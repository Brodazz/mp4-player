# MP4 Player per VS Code

[![CI](https://github.com/Brodazz/mp4-player/actions/workflows/ci.yml/badge.svg)](https://github.com/Brodazz/mp4-player/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Estensione che riproduce video `.mp4` (video **e** audio) in una scheda dell'editor
di Visual Studio Code. Puoi tenere il video aperto in un riquadro e continuare a
scrivere codice in un altro, dividendo l'editor — senza finestre esterne.

## Come funziona

VS Code è basato su Electron (Chromium), quindi un tag HTML5 `<video>` in una
Webview riproduce il video **H.264** dei file MP4. Il motore di VS Code, però,
non decodifica l'**audio AAC**: per questo l'estensione estrae la traccia audio
e la transcodifica in locale (con un `ffmpeg` incluso) in un formato riproducibile,
poi la riproduce **in sincrono** con il video. Tutto avviene offline, sul tuo PC.
L'estensione registra un *Custom Editor* per i file `.mp4`.

## Installazione

### Da file `.vsix`
1. Scarica il file `.vsix` (dalla pagina *Releases* o generandolo, vedi sotto).
2. In VS Code: **Estensioni** (`Ctrl+Shift+X`) → menu `...` → *Install from VSIX...*
3. Oppure da terminale: `code --install-extension mp4-player-0.1.0.vsix`

### Uso
- Apri un file `.mp4` da Explorer: parte il player.
- Per affiancare codice e video usa lo split dell'editor (`Ctrl+\` o trascina la tab).

## Scorciatoie da tastiera

| Tasto | Azione |
|---|---|
| `Spazio` / `K` | Play / Pausa |
| `←` / `→` | Indietro / Avanti 5s |
| `↑` / `↓` | Volume su / giù |
| `M` | Muto |
| `F` | Schermo intero |

## Sviluppo

```bash
npm install
npm run compile      # oppure: npm run watch
```

Premi **F5** in VS Code per aprire la finestra *Extension Development Host* di prova.

### Pacchettizzazione (.vsix)

```bash
npm run package
```

## Sicurezza

Vedi [SECURITY.md](SECURITY.md). In breve: Content-Security-Policy restrittiva,
nonce crittografico, accesso ai file limitato alla cartella del video, editor in
sola lettura, nessuna connessione di rete.

## Codec supportati

- **Video**: **H.264** (il più diffuso). Codec come **H.265/HEVC** potrebbero non
  essere supportati dal motore di VS Code: in quel caso il player mostra un errore.
- **Audio**: gestito tramite transcodifica locale con `ffmpeg`, quindi funziona
  anche con l'**AAC** (che VS Code non decodifica da solo). L'audio viene
  convertito in WAV temporaneo — l'unico formato che il motore di VS Code apre in
  modo affidabile — e messo in cache; per video molto lunghi i file temporanei
  possono essere grandi.

## Licenza

[MIT](LICENSE) © Alessandro Broda
