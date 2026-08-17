import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import fs from "fs";
import path from "path";
import { assertProductionBuildOutputIsSafe } from "./lib/deployment/productionBuildGuard";

// Manually load .env.local from the project directory
// (needed because Turbopack may detect a different workspace root)
function loadEnvLocal() {
  const envPath = path.join(__dirname, ".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}
loadEnvLocal();

const distDir = process.env.NEXT_DEPLOY_BUILD === '1'
  ? '.next-deploy'
  : process.env.NEXT_PREVIEW === '1'
    ? '.next-preview'
    : '.next';

const nextConfig: NextConfig = {
  // Production 部署先旁路建置到 .next-deploy，成功後才由 deploy guard 原子切換；
  // 避免 build 失敗時清掉正在服務中的 .next，造成靜態資源 404／黑頁。
  ...(distDir === '.next' ? {} : { distDir }),
  turbopack: {
    root: __dirname,
  },
  // Next 16 default metadata streaming 在 client component page + Suspense 會出 hydration mismatch
  // (Next.MetadataOutlet 內部 <script id="_R_"> SSR vs <Suspense> client 不 match)
  // 關掉 streaming → metadata 直接 render 進 HTML,跳過 streaming placeholder
  // (streamingMetadata 不在 Next 16.2.1 的 TS type 內但 runtime 認得,故 cast)
  experimental: {
    streamingMetadata: false,
  } as NextConfig['experimental'],
  // Runtime data is read from disk locally and Blob on Vercel. Server bundles
  // use compiled chunks, so source/test/mobile/temp trees must not be copied
  // merely because a dynamic fs path caused an overly broad NFT trace.
  // Python helpers and docs are intentionally left available: some Node routes
  // execute/read them at runtime.
  outputFileTracingExcludes: {
    '/*': [
      './data/**/*',
      './app/**/*',
      './components/**/*',
      './features/**/*',
      './lib/**/*',
      './store/**/*',
      './types/**/*',
      './__tests__/**/*',
      './e2e/**/*',
      './android/**/*',
      './ios/**/*',
      './artifacts/**/*',
      './tmp/**/*',
      './coverage/**/*',
      './public/**/*',
      './scripts/**/*.{ts,tsx,js,mjs,cjs,sh}',
    ],
  },
};

const createNextConfig = (phase: string): NextConfig => {
  assertProductionBuildOutputIsSafe({
    isProductionBuild: phase === PHASE_PRODUCTION_BUILD,
    distDir,
    rootDir: __dirname,
  });
  return nextConfig;
};

export default createNextConfig;
