import { expect, test } from '@playwright/test';

test('陸股節目績效使用有標籤的單一日期區間控制', async ({ page, context }) => {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('risk-disclaimer-accepted', '1');
      localStorage.setItem('feature-guide-seen', '1');
    } catch {}
  });

  await page.goto('/?tab=youtube&date=2026-08-14&ytMarket=cn&ytSub=teachers');

  const panel = page.getByRole('region', { name: '陸股節目績效' });
  await expect(panel).toBeVisible({ timeout: 20_000 });

  const from = panel.getByLabel('起日');
  const to = panel.getByLabel('迄日');
  await expect(from).toHaveAttribute('type', 'date');
  await expect(to).toHaveAttribute('type', 'date');
  await expect(panel.getByRole('group', { name: '日期選擇' })).toHaveCount(0);

  await from.fill('2026-08-12');
  await expect(from).toHaveValue('2026-08-12');
  await expect(to).toHaveAttribute('min', '2026-08-12');
});
