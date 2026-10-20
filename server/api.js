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
import { aceStepStatus } from './providers/acestep.js';
import { generateLyrics as generateLocalLyrics } from './lyrics.js';
import { voiceOver, resolveTtsVoice } from './audio/voice.js';
import { detectGenre, detectMood, MAX_DURATION_SEC } from './audio/render.js';
import { encodeMp3, mp3Available } from './audio/mp3.js';
import { mp3Duration, wavDuration } from './audio/remote.js';

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

async function executeJob(job, options) {
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

    if (provider === 'acestep') {
      // O ACE-Step gera a musica E o vocal (com a letra). Quando o usuario
      // nao manda uma letra, o proprio LM 5Hz escreve uma - sem depender do
      // OpenRouter (nem de rede extra).
      lyricsEngine = options.instrumental ? null : (lyrics ? 'user' : 'acestep-lm');
    } else if (!options.instrumental && !lyrics) {
      try {
        const res = await generateLyricsWithProvider({
          prompt: options.prompt,
          lang: options.lang,
          style: options.style,
          seed: options.seed,
        }, mainLyricsProvider());
        lyrics = res.text;
        lyricsEngine = res.engine;
      } catch (err) {
        // fallback: gerador local de letras
        const local = generateLocalLyrics({
          prompt: options.prompt,
          lang: options.lang,
          style: options.style,
          seed: options.seed,
        });
        lyrics = local.text;
        lyricsEngine = 'local-templates';
        warnings.push(`Letra via IA indisponível (${err.message}). Usado o gerador local.`);
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
        result = await generateMusic({ ...options, lyrics, trackId }, (p) => {
          emit({ stage: p.stage, progress: Math.min(92, 10 + Math.round((p.pct || 0) * 0.82)), detail: p.detail });
        });
        if (!result.peaks) result.peaks = null;
      } catch (err) {
        // o provedor remoto falhou (cota, rede, chave): seguimos com o motor
        // procedural local para nao perder a geracao
        emit({ stage: 'motor local', progress: 90, detail: `provedor falhou (${err.message})` });
        warnings.push(`Provedor remoto indisponível (${err.message}). Usado o motor procedural local.`);
        if (!options.instrumental && !lyrics) {
          // o motor local precisa de uma letra para cantar
          const local = generateLocalLyrics({
            prompt: options.prompt,
            lang: options.lang,
            style: options.style,
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
      style: options.style,
      instrumental: Boolean(options.instrumental),
      lyrics: finalLyrics,
      lyricsEngine: lyricsEngine || result.meta?.lyricsEngine || null,
      duration: Math.round(duration * 100) / 100,
      bpm: result.meta?.bpm ?? GENRES[options.genre]?.bpm ?? null,
      key: result.meta?.key ?? null,
      structure: result.meta?.structure ?? [],
      vocals: result.meta?.vocals ?? [],
      melody: result.meta?.melody ?? [],
      voice: options.voiceStyle || result.meta?.voice || null,
      voiceInfo,
      warnings,
      lofi: Boolean(options.lofi),
      engine: result.meta?.engine || effectiveProvider,
      provider: effectiveProvider,
      format,
      file: relative,
      peaks: result.peaks || [],
      tags: [options.genreLabel, options.moodLabel, options.lofi ? 'chuva' : null].filter(Boolean),
      createdAt: now,
      plays: 0,
      likes: 0,
      isPublic: false,
    };

    const lib = store.library();
    lib.tracks.unshift(track);
    store.saveLibrary(lib);

    emit({ status: 'done', progress: 100, stage: 'pronto', track });
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

  async generate(req, res) {
    const body = await readJson(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt && !body.lyrics) {
      return json(res, 400, { error: 'Descreva a musica que voce quer criar.' });
    }
    // quando o cliente nao informa um genero/clima explicito, detectamos pelo prompt
    const genreKey = body.genre && GENRES[body.genre] ? body.genre : detectGenre(prompt);
    const genre = GENRES[genreKey];
    const moodKey = body.mood && MOODS[body.mood] ? body.mood : detectMood(prompt);
    const options = {
      prompt,
      title: body.title,
      genre: genreKey,
      genreLabel: genre.label,
      mood: moodKey,
      moodLabel: moodKey,
      style: body.style || genre.label,
      instrumental: Boolean(body.instrumental),
      duration: Math.min(MAX_DURATION_SEC, Math.max(20, Number(body.duration) || 75)),
      voiceStyle: VOICE_STYLES[body.voiceStyle] ? body.voiceStyle : genre.vocal,
      lofi: Boolean(body.lofi),
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
    setTimeout(() => executeJob(job, options), 10);
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

  async lyrics(req, res) {
    const body = await readJson(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return json(res, 400, { error: 'Informe o tema da letra.' });
    try {
      const result = await generateLyricsWithProvider({
        prompt,
        lang: body.lang === 'en' ? 'en' : 'pt',
        style: body.style,
        mode: body.mode === 'next' ? 'next' : 'full',
        context: Array.isArray(body.context) ? body.context : [],
        seed: body.seed,
      });
      if (body.mode === 'next') {
        const line = result.line || result.text || '';
        return json(res, 200, { line, theme: result.theme, engine: result.engine });
      }
      return json(res, 200, result);
    } catch (error) {
      return json(res, 502, { error: `Falha ao gerar letra: ${error.message}` });
    }
  },

  listTracks(_req, res) {
    const lib = store.library();
    return json(res, 200, { tracks: lib.tracks });
  },

  getTrack(req, res, params) {
    const track = trackById(params.id);
    if (!track) return json(res, 404, { error: 'Faixa nao encontrada' });
    return json(res, 200, { track });
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
   * GET /api/download/:id
   * Envia o audio gerado como arquivo WAV para download (Content-Disposition:
   * attachment). O master em disco e exatamente o buffer gerado pelo motor de
   * sintese, entao o arquivo baixado e a faixa original, sem re-encode.
   */
  downloadWav(req, res, params) {
    const track = trackById(params.id);
    if (!track) return json(res, 404, { error: 'Faixa nao encontrada' });

    if (track.format !== 'wav') {
      return json(res, 409, {
        error: 'Esta faixa veio de um provider remoto e nao possui WAV local. Use o download em MP3.',
      });
    }

    const filePath = audioPath(track.file);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return json(res, 410, { error: 'Arquivo de audio nao encontrado no disco.' });
    }

    const rawName = `${track.slug || track.id}.wav`;
    const asciiName = rawName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    const encoded = encodeURIComponent(rawName);

    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'X-Track-Id': track.id,
    });
    return fs.createReadStream(filePath).pipe(res);
  },

  async audio(req, res, params) {
    const track = trackById(params.id);
    if (!track) return json(res, 404, { error: 'Faixa nao encontrada' });
    const url = new URL(req.url, 'http://localhost');
    const format = (url.searchParams.get('format') || track.format).toLowerCase();
    const download = url.searchParams.get('download') === '1';

    let filePath = audioPath(track.file);
    let contentType = track.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    let filename = `${track.slug || track.id}.${track.format}`;

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
    return json(res, 200, { tracks: community, ideas });
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
