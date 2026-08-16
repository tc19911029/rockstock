import { readFileSync } from 'fs';
import path from 'path';

const root = process.cwd();
const source = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('首頁資料完整性防回歸契約', () => {
  it('股票載入失敗會清空舊走圖，而不是回退 DEMO 或固定重試 2330', () => {
    const store = source('store/replayStore.ts');
    const page = source('app/page.tsx');
    expect(store).toContain('currentStock: null');
    expect(store).toContain('allCandles: []');
    expect(page).toContain('重試同一檔');
    expect(page).not.toContain("loadStock('2330', '1d', '2y');");
  });

  it('YouTube、法人與歷史走圖使用不同日期狀態', () => {
    const page = source('app/page.tsx');
    expect(page).toContain('youtubeDate');
    expect(page).toContain('brokerDate');
    expect(page).toContain('const chartDate = sym');
    expect(page).not.toContain('const [tabDate, setTabDate]');
  });

  it('陸股基本面必須收到走圖價格與歷史日期', () => {
    const page = source('app/page.tsx');
    expect(page).toMatch(/<CnFundamentalPanel[\s\S]*?currentPrice=\{allCandles\[currentIndex\]\?\.close\}/);
    expect(page).toMatch(/<CnFundamentalPanel[\s\S]*?date=\{currentIndex < allCandles\.length - 1/);
  });

  it('法人消息與報告使用同一日期，日期列只列可用報告日', () => {
    const reports = source('components/broker/BrokerReportsPanel.tsx');
    const news = source('components/broker/BrokerNewsSection.tsx');
    expect(reports).toContain('<BrokerNewsSection date={date}');
    expect(reports).toContain('dates={data?.availableDates}');
    expect(news).toContain('/api/broker/news-digest/${encodeURIComponent(date)}');
    expect(news).not.toContain("news-digest/latest");
  });
});
