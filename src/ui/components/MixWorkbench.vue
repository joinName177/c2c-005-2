<script setup lang="ts">
import { ref, watch } from 'vue';
import type { MixSettings } from '../../core/mixing-engine';

const props = defineProps<{
  voiceDuration: number;
  backgroundName: string;
  backgroundDuration: number;
  settings: MixSettings;
  confirmed: boolean;
  dirty: boolean;
  clipRisk: boolean;
  peak: number;
  previewing: boolean;
  audioUrl: string;
}>();
const emit = defineEmits<{
  importBackground: [file: File];
  removeBackground: [];
  patch: [patch: Partial<MixSettings>];
  preview: [];
  confirm: [lowerOverall: boolean];
  revert: [];
  analyze: [];
  back: [];
}>();

const audioEl = ref<HTMLAudioElement>();
// 试听只播放确认后的混音；参数改动后旧确认失效，试听源随之清空
watch(() => props.audioUrl, (url) => { if (audioEl.value) { audioEl.value.pause(); audioEl.value.src = url; } }, { immediate: false });

function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files?.[0]) emit('importBackground', input.files[0]);
  input.value = '';
}
function percent(value: number) { return `${Math.round(value * 100)}%`; }
</script>
<template>
  <section class="stage-card mix-bench">
    <span class="kicker">03 / VOICE × BACKDROP</span>
    <h2>人声与背景混音台</h2>
    <p class="mix-hint">成品长度以人声选段为准（{{ voiceDuration.toFixed(1) }} 秒，不超过 10 秒）；两路采样率与声道不同也会自动对齐到同一时间轴。</p>

    <div class="mix-grid">
      <div class="mix-track">
        <h3>① 背景声</h3>
        <label class="mix-file">
          {{ backgroundName || '选择一段背景音频导入' }}
          <input type="file" accept="audio/*" @change="onFile">
        </label>
        <div v-if="backgroundName" class="mix-bg-meta">
          <span>{{ backgroundName }} · {{ backgroundDuration.toFixed(1) }}s</span>
          <button type="button" data-testid="remove-bg" @click="emit('removeBackground')">移除背景</button>
        </div>
        <label v-if="backgroundName" class="mix-control">
          起播位置 {{ settings.startOffset.toFixed(1) }}s
          <input type="range" min="0" :max="Math.max(0, backgroundDuration - .1)" step=".1" :value="settings.startOffset" @input="emit('patch',{ startOffset: Number(($event.target as HTMLInputElement).value) })">
        </label>
        <label class="mix-check" v-if="backgroundName">
          <input type="checkbox" :checked="settings.loop" @change="emit('patch',{ loop: ($event.target as HTMLInputElement).checked })">
          循环播放，接缝平滑交叉淡化（{{ settings.crossfade.toFixed(2) }}s）
        </label>
        <p v-if="!backgroundName" class="mix-empty">未导入背景时，可直接确认纯人声版本继续。</p>
      </div>

      <div class="mix-track">
        <h3>② 两路音量</h3>
        <label class="mix-control">人声音量 {{ percent(settings.voiceVolume) }}
          <input type="range" min="0" max="2" step=".01" :value="settings.voiceVolume" @input="emit('patch',{ voiceVolume: Number(($event.target as HTMLInputElement).value) })">
        </label>
        <label class="mix-control">背景音量 {{ percent(settings.bgVolume) }}
          <input type="range" min="0" max="2" step=".01" :value="settings.bgVolume" :disabled="!backgroundName" @input="emit('patch',{ bgVolume: Number(($event.target as HTMLInputElement).value) })">
        </label>

        <h3>③ 人声出现时自动压低背景</h3>
        <label class="mix-check">
          <input type="checkbox" :checked="settings.ducking" :disabled="!backgroundName" @change="emit('patch',{ ducking: ($event.target as HTMLInputElement).checked })">
          开启闪避：有人声时背景压到 {{ percent(settings.duckDepth) }}
        </label>
        <label class="mix-control" v-if="backgroundName">压到比例
          <input type="range" min=".05" max="1" step=".01" :value="settings.duckDepth" :disabled="!settings.ducking" @input="emit('patch',{ duckDepth: Number(($event.target as HTMLInputElement).value) })">
        </label>
        <label class="mix-control" v-if="backgroundName">停顿后恢复时长 {{ settings.release.toFixed(1) }}s
          <input type="range" min=".1" max="2" step=".1" :value="settings.release" :disabled="!settings.ducking" @input="emit('patch',{ release: Number(($event.target as HTMLInputElement).value) })">
        </label>
      </div>
    </div>

    <div class="mix-actions">
      <button type="button" data-testid="mix-preview" class="acid-button ghost" :disabled="previewing" @click="emit('preview')">{{ previewing ? '试算中…' : '试算音量风险' }}</button>
      <button type="button" data-testid="mix-confirm" class="acid-button" @click="emit('confirm', false)">确认混音</button>
    </div>

    <div v-if="clipRisk" class="clip-warning" data-testid="clip-warning">
      <b>⚠ 削波风险</b>
      <p>当前两路叠加峰值 {{ Math.min(9.9, peak).toFixed(2) }}，超过可表达的音量。建议整体等比降低（保持人声与背景的比例），不会分别截断响声。</p>
      <div>
        <button type="button" data-testid="lower-overall" class="acid-button" @click="emit('confirm', true)">整体降低后导出</button>
        <button type="button" class="text-button" @click="emit('preview')">返回调整参数</button>
      </div>
    </div>

    <div v-if="confirmed" class="confirmed-bar" data-testid="confirmed-bar">
      <span>✓ 已确认混音版本（峰值 {{ Math.min(1, peak || 0).toFixed(2) }}）</span>
      <audio ref="audioEl" :src="audioUrl" controls preload="none"></audio>
      <button type="button" class="text-button" data-testid="revert-mix" @click="emit('revert')">撤回到人声选段</button>
    </div>
    <p v-else-if="dirty && !clipRisk" class="mix-dirty">参数或背景已变更，旧混音不会写回；请重新试算并确认后再试听或继续。</p>

    <div class="mix-footer">
      <button type="button" class="text-button" @click="emit('back')">← 返回裁剪</button>
      <button type="button" data-testid="to-analysis" class="acid-button" :disabled="!confirmed" @click="emit('analyze')">用确认后的混音分析情绪 →</button>
    </div>
  </section>
</template>
