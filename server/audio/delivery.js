/**
 * Entrega do audio para download.
 *
 * Uma faixa guarda a `audio_url` original devolvida pelo provider:
 *   - ACE-Step  : data URL (base64) embutida na resposta da API;
 *   - Replicate : URL https do arquivo gerado;
 *   - fal       : URL https do arquivo gerado.
 *
 * No deploy na nuvem o disco e efemero: o arquivo em data/tracks some no
 * proximo restart, mas a `audio_url` original continua valendo. Por isso a
 * rota de download resolve a fonte assim:
 *
 *   1. URL original (data URL ou https)  -> funciona sem o disco;
 *   2. arquivo local em data/tracks      -> cache local do mesmo audio.
 *
 * O formato pedido tambem e resolvido aqui: MP3 -> MP3 direto, WAV -> MP3
 * convertido com lamejs e MP3 -> WAV decodificado (@audio/decode-mp3).
 */

import fs from 'node:fs';
import { Readable } from 'node:stream';
import { audioPath } from '../store.js';
import { encodeMp3, mp3Available } from './mp3.js';
import { decodeWav, encodeWav } from './wav.js';

export const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav' };

/** Descobre o formato pela extensao da URL. */
function formatFromUrl(url) {
  return /\.wav(\?|$)/i.test(url) ? 'wav' : 'mp3';
}

/** Descobre o formato pelo mime da data URL. */
function formatFromDataUrl(url) {
  const head = url.slice(5, Math.min(url.indexOf(',') > 0 ? url.indexOf(',') : 40, 40)).toLowerCase();
  return /wav/.test(head) ? 'wav' : 'mp3';
}

/**
 * Resolve a fonte do audio de uma faixa.
 *
 * @param {object} track   faixa da biblioteca
 * @param {string} prefer  'auto' | 'remote' | 'local'
 * @returns {null|{kind:'remote'|'inline'|'local', format:string, url?:string, path?:string}}
 */
export function resolveSource(track, prefer = 'auto') {
  const remote = typeof track.sourceUrl === 'string' ? track.sourceUrl : '';
  const remoteSource = /^https?:\/\//i.test(remote)
    ? { kind: 'remote', url: remote, format: formatFromUrl(remote) }
    : remote.startsWith('data:audio/')
      ? { kind: 'inline', url: remote, format: formatFromDataUrl(remote) }
      : null;

  const file = track.file ? audioPath(track.file) : null;
  const localSource = (() => {
    if (!file) return null;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0) return null;
    } catch {
      return null;
    }
    return { kind: 'local', path: file, format: track.format === 'wav' ? 'wav' : 'mp3' };
  })();

  if (prefer === 'remote') return remoteSource || localSource;
  if (prefer === 'local') return localSource || remoteSource;
  // auto: o arquivo local e o mesmo audio, so que em cache (sem rede)
  return localSource || remoteSource;
}

/** Le a fonte inteira em memoria (usado quando precisa converter o formato). */
export async function readSource(source) {
  if (source.kind === 'local') {
    return { buffer: fs.readFileSync(source.path), format: source.format };
  }
  if (source.kind === 'inline') {
    const comma = source.url.indexOf(',');
    const base64 = comma >= 0 ? source.url.slice(comma + 1) : '';
    return { buffer: Buffer.from(base64, 'base64'), format: source.format };
  }
  // remote: baixa o arquivo original do provider
  const res = await fetch(source.url);
  if (!res.ok) throw new Error(`O provider respondeu ${res.status} ao servir o audio original`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, format: source.format };
}

/**
 * Converte o audio para o formato pedido.
 * MP3 -> MP3 e WAV -> WAV sao devolvidos sem tocar no buffer.
 */
export async function convertAudio(buffer, from, to) {
  if (from === to) return buffer;

  if (to === 'mp3') {
    if (!mp3Available()) throw new Error('Encoder MP3 indisponivel neste host');
    if (from !== 'wav') throw new Error(`Nao sei converter ${from} para mp3`);
    const wav = decodeWav(buffer);
    return encodeMp3(wav.channels, wav.sampleRate, 160);
  }

  if (to === 'wav') {
    if (from !== 'mp3') throw new Error(`Nao sei converter ${from} para wav`);
    const { decodeMp3Buffer } = await import('./voice.js');
    const decoded = await decodeMp3Buffer(buffer);
    return encodeWav(decoded.channels, decoded.sampleRate);
  }

  throw new Error(`Formato desconhecido: ${to}`);
}

/**
 * Monta o Content-Disposition de um download.
 * `filename` ASCII para navegadores antigos + `filename*` UTF-8 para o Chrome.
 */
export function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Envia o audio como anexo.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {Buffer} buffer   conteudo final (ja no formato pedido)
 * @param {string} filename nome do arquivo (ex.: "minha-musica.mp3")
 * @param {string} format   'mp3' | 'wav'
 */
export function sendAttachment(res, buffer, filename, format) {
  res.writeHead(200, {
    'Content-Type': MIME[format] || 'application/octet-stream',
    'Content-Length': buffer.length,
    'Content-Disposition': contentDisposition(filename),
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buffer);
}

/**
 * Faz proxy do arquivo remoto (sem passar pela memoria): o corpo da resposta
 * do provider vai direto para o navegador.
 */
export async function sendRemoteProxy(res, url, filename, format, extraHeaders = {}) {
  const upstream = await fetch(url);
  if (!upstream.ok || !upstream.body) {
    throw new Error(`O provider respondeu ${upstream.status} ao servir o audio original`);
  }
  const length = upstream.headers.get('content-length');
  res.writeHead(200, {
    'Content-Type': MIME[format] || upstream.headers.get('content-type') || 'application/octet-stream',
    ...(length ? { 'Content-Length': length } : {}),
    'Content-Disposition': contentDisposition(filename),
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  return Readable.fromWeb(upstream.body).pipe(res);
}
