import { describe, expect, it } from 'vitest';
import { attenuationFor, buildDuckEnvelope, DEFAULT_MIX_SETTINGS, matchChannels, mixAudio, resample, scaleMix, validateMixSettings, type PcmAudio } from '../mixing-engine';

const tone = (sampleRate: number, duration: number, channels: 1 | 2 = 1, level = .5): PcmAudio => {
  const length = Math.round(sampleRate * duration);
  const make = (phase: number) => Float32Array.from({ length }, (_, i) => Math.sin(i / sampleRate * Math.PI * 2 * 220 + phase) * level);
  return { sampleRate, duration, channels: channels === 1 ? [make(0)] : [make(0), make(Math.PI / 2)] };
};

describe('validateMixSettings', () => {
  it('rejects crossfade longer than half the loop source', () => {
    expect(validateMixSettings({ ...DEFAULT_MIX_SETTINGS, loop: true, crossfade: 1 }, 1.5)).toContain('背景太短');
    expect(validateMixSettings({ ...DEFAULT_MIX_SETTINGS, loop: true, crossfade: .05 }, 1.5)).toBeUndefined();
    expect(validateMixSettings({ ...DEFAULT_MIX_SETTINGS, loop: false, crossfade: 5 }, 1.5)).toBeUndefined();
  });
});

describe('resample / channel matching', () => {
  it('resamples to the voice sample rate on one timeline', () => {
    const fast = tone(8000, 1);
    const out = resample(fast, 4000);
    expect(out.sampleRate).toBe(4000);
    expect(out.channels[0]!.length).toBe(4000);
    expect(out.duration).toBeCloseTo(1, 5);
  });
  it('up-mixes mono background to stereo and down-mixes stereo to mono', () => {
    expect(matchChannels(tone(8000, 1, 1), 2).channels.length).toBe(2);
    const stereo: PcmAudio = { sampleRate: 8000, duration: .01, channels: [new Float32Array(80).fill(.6), new Float32Array(80).fill(.2)] };
    const mono = matchChannels(stereo, 1);
    expect(mono.channels.length).toBe(1);
    expect(mono.channels[0]!.every((v) => Math.abs(v - .4) < 1e-6)).toBe(true);
  });
});

describe('mixAudio', () => {
  it('output length follows the voice selection and never exceeds ten seconds', () => {
    const voice = tone(8000, 3);
    const result = mixAudio(voice, tone(16000, 1), DEFAULT_MIX_SETTINGS);
    expect(result.duration).toBe(3);
    expect(result.channels[0]!.length).toBe(24000);
    const longVoice = tone(8000, 10);
    expect(mixAudio(longVoice, undefined, DEFAULT_MIX_SETTINGS).duration).toBe(10);
  });
  it('mixes two tracks with different sample rates and channel counts', () => {
    const voice = tone(8000, 1, 1, .2);
    const bg = tone(16000, 1, 2, .2);
    const result = mixAudio(voice, bg, DEFAULT_MIX_SETTINGS);
    expect(result.sampleRate).toBe(8000);
    expect(result.channels.length).toBe(1);
    // ducking 开启但纯正弦能量恒定，背景增益被压低，叠加仍大于单路人声
    expect(result.peak).toBeGreaterThan(.2);
  });
  it('respects per-track volume without changing the other track', () => {
    const voice = tone(8000, .5, 1, .4);
    const bg = tone(8000, .5, 1, .4);
    const silentBg = mixAudio(voice, bg, { ...DEFAULT_MIX_SETTINGS, ducking: false, bgVolume: 0 });
    const voiced = mixAudio(voice, bg, { ...DEFAULT_MIX_SETTINGS, ducking: false, voiceVolume: 0 });
    expect(silentBg.peak).toBeCloseTo(.4, 2);
    expect(voiced.peak).toBeCloseTo(.4, 2);
  });
  it('honors the background start offset on the voice timeline', () => {
    const voice: PcmAudio = { sampleRate: 1000, duration: 1, channels: [new Float32Array(1000)] };
    const bg: PcmAudio = { sampleRate: 1000, duration: .5, channels: [Float32Array.from({ length: 500 }, () => .5)] };
    const late = mixAudio(voice, bg, { ...DEFAULT_MIX_SETTINGS, loop: false, ducking: false, startOffset: .8 });
    expect(late.channels[0]!.slice(0, 799).every((v) => v === 0)).toBe(true);
    expect(late.channels[0]!.slice(900, 999).some((v) => v > 0)).toBe(true);
  });
  it('stops a non-looping background after its own length', () => {
    const voice: PcmAudio = { sampleRate: 1000, duration: 2, channels: [new Float32Array(2000)] };
    const bg: PcmAudio = { sampleRate: 1000, duration: .5, channels: [Float32Array.from({ length: 500 }, () => .5)] };
    const result = mixAudio(voice, bg, { ...DEFAULT_MIX_SETTINGS, loop: false, ducking: false });
    expect(result.channels[0]![600]).toBe(0);
  });
  it('loops with a smooth crossfade: the seam has no discontinuity', () => {
    // 素材头部 .8、尾部 -.2：硬循环时首尾接缝跳变 1.0；交叉淡化后接缝处逐样本连续
    const sr = 1000;
    const voice: PcmAudio = { sampleRate: sr, duration: 2, channels: [new Float32Array(2000)] };
    const bgData = new Float32Array(400); bgData.fill(.8); bgData.fill(-.2, 398);
    const bg: PcmAudio = { sampleRate: sr, duration: .4, channels: [bgData] };
    const hard = mixAudio(voice, bg, { ...DEFAULT_MIX_SETTINGS, crossfade: 0, ducking: false });
    const smooth = mixAudio(voice, bg, { ...DEFAULT_MIX_SETTINGS, crossfade: .1, ducking: false });
    const maxJump = (ch: Float32Array, at: number) => { let jump = 0; for (let i = at - 2; i < at + 2; i += 1) jump = Math.max(jump, Math.abs(ch[i]! - ch[i - 1]!)); return jump; };
    for (const seam of [300, 600, 900]) {
      expect(maxJump(smooth.channels[0]!, seam)).toBeLessThan(.01);
      expect(maxJump(hard.channels[0]!, 400)).toBeGreaterThan(.9);
    }
    // 循环确实覆盖到人声结束
    expect(smooth.channels[0]!.some((v, i) => i > 400 && v !== 0)).toBe(true);
  });
});

describe('ducking envelope', () => {
  it('ducks quickly on voice and recovers gradually after the pause', () => {
    const sr = 1000;
    const samples = new Float32Array(sr * 2); samples.fill(.5, 0, 300);
    const gain = buildDuckEnvelope(samples, sr, { ...DEFAULT_MIX_SETTINGS, duckDepth: .2, attack: .02, release: .4 });
    expect(gain[100]).toBeLessThan(.3); // 说话中已压低
    expect(gain[350]).toBeLessThan(.9); // 停顿后仍在恢复，不是瞬间弹回
    expect(gain[500]).toBeGreaterThan(gain[350]!); // 恢复是渐进的
    expect(gain[1900]).toBeCloseTo(1, 2); // 停顿足够久后恢复满
  });
  it('is flat when ducking is disabled', () => {
    const gain = buildDuckEnvelope(Float32Array.from({ length: 100 }, () => .5), 1000, { ...DEFAULT_MIX_SETTINGS, ducking: false });
    expect(gain.every((g) => g === 1)).toBe(true);
  });
});

describe('clipping handling', () => {
  it('flags peaks above the safe limit', () => {
    const voice: PcmAudio = { sampleRate: 1000, duration: .1, channels: [Float32Array.from({ length: 100 }, () => 1.2)] };
    const result = mixAudio(voice, undefined, DEFAULT_MIX_SETTINGS);
    expect(result.clipping).toBe(true);
    expect(attenuationFor(result.peak)).toBeCloseTo(.98 / 1.2, 5);
  });
  it('scales the whole mix with one factor instead of clipping tracks separately', () => {
    const voice: PcmAudio = { sampleRate: 1000, duration: .1, channels: [Float32Array.from({ length: 100 }, (_, i) => i % 2 ? .4 : .8)] };
    const result = mixAudio(voice, undefined, DEFAULT_MIX_SETTINGS);
    const scaled = scaleMix(result, .5);
    // 两路（此处即各采样间）比例保持不变
    expect(scaled.channels[0]![1] / scaled.channels[0]![0]).toBeCloseTo(result.channels[0]![1] / result.channels[0]![0], 5);
    expect(scaled.peak).toBeCloseTo(result.peak * .5, 5);
    expect(scaled.clipping).toBe(false);
  });
});
