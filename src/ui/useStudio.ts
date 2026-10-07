import { reactive, ref } from 'vue';
import { classifyEmotion } from '../core/emotion-engine';
import { coverPresetFor } from '../core/cover-presets';
import { attenuationFor, DEFAULT_MIX_SETTINGS, type MixSettings } from '../core/mixing-engine';
import type { AudioFeatures, CoverConfig, EmotionLabel, EmotionResult, StudioStage, VoiceMeme } from '../core/models';
import type { RecorderPort } from '../ports/recorder.port';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { AudioCropperPort } from '../ports/audio-cropper.port';
import type { AudioMixerPort } from '../ports/audio-mixer.port';
import type { CoverRendererPort } from '../ports/cover-renderer.port';
import type { MemeRepository } from '../ports/meme-repository.port';
import type { SharePort } from '../ports/share.port';

export interface StudioDependencies { recorder: RecorderPort; analyzer: AudioAnalyzerPort; cropper: AudioCropperPort; mixer: AudioMixerPort; renderer: CoverRendererPort; repository: MemeRepository; share: SharePort }
export function useStudio(deps: StudioDependencies) {
  const stage = ref<StudioStage>('record'); const error = ref(''); const notice = ref(''); const level = ref(0);
  const draft = reactive<{ id?: string; title: string; audio?: Blob; duration: number; cropStart: number; cropEnd: number }>({ title: '我的声音表情', duration: 0, cropStart: 0, cropEnd: 0 });
  const emotion = ref<EmotionResult>(); const features = ref<AudioFeatures>(); const cover = ref<CoverConfig>(coverPresetFor('元气满满')); const collection = ref<VoiceMeme[]>([]);

  // —— 混音工作台状态 ——
  // 原始人声选段（裁剪结果）始终保留，便于撤回混音与重新配置。
  const voiceSource = ref<Blob>();
  const background = ref<Blob>();
  const backgroundName = ref('');
  const backgroundDuration = ref(0);
  const mixSettings = reactive<MixSettings>({ ...DEFAULT_MIX_SETTINGS });
  // 最近一次确认后的混音：试听、情绪分析与保存只允许使用它。
  const confirmedMix = ref<Blob>();
  // 尚未导出的试算结果（仅数值，用于削波提示）
  const pendingPeak = ref(0);
  const clipRisk = ref(false);
  const mixDirty = ref(false);
  const previewing = ref(false);

  async function startRecording() { error.value = ''; try { await deps.recorder.start((value) => { level.value = value; }); notice.value = '正在录音，最长 10 秒'; } catch { error.value = '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。'; } }
  async function stopRecording() { try { draft.audio = await deps.recorder.stop(); const info = await deps.cropper.inspect(draft.audio); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); resetMix(); stage.value = 'crop'; notice.value = info.needsCrop ? '音频超过 10 秒，请选择保留片段' : '录音完成，可以试听并选择片段'; } catch (cause) { error.value = cause instanceof Error ? cause.message : '录音结束失败'; } }
  async function importAudio(blob: Blob) { draft.audio = blob; const info = await deps.cropper.inspect(blob); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); resetMix(); stage.value = 'crop'; }

  function resetMix() {
    voiceSource.value = undefined; background.value = undefined; backgroundName.value = ''; backgroundDuration.value = 0;
    Object.assign(mixSettings, DEFAULT_MIX_SETTINGS);
    confirmedMix.value = undefined; pendingPeak.value = 0; clipRisk.value = false; mixDirty.value = false;
  }
  // 裁剪确认：先固化人声选段（原始素材保留在 draft.audio 中以便撤回），再进入混音台
  async function enterMix() {
    if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; }
    try {
      const cropped = await deps.cropper.crop(draft.audio, { start: draft.cropStart, end: draft.cropEnd });
      voiceSource.value = cropped.blob;
      draft.duration = cropped.duration;
      confirmedMix.value = undefined; mixDirty.value = false; clipRisk.value = false; pendingPeak.value = 0;
      stage.value = 'mix';
      error.value = ''; notice.value = background.value ? '' : '可以直接确认纯人声，或导入一段背景声';
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '无法解码该段音频'; }
  }
  async function importBackground(file: File) {
    error.value = '';
    try {
      const info = await deps.mixer.inspectBackground(file);
      // 解码成功才提交；失败时上次有效背景、配置与结果全部保留
      background.value = file; backgroundName.value = file.name; backgroundDuration.value = info.duration;
      if (mixSettings.startOffset > Math.max(0, info.duration - .1)) mixSettings.startOffset = 0;
      invalidateMix('背景已更换，请重新确认混音');
    } catch {
      error.value = '背景文件解码失败，已保留上一次有效的背景与混音配置';
    }
  }
  function removeBackground() {
    background.value = undefined; backgroundName.value = ''; backgroundDuration.value = 0;
    invalidateMix('已移除背景，请重新确认混音');
  }
  function patchSettings(patch: Partial<MixSettings>) {
    Object.assign(mixSettings, patch);
    invalidateMix();
  }
  // 配置变化：旧混音标记失效，绝不写回试听/分析/保存链路
  function invalidateMix(noticeText = '') {
    confirmedMix.value = undefined; clipRisk.value = false; mixDirty.value = true; pendingPeak.value = 0;
    if (noticeText) notice.value = noticeText;
  }

  async function previewMix() {
    if (!voiceSource.value) return;
    previewing.value = true; error.value = '';
    try {
      if (background.value) {
        const result = await deps.mixer.preview(voiceSource.value, background.value, { ...mixSettings });
        pendingPeak.value = result.peak; clipRisk.value = result.clipping;
        notice.value = result.clipping ? '混音音量超过可表达范围，存在削波风险，请选择整体降低后再确认' : '当前参数没有削波风险，可以确认混音';
      } else {
        pendingPeak.value = 0; clipRisk.value = false; notice.value = '未添加背景，将使用人声选段本身';
      }
    } catch (cause) {
      // 试算失败（如背景解码异常）保留上次有效配置与结果
      error.value = cause instanceof Error ? cause.message : '混音预览失败，已保留当前配置';
    } finally { previewing.value = false; }
  }

  // 确认混音：先试算，削波则只展示风险，由用户选择“整体降低后导出”；
  // 未选择整体降低前绝不产出成品，也不分别截断两路响声
  async function confirmMix(lowerOverall = false) {
    if (!voiceSource.value) return;
    try {
      let attenuation = 1;
      if (background.value) {
        const probe = await deps.mixer.preview(voiceSource.value, background.value, { ...mixSettings });
        pendingPeak.value = probe.peak; clipRisk.value = probe.clipping;
        if (probe.clipping) {
          if (!lowerOverall) {
            error.value = '存在削波风险：混音音量超过可表达范围，请选择整体降低后再导出（不会分别截断两路响声）';
            notice.value = '';
            return;
          }
          attenuation = attenuationFor(probe.peak);
        }
      }
      const result = await deps.mixer.render(voiceSource.value, background.value, { ...mixSettings }, attenuation);
      confirmedMix.value = result.blob;
      mixDirty.value = false; clipRisk.value = false;
      error.value = ''; notice.value = '混音已确认，试听、情绪分析和保存都将使用这一版本';
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '混音导出失败，已保留上次有效配置';
    }
  }

  // 撤回混音：恢复到人声选段（原始素材仍在），配置保留供再次调整
  function revertMix() {
    confirmedMix.value = undefined; mixDirty.value = true; clipRisk.value = false;
    notice.value = '已撤回到人声选段，背景与参数仍保留';
  }

  // 试听、情绪分析与保存只能使用确认后的混音；未确认时拒绝推进
  async function analyze() {
    if (!confirmedMix.value) { error.value = '请先确认混音（纯人声也需要确认），情绪分析只使用确认后的版本'; return; }
    try {
      const result = await deps.analyzer.analyze(confirmedMix.value);
      features.value = result.features;
      emotion.value = classifyEmotion(result.features);
      cover.value = coverPresetFor(emotion.value.label);
      draft.audio = confirmedMix.value; draft.duration = result.duration;
      stage.value = 'emotion';
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '情绪分析失败，请确认混音可正常解码'; }
  }
  function selectEmotion(label: EmotionLabel) { const current = emotion.value ?? classifyEmotion({ loudness:0,dynamics:0,pitch:0,zeroCrossing:0,pauseRatio:1,tempoVariation:0 }); emotion.value = { ...current, label, explanation: `已手动选择「${label}」标签。` }; cover.value = { ...coverPresetFor(label), title: cover.value.title || label }; }
  function goCover() { stage.value = 'cover'; }
  async function save(target?: HTMLCanvasElement) {
    if (!confirmedMix.value && voiceSource.value) { error.value = '混音尚未确认，试听、分析与保存均需使用确认后的混音'; return; }
    if (!draft.audio || !emotion.value || !features.value) { error.value = '作品信息尚未完整，请先完成声音分析'; return; }
    try {
      const coverBlob = await deps.renderer.render(cover.value, target);
      const meme: VoiceMeme = { id: draft.id ?? `meme-${Date.now()}`, title: draft.title.trim() || '未命名声音', emotion: emotion.value.label, confidence: emotion.value.confidence, features: features.value, audio: draft.audio, duration: draft.duration, cover: coverBlob, coverConfig: { ...cover.value }, createdAt: new Date().toISOString() };
      await deps.repository.save(meme); await loadCollection(); stage.value = 'collection'; notice.value = '作品已保存到本地';
    } catch { error.value = '保存失败，本次编辑内容仍保留，请检查浏览器存储空间。'; }
  }
  async function loadCollection() { collection.value = (await deps.repository.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  function editMeme(meme: VoiceMeme) { Object.assign(draft, { id:meme.id,title:meme.title,audio:meme.audio,duration:meme.duration,cropStart:0,cropEnd:meme.duration }); resetMix(); voiceSource.value = meme.audio; confirmedMix.value = meme.audio; mixDirty.value = false; features.value = meme.features; emotion.value = { label:meme.emotion,confidence:meme.confidence,explanation:'编辑已保存作品',scores:{'暴躁老哥':0,'温柔姐姐':0,'阴阳怪气':0,'元气满满':0} }; cover.value = { ...meme.coverConfig }; stage.value = 'cover'; }
  async function deleteMeme(id: string) { await deps.repository.delete(id); await loadCollection(); }
  async function shareMeme(meme: VoiceMeme) { const result = await deps.share.share(meme); notice.value = result === 'shared' ? '已打开系统分享' : '浏览器不支持文件分享，已下载音频和封面'; }
  function newRecording() { draft.id = undefined; draft.title = '我的声音表情'; draft.audio = undefined; emotion.value = undefined; features.value = undefined; resetMix(); stage.value = 'record'; error.value = ''; }
  return { stage,error,notice,level,draft,emotion,features,cover,collection,
    voiceSource,background,backgroundName,backgroundDuration,mixSettings,confirmedMix,pendingPeak,clipRisk,mixDirty,previewing,
    startRecording,stopRecording,importAudio,enterMix,importBackground,removeBackground,patchSettings,previewMix,confirmMix,revertMix,analyze,selectEmotion,goCover,save,loadCollection,editMeme,deleteMeme,shareMeme,newRecording };
}
