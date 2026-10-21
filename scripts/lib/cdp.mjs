/**
 * Cliente CDP minimo (Chrome DevTools Protocol) para os testes locais.
 *
 * O Node 22 ja vem com WebSocket global, entao nao e preciso depender de
 * puppeteer: o Chromium e Speak-launchado com --remote-debugging-port e
 * falamos CDP direto.
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHROME_BIN = process.env.CHROME_BIN || 'chromium';

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.errors = [];
    this.listeners = new Map();
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`falha ao conectar em ${url}`)), { once: true });
    });
    const cdp = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method) {
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails;
          cdp.errors.push(d.exception?.description || d.text || 'erro desconhecido');
        }
        if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
          cdp.errors.push(msg.params.entry.text);
        }
        const handlers = cdp.listeners.get(msg.method);
        if (handlers) for (const fn of handlers) fn(msg.params);
      }
      const pending = msg.id ? cdp.pending.get(msg.id) : null;
      if (!pending) return;
      cdp.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
      else pending.resolve(msg.result);
    });
    return cdp;
  }

  /** Registra um ouvinte para um evento do CDP (ex.: 'Browser.downloadWillBegin'). */
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }

  /** Espera o proximo evento do tipo informado (com timeout). */
  once(method, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timeout esperando o evento ${method}`));
      }, timeoutMs);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout em ${method}`));
      }, 60000);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Avalia uma funcao na pagina (a fonte precisa ser uma expressao de funcao). */
  async eval(fnSource) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(${fnSource})()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`excecao na pagina: ${d.exception?.description || d.text}`);
    }
    return res.result.value;
  }
}

/** Sobe um Chromium headless e devolve { cdp, profile, close }. */
export async function launchChrome({ port = 9333, windowSize = '1280,860' } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'musicgpt-cdp-'));
  const chrome = spawn(CHROME_BIN, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    `--window-size=${windowSize}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  chrome.stderr.on('data', (d) => { stderr += d.toString(); });

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch { /* ainda subindo */ }
    await delay(250);
  }
  if (!target) {
    chrome.kill('SIGKILL');
    throw new Error(`Chromium nao subiu na porta ${port}. ${stderr.slice(-400)}`);
  }

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  return {
    cdp,
    chrome,
    stderr: () => stderr,
    async close() {
      try { cdp.ws.close(); } catch { /* ignora */ }
      chrome.kill('SIGKILL');
      await delay(400);
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* ignora */ }
    },
  };
}

/** Clique de verdade (gera ativacao de usuario para a Web Audio API). */
export async function realClick(cdp, selector) {
  const box = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })`);
  if (!box) throw new Error(`elemento nao encontrado: ${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
    });
  }
  await delay(150);
}

export async function screenshot(cdp, file) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return file;
}

/** Formata o resultado das verificacoes. */
export function createReporter() {
  const results = [];
  const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };
  return {
    results,
    check(name, ok, detail = '') {
      results.push({ name, ok, detail });
      console.log(`${ok ? `${C.g}PASS${C.x}` : `${C.r}FALHA${C.x}`} ${name}${detail ? ` ${C.d}(${detail})${C.x}` : ''}`);
      return ok;
    },
    summary() {
      const failed = results.filter((r) => !r.ok);
      console.log(`\n${failed.length ? C.r : C.g}${results.length - failed.length}/${results.length} verificacoes ok${C.x}`);
      return failed.length;
    },
    colors: C,
  };
}
