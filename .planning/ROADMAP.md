# Roadmap: Stock-Replay v3 — 世界級台股研究平台

## Overview

從成熟個人工具升級為世界級公開產品。按依賴順序執行 8 個 Phase：先建立設計系統基礎，再拆分巨型頁面，同時整合真實數據源，最後重建所有 UI 頁面達到專業產品水準。

## Phases

- [ ] **Phase 1: Design System + shadcn/ui** - 建立統一視覺語言和組件庫
- [ ] **Phase 2: 頁面拆分 + 狀態架構** - 將巨型頁面拆成 <400 行聚焦模組
- [ ] **Phase 3: 數據基礎設施** - FinMind + TWSE 多源數據層
- [ ] **Phase 4: AI 分析引擎升級** - 真實數據餵入每個 AI 角色
- [ ] **Phase 5: UI 頁面重建** - 用設計系統重建所有頁面
- [ ] **Phase 6: 當沖系統正式化** - 盤中數據 + 倉位計算 + 交易日誌
- [ ] **Phase 7: PDF 報告 + 匯出** - 專業 PDF 報告一鍵匯出
- [ ] **Phase 8: 測試 + 無障礙 + 上線加固** - 80% 覆蓋率 + WCAG 2.1 AA

## Phase Details

### Phase 1: Design System + shadcn/ui
**Goal**: 建立統一設計語言，讓後續所有 Phase 產出一致 UI
**Depends on**: Nothing
**Success Criteria**:
  1. shadcn/ui 安裝完成，所有基礎組件可用
  2. dark/light 主題切換正常運作
  3. DataTable、ChartContainer、StockCard、PageShell 組件建立
  4. 設計 token 系統（間距/字體/色彩）統一應用
**Plans**: 3 plans

Plans:
- [ ] 01-01: Install shadcn/ui, next-themes, design tokens
- [ ] 01-02: Build DataTable (tanstack/react-table), PageShell
- [ ] 01-03: Build ChartContainer, StockCard, theme toggle

### Phase 2: 頁面拆分 + 狀態架構
**Goal**: 將三大巨型頁面（首頁/掃描/分析）拆成 <400 行聚焦模組
**Depends on**: Phase 1
**Success Criteria**:
  1. 每個組件檔案 <400 行
  2. features/ 目錄結構建立
  3. 共用 hooks 提取（useStockData, useAnalysis）
  4. Lazy loading + error boundary 加入
**Plans**: 3 plans

Plans:
- [ ] 02-01: 掃描頁拆分 (ScanConfigPanel, ScanResultsTable, ScanFilters)
- [ ] 02-02: 分析頁拆分 + hooks 提取
- [ ] 02-03: 首頁拆分 + features/ 目錄結構

### Phase 3: 數據基礎設施
**Goal**: FinMind API 整合（三大法人、融資融券、財報、月營收）
**Depends on**: None (parallel with 1-2)
**Success Criteria**:
  1. FinMind API 整合，三大法人數據可查詢
  2. FallbackChain<T> 實作（FinMind → TWSE 備援）
  3. 財報數據（EPS、P/E、月營收）可查詢
  4. TTL 快取（法人/財報 24小時）
**Plans**: 3 plans

Plans:
- [ ] 03-01: FinMind API client + 三大法人數據
- [ ] 03-02: 財報 adapter (EPS, P/E, 月營收)
- [ ] 03-03: FallbackChain + TTL cache layer

### Phase 4: AI 分析引擎升級
**Goal**: 真實籌碼/財報數據餵入 AI，增加同業比較
**Depends on**: Phase 3
**Success Criteria**:
  1. 籌碼分析師接收真實三大法人 + 融資融券數據
  2. 基本面分析師接收 P/E、EPS、月營收數據
  3. 同業比較功能（3-5 家同業）
  4. Zod schema 驗證所有 AI 輸出
**Plans**: 2 plans

Plans:
- [ ] 04-01: 籌碼分析師 + 基本面分析師升級
- [ ] 04-02: 同業比較 + Zod validation

### Phase 5: UI 頁面重建
**Goal**: 用 Phase 1 組件庫重建所有頁面，達到專業產品水準
**Depends on**: Phase 2, Phase 4
**Success Criteria**:
  1. 掃描頁：DataTable + 法人買賣欄 + 新聞情緒 + 詳情抽屜
  2. 分析頁：卡片式 AI 角色 + 頁籤（AI | K線 | 回測 | 新聞）
  3. 首頁：大盤概覽 + 自選股 + 快速掃描
  4. 響應式：手機/平板/桌面
**Plans**: 3 plans

Plans:
- [ ] 05-01: 掃描頁重建
- [ ] 05-02: 分析頁重建
- [ ] 05-03: 首頁重建 + 響應式

### Phase 6: 當沖系統正式化
**Goal**: 盤中數據接入，倉位計算器，交易日誌
**Depends on**: Phase 3, Phase 5
**Success Criteria**:
  1. 多時間框架圖表（1m/5m/15m/日線）
  2. 倉位計算器（帳戶 × 風險 × 停損 → 股數）
  3. 交易日誌持久化（localStorage + CSV匯出）
  4. 盤中掃描訊號（量能/VWAP）
**Plans**: 2 plans

Plans:
- [ ] 06-01: 多時間框架 + 倉位計算器
- [ ] 06-02: 交易日誌 + 盤中掃描訊號

### Phase 7: PDF 報告 + 匯出
**Goal**: 一鍵匯出包含所有分析區塊的專業 PDF 報告
**Depends on**: Phase 4, Phase 5
**Success Criteria**:
  1. PDF 包含：股票概覽 + AI分析 + 回測 + K線截圖
  2. CJK 字型正確渲染
  3. CSV 匯出（掃描結果 + 回測記錄）
**Plans**: 1 plan

Plans:
- [ ] 07-01: pdfmake PDF + CSV export

### Phase 8: 測試 + 無障礙 + 上線加固
**Goal**: 80% 測試覆蓋、WCAG 2.1 AA、Lighthouse > 90
**Depends on**: All
**Success Criteria**:
  1. /lib/ 模組 unit test 80%+ 覆蓋率
  2. API routes integration test
  3. axe-core 無障礙掃描 + AA 修復
  4. Lighthouse Performance > 90, Accessibility > 95
**Plans**: 2 plans

Plans:
- [ ] 08-01: Unit tests + integration tests
- [ ] 08-02: E2E + accessibility + Lighthouse
