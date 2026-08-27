import { expect, test } from '@playwright/test';

test.describe('Tide Pro 重建頁', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      localStorage.setItem('risk-disclaimer-accepted', '1');
      localStorage.setItem('feature-guide-seen', '1');
      localStorage.removeItem('tide-clone-watchlist');
      localStorage.removeItem('tide-clone-watch-folders');
      localStorage.removeItem('tide-clone-watch-folder-map');
      localStorage.removeItem('tide-clone-watch-width');
      localStorage.removeItem('tide-clone-alerts');
      localStorage.setItem('tide-clone-guide-seen', '1');
      localStorage.removeItem('tide-clone-signed-in');
    });
  });

  test('泡泡圖、說明、回放、排行榜與 Pro 分頁可用', async ({ page }) => {
    await page.goto('/tide');
    await expect(page.getByRole('img', { name: '台股市場題材法人資金泡泡圖' })).toBeVisible();
    await expect(page.getByRole('button', { name: '顯示全部 38 個' })).toBeVisible();
    await page.getByRole('button', { name: '顯示全部 38 個' }).click();
    await expect(page.getByRole('button', { name: '只看熱門 15' })).toBeVisible();
    await page.getByRole('button', { name: '只看熱門 15' }).click();

    await page.getByRole('button', { name: /記憶體，/ }).click();
    await expect(page.getByRole('region', { name: '記憶體 題材摘要' })).toBeVisible();
    await page.getByRole('button', { name: '關閉題材摘要' }).click();

    await page.getByRole('button', { name: '怎麼看這張圖' }).click();
    await expect(page.getByText('所以右上角＝買最多、還在加速')).toBeVisible();
    await page.getByRole('button', { name: '怎麼看這張圖' }).click();

    await page.getByRole('button', { name: '回放', exact: true }).click();
    const replay = page.getByRole('dialog', { name: '市場題材資金輪動回放' });
    await expect(replay.getByRole('slider', { name: '回放進度' })).toBeVisible();
    await replay.getByRole('button', { name: /選題材/ }).click();
    await expect(replay.getByPlaceholder('搜尋題材…')).toBeVisible();
    await replay.getByRole('button', { name: /選題材/ }).click();
    await replay.getByRole('button', { name: '播放速度' }).click();
    await expect(replay.getByRole('button', { name: '播放速度' })).toHaveText('2x');
    await replay.getByRole('button', { name: '關閉回放' }).click();

    await page.getByRole('button', { name: '題材泡泡圖', exact: true }).click();
    await page.getByRole('menuitem', { name: '題材排行榜', exact: true }).click();
    await expect(page.getByRole('button', { name: '法人動向', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '個股異常', exact: true }).click();
    await expect(page.getByRole('button', { name: '爆買', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '外資投信', exact: true }).click();
    for (const tab of ['同買', '同賣', '連買', '連賣']) await expect(page.getByRole('button', { name: tab, exact: true })).toBeVisible();
  });

  test('今日重點使用當日題材、前一交易日回顧與大戶異常規則', async ({ page }) => {
    await page.goto('/tide');
    await page.getByRole('button', { name: '今日重點', exact: true }).click();
    const highlights = page.getByRole('region', { name: '今日盤面重點' });
    await expect(highlights).toContainText('HBM 高頻寬記憶體 +348億');
    await expect(highlights).toContainText('記憶體模組 +228億');
    await expect(highlights).toContainText('CXL 技術 +227億');
    await expect(highlights).toContainText('回顧：08/26 法人買最多的 3 個板塊');
    await expect(highlights).toContainText('景碩 被買 44億');
    await expect(highlights).toContainText('力成 被倒 40億');
    await expect(highlights.getByRole('button', { name: /AI 盤後總結/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(highlights).toContainText('賣壓集中在 封測代工、Edge AI AIoT、被動元件 MLCC');
  });

  test('個股 Pro 深度、自選與不限檔提醒可互動', async ({ page }) => {
    await page.goto('/tide');
    await page.getByPlaceholder('搜尋股票或板塊...').fill('2330');
    await page.getByRole('listbox').getByRole('button').first().click();

    const drawer = page.getByRole('dialog', { name: /台積電 Pro 籌碼詳情/ });
    await expect(drawer.getByText('法人分項深度', { exact: true })).toBeVisible();
    await expect(drawer.getByText('近 30 日股價走勢', { exact: true })).toBeVisible();
    await expect(drawer.getByText('個股歷史回看', { exact: true })).toBeVisible();

    await drawer.getByRole('button', { name: '加入自選', exact: true }).click();
    await drawer.getByRole('button', { name: '籌碼提醒', exact: true }).click();
    await expect(drawer.getByRole('button', { name: '從自選移除', exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: '提醒已開啟', exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: '從自選移除', exact: true }).click();
    await expect(drawer.getByRole('button', { name: '加入自選', exact: true })).toBeVisible();
  });

  test('觀察清單以搜尋方式加入股票', async ({ page }) => {
    await page.goto('/tide');
    await page.getByRole('button', { name: '新增自選資料夾' }).click();
    await page.getByRole('textbox', { name: '資料夾名稱' }).fill('追蹤名單');
    await page.getByRole('button', { name: '建立' }).click();
    await expect(page.getByRole('navigation', { name: '自選資料夾' }).getByRole('button', { name: /追蹤名單/ })).toBeVisible();
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await page.getByPlaceholder('股票代碼 / 名稱').fill('2454');
    await page.getByRole('button', { name: /2454 聯發科/ }).click();
    await expect(page.getByRole('complementary').getByRole('button', { name: /2454 聯發科/ })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '自選資料夾' }).getByRole('button', { name: /追蹤名單 1/ })).toBeVisible();
    const resizer = page.getByRole('separator', { name: '調整自選清單寬度' });
    await resizer.focus();
    await resizer.press('ArrowLeft');
    await expect(resizer).toHaveAttribute('aria-valuenow', '320');
  });

  test('手機版不產生整頁水平捲動', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tide');
    const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(hasOverflow).toBe(false);
    await expect(page.getByRole('navigation', { name: '手機版主要導覽' })).toBeVisible();
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '⚙️ 設定' });
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('button', { name: '展開半導體供應鏈' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });

  test('登入、設定、通知與會員流程可用', async ({ page }) => {
    await page.goto('/tide');
    await page.getByRole('button', { name: /^多 \d+%$/ }).click();
    await page.getByRole('dialog', { name: '你覺得明天大盤會…' }).getByRole('button', { name: '看多' }).click();
    await expect(page.getByRole('dialog', { name: '歡迎登入' })).toBeVisible();
    await page.getByRole('button', { name: '使用 Google 登入' }).click();
    await expect(page.getByText('已登入本機示範帳號')).toBeVisible();

    await page.getByRole('button', { name: '設定', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '⚙️ 設定' });
    await expect(settings.getByText('漲跌顏色', { exact: true })).toBeVisible();
    await expect(settings.getByText('通知設定', { exact: true })).toBeVisible();
    await settings.getByRole('button', { name: '展開半導體供應鏈' }).click();
    await expect(settings.getByText('記憶體', { exact: true })).toBeVisible();
    await settings.getByRole('checkbox', { name: /記憶體 \d+ 檔/ }).uncheck();
    await expect(settings.getByText('9/10', { exact: true })).toBeVisible();
    await settings.getByRole('checkbox', { name: '半導體供應鏈全部顯示' }).check();
    await expect(settings.getByRole('checkbox', { name: /記憶體 \d+ 檔/ })).toBeChecked();
    await settings.getByRole('button', { name: '暗色', exact: true }).click();
    await settings.getByRole('button', { name: '許願池', exact: true }).click();
    const wish = page.getByRole('dialog', { name: '許願池' });
    await expect(wish.getByRole('button', { name: '選一張截圖' })).toBeVisible();
    await wish.getByTestId('wish-screenshot-input').setInputFiles({ name: 'feedback.png', mimeType: 'image/png', buffer: Buffer.from('feedback') });
    await expect(wish.getByRole('img', { name: '截圖預覽' })).toBeVisible();
    await wish.getByRole('button', { name: '移除截圖' }).click();
    await expect(wish.getByRole('button', { name: '選一張截圖' })).toBeVisible();
    await wish.getByRole('button', { name: '關閉許願池' }).click();

    await page.getByRole('button', { name: '籌碼異動提醒', exact: true }).click();
    const alerts = page.getByRole('dialog', { name: '籌碼異動提醒' });
    await alerts.getByRole('tab', { name: '通知欄', exact: true }).click();
    await expect(alerts.getByText('還沒有監控任何股票')).toBeVisible();
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
      await expect(page.getByRole('link', { name: '回 Tide 台股資金潮汐' })).toBeVisible();
    }
  });
});
