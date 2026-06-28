import * as vscode from 'vscode';
import { randomBytes, createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { FFmpeg } from '@ffmpeg.wasm/main';

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

interface Cue {
  start: number;
  end: number;
  text: string;
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
        return parseCues(fs.readFileSync(p, 'utf8'));
      }
    }
  } catch {
    /* sottotitoli best-effort */
  }
  return [];
}

/** Parser minimale di SRT/WebVTT → cue (secondi). Gestisce sia "," sia "." nei ms. */
function parseCues(content: string): Cue[] {
  const cues: Cue[] = [];
  const toSec = (s: string): number => {
    const m = /(\d\d):(\d\d):(\d\d)[.,](\d{1,3})/.exec(s);
    return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000 : -1;
  };
  for (const block of content.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block
      .split('\n')
      .filter((l) => l.trim() && l.trim().toUpperCase() !== 'WEBVTT');
    const arrow = lines.find((l) => l.includes('-->'));
    if (!arrow) {
      continue;
    }
    const [a, b] = arrow.split('-->');
    const start = toSec(a);
    const end = toSec(b);
    if (start < 0 || end < 0) {
      continue;
    }
    const text = lines.slice(lines.indexOf(arrow) + 1).join('\n').trim();
    if (text) {
      cues.push({ start, end, text });
    }
  }
  return cues;
}

/**
 * Riconosce il codec VIDEO leggendo il fourcc del sample-entry (box `stsd`) in un
 * file ISOBMFF (MP4/MOV/M4V/F4V, e l'MP4 prodotto dal remux). Serve solo a dare un
 * messaggio d'errore onesto ("HEVC", "VP9", …) quando il motore non sa decodificare:
 * best-effort, niente parsing pesante.
 */
function videoCodec(buf: Buffer): { name: string; h264: boolean } | null {
  const MAP: Record<string, string> = {
    avc1: 'H.264', avc3: 'H.264',
    hvc1: 'HEVC (H.265)', hev1: 'HEVC (H.265)',
    vp08: 'VP8', vp09: 'VP9', av01: 'AV1',
    mp4v: 'MPEG-4 Part 2', ap4h: 'ProRes', apcn: 'ProRes',
  };
  const AUDIO = new Set([
    'mp4a', 'ac-3', 'ec-3', 'alac', 'Opus', 'fLaC', 'sowt', 'twos', 'samr', '.mp3',
  ]);
  const found: string[] = [];
  let i = 0;
  while (i < buf.length && found.length < 8) {
    const p = buf.indexOf('stsd', i, 'latin1');
    if (p < 0) { break; }
    // fourcc = stsd(4) + versione/flag(4) + numero voci(4) + dimensione voce(4)
    if (p + 20 <= buf.length) {
      found.push(buf.toString('latin1', p + 16, p + 20));
    }
    i = p + 4;
  }
  for (const cc of found) {
    if (MAP[cc]) { return { name: MAP[cc], h264: cc === 'avc1' || cc === 'avc3' }; }
  }
  for (const cc of found) {
    if (!AUDIO.has(cc)) {
      const clean = cc.replace(/[^\x20-\x7e]/g, '').trim();
      return { name: clean || 'unknown', h264: false };
    }
  }
  // Fallback Matroska/WebM: il codec è una stringa CodecID nell'header EBML.
  const head = buf.toString('latin1', 0, Math.min(buf.length, 1 << 18));
  const MKV: [string, string, boolean][] = [
    ['V_MPEG4/ISO/AVC', 'H.264', true],
    ['V_MPEGH/ISO/HEVC', 'HEVC (H.265)', false],
    ['V_VP9', 'VP9', false],
    ['V_VP8', 'VP8', false],
    ['V_AV1', 'AV1', false],
    ['V_MPEG4/ISO/ASP', 'MPEG-4 Part 2', false],
    ['V_MPEG2', 'MPEG-2', false],
  ];
  for (const [sig, name, h264] of MKV) {
    if (head.includes(sig)) { return { name, h264 }; }
  }
  return null;
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
        .catch((err: unknown) => {
          if (disposed) {
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          webviewPanel.webview.postMessage({ type: 'audioError', message });
        });
    } else {
      // MKV/AVI: il webview non apre il contenitore. Rimuxiamo il video (H.264)
      // in un MP4 temporaneo e lo inviamo, più l'audio in MP3.
      webviewPanel.webview.html = this.getHtml(webviewPanel.webview, prefs, undefined, cues);
      once('remux:' + fsPath, () => prepareRemux(fsPath, tempDir))
        .then((res) => {
          if (disposed) {
            return;
          }
          // Codec noto dalla sorgente: lo mandiamo SEMPRE (anche se il remux
          // fallisce), così l'overlay d'errore può nominarlo onestamente.
          sendCodec(res.codec ?? null);
          if (res.videoPath) {
            const vUri = webviewPanel.webview.asWebviewUri(
              vscode.Uri.file(res.videoPath),
            );
            webviewPanel.webview.postMessage({
              type: 'videoReady',
              src: vUri.toString(),
            });
          } else {
            webviewPanel.webview.postMessage({
              type: 'videoError',
              reason: res.tooLarge ? 'tooLarge' : 'failed',
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
      bottom: 72px;
      transform: translateX(-50%);
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: rgba(28, 28, 28, 0.96);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
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

    /* Barra di controlli custom, a comparsa */
    .bar {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 4px 12px 10px;
      background: linear-gradient(to top, rgba(0, 0, 0, 0.85), rgba(0, 0, 0, 0));
      font-family: var(--vscode-font-family, sans-serif);
      color: #fff;
      opacity: 1;
      transition: opacity 0.25s ease;
      z-index: 5;
      user-select: none;
    }
    .bar.hidden { opacity: 0; pointer-events: none; }
    .row { display: flex; align-items: center; gap: 4px; }
    .ic {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      padding: 0;
      background: transparent;
      border: none;
      color: #fff;
      cursor: pointer;
      border-radius: 4px;
    }
    .ic:hover { background: rgba(255, 255, 255, 0.18); }
    .ic svg { width: 20px; height: 20px; display: block; }
    .time {
      font-size: 12px;
      color: #eee;
      margin: 0 8px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .spacer { flex: 1; }

    /* Timeline */
    .seek {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 4px;
      margin: 4px 0 8px;
      padding: 0;
      border-radius: 2px;
      cursor: pointer;
      background-color: rgba(255, 255, 255, 0.25);
      background-image: linear-gradient(#e84e4e, #e84e4e);
      background-size: 0% 100%;
      background-repeat: no-repeat;
    }
    .seek::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 13px;
      height: 13px;
      border-radius: 50%;
      background: #e84e4e;
      border: none;
      cursor: pointer;
    }

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
      background: transparent;
      border: none;
      color: #fff;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      padding: 6px 8px;
      border-radius: 4px;
      min-width: 40px;
    }
    .speedbtn:hover { background: rgba(255, 255, 255, 0.18); }
    .speedmenu {
      display: none;
      position: absolute;
      bottom: 40px;
      right: 0;
      background: rgba(28, 28, 28, 0.97);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 4px;
      min-width: 66px;
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
      align-items: center;
      gap: 8px;
      background: rgba(0, 0, 0, 0.7);
      color: #ddd;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 12px;
      padding: 6px 10px;
      border-radius: 6px;
      z-index: 10;
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
          <span id="time" class="time">0:00 / 0:00</span>
          <span class="spacer"></span>
          <button id="muteBtn" class="ic" title="Mute (M)" aria-label="Mute"></button>
          <input id="vol" class="vol" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume" />
          <div class="speedWrap">
            <button id="speedBtn" class="speedbtn" title="Playback speed (&lt; &gt;)" aria-label="Playback speed">1×</button>
            <div id="speedMenu" class="speedmenu"></div>
          </div>
          ${cues.length ? `<button id="ccBtn" class="ic" title="Subtitles (C)" aria-label="Subtitles"></button>` : ''}
          <button id="camBtn" class="ic" title="Capture frame (S)" aria-label="Capture frame"></button>
          <button id="pipBtn" class="ic" title="Picture-in-Picture (P)" aria-label="Picture-in-Picture"></button>
          <button id="fsBtn" class="ic" title="Fullscreen (F)" aria-label="Fullscreen"></button>
        </div>
      </div>
    </div>
  </div>
  <audio id="audio" preload="auto"></audio>
  <div id="status" aria-live="polite"><span class="spinner"></span><span id="statusText">Preparing…</span></div>

  <script nonce="${nonce}">
    const player = document.getElementById('player');
    const error = document.getElementById('error');
    const audio = document.getElementById('audio');
    const status = document.getElementById('status');
    const statusText = document.getElementById('statusText');
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
      cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3"/></svg>'
    };

    playBtn.innerHTML = IC.play;
    backBtn.innerHTML = IC.back;
    fwdBtn.innerHTML = IC.forward;
    muteBtn.innerHTML = IC.volOn;
    pipBtn.innerHTML = IC.pip;
    fsBtn.innerHTML = IC.fsIn;
    camBtn.innerHTML = IC.cam;
    if (ccBtn) { ccBtn.innerHTML = IC.cc; }
    // Picture-in-Picture: nascondi il pulsante se il webview non lo supporta.
    if (!document.pictureInPictureEnabled) { pipBtn.style.display = 'none'; }

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
    function hideStatus() { status.style.display = 'none'; }

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
      } else if (msg.type === 'audioError') {
        showStatus('Audio unavailable: ' + msg.message, false);
        setTimeout(hideStatus, 7000);
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
      audio.volume = player.volume;
      audio.muted = player.muted;
      const muted = player.muted || player.volume === 0;
      muteBtn.innerHTML = muted ? IC.volOff : IC.volOn;
      const v = player.muted ? 0 : player.volume;
      vol.value = String(v);
      vol.style.backgroundSize = (v * 100) + '% 100%';
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
          volume: player.volume,
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
      player.volume = parseFloat(vol.value);
    });

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
    function toggleCC() {
      if (!ccTrack) { return; }
      ccOn = !ccOn;
      ccTrack.mode = ccOn ? 'showing' : 'hidden';
      if (ccBtn) { ccBtn.style.opacity = ccOn ? '1' : '0.5'; }
    }
    if (ccBtn) { ccBtn.addEventListener('click', toggleCC); }

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
      player.volume = Math.min(1, Math.max(0, player.volume + step));
    }, { passive: false });
    bar.addEventListener('mouseenter', cancelHide);
    bar.addEventListener('mouseleave', () => { if (!player.paused) { scheduleHide(); } });

    // --- Scorciatoie da tastiera ---
    document.addEventListener('keydown', (e) => {
      if (e.target && e.target.tagName === 'INPUT') { return; }
      switch (e.key) {
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
          player.volume = Math.min(1, player.volume + 0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          player.volume = Math.max(0, player.volume - 0.1);
          break;
        case 'f': toggleFs(); break;
        case 'p': togglePip(); break;
        case 's': captureFrame(); break;
        case 'c': toggleCC(); break;
        case 'm': player.muted = !player.muted; break;
        case '>':
          e.preventDefault();
          setRate(player.playbackRate + 0.25);
          break;
        case '<':
          e.preventDefault();
          setRate(player.playbackRate - 0.25);
          break;
      }
    });

    // Stato iniziale: applica volume/velocità salvati (gli handler sincronizzano
    // slider, icone e audio); la posizione si riprende a 'loadedmetadata'.
    player.volume = SAVED.volume;
    player.muted = SAVED.muted;
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
          f.endsWith('.wav') ||
          f.endsWith('.mp4') ||
          f.endsWith('.vtt'),
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
  for (const ext of ['.mp3', '.wav']) {
    const cached = path.join(tempDir, key + ext);
    if (fs.existsSync(cached) && fs.statSync(cached).size > 0) {
      try {
        const now = new Date();
        fs.utimesSync(cached, now, now);
      } catch {
        /* ignora */
      }
      return { audioPath: cached, codec: null };
    }
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
      '-c:a', 'libmp3lame', '-q:a', '4',
      '-ar', '48000', '-ac', '2',
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
): Promise<{
  videoPath: string | null;
  audioPath: string | null;
  tooLarge?: boolean;
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

  // Se sappiamo già che il video non è H.264 (es. HEVC/VP9 in MKV), inutile (e
  // rischioso: il core può crashare) tentare la copia → errore onesto e basta.
  if (codec && !codec.h264) {
    return { videoPath: null, audioPath: null, codec };
  }

  const ffmpeg = await FFmpeg.create({ core: '@ffmpeg.wasm/core-st' });
  try {
    const inName = 'input' + path.extname(srcPath).toLowerCase();
    ffmpeg.fs.writeFile(inName, srcData);
    // Un solo run: video copiato in MP4 (no re-encode, no audio) + audio in MP3.
    const code = await ffmpeg.run(
      '-i', inName,
      '-map', '0:v:0?', '-c:v', 'copy', '-an', 'video.mp4',
      '-map', '0:a:0?', '-c:a', 'libmp3lame', '-q:a', '4',
      '-ar', '48000', '-ac', '2', 'audio.mp3',
    );
    let v: Uint8Array | undefined;
    let a: Uint8Array | undefined;
    try {
      v = ffmpeg.fs.readFile('video.mp4');
    } catch {
      v = undefined;
    }
    try {
      a = ffmpeg.fs.readFile('audio.mp3');
    } catch {
      a = undefined;
    }
    // Se ffmpeg è fallito (code != 0) non ci fidiamo di output parziali.
    let vp: string | null = null;
    let ap: string | null = null;
    if (code === 0 && v && v.length > 0) {
      await writeAtomic(videoPath, Buffer.from(v));
      vp = videoPath;
    }
    if (code === 0 && a && a.length > 0) {
      await writeAtomic(audioPath, Buffer.from(a));
      ap = audioPath;
    }
    return { videoPath: vp, audioPath: ap, codec };
  } catch {
    // Il core può andare in "memory access out of bounds" copiando certi codec:
    // niente video, ma il codec lo conosciamo già dalla sorgente.
    return { videoPath: null, audioPath: null, codec };
  } finally {
    try {
      ffmpeg.exit('kill');
    } catch {
      /* ignora */
    }
  }
}

function getNonce(): string {
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}
