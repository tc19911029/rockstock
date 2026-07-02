/**
 * Contract test: 關鍵幀 OCR 初篩（keyframeScreen）
 *
 * 守門員：
 *   - 代號命中需通過 stock-master 驗證（不存在的 4 位數不算）
 *   - 年份歧義（1900-2099 段代號如 2002 中鋼）需 ±6 字內有對應股名才算
 *   - 股名 substring 命中（長名優先）
 *   - 純關鍵字 ≥2 個才留；talking head（<6 字）一律丟
 *   - scoreFrame：逐字稿沒有的代號（novel）加重
 *   - selectTopImages：每影片上限 + 10 分鐘 bucket 分散 + 全日上限
 *   - transcriptWindow：±45s 邊界
 */

import { buildTestMaster } from '@/lib/youtube/stockMaster';
import {
  buildScreenMaster, codeContextConfident, screenFrame, scoreFrame, selectTopImages, transcriptWindow,
} from '@/lib/youtube/keyframeScreen';

// 注意：buildTestMaster 對 ALIAS_MAP 已有的代號（如 3661 世芯）會略過 extras，
// 故 -KY 長名測試用一個不在 ALIAS_MAP 的代號（9962 假想-KY）。
const master = buildTestMaster([
  { code: '2330', name: '台積電', market: 'TWSE' },
  { code: '9962', name: '假想-KY', market: 'TWSE' },
  { code: '2002', name: '中鋼', market: 'TWSE' },
  { code: '8069', name: '元太', market: 'TPEx' },
]);
const sm = buildScreenMaster(master);

describe('screenFrame', () => {
  it('master 內代號 → keep + code 命中', () => {
    const r = screenFrame('今日推薦 2330 站上月線', sm);
    expect(r.keep).toBe(true);
    expect(r.hit_codes).toEqual(['2330']);
    expect(r.hit_reasons).toContain('code:2330');
  });

  it('不存在於 master 的 4 位數 → 不算代號', () => {
    const r = screenFrame('編號 7777 不是股票喔', sm);
    expect(r.hit_codes).toEqual([]);
  });

  it('年份歧義：「2002年以來」無股名佐證 → 不算；「2002 中鋼」→ 算', () => {
    const noName = screenFrame('自 2002 年以來最大漲幅統計表', sm);
    expect(noName.hit_codes).toEqual([]);
    const withName = screenFrame('鋼鐵股 2002 中鋼 出量', sm);
    expect(withName.hit_codes).toEqual(['2002']);
  });

  it('股名 substring 命中（含 -KY 長名，長名優先不被短 alias 蓋掉）', () => {
    const r = screenFrame('IC 設計族群：假想-KY 與台積電動能延續', sm);
    expect(r.keep).toBe(true);
    expect(r.hit_names.sort()).toEqual(['假想-KY', '台積電'].sort());
  });

  it('純關鍵字 1 個不留、2 個留', () => {
    expect(screenFrame('現在來看一下目標價的部分如何', sm).keep).toBe(false);
    expect(screenFrame('目標價與停損的設定原則說明', sm).keep).toBe(true);
  });

  it('talking head（<6 字）一律丟', () => {
    expect(screenFrame('你好', sm).keep).toBe(false);
    expect(screenFrame('', sm).keep).toBe(false);
  });

  it('陸股 6 位代號記錄為 cn_code 且可獨立成立 keep', () => {
    const r = screenFrame('滬深核心：600519 貴州茅台', sm);
    expect(r.keep).toBe(true);
    expect(r.hit_reasons).toContain('cn_code:600519');
    expect(r.hit_codes).toEqual([]);  // 不進台股 hit_codes
  });

  it('小數/百分比上下文不誤判代號（如 1250.5）', () => {
    const r = screenFrame('目標價 1250.5 元附近、漲幅 2330% 不可能', sm);
    expect(r.hit_codes).toEqual([]);
  });

  it('價格/點數上下文剔除：震N點、收盤價+漲幅、N年（2026-06-12 盤面 OCR 誤判修正）', () => {
    // 2330 等代號若出現在價格語境不算命中（即使代號存在於 master）
    expect(screenFrame('台股上下震2330點！歷史紀錄', sm).hit_codes).toEqual([]);
    expect(screenFrame('個股 收盤 台積電 2330 +13.4% 月營收創高', sm).hit_codes).toEqual([]);
    expect(screenFrame('預估 2330年 才會發生', sm).hit_codes).toEqual([]);
    // 乾淨語境照常命中
    expect(screenFrame('今日推薦 2330 站上月線', sm).hit_codes).toEqual(['2330']);
  });
});

describe('codeContextConfident（audit FAIL 門檻）', () => {
  it('（代號）括號格式 → 高信心；股名 ±10 字相鄰 → 高信心；裸代號 → 否', () => {
    expect(codeContextConfident('（2330）台積電日線圖 開盤價', '2330', sm)).toBe(true);
    expect(codeContextConfident('代號 2330 個股 台積電 出關日', '2330', sm)).toBe(true);
    expect(codeContextConfident('近5日台指期外資 2330 留倉 -69146', '2330', sm)).toBe(false);
  });
});

describe('scoreFrame', () => {
  const base = { ocr_confidence: 0.9, hit_names: [], hit_reasons: [] };

  it('novel 代號（逐字稿沒有）比已唸出的代號分數高', () => {
    const novel = scoreFrame({ ...base, ocr_text: '2330', hit_codes: ['2330'] }, '老師只講了台積電沒唸代號');
    const spoken = scoreFrame({ ...base, ocr_text: '2330', hit_codes: ['2330'] }, '逐字稿有 2330 喔');
    expect(novel).toBeGreaterThan(spoken);
    expect(novel - spoken).toBeCloseTo(4, 5);
  });

  it('長文字（密集表格）+2', () => {
    const short = scoreFrame({ ...base, ocr_text: 'x'.repeat(50), hit_codes: [] }, '');
    const long = scoreFrame({ ...base, ocr_text: 'x'.repeat(100), hit_codes: [] }, '');
    expect(long - short).toBeCloseTo(2, 5);
  });
});

describe('selectTopImages', () => {
  it('每影片 perVideo 上限 + 同 10 分鐘 bucket 最多 2 張', () => {
    // 5 張全在 0-10 分鐘內（bucket 0），分數遞減 → 只能取 2 張
    const frames = [0, 1, 2, 3, 4].map(i => ({ video_id: 'v1', ts: 60 * i, score: 10 - i }));
    const picked = selectTopImages(frames, 5, 40);
    expect(picked.size).toBe(2);
    expect(picked.has('v1:0')).toBe(true);
    expect(picked.has('v1:60')).toBe(true);
  });

  it('跨 bucket 可取滿 perVideo；全日 globalCap 修剪低分', () => {
    // v1：5 張分散 5 個 bucket → 取滿 5；v2：3 張高分 → globalCap=6 時 v1 低分被剪
    const v1 = [0, 1, 2, 3, 4].map(i => ({ video_id: 'v1', ts: 700 * i, score: 5 - i }));
    const v2 = [0, 1, 2].map(i => ({ video_id: 'v2', ts: 700 * i, score: 100 - i }));
    const picked = selectTopImages([...v1, ...v2], 5, 6);
    expect(picked.size).toBe(6);
    expect(picked.has('v2:0')).toBe(true);
    expect(picked.has('v1:2800')).toBe(false);  // v1 最低分被全日 cap 剪掉
  });
});

describe('transcriptWindow', () => {
  const cues = [
    { start: 0, end: 5, text: '開場' },
    { start: 100, end: 105, text: '看好世芯' },
    { start: 130, end: 135, text: '目標價三千二' },
    { start: 200, end: 205, text: '下一檔' },
  ];

  it('±45s 內的 cue 才收（邊界含等於）', () => {
    const w = transcriptWindow(cues, 120, 45);
    expect(w).toContain('看好世芯');
    expect(w).toContain('目標價三千二');
    expect(w).not.toContain('開場');
    expect(w).not.toContain('下一檔');
  });

  it('超過 maxChars 截斷加省略號', () => {
    const long = [{ start: 100, end: 105, text: 'A'.repeat(500) }];
    const w = transcriptWindow(long, 100, 45, 100);
    expect(w.length).toBe(101);  // 100 + '…'
    expect(w.endsWith('…')).toBe(true);
  });

  it('空 cues → 空字串', () => {
    expect(transcriptWindow(null, 100)).toBe('');
    expect(transcriptWindow([], 100)).toBe('');
  });
});
