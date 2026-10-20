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

function expandBlock(name) {
  const btn = $(`#toggle${name}`);
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
  [['lyrics', 'toggleLyrics'], ['styles', 'toggleStyles'], ['more', 'toggleMore']].forEach(([name, id]) => {
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
    payload = await api('/api/generate', {
      method: 'POST',
      body: {
        prompt,
        title: $('#title').value.trim(),
        genre: state.touched.genre ? selectedGenre() : '',
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
      },
    });
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
      $('#doneTitle').textContent = 'Faixa pronta';
      $('#doneCard').innerHTML = `
        <div class="done-title">${escapeHtml(track.title)}</div>
        <div class="done-tags">
          <span class="tag">${escapeHtml(track.genreLabel || '')}</span>
          <span class="tag">${escapeHtml(track.moodLabel || '')}</span>
          <span class="tag">${Math.round(track.duration)}s</span>
          ${track.bpm ? `<span class="tag">${track.bpm} BPM</span>` : ''}
          ${track.key ? `<span class="tag">${escapeHtml(track.key)}</span>` : ''}
          ${track.lofi ? '<span class="tag">chuva</span>' : ''}
          <span class="tag">${escapeHtml(track.engine || '')}</span>
          ${track.voiceInfo?.engine === 'openrouter' ? '<span class="tag">voz IA</span>' : ''}
          ${track.voiceInfo?.engine === 'acestep' ? '<span class="tag">voz ACE-Step</span>' : ''}
        </div>`;
      if (Array.isArray(track.warnings) && track.warnings.length) {
        toast(track.warnings[0], 'error');
      }
      $('#btnPlayDone').onclick = () => playTrack(track);
      // download do WAV gerado: a rota devolve o buffer de audio como arquivo
      const wavBtn = $('#btnDownloadDone');
      wavBtn.onclick = () => downloadWav(track);
      wavBtn.disabled = track.format !== 'wav';
      wavBtn.title = track.format === 'wav'
        ? 'Baixar o audio gerado em .wav'
        : 'WAV local indisponivel (faixa vinda de provider remoto)';
      $('#btnOpenDone').onclick = () => { showView('biblioteca'); loadTracks(); };
      // reflete o genero/clima efetivamente usados (podem ter sido detectados pelo prompt)
      const usedChip = $(`#genreChips .chip[data-genre="${track.genre}"]`);
      if (usedChip) {
        $$('#genreChips .chip').forEach((c) => c.classList.remove('is-on'));
        usedChip.classList.add('is-on');
        state.touched.genre = true;
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
      toast('Letra criada. Edite à vontade.', 'ok');
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
        <span>${escapeHtml(t.genreLabel || '')} · ${escapeHtml(t.moodLabel || '')}</span>
      </div>
    </div>
    <div class="wave">${bars}</div>
    <div class="track-meta">
      <span>${fmtTime(t.duration)}</span>
      ${t.bpm ? `<span>${t.bpm} BPM</span>` : ''}
      ${t.key ? `<span>${escapeHtml(t.key)}</span>` : ''}
      ${t.instrumental ? '<span>instrumental</span>' : '<span>com voz</span>'}
      ${t.voiceInfo?.engine === 'openrouter' ? '<span>voz IA</span>' : ''}
      ${t.voiceInfo?.engine === 'acestep' ? '<span>voz ACE-Step</span>' : ''}
      ${t.lofi ? '<span>chuva</span>' : ''}
      <span>${t.plays || 0} plays</span>
      ${t.isPublic ? '<span class="tag">publicada</span>' : ''}
    </div>
    <div class="track-actions">
      <button class="icon-btn is-primary" data-act="play" title="Tocar">${ICON.play}</button>
      <button class="icon-btn" data-act="download-wav" title="Baixar .wav">${ICON.wave}</button>
      <button class="icon-btn" data-act="download" title="Baixar MP3">${ICON.download}</button>
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
 * (a API responde JSON quando a faixa nao tem WAV local, por exemplo).
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
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
    toast(`${label} iniciado (${(blob.size / 1048576).toFixed(1)} MB).`, 'ok');
  } catch (err) {
    toast(`Falha no download: ${err.message}`, 'error');
  }
}

function downloadWav(track) {
  return downloadFile(`/api/download/${track.id}`, `${track.slug || track.id}.wav`, 'Download do WAV');
}

function downloadTrack(track) {
  return downloadFile(`/api/tracks/${track.id}/audio?format=mp3`, `${track.slug || track.id}.mp3`, 'Download do MP3');
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
  audio.src = `/api/tracks/${track.id}/audio`;
  audio.play().catch(() => toast('Toque novamente para iniciar a reprodução.', 'error'));
  updatePlayerMeta(track);
  api(`/api/tracks/${track.id}/play`, { method: 'POST' }).catch(() => {});
  renderQueue();
}

function updatePlayerMeta(track) {
  $('#playerTitle').textContent = track.title;
  $('#playerSub').textContent = `${track.genreLabel || ''} · ${track.moodLabel || ''} · ${fmtTime(track.duration)}`;
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
 * Eventos
 * ------------------------------------------------------------------ */

function bind() {
  $('#nav').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.nav-item');
    if (btn) showView(btn.dataset.view);
  });

  $('#mood').addEventListener('change', () => { state.touched.mood = true; });
  $('#genreChips').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
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
  $('#btnCancelJob').addEventListener('click', () => {
    if (state.events) state.events.close();
    state.events = null;
    $('#statusRunning').hidden = true;
    $('#statusEmpty').hidden = false;
    $('#btnGenerate').disabled = false;
    toast('Geração cancelada.', 'info');
  });

  // varinha da letra: gera a letra com IA e coloca no bloco "Letra"
  $('#btnLyricWand').addEventListener('click', async () => {
    const prompt = $('#prompt').value.trim() || $('#lyricsPrompt').value.trim();
    if (!prompt) {
      toast('Escreva um estilo primeiro — a letra nasce da ideia.', 'error');
      $('#prompt').focus();
      return;
    }
    const btn = $('#btnLyricWand');
    btn.classList.add('is-busy');
    try {
      const res = await api('/api/lyrics', { method: 'POST', body: { prompt, mode: 'full' } });
      $('#customLyrics').value = res.text;
      expandBlock('lyrics');
      toast(`Letra criada (${res.engine || 'IA'}).`, 'ok');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.classList.remove('is-busy');
    }
  });

  // varinha de estilo: sugere uma descricao de estilo coerente
  $('#btnStyleWand').addEventListener('click', () => {
    const genre = selectedGenre();
    const label = $('#genreChips .chip.is-on')?.textContent || 'Pop';
    const mood = $('#mood').value;
    const extras = {
      lofi: 'com chuva de fundo e textura de vinil',
      rock: 'com guitarra distorcida e bateria seca',
      mpb: 'com violão, pandeiro e groove brasileiro',
      trap: 'com 808 pesado, hi-hats rápidos e sintetizadores escuros',
      samba: 'com surdo, tamborim e pandeiro',
      house: 'com kick de quatro tempos e sintetizador pulsante',
      forro: 'com sanfona, triângulo e bateria de vaqueiro',
      gospel: 'com coro, piano e dinâmica crescente',
    };
    const suggestion = `${label} ${mood === 'alegre' ? 'energético' : mood} ${extras[genre] || 'com produção limpa e foco na melodia'}`;
    $('#prompt').value = suggestion;
    toast('Estilo sugerido. Ajuste como quiser.', 'ok');
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
  $('#volume').addEventListener('input', (e) => { audio.volume = Number(e.target.value); });
  $('#btnMute').addEventListener('click', () => {
    audio.muted = !audio.muted;
    $('#btnMute').textContent = audio.muted ? '◂̸' : '◂';
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
  audio.addEventListener('play', () => { $('#btnPlay').innerHTML = ICON.pause; });
  audio.addEventListener('pause', () => { $('#btnPlay').innerHTML = ICON.play; });
}

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
  await loadConfig();
  await loadTracks();
  await loadPlaylists();
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
