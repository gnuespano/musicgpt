/**
 * Teste do modo NATURAL LANGUAGE do ACE-Step.
 *
 * Regra testada: na rota de geracao, quando o campo "Letra" esta vazio ou
 * contem so um TEMA curto (sem tags de secao), o backend NAO chama o
 * gerador local nem o OpenRouter - o texto puro vai para a API do ACE-Step
 * como `sample_query` (a "natural language description" da API) e o PROPRIO
 * LM 5Hz expande o tema em caption + letra + metadados.
 *
 *  - `buildRequestBody({ theme })` -> body.sample_mode = true,
 *    body.sample_query = tema, content SEM <lyrics> (só <prompt>).
 *  - Uma letra COMPLETA continua sendo respeitada: vai em <lyrics>,
 *    sem sample_mode/sample_query (o LM nao reescreve).
 *  - Instrumental e cover nao entram no modo sample (excecoes documentadas).
 *  - Na rota HTTP (com um stub da API), a faixa vem com a letra que o LM
 *    escreveu (metadados ## Lyrics), lyricsEngine = acestep-lm e o aviso
 *    de Natural Language - provando que nada passou pelo gerador local.
 *
 * Camadas:
 *  1. Contrato  - corpo do pedido do ACE-Step conforme o campo de letra.
 *  2. HTTP      - rota /api/generate com um STUB da API do ACE-Step.
 *  3. Live      - opcional (MUSICGPT_TESTE_LIVE=1): gera de verdade com um
 *     tema e compara a letra do LM com a do gerador local de templates.
 *
 * Uso:
 *   node scripts/testar-tema-natural.mjs
 *   MUSICGPT_TESTE_LIVE=1 node scripts/testar-tema-natural.mjs
 *     (gera de verdade no ACE-Step - gasta cota)
 */

import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { buildRequestBody } from '../server/providers/acestep.js';
import { generateLyrics as generateLocalLyrics } from '../server/lyrics.js';
import { encodeMp3 } from '../server/audio/mp3.js';
import { createReporter } from './lib/cdp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.env.MUSICGPT_TESTE_LIVE === '1';

const report = createReporter();
const { check } = report;

/** Tema curto, como o usuario digita no campo "Letra". */
const TEMA = 'Uma música sobre aceitar que o fim já chegou';

/** Palavras-chave do tema: medidas na letra para ver se o LM ancora no tema. */
const KEYWORDS_TEMA = ['fim', 'chegou', 'aceitar', 'acabar', 'despedir', 'partida', 'último', 'ultimo'];

/** Letra completa, com tags de secao (o caso que continua igual). */
const LETRA_ESCRITA = [
  '[Verse 1]',
  'Eu desliguei a luz da cozinha sem pressa',
  'Guardei a xicara no lugar de sempre',
  '',
  '[Chorus]',
  'E o fim chegou devagar, sem cerimonia',
].join('\n');

/** Letra que o "LM" do stub devolve (metadata ## Lyrics). */
const LETRA_DO_LM = [
  '[Verse 1]',
  'O fim chegou num dia comum de terca',
  'Sem banda, sem discurso, sem saida',
  '',
  '[Chorus]',
  'Aceitar e despir o que nao cabe',
  'E seguir com as maos vazias na estrada',
].join('\n');


/* ------------------------------------------------------------------ *
 * Contrato de formatacao (patch de performance cues)
 * ------------------------------------------------------------------ */

/** Compara o CONTEUDO da letra, ignorando tags e quebras de linha. */
function mesmaLetra(a, b) {
  const palavras = (t) => String(t ?? '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return palavras(a) === palavras(b) && palavras(a).length > 0;
}

/** Tags canonicas SEM numero: [Verse], [Chorus], [Bridge], [Outro]. */
function tagsCanonicas(t) {
  const texto = String(t ?? '');
  return /\[(Verse|Chorus|Bridge|Outro)\]/i.test(texto)
    && !/\[(Verse|Chorus|Bridge|Outro)\s*\d+\]/i.test(texto);
}
/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** MP3 curtissimo (0.4s de seno) para o stub devolver como "audio". */
function tinyMp3() {
  const sampleRate = 8000;
  const frames = Math.floor(sampleRate * 0.4);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.3;
  }
  return encodeMp3([samples], sampleRate, 32);
}

/**
 * Stub da API do ACE-Step (chat/completions): guarda o corpo de cada
 * pedido e devolve uma resposta no formato real (metadata + audio base64).
 */
async function startStub() {
  const port = await freePort();
  const pedidos = [];
  const audioB64 = tinyMp3().toString('base64');
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        pedidos.push(JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'stub-acestep',
          model: 'acemusic/acestep-v1.5-turbo',
          choices: [{
            message: {
              role: 'assistant',
              content: [
                '**Caption:** aceitar o fim, ballad lenta e limpa',
                '**BPM:** 84',
                '**Duration:** 30',
                '**Key:** C Major',
                '## Lyrics',
                LETRA_DO_LM,
              ].join('\n'),
              audio: [{ audio_url: { url: `data:audio/mpeg;base64,${audioB64}` } }],
            },
          }],
        }));
        return;
      }
      res.writeHead(404);
      res.end('{"detail":"rota inexistente no stub"}');
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port,
    pedidos,
    last: () => pedidos[pedidos.length - 1],
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Sobe o servidor do app apontando para o stub do ACE-Step. */
async function startServer(env = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicgpt-tema-natural-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      MUSICGPT_DATA_DIR: dataDir,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return { url, child, dataDir, log: () => log };
    } catch { /* ainda subindo */ }
    await delay(250);
  }
  child.kill('SIGKILL');
  throw new Error(`servidor nao subiu: ${log.slice(-400)}`);
}

/** POST /api/generate e espera a faixa ficar pronta. */
async function gerar(url, body) {
  const res = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ duration: 25, instrumental: false, ...body }),
  });
  const { jobId, error } = await res.json();
  if (!jobId) throw new Error(error || `sem jobId (${res.status})`);
  for (let i = 0; i < 300; i += 1) {
    const status = await (await fetch(`${url}/api/jobs/${jobId}`)).json();
    if (status.status === 'done') return status.track;
    if (status.status === 'error') throw new Error(status.error);
    await delay(300);
  }
  throw new Error(`job ${jobId} nao terminou`);
}

/* ------------------------------------------------------------------ *
 * 1. Contrato: o corpo do pedido muda conforme o campo de letra
 * ------------------------------------------------------------------ */

const pedidoTema = buildRequestBody({
  prompt: 'MPB melancolítica com violão',
  lyrics: '',
  style: 'MPB',
  options: { duration: 40, theme: TEMA },
});
check('contrato: tema -> sample_mode ligado (o LM escreve a letra)',
  pedidoTema.sample_mode === true, String(pedidoTema.sample_mode));
check('contrato: tema vira sample_query (natural language description)',
  pedidoTema.sample_query === TEMA, JSON.stringify(pedidoTema.sample_query));
check('contrato: o tema NAO vai como <lyrics> (evita a frase repetida)',
  !String(pedidoTema.messages[0].content).includes('<lyrics>'),
  JSON.stringify(pedidoTema.messages[0].content));
check('contrato: a caption de estilo continua no <prompt>',
  String(pedidoTema.messages[0].content).includes('<prompt>'),
  JSON.stringify(pedidoTema.messages[0].content));

const pedidoLetra = buildRequestBody({
  prompt: 'MPB melancolítica com violão',
  lyrics: LETRA_ESCRITA,
  style: 'MPB',
  options: { duration: 40, theme: TEMA },
});
check('contrato: letra completa -> vai em <lyrics> como antes',
  String(pedidoLetra.messages[0].content).includes(`<lyrics>${LETRA_ESCRITA}</lyrics>`),
  JSON.stringify(pedidoLetra.messages[0].content.slice(0, 80)));
check('contrato: letra completa -> sem sample_mode nem sample_query',
  pedidoLetra.sample_mode === undefined && pedidoLetra.sample_query === undefined,
  JSON.stringify({ sample_mode: pedidoLetra.sample_mode, sample_query: pedidoLetra.sample_query }));

const pedidoInstrumental = buildRequestBody({
  prompt: 'MPB melancolítica com violão',
  lyrics: '',
  style: 'MPB',
  options: { duration: 40, instrumental: true, theme: TEMA },
});
check('contrato: instrumental -> nao entra em modo sample',
  pedidoInstrumental.sample_mode === undefined && pedidoInstrumental.sample_query === undefined,
  JSON.stringify({ sample_mode: pedidoInstrumental.sample_mode, sample_query: pedidoInstrumental.sample_query }));

const pedidoCover = buildRequestBody({
  prompt: 'MPB melancolítica com violão',
  lyrics: '',
  style: 'MPB',
  options: {
    duration: 40,
    theme: TEMA,
    audioMode: 'cover',
    referenceAudio: { base64: 'YWJj', format: 'mp3' },
  },
});
check('contrato: cover -> sem sample_mode (o LM do cover e pulado)',
  pedidoCover.sample_mode === undefined && pedidoCover.sample_query === undefined,
  JSON.stringify({ sample_mode: pedidoCover.sample_mode, sample_query: pedidoCover.sample_query }));

const pedidoVazio = buildRequestBody({
  prompt: 'MPB melancolítica com violão',
  lyrics: '',
  style: 'MPB',
  options: { duration: 40 },
});
check('contrato: campo vazio -> sample_mode sem sample_query (LM planeja do caption)',
  pedidoVazio.sample_mode === true && pedidoVazio.sample_query === undefined,
  JSON.stringify({ sample_mode: pedidoVazio.sample_mode, sample_query: pedidoVazio.sample_query }));

/* ------------------------------------------------------------------ *
 * 2. HTTP: a rota manda o tema cru para o ACE-Step (stub da API)
 * ------------------------------------------------------------------ */

const stub = await startStub();
const server = await startServer({
  MUSICGPT_MUSIC_PROVIDER: 'acestep',
  ACESTEP_API_KEY: 'stub-chave-123456',
  ACESTEP_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
  ACESTEP_MODEL: 'acemusic/acestep-v1.5-turbo',
  ACESTEP_DURATION_FACTOR: '1',
});

try {
  // 2a. tema no campo -> Natural Language (sample_query, sem <lyrics>)
  const comTema = await gerar(server.url, { prompt: 'MPB melancólica com violão', lyrics: TEMA });
  const pedido = stub.last();
  check('http: o pedido ao ACE-Step traz sample_mode ligado',
    pedido.sample_mode === true, String(pedido.sample_mode));
  check('http: o pedido traz o TEMA cru como sample_query',
    pedido.sample_query === TEMA, JSON.stringify(pedido.sample_query));
  check('http: o pedido NAO leva <lyrics> (nada foi expandido antes)',
    !String(pedido.messages[0].content).includes('<lyrics>'),
    JSON.stringify(String(pedido.messages[0].content).slice(0, 120)));
  check('http: a faixa guarda a LETRA que o LM escreveu (## Lyrics)',
    comTema.lyrics.trim() === LETRA_DO_LM, JSON.stringify(comTema.lyrics.slice(0, 80)));
  check('http: o engine da letra e o acestep-lm (nao local-templates)',
    comTema.lyricsEngine === 'acestep-lm', String(comTema.lyricsEngine));
  check('http: a faixa guarda o tema original e a marca como expandido',
    comTema.lyricsTheme === TEMA && comTema.lyricsExpanded === true,
    JSON.stringify({ theme: comTema.lyricsTheme, expanded: comTema.lyricsExpanded }));
  check('http: o aviso de Natural Language vem junto',
    (comTema.warnings || []).some((w) => /Natural Language/i.test(w)),
    JSON.stringify(comTema.warnings));
  check('http: a faixa NAO tem aviso de gerador local (tema nao passou por ele)',
    !(comTema.warnings || []).some((w) => /gerador local/i.test(w)),
    JSON.stringify(comTema.warnings));

  // 2b. letra completa escrita pelo usuario -> respeitada (vai em <lyrics>)
  const comLetra = await gerar(server.url, { prompt: 'MPB melancólica com violão', lyrics: LETRA_ESCRITA });
  const pedidoLetraHttp = stub.last();
  const blocoLyrics = String(pedidoLetraHttp.messages[0].content)
    .match(/<lyrics>([\s\S]*?)<\/lyrics>/)?.[1] || '';
  check('http: letra completa -> o pedido leva <lyrics> com o texto do usuario',
    mesmaLetra(blocoLyrics, LETRA_ESCRITA) && tagsCanonicas(blocoLyrics),
    JSON.stringify(String(pedidoLetraHttp.messages[0].content).slice(-80)));
  check('http: letra completa -> sem sample_mode (o LM nao reescreve)',
    pedidoLetraHttp.sample_mode === undefined && pedidoLetraHttp.sample_query === undefined,
    JSON.stringify({ sample_mode: pedidoLetraHttp.sample_mode, sample_query: pedidoLetraHttp.sample_query }));
  check('http: a faixa guarda a letra do usuario intacta (conteudo intacto, formatado pelo pipeline)',
    mesmaLetra(comLetra.lyrics, LETRA_ESCRITA) && tagsCanonicas(comLetra.lyrics)
    && comLetra.lyricsExpanded === false,
    JSON.stringify(comLetra.lyrics.slice(0, 60)));

  // 2c. instrumental -> tema nao vira sample_query
  const instrumental = await gerar(server.url, { prompt: 'MPB melancólica com violão', lyrics: TEMA, instrumental: true });
  const pedidoInst = stub.last();
  check('http: instrumental -> sem sample_mode/sample_query no pedido',
    pedidoInst.sample_mode === undefined && pedidoInst.sample_query === undefined,
    JSON.stringify({ sample_mode: pedidoInst.sample_mode, sample_query: pedidoInst.sample_query }));
  check('http: instrumental -> faixa sem letra e sem expansao',
    instrumental.lyrics === '' && instrumental.lyricsExpanded === false,
    JSON.stringify({ lyrics: instrumental.lyrics, expanded: instrumental.lyricsExpanded }));

  // 2d. campo vazio -> sample_mode classico (LM planeja do caption)
  const semLetra = await gerar(server.url, { prompt: 'MPB melancólica com violão e saxofone' });
  const pedidoVazioHttp = stub.last();
  check('http: campo vazio -> sample_mode ligado e sem sample_query',
    pedidoVazioHttp.sample_mode === true && pedidoVazioHttp.sample_query === undefined,
    JSON.stringify({ sample_mode: pedidoVazioHttp.sample_mode, sample_query: pedidoVazioHttp.sample_query }));
  check('http: campo vazio -> a faixa guarda a letra vinda do LM',
    semLetra.lyrics.trim() === LETRA_DO_LM && semLetra.lyricsEngine === 'acestep-lm',
    JSON.stringify({ lyrics: semLetra.lyrics.slice(0, 40), engine: semLetra.lyricsEngine }));
} finally {
  server.child.kill('SIGKILL');
  fs.rmSync(server.dataDir, { recursive: true, force: true, maxAttempts: 3 });
  await stub.close();
}

/* ------------------------------------------------------------------ *
 * 3. Live (opcional): letra do LM x gerador local de templates
 * ------------------------------------------------------------------ */

if (LIVE) {
  const live = await startServer({
    MUSICGPT_MUSIC_PROVIDER: 'acestep',
    ACESTEP_MODEL: 'acemusic/acestep-v1.5-turbo',
    ACESTEP_DURATION_FACTOR: '1',
  });
  try {
    const faixa = await gerar(live.url, { prompt: 'MPB melancólica com violão', lyrics: TEMA, duration: 40 });

    const local = generateLocalLyrics({ prompt: TEMA, lang: 'pt', style: 'MPB', seed: 7 });

    const metricas = (texto) => {
      const linhas = String(texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
      const cantaveis = linhas.filter((l) => !/^\[.+\]$/.test(l));
      return {
        linhas: cantaveis.length,
        distintas: new Set(cantaveis).size,
        taxaduplicata: cantaveis.length ? 1 - (new Set(cantaveis).size / cantaveis.length) : 0,
        tags: /\[[A-Za-z]/.test(texto),
        // fidelidade ao TEMA: palavras-chave do tema presentes na letra
        fidelidade: KEYWORDS_TEMA.filter((k) => String(texto || '').toLowerCase().includes(k)).length,
      };
    };

    const mLM = metricas(faixa.lyrics);
    const mLocal = metricas(local.text);

    console.log('\n===== COMPARACAO DE LETRA (mesmo tema) =====');
    console.log(`TEMA: ${TEMA}\n`);
    console.log(`--- LETRA DO LM DO ACE-Step (engine: ${faixa.lyricsEngine}) ---\n${faixa.lyrics || '(VAZIA)'}\n`);
    console.log(`--- LETRA DO GERADOR LOCAL (templates) ---\n${local.text}\n`);
    console.log(`metricas  LM   : ${JSON.stringify(mLM)}`);
    console.log(`metricas  local: ${JSON.stringify(mLocal)}`);
    console.log('(qualidade e uma medicao, nao um check: compare as duas letras acima)');
    console.log('(esperado medido: o LM do ACE-Step IGNORA o tema - 0 keywords em 7 geracoes)\n');

    // checks mecanicos (deterministicos): a rota usou Natural Language e
    // gerou a faixa. A qualidade da letra e IMRESSA acima, nao e check -
    // medimos que o LM do ACE-Step nao ancora no tema.
    check('live: a faixa foi gerada com o tema em modo Natural Language',
      faixa.lyricsExpanded === true && faixa.lyricsTheme === TEMA
      && (faixa.warnings || []).some((w) => /Natural Language/i.test(w)),
      JSON.stringify({ theme: faixa.lyricsTheme, expanded: faixa.lyricsExpanded, warnings: faixa.warnings }));
    check('live: nada passou pelo gerador local (sem aviso dele)',
      !(faixa.warnings || []).some((w) => /gerador local/i.test(w)),
      JSON.stringify(faixa.warnings));
    check('live: engine da letra foi o do ACE-Step (acestep-lm) ou vazio (LM nao devolveu)',
      faixa.lyricsEngine === 'acestep-lm' || faixa.lyrics === '',
      JSON.stringify({ engine: faixa.lyricsEngine, letras: faixa.lyrics.length }));
    check('live: a letra do LM (quando vem) NAO e o tema repetido',
      faixa.lyrics.trim() !== TEMA && !faixa.lyrics.includes(TEMA),
      JSON.stringify(faixa.lyrics.slice(0, 80)));
  } finally {
    live.child.kill('SIGKILL');
    fs.rmSync(live.dataDir, { recursive: true, force: true, maxAttempts: 3 });
  }
} else {
  console.log('(camada live pulada - rode com MUSICGPT_TESTE_LIVE=1 para comparar com o gerador local)');
}

process.exit(report.summary() ? 1 : 0);
