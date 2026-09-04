/**
 * 0513 ABCDE B4 — 走圖型態鎖定鏈路 E2E 防回歸
 *
 * Catches: 0513 chart pivots-empty crash —
 *   useLockedPattern 命中時 freshSource.pivots = [] → activePattern.pivots = []
 *   → sortedByIndex[0].index 讀 undefined → ErrorBoundary 接住 → 整個走圖消失
 *
 * 這層 Jest + jsdom 抓不到（lightweight-charts Canvas 渲染要真瀏覽器）。
 */

import { test, expect, type Page } from '@playwright/test';

async function mockActiveLockedPattern(
  page: Page,
  market: 'TW' | 'CN',
  record: { symbol: string; patternType: string; triggerPrice: number; patternTargetPrice: number },
) {
  await page.route(`**/api/lockwatch?market=${market}`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    const records = Array.isArray(payload?.snapshot?.records)
      ? payload.snapshot.records.filter((item: { symbol?: string }) => item.symbol !== record.symbol)
      : [];
    await route.fulfill({
      response,
      json: {
        ...payload,
        ok: true,
        snapshot: {
          ...(payload.snapshot ?? {}),
          records: [{
            ...record,
            market,
            triggerSignal: 'N',
            currentStage: 'observation',
            // 直接覆蓋當初造成 Canvas crash 的空腳位案例。
            patternPivots: [],
          }, ...records],
        },
      },
    });
  });
}

test.describe('走圖型態鎖定鏈路', () => {
  test.beforeEach(async ({ context }) => {
    // 風險免責 modal + 功能引導 modal 第一次都擋住點擊，預先接受
    await context.addInitScript(() => {
      try {
        localStorage.setItem('risk-disclaimer-accepted', '1');
        localStorage.setItem('feature-guide-seen', '1');
      } catch {}
    });
  });


  test('TW lockwatch 有效 N 訊號且腳位為空 → 顯示「鎖定」badge、不 crash', async ({ page }) => {
    // 收集 console errors
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (/Cannot read properties|undefined|TypeError|ErrorBoundary/.test(text)) {
          consoleErrors.push(`console.error: ${text.slice(0, 200)}`);
        }
      }
    });

    await mockActiveLockedPattern(page, 'TW', {
      symbol: '2330.TW',
      patternType: 'head-shoulder',
      triggerPrice: 1000,
      patternTargetPrice: 1200,
    });
    await page.goto('/?load=2330.TW');
    // 等股票名稱出現（loaded 完成）
    await expect(page.getByText('台積電').first()).toBeVisible({ timeout: 15_000 });

    // 開「型態分析」：腳位與生命週期價位改由單一控制一起顯示
    const patternBtn = page.locator('button:text-is("型態分析")').first();
    await patternBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await patternBtn.click();
    // 等 chart 重渲染
    await page.waitForTimeout(800);

    // 驗證沒 chart crash
    expect(consoleErrors, `走圖 crash: ${consoleErrors.join('\n')}`).toHaveLength(0);

    // 鎖定狀態應出現（目前完整文案為「觸發日鎖定」）
    await expect(page.getByText(/觸發日鎖定/).first()).toBeVisible();
    // 型態名稱應出現
    await expect(page.locator('text=/複式頭肩底|頭肩底|圓弧底|楔形|雙重底|三重底/').first()).toBeVisible();
  });

  test('CN lockwatch 有效 N 訊號且腳位為空 → 顯示「鎖定」badge、不 crash', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /Cannot read|TypeError/.test(msg.text())) {
        consoleErrors.push(`console.error: ${msg.text().slice(0, 200)}`);
      }
    });

    await mockActiveLockedPattern(page, 'CN', {
      symbol: '000703.SZ',
      patternType: 'rounding-bottom',
      triggerPrice: 12,
      patternTargetPrice: 15,
    });
    await page.goto('/?load=000703.SZ');
    await expect(page.getByText('恒逸石化').first()).toBeVisible({ timeout: 15_000 });

    const patternBtn = page.locator('button:text-is("型態分析")').first();
    await patternBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await patternBtn.click();
    await page.waitForTimeout(800);

    expect(consoleErrors).toHaveLength(0);
    await expect(page.getByText(/觸發日鎖定/).first()).toBeVisible();
  });

  test('無 lockwatch 紀錄股 (2330.TW) → 顯示「即時」badge', async ({ page }) => {
    await page.goto('/?load=2330.TW');
    await expect(page.getByText('台積電').first()).toBeVisible({ timeout: 15_000 });

    const patternBtn = page.locator('button:text-is("型態分析")').first();
    await patternBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await patternBtn.click();
    await page.waitForTimeout(800);

    // 即時狀態應出現（fresh detection mode）
    await expect(page.getByText(/即時候選/).first()).toBeVisible();
  });

  test('價位疊圖互斥：型態分析會關閉頭底與關鍵壓撐', async ({ page }) => {
    await page.goto('/?load=2330.TW');
    await expect(page.getByText('台積電').first()).toBeVisible({ timeout: 15_000 });

    const pivotsBtn = page.locator('button:text-is("頭底")').first();
    const supportBtn = page.locator('button:text-is("關鍵壓撐")').first();
    const patternBtn = page.locator('button:text-is("型態分析")').first();
    await expect(pivotsBtn).toHaveAttribute('aria-pressed', 'true');

    await supportBtn.click();
    await expect(supportBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(pivotsBtn).toHaveAttribute('aria-pressed', 'false');

    await patternBtn.click();
    await expect(patternBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(supportBtn).toHaveAttribute('aria-pressed', 'false');
  });

  test('?symbol= 跟 ?load= 兩種 URL param 都接受', async ({ page }) => {
    await page.goto('/?symbol=2330.TW');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await expect(page.getByText('台積電').first()).toBeVisible({ timeout: 20_000 });
  });
});
