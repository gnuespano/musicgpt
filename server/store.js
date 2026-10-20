/**
 * Persistencia simples em JSON (sem dependencias).
 * Arquivos: data/library.json, data/playlists.json, data/profile.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, TRACKS_DIR } from './config.js';

const FILES = {
  library: path.join(DATA_DIR, 'library.json'),
  playlists: path.join(DATA_DIR, 'playlists.json'),
  profile: path.join(DATA_DIR, 'profile.json'),
};

const DEFAULT_PROFILE = {
  displayName: 'Estúdio',
  language: 'pt',
  voiceStyle: 'pop',
  favoriteGenres: ['pop', 'mpb', 'trap'],
  defaultDuration: 75,
  modelProfile: {
    name: 'Meu modelo',
    description: 'Perfil criativo que orienta geração, letras e mixagem.',
    bpmBias: 0,
    brightness: 0.5,
    vocalCharacter: 'natural',
    energy: 0.6,
  },
};

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return structuredClone(fallback);
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export const store = {
  library() {
    return readJson(FILES.library, { tracks: [], plays: {} });
  },
  saveLibrary(data) {
    writeJson(FILES.library, data);
  },
  playlists() {
    return readJson(FILES.playlists, { playlists: [] });
  },
  savePlaylists(data) {
    writeJson(FILES.playlists, data);
  },
  profile() {
    return { ...DEFAULT_PROFILE, ...readJson(FILES.profile, DEFAULT_PROFILE) };
  },
  saveProfile(data) {
    writeJson(FILES.profile, data);
  },
};

export function newId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** Picos de forma de onda (normalizados 0..1) para a UI. */
export function computePeaks(channels, buckets = 72) {
  const len = channels[0].length;
  const size = Math.max(1, Math.floor(len / buckets));
  const peaks = [];
  for (let b = 0; b < buckets; b += 1) {
    const start = b * size;
    let max = 0;
    for (let c = 0; c < channels.length; c += 1) {
      for (let i = start; i < Math.min(len, start + size); i += 1) {
        const v = Math.abs(channels[c][i]);
        if (v > max) max = v;
      }
    }
    peaks.push(Math.round(max * 100) / 100);
  }
  const top = Math.max(...peaks, 0.01);
  return peaks.map((p) => Math.round((p / top) * 100) / 100);
}

/** Salva o audio em disco e devolve o caminho relativo. */
export function saveAudio(id, buffer, format) {
  const file = path.join(TRACKS_DIR, `${id}.${format}`);
  fs.writeFileSync(file, buffer);
  return path.relative(DATA_DIR, file);
}

export function audioPath(relative) {
  return path.join(DATA_DIR, relative);
}

export function listTrackFiles() {
  try {
    return fs.readdirSync(TRACKS_DIR);
  } catch {
    return [];
  }
}
