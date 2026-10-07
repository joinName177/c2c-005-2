export type EmotionLabel = '暴躁老哥' | '温柔姐姐' | '阴阳怪气' | '元气满满';
export type StudioStage = 'record' | 'crop' | 'mix' | 'emotion' | 'cover' | 'collection';
export interface CropRange { start: number; end: number }
export interface MixConfig {
  backgroundStart: number;
  loop: boolean;
  voiceGain: number;
  backgroundGain: number;
  duckAmount: number;
  duckRelease: number;
  masterGain: number;
}
export const DEFAULT_MIX_CONFIG: MixConfig = { backgroundStart: 0, loop: true, voiceGain: 1, backgroundGain: 0.8, duckAmount: 0.6, duckRelease: 0.4, masterGain: 1 };
export interface AudioFeatures { loudness: number; dynamics: number; pitch: number; zeroCrossing: number; pauseRatio: number; tempoVariation: number }
export interface EmotionResult { label: EmotionLabel; confidence: number; explanation: string; scores: Record<EmotionLabel, number> }
export interface CoverConfig {
  label: EmotionLabel;
  title: string;
  bubbleText: string;
  bubbleX: number;
  bubbleY: number;
  palette: [string, string, string];
  filter: 'none' | 'mono' | 'saturate' | 'warm' | 'cool';
  ratio: 'square' | 'portrait';
}
export interface VoiceMeme {
  id: string;
  title: string;
  emotion: EmotionLabel;
  confidence: number;
  features: AudioFeatures;
  audio: Blob;
  duration: number;
  cover: Blob;
  coverConfig: CoverConfig;
  createdAt: string;
}

export function validateCropRange(range: CropRange, duration: number): string | undefined {
  if (range.start < 0) return '裁剪起点不能小于 0';
  if (range.end <= range.start) return '裁剪终点必须晚于起点';
  if (range.end > duration) return '裁剪终点超出音频时长';
  if (range.end - range.start > 10) return '裁剪片段不能超过 10 秒';
  return undefined;
}

export function validateMixConfig(config: MixConfig, backgroundDuration: number): string | undefined {
  if (config.backgroundStart < 0) return '背景起播位置不能小于 0';
  if (backgroundDuration > 0 && config.backgroundStart >= backgroundDuration) return '背景起播位置超出背景音频时长';
  if (config.voiceGain < 0 || config.voiceGain > 1 || config.backgroundGain < 0 || config.backgroundGain > 1) return '两路音量必须在 0 到 1 之间';
  if (config.duckAmount < 0 || config.duckAmount > 1) return '背景自动降低幅度必须在 0 到 1 之间';
  if (config.duckRelease < 0 || config.duckRelease > 5) return '停顿恢复时长必须在 0 到 5 秒之间';
  if (config.masterGain <= 0 || config.masterGain > 1) return '整体音量必须在 0 到 1 之间';
  return undefined;
}
