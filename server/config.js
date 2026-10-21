import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');

// carrega o .env da raiz do projeto (chaves do OpenRouter, etc.)
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = process.env.MUSICGPT_DATA_DIR || path.join(ROOT, 'data');
export const TRACKS_DIR = path.join(DATA_DIR, 'tracks');

for (const dir of [DATA_DIR, TRACKS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Porta do servidor.
 *
 * O host (Render, Heroku, Docker, ...) injeta process.env.PORT; quando a
 * variavel nao existe ou e invalida, o app usa a porta padrao 8787.
 */
export const DEFAULT_PORT = 8787;

/** Resolve a porta a partir do ambiente (prioridade: process.env.PORT). */
export function resolvePort(value = process.env.PORT) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

export const PORT = resolvePort();
export const HOST = process.env.HOST || '0.0.0.0';

/**
 * Camada de providers. Cada provider sabe transformar um prompt em audio.
 * A selecao e automatica: chaves de API presentes -> provider remoto;
 * caso contrario -> motor local procedural (funciona offline).
 */
export const PROVIDERS = {
  music: {
    mode: process.env.MUSICGPT_MUSIC_PROVIDER || 'auto', // auto | acestep | local | replicate | fal
    replicate: {
      token: process.env.REPLICATE_API_TOKEN || '',
      model: process.env.MUSICGPT_REPLICATE_MODEL || 'minimax/music-01',
      version: process.env.MUSICGPT_REPLICATE_VERSION || '',
    },
    fal: {
      key: process.env.FAL_KEY || '',
      model: process.env.MUSICGPT_FAL_MODEL || 'fal-ai/minimax-music-01',
    },
  },
  lyrics: {
    mode: process.env.MUSICGPT_LYRICS_PROVIDER || 'auto', // auto | local | openrouter
    openai: {
      key: process.env.OPENAI_API_KEY || '',
      model: process.env.MUSICGPT_OPENAI_MODEL || 'gpt-4o-mini',
    },
  },
};

/**
 * ACE-Step 1.5 - API oficial do ACE Music (https://acemusic.ai), gratuita.
 *
 * Endpoint compativel com OpenAI:
 *   POST {baseURL}/chat/completions
 *     -> { model, messages:[{role,content}], thinking, use_format,
 *          sample_mode, audio_config:{duration,format,instrumental,...} }
 *     <- choices[0].message.audio[0].audio_url.url = "data:audio/mpeg;base64,..."
 *
 * `thinking: true` liga o LM 5Hz (gera os codigos semanticos antes do DiT),
 * que e o modo de maior qualidade.
 *
 * Chave: https://acemusic.ai/api-key -> ACESTEP_API_KEY no .env
 */
export const ACESTEP = {
  apiKey: (process.env.ACESTEP_API_KEY || '').trim(),
  baseURL: (process.env.ACESTEP_BASE_URL || 'https://api.acemusic.ai/v1').replace(/\/+$/, ''),
  // vazio = o servidor escolhe o modelo padrao
  model: (process.env.ACESTEP_MODEL || '').trim(),
  // 5Hz LM (qualidade) - ligado por padrao
  thinking: process.env.ACESTEP_THINKING !== '0',
  // vazio = deteccao automatica do idioma do vocal pelo LM
  vocalLanguage: (process.env.ACESTEP_VOCAL_LANGUAGE || '').trim(),
  timeoutMs: Number(process.env.ACESTEP_TIMEOUT_MS || 600000),
  format: 'mp3',
  /**
   * O endpoint hospedado entrega em media 43% da duracao planejada e tem
   * teto de ~100s (medido: 30->13s, 60->26s, 120->51s, 240->102s). Para que
   * a faixa final tenha o tamanho pedido pelo usuario, pedimos ao modelo um
   * pouco mais que o alvo (fator 2,3). Ajuste em ACESTEP_DURATION_FACTOR.
   */
  durationFactor: Number(process.env.ACESTEP_DURATION_FACTOR || 2.3),
  /**
   * Guarda a `audio_url` original (a data URL com o audio em base64) nos
   * metadados da faixa. No deploy na nuvem o disco e efemero e o arquivo
   * some no proximo restart; com a URL original o download continua
   * funcionando. 0 = nao guardar (biblioteca fica leve, mas o download
   * passa a depender do arquivo local).
   */
  keepSourceAudio: process.env.MUSICGPT_KEEP_SOURCE_AUDIO !== '0',
};

/** Valores de exemplo: nao contam como chave configurada. */
const PLACEHOLDER_VALUES = new Set([
  '',
  'sua_chave_aqui',
  'sua-chave-aqui',
  'your_api_key_here',
  'your-api-key',
  'changeme',
  'xxx',
  'sk-xxx',
  'none',
  'null',
  'undefined',
]);

/** O ACE-Step esta pronto para uso? */
export function aceStepAvailable() {
  const key = ACESTEP.apiKey.toLowerCase();
  if (PLACEHOLDER_VALUES.has(key)) return false;
  return key.length >= 12;
}

/**
 * OpenRouter: API compativel com a da OpenAI (chat + TTS).
 * Sem a chave, tudo continua no motor local (fallback).
 *
 * ATENCAO: o fluxo principal de geracao (musica + letra + vocal) NAO depende
 * do OpenRouter - ele usa o ACE-Step. O OpenRouter so aparece em:
 *   - botao "Escrever letra" (endpoint /api/lyrics);
 *   - TTS, se voce escolher explicitamente "Voz por IA (OpenRouter)" na UI.
 *
 * Modelo de TTS padrao: o gratuito (funciona sem credito na conta).
 *   fish-audio/s2.1-pro-free:free  -> testado: HTTP 200, devolve MP3
 *   fish-audio/s2.1-pro            -> variante paga (exige credito)
 *   fish-audio/s2-pro | fish-audio/s1 | hexgrad/Kokoro-82M
 * (openai/gpt-4o-mini-tts e openai/tts-1 NAO existem la: retornam 400)
 */
export const OPENROUTER = {
  apiKey: process.env.OPENROUTER_API_KEY || '',
  baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  lyricsModel: process.env.OPENROUTER_LYRICS_MODEL || 'openai/gpt-4o-mini',
  ttsModel: process.env.OPENROUTER_TTS_MODEL || 'fish-audio/s2.1-pro-free:free',
  ttsVoice: process.env.OPENROUTER_TTS_VOICE || 'alloy',
  // estilo/emotion do Fish Audio: o endpoint aceita mas hoje ignora (ver README)
  ttsStyle: process.env.OPENROUTER_TTS_STYLE || '',
  ttsEmotion: process.env.OPENROUTER_TTS_EMOTION || '',
  // 1 = sintetiza cada secao da letra separadamente (alinha melhor com a musica)
  ttsPerSection: process.env.OPENROUTER_TTS_PER_SECTION !== '0',
  referer: process.env.OPENROUTER_REFERER || 'https://musicgpt.local',
  title: process.env.OPENROUTER_TITLE || 'MusicGPT',
};

export function openRouterAvailable() {
  return Boolean(OPENROUTER.apiKey);
}

export function activeMusicProvider() {
  const { mode, replicate, fal } = PROVIDERS.music;
  if (mode === 'local') return 'local';
  if (mode === 'acestep') return aceStepAvailable() ? 'acestep' : 'local';
  if (mode === 'replicate' && replicate.token) return 'replicate';
  if (mode === 'fal' && fal.key) return 'fal';
  // modo auto: o ACE-Step e o motor padrao (quando ha chave)
  if (aceStepAvailable()) return 'acestep';
  if (replicate.token) return 'replicate';
  if (fal.key) return 'fal';
  return 'local';
}

export function activeLyricsProvider() {
  const { mode, openai } = PROVIDERS.lyrics;
  if (mode === 'local') return 'local';
  if (mode === 'openrouter' && openRouterAvailable()) return 'openrouter';
  if (mode === 'openai' && openai.key) return 'openai';
  if (openRouterAvailable()) return 'openrouter';
  if (openai.key) return 'openai';
  return 'local';
}

/**
 * Provider de letra usado na GERACAO PRINCIPAL.
 *
 * Por padrao e o gerador local (templates), para o fluxo de geracao nao
 * depender de rede extra nem de saldo. Para voltar a usar o OpenRouter
 * nessa etapa: MUSICGPT_LYRICS_PROVIDER=openrouter
 *
 * (o endpoint /api/lyrics, do botao "Escrever letra", usa
 *  activeLyricsProvider() e continua podendo usar o OpenRouter)
 */
export function mainLyricsProvider() {
  const { mode } = PROVIDERS.lyrics;
  if (mode === 'openrouter' && openRouterAvailable()) return 'openrouter';
  if (mode === 'openai' && PROVIDERS.lyrics.openai.key) return 'openai';
  return 'local';
}

/**
 * Provedor de voz: TTS do OpenRouter quando explicitamente ligado, senao a
 * voz procedural. O ACE-Step ja gera o vocal junto com a musica, entao o
 * TTS so entra no motor local (e so se o usuario pedir "Voz por IA").
 *
 * MUSICGPT_TTS_PROVIDER=openrouter  -> religa o TTS em toda faixa
 */
export function activeVoiceProvider() {
  const mode = (process.env.MUSICGPT_TTS_PROVIDER || 'procedural').toLowerCase();
  if (mode === 'openrouter' && openRouterAvailable()) return 'openrouter';
  return 'procedural';
}
