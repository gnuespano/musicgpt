#!/usr/bin/env node
/**
 * Testes do gerador de estilos sofisticados (varinha magica).
 *
 * Garante que a varinha produza um prompt de PRODUCAO (4 frases em ingles,
 * com instrumentacao, vocal, tema e ficha de producao) e que nunca repita
 * o estilo anterior.
 *
 * Uso: node scripts/testar-estilo-sophisticated.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSophisticatedStyle, isSophisticatedStyle } from '../server/providers/style.js';

const contarPalavras = (t) => t.split(/\s+/).filter(Boolean).length;

test('o estilo tem 4 frases (ancora, vocal, tema, producao)', () => {
  const estilo = buildSophisticatedStyle({ genre: 'sertanejo' });
  const frases = estilo.split('.').map((f) => f.trim()).filter(Boolean);
  assert.equal(frases.length, 4, `frases=${frases.length}: ${estilo}`);
});

test('o estilo segue a estrutura do exemplo pedido', () => {
  const estilo = buildSophisticatedStyle({ genre: 'sertanejo', mood: 'melancolico', vocals: 'nasal' });
  // 1) ancora + groove + instrumentacao + percussao + textura
  assert.match(estilo, /with .*(groove|beat|pocket|pulse|flow|drift|tempo).*,.*,.*, and /i, estilo);
  // 2) vocal: sujeito + timbre + entrega + arco dinamico
  assert.match(estilo, /(Male|Female|Androgynous) vocalist with .* voice, .* delivery with /i, estilo);
  // 3) tema + virada de atitude + clima
  assert.match(estilo, /Theme of .+, .+ and .+/i, estilo);
  // 4) gancho + refrão + producao + energia
  const ultima = estilo.split('.').map((f) => f.trim()).filter(Boolean).pop();
  assert.match(ultima, /(hook|top line)/i, ultima);
  assert.match(ultima, /chorus/i, ultima);
  assert.match(ultima, /(production|mix)/i, ultima);
  assert.ok(ultima.split(',').length >= 4, `energia/ficha: ${ultima}`);
});

test('o estilo e texto de uma linha, em ingles, com 40+ palavras', () => {
  const estilo = buildSophisticatedStyle({ genre: 'mpb' });
  assert.ok(!estilo.includes('\n'), 'nao pode ter quebra de linha');
  assert.ok(contarPalavras(estilo) >= 40, `palavras=${contarPalavras(estilo)}`);
  assert.ok(/[a-z]/i.test(estilo), estilo);
});

test('o genero escolhido ancora o estilo', () => {
  const sertanejo = buildSophisticatedStyle({ genre: 'sertanejo' });
  assert.match(sertanejo, /sertanejo|country-pop/i, sertanejo);
  const trap = buildSophisticatedStyle({ genre: 'trap' });
  assert.match(trap, /trap/i, trap);
});

test('o clima e o timbre da voz mudam o texto', () => {
  const triste = buildSophisticatedStyle({ genre: 'sertanejo', mood: 'triste', seed: 7 });
  const alegre = buildSophisticatedStyle({ genre: 'sertanejo', mood: 'animado', seed: 7 });
  assert.notEqual(triste, alegre, 'clima diferente devia mudar o estilo');
  const smoky = buildSophisticatedStyle({ genre: 'jazz', vocals: 'smoky', seed: 7 });
  assert.match(smoky, /smoky, husky/i, smoky);
});

test('cliques seguidos nunca repetem o estilo', () => {
  const vistos = new Set();
  for (let i = 0; i < 12; i++) {
    const estilo = buildSophisticatedStyle({ genre: 'sertanejo', mood: 'melancolico' });
    assert.ok(!vistos.has(estilo), `repetiu no click ${i + 1}: ${estilo}`);
    vistos.add(estilo);
  }
  assert.ok(vistos.size >= 10, `variacoes=${vistos.size}`);
});

test('a mesma semente devolve o mesmo estilo (testes deterministicos)', () => {
  const a = buildSophisticatedStyle({ genre: 'trap', seed: 42 });
  const b = buildSophisticatedStyle({ genre: 'trap', seed: 42 });
  assert.equal(a, b);
});

test('o controle de qualidade aceita o estilo gerado e rejeita o simples', () => {
  assert.ok(isSophisticatedStyle(buildSophisticatedStyle({ genre: 'pop' })));
  assert.ok(!isSophisticatedStyle('Rock alternativo dos anos 90 com guitarra distorcida e bateria seca'));
  assert.ok(!isSophisticatedStyle('MPB melancólica com violão, pandeiro e saxofone ao fundo'));
  assert.ok(!isSophisticatedStyle(''));
});
