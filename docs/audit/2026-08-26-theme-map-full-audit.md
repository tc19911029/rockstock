# 台股 38 題材成分完整稽核（2026-08-26）

## 結論

- 已逐題材檢查 `lib/themes/themeMap.ts` 的 38 個題材、546 筆題材歸屬、353 家不重複公司。
- 代號與名稱全部通過 `stock-master.json` 對照；每個題材內無重複代號。
- 本輪新增或校正 17 筆歸屬：新增 16 筆、ASIC 移除 1 筆；另確認 CPO、矽光子均維持為光通訊子集合。
- 名單採「可驗證供應鏈」口徑：公司須有直接產品、技術、量產、客戶驗證、正式合作或明確營運布局；只有產業相近或網路傳聞者不納入核心名單。

## 本輪校正

| 題材 | 校正 | 判定理由 |
|---|---|---|
| AI伺服器 | +信驊 5274 | BMC SoC 是伺服器遠端管理核心晶片，AST2700 明列高功率 AI 伺服器應用。 |
| ASIC | +祥碩 5269、-瑞昱 2379 | 祥碩正式資料明列客製 ASIC；瑞昱是標準產品 IC 設計，保留於 IC設計。 |
| 先進封裝 | +台積電 2330、+群創 3481 | 台積電是 3DFabric／CoWoS／SoIC 核心；群創 FOPLP 已量產。 |
| CoWoS | +台積電 2330 | CoWoS 為台積電的先進封裝平台，原名單只列周邊設備、漏掉核心廠。 |
| 半導體設備 | +致茂 2360、+惠特 6706、+光焱科技 7728、+鴻勁 7769 | 均有半導體、矽光子或光電元件量測／分選設備角色。 |
| 玻璃基板 | +群創 3481 | TGV 玻璃基板已進客戶驗證。 |
| 機器人 | +台達電 2308、+鴻海 2317 | 台達電已有自有工業機器人產品；鴻海正式展示 AI 工業人形機器人與實際工廠任務。 |
| 低軌衛星 | +友達 2409、+聯發科 2454、+飛宏 2457 | 分別對應玻璃基板衛星天線、NR-NTN 晶片／連線、低軌通訊電源產品。 |
| 伺服器電源 | +貿聯-KY 3665 | 有 AI 資料中心 power shelf、BBU、機櫃匯流排與伺服器電源線束產品。 |

## 全 38 題材檢查結果

| 題材 | 筆數 | 結果／口徑 |
|---|---:|---|
| AI伺服器 | 17 | 已校正；整機、機櫃及伺服器專用關鍵零組件。 |
| 散熱 | 13 | 符合；散熱模組、風扇、冷板及熱交換。 |
| ASIC | 8 | 已校正；客製 ASIC 服務與必要矽智財。 |
| CPO | 50 | 已複核；含晶圓、PIC/EIC、光源、封裝、測試、連接與系統整合供應鏈。 |
| 矽光子 | 44 | 已複核；排除只有 Micro LED／一般光通訊、未具 SiPh 角色者。 |
| 光通訊 | 55 | 已複核；完整涵蓋 CPO 與矽光子，另含一般光收發／光纖業者。 |
| 記憶體 | 14 | 符合；記憶體製造、控制器、模組與相關 IP。 |
| 被動元件 | 10 | 符合；電阻、電容、電感與被動元件通路／模組。 |
| PCB | 17 | 符合；板廠、載板、軟板與直接鑽孔耗材。 |
| CCL | 7 | 符合；CCL 廠及銅箔、玻纖布等直接上游材料。 |
| 先進封裝 | 17 | 已校正；平台、封測、FOPLP、探針與測試供應鏈。 |
| CoWoS | 10 | 已校正；台積電核心平台與直接設備／測試供應鏈。 |
| 半導體設備 | 22 | 已校正；製程、自動化、量測、探針、分選與廠務設備。 |
| 玻璃基板 | 12 | 已校正；含研發／客戶驗證階段業者，不代表皆已貢獻營收。 |
| 機器人 | 18 | 已校正；機器人本體、控制、減速機、傳動與自動化整合。 |
| 重電 | 9 | 符合；變壓器、配電、電網與電線電纜。 |
| 電力 | 9 | 符合；目前依規格與重電採同一電網基建母集合。 |
| 軍工 | 9 | 符合；國防航太、軍規通訊、無人機、造艦與維修。 |
| 生技 | 17 | 符合；新藥、疫苗、生物製劑、CDMO 與製藥。 |
| 面板 | 9 | 符合；面板、電子紙、背光與模組。 |
| 車用電子 | 13 | 符合；車用電源、ADAS、連接、燈具與電子模組。 |
| 航運 | 12 | 符合；貨櫃、散裝、航空與貨代。 |
| 金融 | 13 | 符合；均為金融控股公司。 |
| 低軌衛星 | 13 | 已校正；RF、天線、終端、PCB、晶片與電源直接供應鏈。 |
| 蘋果供應鏈 | 11 | 符合；晶圓、組裝、PCB、光學、聲學與周邊供應鏈。 |
| 中國政策受惠 | 4 | 符合既定 proxy 口徑；皆有中國內需營運曝險，但不是政策保證受益名單。 |
| 綠能 | 9 | 符合；發電、售電、太陽能、風電與儲能主業。 |
| 伺服器電源 | 13 | 已校正；PSU、power shelf、BBU、電池與直接連接器。 |
| 高速連接 | 8 | 符合；高速 socket、DAC、連接器與線束。 |
| 成熟製程 | 5 | 符合；8 吋、特殊製程、功率及化合物晶圓代工。 |
| IC設計 | 20 | 符合；標準產品 IC 設計，祥碩可同時具 ASIC 業務。 |
| 矽晶圓 | 5 | 符合；長晶、切磨、磊晶與晶圓材料。 |
| 第三代半導體 | 9 | 符合；SiC／GaN 基板、磊晶、功率與射頻元件。 |
| 網通 | 11 | 符合；交換器、路由器、Wi-Fi 與寬頻設備。 |
| 半導體通路 | 6 | 符合；均有 IC／半導體代理與通路業務。 |
| 工具機 | 7 | 符合；CNC 工具機、加工機及直接傳動／自動化。 |
| 自行車 | 7 | 符合；整車、鏈條與直接零組件。 |
| 功率元件 | 13 | 符合；MOSFET、二極體、IGBT、整流、SiC／GaN 功率供應鏈。 |

## 邊界說明

- 瑞軒 2489 保留在 CPO／光通訊的「Shuffle Box 周邊代工」角色，不列矽光子；其證據強度低於公司正式揭露，因此不當作核心元件廠。
- 題材允許交叉歸類。例如貿聯-KY 同時屬光通訊、高速連接與伺服器電源，分別有對應產品，不是重複錯誤。
- 「玻璃基板」含公開研發或客戶驗證中的公司；名單表示具題材關聯，不表示已量產或已形成重大營收。
- 「中國政策受惠」是中國內需營運曝險 proxy，應以低權重解讀；政策方向改變時需重新稽核。

## 主要公司級證據

- [台積電 CoWoS](https://3dfabric.tsmc.com/chinese/dedicatedFoundry/technology/cowos.htm)
- [台積電先進封裝](https://www.tsmc.com/schinese/dedicatedFoundry/services/advanced-packaging)
- [信驊伺服器 BMC](https://www.aspeedtech.com/server/)
- [台達電機器人產品](https://www.deltaww.com/en-US/solutions/robotics)
- [鴻海 AI 人形機器人公告](https://www.foxconn.com/en-us/press-center/press-releases/latest-news/1975)
- [友達 2025 年報：CPO 與低軌衛星透明天線](https://www.auo.com/upload/media/ir/2025_AUO_Annual_Report_EN.pdf)
- [聯發科與 Eutelsat／Airbus 的 LEO NR-NTN](https://www.mediatek.com/press-room/eutelsat-mediatek-and-airbus-announce-worlds-first-5g-non-terrestrial-network-connection-leveraging-oneweb-leo-satellites)
- [貿聯伺服器電源線](https://www.bizlinktech.com/products/server-power-cable)
- [貿聯機櫃匯流排](https://www.bizlinktech.com/products/rack-busbar)
- [緯穎與 Ayar Labs CPO 合作](https://www.wiwynn.com/zh/news/ayar-labs-and-wiwynn-partner-to-bring-co-packaged-optics-to-rack-scale-ai-systems)
- [鴻海／FIT 與聯發科 CPO 合作](https://www.foxconn.com/zh-tw/press-center/press-releases/latest-news/1303)
