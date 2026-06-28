# Changelog

All notable changes to this project are documented in this file.

## [0.8.4] - 2026-06-29

### Added
- **Real progress bar during conversion**: while an HEVC/VP9/VP8 video is being
  converted to H.264, the "Converting video…" badge now shows a live percentage
  and a filling bar (parsed from the encoder's actual frame count), so you can see
  how far along it is — most useful on longer files.

## [0.8.3] - 2026-06-29

### Added
- **WebM playback** (`.webm`): the **VP9** and **VP8** video inside WebM — which
  the VS Code engine can't decode — is **converted to H.264 on the fly** by the
  bundled WebAssembly ffmpeg, exactly like HEVC. **Opus** and **Vorbis** audio are
  extracted and played in sync. Still zero-setup and one universal package — no
  extra download. (VP9/VP8 inside `.mkv` now plays too.) AV1 isn't decodable here
  and still shows the honest per-codec message; very large/long files are skipped.

## [0.8.2] - 2026-06-28

### Changed
- **Marketplace listing** now reflects the real coverage: HEVC/H.265 and the newer
  containers (M2TS, MTS, FLV, F4V) are advertised in the name and description.

### Fixed
- A video with **no audio track** no longer shows a scary internal error
  ("Audio unavailable: …") — it just plays without sound, as expected.
- **Subtitles** in non-UTF-8 encodings (UTF-16 / UTF-8 with BOM, common in
  downloaded `.srt`) now load correctly instead of silently failing; malformed
  timestamps are ignored more strictly.
- Hardened the codec-name shown in the error overlay (sanitised), and the temp
  cache cleanup now also removes orphaned partial files.

### Internal
- Extracted the pure subtitle/codec helpers into a separate module and added a
  unit-test suite (run on CI), to catch regressions in that fiddly parsing.

## [0.8.1] - 2026-06-28

### Changed
- **Faster audio extraction** (so MKV/AVI/HEVC and MP4/MOV files load quicker):
  dropped a forced 48 kHz resample that cost about a third of the audio step for
  no benefit — the MP3 now keeps the source sample rate, which the player handles
  fine. The saving grows with clip length, so medium/long files open noticeably
  sooner. (Surround tracks are still downmixed to stereo.)

## [0.8.0] - 2026-06-28

### Added
- **HEVC / H.265 playback** in the supported containers (MKV/AVI/M2TS/MTS/FLV/F4V):
  the VS Code engine can't decode HEVC, so the bundled WebAssembly `ffmpeg`
  **converts it to H.264 on the fly** (a "Converting HEVC…" badge shows during the
  one-time conversion). Works for 8-bit and 10-bit HEVC, with audio. Still
  zero-setup and one universal package — no extra download. Very large/long HEVC
  files (over ~128 MB) are skipped with a clear message, to keep conversion times
  reasonable; other codecs (VP9/AV1) continue to show the honest per-codec error.

### Fixed
- A video with **no audio track** in a remuxed container (MKV/AVI/TS/FLV) could
  fail to play at all; video and audio are now processed independently, so the
  video always plays and audio is added when present.

## [0.7.2] - 2026-06-28

### Added
- **More containers** (H.264 inside): `.m2ts`, `.mts` (AVCHD camcorders), `.flv`
  and `.f4v` now open, reusing the same on-the-fly remux to MP4 + audio extraction
  as MKV/AVI — no re-encoding, no added size.

### Changed
- **Honest per-codec error**: when a video can't be decoded, the message now names
  the actual codec it found (e.g. "This video uses the **HEVC (H.265)** codec…")
  instead of a generic note. The codec is detected up front from the file, so
  unplayable files fail fast with a clear reason instead of a silent black frame.

## [0.7.1] - 2026-06-27

### Changed
- Documentation: the README now describes the **Copy / Save** frame capture and the
  zero-config subtitles more clearly (no functional changes).

## [0.7.0] - 2026-06-27

### Added
- **Subtitles**: a sidecar `.srt`/`.vtt` file with the same name as the video is
  loaded automatically (SRT is converted to WebVTT on the fly). Toggle with the
  `CC` button or `C`.
- **Capture frame**: the camera button (or `S`) grabs the current frame and offers
  **Copy** (to the clipboard, ready to paste into a chat/doc) or **Save** as a PNG.
- A gentle, one-time prompt asking for a ⭐ rating after a few videos.

## [0.6.2] - 2026-06-27

### Fixed
- A TypeScript `.ts` file could open in the video player — the `.ts`/`.m2ts`/`.flv`
  patterns were removed; the editor now handles `.mp4/.mov/.m4v/.mkv/.avi`.
- Clearer messages: files over 1 GB now report "too large" instead of a
  misleading "unsupported codec"; failed/partial transcodes are no longer served.
- Opening the same file twice no longer races on the cache (atomic writes +
  de-duplicated work); fixed a possible double-audio when native audio is present.

### Added
- **Remembers** your last volume and playback speed, and **resumes** each video
  from where you left off.
- **Double-click** to toggle fullscreen; **scroll-wheel** over the player changes volume.
- Accessibility: focus outlines, ARIA labels on controls, live status/error regions.

## [0.6.1] - 2026-06-27

### Added
- **MKV, AVI and TS support** (H.264 video): these containers are remuxed to a
  temporary MP4 on the fly (a fast repackage, no re-encoding) so the player can
  show them, with audio extracted as usual. Files whose video isn't H.264 (e.g.
  HEVC/VP9) show a clear "unsupported codec" message.

## [0.6.0] - 2026-06-27

### Changed
- **Audio engine rewritten on WebAssembly ffmpeg.** Audio is now extracted and
  transcoded in-process with a bundled WebAssembly `ffmpeg` instead of a native
  binary. Result: **one universal package** (~9 MB download / ~25 MB installed,
  down from ~80 MB), no per-platform builds, and no external processes spawned.

### Added
- **Broader audio coverage**: besides AAC, the player now also handles AC-3,
  E-AC-3, ALAC and other audio codecs found in MP4/MOV/M4V files.

### Note
- Very large files (> 1 GB) skip audio extraction for now (the video still
  plays); chunked streaming will come in a follow-up.

## [0.5.6] - 2026-06-25

### Changed
- Re-added the Marketplace rating badge to the README now that ratings have
  propagated.
- Smaller published package: README media (demo GIF, screenshot) are now
  excluded from the VSIX — they are served from GitHub, not needed inside it.

## [0.5.4] - 2026-06-25

### Fixed
- Marketplace badges in the README (version, installs) now use a supported
  provider; the previous one had been retired and showed a broken badge.

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
