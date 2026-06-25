import * as vscode from 'vscode';
import { randomBytes, createHash } from 'crypto';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Percorso del binario ffmpeg incluso (ffmpeg-static). Il motore di VS Code non
// decodifica l'audio AAC degli MP4/MOV/M4V, quindi estraiamo/transcodifichiamo la
// traccia audio in MP3 (che la Webview riproduce) e la sincronizziamo col video.
let ffmpegPath: string | undefined;
try {
  ffmpegPath = require('ffmpeg-static') as string;
} catch {
  ffmpegPath = undefined;
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
 * Custom Editor in sola lettura per i file .mp4.
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

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [fileDir, vscode.Uri.file(tempDir)],
    };

    const videoUri = webviewPanel.webview.asWebviewUri(document.uri);
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview, videoUri);

    let disposed = false;
    webviewPanel.onDidDispose(() => {
      disposed = true;
    });

    // Prepara l'audio in background e lo comunica alla Webview.
    prepareAudio(document.uri.fsPath, tempDir)
      .then((outPath) => {
        if (disposed) {
          return;
        }
        if (outPath === null) {
          webviewPanel.webview.postMessage({ type: 'noAudio' });
        } else {
          const audioUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.file(outPath),
          );
          webviewPanel.webview.postMessage({
            type: 'audioReady',
            src: audioUri.toString(),
          });
        }
      })
      .catch((err: unknown) => {
        if (disposed) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        webviewPanel.webview.postMessage({ type: 'audioError', message });
      });
  }

  private getHtml(webview: vscode.Webview, videoUri: vscode.Uri): string {
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
  <title>MP4 Player</title>
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
    video {
      max-width: 100%;
      max-height: 100%;
      outline: none;
      background: #000;
    }
    audio { display: none; }
    .error {
      display: none;
      color: #f48771;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 14px;
      max-width: 480px;
      text-align: center;
      line-height: 1.5;
      padding: 24px;
    }
    .error code { color: #ccc; }
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
    #speed {
      position: fixed;
      top: 10px;
      left: 12px;
      background: rgba(0, 0, 0, 0.7);
      color: #ddd;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 12px;
      border: none;
      border-radius: 6px;
      padding: 5px 8px;
      z-index: 10;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.2s;
    }
    body:hover #speed, #speed:focus { opacity: 1; outline: none; }
  </style>
</head>
<body>
  <div class="stage">
    <video id="player" controls preload="metadata">
      <source src="${videoUri}" type="video/mp4" />
    </video>
    <div id="error" class="error">
      Unable to play this video.<br />
      The video codec may not be supported by the VS Code engine
      (e.g. <code>H.265/HEVC</code>). Supported: <code>H.264</code>
      video (MP4/MOV/M4V).
    </div>
  </div>
  <audio id="audio" preload="auto"></audio>
  <div id="status"><span class="spinner"></span><span id="statusText">Preparing audio…</span></div>
  <select id="speed" title="Playback speed">
    <option value="0.25">0.25×</option>
    <option value="0.5">0.5×</option>
    <option value="0.75">0.75×</option>
    <option value="1" selected>1×</option>
    <option value="1.25">1.25×</option>
    <option value="1.5">1.5×</option>
    <option value="1.75">1.75×</option>
    <option value="2">2×</option>
  </select>

  <script nonce="${nonce}">
    const player = document.getElementById('player');
    const error = document.getElementById('error');
    const audio = document.getElementById('audio');
    const status = document.getElementById('status');
    const statusText = document.getElementById('statusText');
    const speed = document.getElementById('speed');

    let audioReady = false;
    let useExternal = false;
    let nativeChecked = false;

    showStatus('Preparing audio…', true);

    // Errore di decodifica VIDEO → messaggio chiaro.
    player.addEventListener('error', showVideoError);
    const source = player.querySelector('source');
    if (source) { source.addEventListener('error', showVideoError); }
    function showVideoError() {
      player.style.display = 'none';
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
      }
    });

    function syncTime() {
      if (Math.abs(audio.currentTime - player.currentTime) > 0.25) {
        audio.currentTime = player.currentTime;
      }
    }

    // Il video è muto a livello pratico (l'AAC non viene decodificato),
    // quindi usiamo i suoi controlli nativi per pilotare l'audio esterno.
    player.addEventListener('play', () => {
      if (useExternal) { syncTime(); audio.play().catch(() => {}); }
    });
    player.addEventListener('pause', () => { if (useExternal) { audio.pause(); } });
    player.addEventListener('seeking', () => { if (useExternal) { audio.pause(); } });
    player.addEventListener('seeked', () => {
      if (useExternal) {
        audio.currentTime = player.currentTime;
        if (!player.paused) { audio.play().catch(() => {}); }
      }
    });
    player.addEventListener('ratechange', () => {
      audio.playbackRate = player.playbackRate;
      const v = String(player.playbackRate);
      if (speed.value !== v) { speed.value = v; }
    });
    player.addEventListener('volumechange', () => {
      audio.volume = player.volume;
      audio.muted = player.muted;
    });
    player.addEventListener('timeupdate', () => {
      if (useExternal && !player.paused) { syncTime(); }
    });

    // Se per caso il motore decodifica davvero l'audio nativo, evitiamo l'audio doppio.
    player.addEventListener('playing', () => {
      if (nativeChecked) { return; }
      nativeChecked = true;
      setTimeout(() => {
        if ((player.webkitAudioDecodedByteCount || 0) > 0) {
          useExternal = false;
          audio.pause();
        }
      }, 1500);
    });

    // Controllo velocità: imposta il rate del video; l'audio segue via 'ratechange'.
    function setRate(r) {
      r = Math.min(2, Math.max(0.25, Math.round(r * 100) / 100));
      player.playbackRate = r;
    }
    speed.addEventListener('change', () => {
      player.playbackRate = parseFloat(speed.value);
      player.focus();
    });

    // Scorciatoie da tastiera comode mentre si lavora a fianco.
    document.addEventListener('keydown', (e) => {
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          player.paused ? player.play() : player.pause();
          break;
        case 'ArrowRight': player.currentTime += 5; break;
        case 'ArrowLeft': player.currentTime -= 5; break;
        case 'ArrowUp':
          e.preventDefault();
          player.volume = Math.min(1, player.volume + 0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          player.volume = Math.max(0, player.volume - 0.1);
          break;
        case 'f':
          if (player.requestFullscreen) { player.requestFullscreen(); }
          break;
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

let ffmpegReady = false;

/** Su macOS/Linux assicura che il binario ffmpeg abbia il permesso d'esecuzione. */
function ensureFfmpegExecutable(): void {
  if (ffmpegReady || !ffmpegPath) {
    return;
  }
  ffmpegReady = true;
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(ffmpegPath, 0o755);
    } catch {
      /* ignora: potrebbe essere già eseguibile */
    }
  }
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
      .filter((f) => f.endsWith('.mp3') || f.endsWith('.wav'))
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

/**
 * Estrae e transcodifica la traccia audio in MP3 — formato che il motore di
 * VS Code riproduce in modo affidabile e molto più leggero del WAV PCM.
 * Ritorna il percorso del file audio, oppure null se il video non ha audio.
 */
async function prepareAudio(
  srcPath: string,
  tempDir: string,
): Promise<string | null> {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error('ffmpeg component not available on this platform');
  }
  ensureFfmpegExecutable();

  const stat = await fs.promises.stat(srcPath);
  const key = createHash('sha1')
    .update(srcPath + '|' + stat.size + '|' + stat.mtimeMs)
    .digest('hex')
    .slice(0, 16);
  const outPath = path.join(tempDir, key + '.mp3');

  // Cache: se già transcodificato, riusa (e "tocca" il file per la logica LRU).
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    try {
      const now = new Date();
      fs.utimesSync(outPath, now, now);
    } catch {
      /* ignora */
    }
    return outPath;
  }

  // Verifica la presenza di una traccia audio.
  const probe = await runFfmpeg(['-hide_banner', '-i', srcPath]);
  const hasAudio = /Stream #\d+:\d+.*: Audio:/i.test(probe.stderr);
  if (!hasAudio) {
    return null; // nessuna traccia audio: niente da riprodurre
  }

  const res = await runFfmpeg([
    '-y',
    '-hide_banner',
    '-i',
    srcPath,
    '-vn',
    '-c:a',
    'libmp3lame',
    '-q:a',
    '4',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-f',
    'mp3',
    outPath,
  ]);

  if (res.code !== 0 || !fs.existsSync(outPath)) {
    // Pulisce eventuali file parziali.
    try {
      fs.unlinkSync(outPath);
    } catch {
      /* ignora */
    }
    throw new Error('audio transcoding failed\n' + res.stderr.slice(-400));
  }

  return outPath;
}

function runFfmpeg(
  args: string[],
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn(ffmpegPath as string, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

function getNonce(): string {
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}
