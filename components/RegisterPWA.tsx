"use client";
import { useEffect } from "react";

export default function RegisterPWA() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // 開發版的 chunk URL 會重複使用；Service Worker 若快取它們，HMR 後可能
    // 把舊模組送回來，造成畫面載入舊 UI 或 module factory 錯誤。
    if (process.env.NODE_ENV !== "production") {
      void navigator.serviceWorker.getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .then(() => caches.keys())
        .then((keys) => Promise.all(keys.filter((key) => key.startsWith("rockstock-")).map((key) => caches.delete(key))))
        .catch(() => { /* 開發環境清理失敗不阻擋頁面 */ });
      return;
    }

    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // PWA 是漸進增強；註冊失敗不阻擋主流程。
    });
  }, []);
  return null;
}
