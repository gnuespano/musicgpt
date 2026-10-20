/**
 * Worker de renderizacao: roda o motor de sintese fora do thread principal
 * para o servidor HTTP continuar respondendo durante a geracao.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { renderSong } from './render.js';
import { encodeWav } from './wav.js';
import { computePeaks } from '../store.js';

const { options } = workerData;

try {
  const rendered = await renderSong(options, (progress) => {
    parentPort.postMessage({ type: 'progress', ...progress });
  });
  const buffer = encodeWav(rendered.channels, rendered.sampleRate);
  const peaks = computePeaks(rendered.channels);
  parentPort.postMessage(
    { type: 'done', buffer: buffer.buffer, meta: rendered.meta, peaks },
    [buffer.buffer],
  );
} catch (error) {
  parentPort.postMessage({ type: 'error', message: error?.message || String(error) });
}
