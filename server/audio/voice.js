/**
 * Voz por TTS (OpenRouter) + mixagem no instrumental.
 *
 * O motor procedural continua sendo o reserva: se a chamada ao TTS falhar
 * (sem chave, sem credito, timeout), a faixa volta a usar a voz sintetica
 * local e o app continua funcionando.
 */

import OpenAI from 'openai';
import decodeMp3 from '@audio/decode-mp3';
import { OPENROUTER, openRouterAvailable } from '../config.js';
import { decodeWav, encodeWav } from './wav.js';
import { singAlong } from './singing.js';

const SECTION_TYPES = {
  intro: 'intro',
  verse: 'verse',
  'pre-chorus': 'pre',
  pre: 'pre',
  chorus: 'chorus',
  bridge: 'bridge',
  outro: 'outro',
};

let cachedClient = null;
function client() {
  if (!cachedClient) {
    cachedClient = new OpenAI({
      apiKey: OPENROUTER.apiKey,
      baseURL: OPENROUTER.baseURL,
      defaultHeaders: {
        'HTTP-Referer': OPENROUTER.referer,
        'X-Title': OPENROUTER.title,
      },
    });
  }
  return cachedClient;
}

/** Vozes do TTS por estilo musical do app. */
const TTS_VOICES = {
  pop: 'alloy',
  warm: 'coral',
  rock: 'onyx',
  rap: 'ash',
  smoky: 'echo',
  forro: 'fable',
  gospel: 'shimmer',
  lofi: 'sage',
  airy: 'nova',
  nasal: 'verse',
};

/** Converte o estilo vocal do app na voz do TTS. */
export function resolveTtsVoice(style) {
  return TTS_VOICES[style] || OPENROUTER.ttsVoice;
}

/** Divide a letra em secoes (tags em ingles) -> [{ tag, type, lines[] }] */
export function parseLyricSections(text) {
  const sections = [];
  let current = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const tagMatch = /^\[(.+?)\]$/.exec(line);
    if (tagMatch) {
      const key = tagMatch[1].toLowerCase().replace(/\s*\d+$/, '').trim();
      current = { tag: tagMatch[1], type: SECTION_TYPES[key] || 'verse', lines: [] };
      sections.push(current);
      continue;
    }
    if (!line) continue;
    if (/^\(.*\)$/.test(line)) continue; // direcao entre parenteses: nao e cantada
    if (!current) {
      current = { tag: 'Verse', type: 'verse', lines: [] };
      sections.push(current);
    }
    current.lines.push(line);
  }
  return sections.filter((s) => s.lines.length > 0);
}

/** Texto corrido para o TTS (sem tags nem direcoes). */
export function sectionSpeechText(section) {
  return section.lines.join(' ');
}

/**
 * Sintetiza fala via /audio/speech do OpenRouter.
 *
 * Cada modelo aceita um conjunto de vozes diferente: o pedido tenta a voz
 * configurada, depois a voz padrao "alloy" e por fim sem o parametro voice
 * (modelos estilo Fish Audio escolhem a voz por prefixo no proprio texto).
 *
 * `style`/`emotion` sao enviados quando configurados: o OpenRouter encaminha
 * parametros nao-padrao para a API do modelo (OpenAI). No estado atual do
 * endpoint do Fish Audio eles sao ACEITOS mas IGNORADOS (um valor invalido
 * tambem devolve 200 e nao muda o audio) - por isso o "canto" e feito local,
 * em singing.js, aplicando a melodia da faixa sobre a fala.
 *
 * @returns {Promise<{buffer: Buffer, model: string, voice: string}>}
 */
export async function synthesizeSpeech(text, opts = {}) {
  if (!openRouterAvailable()) throw new Error('OPENROUTER_API_KEY ausente');
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Texto vazio para o TTS');

  const model = opts.model || OPENROUTER.ttsModel;
  const preferred = opts.voice || OPENROUTER.ttsVoice;
  const style = opts.style ?? OPENROUTER.ttsStyle;
  const emotion = opts.emotion ?? OPENROUTER.ttsEmotion;

  const base = { model, input: clean.slice(0, 4000), response_format: 'mp3' };
  if (style) base.style = style;
  if (emotion) base.emotion = emotion;

  const attempts = [
    { ...base, voice: preferred },
    { ...base, voice: 'alloy' },
    { ...base },
  ];

  let lastError = null;
  for (let i = 0; i < attempts.length; i += 1) {
    const body = attempts[i];
    try {
      const res = await client().audio.speech.create(body);
      let buffer;
      if (res && typeof res.arrayBuffer === 'function') buffer = Buffer.from(await res.arrayBuffer());
      else if (res instanceof ArrayBuffer) buffer = Buffer.from(res);
      else throw new Error('Resposta inesperada do endpoint de TTS');
      if (buffer.length < 128) throw new Error('TTS devolveu audio vazio');
      return { buffer, model, voice: body.voice || preferred, style: body.style, emotion: body.emotion };
    } catch (err) {
      lastError = err;
      // 402 (sem credito) e 429 nao mudam com outra voz: aborta
      const status = err?.status || err?.response?.status;
      if (status === 402 || status === 429 || status === 401 || status === 403) throw err;
    }
  }
  throw lastError || new Error('Falha no TTS');
}

/** Decodifica MP3 -> canais Float32 + sampleRate. */
export async function decodeMp3Buffer(buffer) {
  const view = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const out = await decodeMp3(view);
  if (!out || !out.channelData || !out.channelData.length) {
    throw new Error('Falha ao decodificar o MP3 do TTS');
  }
  return {
    channels: out.channelData.map((c) => Float32Array.from(c)),
    sampleRate: out.sampleRate || 44100,
  };
}

/**
 * Mistura as faixas de voz no WAV do instrumental (reamostrando).
 * @param {Buffer} wavBuffer
 * @param {Array<{start:number, channels:Float32Array[], sampleRate:number, gain?:number}>} takes
 */
export function mixSpeechIntoWav(wavBuffer, takes) {
  const { channels, sampleRate } = decodeWav(wavBuffer);
  const [L, R] = channels;
  const total = L.length;
  const fade = Math.floor(0.04 * sampleRate);

  for (const take of takes) {
    if (!take || !take.channels || !take.channels.length) continue;
    const srcL = take.channels[0];
    const srcR = take.channels[1] || srcL;
    const start = Math.max(0, Math.floor(take.start * sampleRate));
    const gain = take.gain ?? 0.9;
    const ratio = take.sampleRate / sampleRate;

    for (let i = 0; i < srcL.length; i += 1) {
      const pos = start + i;
      if (pos >= total) break;
      const srcPos = i * ratio;
      const i0 = Math.floor(srcPos);
      const frac = srcPos - i0;
      const a0 = srcL[Math.min(i0, srcL.length - 1)];
      const a1 = srcL[Math.min(i0 + 1, srcL.length - 1)];
      const b0 = srcR[Math.min(i0, srcR.length - 1)];
      const b1 = srcR[Math.min(i0 + 1, srcR.length - 1)];
      let env = 1;
      if (i < fade) env = i / fade;
      const tail = srcL.length - i;
      if (tail < fade) env *= Math.max(0, tail) / fade;
      L[pos] += (a0 + (a1 - a0) * frac) * gain * env;
      R[pos] += (b0 + (b1 - b0) * frac) * gain * env;
    }
  }

  // limita a soma para nao estourar (o instrumental ja vem normalizado em 0.9)
  let peak = 0;
  for (let i = 0; i < L.length; i += 1) {
    const a = Math.abs(L[i]);
    const b = Math.abs(R[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  if (peak > 0.98) {
    const g = 0.98 / peak;
    for (let i = 0; i < L.length; i += 1) {
      L[i] *= g;
      R[i] *= g;
    }
  }

  return encodeWav([L, R], sampleRate);
}

/** Executa tarefas em paralelo com limite de concorrência. */
async function pool(tasks, limit = 3) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Gera a voz da faixa: sintetiza a letra e mistura no instrumental.
 *
 * @param {Buffer} wavBuffer WAV do instrumental
 * @param {string} lyrics letra completa
 * @param {Array<{name:string,type:string,start:number,duration:number}>} planSections
 * @param {object} opts { voice, model, onProgress }
 * @returns {Promise<{buffer: Buffer, takes: number, model: string, voice: string}>}
 */
export async function voiceOver(wavBuffer, lyrics, planSections = [], opts = {}) {
  const sections = parseLyricSections(lyrics);
  if (!sections.length) throw new Error('Letra sem secoes para cantar');

  const singable = sections.filter((s) => s.type !== 'intro' && s.type !== 'outro');
  const timeline = planSections.filter((s) => s.type !== 'intro' && s.type !== 'outro');

  // posiciona cada secao da letra no compasso correspondente do plano
  const planCursor = { i: 0 };
  const planned = singable.map((section) => {
    let idx = -1;
    for (let k = planCursor.i; k < timeline.length; k += 1) {
      if (timeline[k].type === section.type) { idx = k; break; }
    }
    if (idx < 0) {
      for (let k = planCursor.i; k < timeline.length; k += 1) {
        if (timeline[k].type === 'verse' || timeline[k].type === 'chorus') { idx = k; break; }
      }
    }
    if (idx >= 0) planCursor.i = idx + 1;
    const start = idx >= 0 ? timeline[idx].start : null;
    return { section, start };
  });

  // sem correspondencia por tipo: posiciona sequencialmente
  let fallbackStart = timeline.length ? timeline[0].start : 0;
  for (const item of planned) {
    if (item.start === null) {
      item.start = fallbackStart;
      fallbackStart += 6;
    } else {
      fallbackStart = item.start + 1;
    }
  }

  const onProgress = opts.onProgress || (() => {});
  const usePerSection = OPENROUTER.ttsPerSection && planned.length > 1;
  const melody = opts.melody || [];
  const singStrength = opts.singStrength ?? 0.85;

  /**
   * Faz a voz "cantar": aplica a melodia da faixa sobre a fala do TTS.
   * O tempo do audio e mapeado no tempo planejado (a fala pode ser mais rapida
   * ou lenta que a melodia).
   */
  const applySinging = (audio, takeStart) => {
    if (!melody.length || singStrength <= 0) return audio;
    const notes = melody.filter((n) => n.start >= takeStart - 0.05 && n.start < takeStart + 12);
    if (!notes.length) return audio;
    const plannedSpan = Math.max(
      0.5,
      notes[notes.length - 1].start + notes[notes.length - 1].dur - notes[0].start,
    );
    const audioDur = audio.channels[0].length / audio.sampleRate;
    const mono = new Float32Array(audio.channels[0].length);
    for (let c = 0; c < audio.channels.length; c += 1) {
      const ch = audio.channels[c];
      for (let i = 0; i < mono.length; i += 1) mono[i] += ch[i] / audio.channels.length;
    }
    const sung = singAlong(mono, audio.sampleRate, notes, takeStart, plannedSpan, singStrength, audioDur / plannedSpan);
    return {
      channels: [sung, sung],
      sampleRate: audio.sampleRate,
    };
  };

  const synthOne = async (item) => {
    const speech = await synthesizeSpeech(sectionSpeechText(item.section), opts);
    const decoded = await decodeMp3Buffer(speech.buffer);
    const audio = applySinging(decoded, item.start);
    return { start: item.start, ...audio, gain: opts.gain ?? 1.15 };
  };

  let takes;
  if (usePerSection) {
    onProgress({ detail: `TTS: ${planned.length} seções` });
    let firstError = null;
    takes = await pool(planned.map((item) => async () => {
      try {
        return await synthOne(item);
      } catch (err) {
        if (!firstError) firstError = err;
        onProgress({ detail: `falha em "${item.section.tag}": ${err.message}` });
        return null;
      }
    }), 3);
    takes = takes.filter(Boolean);
    if (!takes.length) {
      throw firstError || new Error('nenhuma seção de voz foi sintetizada');
    }
  } else {
    onProgress({ detail: 'TTS: letra completa' });
    const all = planned.map((p) => sectionSpeechText(p.section)).join(' ');
    const speech = await synthesizeSpeech(all, opts);
    const decoded = await decodeMp3Buffer(speech.buffer);
    const start = planned[0]?.start ?? 0;
    const audio = applySinging(decoded, start);
    takes = [{ start, ...audio, gain: opts.gain ?? 1.15 }];
  }

  const buffer = mixSpeechIntoWav(wavBuffer, takes);
  return {
    buffer,
    takes: takes.length,
    model: opts.model || OPENROUTER.ttsModel,
    voice: opts.voice || OPENROUTER.ttsVoice,
  };
}
