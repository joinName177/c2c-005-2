import { describe, expect, it } from 'vitest';
import { DEFAULT_MIX_SETTINGS } from '../../core/mixing-engine';
import { WebAudioMixerAdapter } from '../web-audio-mixer.adapter';
import type { DecodedAudio } from '../web-audio-cropper.adapter';

const pcm = (sampleRate: number, duration: number, channels: 1 | 2 = 1, level = .4): DecodedAudio => ({
  sampleRate, duration,
  channels: Array.from({ length: channels }, (_, ch) => Float32Array.from({ length: Math.round(sampleRate * duration) }, (_, i) => Math.sin(i / 3) * level + ch * .01)),
});

describe('WebAudioMixerAdapter', () => {
  it('inspects background metadata without changing voice state', async () => {
    const adapter = new WebAudioMixerAdapter({ decode: async () => pcm(22050, 3, 2) });
    await expect(adapter.inspectBackground(new Blob())).resolves.toEqual({ duration: 3, sampleRate: 22050, channels: 2 });
  });
  it('renders on the voice timeline even when rates and channels differ', async () => {
    const adapter = new WebAudioMixerAdapter({ decode: async (blob) => blob === voiceBlob ? pcm(8000, 2, 1) : pcm(48000, 5, 2) });
    const voiceBlob = new Blob(['voice']);
    const rendered = await adapter.render(voiceBlob, new Blob(['bg']), { ...DEFAULT_MIX_SETTINGS, loop: true });
    expect(rendered.duration).toBe(2);
    expect(rendered.blob.type).toBe('audio/wav');
  });
  it('reports clipping risk in preview and removes it with overall attenuation', async () => {
    const adapter = new WebAudioMixerAdapter({ decode: async () => pcm(8000, 1, 1, .9) });
    const blob = new Blob(['x']);
    const probe = await adapter.preview(blob, blob, { ...DEFAULT_MIX_SETTINGS, ducking: false, voiceVolume: 1, bgVolume: 1 });
    expect(probe.clipping).toBe(true);
    const safe = await adapter.render(blob, blob, { ...DEFAULT_MIX_SETTINGS, ducking: false, voiceVolume: 1, bgVolume: 1 }, attenuation(1.8));
    expect(safe.clipping).toBe(false);
  });
  it('caps output duration at ten seconds', async () => {
    const adapter = new WebAudioMixerAdapter({ decode: async (blob) => blob === voiceBlob ? pcm(8000, 12, 1) : pcm(8000, 2, 1) });
    const voiceBlob = new Blob(['v']);
    const result = await adapter.render(voiceBlob, new Blob(['b']), DEFAULT_MIX_SETTINGS);
    expect(result.duration).toBeLessThanOrEqual(10);
  });
  it('supports voice-only export when no background is provided', async () => {
    const adapter = new WebAudioMixerAdapter({ decode: async () => pcm(8000, 1) });
    const result = await adapter.render(new Blob(['v']), undefined, DEFAULT_MIX_SETTINGS);
    expect(result.duration).toBe(1);
    expect(result.blob.type).toBe('audio/wav');
  });
});

function attenuation(peak: number) { return .98 / peak; }
