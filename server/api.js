/**
 * Camada de API do MusicGPT (clone).
 * Rotas: geracao, biblioteca, playlists, letras, perfil, explorar, export.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { GENRES, MOODS, VOICE_STYLES, STRUCTURES } from './theory.js';
import { audioPath, newId, saveAudio, store } from './store.js';
import {
  activeLyricsProvider,
  activeMusicProvider,
  activeVoiceProvider,
  mainLyricsProvider,
  PROVIDERS,
} from './config.js';
import { generateLyricsWithProvider } from './providers/lyrics.js';
import { generateMusic } from './providers/music.js';
import { aceStepStatus, normalizeAudioMode } from './providers/acestep.js';
import { generateLyrics as generateLocalLyrics, lyricTheme } from './lyrics.js';
import { voiceOver, resolveTtsVoice } from './audio/voice.js';
import { detectGenre, detectMood, MAX_DURATION_SEC } from './audio/render.js';
import { encodeMp3, mp3Available } from './audio/mp3.js';
import { mp3Duration, wavDuration } from './audio/remote.js';
import { buildReferencePayload, referenceSummary } from './audio/reference.js';
import { describeUploadError, isMultipart, readMultipart } from './upload.js';
import {
  convertAudio,
  readSource,
  resolveSource,
  sendAttachment,
  sendRemoteProxy,
} from './audio/delivery.js';

const jobs = new Map();
const workerFile = new URL('./audio/worker.js', import.meta.url);

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function slugify(text) {
  return String(text || 'sem-titulo')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'sem-titulo';
}

const STOPWORDS = new Set(['de', 'do', 'da', 'das', 'dos', 'com', 'sobre', 'no', 'na', 'nos', 'nas', 'em', 'e', 'a', 'o', 'um', 'uma', 'para', 'pra', 'que', 'e']);
const GENRE_WORDS = new Set(['mpb', 'trap', 'pop', 'rock', 'funk', 'samba', 'sertanejo', 'forro', 'forró', 'pagode', 'lofi', 'lo-fi', 'house', 'gospel', 'jazz', 'ambient', 'reaggaeton', 'baile', 'disco', 'soul']);

function titleFromPrompt(prompt, genre) {
  const clean = String(prompt || '').trim();
  if (!clean) return `Faixa ${genre || 'nova'}`;
  const first = clean.split(/[.,\n]/)[0].trim();
  let words = first.split(/\s+/).filter(Boolean);
  // tira o rótulo do gênero no começo ("MPB melancólico..." -> "Melancólico...")
  while (words.length > 1 && GENRE_WORDS.has(words[0].toLowerCase().replace(/[.,!?;:]$/, ''))) {
    words.shift();
  }
  // corta em 5 palavras
  words = words.slice(0, 5);
  // remove conectivos no fim ("... sobre", "... de")
  while (words.length > 1 && STOPWORDS.has(words[words.length - 1].toLowerCase().replace(/[.,!?;:]$/, ''))) {
    words.pop();
  }
  const title = words.join(' ');
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function trackById(id) {
  const lib = store.library();
  return lib.tracks.find((t) => t.id === id) || null;
}

/**
 * Versao da faixa segura para o cliente.
 *
 * A `sourceUrl` guarda o audio original do provider (data URL do ACE-Step
 * com megabytes de base64, ou URL https). Ela e do servidor: nunca vai
 * para o browser, senao a biblioteca viraria um arquivo gigante.
 */
export function publicTrack(track) {
  if (!track) return track;
  const { sourceUrl, ...rest } = track;
  // `hasSource` diz se a faixa ainda tem a URL original do provider (util
  // para a UI saber que o download nao depende do disco), sem expor o audio.
  return { ...rest, hasSource: Boolean(sourceUrl) };
}

/* ------------------------------------------------------------------ *
 * Geracao
 * ------------------------------------------------------------------ */

function runWorker(options, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: { options } });
    worker.on('message', (msg) => {
      if (msg.type === 'progress') onProgress(msg);
      else if (msg.type === 'done') {
        worker.terminate();
        resolve({
          buffer: Buffer.from(msg.buffer),
          meta: msg.meta,
          peaks: msg.peaks,
          duration: msg.meta?.duration,
        });
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    });
    worker.on('error', (err) => reject(err));
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`worker encerrou com codigo ${code}`));
    });
  });
}

async function executeJob(job, options, referenceAudio = null) {
  const emit = (patch) => {
    Object.assign(job, patch);
    for (const client of job.clients) {
      try {
        client.write(`data: ${JSON.stringify({
          status: job.status,
          progress: job.progress,
          stage: job.stage,
          detail: job.detail,
          error: job.error,
          track: job.track,
        })}\n\n`);
      } catch {
        job.clients.delete(client);
      }
    }
  };

  try {
    emit({ status: 'running', stage: 'letra', progress: 5 });

    const warnings = [];
    const provider = activeMusicProvider();
    const trackId = newId('trk');
    let lyrics = options.lyrics;
    let lyricsEngine = null;

    // o audio de referencia so e usado pelo ACE-Step (motor multimodal)
    if (referenceAudio && provider !== 'acestep') {
      warnings.push('Audio de referencia ignorado: ele precisa do motor ACE-Step, que nao esta ativo neste servidor.');
      emit({ detail: warnings[warnings.length - 1] });
    }

    const theme = options.instrumental ? '' : lyricTheme(lyrics);

    // COVER: o LM do ACE-Step e pulado pela propria API e a melodia
    // original exige letra pronta - nesse caso o tema continua sendo
    // expandido aqui (como no caminho local).
    const coverMode = Boolean(referenceAudio)
      && normalizeAudioMode(options.audioMode) === 'cover';

    /**
     * MODO NATURAL LANGUAGE (ACE-Step).
     *
     * Com o ACE-Step ativo, o tema (ou o campo vazio) NAO passa pelo
     * gerador local nem pelo OpenRouter: o texto vira `sample_query` da API
     * ("natural language description", documentacao do ACE-Step) e o PROPRIO
     * LM 5Hz expande o tema em caption + letra + metadados antes do DiT.
     * Excecoes: instrumental (sem vocal) e cover (letra precisa estar pronta).
     */
    const naturalLanguage = provider === 'acestep'
      && !options.instrumental && !coverMode;
    if (theme && naturalLanguage) {
      emit({ detail: 'enviando o tema ao ACE-Step (modo Natural Language)' });
      warnings.push('Tema expandido pelo modelo do ACE-Step (Natural Language).');
      emit({ detail: warnings[warnings.length - 1] });
      // o tema NAO vai como <lyrics>: vira sample_query (options.theme)
      lyrics = '';
    } else if (theme) {
      emit({ detail: 'transformando o tema em letra completa' });
      // com o texto de Estilos preenchido ele JA e o estilo: nao repetimos no
      // campo "genero" do gerador de letras
      const styleForLyrics = options.styleFromText ? '' : options.style;
      try {
        const res = await generateLyricsWithProvider({
          prompt: theme,
          lang: options.lang,
          style: styleForLyrics,
          seed: options.seed,
        }, mainLyricsProvider());
        lyrics = res.text;
        lyricsEngine = res.engine;
      } catch (err) {
        // fallback: gerador local de letras (offline)
        const local = generateLocalLyrics({
          prompt: theme,
          lang: options.lang,
          style: styleForLyrics,
          seed: options.seed,
        });
        lyrics = local.text;
        lyricsEngine = 'local-templates';
        // so a 1a linha, e curta: o toast nao aguenta a resposta inteira da API
        const motivo = `${err.message}`.split('\n')[0].slice(0, 120);
        warnings.push(`Letra via IA indisponível (${motivo}). Usado o gerador local.`);
        emit({ detail: warnings[warnings.length - 1] });
      }
      warnings.push('Tema expandido em letra completa.');
      emit({ detail: warnings[warnings.length - 1] });
    }
    // tema original digitado pelo usuario (quando ele virou letra completa)
    const lyricsTheme = theme || null;
    const lyricsExpanded = Boolean(theme);
    if (provider === 'acestep') {
      // O ACE-Step gera a musica E o vocal (com a letra). Quando o usuario
      // nao manda uma letra, o proprio LM 5Hz escreve uma - sem depender do
      // OpenRouter (nem de rede extra). Se o tema ja virou letra, o engine
      // ve do gerador usado (acima).
      lyricsEngine = options.instrumental ? null : (lyricsEngine || (lyrics ? 'user' : 'acestep-lm'));
    } else if (!options.instrumental && !lyrics) {
      // com o texto de Estilos preenchido o prompt JA e o estilo: nao
      // repetimos o texto no campo "genero" do gerador de letras.
      const styleForLyrics = options.styleFromText ? '' : options.style;
      try {
        const res = await generateLyricsWithProvider({
          prompt: options.prompt,
          lang: options.lang,
          style: styleForLyrics,
          seed: options.seed,
        }, mainLyricsProvider());
        lyrics = res.text;
        lyricsEngine = res.engine;
      } catch (err) {
        // fallback: gerador local de letras
        const local = generateLocalLyrics({
          prompt: options.prompt,
          lang: options.lang,
          style: styleForLyrics,
          seed: options.seed,
        });
        lyrics = local.text;
        lyricsEngine = 'local-templates';
        // so a 1a linha, e curta: o toast nao aguenta a resposta inteira da API
        const motivo = `${err.message}`.split('\n')[0].slice(0, 120);
        warnings.push(`Letra via IA indisponível (${motivo}). Usado o gerador local.`);
        emit({ detail: warnings[warnings.length - 1] });
      }
    }

    emit({ status: 'running', stage: 'composicao', progress: 12, detail: 'escrevendo a música' });

    const voiceProvider = activeVoiceProvider();
    const wantsVoice = !options.instrumental && Boolean(lyrics);
    // O TTS so entra no motor local (o ACE-Step ja canta). E so quando o
    // usuario pede "Voz por IA" ou quando MUSICGPT_TTS_PROVIDER=openrouter.
    const useTts = wantsVoice && provider === 'local'
      && (options.voiceEngine === 'openrouter'
        || (options.voiceEngine === 'auto' && voiceProvider === 'openrouter'));

    let result;
    let effectiveProvider = provider;
    if (provider === 'local') {
      result = await runWorker({ ...options, lyrics, instrumental: useTts ? true : options.instrumental }, (p) => {
        emit({ stage: p.stage, progress: Math.min(92, 10 + Math.round((p.pct || 0) * 0.82)), detail: p.detail });
      });
    } else {
      try {
        result = await generateMusic({
          ...options,
          lyrics,
          // tema cru para o modo Natural Language do ACE-Step
          theme: naturalLanguage ? theme : '',
          trackId,
          referenceAudio,
        }, (p) => {
          emit({ stage: p.stage, progress: Math.min(92, 10 + Math.round((p.pct || 0) * 0.82)), detail: p.detail });
        });
        if (!result.peaks) result.peaks = null;
      } catch (err) {
        // o provedor remoto falhou (cota, rede, chave): seguimos com o motor
        // procedural local para nao perder a geracao
        emit({ stage: 'motor local', progress: 90, detail: `provedor falhou (${err.message})` });
        warnings.push(`Provedor remoto indisponível (${err.message}). Usado o motor procedural local.`);
        if (referenceAudio) {
          warnings.push('O audio de referencia nao pode ser usado pelo motor local.');
        }
        if (!options.instrumental && !lyrics) {
          // o motor local precisa de uma letra para cantar: aqui (e so
          // aqui, com o ACE-Step fora) o tema vira letra pelos templates
          const local = generateLocalLyrics({
            prompt: theme || options.prompt,
            lang: options.lang,
            style: options.styleFromText ? '' : options.style,
            seed: options.seed,
          });
          lyrics = local.text;
          lyricsEngine = 'local-templates';
        }
        result = await runWorker({ ...options, lyrics, instrumental: options.instrumental }, (p) => {
          emit({ stage: p.stage, progress: 93, detail: p.detail });
        });
        effectiveProvider = 'local';
        result.meta = { ...result.meta, engine: 'local-procedural' };
      }
    }

    let voiceInfo = { engine: useTts ? 'openrouter' : 'procedural' };
    if (provider === 'acestep' && effectiveProvider === 'acestep') {
      // o vocal veio junto com a musica, gerado pelo proprio modelo
      voiceInfo = {
        engine: 'acestep',
        model: result.meta?.model,
        vocals: !options.instrumental,
      };
    }

    if (useTts) {
      try {
        emit({ stage: 'voz (TTS)', progress: 90, detail: 'sintetizando a voz' });
        const voiced = await voiceOver(result.buffer, lyrics, result.meta?.sections || [], {
          voice: options.ttsVoice || resolveTtsVoice(options.voiceStyle),
          melody: result.meta?.melody || [],
          singStrength: options.singStrength,
          onProgress: (p) => emit({ detail: p.detail }),
        });
        result.buffer = voiced.buffer;
        voiceInfo = {
          engine: 'openrouter',
          model: voiced.model,
          voice: voiced.voice,
          takes: voiced.takes,
        };
      } catch (err) {
        // fallback: re-renderiza com a voz procedural local
        emit({ stage: 'voz procedural', progress: 92, detail: `TTS falhou (${err.message})` });
        const fallback = await runWorker({ ...options, lyrics, instrumental: false }, (p) => {
          emit({ stage: p.stage, progress: 93, detail: p.detail });
        });
        result.buffer = fallback.buffer;
        result.peaks = fallback.peaks;
        result.meta = fallback.meta;
        voiceInfo = { engine: 'procedural-fallback', error: err.message };
        warnings.push(`Voz por IA indisponível (${err.message}). Usada a voz procedural.`);
      }
    }

    emit({ stage: 'salvando', progress: 94 });

    const id = trackId;
    const format = result.format || 'wav';
    // o provider ACE-Step ja salvou o MP3 no disco (data/tracks)
    const relative = result.file || saveAudio(id, result.buffer, format);
    const duration = result.duration
      || (format === 'wav' ? wavDuration(result.buffer) : mp3Duration(result.buffer))
      || options.duration;

    // letra escrita pelo proprio modelo (quando o usuario nao mandou uma)
    const finalLyrics = options.instrumental
      ? ''
      : (lyrics || result.meta?.lyrics || '');
    // modo Natural Language: o ACE-Step expandiu o tema, mas nem sempre
    // devolve a letra escrita no `content` - avisamos em vez de deixar
    // a faixa silenciosa sobre o assunto.
    if (naturalLanguage && theme && !finalLyrics) {
      warnings.push('O ACE-Step nao devolveu a letra escrita pelo modelo (a musica foi gerada sem ela no card).');
      emit({ detail: warnings[warnings.length - 1] });
    }
    const title = (options.title && options.title.trim()) || titleFromPrompt(options.prompt, options.genreLabel);
    const now = Date.now();
    const track = {
      id,
      title,
      slug: slugify(title),
      prompt: options.prompt || '',
      description: options.prompt || '',
      genre: options.genre,
      genreLabel: options.genreLabel,
      mood: options.mood,
      moodLabel: options.moodLabel,
      // estilo usado na geracao (texto digitado > botao de genero)
      style: options.style,
      styleLabel: options.styleLabel,
      styleSource: options.styleSource,
      instrumental: Boolean(options.instrumental),
      lyrics: finalLyrics,
      lyricsEngine: lyricsEngine || result.meta?.lyricsEngine || null,
      // tema digitado no campo "Letra" que virou letra completa (Bug 2)
      lyricsTheme,
      lyricsExpanded,
      duration: Math.round(duration * 100) / 100,
      bpm: result.meta?.bpm ?? GENRES[options.genre]?.bpm ?? null,
      key: result.meta?.key ?? null,
      structure: result.meta?.structure ?? [],
      vocals: result.meta?.vocals ?? [],
      melody: result.meta?.melody ?? [],
      voice: options.voiceStyle || result.meta?.voice || null,
      voiceInfo,
      warnings,
      // audio de referencia usado como estilo (sem o audio em si)
      referenceAudio: result.meta?.referenceAudio
        || (referenceAudio ? { ...referenceSummary(referenceAudio), used: false, mode: options.audioMode } : null),
      // modo usado com o audio anexado: "reference" (estilo/remix) ou
      // "cover" (manter a melodia original). null = sem audio anexado.
      audioMode: referenceAudio
        ? (result.meta?.audioMode || options.audioMode)
        : null,
      // fidelidade usada no cover (0.8..1.0)
      coverStrength: result.meta?.coverStrength ?? null,
      coverNoiseStrength: result.meta?.coverNoiseStrength ?? null,
      lofi: Boolean(options.lofi),
      engine: result.meta?.engine || effectiveProvider,
      provider: effectiveProvider,
      format,
      file: relative,
      // URL original do audio no provider (data URL do ACE-Step ou https do
      // Replicate/fal). E o que permite baixar a faixa mesmo quando o disco
      // efemero do host foi recriado.
      sourceUrl: result.sourceUrl || result.meta?.sourceUrl || null,
      sourceFormat: result.sourceFormat || result.meta?.sourceFormat || format,
      peaks: result.peaks || [],
      // a primeira tag e o estilo usado (texto digitado quando existe)
      tags: [
        options.styleLabel,
        options.moodLabel,
        options.lofi ? 'chuva' : null,
        referenceAudio ? (options.audioMode === 'cover' ? 'modo: cover' : 'modo: estilo') : null,
      ].filter(Boolean),
      createdAt: now,
      plays: 0,
      likes: 0,
      isPublic: false,
    };

    const lib = store.library();
    lib.tracks.unshift(track);
    store.saveLibrary(lib);

    emit({ status: 'done', progress: 100, stage: 'pronto', track: publicTrack(track) });
  } catch (error) {
    emit({ status: 'error', stage: 'erro', progress: 100, error: error?.message || String(error) });
  }
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

export const handlers = {
  health(_req, res) {
    json(res, 200, {
      ok: true,
      musicProvider: activeMusicProvider(),
      lyricsProvider: activeLyricsProvider(),
      mainLyricsProvider: mainLyricsProvider(),
      acestep: aceStepStatus(),
      mp3: mp3Available(),
      tracks: store.library().tracks.length,
    });
  },

  config(_req, res) {
    json(res, 200, {
      genres: Object.entries(GENRES).map(([key, g]) => ({ key, label: g.label, bpm: g.bpm, vocal: g.vocal })),
      moods: Object.keys(MOODS),
      voices: Object.keys(VOICE_STYLES),
      structures: Object.keys(STRUCTURES),
      providers: {
        music: activeMusicProvider(),
        lyrics: activeLyricsProvider(),
        mainLyrics: mainLyricsProvider(),
        voice: activeVoiceProvider(),
        acestep: aceStepStatus(),
        openrouter: {
          configured: Boolean(process.env.OPENROUTER_API_KEY),
          lyricsModel: process.env.OPENROUTER_LYRICS_MODEL || 'openai/gpt-4o-mini',
          ttsModel: process.env.OPENROUTER_TTS_MODEL || 'fish-audio/s2.1-pro-free:free',
        },
        configured: {
          acestep: aceStepStatus().configured,
          replicate: Boolean(PROVIDERS.music.replicate.token),
          fal: Boolean(PROVIDERS.music.fal.key),
          openai: Boolean(PROVIDERS.lyrics.openai.key),
        },
      },
    });
  },

  /**
   * POST /api/generate
   *
   * Aceita application/json (fluxo normal) ou multipart/form-data (quando o
   * usuario anexa um audio de referencia para Audio-to-Audio / Style Transfer).
   * No caso multipart, o audio vem no campo "referenceAudio".
   */
  async generate(req, res) {
    let body;
    let referenceAudio = null;

    if (isMultipart(req)) {
      let parsed;
      try {
        parsed = await readMultipart(req, res);
      } catch (err) {
        return json(res, 400, { error: describeUploadError(err) });
      }
      body = parsed.fields || {};
      referenceAudio = buildReferencePayload(parsed.file);
    } else {
      body = await readJson(req);
    }

    const prompt = String(body.prompt || '').trim();
    if (!prompt && !body.lyrics) {
      return json(res, 400, { error: 'Descreva a musica que voce quer criar.' });
    }

    /**
     * MODO DO AUDIO ANEXADO.
     *
     * - `reference` (padrao): o arquivo e so uma REFERENCIA DE ESTILO - a
     *   API cria uma musica nova usando o timbre/producao dele.
     * - `cover`: o arquivo e o AUDIO DE ORIGEM (`src_audio`): o modelo tenta
     *   manter a melodia e a estrutura originais.
     *
     * Sem audio anexado o modo nao muda nada (pedido em texto puro).
     */
    const audioMode = normalizeAudioMode(body.audioMode);

    /**
     * PRIORIDADE ABSOLUTA DO TEXTO DO CAMPO "ESTILOS".
     *
     * Quando o cliente envia o texto digitado (`style`), ele manda: o genero
     * dos botoes (Pop, MPB, ...) e completamente ignorado - nem no estilo,
     * nem na caption que vai para a API do ACE-Step, nem nas tags da faixa.
     * Sem o texto, o genero do botao (ou o detectado pelo prompt) manda.
     */
    const styleText = String(body.style || '').trim();
    const styleFromText = Boolean(styleText);

    // com o texto preenchido o genero tambem vem do texto (botao ignorado);
    // sem texto, vale o botao selecionado e, na falta dele, a deteccao.
    const genreKey = styleFromText
      ? detectGenre(prompt)
      : (body.genre && GENRES[body.genre] ? body.genre : detectGenre(prompt));
    const genre = GENRES[genreKey];
    const moodKey = body.mood && MOODS[body.mood] ? body.mood : detectMood(prompt);
    const effectiveStyle = styleFromText ? styleText : genre.label;
    const options = {
      prompt,
      title: body.title,
      genre: genreKey,
      genreLabel: genre.label,
      mood: moodKey,
      moodLabel: moodKey,
      // estilo que vai para o motor de musica (caption do ACE-Step)
      style: effectiveStyle,
      // rotulo exibido no card da faixa (o texto digitado, quando existe)
      styleLabel: effectiveStyle,
      styleSource: styleFromText ? 'text' : 'genre',
      styleFromText,
      // modo do audio anexado: referencia de estilo (remix) ou cover
      audioMode,
      // fidelidade ao original no cover (slider "Fidelidade ao Original")
      coverStrength: Number(body.coverStrength),
      coverNoiseStrength: Number(body.coverNoiseStrength),
      instrumental: asBool(body.instrumental),
      duration: Math.min(MAX_DURATION_SEC, Math.max(20, Number(body.duration) || 75)),
      voiceStyle: VOICE_STYLES[body.voiceStyle] ? body.voiceStyle : genre.vocal,
      lofi: asBool(body.lofi),
      variety: Number.isFinite(Number(body.variety)) ? Math.max(0, Math.min(1, Number(body.variety))) : 0.5,
      voiceEngine: ['auto', 'openrouter', 'procedural'].includes(body.voiceEngine) ? body.voiceEngine : 'auto',
      ttsVoice: typeof body.ttsVoice === 'string' ? body.ttsVoice : '',
      singStrength: Number.isFinite(Number(body.singStrength))
        ? Math.max(0, Math.min(1, Number(body.singStrength)))
        : 0.85,
      lyrics: body.lyrics || '',
      lang: body.lang === 'en' ? 'en' : 'pt',
      seed: body.seed,
    };

    const job = {
      id: newId('job'),
      status: 'queued',
      progress: 0,
      stage: 'fila',
      detail: null,
      error: null,
      track: null,
      createdAt: Date.now(),
      clients: new Set(),
    };
    jobs.set(job.id, job);
    setTimeout(() => executeJob(job, options, referenceAudio), 10);
    return json(res, 202, { jobId: job.id, status: job.status });
  },

  jobStatus(req, res, params) {
    const job = jobs.get(params.id);
    if (!job) return json(res, 404, { error: 'Job nao encontrado' });
    return json(res, 200, {
      id: job.id, status: job.status, progress: job.progress, stage: job.stage,
      detail: job.detail, error: job.error, track: job.track,
    });
  },

  jobEvents(req, res, params) {
    const job = jobs.get(params.id);
    if (!job) return json(res, 404, { error: 'Job nao encontrado' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (payload) => {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch { /* cliente desconectou */ }
    };
    write({ status: job.status, progress: job.progress, stage: job.stage, detail: job.detail, error: job.error, track: job.track });
    job.clients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* noop */ }
    }, 15000);
    req.on('close', () => {
      clearInterval(ping);
      job.clients.delete(res);
    });
  },

  /**
   * GERA LETRA A PARTIR DE UM TEMA.
   *
   * A varinha do bloco "Letra" manda aqui o texto do campo (o tema) e
   * recebe uma letra completa de volta.
   *
   * `seed` opcional: sem ela o gerador local deriva a seed do hash do
   * prompt, entao o MESMO tema devolveria SEMPRE a mesma letra (o Bug 1 da
   * varinha). O cliente manda uma seed nova por clique; aqui ela so passa
   * adiante.
   *
   * Se o provider de IA falhar, o gerador local offline assume - a rota
   * nunca responde 502 so por causa de rede/chave.
   */
  async lyrics(req, res) {
    const body = await readJson(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return json(res, 400, { error: 'Informe o tema da letra.' });

    const opts = {
      prompt,
      lang: body.lang === 'en' ? 'en' : 'pt',
      style: body.style,
      mode: body.mode === 'next' ? 'next' : 'full',
      context: Array.isArray(body.context) ? body.context : [],
      // so numero vira seed; null/vazio/lixo caem em undefined (hash do
      // prompt) - Number(null) e 0, entao nao da para confiar em Number()
      seed: body.seed === null || body.seed === undefined || body.seed === ''
        ? undefined
        : Number(body.seed),
    };
    if (!Number.isFinite(opts.seed)) opts.seed = undefined;

    try {
      const result = await generateLyricsWithProvider(opts);
      if (opts.mode === 'next') {
        const line = result.line || result.text || '';
        return json(res, 200, { line, theme: result.theme, engine: result.engine });
      }
      return json(res, 200, result);
    } catch (error) {
      // fallback offline: o app nunca quebra por falta de chave/rede
      try {
        const local = generateLocalLyrics(opts);
        if (opts.mode === 'next') {
          return json(res, 200, { line: local.line, theme: local.theme, engine: 'local-templates' });
        }
        return json(res, 200, { ...local, engine: 'local-templates' });
      } catch (localError) {
        return json(res, 502, { error: `Falha ao gerar letra: ${localError.message}` });
      }
    }
  },

  listTracks(_req, res) {
    const lib = store.library();
    return json(res, 200, { tracks: lib.tracks.map(publicTrack) });
  },

  getTrack(req, res, params) {
    const track = trackById(params.id);
    if (!track) return json(res, 404, { error: 'Faixa nao encontrada' });
    return json(res, 200, { track: publicTrack(track) });
  },

  deleteTrack(req, res, params) {
    const lib = store.library();
    const idx = lib.tracks.findIndex((t) => t.id === params.id);
    if (idx < 0) return json(res, 404, { error: 'Faixa nao encontrada' });
    const [track] = lib.tracks.splice(idx, 1);
    lib.plays = lib.plays || {};
    delete lib.plays[track.id];
    store.saveLibrary(lib);
    const playlists = store.playlists();
    for (const p of playlists.playlists) {
      const before = p.trackIds.length;
      p.trackIds = p.trackIds.filter((id) => id !== track.id);
      if (p.trackIds.length !== before) p.updatedAt = Date.now();
    }
    store.savePlaylists(playlists);
    try {
      fs.unlinkSync(audioPath(track.file));
    } catch { /* arquivo ja removido */ }
    return json(res, 200, { ok: true, id: track.id });
  },

  playTrack(req, res, params) {
    const lib = store.library();
    lib.plays = lib.plays || {};
    lib.plays[params.id] = (lib.plays[params.id] || 0) + 1;
    const track = lib.tracks.find((t) => t.id === params.id);
    if (track) track.plays = (track.plays || 0) + 1;
    store.saveLibrary(lib);
    return json(res, 200, { ok: true, plays: track?.plays || 0 });
  },

  likeTrack(req, res, params) {
    const lib = store.library();
    const track = lib.tracks.find((t) => t.id === params.id);
    if (!track) return json(res, 404, { error: 'Faixa nao encontrada' });
    track.likes = (track.likes || 0) + 1;
    track.isPublic = true;
    store.saveLibrary(lib);
    return json(res, 200, { ok: true, likes: track.likes });
  },

  publishTrack(req, res, params) {
    const lib = store.library();
    const track = lib.tracks.find((t) => t.id === params.id);
    if (!track) return json(res, 404, { error: 'Faixa nao encontrada' });
    track.isPublic = !track.isPublic;
    store.saveLibrary(lib);
    return json(res, 200, { ok: true, isPublic: track.isPublic });
  },

  /**
   * GET /api/download/:id?format=mp3|wav[&source=auto|remote|local]
   *
   * Baixa o audio da faixa como anexo (Content-Disposition: attachment).
   *
   * A fonte NAO depende do disco local: quando a faixa tem a `audio_url`
   * original do provider (data URL do ACE-Step ou URL https do
   * Replicate/fal), o arquivo e servido a partir dela - assim o download
   * continua funcionando depois de um restart/deploy que recriou o disco.
   * Sem a URL original, cai para o arquivo em data/tracks.
   *
   * O formato pedido e garantido: WAV -> MP3 e convertido com lamejs,
   * MP3 -> WAV e decodificado (@audio/decode-mp3).
   */
  async download(req, res, params) {
    const track = trackById(params.id);
    if (!track) return json(res, 404, { error: 'Faixa nao encontrada' });

    const url = new URL(req.url, 'http://localhost');
    const format = (url.searchParams.get('format') || 'wav').toLowerCase() === 'mp3' ? 'mp3' : 'wav';
    const prefer = (url.searchParams.get('source') || 'auto').toLowerCase();

    const source = resolveSource(track, prefer);
    if (!source) {
      return json(res, 410, {
        error: 'O audio desta faixa nao esta mais disponivel: o disco do servidor foi recriado e o provider nao devolveu uma URL original. Gere a faixa novamente.',
      });
    }

    const filename = `${track.slug || track.id}.${format}`;

    try {
      // proxy direto: o arquivo remoto ja esta no formato pedido
      if (source.kind === 'remote' && source.format === format) {
        return await sendRemoteProxy(res, source.url, filename, format);
      }

      const { buffer, format: sourceFormat } = await readSource(source);
      const out = await convertAudio(buffer, sourceFormat, format);
      return sendAttachment(res, out, filename, format);
    } catch (err) {
      return json(res, 502, {
        error: `Nao foi possivel baixar o audio: ${err.message}`,
      });
    }
  },

  async audio(req, res, params) {
    const track = trackById(params.id);
    if (!track) return json(res, 404, { error: 'Faixa nao encontrada' });
    const url = new URL(req.url, 'http://localhost');
    const format = (url.searchParams.get('format') || track.format).toLowerCase();
    const download = url.searchParams.get('download') === '1';

    let filePath = track.file ? audioPath(track.file) : null;
    let contentType = track.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    let filename = `${track.slug || track.id}.${track.format}`;

    const localExists = (() => {
      if (!filePath) return false;
      try { return fs.statSync(filePath).isFile(); } catch { return false; }
    })();

    // disco efemero: o arquivo local pode ter sumido (restart/deploy).
    // nesse caso a faixa ainda tem a URL original do provider.
    if (!localExists) {
      const source = resolveSource(track, 'remote');
      if (!source) {
        return json(res, 410, { error: 'Arquivo de audio nao encontrado no disco e sem URL original do provider.' });
      }
      try {
        if (source.kind === 'remote' && source.format === format) {
          return await sendRemoteProxy(res, source.url, filename, source.format, { 'Accept-Ranges': 'none' });
        }
        const { buffer, format: sourceFormat } = await readSource(source);
        const out = await convertAudio(buffer, sourceFormat, format === 'wav' ? 'wav' : 'mp3');
        contentType = format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
        filename = `${track.slug || track.id}.${format}`;
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': out.length,
          'Cache-Control': 'private, max-age=3600',
          ...(download ? { 'Content-Disposition': `attachment; filename="${filename}"` } : {}),
        });
        return res.end(out);
      } catch (err) {
        return json(res, 502, { error: `Nao foi possivel servir o audio: ${err.message}` });
      }
    }

    if (format === 'mp3' && track.format !== 'mp3') {
      if (!mp3Available()) return json(res, 501, { error: 'Encoder MP3 indisponivel neste host.' });
      const cached = path.join(path.dirname(filePath), `${track.id}.mp3`);
      if (!fs.existsSync(cached)) {
        const { decodeWav } = await import('./audio/wav.js');
        const wav = decodeWav(fs.readFileSync(filePath));
        fs.writeFileSync(cached, encodeMp3(wav.channels, wav.sampleRate, 160));
      }
      filePath = cached;
      contentType = 'audio/mpeg';
      filename = `${track.slug || track.id}.mp3`;
    } else if (format === 'wav' && track.format !== 'wav') {
      return json(res, 501, { error: 'Esta faixa veio de um provider remoto e nao possui WAV local.' });
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return json(res, 410, { error: 'Arquivo de audio nao encontrado no disco.' });
    }

    const range = req.headers.range;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (download) {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = match && match[2] ? Number(match[2]) : stat.size - 1;
      if (start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1,
      });
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }

    res.writeHead(200, { 'Content-Length': stat.size });
    return fs.createReadStream(filePath).pipe(res);
  },

  listPlaylists(_req, res) {
    return json(res, 200, { playlists: store.playlists().playlists });
  },

  async createPlaylist(req, res) {
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    if (!name) return json(res, 400, { error: 'Dê um nome à playlist.' });
    const data = store.playlists();
    const playlist = {
      id: newId('pl'),
      name,
      description: String(body.description || '').trim(),
      color: body.color || ['#7c5cff', '#ff5c8a', '#00c2a8', '#ffb020', '#38b6ff'][data.playlists.length % 5],
      trackIds: Array.isArray(body.trackIds) ? body.trackIds : [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    data.playlists.push(playlist);
    store.savePlaylists(data);
    return json(res, 201, { playlist });
  },

  async updatePlaylist(req, res, params) {
    const body = await readJson(req);
    const data = store.playlists();
    const playlist = data.playlists.find((p) => p.id === params.id);
    if (!playlist) return json(res, 404, { error: 'Playlist nao encontrada' });
    if (typeof body.name === 'string' && body.name.trim()) playlist.name = body.name.trim();
    if (typeof body.description === 'string') playlist.description = body.description.trim();
    if (typeof body.color === 'string') playlist.color = body.color;
    if (Array.isArray(body.trackIds)) playlist.trackIds = body.trackIds;
    playlist.updatedAt = Date.now();
    store.savePlaylists(data);
    return json(res, 200, { playlist });
  },

  deletePlaylist(req, res, params) {
    const data = store.playlists();
    const idx = data.playlists.findIndex((p) => p.id === params.id);
    if (idx < 0) return json(res, 404, { error: 'Playlist nao encontrada' });
    data.playlists.splice(idx, 1);
    store.savePlaylists(data);
    return json(res, 200, { ok: true });
  },

  getProfile(_req, res) {
    return json(res, 200, { profile: store.profile() });
  },

  async updateProfile(req, res) {
    const body = await readJson(req);
    const current = store.profile();
    const profile = {
      ...current,
      ...body,
      modelProfile: { ...current.modelProfile, ...(body.modelProfile || {}) },
    };
    store.saveProfile(profile);
    return json(res, 200, { profile });
  },

  explore(_req, res) {
    const lib = store.library();
    const community = lib.tracks.filter((t) => t.isPublic);
    const ideas = loadCommunityIdeas();
    return json(res, 200, { tracks: community.map(publicTrack), ideas });
  },

  share(req, res, params) {
    const track = trackById(params.id);
    if (!track) return json(res, 404, { error: 'Faixa nao encontrada' });
    const url = `${baseUrl(req)}/api/tracks/${track.id}`;
    return json(res, 200, {
      ok: true,
      title: track.title,
      url,
      text: `Ouça "${track.title}" no MusicGPT: ${url}`,
    });
  },
};

function baseUrl(req) {
  const host = req.headers.host || 'localhost';
  return `http://${host}`;
}

function loadCommunityIdeas() {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'community.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('Corpo da requisicao muito grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON invalido'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Converte um valor em booleano.
 *
 * No multipart/form-data todo campo chega como texto: "false" seria
 * verdadeiro com Boolean(), entao as flags sao normalizadas aqui.
 */
function asBool(value) {
  if (typeof value === 'boolean') return value;
  if (value == null) return false;
  const text = String(value).trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'on' || text === 'yes';
}
