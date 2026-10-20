/**
 * Motor de composicao local.
 *
 * Recebe um prompt + parametros e renderiza uma faixa stereo completa:
 * bateria, baixo, acordes/arpejos, melodia e voz sintetica alinhada a letra.
 * E deterministico: mesma seed + mesmos parametros -> mesma musica.
 */

import {
  GENRES,
  MOODS,
  VOICE_STYLES,
  SCALES,
  STRUCTURES,
  chordFromDegree,
  keyToMidi,
  midiToFreq,
} from '../theory.js';
import {
  adsr,
  applyFades,
  clamp,
  hashString,
  lerp,
  makeDelay,
  makeHighpass,
  makeLowpass,
  makeResonator,
  makeReverb,
  mixRain,
  mixInto,
  mulberry32,
  normalize,
  pick,
  softLimit,
} from './dsp.js';

const SR = 44100;

/** Duracao maxima de uma faixa: 2 minutos. */
export const MAX_DURATION_SEC = 120;

const DRUM_PATTERNS = {
  pop: {
    kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    open: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
  },
  rock: {
    kick: [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0],
    open: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  },
  trap: {
    kick: [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    hat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    open: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  },
  funk: {
    kick: [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    hat: [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1],
    open: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  },
  baile: {
    kick: [1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    snare: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
    hat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    open: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  },
  house: {
    kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
    open: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
  },
  samba: {
    kick: [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0],
    snare: [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0],
    hat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    open: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  },
  pagode: {
    kick: [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    snare: [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0],
    hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    open: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
  },
  sertanejo: {
    kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    open: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  },
  forro: {
    kick: [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    open: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  },
  gospel: {
    kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    open: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  },
  lofi: {
    kick: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0],
    open: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  jazz: {
    kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0],
    open: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  ambient: {
    kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    hat: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    open: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
};

const VOWELS = {
  a: [730, 1090], e: [530, 1840], i: [270, 2290], o: [570, 840], u: [300, 870],
};

const SECTION_DENSITY = {
  intro: 0.35, verse: 0.7, pre: 0.85, chorus: 1, bridge: 0.6, outro: 0.3,
};

export function detectGenre(prompt) {
  const p = (prompt || '').toLowerCase();
  const table = [
    ['trap', ['trap', 'trap', '808', 'bounce']],
    ['funk_br', ['funk brasileiro', 'baile', 'baile funk']],
    ['funk', ['funk']],
    ['sertanejo', ['sertanejo', 'sertaneja']],
    ['mpb', ['mpb', 'caipirinha', 'violao', 'violão']],
    ['samba', ['samba', 'sambada', 'carnaval', 'bloco']],
    ['pagode', ['pagode']],
    ['forro', ['forró', 'forro', 'xote', 'boca de ouro']],
    ['rock_nacional', ['rock nacional', 'rock brasileiro']],
    ['rock', ['rock', 'guitarra', 'guitar']],
    ['lofi', ['lo-fi', 'lofi', 'chill', 'study', 'estudo']],
    ['house', ['house', 'eletronica', 'eletrônica', 'techno', 'edm']],
    ['gospel', ['gospel', 'adoracao', 'adoração']],
    ['jazz', ['jazz', 'samba jazz', 'blues']],
    ['ambient', ['ambient', 'atmosferico', 'atmosférico', 'meditacao', 'meditação']],
    ['pop', ['pop', 'synthpop']],
  ];
  for (const [genre, keys] of table) {
    if (keys.some((k) => p.includes(k))) return genre;
  }
  return 'pop';
}

export function detectMood(prompt) {
  const p = (prompt || '').toLowerCase();
  const table = [
    ['melancolico', ['melancolico', 'melancólico', 'nostalgico', 'nostálgico', 'saudoso', 'madrugada']],
    ['triste', ['triste', 'tristeza', 'saudade']],
    ['ansioso', ['ansioso', 'ansiedade', 'nervoso', 'tensao', 'tensão']],
    ['romantic', ['romantico', 'romântico', 'amor', 'paixao', 'paixão', 'love']],
    ['dancante', ['dancante', 'dancar', 'dançar', 'festa', 'baile', 'energetico', 'energético']],
    ['calmo', ['calmo', 'tranquilo', 'tranquila', 'relaxante', 'suave', 'chuvoso', 'chuvosa']],
    ['inspirador', ['inspirador', 'inspiradora', 'sonho', 'esperanca', 'esperança']],
    ['soak', ['soberano', 'epico', 'épico', 'grandioso']],
    ['alegre', ['alegre', 'alegria', 'feliz', 'felicidade', 'divertido']],
  ];
  // vence o clima cujo termo aparece mais cedo no prompt (o mais saliente)
  let best = null;
  let bestPos = Infinity;
  for (const [mood, keys] of table) {
    for (const key of keys) {
      const pos = p.indexOf(key);
      if (pos >= 0 && pos < bestPos) {
        bestPos = pos;
        best = mood;
      }
    }
  }
  return best || 'alegre';
}

/** Separa a letra em silabas aproximadas (heuristica por grupos de vogais). */
export function splitSyllables(text) {
  const words = String(text)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-zA-ZÀ-ÿ' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = [];
  for (const word of words) {
    const groups = word.toLowerCase().match(/[aeiouy]+/g);
    const count = Math.max(1, groups ? groups.length : 1);
    if (count === 1) {
      out.push(word);
      continue;
    }
    // divide a palavra em pedacos com uma vogal cada
    let idx = 0;
    let current = '';
    let vowels = 0;
    for (const ch of word) {
      current += ch;
      if (/[aeiouy]/i.test(ch)) vowels += 1;
      if (vowels === 1 && current.length >= Math.ceil(word.length / count)) {
        out.push(current);
        current = '';
        vowels = 0;
      }
    }
    if (current) {
      if (out.length && count > 1) {
        out[out.length - 1] += current;
      } else {
        out.push(current);
      }
    }
    idx += 1;
  }
  return out.length ? out : ['la'];
}

function vowelOf(syllable) {
  const m = /[aeiouy]/i.exec(String(syllable || ''));
  return m ? m[0].toLowerCase() : 'a';
}

/**
 * Encurta a estrutura ate caber em maxBars compassos.
 * Remove do fim as secoes descartaveis (outro, ponte) e, se ainda assim
 * faltar, encurta a ultima secao.
 */
function trimStructure(structure, maxBars) {
  const out = structure.map((s) => ({ ...s }));
  const total = () => out.reduce((acc, s) => acc + s.bars, 0);
  const removable = ['outro', 'bridge'];
  let guard = 0;
  while (total() > maxBars && guard < 24) {
    guard += 1;
    const idx = out.findIndex((s) => removable.includes(s.type));
    if (idx >= 0) {
      out.splice(idx, 1);
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.bars > 1) {
      last.bars -= 1;
      continue;
    }
    break;
  }
  return out;
}

/** Monta o plano da musica: tom, andamento, estrutura e acordes por compasso. */
export function planSong(options) {
  const prompt = options.prompt || '';
  const seed = options.seed ?? hashString(prompt + (options.title || ''));
  const rng = mulberry32(seed);

  const genreKey = GENRES[options.genre] ? options.genre : detectGenre(prompt);
  const genre = GENRES[genreKey];
  const moodKey = MOODS[options.mood] ? options.mood : detectMood(prompt);
  const mood = MOODS[moodKey];
  // variedade (0..1): controla densidade do arpejo, repeticao da melodia,
  // inversoes de acorde e fills de bateria. 0 = parado e repetitivo, 1 = mutante.
  const variety = clamp(options.variety ?? 0.5, 0, 1);

  const targetDuration = clamp(options.duration || 75, 20, MAX_DURATION_SEC);
  const structureKey = targetDuration < 55 ? 'curta' : targetDuration < 110 ? 'media' : 'longa';
  let structure = STRUCTURES[structureKey].map((s) => ({ ...s }));

  const barsOf = (list) => list.reduce((acc, s) => acc + s.bars, 0);
  const baseBpm = genre.bpm * lerp(0.92, 1.08, rng()) * lerp(0.94, 1.06, mood.energy);
  const requiredBpm = (barsOf(structure) * 4 * 60) / targetDuration;
  // se o andamento natural do genero cabe no tempo pedido, ele manda;
  // caso contrario o andamento cede para a faixa caber na duracao
  const deviation = Math.abs(requiredBpm - baseBpm) / baseBpm;
  let bpm = deviation <= 0.15 ? baseBpm : clamp(requiredBpm, 55, 195);
  bpm = Math.round(bpm * 10) / 10;

  // garante que a faixa final respeite o teto de 2 minutos
  const maxBars = Math.floor((MAX_DURATION_SEC * bpm) / (4 * 60));
  structure = trimStructure(structure, maxBars);
  const totalBars = barsOf(structure);

  const beat = 60 / bpm;
  const bar = beat * 4;

  const rootName = pick(rng, genre.roots);
  const isMinor = /m$/.test(rootName);
  const scaleName = isMinor && SCALES[genre.scale] && genre.scale !== 'minor' ? 'minor' : genre.scale;
  const scale = SCALES[scaleName];
  const rootMidi = keyToMidi(rootName[0] + (rootName[1] === '#' ? '#' : rootName[1] === 'b' ? 'b' : '')) - 12;

  const progression = pick(rng, genre.progressions);
  const bars = [];
  const sectionTimeline = [];
  let barIndex = 0;
  for (const section of structure) {
    const startBar = barIndex;
    for (let i = 0; i < section.bars; i += 1) {
      const degree = progression[barIndex % progression.length];
      const chord = chordFromDegree(rootMidi, scale, degree, genreKey === 'jazz' ? 4 : 3);
      bars.push({
        index: barIndex,
        section: section.name,
        type: section.type,
        degree,
        chord,
        startTime: barIndex * bar,
      });
      barIndex += 1;
    }
    sectionTimeline.push({
      name: section.name,
      type: section.type,
      start: startBar * bar,
      duration: section.bars * bar,
      bars: section.bars,
    });
  }

  return {
    seed,
    rng,
    sr: SR,
    bpm,
    beat,
    bar,
    genre: genreKey,
    genreLabel: genre.label,
    mood: moodKey,
    scale: scaleName,
    scaleIntervals: scale,
    rootName,
    rootMidi,
    progression,
    structure,
    bars,
    totalBars,
    variety,
    duration: totalBars * bar,
  };
}

function renderKick(out, start, gain, rng) {
  const len = Math.floor(SR * 0.3);
  const buf = new Float32Array(len);
  let phase = 0;
  for (let i = 0; i < len; i += 1) {
    const t = i / SR;
    const f = 45 + 110 * Math.exp(-t / 0.028);
    phase += (2 * Math.PI * f) / SR;
    const click = i < 220 ? (rng() * 2 - 1) * Math.exp(-i / 60) * 0.5 : 0;
    buf[i] = (Math.sin(phase) * Math.exp(-t / 0.09) * 0.95 + click) * 0.9;
  }
  mixInto(out, buf, buf, gain, gain, start);
}

function renderSnare(out, start, gain, rng, bright = 1) {
  const len = Math.floor(SR * 0.26);
  const buf = new Float32Array(len);
  const hp = makeHighpass();
  let phase = 0;
  for (let i = 0; i < len; i += 1) {
    const t = i / SR;
    const noise = hp(rng() * 2 - 1, 1200 * bright, SR);
    phase += (2 * Math.PI * 185) / SR;
    const tone = Math.sin(phase) * Math.exp(-t / 0.035) * 0.35;
    buf[i] = (noise * Math.exp(-t / 0.075) * 0.9 + tone) * 0.8;
  }
  mixInto(out, buf, buf, gain, gain, start);
}

function renderHat(out, start, gain, rng, open = false) {
  const len = Math.floor(SR * (open ? 0.22 : 0.055));
  const buf = new Float32Array(len);
  const hp = makeHighpass();
  for (let i = 0; i < len; i += 1) {
    const t = i / SR;
    buf[i] = hp(rng() * 2 - 1, 6500, SR) * Math.exp(-t / (open ? 0.09 : 0.014)) * 0.5;
  }
  mixInto(out, buf, buf, gain * 0.7, gain * 0.75, start);
}

function renderClap(out, start, gain, rng) {
  const len = Math.floor(SR * 0.22);
  const buf = new Float32Array(len);
  const bp = makeResonator();
  for (let i = 0; i < len; i += 1) {
    const t = i / SR;
    const bursts = t < 0.02 ? 1 : t < 0.035 ? 0.7 : t < 0.05 ? 0.5 : 1;
    buf[i] = bp(rng() * 2 - 1, 1750, 2.2, SR) * Math.exp(-t / 0.055) * bursts * 0.8;
  }
  mixInto(out, buf, buf, gain, gain, start);
}

/** Sintetizador polifonico simples com 2 osciladores + filtro + envelope. */
function renderSynthNote(out, start, durSec, freq, opts) {
  const {
    type = 'saw', gain = 0.2, detune = 0.008, attack = 0.01, release = 0.18,
    cutoff = 2400, cutoffEnd = 900, pan = 0, sub = 0.25, square = 0,
  } = opts || {};
  const len = Math.floor(SR * (durSec + release + 0.05));
  const buf = new Float32Array(len);
  const lp = makeLowpass();
  let ph1 = 0;
  let ph2 = 0;
  let ph3 = 0;
  const detuneRatio = Math.pow(2, detune / 12);
  for (let i = 0; i < len; i += 1) {
    const t = i / SR;
    const env = adsr(t, durSec, attack, Math.min(0.25, durSec * 0.5), 0.75, release);
    const cut = lerp(cutoff, cutoffEnd, clamp(t / Math.max(0.001, durSec), 0, 1));
    ph1 += freq / SR;
    ph2 += (freq * detuneRatio) / SR;
    ph3 += (freq * 0.5) / SR;
    let s = 0;
    if (type === 'saw' || type === 'square') {
      s += (2 * (ph1 % 1) - 1) * 0.6;
      s += (2 * (ph2 % 1) - 1) * 0.4;
    } else if (type === 'triangle') {
      const p = ph1 % 1;
      s += (p < 0.5 ? 4 * p - 1 : 3 - 4 * p) * 0.6 + (2 * (ph2 % 1) - 1) * 0.3;
    } else {
      s += Math.sin(2 * Math.PI * ph1) * 0.7 + Math.sin(2 * Math.PI * ph2) * 0.3;
    }
    if (square > 0) s += (2 * ((ph1 * 1.0 + 0.25) % 1) - 1) * square * 0.4;
    s += Math.sin(2 * Math.PI * ph3) * sub;
    buf[i] = lp(s, cut, SR) * env * gain;
  }
  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);
  mixInto(out, buf, buf, gl, gr, start);
}

/** Voz sintetica por formantes: fonte pulsada + 2 ressonadores. */
function renderVocalPhrase(out, start, syllables, voice, rng) {
  let cursor = start;
  const notes = syllables.notes;
  for (let i = 0; i < notes.length; i += 1) {
    const note = notes[i];
    const dur = note.dur;
    const len = Math.floor(SR * (dur + 0.06));
    const buf = new Float32Array(len);
    const f1 = makeResonator();
    const f2 = makeResonator();
    const f3 = makeResonator();
    const vowel = VOWELS[vowelOf(note.text)] || VOWELS.a;
    let phase = 0;
    let lastFreq = note.freq;
    for (let s = 0; s < len; s += 1) {
      const t = s / SR;
      const env = adsr(t, dur, 0.035, 0.09, 0.85, 0.08);
      const vibDepth = voice.vibrato * (t > voice.vibratoDelay ? 1 : 0);
      const vib = Math.sin(2 * Math.PI * 5.2 * t) * vibDepth;
      const target = note.freq * (1 + vib);
      const freq = t < 0.045 ? lerp(lastFreq, target, t / 0.045) : target;
      lastFreq = freq;
      phase += freq / SR;
      const src = (2 * (phase % 1) - 1) * 0.9 + (rng() * 2 - 1) * voice.breath * 0.25;
      const shaped =
        f1(src, vowel[0] * voice.formant, 7, SR) * 1.0 +
        f2(src, vowel[1] * voice.formant, 9, SR) * 0.6 +
        f3(src, 2900 * voice.formant, 11, SR) * 0.18;
      const rasp = (rng() * 2 - 1) * voice.rasp * 0.06 * Math.exp(-t / 0.08);
      buf[s] = (shaped * 1.6 + rasp) * env * 0.5;
    }
    const pan = Math.sin(i * 1.7) * 0.12;
    const gl = Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = Math.sin(((pan + 1) * Math.PI) / 4);
    mixInto(out, buf, buf, gl, gr, cursor);
    cursor += Math.floor(SR * dur);
  }
  return cursor;
}

/** Gera a melodia vocal de uma linha de letra sobre o acorde corrente. */
function buildVocalLine(line, bar, scale, rng, voice) {
  const syllables = splitSyllables(line);
  const notes = [];
  const base = bar.chord[0];
  const [low, high] = voice.range;
  let contour = 0;
  const total = syllables.length;
  syllables.forEach((text, i) => {
    const chordTones = bar.chord;
    const choice = rng();
    let midi;
    if (choice < 0.62) {
      midi = chordTones[Math.floor(rng() * chordTones.length)];
    } else {
      const pool = scale.map((s) => base + s);
      midi = pool[Math.floor(rng() * pool.length)];
    }
    contour = clamp(contour + (rng() - 0.45) * 3, -4, 4);
    midi += Math.round(contour);
    while (midi < low) midi += 12;
    while (midi > high) midi -= 12;
    const isLast = i === total - 1;
    const dur = isLast ? 0.62 : i === 0 ? 0.34 : 0.24;
    notes.push({ text, midi, freq: midiToFreq(midi), dur });
  });
  return { text: line, notes, duration: notes.reduce((a, n) => a + n.dur, 0) };
}

/**
 * Renderiza a musica completa.
 * Retorna { channels, sampleRate, meta } com dois Float32Array (stereo).
 */
export async function renderSong(options, onProgress = () => {}) {
  const plan = planSong(options);
  const { rng } = plan;
  const genre = GENRES[plan.genre];
  const mood = MOODS[plan.mood];
  const voice = VOICE_STYLES[options.voiceStyle] || VOICE_STYLES[genre.vocal] || VOICE_STYLES.pop;

  const totalSamples = Math.ceil(plan.duration * SR) + SR;
  const stereo = [new Float32Array(totalSamples), new Float32Array(totalSamples)];
  const dry = [new Float32Array(totalSamples), new Float32Array(totalSamples)];

  await onProgress({ stage: 'estrutura', pct: 10, detail: `${plan.genreLabel} em ${plan.bpm} BPM, ${plan.totalBars} compassos` });

  const patterns = DRUM_PATTERNS[genre.drums] || DRUM_PATTERNS.pop;
  const stepDur = plan.beat / 4;
  const swing = clamp(genre.swing + mood.swingBoost, 0, 0.35);

  // ---------- bateria ----------
  for (const bar of plan.bars) {
    const density = SECTION_DENSITY[bar.type] ?? 0.8;
    for (let s = 0; s < 16; s += 1) {
      const swingOffset = s % 2 === 1 ? stepDur * swing : 0;
      const t = bar.startTime + s * stepDur + swingOffset;
      const start = Math.floor(t * SR);
      if (start >= totalSamples) continue;
      if (patterns.kick[s]) {
        renderKick(dry, start, 0.85 * lerp(0.6, 1, density) * lerp(0.85, 1.15, mood.energy), rng);
      }
      if (patterns.snare[s] && bar.type !== 'intro') {
        renderSnare(dry, start, 0.42 * lerp(0.6, 1, density), rng, genre.drums === 'trap' ? 1.2 : 1);
      }
      if (patterns.hat[s] && bar.type !== 'intro') {
        renderHat(dry, start, 0.2 * density, rng, false);
      }
      if (patterns.open[s] && bar.type !== 'intro') {
        renderHat(dry, start, 0.16 * density, rng, true);
      }
    }
    if (genre.drums === 'samba' || genre.drums === 'pagode' || genre.drums === 'baile') {
      // tamborim: notas em colcheias alternadas
      for (let s = 2; s < 16; s += 4) {
        const start = Math.floor((bar.startTime + s * stepDur) * SR);
        if (start < totalSamples) renderClap(dry, start, 0.16, rng);
      }
    }
    // fill de bateria no fim de blocos de 8 compassos (so com variedade alta)
    if (plan.variety > 0.3 && (bar.index + 1) % 8 === 0 && rng() < 0.6 * plan.variety) {
      for (let s = 0; s < 4; s += 1) {
        const start = Math.floor((bar.startTime + plan.bar - plan.beat + s * (plan.beat / 4)) * SR);
        if (start < totalSamples) renderSnare(dry, start, 0.22 + s * 0.06, rng, 1.15);
      }
    }
  }

  await onProgress({ stage: 'baixo e acordes', pct: 35 });

  // ---------- baixo ----------
  const bassPattern = {
    pop: [1, 0, 0, 1, 0, 0, 1, 0], rock: [1, 0, 1, 0, 1, 0, 1, 0], trap: [1, 0, 0, 0, 1, 0, 0, 0],
    funk: [1, 0, 1, 0, 0, 1, 0, 0], house: [1, 0, 0, 1, 0, 0, 1, 0], samba: [1, 0, 1, 0, 1, 0, 1, 0],
    pagode: [1, 0, 1, 0, 1, 0, 1, 0], sertanejo: [1, 0, 1, 0, 1, 0, 1, 0], forro: [1, 0, 1, 0, 1, 0, 1, 0],
    gospel: [1, 0, 0, 0, 1, 0, 0, 0], lofi: [1, 0, 0, 1, 0, 0, 1, 0], jazz: [1, 0, 0, 0, 1, 0, 0, 1],
    ambient: [1, 0, 0, 0, 0, 0, 0, 0], baile: [1, 0, 0, 0, 1, 0, 0, 0],
  }[genre.bass] || [1, 0, 0, 1, 0, 0, 1, 0];

  for (const bar of plan.bars) {
    if (bar.type === 'intro') continue;
    const rootNote = bar.chord[0] - 24;
    const freq = midiToFreq(rootNote);
    for (let e = 0; e < 8; e += 1) {
      if (!bassPattern[e]) continue;
      if (rng() < 0.12) continue;
      const dur = plan.beat * (e % 2 === 0 ? 0.9 : 0.45);
      const start = Math.floor((bar.startTime + e * (plan.beat / 2)) * SR);
      const type = genre.bass === '808' ? 'sine' : genre.bass === 'punch' ? 'square' : 'saw';
      renderSynthNote(dry, start, dur, freq, {
        type,
        gain: 0.3,
        sub: type === 'sine' ? 0.1 : 0.35,
        square: type === 'square' ? 0.5 : 0,
        cutoff: type === 'sine' ? 320 : 900,
        cutoffEnd: type === 'sine' ? 180 : 400,
        attack: 0.005,
        release: 0.08,
        pan: 0,
      });
    }
  }

  // ---------- acordes (pad + pluck) ----------
  for (const bar of plan.bars) {
    const start = Math.floor(bar.startTime * SR);
    const dur = plan.bar;
    const density = SECTION_DENSITY[bar.type] ?? 0.8;
    // variedade alta: occasionally inverte a voicing do acorde
    const voicing = plan.variety > 0.55 && rng() < 0.5 * plan.variety
      ? [...bar.chord.slice(1), bar.chord[0]]
      : bar.chord;
    if (bar.type !== 'intro' || rng() < 0.5) {
      for (const note of voicing) {
        const freq = midiToFreq(note - 12);
        renderSynthNote(dry, start, dur * 0.95, freq, {
          type: 'saw',
          gain: 0.075 * genre.pad * lerp(0.6, 1.1, density),
          cutoff: lerp(1200, 2600, genre.brightness),
          cutoffEnd: lerp(700, 1400, genre.brightness),
          attack: 0.25,
          release: 0.5,
          pan: (note - bar.chord[0]) * 0.05,
        });
      }
    }
    if (genre.pluck > 0 && bar.type !== 'intro') {
      for (let e = 0; e < 8; e += 1) {
        if (rng() > genre.pluck * 0.5) continue;
        const note = bar.chord[Math.floor(rng() * bar.chord.length)];
        const startPluck = Math.floor((bar.startTime + e * (plan.beat / 2)) * SR);
        renderSynthNote(dry, startPluck, plan.beat * 0.4, midiToFreq(note + 12), {
          type: 'triangle',
          gain: 0.075 * genre.pluck,
          cutoff: 3000,
          cutoffEnd: 1200,
          attack: 0.004,
          release: 0.12,
          pan: -0.2 + rng() * 0.4,
        });
      }
    }
  }

  await onProgress({ stage: 'arpejo e melodia', pct: 55 });

  // ---------- arpejo ----------
  // densidade escala com a variedade: baixa = raro e simples, alta = cheio
  const arpDensity = genre.arp * (0.4 + plan.variety * 1.2);
  if (genre.arp > 0) {
    for (const bar of plan.bars) {
      if (bar.type === 'intro') continue;
      const steps = 16;
      for (let s = 0; s < steps; s += 1) {
        if (rng() > arpDensity) continue;
        const note = bar.chord[Math.floor(rng() * bar.chord.length)];
        const octave = rng() < 0.35 ? 12 : 0;
        const start = Math.floor((bar.startTime + s * stepDur) * SR);
        renderSynthNote(dry, start, stepDur * 1.4, midiToFreq(note + 12 + octave), {
          type: 'square',
          gain: 0.05,
          cutoff: 4200,
          cutoffEnd: 1600,
          attack: 0.003,
          release: 0.09,
          pan: 0.3 - rng() * 0.6,
        });
      }
    }
  }

  // ---------- melodia ----------
  // variedade baixa -> a melodia repete mais; alta -> mais notas e mais saltos
  const leadNotes = [];
  let lastLead = null;
  for (const bar of plan.bars) {
    const density = SECTION_DENSITY[bar.type] ?? 0.8;
    if (bar.type === 'intro' || bar.type === 'outro') {
      if (rng() < 0.45) {
        const note = bar.chord[Math.floor(rng() * bar.chord.length)] + 12;
        const start = Math.floor((bar.startTime + plan.beat * 2) * SR);
        renderSynthNote(dry, start, plan.beat * 1.6, midiToFreq(note), {
          type: 'triangle', gain: 0.09 * genre.lead, cutoff: 3200, cutoffEnd: 1400, attack: 0.02, release: 0.3,
        });
      }
      continue;
    }
    const beats = rng() < 0.5 * density ? [0, 1.5, 2.5, 3.5] : [0, 2, 3, 3.5];
    beats.forEach((b, idx) => {
      if (rng() > density * (0.6 + 0.5 * genre.lead) * (0.65 + 0.7 * plan.variety)) return;
      const pool = bar.chord.concat(bar.chord.map((n) => n + 12));
      let midi;
      if (lastLead !== null && rng() < 0.45 * (1 - plan.variety)) {
        midi = lastLead; // repete a nota anterior (variedade baixa)
      } else {
        midi = pool[Math.floor(rng() * pool.length)];
      }
      lastLead = midi;
      const dur = plan.beat * (idx === beats.length - 1 ? 0.9 : 0.55);
      const start = Math.floor((bar.startTime + b * plan.beat) * SR);
      leadNotes.push({ midi, start, dur });
      renderSynthNote(dry, start, dur, midiToFreq(midi), {
        type: genre.lead > 0.7 ? 'saw' : 'square',
        gain: 0.085 * genre.lead,
        cutoff: lerp(1800, 4200, genre.brightness),
        cutoffEnd: 1200,
        attack: 0.012,
        release: 0.16,
        pan: 0.18,
      });
    });
  }

  await onProgress({ stage: 'voz', pct: 70 });

  // ---------- voz ----------
  // A melodia vocal e sempre calculada (mesmo no modo instrumental) porque o
  // TTS externo usa essa linha para "cantar" a letra em vez de so falar.
  const vocalTracks = [];
  const melody = [];
  if (options.lyrics && options.lyrics.trim()) {
    const lines = String(options.lyrics)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^\[.*\]$/.test(l));
    const singable = plan.bars.filter((b) => b.type === 'verse' || b.type === 'chorus' || b.type === 'pre' || b.type === 'bridge');
    if (singable.length && lines.length) {
      const slots = [];
      for (const bar of singable) {
        const line = lines[slots.length % lines.length];
        slots.push({ bar, line });
      }
      for (const slot of slots) {
        const vocal = buildVocalLine(slot.line, slot.bar, plan.scaleIntervals, rng, voice);
        const start = Math.floor((slot.bar.startTime + plan.beat * 0.5) * SR);
        // linha melódica em segundos (para o TTS cantar junto)
        let cursor = slot.bar.startTime + plan.beat * 0.5;
        for (const note of vocal.notes) {
          melody.push({ start: cursor, dur: note.dur, midi: note.midi });
          cursor += note.dur;
        }
        if (!options.instrumental) {
          renderVocalPhrase(dry, start, vocal, voice, rng);
        }
        vocalTracks.push({
          section: slot.bar.section,
          line: slot.line,
          start: slot.bar.startTime + plan.beat * 0.5,
          duration: vocal.duration,
        });
      }
    }
  }

  await onProgress({ stage: 'mixagem', pct: 85 });

  // ---------- mixagem, reverb e limitador ----------
  const reverb = makeReverb(SR, 0.75, 0.16);
  const delay = makeDelay(Math.floor(SR * 0.6), 0.32, 0.16);
  const delayTime = plan.beat * 0.75 * SR;
  for (let i = 0; i < totalSamples; i += 1) {
    const l = dry[0][i];
    const r = dry[1][i];
    const revL = reverb(l);
    const revR = reverb(r);
    const dL = delay(l, delayTime);
    const dR = delay(r, delayTime);
    stereo[0][i] = softLimit(l * 0.82 + revL * 0.5 + dL * 0.35);
    stereo[1][i] = softLimit(r * 0.82 + revR * 0.5 + dR * 0.35);
  }

  // ---------- camada lo-fi: chuva ambiente ----------
  // ruido branco -> passa-baixa, injetado no fundo (sem reverb) para nao
  // competir com a mixagem musical
  if (options.lofi) {
    mixRain(stereo, SR, { gain: 1.0, cutoff: 1800, depth: 0.45, hp: 140 });
    await onProgress({ stage: 'chuva ambiente', pct: 90 });
  }

  applyFades(stereo[0], SR, 0.8, 2.2);
  applyFades(stereo[1], SR, 0.8, 2.2);
  normalize(stereo, 0.9);

  await onProgress({ stage: 'pronto', pct: 100 });

  return {
    channels: stereo,
    sampleRate: SR,
    meta: {
      bpm: plan.bpm,
      key: plan.rootName,
      scale: plan.scale,
      genre: plan.genre,
      genreLabel: plan.genreLabel,
      mood: plan.mood,
      duration: plan.duration,
      bars: plan.totalBars,
      variety: plan.variety,
      progression: plan.progression,
      structure: plan.structure.map((s) => s.name),
      sections: plan.sectionTimeline,
      voice: options.voiceStyle || genre.vocal,
      rain: Boolean(options.lofi),
      vocals: vocalTracks,
      melody,
    },
  };
}
