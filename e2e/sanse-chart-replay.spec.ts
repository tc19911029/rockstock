/**
 * 三色走圖 time-scale compaction 回歸測試。
 *
 * lightweight-charts <= 5.2.0 在多序列縮短且 crosshair 仍 hover 舊資料點時，
 * 可能拋出 `Value is null`。這支測試刻意把滑鼠留在 canvas 上並連續往前走圖。
 */

import { expect, test, type Page } from '@playwright/test';

function watchChartErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Value is null|ErrorBoundary|載入失敗/i.test(text)) {
      errors.push(`console: ${text.slice(0, 300)}`);
    }
  });
  return errors;
}

test.describe('三色走圖副圖穩定性', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try {
        localStorage.setItem('risk-disclaimer-accepted', '1');
        localStorage.setItem('feature-guide-seen', '1');
      } catch {}
    });
  });

  test('聯亞：crosshair 懸停時連續往前走圖不會出現 Value is null', async ({ page }) => {
    const errors = watchChartErrors(page);
    await page.goto('/?load=3081.TWO');
    await expect(page.getByText('聯亞').first()).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: '三色', exact: true }).click();
    await expect(page.getByText('主力狀態F').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('捕撈季節').first()).toBeVisible({ timeout: 15_000 });

    const mainCanvas = page.locator('canvas').first();
    // lightweight-charts 疊有多層 canvas；force 讓滑鼠落在指定座標，不受上層 canvas 擋住。
    await mainCanvas.hover({ position: { x: 240, y: 120 }, force: true });
    for (let i = 0; i < 24; i += 1) {
      await page.keyboard.press('ArrowLeft');
    }
    await page.waitForTimeout(1_500);

    await expect(page.getByText(/載入失敗/)).toHaveCount(0);
    await expect(page.getByText('主力狀態F').first()).toBeVisible();
    await expect(page.getByText('捕撈季節').first()).toBeVisible();
    expect(errors, errors.join('\n')).toHaveLength(0);
  });
});
