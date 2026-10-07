/** 16-bit PCM WAV 编码，裁剪与混音共用。 */
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const length = channels[0]?.length ?? 0;
  const buffer = new ArrayBuffer(44 + length * channels.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + length * channels.length * 2, true); write(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels.length, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels.length * 2, true); view.setUint16(32, channels.length * 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, length * channels.length * 2, true);
  let offset = 44;
  for (let i = 0; i < length; i += 1) for (const channel of channels) { const value = Math.max(-1, Math.min(1, channel[i] ?? 0)); view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true); offset += 2; }
  return new Blob([buffer], { type: 'audio/wav' });
}
