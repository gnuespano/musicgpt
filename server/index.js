/**
 * Servidor HTTP do MusicGPT (clone).
 * Rotas /api/* + arquivos estaticos do front-end.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { HOST, PUBLIC_DIR, resolvePort } from './config.js';
import { activeMusicProvider, aceStepAvailable, activeLyricsProvider, mainLyricsProvider, deepSeekAvailable, nvidiaAvailable, groqAvailable } from './config.js';
import { handlers, json } from './api.js';

/**
 * Porta do servidor: process.env.PORT tem prioridade (Render/Heroku/Docker
 * injetam essa variavel). Sem ela - ou com valor invalido - usa 8787.
 */
const PORT = resolvePort(process.env.PORT);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const ROUTES = [
  ['GET', '/api/health', handlers.health],
  ['GET', '/api/config', handlers.config],
  ['POST', '/api/generate', handlers.generate],
  ['GET', '/api/jobs/:id', handlers.jobStatus],
  ['GET', '/api/jobs/:id/events', handlers.jobEvents],
  ['POST', '/api/lyrics', handlers.lyrics],
  ['GET', '/api/generate-style', handlers.generateStyle],
  ['GET', '/api/tracks', handlers.listTracks],
  ['GET', '/api/tracks/:id', handlers.getTrack],
  ['DELETE', '/api/tracks/:id', handlers.deleteTrack],
  ['POST', '/api/tracks/:id/play', handlers.playTrack],
  ['POST', '/api/tracks/:id/like', handlers.likeTrack],
  ['POST', '/api/tracks/:id/publish', handlers.publishTrack],
  ['GET', '/api/tracks/:id/audio', handlers.audio],
  ['GET', '/api/download/:id', handlers.download],
  ['GET', '/api/tracks/:id/share', handlers.share],
  ['GET', '/api/playlists', handlers.listPlaylists],
  ['POST', '/api/playlists', handlers.createPlaylist],
  ['PATCH', '/api/playlists/:id', handlers.updatePlaylist],
  ['DELETE', '/api/playlists/:id', handlers.deletePlaylist],
  ['GET', '/api/profile', handlers.getProfile],
  ['PUT', '/api/profile', handlers.updateProfile],
  ['GET', '/api/explore', handlers.explore],
];

function matchRoute(method, pathname) {
  for (const [routeMethod, pattern, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const patternParts = pattern.split('/').filter(Boolean);
    const pathParts = pathname.split('/').filter(Boolean);
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      const p = patternParts[i];
      if (p.startsWith(':')) {
        params[p.slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (p !== pathParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler, params };
  }
  return null;
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Acesso negado');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      return fs.readFile(indexPath, (e2, data) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Nao encontrado');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        return res.end(data);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    const isSource = ext === '.html' || ext === '.css' || ext === '.js';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': isSource ? 'no-cache' : 'public, max-age=3600',
    });
    return fs.createReadStream(filePath).pipe(res);
  });
}

const requestListener = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (pathname.startsWith('/api/')) {
    const match = matchRoute(req.method, pathname);
    if (!match) return json(res, 404, { error: `Rota nao encontrada: ${req.method} ${pathname}` });
    try {
      return await match.handler(req, res, match.params);
    } catch (error) {
      return json(res, 500, { error: error?.message || 'Erro interno' });
    }
  }

  return serveStatic(req, res, pathname);
};

// HTTPS opcional: necessario para instalar o PWA em um celular (o service
// worker so registra em origens seguras). Habilite com:
//   MUSICGPT_SSL_CERT=data/ssl/cert.pem MUSICGPT_SSL_KEY=data/ssl/key.pem npm start
const SSL_CERT = process.env.MUSICGPT_SSL_CERT;
const SSL_KEY = process.env.MUSICGPT_SSL_KEY;
const useHttps = Boolean(SSL_CERT && SSL_KEY && fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY));

const server = useHttps
  ? https.createServer({ cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) }, requestListener)
  : http.createServer(requestListener);

server.listen(PORT, HOST, () => {
  const scheme = useHttps ? 'https' : 'http';
  console.log(`MusicGPT (clone) rodando em ${scheme}://localhost:${PORT}`);
  const engine = activeMusicProvider();
  console.log(`  -> motor de musica: ${engine}${engine === 'acestep' ? ' (ACE-Step 1.5)' : ''}`);
  if (!aceStepAvailable()) {
    console.log('  -> ACESTEP_API_KEY ausente: usando o motor procedural local.');
    console.log('     pegue a chave gratuita em https://acemusic.ai/api-key e coloque no .env');
  }
  const letras = activeLyricsProvider();
  const letrasPrincipal = mainLyricsProvider();
  const provedorLabel = letras === 'deepseek' ? ' (DeepSeek)'
    : letras === 'groq' ? ' (Groq)'
    : letras === 'nvidia' ? ' (NVIDIA NIM)'
    : '';
  console.log(`  -> provedor de letras: ${letras}${provedorLabel}`);
  if (letrasPrincipal !== letras) console.log(`     letras na geracao principal: ${letrasPrincipal}`);
  if (letras === 'deepseek' || letras === 'groq' || letras === 'nvidia') {
    console.log('     cadeia de fallback: DeepSeek -> Groq -> NVIDIA NIM -> gerador local de templates');
  }
  if (letras === 'local' && !deepSeekAvailable() && !groqAvailable() && !nvidiaAvailable()) {
    console.log('  -> DEEPSEEK_API_KEY/GROQ_API_KEY/NVIDIA_API_KEY ausentes: letras no gerador local de templates.');
    console.log('     pegue as chaves em https://platform.deepseek.com, https://groq.com/groq-cloud ou https://build.nvidia.com e coloque no .env');
  }
  if (useHttps) {
    console.log('  -> PWA instalável (origem segura). Para o celular, use o IP da rede local ou um túnel HTTPS.');
  } else {
    console.log('  -> Para instalar como PWA no celular, rode com HTTPS (veja README, seção PWA).');
  }
});
