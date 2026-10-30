#!/usr/bin/env node
/**
 * Testes da camada determinística: quebra por sílabas + performance cues.
 *
 * ARQUIVO DE DESTINO: scripts/testar-performance-cues.mjs (NOVO)
 *
 * Uso:
 *   node scripts/testar-performance-cues.mjs
 *   SMOKE=1 PORT=3000 node scripts/testar-performance-cues.mjs   # teste de rede
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.DEEPSEEK_API_KEY ||= 'test-key';
process.env.GROQ_API_KEY ||= 'test-key';
process.env.NVIDIA_API_KEY ||= 'test-key';
process.env.ACESTEP_API_KEY ||= 'test-key';

const PROVIDER_PATH = fileURLToPath(new URL('../server/providers/lyrics.js', import.meta.url));
const { addPerformanceCues, stripPerformanceCues, hasPerformanceCues,
        breakLyricsIntoSyllableLines, estimateSyllables, applyLyricsPipeline,
        canonicalTagFor, normalizeSectionTags,
        PERFORMANCE_CUES_POLICY, CANONICAL_SECTION_TAGS } =
  await import('../server/providers/lyrics.js');

/** Letra crua (como o LLM devolve): 4 blocos, verso/chorus/verso/chorus. */
const LETRA_CRUA = `A cidade dorme mas meu peito não acorda
Eu ainda escuto o teu nome quando a chuva cai
O poste acende e a rua fica inteira

Se você voltar eu vou estar aqui de novo
Com as mãos abertas e o coração mais quieto
Esperando o sol quebrar no horizonte

O tempo passou e a rua mudou de cor
Mas a saudade ficou exatamente igual
E o teu lugar na mesa continua vazio

Se você voltar eu vou estar aqui de novo
Com as mãos abertas e o coração mais quieto
Esperando o sol quebrar no horizonte`;

/** Pipeline real do projeto: quebra por sílabas ANTES das cues. */
function pipeline(raw, context = {}) {
  return addPerformanceCues(breakLyricsIntoSyllableLines(raw, { min: 6, max: 9 }), context);
}

function blocos(text) {
  return String(text).split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
}

function syllablesOfLine(line) {
  return String(line).split(/\s+/).filter(Boolean)
    .reduce((sum, word) => sum + estimateSyllables(word), 0);
}

function corpoDoBloco(block) {
  return block.split('\n').filter((l) => !/^\s*\[/.test(l)).join('\n');
}

/* ========================================================================== */
test('REQUISITO 1 — includeDirections tem padrão false', () => {
  assert.equal(PERFORMANCE_CUES_POLICY.includeDirections, false);
  const out = pipeline(LETRA_CRUA, { genre: 'sertanejo', mood: 'sad', vocals: 'female' });
  assert.ok(!out.includes('('), 'a letra não pode conter parênteses por padrão');
  assert.ok(!/^\(.*\)$/m.test(out), 'nenhuma linha entre parênteses');
});

test('REQUISITO 1 — includeDirections:true só insere se pedido', () => {
  const out = pipeline(LETRA_CRUA, { genre: 'sertanejo', includeDirections: true });
  assert.ok(out.startsWith('('), 'direção deve aparecer quando explicitamente pedida');
  assert.match(out, /violão acústico/);
});

test('REQUISITO 2 — tags sem número', () => {
  const out = pipeline(LETRA_CRUA);
  assert.match(out, /^\[Verse\]$/m);
  assert.match(out, /^\[Chorus\]$/m);
  assert.ok(!/\[Verse \d+\]/.test(out), 'não deve existir [Verse 2]');
  assert.ok(!/\[Chorus \d+\]/.test(out), 'não deve existir [Chorus 2]');
  const tags = [...out.matchAll(/^\[([^\]]+)\]$/gm)].map((m) => m[1]);
  for (const tag of tags) {
    assert.ok(CANONICAL_SECTION_TAGS.includes(tag), `tag fora do conjunto canônico: ${tag}`);
  }
});

test('REQUISITO 2 — [Bridge] aparece em interlúdio curto entre dois [Chorus]', () => {
  const letra = `primeiro bloco do verso
segunda linha do verso

refrao que se repete
segunda linha do refrao

solo

refrao que se repete
segunda linha do refrao`;
  const out = pipeline(letra);
  const tags = [...out.matchAll(/^\[([^\]]+)\]$/gm)].map((m) => m[1]);
  assert.deepEqual(tags, ['Verse', 'Chorus', 'Bridge', 'Chorus']);
});

test('REQUISITO 2 — verso cheio entre dois [Chorus] continua [Verse]', () => {
  const letra = `primeiro bloco do verso
segunda linha do verso

refrao que se repete
segunda linha do refrao

terceiro bloco do verso
segunda linha do verso

refrao que se repete
segunda linha do refrao`;
  const out = pipeline(letra);
  const tags = [...out.matchAll(/^\[([^\]]+)\]$/gm)].map((m) => m[1]);
  assert.deepEqual(tags, ['Verse', 'Chorus', 'Verse', 'Chorus']);
});

test('REQUISITO 2 — context.bridge=true força [Bridge]', () => {
  const letra = `primeiro bloco do verso
segunda linha do verso

refrao que se repete
segunda linha do refrao

terceiro bloco do verso
segunda linha do verso

refrao que se repete
segunda linha do refrao`;
  const out = pipeline(letra, { bridge: true });
  const tags = [...out.matchAll(/^\[([^\]]+)\]$/gm)].map((m) => m[1]);
  assert.deepEqual(tags, ['Verse', 'Chorus', 'Bridge', 'Chorus']);
});

test('REQUISITO 3 — linhas ficam entre 6 e 9 sílabas', () => {
  const broken = breakLyricsIntoSyllableLines(LETRA_CRUA, { min: 6, max: 9 });

  // cada verso original e quebrado SOZINHO (nada de juntar versos
  // diferentes): os fragmentos preservam a soma de silabas do verso.
  const origem = blocos(LETRA_CRUA);
  const saida = blocos(broken);
  assert.equal(saida.length, origem.length);

  origem.forEach((bloco, b) => {
    const versos = bloco.split('\n').filter(Boolean);
    const linhas = saida[b].split('\n').filter(Boolean);
    let cursor = 0;

    for (const verso of versos) {
      const total = syllablesOfLine(verso);
      const partes = [];
      let acumulado = 0;
      while (cursor < linhas.length && acumulado < total) {
        const n = syllablesOfLine(linhas[cursor]);
        assert.ok(n <= 9, `linha acima de 9 silabas (${n}): "${linhas[cursor]}"`);
        partes.push(n);
        acumulado += n;
        cursor += 1;
      }
      assert.equal(acumulado, total, `a quebra preservou as silabas de "${verso}"`);
      for (let i = 0; i < partes.length - 1; i += 1) {
        assert.ok(partes[i] >= 6, `parte abaixo de 6 silabas (${partes[i]}) em "${verso}"`);
      }
    }
    assert.equal(cursor, linhas.length, 'nenhuma linha sobrou ou foi inventada');
  });
});

test('REQUISITO 2 — o pipeline preserva as seções do LLM ([Chorus], [Bridge], [Outro])', () => {
  // as tags do LLM sao a FONTE da secao: o strip do pipeline nao pode
  // apaga-las antes das cues (senao tudo vira [Verse]).
  const letra = `[Verse]
primeiro verso para abrir a rua antiga

[Chorus]
saudade de uma rua antiga que nao dorme nunca

[Bridge]
ponte do meio

[Outro]
fim da cancao`;

  const saida = pipeline(letra, {});
  const tags = blocos(saida).map((b) => b.split('\n')[0].trim());
  assert.deepEqual(tags, ['[Verse]', '[Chorus]', '[Bridge]', '[Outro]']);
});

test('REQUISITO 3 — refrão com uma palavra diferente é unificado pelo pipeline', () => {
  // o LLM às vezes repete o refrão com uma palavra trocada: o pipeline
  // unifica no primeiro refrão (já quebrado), então continua idêntico.
  const letra = `[Verse]
Primeiro verso para abrir a rua antiga
Com a luz do poste acesa

[Chorus]
Saudade de uma rua antiga, canto pra quem não tentou sair
No meu peito o tempo se foi

[Chorus]
Saudade de uma rua antiga, canto pra quem não tentou sair
No meu coração o tempo volta`;

  const saida = pipeline(letra, {});
  const choruses = blocos(saida).filter((b) => b.startsWith('[Chorus]'));
  assert.equal(choruses.length, 2);
  assert.equal(corpoDoBloco(choruses[0]), corpoDoBloco(choruses[1]));
  assert.match(corpoDoBloco(choruses[0]), /no meu peito o tempo se foi/i);
});

test('REQUISITO 3 — o refrão repetido continua idêntico depois da quebra', () => {
  const broken = breakLyricsIntoSyllableLines(LETRA_CRUA, { min: 6, max: 9 });
  const choruses = blocos(broken).filter((b) => corpoDoBloco(b) && b.includes('Se você voltar'));
  assert.equal(choruses.length, 2, 'esperava dois refrões');
  assert.equal(choruses[0], choruses[1], 'refrão repetido divergiu após a quebra');

  const final = pipeline(LETRA_CRUA);
  const tagged = blocos(final).filter((b) => b.startsWith('[Chorus]'));
  assert.equal(tagged.length, 2);
  assert.equal(tagged[0], tagged[1], 'refrão repetido divergiu após as cues');
});

test('REQUISITO 3 — a quebra roda antes das cues', () => {
  const broken = breakLyricsIntoSyllableLines(LETRA_CRUA, { min: 6, max: 9 });
  const final = pipeline(LETRA_CRUA);
  const corpoFinal = final.split('\n').filter((l) => l.trim() !== '' && !/^\s*\[/.test(l));
  const corpoBroken = broken.split('\n').filter(Boolean);
  assert.deepEqual(corpoFinal, corpoBroken, 'o corpo da letra final deve ser a letra já quebrada');
});

test('REQUISITO 4 — typo "suyo" corrigido para "suave"', () => {
  const source = fs.readFileSync(PROVIDER_PATH, 'utf8');
  assert.ok(!source.includes('suyo'), 'o typo "suyo" ainda existe no código');
  assert.ok(source.includes('nostálgico e suave'), 'a dica de mood deveria estar corrigida');
});

test('REQUISITO 2 — tags legadas do LLM viram canônicas sem número', () => {
  const letra = `[Verso 1 - sussurrando]
primeiro bloco do verso
segunda linha do verso

[Refrao]
refrao que se repete
segunda linha do refrao

[Verso 2]
terceiro bloco do verso
segunda linha do verso

[Refrao]
refrao que se repete
segunda linha do refrao`;
  const out = pipeline(letra);
  const tags = [...out.matchAll(/^\[([^\]]+)\]$/gm)].map((m) => m[1]);
  assert.deepEqual(tags, ['Verse', 'Chorus', 'Verse', 'Chorus']);
  assert.ok(!/\[(Verse|Chorus|Bridge|Outro) ?\d+\]/.test(out), 'não deve existir tag numerada');
  assert.ok(!out.includes('sussurrando'), 'hint da tag não pode sobrar');
});

test('REQUISITO 2 — canonicalTagFor mapeia os casos do projeto real', () => {
  assert.equal(canonicalTagFor('Verse 1'), 'Verse');
  assert.equal(canonicalTagFor('Verso 2'), 'Verse');
  assert.equal(canonicalTagFor('Refrao'), 'Chorus');
  assert.equal(canonicalTagFor('Ponte'), 'Bridge');
  assert.equal(canonicalTagFor('Outro'), 'Outro');
  assert.equal(canonicalTagFor('Intro'), 'Verse');
  assert.equal(canonicalTagFor('Chorus 2 - explosivo'), 'Chorus');
  assert.equal(canonicalTagFor('xyz'), '');
});

test('REQUISITO 1 — hints entre parênteses do LLM saem da letra', () => {
  const letra = `(soft vocal)
primeiro bloco do verso
segunda linha do verso

(chorus, explode)
refrao que se repete
segunda linha do refrao`;
  const out = pipeline(letra);
  assert.ok(!out.includes('('), 'a letra não pode conter parênteses');
  assert.ok(!out.includes('soft vocal'));
});

test('pipeline oficial applyLyricsPipeline = strip -> break -> cues', () => {
  const out = applyLyricsPipeline(LETRA_CRUA, { genre: 'sertanejo', mood: 'sad' });
  assert.equal(out, pipeline(LETRA_CRUA, { genre: 'sertanejo', mood: 'sad' }));
  assert.match(out, /^\[Verse\]$/m);
  assert.match(out, /^\[Chorus\]$/m);
});

test('entrada vazia / inválida não lança exceção', () => {
  assert.equal(addPerformanceCues(''), '');
  assert.equal(addPerformanceCues(null), '');
  assert.equal(addPerformanceCues(undefined), '');
  assert.equal(addPerformanceCues({}), '');
  assert.equal(breakLyricsIntoSyllableLines(''), '');
  assert.equal(breakLyricsIntoSyllableLines(null), '');
  assert.equal(typeof pipeline(LETRA_CRUA, null), 'string');
});

test('idempotência das cues e do pipeline', () => {
  const once = pipeline(LETRA_CRUA);
  assert.equal(pipeline(once), once);
  assert.equal(addPerformanceCues(once), once);
});

test('cues já existentes são preservados sem duplicação', () => {
  const comCues = '[Verse]\nlinha um\nlinha dois';
  assert.equal(addPerformanceCues(comCues), comCues);
  assert.equal((addPerformanceCues(comCues).match(/\[Verse\]/g) || []).length, 1);
});

test('stripPerformanceCues remove tags e direções', () => {
  const limpo = stripPerformanceCues('(soft vocal)\n[Verse]\nlinha um');
  assert.ok(!limpo.includes('[Verse]'));
  assert.ok(!limpo.includes('(soft vocal)'));
  assert.match(limpo, /linha um/);
});

test('hasPerformanceCues identifica tags', () => {
  assert.equal(hasPerformanceCues(LETRA_CRUA), false);
  assert.equal(hasPerformanceCues('[Chorus]\nla la la'), true);
});

test('entrada gigante é devolvida sem alteração (fail-safe)', () => {
  const enorme = 'x'.repeat(120_000);
  assert.equal(addPerformanceCues(enorme), enorme);
});

test(
  'smoke: /api/lyrics devolve letra com cues e sem parênteses',
  { skip: process.env.SMOKE !== '1' ? 'defina SMOKE=1 e rode o servidor' : false },
  async () => {
    const port = process.env.PORT || '3000';
    const response = await fetch(`http://127.0.0.1:${port}/api/lyrics`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'saudade de uma rua antiga', genre: 'sertanejo',
        style: 'sertanejo acústico, valsa lenta', mood: 'sad', vocals: 'female', language: 'pt' }),
    });
    const raw = await response.text();
    console.log(`[smoke] HTTP ${response.status}: ${raw.slice(0, 400)}`);
    assert.ok(response.ok, `esperava 2xx, veio ${response.status}`);
    let payload; try { payload = JSON.parse(raw); } catch { return; }
    const lyrics = payload?.lyrics ?? payload?.text ?? payload?.data?.lyrics;
    if (typeof lyrics !== 'string') return;
    assert.match(lyrics, /\[[^\]]+\]/, 'esperava cues de seção na letra');
    assert.ok(!lyrics.includes('('), 'a letra não pode conter parênteses');
  },
);

test('REGRESSÃO — tags consecutivas (sem linha em branco) não descolam do conteúdo', () => {
  // Letra real: tags em linhas consecutivas, sem linha vazia entre as
  // seções, e uma direção entre parênteses logo depois da primeira tag.
  const cru = `[Verse 1]
(cantando baixinho)
A luz da rua antiga ainda acesa
O tempo passa devagar e a saudade cresce
[Chorus]
Volta pra casa, meu coração
A noite te espera no fim do corredor
[Verse 2]
A luz da rua antiga ainda acesa
O tempo passa devagar e a saudade cresce
[Refrao]
Volta pra casa, meu coração
A noite te espera no fim do corredor
[Outro]
O silêncio cobre tudo outra vez`;

  const out = applyLyricsPipeline(cru, {});
  const blocos = out.split(/\n\s*\n/).filter((bloco) => bloco.trim());
  const tags = blocos.map((bloco) => bloco.split('\n')[0]);

  assert.deepEqual(tags, ['[Verse]', '[Chorus]', '[Verse]', '[Chorus]', '[Outro]']);

  // Nenhum bloco pode ficar vazio: a tag não pode se separar do conteúdo.
  for (const bloco of blocos) {
    assert.ok(
      bloco.split('\n').slice(1).some((linha) => linha.trim()),
      `bloco sem conteúdo:\n${bloco}`,
    );
  }

  // O refrão repetido continua idêntico depois da quebra.
  const coros = blocos.filter((bloco) => bloco.startsWith('[Chorus]'));
  assert.equal(coros.length, 2);
  assert.equal(coros[0], coros[1]);

  // Sem parênteses e sem tags numeradas.
  assert.ok(!/\([^)]*\)/.test(out), 'a letra não pode conter parênteses');
  assert.ok(!/\[[A-Za-z]+\s*\d+\]/.test(out), 'a letra não pode ter tag numerada');
});
