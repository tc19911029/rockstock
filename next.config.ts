import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
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

const createNextConfig = (phase: string): NextConfig => {
  const distDir = process.env.NEXT_DEPLOY_BUILD === '1'
    ? '.next-deploy'
    : process.env.NEXT_PREVIEW === '1'
      ? '.next-preview'
      : phase === PHASE_DEVELOPMENT_SERVER
        ? '.next-dev'
        : '.next';

  assertProductionBuildOutputIsSafe({
    isProductionBuild: phase === PHASE_PRODUCTION_BUILD,
    distDir,
    rootDir: __dirname,
  });

  return {
    // Dev 與 production 必須使用不同輸出目錄。deploy guard 會原子替換 .next；
    // 若 next dev 也使用 .next，存活中的 Turbopack 會失去 cache/index 而全站 API 500。
    ...(distDir === '.next' ? {} : { distDir }),
    turbopack: {
      root: __dirname,
    },
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
};

export default createNextConfig;
