import {
  buildCodexExecArgs,
  CodexUnavailableError,
  DEFAULT_CODEX_TIMEOUT_MS,
  normalizeCodexExecutionError,
} from '@/lib/ai/codexCliRunner';

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

  test('深度分析預設允許執行 20 分鐘', () => {
    expect(DEFAULT_CODEX_TIMEOUT_MS).toBe(20 * 60 * 1000);
  });

  test('只有 child_process 的 ENOENT 才判定 CLI 不存在', () => {
    const spawnError = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
    expect(normalizeCodexExecutionError(spawnError)).toBeInstanceOf(CodexUnavailableError);
  });

  test('分析內容出現 not found 或 ENOENT 不會誤判 CLI 不存在', () => {
    const error = new Error('Codex output: source not found; tool said ENOENT');
    const normalized = normalizeCodexExecutionError(error);

    expect(normalized).not.toBeInstanceOf(CodexUnavailableError);
    expect(normalized.message).toBe('Codex 分析失敗，請稍後重試');
  });

  test('child_process 被 timeout 終止時回報分析逾時', () => {
    const timeoutError = Object.assign(new Error('Command failed'), {
      killed: true,
      signal: 'SIGTERM' as NodeJS.Signals,
    });
    expect(normalizeCodexExecutionError(timeoutError).message)
      .toBe('Codex 分析逾時，請稍後重試');
  });

  test('使用者取消優先於 process signal 分類', () => {
    const abortError = Object.assign(new Error('Command failed'), {
      killed: true,
      signal: 'SIGTERM' as NodeJS.Signals,
    });
    expect(normalizeCodexExecutionError(abortError, true).message)
      .toBe('Codex 分析已取消');
  });
});
