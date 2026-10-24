/**
 * Provider de letras.
 * - deepseek:  chat completions na API da DeepSeek (gerador padrao com chave)
 * - nvidia:    chat completions na API do NVIDIA NIM (fallback do DeepSeek)
 * - openrouter: chat completions via SDK da OpenAI apontado para o OpenRouter
 * - openai:     chat completions na API da OpenAI
 * - local:      gerador template-based (offline)
 *
 * Sem chave - ou se a chamada falhar - cai no proximo da cadeia: o app
 * nunca quebra. A cadeia de letras e DeepSeek -> NVIDIA NIM -> local; o
 * DeepSeek substitui o gerador local de templates quando ha
 * DEEPSEEK_API_KEY (MUSICGPT_LYRICS_PROVIDER=local desliga, =nvidia forca
 * o NIM, =openrouter volta ao OpenRouter).
 *
 * O fluxo principal de geracao usa `mainLyricsProvider()` e o botao
 * "Escrever letra" (/api/lyrics) usa `activeLyricsProvider()`; nos dois o
 * DeepSeek vem primeiro no modo auto.
 */

import OpenAI from 'openai';
import { generateLyrics } from '../lyrics.js';
import {
  DEEPSEEK,
  NVIDIA,
  OPENROUTER,
  PROVIDERS,
  activeLyricsProvider,
  deepSeekAvailable,
  nvidiaAvailable,
  openRouterAvailable,
} from '../config.js';

const SYSTEM_PROMPT = `Voce e um compositor e letrista profissional.
Escreva uma letra ORIGINAL (nao copie nem imite artistas existentes) com:
- metrica regular e ritmo confortavel de cantar;
- rimas consistentes dentro de cada estrofe e um refrao com rima forte;
- imagens concretas, sem cliches vazios;
- tags estruturais em ingles e na ordem: [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Chorus], [Bridge], [Chorus], [Outro];
- 4 linhas por verso, 2 no Pre-Chorus e na Bridge, 4 no refrão;
- o refrão se repete de forma identica (a mesma letra);
- nada antes ou depois da letra: sem titulo, sem explicacao, sem aspas envolventes.`;

let cachedClient = null;
function clientFor(baseURL, apiKey) {
  if (cachedClient && cachedClient.baseURL === baseURL) return cachedClient.client;
  const client = new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: {
      'HTTP-Referer': OPENROUTER.referer,
      'X-Title': OPENROUTER.title,
    },
  });
  cachedClient = { baseURL, client };
  return client;
}

function buildUserPrompt(opts) {
  const lang = opts.lang === 'en' ? 'English' : 'portugues do Brasil';
  const genre = opts.style || opts.genreLabel || 'pop';
  const mood = opts.moodLabel || 'alegre';
  const base = `Ideia/tema do usuario: "${opts.prompt}"\n`
    + `Genero: ${genre}. Clima: ${mood}. Idioma: ${lang}.\n`
    + 'Escreva a letra completa seguindo as regras.';

  if (opts.mode === 'next') {
    const ctx = (opts.context || []).filter(Boolean).slice(-6).join(' | ');
    return `${base}\n\nLinhas ja escritas (para manter o tom): ${ctx || '(nenhuma)'}\n`
      + 'Agora escreva APENAS a proxima linha (uma unica linha de verso, sem tag e sem aspas).';
  }
  return base;
}

export async function generateLyricsWithProvider(opts = {}, provider = activeLyricsProvider()) {
  if (provider === 'deepseek') return generateLyricsDeepSeek(opts);
  if (provider === 'nvidia') return generateLyricsNvidia(opts);
  if (provider === 'openrouter') return generateWithOpenRouter(opts);
  if (provider === 'openai') return generateWithOpenAI(opts);
  const result = generateLyrics(opts);
  return {
    text: result.text,
    line: result.line,
    theme: result.theme,
    engine: 'local-templates',
  };
}

/* ---------------- DeepSeek (gerador padrao com chave) ---------------- */

/** Log visivel no console do servidor (server.log) para acompanhar as chamadas. */
function log(msg) {
  console.log(`[letras] ${msg}`);
}

/**
 * System prompt do DeepSeek: compositor brasileiro, letra completa em
 * portugues do Brasil com estrutura de [Verso]/[Refrao], devolvida como
 * JSON (a API exige a palavra "json" no prompt para ligar o JSON mode).
 *
 * e o MESMO system prompt usado pelo NVIDIA NIM (fallback, ver 4.1.1).
 */
const SYSTEM_PROMPT_DEEPSEEK = 'Voce e um compositor e letrista brasileiro premiado, '
  + 'especialista em pop, MPB e sertanejo.\n'
  + 'Escreva uma letra ORIGINAL em portugues do Brasil (nao copie nem imite artistas existentes), '
  + 'com estrutura de musica de verdade:\n'
  + '- tags de secao na ordem: [Verso 1], [Refrao], [Verso 2], [Refrao] (e opcionalmente [Ponte]);\n'
  + '- metrica regular e ritmo confortavel de cantar;\n'
  + '- rimas consistentes dentro de cada estrofe e um refrao com rima forte, que se repete identico;\n'
  + '- imagens concretas, sem cliches vazios;\n'
  + '- a letra deve seguir o tema/ideia pedido pelo usuario.\n'
  + 'Responda SOMENTE com um objeto JSON no formato {"letra": "..."} em que "letra" e a letra '
  + 'inteira, com as tags de secao e as quebras de linha. Nada fora do JSON.';

/** Prompt do usuario (tema + estilo) + instrucao do formato de saida. */
function buildDeepSeekUserPrompt(opts) {
  const base = buildUserPrompt(opts);
  if (opts.mode === 'next') {
    return `${base}\n\nResponda SOMENTE com JSON no formato {"linha": "a proxima linha da letra"}.`;
  }
  return `${base}\n\nResponda SOMENTE com JSON no formato {"letra": "a letra completa"}.`;
}

/**
 * Extrai a letra (ou a proxima linha) da resposta de um LLM em JSON mode.
 * Defensivo: mesmo vindo com cerca ```json, ou fora do JSON (alguns modelos
 * do NIM ignoram o formato e devolvem a letra solta), ainda assim funciona.
 */
function parseLyricPayload(content, modo) {
  const semCerca = String(content).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data = {};
  try { data = JSON.parse(semCerca); } catch { data = {}; }

  if (modo === 'next') {
    const linha = String(data.linha || data.line || '').trim()
      || semCerca.split('\n').map((l) => l.trim().replace(/^["'`]+|["'`]+$/g, '')).find(Boolean) || '';
    return { linha };
  }
  const letra = String(data.letra || data.lyrics || '').trim() || semCerca.trim();
  return { letra };
}

/**
 * Chamada crua ao DeepSeek (`POST /chat/completions`, modelo deepseek-chat,
 * response_format json_object). LANCA ERRO quando falha (rede, saldo, 4xx/
 * 5xx, JSON invalido) - quem decide o fallback e a cadeia chamadora.
 */
async function callDeepSeek(opts, tema) {
  log(`pedindo letra ao DeepSeek (${DEEPSEEK.model}): "${tema.slice(0, 60)}"`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEEPSEEK.timeoutMs);
  let res;
  try {
    res = await fetch(`${DEEPSEEK.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK.apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT_DEEPSEEK },
          { role: 'user', content: buildDeepSeekUserPrompt(opts) },
        ],
        // JSON mode: a resposta vem como objeto JSON puro (sem cercas de codigo)
        response_format: { type: 'json_object' },
        temperature: 0.9,
        max_tokens: 900,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* resposta nao-JSON tratada como erro abaixo */ }
  if (!res.ok) {
    const motivo = payload?.error?.message || payload?.message || raw.slice(0, 200);
    throw new Error(`DeepSeek respondeu ${res.status}: ${motivo}`);
  }

  const content = String(payload?.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('DeepSeek nao retornou conteudo');

  if (opts.mode === 'next') {
    const { linha } = parseLyricPayload(content, 'next');
    if (!linha) throw new Error('DeepSeek nao retornou a proxima linha');
    log(`DeepSeek devolveu a proxima linha ("${linha.slice(0, 40)}")`);
    return { line: linha, engine: 'deepseek', model: DEEPSEEK.model };
  }

  const { letra } = parseLyricPayload(content, 'full');
  if (!letra) throw new Error('DeepSeek nao retornou a letra no JSON');
  log(`DeepSeek devolveu a letra (${letra.length} chars)`);
  return { text: cleanLyric(letra), engine: 'deepseek', model: DEEPSEEK.model };
}

/**
 * Gera letra com o DeepSeek, com CADEIA DE FALLBACK:
 *   DeepSeek -> NVIDIA NIM -> gerador local de templates.
 *
 * Aceita tanto `generateLyricsDeepSeek('meu tema')` quanto o objeto opts do
 * gerador local (`{ prompt, lang, style, seed, mode, context }`).
 *
 * Se o DeepSeek falhar (sem chave, rede, saldo, 4xx/5xx, JSON invalido), o
 * NVIDIA NIM assume quando ha NVIDIA_API_KEY; se tambem faltar ou falhar,
 * cai NO GERADOR LOCAL de templates - o app nunca quebra. O resultado vem
 * com `engine` indicando quem escreveu ('deepseek' | 'nvidia' |
 * 'local-templates') e, no fallback, `fallback` com o(s) motivo(s).
 */
export async function generateLyricsDeepSeek(temaOuOpts = {}, extra = {}) {
  const opts = typeof temaOuOpts === 'string'
    ? { ...extra, prompt: temaOuOpts }
    : { ...temaOuOpts };
  const tema = String(opts.prompt || '').trim();
  const motivos = [];

  if (!tema) {
    // sem tema nao ha o que o modelo expandir: o local resolve (e e offline)
    return localFallback(opts, 'tema vazio');
  }

  if (deepSeekAvailable()) {
    try {
      return await callDeepSeek(opts, tema);
    } catch (err) {
      motivos.push(`DeepSeek: ${primeiraLinha(err.message)}`);
      log(`DeepSeek fora (${motivos[motivos.length - 1]}) -> tentando o NVIDIA NIM`);
    }
  } else {
    motivos.push('DeepSeek: DEEPSEEK_API_KEY ausente');
  }

  // fallback secundario: NVIDIA NIM (mesmo prompt, ver 4.1.1)
  if (nvidiaAvailable()) {
    try {
      return await callNvidia(opts, tema);
    } catch (err) {
      motivos.push(`NVIDIA: ${primeiraLinha(err.message)}`);
      log(`NVIDIA fora (${motivos[motivos.length - 1]}) -> gerador local de templates`);
    }
  } else {
    motivos.push('NVIDIA: NVIDIA_API_KEY ausente');
  }

  return localFallback(opts, motivos.join(' | '));
}

/** So a 1a linha, curta: o toast nao aguenta a resposta inteira da API. */
function primeiraLinha(msg) {
  return String(msg || '').split('\n')[0].slice(0, 120);
}

/** Fallback offline: o gerador local de templates assume. */
function localFallback(opts, motivo) {
  const curto = primeiraLinha(motivo);
  log(`provedores de IA fora (${curto}) -> gerador local de templates`);
  const local = generateLyrics(opts);
  return { ...local, engine: 'local-templates', fallback: curto };
}

/* ---------------- NVIDIA NIM (fallback do DeepSeek) ---------------- */

/**
 * Chamada crua ao NVIDIA NIM (`POST /v1/chat/completions` da
 * integrate.api.nvidia.com), MESMO system prompt do DeepSeek (compositor
 * brasileiro, [Verso]/[Refrao], saida em JSON). Sem response_format: nem
 * todo modelo do NIM aceita JSON mode, entao o parser e defensivo (ver
 * parseLyricPayload). LANCA ERRO quando falha.
 */
async function callNvidia(opts, tema) {
  log(`pedindo letra ao NVIDIA NIM (${NVIDIA.model}): "${tema.slice(0, 60)}"`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NVIDIA.timeoutMs);
  let res;
  try {
    res = await fetch(`${NVIDIA.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${NVIDIA.apiKey}`,
      },
      body: JSON.stringify({
        model: NVIDIA.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT_DEEPSEEK },
          { role: 'user', content: buildDeepSeekUserPrompt(opts) },
        ],
        temperature: 0.9,
        // reserva para os modelos de raciocinio do NIM: eles gastam tokens
        // no reasoning_content ANTES do conteudo - com 900 o content vinha
        // null e a letra se perdia no meio do raciocinio.
        max_tokens: Number(process.env.NVIDIA_MAX_TOKENS || 2500),
        // 'low' derruba o raciocinio de ~1600 chars para ~48 (medido), sem
        // estourar os 2500 de max_tokens. Sem isso o gpt-oss-20b as vezes
        // devolve SO reasoning_content e cai no gerador local.
        // ('minimal' nao e aceito pela API; aceitos: low | medium | high)
        reasoning_effort: (process.env.NVIDIA_REASONING_EFFORT || 'low').trim(),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* resposta nao-JSON tratada como erro abaixo */ }
  if (!res.ok) {
    const motivo = payload?.error?.message || payload?.message || raw.slice(0, 200);
    throw new Error(`NVIDIA respondeu ${res.status}: ${motivo}`);
  }

  const msg = payload?.choices?.[0]?.message || {};
  const content = String(msg.content || '').trim();
  if (!content) {
    // modelo de raciocinio que estourou o budget: so veio reasoning_content
    const raciocinio = String(msg.reasoning_content || '').trim();
    if (raciocinio) {
      throw new Error('NVIDIA so devolveu raciocinio, sem conteudo '
        + '(aumente NVIDIA_MAX_TOKENS ou tire o NVIDIA_REASONING_EFFORT)');
    }
    const finish = payload?.choices?.[0]?.finish_reason || 'desconhecido';
    throw new Error(`NVIDIA nao retornou conteudo (finish_reason: ${finish})`);
  }

  if (opts.mode === 'next') {
    const { linha } = parseLyricPayload(content, 'next');
    if (!linha) throw new Error('NVIDIA nao retornou a proxima linha');
    log(`NVIDIA devolveu a proxima linha ("${linha.slice(0, 40)}")`);
    return { line: linha, engine: 'nvidia', model: NVIDIA.model };
  }

  const { letra } = parseLyricPayload(content, 'full');
  if (!letra) throw new Error('NVIDIA nao retornou a letra');
  log(`NVIDIA devolveu a letra (${letra.length} chars)`);
  return { text: cleanLyric(letra), engine: 'nvidia', model: NVIDIA.model };
}

/**
 * Gera letra direto no NVIDIA NIM (provedor `nvidia`), com fallback no
 * gerador local. Aceita string (tema) ou opts, igual ao DeepSeek.
 *
 * No fluxo normal quem chama e a cadeia do generateLyricsDeepSeek (DeepSeek
 * primeiro); use essa funcao quando quiser FORCAR o NVIDIA
 * (MUSICGPT_LYRICS_PROVIDER=nvidia).
 */
export async function generateLyricsNvidia(temaOuOpts = {}, extra = {}) {
  const opts = typeof temaOuOpts === 'string'
    ? { ...extra, prompt: temaOuOpts }
    : { ...temaOuOpts };
  const tema = String(opts.prompt || '').trim();

  if (!nvidiaAvailable()) {
    return localFallback(opts, 'NVIDIA: NVIDIA_API_KEY ausente');
  }
  if (!tema) {
    return localFallback(opts, 'tema vazio');
  }
  try {
    return await callNvidia(opts, tema);
  } catch (err) {
    return localFallback(opts, `NVIDIA: ${primeiraLinha(err.message)}`);
  }
}

/* ---------------- OpenRouter ---------------- */

async function generateWithOpenRouter(opts) {
  if (!openRouterAvailable()) throw new Error('OPENROUTER_API_KEY ausente');
  const client = clientFor(OPENROUTER.baseURL, OPENROUTER.apiKey);

  const completion = await client.chat.completions.create({
    model: OPENROUTER.lyricsModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(opts) },
    ],
    temperature: 0.9,
    max_tokens: 900,
  });

  const text = completion?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenRouter nao retornou letra');

  if (opts.mode === 'next') {
    const line = text.split('\n').map((l) => l.replace(/^["'`\s]+|["'`\s]+$/g, '')).find((l) => l.trim().length > 0) || text;
    return { line: line.trim(), engine: 'openrouter', model: OPENROUTER.lyricsModel };
  }
  return { text: cleanLyric(text), engine: 'openrouter', model: OPENROUTER.lyricsModel };
}

/* ---------------- OpenAI (direto) ---------------- */

async function generateWithOpenAI(opts) {
  const { key, model } = PROVIDERS.lyrics.openai;
  if (!key) throw new Error('OPENAI_API_KEY ausente');
  const client = clientFor('https://api.openai.com/v1', key);
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(opts) },
    ],
    temperature: 0.9,
  });
  const text = completion?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI nao retornou letra');
  if (opts.mode === 'next') {
    const line = text.split('\n').find((l) => l.trim().length > 0) || text;
    return { line: line.trim(), engine: 'openai', model };
  }
  return { text: cleanLyric(text), engine: 'openai', model };
}

/** Remove cabecalhos/marcacoes que o modelo possa ter acrescentado. */
export function cleanLyric(text) {
  return String(text)
    .replace(/^```[a-z]*$/gim, '')
    .replace(/^(letra|lyric|titulo|título)\s*:.*$/gim, '')
    .trim();
}
