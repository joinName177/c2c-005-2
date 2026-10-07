import type { MixConfig } from './models';

export const MIX_MAX_SECONDS = 10;
export const LOOP_SEAM_SECONDS = 0.03;

/** 多声道按同一时间轴平均为单声道。 */
export function toMono(channels: Float32Array[]): Float32Array {
  if (!channels.length) return new Float32Array();
  if (channels.length === 1) return channels[0].slice();
  const length = Math.min(...channels.map((channel) => channel.length));
  const out = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i += 1) out[i] += channel[i] / channels.length;
  return out;
}

/** 线性插值重采样，保持时长不变，只改变采样率。 */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!samples.length || fromRate === toRate || fromRate <= 0 || toRate <= 0) return samples.slice();
  const length = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const ratio = fromRate / toRate;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.min(Math.floor(position), samples.length - 1);
    const next = Math.min(index + 1, samples.length - 1);
    const fraction = position - index;
    out[i] = samples[index] + (samples[next] - samples[index]) * fraction;
  }
  return out;
}

/**
 * 从 startSample 起播放背景，生成长度为 length 的时间轴。
 * 不循环时背景播完补静音；循环时在接缝处做等幅交叉淡化，避免咔哒声。
 */
export function buildLoopTrack(source: Float32Array, startSample: number, length: number, loop: boolean, seamSamples: number): Float32Array {
  const out = new Float32Array(Math.max(0, length));
  const size = source.length;
  if (!size || !out.length) return out;
  const start = ((Math.floor(startSample) % size) + size) % size;
  if (!loop) {
    for (let i = 0; i < out.length && start + i < size; i += 1) out[i] = source[start + i];
    return out;
  }
  const rotated = new Float32Array(size);
  for (let i = 0; i < size; i += 1) rotated[i] = source[(start + i) % size];
  const seam = Math.min(Math.max(0, Math.floor(seamSamples)), Math.floor(size / 2));
  if (!seam) {
    for (let i = 0; i < out.length; i += 1) out[i] = rotated[i % size];
    return out;
  }
  const period = size - seam;
  let placed = 0;
  let first = true;
  while (placed < out.length) {
    const more = placed + period < out.length;
    for (let j = 0; j < size && placed + j < out.length; j += 1) {
      const index = placed + j;
      if (!first && j < seam) out[index] += rotated[j] * (j / seam);
      else if (more && j >= size - seam) out[index] = rotated[j] * ((size - j) / seam);
      else out[index] = rotated[j];
    }
    placed += period;
    first = false;
  }
  return out;
}

/** 人声活动时背景增益降到 1-amount，停顿后在 releaseSeconds 内线性恢复。 */
export function duckingEnvelope(voice: Float32Array, sampleRate: number, amount: number, releaseSeconds: number): Float32Array {
  const gain = new Float32Array(voice.length);
  const floor = Math.max(0, 1 - amount);
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  const attackStep = 1 / Math.max(1, sampleRate * 0.02);
  const releaseStep = releaseSeconds > 0 ? 1 / (releaseSeconds * sampleRate) : 1;
  let current = 1;
  for (let start = 0; start < voice.length; start += frame) {
    const end = Math.min(voice.length, start + frame);
    let energy = 0;
    for (let i = start; i < end; i += 1) energy += voice[i] * voice[i];
    const target = Math.sqrt(energy / Math.max(1, end - start)) > 0.02 ? floor : 1;
    for (let i = start; i < end; i += 1) {
      current = target < current ? Math.max(target, current - attackStep) : Math.min(target, current + releaseStep);
      gain[i] = current;
    }
  }
  return gain;
}

/**
 * 以人声选段为母时间轴合成两路音频，长度不超过十秒。
 * 只做整体增益，从不分别截断任何一路，因此两路音量比例始终不变；
 * 峰值原样上报，由调用方决定是否需要整体降低。
 */
export function mixTracks(voice: Float32Array, background: Float32Array, config: MixConfig, sampleRate: number): { samples: Float32Array; peak: number } {
  const length = Math.max(0, Math.min(voice.length, Math.floor(MIX_MAX_SECONDS * sampleRate)));
  const backgroundTrack = buildLoopTrack(background, Math.floor(config.backgroundStart * sampleRate), length, config.loop, Math.floor(LOOP_SEAM_SECONDS * sampleRate));
  const duck = duckingEnvelope(voice, sampleRate, config.duckAmount, config.duckRelease);
  const samples = new Float32Array(length);
  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    const value = (voice[i] * config.voiceGain + backgroundTrack[i] * config.backgroundGain * duck[i]) * config.masterGain;
    samples[i] = value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  return { samples, peak };
}
