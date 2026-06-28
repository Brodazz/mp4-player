import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseCues, decodeSubtitle, videoCodec } from './media';

// --- parseCues -------------------------------------------------------------

test('parseCues: SRT base con virgola nei ms', () => {
  const srt = '1\n00:00:01,000 --> 00:00:04,500\nCiao mondo\n';
  const cues = parseCues(srt);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 4.5);
  assert.equal(cues[0].text, 'Ciao mondo');
});

test('parseCues: WebVTT con punto nei ms e header ignorato', () => {
  const vtt = 'WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nRiga uno\nRiga due\n';
  const cues = parseCues(vtt);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 2);
  assert.equal(cues[0].text, 'Riga uno\nRiga due');
});

test('parseCues: più cue', () => {
  const srt =
    '1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:03,000 --> 00:00:04,000\nB\n';
  assert.equal(parseCues(srt).length, 2);
});

test('parseCues: timestamp fuori range (minuti/secondi >= 60) scartato', () => {
  assert.equal(parseCues('00:99:99,000 --> 00:00:02,000\nX').length, 0);
  assert.equal(parseCues('00:00:00,000 --> 00:60:00,000\nX').length, 0);
});

test('parseCues: blocco senza freccia o senza testo ignorato', () => {
  assert.equal(parseCues('solo testo, niente tempi').length, 0);
  assert.equal(parseCues('00:00:01,000 --> 00:00:02,000\n').length, 0);
});

// --- decodeSubtitle --------------------------------------------------------

test('decodeSubtitle: BOM UTF-8 rimosso', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('abc', 'utf8')]);
  assert.equal(decodeSubtitle(buf), 'abc');
});

test('decodeSubtitle: UTF-16 LE con BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ciaò', 'utf16le')]);
  assert.equal(decodeSubtitle(buf), 'ciaò');
});

test('decodeSubtitle: UTF-8 semplice senza BOM', () => {
  assert.equal(decodeSubtitle(Buffer.from('hello', 'utf8')), 'hello');
});

test('decodeSubtitle: UTF-16 BE dispari (troncato) non lancia, fallback', () => {
  // BOM BE + 3 byte (dispari): swap16 lancerebbe → deve gestire senza crash.
  const buf = Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x00]);
  assert.doesNotThrow(() => decodeSubtitle(buf));
});

// --- videoCodec ------------------------------------------------------------

function isobmff(fourcc: string): Buffer {
  // prefisso + 'stsd' + 12 byte (ver/flag + entry count + entry size) + fourcc
  return Buffer.concat([
    Buffer.from('....'),
    Buffer.from('stsd'),
    Buffer.alloc(12),
    Buffer.from(fourcc, 'latin1'),
  ]);
}

test('videoCodec: ISOBMFF avc1 -> H.264', () => {
  assert.deepEqual(videoCodec(isobmff('avc1')), { name: 'H.264', h264: true });
});

test('videoCodec: ISOBMFF hvc1 -> HEVC (non H.264)', () => {
  assert.deepEqual(videoCodec(isobmff('hvc1')), { name: 'HEVC (H.265)', h264: false });
});

test('videoCodec: Matroska CodecID HEVC', () => {
  const buf = Buffer.from('...V_MPEGH/ISO/HEVC...', 'latin1');
  assert.deepEqual(videoCodec(buf), { name: 'HEVC (H.265)', h264: false });
});

test('videoCodec: Matroska CodecID AVC -> H.264', () => {
  const buf = Buffer.from('...V_MPEG4/ISO/AVC...', 'latin1');
  assert.deepEqual(videoCodec(buf), { name: 'H.264', h264: true });
});

test('videoCodec: nessun codec riconosciuto -> null', () => {
  assert.equal(videoCodec(Buffer.from('niente di utile qui')), null);
});

test('videoCodec: nome fourcc sconosciuto sanificato (niente < > per innerHTML)', () => {
  const r = videoCodec(isobmff('<i>!'));
  assert.ok(r);
  assert.ok(!/[<>&]/.test(r!.name), 'il nome non deve contenere caratteri HTML');
});
