import { describe, expect, it } from 'vitest';
import { DEFAULT_MIX_CONFIG, validateCropRange, validateMixConfig } from '../models';

describe('validateCropRange', () => {
  it('rejects a negative start', () => expect(validateCropRange({ start: -1, end: 3 }, 5)).toContain('起点'));
  it('rejects reversed endpoints', () => expect(validateCropRange({ start: 4, end: 2 }, 5)).toContain('终点'));
  it('rejects clips longer than ten seconds', () => expect(validateCropRange({ start: 0, end: 11 }, 12)).toContain('10 秒'));
  it('accepts an exact ten-second clip', () => expect(validateCropRange({ start: 0, end: 10 }, 10)).toBeUndefined());
});

describe('validateMixConfig', () => {
  it('accepts the default config', () => expect(validateMixConfig({ ...DEFAULT_MIX_CONFIG }, 8)).toBeUndefined());
  it('rejects a background start beyond the background duration', () => expect(validateMixConfig({ ...DEFAULT_MIX_CONFIG, backgroundStart: 8 }, 8)).toContain('起播位置'));
  it('rejects a negative background start', () => expect(validateMixConfig({ ...DEFAULT_MIX_CONFIG, backgroundStart: -1 }, 8)).toContain('起播位置'));
  it('rejects gains outside zero to one', () => {
    expect(validateMixConfig({ ...DEFAULT_MIX_CONFIG, voiceGain: 1.2 }, 8)).toContain('音量');
    expect(validateMixConfig({ ...DEFAULT_MIX_CONFIG, backgroundGain: -0.1 }, 8)).toContain('音量');
    expect(validateMixConfig({ ...DEFAULT_MIX_CONFIG, masterGain: 0 }, 8)).toContain('整体音量');
  });
  it('rejects ducking settings outside their ranges', () => {
    expect(validateMixConfig({ ...DEFAULT_MIX_CONFIG, duckAmount: 1.5 }, 8)).toContain('降低幅度');
    expect(validateMixConfig({ ...DEFAULT_MIX_CONFIG, duckRelease: 9 }, 8)).toContain('恢复时长');
  });
});
