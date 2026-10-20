/**
 * Codificacao MP3 (lamejs). Converte Float32 stereo em Buffer MP3.
 * Se a dependencia nao estiver disponivel, o caller cai para WAV.
 */

let lamejs = null;
try {
  const mod = await import('@breezystack/lamejs');
  lamejs = mod.default || mod;
} catch {
  lamejs = null;
}

export function mp3Available() {
  return Boolean(lamejs);
}

export function encodeMp3(channels, sampleRate, kbps = 160) {
  if (!lamejs) throw new Error('lamejs indisponivel');
  const numChannels = channels.length;
  const numFrames = channels[0].length;
  const encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, kbps);

  const left = toInt16(channels[0]);
  const right = numChannels > 1 ? toInt16(channels[1]) : null;

  const chunks = [];
  const blockSize = 1152;
  for (let i = 0; i < numFrames; i += blockSize) {
    const end = Math.min(numFrames, i + blockSize);
    const l = left.subarray(i, end);
    const r = right ? right.subarray(i, end) : null;
    const buf = r ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l);
    if (buf.length) chunks.push(Buffer.from(buf));
  }
  const flushed = encoder.flush();
  if (flushed.length) chunks.push(Buffer.from(flushed));
  return Buffer.concat(chunks);
}

function toInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = Math.round(s * 32767);
  }
  return out;
}
