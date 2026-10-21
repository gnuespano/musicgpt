/**
 * Providers de musica.
 *
 * - acestep:  ACE-Step 1.5 (API oficial do ACE Music, acemusic.ai) - PADRAO
 * - local:     motor procedural proprio (offline, sempre disponivel)
 * - replicate / fal: modelos remotos de geracao de musica com vocal
 *
 * Todos devolvem { buffer, format, duration, meta }.
 */

import { renderSong } from '../audio/render.js';
import { encodeWav } from '../audio/wav.js';
import { downloadBuffer, mp3Duration, wavDuration } from '../audio/remote.js';
import { PROVIDERS, activeMusicProvider } from '../config.js';
import { generateAceMusic } from './acestep.js';

export async function generateWithLocalProvider(options, onProgress) {
  const rendered = await renderSong(options, onProgress);
  const buffer = encodeWav(rendered.channels, rendered.sampleRate);
  return {
    buffer,
    format: 'wav',
    duration: rendered.meta.duration,
    meta: { ...rendered.meta, engine: 'local-procedural' },
  };
}

/**
 * ACE-Step 1.5: caption (estilo) + letra + thinking:true (LM 5Hz).
 * O audio volta em base64, e decodificado e salvo em data/tracks.
 */
export async function generateWithAceStep(options, onProgress) {
  return generateAceMusic(
    options.prompt,
    options.lyrics,
    options.style || options.genreLabel,
    { ...options, onProgress },
  );
}

export async function generateWithReplicate(options, onProgress) {
  const { token, model, version } = PROVIDERS.music.replicate;
  if (!token) throw new Error('REPLICATE_API_TOKEN ausente');
  onProgress({ stage: 'enviando ao modelo', pct: 20, detail: model });

  const input = {
    prompt: buildPrompt(options),
    duration: options.duration || 75,
    instrumental: Boolean(options.instrumental),
  };
  if (options.lyrics) input.lyrics = options.lyrics;

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const endpoint = version
    ? 'https://api.replicate.com/v1/predictions'
    : `https://api.replicate.com/v1/models/${model}/predictions`;
  const body = version ? { version, input } : { input };

  let res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Replicate respondeu ${res.status}: ${await res.text()}`);
  let prediction = await res.json();

  const deadline = Date.now() + 300000;
  while (prediction.status === 'starting' || prediction.status === 'processing') {
    if (Date.now() > deadline) throw new Error('Replicate excedeu o tempo limite');
    await new Promise((r) => setTimeout(r, 2500));
    onProgress({ stage: 'gerando', pct: Math.min(90, 40 + Math.random() * 40) });
    res = await fetch(prediction.urls.get, { headers });
    prediction = await res.json();
  }
  if (prediction.status !== 'succeeded') {
    throw new Error(`Replicate falhou (${prediction.status}): ${prediction.error || 'erro desconhecido'}`);
  }

  const output = prediction.output;
  const url = Array.isArray(output) ? output[0] : output;
  const buffer = await downloadBuffer(url);
  onProgress({ stage: 'pronto', pct: 95 });
  return {
    buffer,
    format: 'mp3',
    duration: mp3Duration(buffer) || options.duration || 75,
    // URL original do provider: o download funciona mesmo sem o disco
    sourceUrl: url,
    sourceFormat: 'mp3',
    meta: { engine: 'replicate', model, remoteId: prediction.id, sourceUrl: url },
  };
}

export async function generateWithFal(options, onProgress) {
  const { key, model } = PROVIDERS.music.fal;
  if (!key) throw new Error('FAL_KEY ausente');
  onProgress({ stage: 'enviando ao modelo', pct: 20, detail: model });

  const res = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: buildPrompt(options),
      duration: options.duration || 75,
      instrumental: Boolean(options.instrumental),
      ...(options.lyrics ? { lyrics: options.lyrics } : {}),
    }),
  });
  if (!res.ok) throw new Error(`fal respondeu ${res.status}: ${await res.text()}`);
  const payload = await res.json();
  const url = payload?.audio?.url || payload?.output?.audio?.url || payload?.audio_url;
  if (!url) throw new Error('fal nao retornou um arquivo de audio');
  const buffer = await downloadBuffer(url);
  onProgress({ stage: 'pronto', pct: 95 });
  return {
    buffer,
    format: 'mp3',
    duration: mp3Duration(buffer) || options.duration || 75,
    // URL original do provider: o download funciona mesmo sem o disco
    sourceUrl: url,
    sourceFormat: 'mp3',
    meta: { engine: 'fal', model, sourceUrl: url },
  };
}

function buildPrompt(options) {
  const parts = [options.prompt];
  if (options.genreLabel) parts.push(`genre: ${options.genreLabel}`);
  if (options.moodLabel) parts.push(`mood: ${options.moodLabel}`);
  if (options.instrumental) parts.push('instrumental, no vocals');
  if (options.lyrics) parts.push(`lyrics:\n${options.lyrics}`);
  return parts.filter(Boolean).join('\n');
}

export async function generateMusic(options, onProgress = () => {}) {
  const provider = activeMusicProvider();
  onProgress({ stage: 'preparando', pct: 5, detail: `provider: ${provider}` });
  if (provider === 'acestep') return generateWithAceStep(options, onProgress);
  if (provider === 'replicate') return generateWithReplicate(options, onProgress);
  if (provider === 'fal') return generateWithFal(options, onProgress);
  return generateWithLocalProvider(options, onProgress);
}

export { wavDuration, mp3Duration };
