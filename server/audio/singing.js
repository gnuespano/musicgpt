/**
 * "Cantar" a voz do TTS: aplica a melodia da faixa sobre a fala.
 *
 * O endpoint /audio/speech do OpenRouter ignora `style`/`emotion` (verificado:
 * valores invalidos tambem devolvem 200 e nao mudam o audio), entao o caminho
 * e(local): pitch-shift com PSOLA (TD-PSOLA) seguindo a melodia.
 *
 * PSOLA preserva os formantes: os segmentos originais sao reaproveitados e
 * reposicionados com o espacamento do periodo alvo -> a voz "canta" a melodia
 * sem virar chipmunk.
 */

/**
 * F0 por autocorrelacao num trecho. 0 = trecho nao vozado.
 *
 * Usa center-clipping (reduz a influencia dos formantes) e escolhe o menor
 * lag com correlacao alta -> evita o classico erro de oitava (medir 100 Hz
 * quando a voz esta em 200 Hz).
 */
export function estimateF0(x, sr, pos, win = 2048, minF0 = 70, maxF0 = 400) {
  const end = Math.min(x.length, pos + win);
  const n = end - pos;
  if (n < 512) return 0;

  // center clipping no trecho
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    const v = Math.abs(x[pos + i]);
    if (v > peak) peak = v;
  }
  if (peak < 0.01) return 0;
  const clip = peak * 0.3;

  const minLag = Math.max(2, Math.floor(sr / maxF0));
  const maxLag = Math.min(Math.floor(sr / minF0), n - 1);
  const corr = new Float32Array(maxLag + 1);
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let c = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i + lag < n; i += 1) {
      const a = x[pos + i];
      const b = x[pos + i + lag];
      const ca = Math.abs(a) > clip ? a - Math.sign(a) * clip : 0;
      const cb = Math.abs(b) > clip ? b - Math.sign(b) * clip : 0;
      c += ca * cb;
      e1 += ca * ca;
      e2 += cb * cb;
    }
    const v = c / Math.sqrt(e1 * e2 + 1e-9);
    corr[lag] = v;
    if (v > bestCorr) bestCorr = v;
  }
  if (bestCorr < 0.35) return 0;

  // menor lag com correlacao quase maxima (anti-erro de oitava)
  const threshold = bestCorr * 0.85;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    if (corr[lag] >= threshold && corr[lag] > 0.3) return sr / lag;
  }
  return 0;
}

/** Sequencia de marcas de pitch (uma por periodo) com o periodo local. */
export function findPitchMarks(x, sr, win = 1024) {
  const marks = [];
  let pos = 0;
  const fallback = sr / 120;
  let guard = 0;
  while (pos < x.length - win && guard < 20000) {
    guard += 1;
    const f0 = estimateF0(x, sr, pos, win);
    const period = f0 > 0 ? sr / f0 : fallback;
    marks.push({ pos: pos + win / 2, period });
    pos += Math.max(16, period);
  }
  return marks;
}

/**
 * Pitch shift com PSOLA, com razao de variacao temporal.
 * @param {Float32Array} x sinal mono
 * @param {number} sr
 * @param {(t:number)=>number} alphaAt razao alvo (2^(semitons/12)); 1 = inalterado
 * @returns {Float32Array}
 */
export function psolaShift(x, sr, alphaAt) {
  const marks = findPitchMarks(x, sr);
  if (marks.length < 4) return x;

  const out = new Float32Array(x.length + sr);
  const outLen = x.length;

  let analysisIdx = 0;
  let synthPos = 0;

  while (synthPos < outLen && analysisIdx < marks.length) {
    const t = synthPos / sr;
    const alpha = Math.max(0.5, Math.min(2, alphaAt(t) || 1));
    const idx = Math.min(marks.length - 1, Math.round(analysisIdx));
    const mark = marks[idx];
    const period = mark.period;
    // janela de exatamente 2 periodos (principio do PSOLA: um periodo por segmento)
    const win = Math.max(64, Math.round(period * 2));
    const hann = new Float32Array(win);
    for (let i = 0; i < win; i += 1) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));

    const start = Math.round(mark.pos - win / 2);
    const dstStart = Math.round(synthPos - win / 2);
    for (let i = 0; i < win; i += 1) {
      const src = start + i;
      const dst = dstStart + i;
      if (src < 0 || src >= x.length || dst < 0 || dst >= out.length) continue;
      out[dst] += x[src] * hann[i];
    }

    synthPos += period / alpha;   // espacamento de sintese define a altura
    analysisIdx += 1 / alpha;     // consome a origem na taxa que preserva a duracao
  }

  return out.subarray(0, outLen);
}

/**
 * Faz a voz seguir a melodia.
 *
 * @param {Float32Array} x fala do TTS (mono)
 * @param {number} sr
 * @param {Array<{start:number, dur:number, midi:number}>} notes notas da melodia vocal (absolutas na faixa)
 * @param {number} takeStart inicio do take na faixa (segundos)
 * @param {number} takeDuration duracao do take (segundos)
 * @param {number} strength 0..1 (0 = sem canto, 1 = melodia cheia)
 */
export function singAlong(x, sr, notes, takeStart, takeDuration, strength = 0.8, timeScale = 1) {
  if (!notes || !notes.length || strength <= 0) return x;
  const relevant = notes
    .filter((n) => n.start >= takeStart - 0.05 && n.start < takeStart + takeDuration + 0.05)
    .sort((a, b) => a.start - b.start);
  if (!relevant.length) return x;

  // referencia: centro do trecho melódico -> a voz canta o CONTORNO da melodia
  // na propria faixa (como um cantor), em vez de ser forçada a nota absoluta.
  const ref = relevant.reduce((a, n) => a + n.midi, 0) / relevant.length;

  /** Nota da melodia no instante t (t = tempo dentro do take), com glissando. */
  const noteAt = (t) => {
    const abs = takeStart + t * timeScale;
    let i = 0;
    for (let k = 0; k < relevant.length; k += 1) {
      if (relevant[k].start <= abs) i = k;
      else break;
    }
    const cur = relevant[i];
    const next = relevant[i + 1];
    if (!next) return cur.midi;
    const span = Math.max(0.05, next.start - cur.start);
    const frac = Math.max(0, Math.min(1, (abs - cur.start) / span));
    return cur.midi + (next.midi - cur.midi) * frac;
  };

  const alphaAt = (t) => {
    const semitones = (noteAt(t) - ref) * strength;
    const limited = Math.max(-7, Math.min(7, semitones));
    return Math.pow(2, limited / 12);
  };

  const shifted = psolaShift(x, sr, alphaAt);

  // normaliza o nivel (o PSOLA atenua um pouco)
  let peak = 0;
  for (let i = 0; i < shifted.length; i += 1) peak = Math.max(peak, Math.abs(shifted[i]));
  if (peak > 0) {
    const g = Math.min(1.8, 0.9 / peak);
    for (let i = 0; i < shifted.length; i += 1) shifted[i] *= g;
  }
  return shifted;
}
