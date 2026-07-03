/**
 * phoneticMatch — Whisper 同音誤植拼音偵測
 *
 * 真實案例迴歸：2026-07-02 理財達人秀「台聚集團」被 Whisper 寫成「台劇集團」，
 * 字面 grep 查無 → 語音端整段看多被漏。
 */

import { findPhoneticHits, chineseCore, estimateCueTime } from '@/lib/youtube/phoneticMatch';

describe('findPhoneticHits', () => {
  it('台聚 → 逐字稿「台劇」（2026-07-02 實例）', () => {
    const transcript = '再來就是呢 台劇集團裡面 可以發現到 最近他們的骨架 也都是非常非常的漂亮 所以我覺得目前看起來 台劇他就是比較是屬於 最壞時間已經過去的';
    const hits = findPhoneticHits('台聚', transcript);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].form).toBe('台劇');
    expect(hits[0].count).toBe(2);
    expect(hits[0].context).toContain('台劇集團');
  });

  it('亞聚 → 逐字稿「雅劇」（2026-07-02 實例）', () => {
    const transcript = '另外一家呢 在也是同集團當中的雅劇 也是一樣可以發現到 他在LDP的相關的這個產品';
    const hits = findPhoneticHits('亞聚', transcript);
    expect(hits.map(h => h.form)).toContain('雅劇');
  });

  it('晶豪科 → 「金豪科」（ng/n 韻尾混淆要能蓋到）', () => {
    const hits = findPhoneticHits('晶豪科', '記憶體族群的金豪科今天也是漲停');
    expect(hits.map(h => h.form)).toContain('金豪科');
  });

  it('力積電 → 「立基電」', () => {
    const hits = findPhoneticHits('力積電', '晶圓代工的立基電 銅鑼廠賣美光');
    expect(hits.map(h => h.form)).toContain('立基電');
  });

  it('字面完全相同（本尊）不算嫌疑', () => {
    const hits = findPhoneticHits('台聚', '今天台聚漲了 台聚很強');
    expect(hits).toHaveLength(0);
  });

  it('不同音不誤報', () => {
    const hits = findPhoneticHits('台聚', '今天台北的天氣很好 台股大漲');
    expect(hits).toHaveLength(0);
  });

  it('空逐字稿/單字股名回空', () => {
    expect(findPhoneticHits('台聚', '')).toHaveLength(0);
    expect(findPhoneticHits('聚', '台劇')).toHaveLength(0);
  });
});

describe('chineseCore', () => {
  it('剝掉 -KY / 英數尾綴', () => {
    expect(chineseCore('臻鼎-KY')).toBe('臻鼎');
    expect(chineseCore('台聚')).toBe('台聚');
  });
});

describe('estimateCueTime', () => {
  it('由字元位置估 cue 秒數（join 空白座標系）', () => {
    const cues = [
      { start: 0, text: '第一句五個字' },
      { start: 10, text: '第二句' },
      { start: 20, text: '第三句' },
    ];
    expect(estimateCueTime(cues, 0)).toBe(0);
    expect(estimateCueTime(cues, 8)).toBe(10);  // 6字+1空白後進第二句
    expect(estimateCueTime(cues, 999)).toBe(20); // 超界回最後 cue
    expect(estimateCueTime(null, 5)).toBeNull();
  });
});
