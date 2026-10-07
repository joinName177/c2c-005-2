import { mixTracks, resampleLinear, toMono } from '../core/mix-engine';
import type { MixConfig } from '../core/models';
import type { AudioMixerPort, MixResult } from '../ports/audio-mixer.port';
import { encodeWav } from './wav-encoder';
import type { DecodedAudio } from './web-audio-cropper.adapter';

interface Dependencies { decode(blob: Blob): Promise<DecodedAudio> }
async function browserDecode(blob: Blob): Promise<DecodedAudio> {
  const context = new AudioContext();
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  const result = { sampleRate: buffer.sampleRate, duration: buffer.duration, channels: Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index).slice()) };
  await context.close();
  return result;
}
export class WebAudioMixerAdapter implements AudioMixerPort {
  constructor(private readonly deps: Dependencies = { decode: browserDecode }) {}
  async inspect(blob: Blob) { const audio = await this.deps.decode(blob); return { duration: audio.duration }; }
  async mix(voiceBlob: Blob, backgroundBlob: Blob, config: MixConfig): Promise<MixResult> {
    const [voice, background] = await Promise.all([this.deps.decode(voiceBlob), this.deps.decode(backgroundBlob)]);
    const sampleRate = voice.sampleRate;
    const voiceMono = toMono(voice.channels);
    const backgroundMono = background.sampleRate === sampleRate ? toMono(background.channels) : resampleLinear(toMono(background.channels), background.sampleRate, sampleRate);
    const { samples, peak } = mixTracks(voiceMono, backgroundMono, config, sampleRate);
    return { blob: encodeWav([samples], sampleRate), duration: sampleRate ? samples.length / sampleRate : 0, peak };
  }
}
