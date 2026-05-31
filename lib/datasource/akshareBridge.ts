/**
 * AkShare Python 橋接（Node 端）— spawn scripts/akshare_bridge.py，取陸股「非 EastMoney 源」資料。
 * 同 whisper/youtube 檔案橋接 pattern。失敗/逾時/無 akshare 一律回 []（永不丟例外）。
 *
 * 注意：akshare 走 Python 子程序、首次 import 較慢（~2-3s），只當 EastMoney 的 fallback 用，
 * 不放熱路徑。需 `python3 -m pip install --user akshare`（見記憶 data_sources_cn_chip_fundamental）。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { homedir } from 'node:os';

const SCRIPT = path.join(process.cwd(), 'scripts', 'akshare_bridge.py');
const DEFAULT_TIMEOUT_MS = 30_000;

export type AkshareType = 'financials';

/** 跑 akshare bridge，回 data 陣列（失敗回 []）。 */
export async function runAkshareBridge(type: AkshareType, code: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, unknown>[]> {
  const extraPaths = [`${homedir()}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  const augmentedPath = [...extraPaths, process.env.PATH || ''].filter(Boolean).join(':');

  return new Promise((resolve) => {
    let stdout = '';
    let done = false;
    const finish = (rows: Record<string, unknown>[]) => { if (!done) { done = true; resolve(rows); } };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('python3', [SCRIPT, '--type', type, '--code', code], {
        env: { ...process.env, PATH: augmentedPath },
      });
    } catch {
      return finish([]);
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
      finish([]);
    }, timeoutMs);

    child.stdout?.setEncoding?.('utf-8');
    child.stdout?.on('data', (c: string) => { stdout += c; if (stdout.length > 1_000_000) stdout = stdout.slice(-1_000_000); });
    child.on('error', () => { clearTimeout(timer); finish([]); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(stdout.trim()) as { ok?: boolean; data?: Record<string, unknown>[] };
        finish(j?.ok && Array.isArray(j.data) ? j.data : []);
      } catch {
        finish([]); // 非 JSON（akshare 未裝 / 噴錯）→ 優雅空
      }
    });
  });
}
