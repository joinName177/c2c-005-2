import { attenuationFor, mixAudio, scaleMix, validateMixSettings, type MixSettings, type PcmAudio } from '../core/mixing-engine';
import type { AudioMixerPort, MixedAudio } from '../ports/audio-mixer.port';
import type { DecodedAudio } from './web-audio-cropper.adapter';

interface Dependencies { decode(blob: Blob): Promise<DecodedAudio> }
async function browserDecode(blob: Blob): Promise<DecodedAudio> {
  const context = new AudioContext();
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  const result = { sampleRate: buffer.sampleRate, duration: buffer.duration, channels: Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index).slice()) };
  await context.close();
  return result;
}
function encodeWav(audio: PcmAudio): Blob {
  const length = audio.channels[0]?.length ?? 0;
  const channelCount = audio.channels.length;
  const buffer = new ArrayBuffer(44 + length * channelCount * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + length * channelCount * 2, true); write(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channelCount, true); view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * channelCount * 2, true); view.setUint16(32, channelCount * 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, length * channelCount * 2, true);
  let offset = 44;
  for (let i = 0; i < length; i += 1) for (const channel of audio.channels) { const value = Math.max(-1, Math.min(1, channel[i] ?? 0)); view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true); offset += 2; }
  return new Blob([buffer], { type: 'audio/wav' });
}

export class WebAudioMixerAdapter implements AudioMixerPort {
  constructor(private readonly deps: Dependencies = { decode: browserDecode }) {}

  async inspectBackground(blob: Blob) {
    const audio = await this.deps.decode(blob);
    return { duration: audio.duration, sampleRate: audio.sampleRate, channels: audio.channels.length };
  }

  private async compute(voiceBlob: Blob, backgroundBlob: Blob | undefined, settings: MixSettings) {
    const voice = await this.deps.decode(voiceBlob);
    const background = backgroundBlob ? await this.deps.decode(backgroundBlob) : undefined;
    if (background) {
      const error = validateMixSettings(settings, background.duration);
      if (error) throw new Error(error);
    }
    // 成品以人声选段长度为准；人声选段已被裁剪端口限制在十秒内，这里再次钳制
    const duration = Math.min(voice.duration, 10);
    const voicePcm: PcmAudio = { sampleRate: voice.sampleRate, duration, channels: voice.channels.map((c) => c.slice(0, Math.round(duration * voice.sampleRate))) };
    return mixAudio(voicePcm, background, settings);
  }

  async preview(voice: Blob, background: Blob, settings: MixSettings) {
    const result = await this.compute(voice, background, settings);
    return { peak: result.peak, clipping: result.clipping, duration: result.duration };
  }

  async render(voice: Blob, background: Blob | undefined, settings: MixSettings, attenuation = 1): Promise<MixedAudio> {
    const result = scaleMix(await this.compute(voice, background, settings), attenuation);
    const pcm: PcmAudio = { sampleRate: result.sampleRate, duration: result.duration, channels: result.channels };
    return { blob: encodeWav(pcm), duration: result.duration, peak: result.peak, clipping: attenuationFor(result.peak) < 1 };
  }
}
