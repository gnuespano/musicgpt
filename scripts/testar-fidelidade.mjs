/**
 * Mede a FIDELIDADE de um cover em relacao ao audio de origem.
 *
 * A metrica e uma similaridade de MELODIA (croma): o audio e quebrado em
 * quadros, cada quadro vira um vetor de 12 classes de altura (C, C#, D...)
 * e a similaridade entre o original e o cover e medida:
 *
 *  - `melodia`         = correlacao media de Pearson entre os croma dos
 *                        quadros (0..1): quanto as duas faixas tocam as
 *                        mesmas notas ao mesmo tempo.
 *  - `nota dominante`  = percentual de quadros com a MESMA classe de altura
 *                        dominante (0..1; acaso = ~0.08). E a medida mais
 *                        direta de "a melodia foi seguida".
 *  - `harmonia`        = cosseno entre os perfis medios de croma (0..1): quanto
 *                        as duas faixas usam a mesma escala.
 *  - `timing`          = correlacao de Pearson entre as curvas de energia
 *                        suavizadas (0..1): quanto o andamento/ritmo bate.
 *
 * Um cover "colado" no original pontua alto nos tres; um cover que so
 * "puxou o estilo" (sem copiar a melodia) pontua como uma faixa qualquer.
 *
 * Uso:
 *   node scripts/testar-fidelidade.mjs <original> <cover> [<cover2> ...]
 *   npm run test:fidelidade -- <original> <cover>
 */

import fs from 'node:fs';
import path from 'node:path';
import { decodeMp3Buffer } from '../server/audio/voice.js';
import { decodeWav } from '../server/audio/wav.js';

const FRAME = 2048;
const HOP = 512;

/* ------------------------------------------------------------------ *
 * FFT (radix-2, in-place)
 * ------------------------------------------------------------------ */

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Croma
 * ------------------------------------------------------------------ */

/** Le qualquer audio (mp3/wav) e devolve mono na taxa nativa. */
async function loadMono(file) {
  const buffer = fs.readFileSync(file);
  if (/\.wav$/i.test(file)) {
    const { channels, sampleRate } = decodeWav(buffer);
    const left = channels[0] || new Float32Array(0);
    const right = channels[1] || left;
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i += 1) mono[i] = (left[i] + right[i]) / 2;
    return { mono, sampleRate };
  }
  const { channels, sampleRate } = await decodeMp3Buffer(buffer);
  const left = channels[0] || new Float32Array(0);
  const right = channels[1] || left;
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i += 1) mono[i] = (left[i] + right[i]) / 2;
  return { mono, sampleRate };
}

/**
 * Chromagrama: 12 classes de altura x quadros.
 * Cada quadro e normalizado (L2) para comparar so o conteudo harmônico.
 */
function chromagram(mono, sampleRate) {
  const bins = FRAME / 2;
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

  // mapa bin -> classe de altura (C=0, C#=1, ...)
  const binToClass = new Int8Array(bins).fill(-1);
  for (let b = 1; b < bins; b += 1) {
    const freq = (b * sampleRate) / FRAME;
    if (freq < 55 || freq > 2200) continue; // fora da faixa musical grave/aguda
    const midi = 69 + 12 * Math.log2(freq / 440);
    binToClass[b] = ((Math.round(midi) % 12) + 12) % 12;
  }

  const frames = [];
  const energies = [];
  for (let start = 0; start + FRAME <= mono.length; start += HOP) {
    for (let i = 0; i < FRAME; i += 1) {
      re[i] = mono[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    const chroma = new Float64Array(12);
    let energy = 0;
    for (let b = 1; b < bins; b += 1) {
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      energy += mag * mag;
      const cls = binToClass[b];
      if (cls >= 0) chroma[cls] += mag;
    }
    energies.push(Math.sqrt(energy));
    let norm = 0;
    for (let c = 0; c < 12; c += 1) norm += chroma[c] * chroma[c];
    norm = Math.sqrt(norm) || 1;
    for (let c = 0; c < 12; c += 1) chroma[c] /= norm;
    frames.push(chroma);
  }
  return { frames, energies };
}

const cosine = (a, b) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

/**
 * Pearson entre dois vetores (croma de um quadro).
 *
 * O cosseno nao serve aqui: qualquer musica popular tem classes de altura
 * dominantes em comum (o cosseno de 2 faixas sem relacao passa de 0.7).
 * A correlacao de Pearson remove esse vies - ela pergunta "as duas faixas
 * usam as mesmas notas em relacao ao fundo de cada uma", e nao apenas
 * "as duas tem notas graves".
 */
function pearsonVec(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/** Pearson entre duas series. */
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / (Math.sqrt(da) * Math.sqrt(db) || 1);
}

/** Perfil medio de croma (a "harmonia" da faixa). */
function meanChroma(frames) {
  const mean = new Float64Array(12);
  for (const f of frames) for (let c = 0; c < 12; c += 1) mean[c] += f[c];
  for (let c = 0; c < 12; c += 1) mean[c] /= (frames.length || 1);
  const norm = Math.sqrt(mean.reduce((s, v) => s + v * v, 0)) || 1;
  for (let c = 0; c < 12; c += 1) mean[c] /= norm;
  return mean;
}

/** Suaviza uma serie (media movel) - deixa o contorno de energia legivel. */
function smooth(series, window) {
  const out = new Float64Array(series.length);
  const half = Math.floor(window / 2);
  for (let i = 0; i < series.length; i += 1) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(series.length - 1, i + half); j += 1) {
      sum += series[j];
      count += 1;
    }
    out[i] = sum / (count || 1);
  }
  return out;
}

/** Compara dois audios e devolve as medidas de fidelidade. */
export async function measureFidelity(originalFile, coverFile) {
  const original = await loadMono(originalFile);
  const cover = await loadMono(coverFile);
  const a = chromagram(original.mono, original.sampleRate);
  const b = chromagram(cover.mono, cover.sampleRate);

  // alinha pelo inicio e compara os quadros em comum
  const n = Math.min(a.frames.length, b.frames.length);
  let somaPearson = 0;
  let notasIguais = 0;
  for (let i = 0; i < n; i += 1) {
    somaPearson += pearsonVec(a.frames[i], b.frames[i]);
    // nota dominante do quadro: a mesma classe de altura?
    let ia = 0;
    let ib = 0;
    for (let c = 1; c < 12; c += 1) {
      if (a.frames[i][c] > a.frames[i][ia]) ia = c;
      if (b.frames[i][c] > b.frames[i][ib]) ib = c;
    }
    if (ia === ib) notasIguais += 1;
  }

  // energia suavizada (~1 s) -> contorno de ritmo/loudness
  const janela = Math.max(1, Math.round((original.sampleRate / HOP)));
  const energiaA = Array.from(smooth(a.energies.slice(0, n), janela));
  const energiaB = Array.from(smooth(b.energies.slice(0, n), janela));
  const norm = (arr) => {
    const max = Math.max(...arr, 1e-9);
    return arr.map((v) => v / max);
  };

  return {
    original: path.basename(originalFile),
    cover: path.basename(coverFile),
    duracaoOriginal: +(original.mono.length / original.sampleRate).toFixed(2),
    duracaoCover: +(cover.mono.length / cover.sampleRate).toFixed(2),
    // correlacao de croma quadro a quadro (0..1; ~0 = nada a ver)
    melodia: +((somaPearson / (n || 1)) * 0.5 + 0.5).toFixed(3),
    // frames com a MESMA nota dominante (0..1; acaso = ~0.08)
    notaDominante: +(notasIguais / (n || 1)).toFixed(3),
    // perfil de croma medio (mesma escala/harmonia)
    harmonia: +cosine(meanChroma(a.frames), meanChroma(b.frames)).toFixed(3),
    // contorno de energia suavizado (ritmo/loudness)
    timing: +pearson(norm(energiaA), norm(energiaB)).toFixed(3),
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

if (process.argv[1] && process.argv[1].endsWith('testar-fidelidade.mjs')) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('uso: node scripts/testar-fidelidade.mjs <original> <cover> [<cover2> ...]');
    process.exit(1);
  }
  const [original, ...covers] = args;
  console.log(`original: ${original}\n`);
  for (const cover of covers) {
    const r = await measureFidelity(original, cover);
    console.log(`cover: ${r.cover}`);
    console.log(`  duracao: ${r.duracaoOriginal}s (original) -> ${r.duracaoCover}s`);
    console.log(`  melodia: ${r.melodia}   nota dominante: ${r.notaDominante}   harmonia: ${r.harmonia}   timing: ${r.timing}\n`);
  }
}
