import { reactive, ref } from 'vue';
import { classifyEmotion } from '../core/emotion-engine';
import { coverPresetFor } from '../core/cover-presets';
import { DEFAULT_MIX_CONFIG, validateMixConfig } from '../core/models';
import type { AudioFeatures, CoverConfig, EmotionLabel, EmotionResult, MixConfig, StudioStage, VoiceMeme } from '../core/models';
import type { RecorderPort } from '../ports/recorder.port';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { AudioCropperPort } from '../ports/audio-cropper.port';
import type { AudioMixerPort, MixResult } from '../ports/audio-mixer.port';
import type { CoverRendererPort } from '../ports/cover-renderer.port';
import type { MemeRepository } from '../ports/meme-repository.port';
import type { SharePort } from '../ports/share.port';

export interface StudioDependencies { recorder: RecorderPort; analyzer: AudioAnalyzerPort; cropper: AudioCropperPort; mixer: AudioMixerPort; renderer: CoverRendererPort; repository: MemeRepository; share: SharePort }
export function useStudio(deps: StudioDependencies) {
  const stage = ref<StudioStage>('record'); const error = ref(''); const notice = ref(''); const level = ref(0);
  const draft = reactive<{ id?: string; title: string; audio?: Blob; voice?: Blob; duration: number; cropStart: number; cropEnd: number }>({ title: '我的声音表情', duration: 0, cropStart: 0, cropEnd: 0 });
  const emotion = ref<EmotionResult>(); const features = ref<AudioFeatures>(); const cover = ref<CoverConfig>(coverPresetFor('元气满满')); const collection = ref<VoiceMeme[]>([]);
  const mixConfig = reactive<MixConfig>({ ...DEFAULT_MIX_CONFIG });
  const mixState = reactive<{ background?: Blob; backgroundName: string; backgroundDuration: number; result?: MixResult; mixing: boolean; clipRisk: boolean; confirmed: boolean; stale: boolean }>({ backgroundName: '', backgroundDuration: 0, mixing: false, clipRisk: false, confirmed: false, stale: false });
  let mixGeneration = 0; let mixApplied = false; let pendingMixes = 0;

  function resetMix() { mixGeneration += 1; mixApplied = false; Object.assign(mixConfig, DEFAULT_MIX_CONFIG); Object.assign(mixState, { background: undefined, backgroundName: '', backgroundDuration: 0, result: undefined, mixing: false, clipRisk: false, confirmed: false, stale: false }); }

  async function startRecording() { error.value = ''; try { await deps.recorder.start((value) => { level.value = value; }); notice.value = '正在录音，最长 10 秒'; } catch { error.value = '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。'; } }
  async function stopRecording() { try { draft.audio = await deps.recorder.stop(); resetMix(); draft.voice = undefined; const info = await deps.cropper.inspect(draft.audio); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); stage.value = 'crop'; notice.value = info.needsCrop ? '音频超过 10 秒，请选择保留片段' : '录音完成，可以试听并分析'; } catch (cause) { error.value = cause instanceof Error ? cause.message : '录音结束失败'; } }
  async function importAudio(blob: Blob) { resetMix(); draft.voice = undefined; draft.audio = blob; const info = await deps.cropper.inspect(blob); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); stage.value = 'crop'; }

  async function applyCrop() {
    if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; }
    try {
      const cropped = await deps.cropper.crop(draft.audio, { start: draft.cropStart, end: draft.cropEnd });
      draft.voice = cropped.blob; draft.audio = cropped.blob; draft.duration = cropped.duration;
      mixGeneration += 1; mixApplied = false; mixState.result = undefined; mixState.clipRisk = false; mixState.confirmed = false; mixState.stale = false;
      stage.value = 'mix'; notice.value = '人声选段已确定，可以导入背景进行混音';
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '裁剪失败'; }
  }

  async function importBackground(file: Blob) {
    error.value = '';
    try {
      const info = await deps.mixer.inspect(file);
      mixGeneration += 1; // 作废旧背景下尚未完成的混音
      mixState.background = file; mixState.backgroundName = (file as File).name || '背景音频'; mixState.backgroundDuration = info.duration;
      mixConfig.backgroundStart = 0; mixConfig.masterGain = 1;
      mixState.result = undefined; mixState.clipRisk = false; mixState.confirmed = false; mixState.stale = false;
      if (mixApplied) { draft.audio = draft.voice; mixApplied = false; } // 更换背景后旧混音不能写回
      notice.value = '背景已导入，此前的混音已作废，请重新生成';
    } catch { error.value = '背景音频解码失败，已保留上次有效的背景与混音结果。'; }
  }

  async function runMix(): Promise<MixResult | undefined> {
    if (!mixState.background) { error.value = '请先导入一段背景音频'; return undefined; }
    const voice = draft.voice ?? draft.audio;
    if (!voice) { error.value = '请先录制或导入一段声音'; return undefined; }
    const invalid = validateMixConfig(mixConfig, mixState.backgroundDuration);
    if (invalid) { error.value = invalid; return undefined; }
    const generation = ++mixGeneration;
    pendingMixes += 1; mixState.mixing = true; error.value = '';
    try {
      const result = await deps.mixer.mix(voice, mixState.background, { ...mixConfig });
      if (generation !== mixGeneration) return undefined; // 背景已更换，丢弃旧混音
      mixState.result = result; mixState.clipRisk = result.peak > 1; mixState.stale = false;
      return result;
    } catch {
      if (generation === mixGeneration) error.value = '混音失败，已保留上次有效的配置与混音结果。';
      return undefined;
    } finally { pendingMixes -= 1; mixState.mixing = pendingMixes > 0; }
  }

  async function previewMix() { const result = await runMix(); if (result) notice.value = result.peak > 1 ? '混音超出可表达音量，存在削波风险，请整体降低音量' : '混音已生成，可试听确认'; }
  function patchMixConfig(patch: Partial<MixConfig>) { Object.assign(mixConfig, patch); mixState.stale = true; mixState.clipRisk = false; }
  async function reduceMasterGain() { const peak = mixState.result?.peak; if (!peak || peak <= 1) return; mixConfig.masterGain = Math.max(0.05, (mixConfig.masterGain * 0.98) / peak); const result = await runMix(); if (result && result.peak <= 1) notice.value = '已整体降低音量，两路音量比例保持不变'; }
  async function confirmMix() {
    if (!mixState.background) { await skipMix(); return; }
    const result = await runMix();
    if (!result) return;
    if (result.peak > 1) { notice.value = '混音仍有削波风险，请先整体降低音量再导出'; return; }
    draft.audio = result.blob; mixApplied = true; mixState.confirmed = true;
    await analyze();
  }
  async function skipMix() { draft.audio = draft.voice ?? draft.audio; mixApplied = false; mixState.confirmed = false; await analyze(); }
  function revertMix() { mixGeneration += 1; mixState.result = undefined; mixState.clipRisk = false; mixState.confirmed = false; mixState.stale = false; mixApplied = false; draft.audio = draft.voice; notice.value = '已撤回混音，恢复原始人声，背景素材保留可重新混音'; }
  function backToMix() { stage.value = 'mix'; }

  async function analyze() { if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; } const result = await deps.analyzer.analyze(draft.audio); features.value = result.features; emotion.value = classifyEmotion(result.features); cover.value = coverPresetFor(emotion.value.label); stage.value = 'emotion'; }
  function selectEmotion(label: EmotionLabel) { const current = emotion.value ?? classifyEmotion({ loudness:0,dynamics:0,pitch:0,zeroCrossing:0,pauseRatio:1,tempoVariation:0 }); emotion.value = { ...current, label, explanation: `已手动选择「${label}」标签。` }; cover.value = { ...coverPresetFor(label), title: cover.value.title || label }; }
  function goCover() { stage.value = 'cover'; }
  async function save(target?: HTMLCanvasElement) { if (!draft.audio || !emotion.value || !features.value) { error.value = '作品信息尚未完整，请先完成声音分析'; return; } try { const coverBlob = await deps.renderer.render(cover.value, target); const meme: VoiceMeme = { id: draft.id ?? `meme-${Date.now()}`, title: draft.title.trim() || '未命名声音', emotion: emotion.value.label, confidence: emotion.value.confidence, features: features.value, audio: draft.audio, duration: draft.duration, cover: coverBlob, coverConfig: { ...cover.value }, createdAt: new Date().toISOString() }; await deps.repository.save(meme); await loadCollection(); stage.value = 'collection'; notice.value = '作品已保存到本地'; } catch { error.value = '保存失败，本次编辑内容仍保留，请检查浏览器存储空间。'; } }
  async function loadCollection() { collection.value = (await deps.repository.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  function editMeme(meme: VoiceMeme) { resetMix(); Object.assign(draft, { id:meme.id,title:meme.title,audio:meme.audio,voice:meme.audio,duration:meme.duration,cropStart:0,cropEnd:meme.duration }); features.value = meme.features; emotion.value = { label:meme.emotion,confidence:meme.confidence,explanation:'编辑已保存作品',scores:{'暴躁老哥':0,'温柔姐姐':0,'阴阳怪气':0,'元气满满':0} }; cover.value = { ...meme.coverConfig }; stage.value = 'cover'; }
  async function deleteMeme(id: string) { await deps.repository.delete(id); await loadCollection(); }
  async function shareMeme(meme: VoiceMeme) { const result = await deps.share.share(meme); notice.value = result === 'shared' ? '已打开系统分享' : '浏览器不支持文件分享，已下载音频和封面'; }
  function newRecording() { resetMix(); draft.id = undefined; draft.title = '我的声音表情'; draft.audio = undefined; draft.voice = undefined; emotion.value = undefined; features.value = undefined; stage.value = 'record'; error.value = ''; }
  return { stage,error,notice,level,draft,emotion,features,cover,collection,mixConfig,mixState,startRecording,stopRecording,importAudio,applyCrop,importBackground,previewMix,patchMixConfig,reduceMasterGain,confirmMix,skipMix,revertMix,backToMix,analyze,selectEmotion,goCover,save,loadCollection,editMeme,deleteMeme,shareMeme,newRecording };
}
