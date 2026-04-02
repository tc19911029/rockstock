import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.rockstock.app",
  appName: "RockStock",
  webDir: "out",
  server: {
    // Live URL mode — WebView loads the production site directly
    url: "https://rockstock.com",
    cleartext: false,
  },
  ios: {
    contentInset: "automatic",
    backgroundColor: "#0f172a",
    preferredContentMode: "mobile",
  },
  android: {
    backgroundColor: "#0f172a",
  },
};

export default config;
