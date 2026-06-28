// Funzioni "pure" di media (parsing sottotitoli e riconoscimento codec), estratte
// da extension.ts perché NON dipendono da `vscode` → testabili in isolamento.

/** Un sottotitolo: intervallo in secondi + testo. */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Codec video riconosciuto dal contenitore (nome leggibile + se è H.264). */
export interface CodecInfo {
  name: string;
  h264: boolean;
}

/** Decodifica un file di sottotitoli rispettando il BOM (UTF-8 / UTF-16 LE/BE):
 *  i sottotitoli scaricati spesso non sono UTF-8 e senza questo restano muti. */
export function decodeSubtitle(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8', 3); // BOM UTF-8
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le', 2); // BOM UTF-16 LE
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff && buf.length % 2 === 0) {
    const swapped = Buffer.from(buf.subarray(2)); // BOM UTF-16 BE → swap → LE
    swapped.swap16(); // richiede lunghezza pari (garantita dal check sopra)
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8');
}

/** Parser minimale di SRT/WebVTT → cue (secondi). Gestisce sia "," sia "." nei ms. */
export function parseCues(content: string): Cue[] {
  const cues: Cue[] = [];
  const toSec = (s: string): number => {
    const m = /(\d\d):(\d\d):(\d\d)[.,](\d{1,3})/.exec(s);
    if (!m || +m[2] >= 60 || +m[3] >= 60) {
      return -1; // timestamp malformato (minuti/secondi fuori range)
    }
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
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
 * file ISOBMFF (MP4/MOV/M4V/F4V, e l'MP4 prodotto dal remux); fallback alla stringa
 * CodecID per Matroska/WebM. Serve solo a dare un messaggio d'errore onesto
 * ("HEVC", "VP9", …): best-effort, niente parsing pesante.
 */
export function videoCodec(buf: Buffer): CodecInfo | null {
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
      // Solo caratteri sicuri: il nome finisce in innerHTML nell'overlay d'errore,
      // quindi niente < > & ecc. da un fourcc malformato.
      const clean = cc.replace(/[^A-Za-z0-9 ./()_-]/g, '').trim();
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
