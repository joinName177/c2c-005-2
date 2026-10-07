// 人声 + 背景声混音核心：全部为纯函数，便于在浏览器外测试。
// 时间单位统一为秒，采样以 PCM Float32（-1..1）表达。

export interface PcmAudio { sampleRate: number; duration: number; channels: Float32Array[] }
export interface MixSettings {
  /** 背景在人声时间轴上的起播位置（秒，0 表示与人声开头对齐） */
  startOffset: number;
  /** 背景是否循环 */
  loop: boolean;
  /** 人声音量 0..2 */
  voiceVolume: number;
  /** 背景音量 0..2 */
  bgVolume: number;
  /** 有人声时背景自动降低 */
  ducking: boolean;
  /** 自动降低时背景保持的比例 0..1（如 0.25 = 压到 25%） */
  duckDepth: number;
  /** 判定人声的电平阈值（线性幅度） */
  duckThreshold: number;
  /** 检测到人声后压下的起控时间（秒） */
  attack: number;
  /** 人声停顿后背景恢复的时间（秒） */
  release: number;
  /** 循环接缝交叉淡化时长（秒） */
  crossfade: number;
}
export interface MixResult { channels: Float32Array[]; peak: number; clipping: boolean; duration: number; sampleRate: number }

export const DEFAULT_MIX_SETTINGS: MixSettings = {
  startOffset: 0, loop: true, voiceVolume: 1, bgVolume: 1,
  ducking: true, duckDepth: .25, duckThreshold: .02, attack: .04, release: .6, crossfade: .08,
};
/** 成品时长硬上限：人声选段长度，且不超过十秒 */
export const MAX_MIX_DURATION = 10;
/** 仅提示削波风险的阈值，给 16bit 编码留点余量 */
const CLIP_WARN = .98;

export function validateMixSettings(settings: MixSettings, bgDuration: number): string | undefined {
  if (!(settings.voiceVolume >= 0 && Number.isFinite(settings.voiceVolume))) return '人声音量无效';
  if (!(settings.bgVolume >= 0 && Number.isFinite(settings.bgVolume))) return '背景音量无效';
  if (settings.loop && bgDuration > 0 && settings.crossfade * 2 >= bgDuration) return '背景太短，无法平滑循环';
  if (settings.duckDepth < 0 || settings.duckDepth > 1) return '背景压低比例无效';
  if (settings.attack < 0 || settings.release < 0) return '压低/恢复时长无效';
  return undefined;
}

/** 线性插值重采样到目标采样率 */
export function resample(audio: PcmAudio, targetRate: number): PcmAudio {
  if (audio.sampleRate === targetRate || audio.channels.length === 0) return audio;
  const ratio = audio.sampleRate / targetRate;
  const length = Math.round(audio.duration * targetRate);
  const channels = audio.channels.map((source) => {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      const position = i * ratio;
      const index = Math.floor(position);
      const fraction = position - index;
      const a = source[index] ?? 0;
      const b = source[index + 1] ?? a;
      out[i] = a + (b - a) * fraction;
    }
    return out;
  });
  return { sampleRate: targetRate, duration: audio.duration, channels };
}

/** 声道上混/下混到目标声道数（单声道↔立体声） */
export function matchChannels(audio: PcmAudio, target: number): PcmAudio {
  const count = Math.max(1, Math.min(2, target));
  if (audio.channels.length === count) return audio;
  if (audio.channels.length === 1 && count === 2) {
    const mono = audio.channels[0] as Float32Array;
    return { ...audio, channels: [mono.slice(), mono.slice()] };
  }
  if (audio.channels.length >= 2 && count === 1) {
    const [left, right] = audio.channels;
    const mono = new Float32Array(Math.max(left.length, right.length));
    for (let i = 0; i < mono.length; i += 1) mono[i] = ((left[i] ?? 0) + (right[i] ?? 0)) / 2;
    return { ...audio, channels: [mono] };
  }
  const length = Math.max(...audio.channels.map((c) => c.length));
  const channels = Array.from({ length: count }, (_, ch) => audio.channels[ch]?.slice(0, length) ?? new Float32Array(length));
  return { ...audio, channels };
}

/**
 * 循环背景在输出时间 t 处的样本。
 * 把长度 L 的素材按重叠 C 个采样拼接：每圈时间轴推进 P=L-C，
 * 重叠区尾部淡出、新圈头部淡入，权重之和恒为 1，接缝无跳变。
 * 首圈之前不存在上一圈，因此头部 C 个采样原样播放。
 */
function loopedSample(source: Float32Array, length: number, period: number, fadeSamples: number, t: number): number {
  if (length === 0 || t < 0) return 0;
  const lap = Math.floor(t / period);
  const j = t - lap * period; // 0 .. period-1
  const head = source[j] ?? 0;
  if (lap === 0 || fadeSamples === 0 || j >= fadeSamples) return head;
  const headGain = j / fadeSamples;
  const tail = source[period + j] ?? 0; // 上一圈尾部：source[L-C .. L-1]
  return tail * (1 - headGain) + head * headGain;
}

/**
 * 由人声响度计算背景增益包络：
 * 以约 20ms 块的 RMS 判定是否有人声，检测到后按 attack 快速压下；
 * 进入停顿保留很短的保持期，随后按 release 逐渐恢复到满音量。
 */
export function buildDuckEnvelope(voice: Float32Array, sampleRate: number, settings: MixSettings): Float32Array {
  const gain = new Float32Array(voice.length).fill(1);
  if (!settings.ducking) return gain;
  const blockSeconds = .02;
  const blockSize = Math.max(1, Math.round(sampleRate * blockSeconds));
  const attackPerBlock = 1 - Math.exp(-blockSeconds / Math.max(.001, settings.attack));
  const releasePerBlock = 1 - Math.exp(-blockSeconds / Math.max(.001, settings.release));
  const holdBlocks = Math.max(1, Math.round(.12 / blockSeconds));
  const minGain = settings.duckDepth;
  let envelope = 1; let silenceBlocks = 0;
  for (let start = 0; start < voice.length; start += blockSize) {
    let sum = 0; let count = 0;
    for (let i = start; i < Math.min(start + blockSize, voice.length); i += 1) { sum += voice[i]! * voice[i]!; count += 1; }
    const rms = Math.sqrt(sum / Math.max(1, count));
    if (rms >= settings.duckThreshold) silenceBlocks = 0; else silenceBlocks += 1;
    const target = silenceBlocks <= holdBlocks ? minGain : 1;
    envelope += (target - envelope) * (target < envelope ? attackPerBlock : releasePerBlock);
    if (Math.abs(target - envelope) < .02) envelope = target; // 末段吸附，保证长时间停顿后完全恢复
    gain.fill(envelope, start, Math.min(start + blockSize, voice.length));
  }
  return gain;
}

/**
 * 按同一时间轴合成两路音频。
 * 输出时长 = 人声选段长度（调用方负责裁剪到 ≤10s）；
 * 输出采样率/声道随人声，背景自动重采样、上下混对齐。
 */
export function mixAudio(voiceInput: PcmAudio, bgInput: PcmAudio | undefined, settings: MixSettings): MixResult {
  const length = Math.round(voiceInput.duration * voiceInput.sampleRate);
  const channelCount = Math.max(1, Math.min(2, voiceInput.channels.length));
  const out = Array.from({ length: channelCount }, () => new Float32Array(length));
  let peak = 0;

  const voice = matchChannels(voiceInput, channelCount);
  let bg: PcmAudio | undefined;
  if (bgInput && settings.bgVolume > 0) {
    bg = matchChannels(resample(bgInput, voiceInput.sampleRate), channelCount);
  }

  const monoVoice = voice.channels[0] ?? new Float32Array();
  const duck = buildDuckEnvelope(monoVoice, voiceInput.sampleRate, settings);
  const bgLen = bg ? bg.channels[0]?.length ?? 0 : 0;
  const fadeSamples = settings.loop && bgLen > 0 ? Math.min(Math.round(settings.crossfade * voiceInput.sampleRate), Math.floor(bgLen / 2)) : 0;
  const loopPeriod = bgLen - fadeSamples;
  const offsetSamples = Math.round(settings.startOffset * voiceInput.sampleRate);

  for (let ch = 0; ch < channelCount; ch += 1) {
    const voiceChannel = voice.channels[ch] ?? monoVoice;
    const bgChannel = bg?.channels[ch];
    for (let i = 0; i < length; i += 1) {
      const v = (voiceChannel[i] ?? 0) * settings.voiceVolume;
      let value = v;
      if (bg && bgChannel) {
        const t = i - offsetSamples;
        let bgSample = 0;
        if (settings.loop) {
          const loopT = t < 0 ? 0 : t; // 循环从人声起点开始，不回绕到素材末尾
          bgSample = loopPeriod > 0 ? loopedSample(bgChannel, bgLen, loopPeriod, fadeSamples, loopT) : 0;
        } else {
          const index = Math.floor(t);
          if (index >= 0 && index < bgLen) bgSample = bgChannel[index] ?? 0;
        }
        value += bgSample * settings.bgVolume * duck[i]!;
      }
      out[ch]![i] = value;
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return { channels: out, peak, clipping: peak > CLIP_WARN, duration: length / voiceInput.sampleRate, sampleRate: voiceInput.sampleRate };
}

/** 计算刚好消除削波风险的整体衰减系数（两路同比例降低，不改变相互比例） */
export function attenuationFor(peak: number): number {
  if (!(peak > CLIP_WARN) || !Number.isFinite(peak) || peak === 0) return 1;
  return CLIP_WARN / peak;
}

/** 对已合成结果统一乘上整体增益（用于用户确认整体降低，而非分别截断） */
export function scaleMix(result: MixResult, factor: number): MixResult {
  const channels = result.channels.map((channel) => {
    const scaled = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i += 1) scaled[i] = channel[i]! * factor;
    return scaled;
  });
  const peak = result.peak * factor;
  return { ...result, channels, peak, clipping: peak > CLIP_WARN };
}
