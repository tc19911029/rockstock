import { expect, test } from '@playwright/test';

test.describe('Tide Pro 重建頁', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      localStorage.setItem('risk-disclaimer-accepted', '1');
      localStorage.setItem('feature-guide-seen', '1');
      localStorage.removeItem('tide-clone-watchlist');
      localStorage.removeItem('tide-clone-alerts');
    });
  });

  test('泡泡圖與 Pro 分頁可用', async ({ page }) => {
    await page.goto('/tide');
    await expect(page.getByRole('img', { name: '台股板塊法人資金泡泡圖' })).toBeVisible();
    await expect(page.getByText('Pro 全功能')).toBeVisible();

    for (const tab of ['完整籌碼排行', '外資投信同買賣', '外資連買賣', '籌碼雷達']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
    }
  });

  test('個股 Pro 深度、自選與不限檔提醒可互動', async ({ page }) => {
    await page.goto('/tide');
    await page.getByPlaceholder('搜尋股票或板塊...').fill('2330');
    await page.getByRole('button', { name: /2330 台積電/ }).click();

    const drawer = page.getByRole('dialog', { name: /台積電 Pro 籌碼詳情/ });
    await expect(drawer.getByText('法人分項深度', { exact: true })).toBeVisible();
    await expect(drawer.getByText('近 30 日股價走勢', { exact: true })).toBeVisible();
    await expect(drawer.getByText('個股歷史回看', { exact: true })).toBeVisible();

    await drawer.getByRole('button', { name: '加入自選', exact: true }).click();
    await drawer.getByRole('button', { name: '籌碼提醒', exact: true }).click();
    await expect(drawer.getByRole('button', { name: '已在自選', exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: '提醒已開啟', exact: true })).toBeVisible();
  });

  test('手機版不產生整頁水平捲動', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tide');
    const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(hasOverflow).toBe(false);
  });
});
