# MP4 Player for VS Code

[![CI](https://github.com/Brodazz/mp4-player/actions/workflows/ci.yml/badge.svg)](https://github.com/Brodazz/mp4-player/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Extension that plays `.mp4`, `.mov` and `.m4v` videos (video **and** audio) in a
Visual Studio Code editor tab. You can keep the video open in one pane and keep
writing code in another by splitting the editor — no external windows.

## How it works

VS Code is built on Electron (Chromium), so an HTML5 `<video>` tag in a Webview
plays the **H.264** video of MP4/MOV/M4V files. The VS Code engine, however, does
not decode **AAC audio**: that's why the extension extracts the audio track and
transcodes it locally (with a bundled `ffmpeg`) into MP3, then plays it **in
sync** with the video. Everything happens offline, on your PC. The extension
registers a *Custom Editor* for `.mp4`, `.mov` and `.m4v` files.

## Installation

### From a `.vsix` file
1. Download the `.vsix` file (from the *Releases* page, or build it yourself, see below).
2. In VS Code: **Extensions** (`Ctrl+Shift+X`) → `...` menu → *Install from VSIX...*
3. Or from the terminal: `code --install-extension mp4-player-win32-x64.vsix`

### Usage
- Open a `.mp4`, `.mov` or `.m4v` file from the Explorer: the player starts.
- To place code and video side by side, use the editor split (`Ctrl+\` or drag the tab).
- Playback speed: use the selector at the top-left (it appears on hover) or the `<` / `>` keys.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / Pause |
| `←` / `→` | Back / Forward 5s |
| `↑` / `↓` | Volume up / down |
| `<` / `>` | Slower / Faster (0.25×–2×) |
| `M` | Mute |
| `F` | Fullscreen |

## Development

```bash
npm install
npm run compile      # or: npm run watch
```

Press **F5** in VS Code to open the *Extension Development Host* test window.

### Packaging (.vsix)

```bash
npm run package
```

## Security

See [SECURITY.md](SECURITY.md). In short: restrictive Content-Security-Policy,
cryptographic nonce, file access limited to the video's folder, read-only editor,
no network connections.

## Supported codecs

- **Video**: **H.264** (the most common). Codecs such as **H.265/HEVC** may not
  be supported by the VS Code engine: in that case the player shows an error.
- **Audio**: handled via local transcoding with `ffmpeg`, so it works even with
  **AAC** (which VS Code does not decode on its own). The audio is converted to a
  temporary MP3 file the VS Code engine plays reliably, then cached for instant
  reopens. The cache **cleans itself up** (files older than 7 days, and a 1 GB cap).

## Platforms

Dedicated packages for **Windows (x64)**, **Linux (x64)**, **macOS Intel** and
**macOS Apple Silicon**: audio works on all of them thanks to a bundled `ffmpeg`
for each platform. The VS Code Marketplace automatically downloads the right
package for your system.

## License

[MIT](LICENSE) © Alessandro Broda
