/**
 * smartmoney 每日掃描結果讀寫 — data/smartmoney/{date}.json
 */
import { promises as fs } from 'fs';
import path from 'path';
import { SmartMoneyDay } from './types';

const DIR = path.join(process.cwd(), 'data', 'smartmoney');

export async function writeDay(day: SmartMoneyDay): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(path.join(DIR, `${day.date}.json`), JSON.stringify(day, null, 1));
}

export async function readDay(date: string): Promise<SmartMoneyDay | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(DIR, `${date}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export async function listDates(): Promise<string[]> {
  try {
    return (await fs.readdir(DIR))
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
      .sort();
  } catch {
    return [];
  }
}
