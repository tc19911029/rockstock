/**
 * 種子資料產生器：把本對話分析過的 20 份券商報告寫進 data/broker/reports/{date}.json。
 *
 * 用真實的 normalizeRating / sentimentFromRating / saveDailyReports，
 * 確保種子資料與合約測試一致（sentiment 由 rating 推導、stats 由儲存層重算）。
 *
 * 用法：npx tsx scripts/seed-broker-reports.ts
 *
 * 所有 stock code 已對 data/youtube/stock-master.json 驗證（2026-06-09）。
 * 注意修正：聯茂=6213（非2383）、台光電=2383（非6274）、晶電→富采3714。
 * 刻意略過 Computex 內 Tyntek/光磊 光通訊 photodiode 提及（代號不確定，避免寫錯）。
 */

import {
  normalizeRating, sentimentFromRating,
  type BrokerReport, type BrokerStockMention, type BrokerDailyReports, type RatingAction,
} from '@/lib/broker/types';
import { saveDailyReports, loadBrokerRegistry } from '@/lib/broker/brokerStorage';
import { loadStockMaster } from '@/lib/youtube/stockMaster';

interface StockSpec {
  raw: string;
  code: string | null;          // null = 非台股
  rating_raw: string;           // '' = 純提及（mentioned_only）
  target: number | null;
  prev: number | null;
  covered: boolean;
  thesis: string;
  action?: RatingAction;
  currency?: string;
}
interface ReportSpec {
  report_id: string;
  broker: string;
  broker_display: string;
  report_date: string;
  title: string;
  source_pdf: string;
  primary: string | null;
  parse_mode: 'text' | 'vision';
  stocks: StockSpec[];
}

const SPECS: ReportSpec[] = [
  // ===== 2026-06-05 =====
  { report_id: '617561980240920768', broker: 'gs', broker_display: '高盛', report_date: '2026-06-05',
    title: 'King Slide — 上修目標價，AI 滑軌含量提升', source_pdf: '617561980240920768_260605_gs_kingslide.pdf',
    primary: '2059', parse_mode: 'text', stocks: [
      { raw: '川湖 King Slide', code: '2059', rating_raw: 'Buy', target: 7664, prev: 4386, covered: true,
        thesis: 'AI 伺服器滑軌含量提升；低倍數×高 EPS（30 倍×2027 年 EPS 255）算出 7,664，較市場樂觀。' },
    ] },
  { report_id: '617561981078995455', broker: 'gs', broker_display: '高盛', report_date: '2026-06-05',
    title: 'Hon Hai — 列入信念買進名單', source_pdf: '617561981078995455_260605_gs_HH.pdf',
    primary: '2317', parse_mode: 'text', stocks: [
      { raw: '鴻海 Hon Hai', code: '2317', rating_raw: 'Conviction List Buy', target: 400, prev: null, covered: true,
        thesis: 'AI 伺服器主引擎；2026 營收估 11 兆、EPS 19，全市場最樂觀。' },
    ] },
  { report_id: '617561981834493974', broker: 'gs', broker_display: '高盛', report_date: '2026-06-05',
    title: 'Delta — 大幅上修目標價，AI 電源', source_pdf: '617561981834493974_260605_gs_delta.pdf',
    primary: '2308', parse_mode: 'text', stocks: [
      { raw: '台達電 Delta', code: '2308', rating_raw: 'Buy', target: 4500, prev: 2420, covered: true,
        thesis: 'HVDC/800V AI 電源；電源營收 2025-28 年複合 +210%、毛利率衝 45%、EPS 三年複合破 100%。' },
    ] },
  { report_id: '617561982337810575', broker: 'ms', broker_display: '大摩', report_date: '2026-06-05',
    title: 'Hon Hai — 5 月營收', source_pdf: '617561982337810575_260605_ms_HH.pdf',
    primary: '2317', parse_mode: 'text', stocks: [
      { raw: '鴻海 Hon Hai', code: '2317', rating_raw: 'Overweight', target: 310, prev: null, covered: true,
        thesis: 'AI 伺服器；2026 營收估 9.7 兆、EPS 16.4，較高盛保守一截。' },
    ] },
  { report_id: '617561983159370329', broker: 'citi', broker_display: '花旗', report_date: '2026-06-05',
    title: 'Hon Hai — 台灣科技論壇', source_pdf: '617561983159370329_260605_citi_HH.pdf',
    primary: '2317', parse_mode: 'vision', stocks: [
      { raw: '鴻海 Hon Hai', code: '2317', rating_raw: 'Buy', target: 360, prev: null, covered: true,
        thesis: '垂直整合（CPO/液冷/連接器自製率拉到 50%+）；強調絕對獲利金額而非毛利率。' },
    ] },
  { report_id: '617561983982239764', broker: 'citi', broker_display: '花旗', report_date: '2026-06-05',
    title: 'Sinbon — 上修目標價', source_pdf: '617561983982239764_260605_citi_sinbon.pdf',
    primary: '3023', parse_mode: 'text', stocks: [
      { raw: '信邦 Sinbon', code: '3023', rating_raw: 'Buy', target: 370, prev: 310, covered: true,
        thesis: '半導體訂單帶動 2026 年度營收上修至 +16%；機器人/低軌衛星新業務發酵。' },
    ] },
  { report_id: '617561984434438353', broker: 'ms', broker_display: '大摩', report_date: '2026-06-05',
    title: 'Largan — 維持中立', source_pdf: '617561984434438353_260605_ms_largan.pdf',
    primary: '3008', parse_mode: 'text', stocks: [
      { raw: '大立光 Largan', code: '3008', rating_raw: 'Equal-weight', target: 2450, prev: null, covered: true,
        thesis: 'CPO 題材難量產化、安卓逆風；2026 EPS 反衰退，現價高估約 33%。' },
    ] },
  { report_id: '617561993846456389', broker: 'ubs', broker_display: '瑞銀', report_date: '2026-06-05',
    title: 'Chipbond — 大幅上修，矽光子', source_pdf: '617561993846456389_260605_ubs_Chipbond.pdf',
    primary: '6147', parse_mode: 'text', stocks: [
      { raw: '頎邦 Chipbond', code: '6147', rating_raw: 'Buy', target: 340, prev: 230, covered: true,
        thesis: '矽光子/光通訊含量升（占比 2028→24%）+ 後段服務擴張；EPS 大升級。' },
    ] },

  // ===== 2026-06-06 =====
  { report_id: '617561990273433824', broker: 'gs', broker_display: '高盛', report_date: '2026-06-08',
    title: 'Asustek — 大幅上修目標價', source_pdf: '617561990273433824_260606_gs_asustek.pdf',
    primary: '2357', parse_mode: 'text', stocks: [
      { raw: '華碩 Asustek', code: '2357', rating_raw: 'Neutral', target: 1082, prev: 690, covered: true,
        thesis: '本益比上修推升；但僅中立、季線乖離已大、追高風險。' },
    ] },
  { report_id: '617561994299441323', broker: 'daiwa', broker_display: '大和', report_date: '2026-06-08',
    title: 'Jentech — 5 月營收創高', source_pdf: '617561994299441323_260606_daiwa_Jentech.pdf',
    primary: '3653', parse_mode: 'text', stocks: [
      { raw: '健策 Jentech', code: '3653', rating_raw: 'Buy', target: 6770, prev: null, covered: true,
        thesis: '5 月營收創高 +37.7%；Rubin 均熱片急單、售價走高；本益比 73 倍（預估）。' },
    ] },

  // ===== 2026-06-07 =====
  { report_id: '617561984870645795', broker: 'ms', broker_display: '大摩', report_date: '2026-06-08',
    title: 'Hiwin — 加碼', source_pdf: '617561984870645795_260607_ms_hiwin.pdf',
    primary: '2049', parse_mode: 'text', stocks: [
      { raw: '上銀 Hiwin', code: '2049', rating_raw: 'Overweight', target: 400, prev: null, covered: true,
        thesis: '機器人/工業自動化復甦題材。' },
    ] },
  { report_id: '617561985323631026', broker: 'ms', broker_display: '大摩', report_date: '2026-06-08',
    title: 'Chroma — 加碼', source_pdf: '617561985323631026_260607_ms_chroma.pdf',
    primary: '2360', parse_mode: 'text', stocks: [
      { raw: '致茂 Chroma', code: '2360', rating_raw: 'Overweight', target: 2800, prev: null, covered: true,
        thesis: 'AI/HBM 測試設備需求；營收年增 +133%。' },
    ] },
  { report_id: '617561986145714266', broker: 'ms', broker_display: '大摩', report_date: '2026-06-08',
    title: 'King Slide — 加碼', source_pdf: '617561986145714266_260607_ms_kingslide.pdf',
    primary: '2059', parse_mode: 'text', stocks: [
      { raw: '川湖 King Slide', code: '2059', rating_raw: 'Overweight', target: 6650, prev: null, covered: true,
        thesis: '滑軌；34 倍×2027 保守 EPS 194 算 6,650，方法與高盛相反但結論接近。' },
    ] },
  { report_id: '617561986884174272', broker: 'ms', broker_display: '大摩', report_date: '2026-06-08',
    title: 'Accton — 網通首選', source_pdf: '617561986884174272_260607_ms_accton.pdf',
    primary: '2345', parse_mode: 'text', stocks: [
      { raw: '智邦 Accton', code: '2345', rating_raw: 'Overweight', target: 3350, prev: null, covered: true,
        thesis: '矽光子/CPO 交換器（2027 起貢獻營收）；網通首選。' },
    ] },
  { report_id: '617561988495311089', broker: 'ms', broker_display: '大摩', report_date: '2026-06-08',
    title: 'Bizlink — 加碼', source_pdf: '617561988495311089_260607_ms_bizlink.pdf',
    primary: '3665', parse_mode: 'text', stocks: [
      { raw: '貿聯-KY Bizlink', code: '3665', rating_raw: 'Overweight', target: 3665, prev: null, covered: true,
        thesis: '電源線束/匯流排、DAC/AEC/AOC 高速線；併購 XFS 強化光纖；低軌衛星/機器人新題材。' },
    ] },
  { report_id: '617561989383716973', broker: 'ms', broker_display: '大摩', report_date: '2026-06-08',
    title: 'Advantech — 加碼', source_pdf: '617561989383716973_260607_ms_advantech.pdf',
    primary: '2395', parse_mode: 'text', stocks: [
      { raw: '研華 Advantech', code: '2395', rating_raw: 'Overweight', target: 400, prev: null, covered: true,
        thesis: '工業電腦復甦；但現價已高於目標價（隱含下跌空間）。' },
    ] },
  { report_id: '617561990793003250', broker: 'citi', broker_display: '花旗', report_date: '2026-06-08',
    title: 'Taiwan PCB & CCL — 科技論壇紀要', source_pdf: '617561990793003250_260607_citi_TW-PCB-CCL.pdf',
    primary: null, parse_mode: 'text', stocks: [
      { raw: '台光電', code: '2383', rating_raw: 'Buy', target: 5100, prev: null, covered: false,
        thesis: 'CCL 供 AI GPU/ASIC 龍頭地位、規格升級+漲價撐毛利；目標本益比 30 倍（2027 預估）。（註：花旗報告英文名與台股慣用名不一致，以代號 2383 為準）' },
      { raw: '金像電 Gold Circuit', code: '2368', rating_raw: 'Buy', target: 1650, prev: null, covered: false,
        thesis: 'AI 伺服器/網通高曝險、ASIC 客戶市占升 + 4Q26 新客戶；PCB/CCL 裡上漲空間最大。' },
      { raw: '台燿', code: '6274', rating_raw: 'Buy', target: 1600, prev: null, covered: false,
        thesis: 'AI ASIC/800G 帶動、泰國廠 2Q26 放量；目標本益比 25 倍；已近目標價。（註：花旗報告英文名與台股慣用名不一致，以代號 6274 為準）' },
    ] },
  { report_id: '617561991112294885', broker: 'citi', broker_display: '花旗', report_date: '2026-06-08',
    title: 'Vanguard — 科技論壇', source_pdf: '617561991112294885_260607_citi_vanguard.pdf',
    primary: '5347', parse_mode: 'vision', stocks: [
      { raw: '世界先進 Vanguard', code: '5347', rating_raw: 'Buy', target: 170, prev: null, covered: true,
        thesis: 'AI PMIC + 台積電合作改造新加坡 12 吋廠；結構性升級但目標價空間僅 +5%。' },
    ] },
  { report_id: '617561992018526773', broker: 'ms', broker_display: '大摩', report_date: '2026-06-08',
    title: '1H June 面板報價', source_pdf: '617561992018526773_260607_ms_1h-june-panel-px.pdf',
    primary: null, parse_mode: 'text', stocks: [
      { raw: '友達 AUO', code: '2409', rating_raw: 'Equal-weight', target: 14, prev: null, covered: false,
        thesis: '面板報價接近見頂（電視 3Q26 轉跌）；估值偏貴。' },
      { raw: '群創 Innolux', code: '3481', rating_raw: 'Equal-weight', target: 19.5, prev: null, covered: false,
        thesis: '同上，估值已反映利多。' },
      { raw: '聯詠 Novatek', code: '3034', rating_raw: 'Underweight', target: null, prev: null, covered: false,
        thesis: 'DDI 需求弱、毛利壓力、缺新成長動能。' },
    ] },
  { report_id: '617561992739160167', broker: 'ms', broker_display: '大摩', report_date: '2026-06-08',
    title: 'Computex 2026 Takeaways', source_pdf: '617561992739160167_260607_ms_computex.pdf',
    primary: null, parse_mode: 'text', stocks: [
      { raw: '台達電 Delta', code: '2308', rating_raw: '', target: null, prev: null, covered: false,
        thesis: '800V DC 電源櫃 / SST / 燃料電池 / 液冷 CDU。' },
      { raw: '鴻海 Hon Hai', code: '2317', rating_raw: '', target: null, prev: null, covered: false,
        thesis: 'AI 機櫃 L10/L11 組裝；Groq 3 LPX 運算盤 3Q26 量產。' },
      { raw: '智邦 Accton', code: '2345', rating_raw: '', target: null, prev: null, covered: false,
        thesis: 'OWS / CPO 交換器，2027 起貢獻。' },
      { raw: '貿聯-KY Bizlink', code: '3665', rating_raw: '', target: null, prev: null, covered: false,
        thesis: '電源 / 資料互連 / 光纖分流盒；機器狗 / 低軌衛星。' },
      { raw: '川湖 King Slide', code: '2059', rating_raw: '', target: null, prev: null, covered: false,
        thesis: '滑軌滲透各家機櫃，市場規模擴大。' },
      { raw: '緯創 Wistron', code: '3231', rating_raw: '', target: null, prev: null, covered: false,
        thesis: 'BlueField-4 STX 儲存櫃。' },
      { raw: '緯穎 Wiwynn', code: '6669', rating_raw: '', target: null, prev: null, covered: false,
        thesis: '氣冷 Vera CPU 機櫃。' },
      { raw: '勤誠 Chenbro', code: '8210', rating_raw: '', target: null, prev: null, covered: false,
        thesis: 'AI 機殼全系列；馬來西亞廠 3Q26 量產。' },
      { raw: '聯發科 MediaTek', code: '2454', rating_raw: '', target: null, prev: null, covered: false,
        thesis: 'Micro LED AOC 原型；與 NVIDIA RTX Spark Arm SoC。' },
      { raw: '友達 AUO', code: '2409', rating_raw: '', target: null, prev: null, covered: false,
        thesis: 'Micro LED 玻璃基板封裝。' },
      { raw: '臻鼎-KY Zhen Ding', code: '4958', rating_raw: '', target: null, prev: null, covered: false,
        thesis: '認證 VR200 NVL72 44 層中板 PCB。' },
      { raw: 'Ennostar 晶電', code: '3714', rating_raw: '', target: null, prev: null, covered: false,
        thesis: 'Micro LED 光通訊晶片供應鏈。' },
    ] },

  // ===== 2026-06-08 第二批（617625 外資批 + 花旗國巨截圖）=====
  { report_id: '617625255510278315', broker: 'citi', broker_display: '花旗', report_date: '2026-06-08',
    title: 'Largan — 升評至買進（CPO 光學）', source_pdf: '617625255510278315_Largan 3008 upgrade to Buy_Citi_20260608.pdf',
    primary: '3008', parse_mode: 'text', stocks: [
      { raw: '大立光', code: '3008', rating_raw: 'Buy', target: 5325, prev: null, covered: true, action: 'upgrade',
        thesis: 'Computex 展出 CPO 光學方案 PMLA、半導體級精度為優勢；升評至買進、目標價上調 74% 至 5,325（25 倍 27/28 EPS）。與大摩中立看法分歧。' },
    ] },
  { report_id: '617625256667906566', broker: 'citi', broker_display: '花旗', report_date: '2026-06-08',
    title: 'Gold Circuit — 月營收創高', source_pdf: '617625256667906566_260608_citi_GCE.pdf',
    primary: '2368', parse_mode: 'text', stocks: [
      { raw: '金像電', code: '2368', rating_raw: 'Buy', target: 1740, prev: null, covered: true,
        thesis: '5 月營收創高 +88% 年增、產品組合佳 + ASP 漲；ASIC 客戶放量、新客戶機會。' },
    ] },
  { report_id: '617625257188000088', broker: 'ms', broker_display: '大摩', report_date: '2026-06-08',
    title: 'Aspeed — 加碼', source_pdf: '617625257188000088_260608_ms_aspeed.pdf',
    primary: '5274', parse_mode: 'text', stocks: [
      { raw: '信驊', code: '5274', rating_raw: 'Overweight', target: 23456, prev: null, covered: true,
        thesis: '伺服器 BMC 晶片龍頭、AI 伺服器帶動；EPS 連年高成長（189→295→467）。' },
    ] },
  { report_id: '617625257540583856', broker: 'ms', broker_display: '大摩', report_date: '2026-06-08',
    title: 'Genius 玉晶光 — 中立', source_pdf: '617625257540583856_260608_ms_genius.pdf',
    primary: '3406', parse_mode: 'text', stocks: [
      { raw: '玉晶光', code: '3406', rating_raw: 'Equal-weight', target: 425, prev: null, covered: true,
        thesis: '光學鏡頭；現價 654 已高於目標價 425（隱含下跌約 35%），中立偏空。' },
    ] },
  { report_id: '617625258077716977', broker: 'ms', broker_display: '大摩', report_date: '2026-06-08',
    title: 'Gold Circuit — 加碼', source_pdf: '617625258077716977_260608_ms_GCE.pdf',
    primary: '2368', parse_mode: 'text', stocks: [
      { raw: '金像電', code: '2368', rating_raw: 'Overweight', target: 1660, prev: null, covered: true,
        thesis: 'ASIC 主板放量；目標本益比反映 AI PCB 成長。' },
    ] },
  { report_id: '617625258530701911', broker: 'ms', broker_display: '大摩', report_date: '2026-06-08',
    title: 'Yageo 國巨 — 加碼', source_pdf: '617625258530701911_260608_ms_yageo.pdf',
    primary: '2327', parse_mode: 'text', stocks: [
      { raw: '國巨', code: '2327', rating_raw: 'Overweight', target: 1010, prev: null, covered: true,
        thesis: '被動元件/MLCC 結構性上升循環。注意：花旗同日給買進、目標價 1,500，分歧大。' },
    ] },
  { report_id: 'citi-yageo-20260608', broker: 'citi', broker_display: '花旗', report_date: '2026-06-08',
    title: 'Yageo 國巨 — 多產品結構性軋空（目標價大升至 1,500）', source_pdf: '（截圖提供，無 PDF 檔）',
    primary: '2327', parse_mode: 'text', stocks: [
      { raw: '國巨', code: '2327', rating_raw: 'Buy', target: 1500, prev: 495, covered: true,
        thesis: '多產品結構性軋空帶動獲利複利；MLCC/鉭質/電阻 ASP 上升、UTR 1.3；目標價自 495 大升至 1,500、+99.7% 空間。' },
    ] },
  { report_id: '617625258748543302', broker: 'ms', broker_display: '大摩', report_date: '2026-06-08',
    title: 'NVL72 供應鏈（主題）', source_pdf: '617625258748543302_260608_ms_nvl72.pdf',
    primary: null, parse_mode: 'text', stocks: [
      { raw: '廣達', code: '2382', rating_raw: 'Overweight', target: null, prev: null, covered: false,
        thesis: 'NVL72 機櫃組裝受惠。' },
      { raw: '緯創', code: '3231', rating_raw: 'Overweight', target: null, prev: null, covered: false,
        thesis: 'NVL72 供應鏈。' },
      { raw: '鴻海', code: '2317', rating_raw: 'Overweight', target: null, prev: null, covered: false,
        thesis: 'NVL72 組裝。' },
    ] },
  { report_id: '617625255695352441', broker: 'daiwa', broker_display: '大和', report_date: '2026-06-08',
    title: 'Taiwan Datacentre Hardware — 資料中心硬體（產業）', source_pdf: '617625255695352441_250608_daiwa_ Taiwan Datacentre Hardware.pdf',
    primary: null, parse_mode: 'text', stocks: [
      { raw: '緯穎', code: '6669', rating_raw: 'Buy', target: 7100, prev: null, covered: false,
        thesis: '5 月營收 +18% 年增、Trn3 放量；18 倍預估 EPS。' },
      { raw: '智邦', code: '2345', rating_raw: 'Buy', target: 3222, prev: null, covered: false,
        thesis: '5 月營收 +57% 年增、T3 放量。' },
      { raw: '台燿', code: '6274', rating_raw: 'Buy', target: 1680, prev: null, covered: false,
        thesis: 'CCL 漲價 + 產品組合優化、泰國廠 2H26 貢獻；48 倍預估 EPS。' },
      { raw: '金像電', code: '2368', rating_raw: 'Buy', target: null, prev: null, covered: false,
        thesis: '資料中心 CCL/PCB 受惠。' },
      { raw: '川湖', code: '2059', rating_raw: 'Buy', target: null, prev: null, covered: false,
        thesis: '滑軌、5 月營收 +172% 年增。' },
    ] },

  // ===== 本土券商（富邦/凱基/中信）=====
  { report_id: '617560489987145937', broker: 'fubon', broker_display: '富邦', report_date: '2026-06-02',
    title: 'AI 伺服器電力於 Computex（電源族群）', source_pdf: '617560489987145937_富邦-AI伺服器電力於Computex-20260603.pdf',
    primary: null, parse_mode: 'text', stocks: [
      { raw: '光寶科', code: '2301', rating_raw: '買進', target: 225, prev: null, covered: false,
        thesis: 'AI 伺服器電源；800VDC 趨勢受惠。' },
      { raw: '台達電', code: '2308', rating_raw: '買進', target: 3000, prev: null, covered: false,
        thesis: 'AI 電源龍頭；800VDC/液冷完整方案。' },
      { raw: '旭隼', code: '6409', rating_raw: '中立', target: 620, prev: null, covered: false,
        thesis: '不斷電系統；現價 742 已高於目標價 620。' },
    ] },
  { report_id: '617560489484354051', broker: 'kgi', broker_display: '凱基', report_date: '2026-06-02',
    title: 'Computex Takeaway（向子慧）', source_pdf: '617560489484354051_凱基投顧_Takeaway_Computex_向子慧_20260602.pdf',
    primary: '4938', parse_mode: 'text', stocks: [
      { raw: '和碩', code: '4938', rating_raw: '增加持股', target: null, prev: null, covered: true,
        thesis: 'Computex AI 伺服器/系統題材；增加持股。' },
    ] },
  { report_id: '617560489953853514', broker: 'kgi', broker_display: '凱基', report_date: '2026-06-03',
    title: 'Computex Takeaway（向子慧）', source_pdf: '617560489953853514_凱基投顧_Takeaway_Computex 2026_向子慧_20260603.pdf',
    primary: '2317', parse_mode: 'text', stocks: [
      { raw: '鴻海', code: '2317', rating_raw: '增加持股', target: null, prev: null, covered: true,
        thesis: 'Computex AI 機櫃組裝題材；增加持股。' },
    ] },
  { report_id: '617560489282502930', broker: 'kgi', broker_display: '凱基', report_date: '2026-06-04',
    title: 'Computex Takeaway（向子慧）', source_pdf: '617560489282502930_Takeaway_Computex_向子慧_20260604.pdf',
    primary: null, parse_mode: 'text', stocks: [
      { raw: '緯穎', code: '6669', rating_raw: '增加持股', target: null, prev: null, covered: false,
        thesis: '與緯創共同開發先進機櫃級 AI 伺服器、光學擴展、HVDC。' },
      { raw: '緯創', code: '3231', rating_raw: '增加持股', target: null, prev: null, covered: false,
        thesis: '128x800G 交換器、光互連；布局擴大至 AI 資料中心。' },
      { raw: '雙鴻', code: '3324', rating_raw: '增加持股', target: null, prev: null, covered: false,
        thesis: '散熱；液冷題材受惠。' },
    ] },
  { report_id: 'ctbc-weekly-20260608', broker: 'ctbc', broker_display: '中信', report_date: '2026-06-08',
    title: '台股策略週報（焦點個股）', source_pdf: '0608台股策略周報.pdf',
    primary: null, parse_mode: 'text', stocks: [
      { raw: '勤誠', code: '8210', rating_raw: '買進', target: null, prev: null, covered: false,
        thesis: 'AI 機殼；800VDC 水冷趨勢受惠，維持買進。' },
      { raw: '奇鋐', code: '3017', rating_raw: '買進', target: null, prev: null, covered: false,
        thesis: '散熱；水冷導入受惠，維持買進。' },
      { raw: '雙鴻', code: '3324', rating_raw: '買進', target: null, prev: null, covered: false,
        thesis: '散熱；水冷題材，維持買進。' },
      { raw: '健策', code: '3653', rating_raw: '看好', target: null, prev: null, covered: false,
        thesis: 'Computex 展示 Lid 與 MCL；看好技術導入先行優勢。' },
      { raw: '貿聯', code: '3665', rating_raw: '', target: null, prev: null, covered: false,
        thesis: 'Power Whips/Busbars/HVDC Cables；支援 800VDC、448Gbps、CPO。' },
      { raw: '金居', code: '8358', rating_raw: '', target: null, prev: null, covered: false,
        thesis: 'CCL 銅箔供應鏈。' },
      { raw: '台光電', code: '2383', rating_raw: '', target: null, prev: null, covered: false,
        thesis: 'CCL 供應鏈。' },
      { raw: '印能科技', code: '7734', rating_raw: '', target: null, prev: null, covered: false,
        thesis: '封裝設備供應鏈。' },
    ] },

  // ===== 中信投顧 投資早報研究摘要 2026-06-10 =====
  { report_id: 'ctbc-6613-20260610', broker: 'ctbc', broker_display: '中信', report_date: '2026-06-10',
    title: '朋億 — 買進（1Q26 谷底、2H26 增速）', source_pdf: '617778941570056555_610台股晨報.pdf',
    primary: '6613', parse_mode: 'text', stocks: [
      { raw: '朋億', code: '6613', rating_raw: '買進', target: 400, prev: 265, covered: true,
        thesis: '1Q26 為全年谷底、2H26 增速更上層樓；毛利率上修；目標價 400（2027 EPS×17 倍）。' },
    ] },
  { report_id: 'ctbc-6415-20260610', broker: 'ctbc', broker_display: '中信', report_date: '2026-06-10',
    title: '矽力-KY — 增加持股（資料中心成長快）', source_pdf: '617778941570056555_610台股晨報.pdf',
    primary: '6415', parse_mode: 'text', stocks: [
      { raw: '矽力-KY', code: '6415', rating_raw: '增加持股', target: 610, prev: 550, covered: true,
        thesis: '資料中心營收成長快速、1Q26 伺服器營收遠優於預期；高毛利產品比重提升；目標價上調至 610。' },
    ] },
  { report_id: 'ctbc-4137-20260610', broker: 'ctbc', broker_display: '中信', report_date: '2026-06-10',
    title: '麗豐-KY — 中立（殖利率防禦）', source_pdf: '617778941570056555_610台股晨報.pdf',
    primary: '4137', parse_mode: 'text', stocks: [
      { raw: '麗豐-KY', code: '4137', rating_raw: '中立', target: 110, prev: 102, covered: true,
        thesis: '殖利率 9% 具下檔防禦，惟成長動能待觀察；4~5 月營收低於預期。' },
    ] },
  { report_id: 'ctbc-5388-20260610', broker: 'ctbc', broker_display: '中信', report_date: '2026-06-10',
    title: '中磊 — 調升買進（訂單價量齊揚）', source_pdf: '617778941570056555_610台股晨報.pdf',
    primary: '5388', parse_mode: 'text', stocks: [
      { raw: '中磊', code: '5388', rating_raw: '買進', target: 110, prev: 90, covered: true, action: 'upgrade',
        thesis: '訂單價量齊揚、全年營收挑戰新高、淡季不淡；調升至買進，目標價 110。' },
    ] },
];

async function main() {
  const master = await loadStockMaster();
  const byCode = new Map(master.entries.map(e => [e.code, e]));
  await loadBrokerRegistry(); // 確保 registry 可載（缺檔回 DEFAULT_BROKERS）

  // group by date
  const byDate = new Map<string, ReportSpec[]>();
  for (const s of SPECS) {
    const arr = byDate.get(s.report_date) ?? [];
    arr.push(s);
    byDate.set(s.report_date, arr);
  }

  const generated_at = new Date().toISOString();
  let droppedNonTw = 0;

  for (const [date, specs] of byDate) {
    const reports: BrokerReport[] = specs.map(spec => {
      const stocks: BrokerStockMention[] = spec.stocks.map(st => {
        const rating = normalizeRating(st.rating_raw);
        const entry = st.code ? byCode.get(st.code) : undefined;
        if (st.code && !entry) {
          throw new Error(`code ${st.code} (${st.raw}) 不在 stock-master，請先確認代號`);
        }
        const matched = entry
          ? { code: entry.code, name: entry.name, market: entry.market, confidence: 1, match_via: 'exact_code' as const }
          : null;
        if (!matched) droppedNonTw += 1;
        return {
          raw_query: st.raw,
          matched,
          market: matched ? ('TW' as const) : ('OTHER' as const),
          broker: spec.broker,
          rating_raw: st.rating_raw,
          rating,
          rating_action: st.action ?? 'maintain',
          target_price: st.target,
          prev_target_price: st.prev,
          report_currency: st.currency ?? 'TWD',
          sentiment: sentimentFromRating(rating),
          covered: st.covered,
          thesis: st.thesis,
          context: st.thesis,
          llm_confidence: 0.95,
        };
      });
      return {
        report_id: spec.report_id,
        broker: spec.broker,
        broker_display: spec.broker_display,
        report_date: spec.report_date,
        title: spec.title,
        source_pdf: spec.source_pdf,
        primary_stock_code: spec.primary,
        stocks,
        parse_mode: spec.parse_mode,
        generated_at,
      };
    });

    const day: BrokerDailyReports = {
      date,
      generated_at,
      reports,
      stats: { report_count: 0, unique_brokers: 0, unique_stocks: 0, covered_count: 0 }, // saveDailyReports 會重算
    };
    await saveDailyReports(day);
    console.log(`✓ ${date}: ${reports.length} reports written`);
  }
  console.log(`done. 非台股 mention（matched=null）共 ${droppedNonTw} 筆（目前種子全為台股，應為 0）。`);
}

main().catch(err => { console.error(err); process.exit(1); });
