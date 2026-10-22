/**
 * Teste do modo do audio anexado: REFERENCIA DE ESTILO (remix) x COVER
 * (manter a melodia original).
 *
 * Regra testada:
 *  - `audioMode: "reference"` -> o arquivo vira referencia de estilo
 *    (`task_type: "text2music"`, `audio_cover_strength` ~0.3).
 *  - `audioMode: "cover"`     -> o arquivo vira o audio de origem
 *    (`task_type: "cover"`, `audio_cover_strength` ~0.85) e o modelo tenta
 *    manter a melodia/estrutura originais.
 *
 * Camadas:
 *  1. Contrato - o corpo do pedido do ACE-Step muda conforme o modo.
 *  2. HTTP - a rota guarda o modo na faixa (audioMode + tag "modo: ...").
 *  3. Navegador - o seletor funciona, o pedido manda o modo e o card mostra
 *     a tag do modo; o layout mobile nao quebra.
 *
 * Uso:
 *   node scripts/testar-modo-audio.mjs
 *   MUSICGPT_TESTE_LIVE=1 node scripts/testar-modo-audio.mjs
 *     (gera de verdade no ACE-Step - gasta cota)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { launchChrome, realClick, screenshot, createReporter } from './lib/cdp.mjs';
import { buildRequestBody, normalizeAudioMode } from '../server/providers/acestep.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.env.MUSICGPT_TESTE_LIVE === '1';

const report = createReporter();
const { check } = report;

const ESTILO = 'rock anos 90 com guitarra pesada';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** WAV PCM 16 bits mono (servindo de audio de referencia). */
function makeWav(seconds = 3, sampleRate = 8000, freq = 440) {
  const frames = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.4 * 32767), i * 2);
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicgpt-modo-data-'));
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
 * 1. Contrato: o corpo do pedido muda conforme o modo
 * ------------------------------------------------------------------ */

const refAudio = { base64: 'QUFBQQ==', format: 'wav', name: 'ref.wav', size: 8 };

const pedidoReferencia = buildRequestBody({
  prompt: ESTILO,
  lyrics: '',
  style: ESTILO,
  styleFromText: true,
  options: { duration: 30, genreLabel: 'Pop', referenceAudio: refAudio, audioMode: 'reference' },
});
check('modo referencia: task_type text2music',
  pedidoReferencia.task_type === 'text2music', String(pedidoReferencia.task_type));
check('modo referencia: audio_cover_strength baixo (estilo, ~0.3)',
  pedidoReferencia.audio_cover_strength > 0 && pedidoReferencia.audio_cover_strength <= 0.4,
  String(pedidoReferencia.audio_cover_strength));
check('modo referencia: o audio vai no bloco multimodal input_audio',
  Array.isArray(pedidoReferencia.messages[0].content)
  && pedidoReferencia.messages[0].content[1]?.type === 'input_audio',
  JSON.stringify(pedidoReferencia.messages[0].content?.[1]?.type));

const pedidoCover = buildRequestBody({
  prompt: ESTILO,
  lyrics: '',
  style: ESTILO,
  styleFromText: true,
  options: { duration: 30, genreLabel: 'Pop', referenceAudio: refAudio, audioMode: 'cover' },
});
check('modo cover: task_type cover',
  pedidoCover.task_type === 'cover', String(pedidoCover.task_type));
check('modo cover: audio_cover_strength 0.85 (mantem a melodia)',
  Math.abs(pedidoCover.audio_cover_strength - 0.85) < 0.001,
  String(pedidoCover.audio_cover_strength));
check('modo cover: o audio de origem vai no bloco multimodal input_audio',
  Array.isArray(pedidoCover.messages[0].content)
  && pedidoCover.messages[0].content[1]?.type === 'input_audio'
  && pedidoCover.messages[0].content[1]?.input_audio?.data === 'QUFBQQ==',
  JSON.stringify(pedidoCover.messages[0].content?.[1]?.input_audio || null));
check('modo cover: o LM e desligado (a API pula o LM em cover)',
  pedidoCover.thinking === false, String(pedidoCover.thinking));

const pedidoCoverComLetra = buildRequestBody({
  prompt: ESTILO,
  lyrics: '[Verse 1]\nteste',
  style: ESTILO,
  styleFromText: true,
  options: { duration: 30, genreLabel: 'Pop', referenceAudio: refAudio, audioMode: 'cover' },
});
check('modo cover: nao entra em sample_mode (a letra nao e inventada)',
  pedidoCoverComLetra.sample_mode === undefined, String(pedidoCoverComLetra.sample_mode));

const pedidoSemAudio = buildRequestBody({
  prompt: ESTILO,
  lyrics: '',
  style: ESTILO,
  styleFromText: true,
  options: { duration: 30, genreLabel: 'Pop', audioMode: 'cover' },
});
check('sem audio anexado: nenhum task_type no pedido (texto puro)',
  pedidoSemAudio.task_type === undefined && pedidoSemAudio.audio_cover_strength === undefined,
  String(pedidoSemAudio.task_type));

check('normalizeAudioMode: "cover" vira cover', normalizeAudioMode('cover') === 'cover');
check('normalizeAudioMode: "reference" vira reference', normalizeAudioMode('reference') === 'reference');
check('normalizeAudioMode: valor desconhecido vira reference',
  normalizeAudioMode('banana') === 'reference' && normalizeAudioMode(undefined) === 'reference');

/* ------------------------------------------------------------------ *
 * 2. HTTP: a rota guarda o modo na faixa
 * ------------------------------------------------------------------ */

const server = await startServer({ MUSICGPT_MUSIC_PROVIDER: 'local' });

try {
  const wav = makeWav();
  const form = (campos) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(campos)) f.append(k, String(v));
    f.append('referenceAudio', new Blob([wav], { type: 'audio/wav' }), 'minha-referencia.wav');
    return f;
  };

  const resCover = await fetch(`${server.url}/api/generate`, {
    method: 'POST',
    body: form({ prompt: ESTILO, style: ESTILO, audioMode: 'cover', duration: 25, instrumental: 'true' }),
  });
  const jobCover = await waitJob(server.url, (await resCover.json()).jobId);
  check('HTTP com cover: o job termina sem erro', jobCover.status === 'done', jobCover.error || '');
  check('HTTP com cover: a faixa guarda o modo cover',
    jobCover.track?.audioMode === 'cover', JSON.stringify(jobCover.track?.audioMode));
  check('HTTP com cover: a tag "modo: cover" aparece',
    (jobCover.track?.tags || []).includes('modo: cover'), JSON.stringify(jobCover.track?.tags));

  const resRef = await fetch(`${server.url}/api/generate`, {
    method: 'POST',
    body: form({ prompt: ESTILO, style: ESTILO, audioMode: 'reference', duration: 25, instrumental: 'true' }),
  });
  const jobRef = await waitJob(server.url, (await resRef.json()).jobId);
  check('HTTP com referencia: a faixa guarda o modo reference',
    jobRef.track?.audioMode === 'reference', JSON.stringify(jobRef.track?.audioMode));
  check('HTTP com referencia: a tag "modo: estilo" aparece',
    (jobRef.track?.tags || []).includes('modo: estilo'), JSON.stringify(jobRef.track?.tags));

  const resSemModo = await fetch(`${server.url}/api/generate`, {
    method: 'POST',
    body: form({ prompt: ESTILO, duration: 25, instrumental: 'true' }),
  });
  const jobSemModo = await waitJob(server.url, (await resSemModo.json()).jobId);
  check('HTTP sem audioMode: o padrao e referencia (estilo)',
    jobSemModo.track?.audioMode === 'reference', JSON.stringify(jobSemModo.track?.audioMode));

  const resSemAudio = await fetch(`${server.url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: ESTILO, duration: 25, instrumental: true }),
  });
  const jobSemAudio = await waitJob(server.url, (await resSemAudio.json()).jobId);
  check('HTTP sem audio anexado: a faixa fica sem modo',
    jobSemAudio.track?.audioMode === null, JSON.stringify(jobSemAudio.track?.audioMode));
} finally {
  server.child.kill('SIGKILL');
  fs.rmSync(server.dataDir, { recursive: true, force: true, maxAttempts: 3 });
}

/* ------------------------------------------------------------------ *
 * 3. Navegador: seletor, pedido e card
 * ------------------------------------------------------------------ */

const refDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicgpt-modo-ref-'));
const refFile = path.join(refDir, 'minha-referencia.wav');
fs.writeFileSync(refFile, makeWav(3));

const appServer = await startServer(LIVE
  ? { MUSICGPT_MUSIC_PROVIDER: 'acestep' }
  : { MUSICGPT_MUSIC_PROVIDER: 'local' });

const browser = await launchChrome({ port: 9336 });

try {
  console.log(`${report.colors.y}abrindo ${appServer.url} (motor: ${LIVE ? 'ACE-Step' : 'local'})${report.colors.x}`);
  await browser.cdp.send('Page.navigate', { url: appServer.url });
  await delay(2500);

  // ---------- 3.1 o seletor de modo existe ----------
  const seletor = await browser.cdp.eval(`(() => {
    const inputs = Array.from(document.querySelectorAll('input[name="audioMode"]'));
    return {
      quantidade: inputs.length,
      opcoes: inputs.map((i) => i.value),
      marcado: inputs.filter((i) => i.checked).map((i) => i.value),
      visivelSemArquivo: !!document.querySelector('#refAudioBox') && !document.querySelector('#refAudioBox').hidden,
    };
  })`);
  check('navegador: o seletor tem as duas opcoes (reference e cover)',
    seletor.quantidade === 2 && seletor.opcoes.includes('reference') && seletor.opcoes.includes('cover'),
    JSON.stringify(seletor.opcoes));
  check('navegador: o padrao e "reference" (estilo/remix)',
    seletor.marcado.length === 1 && seletor.marcado[0] === 'reference', JSON.stringify(seletor.marcado));

  // ---------- 3.2 anexa o audio e escolhe o modo cover ----------
  const doc = await browser.cdp.send('DOM.getDocument');
  const { nodeId } = await browser.cdp.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: '#referenceAudioInput',
  });
  await browser.cdp.send('DOM.setFileInputFiles', { files: [refFile], nodeId });
  await browser.cdp.eval(`(() => {
    document.querySelector('#referenceAudioInput').dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })`);
  await delay(400);

  const comArquivo = await browser.cdp.eval(`(() => ({
    visivel: !document.querySelector('#refAudioBox').hidden,
    nome: document.querySelector('#refAudioName').textContent,
    modos: document.querySelectorAll('.audio-mode').length,
  }))`);
  check('navegador: o seletor de modo aparece com o audio anexado',
    comArquivo.visivel && comArquivo.modos === 2, JSON.stringify(comArquivo));

  await browser.cdp.eval(`(() => {
    const input = document.querySelector('input[name="audioMode"][value="cover"]');
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })`);
  await delay(300);

  const marcado = await browser.cdp.eval(`(() => ({
    marcado: document.querySelector('input[name="audioMode"]:checked')?.value || null,
    estado: window.__modoAudio ?? null,
    box: document.querySelector('#refAudioBox').dataset.mode || null,
    titulo: document.querySelector('#btnAddAudio').title,
  }))`);
  check('navegador: escolher "cover" marca o radio e guarda o modo',
    marcado.marcado === 'cover' && marcado.box === 'cover', JSON.stringify(marcado));
  check('navegador: o botao de audio avisa que agora e cover',
    /cover/i.test(marcado.titulo), marcado.titulo);

  // ---------- 3.3 preenche o estilo e clica em Criar ----------
  await browser.cdp.eval(`(() => {
    const campo = document.querySelector('#prompt');
    campo.value = ${JSON.stringify(ESTILO)};
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })`);

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
      const c = document.querySelector('#doneCard');
      return {
        pronto: !!done && !done.hidden,
        tags: c ? Array.from(c.querySelectorAll('.tag')).map((t) => t.textContent.trim()) : [],
      };
    })`);
    if (card.pronto) break;
    await delay(700);
  }

  check('navegador: a faixa foi gerada e o card aparece', Boolean(card && card.pronto),
    card ? JSON.stringify(card.tags) : 'timeout');
  if (card && card.pronto) {
    check('navegador: o card mostra a tag "modo: cover"',
      card.tags.includes('modo: cover'), JSON.stringify(card.tags));
    check('navegador: o card mostra o texto de estilo exato',
      card.tags.includes(ESTILO), JSON.stringify(card.tags));
  }

  const enviado = await browser.cdp.eval(`(() => window.__capturado || [])`);
  const campos = enviado[0]?.campos || {};
  check('navegador: o pedido manda audioMode=cover',
    campos.audioMode === 'cover', `audioMode=${JSON.stringify(campos.audioMode)}`);
  check('navegador: o pedido manda o audio anexado',
    /\[arquivo:minha-referencia\.wav\]/.test(String(campos.referenceAudio)),
    String(campos.referenceAudio));

  // ---------- 3.4 layout mobile ----------
  await browser.cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  });
  await delay(700);

  const mobile = await browser.cdp.eval(`(() => {
    const box = document.querySelector('#refAudioBox');
    const opcoes = Array.from(document.querySelectorAll('.audio-mode')).map((el) => {
      const r = el.getBoundingClientRect();
      return { largura: r.width, altura: r.height, visivel: r.width > 0 && r.height > 0 };
    });
    const radio = document.querySelector('input[name="audioMode"]');
    const rr = radio.getBoundingClientRect();
    return {
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      boxVisivel: box && !box.hidden,
      opcoes,
      radioVisivel: rr.width > 0 && rr.height > 0,
      viewport: window.innerWidth,
    };
  })`);
  check('mobile: sem overflow horizontal', mobile.overflowX <= 1, `overflow=${mobile.overflowX}px`);
  check('mobile: o seletor de modo continua visivel',
    mobile.boxVisivel && mobile.opcoes.every((o) => o.visivel), JSON.stringify(mobile.opcoes));
  check('mobile: o radio do modo e clicavel (tamanho minimo)',
    mobile.radioVisivel, JSON.stringify(mobile));

  await browser.cdp.send('Emulation.clearDeviceMetricsOverride');
  await delay(300);
  await browser.cdp.eval(`(() => {
    const c = document.querySelector('#doneCard');
    if (c) c.scrollIntoView({ block: 'center' });
    return true;
  })`);
  await delay(400);
  await screenshot(browser.cdp, path.join(os.tmpdir(), 'musicgpt-modo-audio.png'));

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

console.log(`\n${report.colors.d}screenshot: ${path.join(os.tmpdir(), 'musicgpt-modo-audio.png')}${report.colors.x}`);
process.exit(report.summary() ? 1 : 0);
