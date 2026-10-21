/**
 * Teste do audio de referencia (Audio-to-Audio / Style Transfer).
 *
 * Cobre tres camadas:
 *  1. Unitario - o corpo do pedido do ACE-Step ganha o bloco `input_audio`
 *     quando existe referencia e continua sendo texto puro quando nao existe
 *     (o comportamento padrao "gerar do zero" nao pode mudar).
 *  2. HTTP - a rota /api/generate aceita multipart/form-data com o arquivo
 *     (job criado e concluido) e continua aceitando JSON puro.
 *  3. Erro - arquivo que nao e audio volta 400 com mensagem clara.
 *
 * O teste sobe o proprio servidor (motor procedural local, sem cota de API)
 * numa porta e num diretorio de dados proprios: nada depende do servidor de
 * desenvolvimento nem suja a biblioteca.
 *
 * Uso:
 *   node scripts/testar-audio-referencia.mjs
 *   MUSICGPT_TESTE_LIVE=1 node scripts/testar-audio-referencia.mjs
 *     (gera de verdade no ACE-Step com audio de referencia - gasta cota)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { createReporter } from './lib/cdp.mjs';
import { buildRequestBody } from '../server/providers/acestep.js';
import { detectAudioFormat } from '../server/audio/reference.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.env.MUSICGPT_TESTE_LIVE === '1';

const report = createReporter();
const { check } = report;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** WAV PCM 16 bits mono com uma nota (servindo de audio de referencia). */
function makeWav(seconds = 1, sampleRate = 8000, freq = 440) {
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicgpt-ref-data-'));
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

function formWith(fields, file) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  if (file) {
    form.append('referenceAudio', new Blob([file.buffer], { type: file.type }), file.name);
  }
  return form;
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
 * 1. Unitario: corpo do pedido do ACE-Step
 * ------------------------------------------------------------------ */

const semReferencia = buildRequestBody({
  prompt: 'batida sintetica leve',
  lyrics: '',
  style: 'Pop',
  options: { duration: 30 },
});

check('sem referencia: o content continua sendo texto puro',
  typeof semReferencia.messages[0].content === 'string',
  typeof semReferencia.messages[0].content);
check('sem referencia: nao manda task_type nem audio_cover_strength',
  semReferencia.task_type === undefined && semReferencia.audio_cover_strength === undefined);

const comReferencia = buildRequestBody({
  prompt: 'batida sintetica leve',
  lyrics: '',
  style: 'Pop',
  options: {
    duration: 30,
    referenceAudio: { base64: 'QUFBQQ==', format: 'wav', name: 'ref.wav', size: 8 },
  },
});

const conteudo = comReferencia.messages[0].content;
check('com referencia: o content vira uma lista multimodal', Array.isArray(conteudo),
  Array.isArray(conteudo) ? `${conteudo.length} blocos` : typeof conteudo);
check('com referencia: o primeiro bloco e o texto do prompt',
  conteudo?.[0]?.type === 'text' && /<prompt>/.test(conteudo?.[0]?.text || ''));
check('com referencia: o segundo bloco e input_audio com o audio em base64',
  conteudo?.[1]?.type === 'input_audio'
  && conteudo?.[1]?.input_audio?.data === 'QUFBQQ=='
  && conteudo?.[1]?.input_audio?.format === 'wav',
  JSON.stringify(conteudo?.[1]?.input_audio || null));
check('com referencia: task_type text2music (a referencia vira estilo)',
  comReferencia.task_type === 'text2music', String(comReferencia.task_type));
check('com referencia: audio_cover_strength dentro de 0..1',
  comReferencia.audio_cover_strength > 0 && comReferencia.audio_cover_strength <= 1,
  String(comReferencia.audio_cover_strength));

/* ------------------------------------------------------------------ *
 * 2. Deteccao de formato do arquivo
 * ------------------------------------------------------------------ */

check('formato detectado pela extensao (.wav)', detectAudioFormat('ref.wav', '') === 'wav');
check('formato detectado pelo mime type (audio/mpeg)', detectAudioFormat('ref', 'audio/mpeg') === 'mp3');
check('formato desconhecido cai para mp3', detectAudioFormat('ref.desconhecido', '') === 'mp3');

/* ------------------------------------------------------------------ *
 * 3. HTTP: a rota aceita multipart e continua aceitando JSON
 * ------------------------------------------------------------------ */

const server = await startServer({ MUSICGPT_MUSIC_PROVIDER: 'local' });

try {
  const wav = makeWav();

  // ---- multipart COM audio de referencia ----
  const comAudio = await fetch(`${server.url}/api/generate`, {
    method: 'POST',
    body: formWith({
      prompt: 'batida sintetica leve',
      duration: 25,
      instrumental: 'true',
      lofi: 'false',
    }, { buffer: wav, name: 'minha-referencia.wav', type: 'audio/wav' }),
  });
  const comAudioBody = await comAudio.json();
  check('multipart com audio: a rota responde 202 com jobId',
    comAudio.status === 202 && Boolean(comAudioBody.jobId),
    `status=${comAudio.status}`);

  const jobComAudio = await waitJob(server.url, comAudioBody.jobId);
  check('multipart com audio: o job termina sem erro',
    jobComAudio.status === 'done', jobComAudio.error || jobComAudio.status);
  check('multipart com audio: a faixa guarda o nome do arquivo de referencia',
    jobComAudio.track?.referenceAudio?.name === 'minha-referencia.wav',
    JSON.stringify(jobComAudio.track?.referenceAudio || null));
  check('multipart com audio: o motor local avisa que a referencia exige o ACE-Step',
    Array.isArray(jobComAudio.track?.warnings)
    && jobComAudio.track.warnings.some((w) => /referencia/i.test(w)),
    (jobComAudio.track?.warnings || []).join(' | ') || '(sem avisos)');

  // ---- multipart SEM audio (fallback: gerar do zero) ----
  const semAudio = await fetch(`${server.url}/api/generate`, {
    method: 'POST',
    body: formWith({ prompt: 'batida sintetica leve', duration: 25, instrumental: 'true' }),
  });
  const semAudioBody = await semAudio.json();
  check('multipart sem audio: a rota responde 202 com jobId',
    semAudio.status === 202 && Boolean(semAudioBody.jobId), `status=${semAudio.status}`);

  const jobSemAudio = await waitJob(server.url, semAudioBody.jobId);
  check('multipart sem audio: o job termina sem erro',
    jobSemAudio.status === 'done', jobSemAudio.error || jobSemAudio.status);
  check('multipart sem audio: a faixa fica sem referencia (comportamento padrao)',
    jobSemAudio.track?.referenceAudio === null,
    JSON.stringify(jobSemAudio.track?.referenceAudio ?? null));

  // ---- JSON puro (fluxo antigo) ----
  const jsonRes = await fetch(`${server.url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'batida sintetica leve', duration: 25, instrumental: true, lofi: false }),
  });
  const jsonBody = await jsonRes.json();
  check('JSON puro: a rota continua funcionando',
    jsonRes.status === 202 && Boolean(jsonBody.jobId), `status=${jsonRes.status}`);
  const jobJson = await waitJob(server.url, jsonBody.jobId);
  check('JSON puro: o job termina sem erro',
    jobJson.status === 'done', jobJson.error || jobJson.status);
  check('JSON puro: instrumental=true continua valendo (nao vira "false" textual)',
    jobJson.track?.instrumental === true, String(jobJson.track?.instrumental));
  check('JSON puro: a faixa fica sem referencia',
    jobJson.track?.referenceAudio === null,
    JSON.stringify(jobJson.track?.referenceAudio ?? null));

  // ---- arquivo que nao e audio ----
  const invalido = await fetch(`${server.url}/api/generate`, {
    method: 'POST',
    body: formWith({ prompt: 'teste' }, { buffer: Buffer.from('nao sou audio'), name: 'nota.txt', type: 'text/plain' }),
  });
  const invalidoBody = await invalido.json();
  check('arquivo invalido: a rota responde 400 com mensagem clara',
    invalido.status === 400 && /audio/i.test(invalidoBody.error || ''),
    `${invalido.status} ${invalidoBody.error || ''}`);

  // ---- multipart sem prompt: validacao normal ----
  const semPrompt = await fetch(`${server.url}/api/generate`, {
    method: 'POST',
    body: formWith({ duration: 25 }, { buffer: wav, name: 'ref.wav', type: 'audio/wav' }),
  });
  const semPromptBody = await semPrompt.json();
  check('multipart sem prompt: a validacao continua valendo (400)',
    semPrompt.status === 400 && Boolean(semPromptBody.error), `status=${semPrompt.status}`);
} finally {
  server.child.kill('SIGKILL');
  fs.rmSync(server.dataDir, { recursive: true, force: true, maxAttempts: 3 });
}

/* ------------------------------------------------------------------ *
 * 4. (opcional) geracao real no ACE-Step com audio de referencia
 * ------------------------------------------------------------------ */

if (LIVE) {
  const serverLive = await startServer({ MUSICGPT_MUSIC_PROVIDER: 'acestep' });
  try {
    const wav = makeWav(3);
    const res = await fetch(`${serverLive.url}/api/generate`, {
      method: 'POST',
      body: formWith({
        prompt: 'house otimista com baixo round e hats',
        duration: 30,
        instrumental: 'true',
      }, { buffer: wav, name: 'referencia-live.wav', type: 'audio/wav' }),
    });
    const body = await res.json();
    const job = await waitJob(serverLive.url, body.jobId, 600000);
    check('ACE-Step real: a faixa foi gerada usando o audio de referencia',
      job.status === 'done' && job.track?.referenceAudio?.used === true,
      JSON.stringify(job.track?.referenceAudio || job.error || null));
  } finally {
    serverLive.child.kill('SIGKILL');
    fs.rmSync(serverLive.dataDir, { recursive: true, force: true, maxAttempts: 3 });
  }
} else {
  console.log(`${report.colors.d}(use MUSICGPT_TESTE_LIVE=1 para gerar de verdade no ACE-Step com audio de referencia)${report.colors.x}`);
}

process.exit(report.summary() ? 1 : 0);
