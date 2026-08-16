const triggerSkillKeystroke = jest.fn();

jest.mock('@/lib/ai/skillAutoTrigger', () => ({
  triggerSkillKeystroke: (...args: unknown[]) => triggerSkillKeystroke(...args),
}));

import { triggerZhuKeystroke } from '@/lib/ai/zhuAutoTrigger';

describe('triggerZhuKeystroke', () => {
  test('委派給共用且已處理 Terminal/iTerm 差異的 skill runner', async () => {
    triggerSkillKeystroke.mockResolvedValue({ ok: true, detail: 'queued' });

    await expect(triggerZhuKeystroke()).resolves.toEqual({ ok: true, detail: 'queued' });
    expect(triggerSkillKeystroke).toHaveBeenCalledWith('/zhu');
  });
});
