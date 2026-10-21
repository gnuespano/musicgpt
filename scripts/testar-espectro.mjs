/**
 * Teste local do visualizador de espectro (Web Audio API).
 *
 * Sobe um Chromium headless, abre o app, toca uma faixa e confere:
 *  - o <canvas> existe e acompanha o tamanho da tela (devicePixelRatio);
 *  - as barras crescem conforme a frequencia do audio (dados do AnalyserNode);
 *  - a animacao congela quando o audio pausa e volta ao dar play;
 *  - o controle de volume continua valendo depois de conectar o grafo de audio;
 *  - o layout nao quebra no mobile (sem overflow, player visivel).
 *
 * Uso: node scripts/testar-espectro.mjs   (o servidor precisa estar no ar)
 */

import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, realClick, screenshot, createReporter } from './lib/cdp.mjs';

const APP_URL = process.env.MUSICGPT_URL || 'http://localhost:8787';
const report = createReporter();
const { check } = report;

/** Mede o quadro atual do canvas: pixels pintados, altura das barras e hash. */
const CANVAS_STATS = `() => {
  const canvas = document.querySelector('#spectrum');
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let painted = 0;
  let hash = 0;
  const columns = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 12) {
        painted++;
        columns[x]++;
        hash = (hash + data[i] * 3 + data[i + 1] * 5 + data[i + 2] * 7 + y) % 2147483647;
      }
    }
  }
  let tallest = 0;
  for (let x = 0; x < width; x++) if (columns[x] > tallest) tallest = columns[x];
  return {
    painted, hash, tallest, width, height,
    cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight,
    dpr: window.devicePixelRatio || 1,
    rect: (() => { const r = canvas.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
  };
}`;

const browser = await launchChrome({ port: 9333 });
const { cdp } = browser;

try {
  console.log(`${report.colors.y}abrindo ${APP_URL}${report.colors.x}`);
  await cdp.send('Page.navigate', { url: APP_URL });
  await delay(2500);

  // ---------- 1. canvas e dimensionamento ----------
  const canvasInfo = await cdp.eval(`(() => {
    const c = document.querySelector('#spectrum');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { cssWidth: r.width, cssHeight: r.height, bufWidth: c.width, bufHeight: c.height, dpr: window.devicePixelRatio || 1 };
  })`);

  check('canvas #spectrum existe no player', !!canvasInfo);
  if (canvasInfo) {
    check('canvas tem area visivel', canvasInfo.cssWidth > 100 && canvasInfo.cssHeight > 8,
      `${Math.round(canvasInfo.cssWidth)}x${Math.round(canvasInfo.cssHeight)}`);
    const esperadoW = Math.round(canvasInfo.cssWidth * canvasInfo.dpr);
    const esperadoH = Math.round(canvasInfo.cssHeight * canvasInfo.dpr);
    check('buffer do canvas acompanha o devicePixelRatio',
      Math.abs(canvasInfo.bufWidth - esperadoW) <= 2 && Math.abs(canvasInfo.bufHeight - esperadoH) <= 2,
      `buffer ${canvasInfo.bufWidth}x${canvasInfo.bufHeight} vs ${esperadoW}x${esperadoH}`);
  }

  // ---------- 2. reproducao e dados do AnalyserNode ----------
  await realClick(cdp, '#btnPlay');
  await delay(1800);

  const tocando = await cdp.eval(`(() => {
    const a = document.querySelector('#audio');
    return { paused: a.paused, currentTime: a.currentTime, duration: a.duration, src: a.currentSrc || a.src };
  })`);
  check('audio esta reproduzindo', !tocando.paused && tocando.currentTime > 0.15,
    `currentTime=${(tocando.currentTime || 0).toFixed(2)}s`);

  const estado = await cdp.eval(`(() => ({
    ctx: window.__musicgptSpectrum?.audioCtx?.state || null,
    barras: window.__musicgptSpectrum?.bars || 0,
    tocando: window.__musicgptSpectrum?.playing || false,
    ganho: window.__musicgptSpectrum?.gain?.gain?.value ?? null,
  }))`);
  check('AudioContext criado e em execucao', estado.ctx === 'running', `state=${estado.ctx}`);
  check('AnalyserNode conectado ao <audio>', estado.barras > 0, `${estado.barras} barras`);

  const a1 = await cdp.eval(CANVAS_STATS);
  await delay(320);
  const a2 = await cdp.eval(CANVAS_STATS);

  check('barras desenhadas no canvas', a1.painted > 500, `${a1.painted} pixels pintados`);
  check('barras reagem a frequencia do audio', a1.tallest > 6,
    `barra mais alta ${a1.tallest}px de ${a1.height}px`);
  check('animacao roda com o audio tocando', a1.hash !== a2.hash,
    `hash ${a1.hash} -> ${a2.hash}`);

  const tons = await cdp.eval(`(() => {
    const s = window.__musicgptSpectrum;
    return { smooth: Array.from(s.smooth), levels: Array.from(s.levels) };
  })`);
  const variaveis = new Set(tons.smooth.map((v) => Math.round(v * 100))).size;
  check('as barras tem alturas diferentes (espectro real, nao um bloco unico)', variaveis > 5,
    `${variaveis} niveis distintos`);

  await screenshot(cdp, path.join(os.tmpdir(), 'musicgpt-espectro-desktop.png'));

  // ---------- 3. pausa congela a animacao ----------
  await realClick(cdp, '#btnPlay');
  await delay(400);
  const p1 = await cdp.eval(CANVAS_STATS);
  await delay(600);
  const p2 = await cdp.eval(CANVAS_STATS);
  const pausado = await cdp.eval(`(() => ({
    paused: document.querySelector('#audio').paused,
    tocando: window.__musicgptSpectrum?.playing || false,
  }))`);

  check('audio pausa ao clicar em play/pausar', pausado.paused === true);
  check('loop de animacao para junto com o audio', pausado.tocando === false);
  check('canvas congela (mesmo quadro) enquanto pausado', p1.hash === p2.hash,
    `hash ${p1.hash} / ${p2.hash}`);

  // ---------- 4. play retoma a animacao ----------
  await realClick(cdp, '#btnPlay');
  await delay(700);
  const r1 = await cdp.eval(CANVAS_STATS);
  await delay(320);
  const r2 = await cdp.eval(CANVAS_STATS);
  check('animacao volta ao dar play', r1.hash !== r2.hash && r2.tallest > 4,
    `hash ${r1.hash} -> ${r2.hash}`);

  // ---------- 5. volume continua funcionando com o grafo de audio ----------
  const vol = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const slider = document.querySelector('#volume');
    slider.value = '0.4';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    const s = window.__musicgptSpectrum;
    return { elemento: document.querySelector('#audio').volume, ganho: s?.gain?.gain?.value ?? null };
  })`);
  check('volume do player e aplicado no GainNode (elemento <audio> nao e mais ignorado)',
    Math.abs((vol.ganho ?? 0) - 0.4) < 0.08, `ganho=${vol.ganho} elemento.volume=${vol.elemento}`);

  const mudo = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#btnMute').click();
    await sleep(250);
    const s = window.__musicgptSpectrum;
    const apagado = s?.gain?.gain?.value ?? null;
    document.querySelector('#btnMute').click();
    await sleep(250);
    return { apagado, restaurado: s?.gain?.gain?.value ?? null };
  })`);
  check('mudo silencia o GainNode e volta ao normal',
    (mudo.apagado ?? 1) < 0.05 && (mudo.restaurado ?? 0) > 0.2,
    `mudo=${mudo.apagado} restaurado=${mudo.restaurado}`);

  // ---------- 6. layout mobile ----------
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  });
  await delay(700);

  const mobile = await cdp.eval(`(() => {
    const c = document.querySelector('#spectrum');
    const r = c.getBoundingClientRect();
    const player = document.querySelector('#player').getBoundingClientRect();
    const main = document.querySelector('#main').getBoundingClientRect();
    return {
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      canvas: { w: r.width, h: r.height, y: r.y },
      playerBottom: player.bottom,
      mainBottom: main.bottom,
      viewport: window.innerWidth,
      bufW: c.width, bufH: c.height,
      dpr: window.devicePixelRatio,
    };
  })`);

  check('mobile: sem overflow horizontal', mobile.overflowX <= 1, `overflow=${mobile.overflowX}px`);
  check('mobile: canvas continua visivel e dimensvel', mobile.canvas.w > 100 && mobile.canvas.h >= 12,
    `${Math.round(mobile.canvas.w)}x${Math.round(mobile.canvas.h)}`);
  check('mobile: canvas re dimensionado ao devicePixelRatio (limitado a 2x)',
    Math.abs(mobile.bufW - Math.round(mobile.canvas.w * Math.min(mobile.dpr, 2))) <= 2,
    `buffer=${mobile.bufW} css=${Math.round(mobile.canvas.w)} dpr=${mobile.dpr}`);
  check('mobile: player nao invade o conteudo principal',
    mobile.mainBottom <= mobile.playerBottom + 1,
    `main=${Math.round(mobile.mainBottom)} player=${Math.round(mobile.playerBottom)}`);

  await screenshot(cdp, path.join(os.tmpdir(), 'musicgpt-espectro-mobile.png'));

  // ---------- 7. sem erros de JS no console ----------
  const relevantes = cdp.errors.filter((e) => !/favicon|manifest|ServiceWorker|sw\.js/i.test(e));
  check('nenhum erro de JavaScript na pagina', relevantes.length === 0, relevantes.slice(0, 2).join(' | '));

  console.log(`\n${report.colors.d}screenshots: ${path.join(os.tmpdir(), 'musicgpt-espectro-desktop.png')} e ${path.join(os.tmpdir(), 'musicgpt-espectro-mobile.png')}${report.colors.x}`);
} catch (err) {
  check(`execucao do teste (${err.message})`, false);
} finally {
  await browser.close();
}

process.exit(report.summary() ? 1 : 0);
