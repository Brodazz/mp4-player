# Changelog

Tutte le modifiche rilevanti a questo progetto sono documentate in questo file.

## [0.3.0] - 2026-06-24

### Aggiunto
- **Supporto multipiattaforma**: pacchetti dedicati per Windows (x64), Linux
  (x64), macOS Intel e macOS Apple Silicon, ognuno con il proprio `ffmpeg`.
  L'audio funziona quindi anche su macOS e Linux (build via CI).
- **Pulizia automatica della cache audio**: all'avvio vengono eliminati i file
  WAV temporanei più vecchi di 7 giorni e, se la cartella supera 1 GB, vengono
  rimossi i meno usati finché non rientra.

### Modificato
- Permesso d'esecuzione del binario ffmpeg impostato automaticamente su
  macOS/Linux.

## [0.2.0] - 2026-06-24

### Aggiunto
- **Audio funzionante** anche per i file con codec AAC, che il motore di VS Code
  non decodifica nativamente. La traccia audio viene estratta e transcodificata
  in locale con un `ffmpeg` incluso, poi riprodotta in sincrono con il video.
- Badge "Preparazione audio…" durante la transcodifica; cache del risultato per
  riaperture immediate.
- Icona dell'estensione.

### Note
- L'audio transcodificato è in formato WAV (PCM): è l'unico che il motore di
  VS Code riproduce in modo affidabile. I file temporanei possono quindi essere
  grandi per video lunghi (vengono messi in cache nella cartella temporanea).

## [0.1.0] - 2026-06-24

### Aggiunto
- Custom Editor che riproduce file `.mp4` (video + audio) in una scheda dell'editor.
- Player HTML5 con controlli nativi: play/pausa, volume, timeline, schermo intero.
- Scorciatoie da tastiera (spazio, frecce, `M`, `F`).
- Messaggio d'errore chiaro per codec non supportati (es. H.265/HEVC).
- Content-Security-Policy restrittiva con nonce crittografico e accesso ai file
  limitato alla sola cartella del video.
