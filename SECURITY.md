# Security policy

## Reporting a vulnerability

If you find a vulnerability, open a private *issue* or contact the author.
Please try to include steps to reproduce the problem.

## Extension security model

The extension shows videos in a VS Code Webview with restrictive measures:

- **Content-Security-Policy** with `default-src 'none'`: nothing is loaded unless
  explicitly allowed.
- Inline scripts are authorized only through a **cryptographic nonce** generated
  with `crypto.randomBytes` on every open.
- The Webview's filesystem access is limited (`localResourceRoots`) to the
  **video's folder only**.
- The editor is **read-only**: the extension does not modify files.
- No network connections: the video is streamed from the local disk.
