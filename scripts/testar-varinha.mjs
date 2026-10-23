/**
 * Teste da varinha magica dos blocos "Estilos" e "Letra".
 *
 * Regra testada: clicar na varinha SORTEIA um item aleatorio de uma lista
 * e escreve no campo do bloco.
 *
 *  - "Estilos" (btnStyleWand): sortea uma descricao de estilo aleatoria.
 *    O texto passa a ter prioridade (os chips de genero ficam esmaecidos e
 *    o aviso de prioridade aparece).
 *  - "Letra"    (btnLyricWand): sortea um tema aleatorio para a letra.
 *  - "IA"       (btnLyricAI) : continua gerando a letra de verdade (motor
 *    local/offline) - a funcao da varinha nao substituiu esse caminho.
 *
 * Alem disso confere o efeito visual da varinha (classe `is-magic` com a
 * animacao magicGlow/magicSpin), que dois cliques seguidos nao repetem a
 * mesma sugestao e que o layout mobile continua sem overflow.
 *
 * Uso:
 *   node scripts/testar-varinha.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { launchChrome, realClick, screenshot, createReporter } from './lib/cdp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const report = createReporter();
const { check } = report;

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicgpt-varinha-data-'));
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

/** Limpa os toasts da tela para nao cobrirem o botao clicado. */
function limpaToasts(cdp) {
  return cdp.eval(`(() => { document.querySelector('#toasts').innerHTML = ''; return true; })`);
}

/* ------------------------------------------------------------------ *
 * 1. Listas expostas pelo front-end
 * ------------------------------------------------------------------ */

const appServer = await startServer();
const browser = await launchChrome({ port: 9341 });

try {
  console.log(`${report.colors.y}abrindo ${appServer.url} (motor local, offline)${report.colors.x}`);
  await browser.cdp.send('Page.navigate', { url: appServer.url });
  await delay(2500);

  const listas = await browser.cdp.eval(`(() => ({
    estilos: Array.isArray(window.MUSICGPT_STYLE_SUGGESTIONS) ? window.MUSICGPT_STYLE_SUGGESTIONS : [],
    temas: Array.isArray(window.MUSICGPT_LYRIC_THEMES) ? window.MUSICGPT_LYRIC_THEMES : [],
  }))`);

  check('a lista de sugestoes de estilo tem pelo menos 15 itens',
    listas.estilos.length >= 15, `itens=${listas.estilos.length}`);
  check('a lista de temas de letra tem pelo menos 15 itens',
    listas.temas.length >= 15, `itens=${listas.temas.length}`);
  check('as sugestoes de estilo sao textos nao vazios',
    listas.estilos.every((s) => typeof s === 'string' && s.trim().length > 10));
  check('os temas de letra sao textos nao vazios',
    listas.temas.every((s) => typeof s === 'string' && s.trim().length > 10));

  /* ---------------------------------------------------------------- *
   * 2. Varinha de "Estilos"
   * ---------------------------------------------------------------- */

  // observa a classe is-magic (efeito da varinha) sem depender de timing
  await browser.cdp.eval(`(() => {
    window.__magic = { estilo: false, estiloBotao: false, letra: false, letraBotao: false };
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target;
        if (!(el instanceof Element)) continue;
        if (el.id === 'prompt' && el.classList.contains('is-magic')) window.__magic.estilo = true;
        if (el.id === 'btnStyleWand' && el.classList.contains('is-magic')) window.__magic.estiloBotao = true;
        if (el.id === 'customLyrics' && el.classList.contains('is-magic')) window.__magic.letra = true;
        if (el.id === 'btnLyricWand' && el.classList.contains('is-magic')) window.__magic.letraBotao = true;
      }
    });
    obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
    return true;
  })`);

  await limpaToasts(browser.cdp);
  await realClick(browser.cdp, '#btnStyleWand');

  const estilo1 = await browser.cdp.eval(`(() => document.querySelector('#prompt').value.trim())`);
  check('a varinha de Estilos preenche o campo com uma sugestao valida',
    listas.estilos.includes(estilo1), JSON.stringify(estilo1));

  const visual1 = await browser.cdp.eval(`(() => ({
    magic: window.__magic,
    anim: getComputedStyle(document.querySelector('#prompt')).animationName,
    sobreposto: document.querySelector('#genreChips').classList.contains('is-overridden'),
    hint: !document.querySelector('#styleHint').hidden,
  }))`);
  check('o campo de Estilos ganha a animacao da varinha (is-magic)',
    visual1.magic.estilo, `animationName=${visual1.anim}`);
  check('o botao da varinha de Estilos ganha a animacao (is-magic)',
    visual1.magic.estiloBotao);
  check('o estilo sorteado vale como texto digitado (chips de genero desativados)',
    visual1.sobreposto && visual1.hint, JSON.stringify(visual1));

  await limpaToasts(browser.cdp);
  await realClick(browser.cdp, '#btnStyleWand');
  const estilo2 = await browser.cdp.eval(`(() => document.querySelector('#prompt').value.trim())`);
  check('dois cliques seguidos nao repetem o mesmo estilo',
    estilo1 !== estilo2, `${JSON.stringify(estilo1)} vs ${JSON.stringify(estilo2)}`);
  check('o segundo clique tambem traz uma sugestao valida',
    listas.estilos.includes(estilo2), JSON.stringify(estilo2));

  /* ---------------------------------------------------------------- *
   * 3. Varinha de "Letra": usa o tema do campo e GERA a letra
   * ---------------------------------------------------------------- */

  // colapsa o bloco para provar que a varinha o reabre
  await browser.cdp.eval(`(() => {
    document.querySelector('#toggleLyrics').closest('.block').classList.add('is-collapsed');
    return true;
  })`);
  await delay(200);

  // sem texto no campo: a varinha sorteia um tema e gera a letra a partir dele
  await limpaToasts(browser.cdp);
  await realClick(browser.cdp, '#btnLyricWand');

  const letra1 = await browser.cdp.eval(`(() => ({
    valor: document.querySelector('#customLyrics').value.trim(),
    aberto: !document.querySelector('#bodyLyrics').closest('.block').classList.contains('is-collapsed'),
  }))`);
  check('a varinha de Letra gera uma letra completa (com tags de secao)',
    letra1.valor.length > 40 && /\[[A-Za-zÀ-ú]/.test(letra1.valor), `${letra1.valor.slice(0, 60)}...`);
  check('a letra gerada NAO e um tema da lista (virou letra de verdade)',
    !listas.temas.includes(letra1.valor), JSON.stringify(letra1.valor.slice(0, 40)));
  check('o bloco "Letra" abre quando a letra e gerada', letra1.aberto);
  check('o campo de Letra ganha a animacao da varinha (is-magic)',
    (await browser.cdp.eval(`(() => window.__magic.letra)`)));

  // com um tema escrito no campo, a varinha usa ELE como semente
  const TEMA_DIGITADO = 'Uma música sobre aceitar que o fim já chegou';
  await browser.cdp.eval(`(() => {
    const campo = document.querySelector('#customLyrics');
    campo.value = ${JSON.stringify(TEMA_DIGITADO)};
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })`);
  await limpaToasts(browser.cdp);
  await realClick(browser.cdp, '#btnLyricWand');

  const letraDoTema = await browser.cdp.eval(`(() => document.querySelector('#customLyrics').value.trim())`);
  check('a varinha usa o TEMA digitado no campo como semente',
    letraDoTema !== TEMA_DIGITADO && /\[[A-Za-zÀ-ú]/.test(letraDoTema) && letraDoTema.length > 40,
    `${letraDoTema.slice(0, 60)}...`);
  check('dois cliques com o mesmo tema nao repetem a mesma letra',
    letraDoTema !== letra1.valor, `${JSON.stringify(letra1.valor.slice(0, 30))} vs ${JSON.stringify(letraDoTema.slice(0, 30))}`);

  /* ---------------------------------------------------------------- *
   * 4. O botao "IA" continua gerando letra a partir de Estilos
   * ---------------------------------------------------------------- */

  await realClick(browser.cdp, '#btnLyricAI');

  let letraIA = '';
  for (let i = 0; i < 40; i += 1) {
    const valor = await browser.cdp.eval(`(() => document.querySelector('#customLyrics').value.trim())`);
    if (valor && valor !== letraDoTema) { letraIA = valor; break; }
    await delay(400);
  }
  check('o botao "IA" gera a letra de verdade (motor local)',
    letraIA.length > 40 && /verso|refr[ãa]o|intro/i.test(letraIA), `${letraIA.slice(0, 80)}...`);

  /* ---------------------------------------------------------------- *
   * 5. Layout mobile (os dois botoes do bloco Letra cabem na tela)
   * ---------------------------------------------------------------- */

  await browser.cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  });
  await delay(700);

  const mobile = await browser.cdp.eval(`(() => {
    const caixa = (sel) => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, visivel: r.width > 0 && r.height > 0, lado: Math.round(r.right), top: Math.round(r.top) };
    };
    return {
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      estilo: caixa('#btnStyleWand'),
      letra: caixa('#btnLyricWand'),
      ia: caixa('#btnLyricAI'),
    };
  })`);

  check('mobile: sem overflow horizontal', mobile.overflowX <= 1, `overflow=${mobile.overflowX}px`);
  check('mobile: as varinhas continuam visiveis com tamanho clicavel',
    mobile.estilo.visivel && mobile.letra.visivel && mobile.ia.visivel
    && [mobile.estilo, mobile.letra, mobile.ia].every((b) => b.w >= 30 && b.h >= 30),
    JSON.stringify(mobile));
  check('mobile: os botoes do bloco Letra nao ultrapassam a tela',
    mobile.letra.lado <= 390 && mobile.ia.lado <= 390, JSON.stringify({ letra: mobile.letra.lado, ia: mobile.ia.lado }));

  await browser.cdp.eval(`(() => {
    document.querySelector('#prompt').scrollIntoView({ block: 'center' });
    return true;
  })`);
  await delay(300);
  await screenshot(browser.cdp, path.join(os.tmpdir(), 'musicgpt-varinha-mobile.png'));

  await browser.cdp.send('Emulation.clearDeviceMetricsOverride');
  await delay(400);

  await browser.cdp.eval(`(() => {
    document.querySelector('#prompt').scrollIntoView({ block: 'center' });
    return true;
  })`);
  await delay(400);
  await screenshot(browser.cdp, path.join(os.tmpdir(), 'musicgpt-varinha.png'));

  const erros = browser.cdp.errors.filter((e) => !/favicon|manifest|ServiceWorker|sw\.js/i.test(e));
  check('nenhum erro de JavaScript na pagina', erros.length === 0, erros.slice(0, 2).join(' | '));
} catch (err) {
  check(`execucao do teste no navegador (${err.message})`, false);
} finally {
  await browser.close();
  appServer.child.kill('SIGKILL');
  fs.rmSync(appServer.dataDir, { recursive: true, force: true, maxAttempts: 3 });
}

console.log(`\n${report.colors.d}screenshot: ${path.join(os.tmpdir(), 'musicgpt-varinha.png')}${report.colors.x}`);
process.exit(report.summary() ? 1 : 0);
