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
