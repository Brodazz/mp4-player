# Politica di sicurezza

## Segnalare una vulnerabilità

Se trovi una vulnerabilità, apri una *issue* privata o scrivi all'autore.
Cerca di includere passi per riprodurre il problema.

## Modello di sicurezza dell'estensione

L'estensione mostra i video in una Webview di VS Code con misure restrittive:

- **Content-Security-Policy** con `default-src 'none'`: nulla è caricato se non
  esplicitamente consentito.
- Gli script inline sono autorizzati solo tramite un **nonce crittografico**
  generato con `crypto.randomBytes` a ogni apertura.
- L'accesso al filesystem della Webview è limitato (`localResourceRoots`) alla
  **sola cartella del video** aperto.
- L'editor è in **sola lettura**: l'estensione non modifica i file.
- Nessuna connessione di rete: il video è letto in streaming dal disco locale.
