import { test, expect } from '@playwright/test';

test('集保持股分布週次在窄面板以四欄兩列顯示', async ({ page, context }) => {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('risk-disclaimer-accepted', '1');
      localStorage.setItem('feature-guide-seen', '1');
    } catch {}
  });

  await page.goto('/?load=6770.TW');
  await expect(page.getByText('力積電').first()).toBeVisible({ timeout: 20_000 });
  const analysisToggle = page.getByRole('button', { name: /分析面板/ });
  if (await analysisToggle.isVisible()) await analysisToggle.click();
  await page.getByRole('tablist', { name: '分析面板' })
    .getByRole('tab', { name: '籌碼', exact: true })
    .click();

  const weekPicker = page.getByRole('group', { name: '集保持股分布週次' });
  await expect(weekPicker).toBeVisible({ timeout: 20_000 });
  await expect(weekPicker.getByRole('button')).toHaveCount(8);

  const columnCount = await weekPicker.evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length,
  );
  expect(columnCount).toBe(4);

  const labels = await weekPicker.getByRole('button').allTextContents();
  expect(labels).toEqual(['08-14', '08-07', '07-31', '07-24', '07-17', '07-09', '07-03', '06-26']);
});
