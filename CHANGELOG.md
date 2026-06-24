# Changelog

Tutte le modifiche rilevanti a questo progetto sono documentate in questo file.

## [0.1.0] - 2026-06-24

### Aggiunto
- Custom Editor che riproduce file `.mp4` (video + audio) in una scheda dell'editor.
- Player HTML5 con controlli nativi: play/pausa, volume, timeline, schermo intero.
- Scorciatoie da tastiera (spazio, frecce, `M`, `F`).
- Messaggio d'errore chiaro per codec non supportati (es. H.265/HEVC).
- Content-Security-Policy restrittiva con nonce crittografico e accesso ai file
  limitato alla sola cartella del video.
