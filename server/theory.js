/**
 * Teoria musical: notas, escalas, acordes, progressoes e presets de genero.
 * Tudo deterministico a partir de uma seed, para que a mesma combinacao
 * de prompt + seed produza sempre a mesma musica.
 */

const NOTE_ALIASES = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function noteNameToMidi(name) {
  const m = /^([A-G])([#b]?)(-?\d+)$/.exec(name);
  if (!m) throw new Error(`Nota invalida: ${name}`);
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const base = NOTE_ALIASES[m[1]] + accidental;
  const octave = Number(m[3]);
  return (octave + 1) * 12 + base;
}

/** Converte nome ("A", "F#m", "Bb") para MIDI da fundamental. */
export function keyToMidi(key) {
  const m = /^([A-G][#b]?)(.*)$/.exec(key.trim());
  if (!m) throw new Error(`Tonalidade invalida: ${key}`);
  const letter = m[1][0];
  const accidental = m[1][1] === '#' ? 1 : m[1][1] === 'b' ? -1 : 0;
  const base = NOTE_ALIASES[letter] + accidental;
  return 12 * (3 + 1) + base; // C4 = 60
}

/**
 * Monta o acorde a partir do grau da escala (1-based) e do numero de notas.
 * Graus sao empilhados em tercas reais da escala (diatonicos).
 */
export function chordFromDegree(rootMidi, scale, degree, size = 3) {
  const notes = [];
  const len = scale.length;
  for (let i = 0; i < size; i += 1) {
    const idx = (degree - 1 + i * 2) % len;
    const octaves = Math.floor((degree - 1 + i * 2) / len);
    notes.push(rootMidi + scale[idx] + 12 * octaves);
  }
  return notes;
}

export function scaleNotes(rootMidi, scale, octave = 0) {
  return scale.map((s) => rootMidi + s + 12 * octave);
}

/**
 * Presets por genero. Cada preset define escala, progressoes, ritmo de
 * bateria, timbres e perfil de voz.
 */
export const GENRES = {
  pop: {
    label: 'Pop', bpm: 104, scale: 'major', roots: ['C', 'G', 'D', 'A'],
    progressions: [[1, 5, 6, 4], [1, 6, 4, 5], [4, 5, 3, 6]],
    drums: 'pop', bass: 'pop', arp: 0.45, lead: 0.7, pad: 0.55, pluck: 0.5,
    vocal: 'pop', brightness: 0.6, swing: 0.06,
  },
  mpb: {
    label: 'MPB', bpm: 92, scale: 'minor', roots: ['Am', 'Em', 'Dm', 'Gm'],
    progressions: [[1, 6, 4, 5], [1, 4, 6, 5], [6, 4, 1, 5]],
    drums: 'samba', bass: 'finger', arp: 0.5, lead: 0.55, pad: 0.5, pluck: 0.6,
    vocal: 'warm', brightness: 0.45, swing: 0.12,
  },
  sertanejo: {
    label: 'Sertanejo', bpm: 118, scale: 'mixolydian', roots: ['G', 'C', 'D', 'A'],
    progressions: [[1, 6, 4, 5], [1, 4, 1, 5], [1, 5, 6, 4]],
    drums: 'sertanejo', bass: 'round', arp: 0.35, lead: 0.75, pad: 0.35, pluck: 0.45,
    vocal: 'nasal', brightness: 0.55, swing: 0.04,
  },
  trap: {
    label: 'Trap', bpm: 140, scale: 'minor', roots: ['F#m', 'Dm', 'Gm', 'Am'],
    progressions: [[1, 6, 4, 5], [1, 4, 5, 1], [6, 5, 1, 4]],
    drums: 'trap', bass: '808', arp: 0.25, lead: 0.45, pad: 0.45, pluck: 0.3,
    vocal: 'rap', brightness: 0.35, swing: 0.0,
  },
  funk: {
    label: 'Funk', bpm: 132, scale: 'minor', roots: ['Am', 'Dm', 'Gm', 'Cm'],
    progressions: [[1, 6, 4, 5], [1, 4, 1, 5]],
    drums: 'funk', bass: '808', arp: 0.3, lead: 0.4, pad: 0.4, pluck: 0.25,
    vocal: 'rap', brightness: 0.4, swing: 0.0,
  },
  rock: {
    label: 'Rock', bpm: 128, scale: 'mixolydian', roots: ['E', 'G', 'D', 'A'],
    progressions: [[1, 7, 6, 5], [1, 5, 4, 1], [1, 7, 4, 1]],
    drums: 'rock', bass: 'punch', arp: 0.15, lead: 0.9, pad: 0.25, pluck: 0.35,
    vocal: 'rock', brightness: 0.7, swing: 0.0,
  },
  rock_nacional: {
    label: 'Rock Nacional', bpm: 122, scale: 'minor', roots: ['Am', 'Em', 'Dm', 'Gm'],
    progressions: [[1, 7, 6, 5], [1, 6, 4, 5], [6, 5, 4, 1]],
    drums: 'rock', bass: 'punch', arp: 0.2, lead: 0.85, pad: 0.3, pluck: 0.35,
    vocal: 'rock', brightness: 0.62, swing: 0.0,
  },
  samba: {
    label: 'Samba', bpm: 96, scale: 'minor', roots: ['Am', 'Dm', 'Gm', 'Cm'],
    progressions: [[1, 4, 2, 5], [1, 6, 4, 5], [1, 5, 6, 4]],
    drums: 'samba', bass: 'finger', arp: 0.55, lead: 0.5, pad: 0.45, pluck: 0.6,
    vocal: 'warm', brightness: 0.5, swing: 0.14,
  },
  pagode: {
    label: 'Pagode', bpm: 104, scale: 'minor', roots: ['Am', 'Dm', 'Gm', 'Em'],
    progressions: [[1, 4, 5, 1], [1, 6, 4, 5], [2, 5, 1, 6]],
    drums: 'pagode', bass: 'finger', arp: 0.5, lead: 0.55, pad: 0.45, pluck: 0.55,
    vocal: 'warm', brightness: 0.5, swing: 0.12,
  },
  forro: {
    label: 'Forro', bpm: 124, scale: 'major', roots: ['C', 'F', 'G', 'D'],
    progressions: [[1, 5, 6, 4], [1, 4, 5, 1], [4, 1, 5, 6]],
    drums: 'forro', bass: 'round', arp: 0.4, lead: 0.7, pad: 0.35, pluck: 0.5,
    vocal: 'forro', brightness: 0.6, swing: 0.05,
  },
  lofi: {
    label: 'Lo-fi', bpm: 78, scale: 'dorian', roots: ['Cm', 'F', 'Gm', 'A'],
    progressions: [[1, 4, 1, 5], [1, 7, 4, 5], [2, 5, 1, 4]],
    drums: 'lofi', bass: 'round', arp: 0.45, lead: 0.35, pad: 0.6, pluck: 0.55,
    vocal: 'lofi', brightness: 0.3, swing: 0.18,
  },
  house: {
    label: 'House', bpm: 124, scale: 'minor', roots: ['Am', 'Fm', 'Cm', 'Gm'],
    progressions: [[1, 6, 4, 5], [1, 5, 6, 4]],
    drums: 'house', bass: 'house', arp: 0.4, lead: 0.4, pad: 0.5, pluck: 0.4,
    vocal: 'pop', brightness: 0.55, swing: 0.0,
  },
  gospel: {
    label: 'Gospel', bpm: 88, scale: 'major', roots: ['Eb', 'Ab', 'Bb', 'Cm'],
    progressions: [[1, 4, 1, 5], [1, 5, 6, 4], [4, 1, 5, 1]],
    drums: 'gospel', bass: 'punch', arp: 0.35, lead: 0.75, pad: 0.65, pluck: 0.4,
    vocal: 'gospel', brightness: 0.6, swing: 0.08,
  },
  jazz: {
    label: 'Jazz', bpm: 96, scale: 'dorian', roots: ['Dm', 'G7', 'Cmaj7', 'Am7'],
    progressions: [[1, 4, 1, 5], [2, 5, 1, 4], [1, 6, 2, 5]],
    drums: 'jazz', bass: 'upright', arp: 0.3, lead: 0.7, pad: 0.5, pluck: 0.45,
    vocal: 'smoky', brightness: 0.45, swing: 0.22,
  },
  ambient: {
    label: 'Ambient', bpm: 68, scale: 'lydian', roots: ['C', 'F', 'G', 'Am'],
    progressions: [[1, 4, 1, 5], [1, 6, 4, 5]],
    drums: 'ambient', bass: 'pad', arp: 0.3, lead: 0.3, pad: 0.85, pluck: 0.5,
    vocal: 'airy', brightness: 0.35, swing: 0.0,
  },
  funk_br: {
    label: 'Funk brasileiro', bpm: 130, scale: 'minor', roots: ['Am', 'Dm', 'Em', 'Gm'],
    progressions: [[1, 6, 4, 5], [1, 5, 6, 4], [1, 4, 5, 1]],
    drums: 'baile', bass: '808', arp: 0.3, lead: 0.45, pad: 0.4, pluck: 0.3,
    vocal: 'rap', brightness: 0.45, swing: 0.0,
  },
};

export const MOODS = {
  alegre: { energy: 0.85, brightness: 0.7, valence: 0.8, swingBoost: 0.02 },
  animado: { energy: 0.95, brightness: 0.75, valence: 0.7, swingBoost: 0.0 },
  triste: { energy: 0.3, brightness: 0.3, valence: 0.15, swingBoost: 0.06 },
  melancolico: { energy: 0.4, brightness: 0.35, valence: 0.25, swingBoost: 0.08 },
  romantic: { energy: 0.45, brightness: 0.45, valence: 0.6, swingBoost: 0.06 },
  soak: { energy: 0.5, brightness: 0.4, valence: 0.4, swingBoost: 0.0 },
  ansioso: { energy: 0.75, brightness: 0.55, valence: 0.2, swingBoost: 0.0 },
  dancante: { energy: 0.9, brightness: 0.65, valence: 0.75, swingBoost: 0.0 },
  calmo: { energy: 0.25, brightness: 0.3, valence: 0.5, swingBoost: 0.1 },
  inspirador: { energy: 0.6, brightness: 0.6, valence: 0.7, swingBoost: 0.0 },
};

export const VOICE_STYLES = {
  pop: { range: [57, 76], vibrato: 0.014, formant: 1.0, rasp: 0.05, breath: 0.1, vibratoDelay: 0.35 },
  warm: { range: [52, 71], vibrato: 0.016, formant: 0.92, rasp: 0.08, breath: 0.16, vibratoDelay: 0.4 },
  rock: { range: [50, 74], vibrato: 0.022, formant: 1.08, rasp: 0.22, breath: 0.2, vibratoDelay: 0.3 },
  rap: { range: [45, 62], vibrato: 0.008, formant: 0.85, rasp: 0.3, breath: 0.25, vibratoDelay: 0.15 },
  nasal: { range: [52, 71], vibrato: 0.018, formant: 1.12, rasp: 0.14, breath: 0.12, vibratoDelay: 0.35 },
  smoky: { range: [50, 68], vibrato: 0.012, formant: 0.88, rasp: 0.18, breath: 0.28, vibratoDelay: 0.4 },
  forro: { range: [55, 74], vibrato: 0.02, formant: 1.05, rasp: 0.12, breath: 0.14, vibratoDelay: 0.32 },
  gospel: { range: [50, 76], vibrato: 0.026, formant: 1.02, rasp: 0.16, breath: 0.18, vibratoDelay: 0.45 },
  lofi: { range: [50, 68], vibrato: 0.01, formant: 0.9, rasp: 0.1, breath: 0.3, vibratoDelay: 0.4 },
  airy: { range: [55, 79], vibrato: 0.012, formant: 0.95, rasp: 0.03, breath: 0.35, vibratoDelay: 0.5 },
};

/** Estruturas de secao usadas na montagem da musica. */
export const STRUCTURES = {
  curta: [
    { name: 'Intro', bars: 2, type: 'intro' },
    { name: 'Verso 1', bars: 4, type: 'verse' },
    { name: 'Refrão', bars: 4, type: 'chorus' },
    { name: 'Verso 2', bars: 4, type: 'verse' },
    { name: 'Refrão', bars: 4, type: 'chorus' },
    { name: 'Outro', bars: 2, type: 'outro' },
  ],
  media: [
    { name: 'Intro', bars: 2, type: 'intro' },
    { name: 'Verso 1', bars: 4, type: 'verse' },
    { name: 'Pre-Refrão', bars: 2, type: 'pre' },
    { name: 'Refrão', bars: 4, type: 'chorus' },
    { name: 'Verso 2', bars: 4, type: 'verse' },
    { name: 'Refrão', bars: 4, type: 'chorus' },
    { name: 'Ponte', bars: 2, type: 'bridge' },
    { name: 'Refrão Final', bars: 4, type: 'chorus' },
    { name: 'Outro', bars: 2, type: 'outro' },
  ],
  longa: [
    { name: 'Intro', bars: 4, type: 'intro' },
    { name: 'Verso 1', bars: 8, type: 'verse' },
    { name: 'Pre-Refrão', bars: 4, type: 'pre' },
    { name: 'Refrão', bars: 8, type: 'chorus' },
    { name: 'Verso 2', bars: 8, type: 'verse' },
    { name: 'Refrão', bars: 8, type: 'chorus' },
    { name: 'Ponte', bars: 4, type: 'bridge' },
    { name: 'Refrão Final', bars: 8, type: 'chorus' },
    { name: 'Outro', bars: 4, type: 'outro' },
  ],
};
