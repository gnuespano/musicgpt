/**
 * Teste do DeepSeek como gerador de letras (substitui o local de templates).
 *
 * Regra testada: com DEEPSEEK_API_KEY configurada, a rota /api/lyrics e a
 * expansao de tema da geracao principal usam `POST /chat/completions`
 * (modelo deepseek-chat, response_format json_object) e extraem so a
 * letra do JSON. Sem chave ou se a chamada falhar, o GERADOR LOCAL de
 * templates assume - o app nunca quebra.
 *
 * Camadas:
 *  1. HTTP  - stub da API DeepSeek captura o corpo do pedido e prova o
 *             contrato (model, json mode, system prompt de compositor
 *             brasileiro, tema no prompt) e o fallback (stub 500 / sem
 *             chave -> engine local-templates).
 *  2. Live  - opcional (MUSICGPT_TESTE_LIVE=1): chamada real com a chave
 *             do .env e a letra devolvida impressa.
 *
 * Uso:
 *   node scripts/testar-deepseek.mjs
 *   MUSICGPT_TESTE_LIVE=1 node scripts/testar-deepseek.mjs
 *     (chama a API da DeepSeek de verdade)
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
import { createReporter } from './lib/cdp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.env.MUSICGPT_TESTE_LIVE === '1';

const report = createReporter();
const { check } = report;

/** Tema curto, como o usuario digita. */
const TEMA = 'Uma música sobre aceitar que o fim já chegou';

/** Letra que o "DeepSeek" do stub devolve (JSON mode: {"letra": ...}). */
const LETRA_DEEPSEEK = [
  '[Verso 1]',
  'Linha um da letra vinda do stub',
  'Linha dois da letra vinda do stub',
  '',
  '[Refrao]',
  'Refrao um da letra vinda do stub',
  'Refrao dois da letra vinda do stub',
].join('\n');

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

/**
 * Stub da API da DeepSeek (chat/completions): guarda o corpo de cada
 * pedido e devolve {"letra": ...} - ou 500 quando o prompt contem FALHAR
 * (para exercitar o fallback sem reiniciar o stub).
 */
async function startStub() {
  const port = await freePort();
  const pedidos = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        const body = JSON.parse(raw);
        pedidos.push(body);
        const user = (body.messages || []).find((m) => m.role === 'user')?.content || '';
        if (user.includes('FALHAR')) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'saldo insuficiente (stub)' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'stub-deepseek',
          model: body.model,
          choices: [{
            message: {
              role: 'assistant',
              content: JSON.stringify({ letra: LETRA_DEEPSEEK }),
            },
          }],
        }));
        return;
      }
      res.writeHead(404);
      res.end('{"error":{"message":"rota inexistente no stub"}}');
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

/** Sobe o servidor do app apontando para o stub do DeepSeek. */
async function startServer(env = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicgpt-deepseek-'));
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

/** POST /api/lyrics (o botao "Escrever letra"). */
async function pedirLetra(url, body) {
  const res = await fetch(`${url}/api/lyrics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
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
 * 1. HTTP: rota de letras com um stub da API da DeepSeek
 * ------------------------------------------------------------------ */

const stub = await startStub();
const server = await startServer({
  MUSICGPT_MUSIC_PROVIDER: 'local',
  MUSICGPT_LYRICS_PROVIDER: 'deepseek',
  DEEPSEEK_API_KEY: 'stub-chave-123456',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${stub.port}`,
});

try {
  const health = await (await fetch(`${server.url}/api/health`)).json();
  check('http: o health reporta o DeepSeek como provedor de letras',
    health.lyricsProvider === 'deepseek' && health.mainLyricsProvider === 'deepseek',
    JSON.stringify({ lyrics: health.lyricsProvider, main: health.mainLyricsProvider }));

  // 1a. botao "Escrever letra" -> chamada real ao stub, letra no JSON
  const letra = await pedirLetra(server.url, { prompt: TEMA, lang: 'pt' });
  const pedido = stub.last();
  check('http: /api/lyrics devolve a letra extraida do JSON do DeepSeek',
    letra.text === LETRA_DEEPSEEK && letra.engine === 'deepseek'
    && letra.provider === 'deepseek',
    JSON.stringify({ engine: letra.engine, provider: letra.provider, texto: String(letra.text).slice(0, 40) }));
  check('http: o pedido usa o modelo deepseek-chat',
    pedido.model === 'deepseek-chat', String(pedido.model));
  check('http: o pedido liga o JSON mode (response_format json_object)',
    pedido.response_format?.type === 'json_object',
    JSON.stringify(pedido.response_format));
  const system = String(pedido.messages?.[0]?.content || '');
  check('http: o system prompt pede compositor brasileiro + [Verso]/[Refrao] em pt-BR',
    /compositor/i.test(system) && /portugues do Brasil/i.test(system)
    && system.includes('[Verso') && system.includes('[Refrao'),
    JSON.stringify(system.slice(0, 80)));
  check('http: o system prompt pede saida em JSON (exigencia do JSON mode)',
    /json/i.test(system), JSON.stringify(system.slice(-60)));
  const user = String(pedido.messages?.find((m) => m.role === 'user')?.content || '');
  check('http: o tema vai no prompt do usuario',
    user.includes(TEMA), JSON.stringify(user.slice(0, 80)));

  // 1b. geracao principal: tema do campo "Letra" -> letra do DeepSeek
  const faixa = await gerar(server.url, { prompt: 'MPB melancólica com violão', lyrics: TEMA });
  check('http: na geracao, o tema vira letra do DeepSeek (engine deepseek)',
    faixa.lyrics.trim() === LETRA_DEEPSEEK && faixa.lyricsEngine === 'deepseek',
    JSON.stringify({ engine: faixa.lyricsEngine, lyrics: faixa.lyrics.slice(0, 40) }));
  check('http: a faixa guarda o tema original como expandido',
    faixa.lyricsTheme === TEMA && faixa.lyricsExpanded === true,
    JSON.stringify({ theme: faixa.lyricsTheme, expanded: faixa.lyricsExpanded }));

  // 1c. falha na API (stub 500) -> GERADOR LOCAL assume, sem quebrar
  const letraFalha = await pedirLetra(server.url, { prompt: `FALHAR ${TEMA}`, lang: 'pt' });
  check('http: DeepSeek 500 -> /api/lyrics cai no gerador local (200, provider local + motivo)',
    letraFalha.engine === 'local-templates' && letraFalha.provider === 'local'
    && /500/.test(letraFalha.fallback || '') && /\[[A-Za-z]/.test(letraFalha.text || ''),
    JSON.stringify({ engine: letraFalha.engine, provider: letraFalha.provider, fallback: letraFalha.fallback }));
  const faixaFalha = await gerar(server.url, { prompt: 'MPB melancólica com violão', lyrics: `FALHAR ${TEMA}` });
  check('http: DeepSeek 500 na geracao -> faixa sai com a letra local (nao quebra)',
    faixaFalha.lyricsEngine === 'local-templates' && faixaFalha.lyrics !== LETRA_DEEPSEEK,
    JSON.stringify({ engine: faixaFalha.lyricsEngine, lyrics: faixaFalha.lyrics.slice(0, 40) }));

  // 1d. letra completa escrita pelo usuario continua respeitada
  const LETRA_ESCRITA = '[Verse 1]\nLetra escrita pelo usuario\n[Chorus]\nRefrao do usuario';
  const antesUser = stub.pedidos.length;
  const faixaUser = await gerar(server.url, { prompt: 'MPB melancólica com violão', lyrics: LETRA_ESCRITA });
  check('http: letra completa do usuario NAO passa pelo DeepSeek (respeitada, sem chamada)',
    faixaUser.lyrics.trim() === LETRA_ESCRITA
    && stub.pedidos.length === antesUser,
    JSON.stringify({ lyrics: faixaUser.lyrics.slice(0, 40), chamadas_ao_stub: stub.pedidos.length - antesUser }));

  // 1e. sem chave: o DeepSeek nao e chamado e o local assume
  const antes = stub.pedidos.length;
  const semChave = await startServer({
    MUSICGPT_MUSIC_PROVIDER: 'local',
    MUSICGPT_LYRICS_PROVIDER: 'deepseek',
    DEEPSEEK_API_KEY: '',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${stub.port}`,
  });
  try {
    const letraLocal = await pedirLetra(semChave.url, { prompt: TEMA, lang: 'pt' });
    check('http: sem DEEPSEEK_API_KEY -> gerador local de templates (nem chama a API)',
      letraLocal.engine === 'local-templates' && letraLocal.provider === 'local'
      && stub.pedidos.length === antes,
      JSON.stringify({ engine: letraLocal.engine, provider: letraLocal.provider, chamadas_ao_stub: stub.pedidos.length - antes }));
  } finally {
    semChave.child.kill('SIGKILL');
    fs.rmSync(semChave.dataDir, { recursive: true, force: true, maxAttempts: 3 });
  }
} finally {
  server.child.kill('SIGKILL');
  fs.rmSync(server.dataDir, { recursive: true, force: true, maxAttempts: 3 });
  await stub.close();
}

/* ------------------------------------------------------------------ *
 * 2. Live (opcional): chamada real com a chave do .env
 * ------------------------------------------------------------------ */

if (LIVE) {
  const { generateLyricsDeepSeek } = await import('../server/providers/lyrics.js');
  const resultado = await generateLyricsDeepSeek(TEMA);
  console.log('\n===== DeepSeek ao vivo =====');
  console.log(`engine: ${resultado.engine}${resultado.model ? ` (${resultado.model})` : ''}`);
  if (resultado.fallback) console.log(`fallback: ${resultado.fallback}`);
  console.log(`\n${resultado.text}\n`);
  check('live: a letra veio do DeepSeek (nao do fallback local)',
    resultado.engine === 'deepseek' && resultado.text !== undefined,
    String(resultado.engine + (resultado.fallback ? ` | ${resultado.fallback}` : '')));
  check('live: a letra tem estrutura de [Verso]/[Refrao]',
    /\[.*[Vv]erso/.test(resultado.text) && /\[.*[Rr]efr/.test(resultado.text),
    JSON.stringify(resultado.text.slice(0, 60)));
} else {
  console.log('(camada live pulada - rode com MUSICGPT_TESTE_LIVE=1 para chamar a DeepSeek de verdade)');
}

process.exit(report.summary() ? 1 : 0);
