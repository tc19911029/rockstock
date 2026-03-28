'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[#0b1120] text-white flex items-center justify-center p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-md w-full text-center space-y-4">
        <p className="text-3xl">⚠️</p>
        <h2 className="text-base font-bold text-slate-200">發生錯誤</h2>
        <p className="text-xs text-slate-400">{error.message || '未知錯誤，請重新整理頁面'}</p>
        {error.digest && <p className="text-[10px] text-slate-600 font-mono">錯誤代碼：{error.digest}</p>}
        <div className="flex gap-2 justify-center">
          <button
            onClick={reset}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-bold transition"
          >
            重試
          </button>
          <button
            onClick={() => window.location.href = '/'}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm font-medium transition text-slate-300"
          >
            回到首頁
          </button>
        </div>
        <p className="text-[10px] text-slate-600">
          若問題持續發生，請嘗試清除瀏覽器快取或更換瀏覽器
        </p>
      </div>
    </div>
  );
}
