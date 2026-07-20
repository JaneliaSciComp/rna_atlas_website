#!/usr/bin/env bash
# Deploy the casp-web bridge: IAM role + Lambda + HTTP API (us-east-2).
# Needs ADMIN creds (default profile / SSO AdministratorAccess) — the scoped
# atlas-inference user cannot create IAM/Lambda/API-Gateway.
#
#   ./deploy_bridge.sh              # -> shared CASP prod stack (FN casp-web),   print INFER_API url
#   STAGE=atlas ./deploy_bridge.sh  # -> isolated atlas fork (FN casp-web-atlas), print INFER_API url
#
# WEB_TOKEN (the gate passcode) is read from DEPLOYED.local.md (gitignored) —
# it must equal the atlas passcode so the front-end's ?t=/token matches.
set -euo pipefail
cd "$(dirname "$0")"

PROFILE="${PROFILE:-default}"
REGION="us-east-2"
ACCOUNT="481088927481"
# STAGE picks which CASP pipeline stack the bridge drives: "prod" = the shared CASP production
# pipeline; "atlas" (or any non-prod) = the isolated atlas fork. Non-prod stages get a "-<stage>"
# suffix on the bridge Lambda/role/API so they never collide with the prod bridge.
STAGE="${STAGE:-prod}"
SUF=""; [ "$STAGE" = "prod" ] || SUF="-$STAGE"
FN="casp-web$SUF"
ROLE="casp-web-role$SUF"
API="casp-web-api$SUF"
ARTIFACTS_BUCKET="janelia-das-casp-artifacts-$STAGE"
AWS="aws --profile $PROFILE --region $REGION"
LAMBDA_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$FN"
echo "STAGE=$STAGE  ->  FN=$FN  ARTIFACTS_BUCKET=$ARTIFACTS_BUCKET"

WEB_TOKEN="$(grep -ioE 'atlas-[a-f0-9]{12}' ../DEPLOYED.local.md | head -1)"
[ -n "$WEB_TOKEN" ] || { echo "ERROR: could not read passcode from ../DEPLOYED.local.md"; exit 1; }

echo "== 1/5 IAM role =="
cat > /tmp/casp-web-trust.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
$AWS iam get-role --role-name "$ROLE" >/dev/null 2>&1 || \
  aws --profile "$PROFILE" iam create-role --role-name "$ROLE" \
    --assume-role-policy-document file:///tmp/casp-web-trust.json >/dev/null
cat > /tmp/casp-web-policy.json <<JSON
{"Version":"2012-10-17","Statement":[
 {"Sid":"logs","Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"*"},
 {"Sid":"lambdacfg","Effect":"Allow","Action":"lambda:GetFunctionConfiguration","Resource":"arn:aws:lambda:$REGION:$ACCOUNT:function:janelia-das-casp-daslab-*-$STAGE"},
 {"Sid":"sfnexec","Effect":"Allow","Action":["states:DescribeExecution","states:StopExecution"],"Resource":"arn:aws:states:$REGION:$ACCOUNT:execution:janelia-das-casp-daslab-*-pipeline-$STAGE:*"},
 {"Sid":"sfnsm","Effect":"Allow","Action":["states:StartExecution","states:ListExecutions"],"Resource":"arn:aws:states:$REGION:$ACCOUNT:stateMachine:janelia-das-casp-daslab-*-pipeline-$STAGE"},
 {"Sid":"s3get","Effect":"Allow","Action":"s3:GetObject","Resource":["arn:aws:s3:::$ARTIFACTS_BUCKET/submissions/*","arn:aws:s3:::$ARTIFACTS_BUCKET/cache/*","arn:aws:s3:::$ARTIFACTS_BUCKET/predictions/*"]},
 {"Sid":"s3put","Effect":"Allow","Action":"s3:PutObject","Resource":"arn:aws:s3:::$ARTIFACTS_BUCKET/requests/*"},
 {"Sid":"s3list","Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::$ARTIFACTS_BUCKET","Condition":{"StringLike":{"s3:prefix":["submissions/*","cache/*","requests/*","predictions/*"]}}}
]}
JSON
aws --profile "$PROFILE" iam put-role-policy --role-name "$ROLE" \
  --policy-name casp-web-policy --policy-document file:///tmp/casp-web-policy.json
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"
echo "   role: $ROLE_ARN"

echo "== 2/5 package =="
rm -f /tmp/casp-web.zip
( cd "$(dirname casp_web.py)" && zip -q /tmp/casp-web.zip casp_web.py )

echo "== 3/5 Lambda =="
ENV="Variables={WEB_TOKEN=$WEB_TOKEN,ARTIFACTS_BUCKET=$ARTIFACTS_BUCKET,ACCOUNT=$ACCOUNT,REGION=$REGION,STAGE=$STAGE}"
if $AWS lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  $AWS lambda update-function-code --function-name "$FN" --zip-file fileb:///tmp/casp-web.zip >/dev/null
  sleep 3
  $AWS lambda update-function-configuration --function-name "$FN" \
    --handler casp_web.lambda_handler --runtime python3.12 --timeout 30 --memory-size 256 \
    --environment "$ENV" >/dev/null
else
  # give IAM a moment to propagate the new role before Lambda validates it
  sleep 8
  $AWS lambda create-function --function-name "$FN" \
    --runtime python3.12 --role "$ROLE_ARN" --handler casp_web.lambda_handler \
    --timeout 30 --memory-size 256 --environment "$ENV" \
    --zip-file fileb:///tmp/casp-web.zip >/dev/null
fi
echo "   fn: $LAMBDA_ARN"

echo "== 4/5 HTTP API =="
API_ID="$($AWS apigatewayv2 get-apis --query "Items[?Name=='$API'].ApiId" --output text 2>/dev/null || true)"
if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  API_ID="$($AWS apigatewayv2 create-api --name "$API" --protocol-type HTTP \
    --target "$LAMBDA_ARN" \
    --cors-configuration AllowOrigins='*',AllowMethods='GET,POST,OPTIONS',AllowHeaders='content-type' \
    --query ApiId --output text)"
else
  $AWS apigatewayv2 update-api --api-id "$API_ID" \
    --cors-configuration AllowOrigins='*',AllowMethods='GET,POST,OPTIONS',AllowHeaders='content-type' >/dev/null
fi
# allow API Gateway to invoke the Lambda (ignore if the statement already exists)
$AWS lambda add-permission --function-name "$FN" --statement-id apigw-invoke \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*/*" >/dev/null 2>&1 || true

URL="$($AWS apigatewayv2 get-api --api-id "$API_ID" --query ApiEndpoint --output text)"
echo "== 5/5 done =="
echo
echo "INFER_API = $URL"
echo "smoke test: curl -s '$URL/models'"
