import { describe, expect, it } from 'vitest';
import { WebAudioMixerAdapter } from '../web-audio-mixer.adapter';
import type { DecodedAudio } from '../web-audio-cropper.adapter';
import { DEFAULT_MIX_CONFIG, type MixConfig } from '../../core/models';

const decoded = (sampleRate: number, seconds: number, channels: number, value = 0.4): DecodedAudio => ({ sampleRate, duration: seconds, channels: Array.from({ length: channels }, () => new Float32Array(Math.round(sampleRate * seconds)).fill(value)) });
const config: MixConfig = { ...DEFAULT_MIX_CONFIG, duckAmount: 0 };

describe('WebAudioMixerAdapter', () => {
  it('mixes different sample rates and channel counts on one timeline', async () => {
    const voice = new Blob(['voice']); const background = new Blob(['bg']);
    const adapter = new WebAudioMixerAdapter({ decode: async (blob) => (blob === voice ? decoded(10, 2, 2) : decoded(20, 1, 1)) });
    const result = await adapter.mix(voice, background, config);
    expect(result.duration).toBe(2); // 以人声选段长度为准
    expect(result.blob.type).toBe('audio/wav');
    expect(Number.isFinite(result.peak)).toBe(true);
    expect(result.peak).toBeGreaterThan(0);
  });
  it('surfaces the clipping peak instead of truncating hot channels', async () => {
    const adapter = new WebAudioMixerAdapter({ decode: async () => decoded(10, 1, 1, 0.9) });
    const result = await adapter.mix(new Blob(), new Blob(), config);
    expect(result.peak).toBeGreaterThan(1);
  });
  it('rejects when decoding fails so the caller can keep the last valid mix', async () => {
    const adapter = new WebAudioMixerAdapter({ decode: async () => { throw new Error('decode failed'); } });
    await expect(adapter.inspect(new Blob())).rejects.toThrow('decode failed');
    await expect(adapter.mix(new Blob(), new Blob(), config)).rejects.toThrow('decode failed');
  });
});
