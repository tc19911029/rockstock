import {
  fetchTwOfficialIndustryRoster,
  groupOfficialIndustryStocks,
  type TwOfficialIndustryStock,
} from '@/lib/datasource/TWOfficialIndustry';
import { readLatestSectorRanking, type SectorRankingFile } from './sectorRanking';

export interface OfficialIndustryContext {
  industryByCode: Map<string, string>;
  peersByCode: Map<string, string[]>;
  symbolByCode: Map<string, string>;
  source: 'openapi' | 'persisted_snapshot';
  asOf: string | null;
}

export class OfficialIndustryUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('TWSE／TPEx 官方產業資料與已驗證快照皆不可用', { cause });
    this.name = 'OfficialIndustryUnavailableError';
  }
}

export function buildOfficialIndustryContextFromRoster(
  roster: TwOfficialIndustryStock[],
  source: OfficialIndustryContext['source'] = 'openapi',
  asOf: string | null = null,
): OfficialIndustryContext {
  const industryByCode = new Map(roster.map((stock) => [stock.code, stock.industry]));
  const symbolByCode = new Map(roster.map((stock) => [stock.code, stock.symbol]));
  const peersByCode = new Map<string, string[]>();
  for (const group of groupOfficialIndustryStocks(roster)) {
    const codes = group.stocks.map((stock) => stock.code);
    for (const code of codes) peersByCode.set(code, codes.filter((peer) => peer !== code));
  }
  return { industryByCode, peersByCode, symbolByCode, source, asOf };
}

export function buildOfficialIndustryContextFromRanking(file: SectorRankingFile): OfficialIndustryContext {
  const industryByCode = new Map<string, string>();
  const symbolByCode = new Map<string, string>();
  const peersByCode = new Map<string, string[]>();
  for (const theme of file.themes) {
    const codes = theme.members.map((member) => member.code);
    for (const member of theme.members) {
      industryByCode.set(member.code, theme.theme);
      symbolByCode.set(member.code, member.symbol);
      peersByCode.set(member.code, codes.filter((code) => code !== member.code));
    }
  }
  return { industryByCode, peersByCode, symbolByCode, source: 'persisted_snapshot', asOf: file.date };
}

/** 即時官方 OpenAPI 優先；短暫故障時只退到已驗證過的官方快照，絕不退人工題材或空分類。 */
export async function loadOfficialIndustryContext(): Promise<OfficialIndustryContext> {
  try {
    return buildOfficialIndustryContextFromRoster(await fetchTwOfficialIndustryRoster());
  } catch (openApiError) {
    const snapshot = await readLatestSectorRanking();
    if (snapshot) return buildOfficialIndustryContextFromRanking(snapshot);
    throw new OfficialIndustryUnavailableError(openApiError);
  }
}
