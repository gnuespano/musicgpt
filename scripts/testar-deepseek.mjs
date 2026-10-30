/**
 * Teste do DeepSeek como gerador de letras (substitui o local de templates)
 * e do NVIDIA NIM como fallback secundario dele.
 *
 * Regra testada: com DEEPSEEK_API_KEY configurada, a rota /api/lyrics e a
 * expansao de tema da geracao principal usam `POST /chat/completions`
 * (modelo deepseek-chat, response_format json_object) e extraem so a
 * letra do JSON. Se o DeepSeek falhar, o NVIDIA NIM assume (mesmo system
 * prompt, sem JSON mode); se os dois falharem, o GERADOR LOCAL de
 * templates assume - o app nunca quebra.
 *
 * Camadas:
 *  1. HTTP  - stub da API DeepSeek captura o corpo do pedido e prova o
 *             contrato (model, json mode, system prompt de compositor
 *             brasileiro, tema no prompt) e o fallback (stub 500 / sem
 *             chave -> engine local-templates).
 *  2. HTTP  - stubs DeepSeek + NVIDIA provam a cadeia: DeepSeek 500 ->
 *             NVIDIA responde (engine nvidia); os dois 500 -> local;
 *             so NVIDIA -> provedor nvidia no modo auto.
 *  3. Live  - opcional (MUSICGPT_TESTE_LIVE=1): chamada real com a chave
 *             do .env e a letra devolvida impressa.
 *
 * Uso:
 *   node scripts/testar-deepseek.mjs
 *   MUSICGPT_TESTE_LIVE=1 node scripts/testar-deepseek.mjs
 *     (chama a API da DeepSeek/NVIDIA de verdade)
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

/** Letra distinta do stub do NVIDIA, para provar QUEM escreveu. */
const LETRA_NVIDIA = [
  '[Verso 1]',
  'Linha um da letra do NVIDIA NIM (stub)',
  'Linha dois da letra do NVIDIA NIM (stub)',
  '',
  '[Refrao]',
  'Refrao do NVIDIA NIM (stub)',
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

/**
 * Stub da API (DeepSeek ou NVIDIA NIM): guarda o corpo de cada pedido e
 * devolve {"letra": ...} - ou 500 quando o prompt contem o `falhar`
 * (para exercitar o fallback sem reiniciar o stub).
 */
async function startStub({ letra = LETRA_DEEPSEEK, falhar = 'FALHAR', id = 'stub' } = {}) {
  const port = await freePort();
  const pedidos = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        const body = JSON.parse(raw);
        pedidos.push({ body, headers: req.headers });
        const user = (body.messages || []).find((m) => m.role === 'user')?.content || '';
        if (falhar && user.includes(falhar)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'saldo insuficiente (stub)' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id,
          model: body.model,
          choices: [{
            message: {
              role: 'assistant',
              content: JSON.stringify({ letra }),
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
    last: () => pedidos[pedidos.length - 1]?.body,
    lastHeaders: () => pedidos[pedidos.length - 1]?.headers,
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
      // por padrao o NVIDIA fica DESLIGADO nos testes de stub: sem isso a
      // chave real do .env seria herdada e a cadeia chamaria a API de
      // verdade. Cada secao liga de proposito quando quer testar o NIM.
      NVIDIA_API_KEY: '',
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
    mesmaLetra(letra.text, LETRA_DEEPSEEK) && tagsCanonicas(letra.text)
    && letra.engine === 'deepseek'
    && letra.provider === 'deepseek',
    JSON.stringify({ engine: letra.engine, provider: letra.provider, texto: String(letra.text).slice(0, 40) }));
  check('http: o pedido usa o modelo deepseek-chat',
    pedido.model === 'deepseek-chat', String(pedido.model));
  check('http: o pedido liga o JSON mode (response_format json_object)',
    pedido.response_format?.type === 'json_object',
    JSON.stringify(pedido.response_format));
  const system = String(pedido.messages?.[0]?.content || '');
  check('http: o system prompt pede compositor brasileiro + [Verse]/[Chorus] sem numero em pt-BR',
    /compositor/i.test(system) && /portugues do Brasil/i.test(system)
    && system.includes('[Verse]') && system.includes('[Chorus]')
    && !/\[(?:Verse|Chorus|Bridge|Outro)\s*\d+\]/i.test(system),
    JSON.stringify(system.slice(0, 80)));
  check('http: o system prompt pede saida em JSON (exigencia do JSON mode)',
    /json/i.test(system), JSON.stringify(system.slice(-60)));
  const user = String(pedido.messages?.find((m) => m.role === 'user')?.content || '');
  check('http: o tema vai no prompt do usuario',
    user.includes(TEMA), JSON.stringify(user.slice(0, 80)));

  // 1b. geracao principal: tema do campo "Letra" -> letra do DeepSeek
  const faixa = await gerar(server.url, { prompt: 'MPB melancólica com violão', lyrics: TEMA });
  check('http: na geracao, o tema vira letra do DeepSeek (engine deepseek)',
    mesmaLetra(faixa.lyrics, LETRA_DEEPSEEK) && tagsCanonicas(faixa.lyrics)
    && faixa.lyricsEngine === 'deepseek',
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
    mesmaLetra(faixaUser.lyrics, LETRA_ESCRITA) && tagsCanonicas(faixaUser.lyrics)
    && faixaUser.lyricsExpanded === false
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
 * 2. HTTP: cadeia de fallback DeepSeek -> NVIDIA NIM -> local
 * ------------------------------------------------------------------ */

const stubNvidia = await startStub({ letra: LETRA_NVIDIA, falhar: 'FALHAR_NVIDIA', id: 'stub-nvidia' });
const stubDeepSeekCadeia = await startStub({ id: 'stub-deepseek-cadeia' });
const cadeia = await startServer({
  MUSICGPT_MUSIC_PROVIDER: 'local',
  MUSICGPT_LYRICS_PROVIDER: 'deepseek',
  DEEPSEEK_API_KEY: 'stub-chave-123456',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${stubDeepSeekCadeia.port}`,
  NVIDIA_API_KEY: 'nvapi-stub-123456',
  NVIDIA_BASE_URL: `http://127.0.0.1:${stubNvidia.port}`,
});

try {
  const health = await (await fetch(`${cadeia.url}/api/health`)).json();
  check('cadeia: o health continua reportando o DeepSeek como provedor (NVIDIA e so fallback)',
    health.lyricsProvider === 'deepseek' && health.mainLyricsProvider === 'deepseek',
    JSON.stringify({ lyrics: health.lyricsProvider, main: health.mainLyricsProvider }));

  // 2a. DeepSeek ok -> ele responde e o NVIDIA NIM NEM e chamado
  const antesNvidia = stubNvidia.pedidos.length;
  const letraOk = await pedirLetra(cadeia.url, { prompt: TEMA, lang: 'pt' });
  check('cadeia: DeepSeek responde -> letra do DeepSeek, NVIDIA NIM nao e chamado',
    mesmaLetra(letraOk.text, LETRA_DEEPSEEK) && tagsCanonicas(letraOk.text)
    && letraOk.engine === 'deepseek'
    && stubNvidia.pedidos.length === antesNvidia,
    JSON.stringify({ engine: letraOk.engine, chamadas_nvidia: stubNvidia.pedidos.length - antesNvidia }));

  // 2b. DeepSeek 500 -> NVIDIA NIM assume (engine nvidia, letra do NIM)
  const letraNvidia = await pedirLetra(cadeia.url, { prompt: `FALHAR ${TEMA}`, lang: 'pt' });
  check('cadeia: DeepSeek 500 -> NVIDIA NIM assume (engine nvidia, provider nvidia)',
    mesmaLetra(letraNvidia.text, LETRA_NVIDIA) && tagsCanonicas(letraNvidia.text)
    && letraNvidia.engine === 'nvidia'
    && letraNvidia.provider === 'nvidia' && !letraNvidia.fallback,
    JSON.stringify({ engine: letraNvidia.engine, provider: letraNvidia.provider, texto: String(letraNvidia.text).slice(0, 40) }));
  const pedidoNvidia = stubNvidia.last();
  check('cadeia: o pedido ao NIM usa o modelo padrao (openai/gpt-oss-20b, o mais rapido da sonda)',
    pedidoNvidia.model === 'openai/gpt-oss-20b',
    String(pedidoNvidia.model));
  const systemNvidia = String(pedidoNvidia.messages?.[0]?.content || '');
  check('cadeia: o NIM recebe o MESMO system prompt do DeepSeek (compositor brasileiro + [Verse]/[Chorus])',
    systemNvidia === String(stubDeepSeekCadeia.last()?.messages?.[0]?.content || '')
    && /compositor/i.test(systemNvidia) && systemNvidia.includes('[Verse]')
    && systemNvidia.includes('[Chorus]')
    && !/\[(?:Verse|Chorus|Bridge|Outro)\s*\d+\]/i.test(systemNvidia),
    JSON.stringify(systemNvidia.slice(0, 60)));
  check('cadeia: a chamada ao NIM autentica com Bearer da NVIDIA_API_KEY',
    /bearer\s+nvapi-stub/i.test(String(stubNvidia.lastHeaders()?.authorization || '')),
    String(stubNvidia.lastHeaders()?.authorization).slice(0, 20));
  const userNvidia = String(pedidoNvidia.messages?.find((m) => m.role === 'user')?.content || '');
  check('cadeia: o tema tambem vai no prompt do usuario do NIM',
    userNvidia.includes(TEMA), JSON.stringify(userNvidia.slice(0, 60)));

  // 2c. os dois caem -> gerador local (o app nunca quebra)
  const letraLocal = await pedirLetra(cadeia.url, { prompt: `FALHAR_NVIDIA ${TEMA}`, lang: 'pt' });
  check('cadeia: DeepSeek 500 + NVIDIA 500 -> gerador local (engine local-templates, com os motivos)',
    letraLocal.engine === 'local-templates' && letraLocal.provider === 'local'
    && /DeepSeek/.test(letraLocal.fallback || '') && /NVIDIA/.test(letraLocal.fallback || '')
    && /\[[A-Za-z]/.test(letraLocal.text || ''),
    JSON.stringify({ engine: letraLocal.engine, fallback: letraLocal.fallback }));

  // 2d. so o NVIDIA tem chave -> no modo auto ele e o provedor (sem DeepSeek)
  const soNvidia = await startServer({
    MUSICGPT_MUSIC_PROVIDER: 'local',
    DEEPSEEK_API_KEY: '',
    NVIDIA_API_KEY: 'nvapi-stub-123456',
    NVIDIA_BASE_URL: `http://127.0.0.1:${stubNvidia.port}`,
  });
  try {
    const healthNvidia = await (await fetch(`${soNvidia.url}/api/health`)).json();
    check('cadeia: sem DeepSeek e com NVIDIA -> provedor de letras nvidia no modo auto',
      healthNvidia.lyricsProvider === 'nvidia' && healthNvidia.mainLyricsProvider === 'nvidia',
      JSON.stringify({ lyrics: healthNvidia.lyricsProvider, main: healthNvidia.mainLyricsProvider }));
    const letraSoNvidia = await pedirLetra(soNvidia.url, { prompt: TEMA, lang: 'pt' });
    check('cadeia: /api/lyrics devolve a letra do NIM (engine nvidia)',
      mesmaLetra(letraSoNvidia.text, LETRA_NVIDIA) && tagsCanonicas(letraSoNvidia.text)
      && letraSoNvidia.engine === 'nvidia',
      JSON.stringify({ engine: letraSoNvidia.engine, texto: String(letraSoNvidia.text).slice(0, 40) }));
  } finally {
    soNvidia.child.kill('SIGKILL');
    fs.rmSync(soNvidia.dataDir, { recursive: true, force: true, maxAttempts: 3 });
  }
} finally {
  cadeia.child.kill('SIGKILL');
  fs.rmSync(cadeia.dataDir, { recursive: true, force: true, maxAttempts: 3 });
  await stubNvidia.close();
  await stubDeepSeekCadeia.close();
}

/* ------------------------------------------------------------------ *
 * 3. Live (opcional): chamada real com a chave do .env
 * ------------------------------------------------------------------ */

if (LIVE) {
  const { generateLyricsDeepSeek } = await import('../server/providers/lyrics.js');
  const resultado = await generateLyricsDeepSeek(TEMA);
  console.log('\n===== cadeia DeepSeek/NVIDIA ao vivo =====');
  console.log(`engine: ${resultado.engine}${resultado.model ? ` (${resultado.model})` : ''}`);
  if (resultado.fallback) console.log(`fallback: ${resultado.fallback}`);
  console.log(`\n${resultado.text}\n`);
  check('live: a letra veio de um provedor de IA (nao do fallback local)',
    ['deepseek', 'nvidia'].includes(resultado.engine) && resultado.text !== undefined,
    String(resultado.engine + (resultado.fallback ? ` | ${resultado.fallback}` : '')));
  check('live: a letra tem estrutura de [Verse]/[Chorus] sem numero',
    /\[Verse\]/i.test(resultado.text) && /\[Chorus\]/i.test(resultado.text)
    && !/\[(?:Verse|Chorus|Bridge|Outro)\s*\d+\]/i.test(resultado.text),
    JSON.stringify(resultado.text.slice(0, 60)));
} else {
  console.log('(camada live pulada - rode com MUSICGPT_TESTE_LIVE=1 para chamar a DeepSeek de verdade)');
}

process.exit(report.summary() ? 1 : 0);
