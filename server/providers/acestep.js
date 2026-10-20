/**
 * Provider ACE-Step 1.5 (API oficial do ACE Music - https://acemusic.ai).
 *
 * A API e compativel com OpenAI:
 *
 *   POST https://api.acemusic.ai/v1/chat/completions
 *   Authorization: Bearer <ACESTEP_API_KEY>
 *   {
 *     "model": "acemusic/acestep-v15-turbo",
 *     "messages": [{ "role": "user", "content": "<prompt>...</prompt><lyrics>...</lyrics>" }],
 *     "stream": false,
 *     "thinking": true,          // usa o LM 5Hz -> qualidade melhor
 *     "use_format": false,
 *     "audio_config": { "duration": 75, "format": "mp3", "instrumental": false }
 *   }
 *
 * A resposta traz o audio em base64:
 *   choices[0].message.audio[0].audio_url.url = "data:audio/mpeg;base64,SUQzB..."
 *
 * Este provider decodifica o base64, salva o MP3 no servidor (data/tracks)
 * e devolve o caminho local + o buffer para o player.
 *
 * Sem ACESTEP_API_KEY no .env este arquivo nunca e chamado: o app usa o
 * motor procedural local (server/audio/render.js).
 */

import { ACESTEP, aceStepAvailable } from '../config.js';
import { audioPath, computePeaks, newId, saveAudio } from '../store.js';
import { downloadBuffer, mp3Duration, wavDuration } from '../audio/remote.js';
import { decodeMp3Buffer } from '../audio/voice.js';

/** Modelos tentados quando o servidor rejeita o "model" informado. */
const MODEL_FALLBACKS = [
  'acemusic/acestep-v1.5-turbo',
  'acestep-v15-xl-turbo',
  'acestep-v15-turbo',
  'acemusic/acestep-v15-turbo',
];

const MIN_DURATION = 10;
const MAX_DURATION = 240;

/* ------------------------------------------------------------------ *
 * Montagem do pedido
 * ------------------------------------------------------------------ */

/**
 * Caption (descricao do estilo) enviada para o modelo.
 * Junta o prompt do usuario com genero, clima e opcoes do app.
 *
 * `duration` e o tempo PLANEJADO (ja compensado): no modo sample o LM
 * planeja a musica a partir do texto e ignora o campo duration do
 * audio_config, entao a dica precisa vir aqui para a faixa ter o tamanho
 * pedido (medido: pedir 30s sem dica -> faixa de 100s; com dica de 69s ->
 * faixa de ~30s).
 */
export function buildCaption({ prompt, style, genreLabel, moodLabel, lofi, instrumental, duration }) {
  const bits = [];
  const text = String(prompt || '').trim();
  if (text) bits.push(text);

  const genre = style || genreLabel;
  if (genre) bits.push(`${genre} style`);

  const mood = moodLabel;
  if (mood) bits.push(`${mood} mood`);

  if (lofi) bits.push('lofi, vinyl crackle, soft and warm');
  if (instrumental) bits.push('instrumental, no vocals');

  if (Number.isFinite(Number(duration)) && Number(duration) > 0) {
    bits.push(`about ${Math.round(Number(duration))} seconds`);
  }

  return bits.join(', ') || 'instrumental track';
}

/** Monta o corpo da requisicao no formato da API do ACE-Step. */
export function buildRequestBody({ prompt, lyrics, style, options = {} }) {
  const duration = Number(options.duration);
  // o endpoint entrega ~43% do tempo planejado e tem teto de ~100s
  // (medido: 30->13s, 60->26s, 120->51s, 240->102s). Pedimos um pouco mais
  // que o alvo para a faixa final ter o tamanho desejado.
  const planned = Number.isFinite(duration) && duration > 0
    ? Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(duration * (ACESTEP.durationFactor || 1))))
    : null;

  const caption = buildCaption({
    prompt,
    style,
    genreLabel: options.genreLabel,
    moodLabel: options.moodLabel,
    lofi: options.lofi,
    instrumental: options.instrumental,
    duration: planned,
  });

  const cleanLyrics = String(lyrics || '').trim();
  const instrumental = Boolean(options.instrumental);

  const audioConfig = {
    format: ACESTEP.format || 'mp3',
    instrumental,
  };

  if (planned) audioConfig.duration = planned;
  // idioma do vocal: vem do app (pt/en) ou da configuracao
  const vocalLanguage = ACESTEP.vocalLanguage || (options.lang === 'en' ? 'en' : 'pt');
  if (vocalLanguage) audioConfig.vocal_language = vocalLanguage;

  const body = {
    messages: [{
      role: 'user',
      content: cleanLyrics
        ? `<prompt>${caption}</prompt><lyrics>${cleanLyrics}</lyrics>`
        : `<prompt>${caption}</prompt>`,
    }],
    stream: false,
    // 5Hz LM: gera os codigos semanticos antes do DiT (qualidade mais alta)
    thinking: ACESTEP.thinking,
    // a letra ja vem pronta: nao deixamos o modelo reescrever
    use_format: false,
    use_cot_caption: true,
    use_cot_language: true,
    audio_config: audioConfig,
  };

  // sem letra do usuario: o proprio LM escreve a letra (sample mode)
  if (!cleanLyrics && !instrumental) body.sample_mode = true;

  if (ACESTEP.model) body.model = ACESTEP.model;

  return body;
}

/* ------------------------------------------------------------------ *
 * Chamada HTTP
 * ------------------------------------------------------------------ */

function errorMessage(status, payload, raw) {
  const fromPayload = payload?.error?.message
    || payload?.error?.code
    || payload?.message
    || payload?.detail;
  if (fromPayload) return `ACE-Step respondeu ${status}: ${fromPayload}`;
  const snippet = String(raw || '').slice(0, 300);
  return snippet ? `ACE-Step respondeu ${status}: ${snippet}` : `ACE-Step respondeu ${status}`;
}

/** POST /chat/completions com timeout. */
async function postChatCompletion(body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ACESTEP.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ACESTEP.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await res.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }

    if (!res.ok) {
      const err = new Error(errorMessage(res.status, payload, raw));
      err.status = res.status;
      throw err;
    }
    if (!payload) throw new Error('ACE-Step devolveu uma resposta vazia');
    return payload;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`ACE-Step demorou demais (timeout de ${Math.round(timeoutMs / 1000)}s)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chama a API. Se o servidor recusar o "model" informado, tenta os modelos
 * alternativos (o ACE-Step hospedado pode expor ids diferentes).
 */
async function callApi(body) {
  const candidates = ACESTEP.model ? [ACESTEP.model] : [null, ...MODEL_FALLBACKS];
  let lastError = null;

  for (const model of candidates) {
    const payload = { ...body };
    if (model) payload.model = model;
    try {
      return await postChatCompletion(payload, ACESTEP.timeoutMs);
    } catch (err) {
      lastError = err;
      const status = err?.status;
      const modelIssue = [400, 404, 422].includes(status) && /model/i.test(err.message || '');
      if (!modelIssue) throw err;
    }
  }
  throw lastError || new Error('ACE-Step: nenhuma resposta valida');
}

/* ------------------------------------------------------------------ *
 * Extracao do audio e dos metadados
 * ------------------------------------------------------------------ */

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Procura strings de audio em qualquer lugar do payload. */
function collectStrings(node, out = [], depth = 0) {
  if (depth > 6 || node == null) return out;
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out, depth + 1);
    return out;
  }
  if (typeof node === 'object') {
    for (const value of Object.values(node)) collectStrings(value, out, depth + 1);
  }
  return out;
}

/**
 * Descobre o audio na resposta do ACE-Step.
 * Formatos aceitos: data URL base64, base64 puro e URL http(s).
 */
export function findAudioInPayload(payload) {
  const message = payload?.choices?.[0]?.message || {};
  const candidates = [];

  const pushAudio = (audio) => {
    if (!audio) return;
    if (typeof audio === 'string') {
      candidates.push({ value: audio, raw: true });
      return;
    }
    if (Array.isArray(audio)) {
      for (const item of audio) pushAudio(item);
      return;
    }
    if (typeof audio === 'object') {
      const url = audio?.audio_url?.url ?? audio?.audio_url ?? audio?.url;
      if (typeof url === 'string') candidates.push({ value: url });
      const b64 = audio?.data?.base64 ?? audio?.base64 ?? audio?.b64_json ?? audio?.data;
      if (typeof b64 === 'string' && b64 !== url) candidates.push({ value: b64 });
    }
  };

  pushAudio(message.audio);
  pushAudio(message.audio_url);
  pushAudio(payload?.audio);
  pushAudio(payload?.data);
  pushAudio(payload?.output);
  pushAudio(payload?.choices?.[0]?.audio);

  // varredura final: qualquer string que pareca audio
  for (const s of collectStrings(payload)) {
    if (s.startsWith('data:audio/') || /^https?:\/\/\S+\.(mp3|wav|ogg|m4a|flac)(\?|$)/i.test(s)) {
      candidates.push({ value: s });
    }
  }

  for (const candidate of candidates) {
    const value = candidate.value.trim();
    if (!value) continue;

    // data URL: data:audio/mpeg;base64,XXXX
    if (value.startsWith('data:')) {
      const comma = value.indexOf(',');
      if (comma < 0) continue;
      const mime = value.slice(5, value.indexOf(';') > 0 ? value.indexOf(';') : comma);
      const b64 = value.slice(comma + 1);
      const format = /wav/i.test(mime) ? 'wav' : /ogg/i.test(mime) ? 'ogg' : 'mp3';
      return { kind: 'base64', value: b64, format };
    }

    // URL http(s)
    if (/^https?:\/\//i.test(value)) {
      return { kind: 'url', value, format: 'mp3' };
    }

    // base64 puro
    if (value.length > 512 && BASE64_RE.test(value)) {
      return { kind: 'base64', value, format: 'mp3' };
    }
  }

  return null;
}

/** Le os metadados que o LM escreveu no campo `content`. */
export function parseMetadata(content) {
  const meta = { caption: '', bpm: null, key: null, duration: null, lyrics: '' };
  const text = String(content || '');
  if (!text) return meta;

  const caption = /\*\*Caption:?\*\*\s*([^\n]+)/i.exec(text);
  if (caption) meta.caption = caption[1].trim();

  const bpm = /\*\*BPM:?\*\*\s*(\d+)/i.exec(text);
  if (bpm) meta.bpm = Number(bpm[1]);

  const duration = /\*\*Duration:?\*\*\s*([\d.]+)/i.exec(text);
  if (duration) meta.duration = Number(duration[1]);

  const key = /\*\*Key:?\*\*\s*([^\n]+)/i.exec(text);
  if (key) meta.key = key[1].trim();

  const lyrics = /#{1,3}\s*Lyrics\s*:?\s*([\s\S]*)$/i.exec(text);
  if (lyrics) meta.lyrics = lyrics[1].trim();

  return meta;
}

/** Descobre a duracao real do audio gerado. */
function durationOf(buffer, format, fallback) {
  const d = format === 'wav' ? wavDuration(buffer) : mp3Duration(buffer);
  return d || fallback || null;
}

/** Picos da forma de onda para a UI (decodifica o MP3 gerado). */
async function computeAudioPeaks(buffer, format) {
  if (format !== 'mp3') return null;
  try {
    const decoded = await decodeMp3Buffer(buffer);
    return computePeaks(decoded.channels);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Funcao principal
 * ------------------------------------------------------------------ */

/**
 * Gera a musica no ACE-Step 1.5.
 *
 * @param {string} prompt  descricao do estilo (caption)
 * @param {string} lyrics  letra (vazio = o modelo escreve a letra)
 * @param {string} style   genero/estilo (ex.: "MPB")
 * @param {object} options { duration, instrumental, genreLabel, moodLabel, lofi,
 *                           trackId, onProgress }
 * @returns {Promise<{buffer: Buffer, format: string, duration: number|null,
 *                    file: string, path: string, meta: object}>}
 */
export async function generateAceMusic(prompt, lyrics, style, options = {}) {
  if (!aceStepAvailable()) {
    throw new Error('ACESTEP_API_KEY ausente (configure em .env: https://acemusic.ai/api-key)');
  }

  const onProgress = options.onProgress || (() => {});
  const body = buildRequestBody({ prompt, lyrics, style, options });

  onProgress({
    stage: 'enviando ao ACE-Step',
    pct: 20,
    detail: body.sample_mode ? 'o modelo escreve a letra' : 'letra + estilo',
  });

  const payload = await callApi(body);

  onProgress({ stage: 'decodificando o audio', pct: 85, detail: 'base64 -> mp3' });

  const found = findAudioInPayload(payload);
  if (!found) {
    throw new Error('ACE-Step nao devolveu audio na resposta');
  }

  let buffer;
  let format = found.format;
  if (found.kind === 'base64') {
    buffer = Buffer.from(found.value, 'base64');
    if (buffer.length < 128) throw new Error('ACE-Step devolveu audio vazio');
  } else {
    buffer = await downloadBuffer(found.value);
    format = /\.wav(\?|$)/i.test(found.value) ? 'wav' : 'mp3';
  }

  const content = payload?.choices?.[0]?.message?.content || '';
  const meta = parseMetadata(content);
  meta.engine = 'acestep';
  meta.model = payload?.model || body.model || ACESTEP.model || 'acestep';
  meta.thinking = Boolean(body.thinking);
  meta.sampleMode = Boolean(body.sample_mode);
  meta.caption = meta.caption || buildCaption({ prompt, style, options });
  meta.requestId = payload?.id || null;

  // salva o MP3 no servidor e devolve o caminho local para o player
  const id = options.trackId || newId('trk');
  const file = saveAudio(id, buffer, format);

  const duration = durationOf(buffer, format, meta.duration || options.duration);
  const peaks = await computeAudioPeaks(buffer, format);

  onProgress({ stage: 'pronto', pct: 95, detail: `${Math.round(duration || 0)}s` });

  return {
    buffer,
    format,
    duration,
    file,
    path: audioPath(file),
    peaks,
    meta,
  };
}

/** Disponibilidade do provider (chave + base URL). */
export function aceStepStatus() {
  return {
    configured: aceStepAvailable(),
    baseURL: ACESTEP.baseURL,
    model: ACESTEP.model || '(padrao do servidor)',
    thinking: ACESTEP.thinking,
  };
}
