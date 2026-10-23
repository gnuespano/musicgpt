/**
 * Provider de letras.
 * - deepseek:  chat completions na API da DeepSeek (gerador padrao com chave)
 * - openrouter: chat completions via SDK da OpenAI apontado para o OpenRouter
 * - openai:     chat completions na API da OpenAI
 * - local:      gerador template-based (offline)
 *
 * Sem chave - ou se a chamada falhar - cai no gerador local: o app nunca
 * quebra. O DeepSeek substitui o gerador local de templates quando ha
 * DEEPSEEK_API_KEY (MUSICGPT_LYRICS_PROVIDER=local desliga, =openrouter
 * volta ao OpenRouter).
 *
 * O fluxo principal de geracao usa `mainLyricsProvider()` e o botao
 * "Escrever letra" (/api/lyrics) usa `activeLyricsProvider()`; nos dois o
 * DeepSeek vem primeiro no modo auto.
 */

import OpenAI from 'openai';
import { generateLyrics } from '../lyrics.js';
import {
  DEEPSEEK,
  OPENROUTER,
  PROVIDERS,
  activeLyricsProvider,
  deepSeekAvailable,
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
 * Gera letra com o DeepSeek (`POST /chat/completions`, modelo deepseek-chat,
 * response_format json_object) e extrai so a letra do JSON.
 *
 * Aceita tanto `generateLyricsDeepSeek('meu tema')` quanto o objeto opts do
 * gerador local (`{ prompt, lang, style, seed, mode, context }`).
 *
 * Sem DEEPSEEK_API_KEY, com tema vazio ou se a chamada falhar (rede, saldo,
 * 4xx/5xx, JSON invalido), cai NO GERADOR LOCAL de templates - o app nunca
 * quebra. O resultado local vem com `engine: 'local-templates'`.
 */
export async function generateLyricsDeepSeek(temaOuOpts = {}, extra = {}) {
  const opts = typeof temaOuOpts === 'string'
    ? { ...extra, prompt: temaOuOpts }
    : { ...temaOuOpts };
  const tema = String(opts.prompt || '').trim();

  if (!deepSeekAvailable()) {
    return localFallback(opts, 'DEEPSEEK_API_KEY ausente');
  }
  if (!tema) {
    // sem tema nao ha o que o modelo expandir: o local resolve (e e offline)
    return localFallback(opts, 'tema vazio');
  }

  log(`pedindo letra ao DeepSeek (${DEEPSEEK.model}): "${tema.slice(0, 60)}"`);
  try {
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
    // defensivo: mesmo com json_object, remove cercas ```json se aparecerem
    const data = JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));

    if (opts.mode === 'next') {
      const linha = String(data.linha || data.line || '').trim()
        || content.split('\n').map((l) => l.trim()).find(Boolean) || '';
      if (!linha) throw new Error('DeepSeek nao retornou a proxima linha');
      log(`DeepSeek devolveu a proxima linha ("${linha.slice(0, 40)}")`);
      return { line: linha, engine: 'deepseek', model: DEEPSEEK.model };
    }

    const letra = String(data.letra || data.lyrics || '').trim();
    if (!letra) throw new Error('DeepSeek nao retornou a letra no JSON');
    log(`DeepSeek devolveu a letra (${letra.length} chars)`);
    return { text: cleanLyric(letra), engine: 'deepseek', model: DEEPSEEK.model };
  } catch (err) {
    return localFallback(opts, err.message);
  }
}

/** Fallback offline: o gerador local de templates assume. */
function localFallback(opts, motivo) {
  const curto = String(motivo || '').split('\n')[0].slice(0, 120);
  log(`DeepSeek fora (${curto}) -> gerador local de templates`);
  const local = generateLyrics(opts);
  return { ...local, engine: 'local-templates', fallback: curto };
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
