import { expect, test, type Locator } from '@playwright/test';

async function expectReadableResponsiveDates(picker: Locator) {
  await expect(picker).toBeVisible({ timeout: 20_000 });
  await expect(picker).toHaveAttribute('data-date-picker-layout', 'responsive');

  const metrics = await picker.evaluate((element) => {
    const buttons = [...element.querySelectorAll('button')];
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      widths: buttons.map(button => button.getBoundingClientRect().width),
    };
  });

  expect(metrics.widths.length).toBeGreaterThan(0);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(Math.min(...metrics.widths)).toBeGreaterThanOrEqual(44);
}

test('策略掃描與三色資金日期會依側欄寬度換行，不互相擠壓', async ({ page, context }) => {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('risk-disclaimer-accepted', '1');
      localStorage.setItem('feature-guide-seen', '1');
    } catch {}
  });

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?load=6770.TW');
  await expect(page.getByText('力積電').first()).toBeVisible({ timeout: 20_000 });

  await expectReadableResponsiveDates(page.getByRole('group', { name: '策略掃描歷史日期' }));

  await page.getByRole('button', { name: '三色(中等)', exact: true }).click();
  await expectReadableResponsiveDates(page.getByRole('group', { name: '三色資金歷史日期' }));
});
