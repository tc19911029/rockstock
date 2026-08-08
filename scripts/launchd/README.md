# 本地 launchd 排程（補 instrumentation.ts 沒做的）

## 正式盤後策略流水線

`strategy-eod-tw/cn` 會先完成 A，再跑 B～R、SanSe、V（TW 另跑 Y），
最後一定更新 health。A 若失敗會阻止依賴它的策略；其餘獨立策略會繼續執行，
但任何失敗都會讓排程非零退出，避免 partial 結果被誤報為成功。

盤後正式掃描只允許 sealed L1，不得用未標記 final 的 L2 快照覆寫收盤價。
直接執行 TypeScript 的維護任務統一使用 `~/.local/node-22` 的固定 Node 與
全域 `tsx`，禁止引用 Desktop 專案內的 `node_modules/.bin/tsx`，避免
macOS launchd/TCC 權限造成靜默漏跑。安裝前請執行：

```bash
~/.local/node-22/bin/npm install -g tsx@4.23.5
```

## 為什麼只有 4 個（不是 60 個）

你的系統有兩層自動化：

### 第一層：`instrumentation.ts`（Next.js 啟動 hook）

只要你跑 `npm run dev` 或 `npm run start`，這個檔案會自動啟動以下排程：

- 盤中 L2 快照（每 5 分鐘）
- 盤中六條件掃描（每 10 分鐘）
- 盤中買法掃描 B-I（每分鐘輪流）
- 盤後 scan-tw / scan-cn（一次）
- 盤後買法 16 個並行（一次）
- L1 歷史日K 下載（每 10 分鐘檢查）
- append-from-snapshot 補當日K（每 5 分鐘檢查）
- auto-repair-watchdog（每 30 分鐘）
- daily-health-snapshot（盤後固化健康報告）
- ETF 18:00 fetch
- TDCC 週四 18:30

**這 11 件事 instrumentation.ts 全包了。** 不需要 launchd。

### 第二層：launchd（補 instrumentation.ts 沒做的）

需要 launchd 的事項：

| Plist 檔 | 觸發時機（CST） | 做什麼 |
|---|---|---|
| `com.rockstock.tw-institutional.plist` | 平日 15:45 | TW 三大法人籌碼 |
| `com.rockstock.cn-flow.plist` | 平日 16:15 | CN 北上資金（capital + flow） |
| `com.rockstock.cn-daban-close.plist` | 平日 15:55 | CN 打版盤後掃描（漲停板候選） |
| `com.rockstock.cn-daban-open.plist` | 平日 9:27 | CN 打版開盤確認（前一日候選的 9:25 集合競價） |
| `com.rockstock.tw-lockwatch.plist` | 平日 18:50 | TW 鎖股名單刷新 |
| `com.rockstock.cn-lockwatch.plist` | 平日 19:00 | CN 鎖股名單刷新 |

加上你**已經在跑**的：
- `com.rockstock.etf-fetch.plist` — ETF 持股 18:00 / 22:00 / 隔日 09:00（補晚揭露）
- `com.rockstock.etf-track.plist` — ETF 變化追蹤每天 23:00

**總共 8 個 launchd 排程。**

## ⚠️ ~/Desktop 沙箱問題（0519 發現）

macOS Sequoia/Sonoma 預設不准 launchd job 執行 `~/Desktop` 下的 shell 腳本。
徵狀：plist 載入 OK、`launchctl start` 立刻 exit 127、stderr 顯示
`/bin/zsh: can't open input file: /Users/.../Desktop/.../scripts/launchd/_curl-cron.sh`

**繞開作法**：plist 的 `ProgramArguments` 改成 inline 呼叫 `/usr/bin/curl`，不依賴 `_curl-cron.sh`。

**0519 全部修完**（12 個 plist 全部繞開沙箱，煙霧測試 exit 0 + 程式啟動驗證過）：

純 curl（單 endpoint）— `<ProgramArguments>` 為 `/usr/bin/curl ...`:
- `cn-daban-close` / `cn-daban-open`
- `tw-institutional` / `tw-lockwatch` / `cn-lockwatch`
- `cn-scan` / `tw-scan`

`/bin/sh -c` 串 curl（雙 endpoint）：
- `cn-flow`

`/bin/sh -c "cd Desktop && npx tsx scripts/...ts"`（跑 tsx 腳本）：
- `audit-l1-invariant`
- `eod-settle-cn` / `eod-settle-tw`
- `t1-fill-gaps`

關鍵發現：launchd 沙箱 **擋的是「launchd 直接執行 Desktop 下的 shell 腳本」**（exit 127、can't open input file），但**不擋「launchd 執行非 Desktop 的 sh/curl/npx，然後 cd 進 Desktop 讀檔/跑 tsx」**。inline cd 模式因此能繞開。

4 個 sh wrapper（`_curl-cron.sh` / `_audit-l1-invariant.sh` / `_eod-settle.sh` / `_t1-fill.sh`）都加了 DEPRECATED 警告，保留供手動執行，但 launchd 不再用。

**新增 plist 一律鏡像現有 inline 寫法，不要走 sh wrapper 路徑**，除非 wrapper 搬離 `~/Desktop` 或 `/bin/zsh` 取得完全取用磁碟權限。

## 📍 `bin/` — 住在 ~/.local/bin 的腳本（0715 建立）

有些排程不是單一 curl 而是多步驟腳本（YouTube nightly 分析等），必須是真的 `.sh`。
因為上述沙箱 + iCloud evict 問題，它們**只能住在 `~/.local/bin/`**，不能從 Desktop 執行。

**約定（重要）**：

| | 位置 | 角色 |
|---|---|---|
| 版控真相 | `scripts/launchd/bin/*.sh` | 改這裡，進 git |
| 實際執行 | `~/.local/bin/*.sh` | launchd 跑這裡，**不進 git** |

```bash
bash scripts/launchd/sync-bin.sh          # repo → ~/.local/bin 部署
bash scripts/launchd/sync-bin.sh --check  # 只檢查漂移，有差異 exit 1
```

**為什麼要有這條規矩**：0715 發現 `scripts/youtube-nightly-analysis.sh`（repo）與
`~/.local/bin/rockstock-youtube-nightly-analysis.sh`（實跑）**無聲分岔一個月**。
06-13 commit e45f403 把 normalize 步驟加進 repo 那份，看起來已上線、git 也有紀錄，
但實跑的那份從沒被同步 → **normalize 從 06-13 到 07-15 一次都沒在生產跑過**。
repo 那份「留作參考」的舊副本已刪除，只留 `bin/` + `sync-bin.sh` 這條單向路徑。

改完腳本沒跑 sync = 改的是沒在跑的那份。排查任何「腳本明明改了卻沒效果」先跑 `--check`。

`sync-bin.sh` 用「寫暫存 + `mv`」而非 `cp`：zsh 邊讀邊執行，就地覆寫正在跑的腳本會讓它
執行到亂碼；rename 換的是新 inode，執行中的舊 inode 不受影響。

## 安裝

```bash
cd ~/Desktop/rockstock

# 第一步：先讓 dev / production server 跑起來（另一個 terminal）
npm run dev    # 開發用（hot reload，吃 RAM 較多）
# 或
bash scripts/launchd/start-production.sh   # 正式用（省一半 RAM）

# 第二步：載入所有 launchd
bash scripts/launchd/install-all.sh
```

## 前提

1. **Mac 24/7 開機 + 接電源 + 不睡眠**
   - 系統設定 → 顯示器 → 進階 → 「電池接上電源時防止自動進入睡眠」打勾
2. **`npm run dev` 或 `npm run start` 必須在 port 3000 跑著**（launchd 打 localhost:3000）

## dev mode vs production mode

| | `npm run dev` | `npm run build && npm run start` |
|---|---|---|
| 用途 | 寫程式時 | 你只是用系統時 |
| RAM | 800MB–1.5GB | 300–500MB（省一半） |
| 第一次開頁面 | 慢（要編譯） | 快 |
| 改程式碼 | 自動 reload | 要重 build |
| **適合你嗎** | ❌ | ✅ |

兩者**都會啟動 instrumentation.ts**，所以排程都會跑。

## 確認

```bash
# 看哪些 launchd 已載入
launchctl list | grep com.rockstock

# 應該看到 8 個：
# com.rockstock.cn-daban-close   ← 0519 新增（inline curl，無沙箱問題）
# com.rockstock.cn-daban-open    ← 0519 新增（inline curl，無沙箱問題）
# com.rockstock.cn-flow
# com.rockstock.cn-lockwatch
# com.rockstock.etf-fetch        ← 你已有
# com.rockstock.etf-track        ← 你已有
# com.rockstock.tw-institutional
# com.rockstock.tw-lockwatch

# 看 log（明天平日 15:45 後）
tail -f /tmp/rockstock-tw-inst.log
```

## 手動立即測試

```bash
# 觸發一次（不等到時間到）
launchctl start com.rockstock.tw-institutional
cat /tmp/rockstock-tw-inst.log
```

## 暫停 / 移除

```bash
# 暫停某一個（保留檔案）
launchctl unload ~/Library/LaunchAgents/com.rockstock.tw-institutional.plist

# 全部停掉並刪掉（保留 etf-fetch / etf-track）
bash scripts/launchd/uninstall-all.sh
```

## 切回 Vercel

`vercel.json` 還在，所有 cron 設定都保留。要切回 Vercel：
1. `bash scripts/launchd/uninstall-all.sh` 停本地排程
2. 推一個 commit 到 main → Vercel 自動部署 → cron 復活

## 常見問題

**Q：launchd 觸發但 API 沒收到請求？**
- 檢查 `npm run dev` 是不是還在跑
- `lsof -i :3000` 看 port 有沒有占用
- `cat /tmp/rockstock-tw-inst.err.log` 看錯誤

**Q：盤中 Mac 會不會變慢？**
- instrumentation.ts 5 分鐘刷一次 L2，CPU 短暫飆高 5-10 秒
- 改 production mode（`npm run start`）會明顯比較順

**Q：Mac 蓋蓋子或睡覺，launchd 還會跑嗎？**
- 不會。一定要保持清醒。

## 變動歷史

- 2026-05-10：建立。從 vercel.json 60 cron → 11 個 launchd 計畫，後查 instrumentation.ts 發現大量重複，砍剩 4 個必要。
- 2026-05-19：補 `cn-daban-close` / `cn-daban-open`（A 股打版策略本機 cron 缺漏 9 天，DateNavigator 切歷史日空）。同日發現 `_curl-cron.sh` 在 `~/Desktop` 下被 macOS launchd 沙箱擋，所有舊 plist 皆 exit 127 — 新增 2 個用 inline `/usr/bin/curl` 繞開。
