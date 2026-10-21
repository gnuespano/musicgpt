/**
 * Sonda: o que a API do ACE-Step devolve em audio_url?
 * Roda uma geracao curtissima e imprime a "forma" do payload (sem o audio).
 */
import 'dotenv/config';
import { ACESTEP } from '../server/config.js';

const body = {
  messages: [{ role: 'user', content: '<prompt>teste curto</prompt>' }],
  stream: false,
  thinking: false,
  use_format: false,
  sample_mode: true,
  audio_config: { format: 'mp3', instrumental: true, duration: 12 },
  model: 'acemusic/acestep-v1.5-turbo',
};

const res = await fetch(`${ACESTEP.baseURL}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ACESTEP.apiKey}` },
  body: JSON.stringify(body),
});

const raw = await res.text();
console.log('status:', res.status);
let payload;
try { payload = JSON.parse(raw); } catch { console.log('resposta nao-JSON:', raw.slice(0, 500)); process.exit(1); }

const audio = payload?.choices?.[0]?.message?.audio;
const first = Array.isArray(audio) ? audio[0] : audio;
const url = first?.audio_url?.url || first?.audio_url || first?.url || null;
console.log('formato do audio_url:', url ? String(url).slice(0, 60) : '(ausente)');
console.log('eh data URL?', typeof url === 'string' && url.startsWith('data:'));
console.log('eh http(s)?', typeof url === 'string' && /^https?:\/\//i.test(url));
console.log('chaves do audio[0]:', Object.keys(first || {}));
console.log('chaves da message:', Object.keys(payload?.choices?.[0]?.message || {}));
if (typeof url === 'string' && url.startsWith('data:')) {
  console.log('mime:', url.slice(5, url.indexOf(';') > 0 ? url.indexOf(';') : 40));
  console.log('tamanho base64:', url.length);
}
console.log('content (inicio):', String(payload?.choices?.[0]?.message?.content || '').slice(0, 300));
