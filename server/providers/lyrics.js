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
  GROQ,
  OPENROUTER,
  PROVIDERS,
  RATE_LIMIT,
  activeLyricsProvider,
  deepSeekAvailable,
  nvidiaAvailable,
  groqAvailable,
  openRouterAvailable,
} from '../config.js';

export const LOCAL_STYLE_EXPANSION_DICT = new Map([
  ['mpb', 'MPB melancolica com violao, pandeiro e saxofone ao fundo, ritmo moderado, voz sentimental'],
  ['trap', 'Trap pesado com 808 grave, hi-hats rapidos e sintetizadores escuros, BPM 140, voz arrastada'],
  ['pop', 'Pop dançante com sintetizadores brilhantes e refrao chiclete, BPM 128, voz clara e dominante'],
  ['rock', 'Rock energetico com guitarra distorcida e bateria pesada, BPM 130, voz potente e distorcida'],
  ['sertanejo', 'Sertanejo universitario com viola, sanfona e batida em dois, BPM 90, vocal emotivo'],
  ['forro', 'Forro animado com sanfona, zabumba e triangulo, BPM 110, vocal animado e danceable'],
  ['samba', 'Samba de roda animado com pandeiro, cavaquinho e surdo no refrão, BPM 100, voce classica'],
  ['lofi', 'Lo-fi chill com piano suave, chuva de fundo e textura de vinil, BPM 70, instrumental relax'],
  ['house', 'House club com kick de quatro tempos, hi-hat e sintetizador pulsante, BPM 125, vocal elegante'],
  ['gospel', 'Gospel soul com coro, piano e dinamica crescente no refrão, BPM 80, voz poderosa'],
  ['jazz', 'Jazz de madrugada com piano, contrabaixo e saxofone quente, BPM 60, vocal suave'],
  ['ambient', 'Ambient etereo com pads atmosfericos e texturas flutuantes, BPM 60, instrumental imersivo'],
  ['reaggaeton', 'Reaggaeton com dembow suave, sintetizadores escuros e reggae influence, BPM 108, voz sedutora'],
  ['baile', 'Funk de baile com tamborzão, grave 808 e MC fazendo bordao, BPM 135, vocal gritado'],
  ['disco', 'Disco music com guitarra funky, secao de metais brilhante e ritmo disco, BPM 120, vocal suave'],
  ['soul', 'Soul groovy com baixo encorpado, Rhodes e grooves relaxados, BPM 95, vocal emotivo'],
]);
const SYSTEM_PROMPT = `Voce e um compositor e letrista profissional.

  ['mpb', 'MPB melancolica com violao, pandeiro e saxofone ao fundo, ritmo moderado, voz sentimental'],
  ['trap', 'Trap pesado com 808 grave, hi-hats rapidos e sintetizadores escuros, BPM 140, voz arrastada'],
  ['pop', 'Pop dançante com sintetizadores brilhantes e refrao chiclete, BPM 128, voz clara e dominante'],
  ['rock', 'Rock energetico com guitarra distorcida e bateria pesada, BPM 130, voz potente e distorcida'],
  ['sertanejo', 'Sertanejo universitario com viola, sanfona e batida em dois, BPM 90, vocal emotivo'],
  ['forro', 'Forro animado com sanfona, zabumba e triangulo, BPM 110, vocal animado e danceable'],
  ['samba', 'Samba de roda animado com pandeiro, cavaquinho e surdo no refrão, BPM 100, voce classica'],
  ['lofi', 'Lo-fi chill com piano suave, chuva de fundo e textura de vinil, BPM 70, instrumental relax'],
  ['house', 'House club com kick de quatro tempos, hi-hat e sintetizador pulsante, BPM 125, vocal elegante'],
  ['gospel', 'Gospel soul com coro, piano e dinamica crescente no refrão, BPM 80, voz poderosa'],
  ['jazz', 'Jazz de madrugada com piano, contrabaixo e saxofone quente, BPM 60, vocal suave'],
  ['ambient', 'Ambient etereo com pads atmosfericos e texturas flutuantes, BPM 60, instrumental imersivo'],
  ['reaggaeton', 'Reaggaeton com dembow suave, sintetizadores escuros e reggae influence, BPM 108, voz sedutora'],
  ['baile', 'Funk de baile com tamborzão, grave 808 e MC fazendo bordao, BPM 135, vocal gritado'],
  ['disco', 'Disco music com guitarra funky, secao de metais brilhante e ritmo disco, BPM 120, vocal suave'],
  ['soul', 'Soul groovy com baixo encorpado, Rhodes e grooves relaxados, BPM 95, vocal emotivo'],
]);Escreva uma letra ORIGINAL (nao copie nem imite artistas existentes) com:
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
      await throttle('deepseek');
      return await retryWithBackoff(() => callDeepSeek(opts, tema), 'deepseek');
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
      await throttle('nvidia');
      return await retryWithBackoff(() => callNvidia(opts, tema), 'nvidia');
    } catch (err) {
      motivos.push(`NVIDIA: ${primeiraLinha(err.message)}`);
      log(`NVIDIA fora (${motivos[motivos.length - 1]}) -> tentando o Groq`);
    }
  } else {
    motivos.push('NVIDIA: NVIDIA_API_KEY ausente');
  }

  // fallback tercario: Groq
  if (groqAvailable()) {
    try {
      await throttle('groq');
      return await retryWithBackoff(() => callGroq(opts, tema), 'groq');
    } catch (err) {
      motivos.push(`Groq: ${primeiraLinha(err.message)}`);
      log(`Groq fora (${motivos[motivos.length - 1]}) -> gerador local de templates`);
    }
  } else {
    motivos.push('Groq: GROQ_API_KEY ausente');
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
    await throttle('nvidia');
    return await retryWithBackoff(() => callNvidia(opts, tema), 'nvidia');
  } catch (err) {
    return localFallback(opts, `NVIDIA: ${primeiraLinha(err.message)}`);
  }
}

/* ---------------- Groq (fallback tercario) ---------------- */

 /**
  * Chamada crua ao Groq (`POST /chat/completions` da API do Groq, modelo
  * llama3-groq-70b-8192-text-spec ou o definido em GROQ_MODEL). A API do Groq
  * e compativel com OpenAI: usa Authorization: Bearer e o mesmo payload de
  * mensagens. O system prompt e o MESMO do DeepSeek e NVIDIA (ver 4.1.1 e
  * 4.2.0).
  */
async function callGroq(opts, tema) {
  log(`pedindo letra ao Groq (${GROQ.model}): "${tema.slice(0, 60)}"`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ.timeoutMs);
  let res;
  try {
    res = await fetch(`${GROQ.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ.apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT_DEEPSEEK },
          { role: 'user', content: buildDeepSeekUserPrompt(opts) },
        ],
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
    throw new Error(`Groq respondeu ${res.status}: ${motivo}`);
  }

  const content = String(payload?.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('Groq nao retornou conteudo');

  if (opts.mode === 'next') {
    const { linha } = parseLyricPayload(content, 'next');
    if (!linha) throw new Error('Groq nao retornou a proxima linha');
    log(`Groq devolveu a proxima linha ("${linha.slice(0, 40)}")`);
    return { line: linha, engine: 'groq', model: GROQ.model };
  }

  const { letra } = parseLyricPayload(content, 'full');
  if (!letra) throw new Error('Groq nao retornou a letra no JSON');
  log(`Groq devolveu a letra (${letra.length} chars)`);
  return { text: cleanLyric(letra), engine: 'groq', model: GROQ.model };
}

/**
 * Gera letra com o Groq, com fallback para o gerador local.
 * Aceita string (tema) ou opts.
 * Esta funcao e chamada pela cadeia do generateLyricsDeepSeek
 * (DeepSeek -> NVIDIA -> Groq -> Local).
 */
export async function generateLyricsGroq(temaOuOpts = {}, extra = {}) {
  const opts = typeof temaOuOpts === 'string'
    ? { ...extra, prompt: temaOuOpts }
    : { ...temaOuOpts };
  const tema = String(opts.prompt || '').trim();

  if (!groqAvailable()) {
    return localFallback(opts, 'Groq: GROQ_API_KEY ausente');
  }
  if (!tema) {
    return localFallback(opts, 'tema vazio');
  }
  try {
    await throttle('groq');
    return await retryWithBackoff(() => callGroq(opts, tema), 'groq');
  } catch (err) {
    return localFallback(opts, `Groq: ${primeiraLinha(err.message)}`);
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

/* ---------------- Geração de Estilos Musicais ---------------- */

/**
 * Prompt para gerar descrições criativas de estilos musicais.
 */
const STYLE_SYSTEM_PROMPT = 'Você é um especialista em música e estilos musicais. '
  + 'Gere descrições criativas e detalhadas de estilos musicais em português do Brasil, '
  + 'incluindo instrumentação característica e elementos sonoros. '
  + 'A descrição deve ter entre 8 e 15 palavras.';

const STYLE_USER_PROMPT = 'Gere uma descrição curta e criativa de um estilo musical em português do Brasil. '
  + 'Responda APENAS com a descrição, sem aspas, sem explicações, sem introdução. '
  + 'Exemplos: "Rock alternativo dos anos 90 com guitarra distorcida e bateria seca", '
  + '"Lo-fi chill com piano suave, chuva de fundo e textura de vinil", '
  + '"Trap pesado com 808 grave, hi-hats rápidos e sintetizadores escuros". '
  + 'Agora gere uma nova descrição criativa e original:';

/**
 * Lista de estilos locais para fallback (mesma usada no frontend).
 */
const LOCAL_STYLE_SUGGESTIONS = [
  'Rock alternativo dos anos 90 com guitarra distorcida e bateria seca',
  'Lo-fi chill com piano suave, chuva de fundo e textura de vinil',
  'Trap pesado com 808 grave, hi-hats rápidos e sintetizadores escuros',
  'MPB melancólica com violão, pandeiro e saxofone ao fundo',
  'Synthwave dos anos 80 com sintetizadores neon e bateria eletrônica',
  'Samba de roda animado com pandeiro, cavaquinho e surdo no refrão',
  'Funk brasileiro com tambor, baixo elétrico e bordões gritando',
  'Pop dance dos anos 2000 com sintetizadores brilhantes e refrão grudento',
  'Jazz de madrugada com piano, contrabaixo e saxofone quente',
  'Bossa nova leve com violão de nylon e percussão discreta',
  'Reggae tranquilo com baixo round, skank no violão e melodia solta',
  'Rock progressivo com guitarra limpa, sintetizadores e solos longos',
  'Forró de vaqueiro com sanfona, triângulo e bateria de baile',
  'Gospel soul com coro, piano e dinâmica crescente no refrão',
  'Indie folk acústico com violão, bumbo leve e vozes em dupla',
  'House club com kick de quatro tempos, hi-hat e sintetizador pulsante',
  'Balada de piano com cordas orquestrais e refrão em tom menor',
  'K-pop animado com beat dance, sintetizadores brilhantes e refrão coreografado',
  'R&B neosoul com baixo encorpado, Rhodes e grooves relaxados',
  'Rockabilly dos anos 50 com guitarra twang, contrabaixo e bateria scrub',
  'Amapiano com piano log drum, percussão africana e melodia etérea',
  'Sertanejo universitário com viola, sanfona e batida em dois',
];

/**
 * Gera um estilo musical aleatório usando IA (NVIDIA/DeepSeek) com fallback local.
 * Retorna { style: string, engine: string }.
 */
export async function generateMusicStyle() {
  // Tenta NVIDIA primeiro (se disponível)
  if (nvidiaAvailable()) {
    try {
      log('[estilo] tentando gerar com NVIDIA NIM');
      await throttle('nvidia');
      const result = await retryWithBackoff(() => callNvidiaForStyle(), 'nvidia');
      log(`[estilo] NVIDIA gerou: "${result.slice(0, 60)}"`);
      return { style: result, engine: 'nvidia' };
    } catch (err) {
      log(`[estilo] NVIDIA fora: ${primeiraLinha(err.message)} -> tentando DeepSeek`);
    }
  } else {
    log('[estilo] NVIDIA_API_KEY ausente, pulando para DeepSeek');
  }

  // Fallback para DeepSeek (se disponível)
  if (deepSeekAvailable()) {
    try {
      log('[estilo] tentando gerar com DeepSeek');
      await throttle('deepseek');
      const result = await retryWithBackoff(() => callDeepSeekForStyle(), 'deepseek');
      log(`[estilo] DeepSeek gerou: "${result.slice(0, 60)}"`);
      return { style: result, engine: 'deepseek' };
    } catch (err) {
      log(`[estilo] DeepSeek fora: ${primeiraLinha(err.message)} -> usando lista local`);
    }
  } else {
    log('[estilo] DEEPSEEK_API_KEY ausente, usando lista local');
  }

  // Fallback final: lista local
  log('[estilo] usando lista local (fallback)');
  const randomStyle = LOCAL_STYLE_SUGGESTIONS[
    Math.floor(Math.random() * LOCAL_STYLE_SUGGESTIONS.length)
  ];
  return { style: randomStyle, engine: 'local' };
}

/**
 * Chama NVIDIA NIM para gerar um estilo musical.
 */
async function callNvidiaForStyle() {
  log('pedindo estilo musical ao NVIDIA NIM');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000); // 8s timeout (estilo e rapido)
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
          { role: 'system', content: STYLE_SYSTEM_PROMPT },
          { role: 'user', content: STYLE_USER_PROMPT },
        ],
        temperature: 1.1, // alta criatividade
        max_tokens: 100,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* tratado abaixo */ }
  if (!res.ok) {
    const motivo = payload?.error?.message || payload?.message || raw.slice(0, 200);
    throw new Error(`NVIDIA respondeu ${res.status}: ${motivo}`);
  }

  const content = String(payload?.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('NVIDIA não retornou conteúdo');

  // Limpa a resposta (remove aspas, pontos finais desnecessários)
  const clean = content.replace(/^["'`]+|["'`]+$/g, '').replace(/\.+$/, '').trim();
  log(`NVIDIA devolveu estilo: "${clean.slice(0, 60)}"`);
  return clean;
}

/**
 * Chama DeepSeek para gerar um estilo musical.
 */
async function callDeepSeekForStyle() {
  log('pedindo estilo musical ao DeepSeek');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000); // 8s timeout
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
          { role: 'system', content: STYLE_SYSTEM_PROMPT },
          { role: 'user', content: STYLE_USER_PROMPT },
        ],
        temperature: 1.1, // alta criatividade
        max_tokens: 100,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* tratado abaixo */ }
  if (!res.ok) {
    const motivo = payload?.error?.message || payload?.message || raw.slice(0, 200);
    throw new Error(`DeepSeek respondeu ${res.status}: ${motivo}`);
  }

  const content = String(payload?.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('DeepSeek não retornou conteúdo');

  // Limpa a resposta
  const clean = content.replace(/^["'`]+|["'`]+$/g, '').replace(/\.+$/, '').trim();
  log(`DeepSeek devolveu estilo: "${clean.slice(0, 60)}"`);
  return clean;
}

/* ---------------- Expansão de Estilo com IA ---------------- */

/**
 * Prompt para expansão de estilo musical via IA (NVIDIA/Groq).
 * Formato Suno AI: instrumentos, BPM, tipo de vocal e clima.
 */
const STYLE_EXPANSION_SYSTEM_PROMPT = 'Você é um especialista em estilos musicais Suno AI. '
  + 'Gere uma descrição detalhada e estruturada de um estilo musical, '
  + 'incluindo: instrumentos característicos, BPM aproximado, tipo de voz/vocal '
  + 'e o clima/mood da produção. '
  + 'Responda APENAS com a descrição, sem aspas, sem introdução, sem explicações.';

const STYLE_EXPANSION_USER_PROMPT = 'Gere uma descrição detalhada de estilo musical no formato Suno AI para o gênero: {gênero}. '
  + 'Inclua instrumentos específicos, BPM, tipo de vocal e clima da produção. '
  + 'IMPORTANTE: gere uma descrição ÚNICA e VARIADA a cada solicitação - nunca repita a mesma resposta para o mesmo gênero. '
  + 'Variados instrumentos, BPM, arranjos e atmosferas de forma criativa. '
  + 'Responda apenas com a descrição.';

/**
 * Expande um gênero musical usando exclusivamente a NVIDIA Nemotron 3.5 Lightning.
 * Retorna a descrição expandida ou null em caso de erro.
 * O dicionário local serve apenas como fallback se a API falhar.
 */
export async function expandStyleWithAI(genre) {
  const genreLower = String(genre || '').trim().toLowerCase();
  if (!genreLower) {
    log('[estilo-ia] gênero vazio, retornando null');
    return null;
  }

  log(`[estilo-ia] expandStyleWithAI chamado para gênero="${genreLower}"`);

  // Usa exclusivamente a NVIDIA Nemotron 3.5 Lightning
  if (nvidiaAvailable()) {
    try {
      log('[estilo-ia] NVIDIA disponível, chamando API para expansão de estilo');
      const prompt = STYLE_EXPANSION_USER_PROMPT.replace('{gênero}', genreLower);
      log(`[estilo-ia] prompt enviado à NVIDIA: "${prompt.slice(0, 120)}"`);
      const result = await callNvidiaForStyleExpansionWithNemotron(prompt);
      log(`[estilo-ia] NVIDIA retornou com SUCESSO: "${result.slice(0, 100)}"`);
      return result;
    } catch (err) {
      log(`[estilo-ia] NVIDIA FALHOU: ${primeiraLinha(err.message)} -> usando dicionário local`);
    }
  } else {
    log('[estilo-ia] NVIDIA_API_KEY não configurada, usando dicionário local');
  }

  // Fallback: dicionário local
  const local = LOCAL_STYLE_EXPANSION_DICT.get(genreLower);
  if (local) {
    log(`[estilo-ia] usando dicionário local para gênero="${genreLower}": "${local.slice(0, 80)}"`);
    return local;
  }

  log(`[estilo-ia] gênero="${genreLower}" não encontrado no dicionário local`);
  return null;

/**
 * Chama a NVIDIA Nemotron 3.5 Lightning para expansão de estilo.
 * Usa a chave nvapi-... e o modelo nvidia/nemotron-3.5-lightning-30b-a3b.
 */
async function callNvidiaForStyleExpansionWithNemotron(prompt) {
  // Modelo específico Nemotron 3.5 Lightning
  const model = 'nvidia/nemotron-3.5-lightning-30b-a3b';
  
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + NVIDIA.apiKey,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: STYLE_EXPANSION_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 1.1,
        max_tokens: 150,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* tratado abaixo */ }
  if (!res.ok) {
    const motivo = payload?.error?.message || payload?.message || raw.slice(0, 200);
    throw new Error('NVIDIA respondeu ' + res.status + ': ' + motivo);
  }

  const msg = payload?.choices?.[0]?.message || {};
  const content = String(msg.content || '').trim();
  if (!content) {
    const raciocinio = String(msg.reasoning_content || '').trim();
    if (raciocinio) {
      throw new Error('NVIDIA só devolveu raciocínio, sem conteúdo');
    }
    throw new Error('NVIDIA não retornou conteúdo');
  }

  const clean = content.replace(/^["'`]+|["'`]+$/g, '').replace(/\.+$/, '').trim();
  log('NVIDIA Nemotron devolveu estilo expandido: "' + content.slice(0, 80) + '"');
  return clean}
}

/**
 * Chama NVIDIA NIM para expansão de estilo.
 */
async function callNvidiaForStyleExpansion(prompt) {
  log('pedindo expansão de estilo ao NVIDIA NIM');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
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
          { role: 'system', content: STYLE_EXPANSION_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 1.1,
        max_tokens: 150,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* tratado abaixo */ }
  if (!res.ok) {
    const motivo = payload?.error?.message || payload?.message || raw.slice(0, 200);
    throw new Error(`NVIDIA respondeu ${res.status}: ${motivo}`);
  }

  const msg = payload?.choices?.[0]?.message || {};
  const content = String(msg.content || '').trim();
  if (!content) {
    const raciocinio = String(msg.reasoning_content || '').trim();
    if (raciocinio) {
      throw new Error('NVIDIA só devolveu raciocínio, sem conteúdo');
    }
    throw new Error('NVIDIA não retornou conteúdo');
  }

  const clean = content.replace(/^["'`]+|["'`]+$/g, '').replace(/\.+$/, '').trim();
  log(`NVIDIA devolveu estilo expandido: "${clean.slice(0, 80)}"`);
  return clean;
}

/**
 * Chama Groq para expansão de estilo.
 */
async function callGroqForStyleExpansion(prompt) {
  log('pedindo expansão de estilo ao Groq');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(`${GROQ.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ.apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ.model,
        messages: [
          { role: 'system', content: STYLE_EXPANSION_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 1.1,
        max_tokens: 150,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* tratado abaixo */ }
  if (!res.ok) {
    const motivo = payload?.error?.message || payload?.message || raw.slice(0, 200);
    throw new Error(`Groq respondeu ${res.status}: ${motivo}`);
  }

  const content = String(payload?.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('Groq não retornou conteúdo');

  const clean = content.replace(/^["'`]+|["'`]+$/g, '').replace(/\.+$/, '').trim();
  log(`Groq devolveu estilo expandido: "${clean.slice(0, 80)}"`);
  return clean;
}

/* ---------------- Controle de Rate Limit e Retry ---------------- */

/**
 * Controle de throttle para evitar rate limit (429) da NVIDIA.
 * Garante um intervalo mínimo entre chamadas consecutivas.
 */
const throttleState = {
  nvidia: { lastCall: 0 },
  deepseek: { lastCall: 0 },
};

/**
 * Aguarda o intervalo mínimo desde a última chamada.
 */
async function throttle(provider) {
  const config = RATE_LIMIT[provider];
  const state = throttleState[provider];
  if (!config || !state) return;
  
  const now = Date.now();
  const elapsed = now - state.lastCall;
  const remaining = config.throttleMs - elapsed;
  
  if (remaining > 0) {
    log(`throttle: aguardando ${remaining}ms antes da próxima chamada ao ${provider}`);
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  
  state.lastCall = Date.now();
}

/**
 * Retry com backoff exponencial para recuperar de erros temporários (429, 5xx).
 * Para estilo musical: usa menos tentativas para fallback rapido.
 */
async function retryWithBackoff(fn, provider = 'nvidia') {
  const config = RATE_LIMIT[provider] || RATE_LIMIT.nvidia;
  
  // Para estilo: usa menos retries para nao travar a UI
  const maxRetries = provider === 'nvidia' ? 1 : config.maxRetries;
  const {
    initialRetryDelay = 2000,
    maxRetryDelay = 16000,
  } = config;
  
  const shouldRetry = (error) => {
    // Retry em 429 (rate limit), 503 (service unavailable), timeout
    const is429 = /429/.test(error.message);
    const is5xx = /5\d{2}/.test(error.message);
    const isTimeout = /timeout|aborted/i.test(error.message);
    return is429 || is5xx || isTimeout;
  };

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }
      
      const delay = Math.min(initialRetryDelay * Math.pow(2, attempt), maxRetryDelay);
      log(`tentativa ${attempt + 1}/${maxRetries + 1} falhou: ${primeiraLinha(error.message)} -> aguardando ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}


export function buildSunoCaption({ prompt, style, styleFromText = false, genreLabel, moodLabel, lofi, instrumental, duration }) {
  const bits = [];
  const text = String(prompt || '').trim();

  const textCleaned = text;

  let styleText = '';
  if (styleFromText || style) {
    styleText = String(style || '').trim();
  } else if (genreLabel) {
    styleText = genreLabel;
  }

  if (styleText && !styleFromText) {
    const expanded = expandStyleLocal(styleText);
    if (expanded) {
      styleText = expanded;
    }
  }

  const vocalDesc = textCleaned ? `${textCleaned}, ` : '';

  let genreInstrumentation = '';
  if (styleText) {
    genreInstrumentation = styleText;
  } else if (genreLabel) {
    genreInstrumentation = genreLabel;
  }

  const moodDesc = moodLabel ? `${moodLabel} mood, ` : '';
  const lofiDesc = lofi ? 'lo-fi, vinyl crackle, soft and warm, ' : '';
  const instrDesc = instrumental ? 'instrumental, no vocals, ' : '';

  if (Number.isFinite(Number(duration)) && Number(duration) > 0) {
    bits.push(`${Math.round(Number(duration))} seconds`);
  }

  const vocalBit = vocalDesc.length > 0 ? vocalDesc.slice(0, -2) : '';
  const genreBit = genreInstrumentation ? genreInstrumentation : 'music';
  const moodBit = moodDesc.length > 0 ? moodDesc.slice(0, -2) : '';
  const lofiBit = lofiDesc.length > 0 ? lofiDesc.slice(0, -2) : '';
  const instrBit = instrDesc.length > 0 ? instrDesc.slice(0, -2) : '';

  const nonEmptyBits = [vocalBit, genreBit, moodBit, lofiBit, instrBit]
    .filter((b) => b.length > 0);

  if (nonEmptyBits.length >= 2) {
    const vocal = nonEmptyBits[0];
    const rest = nonEmptyBits.slice(1).join(', ');
    return `${vocal}. ${rest}`;
  }

  return nonEmptyBits[0] || 'instrumental track';
}

// Remove: export const LYRIC_THEMES = [...Object.keys(THEMES), 'livre', 'en'];
