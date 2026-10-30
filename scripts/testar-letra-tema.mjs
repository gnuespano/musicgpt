/**
 * Teste do Bug 2: tema digitado no campo "Letra" vira letra COMPLETA.
 *
 * O problema: o campo "Letra" aceita uma sugestao/tema (o placeholder diz
 * "Escreva a letra de uma musica ou uma sugestao"), mas o backend enviava o
 * texto como se fosse a letra final. Resultado: a MESMA frase curta era
 * cantada em todas as frases da musica (medido: 16 frases identicas).
 *
 * A correcao: `lyricTheme()` em server/lyrics.js detecta quando o texto so
 * tem um tema (sem tags de secao e poucas linhas) e o backend expande o
 * tema em letra completa ANTES de mandar para o motor (IA quando ha chave,
 * senao o gerador local).
 *
 * Tres camadas:
 *  1. Contrato - isCompleteLyric()/lyricTheme() separam tema de letra.
 *  2. HTTP - /api/generate com um tema devolve uma faixa com letra de
 *     verdade (tags de secao, varias linhas) e NAO o tema repetido.
 *  3. Navegador - digitar so o tema e clicar em "Criar" gera a musica com
 *     letra completa; uma letra ja escrita pelo usuario e respeitada.
 *
 * Uso:
 *   node scripts/testar-letra-tema.mjs
 *     (motor procedural local: rapido, sem cota de API)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { launchChrome, realClick, screenshot, createReporter } from './lib/cdp.mjs';
import { isCompleteLyric, lyricTheme } from '../server/lyrics.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const report = createReporter();
const { check } = report;

/** Tema curto, como o usuario digita. */
const TEMA = 'Uma música sobre aceitar que o fim já chegou';

/** Letra completa, com tags de secao. */
const LETRA_ESCRITA = [
  '[Verse 1]',
  'Eu desliguei a luz da cozinha sem pressa',
  'Guardei a xicara no lugar de sempre',
  '',
  '[Chorus]',
  'E o fim chegou devagar, sem cerimonia',
  'Sem barganha, sem pedido, sem saida',
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

/** Sobe o servidor do app e espera ele responder /api/health. */
async function startServer(env = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicgpt-letra-tema-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      MUSICGPT_DATA_DIR: dataDir,
      MUSICGPT_MUSIC_PROVIDER: 'local',
      MUSICGPT_LYRICS_PROVIDER: 'local',
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
 * 1. Contrato: isCompleteLyric / lyricTheme separam tema de letra
 * ------------------------------------------------------------------ */

check('contrato: uma frase curta NAO e letra completa',
  isCompleteLyric(TEMA) === false, TEMA);
check('contrato: o tema e extraido para virar semente',
  lyricTheme(TEMA) === TEMA, lyricTheme(TEMA));
check('contrato: texto vazio nao e tema nem letra',
  isCompleteLyric('') === false && lyricTheme('   ') === '');

const LETRAS_COM_TAGS = [
  LETRA_ESCRITA,
  '[Intro]\nluz baixa\n\n[Verse 1]\nlinha um\nlinha dois\n\n[Chorus]\nrefrao aqui\n',
  '[Verse]\nso uma linha de conteudo\n',
];
LETRAS_COM_TAGS.forEach((letra, i) => {
  check(`contrato: letra ${i + 1} com tags de secao e completa`,
    isCompleteLyric(letra) === true && lyricTheme(letra) === '', JSON.stringify(letra.slice(0, 30)));
});

const LETRA_SEM_TAGS = ['linha um\nlinha dois\nlinha tres\nlinha quatro\nlinha cinco'];
LETRA_SEM_TAGS.forEach((letra, i) => {
  check(`contrato: letra ${i + 1} sem tags mas com 5 linhas e completa`,
    isCompleteLyric(letra) === true, JSON.stringify(letra.slice(0, 30)));
});

// fronteira: 4 linhas sem tag ja e letra; 3 linhas ainda sao tema
check('contrato: 4 linhas sem tag ja contam como letra',
  isCompleteLyric('a\nb\nc\nd') === true && lyricTheme('a\nb\nc\nd') === '');
check('contrato: 3 linhas sem tag continuam sendo tema',
  isCompleteLyric('a\nb\nc') === false && lyricTheme('a\nb\nc') === 'a\nb\nc');
// 1 linha com tag e conteudo junto e letra; tag sozinha (sem conteudo) e tema
check('contrato: tag sozinha sem conteudo ainda e tema',
  isCompleteLyric('[Chorus]') === false && lyricTheme('[Chorus]') === '[Chorus]');
check('contrato: tag com 1 linha de conteudo e letra',
  isCompleteLyric('[Chorus]\nsó o refrão') === true);

// temas de exemplo da varinha (front-end) precisam TODOS virar letra
const TEMAS_DA_VARINHA = [
  'Uma música sobre dirigir na estrada à noite',
  'Uma música sobre um amor perdido no verão',
  'Uma música sobre a coragem de recomeçar do zero',
  'Uma música sobre se perdoar depois de anos de mágoa',
  'Uma música sobre a montanha que você prometeu escalar',
];
check('contrato: todos os temas de exemplo passam como tema (e nao como letra)',
  TEMAS_DA_VARINHA.every((t) => lyricTheme(t) === t),
  JSON.stringify(TEMAS_DA_VARINHA.filter((t) => lyricTheme(t) !== t)));

/* ------------------------------------------------------------------ *
 * 2. HTTP: o tema vira letra antes de virar audio
 * ------------------------------------------------------------------ */

const server = await startServer();

try {
  const comTema = await gerar(server.url, { prompt: TEMA, lyrics: TEMA });
  check('http: a faixa guarda uma letra COMPLETA (vrias linhas)',
    comTema.lyrics.split('\n').filter(Boolean).length >= 8,
    `linhas=${comTema.lyrics.split('\n').filter(Boolean).length}`);
  check('http: a letra tem tags de secao ([Verse], [Chorus]...)',
    /\[[A-Za-z]/.test(comTema.lyrics), comTema.lyrics.slice(0, 60));
  check('http: a letra NAO e o tema digitado',
    comTema.lyrics.trim() !== TEMA && !comTema.lyrics.includes(TEMA),
    JSON.stringify(comTema.lyrics.slice(0, 60)));
  check('http: os vocais cantam linhas DIFERENTES (nao a mesma frase repetida)',
    new Set((comTema.vocals || []).map((v) => v.line)).size >= 3,
    JSON.stringify((comTema.vocals || []).map((v) => v.line).slice(0, 4)));
  check('http: a faixa guarda o tema original digitado',
    comTema.lyricsTheme === TEMA, JSON.stringify(comTema.lyricsTheme));
  check('http: a faixa marca que a letra veio de um tema expandido',
    comTema.lyricsExpanded === true, String(comTema.lyricsExpanded));
  check('http: o engine da letra e registrado',
    Boolean(comTema.lyricsEngine), comTema.lyricsEngine);
  check('http: o aviso de expansao vem junto',
    (comTema.warnings || []).some((w) => /Tema expandido/i.test(w)),
    JSON.stringify(comTema.warnings));

  // sem letra nenhuma: o motor escreve a propria (regressao do caminho normal)
  const semLetra = await gerar(server.url, { prompt: 'MPB melancólica com violão e saxofone' });
  check('http: sem letra o motor gera a propria (nao e tema expandido)',
    semLetra.lyricsExpanded === false && semLetra.lyrics.length > 20,
    JSON.stringify({ expanded: semLetra.lyricsExpanded, len: semLetra.lyrics.length }));

  // letra ja escrita pelo usuario: e respeitada como esta (nao reescrita)
  const letraDoUsuario = await gerar(server.url, { prompt: TEMA, lyrics: LETRA_ESCRITA });
  check('http: uma letra completa escrita pelo usuario e respeitada (conteudo intacto, formatado pelo pipeline)',
    mesmaLetra(letraDoUsuario.lyrics, LETRA_ESCRITA) && tagsCanonicas(letraDoUsuario.lyrics)
    && letraDoUsuario.lyricsExpanded === false,
    JSON.stringify(letraDoUsuario.lyrics.slice(0, 60)));

  // instrumental: tema no campo nao gera vocal nem letra
  const instrumental = await gerar(server.url, { prompt: TEMA, lyrics: TEMA, instrumental: true });
  check('http: no modo instrumental o tema nao vira letra',
    instrumental.lyrics === '' && instrumental.lyricsExpanded === false,
    JSON.stringify({ lyrics: instrumental.lyrics, expanded: instrumental.lyricsExpanded }));

  // OUTRO tema: a expansao nao e especifica de um unico texto
  const OUTRO_TEMA = 'Uma música sobre dirigir na estrada à noite';
  const comOutroTema = await gerar(server.url, { prompt: OUTRO_TEMA, lyrics: OUTRO_TEMA });
  check('http: um segundo tema diferente tambem vira letra completa',
    comOutroTema.lyricsExpanded === true
      && comOutroTema.lyricsTheme === OUTRO_TEMA
      && /\[[A-Za-z]/.test(comOutroTema.lyrics)
      && new Set((comOutroTema.vocals || []).map((v) => v.line)).size >= 3,
    JSON.stringify({ theme: comOutroTema.lyricsTheme, linhas: comOutroTema.lyrics.split('\n').filter(Boolean).length }));
  check('http: os dois temas viraram letras DIFERENTES entre si',
    comOutroTema.lyrics !== comTema.lyrics,
    JSON.stringify(comOutroTema.lyrics.slice(0, 40)));

  /* ---------------------------------------------------------------- *
   * 3. /api/lyrics: a varinha gera letras diferentes por clique
   * ---------------------------------------------------------------- */

  const pedir = (body) => fetch(`${server.url}/api/lyrics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

  const a = await pedir({ prompt: TEMA, mode: 'full', seed: 101 });
  const b = await pedir({ prompt: TEMA, mode: 'full', seed: 202 });
  check('varinha: a rota de letras devolve letra completa',
    a.text && /\[[A-Za-z]/.test(a.text) && a.text.length > 40, String(a.engine));
  check('varinha: seeds diferentes dao letras diferentes (Bug 1)',
    a.text !== b.text, `${JSON.stringify(a.text.slice(0, 30))} vs ${JSON.stringify(b.text.slice(0, 30))}`);

  const repetida = await pedir({ prompt: TEMA, mode: 'full', seed: 101 });
  check('varinha: a mesma seed mantem o determinismo',
    repetida.text === a.text, String(repetida.text === a.text));

  const linha = await pedir({ prompt: TEMA, mode: 'next', seed: 303 });
  check('varinha: o modo "next" (colaboracao) continua funcionando',
    typeof linha.line === 'string' && linha.line.length > 0, JSON.stringify(linha).slice(0, 60));

  const semTema = await fetch(`${server.url}/api/lyrics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '   ', mode: 'full' }),
  });
  check('varinha: sem tema a rota responde 400', semTema.status === 400, String(semTema.status));

  // seed null/vazia cai no padrao (hash do prompt) em vez de virar 0
  const seedNula = await pedir({ prompt: TEMA, mode: 'full', seed: null });
  check('varinha: seed null/vazia nao quebra (cai no padrao do hash)',
    typeof seedNula.text === 'string' && seedNula.text.length > 40, String(seedNula.engine));

  // varios temas de uma vez: cada um vira uma letra completa e DISTINTA
  const TEMAS_VARIOS = [
    'Uma música sobre dirigir na estrada à noite',
    'Uma música sobre um amor perdido no verão',
    'Uma música sobre a coragem de recomeçar do zero',
    'Uma música sobre se perdoar depois de anos de mágoa',
  ];
  const geradas = await Promise.all(
    TEMAS_VARIOS.map((tema, i) => pedir({ prompt: tema, mode: 'full', seed: 900 + i })),
  );
  check('varinha: os 4 temas diferentes viram letras completas com tags',
    geradas.every((l) => l.text && /\[[A-Za-z]/.test(l.text)
      && l.text.split('\n').filter(Boolean).length >= 8),
    JSON.stringify(geradas.map((l) => `${l.text.split('\n').filter(Boolean).length}L`)));
  check('varinha: 4 temas diferentes -> 4 letras diferentes',
    new Set(geradas.map((l) => l.text)).size === TEMAS_VARIOS.length,
    `${new Set(geradas.map((l) => l.text)).size}/${TEMAS_VARIOS.length}`);

  /* ---------------------------------------------------------------- *
   * 4. Navegador: digitar so o tema e clicar em Criar
   * ---------------------------------------------------------------- */

  const browser = await launchChrome({ port: 9343 });

  try {
    console.log(`${report.colors.y}abrindo ${server.url} (motor local, offline)${report.colors.x}`);
    await browser.cdp.send('Page.navigate', { url: server.url });
    await delay(2500);

    // limpa a biblioteca para isolar a faixa do teste
    const antes = (await (await fetch(`${server.url}/api/tracks`)).json()).tracks.length;

    await browser.cdp.eval(`(() => {
      document.querySelector('#prompt').value = 'MPB melancólica com violão e saxofone';
      document.querySelector('#prompt').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#customLyrics').value = ${JSON.stringify(TEMA)};
      return true;
    })`);
    await delay(200);

    await realClick(browser.cdp, '#btnGenerate');

    let card = null;
    for (let i = 0; i < 200; i += 1) {
      card = await browser.cdp.eval(`(() => {
        const done = document.querySelector('#statusDone');
        const vazio = document.querySelector('#statusEmpty');
        const card = document.querySelector('#doneCard');
        return {
          pronto: !!done && !done.hidden,
          erro: vazio && !vazio.hidden ? vazio.textContent.trim().slice(0, 200) : '',
          tags: card ? Array.from(card.querySelectorAll('.tag')).map((t) => t.textContent.trim()) : [],
        };
      })`);
      if (card.pronto) break;
      if (card.erro) throw new Error(`a geracao falhou: ${card.erro}`);
      await delay(700);
    }
    check('navegador: a musica foi gerada a partir do tema', Boolean(card && card.pronto));

    const depois = (await (await fetch(`${server.url}/api/tracks`)).json()).tracks;
    const nova = depois[0];
    check('navegador: a faixa guarda letra completa, nao o tema',
      nova && nova.lyrics.trim() !== TEMA && /\[[A-Za-z]/.test(nova.lyrics),
      JSON.stringify((nova?.lyrics || '').slice(0, 50)));
    check('navegador: os vocais cantam varias linhas diferentes',
      nova && new Set((nova.vocals || []).map((v) => v.line)).size >= 3,
      JSON.stringify((nova?.vocals || []).slice(0, 3).map((v) => v.line)));

    await browser.cdp.eval(`(() => {
      document.querySelector('#doneCard')?.scrollIntoView({ block: 'center' });
      return true;
    })`);
    await delay(400);
    await screenshot(browser.cdp, path.join(os.tmpdir(), 'musicgpt-letra-tema.png'));

    const erros = browser.cdp.errors.filter((e) => !/favicon|manifest|ServiceWorker|sw\.js/i.test(e));
    check('navegador: nenhum erro de JavaScript na pagina', erros.length === 0, erros.slice(0, 2).join(' | '));
  } catch (err) {
    check(`execucao do teste no navegador (${err.message})`, false);
  } finally {
    await browser.close();
  }
} finally {
  server.child.kill('SIGKILL');
  fs.rmSync(server.dataDir, { recursive: true, force: true, maxAttempts: 3 });
}

console.log(`\n${report.colors.d}screenshot: ${path.join(os.tmpdir(), 'musicgpt-letra-tema.png')}${report.colors.x}`);
process.exit(report.summary() ? 1 : 0);
