/**
 * REGRESSAO: o estilo digitado (campo `style`) tem que chegar na caption
 * enviada ao ACE-Step - mesmo quando o cliente manda o TEMA em `prompt` e o
 * ESTILO em `style` (o caso da API publica; no app os dois campos sao a
 * mesma caixa "Estilos", entao o bug ficava escondido).
 *
 * O teste sobe o servidor de verdade com um STUB do ACE-Step e le o corpo
 * HTTP que saiu na rede - nao apenas a funcao interna.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildRequestBody, buildCaption } from '../server/providers/acestep.js';
import { encodeMp3 } from '../server/audio/mp3.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = { ok: 0, fail: 0 };
const check = (nome, cond, detalhe = '') => {
  if (cond) { report.ok += 1; console.log(`  ok   ${nome}`); }
  else { report.fail += 1; console.error(`  FAIL ${nome}${detalhe ? ` :: ${detalhe}` : ''}`); }
};

/* ------------------------------------------------------------------ *
 * 1. Contrato unitario (buildCaption / buildRequestBody)
 * ------------------------------------------------------------------ */

const TEMA = 'Uma musica sobre terminar uma relacao e voltar pra casa';
const ESTILO = 'Brazilian sertanejo universitario "retrato" with rolling two-step pocket, strong acoustic guitar rhythm, punchy drums, subtle accordion, male vocalist with gritty emotional voice, catchy hook, modern radio production, high energy';

console.log('\n== contrato unitario ==');

// o caso que quebrava: tema no prompt, estilo no campo style
const captionSoEstilo = buildCaption({
  prompt: TEMA, style: ESTILO, styleFromText: true, moodLabel: 'melancolico', duration: 30,
});
check('estilo no campo `style` ENTRA na caption quando o prompt e o tema',
  captionSoEstilo.includes(ESTILO), captionSoEstilo.slice(0, 160));
check('o tema continua na caption junto do estilo',
  captionSoEstilo.includes(TEMA), captionSoEstilo.slice(0, 160));
check('o estilo nao aparece duplicado',
  captionSoEstilo.split(ESTILO).length - 1 === 1,
  String(captionSoEstilo.split(ESTILO).length - 1));

// o caso do app: prompt e style sao o MESMO texto -> nao duplica
const captionApp = buildCaption({
  prompt: ESTILO, style: ESTILO, styleFromText: true, moodLabel: 'melancolico', duration: 30,
});
check('quando prompt e style sao o mesmo texto, o estilo nao duplica',
  captionApp.split(ESTILO).length - 1 === 1,
  String(captionApp.split(ESTILO).length - 1));

// o genero do botao continua fora quando o usuario escreveu o estilo
check('o genero do botao ("Pop") nao entra junto do texto do usuario',
  !/pop/i.test(captionSoEstilo), captionSoEstilo.slice(0, 160));

// o caminho de genero (sem texto do usuario) continua igual
const captionGenero = buildCaption({
  prompt: 'batida sintetica leve', style: 'Pop', styleFromText: false, genreLabel: 'Pop', duration: 30,
});
check('sem texto do usuario: o genero do botao entra como fallback ("Pop style")',
  /Pop style/i.test(captionGenero), captionGenero);

// no corpo completo do pedido
const corpo = buildRequestBody({
  prompt: TEMA, lyrics: '', style: ESTILO, styleFromText: true,
  options: { duration: 30, genreLabel: 'Pop', moodLabel: 'melancolico' },
});
const conteudo = String(corpo.messages[0].content);
check('o corpo do pedido leva o estilo dentro do <prompt>',
  conteudo.includes(`<prompt>${ESTILO}`) || (conteudo.includes(ESTILO) && conteudo.includes('<prompt>')),
  conteudo.slice(0, 200));
check('o corpo do pedido nao repete o estilo',
  conteudo.split(ESTILO).length - 1 === 1, String(conteudo.split(ESTILO).length - 1));

/* ------------------------------------------------------------------ *
 * 2. Prova de ponta a ponta: HTTP real -> corpo real do ACE-Step
 * ------------------------------------------------------------------ */

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function tinyMp3() {
  const sampleRate = 8000;
  const frames = Math.round(sampleRate * 0.4);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.3;
  return encodeMp3([samples], sampleRate, 32);
}

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
          id: 'stub-acestep', model: 'acemusic/acestep-v1.5-turbo',
          choices: [{ message: {
            role: 'assistant',
            content: ['**Caption:** estilo brasileiro COUNTRY POP, energia alta', '**BPM:** 120', '**Duration:** 30', '**Key:** C Major', '## Lyrics', '[Verse]', 'Termino a relacao e volto pra casa', '[Chorus]', 'Sofrencia universitaria no radio'].join('\n'),
            audio: [{ audio_url: { url: `data:audio/mpeg;base64,${audioB64}` } }],
          } }],
        }));
        return;
      }
      res.writeHead(404); res.end('{"detail":"rota inexistente"}');
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { port, pedidos, last: () => pedidos[pedidos.length - 1], close: () => new Promise((r) => server.close(r)) };
}

async function startServer(env = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicgpt-estilo-caption-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', MUSICGPT_DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try { const r = await fetch(`${url}/api/health`); if (r.ok) break; } catch { /* ainda subindo */ }
    await delay(100);
  }
  return { url, child, dataDir };
}

async function waitJob(url, jobId) {
  for (let i = 0; i < 200; i += 1) {
    const r = await fetch(`${url}/api/jobs/${jobId}`);
    const status = await r.json();
    if (status.status === 'done') return status.track;
    if (status.status === 'error') throw new Error(status.error);
    await delay(150);
  }
  throw new Error(`job ${jobId} nao terminou`);
}

console.log('\n== prova de ponta a ponta (HTTP -> ACE-Step) ==');
const stub = await startStub();
const server = await startServer({
  MUSICGPT_MUSIC_PROVIDER: 'acestep',
  ACESTEP_API_KEY: 'stub-chave-123456',
  ACESTEP_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
  ACESTEP_MODEL: 'acemusic/acestep-v1.5-turbo',
  ACESTEP_DURATION_FACTOR: '1',
});

try {
  // TEMA em `prompt`, ESTILO em `style` -> o caso que perdia o estilo
  const resp = await fetch(`${server.url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: TEMA, style: ESTILO, genre: 'sertanejo', duration: 30 }),
  });
  const { jobId } = await resp.json();
  const faixa = await waitJob(server.url, jobId);

  const pedido = stub.last();
  const promptEnviado = String(pedido?.messages?.[0]?.content || '');
  check('http: o pedido ao ACE-Step foi feito', Boolean(pedido), JSON.stringify(pedido ? Object.keys(pedido) : null));
  check('http: o ESTILO chegou na caption enviada ao ACE-Step',
    promptEnviado.includes(ESTILO), promptEnviado.slice(0, 220));
  check('http: o TEMA tambem chegou na caption',
    promptEnviado.includes(TEMA), promptEnviado.slice(0, 220));
  check('http: o estilo nao foi repetido no pedido',
    promptEnviado.split(ESTILO).length - 1 === 1, String(promptEnviado.split(ESTILO).length - 1));
  check('http: a faixa guarda o estilo digitado', faixa?.style === ESTILO, JSON.stringify(faixa?.style));
  check('http: a origem do estilo e o texto', faixa?.styleSource === 'text', JSON.stringify(faixa?.styleSource));
} finally {
  server.child.kill('SIGKILL');
  fs.rmSync(server.dataDir, { recursive: true, force: true, maxAttempts: 3 });
  await stub.close();
}

console.log(`\n${report.ok} ok, ${report.fail} falha(s)`);
assert.equal(report.fail, 0, `${report.fail} verificacao(oes) falharam`);
