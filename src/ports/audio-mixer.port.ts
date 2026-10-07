import type { MixConfig } from '../core/models';
export interface MixResult { blob: Blob; duration: number; peak: number }
export interface AudioMixerPort {
  inspect(blob: Blob): Promise<{ duration: number }>;
  mix(voice: Blob, background: Blob, config: MixConfig): Promise<MixResult>;
}
