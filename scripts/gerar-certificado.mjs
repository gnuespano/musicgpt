/**
 * Gera um certificado autoassinado para rodar o MusicGPT em HTTPS.
 *
 * Uso:  node scripts/gerar-certificado.mjs [IP_DA_REDE ...]
 * Saída: data/ssl/cert.pem e data/ssl/key.pem
 *
 * Atenção: certificado autoassinado não é confiável pelo navegador, então o
 * Chrome bloqueia o registro do service worker nessa origem (a instalação do
 * PWA não conclude). Para o celular, prefira um túnel HTTPS com certificado
 * válido (Cloudflare Tunnel, ngrok, Tailscale Serve) — veja o README.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'data', 'ssl');
fs.mkdirSync(outDir, { recursive: true });

const ips = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const altNames = [
  { type: 'DNS', value: 'localhost' },
  { type: 'DNS', value: 'musicgpt.local' },
  ...ips.map((ip) => ({ type: 'IP', value: ip })),
];

const pems = await selfsigned.generate(
  [{ name: 'commonName', value: 'MusicGPT' }],
  {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  },
);

const certPath = path.join(outDir, 'cert.pem');
const keyPath = path.join(outDir, 'key.pem');
fs.writeFileSync(certPath, pems.cert);
fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });

console.log('certificado gerado:');
console.log('  cert:', certPath);
console.log('  key :', keyPath);
console.log('  SAN :', altNames.map((a) => a.value).join(', '));
console.log('\nPara subir com HTTPS:');
console.log(`  MUSICGPT_SSL_CERT=${certPath} MUSICGPT_SSL_KEY=${keyPath} npm start`);
