# Changelog

All notable changes to this project are documented in this file.

## [0.5.3] - 2026-06-25

### Changed
- Maintenance release: hardened the release pipeline so re-publishing an
  existing version no longer fails the build. No user-facing changes.

## [0.5.2] - 2026-06-25

### Changed
- **Marketplace listing**: added a screenshot, a "Why this one" section and a
  comparison table highlighting the zero-setup, offline, secure approach.

## [0.5.1] - 2026-06-25

### Added
- **Picture-in-Picture**: a button in the control bar (and the `P` key) pops the
  video into a floating window; the external audio stays in sync.

## [0.5.0] - 2026-06-25

### Added
- **Custom control bar**: a modern auto-hiding control bar inside the player
  (native controls hidden) with play/pause, a seekable timeline, time, volume,
  playback speed and fullscreen — appears on mouse move, fades out during playback.

### Changed
- **Search-optimized display name**: "Modern Video Player — with Audio (MP4,
  MOV, M4V)", with richer keywords and description for Marketplace discovery.
  The extension id stays `mp4-player`, so existing installs keep updating
  normally.

## [0.4.0] - 2026-06-25

### Added
- **MOV and M4V support**: the player now also opens `.mov` and `.m4v` files
  (H.264 video + AAC audio), using the same ffmpeg audio pipeline as MP4.
- **Playback speed control** (0.25×–2×): selector at the top-left (shown on
  hover) and `<` / `>` keyboard shortcuts. Video and audio change speed together.

### Changed
- **Audio transcoded to MP3** instead of WAV: roughly 1/15 of the size, lighter
  cache and faster startup, with reliable playback in the VS Code webview.

## [0.3.0] - 2026-06-24

### Added
- **Cross-platform support**: dedicated packages for Windows (x64), Linux (x64),
  macOS Intel and macOS Apple Silicon, each with its own `ffmpeg`. Audio
  therefore works on macOS and Linux too (built via CI).
- **Automatic audio cache cleanup**: on startup, temporary WAV files older than
  7 days are deleted and, if the folder exceeds 1 GB, the least used ones are
  removed until it fits again.

### Changed
- ffmpeg binary execute permission set automatically on macOS/Linux.

## [0.2.0] - 2026-06-24

### Added
- **Working audio** even for files with the AAC codec, which the VS Code engine
  does not decode natively. The audio track is extracted and transcoded locally
  with a bundled `ffmpeg`, then played in sync with the video.
- "Preparing audio…" badge during transcoding; result caching for instant
  reopens.
- Extension icon.

### Notes
- The transcoded audio is in WAV (PCM) format: it is the only one the VS Code
  engine plays reliably. The temporary files can therefore be large for long
  videos (they are cached in the temporary folder).

## [0.1.0] - 2026-06-24

### Added
- Custom Editor that plays `.mp4` files (video + audio) in an editor tab.
- HTML5 player with native controls: play/pause, volume, timeline, fullscreen.
- Keyboard shortcuts (space, arrows, `M`, `F`).
- Clear error message for unsupported codecs (e.g. H.265/HEVC).
- Restrictive Content-Security-Policy with a cryptographic nonce and file access
  limited to the video's folder only.
