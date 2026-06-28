# Modern Video Player — with Audio for VS Code

[![Version](https://badgen.net/vs-marketplace/v/Brodazz.mp4-player)](https://marketplace.visualstudio.com/items?itemName=Brodazz.mp4-player)
[![Installs](https://badgen.net/vs-marketplace/i/Brodazz.mp4-player)](https://marketplace.visualstudio.com/items?itemName=Brodazz.mp4-player)
[![Rating](https://badgen.net/vs-marketplace/rating/Brodazz.mp4-player)](https://marketplace.visualstudio.com/items?itemName=Brodazz.mp4-player)
[![CI](https://github.com/Brodazz/mp4-player/actions/workflows/ci.yml/badge.svg)](https://github.com/Brodazz/mp4-player/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Extension that plays `.mp4`, `.mov`, `.m4v`, **`.mkv`**, `.avi` (plus `.m2ts`,
`.mts`, `.flv`, `.f4v`) videos (video **and** audio) in a Visual Studio Code
editor tab. You can keep the video open in one pane and keep writing code in
another by splitting the editor — no external windows.

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

- 🔊 **Real audio** on MP4, MKV, MOV, M4V, AVI, M2TS/MTS, FLV & F4V — even AAC, which VS Code can't decode on its own
- 🎬 **HEVC / H.265 too** (8- or 10-bit) — converted to H.264 on the fly, since VS Code can't decode it natively
- ⚡ **Zero setup** — `ffmpeg` is bundled; nothing to install
- 🔒 **Secure & offline** — no network, no local server, read-only editor, strict CSP
- 🎛️ **Modern control bar** — seekable timeline, speed (0.25×–2×), volume, Picture-in-Picture, fullscreen
- 📝 **Subtitles, zero config** — drop a `.srt`/`.vtt` with the same name next to the video and it just appears (SRT is converted on the fly); toggle with `C`
- 📸 **Grab a frame, paste anywhere** — `S` captures the current frame so you can **Copy** it straight into a chat with your AI assistant, an issue or a doc — or **Save** it as a PNG. No screenshot tool, no leaving VS Code
- 💾 **Remembers** your volume, speed and **resume position** per file
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
`.mkv`, `.avi`, `.m2ts`, `.mts`, `.flv` and `.f4v`.

For containers VS Code can't open directly — **`.mkv`**, `.avi`, `.m2ts`, `.mts`,
`.flv`, `.f4v` — the extension **remuxes** the H.264 video into a temporary MP4 (a
fast repackage, no re-encoding) so the Webview can play it, then extracts the audio
the same way.

## Installation

### From a `.vsix` file
1. Download the `.vsix` file (from the *Releases* page, or build it yourself, see below).
2. In VS Code: **Extensions** (`Ctrl+Shift+X`) → `...` menu → *Install from VSIX...*
3. Or from the terminal: `code --install-extension mp4-player.vsix`

### Usage
- Open a `.mp4`, `.mov`, `.m4v`, `.mkv`, `.avi`, `.m2ts`, `.mts`, `.flv` or `.f4v` file from the Explorer: the player starts.
- To place code and video side by side, use the editor split (`Ctrl+\` or drag the tab).
- A **custom control bar** appears at the bottom of the player on mouse move
  (play/pause, seekable timeline, time, volume, playback speed, Picture-in-Picture,
  fullscreen) and fades out during playback. Keyboard shortcuts work too (see below).
- **Subtitles, zero config**: drop a `.srt` (or `.vtt`) file with the **same name**
  next to the video and it loads automatically — no menus, no import step. SRT is
  converted to WebVTT on the fly and the cues are injected directly into the player
  (so VS Code's strict security policy never blocks them). Toggle with the `CC`
  button or `C`.
- **Capture a frame**: press `S` (or the camera button) to grab the current frame,
  then **Copy** it to the clipboard or **Save** it as a PNG. *Copy* is the handy
  one: paste the still straight into a chat with your AI assistant, a bug report or
  some notes — without a separate screenshot tool and without leaving VS Code.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / Pause |
| `←` / `→` | Back / Forward 5s |
| `↑` / `↓` | Volume up / down |
| `<` / `>` | Slower / Faster (0.25×–2×) |
| `M` | Mute |
| `P` | Picture-in-Picture |
| `S` | Capture frame (copy or save as PNG) |
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

- **Video**: **H.264** (the most common) plays in any supported container
  (MP4/MOV/M4V directly; MKV/AVI/M2TS/MTS/FLV/F4V remuxed to MP4 first).
  **H.265/HEVC** (8- or 10-bit) in those remuxed containers is **converted to
  H.264 on the fly** — VS Code can't decode HEVC itself, so the bundled ffmpeg
  does it (a one-time wait, shown as "Converting HEVC…"); very large/long HEVC
  files are skipped to keep that wait short. Codecs that can't be decoded at all
  (e.g. **VP9/AV1**) show a clear error **naming the codec found**, so you know
  exactly why.
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
