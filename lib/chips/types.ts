/**
 * 籌碼面資料型別
 *
 * Layer 結構：
 * - Daily inst (T86): 每日三大法人買賣超（每天一檔 JSON, 含全市場 ~1957 支）
 * - Weekly TDCC:      每週大戶持股分散（每週一檔 JSON, 含全市場 ~1957 支）
 */

/** 單一股票 ‧ 單一交易日 ‧ 三大法人買賣超（單位：張，1張=1000股） */
export interface InstDay {
  /** 外資買賣超（張，正=買超，負=賣超） */
  foreign: number;
  /** 投信買賣超（張） */
  trust: number;
  /** 自營商買賣超（張，含避險+自行買賣） */
  dealer: number;
  /** 三大法人合計（張） */
  total: number;
  /** 當日總成交張數（用來推算散戶買賣超） */
  totalVolume?: number;
}

/** 一日全市場 inst 資料（T86 一次抓回，存成一檔） */
export interface InstDayFile {
  date: string;            // 'YYYY-MM-DD'
  updatedAt: string;       // ISO
  market: 'TW';
  /** key = pure code (no suffix), e.g. '2330', '6488' */
  data: Record<string, InstDay>;
}

/** 單一股票 ‧ 單一資料日 ‧ 大戶持股分散（TDCC 集保） */
export interface TdccDay {
  /** 大戶持股 400 張↑ 比例（%） */
  holder400Pct: number;
  /** 大戶持股 1000 張↑ 比例（%） */
  holder1000Pct: number;
  /** 總股東戶數 */
  holderCount?: number;
}

/** 一週全市場 TDCC 資料（週四晚公布上週五持股） */
export interface TdccWeekFile {
  date: string;            // 資料基準日（週五），'YYYY-MM-DD'
  updatedAt: string;
  market: 'TW';
  data: Record<string, TdccDay>;
}

/** 走圖 API 回傳：單一股票的籌碼時序 */
export interface ChipSeries {
  symbol: string;
  /** 法人日資料時序（升冪 by date） — TW only */
  inst: Array<{ date: string } & InstDay>;
  /** 大戶週資料時序（升冪 by date） — TW only */
  tdcc: Array<{ date: string } & TdccDay>;
  /** CN 主力資金 daily 時序（升冪 by date） — CN only */
  cnFlow?: Array<{ date: string } & CnFlowDay>;
}

// ── CN 籌碼面（EastMoney 主力資金）─────────────────────────────────────────

/** 單一股票 ‧ 單一交易日 ‧ CN 主力資金流向（單位：萬元，正=淨流入） */
export interface CnFlowDay {
  /** 主力淨流入 = 超大單 + 大單 */
  mainNet: number;
  /** 超大單淨流入（萬元，> 100 萬手或大於 50 萬筆） */
  superLargeNet: number;
  /** 大單淨流入 */
  largeNet: number;
  /** 中單淨流入 */
  mediumNet: number;
  /** 小單淨流入（散戶） */
  smallNet: number;
}
