import { expect, test } from '@playwright/test';

test.describe('Tide Pro 重建頁', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      localStorage.setItem('risk-disclaimer-accepted', '1');
      localStorage.setItem('feature-guide-seen', '1');
      localStorage.removeItem('tide-clone-watchlist');
      localStorage.removeItem('tide-clone-alerts');
      localStorage.setItem('tide-clone-guide-seen', '1');
      localStorage.removeItem('tide-clone-signed-in');
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
    await expect(page.getByRole('navigation', { name: '手機版主要導覽' })).toBeVisible();
  });

  test('登入、設定、通知與會員流程可用', async ({ page }) => {
    await page.goto('/tide');
    await page.getByRole('button', { name: '登入', exact: true }).click();
    await page.getByRole('button', { name: '使用 Google 登入（示範）' }).click();
    await expect(page.getByText('已登入本機示範帳號')).toBeVisible();

    await page.getByRole('button', { name: '設定', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '⚙️ 設定' });
    await expect(settings.getByText('漲跌顏色', { exact: true })).toBeVisible();
    await expect(settings.getByText('通知設定', { exact: true })).toBeVisible();
    await settings.getByRole('button', { name: '暗色', exact: true }).click();
    await settings.getByRole('button', { name: '關閉⚙️ 設定' }).click();

    await page.getByRole('button', { name: '籌碼異動提醒', exact: true }).click();
    const alerts = page.getByRole('dialog', { name: '籌碼異動提醒' });
    await alerts.getByRole('tab', { name: '通知欄', exact: true }).click();
    await expect(alerts.getByText('這裡彙整盤後籌碼提醒。')).toBeVisible();
  });

  test('方案、關於、名詞與條款頁完整可達', async ({ page }) => {
    const pages = [
      ['/tide/pricing', '方案與定價'],
      ['/tide/about', '關於本站'],
      ['/tide/glossary', '名詞小百科'],
      ['/tide/legal', '服務條款・隱私權・退款說明'],
    ] as const;
    for (const [url, title] of pages) {
      await page.goto(url);
      await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
      await expect(page.getByRole('link', { name: '回潮汐儀表板' })).toBeVisible();
    }
  });
});
