/**
 * Portfolio profiles — 多人持倉檔案註冊表 + 路徑解析（單一事實來源）
 *
 * 為什麼：持倉原本是單人寫死設計（holdings.json / holdings-cn.json 兩個固定檔）。
 * 加入 profile 維度後，同一工具可切換「查看 / 管理」多個人的持倉（我的、朋友的…）。
 *
 * 設計：
 *   - 預設 profile 'me' → **沿用既有路徑**（data/agents/portfolio/、data/portfolio/），零資料搬遷。
 *   - 其他 profile {id} → data/portfolios/{id}/ 命名空間（與「我的」完全隔離）。
 *   - id 用檔名安全字串（p{base36}）；顯示名（可中文：朋友 / 老王）另存於 profiles.json。
 *
 * 不違反 FUNDAMENTAL_REQUIREMENTS：只動「持倉」這條個人記帳線（Layer 3，本就獨立於掃描資料流），
 * 不碰行情 / L1–L4 / 掃描 / 選股合約。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';

export const DEFAULT_PROFILE_ID = 'me' as const;
export const PROFILES_SCHEMA_VERSION = 1 as const;

export interface PortfolioProfile {
  id: string;
  name: string;
  createdAt: string;
}

export interface ProfilesFile {
  schemaVersion: typeof PROFILES_SCHEMA_VERSION;
  profiles: PortfolioProfile[];
  updatedAt: string;
}

const PROFILES_FILE = path.join(process.cwd(), 'data', 'portfolio', 'profiles.json');
/** 非預設 profile 的資料根目錄（每個 profile 一個子資料夾）*/
const PROFILES_ROOT = path.join(process.cwd(), 'data', 'portfolios');

const DEFAULT_PROFILE: PortfolioProfile = {
  id: DEFAULT_PROFILE_ID,
  name: '我的',
  createdAt: '1970-01-01T00:00:00.000Z',
};

/**
 * id 檔名安全性：保留字 'me'，或 `p` + 4..30 個 base36 字元（小寫字母 + 數字）。
 * 用於擋掉路徑穿越（../）與任意檔名。
 */
export function isValidProfileId(id: string): boolean {
  return id === DEFAULT_PROFILE_ID || /^p[a-z0-9]{4,30}$/.test(id);
}

/** 把任意外部輸入收斂成合法 profile id；非法 / 空 → 'me'（fail-safe，永遠落在預設） */
export function resolveProfileId(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_PROFILE_ID;
  return isValidProfileId(raw) ? raw : DEFAULT_PROFILE_ID;
}

/**
 * 回傳該 profile 的資料夾。
 * 預設 'me' 回 null → 呼叫端用既有 legacy 路徑（不搬資料）；其他回 data/portfolios/{id}。
 */
export function profileDir(profileId: string): string | null {
  const id = resolveProfileId(profileId);
  if (id === DEFAULT_PROFILE_ID) return null;
  return path.join(PROFILES_ROOT, id);
}

// ────────────────────────────────────────────────────────────────────────────
// Registry CRUD
// ────────────────────────────────────────────────────────────────────────────

export async function loadProfiles(): Promise<ProfilesFile> {
  try {
    const raw = await fs.readFile(PROFILES_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as ProfilesFile;
    if (!Array.isArray(parsed.profiles)) throw new Error('bad shape');
    // 'me' 永遠存在且排第一（即使檔案被手動改壞也自癒）
    if (!parsed.profiles.some(p => p.id === DEFAULT_PROFILE_ID)) {
      parsed.profiles.unshift(DEFAULT_PROFILE);
    }
    return parsed;
  } catch {
    return {
      schemaVersion: PROFILES_SCHEMA_VERSION,
      profiles: [DEFAULT_PROFILE],
      updatedAt: new Date().toISOString(),
    };
  }
}

async function saveProfiles(file: ProfilesFile): Promise<void> {
  await fs.mkdir(path.dirname(PROFILES_FILE), { recursive: true });
  file.updatedAt = new Date().toISOString();
  await atomicFsPut(PROFILES_FILE, JSON.stringify(file, null, 2));
}

function genProfileId(): string {
  // p + base36(now) + 2 隨機字元 — 檔名安全、足夠唯一（個人工具、手動建立）
  const rand = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
  return `p${Date.now().toString(36)}${rand}`;
}

function sanitizeName(name: string): string {
  return name.trim().slice(0, 20);
}

export async function createProfile(name: string): Promise<PortfolioProfile> {
  const clean = sanitizeName(name);
  if (!clean) throw new Error('profile 名稱不可空白');
  const file = await loadProfiles();
  const profile: PortfolioProfile = {
    id: genProfileId(),
    name: clean,
    createdAt: new Date().toISOString(),
  };
  file.profiles.push(profile);
  await saveProfiles(file);
  return profile;
}

export async function renameProfile(id: string, name: string): Promise<PortfolioProfile> {
  const clean = sanitizeName(name);
  if (!clean) throw new Error('profile 名稱不可空白');
  const file = await loadProfiles();
  const p = file.profiles.find(x => x.id === id);
  if (!p) throw new Error(`profile ${id} 不存在`);
  p.name = clean;
  await saveProfiles(file);
  return p;
}

/** 刪除 profile（連同其資料夾整夾移除）。擋刪預設 'me'。 */
export async function deleteProfile(id: string): Promise<boolean> {
  if (id === DEFAULT_PROFILE_ID) throw new Error('不可刪除預設「我的」持倉檔案');
  const file = await loadProfiles();
  const before = file.profiles.length;
  file.profiles = file.profiles.filter(x => x.id !== id);
  if (file.profiles.length === before) return false;
  await saveProfiles(file);
  const dir = profileDir(id);
  if (dir) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
  }
  return true;
}
