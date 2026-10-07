import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import App from '../App.vue';
import type { StudioDependencies } from '../useStudio';
import type { VoiceMeme } from '../../core/models';

function deps(options: { denied?: boolean; peak?: number } = {}): StudioDependencies {
  const works: VoiceMeme[] = [];
  return {
    recorder:{isRecording:false,start:async()=>{if(options.denied)throw new DOMException('denied','NotAllowedError')},stop:async()=>new Blob(['voice'],{type:'audio/webm'})},
    analyzer:{analyze:async()=>({duration:2,features:{loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6}})},
    cropper:{inspect:async()=>({duration:2,needsCrop:false}),crop:async(blob,range)=>({blob,duration:range.end-range.start})},
    mixer:{inspect:async()=>({duration:5}),mix:async(_v,_b,config)=>({blob:new Blob(['mix'],{type:'audio/wav'}),duration:2,peak:(options.peak??0.8)*config.masterGain})},
    renderer:{render:async()=>new Blob(['cover'],{type:'image/png'})},
    repository:{list:async()=>works,save:async(m)=>{works.push(m)},rename:async()=>{},delete:async(id)=>{const i=works.findIndex(w=>w.id===id);if(i>=0)works.splice(i,1)}},
    share:{share:async()=> 'shared'},
  };
}

async function reachMixStage(wrapper: ReturnType<typeof mount>) {
  await wrapper.get('[data-testid="record"]').trigger('click');
  await wrapper.get('[data-testid="stop"]').trigger('click'); await flushPromises();
  await wrapper.get('[data-testid="to-mix"]').trigger('click'); await flushPromises();
}

describe('Voice meme App', () => {
  it('shows the studio stages, time limit and sharing disclosure', () => {
    const wrapper = mount(App,{props:{dependencies:deps()}});
    expect(wrapper.text()).toContain('声音表情包工坊');
    expect(wrapper.text()).toContain('混音');
    expect(wrapper.text()).toContain('00:10 MAX');
    expect(wrapper.text()).toContain('分享链接不包含原始声音');
  });
  it('shows a recoverable microphone permission error', async () => {
    const wrapper=mount(App,{props:{dependencies:deps({denied:true})}}); await wrapper.get('[data-testid="record"]').trigger('click'); await Promise.resolve();
    expect(wrapper.text()).toContain('麦克风权限');
  });
  it('creates, labels, edits and saves a work to the gallery', async () => {
    const wrapper=mount(App,{props:{dependencies:deps()}}); await reachMixStage(wrapper);
    expect(wrapper.text()).toContain('给人声铺一层背景');
    await wrapper.get('[data-testid="skip-mix"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-emotion="温柔姐姐"]').trigger('click'); expect(wrapper.text()).toContain('已手动选择');
    await wrapper.get('[data-testid="to-cover"]').trigger('click'); await wrapper.get('[aria-label="气泡文字"]').setValue('轻轻说一句'); await wrapper.get('[data-testid="save-work"]').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('作品集'); expect(wrapper.text()).toContain('我的声音表情');
  });
  it('warns about clipping and exports the mix only after lowering the whole mix', async () => {
    const wrapper=mount(App,{props:{dependencies:deps({peak:1.6})}}); await reachMixStage(wrapper);
    const input=wrapper.get('[data-testid="bg-input"]');
    Object.defineProperty(input.element,'files',{value:[new File(['bg'],'bg.mp3')],configurable:true});
    await input.trigger('change'); await flushPromises();
    expect(wrapper.text()).toContain('bg.mp3');
    await wrapper.get('[data-testid="preview-mix"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="clip-warning"]').text()).toContain('削波');
    expect((wrapper.get('[data-testid="confirm-mix"]').element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.get('[data-testid="reduce-gain"]').trigger('click'); await flushPromises();
    expect(wrapper.find('[data-testid="clip-warning"]').exists()).toBe(false);
    await wrapper.get('[data-testid="confirm-mix"]').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('这段声音，有点像');
  });
});
