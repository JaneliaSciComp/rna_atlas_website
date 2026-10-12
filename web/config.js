// Deployment config for the explorer shell.
//   DATA_BASE: where data lives relative to the page. "" = same origin (local
//              serve.py, or the S3/CloudFront site where shell + data share one origin).
// Access to the deployed site is enforced at the CloudFront edge (Cognito), not by this
// client -- there is no passcode/token concept here any more (see T-0140).
// build_static.py overwrites this file in dist/ with the deploy values.
window.DATA_BASE = "";
