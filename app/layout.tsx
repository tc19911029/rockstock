import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, JetBrains_Mono, DM_Sans } from "next/font/google";
import "./globals.css";
import { RiskDisclaimerModal, FeatureGuideModal } from "@/components/RiskDisclaimer";
import { ThemeProvider } from "@/components/ThemeProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ColorThemeInit } from "@/components/ColorThemeInit";
import { Toaster } from "sonner";
import RegisterPWA from "@/components/RegisterPWA";
import StoreSync from "@/components/StoreSync";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0f172a",
};

export const metadata: Metadata = {
  title: {
    default: "K線走圖練習器 — 台股陸股掃描選股與策略回測",
    template: "%s | K線走圖練習器",
  },
  description: "免費股票分析工具：K線歷史回放練習、六大條件批量掃描、策略回測驗證、飆股潛力評分。支援台股與陸股，幫助投資人更有效率地看盤、驗證策略、輔助決策。",
  keywords: ["台股", "陸股", "技術分析", "K線", "掃描選股", "策略回測", "飆股", "六大條件", "當沖", "股票"],
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "K線練習",
  },
  openGraph: {
    title: "K線走圖練習器 — 台股陸股掃描選股與策略回測",
    description: "免費股票分析工具：K線歷史回放、六大條件掃描、策略回測、飆股評分",
    type: "website",
    locale: "zh_TW",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-TW"
      className={`${geistSans.variable} ${geistMono.variable} ${jetbrainsMono.variable} ${dmSans.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <meta name="theme-color" content="#0f172a" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body className="min-h-full flex flex-col">
        <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:bg-blue-600 focus:text-white focus:rounded-lg focus:text-sm">
          跳至主要內容
        </a>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
          <TooltipProvider>
            <ColorThemeInit />
            <StoreSync />
            <RiskDisclaimerModal />
            <FeatureGuideModal />
            <Toaster position="top-right" richColors closeButton theme="dark" />
            {children}
            <RegisterPWA />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
