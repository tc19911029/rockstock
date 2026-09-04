# Rockstock UI／UX 總修改清單

來源：七輪 Chrome 實測稽核。已將 94 項發現去重整併；第 94 項是測試限制，不列為產品缺陷。

## P0：先恢復可用性與可信度

- [ ] 恢復正式站部署，建立可持續驗收的 production／staging URL。
- [ ] 修復首頁股票載入：輸入有效代號後必須真的更新 K 線、分析、股票 identity 與 URL。
- [ ] 修復「新增持倉／新增第一筆持倉」點擊無結果。
- [ ] 全面檢查目前只取得 focus、沒有執行效果的 React controls。
- [ ] 建立 Initial／Loading／Success／Empty／Partial／Error／Timeout 互斥狀態。
- [ ] Loading 不可與「尚未載入／0 筆／故障」同時出現。
- [ ] 所有 async action 提供 pending、success、failure、timeout 與 retry 回饋。
- [ ] 搜尋空白或格式錯誤時，在欄位旁顯示具體錯誤並保留 focus。
- [ ] Loading 超時後提供「重試、換股票、查看系統狀態」。
- [ ] 資料尚未完成前，不要先顯示紅色故障或把 0 當正式結果。
- [ ] 所有決策、持倉、Agents、回測頁固定顯示資料日期、完成時間、完整度與過期狀態。
- [ ] 修復 768–1280px 首頁右側研究面板被裁切。
- [ ] 修復 375px 整頁水平溢出：Sizer 135px、Agents 96px、回測 75px、投資組合 54px。
- [ ] 手機 header 重做，所有導覽與主要操作保持在 viewport 內。
- [ ] 搜尋框、主題按鈕及所有互動控制提供清楚可見的 focus ring。
- [ ] Skip link 只保留一個，Enter 後 focus 真正落到 main。

## P1：重建資訊架構與主要流程

- [ ] 建立全域主導覽，不再只從首頁到持倉與健康度。
- [ ] 消除導覽孤島，讓所有正式功能都有可見入口。
- [ ] 顯示目前頁面與 active navigation，使用 `aria-current="page"`。
- [ ] 統一返回模式；返回箭頭不能取代全域導覽。
- [ ] 為每頁提供唯一 H1、正確 heading hierarchy 與獨立 document title。
- [ ] 首頁加入產品定位與單一主要任務，不讓 53 個控制同時競爭注意力。
- [ ] 將首頁重新排序為：資料狀態 → 搜尋 → 今日決策 → 持倉風險 → 研究工具。
- [ ] 串起完整流程：候選 → 個股證據 → 反方風險 → 倉位試算 → 自選／持倉 → 停損 → 回顧。
- [ ] 跨頁保留 symbol、市場、資料日、試算結果與使用者輸入。
- [ ] 股票、panel、主要 filters 寫入 URL，支援書籤、分享、刷新與返回。
- [ ] 每個候選顯示「目前狀態、為何不是現在、等待條件、失效條件、下次檢查時間」。
- [ ] 統一首頁、候選、Agents、持倉與回顧的股票決策卡格式。
- [ ] 分開事前決策與事後報酬，避免 hindsight 改寫原始判斷。
- [ ] 候選排名分開來源可信度、人氣、模型分數與歷史績效。
- [ ] 空持倉只保留一個主要 CTA，掃描選股作為次要入口。
- [ ] 空資料頁提供原因、下一步與可行 CTA，不以巨型 Emoji 取代內容。

## P1：策略、資料與金融決策語意

- [ ] 將 Step 1／Step 2、策略字母、買法字母翻成穩定的白話名稱。
- [ ] UI 以策略名稱為主、字母為 badge；v11／v12 映射移到技術詳情。
- [ ] 已證偽策略移到「研究封存／反例」，移除操作暗示與進場 CTA。
- [ ] 統一資料來源、證據、信心、樣本數、期間與資料完整度呈現。
- [ ] YouTube 回測補上樣本數、期間、重複提及規則、語意分類、滑點與成交限制。
- [ ] 回測控制改名：報酬觀察 1／3／5 日；最小樣本 1／20／100／300 次。
- [ ] 釐清 Paper-trade 的訊號時間、下單時間、價格欄位、費用與滑點。
- [ ] 全站漲跌色從同一設定產生，文案不可硬編碼紅漲綠跌。
- [ ] 所有漲跌、成功、風險狀態同時使用文字／符號，不只靠顏色。
- [ ] 風險拆成資料限制、模型限制、使用限制與操作上限。
- [ ] 重大限制直接降低信心、限制 CTA 或顯示警示，不只放長篇免責文字。
- [ ] 移除 `CLAUDE.md Rule 5`、`npx tsx`、`harness`、`sizing-config`、`broker_bullish` 等使用者層內部用語。
- [ ] 工程命令、檔案與策略 enum 收入管理員模式／技術詳情。

## P1：Responsive、觸控與表單

- [ ] 所有互動熱區至少 44 × 44px；圖示可小，但 button 容器不可小。
- [ ] 首頁搜尋、tabs、filter、來源切換、健康頁複製按鈕全面放大。
- [ ] 手機首頁重新做任務式資訊架構，不只是縮字與換行。
- [ ] Sizer 手機改為單欄，不保留固定雙欄寬度。
- [ ] Sizer 7 個欄位全部補常駐 label、單位、範圍、錯誤與程式關聯。
- [ ] Email、slider 及其他設定欄位補 `label for`／`aria-label`。
- [ ] 數字、金額、百分比欄位使用正確 `type`／`inputmode`。
- [ ] 明確標示必填與選填，消除 placeholder、文案及驗證規則矛盾。
- [ ] Slider 顯示目前值、min、max、step，並支援鍵盤操作。
- [ ] 同類 filters 增加 group label、8px 選項間距及 16px 組間距。
- [ ] 明確區分 segmented control、radio、checkbox 與 tabs 的語意。
- [ ] 空持倉時停用或隱藏無資料可匯出的匯出／CSV。

## P1：鍵盤與無障礙

- [ ] 修正首頁 DOM order，讓 Tab 順序與視覺順序一致。
- [ ] 兩組 tablist 實作 roving tabindex；Left／Right 切換 tabs。
- [ ] 收合區內容在關閉時移出 Tab order。
- [ ] 圖表 resize separator 可 focus，支援方向鍵、Home／End，並宣告 min／max／now。
- [ ] 所有 icon-only links／buttons 補 accessible name 與 keyboard tooltip。
- [ ] `/portfolio`、`/health` header links 補可見文字或 `aria-label`。
- [ ] 降低首頁 55 個 focus 停駐點；提供區域 landmark 與跳轉。
- [ ] 錯誤訊息使用 `role="alert"`／`aria-live`，不要只有紅框。
- [ ] Agents 與回測使用原生 table，或完整 table／grid／row／cell semantics。
- [ ] 表頭使用 `scope`，排序狀態使用 `aria-sort`，資料表提供 caption。
- [ ] 全域 reduced-motion 停用非必要 fadeIn、pulse 與位移動畫。
- [ ] 正式驗收 200%／400% zoom、320px reflow、Shift+Tab 與無 focus trap。

## P1：視覺層級與金融數字

- [ ] 移除首頁與 Agents 的 9–10px 操作文字。
- [ ] 建立統一 type scale：12／14／16／18／24px。
- [ ] 桌面正文與主要控制至少 14px，metadata 至少 12px。
- [ ] 逐一測量 light／dark mode 對比；一般文字至少 4.5:1。
- [ ] 不再同時使用小字、60% 透明度與 muted color 承載重要資訊。
- [ ] 金融數字使用 tabular numerals、右對齊、固定小數位與一致單位。
- [ ] 回測洞察拆成：結論、主數字、勝率／樣本、信心、解讀。
- [ ] 限制長篇正文行長約 65–75 字元，不使用 917px 寬的 12px 長句。
- [ ] 將警示分為 Critical／Warning／Note，重要風險不能放頁尾小字。
- [ ] 統一卡片 padding、section spacing、標題層級與 active state。

## P2：文案、圖示與設定整理

- [ ] 統一產品語氣：專業、白話、可行動；移除課堂筆記與開發工具語氣。
- [ ] 修正重複、矛盾、不自然及中英混雜的文案。
- [ ] 說清楚「0」是無結果、尚未分析、載入失敗或真正數值。
- [ ] disabled controls 說明停用原因及解鎖條件。
- [ ] 「儲存」說明會保存哪些設定，分區設定使用各自保存狀態。
- [ ] 通知測試先顯示收件人、內容摘要與外部副作用確認。
- [ ] 設定頁拆分為通知、交易偏好、顯示、資料與危險操作。
- [ ] 不可調整的策略原則改成說明文件，不與 editable form 混放。
- [ ] 危險操作獨立 danger zone，二次確認並說明不可恢復範圍。
- [ ] 統一採用同一套 SVG icon 與 16／20／24px 尺寸。
- [ ] 移除功能性 Emoji；策略記憶符號若保留，只作 badge。
- [ ] Copy 成功顯示「已複製」文字狀態並保留足夠熱區。
- [ ] Hover、focus、selected、disabled、loading 樣式建立統一元件規格。

## 驗收基線

- [ ] 320、375、390、414、768、1024、1280、1440px 均完成 visual regression。
- [ ] 除明確二維資料區外，任何 viewport 都沒有整頁水平捲動。
- [ ] 核心流程可只用鍵盤完成，也可用手機單手完成。
- [ ] 每頁一個 H1、獨立 title、目前位置及正常返回。
- [ ] 所有欄位有 label、錯誤、單位、必填狀態與正確 keyboard。
- [ ] 所有資料畫面顯示時間、完整度、來源、信心、樣本與限制。
- [ ] 所有 async 操作都能觀察到 pending、success、failure、timeout。
- [ ] 所有 destructive／external-side-effect actions 都有明確確認。
- [ ] 不靠顏色、hover、Emoji 或內部術語才能理解與操作。
