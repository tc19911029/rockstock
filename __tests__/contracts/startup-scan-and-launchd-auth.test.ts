import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

describe('部署後排程防回歸', () => {
  test('L4 在 boot grace 後有首輪掃描，不必等 11 分鐘 interval', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'instrumentation.node.ts'), 'utf8');
    expect(source).toContain("scanIntradayDaily('TW').catch(err => console.error('[local-cron] TW initial scan-intraday:'");
    expect(source).toContain("scanIntradayDaily('CN').catch(err => console.error('[local-cron] CN initial scan-intraday:'");
    expect(source).toContain('}, 120_000);');
    expect(source).toContain('}, 150_000);');
  });

  test('L2 預設每分鐘刷新，避免題材 API 的 40 秒快取反覆回舊快照', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'instrumentation.node.ts'), 'utf8');
    expect(source).toContain('LOCAL_L2_REFRESH_INTERVAL_MS');
    expect(source).toContain("startL2RefreshLoop('TW', 15_000 + L2_REFRESH_INTERVAL_MS)");
    expect(source).toContain("startL2RefreshLoop('CN', 45_000 + L2_REFRESH_INTERVAL_MS)");
    expect(source).toContain('const degradedIntervalMs = Math.max(5 * 60_000, L2_REFRESH_INTERVAL_MS)');
    expect(source).toContain('const nextDelay = healthy ? L2_REFRESH_INTERVAL_MS : degradedIntervalMs');
    expect(source).toContain('setTimeout(runAndSchedule, nextDelay)');
    expect(source).not.toMatch(/refreshAndScan\('TW'\).*5 \* 60 \* 1000/);
  });

  test.each(['com.rockstock.paper-track.plist', 'com.rockstock.prewarm-chip.plist'])(
    '%s 使用 curl argv，不經 shell 拆 Authorization header',
    fileName => {
      const file = path.join(process.cwd(), 'scripts', 'launchd', 'plists', fileName);
      const source = fs.readFileSync(file, 'utf8');
      expect(source).toContain('<string>/usr/bin/curl</string>');
      expect(source).not.toContain('<string>-c</string>');
      expect(source).toContain('<string>Authorization: Bearer CRON_SECRET</string>');
      expect(() => execFileSync('/usr/bin/plutil', ['-lint', file])).not.toThrow();
    },
  );
});
