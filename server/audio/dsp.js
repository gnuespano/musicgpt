/**
 * DSP minimo: RNG deterministico, envelopes, osciladores, filtros,
 * reverb/delay e limiting. Tudo em JS puro para rodar sem dependencias.
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function pick(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length];
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Envelope ADSR em segundos, com sustain normalizado em [0..1]. */
export function adsr(t, dur, a, d, s, r) {
  if (t < 0) return 0;
  if (t < a) return a <= 0 ? 1 : t / a;
  if (t < a + d) return 1 + (s - 1) * ((t - a) / (d || 1e-6));
  if (t < dur) return s;
  const rt = t - dur;
  if (rt < r) return s * (1 - rt / (r || 1e-6));
  return 0;
}

/** Decaimento exponencial simples (1 -> 0). */
export function decay(t, tau) {
  return Math.exp(-t / (tau || 1e-6));
}

export function osc(type, phase) {
  const p = phase % 1;
  if (p < 0) p += 1;
  switch (type) {
    case 'sine':
      return Math.sin(2 * Math.PI * p);
    case 'square':
      return p < 0.5 ? 1 : -1;
    case 'saw':
      return 2 * p - 1;
    case 'triangle':
      return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    case 'noise':
      return Math.random() * 2 - 1;
    default:
      return 0;
  }
}

/** Filtro passa-baixa de 1 polo. */
export function makeLowpass() {
  let z = 0;
  return (x, cutoff, sr) => {
    const a = clamp(1 - Math.exp((-2 * Math.PI * cutoff) / sr), 0.0001, 0.999);
    z += a * (x - z);
    return z;
  };
}

/**
 * Filtro passa-alta de 1 polo (diferenca).
 * `normalized = true` aplica o ganho (1+a)/2, deixando o passante com ganho ~1
 * (sem isso, a resposta cai ~2a dB em toda a faixa, o que mataria o sinal).
 */
export function makeHighpass(normalized = false) {
  let prevIn = 0;
  let prevOut = 0;
  let k = 1;
  return (x, cutoff, sr) => {
    const a = clamp(1 - Math.exp((-2 * Math.PI * cutoff) / sr), 0.0001, 0.999);
    if (normalized) k = (1 + a) / 2;
    const out = k * (prevOut + x - prevIn);
    prevIn = x;
    prevOut = out;
    return out;
  };
}

/**
 * Resonador biquad passa-banda (usado para formantes de voz).
 * Coeficientes recalculados quando a frequencia muda.
 */
export function makeResonator() {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let a1 = 0;
  let a2 = 0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let lastFreq = -1;
  let lastQ = -1;
  return (x, freq, q, sr) => {
    if (freq !== lastFreq || q !== lastQ) {
      lastFreq = freq;
      lastQ = q;
      const w0 = (2 * Math.PI * freq) / sr;
      const alpha = Math.sin(w0) / (2 * q);
      const cosw = Math.cos(w0);
      const a0 = 1 + alpha;
      b0 = alpha / a0;
      b1 = 0;
      b2 = -alpha / a0;
      a1 = (-2 * cosw) / a0;
      a2 = (1 - alpha) / a0;
    }
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/** Delay com realimentacao + mix, em amostras. */
export function makeDelay(maxSamples, feedback = 0.35, mix = 0.25) {
  const buf = new Float32Array(maxSamples);
  let idx = 0;
  return (x, delaySamples) => {
    const d = Math.min(maxSamples - 1, Math.max(1, Math.floor(delaySamples)));
    const out = buf[(idx - d + maxSamples) % maxSamples];
    buf[idx] = x + out * feedback;
    idx = (idx + 1) % maxSamples;
    return x * (1 - mix) + out * mix;
  };
}

/** Reverb simples: 4 combs + 2 allpass (Schroeder). */
export function makeReverb(sr, roomSize = 0.7, mix = 0.2) {
  const combTimes = [0.0297, 0.0371, 0.0411, 0.0437].map((t) => Math.floor(t * sr * (0.7 + roomSize * 0.6)));
  const apTimes = [0.005, 0.0017].map((t) => Math.floor(t * sr));
  const combs = combTimes.map((n) => ({ buf: new Float32Array(n), idx: 0, fb: 0.72 + roomSize * 0.22 }));
  const aps = apTimes.map((n) => ({ buf: new Float32Array(n), idx: 0 }));
  return (x) => {
    let acc = 0;
    for (const c of combs) {
      const y = c.buf[c.idx];
      c.buf[c.idx] = x + y * c.fb;
      c.idx = (c.idx + 1) % c.buf.length;
      acc += y;
    }
    acc /= combs.length;
    for (const a of aps) {
      const y = a.buf[a.idx];
      const out = -acc + y;
      a.buf[a.idx] = acc + y * 0.5;
      a.idx = (a.idx + 1) % a.buf.length;
      acc = out;
    }
    return x * (1 - mix) + acc * mix;
  };
}

/** Limitador suave com lookahead simples. */
export function softLimit(x, ceiling = 0.92) {
  const a = Math.abs(x);
  if (a <= ceiling) return x;
  const over = a / ceiling;
  return Math.sign(x) * ceiling * (1 / over) ** 0.55;
}

/** Normaliza um par de canais stereo para o pico alvo. */
export function normalize(channels, peak = 0.92) {
  let max = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i += 1) {
      const v = Math.abs(ch[i]);
      if (v > max) max = v;
    }
  }
  if (max === 0) return 1;
  const gain = peak / max;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i += 1) ch[i] *= gain;
  }
  return gain;
}

/** Fade linear de entrada/saida sobre um buffer. */
export function applyFades(channel, sampleRate, fadeIn = 1.2, fadeOut = 2.5) {
  const n = channel.length;
  const fi = Math.min(Math.floor(fadeIn * sampleRate), Math.floor(n / 2));
  const fo = Math.min(Math.floor(fadeOut * sampleRate), Math.floor(n / 2));
  for (let i = 0; i < fi; i += 1) channel[i] *= i / fi;
  for (let i = 0; i < fo; i += 1) channel[n - 1 - i] *= i / fo;
}

/** Escreve um buffer mono em um par stereo, com panoramica. */
export function mixInto(stereo, left, right, gainL, gainR, offset = 0) {
  const len = left.length;
  const total = stereo[0].length;
  const start = Math.max(0, offset);
  const end = Math.min(total, offset + len);
  for (let i = start; i < end; i += 1) {
    const v = left[i - offset];
    stereo[0][i] += v * gainL;
    stereo[1][i] += v * gainR;
  }
}

/**
 * Chuva ambiente: ruido branco -> passa-baixa (dois polos) -> corte de graves.
 *
 * O ruido e gerado de forma independente para os dois canais, o que da uma
 * imagem stereo larga (sem microfonia). As rajadas (LFO) fazem a densidade
 * variar como uma chuva real, e nao como um chiado constante.
 *
 * @param {Float32Array[]} channels par stereo (misturado in place)
 * @param {number} sampleRate
 * @param {{gain?:number, cutoff?:number, depth?:number, hp?:number}} opts
 */
export function mixRain(channels, sampleRate, opts = {}) {
  const { gain = 1.0, cutoff = 1800, depth = 0.45, hp = 140 } = opts;
  const lpL = makeLowpass();
  const lpR = makeLowpass();
  const lpL2 = makeLowpass();
  const lpR2 = makeLowpass();
  const hpL = makeHighpass(true);
  const hpR = makeHighpass(true);
  const len = channels[0].length;

  for (let i = 0; i < len; i += 1) {
    const t = i / sampleRate;
    // rajadas: duas LFOs incomensuraveis (0,07 Hz e 0,23 Hz)
    const gust = 0.6 + depth * (
      0.6 * Math.sin(2 * Math.PI * 0.07 * t)
      + 0.4 * Math.sin(2 * Math.PI * 0.23 * t + 1.1)
    );
    const noiseL = Math.random() * 2 - 1;
    const noiseR = Math.random() * 2 - 1;
    // passa-baixa em cascata (2 polos) e depois corte de graves
    const rainL = hpL(lpL2(lpL(noiseL, cutoff, sampleRate), cutoff * 1.25, sampleRate), hp, sampleRate);
    const rainR = hpR(lpR2(lpR(noiseR, cutoff * 0.94, sampleRate), cutoff * 1.2, sampleRate), hp, sampleRate);
    channels[0][i] += rainL * gust * gain;
    channels[1][i] += rainR * gust * gain;
  }
}
