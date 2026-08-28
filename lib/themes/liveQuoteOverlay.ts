/**
 * 題材盤中列表的「統一股價」覆蓋層。
 *
 * /api/themes/live 提供完整題材名單與全市場 L2 粗快照；當該快照延遲時，前端會再用
 * /api/portfolio/quotes 批次補價，並以 /api/stock 對齊目前主圖股票。這裡只做純資料合併
 * 與題材統計重算，不碰網路，方便契約測試。
 */

export interface LiveQuoteOverride {
  symbol: string;
  changePercent: number;
}

interface OverlayMember {
  code: string;
  symbol: string;
  name: string;
  changePercent: number | null;
  volume: number | null;
  volRatio: number | null;
  isLimitUp: boolean;
}

interface OverlayTheme {
  memberCount: number;
  quotedCount: number;
  upCount: number;
  avgChange: number | null;
  maxChange: number | null;
  topStock: { code: string; name: string; symbol: string; changePercent: number } | null;
  members: OverlayMember[];
}

const bareCode = (symbol: string): string => symbol.replace(/\.(TW|TWO)$/i, '');

/**
 * 用統一行情覆蓋成分股並重算題材。
 *
 * clearMissing=true 用於原 L2 已過期：沒有取得統一行情的股票必須顯示「—」，不可繼續
 * 冒充即時價。若原 L2 仍新鮮，則只覆蓋成功取得的股票，短暫缺價仍可沿用新鮮 L2。
 */
export function overlayLiveThemeQuotes<T extends { themes: OverlayTheme[] }>(
  data: T,
  quotes: LiveQuoteOverride[],
  options: { clearMissing: boolean },
): T {
  const byCode = new Map(
    quotes
      .filter((quote) => Number.isFinite(quote.changePercent))
      .map((quote) => [bareCode(quote.symbol), quote] as const),
  );

  const themes = data.themes.map((theme) => {
    const members = theme.members.map((member) => {
      const quote = byCode.get(member.code);
      if (quote) {
        return {
          ...member,
          changePercent: quote.changePercent,
          // 統一報價出口目前不回全市場量比；原快照過期時不可保留舊量比。
          ...(options.clearMissing ? { volume: null, volRatio: null } : {}),
          isLimitUp: false,
        };
      }
      return options.clearMissing
        ? { ...member, changePercent: null, volume: null, volRatio: null, isLimitUp: false }
        : member;
    });

    const quoted = members.filter(
      (member): member is OverlayMember & { changePercent: number } => member.changePercent != null,
    );
    const top = quoted.length > 0
      ? quoted.reduce((best, member) => member.changePercent > best.changePercent ? member : best)
      : null;

    return {
      ...theme,
      memberCount: members.length,
      quotedCount: quoted.length,
      upCount: quoted.filter((member) => member.changePercent > 0).length,
      avgChange: quoted.length > 0
        ? +(quoted.reduce((sum, member) => sum + member.changePercent, 0) / quoted.length).toFixed(2)
        : null,
      maxChange: quoted.length > 0
        ? +Math.max(...quoted.map((member) => member.changePercent)).toFixed(2)
        : null,
      topStock: top
        ? { code: top.code, name: top.name, symbol: top.symbol, changePercent: top.changePercent }
        : null,
      members,
    };
  });

  return { ...data, themes };
}
