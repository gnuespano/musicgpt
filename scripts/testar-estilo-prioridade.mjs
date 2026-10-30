/**
 * Teste da prioridade do campo "Estilos" (texto) sobre os botoes de genero.
 *
 * Regra testada: o TEXTO digitado tem prioridade ABSOLUTA. Quando ele
 * existe, o genero dos chips (Pop, MPB, ...) e ignorado - no pedido, na
 * caption enviada ao ACE-Step e nas tags da faixa. Sem texto, o botao
 * selecionado entra como fallback.
 *
 * Tres camadas:
 *  1. Contrato - a caption do ACE-Step usa o texto digitado (sem "Pop
 *     style"); sem texto, ela usa o genero do botao.
 *  2. HTTP - a rota /api/generate guarda o texto como estilo da faixa
 *     (style/styleLabel/styleSource/tags) e ignora o genero do botao.
 *  3. Navegador - com o audio de referencia anexado, digitar o estilo e
 *     clicar em "Criar" mostra no card a tag de referencia e o texto exato
 *     digitado, sem o "Pop" do botao. Os chips tambem ficam visualmente
 *     desativados enquanto o texto existe.
 *
 * Uso:
 *   node scripts/testar-estilo-prioridade.mjs
 *     (motor procedural local: rapido, sem cota de API)
 *   MUSICGPT_TESTE_LIVE=1 node scripts/testar-estilo-prioridade.mjs
 *     (gera de verdade no ACE-Step com audio de referencia - gasta cota)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { launchChrome, realClick, screenshot, createReporter } from './lib/cdp.mjs';
import { buildRequestBody, buildCaption } from '../server/providers/acestep.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.env.MUSICGPT_TESTE_LIVE === '1';

const report = createReporter();
const { check } = report;

/** Texto de estilo usado no teste (o que o usuario digita). */
const ESTILO = 'Modern talking, cherry cherry lady';


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

/** WAV PCM 16 bits mono (servindo de audio de referencia). */
function makeWav(seconds = 2, sampleRate = 8000, freq = 440) {
  const frames = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.4;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicgpt-estilo-data-'));
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

/** Espera o job terminar e devolve o estado final. */
async function waitJob(url, jobId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${url}/api/jobs/${jobId}`);
    const data = await res.json();
    if (data.status === 'done' || data.status === 'error') return data;
    await delay(400);
  }
  throw new Error(`job ${jobId} nao terminou a tempo`);
}

/* ------------------------------------------------------------------ *
 * 1. Contrato: a caption do ACE-Step respeita a prioridade
 * ------------------------------------------------------------------ */

const comTexto = buildRequestBody({
  prompt: ESTILO,
  lyrics: '',
  style: ESTILO,
  styleFromText: true,
  options: { duration: 30, genreLabel: 'Pop', moodLabel: 'alegre' },
});
const captionTexto = comTexto.messages[0].content;

check('texto do usuario: a caption usa o texto digitado',
  captionTexto.includes(ESTILO), captionTexto);
check('texto do usuario: o genero do botao ("Pop") nao entra na caption',
  !/pop/i.test(captionTexto), captionTexto);
check('texto do usuario: o genero nao e acrescentado como "X style"',
  !/\w+ style/i.test(captionTexto), captionTexto);

const semTexto = buildRequestBody({
  prompt: 'batida sintetica leve',
  lyrics: '',
  style: 'Pop',
  options: { duration: 30, genreLabel: 'Pop', moodLabel: 'alegre' },
});
check('sem texto: o genero do botao entra como fallback ("Pop style")',
  /Pop style/i.test(semTexto.messages[0].content), semTexto.messages[0].content);

check('caption sem prompt e sem estilo nao quebra',
  typeof buildCaption({ prompt: '', style: '', styleFromText: true }) === 'string',
  buildCaption({ prompt: '', style: '', styleFromText: true }));

const comTextoEReferencia = buildRequestBody({
  prompt: ESTILO,
  lyrics: '',
  style: ESTILO,
  styleFromText: true,
  options: {
    duration: 30,
    genreLabel: 'Pop',
    referenceAudio: { base64: 'QUFBQQ==', format: 'wav', name: 'ref.wav', size: 8 },
  },
});
const conteudoRef = comTextoEReferencia.messages[0].content;
check('texto + audio de referencia: o prompt nao ganha o genero do botao',
  Array.isArray(conteudoRef) && !/pop/i.test(conteudoRef[0]?.text || ''),
  Array.isArray(conteudoRef) ? conteudoRef[0]?.text : String(conteudoRef));
check('texto + audio de referencia: o bloco input_audio continua no pedido',
  Array.isArray(conteudoRef) && conteudoRef[1]?.type === 'input_audio',
  Array.isArray(conteudoRef) ? conteudoRef[1]?.type : 'nao-multimodal');

/* ------------------------------------------------------------------ *
 * 2. HTTP: a rota guarda o texto como estilo da faixa
 * ------------------------------------------------------------------ */

const server = await startServer({ MUSICGPT_MUSIC_PROVIDER: 'local' });

try {
  const comEstilo = await fetch(`${server.url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: ESTILO,
      style: ESTILO,
      genre: 'pop',
      duration: 25,
      instrumental: true,
    }),
  });
  const jobEstilo = await waitJob(server.url, (await comEstilo.json()).jobId);
  check('HTTP com texto: o job termina sem erro', jobEstilo.status === 'done', jobEstilo.error || '');
  check('HTTP com texto: a faixa guarda o texto digitado como estilo',
    jobEstilo.track?.style === ESTILO, JSON.stringify(jobEstilo.track?.style));
  check('HTTP com texto: o rotulo exibido no card e o texto digitado',
    jobEstilo.track?.styleLabel === ESTILO, JSON.stringify(jobEstilo.track?.styleLabel));
  check('HTTP com texto: a origem do estilo e o texto (nao o botao)',
    jobEstilo.track?.styleSource === 'text', JSON.stringify(jobEstilo.track?.styleSource));
  check('HTTP com texto: a primeira tag da faixa e o texto digitado',
    jobEstilo.track?.tags?.[0] === ESTILO, JSON.stringify(jobEstilo.track?.tags));

  const semEstilo = await fetch(`${server.url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'batida sintetica leve',
      genre: 'mpb',
      duration: 25,
      instrumental: true,
    }),
  });
  const jobSemEstilo = await waitJob(server.url, (await semEstilo.json()).jobId);
  check('HTTP sem texto: o genero do botao entra como fallback',
    jobSemEstilo.track?.style === 'MPB' && jobSemEstilo.track?.styleSource === 'genre',
    `${jobSemEstilo.track?.style} / ${jobSemEstilo.track?.styleSource}`);
} finally {
  server.child.kill('SIGKILL');
  fs.rmSync(server.dataDir, { recursive: true, force: true, maxAttempts: 3 });
}

/* ------------------------------------------------------------------ *
 * 3. Navegador: audio de referencia + texto de estilo + "Criar"
 * ------------------------------------------------------------------ */

const refDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicgpt-estilo-ref-'));
const refFile = path.join(refDir, 'minha-referencia.wav');
fs.writeFileSync(refFile, makeWav(3));

const appServer = await startServer(LIVE
  ? { MUSICGPT_MUSIC_PROVIDER: 'acestep' }
  : { MUSICGPT_MUSIC_PROVIDER: 'local' });

const browser = await launchChrome({ port: 9334 });

try {
  console.log(`${report.colors.y}abrindo ${appServer.url} (motor: ${LIVE ? 'ACE-Step' : 'local'})${report.colors.x}`);
  await browser.cdp.send('Page.navigate', { url: appServer.url });
  await delay(2500);

  // ---------- 3.1 anexa o audio de referencia ----------
  const doc = await browser.cdp.send('DOM.getDocument');
  const { nodeId } = await browser.cdp.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: '#referenceAudioInput',
  });
  await browser.cdp.send('DOM.setFileInputFiles', { files: [refFile], nodeId });
  await browser.cdp.eval(`(() => {
    const input = document.querySelector('#referenceAudioInput');
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })`);
  await delay(400);

  const refAnexado = await browser.cdp.eval(`(() => ({
    visivel: !document.querySelector('#refAudioBox').hidden,
    nome: document.querySelector('#refAudioName').textContent,
  }))`);
  check('navegador: o audio de referencia aparece anexado',
    refAnexado.visivel && refAnexado.nome === 'minha-referencia.wav',
    JSON.stringify(refAnexado));

  // ---------- 3.2 digita o estilo e confere o feedback visual ----------
  await browser.cdp.eval(`(() => {
    const campo = document.querySelector('#prompt');
    campo.value = ${JSON.stringify(ESTILO)};
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })`);
  // A opacidade dos chips tem uma transicao CSS de 140 ms. Uma espera
  // fixa pode ler o valor no MEIO da animacao (ou antes do primeiro
  // frame renderizado), dando falso negativo. Aqui esperamos a transicao
  // assentar (ou 40 frames) e so entao medimos.
  await browser.cdp.eval(`(() => new Promise((resolve) => {
    const chip = document.querySelector('#genreChips .chip');
    let tries = 0;
    const tick = () => {
      tries += 1;
      if (Number(getComputedStyle(chip).opacity) < 0.6 || tries > 40) resolve(true);
      else requestAnimationFrame(tick);
    };
    tick();
  }))`);
  await delay(120);

  const visual = await browser.cdp.eval(`(() => {
    const chips = document.querySelector('#genreChips');
    const chip = chips.querySelector('.chip');
    const hint = document.querySelector('#styleHint');
    return {
      sobreposto: chips.classList.contains('is-overridden'),
      chipOff: chip.classList.contains('is-off'),
      opacidade: Number(getComputedStyle(chip).opacity),
      hintVisivel: !hint.hidden,
      hint: hint.textContent,
    };
  })`);
  check('navegador: os botoes de genero ficam visualmente desativados',
    visual.sobreposto && visual.chipOff && visual.opacidade < 0.6,
    `opacidade=${visual.opacidade}`);
  check('navegador: aparece o aviso de que o texto tem prioridade',
    visual.hintVisivel && /prioridade/i.test(visual.hint), visual.hint);

  // ---------- 3.3 clica em "Criar" e espera o card ----------
  // captura o que vai para o backend
  await browser.cdp.eval(`(() => {
    window.__capturado = [];
    const original = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = String(input && input.url ? input.url : input);
        if (url.includes('/api/generate')) {
          const reg = { url, campos: null };
          const body = init && init.body;
          if (body && typeof FormData !== 'undefined' && body instanceof FormData) {
            reg.campos = {};
            for (const [k, v] of body.entries()) {
              reg.campos[k] = (typeof v === 'string') ? v : ('[arquivo:' + (v && v.name) + ']');
            }
          } else if (typeof body === 'string') {
            reg.campos = JSON.parse(body);
          }
          window.__capturado.push(reg);
        }
      } catch (e) { /* ignora */ }
      return original.apply(this, arguments);
    };
    return true;
  })`);

  await realClick(browser.cdp, '#btnGenerate');

  const deadline = Date.now() + (LIVE ? 600000 : 120000);
  let card = null;
  while (Date.now() < deadline) {
    card = await browser.cdp.eval(`(() => {
      const done = document.querySelector('#statusDone');
      const card = document.querySelector('#doneCard');
      const running = document.querySelector('#statusRunning');
      const vazio = document.querySelector('#statusEmpty');
      return {
        pronto: !!done && !done.hidden,
        erro: !vazio || !vazio.hidden ? (vazio && !vazio.hidden ? document.querySelector('#statusEmpty').textContent.trim().slice(0, 200) : '') : '',
        rodando: !!running && !running.hidden,
        tags: card ? Array.from(card.querySelectorAll('.tag')).map((t) => t.textContent.trim()) : [],
        texto: card ? card.textContent.trim() : '',
      };
    })`);
    if (card.pronto) break;
    const erro = await browser.cdp.eval(`(() => {
      const s = document.querySelector('#statusEmpty');
      return s && !s.hidden ? s.textContent.trim().slice(0, 200) : '';
    })`);
    if (erro) throw new Error(`a geracao falhou: ${erro}`);
    await delay(700);
  }

  check('navegador: a faixa foi gerada e o card aparece', Boolean(card && card.pronto),
    card ? card.texto.slice(0, 160) : 'timeout');

  if (card && card.pronto) {
    check('navegador: o card mostra o texto exato digitado',
      card.tags.some((t) => t === ESTILO), JSON.stringify(card.tags));
    check('navegador: o card nao mostra o "Pop" do botao',
      !card.tags.some((t) => /^pop$/i.test(t)), JSON.stringify(card.tags));
    if (LIVE) {
      check('navegador: o card mostra a tag da referencia',
        card.tags.some((t) => /^ref:\s*minha-referencia\.wav$/i.test(t)),
        JSON.stringify(card.tags));
    } else {
      console.log(`${report.colors.d}(motor local: o audio de referencia e ignorado, a tag "ref:" so aparece no ACE-Step)${report.colors.x}`);
    }
  }

  // ---------- 3.4 o que foi enviado ao backend ----------
  const enviado = await browser.cdp.eval(`(() => window.__capturado || [])`);
  const campos = enviado[0]?.campos || {};
  check('navegador: o pedido NAO manda o genero do botao',
    !campos.genre, `genre=${JSON.stringify(campos.genre)}`);
  check('navegador: o pedido manda o texto digitado como estilo',
    campos.style === ESTILO, `style=${JSON.stringify(campos.style)}`);
  check('navegador: o pedido manda o texto tambem como prompt',
    campos.prompt === ESTILO, `prompt=${JSON.stringify(campos.prompt)}`);
  check('navegador: o audio de referencia vai no pedido',
    /\[arquivo:minha-referencia\.wav\]/.test(String(campos.referenceAudio)),
    String(campos.referenceAudio));

  await browser.cdp.eval(`(() => {
    const card = document.querySelector('#doneCard');
    if (card) card.scrollIntoView({ block: 'center' });
    return true;
  })`);
  await delay(400);
  await screenshot(browser.cdp, path.join(os.tmpdir(), 'musicgpt-estilo-prioridade.png'));

  const erros = browser.cdp.errors.filter((e) => !/favicon|manifest|ServiceWorker|sw\.js/i.test(e));
  check('navegador: nenhum erro de JavaScript na pagina', erros.length === 0, erros.slice(0, 2).join(' | '));
} catch (err) {
  check(`execucao do teste no navegador (${err.message})`, false);
} finally {
  await browser.close();
  appServer.child.kill('SIGKILL');
  fs.rmSync(appServer.dataDir, { recursive: true, force: true, maxAttempts: 3 });
  fs.rmSync(refDir, { recursive: true, force: true, maxAttempts: 3 });
}

console.log(`\n${report.colors.d}screenshot: ${path.join(os.tmpdir(), 'musicgpt-estilo-prioridade.png')}${report.colors.x}`);
process.exit(report.summary() ? 1 : 0);
