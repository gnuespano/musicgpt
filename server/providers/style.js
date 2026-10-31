/**
 * Gerador de estilos "sophisticated" (prompt de producao) para a varinha magica.
 *
 * O objetivo e o mesmo do exemplo pedido:
 *
 *   Brazilian sertanejo universitario "sofrencia" with mid-tempo groove,
 *   strong acoustic guitar rhythm, punchy drums, and subtle accordion.
 *   Male vocalist with gritty, emotional voice, expressive delivery with
 *   dynamic intensity (soft verses, powerful chorus). Theme of heartbreak
 *   and betrayal, but with attitude and drinking-night vibe. Catchy hook,
 *   memorable chorus, modern radio production, high energy, engaging and
 *   not slow.
 *
 * Ou seja: 4 frases (ancora/groove, vocal, tema, producao) em ingles, com
 * instrumentacao, timbro de voz, arco dinamico, tema e ficha de producao.
 *
 * O texto em ingles e proposital: e a lingua que o ACE-Step entende melhor
 * para instrucoes de producao musical.
 *
 * Sempre variando: cada chamada sorteia outra combinacao e nunca repete a
 * anterior (ha um contador + RNG deterministico por semente).
 */

/* ------------------------------------------------------------------ *
 * Perfis por genero
 * ------------------------------------------------------------------ */

const PROFILES = {
  pop: {
    anchors: ['modern radio pop', 'polished dance-pop', 'synth-driven contemporary pop'],
    instruments: ['tight clean guitar', 'punchy synth bass', 'bright electric guitar hooks'],
    textures: ['glossy synth layers', 'airy pad swells', 'shimmering arpeggios'],
    drums: ['punchy modern drums', 'layered clapping backbeat'],
    tempos: ['up-tempo groove', 'driving four-on-the-floor beat', 'bouncy mid-tempo groove'],
  },
  mpb: {
    anchors: ['Brazilian MPB', 'intimate MPB', 'modern Brazilian pop with MPB roots'],
    instruments: ['warm nylon guitar picking', 'soft acoustic strumming', 'gentle electric guitar lines'],
    textures: ['breathy flute accents', 'subtle Rhodes chords', 'airy string pads'],
    drums: ['soft brushed kit', 'gentle samba percussion', 'restrained live drums'],
    tempos: ['laid-back mid-tempo groove', 'relaxed swing groove', 'slow-burning mid-tempo pocket'],
  },
  sertanejo: {
    anchors: ['Brazilian sertanejo universitario', 'modern Brazilian sertanejo', 'country-pop with Brazilian roots'],
    instruments: ['strong acoustic guitar rhythm', 'crisp nylon-and-steel guitar strumming', 'warm electric guitar fills'],
    textures: ['subtle accordion', 'accordion hooks answering the vocal', 'soft accordion pads'],
    drums: ['punchy drums', 'tight backbeat', 'snare-forward live drums'],
    tempos: ['mid-tempo groove', 'driving mid-tempo beat', 'rolling two-step pocket'],
  },
  forro: {
    anchors: ['Brazilian forro', 'forro de vaqueiro', ' festive northeastern forro'],
    instruments: ['rippling accordion melody', 'brisk zabumba patterns', 'triangle accents over triangle'],
    textures: ['pandeiro and tambourine flourishes', 'whistling chalango flourishes', 'bright accordion runs'],
    drums: ['bouncy zabumba groove', 'driving forro percussion', 'punchy baile drums'],
    tempos: ['up-tempo groove', 'fast(forro) groove', 'eager mid-tempo pocket'],
  },
  funk: {
    anchors: ['Brazilian funk', 'heavy baile funk', 'modern funk brasileiro'],
    instruments: ['rolling 808 bass', 'syncopated tambor pattern', 'whistle hook'],
    textures: ['dark synth stabs', 'industrial percussion noise', 'club-ready vocal chops'],
    drums: ['hard baile drums', 'glitched breakbeat drums', 'punchy tambor-driven beat'],
    tempos: ['heavy mid-tempo groove', 'punchy club groove', 'relentless 808 pocket'],
  },
  funk_br: {
    anchors: ['Brazilian funk', 'heavy baile funk', 'modern funk brasileiro'],
    instruments: ['rolling 808 bass', 'syncopated tambor pattern', 'whistle hook'],
    textures: ['dark synth stabs', 'industrial percussion noise', 'club-ready vocal chops'],
    drums: ['hard baile drums', 'glitched breakbeat drums', 'punchy tambor-driven beat'],
    tempos: ['heavy mid-tempo groove', 'punchy club groove', 'relentless 808 pocket'],
  },
  trap: {
    anchors: ['modern trap', 'heavy trap', 'melodic trap'],
    instruments: ['deep sliding 808', 'hazy bell melody', 'detuned synth leads'],
    textures: ['cinematic string pads', 'dark ambient textures', 'glitchy reverse swells'],
    drums: ['sharp hi-hat rolls', 'hard 808 kick pattern', 'snappy trap snares'],
    tempos: ['half-time groove', 'slow-burn trap pocket', 'mid-tempo trap groove'],
  },
  rock: {
    anchors: ['modern rock', 'classic rock with modern production', 'anthemic guitar rock'],
    instruments: ['crunchy power-chord guitars', 'tight palm-muted riff', 'wailing lead guitar'],
    textures: ['tape-saturated riff textures', 'wall-of-guitars layers', 'bright overdriven leads'],
    drums: ['heavy live drums', 'hard-hitting rock kit', 'punchy backbeat'],
    tempos: ['driving up-tempo groove', 'head-nodding mid-tempo groove', 'fast rock tempo'],
  },
  rock_nacional: {
    anchors: ['Brazilian rock', 'Brazilian guitar rock', 'contemporary Brazilian rock'],
    instruments: ['clean electric guitar tone', 'shimmering tremolo picking', 'sustained guitar leads'],
    textures: ['brass stabs', 'organ swells', 'layered guitar harmonics'],
    drums: ['tight live kit', 'punchy rock backbeat', 'crisp snare accents'],
    tempos: ['driving mid-tempo groove', 'anthemic rolling groove', 'up-tempo rock pocket'],
  },
  samba: {
    anchors: ['Brazilian samba', 'samba de roda', 'modern Brazilian samba'],
    instruments: ['fluid cavaquinho picking', 'syncopated pandeiro grooves', 'smooth surdo pulse'],
    textures: ['whistling apito lines', 'percussive tamborim fills', 'light hand-clap layers'],
    drums: ['rolling samba percussion', 'deep surdo-and-pandeiro groove', 'bouncy live percussion'],
    tempos: ['swinging mid-tempo groove', 'laid-back samba pocket', 'bossa-tinged swing groove'],
  },
  pagode: {
    anchors: ['Brazilian pagode', 'modern pagode', 'street-party pagode'],
    instruments: ['cavalinho hook', 'steady cavaco picking', 'nylon guitar comping'],
    textures: ['tantã scrapes', 'pandeiro rolls', 'occasional whistling answers'],
    drums: ['driving pagode kit', 'rolling percussion groove', 'clapping-heavy backbeat'],
    tempos: ['up-tempo groove', 'bouncy mid-tempo pocket', 'steady party groove'],
  },
  lofi: {
    anchors: ['lo-fi chill', 'dusty lo-fi hip-hop', 'late-night lo-fi'],
    instruments: ['detuned electric keys', 'soft electric piano chords', 'mellow upright bass'],
    textures: ['vinyl crackle and tape hiss', 'rainy ambience', 'distant city hum'],
    drums: ['dusty boom-bap drums', 'laid-back swung kit', 'soft brushed percussion'],
    tempos: ['slow laid-back groove', 'relaxed mid-tempo pocket', 'dreamy downtempo groove'],
  },
  house: {
    anchors: ['modern house', 'club house', 'deep house'],
    instruments: ['rolling synth bassline', 'filtered chord stabs', 'acid synth line'],
    textures: ['sweeping risers', 'airy pad layers', 'vocal chop textures'],
    drums: ['four-on-the-floor kick', 'tight offbeat claps', 'shaker-driven groove'],
    tempos: ['steady four-on-the-floor groove', 'rolling club groove', 'mid-tempo house pocket'],
  },
  gospel: {
    anchors: ['modern gospel soul', 'gospel choir', 'contemporary gospel'],
    instruments: ['warm Hammond organ', 'expressive piano lines', 'sustained string pads'],
    textures: ['layered choir stacks', 'handclaps and foot stomps', 'tape-warped organ'],
    drums: ['punchy gospel kit', 'shaking tambourine groove', 'driving live drums'],
    tempos: ['building mid-tempo groove', 'uplifting up-tempo groove', 'gospel shuffle groove'],
  },
  jazz: {
    anchors: ['modern jazz', 'late-night jazz trio', 'smooth contemporary jazz'],
    instruments: ['warm upright bass walk', 'smoky electric guitar comping', 'brushed snare work'],
    textures: ['muted trumpet answers', 'vinyl-era tape warmth', 'subtle Rhodes voicings'],
    drums: ['brush-kit swing', 'tight ride cymbal groove', 'restrained live drums'],
    tempos: ['relaxed mid-tempo swing', 'laid-back jazz groove', 'swung late-night pocket'],
  },
  ambient: {
    anchors: ['cinematic ambient', 'atmospheric ambient', 'modern ambient score'],
    instruments: ['slow piano motifs', 'long sustained pads', 'distant guitar harmonics'],
    textures: ['airy reverb tails', 'granular textures', 'faint vinyl noise'],
    drums: ['barely-there brushed pulse', 'soft heartbeat kick', 'no drums, just space'],
    tempos: ['slow ambient flow', 'weightless downtempo pulse', 'unhurried mid-tempo drift'],
  },
};

const GENERIC = {
  anchors: ['modern radio track', 'contemporary production', 'modern cross-genre pop'],
  instruments: ['clean electric guitar', 'round bass line', 'punchy synth chords'],
  textures: ['subtle pads', 'light percussion layers', 'airy texture'],
  drums: ['tight live drums', 'punchy modern kit', 'clean programmed drums'],
  tempos: ['mid-tempo groove', 'driving modern groove', 'steady up-tempo pocket'],
};

/* ------------------------------------------------------------------ *
 * Pools das demais frases
 * ------------------------------------------------------------------ */

const NICKNAMES = [
  'sofrencia', 'acre', 'saudade', 'faroeste', 'resposta', 'retrato',
  'inveja', 'volta pra casa', 'copo meio cheio', 'meia-noite',
];

const VOCAL_SUBJECTS = ['Male vocalist', 'Female vocalist', 'Androgynous vocalist'];

const VOCAL_TIMBRE = {
  pop: ['bright, polished', 'clear, radio-ready', 'sweet, melodic'],
  warm: ['warm, mellow', 'soft, honeyed', 'smooth and tender'],
  rock: ['gritty, powerful', 'rough, raspy', 'raw and muscular'],
  rap: ['rapping, rhythmic', 'spoken-word, punchy', 'tight, clipped'],
  nasal: ['nasal, characterful', 'twangy, rural', 'strained and emotional'],
  smoky: ['smoky, husky', 'low, sultry', 'husky and intimate'],
  forro: ['bright, festive', 'cheerful, nasal', 'warm and lively'],
  gospel: ['soulful, choir-backed', 'powerful, church-trained', 'rich, full-throated'],
  lofi: ['soft, breathy', 'hushed, intimate', 'drowsy and gentle'],
  airy: ['airy, ethereal', 'light, floating', 'weightless and delicate'],
  default: ['gritty, emotional', 'warm, expressive', 'clear, textured'],
};

const DELIVERIES = [
  'expressive delivery',
  'conversational delivery',
  'belting delivery',
  'restrained delivery',
  'playful delivery',
];

const DYNAMICS = [
  'dynamic intensity (soft verses, powerful chorus)',
  'dynamics that build from hushed verses to a belt',
  'restrained verses exploding into a huge chorus',
  'controlled verses with a cathartic final chorus',
  'tension in the verses, release in the refrain',
];

const THEMES_SAD = [
  'heartbreak and betrayal',
  'longing and distance',
  'fading love and late-night regret',
  'jealousy and old friendships',
  'homesickness in a crowded city',
  'a promise that was never kept',
];

const THEMES_UP = [
  'new love and second chances',
  'friendship after long years',
  'the freedom of starting over',
  'celebration and one more round',
  'pride after a hard season',
];

const THEMES_NEUTRAL = [
  'a city that never sleeps',
  'the road and what it costs',
  'ordinary days with extraordinary weight',
  'a story told too many times',
];

const TWISTS = [
  'but with attitude',
  'but with swagger',
  'with a hint of defiance',
  'yet somehow hopeful',
  'and a dose of irony',
];

const VIBES_SAD = [
  'drinking-night vibe',
  'midnight-drive mood',
  'late-bar confessional mood',
  'rain-on-the-window mood',
];

const VIBES_UP = [
  'rooftop-party energy',
  'weekend-carnival mood',
  'golden-hour cruising energy',
  'summer-block-party vibe',
];

const VIBES_NEUTRAL = [
  'cinematic late-night mood',
  'open-road freedom',
  'foggy-avenue mystery',
  'warm living-room glow',
];

const HOOKS = [
  'Catchy hook',
  'Immediate hook',
  'Singable hook',
  'Hook that lands on the first chorus',
  'Memorable top line',
];

const CHORUSES = [
  'memorable chorus',
  'anthemic chorus',
  'radio-ready chorus',
  'unforgettable chorus',
  'chorus built for sing-along',
];

const PRODUCTIONS = [
  'modern radio production',
  'vintage analog production',
  'streaming-ready production',
  'warm tape production',
  'crisp modern mix',
];

const ENERGIES_HIGH = [
  'high energy, engaging and not slow',
  'explosive and danceable',
  'relentless drive from the first bar',
  'euphoric payoff with no filler',
];

const ENERGIES_MID = [
  'steady build into a euphoric finish',
  'warm and laid-back but never sleepy',
  'controlled energy with a big final chorus',
  'rolling momentum that keeps the listener locked',
];

const ENERGIES_LOW = [
  'calm and spacious, slow but never boring',
  'hypnotic drift with a gentle lift',
  'unhurried and intimate, no dead air',
];

/* ------------------------------------------------------------------ *
 * Utilidades
 * ------------------------------------------------------------------ */

/** PRNG deterministico (mulberry32): mesma semente -> mesma combinacao. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(list, rnd) {
  return list[Math.floor(rnd() * list.length) % list.length];
}

let seedCounter = Math.floor(Math.random() * 100000);
function nextSeed() {
  seedCounter = (seedCounter + 1) % 1000000007;
  return (Date.now() % 1000000007) * 1000 + seedCounter;
}

/** Perfil do genero; quando nao existe, um perfil generico coerente. */
function profileFor(genre) {
  const key = String(genre || '').trim().toLowerCase();
  if (PROFILES[key]) return PROFILES[key];
  const label = key ? key.replace(/_/g, ' ') : 'modern';
  return {
    ...GENERIC,
    anchors: [`${label} with modern radio production`, `${label} reworked for the streaming era`],
  };
}

function moodBucket(mood) {
  const m = String(mood || '').trim().toLowerCase();
  if (['animado', 'dancante', 'alegre', 'inspirador', 'energetico'].includes(m)) return 'up';
  if (['triste', 'melancolico', 'romantic', 'ansioso', 'soak'].includes(m)) return 'sad';
  return 'neutral';
}

let lastStyle = '';

/**
 * Monta um estilo sofisticado completo.
 *
 * @param {object} opts
 * @param {string} [opts.genre]  chave do genero (sertanejo, mpb, trap...)
 * @param {string} [opts.mood]   clima (melancolico, animado...)
 * @param {string} [opts.vocals] estilo de voz (pop, warm, smoky...)
 * @param {number} [opts.seed]   semente (testes); sem ela, cada chamada varia
 * @returns {string} descricao em ingles, 4 frases
 */
export function buildSophisticatedStyle(opts = {}) {
  const { genre = '', mood = '', vocals = '', seed } = opts;
  const profile = profileFor(genre);
  const bucket = moodBucket(mood);

  const themes = bucket === 'up' ? THEMES_UP : bucket === 'sad' ? THEMES_SAD : THEMES_NEUTRAL;
  const vibes = bucket === 'up' ? VIBES_UP : bucket === 'sad' ? VIBES_SAD : VIBES_NEUTRAL;
  const energies = bucket === 'up' ? ENERGIES_HIGH : bucket === 'sad' ? ENERGIES_LOW : ENERGIES_MID;
  const timbres = VOCAL_TIMBRE[String(vocals || '').trim().toLowerCase()] || VOCAL_TIMBRE.default;

  let style = '';
  // ate 8 tentativas: garante que nunca repete o estilo anterior
  for (let attempt = 0; attempt < 8; attempt++) {
    const rnd = mulberry32(seed === undefined ? nextSeed() : seed);
    const anchor = pick(profile.anchors, rnd);
    const nickname = pick(NICKNAMES, rnd);
    const tempo = pick(profile.tempos, rnd);
    const instrument = pick(profile.instruments, rnd);
    const drums = pick(profile.drums, rnd);
    const texture = pick(profile.textures, rnd);
    const subject = pick(VOCAL_SUBJECTS, rnd);
    const timbre = pick(timbres, rnd);
    const delivery = pick(DELIVERIES, rnd);
    // evita "restrained delivery with restrained verses..." (mesma palavra nas duas frases)
    let dynamic = pick(DYNAMICS, rnd);
    if (dynamic.toLowerCase().includes(delivery.split(' ')[0].toLowerCase())) {
      dynamic = pick(DYNAMICS.filter((d) => !d.toLowerCase().includes(delivery.split(' ')[0].toLowerCase())), rnd);
    }
    const theme = pick(themes, rnd);
    const twist = pick(TWISTS, rnd);
    const vibe = pick(vibes, rnd);
    const hook = pick(HOOKS, rnd);
    const chorus = pick(CHORUSES, rnd);
    const production = pick(PRODUCTIONS, rnd);
    const energy = pick(energies, rnd);

    style = [
      `${anchor} "${nickname}" with ${tempo}, ${instrument}, ${drums}, and ${texture}.`,
      `${subject} with ${timbre} voice, ${delivery} with ${dynamic}.`,
      `Theme of ${theme}, ${twist} and ${vibe}.`,
      `${hook}, ${chorus}, ${production}, ${energy}.`,
    ].join(' ');

    if (seed === undefined && style === lastStyle) continue;
    break;
  }
  lastStyle = style;
  return style;
}

/**
 * Quality gate: o texto tem estrutura de prompt de producao?
 * Usado para aceitar/rejeitar a resposta da IA antes de devolver.
 */
export function isSophisticatedStyle(text) {
  const s = String(text || '').trim();
  if (s.length < 120) return false;
  if (s.includes('\n')) return false;
  if ((s.match(/\./g) || []).length < 3) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 28) return false;
  return /vocal|voice|delivery/i.test(s) && /hook|chorus|production|mix/i.test(s);
}

export default buildSophisticatedStyle;
