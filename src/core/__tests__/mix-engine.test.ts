import { describe, expect, it } from 'vitest';
import { buildLoopTrack, duckingEnvelope, mixTracks, resampleLinear, toMono } from '../mix-engine';
import { DEFAULT_MIX_CONFIG } from '../models';

describe('toMono', () => {
  it('averages multiple channels onto one timeline', () => {
    const mono = toMono([Float32Array.from([1, -1, 0.5]), Float32Array.from([0.5, 0.5, -0.5])]);
    expect(Array.from(mono)).toEqual([0.75, -0.25, 0]);
  });
});

describe('resampleLinear', () => {
  it('keeps the same duration when sample rates differ', () => {
    const source = Float32Array.from({ length: 10 }, (_, index) => index / 10); // 10 个采样 @10Hz = 1 秒
    const up = resampleLinear(source, 10, 20);
    expect(up.length).toBe(20); // 仍然是 1 秒
    expect(up[0]).toBe(0);
    expect(up[up.length - 1]).toBeCloseTo(0.9, 5);
    const down = resampleLinear(source, 10, 5);
    expect(down.length).toBe(5);
  });
});

describe('buildLoopTrack', () => {
  it('pads silence when looping is off and the background is shorter than the voice', () => {
    expect(Array.from(buildLoopTrack(Float32Array.from([1, 1, 1]), 0, 5, false, 0))).toEqual([1, 1, 1, 0, 0]);
  });
  it('starts from the chosen offset and wraps when looping', () => {
    const out = buildLoopTrack(Float32Array.from([0.2, 0.4, 0.6, 0.8]), 1, 8, true, 0);
    [0.4, 0.6, 0.8, 0.2, 0.4, 0.6, 0.8, 0.2].forEach((expected, index) => expect(out[index]).toBeCloseTo(expected, 5));
  });
  it('keeps a constant signal constant across the loop seam', () => {
    const out = buildLoopTrack(Float32Array.from([1, 1, 1, 1]), 0, 10, true, 2);
    for (const value of out) expect(value).toBeCloseTo(1, 5);
  });
  it('crossfades the seam instead of jumping from tail to head', () => {
    const ramp = Float32Array.from({ length: 100 }, (_, index) => index / 100);
    const out = buildLoopTrack(ramp, 0, 100, true, 10);
    for (let i = 90; i < 100; i += 1) expect(out[i]).toBeGreaterThan(0);
    for (let i = 91; i < 100; i += 1) expect(Math.abs(out[i] - out[i - 1])).toBeLessThan(0.2);
  });
});

describe('duckingEnvelope', () => {
  it('lowers the background while the voice is active and recovers after the pause', () => {
    const rate = 100;
    const voice = new Float32Array(250);
    voice.fill(0.5, 50, 150); // 0.5s 静音 → 1s 人声 → 1s 停顿
    const gain = duckingEnvelope(voice, rate, 0.8, 0.5);
    expect(gain[10]).toBeCloseTo(1, 1); // 人声出现前不压低
    expect(gain[140]).toBeLessThan(0.3); // 人声期间压到 1-0.8=0.2 附近
    expect(gain[160]).toBeGreaterThan(0.3); // 停顿后开始恢复
    expect(gain[249]).toBeCloseTo(1, 1); // 0.5s 恢复期内回到满音量
  });
});

describe('mixTracks', () => {
  it('uses the voice selection as the master length and caps at ten seconds', () => {
    const long = mixTracks(new Float32Array(150).fill(0.1), new Float32Array(50).fill(0.1), { ...DEFAULT_MIX_CONFIG }, 10);
    expect(long.samples.length).toBe(100); // 15s 人声截到 10s
    const short = mixTracks(new Float32Array(30).fill(0.1), new Float32Array(50).fill(0.1), { ...DEFAULT_MIX_CONFIG }, 10);
    expect(short.samples.length).toBe(30); // 以人声选段长度为准
  });
  it('reports the peak without truncating either channel', () => {
    const config = { ...DEFAULT_MIX_CONFIG, duckAmount: 0 };
    const hot = mixTracks(new Float32Array(20).fill(0.8), new Float32Array(20).fill(0.8), config, 10);
    expect(hot.peak).toBeCloseTo(1.44, 5); // 0.8*1 + 0.8*0.8，原样保留不截断
    expect(Math.max(...hot.samples)).toBeCloseTo(1.44, 5);
  });
  it('masterGain scales the whole mix uniformly so the channel ratio never changes', () => {
    const config = { ...DEFAULT_MIX_CONFIG, duckAmount: 0 };
    const voice = new Float32Array(20).fill(0.8);
    const background = new Float32Array(20).fill(0.8);
    const full = mixTracks(voice, background, config, 10);
    const tamed = mixTracks(voice, background, { ...config, masterGain: 0.5 }, 10);
    expect(tamed.peak).toBeCloseTo(full.peak / 2, 5);
    for (let i = 0; i < 20; i += 1) expect(tamed.samples[i] / full.samples[i]).toBeCloseTo(0.5, 5);
  });
});
