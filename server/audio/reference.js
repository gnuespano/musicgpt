/**
 * Audio de referencia (Audio-to-Audio / Style Transfer).
 *
 * O arquivo anexado pelo usuario vira base64 e entra no pedido do ACE-Step
 * como bloco `input_audio` (mensagem multimodal). A API oficial do ACE-Step
 * (https://ace-step.github.io/ACE-Step-1.5/en/API) aceita:
 *
 *   {
 *     "messages": [{
 *       "role": "user",
 *       "content": [
 *         { "type": "text", "text": "<prompt>...</prompt>" },
 *         { "type": "input_audio",
 *           "input_audio": { "data": "<base64>", "format": "mp3" } }
 *       ]
 *     }],
 *     "task_type": "text2music",
 *     "audio_cover_strength": 0.3
 *   }
 *
 * Com `task_type: text2music` o audio enviado vira a REFERENCIA de estilo
 * (timbre, instrumentacao, producao) e `audio_cover_strength` define o
 * quanto ela pesa na geracao (a documentacao recomenda ~0.2 para
 * transferencia de estilo; valores altos deixam a faixa colada no original).
 */

/** Extensao -> formato usado no bloco `input_audio`. */
const FORMAT_BY_EXT = {
  mp3: 'mp3',
  wav: 'wav',
  wave: 'wav',
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'ogg',
  m4a: 'm4a',
  mp4: 'm4a',
  aac: 'aac',
  flac: 'flac',
  webm: 'webm',
  aiff: 'aiff',
  aif: 'aiff',
};

/** MIME type -> formato usado no bloco `input_audio`. */
const FORMAT_BY_MIME = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/webm': 'webm',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
};

/**
 * Descobre o formato do audio pelo MIME type e, como reserva, pela extensao
 * do arquivo (alguns navegadores mandam `application/octet-stream`).
 */
export function detectAudioFormat(filename = '', mimetype = '') {
  const mime = String(mimetype || '').split(';')[0].trim().toLowerCase();
  if (FORMAT_BY_MIME[mime]) return FORMAT_BY_MIME[mime];

  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  if (FORMAT_BY_EXT[ext]) return FORMAT_BY_EXT[ext];

  return 'mp3';
}

/**
 * Monta o payload de referencia a partir do arquivo recebido pelo multer.
 *
 * @param {object|null} file  arquivo do multer (memoryStorage)
 * @returns {object|null} { name, mimetype, size, format, base64 }
 */
export function buildReferencePayload(file) {
  if (!file || !file.buffer || !file.buffer.length) return null;
  return {
    name: file.originalname || 'referencia',
    mimetype: file.mimetype || '',
    size: file.buffer.length,
    format: detectAudioFormat(file.originalname, file.mimetype),
    base64: file.buffer.toString('base64'),
  };
}

/**
 * Resumo publico do audio de referencia (sem o audio em base64), usado nos
 * metadados da faixa para a UI mostrar de onde veio o estilo.
 */
export function referenceSummary(reference) {
  if (!reference) return null;
  return {
    name: reference.name,
    format: reference.format,
    size: reference.size,
  };
}
