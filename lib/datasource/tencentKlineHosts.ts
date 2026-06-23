// ============================================================
// 騰訊 CN qfq 日K endpoint 的 host base（含路徑到 .../fqkline/get）。
//
// 主網域 web.ifzq.gtimg.cn 自 2026-06 起被 WAF 封（任何請求回 HTTP 501，
// 已驗證 env -i 直連、零並發、單檔也 501 → 不是限流、不是 TLS reset）。
// → 改走同源鏡像 proxy.finance.qq.com 優先、舊網域 fallback（哪天鏡像也被封還能退回）。
// 兩者回傳格式逐位元相同：{code:0, data:{[tc]:{qfqday:[[date,open,close,high,low,vol手],...], day:[...]}}}
//
// ⚠️ 只適用 CN 的 app/fqkline/get。US 的 app/usfqkline/get 未被封（實測 200），不走這份。
// ============================================================

export const TENCENT_FQKLINE_BASES: readonly string[] = [
  'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get',
  'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
];
