import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');

describe('Next.js deployment asset safety', () => {
  test('deploy health check verifies referenced static assets', () => {
    const deployScript = fs.readFileSync(path.join(root, 'scripts/deploy-prod-guard.sh'), 'utf8');
    expect(deployScript).toContain('scripts/verify-next-assets.mjs');
    expect(deployScript).toMatch(/靜態資源不完整.*自動回復上一版/);
  });

  test('service worker never intercepts Next.js static assets', () => {
    const serviceWorker = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
    const bypassIndex = serviceWorker.indexOf('url.pathname.startsWith("/_next/static/")');
    const runtimeCacheIndex = serviceWorker.indexOf('event.respondWith(staleWhileRevalidate');

    expect(bypassIndex).toBeGreaterThan(-1);
    expect(serviceWorker.slice(bypassIndex, bypassIndex + 80)).toMatch(/return/);
    expect(bypassIndex).toBeLessThan(runtimeCacheIndex);
  });
});
