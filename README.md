# Modern Video Player — with Audio for VS Code

[![Version](https://badgen.net/vs-marketplace/v/Brodazz.mp4-player)](https://marketplace.visualstudio.com/items?itemName=Brodazz.mp4-player)
[![Installs](https://badgen.net/vs-marketplace/i/Brodazz.mp4-player)](https://marketplace.visualstudio.com/items?itemName=Brodazz.mp4-player)
[![Rating](https://badgen.net/vs-marketplace/rating/Brodazz.mp4-player)](https://marketplace.visualstudio.com/items?itemName=Brodazz.mp4-player)
[![CI](https://github.com/Brodazz/mp4-player/actions/workflows/ci.yml/badge.svg)](https://github.com/Brodazz/mp4-player/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Extension that plays `.mp4`, `.mov`, `.m4v`, **`.mkv`** and `.avi` videos (video
**and** audio) in a Visual Studio Code editor tab. You can keep the video open in
one pane and keep writing code in another by splitting the editor — no external
windows.

<!-- Media URLs must be absolute HTTPS (the Marketplace doesn't render relative paths),
     so these point at the raw files on the main branch. -->
![Video, code and AI side by side in VS Code](https://raw.githubusercontent.com/Brodazz/mp4-player/main/assets/demo.gif)

*A modern workflow: a reference video (Modern Video Player), your code and your AI assistant — all at once, in VS Code.*

![The player with its custom control bar](https://raw.githubusercontent.com/Brodazz/mp4-player/main/assets/screenshot.png)

## Why this one

Most video extensions for VS Code either **play MP4 without sound** (Chromium in
VS Code can't decode AAC audio) or **make you install `ffmpeg` yourself**. This one
just works: it **bundles `ffmpeg`** (compiled to WebAssembly), so MP4 **and MKV**
play **with audio out of the box** — no setup, **no local server**, fully
**offline**, in a single lightweight and secure extension.

- 🔊 **Real audio** on MP4, MKV, MOV, M4V & AVI — even AAC, which VS Code can't decode on its own
- ⚡ **Zero setup** — `ffmpeg` is bundled; nothing to install
- 🔒 **Secure & offline** — no network, no local server, read-only editor, strict CSP
- 🎛️ **Modern control bar** — seekable timeline, speed (0.25×–2×), volume, Picture-in-Picture, fullscreen
- 📝 **Subtitles & frame grab** — auto-loads a sidecar `.srt`/`.vtt`, and `S` saves the current frame as a PNG
- 💾 **Remembers** your volume, speed and resume position
- 🪶 **Lightweight & focused** — does one thing, well
- 🖥️ **Cross-platform** — one universal package for Windows, Linux and macOS (Intel & Apple Silicon)

| | This extension | Other VS Code video extensions |
|---|:--:|:--:|
| Audio on MP4 **& MKV** (incl. AAC) | ✅ out of the box | ❌ silent — or ⚠️ only if you install ffmpeg |
| Setup required | ✅ none (ffmpeg bundled) | ⚠️ often needs ffmpeg installed |
| Network / local server | ✅ none — fully offline | ⚠️ some run a local HTTP server |
| Install | ✅ one universal package | ⚠️ per-platform builds or host ffmpeg |
| Security | 🔒 strict CSP, read-only, no network | varies |
| Control bar (speed · PiP · fullscreen) | ✅ built-in | varies |

## How it works

VS Code is built on Electron (Chromium), so an HTML5 `<video>` tag in a Webview
plays the **H.264** video of MP4/MOV/M4V files. The VS Code engine, however, does
not decode **AAC** (and other) audio: that's why the extension extracts the audio
track and transcodes it locally — with a **bundled `ffmpeg` compiled to
WebAssembly** — into MP3, then plays it **in sync** with the video. Everything
happens offline, on your PC, from a **single universal package** (no per-platform
binaries). The extension registers a *Custom Editor* for `.mp4`, `.mov`, `.m4v`,
`.mkv` and `.avi`.

For containers VS Code can't open directly — **`.mkv`** and `.avi` — the extension
**remuxes** the H.264 video into a temporary MP4 (a fast repackage, no re-encoding)
so the Webview can play it, then extracts the audio the same way.

## Installation

### From a `.vsix` file
1. Download the `.vsix` file (from the *Releases* page, or build it yourself, see below).
2. In VS Code: **Extensions** (`Ctrl+Shift+X`) → `...` menu → *Install from VSIX...*
3. Or from the terminal: `code --install-extension mp4-player.vsix`

### Usage
- Open a `.mp4`, `.mov`, `.m4v`, `.mkv` or `.avi` file from the Explorer: the player starts.
- To place code and video side by side, use the editor split (`Ctrl+\` or drag the tab).
- A **custom control bar** appears at the bottom of the player on mouse move
  (play/pause, seekable timeline, time, volume, playback speed, Picture-in-Picture,
  fullscreen) and fades out during playback. Keyboard shortcuts work too (see below).
- **Subtitles**: drop a `.srt` (or `.vtt`) file with the **same name** next to the
  video and it loads automatically — toggle with the `CC` button or `C`.
- **Save a frame**: press `S` (or the camera button) to export the current frame as a PNG.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / Pause |
| `←` / `→` | Back / Forward 5s |
| `↑` / `↓` | Volume up / down |
| `<` / `>` | Slower / Faster (0.25×–2×) |
| `M` | Mute |
| `P` | Picture-in-Picture |
| `S` | Save current frame (PNG) |
| `C` | Subtitles on/off |
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

- **Video**: **H.264** (the most common), in any of the supported containers
  (MP4/MOV/M4V played directly; MKV/AVI remuxed to MP4 first). Other video
  codecs such as **H.265/HEVC** or **VP9** aren't decoded by the VS Code engine:
  in that case the player shows an error.
- **Audio**: handled via local transcoding with a bundled WebAssembly `ffmpeg`,
  so it works even with **AAC** (which VS Code does not decode on its own) — and
  AC-3, ALAC and other codecs too. The audio is converted to a temporary MP3 the
  VS Code engine plays reliably, then cached for instant reopens. The cache
  **cleans itself up** (files older than 7 days, and a 1 GB cap).

## Platforms

**One universal package** for all platforms — Windows, Linux and macOS (Intel &
Apple Silicon). Audio works everywhere thanks to a bundled `ffmpeg` compiled to
WebAssembly: no native binaries, nothing to install.

## License

[MIT](LICENSE) © Alessandro Broda
