/**
 * Contract test：多人持倉 profile 路徑解析（2026-06-04 補）
 *
 * 守的鐵則（加入「誰的持倉」維度後，不可破壞既有資料）：
 *   - 預設 'me' → profileDir 回 null ⇒ 呼叫端走既有 legacy 路徑、**零資料搬遷**
 *   - 其他合法 profile → 隔離在 data/portfolios/{id}/，彼此不同路徑（互不污染）
 *   - 非法 / 空 / 路徑穿越輸入 → resolveProfileId fail-safe 落回 'me'（永不逃出資料夾）
 *
 * 為什麼用純函式測：path 解析是整套隔離的單一收斂點；守住它就守住「朋友的持倉不會
 * 蓋掉我的、外部 ?profile= 不會被當路徑穿越」。CRUD 走 fs，留給手動 / e2e 驗證。
 */

import path from 'node:path';
import {
  DEFAULT_PROFILE_ID,
  isValidProfileId,
  resolveProfileId,
  profileDir,
} from '@/lib/portfolio/profiles';

describe('isValidProfileId', () => {
  test("保留字 'me' 合法", () => {
    expect(isValidProfileId('me')).toBe(true);
  });
  test('p + base36 合法', () => {
    expect(isValidProfileId('pabc12')).toBe(true);
    expect(isValidProfileId('plxk9z7q3a')).toBe(true);
  });
  test('擋掉路徑穿越 / 任意檔名 / 空字串', () => {
    for (const bad of ['', '..', '../../etc/passwd', 'me/../x', 'p', 'P12345', 'holdings.json', 'p abc', 'p!@#']) {
      expect(isValidProfileId(bad)).toBe(false);
    }
  });
});

describe('resolveProfileId — fail-safe 落回 me', () => {
  test('空 / null / undefined → me', () => {
    expect(resolveProfileId(null)).toBe(DEFAULT_PROFILE_ID);
    expect(resolveProfileId(undefined)).toBe(DEFAULT_PROFILE_ID);
    expect(resolveProfileId('')).toBe(DEFAULT_PROFILE_ID);
  });
  test('非法輸入（含路徑穿越）→ me，不會逃出資料夾', () => {
    expect(resolveProfileId('../../etc')).toBe(DEFAULT_PROFILE_ID);
    expect(resolveProfileId('holdings.json')).toBe(DEFAULT_PROFILE_ID);
  });
  test('合法 id 原樣回傳', () => {
    expect(resolveProfileId('pabc12')).toBe('pabc12');
  });
});

describe('profileDir — 隔離 + 零搬遷', () => {
  test("'me' 回 null（呼叫端走既有 legacy 路徑）", () => {
    expect(profileDir('me')).toBeNull();
  });
  test('非法輸入也回 null（當成 me）', () => {
    expect(profileDir('../../etc')).toBeNull();
    expect(profileDir('')).toBeNull();
  });
  test('其他合法 profile 隔離在 data/portfolios/{id}', () => {
    const dir = profileDir('pabc12');
    expect(dir).not.toBeNull();
    expect(dir!.endsWith(path.join('data', 'portfolios', 'pabc12'))).toBe(true);
  });
  test('不同 profile 路徑不同（互不污染）', () => {
    expect(profileDir('pabc12')).not.toBe(profileDir('pxyz99'));
  });
});
