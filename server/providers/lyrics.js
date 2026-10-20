/**
 * Provider de letras.
 * - openrouter: chat completions via SDK da OpenAI apontado para o OpenRouter
 * - openai:     chat completions na API da OpenAI
 * - local:      gerador template-based (offline)
 *
 * Sem chave, cai no gerador local — o app nunca quebra.
 *
 * O fluxo principal de geracao usa `mainLyricsProvider()` (por padrao o
 * gerador local, sem depender do OpenRouter). O botao "Escrever letra"
 * (/api/lyrics) usa `activeLyricsProvider()` e pode usar o OpenRouter.
 */

import OpenAI from 'openai';
import { generateLyrics } from '../lyrics.js';
import { OPENROUTER, PROVIDERS, activeLyricsProvider, openRouterAvailable } from '../config.js';

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
