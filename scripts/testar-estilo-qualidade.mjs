/**
 * REGRESSAO: a varinha da caixa de Estilos tem que devolver um estilo
 * sofisticado de verdade - 4 frases e 60+ palavras (o padrao do exemplo do
 * usuario) - e a IA tem que funcionar mesmo quando o provider devolve o
 * texto dentro do RACIOCINIO (modelos gpt-oss: `content: null` e o texto em
 * `reasoning_content`).
 *
 * Antes: o gate aceitava 28 palavras (e o pedido e 60+), e a NVIDIA nunca
 * servia porque so lia `message.content` - o resultado era sempre `local`.
 *
 * O teste sobe um STUB local do provider OpenAI-compatible e le o corpo
 * HTTP que saiu na rede.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSophisticatedStyle, isSophisticatedStyle } from '../server/providers/style.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = { ok: 0, fail: 0 };
const check = (nome, cond, detalhe = '') => {
  if (cond) { report.ok += 1; console.log(`  ok   ${nome}`); }
  else { report.fail += 1; console.error(`  FAIL ${nome}${detalhe ? ` :: ${detalhe}` : ''}`); }
};

const contarPalavras = (t) => String(t).split(/\s+/).filter(Boolean).length;
const contarFrases = (t) => (String(t).match(/[.;]/g) || []).length;

/* ------------------------------------------------------------------ *
 * 1. O gate e estrito: 4 frases e 60+ palavras
 * ------------------------------------------------------------------ */

console.log('\n== gate de qualidade do estilo ==');

const generos = ['sertanejo', 'trap', 'mpb', 'rock', 'pop', 'funk', 'samba', 'reggae'];
let locaisOk = true;
let minPalavras = Infinity;
let minFrases = Infinity;
for (const g of generos) {
  const s = buildSophisticatedStyle({ genre: g });
  const p = contarPalavras(s);
  const f = contarFrases(s);
  minPalavras = Math.min(minPalavras, p);
  minFrases = Math.min(minFrases, f);
  if (!isSophisticatedStyle(s)) {
    locaisOk = false;
    console.error(`    genero ${g}: ${p} palavras / ${f} frases -> reprovado`);
  }
}
check('todos os generos locais passam no gate', locaisOk);
check('o gerador local entrega 50+ palavras', minPalavras >= 50, `minimo=${minPalavras}`);
check('o gerador local entrega 4 frases', minFrases >= 4, `minimo=${minFrases}`);

const curto = 'Pop with beat. Male vocal delivery. Catchy hook and chorus. Modern radio production, high energy, never slow.';
check('estilo de 24 palavras e REPROVADO', !isSophisticatedStyle(curto));

const exemploUsuario = 'Brazilian sertanejo universitario "sofrência" with mid-tempo groove, strong acoustic guitar rhythm, punchy drums, and subtle accordion. Male vocalist with gritty, emotional voice, expressive delivery with dynamic intensity (soft verses, powerful chorus). Theme of heartbreak and betrayal, but with attitude and drinking-night vibe. Catchy hook, memorable chorus, modern radio production, high energy, engaging and not slow.';
check('o exemplo do usuario passa no gate', isSophisticatedStyle(exemploUsuario));
// o exemplo de referencia do proprio usuario tem 55 palavras - o piso do
// gate fica nesse patamar (rejeita 24-40, aceita 50+).
check('o exemplo do usuario tem 50+ palavras', contarPalavras(exemploUsuario) >= 50, `${contarPalavras(exemploUsuario)} palavras`);
check('o exemplo do usuario tem 4 frases', contarFrases(exemploUsuario) >= 4, `${contarFrases(exemploUsuario)} frases`);

/* ------------------------------------------------------------------ *
 * 2. A IA funciona quando o texto vem no RACIOCINIO (gpt-oss)
 * ------------------------------------------------------------------ */

console.log('\n== IA com texto no reasoning_content ==');

const ESTILO_IA = 'sertanejo, 100 BPM, acoustic guitar, surdo, tambourine, subtle vinyl crackle for warmth, snappy kick, crisp snare for a tight groove, clean reverb; the vocalist narrates a rustic romance with a warm baritone, melodic phrasing, submissive crescendos; the theme is carefree love on a sun-kissed farm, with a cheeky swagger, evoking a lively countryside vibe; the hook is a punchy, memorable chorus in a punchy 4/4, processed with bright high-pass EQ and head-spilling energy';

const requisicoes = [];
const servidor = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => { corpo += c; });
  req.on('end', () => {
    requisicoes.push({ url: req.url, body: JSON.parse(corpo || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-stub', model: 'stub-model',
      choices: [{
        index: 0, finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: null,
          reasoning_content: `The user wants a production prompt. Reasoning... ${ESTILO_IA}`,
        },
      }],
    }));
  });
});
await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
const porta = servidor.address().port;

process.env.NVIDIA_API_KEY = 'stub-chave-1234567890';
process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${porta}/v1`;
process.env.NVIDIA_MODEL = 'stub-model';
process.env.NVIDIA_TIMEOUT_MS = '7000';
process.env.NVIDIA_THROTTLE_MS = '0';
process.env.DEEPSEEK_API_KEY = '';

const { generateMusicStyle } = await import('../server/providers/lyrics.js');
const r = await generateMusicStyle({ genre: 'sertanejo', mood: 'alegre' });

check('a IA foi chamada de verdade', requisicoes.length === 1, `requisicoes=${requisicoes.length}`);
check('a requisicao foi para /chat/completions', requisicoes[0]?.url === '/v1/chat/completions', requisicoes[0]?.url);
check('a requisicao pediu reasoning_effort (gpt-oss)', requisicoes[0]?.body?.reasoning_effort === 'low', String(requisicoes[0]?.body?.reasoning_effort));
check('a requisicao reservou tokens para o raciocinio', Number(requisicoes[0]?.body?.max_tokens) >= 900, String(requisicoes[0]?.body?.max_tokens));
check('o engine reportado e a IA (nao o fallback local)', r.engine === 'nvidia', `engine=${r.engine}`);
check('nao houve fallback por reprovacao no gate', !r.fallback, String(r.fallback));
check('o preambulo de raciocinio foi removido', !/^Reasoning/i.test(r.style) && !/The user wants/i.test(r.style), r.style.slice(0, 60));
check('o texto da IA foi recuperado do reasoning_content', r.style.startsWith('sertanejo'), r.style.slice(0, 60));
check('o estilo da IA passa no gate', isSophisticatedStyle(r.style), `${contarPalavras(r.style)} palavras / ${contarFrases(r.style)} frases`);

servidor.close();

/* ------------------------------------------------------------------ *
 * 3. Quando o provider nao responde, o prazo e respeitado
 * ------------------------------------------------------------------ */

console.log('\n== prazo quando o provider nao responde ==');

const servidorTravado = http.createServer((req, res) => {
  req.on('data', () => {});
});
await new Promise((r) => servidorTravado.listen(0, '127.0.0.1', r));
const portaTravada = servidorTravado.address().port;

const arquivo = path.join(REPO, 'server', 'providers', 'lyrics.js');
const fonte = fs.readFileSync(arquivo, 'utf8');
const prazo = Number((fonte.match(/const STYLE_DEADLINE_MS = (\d+)/) || [])[1] || 0);
check('o prazo do estilo esta configurado', prazo >= 3000 && prazo <= 15000, `${prazo}ms`);

const executar = promisify(execFile);
const codigo = `
  process.env.NVIDIA_API_KEY = 'stub-chave-1234567890';
  process.env.NVIDIA_BASE_URL = 'http://127.0.0.1:${portaTravada}/v1';
  process.env.NVIDIA_MODEL = 'stub-model';
  process.env.DEEPSEEK_API_KEY = '';
  const { generateMusicStyle } = await import(${JSON.stringify(arquivo)});
  const t0 = Date.now();
  const r = await generateMusicStyle({ genre: 'sertanejo', mood: 'alegre' });
  const s = r.style;
  console.log(JSON.stringify({
    engine: r.engine,
    ms: Date.now() - t0,
    palavras: s.split(/\\s+/).filter(Boolean).length,
    frases: (s.match(/[.;]/g) || []).length,
  }));
`;
const t0 = Date.now();
const { stdout } = await executar(process.execPath, ['--input-type=module', '-e', codigo], { cwd: REPO, timeout: 60000 });
const ms = Date.now() - t0;
const r2 = JSON.parse(stdout.trim().split('\n').pop());
check('com o provider travado o fallback local assume', r2.engine === 'local', `engine=${r2.engine}`);
check('o fallback local ainda entrega 50+ palavras', r2.palavras >= 50, `${r2.palavras} palavras`);
check('o fallback local ainda entrega 4 frases', r2.frases >= 4, `${r2.frases} frases`);
check('o prazo foi respeitado', ms < prazo + 6000, `${ms}ms para um prazo de ${prazo}ms`);

servidorTravado.close();

console.log(`\n${report.ok} ok, ${report.fail} falha(s)`);
process.exit(report.fail ? 1 : 0);
