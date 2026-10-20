/** Utilidades para audios remotos: download e estimativas de duracao. */

export async function downloadBuffer(url, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Download falhou (${res.status}) para ${url}`);
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } finally {
    clearTimeout(timer);
  }
}

const BITRATES_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES = [44100, 48000, 32000, 0];

/**
 * Estima a duracao de um MP3 percorrendo os frames.
 * Retorna null quando nao e possivel determinar.
 */
export function mp3Duration(buffer) {
  let offset = 0;
  // pula ID3v2
  if (buffer.length > 10 && buffer.toString('ascii', 0, 3) === 'ID3') {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    offset = 10 + size;
  }
  let samples = 0;
  let rate = 0;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }
    const versionBits = (buffer[offset + 1] >> 3) & 0x03;
    const layerBits = (buffer[offset + 1] >> 1) & 0x03;
    const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
    const rateIndex = (buffer[offset + 2] >> 2) & 0x03;
    const padding = (buffer[offset + 2] >> 1) & 0x01;
    const channelMode = (buffer[offset + 3] >> 6) & 0x03;
    if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      offset += 1;
      continue;
    }
    const mpeg1 = versionBits === 3;
    const table = mpeg1 ? BITRATES_V1L3 : BITRATES_V2;
    const bitrate = table[bitrateIndex] * 1000;
    const sampleRate = RATES[rateIndex] / (versionBits === 2 ? 2 : 1);
    if (!bitrate || !sampleRate) {
      offset += 1;
      continue;
    }
    const samplesPerFrame = mpeg1 ? (layerBits === 3 ? 1152 : 384) : (layerBits === 3 ? 576 : 384);
    const channels = channelMode === 3 ? 1 : 2;
    const frameLen = Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;
    samples += samplesPerFrame;
    rate = sampleRate;
    offset += frameLen;
  }
  if (!rate || !samples) return null;
  return samples / rate;
}

/** Extrai a duracao de um WAV (usa o bloco de dados). */
export function wavDuration(buffer) {
  if (buffer.length < 44) return null;
  const sampleRate = buffer.readUInt32LE(24);
  const channels = buffer.readUInt16LE(22);
  const bits = buffer.readUInt16LE(34);
  let offset = 12;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  const bytesPerFrame = (bits / 8) * channels;
  return bytesPerFrame ? dataSize / bytesPerFrame / sampleRate : null;
}
