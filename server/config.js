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
    mode: process.env.MUSICGPT_LYRICS_PROVIDER || 'auto', // auto | deepseek | nvidia | openrouter | openai | local
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
  /**
   * Peso do audio de referencia (Audio-to-Audio / Style Transfer) na
   * geracao: 0 = ignora o estilo do arquivo, 1 = segue o audio original
   * de perto. A documentacao do ACE-Step recomenda ~0.2 para transferencia
   * de estilo pura (a musica nova segue a referencia sem ser copia dela).
   */
  referenceStrength: Number(process.env.ACESTEP_REFERENCE_STRENGTH || 0.3),
  /**
   * Peso do audio de origem no modo COVER (`task_type: "cover"`): o modelo
   * tenta manter a melodia e a estrutura do arquivo original. A
   * documentacao do ACE-Step usa 1.0 para um cover colado no original e
   * ~0.2 so para referencia de estilo; o valor alto (0.98) trava a
   * geracao na estrutura original.
   */
  coverStrength: Number(process.env.ACESTEP_COVER_STRENGTH || 0.98),
  /**
   * `cover_noise_strength` do ACE-Step: quanto o audio de origem "ancora" a
   * geracao. A documentacao define 0.0 = ruido puro (sem cover) e 1.0 =
   * mais proximo do audio de origem. Com 0.7 a faixa nasce colada no
   * original (melodia, ritmo e timbre).
   */
  coverNoiseStrength: Number(process.env.ACESTEP_COVER_NOISE_STRENGTH || 0.7),
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

/**
 * DeepSeek: gerador de LETRAS que substitui o gerador local de templates.
 * API compativel com a da OpenAI:
 *   POST https://api.deepseek.com/chat/completions
 *     -> { model: "deepseek-chat", messages, response_format: {type:"json_object"} }
 *     <- choices[0].message.content = '{"letra": "[Verso 1]\\n..."}'
 *
 * Sem chave (ou se a chamada falhar), o fluxo cai no gerador local de
 * templates - o app nunca quebra.
 *
 * Chave: https://platform.deepseek.com -> DEEPSEEK_API_KEY no .env
 * Para forcar/desligar em qualquer cenario: MUSICGPT_LYRICS_PROVIDER
 *   =deepseek (forca) | =local (desliga, so templates) | =openrouter
 */
export const DEEPSEEK = {
  apiKey: (process.env.DEEPSEEK_API_KEY || '').trim(),
  baseURL: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  model: (process.env.DEEPSEEK_MODEL || 'deepseek-chat').trim(),
  timeoutMs: Number(process.env.DEEPSEEK_TIMEOUT_MS || 60000),
};

/** O DeepSeek esta pronto para uso? */
export function deepSeekAvailable() {
  const key = DEEPSEEK.apiKey.toLowerCase();
  if (PLACEHOLDER_VALUES.has(key)) return false;
  return key.length >= 12;
}

/**
 * NVIDIA NIM: provedor de LETRAS SECUNDARIO (fallback do DeepSeek).
 * API compativel com a da OpenAI:
 *   POST https://integrate.api.nvidia.com/v1/chat/completions
 *     -> { model: "openai/gpt-oss-20b", messages }
 *     <- choices[0].message.content = '{"letra": "[Verso 1]\\n..."}'
 *
 * A cadeia de letras ficou: DeepSeek -> NVIDIA NIM -> gerador local de
 * templates. O NVIDIA so entra quando o DeepSeek falha (sem chave, rede,
 * saldo, 5xx) - ou quando e forcado via MUSICGPT_LYRICS_PROVIDER=nvidia.
 *
 * Chave: https://build.nvidia.com -> NVIDIA_API_KEY no .env
 * (ver README 4.1.1: sonda dos modelos Free Endpoint e por que o padrao
 * e o openai/gpt-oss-20b)
 */
export const NVIDIA = {
  apiKey: (process.env.NVIDIA_API_KEY || '').trim(),
  baseURL: (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
  /**
   * Modelo padrao: `openai/gpt-oss-20b` foi o mais rapido da sonda com a
   * task de letra (14,8s vs 41s do MiniMax e 93s do Step-5) e o unico que
   * devolveu JSON valido rapido. Os modelos `meta/llama-3.x-instruct`
   * sairam de circulacao (end of life em 2026-08-26) e os `mistral-large`
   * nao estao habilitados nesta conta (404).
   */
  model: (process.env.NVIDIA_MODEL || 'openai/gpt-oss-20b').trim(),
  /**
   * Timeout generoso: os modelos atuais do NIM sao de raciocinio e levam
   * 20-60s por resposta (medido: 42s com GLM-5.3, 20s com MiniMax). O NIM
   * e o fallback do DeepSeek, entao vale esperar mais um pouco antes de
   * desistir e cair no gerador local.
   */
  timeoutMs: Number(process.env.NVIDIA_TIMEOUT_MS || 120000),
};

/** O NVIDIA NIM esta pronto para uso? */
export function nvidiaAvailable() {
  const key = NVIDIA.apiKey.toLowerCase();
  if (PLACEHOLDER_VALUES.has(key)) return false;
  return key.length >= 12;
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
  if (mode === 'deepseek') return deepSeekAvailable() ? 'deepseek' : 'local';
  if (mode === 'nvidia') return nvidiaAvailable() ? 'nvidia' : 'local';
  if (mode === 'openrouter' && openRouterAvailable()) return 'openrouter';
  if (mode === 'openai' && openai.key) return 'openai';
  // auto: o DeepSeek e o gerador de letras padrao quando ha chave - ele
  // substitui o gerador local de templates (que vira o fallback). O NVIDIA
  // NIM e a segunda opcao da cadeia (e tambem o fallback do DeepSeek).
  if (deepSeekAvailable()) return 'deepseek';
  if (nvidiaAvailable()) return 'nvidia';
  if (openRouterAvailable()) return 'openrouter';
  if (openai.key) return 'openai';
  return 'local';
}

/**
 * Provider de letra usado na GERACAO PRINCIPAL.
 *
 * Por padrao e o DeepSeek (quando ha DEEPSEEK_API_KEY), substituindo o
 * gerador local de templates; sem chave, tudo segue no local (offline).
 * Para escolher outro: MUSICGPT_LYRICS_PROVIDER=openrouter | =local
 *
 * (o endpoint /api/lyrics, do botao "Escrever letra", usa
 *  activeLyricsProvider() e tambem vem ao DeepSeek primeiro no modo auto)
 */
export function mainLyricsProvider() {
  const { mode } = PROVIDERS.lyrics;
  if (mode === 'openrouter' && openRouterAvailable()) return 'openrouter';
  if (mode === 'openai' && PROVIDERS.lyrics.openai.key) return 'openai';
  if (mode === 'nvidia' && nvidiaAvailable()) return 'nvidia';
  if (mode === 'local') return 'local';
  // auto (ou deepseek explicito): DeepSeek substitui o gerador local e, se
  // ele cair, a cadeia do proprio DeepSeek tenta o NVIDIA NIM antes do
  // local. Sem chave do DeepSeek mas com a do NVIDIA, ja entra no NVIDIA.
  if (deepSeekAvailable()) return 'deepseek';
  return nvidiaAvailable() ? 'nvidia' : 'local';
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

/**
 * Configurações de Throttle e Retry para APIs.
 *
 * Throttle: intervalo mínimo entre chamadas consecutivas (evita 429 rate limit).
 * Retry: número de tentativas com backoff exponencial (recupera de erros temporários).
 */
export const RATE_LIMIT = {
  nvidia: {
    throttleMs: Number(process.env.NVIDIA_THROTTLE_MS || 2000), // 2s entre chamadas
    maxRetries: Number(process.env.NVIDIA_MAX_RETRIES || 3), // até 3 tentativas
    initialRetryDelay: Number(process.env.NVIDIA_RETRY_DELAY || 2000), // 2s, 4s, 8s...
    maxRetryDelay: Number(process.env.NVIDIA_MAX_RETRY_DELAY || 16000), // máx 16s
  },
  deepseek: {
    throttleMs: Number(process.env.DEEPSEEK_THROTTLE_MS || 1000), // 1s entre chamadas
    maxRetries: Number(process.env.DEEPSEEK_MAX_RETRIES || 3),
    initialRetryDelay: Number(process.env.DEEPSEEK_RETRY_DELAY || 2000),
    maxRetryDelay: Number(process.env.DEEPSEEK_MAX_RETRY_DELAY || 16000),
  },
};
