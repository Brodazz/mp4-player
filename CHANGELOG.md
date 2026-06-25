# Changelog

All notable changes to this project are documented in this file.

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
