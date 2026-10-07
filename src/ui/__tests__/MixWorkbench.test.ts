import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import MixWorkbench from '../components/MixWorkbench.vue';
import { DEFAULT_MIX_SETTINGS } from '../../core/mixing-engine';

function mountBench(overrides: Record<string, unknown> = {}) {
  const props = {
    voiceDuration: 2,
    backgroundName: '',
    backgroundDuration: 0,
    settings: { ...DEFAULT_MIX_SETTINGS },
    confirmed: false,
    dirty: false,
    clipRisk: false,
    peak: 0,
    previewing: false,
    audioUrl: '',
    ...overrides,
  };
  return mount(MixWorkbench, { props });
}

describe('MixWorkbench', () => {
  it('imports a background and exposes start offset, loop and volume controls', async () => {
    const wrapper = mountBench({ backgroundName: 'beat.mp3', backgroundDuration: 4 });
    expect(wrapper.text()).toContain('beat.mp3');
    const inputs = wrapper.findAll('input[type=range]');
    expect(inputs.length).toBeGreaterThanOrEqual(4);
    await wrapper.findAll('input[type=range]')[0]!.setValue('1.2');
    const patch = wrapper.emitted('patch')!.at(-1) as unknown as Partial<typeof DEFAULT_MIX_SETTINGS>[];
    expect(patch[0]).toMatchObject({ startOffset: 1.2 });
    await wrapper.find('input[type=checkbox]').setValue(false);
    expect(wrapper.emitted('patch')!.at(-1)?.[0]).toMatchObject({ loop: false });
  });
  it('blocks continuing to analysis until the mix is confirmed', () => {
    const wrapper = mountBench({ confirmed: false });
    const button = wrapper.get('[data-testid="to-analysis"]');
    expect(button.attributes('disabled')).toBeDefined();
  });
  it('shows clipping risk and offers overall lowering, not per-track truncation', async () => {
    const wrapper = mountBench({ backgroundName: 'b.mp3', backgroundDuration: 2, clipRisk: true, peak: 1.4 });
    expect(wrapper.text()).toContain('削波风险');
    expect(wrapper.text()).toContain('整体等比降低');
    await wrapper.get('[data-testid="lower-overall"]').trigger('click');
    const emitted = wrapper.emitted('confirm')!.at(-1);
    expect(emitted?.[0]).toBe(true);
  });
  it('plays only the confirmed mix and can revert to the voice selection', async () => {
    const wrapper = mountBench({ backgroundName: 'b.mp3', backgroundDuration: 2, confirmed: true, peak: .6, audioUrl: 'blob:confirmed' });
    const audio = wrapper.get('audio');
    expect(audio.attributes('src')).toBe('blob:confirmed');
    expect(wrapper.text()).toContain('已确认混音版本');
    await wrapper.get('[data-testid="revert-mix"]').trigger('click');
    expect(wrapper.emitted('revert')).toBeTruthy();
  });
});
