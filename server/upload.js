/**
 * Recebimento de uploads (audio de referencia).
 *
 * A rota /api/generate aceita dois formatos:
 *   - application/json          -> fluxo normal (sem audio de referencia);
 *   - multipart/form-data       -> quando o usuario anexa um audio de
 *                                  referencia (Audio-to-Audio / Style Transfer).
 *
 * O arquivo e lido em memoria (memoryStorage): nao ha necessidade de
 * gravá-lo no disco, ele vira base64 e entra no corpo da requisicao
 * enviada ao ACE-Step (bloco `input_audio`).
 */

import multer from 'multer';

/** Campo multipart usado pelo front-end para o audio de referencia. */
export const REFERENCE_FIELD = 'referenceAudio';

/** Tamanho maximo aceito para o audio de referencia (15 MB). */
export const MAX_REFERENCE_BYTES = Number(
  process.env.MUSICGPT_MAX_REFERENCE_BYTES || 15 * 1024 * 1024,
);

const AUDIO_MIME = /^audio\//i;
const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|opus|m4a|mp4|aac|flac|webm|aiff|aif|weba)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_REFERENCE_BYTES,
    files: 1,
    fields: 60,
    fieldSize: 1024 * 1024,
  },
  fileFilter(_req, file, cb) {
    const nome = file.originalname || '';
    if (AUDIO_MIME.test(file.mimetype || '') || AUDIO_EXT.test(nome)) return cb(null, true);
    cb(new Error('Formato nao suportado: envie um arquivo de audio (mp3, wav, ogg, m4a, flac).'));
  },
});

/** Traduz o erro do multer para uma mensagem utilizavel pelo usuario. */
export function describeUploadError(err) {
  if (!err) return 'Falha ao ler o arquivo enviado.';
  if (err.code === 'LIMIT_FILE_SIZE') {
    const mb = Math.round(MAX_REFERENCE_BYTES / (1024 * 1024));
    return `Audio de referencia muito grande (max ${mb} MB).`;
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return `Campo de upload invalido: use "${REFERENCE_FIELD}".`;
  }
  return err.message || 'Falha ao ler o arquivo enviado.';
}

/**
 * Le o corpo multipart da requisicao.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<{fields: object, file: object|null}>}
 *   `fields` traz os campos de texto (sempre string) e `file` o audio
 *   de referencia (ou null quando nada foi anexado).
 */
export function readMultipart(req, res) {
  return new Promise((resolve, reject) => {
    upload.single(REFERENCE_FIELD)(req, res, (err) => {
      if (err) return reject(err);
      return resolve({ fields: req.body || {}, file: req.file || null });
    });
  });
}

/** A requisicao vem em multipart/form-data? */
export function isMultipart(req) {
  return String(req.headers?.['content-type'] || '').toLowerCase().startsWith('multipart/form-data');
}
