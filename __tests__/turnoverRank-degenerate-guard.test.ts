/**
 * TurnoverRank 退化守衛測試
 *
 * 背景（2026-06-12 事故）：TPEx 整夜不通時 getStockList 回上市-only 清單，
 * buildTurnoverRank 照建出「0 檔 .TWO」的索引且 date 已是新一天 →
 * needsRebuild 整天不觸發，所有掃描把整個上櫃市場排除在 universe 外
 * （3236 千如 06-11 六條件 6/6 全過卻沒被掃出）。
 *
 * 鎖住的不變量：
 *   1. TW 重建結果 top500 內 .TWO < 30 → 視為退化，拒絕覆蓋既有索引（不寫檔）
 *   2. 退化時回傳既有索引（date 不變 → 下次掃描仍會重試重建，來源恢復即自我修復）
 *   3. 退化且無既有索引可退回 → throw（fail-closed，ScanPipeline 會 abort 掃描）
 *   4. 健康清單照常寫檔
 *   5. CN：滬/深任一整片消失同樣退化
 */
import { promises as fsPromises } from 'fs';
import { buildTurnoverRank } from '@/lib/scanner/TurnoverRank';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';

jest.mock('@/lib/datasource/CandleStorageAdapter', () => ({
  readCandleFile: jest.fn(),
}));
jest.mock('@/lib/storage/atomicFsPut', () => ({
  atomicFsPut: jest.fn().mockResolvedValue(undefined),
}));

const mockReadCandleFile = readCandleFile as jest.MockedFunction<typeof readCandleFile>;
const mockAtomicFsPut = atomicFsPut as jest.MockedFunction<typeof atomicFsPut>;

/** 25 根合法日K（close > 5 元、有量），餵滿 MIN_VALID_DAYS/AVG_WINDOW */
function fakeCandleFile(symbol: string) {
  const candles = Array.from({ length: 25 }, (_, i) => {
    const date = `2026-05-${String(i + 1).padStart(2, '0')}`;
    return { date, open: 50, high: 51, low: 49, close: 50, volume: 1000 + i };
  });
  return { symbol, lastDate: candles[candles.length - 1].date, updatedAt: '', candles };
}

function symbols(prefixCount: Record<string, number>): { symbol: string }[] {
  const out: { symbol: string }[] = [];
  for (const [suffix, count] of Object.entries(prefixCount)) {
    for (let i = 0; i < count; i++) {
      out.push({ symbol: `${1000 + out.length}${suffix}` });
    }
  }
  return out;
}

const HEALTHY_EXISTING_INDEX = {
  market: 'TW',
  date: '2026-06-11',
  generatedAt: '2026-06-11T08:00:00.000Z',
  topN: 500,
  symbols: ['2330.TW', '3236.TWO'],
};

describe('TurnoverRank 退化守衛', () => {
  let readFileSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReadCandleFile.mockImplementation(async (symbol) => fakeCandleFile(symbol) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // readIndexRaw 走 fs.promises.readFile（local 路徑）
    readFileSpy = jest
      .spyOn(fsPromises, 'readFile')
      .mockResolvedValue(JSON.stringify(HEALTHY_EXISTING_INDEX) as never);
  });

  afterEach(() => {
    readFileSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('TW 清單沒有 .TWO → 拒絕覆蓋，回傳既有索引', async () => {
    const result = await buildTurnoverRank('TW', symbols({ '.TW': 200 }), 500);

    expect(mockAtomicFsPut).not.toHaveBeenCalled();          // 不寫壞索引
    expect(result.date).toBe('2026-06-11');                  // 回傳的是既有索引
    expect(result.symbols).toContain('3236.TWO');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('退化'));
  });

  test('TW .TWO 不足下限（< 30）也算退化', async () => {
    const result = await buildTurnoverRank('TW', symbols({ '.TW': 200, '.TWO': 10 }), 500);
    expect(mockAtomicFsPut).not.toHaveBeenCalled();
    expect(result.date).toBe('2026-06-11');
  });

  test('TW 退化且無既有索引 → throw（fail-closed）', async () => {
    readFileSpy.mockRejectedValue(new Error('ENOENT'));
    await expect(buildTurnoverRank('TW', symbols({ '.TW': 200 }), 500))
      .rejects.toThrow('退化');
    expect(mockAtomicFsPut).not.toHaveBeenCalled();
  });

  test('TW 健康清單（.TWO ≥ 30）照常寫檔', async () => {
    const result = await buildTurnoverRank('TW', symbols({ '.TW': 200, '.TWO': 60 }), 500);

    expect(mockAtomicFsPut).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockAtomicFsPut.mock.calls[0][1] as string);
    expect(written.symbols.filter((s: string) => s.endsWith('.TWO')).length).toBe(60);
    expect(result.symbols.length).toBe(260);
  });

  test('小 topN（研究/測試用）不套守衛', async () => {
    await buildTurnoverRank('TW', symbols({ '.TW': 50 }), 10);
    expect(mockAtomicFsPut).toHaveBeenCalledTimes(1);
  });

  test('CN 缺整個深市（.SZ=0）→ 退化', async () => {
    const result = await buildTurnoverRank('CN', symbols({ '.SS': 200 }), 500);
    expect(mockAtomicFsPut).not.toHaveBeenCalled();
    expect(result.date).toBe('2026-06-11'); // 既有索引
  });

  test('CN 滬深都在 → 照常寫檔', async () => {
    await buildTurnoverRank('CN', symbols({ '.SS': 150, '.SZ': 150 }), 500);
    expect(mockAtomicFsPut).toHaveBeenCalledTimes(1);
  });
});
