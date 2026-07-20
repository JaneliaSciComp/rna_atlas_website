"""claude-proxy — server-side proxy for the RNA Atlas in-page assistant.

Holds the Anthropic API key in a Lambda env var (NEVER shipped to the browser) and forwards the
Messages call, gated by the shared site passcode. Replaces the old client-side window.CLAUDE_KEY,
which leaked because a raw key in client JS is readable by anyone who loads the (passcode-gated) site.

  POST /chat   body = Anthropic Messages payload {model, max_tokens, system, tools, messages}
    auth: passcode via ?t=<pass>, header x-atlas-token, or body.token — must equal WEB_TOKEN
    -> forwards to https://api.anthropic.com/v1/messages with x-api-key = ANTHROPIC_API_KEY (env)
    -> returns Anthropic's status + JSON body verbatim

Env: ANTHROPIC_API_KEY (the key), WEB_TOKEN (gate passcode), MAX_TOKENS_CAP (default 4096),
     ALLOWED_MODELS (optional comma list). No external deps — stdlib urllib only.
"""
import base64
import json
import os
import urllib.error
import urllib.request

WEB_TOKEN = os.environ.get("WEB_TOKEN", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MAX_TOKENS_CAP = int(os.environ.get("MAX_TOKENS_CAP", "4096"))
ALLOWED_MODELS = [m.strip() for m in os.environ.get("ALLOWED_MODELS", "").split(",") if m.strip()]
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"

_CORS = {"Access-Control-Allow-Origin": "*",
         "Access-Control-Allow-Methods": "POST,OPTIONS",
         "Access-Control-Allow-Headers": "content-type,x-atlas-token"}


def _resp(code, obj):
    return {"statusCode": code, "headers": {"Content-Type": "application/json", **_CORS},
            "body": json.dumps(obj)}


def lambda_handler(event, context):
    method = (event.get("requestContext", {}).get("http", {}).get("method")
              or event.get("httpMethod") or "GET").upper()
    if method == "OPTIONS":
        return {"statusCode": 200, "headers": _CORS, "body": ""}
    if method != "POST":
        return _resp(405, {"error": "POST only"})

    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    qs = event.get("queryStringParameters") or {}
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8", "replace")
    try:
        body = json.loads(raw)
    except Exception:
        return _resp(400, {"error": "bad json"})

    # passcode gate (same shared token as the rest of the gated site)
    token = qs.get("t") or headers.get("x-atlas-token") or body.pop("token", None) or ""
    if not WEB_TOKEN or token != WEB_TOKEN:
        return _resp(403, {"error": "forbidden"})
    if not ANTHROPIC_API_KEY:
        return _resp(500, {"error": "proxy misconfigured (no key)"})

    # sanitize the passthrough payload: cap max_tokens, optionally restrict model
    mt = body.get("max_tokens")
    if not isinstance(mt, int) or mt <= 0 or mt > MAX_TOKENS_CAP:
        body["max_tokens"] = MAX_TOKENS_CAP
    if ALLOWED_MODELS and body.get("model") not in ALLOWED_MODELS:
        return _resp(400, {"error": "model not allowed", "allowed": ALLOWED_MODELS})
    body.pop("stream", None)  # this proxy is non-streaming (buffered response)

    req = urllib.request.Request(
        ANTHROPIC_URL, method="POST",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json",
                 "x-api-key": ANTHROPIC_API_KEY,
                 "anthropic-version": "2023-06-01"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out, code = r.read().decode("utf-8", "replace"), r.getcode()
    except urllib.error.HTTPError as e:
        out, code = e.read().decode("utf-8", "replace"), e.code
    except Exception as e:
        return _resp(502, {"error": "upstream", "detail": str(e)})
    return {"statusCode": code, "headers": {"Content-Type": "application/json", **_CORS}, "body": out}
