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

    // La Fullscreen API è bloccata nei webview: il pulsante "fullscreen" chiede
    // di attivare lo Zen Mode (schermo intero senza interfaccia).
    webviewPanel.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (msg && msg.type === 'toggleZen') {
        vscode.commands.executeCommand('workbench.action.toggleZenMode');
      }
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
  </style>
</head>
<body>
  <div class="stage">
    <div id="wrap" class="wrap">
      <video id="player" preload="metadata">
        <source src="${videoUri}" type="video/mp4" />
      </video>
      <div id="error" class="error">
        Unable to play this video.<br />
        The video codec may not be supported by the VS Code engine
        (e.g. <code>H.265/HEVC</code>). Supported: <code>H.264</code>
        video (MP4/MOV/M4V).
      </div>
      <div id="bar" class="bar">
        <input id="seek" class="seek" type="range" min="0" max="1000" step="1" value="0" />
        <div class="row">
          <button id="playBtn" class="ic" title="Play / Pause (Space)"></button>
          <button id="backBtn" class="ic" title="Back 5s (←)"></button>
          <button id="fwdBtn" class="ic" title="Forward 5s (→)"></button>
          <span id="time" class="time">0:00 / 0:00</span>
          <span class="spacer"></span>
          <button id="muteBtn" class="ic" title="Mute (M)"></button>
          <input id="vol" class="vol" type="range" min="0" max="1" step="0.05" value="1" />
          <div class="speedWrap">
            <button id="speedBtn" class="speedbtn" title="Playback speed (&lt; &gt;)">1×</button>
            <div id="speedMenu" class="speedmenu"></div>
          </div>
          <button id="pipBtn" class="ic" title="Picture-in-Picture (P)"></button>
          <button id="fsBtn" class="ic" title="Fullscreen (F)"></button>
        </div>
      </div>
    </div>
  </div>
  <audio id="audio" preload="auto"></audio>
  <div id="status"><span class="spinner"></span><span id="statusText">Preparing audio…</span></div>

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

    let audioReady = false;
    let useExternal = false;
    let nativeChecked = false;
    let seeking = false;

    const IC = {
      play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
      pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
      back: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 6L5 12l6 6V6zm8 0l-6 6 6 6V6z"/></svg>',
      forward: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 6l6 6-6 6V6zM5 6l6 6-6 6V6z"/></svg>',
      volOn: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16 8.5a4 4 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
      volOff: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
      fsIn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
      fsOut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
      pip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" stroke="none"/></svg>'
    };

    playBtn.innerHTML = IC.play;
    backBtn.innerHTML = IC.back;
    fwdBtn.innerHTML = IC.forward;
    muteBtn.innerHTML = IC.volOn;
    pipBtn.innerHTML = IC.pip;
    fsBtn.innerHTML = IC.fsIn;
    // Picture-in-Picture: nascondi il pulsante se il webview non lo supporta.
    if (!document.pictureInPictureEnabled) { pipBtn.style.display = 'none'; }

    const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    RATES.forEach((r) => {
      const b = document.createElement('button');
      b.textContent = r + '×';
      b.setAttribute('data-rate', String(r));
      speedMenu.appendChild(b);
    });

    showStatus('Preparing audio…', true);

    // Errore di decodifica VIDEO → messaggio chiaro.
    player.addEventListener('error', showVideoError);
    const source = player.querySelector('source');
    if (source) { source.addEventListener('error', showVideoError); }
    function showVideoError() {
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
    });
    player.addEventListener('volumechange', () => {
      audio.volume = player.volume;
      audio.muted = player.muted;
      const muted = player.muted || player.volume === 0;
      muteBtn.innerHTML = muted ? IC.volOff : IC.volOn;
      const v = player.muted ? 0 : player.volume;
      vol.value = String(v);
      vol.style.backgroundSize = (v * 100) + '% 100%';
    });
    player.addEventListener('timeupdate', () => {
      if (useExternal && !player.paused) { syncTime(); }
      updateTime();
    });
    player.addEventListener('loadedmetadata', updateTime);
    player.addEventListener('durationchange', updateTime);

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
    player.addEventListener('click', togglePlay);
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
    const vscodeApi = acquireVsCodeApi();
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

    // Stato iniziale dell'interfaccia.
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
 * Estrae e transcodifica la traccia audio in MP3 — formato leggero che il motore
 * di VS Code riproduce in modo affidabile. Se l'encoder MP3 non fosse disponibile
 * su una piattaforma, ripiega automaticamente su WAV (sempre presente).
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

  // Cache: riusa un audio già transcodificato (MP3 preferito, WAV di fallback).
  for (const ext of ['.mp3', '.wav']) {
    const cached = path.join(tempDir, key + ext);
    if (fs.existsSync(cached) && fs.statSync(cached).size > 0) {
      try {
        const now = new Date();
        fs.utimesSync(cached, now, now);
      } catch {
        /* ignora */
      }
      return cached;
    }
  }

  // Verifica la presenza di una traccia audio.
  const probe = await runFfmpeg(['-hide_banner', '-i', srcPath]);
  const hasAudio = /Stream #\d+:\d+.*: Audio:/i.test(probe.stderr);
  if (!hasAudio) {
    return null; // nessuna traccia audio: niente da riprodurre
  }

  // Esegue una transcodifica; ritorna il percorso se riesce, altrimenti null.
  const tryEncode = async (
    ext: string,
    codecArgs: string[],
  ): Promise<string | null> => {
    const out = path.join(tempDir, key + ext);
    const res = await runFfmpeg([
      '-y', '-hide_banner', '-i', srcPath,
      '-vn', ...codecArgs, '-ar', '48000', '-ac', '2', out,
    ]);
    if (res.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) {
      return out;
    }
    try { fs.unlinkSync(out); } catch { /* ignora */ }
    return null;
  };

  // 1) MP3 leggero; 2) fallback WAV (PCM) se l'encoder MP3 manca/fallisce.
  const mp3 = await tryEncode('.mp3', ['-c:a', 'libmp3lame', '-q:a', '4', '-f', 'mp3']);
  if (mp3) {
    return mp3;
  }
  const wav = await tryEncode('.wav', ['-c:a', 'pcm_s16le', '-f', 'wav']);
  if (wav) {
    return wav;
  }

  throw new Error('audio transcoding failed');
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
