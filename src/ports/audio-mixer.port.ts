import type { MixSettings } from '../core/mixing-engine';

export interface MixedAudio { blob: Blob; duration: number; peak: number; clipping: boolean }

/**
 * 混音端口：负责把人声选段与背景按同一时间轴合成并编码。
 * 背景单独解码以便获取时长与起播上限；人声沿用裁剪端口产出的 WAV 选段。
 */
export interface AudioMixerPort {
  /** 解码背景文件；失败时由调用方保留上次有效配置，不清空状态 */
  inspectBackground(blob: Blob): Promise<{ duration: number; sampleRate: number; channels: number }>;
  /** 试算混音，只回传峰值与削波风险，不写回任何素材 */
  preview(voice: Blob, background: Blob, settings: MixSettings): Promise<{ peak: number; clipping: boolean; duration: number }>;
  /** 导出确认后的混音；attenuation 为用户确认的整体衰减（默认 1，两路同比例降低） */
  render(voice: Blob, background: Blob | undefined, settings: MixSettings, attenuation?: number): Promise<MixedAudio>;
}
