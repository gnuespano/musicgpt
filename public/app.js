/* MusicGPT (clone) — front-end */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  view: 'criar',
  config: { genres: [], moods: [], voices: [] },
  tracks: [],
  playlists: [],
  profile: null,
  queue: [],
  currentId: null,
  shuffle: false,
  repeat: false,
  jobId: null,
  events: null,
  lastStatus: null,
  touched: { genre: false, mood: false },
  collab: [],
  voiceEngine: 'auto',
  ttsVoice: '',
  singStrength: 0.85,
  referenceAudioFile: null,
  // modo do audio anexado: 'reference' (estilo/remix) ou 'cover' (melodia)
  audioMode: 'reference',
  // fidelidade ao original no cover (0.8..1.0 -> audio_cover_strength)
  coverStrength: 0.98,
  volume: 0.9,
  muted: false,
};

/* ------------------------------------------------------------------ *
 * Utilidades
 * ------------------------------------------------------------------ */

const fmtTime = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};

function toast(message, type = 'info') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast${type === 'error' ? ' is-error' : type === 'ok' ? ' is-ok' : ''}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s ease';
    setTimeout(() => el.remove(), 320);
  }, 3600);
}

/**
 * Rotulo amigavel de QUEM escreveu a letra, lido da resposta do backend
 * (`provider`, com `engine` como plano B). Se a IA falhou e o gerador
 * local assumiu, o backend manda o motivo em `fallback` - mostramos ele
 * junto, para o usuario saber por que a letra nao veio da IA.
 */
function labelLetra(res) {
  const provedor = res?.provider || res?.engine || '';
  const base = provedor === 'deepseek' ? 'Letra gerada via DeepSeek'
    : provedor === 'nvidia' ? 'Letra gerada via NVIDIA'
      : provedor === 'openrouter' ? 'Letra gerada via OpenRouter'
        : provedor === 'openai' ? 'Letra gerada via OpenAI'
          : provedor === 'acestep-lm' ? 'Letra escrita pelo ACE-Step'
            : (provedor === 'local' || provedor === 'local-templates') ? 'Letra gerada localmente'
              : 'Letra criada';
  const motivo = res?.fallback
    ? ` (${String(res.fallback).replace(/\s*\(request_id:[^)]*\)/, '')})`
    : '';
  return `${base}${motivo}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error(data?.error || `Falha na requisição (${res.status})`);
  return data;
}

/**
 * Envia um FormData (upload de arquivo).
 * O Content-Type fica por conta do browser: ele precisa colocar o boundary
 * do multipart no cabecalho.
 */
async function apiForm(path, formData) {
  const res = await fetch(path, { method: 'POST', body: formData });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error(data?.error || `Falha na requisição (${res.status})`);
  return data;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* icones em SVG (evita glifos ausentes em fontes mobile) */
const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M11 3h2v10l4-4 1.4 1.4L12 17.2 5.6 10.4 7 9l4 4zM4 19h16v2H4z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M18 16a3 3 0 0 0-2.2 1l-6-3.1a3 3 0 0 0 0-1.8l6-3.1A3 3 0 1 0 15 6l-6 3.1a3 3 0 1 0 0 5.8l6 3.1A3 3 0 1 0 18 16z"/></svg>',
  publish: '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.7-9.5-9A5.5 5.5 0 0 1 12 6.5 5.5 5.5 0 0 1 21.5 12c-2 4.3-9.5 9-9.5 9z"/></svg>',
  wave: '<svg viewBox="0 0 24 24"><path d="M3 10h2v4H3zm4-4h2v12H7zm4-3h2v18h-2zm4 5h2v8h-2zm4 2h2v4h-2z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M20 3v12.5a3.5 3.5 0 1 1-2-3.16V7.4l-8 1.7v7.4a3.5 3.5 0 1 1-2-3.16V6.6z"/></svg>',
};

const audio = $('#audio');

/* ------------------------------------------------------------------ *
 * Tela "Criar": blocos, variedade e voz
 * ------------------------------------------------------------------ */

const VARIETY_STEPS = [[0, 'Mínima'], [20, 'Baixa'], [40, 'Normal'], [60, 'Alta'], [80, 'Máxima']];

function varietyLabel(value) {
  let label = 'Normal';
  for (const [threshold, name] of VARIETY_STEPS) {
    if (value >= threshold) label = name;
  }
  return label;
}

function renderVarietyScale(value) {
  const box = $('#varietyScale');
  if (!box) return;
  box.innerHTML = Array.from({ length: 11 }, (_, i) => (
    `<i class="${i * 10 <= value ? 'on' : ''}" style="left:${i * 10}%"></i>`
  )).join('');
}

/**
 * Ids dos botoes que abrem/fecham os blocos da tela "Criar".
 * `expandBlock('lyrics')` precisa achar exatamente `#toggleLyrics`
 * (o id e case sensitive no DOM).
 */
const BLOCK_TOGGLES = { lyrics: 'toggleLyrics', styles: 'toggleStyles', more: 'toggleMore' };

function expandBlock(name) {
  const btn = $(`#${BLOCK_TOGGLES[name] || ''}`);
  if (btn) btn.closest('.block')?.classList.remove('is-collapsed');
}

function updateVoiceButton() {
  const engine = state.voiceEngine || 'auto';
  const label = engine === 'openrouter' ? 'Voz IA' : engine === 'procedural' ? 'Voz local' : 'Voz';
  const el = $('#addVoiceLabel');
  if (el) el.textContent = label;
  $('#btnAddVoice')?.classList.toggle('is-on', engine !== 'auto');
}

function bindCreateBlocks() {
  Object.values(BLOCK_TOGGLES).forEach((id) => {
    const btn = $(`#${id}`);
    btn?.addEventListener('click', () => btn.closest('.block')?.classList.toggle('is-collapsed'));
  });

  const variety = $('#variety');
  variety?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#varietyValue').textContent = varietyLabel(v);
    renderVarietyScale(v);
  });
  renderVarietyScale(Number(variety?.value || 50));
  updateVoiceButton();
}

/* ------------------------------------------------------------------ *
 * Áudio de referência (Audio-to-Audio / Style Transfer) e Cover
 * ------------------------------------------------------------------ */

/** Limite do upload (mesmo do servidor: 15 MB). */
const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;

const AUDIO_EXT_RE = /\.(mp3|wav|wave|ogg|oga|opus|m4a|mp4|aac|flac|webm|aiff|aif)$/i;

/**
 * Modos do audio anexado.
 *
 * - `reference`: o arquivo e so uma referencia de estilo (remix) - a musica
 *   nova nasce com o timbre/producao dele.
 * - `cover`: o arquivo e o audio de origem - o modelo tenta manter a
 *   melodia e a estrutura originais.
 */
const AUDIO_MODES = { REFERENCE: 'reference', COVER: 'cover' };

/** Rotulo curto do modo (tag no card da faixa). */
const AUDIO_MODE_LABEL = {
  [AUDIO_MODES.REFERENCE]: 'modo: estilo',
  [AUDIO_MODES.COVER]: 'modo: cover',
};

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Guarda o audio de referencia escolhido pelo usuario e reflecte o estado
 * na tela (nome do arquivo + botao marcado + modo selecionado).
 */
function setReferenceAudio(file) {
  state.referenceAudioFile = file || null;
  const box = $('#refAudioBox');
  const btn = $('#btnAddAudio');
  if (file) {
    $('#refAudioName').textContent = file.name;
    $('#refAudioSize').textContent = formatBytes(file.size);
    if (box) box.hidden = false;
    btn?.classList.add('is-on');
    if (btn) btn.title = `Áudio de referência: ${file.name}`;
  } else {
    if (box) box.hidden = true;
    btn?.classList.remove('is-on');
    if (btn) btn.title = 'Anexar áudio: referência de estilo (remix) ou cover (manter a melodia)';
  }
  syncAudioMode();
}

/**
 * Le o modo escolhido no seletor (estilo x cover) e guarda no estado.
 * O modo so muda o que a API faz com o arquivo: `reference` usa ele como
 * referencia de estilo, `cover` usa ele como audio de origem (src_audio).
 */
function setAudioMode(mode) {
  const value = mode === AUDIO_MODES.COVER ? AUDIO_MODES.COVER : AUDIO_MODES.REFERENCE;
  state.audioMode = value;
  syncAudioMode();
  return value;
}

/** Reflete o modo atual nos botoes de radio e no texto de ajuda. */
function syncAudioMode() {
  const modo = state.audioMode || AUDIO_MODES.REFERENCE;
  const isCover = modo === AUDIO_MODES.COVER;
  $$('input[name="audioMode"]').forEach((input) => {
    input.checked = input.value === modo;
    input.closest('.audio-mode')?.classList.toggle('is-on', input.checked);
  });
  const box = $('#refAudioBox');
  if (box) box.dataset.mode = modo;
  // o slider de fidelidade so faz sentido no cover
  const fidelidade = $('#coverFidelity');
  if (fidelidade) fidelidade.hidden = !isCover;
  syncCoverStrength();
  const btn = $('#btnAddAudio');
  if (btn && state.referenceAudioFile) {
    btn.title = isCover
      ? `Cover: manter a melodia de ${state.referenceAudioFile.name}`
      : `Áudio de referência (estilo): ${state.referenceAudioFile.name}`;
  }
}

/** Escreve o valor do slider de fidelidade (0.8..1.0) e o guarda no estado. */
function syncCoverStrength() {
  const slider = $('#coverStrength');
  if (!slider) return;
  const value = Math.min(1, Math.max(0.8, Number(slider.value) || 0.98));
  state.coverStrength = Math.round(value * 100) / 100;
  const label = $('#coverFidelityValue');
  if (label) label.textContent = `${Math.round(state.coverStrength * 100)}%`;
}

function clearReferenceAudio() {
  const input = $('#referenceAudioInput');
  if (input) input.value = '';
  setReferenceAudio(null);
}

/** Valida o arquivo escolhido antes de anexá-lo. */
function acceptReferenceAudio(file) {
  if (!file) {
    clearReferenceAudio();
    return;
  }
  if (file.size > MAX_REFERENCE_BYTES) {
    toast(`Áudio muito grande (máx. ${formatBytes(MAX_REFERENCE_BYTES)}).`, 'error');
    clearReferenceAudio();
    return;
  }
  const pareceAudio = /^audio\//i.test(file.type || '') || AUDIO_EXT_RE.test(file.name || '');
  if (!pareceAudio) {
    toast('Esse arquivo não parece ser um áudio.', 'error');
    clearReferenceAudio();
    return;
  }
  setReferenceAudio(file);
  toast(`Referência anexada: ${file.name}`, 'ok');
}

/* ------------------------------------------------------------------ *
 * Navegação
 * ------------------------------------------------------------------ */

function showView(view) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === view));
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  if (view === 'biblioteca') loadTracks();
  if (view === 'playlists') loadPlaylists();
  if (view === 'explorar') loadExplore();
  if (view === 'modelo') loadProfile();
}

/* ------------------------------------------------------------------ *
 * Configuração
 * ------------------------------------------------------------------ */

async function loadConfig() {
  try {
    state.config = await api('/api/config');
  } catch (err) {
    toast(`Falha ao carregar configuração: ${err.message}`, 'error');
    return;
  }
  const { genres, moods, voices } = state.config;

  $('#genreChips').innerHTML = genres
    .map((g, i) => `<button type="button" class="chip${i === 0 ? ' is-on' : ''}" data-genre="${g.key}">${escapeHtml(g.label)}</button>`)
    .join('');

  $('#mood').innerHTML = moods.map((m) => `<option value="${m}">${escapeHtml(m)}</option>`).join('');
  $('#voice').innerHTML = voices.map((v) => `<option value="${v}">${escapeHtml(v)}</option>`).join('');
  $('#profileVoice').innerHTML = voices.map((v) => `<option value="${v}">${escapeHtml(v)}</option>`).join('');

  const filter = $('#libraryFilter');
  filter.innerHTML = '<option value="">Todos os gêneros</option>'
    + genres.map((g) => `<option value="${g.key}">${escapeHtml(g.label)}</option>`).join('');
}

function selectedGenre() {
  const chip = $('#genreChips .chip.is-on');
  return chip ? chip.dataset.genre : 'pop';
}

/* ------------------------------------------------------------------ *
 * Mapeamento de gêneros para descrições de estilo
 * ------------------------------------------------------------------ */

/**
 * Descrições ricas e detalhadas para cada gênero. Quando o usuário clicar em um
 * botão de gênero, o campo de texto 'Estilos' será preenchido automaticamente
 * com a descrição correspondente, incluindo instrumentação e características.
 */
const GENRE_DESCRIPTIONS = {
  pop: 'Pop dançante com sintetizadores brilhantes e refrão chiclete',
  mpb: 'MPB melancólica com violão, pandeiro e saxofone ao fundo',
  sertanejo: 'Sertanejo universitário com viola, sanfona e batida em dois',
  forro: 'Forró animado com sanfona, zabumba e triângulo',
  trap: 'Trap pesado com 808 grave, hi-hats rápidos e sintetizadores escuros',
  funk: 'Funk brasileiro com tambor, baixo elétrico e bordões gritando',
  funk_br: 'Funk brasileiro com tambor, baixo elétrico e batida de baile',
  rock: 'Rock energético com guitarra distorcida e bateria pesada',
  rock_nacional: 'Rock nacional brasileiro com guitarra limpa e bateria marcante',
  samba: 'Samba de roda animado com pandeiro, cavaquinho e surdo no refrão',
  pagode: 'Pagode animado com cavaquinho, tantã e pandeiro',
  lofi: 'Lo-fi chill com piano suave, chuva de fundo e textura de vinil',
  house: 'House club com kick de quatro tempos, hi-hat e sintetizador pulsante',
  gospel: 'Gospel soul com coro, piano e dinâmica crescente no refrão',
  jazz: 'Jazz de madrugada com piano, contrabaixo e saxofone quente',
  ambient: 'Ambient etéreo com pads atmosféricos e texturas flutuantes',
  bossa: 'Bossa nova leve com violão de nylon e percussão discreta',
  reggae: 'Reggae tranquilo com baixo round, skank no violão e melodia solta',
  indie: 'Indie folk acústico com violão, bumbo leve e vozes em dupla',
  blues: 'Blues melancólico com guitarra slide e harmônica chorosa',
  soul: 'Soul groovy com baixo encorpado, Rhodes e vocais emotivos',
  rnb: 'R&B neosoul com baixo encorpado, Rhodes e grooves relaxados',
  country: 'Country americano com guitarra steel, banjo e harmônica',
  eletronica: 'Eletrônica experimental com sintetizadores modulares e bateria programada',
  hiphop: 'Hip-hop clássico com sample de vinil, MPC e scratch',
  rockabilly: 'Rockabilly dos anos 50 com guitarra twang, contrabaixo e bateria scrub',
  synthwave: 'Synthwave dos anos 80 com sintetizadores neon e bateria eletrônica',
  kpop: 'K-pop animado com beat dance, sintetizadores brilhantes e refrão coreografado',
  amapiano: 'Amapiano com piano log drum, percussão africana e melodia etérea',
  baile: 'Funk de baile com tamborzão, grave 808 e MC fazendo bordão',
};

/**
 * Obtém a descrição de estilo para um gênero específico.
 * Retorna a descrição rica do dicionário ou uma versão capitalizada da chave como fallback.
 */
function getGenreDescription(genreKey) {
  if (GENRE_DESCRIPTIONS[genreKey]) {
    return GENRE_DESCRIPTIONS[genreKey];
  }
  // fallback: capitaliza a primeira letra da chave
  return genreKey.charAt(0).toUpperCase() + genreKey.slice(1);
}

/* ------------------------------------------------------------------ *
 * Prioridade do estilo: texto > botao de genero
 * ------------------------------------------------------------------ */

/**
 * Texto digitado no campo "Estilos".
 *
 * O texto tem PRIORIDADE ABSOLUTA sobre os botoes de genero: quando ele
 * existe, o genero escolhido nos chips (Pop, MPB, ...) e completamente
 * ignorado - nem no pedido enviado ao servidor nem na caption que vai
 * para a API do ACE-Step.
 */
function styleText() {
  return ($('#prompt')?.value || '').trim();
}

/**
 * Resolve o estilo que sera enviado ao backend.
 *
 * - texto preenchido -> o texto manda (o genero do botao e ignorado);
 * - texto vazio       -> o botao selecionado entra como fallback.
 */
function resolveStyleSelection() {
  const text = styleText();
  if (text) {
    return { text, genre: '', source: 'text' };
  }
  return { text: '', genre: state.touched.genre ? selectedGenre() : '', source: 'genre' };
}

/**
 * Reflexo visual da prioridade: com o campo "Estilos" preenchido, os
 * botoes de genero ficam esmaecidos/desativados (e nao aceitam clique)
 * para deixar claro que NAO vao ser usados no pedido.
 */
function syncStylePriority() {
  const chips = $('#genreChips');
  if (!chips) return;
  const usandoTexto = Boolean(styleText());

  chips.classList.toggle('is-overridden', usandoTexto);
  chips.setAttribute('aria-disabled', usandoTexto ? 'true' : 'false');

  $$('#genreChips .chip').forEach((chip) => {
    chip.classList.toggle('is-off', usandoTexto);
    chip.setAttribute('aria-disabled', usandoTexto ? 'true' : 'false');
    chip.title = usandoTexto
      ? 'Ignorado: o texto digitado em Estilos tem prioridade'
      : 'Usado apenas quando o campo Estilos estiver vazio';
  });

  const hint = $('#styleHint');
  if (hint) {
    hint.hidden = !usandoTexto;
    hint.textContent = 'O texto digitado tem prioridade — os botões de gênero não serão usados.';
  }
}

/* ------------------------------------------------------------------ *
 * Varinha mágica: estilo e tema aleatórios
 * ------------------------------------------------------------------ */

/**
 * Sugestões de ESTILO (descrições curtas que o motor local e o ACE-Step
 * entendem). A varinha do bloco "Estilos" sorteia uma delas.
 */
const STYLE_SUGGESTIONS = [
  'Rock alternativo dos anos 90 com guitarra distorcida e bateria seca',
  'Lo-fi chill com piano suave, chuva de fundo e textura de vinil',
  'Trap pesado com 808 grave, hi-hats rápidos e sintetizadores escuros',
  'MPB melancólica com violão, pandeiro e saxofone ao fundo',
  'Synthwave dos anos 80 com sintetizadores neon e bateria eletrônica',
  'Samba de roda animado com pandeiro, cavaquinho e surdo no refrão',
  'Funk brasileiro com tambor, baixo elétrico e bordões gritando',
  'Pop dance dos anos 2000 com sintetizadores brilhantes e refrão grudento',
  'Jazz de madrugada com piano, contrabaixo e saxofone quente',
  'Bossa nova leve com violão de nylon e percussão discreta',
  'Reggae tranquilo com baixo round, skank no violão e melodia solta',
  'Rock progressivo com guitarra limpa, sintetizadores e solos longos',
  'Forró de vaqueiro com sanfona, triângulo e bateria de baile',
  'Gospel soul com coro, piano e dinâmica crescente no refrão',
  'Indie folk acústico com violão, bumbo leve e vozes em dupla',
  'House club com kick de quatro tempos, hi-hat e sintetizador pulsante',
  'Balada de piano com cordas orquestrais e refrão em tom menor',
  'K-pop animado com beat dance, sintetizadores brilhantes e refrão coreografado',
  'R&B neosoul com baixo encorpado, Rhodes e grooves relaxados',
  'Rockabilly dos anos 50 com guitarra twang, contrabaixo e bateria scrub',
  'Amapiano com piano log drum, percussão africana e melodia etérea',
  'Sertanejo universitário com viola, sanfona e batida em dois',
];

/**
 * Temas de LETRA (ideias curtas de 1 linha para a música). A estrela ✦ do
 * bloco "Letra" sorteia um deles e escreve no campo; a lampada 💡 usa o
 * tema do campo (ou sorteia um desses, se o campo estiver vazio) como
 * semente da letra COMPLETA.
 */
const LYRIC_THEMES = [
  'Uma música sobre dirigir na estrada à noite',
  'Uma música sobre um amor perdido no verão',
  'Uma música sobre uma carta que nunca foi enviada',
  'Uma música sobre voltar para casa depois de anos fora',
  'Uma música sobre a coragem de recomeçar do zero',
  'Uma música sobre a saudade da infância na praia',
  'Uma música sobre ficar anos no mesmo emprego',
  'Uma música sobre dançar a música que você mesmo escreveu',
  'Uma música sobre ficar preso no trânsito na chuva',
  'Uma música sobre o último café da manhã juntos',
  'Uma música sobre aceitar que o fim já chegou',
  'Uma música sobre a cidade que nunca dorme',
  'Uma música sobre um amigo que desapareceu sem avisar',
  'Uma música sobre trocar de vida aos 40 anos',
  'Uma música sobre o som da chuva no telhado de zinco',
  'Uma música sobre se despedir do cachorro no veterinário',
  'Uma música sobre o primeiro salário e a liberdade',
  'Uma música sobre a festa que só acaba às seis da manhã',
  'Uma música sobre se perdoar depois de anos de mágoa',
  'Uma música sobre a montanha que você prometeu escalar',
  'Uma música sobre uma viagem de ônibus sem destino certo',
  'Uma música sobre a saudade de tocar violão à meia-noite',
];

/**
 * Forma aceita pelo botao ✦ do bloco "Letra": UMA frase curta, sem
 * estrutura de musica.
 *
 * Corta na primeira linha util (pulando tags puras como "[Verse 1]") e
 * remove uma tag embutida no inicio ("[Chorus] amor na rua" -> "amor na
 * rua"). Assim, mesmo que um item da lista venha errado - ou que a lista
 * seja trocada por uma com letras prontas - o campo NUNCA recebe verso,
 * refrao ou multiplas linhas por este caminho. Vazio = nada a preencher.
 */
function temaCurto(texto) {
  const linhas = String(texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const linha = linhas.find((l) => !/^\[[^\]]*\]$/.test(l)) || '';
  return linha.replace(/^\[[^\]]*\]\s*/, '').trim();
}

/**
 * Sorteia um item da lista, evitando repetir o valor atual do campo
 * (quando ele esta na lista) — assim dois cliques seguidos sempre
 * mudam a sugestao.
 */
function pickRandom(list, avoid = '') {
  if (!Array.isArray(list) || !list.length) return '';
  const pool = list.length > 1 ? list.filter((item) => item !== avoid) : list;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Efeito visual da varinha: brilho + fade no campo preenchido e uma
 * sacudida no botao. A classe `is-magic` e removida no fim da animacao
 * (ou depois de 1.2 s) para o efeito poder se repetir em cliques seguidos.
 */
function magicEffect(field, btn) {
  [field, btn].filter(Boolean).forEach((el) => {
    el.classList.remove('is-magic');
    void el.offsetWidth; // reinicia a animacao
    el.classList.add('is-magic');
    const clear = () => el.classList.remove('is-magic');
    el.addEventListener('animationend', clear, { once: true });
    setTimeout(clear, 1200);
  });
}

// exposto para os testes locais (scripts/testar-varinha.mjs)
window.MUSICGPT_STYLE_SUGGESTIONS = STYLE_SUGGESTIONS;
window.MUSICGPT_LYRIC_THEMES = LYRIC_THEMES;

/* ------------------------------------------------------------------ *
 * Geração
 * ------------------------------------------------------------------ */

async function generate() {
  const prompt = $('#prompt').value.trim();
  if (!prompt) {
    toast('Descreva a música que você quer criar.', 'error');
    $('#prompt').focus();
    return;
  }
  const btn = $('#btnGenerate');
  btn.disabled = true;
  $('#statusEmpty').hidden = true;
  $('#statusDone').hidden = true;
  $('#statusRunning').hidden = false;
  $('#btnDownloadDone').disabled = false;
  setJobProgress(0, 'enviando');

  let payload;
  try {
    // Prioridade ABSOLUTA do texto do campo "Estilos": quando ele esta
    // preenchido, o genero dos botoes nao entra no pedido. Sem texto, o
    // botao selecionado entra como fallback.
    const estilo = resolveStyleSelection();

    const fields = {
      prompt,
      title: $('#title').value.trim(),
      genre: estilo.genre,
      style: estilo.text,
      mood: state.touched.mood ? $('#mood').value : '',
      voiceStyle: $('#voice').value,
      duration: Number($('#duration').value),
      instrumental: $('#instrumental').checked,
      lofi: $('#lofi').checked,
      variety: Number($('#variety').value) / 100,
      voiceEngine: state.voiceEngine || 'auto',
      ttsVoice: state.ttsVoice || '',
      singStrength: state.singStrength ?? 0.85,
      lyrics: $('#customLyrics').value.trim(),
      // modo do audio anexado: 'reference' (estilo/remix) ou 'cover'
      audioMode: state.audioMode || AUDIO_MODES.REFERENCE,
      // fidelidade ao original (cover): 0.8..1.0
      coverStrength: state.coverStrength ?? 0.98,
    };

    const reference = state.referenceAudioFile;
    if (reference) {
      // com audio de referencia o pedido vai em multipart/form-data
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
      form.append('referenceAudio', reference, reference.name);
      payload = await apiForm('/api/generate', form);
    } else {
      payload = await api('/api/generate', { method: 'POST', body: fields });
    }
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    $('#statusRunning').hidden = true;
    $('#statusEmpty').hidden = false;
    return;
  }

  state.jobId = payload.jobId;
  watchJob(payload.jobId, btn);
}

function setJobProgress(pct, stage, detail) {
  $('#jobBar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  $('#jobPct').textContent = `${Math.round(pct)}%`;
  if (stage) $('#jobStage').textContent = stage;
  $('#jobDetail').textContent = detail || '';
}

function watchJob(jobId, btn) {
  if (state.events) state.events.close();
  let source;
  try {
    source = new EventSource(`/api/jobs/${jobId}/events`);
    state.events = source;
  } catch {
    source = null;
  }

  const finish = (status, payload) => {
    if (btn) btn.disabled = false;
    if (status === 'done') {
      $('#statusRunning').hidden = true;
      $('#statusDone').hidden = false;
      const track = payload.track;
      // O estilo exibido e o que foi realmente usado: o texto digitado no
      // campo "Estilos" (quando existe) ou o genero do botao (fallback).
      const estiloUsado = track.styleLabel || track.style || track.genreLabel || '';
      $('#doneTitle').textContent = 'Faixa pronta';
      $('#doneCard').innerHTML = `
        <div class="done-title">${escapeHtml(track.title)}</div>
        <div class="done-tags">
          <span class="tag">${escapeHtml(estiloUsado)}</span>
          <span class="tag">${escapeHtml(track.moodLabel || '')}</span>
          <span class="tag">${Math.round(track.duration)}s</span>
          ${track.bpm ? `<span class="tag">${track.bpm} BPM</span>` : ''}
          ${track.key ? `<span class="tag">${escapeHtml(track.key)}</span>` : ''}
          ${track.lofi ? '<span class="tag">chuva</span>' : ''}
          ${track.referenceAudio?.used ? `<span class="tag">ref: ${escapeHtml(track.referenceAudio.name)}</span>` : ''}
          ${track.audioMode ? `<span class="tag">${escapeHtml(AUDIO_MODE_LABEL[track.audioMode] || `modo: ${track.audioMode}`)}</span>` : ''}
          ${track.audioMode === 'cover' && track.coverStrength ? `<span class="tag">fidelidade ${Math.round(track.coverStrength * 100)}%</span>` : ''}
          ${track.engine ? `<span class="tag">${escapeHtml(track.engine || '')}</span>` : ''}
          ${track.voiceInfo?.engine === 'openrouter' ? '<span class="tag">voz IA</span>' : ''}
          ${track.voiceInfo?.engine === 'acestep' ? '<span class="tag">voz ACE-Step</span>' : ''}
        </div>`;
      if (Array.isArray(track.warnings) && track.warnings.length) {
        // "Tema expandido..." e comportamento esperado (o tema virou letra):
        // avisa em info. O resto (IA fora do ar, provider caindo no local)
        // continua como erro.
        const info = track.warnings.filter((w) => /^Tema expandido/i.test(w));
        const erros = track.warnings.filter((w) => !/^Tema expandido/i.test(w));
        info.forEach((w) => toast(w, 'info'));
        if (erros.length) toast(erros[0], 'error');
      }
      $('#btnPlayDone').onclick = () => playTrack(track);
      // download do audio gerado: a rota /api/download resolve a fonte
      // (URL original do provider ou arquivo local) e converte o formato
      const wavBtn = $('#btnDownloadDone');
      wavBtn.onclick = () => downloadWav(track);
      wavBtn.disabled = false;
      wavBtn.title = 'Baixar o audio gerado em .wav';
      const mp3Btn = $('#btnDownloadMp3Done');
      mp3Btn.onclick = () => downloadTrack(track);
      mp3Btn.disabled = false;
      mp3Btn.title = 'Baixar o audio gerado em .mp3';
      $('#btnOpenDone').onclick = () => { showView('biblioteca'); loadTracks(); };
      // reflete o genero/clima efetivamente usados (podem ter sido detectados
      // pelo prompt). Com o texto de Estilos preenchido o genero do botao nao
      // foi usado: nesse caso os chips ficam como estao.
      if (track.styleSource !== 'text') {
        const usedChip = $(`#genreChips .chip[data-genre="${track.genre}"]`);
        if (usedChip) {
          $$('#genreChips .chip').forEach((c) => c.classList.remove('is-on'));
          usedChip.classList.add('is-on');
          state.touched.genre = true;
        }
      }
      if (track.mood) {
        $('#mood').value = track.mood;
        state.touched.mood = true;
      }
      toast(`"${track.title}" criada em ${Math.round(track.duration)}s.`, 'ok');
      loadTracks();
      loadPlaylists();
    } else if (status === 'error') {
      $('#statusRunning').hidden = true;
      $('#statusEmpty').hidden = false;
      toast(`Falha na geração: ${payload.error || 'erro desconhecido'}`, 'error');
    }
  };

  if (source) {
    source.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      state.lastStatus = data.status;
      setJobProgress(data.progress ?? 0, data.stage, data.detail);
      if (data.status === 'done' || data.status === 'error') {
        source.close();
        state.events = null;
        finish(data.status, data);
      }
    };
    source.onerror = async () => {
      source.close();
      state.events = null;
      const st = await api(`/api/jobs/${jobId}`).catch(() => null);
      if (st && (st.status === 'done' || st.status === 'error')) finish(st.status, st);
      else if (btn) btn.disabled = false;
    };
  } else {
    const poll = setInterval(async () => {
      const st = await api(`/api/jobs/${jobId}`).catch(() => null);
      if (!st) return;
      setJobProgress(st.progress ?? 0, st.stage, st.detail);
      if (st.status === 'done' || st.status === 'error') {
        clearInterval(poll);
        finish(st.status, st);
      }
    }, 900);
  }
}

/* ------------------------------------------------------------------ *
 * Letras
 * ------------------------------------------------------------------ */

async function generateLyrics(mode) {
  const prompt = $('#lyricsPrompt').value.trim();
  if (!prompt) {
    toast('Informe o tema da letra.', 'error');
    return;
  }
  const btn = mode === 'full' ? $('#btnLyricsFull') : $('#btnLyricsNext');
  btn.disabled = true;
  try {
    const res = await api('/api/lyrics', {
      method: 'POST',
      body: {
        prompt,
        lang: $('#lyricsLang').value,
        style: $('#lyricsStyle').value,
        mode,
        context: state.collab,
      },
    });
    if (mode === 'full') {
      $('#lyricsEditor').value = res.text;
      state.collab = res.text.split('\n').filter((l) => l.trim() && !/^\[.*\]$/.test(l.trim()));
      renderCollab();
      toast(`${labelLetra(res)}. Edite à vontade.`, 'ok');
    } else {
      $('#lyricsEditor').value = `${$('#lyricsEditor').value.replace(/\s*$/, '')}\n${res.line}`.trim();
      state.collab.push(res.line);
      renderCollab(res.line);
      toast('Linha adicionada.', 'ok');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function renderCollab(highlight) {
  $('#collabCount').textContent = `${state.collab.length} linha${state.collab.length === 1 ? '' : 's'}`;
  $('#collabLines').innerHTML = state.collab
    .map((l) => `<div class="collab-line${l === highlight ? ' is-new' : ''}">${escapeHtml(l)}</div>`)
    .join('');
}

/* ------------------------------------------------------------------ *
 * Biblioteca
 * ------------------------------------------------------------------ */

async function loadTracks() {
  try {
    const res = await api('/api/tracks');
    state.tracks = res.tracks || [];
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  renderTracks();
}

function renderTracks() {
  const term = $('#librarySearch').value.trim().toLowerCase();
  const genre = $('#libraryFilter').value;
  const list = state.tracks.filter((t) => {
    if (genre && t.genre !== genre) return false;
    if (!term) return true;
    return `${t.title} ${t.prompt} ${t.genreLabel} ${t.moodLabel}`.toLowerCase().includes(term);
  });

  $('#libraryEmpty').hidden = list.length > 0;
  $('#libraryGrid').innerHTML = list.map((t) => trackCard(t)).join('');
}

function trackCard(t) {
  const peaks = (t.peaks && t.peaks.length ? t.peaks : Array.from({ length: 48 }, () => 0.25));
  const bars = peaks
    .map((p) => `<i style="height:${Math.max(6, Math.round(p * 100))}%"></i>`)
    .join('');
  return `
  <article class="track-card" data-id="${t.id}">
    <div class="track-top">
      <div class="cover">${escapeHtml((t.title || '♪').trim().charAt(0).toUpperCase())}</div>
      <div class="track-info">
        <strong title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</strong>
        <span>${escapeHtml(t.styleLabel || t.genreLabel || '')} · ${escapeHtml(t.moodLabel || '')}</span>
      </div>
    </div>
    <div class="wave">${bars}</div>
    <div class="track-meta">
      <span>${fmtTime(t.duration)}</span>
      ${t.bpm ? `<span>${t.bpm} BPM</span>` : ''}
      ${t.key ? `<span>${escapeHtml(t.key)}</span>` : ''}
      ${t.instrumental ? '<span>instrumental</span>' : '<span>com voz</span>'}
      ${t.audioMode ? `<span>${escapeHtml(AUDIO_MODE_LABEL[t.audioMode] || `modo: ${t.audioMode}`)}</span>` : ''}
      ${t.voiceInfo?.engine === 'openrouter' ? '<span>voz IA</span>' : ''}
      ${t.voiceInfo?.engine === 'acestep' ? '<span>voz ACE-Step</span>' : ''}
      ${t.lofi ? '<span>chuva</span>' : ''}
      <span>${t.plays || 0} plays</span>
      ${t.isPublic ? '<span class="tag">publicada</span>' : ''}
    </div>
    <div class="track-actions">
      <button class="icon-btn is-primary" data-act="play" title="Tocar">${ICON.play}</button>
      <button class="icon-btn" data-act="download-wav" title="Baixar .wav">${ICON.wave}</button>
      <button class="icon-btn" data-act="download" title="Baixar .mp3">${ICON.download}</button>
      <button class="icon-btn" data-act="playlist" title="Adicionar à playlist">${ICON.plus}</button>
      <button class="icon-btn" data-act="share" title="Compartilhar">${ICON.share}</button>
      <button class="icon-btn" data-act="publish" title="Publicar na comunidade">${ICON.publish}</button>
      <button class="icon-btn" data-act="delete" title="Excluir">${ICON.close}</button>
    </div>
  </article>`;
}

function trackAction(id, act) {
  const track = state.tracks.find((t) => t.id === id);
  if (!track) return;
  if (act === 'play') playTrack(track);
  if (act === 'download') downloadTrack(track);
  if (act === 'download-wav') downloadWav(track);
  if (act === 'playlist') openPlaylistModal(track);
  if (act === 'share') shareTrack(track);
  if (act === 'publish') togglePublish(track);
  if (act === 'delete') deleteTrack(track);
}

async function togglePublish(track) {
  const res = await api(`/api/tracks/${track.id}/publish`, { method: 'POST' });
  toast(res.isPublic ? 'Faixa publicada na comunidade.' : 'Faixa removida da comunidade.', 'ok');
  loadTracks();
}

async function deleteTrack(track) {
  if (!confirm(`Excluir "${track.title}"? Essa ação não pode ser desfeita.`)) return;
  try {
    await api(`/api/tracks/${track.id}`, { method: 'DELETE' });
    toast('Faixa excluída.', 'ok');
    if (state.currentId === track.id) stopPlayer();
    loadTracks();
    loadPlaylists();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/**
 * Baixa um arquivo tratando a resposta como blob, para conseguir tratar erro
 * (a API responde JSON quando o audio nao esta disponivel, por exemplo).
 */
async function downloadFile(url, filename, label = 'Download') {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      let msg = `Falha no download (${res.status})`;
      try {
        const data = await res.json();
        if (data?.error) msg = data.error;
      } catch { /* resposta nao-JSON */ }
      toast(msg, 'error');
      return;
    }
    const blob = await res.blob();
    const name = filenameFromDisposition(res.headers.get('Content-Disposition'), filename);
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
    toast(`${label} iniciado (${(blob.size / 1048576).toFixed(1)} MB).`, 'ok');
  } catch (err) {
    toast(`Falha no download: ${err.message}`, 'error');
  }
}

/** Le o nome do arquivo do header Content-Disposition do servidor. */
function filenameFromDisposition(header, fallback) {
  if (!header) return fallback;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8) {
    try { return decodeURIComponent(utf8[1].trim()); } catch { /* ignora */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : fallback;
}

function downloadWav(track) {
  return downloadFile(`/api/download/${track.id}?format=wav`, `${track.slug || track.id}.wav`, 'Download do WAV');
}

function downloadTrack(track) {
  return downloadFile(`/api/download/${track.id}?format=mp3`, `${track.slug || track.id}.mp3`, 'Download do MP3');
}

async function shareTrack(track) {
  try {
    const res = await api(`/api/tracks/${track.id}/share`);
    if (navigator.share) {
      await navigator.share({ title: res.title, text: res.text, url: res.url });
    } else {
      await navigator.clipboard.writeText(res.url);
      toast('Link copiado para a área de transferência.', 'ok');
    }
  } catch (err) {
    toast('Não foi possível compartilhar agora.', 'error');
  }
}

/* ------------------------------------------------------------------ *
 * Playlists
 * ------------------------------------------------------------------ */

async function loadPlaylists() {
  try {
    const res = await api('/api/playlists');
    state.playlists = res.playlists || [];
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  renderPlaylists();
}

function renderPlaylists() {
  const grid = $('#playlistGrid');
  if (!state.playlists.length) {
    grid.innerHTML = '<div class="empty"><h3>Nenhuma playlist ainda</h3><p>Crie a primeira no campo acima.</p></div>';
    return;
  }
  grid.innerHTML = state.playlists.map((p) => {
    const count = p.trackIds.length;
    const mins = Math.round(p.trackIds.reduce((acc, id) => {
      const t = state.tracks.find((x) => x.id === id);
      return acc + (t?.duration || 0);
    }, 0) / 60);
    return `
    <div class="playlist-card" data-id="${p.id}" style="--pc:${escapeHtml(p.color || '#7c5cff')}">
      <h4>${escapeHtml(p.name)}</h4>
      <span>${count} faixa${count === 1 ? '' : 's'} · ${mins} min</span>
    </div>`;
  }).join('');
}

async function createPlaylist() {
  const name = $('#playlistName').value.trim();
  if (!name) {
    toast('Dê um nome à playlist.', 'error');
    return;
  }
  try {
    await api('/api/playlists', { method: 'POST', body: { name } });
    $('#playlistName').value = '';
    toast('Playlist criada.', 'ok');
    loadPlaylists();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openPlaylist(playlist) {
  $('#playlistDetail').hidden = false;
  $('#playlistTitle').textContent = playlist.name;
  const list = playlist.trackIds
    .map((id) => state.tracks.find((t) => t.id === id))
    .filter(Boolean);
  $('#playlistTracks').innerHTML = list.length
    ? list.map((t) => `
      <div class="track-row" data-id="${t.id}">
        <button class="icon-btn" data-act="play">${ICON.play}</button>
        <span class="nm">${escapeHtml(t.title)}</span>
        <span class="track-meta">${fmtTime(t.duration)}</span>
        <button class="icon-btn" data-act="remove">${ICON.close}</button>
      </div>`).join('')
    : '<div class="empty"><p>Playlist vazia. Use o botão ＋ em qualquer faixa para adicionar.</p></div>';

  $('#btnPlaylistDelete').onclick = async () => {
    if (!confirm(`Excluir a playlist "${playlist.name}"?`)) return;
    await api(`/api/playlists/${playlist.id}`, { method: 'DELETE' });
    $('#playlistDetail').hidden = true;
    toast('Playlist excluída.', 'ok');
    loadPlaylists();
  };
  $('#btnPlaylistClose').onclick = () => { $('#playlistDetail').hidden = true; };
}

function openPlaylistModal(track) {
  const body = $('#modalBody');
  $('#modalTitle').textContent = `Adicionar "${track.title}" à playlist`;
  body.innerHTML = state.playlists.length
    ? state.playlists.map((p) => `<button data-playlist="${p.id}">${escapeHtml(p.name)}</button>`).join('')
      + '<button data-new="1">＋ Criar nova playlist</button>'
    : '<p style="color:var(--muted);font-size:13px">Nenhuma playlist ainda. Crie uma agora.</p><button data-new="1">＋ Criar nova playlist</button>';

  body.onclick = async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    if (btn.dataset.new) {
      const name = prompt('Nome da playlist:');
      if (name) {
        const res = await api('/api/playlists', { method: 'POST', body: { name } });
        await addToPlaylist(res.playlist.id, track.id);
        loadPlaylists();
      }
    } else if (btn.dataset.playlist) {
      await addToPlaylist(btn.dataset.playlist, track.id);
      loadPlaylists();
    }
    closeModal();
  };
  $('#modalBackdrop').hidden = false;
}

async function addToPlaylist(playlistId, trackId) {
  const p = state.playlists.find((x) => x.id === playlistId);
  const trackIds = p && !p.trackIds.includes(trackId) ? [...p.trackIds, trackId] : p?.trackIds || [trackId];
  await api(`/api/playlists/${playlistId}`, { method: 'PATCH', body: { trackIds } });
  toast('Adicionada à playlist.', 'ok');
}

function closeModal() {
  $('#modalBackdrop').hidden = true;
}

/* ------------------------------------------------------------------ *
 * Meu modelo
 * ------------------------------------------------------------------ */

async function loadProfile() {
  try {
    const res = await api('/api/profile');
    state.profile = res.profile;
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const p = state.profile;
  $('#displayName').value = p.displayName || '';
  $('#profileVoice').value = p.voiceStyle || 'pop';
  $('#profileDuration').value = p.defaultDuration || 75;
  $('#profileDurationValue').textContent = `${p.defaultDuration || 75}s`;
  $('#energy').value = p.modelProfile?.energy ?? 0.6;
  $('#brightness').value = p.modelProfile?.brightness ?? 0.5;
  $('#bpmBias').value = p.modelProfile?.bpmBias ?? 0;
  $('#vocalCharacter').value = p.modelProfile?.vocalCharacter || 'natural';
  syncModelLabels();
  $('#favGenres').innerHTML = state.config.genres.map((g) => `
    <button type="button" class="chip${(p.favoriteGenres || []).includes(g.key) ? ' is-on' : ''}" data-genre="${g.key}">${escapeHtml(g.label)}</button>
  `).join('');
}

function syncModelLabels() {
  $('#energyValue').textContent = Number($('#energy').value).toFixed(2);
  $('#brightnessValue').textContent = Number($('#brightness').value).toFixed(2);
  $('#bpmBiasValue').textContent = `${$('#bpmBias').value}%`;
}

async function saveProfile() {
  const favGenres = $$('#favGenres .chip.is-on').map((c) => c.dataset.genre);
  const body = {
    displayName: $('#displayName').value.trim() || 'Estúdio',
    voiceStyle: $('#profileVoice').value,
    defaultDuration: Number($('#profileDuration').value),
    favoriteGenres: favGenres,
    modelProfile: {
      energy: Number($('#energy').value),
      brightness: Number($('#brightness').value),
      bpmBias: Number($('#bpmBias').value),
      vocalCharacter: $('#vocalCharacter').value,
    },
  };
  try {
    await api('/api/profile', { method: 'PUT', body });
    toast('Perfil salvo.', 'ok');
    loadProfile();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------------------------------------------ *
 * Explorar
 * ------------------------------------------------------------------ */

async function loadExplore() {
  try {
    const res = await api('/api/explore');
    const tracks = res.tracks || [];
    $('#exploreTracks').innerHTML = tracks.length
      ? tracks.map((t) => trackCard(t)).join('')
      : '<div class="empty"><p>Você ainda não publicou faixas. Use o botão de publicar (coração) em uma faixa da biblioteca.</p></div>';
    const ideas = res.ideas || [];
    $('#ideaGrid').innerHTML = ideas.map((i) => `
      <article class="idea-card">
        <span class="by">${escapeHtml(i.author)}</span>
        <h4>${escapeHtml(i.title)}</h4>
        <p>${escapeHtml(i.prompt)}</p>
        <div class="track-meta"><span>${escapeHtml(i.genre)}</span><span>${escapeHtml(i.mood)}</span><span>♥ ${i.likes}</span></div>
        <div class="track-actions">
          <button class="btn btn-ghost btn-sm" data-idea="${escapeHtml(i.id)}">Criar a partir desta ideia</button>
        </div>
      </article>`).join('');
    state.ideas = ideas;
  } catch (err) {
    toast(err.message, 'error');
  }
}

function useIdea(id) {
  const idea = (state.ideas || []).find((i) => i.id === id);
  if (!idea) return;
  $('#prompt').value = idea.prompt;
  const chip = $(`#genreChips .chip[data-genre="${idea.genre}"]`);
  if (chip) {
    $$('#genreChips .chip').forEach((c) => c.classList.remove('is-on'));
    chip.classList.add('is-on');
    state.touched.genre = true;
  }
  $('#mood').value = idea.mood;
  state.touched.mood = true;
  showView('criar');
  toast('Ideia carregada no estúdio. Ajuste e clique em Criar música.', 'ok');
}

/* ------------------------------------------------------------------ *
 * Player
 * ------------------------------------------------------------------ */

function playTrack(track, queue = null) {
  if (queue) state.queue = queue;
  if (!state.queue.some((t) => t.id === track.id)) state.queue.push(track);
  state.currentId = track.id;
  ensureAudioGraph();
  audio.src = `/api/tracks/${track.id}/audio`;
  audio.play().catch(() => toast('Toque novamente para iniciar a reprodução.', 'error'));
  updatePlayerMeta(track);
  api(`/api/tracks/${track.id}/play`, { method: 'POST' }).catch(() => {});
  renderQueue();
}

function updatePlayerMeta(track) {
  $('#playerTitle').textContent = track.title;
  $('#playerSub').textContent = `${track.styleLabel || track.genreLabel || ''} · ${track.moodLabel || ''} · ${fmtTime(track.duration)}`;
  $('#playerCover').innerHTML = '<span class="cover-letter">' + escapeHtml((track.title || '♪').trim().charAt(0).toUpperCase()) + '</span>';
  $('#playerDuration').textContent = fmtTime(track.duration);
}

function stopPlayer() {
  audio.pause();
  audio.removeAttribute('src');
  state.currentId = null;
  $('#playerTitle').textContent = 'Nada tocando';
  $('#playerSub').textContent = 'Escolha uma faixa';
  $('#playerCover').innerHTML = ICON.note;
  $('#seekBar').style.width = '0%';
  $('#btnPlay').innerHTML = ICON.play;
  resetSpectrum();
  renderQueue();
}

function currentTrack() {
  return state.tracks.find((t) => t.id === state.currentId)
    || state.queue.find((t) => t.id === state.currentId)
    || null;
}

function nextTrack(auto = false) {
  if (!state.queue.length) return;
  let idx = state.queue.findIndex((t) => t.id === state.currentId);
  if (state.shuffle) {
    idx = Math.floor(Math.random() * state.queue.length);
  } else {
    idx = (idx + 1) % state.queue.length;
  }
  const track = state.queue[idx];
  if (track) playTrack(track);
}

function prevTrack() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  let idx = state.queue.findIndex((t) => t.id === state.currentId);
  idx = (idx - 1 + state.queue.length) % state.queue.length;
  const track = state.queue[idx];
  if (track) playTrack(track);
}

function renderQueue() {
  $('#queueList').innerHTML = state.queue.length
    ? state.queue.map((t) => `
      <div class="queue-item${t.id === state.currentId ? ' is-current' : ''}" data-id="${t.id}">
        <span>♪</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(t.title)}</span>
        <span>${fmtTime(t.duration)}</span>
      </div>`).join('')
    : '<p style="color:var(--muted);font-size:12.5px">Fila vazia.</p>';
}

/* ------------------------------------------------------------------ *
 * Visualizador de espectro (Web Audio API)
 * ------------------------------------------------------------------ */

/**
 * O <audio> alimenta um MediaElementAudioSourceNode -> AnalyserNode ->
 * GainNode -> saida. O GainNode e obrigatorio: com o elemento conectado
 * ao grafo, os navegadores ignoram o atributo `volume` do <audio>, e o
 * controle de volume so funciona se passar pelo ganho.
 */
const SPECTRUM_MAX_BARS = 72;

const spectrum = {
  canvas: $('#spectrum'),
  ctx: null,
  audioCtx: null,
  analyser: null,
  source: null,
  gain: null,
  bins: null,
  bars: 0,
  width: 0,
  height: 0,
  levels: new Float32Array(0),
  smooth: new Float32Array(0),
  rafId: 0,
  playing: false,
  unsupported: false,
  palette: { top: '#b46cff', mid: '#7c5cff', bottom: '#4d7cff' },
};

/** Le uma cor do tema (CSS custom property) para o canvas usar a mesma paleta. */
function themeColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function initSpectrum() {
  const canvas = spectrum.canvas;
  if (!canvas) return;
  spectrum.ctx = canvas.getContext('2d');
  if (!spectrum.ctx) return;

  spectrum.palette = {
    top: themeColor('--brand-2', '#b46cff'),
    mid: themeColor('--brand', '#7c5cff'),
    bottom: themeColor('--brand-blue', '#4d7cff'),
  };

  resizeSpectrum();
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resizeSpectrum).observe(canvas);
  }
  window.addEventListener('resize', resizeSpectrum);
  window.addEventListener('orientationchange', () => setTimeout(resizeSpectrum, 250));
  drawIdleSpectrum();

  // ponto de inspecao para depuracao/testes (nao altera o comportamento)
  window.__musicgptSpectrum = spectrum;
}

/** Ajusta o buffer do canvas ao tamanho real da tela (e ao devicePixelRatio). */
function resizeSpectrum() {
  const canvas = spectrum.canvas;
  const ctx = spectrum.ctx;
  if (!canvas || !ctx) return;

  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  spectrum.width = width;
  spectrum.height = height;

  const pixelW = Math.round(width * dpr);
  const pixelH = Math.round(height * dpr);
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // quantas barras cabem na largura atual (mais barras em telas largas)
  const bars = Math.max(16, Math.min(SPECTRUM_MAX_BARS, Math.floor(width / 7)));
  if (bars !== spectrum.bars) {
    spectrum.bars = bars;
    spectrum.levels = new Float32Array(bars);
    spectrum.smooth = new Float32Array(bars);
  }
  if (!spectrum.playing) drawIdleSpectrum();
}

/**
 * Cria (uma unica vez) o grafo de audio. Sem Web Audio API o app continua
 * tocando normalmente — apenas nao ha visualizador.
 */
function ensureAudioGraph() {
  if (spectrum.source) return true;
  if (spectrum.unsupported) return false;

  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    spectrum.unsupported = true;
    return false;
  }

  let ctx = null;
  let source = null;
  try {
    ctx = new Ctx();
    source = ctx.createMediaElementSource(audio);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    analyser.minDecibels = -85;
    analyser.maxDecibels = -18;

    const gain = ctx.createGain();
    gain.gain.value = 1;

    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);

    spectrum.audioCtx = ctx;
    spectrum.source = source;
    spectrum.analyser = analyser;
    spectrum.gain = gain;
    spectrum.bins = new Uint8Array(analyser.frequencyBinCount);
    applyVolume();
    return true;
  } catch (err) {
    console.warn('[spectrum] Web Audio API indisponivel:', err);
    // se o elemento ja foi conectado, garante que o audio continue saindo
    try { if (source && ctx) source.connect(ctx.destination); } catch { /* ignora */ }
    spectrum.audioCtx = null;
    spectrum.source = null;
    spectrum.analyser = null;
    spectrum.gain = null;
    spectrum.unsupported = true;
    return false;
  }
}

/** Volume/mudo: passa pelo GainNode quando o grafo existe, senao no <audio>. */
function applyVolume() {
  if (spectrum.gain && spectrum.audioCtx) {
    // com o <audio> conectado ao grafo, o navegador ignora `volume`/`muted`
    // do elemento: o controle precisa passar pelo ganho do audio.
    spectrum.gain.gain.setTargetAtTime(state.muted ? 0 : state.volume, spectrum.audioCtx.currentTime, 0.02);
    audio.volume = 1;
    audio.muted = false;
  } else {
    audio.volume = state.volume;
    audio.muted = state.muted;
  }
}

/** Agrupa os bins do analizador em barras (escala log: mais peso nas baixas). */
function updateSpectrumLevels() {
  const bins = spectrum.bins;
  const n = spectrum.bars;
  if (!bins || !n) return;

  const minBin = 2;
  const maxBin = Math.max(minBin + 1, Math.floor(bins.length * 0.55));
  const ratio = maxBin / minBin;

  for (let i = 0; i < n; i++) {
    const from = Math.floor(minBin * Math.pow(ratio, i / n));
    const to = Math.max(from + 1, Math.ceil(minBin * Math.pow(ratio, (i + 1) / n)));
    let peak = 0;
    for (let b = from; b < to && b < bins.length; b += 1) {
      if (bins[b] > peak) peak = bins[b];
    }
    // leve realce para as faixas mais graves ficarem visiveis
    const gainBoost = 1 + (i / n) * 0.35;
    spectrum.levels[i] = Math.min(1, (peak / 255) * gainBoost);
  }
}

function roundedBar(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.beginPath();
  ctx.rect(x, y, w, h);
}

function drawSpectrum() {
  const ctx = spectrum.ctx;
  if (!ctx) return;
  const { width, height, bars } = spectrum;
  if (!bars) return;

  ctx.clearRect(0, 0, width, height);

  const gap = width > 520 ? 3 : 2;
  const barW = Math.max(1.5, (width - gap * (bars - 1)) / bars);
  const maxH = Math.max(2, height - 2);

  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, spectrum.palette.top);
  grad.addColorStop(0.55, spectrum.palette.mid);
  grad.addColorStop(1, spectrum.palette.bottom);

  ctx.fillStyle = grad;
  ctx.shadowColor = 'rgba(124, 92, 255, .55)';
  ctx.shadowBlur = 7;

  for (let i = 0; i < bars; i++) {
    const value = spectrum.smooth[i];
    const barH = Math.max(2, value * maxH);
    const x = i * (barW + gap);
    ctx.globalAlpha = 0.45 + value * 0.55;
    roundedBar(ctx, x, height - barH, barW, barH, Math.min(barW / 2, 2));
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}

/** Estado parado: uma linha de base discreta para a faixa nao ficar vazia. */
function drawIdleSpectrum() {
  const ctx = spectrum.ctx;
  if (!ctx) return;
  const { width, height, bars } = spectrum;
  ctx.clearRect(0, 0, width, height);
  if (!bars) return;

  const gap = width > 520 ? 3 : 2;
  const barW = Math.max(1.5, (width - gap * (bars - 1)) / bars);
  const grad = ctx.createLinearGradient(0, 0, width, 0);
  grad.addColorStop(0, spectrum.palette.mid);
  grad.addColorStop(1, spectrum.palette.bottom);
  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.22;
  for (let i = 0; i < bars; i += 1) {
    roundedBar(ctx, i * (barW + gap), height - 2, barW, 2, 1);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function spectrumFrame() {
  if (!spectrum.playing) return;
  spectrum.rafId = requestAnimationFrame(spectrumFrame);
  if (document.hidden || !spectrum.analyser || !spectrum.bins) return;

  // o navegador pode suspender o contexto (aba em segundo plano): religa
  if (spectrum.audioCtx?.state === 'suspended') spectrum.audioCtx.resume().catch(() => {});

  spectrum.analyser.getByteFrequencyData(spectrum.bins);
  updateSpectrumLevels();

  // ataque rapido / relaxamento lento: as barras "respiram" como um VU real
  for (let i = 0; i < spectrum.bars; i += 1) {
    const target = spectrum.levels[i];
    const current = spectrum.smooth[i];
    const factor = target > current ? 0.55 : 0.14;
    spectrum.smooth[i] = current + (target - current) * factor;
  }
  drawSpectrum();
}

/** Liga a animacao (somando ao que ja estiver tocando). */
function startSpectrum() {
  if (!ensureAudioGraph()) return;
  spectrum.playing = true;
  spectrum.canvas?.classList.remove('is-paused');
  if (spectrum.audioCtx.state === 'suspended') {
    spectrum.audioCtx.resume().catch(() => {});
  }
  if (!spectrum.rafId) spectrum.rafId = requestAnimationFrame(spectrumFrame);
}

/** Congela a animacao mantendo o ultimo quadro visivel. */
function stopSpectrum() {
  spectrum.playing = false;
  if (spectrum.rafId) {
    cancelAnimationFrame(spectrum.rafId);
    spectrum.rafId = 0;
  }
  spectrum.canvas?.classList.add('is-paused');
}

/** Reseta o visualizador (player sem faixa). */
function resetSpectrum() {
  stopSpectrum();
  spectrum.smooth.fill(0);
  spectrum.levels.fill(0);
  spectrum.canvas?.classList.remove('is-paused');
  drawIdleSpectrum();
}

/* ------------------------------------------------------------------ *
 * Eventos
 * ------------------------------------------------------------------ */

function bind() {
  $('#nav').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.nav-item');
    if (btn) showView(btn.dataset.view);
  });

  $('#mood').addEventListener('change', () => { state.touched.mood = true; });
  // o texto do campo "Estilos" tem prioridade sobre os botoes de genero:
  // enquanto ele existir, os chips ficam visualmente desativados.
  $('#prompt').addEventListener('input', syncStylePriority);
  $('#genreChips').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    
    // Sincroniza o campo de texto 'Estilos' com o gênero clicado
    const genreKey = chip.dataset.genre;
    const genreDescription = getGenreDescription(genreKey);
    const promptField = $('#prompt');
    
    // Preenche o campo de texto com a descrição do gênero
    if (promptField) {
      promptField.value = genreDescription;
      // Dispara o evento input para atualizar a prioridade visual
      promptField.dispatchEvent(new Event('input', { bubbles: true }));
    }
    
    // Marca os botões visuais
    $$('#genreChips .chip').forEach((c) => c.classList.remove('is-on'));
    chip.classList.add('is-on');
    state.touched.genre = true;
  });

  $('#duration').addEventListener('input', (e) => {
    $('#durationValue').textContent = `${e.target.value}s`;
  });
  $('#profileDuration').addEventListener('input', (e) => {
    $('#profileDurationValue').textContent = `${e.target.value}s`;
  });
  ['#energy', '#brightness', '#bpmBias'].forEach((sel) => {
    $(sel).addEventListener('input', syncModelLabels);
  });

  $('#btnGenerate').addEventListener('click', generate);

  // áudio de referência: abre o seletor de arquivos e reflecte o chosen
  $('#btnAddAudio').addEventListener('click', () => $('#referenceAudioInput').click());
  $('#referenceAudioInput').addEventListener('change', (ev) => {
    acceptReferenceAudio(ev.target.files?.[0] || null);
  });
  // modo do audio anexado: referencia de estilo (remix) x cover (melodia)
  $$('input[name="audioMode"]').forEach((input) => {
    input.addEventListener('change', (ev) => {
      if (!ev.target.checked) return;
      const modo = setAudioMode(ev.target.value);
      toast(modo === AUDIO_MODES.COVER
        ? 'Cover: a melodia do áudio original será mantida.'
        : 'Estilo (remix): o áudio entra só como referência de estilo.', 'ok');
    });
  });
  // slider "Fidelidade ao Original" (so no cover)
  $('#coverStrength').addEventListener('input', syncCoverStrength);
  $('#btnRemoveRefAudio').addEventListener('click', () => {
    clearReferenceAudio();
    toast('Áudio de referência removido.', 'info');
  });
  $('#btnCancelJob').addEventListener('click', () => {
    if (state.events) state.events.close();
    state.events = null;
    $('#statusRunning').hidden = true;
    $('#statusEmpty').hidden = false;
    $('#btnGenerate').disabled = false;
    toast('Geração cancelada.', 'info');
  });

  // seed nova por clique: sem ela o gerador local deriva a seed do hash do
  // prompt e o MESMO tema devolve SEMPRE a mesma letra (Bug 1)
  const novaSeed = () => Math.floor(Math.random() * 2 ** 31);

  /**
   * Gerador da letra COMPLETA: usado pela lampada 💡 (#btnLyricAI), a
   * UNICA porta de entrada do /api/lyrics no bloco "Letra".
   *
   * `tema` e o texto que vira semente da letra (o proprio campo "Letra").
   * O backend escreve a letra completa - com IA quando ha chave, senao com
   * o gerador local - e devolve o texto. A estrela ✦ NAO passa por aqui:
   * ela so sorteia o tema (ver o listener dela logo abaixo).
   */
  async function gerarLetra({ tema, btn }) {
    btn.classList.add('is-busy');
    try {
      const res = await api('/api/lyrics', {
        method: 'POST',
        body: { prompt: tema, style: $('#prompt').value.trim(), mode: 'full', seed: novaSeed() },
      });
      const texto = String(res.text || '').trim();
      if (!texto) throw new Error('a IA não devolveu letra.');
      $('#customLyrics').value = texto;
      expandBlock('lyrics');
      magicEffect($('#customLyrics'), btn);
      toast(`${labelLetra(res)}.`, 'ok');
      return texto;
    } finally {
      btn.classList.remove('is-busy');
    }
  }

  /**
   * LAMPADA 💡 do bloco "Letra": a unica que gera a letra COMPLETA.
   *
   * Usa o TEXTO DO CAMPO como tema (com texto no campo ele e o tema; vazio,
   * a lampada sorteia um tema da lista antes) e pede a letra ao backend.
   */
  $('#btnLyricAI').addEventListener('click', async () => {
    const campo = $('#customLyrics');
    const btn = $('#btnLyricAI');
    const tema = campo.value.trim() || pickRandom(LYRIC_THEMES);
    if (!tema) return;
    try {
      await gerarLetra({ tema, btn });
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  /**
   * ESTRELA ✦ do bloco "Letra" (ao lado direito da lampada): sorteia
   * APENAS um tema curto - uma frase de 1 linha, ex.: "Uma música sobre a
   * saudade da infância na praia" - e escreve no campo. NAO gera
   * verso/refrao e NAO chama a API: a lista LYRIC_THEMES vive no
   * front-end, entao funciona offline e nao gasta cota. Quem transforma o
   * tema em letra completa e a lampada 💡 ao lado, unica dona do
   * gerarLetra() (blindagem: temaCurto() corta qualquer estrutura de
   * musica que um item da lista venha trazer).
   */
  $('#btnLyricWand').addEventListener('click', () => {
    const campo = $('#customLyrics');
    const btn = $('#btnLyricWand');
    // lista local -> 1 linha curta (temaCurto garante que nunca vire letra)
    const tema = temaCurto(pickRandom(LYRIC_THEMES, campo.value.trim()));
    if (!tema) return;
    campo.value = tema;
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    expandBlock('lyrics');
    magicEffect(campo, btn);
    toast('Tema sorteado — a 💡 transforma em letra completa.', 'ok');
    return tema;
  });

  // varinha de estilo: gera uma descricao criativa usando IA (NVIDIA/DeepSeek)
  $('#btnStyleWand').addEventListener('click', async () => {
    const campo = $('#prompt');
    const btn = $('#btnStyleWand');
    
    // Estado de carregamento
    btn.disabled = true;
    btn.classList.add('is-busy');
    const originalTitle = btn.title;
    btn.title = 'Gerando estilo criativo com IA...';
    
    try {
      const res = await api('/api/generate-style');
      campo.value = res.style;
      syncStylePriority();
      magicEffect(campo, btn);
      
      // Informa qual engine gerou (IA ou local)
      const engineLabel = res.engine === 'nvidia' ? 'gerado pela NVIDIA'
        : res.engine === 'deepseek' ? 'gerado pelo DeepSeek'
        : 'sorteado localmente';
      toast(`Estilo ${engineLabel} — ajuste como quiser.`, 'ok');
    } catch (err) {
      // Fallback local se a API falhar completamente
      const sugestao = pickRandom(STYLE_SUGGESTIONS, campo.value.trim());
      if (sugestao) {
        campo.value = sugestao;
        syncStylePriority();
        magicEffect(campo, btn);
        toast('Estilo sorteado localmente — ajuste como quiser.', 'ok');
      } else {
        toast('Erro ao gerar estilo. Tente novamente.', 'error');
      }
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      btn.title = originalTitle;
    }
  });

  // "+ Voz": escolhe o motor e a voz
  $('#btnAddVoice').addEventListener('click', () => {
    const voices = ['alloy', 'coral', 'onyx', 'ash', 'echo', 'fable', 'shimmer', 'nova', 'sage', 'verse'];
    const engine = state.voiceEngine || 'auto';
    $('#modalTitle').textContent = 'Voz';
    $('#modalBody').innerHTML = `
      <div class="voice-picker">
        <button data-voice-engine="auto" class="${engine === 'auto' ? 'is-on' : ''}">
          <strong>Automático</strong>
          <span>Voz do modelo (ACE-Step) ou voz procedural local</span>
        </button>
        <button data-voice-engine="openrouter" class="${engine === 'openrouter' ? 'is-on' : ''}">
          <strong>Voz por IA (OpenRouter)</strong>
          <span>TTS com fala real — só com o motor local e crédito na conta</span>
        </button>
        <button data-voice-engine="procedural" class="${engine === 'procedural' ? 'is-on' : ''}">
          <strong>Voz procedural (local)</strong>
          <span>Síntese formântica, offline e grátis</span>
        </button>
        <div class="voice-list">
          ${voices.map((v) => `<button data-voice="${v}" class="${state.ttsVoice === v ? 'is-on' : ''}">${v}</button>`).join('')}
        </div>
        <label class="field">
          <span class="field-label">Cantar sobre a melodia <b id="singLabel">${Math.round((state.singStrength ?? 0.85) * 100)}%</b></span>
          <input type="range" id="singStrength" min="0" max="100" step="5" value="${Math.round((state.singStrength ?? 0.85) * 100)}" />
          <span class="hint">A voz do TTS segue a melodia da faixa (0% = só fala, 100% = canto pleno).</span>
        </label>
      </div>`;
    $('#modalBody').onclick = (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      if (btn.dataset.voiceEngine) {
        state.voiceEngine = btn.dataset.voiceEngine;
        updateVoiceButton();
        toast(`Voz: ${btn.querySelector('strong').textContent}`, 'ok');
        closeModal();
        return;
      }
      if (btn.dataset.voice) {
        state.ttsVoice = btn.dataset.voice;
        $$('#modalBody .voice-list button').forEach((b) => b.classList.toggle('is-on', b === btn));
        updateVoiceButton();
      }
    };
    $('#singStrength')?.addEventListener('input', (e) => {
      state.singStrength = Number(e.target.value) / 100;
      $('#singLabel').textContent = `${e.target.value}%`;
    });
    $('#modalBackdrop').hidden = false;
  });

  $('#btnClearLyrics').addEventListener('click', () => { $('#customLyrics').value = ''; });

  $('#btnLyricsFull').addEventListener('click', () => generateLyrics('full'));
  $('#btnLyricsNext').addEventListener('click', () => generateLyrics('next'));
  $('#btnCollabAdd').addEventListener('click', () => generateLyrics('next'));
  $('#btnCopyLyrics').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#lyricsEditor').value);
    toast('Letra copiada.', 'ok');
  });
  $('#btnUseLyrics').addEventListener('click', () => {
    $('#customLyrics').value = $('#lyricsEditor').value;
    expandBlock('lyrics');
    showView('criar');
    toast('Letra enviada para a criação.', 'ok');
  });

  $('#librarySearch').addEventListener('input', renderTracks);
  $('#libraryFilter').addEventListener('change', renderTracks);
  $('#btnLibraryRefresh').addEventListener('click', loadTracks);

  $('#libraryGrid').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const card = ev.target.closest('.track-card');
    if (card) trackAction(card.dataset.id, btn.dataset.act);
  });
  $('#exploreTracks').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const card = ev.target.closest('.track-card');
    if (card) trackAction(card.dataset.id, btn.dataset.act);
  });
  $('#ideaGrid').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-idea]');
    if (btn) useIdea(btn.dataset.idea);
  });

  $('#btnCreatePlaylist').addEventListener('click', createPlaylist);
  $('#playlistGrid').addEventListener('click', (ev) => {
    const card = ev.target.closest('.playlist-card');
    if (!card) return;
    const p = state.playlists.find((x) => x.id === card.dataset.id);
    if (p) openPlaylist(p);
  });
  $('#playlistTracks').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    const row = ev.target.closest('.track-row');
    if (!row) return;
    if (btn?.dataset.act === 'play') {
      const t = state.tracks.find((x) => x.id === row.dataset.id);
      if (t) playTrack(t, state.tracks);
    }
    if (btn?.dataset.act === 'remove') {
      const playlistId = $('#playlistDetail').dataset.id;
      const p = state.playlists.find((x) => x.id === playlistId);
      if (!p) return;
      await addToPlaylist(playlistId, row.dataset.id); // no-op guard
      const trackIds = p.trackIds.filter((id) => id !== row.dataset.id);
      await api(`/api/playlists/${playlistId}`, { method: 'PATCH', body: { trackIds } });
      p.trackIds = trackIds;
      openPlaylist(p);
      loadPlaylists();
    }
  });

  $('#favGenres').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (chip) chip.classList.toggle('is-on');
  });
  $('#btnSaveProfile').addEventListener('click', saveProfile);

  $('#btnModalClose').addEventListener('click', closeModal);
  $('#modalBackdrop').addEventListener('click', (ev) => {
    if (ev.target === $('#modalBackdrop')) closeModal();
  });

  // player
  $('#btnPlay').addEventListener('click', () => {
    if (!audio.src) {
      const t = state.tracks[0];
      if (t) playTrack(t, state.tracks);
      return;
    }
    ensureAudioGraph();
    if (audio.paused) { audio.play(); $('#btnPlay').innerHTML = ICON.pause; }
    else { audio.pause(); $('#btnPlay').innerHTML = ICON.play; }
  });
  $('#btnNext').addEventListener('click', () => nextTrack());
  $('#btnPrev').addEventListener('click', () => prevTrack());
  $('#btnShuffle').addEventListener('click', (ev) => {
    state.shuffle = !state.shuffle;
    ev.currentTarget.classList.toggle('is-on', state.shuffle);
  });
  $('#btnRepeat').addEventListener('click', (ev) => {
    state.repeat = !state.repeat;
    ev.currentTarget.classList.toggle('is-on', state.repeat);
  });
  $('#btnQueue').addEventListener('click', () => {
    const panel = $('#queuePanel');
    panel.hidden = !panel.hidden;
    renderQueue();
  });
  $('#btnQueueClose').addEventListener('click', () => { $('#queuePanel').hidden = true; });
  $('#queueList').addEventListener('click', (ev) => {
    const item = ev.target.closest('.queue-item');
    if (!item) return;
    const t = state.queue.find((x) => x.id === item.dataset.id);
    if (t) playTrack(t);
  });
  $('#btnDownload').addEventListener('click', () => {
    const t = currentTrack();
    if (t) downloadTrack(t);
    else toast('Nada tocando.', 'error');
  });
  $('#btnDownloadWav').addEventListener('click', () => {
    const t = currentTrack();
    if (t) downloadWav(t);
    else toast('Nada tocando.', 'error');
  });
  $('#btnShare').addEventListener('click', () => {
    const t = currentTrack();
    if (t) shareTrack(t);
    else toast('Nada tocando.', 'error');
  });
  $('#volume').addEventListener('input', (e) => {
    state.volume = Number(e.target.value);
    applyVolume();
  });
  $('#btnMute').addEventListener('click', () => {
    state.muted = !state.muted;
    applyVolume();
    $('#btnMute').textContent = state.muted ? '◂̸' : '◂';
  });
  $('#seekTrack').addEventListener('click', (ev) => {
    if (!audio.duration) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const ratio = (ev.clientX - rect.left) / rect.width;
    audio.currentTime = ratio * audio.duration;
  });

  audio.addEventListener('timeupdate', () => {
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    $('#seekBar').style.width = `${pct}%`;
    $('#playerCurrent').textContent = fmtTime(audio.currentTime);
  });
  audio.addEventListener('ended', () => {
    if (state.repeat && state.currentId) {
      const t = currentTrack();
      if (t) { audio.currentTime = 0; audio.play(); return; }
    }
    nextTrack(true);
  });
  audio.addEventListener('play', () => {
    $('#btnPlay').innerHTML = ICON.pause;
    startSpectrum();
  });
  audio.addEventListener('pause', () => {
    $('#btnPlay').innerHTML = ICON.play;
    stopSpectrum();
  });
  audio.addEventListener('volumechange', () => {
    // o ganho do grafo e a fonte da verdade quando existe; aqui so
    // refletimos o estado do elemento para manter a UI coerente
    if (!spectrum.gain) {
      state.volume = audio.volume;
      state.muted = audio.muted;
    }
  });
}

/* a animacao nao roda com a aba em segundo plano (poupa bateria) */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (spectrum.rafId) {
      cancelAnimationFrame(spectrum.rafId);
      spectrum.rafId = 0;
    }
  } else if (spectrum.playing && spectrum.analyser && !spectrum.rafId) {
    spectrum.rafId = requestAnimationFrame(spectrumFrame);
  }
});

/* ------------------------------------------------------------------ *
 * PWA: service worker, instalação e estado online
 * ------------------------------------------------------------------ */

let deferredInstallPrompt = null;

function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function setupInstall() {
  const btn = $('#btnInstall');
  const label = $('#installLabel');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (!isStandalone()) {
      btn.hidden = false;
      label.textContent = 'Instalar app';
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    btn.hidden = true;
    toast('MusicGPT instalado — agora abre em tela cheia, como app.', 'ok');
  });

  btn.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      btn.hidden = true;
      toast(
        outcome === 'accepted' ? 'Instalando o MusicGPT…' : 'Instalação cancelada.',
        outcome === 'accepted' ? 'ok' : 'info',
      );
      return;
    }
    // iOS Safari / Firefox: sem prompt nativo, mas dá para instalar manualmente
    toast('Android: menu ⋮ → "Instalar app". iPhone: Compartilhar → "Adicionar à Tela de Início".', 'info');
  });

  // Em iOSstandalone não faz sentido oferecer instalação
  if (isStandalone()) btn.hidden = true;
}

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });

      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            // nova versao pronta: avisa e recarrega (sem dialogo bloqueante)
            toast('Nova versão do MusicGPT disponível — recarregando…', 'ok');
            sw.postMessage('SKIP_WAITING');
            setTimeout(() => location.reload(), 2500);
          }
        });
      });

      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    } catch (err) {
      console.warn('[pwa] service worker não registrado:', err);
    }
  });
}

function setupOnlineState() {
  const badge = $('#offlineBadge');
  const sync = () => { badge.hidden = navigator.onLine; };
  sync();
  window.addEventListener('online', () => {
    sync();
    toast('De volta online.', 'ok');
  });
  window.addEventListener('offline', () => {
    sync();
    toast('Sem conexão — o app segue funcionando com a cópia em cache.', 'info');
  });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  bind();
  bindCreateBlocks();
  setupInstall();
  setupServiceWorker();
  setupOnlineState();
  initSpectrum();
  applyVolume();
  await loadConfig();
  await loadTracks();
  await loadPlaylists();
  syncStylePriority();
  syncAudioMode();
  try {
    const res = await api('/api/profile');
    state.profile = res.profile;
    $('#profileName').textContent = res.profile.displayName || 'Estúdio';
    $('#profileAvatar').textContent = (res.profile.displayName || 'E').charAt(0).toUpperCase();
    const voiceLabel = state.config.providers.voice === 'openrouter' ? ' · voz IA' : '';
    const engineLabel = state.config.providers.music === 'acestep' ? 'ACE-Step' : state.config.providers.music;
    $('#profileProvider').textContent = `${engineLabel}${voiceLabel}`;
    $('#voice').value = res.profile.voiceStyle || 'pop';
    $('#duration').value = res.profile.defaultDuration || 75;
    $('#durationValue').textContent = `${res.profile.defaultDuration || 75}s`;
  } catch { /* perfil indisponivel (offline sem cache) */ }

  // atalhos do manifest (ex.: /?view=biblioteca)
  const view = new URLSearchParams(location.search).get('view');
  const valid = ['criar', 'letras', 'biblioteca', 'playlists', 'modelo', 'explorar'];
  if (view && valid.includes(view)) showView(view);
}

boot();
