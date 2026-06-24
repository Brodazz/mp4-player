# MP4 Player per VS Code

[![CI](https://github.com/Brodazz/mp4-player/actions/workflows/ci.yml/badge.svg)](https://github.com/Brodazz/mp4-player/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Estensione che riproduce video `.mp4` (video **e** audio) in una scheda dell'editor
di Visual Studio Code. Puoi tenere il video aperto in un riquadro e continuare a
scrivere codice in un altro, dividendo l'editor — senza finestre esterne.

## Come funziona

VS Code è basato su Electron (Chromium), quindi un tag HTML5 `<video>` in una
Webview riproduce nativamente i file MP4 con codec **H.264 + AAC**, audio incluso.
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

Funzionano i file MP4 con **H.264 (video) + AAC (audio)**, il formato più diffuso.
Codec come **H.265/HEVC** o **AC-3** potrebbero non essere supportati dal motore
di Chromium incluso in VS Code: in quel caso il player mostra un messaggio d'errore.

## Licenza

[MIT](LICENSE) © Alessandro Broda
