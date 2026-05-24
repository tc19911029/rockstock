/**
 * ntfy.ts — ntfy.sh 推播 wrapper
 *
 * 設計：thin layer 包 fetch(NTFY_TOPIC_URL)，POST plain message body 與 header
 * 控制 title/tags/priority。可被 realtime alertDispatcher 或其他模組共用。
 *
 * Env：
 *   NTFY_TOPIC_URL  — 完整 URL，如 https://ntfy.sh/rockstock-alert-xxxxxxxx
 *   NTFY_ENABLED    — 'true' 開啟；其他值或未設 = disabled（dev 預設關閉）
 *
 * 文件：https://docs.ntfy.sh/publish/#message-body
 */

export interface NtfyPayload {
  /** 推播標題（顯示在通知列） */
  title: string;
  /** 推播本文 */
  message: string;
  /** 標籤 / emoji shortcode，會渲染成 icon */
  tags?: string[];
  /** 1-5；5=緊急、4=高、3=預設、2=低、1=最低 */
  priority?: 1 | 2 | 3 | 4 | 5;
  /** 點擊推播跳轉 URL（MVP 不設） */
  click?: string;
  /** Override topic URL（測試用），預設讀 env */
  topicUrlOverride?: string;
}

export interface NtfyResult {
  ok: boolean;
  status?: number;
  error?: string;
  /** 'disabled' = env 未啟用、'no-url' = env 未設 NTFY_TOPIC_URL */
  reason?: 'disabled' | 'no-url' | 'http' | 'fetch';
}

export async function sendNtfy(p: NtfyPayload): Promise<NtfyResult> {
  if (process.env.NTFY_ENABLED !== 'true') {
    return { ok: false, reason: 'disabled' };
  }
  const url = p.topicUrlOverride ?? process.env.NTFY_TOPIC_URL;
  if (!url) {
    return { ok: false, reason: 'no-url' };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Title': encodeRfc2047(p.title),
  };
  if (p.tags && p.tags.length > 0) headers['Tags'] = p.tags.join(',');
  if (p.priority) headers['Priority'] = String(p.priority);
  if (p.click) headers['Click'] = p.click;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: p.message,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, reason: 'http' };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      reason: 'fetch',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * ntfy header 不支援 raw non-ASCII；中文 title 必須 RFC 2047 Q-encode 或 base64。
 * 用最簡單 base64 encoded-word，保證 ntfy app 端會解碼回中文。
 */
function encodeRfc2047(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  const b64 = Buffer.from(s, 'utf-8').toString('base64');
  return `=?utf-8?B?${b64}?=`;
}
