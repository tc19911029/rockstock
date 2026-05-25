import type { NextConfig } from "next";
import fs from "fs";
import path from "path";

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

const nextConfig: NextConfig = {
  // Preview server 可與 launchd 的 dev server 並存（launchd 用 .next/ 上 3000；preview 用 .next-preview/ 上 3100）
  ...(process.env.NEXT_PREVIEW === '1' ? { distDir: '.next-preview' } : {}),
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
};

export default nextConfig;
