import * as vscode from 'vscode';
import { randomBytes, createHash } from 'crypto';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Percorso del binario ffmpeg incluso (ffmpeg-static). Il motore di VS Code non
// decodifica l'audio AAC degli MP4, quindi estraiamo/transcodifichiamo la traccia
// audio in Opus (che la Webview riproduce) e la sincronizziamo col video.
let ffmpegPath: string | undefined;
try {
  ffmpegPath = require('ffmpeg-static') as string;
} catch {
  ffmpegPath = undefined;
}

/** Punto di ingresso dell'estensione. */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(Mp4EditorProvider.register(context));
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
<html lang="it">
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
  </style>
</head>
<body>
  <div class="stage">
    <video id="player" controls preload="metadata">
      <source src="${videoUri}" type="video/mp4" />
    </video>
    <div id="error" class="error">
      Impossibile riprodurre questo video.<br />
      Il codec video potrebbe non essere supportato dal motore di VS Code
      (es. <code>H.265/HEVC</code>). Sono supportati i file MP4
      con codec video <code>H.264</code>.
    </div>
  </div>
  <audio id="audio" preload="auto"></audio>
  <div id="status"><span class="spinner"></span><span id="statusText">Preparazione audio…</span></div>

  <script nonce="${nonce}">
    const player = document.getElementById('player');
    const error = document.getElementById('error');
    const audio = document.getElementById('audio');
    const status = document.getElementById('status');
    const statusText = document.getElementById('statusText');

    let audioReady = false;
    let useExternal = false;
    let nativeChecked = false;

    showStatus('Preparazione audio…', true);

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
        showStatus('Audio non disponibile: ' + msg.message, false);
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
    player.addEventListener('ratechange', () => { audio.playbackRate = player.playbackRate; });
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

/**
 * Estrae e transcodifica la traccia audio in Opus (.ogg).
 * Ritorna il percorso del file audio, oppure null se il video non ha audio.
 */
async function prepareAudio(
  srcPath: string,
  tempDir: string,
): Promise<string | null> {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error('componente ffmpeg non disponibile su questa piattaforma');
  }

  const stat = await fs.promises.stat(srcPath);
  const key = createHash('sha1')
    .update(srcPath + '|' + stat.size + '|' + stat.mtimeMs)
    .digest('hex')
    .slice(0, 16);
  const outPath = path.join(tempDir, key + '.wav');

  // Cache: se già transcodificato, riusa.
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
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
    'pcm_s16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-f',
    'wav',
    outPath,
  ]);

  if (res.code !== 0 || !fs.existsSync(outPath)) {
    // Pulisce eventuali file parziali.
    try {
      fs.unlinkSync(outPath);
    } catch {
      /* ignora */
    }
    throw new Error('transcodifica audio fallita\n' + res.stderr.slice(-400));
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
