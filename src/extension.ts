import * as vscode from 'vscode';
import { randomBytes, createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { FFmpeg } from '@ffmpeg.wasm/main';
import { Cue, parseCues, decodeSubtitle, videoCodec } from './media';

// Il motore di VS Code non decodifica l'audio AAC degli MP4/MOV/M4V: estraiamo la
// traccia audio e la transcodifichiamo in MP3 (che la Webview riproduce) con un
// ffmpeg compilato in WebAssembly (@ffmpeg.wasm), eseguito nell'extension host.
// Un solo pacchetto universale, nessun binario nativo per piattaforma.

/** Preferenze ripristinate all'apertura: volume/velocità globali, posizione per-file. */
interface Prefs {
  volume: number;
  muted: boolean;
  speed: number;
  pos: number;
}

// Deduplica le elaborazioni concorrenti sullo stesso file (es. due tab dello
// stesso video): non rieseguiamo il WASM né scriviamo la cache due volte.
const pending = new Map<string, Promise<unknown>>();
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = pending.get(key) as Promise<T> | undefined;
  if (existing) {
    return existing;
  }
  const p = fn().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

/** Scrittura atomica: scrive su un file temporaneo e poi lo rinomina, così un
 *  lettore concorrente non vede mai un file di cache troncato. */
async function writeAtomic(dest: string, data: Buffer): Promise<void> {
  const tmp = dest + '.' + randomBytes(4).toString('hex') + '.part';
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, dest);
}

/** Cerca un sottotitolo "sidecar" (.srt o .vtt) con lo stesso nome del video e
 *  lo converte in una lista di cue. I cue vengono iniettati via JS nel webview
 *  (addTextTrack), evitando il <track> esterno e quindi blocchi CSP/MIME. */
function findSubtitle(videoPath: string): Cue[] {
  try {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    for (const ext of ['.vtt', '.srt']) {
      const p = path.join(dir, base + ext);
      if (fs.existsSync(p)) {
        return parseCues(decodeSubtitle(fs.readFileSync(p)));
      }
    }
  } catch {
    /* sottotitoli best-effort */
  }
  return [];
}

/** Salva un fotogramma (PNG, dataURL dal webview) chiedendo dove con un dialog. */
function saveFrame(dataUrl: string, videoPath: string, fileDir: vscode.Uri): void {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!m) {
    return;
  }
  const buf = Buffer.from(m[1], 'base64');
  const base = path.basename(videoPath, path.extname(videoPath));
  const defaultUri = vscode.Uri.joinPath(fileDir, base + '-frame.png');
  vscode.window
    .showSaveDialog({ defaultUri, filters: { Images: ['png'] } })
    .then((uri) => {
      if (uri) {
        vscode.workspace.fs.writeFile(uri, buf);
      }
    });
}

/** Dopo qualche apertura, invita (UNA volta sola, in modo discreto) a recensire. */
function maybeAskForRating(context: vscode.ExtensionContext): void {
  const state = context.globalState;
  if (state.get<boolean>('rate.asked', false)) {
    return;
  }
  const opens = state.get<number>('rate.opens', 0) + 1;
  state.update('rate.opens', opens);
  if (opens < 5) {
    return;
  }
  state.update('rate.asked', true);
  const rate = 'Rate it ⭐';
  vscode.window
    .showInformationMessage(
      'Enjoying Modern Video Player? A quick rating really helps a solo developer 🙏',
      rate,
      'Not now',
    )
    .then((choice) => {
      if (choice === rate) {
        vscode.env.openExternal(
          vscode.Uri.parse(
            'https://marketplace.visualstudio.com/items?itemName=Brodazz.mp4-player&ssr=false#review-details',
          ),
        );
      }
    });
}

/** Punto di ingresso dell'estensione. */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(Mp4EditorProvider.register(context));
  // Pulizia della cache audio in background (non blocca l'avvio).
  setTimeout(cleanupCache, 3000);
}

export function deactivate(): void {
  /* niente da pulire */
}

/**
 * Custom Editor in sola lettura per i file video (.mp4/.mov/.m4v).
 */
class Mp4EditorProvider implements vscode.CustomReadonlyEditorProvider {
  private static readonly viewType = 'mp4Player.preview';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new Mp4EditorProvider(context);
    return vscode.window.registerCustomEditorProvider(
      Mp4EditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  public openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  public resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): void {
    const fileDir = vscode.Uri.joinPath(document.uri, '..');
    const tempDir = getTempDir();
    maybeAskForRating(this.context);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [fileDir, vscode.Uri.file(tempDir)],
    };

    const fsPath = document.uri.fsPath;
    const ext = path.extname(fsPath).toLowerCase();
    const nativeContainer =
      ext === '.mp4' || ext === '.mov' || ext === '.m4v';

    // Preferenze: volume/velocità globali + posizione di ripresa per-file.
    const state = this.context.globalState;
    const prefs: Prefs = {
      volume: state.get<number>('pref.volume', 1),
      muted: state.get<boolean>('pref.muted', false),
      speed: state.get<number>('pref.speed', 1),
      pos: state.get<number>('pos:' + fsPath, 0),
    };

    // Sottotitolo sidecar opzionale (stesso nome del video, .srt/.vtt) → cue.
    const cues = findSubtitle(fsPath);

    let disposed = false;
    webviewPanel.onDidDispose(() => {
      disposed = true;
    });

    webviewPanel.webview.onDidReceiveMessage(
      (msg: {
        type?: string;
        volume?: number;
        muted?: boolean;
        speed?: number;
        time?: number;
        data?: string;
      }) => {
        if (!msg) {
          return;
        }
        if (msg.type === 'toggleZen') {
          // La Fullscreen API è bloccata nei webview → usiamo lo Zen Mode.
          vscode.commands.executeCommand('workbench.action.toggleZenMode');
        } else if (msg.type === 'prefs') {
          if (typeof msg.volume === 'number') { state.update('pref.volume', msg.volume); }
          if (typeof msg.muted === 'boolean') { state.update('pref.muted', msg.muted); }
          if (typeof msg.speed === 'number') { state.update('pref.speed', msg.speed); }
        } else if (msg.type === 'pos' && typeof msg.time === 'number') {
          state.update('pos:' + fsPath, msg.time);
        } else if (msg.type === 'saveFrame' && typeof msg.data === 'string') {
          saveFrame(msg.data, fsPath, fileDir);
        }
      },
    );

    const sendCodec = (
      codec: { name: string; h264: boolean } | null,
    ): void => {
      if (disposed || !codec) {
        return;
      }
      webviewPanel.webview.postMessage({
        type: 'codecInfo',
        name: codec.name,
        h264: codec.h264,
      });
    };

    const sendAudio = (audioPath: string | null): void => {
      if (disposed) {
        return;
      }
      if (audioPath === null) {
        webviewPanel.webview.postMessage({ type: 'noAudio' });
      } else {
        const audioUri = webviewPanel.webview.asWebviewUri(
          vscode.Uri.file(audioPath),
        );
        webviewPanel.webview.postMessage({
          type: 'audioReady',
          src: audioUri.toString(),
        });
      }
    };

    if (nativeContainer) {
      // MP4/MOV/M4V: il webview riproduce il file direttamente; estraiamo l'audio.
      const videoUri = webviewPanel.webview.asWebviewUri(document.uri);
      webviewPanel.webview.html = this.getHtml(webviewPanel.webview, prefs, videoUri, cues);
      once('audio:' + fsPath, () => prepareAudio(fsPath, tempDir))
        .then((res) => {
          if (disposed) {
            return;
          }
          sendCodec(res.codec);
          sendAudio(res.audioPath);
        })
        .catch(() => {
          // Estrazione audio fallita o assente (es. video muto): il core può
          // andare in crash con libmp3lame senza traccia. Non è un errore per
          // l'utente — il video va comunque, semplicemente senza audio.
          if (!disposed) {
            webviewPanel.webview.postMessage({ type: 'noAudio' });
          }
        });
    } else {
      // MKV/AVI: il webview non apre il contenitore. Rimuxiamo il video (H.264)
      // in un MP4 temporaneo e lo inviamo, più l'audio in MP3.
      webviewPanel.webview.html = this.getHtml(webviewPanel.webview, prefs, undefined, cues);
      const onTranscode = (): void => {
        if (!disposed) {
          webviewPanel.webview.postMessage({ type: 'converting' });
        }
      };
      const onProgress = (fraction: number): void => {
        if (!disposed) {
          webviewPanel.webview.postMessage({ type: 'progress', value: fraction });
        }
      };
      once('remux:' + fsPath, () => prepareRemux(fsPath, tempDir, onTranscode, onProgress))
        .then((res) => {
          if (disposed) {
            return;
          }
          if (res.videoPath) {
            // Riproducibile (copia H.264 o transcodifica HEVC→H.264 riuscita):
            // niente codecInfo, il file servito È H.264.
            const vUri = webviewPanel.webview.asWebviewUri(
              vscode.Uri.file(res.videoPath),
            );
            webviewPanel.webview.postMessage({
              type: 'videoReady',
              src: vUri.toString(),
            });
          } else {
            // Errore: mandiamo il codec sorgente per nominarlo onestamente.
            sendCodec(res.codec ?? null);
            webviewPanel.webview.postMessage({
              type: 'videoError',
              reason: res.tooLarge
                ? 'tooLarge'
                : res.convertTooBig
                  ? 'convertTooBig'
                  : 'failed',
            });
          }
          sendAudio(res.audioPath);
        })
        .catch(() => {
          if (!disposed) {
            webviewPanel.webview.postMessage({ type: 'videoError', reason: 'failed' });
          }
        });
    }
  }

  private getHtml(
    webview: vscode.Webview,
    prefs: Prefs,
    videoUri?: vscode.Uri,
    cues: Cue[] = [],
  ): string {
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `media-src ${webview.cspSource}`,
      `img-src ${webview.cspSource}`,
      `style-src 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Video Player</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      width: 100%;
      background: #1e1e1e;
      overflow: hidden;
    }
    .stage {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      width: 100vw;
    }
    .wrap {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #000;
    }
    .wrap.idle { cursor: none; }
    video {
      max-width: 100%;
      max-height: 100%;
      outline: none;
      background: #000;
    }
    audio { display: none; }
    .error {
      display: none;
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      color: #f48771;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 14px;
      max-width: 480px;
      text-align: center;
      line-height: 1.5;
      padding: 24px;
    }
    .error code { color: #ccc; }

    /* Menù di cattura fotogramma (Copy / Save) */
    .capmenu {
      display: none;
      position: absolute;
      left: 50%;
      bottom: 92px;
      transform: translateX(-50%);
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: rgba(24, 24, 28, 0.9);
      backdrop-filter: blur(16px) saturate(140%);
      -webkit-backdrop-filter: blur(16px) saturate(140%);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      z-index: 9;
      font-family: var(--vscode-font-family, sans-serif);
    }
    .capmenu.open { display: flex; }
    .capmenu-label { color: #aaa; font-size: 12px; margin: 0 4px; }
    .capmenu button {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: none;
      border-radius: 5px;
      padding: 6px 16px;
      font-size: 12px;
      cursor: pointer;
    }
    .capmenu button:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }

    /* Barra di controlli custom, a comparsa (pannello "glass" flottante) */
    .bar {
      position: absolute;
      left: 14px;
      right: 14px;
      bottom: 14px;
      padding: 2px 12px 8px;
      background: rgba(22, 22, 26, 0.55);
      backdrop-filter: blur(18px) saturate(150%);
      -webkit-backdrop-filter: blur(18px) saturate(150%);
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 14px;
      box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5);
      font-family: var(--vscode-font-family, sans-serif);
      color: #fff;
      opacity: 1;
      transform: translateY(0);
      transition: opacity 0.28s ease, transform 0.28s ease;
      z-index: 5;
      user-select: none;
    }
    .bar.hidden { opacity: 0; transform: translateY(8px); pointer-events: none; }
    .row { display: flex; align-items: center; gap: 2px; }
    .ic {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      padding: 0;
      background: transparent;
      border: none;
      color: #eaeaea;
      cursor: pointer;
      border-radius: 8px;
      transition: background 0.15s ease, color 0.15s ease, transform 0.12s ease;
    }
    .ic:hover { background: rgba(255, 255, 255, 0.14); color: #fff; transform: translateY(-1px); }
    .ic:active { transform: translateY(0) scale(0.92); }
    .ic svg { width: 20px; height: 20px; display: block; }
    /* Play in evidenza con l'accento del brand */
    #playBtn:hover { background: rgba(232, 78, 78, 0.92); color: #fff; }
    .time {
      font-size: 12px;
      color: #dcdcdc;
      margin: 0 10px;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }
    .sep {
      width: 1px;
      height: 20px;
      margin: 0 6px;
      background: rgba(255, 255, 255, 0.14);
      flex: none;
    }
    .spacer { flex: 1; }

    /* Timeline */
    .seek {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 5px;
      margin: 8px 0 6px;
      padding: 0;
      border-radius: 3px;
      cursor: pointer;
      background-color: rgba(255, 255, 255, 0.22);
      background-image: linear-gradient(90deg, #e84e4e, #ff6b6b);
      background-size: 0% 100%;
      background-repeat: no-repeat;
      transition: height 0.15s ease;
    }
    .seek:hover { height: 7px; }
    .seek::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #fff;
      border: none;
      box-shadow: 0 0 0 4px rgba(232, 78, 78, 0.35);
      cursor: pointer;
      transition: transform 0.12s ease;
    }
    .seek:hover::-webkit-slider-thumb { transform: scale(1.15); }

    /* Volume */
    .vol {
      -webkit-appearance: none;
      appearance: none;
      width: 70px;
      height: 4px;
      padding: 0;
      border-radius: 2px;
      cursor: pointer;
      background-color: rgba(255, 255, 255, 0.25);
      background-image: linear-gradient(#fff, #fff);
      background-size: 100% 100%;
      background-repeat: no-repeat;
    }
    .vol::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: #fff;
      border: none;
      cursor: pointer;
    }

    /* Velocità */
    .speedWrap { position: relative; }
    .speedbtn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #fff;
      cursor: pointer;
      font-size: 12.5px;
      font-weight: 600;
      padding: 5px 10px;
      border-radius: 8px;
      min-width: 42px;
      transition: background 0.15s ease;
    }
    .speedbtn:hover { background: rgba(255, 255, 255, 0.18); }
    .speedmenu {
      display: none;
      position: absolute;
      bottom: 44px;
      right: 0;
      background: rgba(24, 24, 28, 0.9);
      backdrop-filter: blur(16px) saturate(140%);
      -webkit-backdrop-filter: blur(16px) saturate(140%);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      padding: 5px;
      min-width: 70px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    }
    .speedmenu.open { display: block; }
    .speedmenu button {
      display: block;
      width: 100%;
      text-align: left;
      background: transparent;
      border: none;
      color: #fff;
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
      border-radius: 4px;
    }
    .speedmenu button:hover { background: rgba(255, 255, 255, 0.15); }
    .speedmenu button.active { color: #e84e4e; font-weight: 700; }

    /* Indicatore di stato (preparazione audio) */
    #status {
      position: fixed;
      top: 10px;
      right: 12px;
      display: none;
      flex-direction: column;
      gap: 6px;
      background: rgba(0, 0, 0, 0.7);
      color: #ddd;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 12px;
      padding: 6px 10px;
      border-radius: 6px;
      z-index: 10;
    }
    .status-row { display: flex; align-items: center; gap: 8px; }
    .progress {
      display: none;
      height: 4px;
      background: rgba(255, 255, 255, 0.2);
      border-radius: 2px;
      overflow: hidden;
    }
    .progress.show { display: block; }
    #progressFill {
      height: 100%;
      width: 0%;
      background: var(--vscode-progressBar-background, #0a84ff);
      transition: width 0.2s linear;
    }
    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Overlay scorciatoie da tastiera (tasto ?) */
    .help {
      display: none;
      position: absolute;
      inset: 0;
      z-index: 20;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      font-family: var(--vscode-font-family, sans-serif);
    }
    .help.open { display: flex; }
    .help-card {
      background: rgba(26, 26, 30, 0.94);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
      padding: 22px 26px;
      max-width: 440px;
      width: calc(100% - 64px);
      color: #eee;
    }
    .help-title {
      font-size: 15px;
      font-weight: 700;
      margin: 0 0 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .help-title .dot { color: #e84e4e; font-size: 18px; }
    .help-grid {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 9px 16px;
      font-size: 12.5px;
      align-items: center;
    }
    .help-grid .k {
      justify-self: start;
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 6px;
      padding: 2px 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
      white-space: nowrap;
    }
    .help-grid .d { color: #cfcfcf; }
    .help-hint { margin: 18px 0 0; font-size: 11px; color: #8f8f8f; text-align: center; }

    .ic:focus-visible, .speedbtn:focus-visible, .seek:focus-visible,
    .vol:focus-visible, .speedmenu button:focus-visible {
      outline: 2px solid var(--vscode-focusBorder, #0a84ff);
      outline-offset: 1px;
    }
  </style>
</head>
<body>
  <div class="stage">
    <div id="wrap" class="wrap">
      <video id="player" preload="metadata">
        ${videoUri ? `<source src="${videoUri}" type="video/mp4" />` : ''}
      </video>
      <div id="error" class="error" role="alert">
        Unable to play this video.<br />
        The video codec may not be supported by the VS Code engine
        (e.g. <code>H.265/HEVC</code>, VP9). Supported: <code>H.264</code>
        video in MP4/MOV/M4V/MKV/AVI.
      </div>
      <div id="capMenu" class="capmenu">
        <span class="capmenu-label">Frame</span>
        <button id="capCopy" type="button">Copy</button>
        <button id="capSave" type="button">Save</button>
      </div>
      <div id="bar" class="bar">
        <input id="seek" class="seek" type="range" min="0" max="1000" step="1" value="0" aria-label="Seek" />
        <div class="row">
          <button id="playBtn" class="ic" title="Play / Pause (Space)" aria-label="Play / Pause"></button>
          <button id="backBtn" class="ic" title="Back 5s (←)" aria-label="Back 5 seconds"></button>
          <button id="fwdBtn" class="ic" title="Forward 5s (→)" aria-label="Forward 5 seconds"></button>
          <button id="loopBtn" class="ic" title="Loop (R)" aria-label="Loop"></button>
          <span id="time" class="time">0:00 / 0:00</span>
          <span class="spacer"></span>
          <button id="muteBtn" class="ic" title="Mute (M)" aria-label="Mute"></button>
          <input id="vol" class="vol" type="range" min="0" max="2" step="0.05" value="1" aria-label="Volume (drag past 100% to boost)" />
          <div class="speedWrap">
            <button id="speedBtn" class="speedbtn" title="Playback speed (&lt; &gt;)" aria-label="Playback speed">1×</button>
            <div id="speedMenu" class="speedmenu"></div>
          </div>
          <span class="sep"></span>
          ${cues.length ? `<button id="ccBtn" class="ic" title="Subtitles (C)" aria-label="Subtitles"></button>` : ''}
          <button id="camBtn" class="ic" title="Capture frame (S)" aria-label="Capture frame"></button>
          <button id="pipBtn" class="ic" title="Picture-in-Picture (P)" aria-label="Picture-in-Picture"></button>
          <button id="fsBtn" class="ic" title="Fullscreen (F)" aria-label="Fullscreen"></button>
          <button id="helpBtn" class="ic" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts"></button>
        </div>
      </div>
      <div id="help" class="help" role="dialog" aria-label="Keyboard shortcuts">
        <div class="help-card">
          <div class="help-title"><span class="dot">⌨</span> Keyboard shortcuts</div>
          <div id="helpGrid" class="help-grid"></div>
          <div class="help-hint">Press ? or Esc to close</div>
        </div>
      </div>
    </div>
  </div>
  <audio id="audio" preload="auto"></audio>
  <div id="status" aria-live="polite">
    <div class="status-row"><span class="spinner"></span><span id="statusText">Preparing…</span></div>
    <div id="progress" class="progress"><div id="progressFill"></div></div>
  </div>

  <script nonce="${nonce}">
    const player = document.getElementById('player');
    const error = document.getElementById('error');
    const audio = document.getElementById('audio');
    const status = document.getElementById('status');
    const statusText = document.getElementById('statusText');
    const progress = document.getElementById('progress');
    const progressFill = document.getElementById('progressFill');
    const wrap = document.getElementById('wrap');
    const bar = document.getElementById('bar');
    const seek = document.getElementById('seek');
    const playBtn = document.getElementById('playBtn');
    const backBtn = document.getElementById('backBtn');
    const fwdBtn = document.getElementById('fwdBtn');
    const timeEl = document.getElementById('time');
    const muteBtn = document.getElementById('muteBtn');
    const vol = document.getElementById('vol');
    const speedBtn = document.getElementById('speedBtn');
    const speedMenu = document.getElementById('speedMenu');
    const pipBtn = document.getElementById('pipBtn');
    const fsBtn = document.getElementById('fsBtn');
    const camBtn = document.getElementById('camBtn');
    const ccBtn = document.getElementById('ccBtn');
    const loopBtn = document.getElementById('loopBtn');
    const helpBtn = document.getElementById('helpBtn');
    const help = document.getElementById('help');
    const helpGrid = document.getElementById('helpGrid');

    let audioReady = false;
    let useExternal = false;
    let nativeChecked = false;
    let nativeAudioPresent = false;
    let seeking = false;
    const vscodeApi = acquireVsCodeApi();
    const SAVED = ${JSON.stringify(prefs)};
    const CUES = ${JSON.stringify(cues)};

    const IC = {
      play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
      pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
      back: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 6L5 12l6 6V6zm8 0l-6 6 6 6V6z"/></svg>',
      forward: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 6l6 6-6 6V6zM5 6l6 6-6 6V6z"/></svg>',
      volOn: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16 8.5a4 4 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
      volOff: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
      fsIn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
      fsOut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
      pip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" stroke="none"/></svg>',
      cc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M10 10.5a2 2 0 1 0 0 3M16 10.5a2 2 0 1 0 0 3" stroke-linecap="round"/></svg>',
      cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3"/></svg>',
      loop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
      help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.4 2.4 0 1 1 3.4 2.3c-0.8 0.4-1 0.9-1 1.6" stroke-linecap="round"/><circle cx="12" cy="16.6" r="0.6" fill="currentColor" stroke="none"/></svg>'
    };

    playBtn.innerHTML = IC.play;
    backBtn.innerHTML = IC.back;
    fwdBtn.innerHTML = IC.forward;
    muteBtn.innerHTML = IC.volOn;
    pipBtn.innerHTML = IC.pip;
    fsBtn.innerHTML = IC.fsIn;
    camBtn.innerHTML = IC.cam;
    loopBtn.innerHTML = IC.loop;
    loopBtn.style.opacity = '0.5'; // off di default
    helpBtn.innerHTML = IC.help;
    if (ccBtn) { ccBtn.innerHTML = IC.cc; }
    // Picture-in-Picture: nascondi il pulsante se il webview non lo supporta.
    if (!document.pictureInPictureEnabled) { pipBtn.style.display = 'none'; }

    // --- Volume con boost fino al 200% (Web Audio GainNode sull'audio esterno) ---
    let level = Math.max(0, Math.min(2, SAVED.volume)); // 0..2 (oltre 1 = boost)
    let audioCtx = null;
    let gainNode = null;
    function ensureGain() {
      if (gainNode || typeof AudioContext === 'undefined') { return; }
      try {
        audioCtx = new AudioContext();
        const srcNode = audioCtx.createMediaElementSource(audio);
        gainNode = audioCtx.createGain();
        srcNode.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        gainNode.gain.value = Math.max(1, level);
      } catch (e) { gainNode = null; }
    }
    function applyLevel(l) {
      level = Math.max(0, Math.min(2, l));
      const base = Math.min(1, level);
      player.volume = base;
      audio.volume = base;
      if (gainNode) { gainNode.gain.value = Math.max(1, level); }
      vol.value = String(level);
      vol.style.backgroundSize = (level / 2 * 100) + '% 100%';
      const muted = player.muted || level === 0;
      muteBtn.innerHTML = muted ? IC.volOff : IC.volOn;
    }

    const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    RATES.forEach((r) => {
      const b = document.createElement('button');
      b.textContent = r + '×';
      b.setAttribute('data-rate', String(r));
      speedMenu.appendChild(b);
    });

    showStatus('Preparing…', true);

    // Errore di decodifica VIDEO → messaggio chiaro.
    player.addEventListener('error', showVideoError);
    const source = player.querySelector('source');
    if (source) { source.addEventListener('error', showVideoError); }
    let lastCodec = null;
    function showVideoError() {
      if (lastCodec && !lastCodec.h264) {
        error.innerHTML = 'This video uses the <b>' + lastCodec.name +
          '</b> codec, which the VS&nbsp;Code engine cannot decode.<br />' +
          'Files with <b>H.264</b> video play here, with sound.';
      }
      player.style.display = 'none';
      bar.style.display = 'none';
      error.style.display = 'block';
      hideStatus();
    }

    function showStatus(text, spinning) {
      statusText.textContent = text;
      status.querySelector('.spinner').style.display = spinning ? 'block' : 'none';
      status.style.display = 'flex';
    }
    function hideStatus() { status.style.display = 'none'; progress.classList.remove('show'); }

    // Messaggi dall'estensione (audio pronto / assente / errore).
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'audioReady') {
        // Se il motore ha già deciso che c'è audio nativo, non aggiungere quello
        // esterno (eviteremmo l'audio doppio).
        if (nativeAudioPresent) { hideStatus(); return; }
        audio.src = msg.src;
        audioReady = true;
        useExternal = true;
        audio.volume = player.volume;
        audio.muted = player.muted;
        hideStatus();
        if (!player.paused) { syncTime(); audio.play().catch(() => {}); }
      } else if (msg.type === 'noAudio') {
        hideStatus();
      } else if (msg.type === 'converting') {
        showStatus('Converting video…', true);
        progressFill.style.width = '0%';
        progress.classList.add('show');
      } else if (msg.type === 'progress') {
        const pct = Math.max(0, Math.min(100, Math.round((msg.value || 0) * 100)));
        statusText.textContent = 'Converting video… ' + pct + '%';
        progressFill.style.width = pct + '%';
        progress.classList.add('show');
      } else if (msg.type === 'codecInfo') {
        // Codec video riconosciuto host-side: serve a dare un errore onesto se
        // la decodifica fallisce (il player ci prova comunque: se la piattaforma
        // supporta es. HEVC, riproduce lo stesso).
        lastCodec = { name: msg.name, h264: msg.h264 };
      } else if (msg.type === 'videoReady') {
        // Contenitore rimuxato (MKV/AVI/…): la sorgente arriva qui, asincrona.
        player.src = msg.src;
        player.load();
      } else if (msg.type === 'videoError') {
        if (msg.reason === 'tooLarge') {
          error.innerHTML = 'This file is too large to play here (over 1&nbsp;GB).<br />Very large files are not processed in memory yet.';
        } else if (msg.reason === 'convertTooBig') {
          error.innerHTML = 'This video is too large to convert in the editor (long or high-bitrate).<br />Shorter <b>HEVC/VP9</b> clips play here, converted to H.264 on the fly.';
        }
        showVideoError();
      }
    });

    function syncTime() {
      if (Math.abs(audio.currentTime - player.currentTime) > 0.25) {
        audio.currentTime = player.currentTime;
      }
    }

    // --- Sincronizzazione audio esterno + aggiornamento UI della barra ---
    player.addEventListener('play', () => {
      ensureGain();
      if (audioCtx && audioCtx.state === 'suspended') { audioCtx.resume(); }
      if (useExternal) { syncTime(); audio.play().catch(() => {}); }
      playBtn.innerHTML = IC.pause;
      showBar();
      scheduleHide();
    });
    player.addEventListener('pause', () => {
      if (useExternal) { audio.pause(); }
      playBtn.innerHTML = IC.play;
      showBar();
      cancelHide();
      vscodeApi.postMessage({ type: 'pos', time: player.currentTime || 0 });
    });
    player.addEventListener('seeking', () => { if (useExternal) { audio.pause(); } });
    player.addEventListener('seeked', () => {
      if (useExternal) {
        audio.currentTime = player.currentTime;
        if (!player.paused) { audio.play().catch(() => {}); }
      }
    });
    player.addEventListener('ratechange', () => {
      audio.playbackRate = player.playbackRate;
      reflectRate();
      savePrefs();
    });
    player.addEventListener('volumechange', () => {
      audio.muted = player.muted;
      const muted = player.muted || level === 0;
      muteBtn.innerHTML = muted ? IC.volOff : IC.volOn;
      savePrefs();
    });
    player.addEventListener('timeupdate', () => {
      if (useExternal && !player.paused) { syncTime(); }
      updateTime();
      savePos();
    });
    player.addEventListener('durationchange', updateTime);

    // Ripresa dalla posizione salvata + aggiornamento timeline a metadati pronti.
    let resumed = false;
    player.addEventListener('loadedmetadata', () => {
      updateTime();
      if (!resumed && SAVED.pos > 5 && SAVED.pos < (player.duration || 0) - 5) {
        player.currentTime = SAVED.pos;
      }
      resumed = true;
    });

    // Salvataggi (debounce per le preferenze, throttle per la posizione).
    let prefsTimer = null;
    function savePrefs() {
      clearTimeout(prefsTimer);
      prefsTimer = setTimeout(() => {
        vscodeApi.postMessage({
          type: 'prefs',
          volume: level,
          muted: player.muted,
          speed: player.playbackRate,
        });
      }, 400);
    }
    let lastPosSent = -10;
    function savePos() {
      const t = player.currentTime || 0;
      if (Math.abs(t - lastPosSent) >= 5) {
        lastPosSent = t;
        vscodeApi.postMessage({ type: 'pos', time: t });
      }
    }

    // Se per caso il motore decodifica davvero l'audio nativo, evitiamo l'audio doppio.
    player.addEventListener('playing', () => {
      if (nativeChecked) { return; }
      nativeChecked = true;
      setTimeout(() => {
        if ((player.webkitAudioDecodedByteCount || 0) > 0) {
          nativeAudioPresent = true;
          useExternal = false;
          audio.pause();
        }
      }, 1500);
    });

    // --- Tempo / timeline ---
    function fmt(t) {
      if (!isFinite(t) || t < 0) { t = 0; }
      t = Math.floor(t);
      const m = Math.floor(t / 60);
      const s = t % 60;
      return m + ':' + (s < 10 ? '0' : '') + s;
    }
    function updateTime() {
      const d = player.duration || 0;
      const c = player.currentTime || 0;
      timeEl.textContent = fmt(c) + ' / ' + fmt(d);
      const pct = d ? (c / d) * 100 : 0;
      if (!seeking) { seek.value = String(Math.round(pct * 10)); }
      seek.style.backgroundSize = pct + '% 100%';
    }
    seek.addEventListener('input', () => {
      seeking = true;
      const d = player.duration || 0;
      const pct = parseFloat(seek.value) / 10;
      player.currentTime = (pct / 100) * d;
      seek.style.backgroundSize = pct + '% 100%';
    });
    seek.addEventListener('change', () => { seeking = false; });

    // --- Pulsanti ---
    function togglePlay() { player.paused ? player.play() : player.pause(); }
    playBtn.addEventListener('click', togglePlay);
    // Click sul video = play/pausa; doppio click = fullscreen (Zen).
    let clickTimer = null;
    player.addEventListener('click', () => {
      if (clickTimer) { return; }
      clickTimer = setTimeout(() => { clickTimer = null; togglePlay(); }, 220);
    });
    player.addEventListener('dblclick', () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      toggleFs();
    });
    backBtn.addEventListener('click', () => { player.currentTime -= 5; });
    fwdBtn.addEventListener('click', () => { player.currentTime += 5; });
    muteBtn.addEventListener('click', () => { player.muted = !player.muted; });
    vol.addEventListener('input', () => {
      player.muted = false;
      applyLevel(parseFloat(vol.value));
      savePrefs();
    });

    // --- Loop ---  (l'audio esterno si risincronizza da solo via 'seeked' al rientro)
    function toggleLoop() {
      player.loop = !player.loop;
      loopBtn.style.opacity = player.loop ? '1' : '0.5';
    }
    loopBtn.addEventListener('click', toggleLoop);

    // --- Velocità ---
    function setRate(r) {
      r = Math.min(2, Math.max(0.25, Math.round(r * 100) / 100));
      player.playbackRate = r;
    }
    function reflectRate() {
      speedBtn.textContent = player.playbackRate + '×';
      speedMenu.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('active', parseFloat(b.getAttribute('data-rate')) === player.playbackRate);
      });
    }
    speedBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      speedMenu.classList.toggle('open');
    });
    speedMenu.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) { return; }
      setRate(parseFloat(b.getAttribute('data-rate')));
      speedMenu.classList.remove('open');
    });
    document.addEventListener('click', () => speedMenu.classList.remove('open'));

    // --- Fullscreen ---
    // La Fullscreen API è bloccata nei webview di VS Code, quindi usiamo lo
    // "Zen Mode" dell'editor (schermo intero, nessuna interfaccia) via estensione.
    let zen = false;
    function toggleFs() {
      vscodeApi.postMessage({ type: 'toggleZen' });
      zen = !zen;
      fsBtn.innerHTML = zen ? IC.fsOut : IC.fsIn;
    }
    fsBtn.addEventListener('click', toggleFs);

    // --- Picture-in-Picture (finestra video flottante; l'audio resta in sync) ---
    async function togglePip() {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (document.pictureInPictureEnabled) {
          await player.requestPictureInPicture();
        }
      } catch (err) {
        /* PiP non disponibile o negato: ignora */
      }
    }
    pipBtn.addEventListener('click', togglePip);

    // --- Cattura fotogramma (PNG): mostra menù Copy / Save ---
    const capMenu = document.getElementById('capMenu');
    const capCopy = document.getElementById('capCopy');
    const capSave = document.getElementById('capSave');
    let capturedData = null;
    function captureFrame() {
      if (!player.videoWidth) { return; }
      const c = document.createElement('canvas');
      c.width = player.videoWidth;
      c.height = player.videoHeight;
      c.getContext('2d').drawImage(player, 0, 0, c.width, c.height);
      try { capturedData = c.toDataURL('image/png'); } catch (e) { capturedData = null; return; }
      capMenu.classList.add('open');
      showBar();
    }
    camBtn.addEventListener('click', captureFrame);
    capSave.addEventListener('click', () => {
      if (capturedData) { vscodeApi.postMessage({ type: 'saveFrame', data: capturedData }); }
      capMenu.classList.remove('open');
    });
    function dataUrlToBlob(dataUrl) {
      const comma = dataUrl.indexOf(',');
      const mime = (dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png');
      const bin = atob(dataUrl.slice(comma + 1));
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) { arr[i] = bin.charCodeAt(i); }
      return new Blob([arr], { type: mime });
    }
    capCopy.addEventListener('click', async () => {
      if (!capturedData) { return; }
      try {
        const blob = dataUrlToBlob(capturedData);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        showStatus('Frame copied', false);
        setTimeout(hideStatus, 1200);
      } catch (e) {
        showStatus('Copy not available', false);
        setTimeout(hideStatus, 1800);
      }
      capMenu.classList.remove('open');
    });
    document.addEventListener('click', (e) => {
      if (!capMenu.classList.contains('open')) { return; }
      if (capMenu.contains(e.target) || camBtn.contains(e.target) || e.target === camBtn) { return; }
      capMenu.classList.remove('open');
    });

    // --- Sottotitoli: cue iniettati via JS (niente <track> esterno → niente CSP) ---
    let ccTrack = null;
    let ccOn = true;
    if (CUES && CUES.length) {
      ccTrack = player.addTextTrack('subtitles', 'Subtitles', 'und');
      CUES.forEach((c) => {
        try { ccTrack.addCue(new VTTCue(c.start, c.end, c.text)); } catch (e) {}
      });
      ccTrack.mode = 'showing';
    }
    function showSubHint() {
      showStatus('Subtitles on · press Z / X to fix timing', false);
      setTimeout(hideStatus, 2800);
    }
    function toggleCC() {
      if (!ccTrack) { return; }
      ccOn = !ccOn;
      ccTrack.mode = ccOn ? 'showing' : 'hidden';
      if (ccBtn) { ccBtn.style.opacity = ccOn ? '1' : '0.5'; }
      if (ccOn) { showSubHint(); }
    }
    if (ccBtn) { ccBtn.addEventListener('click', toggleCC); }
    // I sottotitoli partono già attivi: mostra una volta l'hint sui tasti Z/X,
    // ma solo quando il badge è libero (no "Preparing/Converting" in corso).
    if (ccTrack) {
      setTimeout(() => {
        if (status.style.display === 'none') { showSubHint(); }
      }, 2200);
    }

    // --- Delay sottotitoli (Z indietro / X avanti): ricrea i cue con offset ---
    let subOffset = 0;
    function shiftSubs(delta) {
      if (!ccTrack) { return; }
      subOffset = Math.round((subOffset + delta) * 10) / 10;
      while (ccTrack.cues && ccTrack.cues.length) { ccTrack.removeCue(ccTrack.cues[0]); }
      CUES.forEach((c) => {
        const s = Math.max(0, c.start + subOffset);
        const e = Math.max(s + 0.1, c.end + subOffset);
        try { ccTrack.addCue(new VTTCue(s, e, c.text)); } catch (err) {}
      });
      showStatus('Subtitles ' + (subOffset >= 0 ? '+' : '') + subOffset.toFixed(1) + 's', false);
      setTimeout(hideStatus, 1000);
    }

    // --- Avanzamento frame-by-frame (, indietro / . avanti), a video in pausa ---
    const FRAME = 1 / 30; // passo di default (~30 fps: il webview non espone gli fps reali)
    function stepFrame(dir) {
      player.pause();
      const d = player.duration || 0;
      player.currentTime = Math.max(0, Math.min(d, player.currentTime + dir * FRAME));
      showStatus(dir < 0 ? '◄ Frame' : 'Frame ►', false);
      setTimeout(hideStatus, 700);
      showBar();
    }

    // --- Overlay scorciatoie (tasto ?) ---
    const SHORTCUTS = [
      ['Space / K', 'Play / pause'],
      ['← / →', 'Skip 5s back / forward'],
      [', / .', 'Previous / next frame (paused)'],
      ['↑ / ↓', 'Volume up / down (boost to 200%)'],
      ['< / >', 'Slower / faster'],
      ['M', 'Mute'],
      ['R', 'Loop'],
      ['S', 'Capture frame'],
    ];
    if (document.pictureInPictureEnabled) { SHORTCUTS.push(['P', 'Picture-in-Picture']); }
    SHORTCUTS.push(['F', 'Fullscreen']);
    if (CUES && CUES.length) {
      SHORTCUTS.push(['C', 'Toggle subtitles']);
      SHORTCUTS.push(['Z / X', 'Subtitle timing − / +']);
    }
    SHORTCUTS.push(['?', 'This help']);
    SHORTCUTS.forEach(([k, d]) => {
      const kEl = document.createElement('span'); kEl.className = 'k'; kEl.textContent = k;
      const dEl = document.createElement('span'); dEl.className = 'd'; dEl.textContent = d;
      helpGrid.appendChild(kEl); helpGrid.appendChild(dEl);
    });
    function toggleHelp() {
      help.classList.toggle('open');
      if (help.classList.contains('open')) { showBar(); cancelHide(); }
    }
    helpBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleHelp(); });
    help.addEventListener('click', (e) => { if (e.target === help) { help.classList.remove('open'); } });

    // --- Auto-hide della barra ---
    let hideTimer = null;
    function showBar() {
      bar.classList.remove('hidden');
      wrap.classList.remove('idle');
    }
    function hideBar() {
      if (!player.paused && !speedMenu.classList.contains('open')) {
        bar.classList.add('hidden');
        wrap.classList.add('idle');
      }
    }
    function scheduleHide() {
      cancelHide();
      hideTimer = setTimeout(hideBar, 2500);
    }
    function cancelHide() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    }
    wrap.addEventListener('mousemove', () => { showBar(); scheduleHide(); });
    wrap.addEventListener('mouseleave', () => { if (!player.paused) { hideBar(); } });
    // Rotellina sul player = volume su/giù.
    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      player.muted = false;
      const step = e.deltaY < 0 ? 0.05 : -0.05;
      applyLevel(level + step);
      savePrefs();
    }, { passive: false });
    bar.addEventListener('mouseenter', cancelHide);
    bar.addEventListener('mouseleave', () => { if (!player.paused) { scheduleHide(); } });

    // --- Scorciatoie da tastiera ---
    document.addEventListener('keydown', (e) => {
      if (e.target && e.target.tagName === 'INPUT') { return; }
      switch (e.key) {
        case 'Escape':
          // Chiude i menù a comparsa (velocità / cattura / scorciatoie) se aperti.
          speedMenu.classList.remove('open');
          if (capMenu) { capMenu.classList.remove('open'); }
          help.classList.remove('open');
          break;
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowRight': player.currentTime += 5; break;
        case 'ArrowLeft': player.currentTime -= 5; break;
        case 'ArrowUp':
          e.preventDefault();
          player.muted = false;
          applyLevel(level + 0.1);
          savePrefs();
          break;
        case 'ArrowDown':
          e.preventDefault();
          applyLevel(level - 0.1);
          savePrefs();
          break;
        case 'f': toggleFs(); break;
        case 'p': togglePip(); break;
        case 's': captureFrame(); break;
        case 'c': toggleCC(); break;
        case 'r': toggleLoop(); break;
        case 'z': shiftSubs(-0.5); break;
        case 'x': shiftSubs(0.5); break;
        case 'm': player.muted = !player.muted; break;
        case '>':
          e.preventDefault();
          setRate(player.playbackRate + 0.25);
          break;
        case '<':
          e.preventDefault();
          setRate(player.playbackRate - 0.25);
          break;
        case ',': stepFrame(-1); break;
        case '.': stepFrame(1); break;
        case '?':
          e.preventDefault();
          toggleHelp();
          break;
      }
    });

    // Stato iniziale: applica volume/velocità salvati (gli handler sincronizzano
    // slider, icone e audio); la posizione si riprende a 'loadedmetadata'.
    player.muted = SAVED.muted;
    applyLevel(SAVED.volume);
    setRate(SAVED.speed);
    reflectRate();
    updateTime();
  </script>
</body>
</html>`;
  }
}

/** Cartella temporanea per gli audio transcodificati (riusata come cache). */
function getTempDir(): string {
  const dir = path.join(os.tmpdir(), 'vscode-mp4-player');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Pulizia automatica della cache audio: elimina i file più vecchi di 7 giorni
 * e, se la cartella supera 1 GB, rimuove i meno usati finché non rientra.
 */
function cleanupCache(): void {
  try {
    const dir = getTempDir();
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    const maxTotalBytes = 1024 * 1024 * 1024; // 1 GB
    const now = Date.now();

    let files = fs
      .readdirSync(dir)
      .filter(
        (f) =>
          f.endsWith('.mp3') ||
          f.endsWith('.mp4') ||
          f.endsWith('.part'), // .part = scritture atomiche interrotte (orfani)
      )
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        return { full, size: st.size, mtime: st.mtimeMs };
      });

    // 1) elimina i file vecchi
    files = files.filter((e) => {
      if (now - e.mtime > maxAgeMs) {
        try {
          fs.unlinkSync(e.full);
        } catch {
          /* ignora */
        }
        return false;
      }
      return true;
    });

    // 2) limita la dimensione totale eliminando i meno recenti
    files.sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((sum, e) => sum + e.size, 0);
    for (const e of files) {
      if (total <= maxTotalBytes) {
        break;
      }
      try {
        fs.unlinkSync(e.full);
        total -= e.size;
      } catch {
        /* ignora */
      }
    }
  } catch {
    /* la pulizia è best-effort */
  }
}

// Oltre questa soglia ffmpeg-WASM caricherebbe in memoria un file troppo grande:
// si salta l'estrazione audio (il video va comunque). Lo streaming a chunk
// arriverà con la build WASM su misura.
const MAX_INPUT_BYTES = 1024 * 1024 * 1024; // 1 GB

// Tier B1 — transcodifica HEVC → H.264 (il webview non decodifica HEVC, ma il
// core WASM sì). Costa TEMPO (re-encode di ogni frame): ~realtime a 720p, ~2× a
// 1080p, inaccettabile a 4K/lunghi. Gate per DIMENSIONE sorgente (proxy della
// durata×risoluzione): sopra soglia → errore onesto, così l'attesa resta nei
// minuti. La dimensione è anche il gate più robusto: niente probe = una sola
// istanza WASM per apertura (un probe separato può far crashare la transcodifica
// successiva per pressione di memoria del core monothread).
const MAX_TRANSCODE_BYTES = 128 * 1024 * 1024; // ~128 MB

/**
 * Esegue un comando ffmpeg-WASM in un'istanza usa-e-getta e ne legge un output.
 * Tollerante: se il core fallisce o crasha (es. libmp3lame senza traccia audio
 * → "memory access out of bounds"), restituisce undefined invece di propagare.
 */
async function ffmpegRun(
  inName: string,
  inData: Uint8Array,
  args: string[],
  outName: string,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array | undefined> {
  // Con onProgress: log attivo + parsing live di "frame= N" (e Duration/fps per il
  // totale) → percentuale reale della transcodifica. Il logger viene chiamato dal
  // vivo durante la run, così possiamo riportare l'avanzamento.
  let opts: Record<string, unknown> = { core: '@ffmpeg.wasm/core-st' };
  if (onProgress) {
    let durSec = 0;
    let fps = 0;
    let total = 0;
    let lastPct = -1;
    opts = {
      core: '@ffmpeg.wasm/core-st',
      log: true,
      logger: (_lvl: string, m: string): void => {
        if (typeof m !== 'string') { return; }
        if (!total) {
          const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(m);
          if (d) { durSec = +d[1] * 3600 + +d[2] * 60 + +d[3]; }
          const f = /(\d+(?:\.\d+)?)\s*fps\b/.exec(m);
          if (f) { fps = parseFloat(f[1]); }
          if (durSec > 0 && fps > 0) { total = Math.round(durSec * fps); }
        }
        const fr = /frame=\s*(\d+)/.exec(m);
        if (fr && total > 0) {
          const pct = Math.min(99, Math.floor((+fr[1] / total) * 100));
          if (pct > lastPct) { lastPct = pct; onProgress(pct / 100); }
        }
      },
    };
  }
  const ffmpeg = await FFmpeg.create(opts as never);
  try {
    ffmpeg.fs.writeFile(inName, inData);
    const code = await ffmpeg.run(...args);
    if (code !== 0) {
      return undefined;
    }
    try {
      return ffmpeg.fs.readFile(outName);
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    try {
      ffmpeg.exit('kill');
    } catch {
      /* ignora */
    }
  }
}

/**
 * Estrae la traccia audio e la transcodifica in MP3 con ffmpeg-WASM, eseguito
 * nell'extension host. Ritorna il percorso del file audio, oppure null se il
 * video non ha audio (o la traccia non è estraibile).
 */
async function prepareAudio(
  srcPath: string,
  tempDir: string,
): Promise<{ audioPath: string | null; codec: { name: string; h264: boolean } | null }> {
  const stat = await fs.promises.stat(srcPath);
  const key = createHash('sha1')
    .update(srcPath + '|' + stat.size + '|' + stat.mtimeMs)
    .digest('hex')
    .slice(0, 16);

  // Cache: riusa un audio già transcodificato (l'audio era già stato estratto,
  // quindi il file aveva aperto bene: il codec non serve più, fallback al generico).
  const cached = path.join(tempDir, key + '.mp3');
  if (fs.existsSync(cached) && fs.statSync(cached).size > 0) {
    try {
      const now = new Date();
      fs.utimesSync(cached, now, now);
    } catch {
      /* ignora */
    }
    return { audioPath: cached, codec: null };
  }

  if (stat.size > MAX_INPUT_BYTES) {
    return { audioPath: null, codec: null };
  }

  const srcData = await fs.promises.readFile(srcPath);
  const codec = videoCodec(srcData); // file nativo = ISOBMFF → leggibile

  // Istanza ffmpeg-WASM monouso: il core esce dopo un run, quindi ne creiamo una
  // per chiamata (il caricamento del modulo è ~50 ms).
  const ffmpeg = await FFmpeg.create({ core: '@ffmpeg.wasm/core-st' });
  try {
    const inName = 'input' + path.extname(srcPath).toLowerCase();
    ffmpeg.fs.writeFile(inName, srcData);
    const code = await ffmpeg.run(
      '-i', inName, '-vn',
      // Niente ricampionamento forzato (-ar): l'MP3 esce al sample rate della
      // sorgente — il webview lo riproduce comunque e si evita un resample che
      // costa ~1/3 del tempo audio. Manteniamo -ac 2 per il downmix surround→stereo.
      '-c:a', 'libmp3lame', '-q:a', '4', '-ac', '2',
      'output.mp3',
    );
    let out: Uint8Array | undefined;
    try {
      out = ffmpeg.fs.readFile('output.mp3');
    } catch {
      out = undefined;
    }
    if (code === 0 && out && out.length > 0) {
      const outPath = path.join(tempDir, key + '.mp3');
      await writeAtomic(outPath, Buffer.from(out));
      return { audioPath: outPath, codec };
    }
    return { audioPath: null, codec }; // nessuna traccia audio estraibile
  } finally {
    try {
      ffmpeg.exit('kill');
    } catch {
      /* ignora */
    }
  }
}

/**
 * Per i contenitori che il webview non sa aprire (MKV/AVI): rimuxa il
 * video (copia, senza ricodificare) in un MP4 temporaneo riproducibile ed estrae
 * l'audio in MP3, in un'unica esecuzione di ffmpeg-WASM. Il video è null se il
 * rimux non riesce o il file è troppo grande; l'audio è null se non c'è traccia.
 */
async function prepareRemux(
  srcPath: string,
  tempDir: string,
  onTranscode?: () => void,
  onProgress?: (fraction: number) => void,
): Promise<{
  videoPath: string | null;
  audioPath: string | null;
  tooLarge?: boolean;
  convertTooBig?: boolean;
  codec?: { name: string; h264: boolean } | null;
}> {
  const stat = await fs.promises.stat(srcPath);
  const key = createHash('sha1')
    .update(srcPath + '|' + stat.size + '|' + stat.mtimeMs)
    .digest('hex')
    .slice(0, 16);
  const videoPath = path.join(tempDir, key + '.mp4');
  const audioPath = path.join(tempDir, key + '.mp3');

  const touch = (p: string): void => {
    try {
      const now = new Date();
      fs.utimesSync(p, now, now);
    } catch {
      /* ignora */
    }
  };

  // Cache: riusa video (e audio) già rimuxati.
  if (fs.existsSync(videoPath) && fs.statSync(videoPath).size > 0) {
    touch(videoPath);
    const haveAudio =
      fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0;
    if (haveAudio) {
      touch(audioPath);
    }
    return { videoPath, audioPath: haveAudio ? audioPath : null };
  }

  if (stat.size > MAX_INPUT_BYTES) {
    return { videoPath: null, audioPath: null, tooLarge: true };
  }

  // Riconosciamo il codec dalla SORGENTE prima del remux: così possiamo dare un
  // errore onesto ("HEVC", "VP9", …) anche se la copia fallisce o fa crashare il
  // core WASM (succede copiando HEVC da MKV in MP4).
  const srcData = await fs.promises.readFile(srcPath);
  const codec = videoCodec(srcData);
  const ext = path.extname(srcPath).toLowerCase();

  // Decidiamo cosa fare del VIDEO in base al codec sorgente:
  //  • H.264 (o sconosciuto) → copia (no re-encode): rapidissimo.
  //  • HEVC / VP9 / VP8 → li decodifichiamo nel core WASM → transcodifica in
  //    H.264 (entro il gating). VP9/VP8 sono il video dei WebM.
  //  • AV1 / MPEG-2 / altro → decoder assente: errore onesto.
  const transcodable = codec ? /HEVC|VP9|VP8/.test(codec.name) : false;
  if (codec && !codec.h264 && !transcodable) {
    return { videoPath: null, audioPath: null, codec };
  }
  let transcode = false;
  if (transcodable) {
    if (stat.size > MAX_TRANSCODE_BYTES) {
      return { videoPath: null, audioPath: null, codec, convertTooBig: true };
    }
    transcode = true;
  }

  if (transcode) {
    onTranscode?.(); // avvisa il webview: l'attesa sarà più lunga del solito
  }

  const inName = 'input' + ext;
  const vArgs = transcode
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'copy'];

  // Due run SEPARATI (istanze usa-e-getta), non uno combinato: l'estrazione audio
  // con libmp3lame fa crashare il core se non c'è traccia audio. Tenendoli distinti,
  // il VIDEO esce sempre (copia o transcodifica) e l'AUDIO è best-effort.
  const v = await ffmpegRun(
    inName, srcData,
    ['-i', inName, '-map', '0:v:0?', ...vArgs, '-an', 'video.mp4'],
    'video.mp4',
    transcode ? onProgress : undefined, // progresso solo quando si transcodifica
  );
  const a = await ffmpegRun(
    inName, srcData,
    // Niente -ar (vedi prepareAudio): MP3 al rate sorgente, ~1/3 più veloce.
    ['-i', inName, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', '-ac', '2', 'audio.mp3'],
    'audio.mp3',
  );

  let vp: string | null = null;
  let ap: string | null = null;
  if (v && v.length > 0) {
    await writeAtomic(videoPath, Buffer.from(v));
    vp = videoPath;
  }
  if (a && a.length > 0) {
    await writeAtomic(audioPath, Buffer.from(a));
    ap = audioPath;
  }
  return { videoPath: vp, audioPath: ap, codec };
}

function getNonce(): string {
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}
