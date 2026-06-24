import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

/**
 * Punto di ingresso dell'estensione.
 * Viene chiamato da VS Code la prima volta che si apre un file .mp4.
 */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(Mp4EditorProvider.register(context));
}

export function deactivate(): void {
  /* niente da pulire */
}

/**
 * Custom Editor in sola lettura per i file .mp4.
 * Un video non si "modifica" nell'editor, quindi usiamo l'interfaccia readonly:
 * VS Code ci dà il documento (path del file) e una webview da popolare.
 */
class Mp4EditorProvider implements vscode.CustomReadonlyEditorProvider {
  private static readonly viewType = 'mp4Player.preview';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new Mp4EditorProvider(context);
    return vscode.window.registerCustomEditorProvider(
      Mp4EditorProvider.viewType,
      provider,
      {
        // Mantiene lo stato del player (posizione, riproduzione) quando la tab
        // non è in primo piano, utile con l'editor diviso.
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Per un editor readonly il "documento" è semplicemente l'URI del file.
   */
  public openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  /**
   * Costruisce la webview che mostra il player.
   */
  public resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): void {
    const fileDir = vscode.Uri.joinPath(document.uri, '..');

    webviewPanel.webview.options = {
      enableScripts: true,
      // Autorizza la webview ad accedere SOLO alla cartella del video.
      localResourceRoots: [fileDir],
    };

    // Trasforma il path su disco in un URI sicuro caricabile dalla webview.
    // Il video viene letto in streaming dal disco, non caricato in memoria.
    const videoUri = webviewPanel.webview.asWebviewUri(document.uri);

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview, videoUri);
  }

  private getHtml(webview: vscode.Webview, videoUri: vscode.Uri): string {
    // Nonce per consentire l'esecuzione solo del nostro script inline.
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
    .error code {
      color: #ccc;
    }
  </style>
</head>
<body>
  <div class="stage">
    <video id="player" controls preload="metadata">
      <source src="${videoUri}" type="video/mp4" />
    </video>
    <div id="error" class="error">
      Impossibile riprodurre questo video.<br />
      Il codec potrebbe non essere supportato dal motore di VS Code
      (es. <code>H.265/HEVC</code>). Sono supportati i file MP4
      con codec <code>H.264 + AAC</code>.
    </div>
  </div>

  <script nonce="${nonce}">
    const player = document.getElementById('player');
    const error = document.getElementById('error');

    // Se il codec non è supportato, nascondiamo il player e mostriamo l'errore.
    player.addEventListener('error', showError);
    const source = player.querySelector('source');
    if (source) {
      source.addEventListener('error', showError);
    }

    function showError() {
      player.style.display = 'none';
      error.style.display = 'block';
    }

    // Scorciatoie da tastiera comode mentre si lavora a fianco.
    document.addEventListener('keydown', (e) => {
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          player.paused ? player.play() : player.pause();
          break;
        case 'ArrowRight':
          player.currentTime += 5;
          break;
        case 'ArrowLeft':
          player.currentTime -= 5;
          break;
        case 'ArrowUp':
          e.preventDefault();
          player.volume = Math.min(1, player.volume + 0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          player.volume = Math.max(0, player.volume - 0.1);
          break;
        case 'f':
          if (player.requestFullscreen) player.requestFullscreen();
          break;
        case 'm':
          player.muted = !player.muted;
          break;
      }
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  // Nonce crittograficamente robusto per la Content-Security-Policy.
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}
