/**
 * Gerador de letras local (offline).
 *
 * Produz letra com estrutura em ingles ([Verse], [Chorus]...) como pede o
 * prompt de referencia do usuario. Todas as palavrasLEXICAL carriesm genero
 * para que artigos, possessivos e preposicoes concordem com o termo usado
 * ("a saudade", "meu silencio", "na rua vazia").
 *
 * O provider remoto (OpenAI) pode substituir isso quando ha chave.
 */

/* --------- dicionarios --------- */

const N = (w, g = 'f') => ({ w, g }); // nome
const V = (ger, inf) => ({ ger, inf }); // verbo
const A = (m, f = m) => ({ m, f }); // adjetivo

const THEMES = {
  noite: {
    keywords: ['noite', 'madrugada', 'lua', 'estrela', 'escuro', 'night'],
    places: [N('rua vazia'), N('cidade adormecida'), N('esquina de bar'), N('quarto aceso', 'm'), N('beira do rio'), N('beco sem luz', 'm'), N('parada de ônibus')],
    nouns: [N('silêncio', 'm'), N('neon', 'm'), N('saudade'), N('farol', 'm'), N('chuva'), N('vento', 'm'), N('memória'), N('madrugada'), N('solidão')],
    objects: [N('chave do carro'), N('copo meio cheio', 'm'), N('celular sem sinal', 'm'), N('foto amassada'), N('guarda-chuva', 'm')],
    verbs: [V('andando sozinho', 'andar sozinho'), V('contando as horas', 'contar as horas'), V('esperando o sol', 'esperar o sol'), V('perdendo o sono', 'perder o sono'), V('me refugiando do barulho', 'se refugiar do barulho')],
    adjs: [A('silencioso', 'silenciosa'), A('devagar'), A('infinito', 'infinita'), A('duvidoso', 'duvidosa'), A('pesado', 'pesada')],
    times: ['de madrugada', 'no fim da madrugada', 'quase cinco da manhã', 'antes do primeiro ônibus'],
    hook: '{Art_noun} {noun} ainda dói {loc_place}',
  },
  amor: {
    keywords: ['amor', 'paixão', 'paixao', 'love', 'namorada', 'namorado', 'beijo', 'encontro'],
    places: [N('quarto vazio'), N('telhado'), N('varanda'), N('carro parado', 'm'), N('coração'), N('cômodo escuro', 'm')],
    nouns: [N('teu nome', 'm'), N('seu riso', 'm'), N('promessa'), N('distância'), N('ciúme', 'm'), N('saudade')],
    objects: [N('carta antiga'), N('anel de prata', 'm'), N('foto do beach'), N('mensagem não enviada')],
    verbs: [V('te procurando', 'te procurar'), V('te esperando', 'te esperar'), V('te lembrando', 'te lembrar'), V('te amando', 'te amar'), V('te desejando', 'te desejar')],
    adjs: [A('insuportável'), A('honesto', 'honesta'), A('quieto', 'quieta'), A('eterno', 'eterna')],
    times: ['desde aquela noite', 'por mais um verão', 'sem você aqui', 'desde que eu te vi'],
    hook: '{poss_noun} {noun} ainda dói {loc_place}',
  },
  saudade: {
    keywords: ['saudade', 'saudades', 'nostalgia', 'nostalgico', 'memoria', 'saudoso', 'recomeço'],
    places: [N('casa antiga'), N('bairro de criança', 'm'), N('quadro da parede', 'm'), N('banheiro da vó', 'm'), N('recreio', 'm')],
    nouns: [N('fita cassete'), N('carrinho de controle', 'm'), N('música antiga'), N('mãe'), N('amizade'), N('casa'), N('infância')],
    objects: [N('foto de três'), N('bilhete dobrado', 'm'), N('chave do portão'), N('recording antigo', 'm')],
    verbs: [V('lembrando', 'lembrar'), V('revendo', 'rever'), V('chamando', 'chamar'), V('voltando no tempo', 'voltar no tempo'), V('sentindo falta', 'sentir falta')],
    adjs: [A('fundo', 'funda'), A('leve'), A('eterno', 'eterna'), A('doce')],
    times: ['no quarto escuro', 'de madrugada', 'quando chove', 'na volta pra casa'],
    hook: 'Ainda mora dentro {de_noun}',
  },
  cidade: {
    keywords: ['cidade', 'rua', 'metro', 'ônibus', 'ônibus', 'sp', 'rio', 'bh', 'city', 'trânsito', 'trabalho'],
    places: [N('esquina'), N('viaduto', 'm'), N('beco', 'm'), N('terminal', 'm'), N('garagem'), N('feira')],
    nouns: [N('luz de neon'), N('multa'), N('poeira'), N('barulho', 'm'), N('gente'), N('dinheiro', 'm'), N('cidade')],
    objects: [N('celular vibrando', 'm'), N('chave reserva'), N('ingresso', 'm'), N('copo de café', 'm')],
    verbs: [V('cruzando a cidade', 'cruzar a cidade'), V('contando os trocados', 'contar os trocados'), V('perdendo o ônibus', 'perder o ônibus'), V('esperando o sinal', 'esperar o sinal'), V('chegando tarde', 'chegar tarde')],
    adjs: [A('cansado', 'cansada'), A('acelerado', 'acelerada'), A('ansioso', 'ansiosa'), A('gigante'), A('sem tempo')],
    times: ['no rush', 'na hora do rush', 'na saída do trabalho', 'no último minuto'],
    hook: '{Art_noun} {noun} não dorme, e eu também não',
  },
  festa: {
    keywords: ['festa', 'balada', 'dança', 'dancar', 'clube', 'party', 'carnaval', 'baile'],
    places: [N('pista'), N('camarote', 'm'), N('corredor', 'm'), N('varanda'), N('mesa do bar')],
    nouns: [N('som grave', 'm'), N('luz colorida'), N('confete', 'm'), N('suor', 'm'), N('playlist'), N('noite')],
    objects: [N('copo de gelo', 'm'), N('convite', 'm'), N('alto-falante', 'm'), N('botão do microfone', 'm')],
    verbs: [V('dançando a noite toda', 'dançar a noite toda'), V('gritando o refrão', 'gritar o refrão'), V('saindo no refrão', 'sair no refrão'), V('perdendo a hora', 'perder a hora'), V('sentindo o grave', 'sentir o grave')],
    adjs: [A('louco', 'louca'), A('elétrico', 'elétrica'), A('febril'), A('absurdo', 'absurda')],
    times: ['até o sol nascer', 'de madrugada', 'na última música', 'no drop'],
    hook: 'Se {art_noun} {noun} parar, a gente ainda dança',
  },
  estrada: {
    keywords: ['estrada', 'viagem', 'carro', 'rodovia', 'road', 'dirigir', 'rota', 'liberdade'],
    places: [N('margem da rodovia'), N('posto de gasolina', 'm'), N('estrada vazia'), N('farol da entrada', 'm'), N('túnel', 'm')],
    nouns: [N('horizonte', 'm'), N('combustível', 'm'), N('distância'), N('vento', 'm'), N('chuva'), N('volante', 'm')],
    objects: [N('mapa', 'm'), N('porta-fotos', 'm'), N('rádio velho', 'm'), N('bilhete de estrada', 'm')],
    verbs: [V('dirigindo sem destino', 'dirigir sem destino'), V('deixando o passado pra trás', 'deixar o passado pra trás'), V('acelerando', 'acelerar'), V('parando no acostamento', 'parar no acostamento'), V('seguindo o sol', 'seguir o sol')],
    adjs: [A('longo', 'longa'), A('cansado', 'cansada'), A('livre'), A('tremido', 'tremida')],
    times: ['desde as cinco da manhã', 'no fim da tarde', 'no meio do nada', 'quando a estrada acaba'],
    hook: '{Art_noun} {noun} não cobra resposta',
  },
  chuva: {
    keywords: ['chuva', 'tempestade', 'chover', 'rain', 'garoa', 'inverno'],
    places: [N('banco do carro', 'm'), N('varanda'), N('calçada'), N('telhado', 'm'), N('quarto', 'm')],
    nouns: [N('gota'), N('trovão', 'm'), N('asfalto', 'm'), N('guarda-chuva', 'm'), N('vento', 'm'), N('vidro', 'm')],
    objects: [N('janela embaçada'), N('guarda-chuva quebrado', 'm'), N('música no fone')],
    verbs: [V('esperando a tempestade', 'esperar a tempestade'), V('contando os segundos', 'contar os segundos'), V('deixando a chuva lavar', 'deixar a chuva lavar'), V('andando na garoa', 'andar na garoa')],
    adjs: [A('frio', 'fria'), A('lento', 'lenta'), A('pesado', 'pesada'), A('silencioso', 'silenciosa')],
    times: ['no meio da tarde', 'quase anoitecendo', 'de madrugada', 'durante a tempestade'],
    hook: 'Chove, mas eu prefiro a versão sem {art_noun2} {noun2}',
  },
  liberdade: {
    keywords: ['liberdade', 'livre', 'flight', 'voar', 'fugir', 'independente', 'sonho'],
    places: [N('topo do morro', 'm'), N('beira do mar'), N('porta de embarque'), N('estrada vazia'), N('campo aberto', 'm')],
    nouns: [N('horizonte', 'm'), N('vento', 'm'), N('asa'), N('passaporte', 'm'), N('céu', 'm'), N('chão', 'm')],
    objects: [N('mala pronta'), N('bilhete só de ida', 'm'), N('chave de casa'), N('caderno de viagem', 'm')],
    verbs: [V('soltando o peso', 'soltar o peso'), V('voando sem mapa', 'voar sem mapa'), V('deixando tudo pra trás', 'deixar tudo pra trás'), V('acordando cedo', 'acordar cedo')],
    adjs: [A('leve'), A('longo', 'longa'), A('doce'), A('livre')],
    times: ['cedo demais', 'antes do sol', 'na hora exata', 'sem hora marcada'],
    hook: 'Eu não vim até aqui pra fingir que era fácil',
  },
  resiliencia: {
    keywords: ['força', 'forca', 'resiliência', 'recomeço', 'superar', 'reerguer', 'vitoria', 'vitória', 'fé'],
    places: [N('beira do caminho', 'm'), N('quarto bagunçado', 'm'), N('chão da fábrica', 'm'), N('cozinha de madrugada')],
    nouns: [N('esforço', 'm'), N('silêncio', 'm'), N('recomeço', 'm'), N('cinza'), N('sol', 'm'), N('estrada')],
    objects: [N('caderno de metas', 'm'), N('café frio', 'm'), N('chave velha'), N('fita de vídeo')],
    verbs: [V('levantando de novo', 'levantar de novo'), V('seguindo em frente', 'seguir em frente'), V('segurando firme', 'segurar firme'), V('refazendo a conta', 'refazer a conta'), V('acendendo a luz', 'acender a luz')],
    adjs: [A('duro', 'dura'), A('firme'), A('quieto', 'quieta'), A('novo', 'nova')],
    times: ['de novo', 'mais uma vez', 'quando eu já não aguentava', 'no primeiro dia'],
    hook: 'Caiu, mas nunca parou de levantar',
  },
};

const GENERIC = {
  keywords: [],
  places: [N('lugar nenhum', 'm'), N('caminho sem nome', 'm'), N('mesa de casa'), N('janela da sala'), N('último ponto', 'm')],
  nouns: [N('silêncio', 'm'), N('tempo', 'm'), N('saudade'), N('luz'), N('cansaço', 'm'), N('verdade')],
  objects: [N('caderno', 'm'), N('chave'), N('música antiga'), N('bilhete', 'm'), N('café', 'm')],
  verbs: [V('seguindo em frente', 'seguir em frente'), V('olhando pra trás', 'olhar pra trás'), V('tentando de novo', 'tentar de novo'), V('ficando por aqui', 'ficar por aqui'), V('partindo de novo', 'partir de novo')],
  adjs: [A('leve'), A('pesado', 'pesada'), A('estranho', 'estranha'), A('honesto', 'honesta'), A('calmo', 'calma')],
  times: ['mais uma noite', 'sem saber o que fazer', 'depois de tudo', 'no fim da semana'],
  hook: 'Se a vida não fez sentido, eu invento o meu',
};

const EN_OVERRIDE = {
  keywords: ['english', 'in english', 'ingles', 'inglês'],
  places: [N('empty street'), N('borrowed room'), N('edge of town'), N('midnight diner')],
  nouns: [N('silence', 'm'), N('neon light'), N('winter night'), N('cheap radio'), N('old song')],
  objects: [N('folded note'), N('half finished song'), N('last ticket home')],
  verbs: [V('still walking home', 'walk home'), V('counting the headlights', 'count the headlights'), V('holding the line', 'hold the line'), V('learning to let go', 'let go')],
  adjs: [A('heavy'), A('quiet'), A('endless'), A('honest')],
  times: ['two in the morning', 'before the first train', 'after the last song'],
  hook: 'I still remember the way you said my name',
};

/* --------- concordancia --------- */

const ART = { m: 'o', f: 'a' };
const ART_CAP = { m: 'O', f: 'A' };
const POSS = { m: 'meu', f: 'minha' };
const POSS2 = { m: 'teu', f: 'tua' };
const LOC = { m: 'no', f: 'na' };
const DE = { m: 'do', f: 'da' };
const PARA = { m: 'para o', f: 'para a' };

/* --------- templates --------- */

const SECTION_PLAN = [
  { tag: '[Intro]', lines: 2, pool: 'intro' },
  { tag: '[Verse 1]', lines: 4, pool: 'verse' },
  { tag: '[Pre-Chorus]', lines: 2, pool: 'pre' },
  { tag: '[Chorus]', lines: 4, pool: 'chorus' },
  { tag: '[Verse 2]', lines: 4, pool: 'verse' },
  { tag: '[Chorus]', lines: 4, pool: 'chorus' },
  { tag: '[Bridge]', lines: 2, pool: 'bridge' },
  { tag: '[Chorus]', lines: 4, pool: 'chorus' },
  { tag: '[Outro]', lines: 2, pool: 'outro' },
];

const POOLS = {
  verse: [
    'Eu {verb} {loc_place}',
    'Deixei {art_object} {object} {loc_place}',
    'Cheguei {loc_place} {verb}',
    '{Art_noun} {noun} me lembra {de_place}',
    '{Art_noun} {noun} mora {loc_place}',
    'Sinto {art_noun} {noun} demais {loc_place}',
    'Não sei {inf} sem {art_object} {object}',
    '{time_cap}, {verb}',
    '{poss_noun} {noun} ainda pesa {loc_place}',
    'Ficou {poss_object} {object} {loc_place}',
    'Cada {noun} me leva {para_place}',
    'Tô {verb} onde {art_noun} {noun} não alcança',
    'A luz bate {loc_object}',
  ],
  pre: [
    'E se {art_noun} {noun} voltar?',
    'Só falta {art_noun} {noun} dizer a hora',
    '{poss_noun} {noun} pede mais {de_noun2}',
    'Vem, {art_noun} {noun} ainda sabe o meu nome',
    'Não é {art_noun} {noun}, mas tá perto',
    'E se eu pedir mais {de_noun}?',
  ],
  chorus: [
    '{hook}',
    'Então {verb} e não vou voltar atrás',
    '{poss_noun} {noun} é {poss_noun2} {noun2}',
    'Se o mundo cair, eu continuo {verb}',
    'Nada muda {poss_noun} {noun}',
    '{Art_noun} {noun} mora dentro {de_noun2}',
    'Eu sou o que sobrou {de_noun}',
    'Canta alto, porque {art_noun} {noun} é {poss2_noun}',
  ],
  bridge: [
    'Se eu voltar, é porque {art_noun} {noun} deixou',
    '{Art_noun} {noun} não pede mais nada de mim',
    'Talvez {de_place} não fosse o bastante',
    'Tudo que eu sou cabe {loc_object}',
  ],
  intro: [
    '({loc_place})',
    '({time})',
    '(e {art_noun} {noun} ainda pulsa)',
  ],
  outro: [
    '(e {art_noun} {noun} fica)',
    '({loc_place})',
    '(sem pressa, sem {art_noun} {noun})',
  ],
};

const POOLS_EN = {
  verse: [
    'I am {verb} {loc_place}',
    'I left {art_object} {object} {loc_place}',
    'I got {para_place} and {verb}',
    '{Art_noun} {noun} still reminds me {de_place}',
    'I feel {art_noun} {noun} too much {loc_place}',
    'I do not know how to {inf} without {art_object} {object}',
    '{time_cap}, {verb}',
    '{poss_noun} {noun} still follows me {loc_place}',
    '{poss_noun} {noun} still lives {loc_place}',
    'Every {noun} takes me {para_place}',
    'I keep {verb} where {art_noun} {noun} cannot reach',
    'The light hits {loc_object}',
  ],
  pre: [
    'And what if {art_noun} {noun} comes back?',
    'Only {art_noun} {noun} knows the time',
    '{poss_noun} {noun} needs more {de_noun2}',
    'Come on, {art_noun} {noun} still knows my name',
    'It is not {art_noun} {noun}, but it is close',
    'And if I ask for more {de_noun}?',
  ],
  chorus: [
    '{hook}',
    'So I keep {verb} and I am not going back',
    '{poss_noun} {noun} is {poss_noun2} {noun2}',
    'If the world falls, I keep {verb}',
    'Nothing changes {poss_noun} {noun}',
    '{Art_noun} {noun} lives inside {de_noun2}',
    'I am what is left {de_noun}',
    'Sing it loud, because {art_noun} {noun} belongs to us',
  ],
  bridge: [
    'If I come back, it is because {art_noun} {noun} let go',
    '{Art_noun} {noun} does not need anything from me',
    'Maybe {de_place} was never enough',
    'Everything I am fits in {loc_object}',
  ],
  intro: [
    '({loc_place})',
    '({time})',
    '(and {art_noun} {noun} still pulses)',
  ],
  outro: [
    '(and {art_noun} {noun} stays)',
    '({loc_place})',
    '(no rush, no {art_noun} {noun})',
  ],
};

/* --------- helpers --------- */

function detectTheme(prompt) {
  const p = String(prompt || '').toLowerCase();
  for (const [name, theme] of Object.entries(THEMES)) {
    if (theme.keywords.some((k) => p.includes(k))) return { name, theme };
  }
  if (/ingl[eê]s|english/.test(p)) return { name: 'en', theme: EN_OVERRIDE };
  return { name: 'livre', theme: GENERIC };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function fill(template, bank, rng, lang = 'pt', depth = 0) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];
  const place = pick(bank.places);
  const noun = pick(bank.nouns);
  const noun2 = pick(bank.nouns);
  const object = pick(bank.objects);
  const verb = pick(bank.verbs);
  const adj = pick(bank.adjs);
  const time = pick(bank.times);
  const adjFor = (g) => (g === 'm' ? adj.m : adj.f);
  const en = lang === 'en';

  // slots compostos: preposicao + artigo + palavra
  const ART_X = en ? { m: 'the', f: 'the' } : ART;
  const ART_CAP_X = en ? { m: 'The', f: 'The' } : ART_CAP;
  const POSS_X = en ? { m: 'my', f: 'my' } : POSS;
  const POSS2_X = en ? { m: 'your', f: 'your' } : POSS2;
  const LOC_X = en ? { m: 'in the', f: 'in the' } : LOC;
  const DE_X = en ? { m: 'of the', f: 'of the' } : DE;
  const PARA_X = en ? { m: 'to the', f: 'to the' } : PARA;

  const locPlace = `${LOC_X[place.g]} ${place.w}`;
  const dePlace = `${DE_X[place.g]} ${place.w}`;
  const paraPlace = `${PARA_X[place.g]} ${place.w}`;
  const locObject = en ? `the ${object.w}` : `${LOC[object.g]} ${object.w}`;
  const deObject = `${DE_X[object.g]} ${object.w}`;
  const locNoun = `${LOC_X[noun.g]} ${noun.w}`;
  const deNoun = `${DE_X[noun.g]} ${noun.w}`;
  const deNoun2 = `${DE_X[noun2.g]} ${noun2.w}`;

  const values = {
    place: place.w,
    art_place: ART_X[place.g],
    Art_place: ART_CAP_X[place.g],
    loc_place: locPlace,
    de_place: dePlace,
    para_place: paraPlace,
    noun: noun.w,
    art_noun: ART_X[noun.g],
    Art_noun: ART_CAP_X[noun.g],
    poss_noun: POSS_X[noun.g],
    poss2_noun: POSS2_X[noun.g],
    de_noun: deNoun,
    loc_noun: locNoun,
    noun2: noun2.w,
    art_noun2: ART_X[noun2.g],
    poss_noun2: POSS_X[noun2.g],
    de_noun2: deNoun2,
    object: object.w,
    art_object: ART_X[object.g],
    poss_object: POSS_X[object.g],
    loc_object: locObject,
    de_object: deObject,
    verb: verb.ger,
    inf: verb.inf,
    adj: adjFor(noun.g),
    time,
    time_cap: time.charAt(0).toUpperCase() + time.slice(1),
  };

  if (depth < 2 && template.includes('{hook}')) {
    values.hook = fill(bank.hook, bank, rng, lang, depth + 1);
  }

  let out = template.replace(/\{(\w+)\}/g, (m, key) => (values[key] !== undefined ? values[key] : m));
  // capitaliza o inicio da frase (mantem parenteses e tags intactos)
  const firstLetter = out.search(/[A-Za-zÀ-ÿ]/);
  if (firstLetter >= 0
    && out[firstLetter] === out[firstLetter].toLowerCase()
    && out[firstLetter] !== out[firstLetter].toUpperCase()) {
    out = out.slice(0, firstLetter) + out[firstLetter].toUpperCase() + out.slice(firstLetter + 1);
  }
  return out;
}

/**
 * Gera letra.
 * @param {object} opts
 * @param {string} opts.prompt tema/ideia da musica
 * @param {'pt'|'en'} opts.lang
 * @param {'full'|'next'} opts.mode 'next' gera apenas a proxima linha
 * @param {string[]} opts.context linhas ja escritas (modo colaborativo)
 * @param {number} opts.seed
 */
export function generateLyrics(opts = {}) {
  const prompt = opts.prompt || '';
  const lang = opts.lang === 'en' ? 'en' : 'pt';
  const seed = opts.seed ?? hash(prompt + (opts.context || []).join('|'));
  const rng = mulberry32(seed);
  const { name: themeName, theme: bank } = lang === 'en'
    ? { name: 'en', theme: EN_OVERRIDE }
    : detectTheme(prompt);
  const context = (opts.context || []).filter(Boolean);
  const pools = lang === 'en' ? POOLS_EN : POOLS;

  if (opts.mode === 'next') {
    const used = new Set(context.map((l) => l.toLowerCase().trim()));
    const names = ['verse', 'pre', 'chorus', 'bridge'];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const pool = pools[names[Math.floor(rng() * names.length) % names.length]];
      const template = pool[Math.floor(rng() * pool.length) % pool.length];
      const line = fill(template, bank, rng, lang);
      if (!used.has(line.toLowerCase().trim())) return { line, theme: themeName };
    }
    return { line: fill(pools.verse[0], bank, rng, lang), theme: themeName };
  }

  const out = [];
  for (const section of SECTION_PLAN) {
    out.push(section.tag);
    const pool = pools[section.pool];
    const usedTemplates = new Set();
    for (let i = 0; i < section.lines; i += 1) {
      let template = pool[Math.floor(rng() * pool.length) % pool.length];
      // evita repetir o mesmo template dentro da mesma secao
      for (let attempt = 0; attempt < 12 && usedTemplates.has(template); attempt += 1) {
        template = pool[Math.floor(rng() * pool.length) % pool.length];
      }
      usedTemplates.add(template);
      out.push(fill(template, bank, rng, lang));
    }
    out.push('');
  }
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, theme: themeName, sections: SECTION_PLAN.map((s) => s.tag) };
}

export const LYRIC_THEMES = [...Object.keys(THEMES), 'livre', 'en'];
