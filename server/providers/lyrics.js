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
import { generateLyrics, expandStyleLocal } from '../lyrics.js';
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
- tags estruturais em ingles, SEM numero e na ordem: [Verse], [Chorus], [Verse], [Chorus] (opcionalmente [Bridge] e [Outro]);
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
  // Sem DEEPSEEK_API_KEY o provedor ativo vira 'groq': antes caia direto no
  // gerador local de templates e a chave do Groq ficava sem uso.
  if (provider === 'groq') return generateLyricsGroq(opts);
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
  + '- tags de secao SEM numero e SEM dicas: [Verse], [Chorus], [Verse], [Chorus] '
  + '(e opcionalmente [Bridge] e [Outro]);\n'
  + '- metrica regular e ritmo confortavel de cantar;\n'
  + '- rimas consistentes dentro de cada estrofe e um refrao com rima forte, que se repete identico;\n'
  + '- imagens concretas, sem cliches vazios;\n'
  + '- nao escreva nenhuma indicacao entre parenteses e nenhum hint dentro das tags;\n'
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
 * Groq assume; se tambem falhar, a NVIDIA NIM entra por ultimo (mais lenta,
 * modelos de raciocínio). Se todos falharem, cai NO GERADOR LOCAL de
 * templates - o app nunca quebra. O resultado vem com `engine` indicando
 * quem escreveu ('deepseek' | 'groq' | 'nvidia' | 'local-templates') e,
 * no fallback, `fallback` com o(s) motivo(s).
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
      log(`DeepSeek fora (${motivos[motivos.length - 1]}) -> tentando o Groq`);
    }
  } else {
    motivos.push('DeepSeek: DEEPSEEK_API_KEY ausente');
  }

  // fallback secundario: Groq (rapido)
  if (groqAvailable()) {
    try {
      await throttle('groq');
      return await retryWithBackoff(() => callGroq(opts, tema), 'groq');
    } catch (err) {
      motivos.push(`Groq: ${primeiraLinha(err.message)}`);
      log(`Groq fora (${motivos[motivos.length - 1]}) -> tentando o NVIDIA NIM`);
    }
  } else {
    motivos.push('Groq: GROQ_API_KEY ausente');
  }

  // fallback terciario: NVIDIA NIM (mais lento, modelos de raciocínio)
  if (nvidiaAvailable()) {
    try {
      await throttle('nvidia');
      return await retryWithBackoff(() => callNvidia(opts, tema), 'nvidia');
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

  // Tratamento de rate limit (429): aguarda o retry-after indicado pela API
  // e tenta uma unica vez, mas so se o tempo de espera nao estourar o limite
  // seguro (20s) para nao comprometer o timeout total de 60s do frontend.
  // Se o retry-after for maior que 20s, nao tenta: deixa o erro propagar
  // para o provedor seguinte da cadeia (NVIDIA).
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    const delayMs = retryAfter ? Number(retryAfter) * 1000 : 5000;
    if (delayMs > 20000) {
      log(`Groq 429 rate limit: retry-after de ${delayMs}ms excede o limite seguro (20s), pulando para o proximo provedor`);
      throw new Error(`Groq respondeu 429: rate limit (retry-after ${delayMs}ms, pulando para o proximo provedor)`);
    }
    log(`Groq 429 rate limit: aguardando ${delayMs}ms antes de retry único`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
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
    const raw2 = await res.text();
    let payload2 = null;
    try { payload2 = JSON.parse(raw2); } catch { /* tratado abaixo */ }
    if (!res.ok) {
      const motivo = payload2?.error?.message || payload2?.message || raw2.slice(0, 200);
      throw new Error(`Groq respondeu ${res.status}: ${motivo}`);
    }
    const content2 = String(payload2?.choices?.[0]?.message?.content || '').trim();
    if (!content2) throw new Error('Groq nao retornou conteudo apos retry');
    const textoFinal = content2;
    return processGroqResponse(textoFinal, opts);
  }

  if (!res.ok) {
    const motivo = payload?.error?.message || payload?.message || raw.slice(0, 200);
    throw new Error(`Groq respondeu ${res.status}: ${motivo}`);
  }

  const content = String(payload?.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('Groq nao retornou conteudo');
  return processGroqResponse(content, opts);
}

/** Processa a resposta de texto do Groq para o formato de retorno da funcao. */
function processGroqResponse(content, opts) {
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
 * (DeepSeek -> Groq -> NVIDIA -> Local).
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
    const motivoGroq = `Groq: ${primeiraLinha(err.message)}`;
    log(`Groq fora (${motivoGroq}) -> tentando o NVIDIA NIM`);
    // cadeia documentada: Groq -> NVIDIA NIM -> gerador local de templates
    if (nvidiaAvailable()) {
      try {
        await throttle('nvidia');
        return await retryWithBackoff(() => callNvidia(opts, tema), 'nvidia');
      } catch (errNvidia) {
        return localFallback(opts, `${motivoGroq} | NVIDIA: ${primeiraLinha(errNvidia.message)}`);
      }
    }
    return localFallback(opts, motivoGroq);
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
  + 'Apenas 3 elementos instrumentais: . BPM e clima. .Seja descritivo. .Responda apenas com a descrição.';

/**
 * Expande um gênero musical usando exclusivamente a NVIDIA Nemotron 3.5 Lightning.
 * Retorna a descrição expandida ou null em caso de erro.
 * O dicionário local serve apenas como fallback se a API falhar.
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

// Dicionário de progressões harmônicas por estilo
const harmonicProgressions = {
  'Sertanejo': [
    'G - D - Em - C (I - V - vi - IV)',
    'C - G - Am - F',
    'D - A - Bm - G'
  ],
  'MPB': [
    'Am7 - Dm7 - G7 - Cmaj7',
    'Dm7 - G7 - Cmaj7 - Am7',
    'Fmaj7 - Em7 - Dm7 - Cmaj7'
  ],
  'Pop': [
    'C - G - Am - F',
    'Am - F - C - G',
    'Em - C - G - D'
  ],
  'Rock': [
    'E5 - A5 - B5 - G5',
    'A5 - D5 - E5 - G5',
    'Em - C - G - D'
  ],
  'Trap': [
    'Cm - Ab - Eb - Bb',
    'Fm - Db - Ab - Eb',
    'Gm - Cm - Eb - Bb'
  ],
  'Funk': [
    'Am - Dm - E - Am',
    'Dm - G - C - Bb',
    'Am - E - F - C'
  ],
  'Lo-fi': [
    'Am - F - C - G',
    'Dm - G - C - Bb',
    'Em - Am - C - G'
  ]
};

// Remove: export const LYRIC_THEMES = [...Object.keys(THEMES), 'livre', 'en'];



export async function expandStyleWithAI(genre) {
  const genreLower = String(genre || "").trim().toLowerCase();
  if (!genreLower) {
    log("[estilo-ia] genero vazio, retornando null");
    return null;
  }

  // 1. Sorteia uma progressao harmonica baseada no estilo
  const progressionsForStyle = harmonicProgressions[genreLower] || harmonicProgressions["Pop"];
  const randomProgression = progressionsForStyle[Math.floor(Math.random() * progressionsForStyle.length)];

  log("[estilo-ia] expandStyleWithAI chamado para genero=" + genreLower);
  log("[estilo-ia] progressao harmonica sorteada: " + randomProgression);

  // 2. Monta o prompt para o LLM com a progressao harmonica inclusa
  const llmPrompt = " voce e um especialista em estilos musicais Suno AI. Expanda o estilo musical " + genreLower + " no formato da Suno AI. OBRIGATORIO: Inclua explicitamente esta progressao harmonica na sua descricao: " + randomProgression + ". Seja descritivo com instrumentos, clima, BPM e tipo de vocal. Responda APENAS com a descricao, sem aspas, sem introducao, sem explicacoes.";

  // Usa exclusivamente a NVIDIA Nemotron 3.5 Lightning
  if (nvidiaAvailable()) {
    try {
      log("[estilo-ia] NVIDIA disponivel, chamando API para expandicao de estilo");
      const prompt = STYLE_EXPANSION_USER_PROMPT.replace("{gênero}", genreLower);
      log("[estilo-ia] prompt enviado NVIDIA: " + prompt.slice(0, 120));
      const result = await callNvidiaForStyleExpansionWithNemotron(llmPrompt);
      log("[estilo-ia] NVIDIA retornou com SUCESSO: " + result.slice(0, 100));
      if (result && !result.includes(randomProgression)) {
        return result + " . Progressao harmonica: " + randomProgression;
      }
      return result;
    } catch (err) {
      log("[estilo-ia] NVIDIA FALHOU: " + primeiraLinha(err.message) + " -> usando dicionario local com progressao");
    }
  } else {
    log("[estilo-ia] NVIDIA_API_KEY nao configurada, usando dicionario local com progressao");
  }

  // Fallback: dicionario local + progressao sorteada
  const local = LOCAL_STYLE_EXPANSION_DICT.get(genreLower);
  if (local) {
    log("[estilo-ia] usando dicionario local para genero=" + genreLower + ": " + local.slice(0, 80));
    return local + ", com progressao harmonica: " + randomProgression;
  }

  // Fallback final: gera descricao basica com a progressao sorteada
  return "Estilo " + genreLower + " com progressao harmonica: " + randomProgression;
}



// Função para contagem de sílabas em português
function countSyllablesPT(text) {
    if (!text) return 0;
    text = text.lower().trim();
    // Remove acentos e normaliza
    text = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    text = text.toLowerCase();
    // Conta grupos de vogais (ditongos contam como uma sílaba)
    const vowels = 'aeiou';
    let count = 0;
    let inVowel = false;
    for (let i = 0; i < text.length; i++) {
        if (vowels.includes(text[i])) {
            if (!inVowel) {
                count++;
                inVowel = true;
            }
        } else {
            inVowel = false;
        }
    }
    if (count === 0) count = 1;
    return count;
}

// Função para quebrar uma linha em até duas linhas, cada one com entre 6 e 9 sílabas
function verseLines(text) {
    const sylCount = countSyllablesPT(text);
    if (sylCount <= 9) return [text];
    
    const words = text.split(' ');
    let firstPart = '';
    let firstSyllables = 0;
    
    for (let i = 0; i < words.length; i++) {
        const wordSyllables = countSyllablesPT(words[i]);
        if (firstSyllables + wordSyllables <= 9 && firstSyllables + wordSyllables >= 6) {
            firstPart += words[i] + ' ';
            firstSyllables += wordSyllables;
        } else if (firstSyllables < 6 && i > 0) {
            break;
        } else {
            firstPart += words[i] + ' ';
            firstSyllables += wordSyllables;
        }
    }
    
    if (!firstPart || firstSyllables < 6) {
        const mid = Math.floor(text.length / 2);
        return [text.substring(0, mid), text.substring(mid)];
    }
    
    const firstLine = firstPart.trim();
    const secondLine = text.substring(firstPart.length).trim();
    
    const lines = [];
    const s1 = countSyllablesPT(firstLine);
    const s2 = countSyllablesPT(secondLine);
    result.push(firstLine);
    if (secondLine && countSyllablesPT(secondLine) > 0) {
        result.push(secondLine);
    }
    return result;
}

// Override do parseLyricPayload para aplicar quebra de linha por sílabas
const originalParseLyricPayload = parseLyricPayload;
parseLyricPayload = function(content, modo) {
    const result = originalParseLyricPayload(content, modo);
    if (modo === 'next') {
        // Aplica quebra de linha para a próxima linha
        const currentLine = result.linha || '';
        const broken = verseLines(currentLine);
        if (broken.length > 1) {
            result.linha = broken[0];
            // A linha restante pode ser adicionada como observação ou próxima linha
        }
    }
    return result;
};

/* ===========================================================================
 * PERFORMANCE CUES + QUEBRA POR SÍLABAS — camada determinística de letras
 * ---------------------------------------------------------------------------
 * ARQUIVO DE DESTINO: server/providers/lyrics.js
 * COMO APLICAR: cole este bloco no fim do arquivo.
 *
 * ORDEM OBRIGATÓRIA NO BACKEND:
 *     letra crua do LLM
 *        -> breakLyricsIntoSyllableLines()   (6-9 sílabas por linha)
 *        -> addPerformanceCues()             (tags canônicas)
 *        -> prompt enviado ao ACE-Step
 *
 * REGRAS
 *   1. includeDirections tem PADRÃO FALSE: nenhuma linha entre parênteses
 *      entra na letra. Instrumento, clima e vocal ficam só no prompt de
 *      estilo (server/providers/music.js / providers/acestep.js).
 *   2. Tags SEM número e SEM hints: [Verse], [Chorus], [Bridge], [Outro].
 *      Tags legadas do LLM ([Verso 1], [Refrao], [Ponte], [Verse 1 - cold])
 *      são normalizadas para o conjunto canônico.
 *   3. A quebra por sílabas roda ANTES das cues; blocos idênticos produzem
 *      linhas idênticas (o refrão repetido continua idêntico).
 *   4. Contrato: PURA | FAIL-SAFE | IDEMPOTENTE | NÃO DUPLICA | DETERMINÍSTICA
 * =========================================================================== */

const MAX_INPUT_CHARS = 100_000;
const CHUNK_SIZE = 4; // linhas por verso quando a letra não tem blocos vazios

const SYLLABLE_MIN_DEFAULT = 6;
const SYLLABLE_MAX_DEFAULT = 9;

/** Qualquer tag de seção já presente ([Verse], [Chorus], [Intro]...). */
// grupo de captura: o texto da tag (sem colchetes) - sem ele as tags do
// LLM eram descartadas e as seções saiam só da heurística
const SECTION_CUE_RE = /^\s*\[\s*([^\]\r\n]{1,80})\s*\]\s*$/;

/** Tags canônicas geradas pelo backend (sem número). */
export const CANONICAL_SECTION_TAGS = ["Verse", "Chorus", "Bridge", "Outro"];

/** (qualquer coisa) — só para detectar cues antigas do LLM. */
const DIRECTION_RE = /\(([^)\r\n]{1,120})\)/;

/* -------------------------------------------------------------------------- */
/* Normalização de tags legadas -> conjunto canônico                           */
/* -------------------------------------------------------------------------- */

/** Ordem importa: a primeira regra que casa vence. */
const LEGACY_SECTION_RULES = [
  { re: /^(intro|introduc|opening|abertura)/, tag: 'Verse' },
  { re: /^(verse|verso|vers|estrofe|couplet|pre[- ]?chorus|pre[- ]?refrao|prechorus|prerefao)/, tag: 'Verse' },
  { re: /^(chorus|refrao|refran|refrain|hook|estribilho)/, tag: 'Chorus' },
  { re: /^(bridge|ponte|solo|break|interlude|interludio|pontefinal)/, tag: 'Bridge' },
  { re: /^(outro|final|finale|ending|encerramento)/, tag: 'Outro' },
];

/**
 * Converte o texto de uma tag (possivelmente com número e/ou hint) na tag
 * canônica correspondente. Devolve '' quando não há equivalente canônico.
 *
 *   'Verse 1'        -> 'Verse'
 *   'Verso 2 - frio' -> 'Verse'
 *   'Refrao'         -> 'Chorus'
 *   'Ponte'          -> 'Bridge'
 *   'Outro'          -> 'Outro'
 *
 * @param {string} tagText
 * @returns {string}
 */
export function canonicalTagFor(tagText) {
  const cleaned = String(tagText ?? '')
    .replace(/\([^)]*\)/g, ' ')          // hints entre parênteses
    .replace(/\[[^\]]*\]/g, ' ')         // hints entre colchetes
    .replace(/[-–—:]/g, ' ')             // separadores de hint
    .trim();
  if (!cleaned) return '';

  const key = normalizeKey(cleaned);
  if (!key) return '';
  if (CANONICAL_SECTION_TAGS.includes(cleaned)) return cleaned;
  if (CANONICAL_SECTION_TAGS.some((tag) => key === tag.toLowerCase())) {
    return CANONICAL_SECTION_TAGS.find((tag) => key === tag.toLowerCase());
  }

  for (const rule of LEGACY_SECTION_RULES) {
    if (rule.re.test(key)) return rule.tag;
  }
  return '';
}

/**
 * Reescreve as tags de um texto para o conjunto canônico, preservando a
 * separação entre blocos (tag desconhecida vira linha em branco).
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeSectionTags(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      const match = line.match(SECTION_CUE_RE);
      if (!match) return line;
      const canonical = canonicalTagFor(match[1]);
      return canonical ? `[${canonical}]` : '';
    })
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/* Dicionários de apoio (usados só no prompt de estilo, nunca na letra)       */
/* -------------------------------------------------------------------------- */

const VOCAL_HINTS = {
  female: 'vocal feminino suave', fem: 'vocal feminino suave', woman: 'vocal feminino suave',
  male: 'vocal masculino grave', man: 'vocal masculino grave',
  duet: 'dueto vocal', dueto: 'dueto vocal',
  child: 'vocal infantil', children: 'vocal infantil',
  choir: 'coral', coral: 'coral', rap: 'flow de rap',
  spoken: 'narração', narracao: 'narração',
};

const GENRE_INSTRUMENT_HINTS = {
  sertanejo: 'violão acústico, sanfona sutil',
  'sertanejo universitario': 'violão acústico, sanfona sutil',
  forró: 'sanfona, triângulo, zabumba',
  mpb: 'violão de nylon, percussão suave', bossa: 'violão de nylon, percussão suave',
  samba: 'surdo, pandeiro, agogô', axé: 'atabaque, timbau, pandeiro',
  gospel: 'coral, harmônico, piano',
  pop: 'síntese pop limpa, baixo round', 'pop rock': 'guitarra elétrica, bateria pop',
  rock: 'guitarra elétrica distorcida, bateria seca', 'rock alternativo': 'guitarra com crivo, bateria seca',
  metal: 'guitarra pesada, bateria dupla', punk: 'guitarra distorcida, bateria rápida',
  jazz: 'baixo acústico, bateria com vassourinha', blues: 'guitarra com sustain, baixo walking',
  funk: '808, groove pesado', 'funk brasileiro': '808, beat sincopado',
  reggaeton: 'dembow, 808', trap: '808, hi-hats rápidos',
  hiphop: 'beat heavy', 'hip hop': 'beat heavy',
  electronic: 'sintetizadores, punch de baixo', indie: 'guitarra limpa, sintetizador atmosférico',
  folk: 'violão acústico, cordas', country: 'violão de steel, fiddle',
  classical: 'orquestra de câmara', lounge: 'pads elétricos, contrabaixo quente',
};

const MOOD_HINTS = {
  happy: 'alegre e leve', sad: 'melancólico e contido', triste: 'melancólico e contido',
  romantic: 'romântico e íntimo', love: 'romântico e íntimo',
  energetic: 'energético e direto', aggressive: 'agressivo e intenso',
  calm: 'calmo e contemplativo', epic: 'épico e amplo',
  nostalgic: 'nostálgico e suave',
};

/**
 * Política de cues no prompt do LLM.
 * A estrutura (syllable break + tags) é aplicada no backend, de forma
 * determinística; o modelo só devolve a letra crua.
 */
export const PERFORMANCE_CUES_POLICY = {
  deterministic: true,
  includeDirections: false,
  tags: ['Verse', 'Chorus', 'Bridge', 'Outro'],
  syllableRange: { min: SYLLABLE_MIN_DEFAULT, max: SYLLABLE_MAX_DEFAULT },
  promptInstruction:
    'Devolva APENAS a letra da musica, em linhas simples, sem marcadores de secao ' +
    'como [Verse] ou [Chorus], sem indicacoes entre parenteses e sem hifenizacao. ' +
    'A estrutura da letra (quebra por silabas e secoes) sera aplicada depois, ' +
    'de forma deterministica.',
};

/* -------------------------------------------------------------------------- */
/* Helpers internos                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Remove linhas que são uma direção entre parênteses (ex.: "(soft vocal)",
 * "(chorus, explode)"). Só remove a linha inteira: parênteses no meio de uma
 * frase fazem parte da letra e são preservados.
 */
function removeDirectionLines(text) {
  // A linha de direcao e removida por INTEIRO: deixar uma linha vazia no
  // lugar cortava a secao ao meio (tag num bloco, conteudo em outro).
  return String(text ?? '')
    .split('\n')
    .filter((line) => !/^\s*\([^)\r\n]{1,120}\)\s*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function normalizeKey(text) {
  return String(text ?? '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeContext(context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const pick = (...keys) => {
    for (const key of keys) {
      const value = ctx[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return String(value).trim();
      }
    }
    return '';
  };
  const genre = pick('genre', 'genero');
  const style = pick('style', 'estilo');
  const mood = pick('mood', 'humor');
  const vocals = pick('vocals', 'voice', 'voz');
  const energyRaw = pick('energy', 'energia');

  let energyHint = '';
  if (energyRaw) {
    const numeric = Number(energyRaw);
    if (Number.isFinite(numeric) && energyRaw !== '') {
      if (numeric >= 7) energyHint = 'alta energia';
      else if (numeric <= 3) energyHint = 'energia baixa';
    } else {
      const key = normalizeKey(energyRaw);
      if (key === 'high' || key === 'alta') energyHint = 'alta energia';
      else if (key === 'low' || key === 'baixa') energyHint = 'energia baixa';
      else if (key === 'medium' || key === 'media') energyHint = 'energia media';
    }
  }

  return {
    // PADRÃO = false: nada entre parênteses na letra.
    includeDirections: ctx.includeDirections === true,
    // bridge=true força [Bridge] no bloco entre dois [Chorus].
    bridge: ctx.bridge === true || ctx.hasBridge === true,
    genre, style, mood, vocals,
    provider: pick('provider', 'provedor'),
    vocalHint: VOCAL_HINTS[normalizeKey(vocals)] || '',
    instrumentHint: GENRE_INSTRUMENT_HINTS[normalizeKey(genre)] || GENRE_INSTRUMENT_HINTS[normalizeKey(style)] || '',
    moodHint: MOOD_HINTS[normalizeKey(mood)] || '',
    energyHint,
  };
}

/* -------------------------------------------------------------------------- */
/* 1) QUEBRA POR SÍLABAS (roda ANTES das cues)                                */
/* -------------------------------------------------------------------------- */

const VOWEL_GROUP_RE = /[aeiouyáéíóúàâêôãõü]+/g;

/**
 * Estimativa de sílabas de uma palavra (heurística PT-BR/EN).
 * - Conta grupos de vogais.
 * - Normaliza 'ão/õe/ç' (1 sílaba) antes de contar.
 * - Palavras sem vogais contam como 1.
 *
 * @param {string} word
 * @returns {number}
 */
export function estimateSyllables(word) {
  const cleaned = String(word ?? '')
    .toLowerCase()
    .replace(/ç(?:ão|ões)/g, 'ca')
    .replace(/ão/g, 'a')
    .replace(/õe/g, 'oe')
    .replace(/[^a-záéíóúàâêôãõü]/g, '');
  if (!cleaned) return 0;
  const groups = cleaned.match(VOWEL_GROUP_RE);
  return Math.max(1, groups ? groups.length : 1);
}

/**
 * Quebra a letra em linhas de 6 a 9 sílabas, preservando os blocos
 * (separados por linha em branco) e sem reordenar nenhuma palavra.
 *
 * Determinística: o mesmo bloco sempre gera exatamente as mesmas linhas —
 * por isso um refrão repetido continua IDÊNTICO depois da quebra.
 *
 * @param {string} rawLyrics
 * @param {object} [options]
 * @param {number} [options.min=6]
 * @param {number} [options.max=9]
 * @returns {string}
 */
export function breakLyricsIntoSyllableLines(rawLyrics, options = {}) {
  try {
    const original = typeof rawLyrics === 'string' ? rawLyrics : '';
    // linhas de direção entre parênteses não são letra: não entram na quebra
    const text = removeDirectionLines(normalizeText(original));
    if (!text) return '';

    const opts = options && typeof options === 'object' ? options : {};
    const min = Math.max(1, Number(opts.min) || SYLLABLE_MIN_DEFAULT);
    const max = Math.max(min, Number(opts.max) || SYLLABLE_MAX_DEFAULT);

    const blocks = splitIntoBlocks(text.split('\n'));
    if (!blocks.length) return text;

    const brokenBlocks = blocks.map((block) => {
      // Linhas que já são cue ([Verse], [Chorus]...) atravessam intactas.
      const cueLines = block.filter((line) => SECTION_CUE_RE.test(line));
      const contentLines = block.filter((line) => !SECTION_CUE_RE.test(line));
      if (!contentLines.length) return block;

      // NUNCA junta linhas de versos diferentes: cada linha original e
      // quebrada sozinha (so uma linha longa vira varias). Preserva a
      // frase musical do compositor.
      const out = [];
      for (const line of contentLines) {
        const words = line.split(/\s+/).filter((word) => word.length > 0);
        if (!words.length) continue;

        const syllables = words.map((word) => estimateSyllables(word));
        const total = syllables.reduce((sum, value) => sum + value, 0);

        // Ja cabe em uma linha cantavel: nao mexe.
        if (total <= max) {
          out.push(words.join(' '));
          continue;
        }

        const linesNeeded = Math.max(1, Math.ceil(total / max));
        const target = Math.min(max, Math.max(min, Math.ceil(total / linesNeeded)));

        const packed = [];
        let current = [];
        let currentSyllables = 0;

        for (let index = 0; index < words.length; index += 1) {
          const word = words[index];
          const count = syllables[index];

          if (current.length && currentSyllables + count > max) {
            packed.push(current);
            current = [];
            currentSyllables = 0;
          }

          current.push(word);
          currentSyllables += count;

          if (currentSyllables >= target) {
            packed.push(current);
            current = [];
            currentSyllables = 0;
          }
        }
        if (current.length) packed.push(current);

        for (const group of packed) out.push(group.join(' '));
      }

      return cueLines.length ? [...cueLines, ...out] : out;
    });

    return brokenBlocks.map((lines) => lines.join('\n')).join('\n\n');
  } catch (error) {
    console.warn('[lyrics] breakLyricsIntoSyllableLines falhou; devolvendo texto original:',
      error && error.message ? error.message : error);
    return typeof rawLyrics === 'string' ? rawLyrics : '';
  }
}

/* -------------------------------------------------------------------------- */
/* 2) PERFORMANCE CUES (roda DEPOIS da quebra por sílabas)                      */
/* -------------------------------------------------------------------------- */

function splitIntoBlocks(lines) {
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length) { blocks.push(current); current = []; }
      continue;
    }
    // Uma tag de secao INICIA um bloco novo. A letra real (do LLM ou do
    // usuario) vem com as tags em linhas consecutivas, sem linha em branco
    // entre as secoes; sem esta regra as tags se descolavam do seu conteudo
    // e a quebra por silabas empilhava todas as tags no topo.
    if (SECTION_CUE_RE.test(line)) {
      if (current.length) { blocks.push(current); current = []; }
      current.push(line);
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function chunkLines(lines, size) {
  const filled = lines.filter((line) => line.trim() !== '');
  const chunks = [];
  for (let i = 0; i < filled.length; i += size) chunks.push(filled.slice(i, i + size));
  return chunks;
}

/** Tag canônica já presente no bloco (dica do LLM), se houver. */
function tagHintOf(block) {
  for (const line of block) {
    const match = line.match(SECTION_CUE_RE);
    if (match) {
      const canonical = canonicalTagFor(match[1]);
      if (canonical) return canonical;
    }
  }
  return '';
}

/** Corpo do bloco sem a linha de tag. */
function bodyOf(block) {
  return block.filter((line) => !SECTION_CUE_RE.test(line));
}

/**
 * Rotula os blocos com tags canônicas SEM número:
 *   - tag do LLM (normalizada)  -> respeitada ([Chorus], [Bridge]...)
 *   - bloco repetido            -> [Chorus]
 *   - interlúdio curto entre dois [Chorus] -> [Bridge]
 *   - último bloco muito menor que a média -> [Outro]
 *   - demais                     -> [Verse]
 */
function assignSectionLabels(rawBlocks, ctx = {}) {
  // Uma secao sem nenhum texto (so a tag; a direcao entre parenteses ja foi
  // removida) nao pode virar bloco: geraria "[Verse]" vazio na letra final.
  const blocks = rawBlocks.filter((block) => bodyOf(block).length > 0);
  if (!blocks.length) return [];
  const bodies = blocks.map((block) => bodyOf(block));
  const keys = bodies.map((body) => normalizeKey(body.join(' ')));
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);

  const isChorus = bodies.map((_, index) => (counts.get(keys[index]) || 0) > 1);
  const hints = blocks.map((block) => tagHintOf(block));

  // Tamanho de cada bloco em silabas (para reconhecer interludios curtos).
  const blockSyllables = bodies.map((body) =>
    body
      .flatMap((line) => line.split(/\s+/))
      .filter(Boolean)
      .reduce((sum, word) => sum + estimateSyllables(word), 0),
  );
  const otherBlocks = blockSyllables.filter((_, index) => index !== blocks.length - 1);
  const average = otherBlocks.length
    ? otherBlocks.reduce((sum, value) => sum + value, 0) / otherBlocks.length
    : 0;

  // Candidatos a [Bridge]: bloco entre dois [Chorus] que nao e chorus.
  const bridgeCandidates = blocks
    .map((_, index) => index)
    .filter((index) => !isChorus[index] && isChorus[index - 1] && isChorus[index + 1]);

  // Sem override, so vira [Bridge] se for um interludio CURTO (< 75% da media).
  // Caso contrario continua [Verse] — um verso entre dois refrões nao e ponte.
  let bridgeIndex = -1;
  if (ctx.bridge && bridgeCandidates.length) {
    bridgeIndex = bridgeCandidates[0];
  } else {
    const found = bridgeCandidates.find(
      (index) => average > 0 && blockSyllables[index] < average * 0.75,
    );
    bridgeIndex = found === undefined ? -1 : found;
  }

  const labeled = blocks.map((block, index) => {
    const isLast = index === blocks.length - 1;
    const isOutro =
      isLast && blocks.length > 1 && average > 0 && blockSyllables[index] < average * 0.6;

    let label;
    if (hints[index]) {
      label = hints[index];                       // o LLM ja disse a secao
    } else if (isChorus[index]) {
      label = 'Chorus';                            // bloco repetido
    } else if (index === bridgeIndex) {
      label = 'Bridge';                            // interludio curto
    } else if (isOutro) {
      label = 'Outro';
    } else {
      label = 'Verse';
    }

    return { label, body: bodies[index] };
  });

  // REFRAO REPETIDO: quando o mesmo [Chorus] aparece mais de uma vez, o
  // texto e o do primeiro refrão (o compositor repete palavra por palavra).
  // A quebra por silabas ja rodou antes das cues: copiar o corpo JA
  // QUEBRADO mantem o refrão idêntico depois da quebra.
  const firstChorus = labeled.find((item) => item.label === 'Chorus');
  if (firstChorus) {
    for (const item of labeled) {
      if (item.label === 'Chorus' && item !== firstChorus) item.body = firstChorus.body;
    }
  }

  return labeled.map((item) => `[${item.label}]\n${item.body.join('\n')}`);
}

/**
 * Aplica performance cues a uma letra já quebrada em sílabas.
 * Não insere nada entre parênteses por padrão (includeDirections === false).
 * Tags legadas são normalizadas para o conjunto canônico (sem número).
 *
 * @param {string} rawLyrics Letra (crua ou já quebrada em sílabas).
 * @param {object} [context]
 * @param {boolean} [context.includeDirections=false] Insere direção entre parênteses.
 * @param {boolean} [context.bridge=false] Força [Bridge] no interlúdio.
 * @returns {string}
 */
export function addPerformanceCues(rawLyrics, context = {}) {
  try {
    const original = typeof rawLyrics === 'string' ? rawLyrics
      : typeof rawLyrics === 'number' ? String(rawLyrics) : '';
    if (!original) return '';

    const text = normalizeText(original);
    if (!text) return '';
    if (text.length > MAX_INPUT_CHARS) return original;

    const ctx = normalizeContext(context);
    // hints entre parênteses do LLM nunca entram na letra final
    const withoutDirections = removeDirectionLines(text);
    const normalized = normalizeSectionTags(withoutDirections);
    const lines = normalized.split('\n');

    let blocks = splitIntoBlocks(lines);
    if (blocks.length <= 1) {
      const filled = lines.filter((line) => line.trim() !== '');
      if (filled.length > CHUNK_SIZE * 2) blocks = chunkLines(lines, CHUNK_SIZE);
    }
    if (!blocks.length) return text;

    const labelled = assignSectionLabels(blocks, ctx);
    if (!labelled.length) return text;

    // Direção entre parênteses: SOMENTE se pedida explicitamente.
    const directions = buildDirectionCues(ctx);
    const hasDirections = lines.some((line) => DIRECTION_RE.test(line));
    const header = directions && !hasDirections ? `${directions}\n\n` : '';

    return `${header}${labelled.join('\n\n')}`.trim();
  } catch (error) {
    console.warn('[lyrics] addPerformanceCues falhou; devolvendo texto original:',
      error && error.message ? error.message : error);
    return typeof rawLyrics === 'string' ? rawLyrics : '';
  }
}

function buildDirectionCues(ctx) {
  if (!ctx.includeDirections) return '';
  const parts = [ctx.vocalHint, ctx.instrumentHint, ctx.moodHint, ctx.energyHint].filter(Boolean);
  if (!parts.length) return '';
  return `(${parts.join(', ').slice(0, 118)})`;
}

/**
 * Remove cues de performance (tags e direções entre parênteses).
 * Tags viram linha em branco para preservar a separação entre blocos.
 */
export function stripPerformanceCues(rawLyrics) {
  try {
    const original = typeof rawLyrics === 'string' ? rawLyrics : '';
    const text = normalizeText(original);
    if (!text) return '';
    return removeDirectionLines(text).split('\n')
      .map((line) => (SECTION_CUE_RE.test(line) ? '' : line.trimEnd()))
      .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  } catch (error) {
    console.warn('[lyrics] stripPerformanceCues falhou; devolvendo texto original:',
      error && error.message ? error.message : error);
    return typeof rawLyrics === 'string' ? rawLyrics : '';
  }
}

/** Indica se o texto já contém cues de performance. */
export function hasPerformanceCues(rawLyrics) {
  try {
    const text = normalizeText(rawLyrics);
    if (!text) return false;
    return text.split('\n').some((line) => SECTION_CUE_RE.test(line));
  } catch {
    return false;
  }
}

/**
 * Pipeline completo da letra (a ordem oficial do backend):
 *   1) remove hints entre parênteses;
 *   2) quebra por sílabas (6-9);
 *   3) aplica as cues com tags canônicas.
 *
 * @param {string} rawLyrics
 * @param {object} [context]
 * @returns {string}
 */
export function applyLyricsPipeline(rawLyrics, context = {}) {
  try {
    const original = typeof rawLyrics === 'string' ? rawLyrics : '';
    if (!original) return '';
    // Só as direções entre parênteses saem aqui. As TAGS do LLM precisam
    // sobreviver até as cues: é delas que sai a seção ([Chorus], [Bridge],
    // [Outro]). As cues reescrevem as tags no conjunto canônico, então
    // tag legada ("Chorus 2") vira "[Chorus]" sem numero.
    const cleaned = removeDirectionLines(normalizeText(original));
    const broken = breakLyricsIntoSyllableLines(cleaned, {
      min: Number(context?.min) || SYLLABLE_MIN_DEFAULT,
      max: Number(context?.max) || SYLLABLE_MAX_DEFAULT,
    });
    return addPerformanceCues(broken, context);
  } catch (error) {
    console.warn('[lyrics] applyLyricsPipeline falhou; devolvendo texto original:',
      error && error.message ? error.message : error);
    return typeof rawLyrics === 'string' ? rawLyrics : '';
  }
}

