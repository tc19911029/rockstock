import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('local cron append-from-snapshot wiring', () => {
  const source = readFileSync(path.join(process.cwd(), 'instrumentation.node.ts'), 'utf8');

  test('延後到 CN 15:45 封存時會明確跳過 route 的 15:30 一般窗口', () => {
    expect(source).toContain('/api/cron/append-from-snapshot?market=${market}&force=1');
  });

  test('route 回 skipped 不得寫入每日完成帳本', () => {
    expect(source).toMatch(/if \(payload\.skipped\)[\s\S]*l1SnapshotDone\[market\] = ''/);
  });
});
