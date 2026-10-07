import { describe, expect, it } from 'vitest';
import { useStudio, type StudioDependencies } from '../useStudio';
import { coverPresetFor } from '../../core/cover-presets';
import type { VoiceMeme } from '../../core/models';

const voiceBlob = () => new Blob(['voice'], { type: 'audio/wav' });
function dependencies(overrides: Partial<StudioDependencies> = {}): StudioDependencies {
  const saved: VoiceMeme[] = [];
  return {
    recorder: { isRecording: false, start: async () => {}, stop: async () => voiceBlob() },
    analyzer: { analyze: async () => ({ duration: 2, features: { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 } }) },
    cropper: { inspect: async () => ({duration:2,needsCrop:false}), crop: async (blob, range) => ({blob,duration:range.end-range.start}) },
    mixer: {
      inspectBackground: async () => ({ duration: 4, sampleRate: 44100, channels: 2 }),
      preview: async () => ({ peak: .5, clipping: false, duration: 2 }),
      render: async (blob) => ({ blob, duration: 2, peak: .5, clipping: false }),
    },
    renderer: { render: async () => new Blob(['cover'], { type: 'image/png' }) },
    repository: { list: async()=>saved, save: async(m)=>{saved.push(m)}, rename:async()=>{}, delete:async()=>{} },
    share: { share: async () => 'shared' },
    ...overrides,
  };
}

async function recordToMix(studio: ReturnType<typeof useStudio>) {
  await studio.startRecording(); await studio.stopRecording();
  expect(studio.stage.value).toBe('crop');
  await studio.enterMix();
  expect(studio.stage.value).toBe('mix');
}

describe('useStudio', () => {
  it('turns microphone denial into a recoverable error', async () => {
    const studio = useStudio(dependencies({ recorder: { isRecording:false, start:async()=>{throw new DOMException('denied','NotAllowedError')}, stop:async()=>new Blob() } }));
    await studio.startRecording();
    expect(studio.error.value).toContain('麦克风权限');
    expect(studio.stage.value).toBe('record');
  });
  it('moves recording through mix, emotion with manual override', async () => {
    const studio = useStudio(dependencies());
    await recordToMix(studio);
    await studio.confirmMix(false);
    expect(studio.confirmedMix.value).toBeTruthy();
    await studio.analyze();
    expect(studio.emotion.value?.label).toBe('元气满满');
    studio.selectEmotion('温柔姐姐'); expect(studio.cover.value.label).toBe('温柔姐姐'); expect(studio.stage.value).toBe('emotion');
  });
  it('refuses analysis and saving before a mix is confirmed', async () => {
    const studio = useStudio(dependencies());
    await recordToMix(studio);
    await studio.analyze();
    expect(studio.stage.value).toBe('mix');
    expect(studio.error.value).toContain('确认');
  });
  it('warns about clipping and applies one overall attenuation chosen by the user', async () => {
    const renderCalls: number[] = [];
    const studio = useStudio(dependencies({
      mixer: {
        inspectBackground: async () => ({ duration: 4, sampleRate: 44100, channels: 2 }),
        preview: async () => ({ peak: 1.6, clipping: true, duration: 2 }),
        render: async (blob, _bg, _settings, attenuation = 1) => { renderCalls.push(attenuation); return { blob, duration: 2, peak: 1.6 * attenuation, clipping: false }; },
      },
    }));
    await recordToMix(studio);
    await studio.importBackground(new File(['bg'], 'bg.mp3'));
    expect(studio.backgroundName.value).toBe('bg.mp3');
    await studio.previewMix();
    expect(studio.clipRisk.value).toBe(true);
    // 用户未选择降低时不能导出
    await studio.confirmMix(false);
    expect(studio.confirmedMix.value).toBeFalsy();
    expect(studio.error.value).toContain('削波');
    // 选择整体降低：单一比例作用于两路之和，不分别截断
    await studio.confirmMix(true);
    expect(renderCalls.at(-1)).toBeCloseTo(.98 / 1.6, 5);
    expect(studio.confirmedMix.value).toBeTruthy();
  });
  it('invalidates the confirmed mix after settings change or replacing the background', async () => {
    const studio = useStudio(dependencies());
    await recordToMix(studio);
    await studio.importBackground(new File(['bg'], 'a.mp3'));
    await studio.confirmMix(false);
    expect(studio.confirmedMix.value).toBeTruthy();
    studio.patchSettings({ bgVolume: .5 });
    expect(studio.confirmedMix.value).toBeFalsy();
    expect(studio.mixDirty.value).toBe(true);
    await studio.importBackground(new File(['bg2'], 'b.mp3'));
    expect(studio.backgroundName.value).toBe('b.mp3');
    expect(studio.confirmedMix.value).toBeFalsy();
  });
  it('keeps the previous background, config and result when a new background fails to decode', async () => {
    const studio = useStudio(dependencies({
      mixer: {
        inspectBackground: async (blob: Blob) => { if ((blob as File).name === 'broken.mp3') throw new DOMException('decode', 'EncodingError'); return { duration: 4, sampleRate: 44100, channels: 2 }; },
        preview: async () => ({ peak: .5, clipping: false, duration: 2 }),
        render: async (blob) => ({ blob, duration: 2, peak: .5, clipping: false }),
      },
    }));
    await recordToMix(studio);
    await studio.importBackground(new File(['bg'], 'good.mp3'));
    studio.patchSettings({ bgVolume: .7, loop: false });
    await studio.confirmMix(false);
    const before = studio.confirmedMix.value;
    await studio.importBackground(new File(['x'], 'broken.mp3'));
    expect(studio.error.value).toContain('解码失败');
    expect(studio.backgroundName.value).toBe('good.mp3');
    expect(studio.mixSettings.bgVolume).toBe(.7);
    expect(studio.mixSettings.loop).toBe(false);
    expect(studio.confirmedMix.value).toBe(before);
  });
  it('keeps the draft when saving fails and can edit an existing work', async () => {
    const studio = useStudio(dependencies({ repository: { list:async()=>[], save:async()=>{throw new DOMException('full','QuotaExceededError')}, rename:async()=>{}, delete:async()=>{} } }));
    studio.draft.audio = new Blob(['a']); studio.draft.duration = 1; studio.voiceSource.value = voiceBlob(); studio.confirmedMix.value = voiceBlob(); studio.cover.value = coverPresetFor('温柔姐姐'); studio.emotion.value = { label:'温柔姐姐',confidence:.8,explanation:'柔和',scores:{'暴躁老哥':0,'温柔姐姐':1,'阴阳怪气':0,'元气满满':0} };
    studio.features.value = { loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2 };
    await studio.save(); expect(studio.error.value).toContain('保存失败'); expect(studio.draft.audio?.size).toBe(1);
    const existing = { id:'old',title:'旧作品',emotion:'温柔姐姐' as const,confidence:.8,features:{loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2},audio:new Blob(['a']),duration:1,cover:new Blob(['c']),coverConfig:coverPresetFor('温柔姐姐'),createdAt:'2026-10-05' };
    studio.editMeme(existing); expect(studio.draft.title).toBe('旧作品'); expect(studio.stage.value).toBe('cover');
  });
});
