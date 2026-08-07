import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLatestValuation } from '@/lib/valuation/storage';

describe('readLatestValuation', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rockstock-valuation-'));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  async function writeValuation(date: string, symbol: string, marker: string) {
    const dir = path.join(rootDir, date);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${symbol}.json`), JSON.stringify({ marker }));
  }

  it('優先讀取指定日資料', async () => {
    await writeValuation('2026-08-06', '3081', 'old');
    await writeValuation('2026-08-07', '3081', 'exact');

    const result = await readLatestValuation<{ marker: string }>({
      rootDir,
      symbol: '3081',
      targetDate: '2026-08-07',
    });

    expect(result).toMatchObject({ date: '2026-08-07', ageDays: 0, valuation: { marker: 'exact' } });
    expect(result?.fellBackFrom).toBeUndefined();
  });

  it('不受七天限制，回傳指定日以前最近一份並計算天數', async () => {
    await writeValuation('2026-06-04', '3081', 'latest-before-target');
    await writeValuation('2026-08-08', '3081', 'future');

    const result = await readLatestValuation<{ marker: string }>({
      rootDir,
      symbol: '3081',
      targetDate: '2026-08-07',
    });

    expect(result).toMatchObject({
      date: '2026-06-04',
      requestedDate: '2026-08-07',
      fellBackFrom: '2026-08-07',
      ageDays: 64,
      valuation: { marker: 'latest-before-target' },
    });
  });

  it('找不到該股票時回傳 null', async () => {
    await writeValuation('2026-08-07', '3006', 'another-stock');

    await expect(readLatestValuation({
      rootDir,
      symbol: '3081',
      targetDate: '2026-08-07',
    })).resolves.toBeNull();
  });
});
