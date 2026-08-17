import { test, expect } from '@playwright/test';

test('新增持股表單輸入多位數時不會失焦或漏字', async ({ page, context }) => {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('risk-disclaimer-accepted', '1');
      localStorage.setItem('feature-guide-seen', '1');
    } catch {}
  });

  await page.goto('/agents/portfolio');
  await page.getByRole('button', { name: '+ 新增', exact: true }).click();

  const symbol = page.getByRole('textbox', { name: '股票代號 *' });
  await symbol.pressSequentially('2330.TW');
  await expect(symbol).toHaveValue('2330.TW');
  await expect(symbol).toBeFocused();

  const entryPrice = page.getByRole('spinbutton', { name: '進場價 *' });
  await entryPrice.pressSequentially('215');
  await expect(entryPrice).toHaveValue('215');
  await expect(entryPrice).toBeFocused();
});
