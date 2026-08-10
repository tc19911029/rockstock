#!/usr/bin/env node
// Verify the HTML shell and recursively follow every referenced Next.js static
// asset. A root 200 alone is insufficient: a stale next-server can still return
// JavaScript that points at chunks deleted by a newer in-place build.

const baseUrl = new URL(process.argv[2] ?? 'http://localhost:3000');
const assetPattern = /\/_next\/static\/[A-Za-z0-9_./-]+\.(?:js|css|woff2?)/g;
const pending = [];
const queued = new Set();
const verified = new Set();

function enqueueReferencedAssets(source) {
  for (const match of source.matchAll(assetPattern)) {
    const assetPath = match[0];
    if (queued.has(assetPath)) continue;
    queued.add(assetPath);
    pending.push(assetPath);
  }
}

async function fetchRequired(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`${label} 回傳 HTTP ${response.status}`);
  }
  return response;
}

try {
  const homeResponse = await fetchRequired(new URL('/', baseUrl), '首頁');
  enqueueReferencedAssets(await homeResponse.text());

  if (pending.length === 0) {
    throw new Error('首頁沒有引用任何 /_next/static 資源，無法確認部署完整性');
  }

  while (pending.length > 0) {
    if (queued.size > 2_000) {
      throw new Error('靜態資源依賴超過 2,000 個，停止異常的遞迴驗證');
    }

    const assetPath = pending.shift();
    const response = await fetchRequired(new URL(assetPath, baseUrl), assetPath);
    verified.add(assetPath);

    if (/\.(?:js|css)$/.test(assetPath)) {
      enqueueReferencedAssets(await response.text());
    }
  }

  console.log(`✓ 首頁與 ${verified.size} 個 Next.js 靜態資源皆可載入`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`✗ Next.js 靜態資源驗證失敗：${message}`);
  process.exit(1);
}
