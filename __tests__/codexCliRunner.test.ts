import { buildCodexExecArgs } from '@/lib/ai/codexCliRunner';

describe('Codex CLI runner', () => {
  test('使用 ephemeral + read-only，且不開啟自動寫入權限', () => {
    const args = buildCodexExecArgs({
      projectRoot: '/repo',
      prompt: 'analyze',
      outputFile: '/tmp/out.txt',
      outputSchema: '/repo/schema.json',
      imagePaths: ['/tmp/chart.png'],
    });

    expect(args).toEqual([
      'exec', '--ephemeral', '--sandbox', 'read-only',
      '-C', '/repo',
      '--image', '/tmp/chart.png',
      '-o', '/tmp/out.txt',
      '--output-schema', '/repo/schema.json',
      'analyze',
    ]);
    expect(args).not.toContain('danger-full-access');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  test('沒有截圖與 schema 時不加入多餘參數', () => {
    const args = buildCodexExecArgs({
      projectRoot: '/repo',
      prompt: 'follow up',
      outputFile: '/tmp/out.txt',
    });

    expect(args).not.toContain('--image');
    expect(args).not.toContain('--output-schema');
    expect(args.at(-1)).toBe('follow up');
  });
});
