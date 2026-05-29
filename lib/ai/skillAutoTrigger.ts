/**
 * 通用 skill auto-trigger — 用 macOS osascript 模擬按鍵注入 `/{command}` 到任一 claude session
 *
 * 找有 claude 在跑的 tab 順序（跟 zhuAutoTrigger 相同邏輯）：
 *   1. tab 名稱含 "Zhu"（最精確 — 用戶有設標題的專用視窗）
 *   2. tab 名稱含 "claude"（claude CLI 跑起來時 tab 自動顯示）
 *   3. tab 名稱含 "node"（claude 是 node 腳本，預設 fallback）
 *
 * 依序試 Terminal.app → iTerm。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

/** AppleScript 在 compile 時就要解析 `tell application "iTerm"` 的 dictionary。
 *  iTerm 沒裝就拿不到 dictionary、整支 script 直接 syntax error。
 *  所以我們在 build script 前先偵測 iTerm 是否存在，沒裝就跳過該區塊。 */
function isITermInstalled(): boolean {
  return existsSync('/Applications/iTerm.app') || existsSync('/Applications/iTerm2.app');
}

function buildAppleScript(command: string): string {
  // 防注入：command 只允許 alphanumeric / 空白 / dot / dash / slash / underscore
  if (!/^[A-Za-z0-9._\-/ ]+$/.test(command)) {
    throw new Error(`invalid skill command (illegal char): ${command}`);
  }

  const itermBlock = isITermInstalled() ? `
if foundIn is "" then
  try
    tell application "System Events"
      if exists process "iTerm2" then
        tell application "iTerm"
          repeat with w in windows
            try
              repeat with t in tabs of w
                try
                  set sessionName to ""
                  try
                    set sessionName to name of current session of t
                  end try
                  set p to my matchesZhu(sessionName)
                  if p > 0 and p < bestPriority then
                    set bestPriority to p
                    set foundIn to "iTerm"
                    tell w to select t
                  end if
                end try
              end repeat
            end try
          end repeat
          if foundIn is "iTerm" then activate
        end tell
      end if
    end tell
  end try
end if
` : '';

  return `
on matchesZhu(s)
  if s contains "Zhu" then return 1
  if s contains "claude" then return 2
  if s contains "node" then return 3
  return 0
end matchesZhu

set prevApp to missing value
try
  tell application "System Events"
    set prevApp to name of first application process whose frontmost is true
  end tell
end try

set bestPriority to 999
set foundIn to ""

try
  tell application "System Events"
    if exists process "Terminal" then
      tell application "Terminal"
        repeat with w in windows
          try
            set wName to ""
            try
              set wName to name of w
            end try
            set wp to my matchesZhu(wName)

            repeat with t in tabs of w
              try
                set tName to ""
                set ctName to ""
                try
                  set tName to name of t
                end try
                try
                  set ctName to custom title of t
                end try
                set p1 to my matchesZhu(tName)
                set p2 to my matchesZhu(ctName)
                set p to wp
                if p1 > 0 and (p is 0 or p1 < p) then set p to p1
                if p2 > 0 and (p is 0 or p2 < p) then set p to p2
                if p > 0 and p < bestPriority then
                  set bestPriority to p
                  set foundIn to "Terminal"
                  set selected of t to true
                  set frontmost of w to true
                end if
              end try
            end repeat
          end try
        end repeat
        if foundIn is "Terminal" then activate
      end tell
    end if
  end tell
end try

${itermBlock}
if foundIn is "" then
  return "ERROR: no Terminal/iTerm tab with claude session (open one with: cd ~/Desktop/rockstock && claude)"
end if

delay 0.25

tell application "System Events"
  keystroke "${command}"
  delay 0.3
  keystroke return
end tell

delay 0.15

if prevApp is not missing value and prevApp is not "Terminal" and prevApp is not "iTerm2" then
  try
    tell application prevApp to activate
  end try
end if

return "OK via " & foundIn & " (priority " & bestPriority & ")"
`;
}

export async function triggerSkillKeystroke(command: string): Promise<{ ok: boolean; detail?: string }> {
  if (process.platform !== 'darwin') {
    return { ok: false, detail: 'not macOS — skip auto-trigger' };
  }
  try {
    const script = buildAppleScript(command);
    const { stdout, stderr } = await execFileAsync('osascript', ['-e', script], {
      timeout: 5_000,
    });
    const result = (stdout || '').trim();
    if (result.startsWith('ERROR')) {
      return { ok: false, detail: result };
    }
    if (stderr && stderr.trim() && !stderr.includes('warning')) {
      return { ok: false, detail: stderr.trim() };
    }
    return { ok: true, detail: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg };
  }
}
