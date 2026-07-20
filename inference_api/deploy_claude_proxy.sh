#!/usr/bin/env bash
# Deploy the claude-proxy Lambda + HTTP API (us-east-2) so the in-page assistant's Anthropic key
# lives SERVER-SIDE (Lambda env var), never in the browser. Needs ADMIN creds (default profile /
# SSO AdministratorAccess) — creating IAM/Lambda/API-Gateway.
#
#   1) put the NEW Anthropic key in ../.anthropic_key   (gitignored; write it yourself, don't paste in chat)
#   2) ./deploy_claude_proxy.sh                          # create-or-update; prints CLAUDE_PROXY url
#
# WEB_TOKEN (the gate passcode) comes from ../DEPLOYED.local.md and must equal the atlas passcode.
set -euo pipefail
cd "$(dirname "$0")"

PROFILE="${PROFILE:-default}"
REGION="us-east-2"
ACCOUNT="481088927481"
FN="claude-proxy"
ROLE="claude-proxy-role"
API="claude-proxy-api"
AWS="aws --profile $PROFILE --region $REGION"
LAMBDA_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$FN"

WEB_TOKEN="$(grep -ioE 'atlas-[a-f0-9]{12}' ../DEPLOYED.local.md | head -1)"
[ -n "$WEB_TOKEN" ] || { echo "ERROR: could not read passcode from ../DEPLOYED.local.md"; exit 1; }
KEY="$(tr -d '\n\r ' < ../.anthropic_key 2>/dev/null || true)"
[ -n "$KEY" ] || { echo "ERROR: put the NEW Anthropic key in ../.anthropic_key (gitignored) first"; exit 1; }
# spend/abuse guardrails (override via env before running if desired)
MAX_TOKENS_CAP="${MAX_TOKENS_CAP:-4096}"
ALLOWED_MODELS="${ALLOWED_MODELS:-claude-sonnet-4-6,claude-opus-4-1,claude-haiku-4-5}"

echo "== 1/4 IAM role (logs only) =="
cat > /tmp/claude-proxy-trust.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
$AWS iam get-role --role-name "$ROLE" >/dev/null 2>&1 || \
  aws --profile "$PROFILE" iam create-role --role-name "$ROLE" \
    --assume-role-policy-document file:///tmp/claude-proxy-trust.json >/dev/null
cat > /tmp/claude-proxy-policy.json <<JSON
{"Version":"2012-10-17","Statement":[
 {"Sid":"logs","Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"*"}
]}
JSON
aws --profile "$PROFILE" iam put-role-policy --role-name "$ROLE" \
  --policy-name claude-proxy-policy --policy-document file:///tmp/claude-proxy-policy.json
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"
echo "   role: $ROLE_ARN"

echo "== 2/4 package =="
rm -f /tmp/claude-proxy.zip
zip -q /tmp/claude-proxy.zip claude_proxy.py

echo "== 3/4 Lambda =="
# NOTE: the key is passed via --environment only (never echoed). Env vars are encrypted at rest and
# readable only by admins with lambda:GetFunctionConfiguration — not by the browser.
ENV="Variables={ANTHROPIC_API_KEY=$KEY,WEB_TOKEN=$WEB_TOKEN,MAX_TOKENS_CAP=$MAX_TOKENS_CAP,ALLOWED_MODELS=$ALLOWED_MODELS}"
if $AWS lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  $AWS lambda update-function-code --function-name "$FN" --zip-file fileb:///tmp/claude-proxy.zip >/dev/null
  sleep 3
  $AWS lambda update-function-configuration --function-name "$FN" \
    --handler claude_proxy.lambda_handler --runtime python3.12 --timeout 60 --memory-size 256 \
    --environment "$ENV" >/dev/null
else
  sleep 8   # let the new IAM role propagate before Lambda validates it
  $AWS lambda create-function --function-name "$FN" \
    --runtime python3.12 --role "$ROLE_ARN" --handler claude_proxy.lambda_handler \
    --timeout 60 --memory-size 256 --environment "$ENV" \
    --zip-file fileb:///tmp/claude-proxy.zip >/dev/null
fi
echo "   fn: $LAMBDA_ARN"

echo "== 4/4 HTTP API =="
API_ID="$($AWS apigatewayv2 get-apis --query "Items[?Name=='$API'].ApiId" --output text 2>/dev/null || true)"
if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  API_ID="$($AWS apigatewayv2 create-api --name "$API" --protocol-type HTTP --target "$LAMBDA_ARN" \
    --cors-configuration AllowOrigins='*',AllowMethods='POST,OPTIONS',AllowHeaders='content-type,x-atlas-token' \
    --query ApiId --output text)"
else
  $AWS apigatewayv2 update-api --api-id "$API_ID" \
    --cors-configuration AllowOrigins='*',AllowMethods='POST,OPTIONS',AllowHeaders='content-type,x-atlas-token' >/dev/null
fi
$AWS lambda add-permission --function-name "$FN" --statement-id apigw-invoke \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*/*" >/dev/null 2>&1 || true

URL="$($AWS apigatewayv2 get-api --api-id "$API_ID" --query ApiEndpoint --output text)"
echo
echo "CLAUDE_PROXY = $URL"
echo "  -> put this in ../.claude_proxy  (gitignored); deploy.sh injects it as window.CLAUDE_PROXY"
echo "  smoke: curl -s -X POST '$URL/chat' -H 'x-atlas-token: <passcode>' -H 'content-type: application/json' -d '{\"model\":\"claude-haiku-4-5\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'"
