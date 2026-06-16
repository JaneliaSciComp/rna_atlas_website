// Deployment config for the explorer shell.
//   DATA_BASE: where data lives relative to the page. "" = same origin (local
//              serve.py, or the S3/CloudFront site where shell + data share one origin).
//   GATED:     true => require the access passcode and send it as ?t=<passcode> on
//              every data request (S3/CloudFront deploy). false => local dev, no gate.
// build_static.py overwrites this file in dist/ with the deploy values.
window.DATA_BASE = "";
window.GATED = false;
