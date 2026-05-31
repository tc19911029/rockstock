/**
 * Centralized environment variable validation.
 *
 * Import this module in server-side code to ensure all required
 * environment variables are present. Missing variables throw
 * a clear error at startup rather than silently failing later.
 */

import { z } from 'zod';

const envSchema = z.object({
  // Optional — have defaults or are only needed for specific features
  // ANTHROPIC_API_KEY 改 optional：本專案分析走檔案橋接訂閱模式、不打 SDK（見記憶），
  // 實際使用處（chat/ai-rank/news sentiment）皆直讀 process.env 並優雅降級；
  // 設成必填會讓任何呼叫 getEnv() 的程式在未設 key 時於啟動拋錯。
  ANTHROPIC_API_KEY: z.string().optional(),

  FINMIND_API_TOKEN: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('onboarding@resend.dev'),
  NOTIFY_EMAIL: z.string().email().optional(),
  CRON_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

let _validated: Env | null = null;

/** Validated environment variables (lazy-parsed on first access) */
export function getEnv(): Env {
  if (_validated) return _validated;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(`[env] Missing or invalid environment variables:\n${missing}`);
    throw new Error(`Environment validation failed:\n${missing}`);
  }

  _validated = result.data;
  return _validated;
}

/**
 * FinMind API token，去除 .env / shell 設定誤帶的引號與頭尾空白。
 *
 * 記憶 env_token_quotes_bug：FINMIND_API_TOKEN 曾含頭尾雙引號 + trailing space
 * → URL malformed、FinMind 全失效。token 本身不應含引號，故一律移除；清乾淨後
 * 為空字串 → 視為「未設定」回 undefined。**所有 provider 應統一走此函式**，
 * 不要各自 `process.env.FINMIND_API_TOKEN ?? ''`（那會漏掉 strip）。
 */
export function getFinMindToken(): string | undefined {
  const cleaned = process.env.FINMIND_API_TOKEN?.replace(/['"]/g, '').trim();
  return cleaned ? cleaned : undefined;
}
