/**
 * Teste local da rota de download.
 *
 * Cobre o cenario da nuvem: o disco e efemero e o arquivo de audio some no
 * proximo restart/deploy. O download tem de continuar funcionando porque a
 * faixa guarda a `audio_url` original devolvida pelo provider.
 *
 * Verificacoes:
 *  - download em MP3 e em WAV (headers + payload valido);
 *  - a fonte remota (?source=remote) devolve os mesmos bytes do arquivo local;
 *  - o download funciona COM o arquivo ausente do disco (disco efemero);
 *  - o player continua servindo o audio sem o arquivo local;
 *  - o botao "Baixar .mp3" existe e baixa o arquivo de verdade no navegador;
 *  - (opcional) o download continua funcionando depois de reiniciar o servidor.
 *
 * Uso:
 *   node scripts/testar-download.mjs
 *   MUSICGPT_TEST_RESTART=1 node scripts/testar-download.mjs   # reinicia o servidor
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { launchChrome, realClick, createReporter } from './lib/cdp.mjs';

const APP_URL = process.env.MUSICGPT_URL || 'http://localhost:8787';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.MUSICGPT_DATA_DIR || path.join(REPO, 'data');
const DO_RESTART = process.env.MUSICGPT_TEST_RESTART === '1';

const report = createReporter();

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function isMp3(buffer) {
  // frame MPEG: 0xFF + flag de sync
  for (let i = 0; i < Math.min(buffer.length - 1, 4096); i += 1) {
    if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) return true;
  }
  return false;
}

function isWav(buffer) {
  return buffer.length > 44
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WAVE';
}

async function getTracks() {
  const res = await fetch(`${APP_URL}/api/tracks`);
  const data = await res.json();
  return data.tracks || [];
}

async function fetchDownload(trackId, format, extra = '') {
  const res = await fetch(`${APP_URL}/api/download/${trackId}?format=${format}${extra}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buffer };
}

function dispositionOf(res) {
  return res.headers.get('content-disposition') || '';
}

/* ------------------------------------------------------------------ *
 * Teste
 * ------------------------------------------------------------------ */

const tracks = await getTracks();
if (!tracks.length) {
  console.error('Nenhuma faixa na biblioteca: gere uma musica antes de rodar o teste.');
  process.exit(1);
}

// uma faixa com audio (mp3 ou wav) e uma com a audio_url original salva
const withAudio = tracks.find((t) => t.file) || tracks[0];
const withSource = tracks.find((t) => t.hasSource) || null;

report.check('biblioteca tem faixas para testar', tracks.length > 0, `${tracks.length} faixas`);

// ---------- 1. download em MP3 ----------
const mp3 = await fetchDownload(withAudio.id, 'mp3');
report.check('download em MP3 responde 200', mp3.status === 200, `status=${mp3.status}`);
report.check('download em MP3 envia Content-Disposition attachment',
  /attachment/.test(dispositionOf(mp3)) && /\.mp3"?/i.test(dispositionOf(mp3)),
  dispositionOf(mp3) || '(vazio)');
report.check('download em MP3 devolve um MP3 valido',
  isMp3(mp3.buffer), `${mp3.buffer.length} bytes`);

// ---------- 2. download em WAV ----------
const wav = await fetchDownload(withAudio.id, 'wav');
report.check('download em WAV responde 200', wav.status === 200, `status=${wav.status}`);
report.check('download em WAV envia Content-Disposition attachment',
  /attachment/.test(dispositionOf(wav)) && /\.wav"?/i.test(dispositionOf(wav)),
  dispositionOf(wav) || '(vazio)');
report.check('download em WAV devolve um WAV valido', isWav(wav.buffer), `${wav.buffer.length} bytes`);

// ---------- 3. a fonte remota devolve o mesmo audio ----------
if (withSource) {
  const local = await fetchDownload(withSource.id, 'mp3', '&source=local');
  const remote = await fetchDownload(withSource.id, 'mp3', '&source=remote');
  const iguais = local.buffer.length === remote.buffer.length
    && local.buffer.equals(remote.buffer);
  report.check('fonte local e fonte remota devolvem os mesmos bytes', iguais,
    `local=${local.buffer.length} remoto=${remote.buffer.length}`);
} else {
  console.log(`${report.colors.y}aviso${report.colors.x} pulando a comparacao local x remoto: nenhuma faixa com audio_url original`);
}

// ---------- 4. disco efemero: o arquivo some, o download continua ----------
const localFile = withAudio.file ? path.join(DATA_DIR, withAudio.file) : null;
let backup = null;
if (localFile && fs.existsSync(localFile)) {
  backup = path.join(os.tmpdir(), `musicgpt-backup-${Date.now()}.bin`);
  fs.renameSync(localFile, backup);
}

const semDisco = await fetchDownload(withAudio.id, 'mp3');
report.check('download funciona com o arquivo ausente do disco (disco efemero)',
  semDisco.status === 200 && isMp3(semDisco.buffer),
  `status=${semDisco.status} ${semDisco.buffer.length} bytes`);

const playerSemDisco = await fetch(`${APP_URL}/api/tracks/${withAudio.id}/audio`);
report.check('player continua servindo o audio sem o arquivo local',
  playerSemDisco.status === 200 && Number(playerSemDisco.headers.get('content-length') || 0) > 1000,
  `status=${playerSemDisco.status}`);

if (backup) {
  fs.renameSync(backup, localFile);
  report.check('arquivo local restaurado no teste', fs.existsSync(localFile));
}

// ---------- 5. a faixa guarda a audio_url original ----------
if (withSource) {
  report.check('a faixa guarda a audio_url original do provider', Boolean(withSource.hasSource),
    withSource.id);
} else {
  console.log(`${report.colors.y}aviso${report.colors.x} nenhuma faixa com audio_url original (gere uma musica pelo ACE-Step para exercitar o caminho remoto)`);
}

// ---------- 6. a API nao vaza a audio_url ----------
const listRes = await fetch(`${APP_URL}/api/tracks`);
const listText = await listRes.text();
report.check('a API nao expoe a audio_url original (biblioteca leve)',
  !listText.includes('sourceUrl') && listText.length < 5 * 1024 * 1024,
  `${(listText.length / 1024).toFixed(0)} KB`);

// ---------- 7. o botao "Baixar .mp3" baixa o arquivo no navegador ----------
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicgpt-dl-'));
const browser = await launchChrome({ port: 9334 });
try {
  await browser.cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true,
  }).catch(async () => {
    // Chrome antigo: usa a API da pagina
    await browser.cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  });

  await browser.cdp.send('Page.navigate', { url: APP_URL });
  await delay(2500);

  const botao = await browser.cdp.eval(`(() => {
    const done = document.querySelector('#btnDownloadMp3Done');
    const card = document.querySelector('#libraryGrid .track-card button[data-act="download"]');
    return { painel: !!done, card: !!card, texto: done?.textContent?.trim() || '' };
  })`);
  report.check('botao "Baixar .mp3" existe no painel do resultado',
    botao.painel && /mp3/i.test(botao.texto), `"${botao.texto}"`);

  // vai para a biblioteca e clica no botao de MP3 do primeiro card
  await browser.cdp.eval(`(() => {
    document.querySelector('#nav button[data-view="biblioteca"]').click();
    return true;
  })`);
  await delay(1200);

  // registra os eventos ANTES do clique (o download pode terminar antes
  // de a gente comecar a esperar)
  const events = [];
  browser.cdp.on('Browser.downloadWillBegin', (p) => events.push(p));
  browser.cdp.on('Browser.downloadProgress', (p) => events.push(p));

  await realClick(browser.cdp, '#libraryGrid .track-card button[data-act="download"]');

  const deadline = Date.now() + 30000;
  let completed = null;
  while (Date.now() < deadline) {
    completed = events.find((e) => e.state === 'completed');
    if (completed) break;
    await delay(250);
  }
  const begin = events.find((e) => e.suggestedFilename);

  report.check('clicar em "Baixar .mp3" inicia um download no navegador',
    Boolean(begin?.suggestedFilename), begin?.suggestedFilename || '(sem evento)');

  if (begin?.suggestedFilename) {
    const file = path.join(downloadDir, begin.suggestedFilename);
    const ok = Boolean(completed) && fs.existsSync(file) && fs.statSync(file).size > 10000;
    report.check('arquivo baixado com o nome e o conteudo corretos', ok,
      `${begin.suggestedFilename} ${fs.existsSync(file) ? `${(fs.statSync(file).size / 1048576).toFixed(1)} MB` : '(ausente)'}`);
    if (fs.existsSync(file)) {
      const buf = fs.readFileSync(file);
      report.check('arquivo baixado e um MP3 valido', isMp3(buf), `${buf.length} bytes`);
    }
  }
} finally {
  await browser.close();
  fs.rmSync(downloadDir, { recursive: true, force: true, maxRetries: 5 });
}

// ---------- 8. o download continua funcionando depois de reiniciar o servidor ----------
if (DO_RESTART) {
  console.log(`${report.colors.y}reiniciando o servidor...${report.colors.x}`);
  await restartServer();
  await delay(1500);
  const after = await fetchDownload(withAudio.id, 'mp3');
  report.check('download funciona depois de reiniciar o servidor',
    after.status === 200 && isMp3(after.buffer),
    `status=${after.status} ${after.buffer.length} bytes`);
} else {
  console.log(`${report.colors.d}(use MUSICGPT_TEST_RESTART=1 para testar o download apos reiniciar o servidor)${report.colors.x}`);
}

process.exit(report.summary() ? 1 : 0);

/* ------------------------------------------------------------------ *
 * Reinicio do servidor (opcional)
 * ------------------------------------------------------------------ */

async function restartServer() {
  const pids = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      if (cmd.includes('server/index.js') && !cmd.includes('testar-download')) pids.push(Number(entry));
    } catch { /* processo encerrado */ }
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignora */ }
  }
  await delay(1500);
  spawn('npm', ['start'], { cwd: REPO, detached: true, stdio: 'ignore' }).unref();
}
