/**
 * 38 題材清單 × 成分股（2026-06-12 A2 起；2026-06-19 加玻璃基板 + 補各題材漏網龍頭；
 *  2026-06-20 補各題材二線/上下游 ~60 檔（含 PCB 鏈尖點/富喬/金居）
 *  + 新增 綠能/伺服器電源/高速連接 三題材；2026-06-22 加 成熟製程
 *  + IC設計/矽晶圓/第三代半導體/網通/半導體通路/工具機/自行車 七題材；
 *  2026-08-25 依公司官網/法說/年報重查 CPO、矽光子、光通訊供應鏈；
 *  2026-08-26 補瑞軒 CPO Shuffle Box 周邊代工題材，並依 2026 公司公告／法說
 *  重建 CPO、矽光子、光通訊三個集合；同日全 38 題材複核，校正 ASIC 並補齊
 *  CoWoS／先進封裝／玻璃基板核心業者）
 *
 * 來源：使用者選股規格書 Step 4 的 25 題材 + Step 3/5 點名股 + 2026-06 市場概念股審查補強，
 * 成分沿用/校正 lib/scanner/conceptMap.ts 的概念分類。
 * 所有代號↔名稱已逐一對 data/youtube/stock-master.json 驗證
 * （合約測試 __tests__/contracts/theme-map.test.ts 持續守護）。
 *
 * 產品定位：這是 Rockstock 維護的「市場題材」名單，不是 TWSE／TPEx 官方產業分類。
 * 顯示層允許一股多題材；股票身分、上市櫃市場及數值仍須由官方基礎資料校驗。
 *
 * 設計註記：
 * - 同一檔股票可屬多個題材（CPO ⊂ 光通訊、CoWoS設備 ≈ 半導體設備）— 刻意保留，
 *   因此不可當作全市場互斥分類或拿來計算市場廣度
 * - 「電力」與「重電」v1 成分相同（規格書分列、台股實際是同一族群）
 * - 「中國政策受惠」成分最弱（內需收成股 proxy），排名參考價值低 — 顯示時敬陪末座可接受
 */

export interface ThemeStock {
  /** 裸代號 */
  code: string;
  /** 中文名（與 stock-master 一致，含 -KY 後綴） */
  name: string;
}

export const THEME_MAP: Record<string, ThemeStock[]> = {
  'AI伺服器': [
    // 2026-08-26 全題材稽核：AI 伺服器遠端管理的 BMC SoC
    { code: '5274', name: '信驊' },
    { code: '2382', name: '廣達' }, { code: '3231', name: '緯創' },
    { code: '6669', name: '緯穎' }, { code: '2376', name: '技嘉' },
    { code: '2324', name: '仁寶' }, { code: '3706', name: '神達' },
    { code: '2353', name: '宏碁' }, { code: '2317', name: '鴻海' },
    { code: '2356', name: '英業達' }, { code: '4938', name: '和碩' },
    { code: '2357', name: '華碩' }, { code: '2377', name: '微星' },
    // 2026-06-20 補：伺服器滑軌/機殼/連接器
    { code: '2059', name: '川湖' }, { code: '8210', name: '勤誠' },
    { code: '3693', name: '營邦' }, { code: '3533', name: '嘉澤' },
  ],
  '散熱': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '6805', name: '富世達' },
    { code: '3017', name: '奇鋐' }, { code: '3324', name: '雙鴻' },
    { code: '3653', name: '健策' }, { code: '8996', name: '高力' },
    { code: '2421', name: '建準' }, { code: '6230', name: '尼得科超眾' },
    { code: '3338', name: '泰碩' }, { code: '3013', name: '晟銘電' },
    // 2026-06-20 補：散熱模組/風扇二線
    { code: '3483', name: '力致' }, { code: '6275', name: '元山' },
    { code: '6124', name: '業強' }, { code: '6591', name: '動力-KY' },
  ],
  'ASIC': [
    { code: '3661', name: '世芯-KY' }, { code: '3443', name: '創意' },
    { code: '3035', name: '智原' }, { code: '2454', name: '聯發科' },
    // 2026-08-26 全題材稽核：祥碩官網／年報明列客製 ASIC；瑞昱屬標準型 IC 設計，移回 IC設計
    { code: '5269', name: '祥碩' }, { code: '3529', name: '力旺' },
    { code: '6533', name: '晶心科' },
    // 2026-06-20 補：矽智財（IP）
    { code: '6643', name: 'M31' },
  ],
  'CPO': [
    // 2026-08-26 稽核補：晶圓平台、ASIC/CPO 系統與整機整合（公司正式揭露或合作公告）
    { code: '2303', name: '聯電' }, { code: '2317', name: '鴻海' },
    { code: '2382', name: '廣達' }, { code: '2454', name: '聯發科' },
    { code: '3443', name: '創意' }, { code: '6669', name: '緯穎' },
    // 2026-08-26 稽核補：PIC/EIC、矽光封裝、連接與 Micro LED 光互連
    { code: '2458', name: '義隆' }, { code: '3265', name: '台星科' },
    { code: '6147', name: '頎邦' }, { code: '6197', name: '佳必琪' },
    { code: '6854', name: '錼創科技-KY創' },
    // 2026-08-26 稽核補：CPO 光電測試、驗證、分析與 FAU/OE 耦合設備
    { code: '2360', name: '致茂' }, { code: '2449', name: '京元電子' },
    { code: '3289', name: '宜特' }, { code: '3587', name: '閎康' },
    { code: '6187', name: '萬潤' }, { code: '6510', name: '精測' },
    { code: '6515', name: '穎崴' }, { code: '6706', name: '惠特' },
    { code: '6830', name: '汎銓' }, { code: '7728', name: '光焱科技' },
    { code: '7769', name: '鴻勁' },
    // 2026-08-26 補：市場供應鏈資訊指向波若威 Shuffle Box 代工；屬 CPO 周邊製造，非矽光子核心元件
    { code: '2489', name: '瑞軒' },
    // 2026-08-25 稽核補：平台/交換器/光學/封裝測試/光源與材料（均有公司級產品或量產證據）
    { code: '2330', name: '台積電' }, { code: '2345', name: '智邦' },
    { code: '2409', name: '友達' }, { code: '2426', name: '鼎元' },
    { code: '3008', name: '大立光' }, { code: '3264', name: '欣銓' },
    { code: '3711', name: '日月光投控' }, { code: '3714', name: '富采' },
    { code: '4971', name: 'IET-KY' }, { code: '4991', name: '環宇-KY' },
    { code: '6223', name: '旺矽' }, { code: '6257', name: '矽格' },
    { code: '6426', name: '統新' },
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '3665', name: '貿聯-KY' },
    { code: '6715', name: '嘉基' },
    { code: '4977', name: '眾達-KY' }, { code: '3363', name: '上詮' },
    { code: '6442', name: '光聖' }, { code: '3081', name: '聯亞' },
    { code: '4979', name: '華星光' }, { code: '3163', name: '波若威' },
    { code: '6451', name: '訊芯-KY' }, { code: '3105', name: '穩懋' },
    { code: '3450', name: '聯鈞' }, { code: '2455', name: '全新' },
    // 2026-06-20 補：光模組/光通訊元件
    { code: '3234', name: '光環' }, { code: '4908', name: '前鼎' },
  ],
  '矽光子': [
    // 2026-08-26 稽核補：SiPh 晶圓平台、ASIC/PIC/EIC、封裝、系統整合與光電連接
    { code: '2303', name: '聯電' }, { code: '2317', name: '鴻海' },
    { code: '2454', name: '聯發科' }, { code: '6669', name: '緯穎' },
    { code: '2458', name: '義隆' }, { code: '3265', name: '台星科' },
    { code: '3443', name: '創意' }, { code: '6147', name: '頎邦' },
    { code: '6197', name: '佳必琪' }, { code: '6271', name: '同欣電' },
    // 2026-08-26 稽核補：SiPh/CPO 光電測試、驗證、分析與自動化設備
    { code: '2360', name: '致茂' }, { code: '2449', name: '京元電子' },
    { code: '3289', name: '宜特' }, { code: '3587', name: '閎康' },
    { code: '6187', name: '萬潤' }, { code: '6510', name: '精測' },
    { code: '6515', name: '穎崴' }, { code: '6706', name: '惠特' },
    { code: '6830', name: '汎銓' }, { code: '7728', name: '光焱科技' },
    { code: '7769', name: '鴻勁' },
    // 2026-08-25 稽核補：COUPE/交換器、耦光、異質整合封裝、SiPh 測試與外部光源
    { code: '2330', name: '台積電' }, { code: '2345', name: '智邦' },
    { code: '3008', name: '大立光' }, { code: '3264', name: '欣銓' },
    { code: '3711', name: '日月光投控' }, { code: '3714', name: '富采' },
    { code: '4971', name: 'IET-KY' }, { code: '4991', name: '環宇-KY' },
    { code: '6223', name: '旺矽' }, { code: '6257', name: '矽格' },
    { code: '6426', name: '統新' },
    // 2026-08-26 稽核補：官方揭露 SiPh 光互連能力，以及供 SiPh/CPO 使用的外置光源
    { code: '3665', name: '貿聯-KY' }, { code: '4908', name: '前鼎' },
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '3450', name: '聯鈞' },
    { code: '3163', name: '波若威' },
    { code: '4977', name: '眾達-KY' },
    { code: '3363', name: '上詮' }, { code: '3081', name: '聯亞' },
    { code: '6442', name: '光聖' }, { code: '4979', name: '華星光' },
    { code: '6451', name: '訊芯-KY' }, { code: '3105', name: '穩懋' },
    { code: '2455', name: '全新' },
  ],
  '光通訊': [
    // 2026-08-26 稽核補：CPO 新增成員；CPO 維持為光通訊子集合
    { code: '2303', name: '聯電' }, { code: '2317', name: '鴻海' },
    { code: '2360', name: '致茂' }, { code: '2382', name: '廣達' },
    { code: '2449', name: '京元電子' }, { code: '2454', name: '聯發科' },
    { code: '2458', name: '義隆' }, { code: '3265', name: '台星科' },
    { code: '3289', name: '宜特' }, { code: '3443', name: '創意' },
    { code: '3587', name: '閎康' }, { code: '6147', name: '頎邦' },
    { code: '6187', name: '萬潤' }, { code: '6197', name: '佳必琪' },
    { code: '6510', name: '精測' }, { code: '6515', name: '穎崴' },
    { code: '6669', name: '緯穎' }, { code: '6706', name: '惠特' },
    { code: '6830', name: '汎銓' }, { code: '6854', name: '錼創科技-KY創' },
    { code: '7728', name: '光焱科技' }, { code: '7769', name: '鴻勁' },
    // 2026-08-26 稽核補：SiPh 光模組封裝，以及非 CPO 的光收發／光纖電纜業者
    { code: '6271', name: '同欣電' }, { code: '6526', name: '達發' },
    { code: '6530', name: '創威' }, { code: '8011', name: '台通' },
    { code: '4903', name: '聯光通' },
    // 2026-08-26 補：CPO Shuffle Box（光纖跳線盒）周邊代工題材
    { code: '2489', name: '瑞軒' },
    // 2026-08-25 稽核補：CPO 是光通訊子集合，維持 CPO 新增股在此完整覆蓋
    { code: '2330', name: '台積電' }, { code: '2409', name: '友達' },
    { code: '2426', name: '鼎元' }, { code: '3008', name: '大立光' },
    { code: '3264', name: '欣銓' }, { code: '3711', name: '日月光投控' },
    { code: '3714', name: '富采' }, { code: '4971', name: 'IET-KY' },
    { code: '4991', name: '環宇-KY' }, { code: '6223', name: '旺矽' },
    { code: '6257', name: '矽格' }, { code: '6426', name: '統新' },
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '3665', name: '貿聯-KY' },
    { code: '6715', name: '嘉基' },
    { code: '3081', name: '聯亞' }, { code: '4979', name: '華星光' },
    { code: '3363', name: '上詮' }, { code: '6442', name: '光聖' },
    { code: '3163', name: '波若威' }, { code: '4977', name: '眾達-KY' },
    { code: '2345', name: '智邦' }, { code: '6451', name: '訊芯-KY' },
    { code: '3105', name: '穩懋' }, { code: '3450', name: '聯鈞' },
    { code: '2455', name: '全新' },
    // 2026-06-20 補：光收發/光通訊元件
    { code: '3234', name: '光環' }, { code: '4908', name: '前鼎' },
  ],
  '記憶體': [
    { code: '2408', name: '南亞科' }, { code: '2344', name: '華邦電' },
    { code: '6770', name: '力積電' }, { code: '3006', name: '晶豪科' },
    { code: '8299', name: '群聯' }, { code: '2337', name: '旺宏' },
    { code: '4967', name: '十銓' }, { code: '3260', name: '威剛' },
    { code: '5289', name: '宜鼎' }, { code: '8271', name: '宇瞻' },
    // 2026-06-20 補：DRAM IP / 記憶體模組
    { code: '5351', name: '鈺創' }, { code: '6531', name: '愛普*' },
    { code: '2451', name: '創見' },
    // 2026-06-22 補：消費性 flash 儲存/讀卡機/隨身碟（二線）
    { code: '8088', name: '品安' },
  ],
  '被動元件': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '3357', name: '臺慶科' },
    { code: '2327', name: '國巨*' }, { code: '2492', name: '華新科' },
    { code: '3026', name: '禾伸堂' }, { code: '2375', name: '凱美' },
    { code: '6173', name: '信昌電' }, { code: '2478', name: '大毅' },
    { code: '3236', name: '千如' }, { code: '2472', name: '立隆電' },
    { code: '6449', name: '鈺邦' },
    // 2026-06-22 補：被動元件二線
  ],
  'PCB': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '2316', name: '楠梓電' },
    { code: '6191', name: '精成科' },
    { code: '3037', name: '欣興' }, { code: '8046', name: '南電' },
    { code: '3189', name: '景碩' }, { code: '6269', name: '台郡' },
    { code: '4958', name: '臻鼎-KY' }, { code: '2368', name: '金像電' },
    { code: '3044', name: '健鼎' }, { code: '2313', name: '華通' },
    { code: '2367', name: '燿華' },
    // 鑽孔耗材：尖點＝PCB 微型鑽針（非板廠，PCB 上游耗材）
    { code: '8021', name: '尖點' },
    // 2026-06-20 補：車用/軟板/伺服器/載板二線
    { code: '2355', name: '敬鵬' }, { code: '3715', name: '定穎投控' },
    { code: '6153', name: '嘉聯益' }, { code: '8155', name: '博智' },
    { code: '5439', name: '高技' },
  ],
  'CCL': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '6672', name: '騰輝電子-KY' },
    { code: '1802', name: '台玻' },
    { code: '2383', name: '台光電' }, { code: '6213', name: '聯茂' },
    { code: '6274', name: '台燿' },
    // 上游原料：銅箔（金居）、玻纖布（富喬）— 壓成銅箔基板的兩大關鍵料
    { code: '8358', name: '金居' }, { code: '1815', name: '富喬' },
  ],
  '先進封裝': [
    // 2026-08-26 全題材稽核：3DFabric/CoWoS/SoIC 核心，以及已量產 FOPLP 的面板級封裝
    { code: '2330', name: '台積電' }, { code: '3481', name: '群創' },
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '6515', name: '穎崴' },
    { code: '6223', name: '旺矽' },
    { code: '6510', name: '精測' },
    { code: '3711', name: '日月光投控' }, { code: '6239', name: '力成' },
    { code: '6147', name: '頎邦' }, { code: '8150', name: '南茂' },
    { code: '2449', name: '京元電子' },
    // 2026-06-20 補：封測二線（異質整合/打線/導線架）
    { code: '6271', name: '同欣電' }, { code: '2441', name: '超豐' },
    { code: '2369', name: '菱生' },
    // 2026-06-22 補：記憶體封測/晶圓測試
    { code: '8131', name: '福懋科' }, { code: '3264', name: '欣銓' },
    { code: '2329', name: '華泰' }, { code: '6257', name: '矽格' },
  ],
  'CoWoS': [
    // CoWoS 為台積電註冊並量產的先進封裝平台，核心廠不可只列周邊設備供應鏈
    { code: '2330', name: '台積電' },
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '3680', name: '家登' },
    { code: '6223', name: '旺矽' },
    { code: '6515', name: '穎崴' },
    { code: '6187', name: '萬潤' }, { code: '3131', name: '弘塑' },
    { code: '3583', name: '辛耘' }, { code: '6196', name: '帆宣' },
    { code: '2467', name: '志聖' }, { code: '5443', name: '均豪' },
  ],
  '半導體設備': [
    // 2026-08-26 全題材稽核：半導體／矽光子晶片與光電元件量測、分選設備
    { code: '2360', name: '致茂' }, { code: '6706', name: '惠特' },
    { code: '7728', name: '光焱科技' }, { code: '7769', name: '鴻勁' },
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '6223', name: '旺矽' },
    { code: '6515', name: '穎崴' },
    { code: '6187', name: '萬潤' }, { code: '2467', name: '志聖' },
    { code: '3131', name: '弘塑' }, { code: '3583', name: '辛耘' },
    { code: '5443', name: '均豪' }, { code: '6196', name: '帆宣' },
    { code: '6510', name: '精測' }, { code: '3680', name: '家登' },
    { code: '3413', name: '京鼎' }, { code: '2404', name: '漢唐' },
    // 2026-06-20 補：CMP耗材/晶圓載具/真空/自動化設備
    { code: '1560', name: '中砂' }, { code: '8091', name: '翔名' },
    { code: '6208', name: '日揚' }, { code: '6438', name: '迅得' },
    // 2026-06-22 補：檢測/量測/濕製程設備
    { code: '6640', name: '均華' }, { code: '3402', name: '漢科' },
  ],
  // 玻璃基板 / TGV（玻璃穿孔）先進封裝載板 — 2026 驗證年，Intel 玻璃基板登場帶動台廠
  '玻璃基板': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '1802', name: '台玻' },
    // 載板廠轉玻璃核心載板（欣興＝Intel R&D 夥伴；南電/景碩同步切入）
    { code: '3037', name: '欣興' }, { code: '8046', name: '南電' },
    { code: '3189', name: '景碩' },
    // 群創 FOPLP 已量產，TGV 玻璃基板已進客戶驗證
    { code: '3481', name: '群創' },
    // 玻璃加工（正達熱成型 TGV、TPK-KY 觸控玻璃轉 TGV 試產）
    { code: '3149', name: '正達' }, { code: '3673', name: 'TPK-KY' },
    // TGV 雷射鑽孔 / 封裝設備
    { code: '6207', name: '雷科' }, { code: '6664', name: '群翊' },
    { code: '8027', name: '鈦昇' },
    // 高階玻璃材料（中釉類晶玻璃陶瓷、晶呈氣相蝕刻）
    { code: '1809', name: '中釉' }, { code: '4768', name: '晶呈科技' },
  ],
  '機器人': [
    // 2026-08-26 全題材稽核：自有工業機器人產品，以及 AI 人形機器人系統整合
    { code: '2308', name: '台達電' }, { code: '2317', name: '鴻海' },
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '4585', name: '達明' },
    { code: '7750', name: '新代' },
    { code: '3023', name: '信邦' },
    { code: '6188', name: '廣明' },
    { code: '2049', name: '上銀' }, { code: '1590', name: '亞德客-KY' },
    { code: '6215', name: '和椿' }, { code: '4583', name: '台灣精銳' },
    { code: '1536', name: '和大' }, { code: '4540', name: '全球傳動' },
    { code: '2359', name: '所羅門' }, { code: '4576', name: '大銀微系統' },
    // 2026-06-20 補：線性滑軌/自動化整合
    { code: '1597', name: '直得' }, { code: '2464', name: '盟立' },
    { code: '6125', name: '廣運' }, { code: '8374', name: '羅昇' },
  ],
  '重電': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '1608', name: '華榮' },
    { code: '1513', name: '中興電' }, { code: '1519', name: '華城' },
    { code: '1503', name: '士電' }, { code: '1504', name: '東元' },
    { code: '1514', name: '亞力' }, { code: '2371', name: '大同' },
    // 2026-06-22 補：電網/電線電纜
    { code: '1605', name: '華新' }, { code: '1609', name: '大亞' },
  ],
  '電力': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '1608', name: '華榮' },
    { code: '1513', name: '中興電' }, { code: '1519', name: '華城' },
    { code: '1503', name: '士電' }, { code: '1504', name: '東元' },
    { code: '1514', name: '亞力' }, { code: '2371', name: '大同' },
    // 2026-06-22 補：電網/電線電纜
    { code: '1605', name: '華新' }, { code: '1609', name: '大亞' },
  ],
  '軍工': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '2645', name: '長榮航太' },
    { code: '5222', name: '全訊' },
    { code: '2634', name: '漢翔' }, { code: '8033', name: '雷虎' },
    { code: '3005', name: '神基' }, { code: '6753', name: '龍德造船' },
    { code: '5371', name: '中光電' },
    // 2026-06-20 補：航太結構/維修
    { code: '2630', name: '亞航' }, { code: '8222', name: '寶一' },
  ],
  '生技': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '6919', name: '康霈*' },
    { code: '4142', name: '國光生' },
    { code: '4726', name: '永昕' },
    { code: '1762', name: '中化生' },
    { code: '6547', name: '高端疫苗' }, { code: '4743', name: '合一' },
    { code: '6446', name: '藥華藥' }, { code: '1760', name: '寶齡富錦' },
    { code: '4147', name: '中裕' }, { code: '6472', name: '保瑞' },
    { code: '1795', name: '美時' },
    // 2026-06-20 補：新藥/生物相似藥二線
    { code: '6589', name: '台康生技' }, { code: '4162', name: '智擎' },
    { code: '6620', name: '漢達' }, { code: '6550', name: '北極星藥業-KY' },
    { code: '6541', name: '泰福-KY' }, { code: '6576', name: '逸達' },
  ],
  '面板': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '6176', name: '瑞儀' },
    { code: '5371', name: '中光電' },
    { code: '6456', name: 'GIS-KY' },
    { code: '2409', name: '友達' }, { code: '3481', name: '群創' },
    { code: '6116', name: '彩晶' }, { code: '8069', name: '元太' },
    // 2026-06-20 補：中小尺寸面板/背光模組
    { code: '8105', name: '凌巨' }, { code: '6120', name: '達運' },
  ],
  '車用電子': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '2360', name: '致茂' },
    { code: '2231', name: '為升' }, 
    { code: '2308', name: '台達電' }, { code: '8261', name: '富鼎' },
    { code: '6279', name: '胡連' }, { code: '1533', name: '車王電' },
    { code: '2497', name: '怡利電' },
    // 2026-06-20 補：ADAS/車用整流/端子/線束/鈑件
    { code: '3552', name: '同致' }, { code: '8255', name: '朋程' },
    { code: '3003', name: '健和興' }, { code: '3665', name: '貿聯-KY' },
    { code: '2239', name: '英利-KY' },
    // 2026-06-22 補：車燈
    { code: '1521', name: '大億' },
  ],
  '航運': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '2646', name: '星宇航空' },
    { code: '2636', name: '台驊控股' },
    { code: '2603', name: '長榮' }, { code: '2609', name: '陽明' },
    { code: '2615', name: '萬海' }, { code: '2618', name: '長榮航' },
    { code: '2610', name: '華航' }, { code: '2637', name: '慧洋-KY' },
    { code: '2606', name: '裕民' },
    // 2026-06-20 補：散裝航運
    { code: '5608', name: '四維航' }, { code: '2612', name: '中航' },
    { code: '2605', name: '新興' },
  ],
  '金融': [
    { code: '2881', name: '富邦金' }, { code: '2882', name: '國泰金' },
    { code: '2883', name: '凱基金' }, { code: '2884', name: '玉山金' },
    { code: '2885', name: '元大金' }, { code: '2886', name: '兆豐金' },
    { code: '2891', name: '中信金' }, { code: '2892', name: '第一金' },
    { code: '5880', name: '合庫金' }, { code: '2890', name: '永豐金' },
    { code: '2880', name: '華南金' }, { code: '2887', name: '台新新光金' },
    // 2026-06-20 補：漏網金控
    { code: '2889', name: '國票金' },
  ],
  '低軌衛星': [
    // 2026-08-26 全題材稽核：NR-NTN 晶片、玻璃基板衛星天線與低軌通訊電源
    { code: '2454', name: '聯發科' }, { code: '2409', name: '友達' },
    { code: '2457', name: '飛宏' },
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '5222', name: '全訊' },
    { code: '3481', name: '群創' },
    { code: '3152', name: '璟德' },
    { code: '3491', name: '昇達科' }, { code: '2455', name: '全新' },
    { code: '2313', name: '華通' },
    { code: '6285', name: '啟碁' }, { code: '2314', name: '台揚' },
    { code: '3105', name: '穩懋' },
    // 2026-06-20 補：衛星 RF 模組
    { code: '6271', name: '同欣電' },
  ],
  '蘋果供應鏈': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '2392', name: '正崴' },
    { code: '2317', name: '鴻海' }, { code: '3008', name: '大立光' },
    { code: '4958', name: '臻鼎-KY' }, { code: '4938', name: '和碩' },
    { code: '2382', name: '廣達' }, { code: '6269', name: '台郡' },
    { code: '2330', name: '台積電' },
    // 2026-06-20 補：鏡頭/聲學/周邊
    { code: '3406', name: '玉晶光' }, { code: '2439', name: '美律' },
    { code: '4915', name: '致伸' },
  ],
  // 真靠中國市場零售/內需收成（2026-06-22 稽核：移除基建/出口/代工/已脫手的台泥/寶成/巨大/潤泰全/潤泰新）
  '中國政策受惠': [
    { code: '1216', name: '統一' }, { code: '1227', name: '佳格' },
    { code: '2912', name: '統一超' }, { code: '1210', name: '大成' },
  ],
  // 2026-06-20 新增：綠能/發電（太陽能 + 風電 + 儲能 + 綠電售電 + 電纜）
  '綠能': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '3708', name: '上緯投控' },
    { code: '8926', name: '台汽電' },
    { code: '6806', name: '森崴能源' }, { code: '6869', name: '雲豹能源' },
    { code: '6873', name: '泓德能源' }, { code: '6443', name: '元晶' },
    { code: '3576', name: '聯合再生' }, { code: '6477', name: '安集' },
    // 2026-06-20 稽核：移除大亞1609（綠能僅佔營收~5%，本質電纜廠）
    { code: '6244', name: '茂迪' },
  ],
  // 2026-06-20 新增：伺服器電源/BBU（電源供應器 + 電池備援模組/超級電容）
  '伺服器電源': [
    // 2026-08-26 全題材稽核：AI 資料中心 power shelf／BBU／機櫃匯流排與電源線束
    { code: '3665', name: '貿聯-KY' },
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '2457', name: '飛宏' },
    { code: '2308', name: '台達電' }, { code: '2301', name: '光寶科' },
    { code: '6282', name: '康舒' }, { code: '6412', name: '群電' },
    { code: '3015', name: '全漢' }, { code: '6781', name: 'AES-KY' },
    { code: '3211', name: '順達' }, { code: '3323', name: '加百裕' },
    { code: '4931', name: '新盛力' }, { code: '6121', name: '新普' },
    // 2026-06-20 稽核補：GB200 BBU 電池模組連接器
    { code: '3003', name: '健和興' },
  ],
  // 2026-06-20 新增：高速連接/銅纜（伺服器 socket + 高速銅纜 + 連接器/線束）
  '高速連接': [
    { code: '3533', name: '嘉澤' }, { code: '6205', name: '詮欣' },
    { code: '3526', name: '凡甲' }, 
    { code: '5457', name: '宣德' }, { code: '3023', name: '信邦' },
    { code: '6134', name: '萬旭' }, { code: '3665', name: '貿聯-KY' },
    // 2026-06-20 稽核補：DAC 直連銅纜純度龍頭（移除維熹3501/良維6290＝電源線非高速訊號）
    { code: '6197', name: '佳必琪' },
  ],
  // 2026-06-22 新增：成熟製程（非先進節點代工 — 8吋/特殊製程/功率/化合物半導體；不含台積電=先進製程）
  '成熟製程': [
    { code: '2303', name: '聯電' }, { code: '5347', name: '世界' },
    { code: '6770', name: '力積電' }, { code: '3707', name: '漢磊' },
    { code: '2342', name: '茂矽' },
  ],
  // 2026-06-22 新增：IC設計（標準產品 IC 設計廠 — SoC/連網/類比電源/IO 控制；ASIC 服務廠另列）
  'IC設計': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '4919', name: '新唐' },
    { code: '3227', name: '原相' },
    { code: '6202', name: '盛群' },
    { code: '6138', name: '茂達' },
    { code: '8081', name: '致新' },
    { code: '4961', name: '天鈺' },
    { code: '2454', name: '聯發科' }, { code: '3034', name: '聯詠' },
    { code: '2379', name: '瑞昱' }, { code: '4966', name: '譜瑞-KY' },
    { code: '5269', name: '祥碩' }, { code: '5274', name: '信驊' },
    { code: '8016', name: '矽創' }, { code: '2458', name: '義隆' },
    { code: '6526', name: '達發' }, { code: '6415', name: '矽力*-KY' },
    { code: '3014', name: '聯陽' }, { code: '6104', name: '創惟' },
    { code: '2401', name: '凌陽' }, { code: '8054', name: '安國' },
  ],
  // 2026-06-22 新增：矽晶圓（半導體基板材料 — 長晶/切磨/磊晶）
  '矽晶圓': [
    { code: '6488', name: '環球晶' }, { code: '5483', name: '中美晶' },
    { code: '3532', name: '台勝科' }, { code: '6182', name: '合晶' },
    { code: '3016', name: '嘉晶' },
  ],
  // 2026-06-22 新增：第三代半導體（化合物 SiC/GaN — 功率/射頻/磊晶基板）
  '第三代半導體': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '3714', name: '富采' },
    { code: '2455', name: '全新' },
    { code: '3105', name: '穩懋' }, { code: '8086', name: '宏捷科' },
    { code: '3707', name: '漢磊' }, { code: '3016', name: '嘉晶' },
    { code: '2481', name: '強茂' }, { code: '5425', name: '台半' },
    { code: '6488', name: '環球晶' },
  ],
  // 2026-06-22 新增：網通（交換器/路由器/Wi-Fi/網通設備）
  '網通': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '3558', name: '神準' },
    { code: '6263', name: '普萊德' },
    { code: '2345', name: '智邦' }, { code: '6285', name: '啟碁' },
    { code: '5388', name: '中磊' }, { code: '3596', name: '智易' },
    { code: '3380', name: '明泰' }, { code: '3704', name: '合勤控' },
    { code: '2332', name: '友訊' }, { code: '2419', name: '仲琦' },
    { code: '4906', name: '正文' },
  ],
  // 2026-06-22 新增：半導體通路（IC 通路代理商）
  '半導體通路': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '3048', name: '益登' },
    { code: '3702', name: '大聯大' }, { code: '3036', name: '文曄' },
    { code: '8112', name: '至上' }, { code: '2347', name: '聯強' },
    { code: '3028', name: '增你強' },
  ],
  // 2026-06-22 新增：工具機（CNC 工具機/綜合加工機/自動化）
  '工具機': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '1540', name: '喬福' },
    { code: '2049', name: '上銀' }, { code: '1583', name: '程泰' },
    { code: '1530', name: '亞崴' }, { code: '4526', name: '東台' },
    { code: '6609', name: '瀧澤科' }, { code: '4510', name: '高鋒' },
  ],
  // 2026-06-22 新增：自行車（整車/鏈條/零組件）
  '自行車': [
    // 2026-06-22 稽核補（分身研究+master 驗證）
    { code: '4536', name: '拓凱' },
    { code: '6804', name: '明係' },
    { code: '9921', name: '巨大' }, { code: '9914', name: '美利達' },
    { code: '5306', name: '桂盟' }, { code: '1517', name: '利奇' },
    { code: '8933', name: '愛地雅' },
  ],
  // 2026-06-22 新增：功率元件（分離式/功率半導體 IDM — MOSFET/二極體/IGBT/整流/SiC；台股口語「主動元件」≈ 這組）
  '功率元件': [
    { code: '2481', name: '強茂' }, { code: '5425', name: '台半' },
    { code: '3675', name: '德微' }, { code: '8261', name: '富鼎' },
    { code: '6435', name: '大中' }, { code: '5299', name: '杰力' },
    { code: '6719', name: '力智' }, { code: '3317', name: '尼克森' },
    { code: '6525', name: '捷敏-KY' }, { code: '2434', name: '統懋' },
    { code: '8255', name: '朋程' },
    // SiC/GaN 功率（市場炒功率元件常一起算；亦在第三代半導體）
    { code: '3707', name: '漢磊' }, { code: '3016', name: '嘉晶' },
  ],
};

export const THEME_NAMES = Object.keys(THEME_MAP);

/** 全部題材成分的去重裸代號 */
export function allThemeCodes(): string[] {
  const set = new Set<string>();
  for (const stocks of Object.values(THEME_MAP)) {
    for (const s of stocks) set.add(s.code);
  }
  return [...set];
}

/** code → 所屬題材名（一檔可屬多題材，如 3081 在 CPO/矽光子/光通訊） */
const CODE_TO_THEMES: Record<string, string[]> = (() => {
  const m: Record<string, string[]> = {};
  for (const [theme, stocks] of Object.entries(THEME_MAP)) {
    for (const s of stocks) (m[s.code] ??= []).push(theme);
  }
  return m;
})();

export function themesOf(code: string): string[] {
  return CODE_TO_THEMES[code] ?? [];
}

/** 同題材其他成分股（去重、排除自己）— 相對族群報酬的基準群 */
export function peersOf(code: string): string[] {
  const peers = new Set<string>();
  for (const t of themesOf(code)) {
    for (const s of THEME_MAP[t]) if (s.code !== code) peers.add(s.code);
  }
  return [...peers];
}
