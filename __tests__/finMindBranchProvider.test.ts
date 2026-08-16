import { classifyFinMindBranchResponse } from '@/lib/datasource/FinMindBranchProvider';

describe('FinMind branch source status', () => {
  it('把會員層級拒絕辨識為永久權限問題', () => {
    expect(classifyFinMindBranchResponse({
      status: 400,
      msg: 'Your level is register. Please update your user level.',
    }).kind).toBe('permission_denied');
  });

  it('把限流和成功分開，避免誤觸永久短路', () => {
    expect(classifyFinMindBranchResponse({ status: 402, msg: 'rate limit' }).kind).toBe('rate_limited');
    expect(classifyFinMindBranchResponse({ status: 200, msg: 'success' }).kind).toBe('ok');
  });
});
