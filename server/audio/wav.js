/** Codificacao WAV (PCM 16 bits) a partir de buffers Float32 stereo. */

export function encodeWav(channels, sampleRate) {
  const numChannels = channels.length;
  const numFrames = channels[0].length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numFrames; i += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      buffer.writeInt16LE(Math.round(s * 32767), offset);
      offset += 2;
    }
  }
  return buffer;
}

/** Decodifica WAV PCM 16 bits mono/stereo -> { channels, sampleRate }. */
export function decodeWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Arquivo nao e um WAV valido');
  const numChannels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bits = buffer.readUInt16LE(34);
  if (bits !== 16) throw new Error('Apenas WAV PCM 16 bits e suportado');
  let offset = 12;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      dataOffset = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error('Bloco de dados WAV nao encontrado');
  const frames = Math.floor(dataSize / (numChannels * 2));
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frames));
  let p = dataOffset;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      channels[c][i] = buffer.readInt16LE(p) / 32768;
      p += 2;
    }
  }
  return { channels, sampleRate };
}
