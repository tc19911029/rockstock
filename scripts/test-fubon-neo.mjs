/**
 * 富邦 Neo API 連線測試
 *
 * 使用方式：
 *   node scripts/test-fubon-neo.mjs
 *
 * 需要在 .env.local 設定：
 *   FUBON_NEO_USER_ID=你的身分證字號
 *   FUBON_NEO_PASSWORD=你的登入密碼
 *   FUBON_NEO_CERT_PATH=/Users/.../你的身分證字號.pfx
 *   FUBON_NEO_API_KEY=你的憑證密碼
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { FubonSDK } from 'fubon-neo';

// 讀取 .env.local
config({ path: resolve(process.cwd(), '.env.local') });

const USER_ID      = process.env.FUBON_NEO_USER_ID;
const PASSWORD     = process.env.FUBON_NEO_PASSWORD;
const CERT_PATH    = process.env.FUBON_NEO_CERT_PATH;
const CERT_PASSWORD = process.env.FUBON_NEO_API_KEY;  // 你之前給的那串

const missing = [];
if (!USER_ID)       missing.push('FUBON_NEO_USER_ID');
if (!PASSWORD)      missing.push('FUBON_NEO_PASSWORD');
if (!CERT_PATH)     missing.push('FUBON_NEO_CERT_PATH');
if (!CERT_PASSWORD) missing.push('FUBON_NEO_API_KEY');

if (missing.length > 0) {
  console.error(`❌ .env.local 缺少以下變數: ${missing.join(', ')}`);
  console.error('   請參考 scripts/test-fubon-neo.mjs 頂部的說明');
  process.exit(1);
}

try {
  console.log('🔑 正在登入富邦 Neo...');
  const sdk = new FubonSDK();
  const accounts = sdk.login(USER_ID, PASSWORD, CERT_PATH, CERT_PASSWORD);

  if (!accounts.isSuccess) {
    console.error('❌ 登入失敗:', accounts.message);
    process.exit(1);
  }

  console.log('✅ 登入成功！');
  console.log('📋 帳號列表:', JSON.stringify(accounts.data, null, 2));

  // 初始化行情
  console.log('\n📡 初始化即時行情...');
  sdk.initRealtime();

  const restStock = sdk.marketdata.restClient.stock;

  // 測試 1: 查詢台積電即時報價
  console.log('\n--- 測試 1: 台積電 (2330) 即時報價 ---');
  const quote = await restStock.intraday.quote({ symbol: '2330' });
  console.log(JSON.stringify(quote, null, 2));

  // 測試 2: 上市全市場快照 (TSE)
  console.log('\n--- 測試 2: 上市全市場快照 (前5筆) ---');
  const snapshot = await restStock.snapshot.quotes({ market: 'TSE' });
  if (snapshot.data) {
    console.log(`共 ${snapshot.data.length} 筆`);
    console.log('前5筆:', JSON.stringify(snapshot.data.slice(0, 5), null, 2));
  } else {
    console.log('快照結果:', JSON.stringify(snapshot, null, 2));
  }

  // 測試 3: 上櫃全市場快照 (OTC)
  console.log('\n--- 測試 3: 上櫃全市場快照 (前5筆) ---');
  const snapshotOtc = await restStock.snapshot.quotes({ market: 'OTC' });
  if (snapshotOtc.data) {
    console.log(`共 ${snapshotOtc.data.length} 筆`);
    console.log('前5筆:', JSON.stringify(snapshotOtc.data.slice(0, 5), null, 2));
  } else {
    console.log('快照結果:', JSON.stringify(snapshotOtc, null, 2));
  }

  console.log('\n🎉 全部測試完成！富邦 Neo API 可以正常使用。');
  sdk.logout();
  console.log('👋 已登出');

} catch (err) {
  console.error('❌ 錯誤:', err.message || err);
  process.exit(1);
}
