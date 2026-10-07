import { describe, expect, it } from 'vitest';
import { useStudio, type StudioDependencies } from '../useStudio';
import { coverPresetFor } from '../../core/cover-presets';
import type { VoiceMeme } from '../../core/models';

function dependencies(overrides: Partial<StudioDependencies> = {}): StudioDependencies {
  const saved: VoiceMeme[] = [];
  return {
    recorder: { isRecording: false, start: async () => {}, stop: async () => new Blob(['voice'], { type: 'audio/webm' }) },
    analyzer: { analyze: async () => ({ duration: 2, features: { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 } }) },
    cropper: { inspect: async () => ({duration:2,needsCrop:false}), crop: async (blob, range) => ({blob,duration:range.end-range.start}) },
    mixer: { inspect: async () => ({ duration: 5 }), mix: async () => ({ blob: new Blob(['mix'], { type: 'audio/wav' }), duration: 2, peak: 0.8 }) },
    renderer: { render: async () => new Blob(['cover'], { type: 'image/png' }) },
    repository: { list: async()=>saved, save: async(m)=>{saved.push(m)}, rename:async()=>{}, delete:async()=>{} },
    share: { share: async () => 'shared' },
    ...overrides,
  };
}

async function recordAndCrop(studio: ReturnType<typeof useStudio>) { await studio.startRecording(); await studio.stopRecording(); await studio.applyCrop(); }

describe('useStudio', () => {
  it('turns microphone denial into a recoverable error', async () => {
    const studio = useStudio(dependencies({ recorder: { isRecording:false, start:async()=>{throw new DOMException('denied','NotAllowedError')}, stop:async()=>new Blob() } }));
    await studio.startRecording();
    expect(studio.error.value).toContain('麦克风权限');
    expect(studio.stage.value).toBe('record');
  });
  it('moves recording through crop, mix and emotion with manual override', async () => {
    const studio = useStudio(dependencies()); await studio.startRecording(); await studio.stopRecording();
    expect(studio.stage.value).toBe('crop'); await studio.applyCrop(); expect(studio.stage.value).toBe('mix');
    await studio.skipMix(); expect(studio.stage.value).toBe('emotion'); expect(studio.emotion.value?.label).toBe('元气满满');
    studio.selectEmotion('温柔姐姐'); expect(studio.cover.value.label).toBe('温柔姐姐'); expect(studio.stage.value).toBe('emotion');
  });
  it('keeps the draft when saving fails and can edit an existing work', async () => {
    const studio = useStudio(dependencies({ repository: { list:async()=>[], save:async()=>{throw new DOMException('full','QuotaExceededError')}, rename:async()=>{}, delete:async()=>{} } }));
    studio.draft.audio = new Blob(['a']); studio.draft.duration = 1; studio.cover.value = coverPresetFor('温柔姐姐'); studio.emotion.value = { label:'温柔姐姐',confidence:.8,explanation:'柔和',scores:{'暴躁老哥':0,'温柔姐姐':1,'阴阳怪气':0,'元气满满':0} };
    studio.features.value = { loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2 };
    await studio.save(); expect(studio.error.value).toContain('保存失败'); expect(studio.draft.audio?.size).toBe(1);
    const existing = { id:'old',title:'旧作品',emotion:'温柔姐姐' as const,confidence:.8,features:{loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2},audio:new Blob(['a']),duration:1,cover:new Blob(['c']),coverConfig:coverPresetFor('温柔姐姐'),createdAt:'2026-10-05' };
    studio.editMeme(existing); expect(studio.draft.title).toBe('旧作品'); expect(studio.stage.value).toBe('cover');
  });
});

describe('useStudio mixing', () => {
  it('confirms a mix and uses it for analysis and saving', async () => {
    const mixed = new Blob(['mixed'], { type: 'audio/wav' });
    const studio = useStudio(dependencies({ mixer: { inspect: async () => ({ duration: 5 }), mix: async () => ({ blob: mixed, duration: 2, peak: 0.8 }) } }));
    await recordAndCrop(studio);
    await studio.importBackground(new File(['bg'], 'bg.mp3'));
    expect(studio.mixState.backgroundName).toBe('bg.mp3');
    await studio.previewMix(); expect(studio.mixState.result?.blob).toBe(mixed);
    await studio.confirmMix();
    expect(studio.stage.value).toBe('emotion');
    expect(studio.draft.audio).toBe(mixed); // 情绪分析与保存使用确认后的混音
    expect(studio.draft.voice).toBeDefined(); // 原始人声保留可撤回
  });
  it('blocks export while clipping until the whole mix is lowered uniformly', async () => {
    const studio = useStudio(dependencies({ mixer: { inspect: async () => ({ duration: 5 }), mix: async (_v, _b, config) => ({ blob: new Blob(['mix']), duration: 2, peak: 1.5 * config.masterGain }) } }));
    await recordAndCrop(studio);
    await studio.importBackground(new File(['bg'], 'bg.mp3'));
    await studio.previewMix();
    expect(studio.mixState.clipRisk).toBe(true);
    await studio.confirmMix(); expect(studio.stage.value).toBe('mix'); // 削波时不能导出
    await studio.reduceMasterGain();
    expect(studio.mixConfig.masterGain).toBeLessThan(1);
    expect(studio.mixState.clipRisk).toBe(false);
    await studio.confirmMix(); expect(studio.stage.value).toBe('emotion');
  });
  it('keeps the last valid background and mix when a new background fails to decode', async () => {
    const good = new File(['good'], 'good.mp3'); const bad = new File(['bad'], 'bad.mp3');
    const studio = useStudio(dependencies({ mixer: { inspect: async (blob) => { if (blob === bad) throw new Error('decode failed'); return { duration: 5 }; }, mix: async () => ({ blob: new Blob(['mix']), duration: 2, peak: 0.8 }) } }));
    await recordAndCrop(studio);
    await studio.importBackground(good); await studio.previewMix();
    const result = studio.mixState.result;
    await studio.importBackground(bad);
    expect(studio.error.value).toContain('解码失败');
    expect(studio.mixState.background).toBe(good); // 上次有效配置与结果保留
    expect(studio.mixState.result).toBe(result);
  });
  it('invalidates the old mix when the background changes', async () => {
    const studio = useStudio(dependencies());
    await recordAndCrop(studio);
    await studio.importBackground(new File(['a'], 'a.mp3'));
    await studio.confirmMix();
    expect(studio.stage.value).toBe('emotion');
    studio.backToMix();
    await studio.importBackground(new File(['b'], 'b.mp3'));
    expect(studio.mixState.result).toBeUndefined(); // 旧混音不能写回
    expect(studio.mixState.confirmed).toBe(false);
    expect(studio.draft.audio).toBe(studio.draft.voice); // 恢复为原始人声
  });
  it('discards an in-flight mix rendered from the old background', async () => {
    let resolveMix!: (value: { blob: Blob; duration: number; peak: number }) => void;
    const studio = useStudio(dependencies({ mixer: { inspect: async () => ({ duration: 5 }), mix: async () => new Promise((resolve) => { resolveMix = resolve; }) } }));
    await recordAndCrop(studio);
    await studio.importBackground(new File(['a'], 'a.mp3'));
    const pending = studio.previewMix();
    await studio.importBackground(new File(['b'], 'b.mp3')); // 混音进行中更换背景
    resolveMix({ blob: new Blob(['stale']), duration: 2, peak: 0.8 });
    await pending;
    expect(studio.mixState.result).toBeUndefined(); // 旧混音没有写回
  });
  it('reverts to the original voice kept aside', async () => {
    const studio = useStudio(dependencies());
    await recordAndCrop(studio);
    const voice = studio.draft.voice;
    await studio.importBackground(new File(['a'], 'a.mp3'));
    await studio.confirmMix();
    expect(studio.draft.audio).not.toBe(voice);
    studio.backToMix(); studio.revertMix();
    expect(studio.draft.audio).toBe(voice);
    expect(studio.mixState.result).toBeUndefined();
    expect(studio.mixState.background).toBeDefined(); // 背景素材保留可重新混音
  });
});
