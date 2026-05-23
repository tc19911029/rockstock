'use client';

/**
 * 自家版 ThemeProvider — 取代 next-themes，避開 React 19 對 Client Component
 * 內 `<script>` 元素的警告（next-themes 的 FOUC 防閃爍 script 直接 render
 * 在 Provider 內，會觸發 "Encountered a script tag while rendering React component"）。
 *
 * FOUC-prevention script 改寫在 app/layout.tsx 的 <head>（Server Component
 * 不受該警告影響）。
 *
 * 公開介面與 next-themes 相容：`<ThemeProvider attribute defaultTheme>` +
 * `useTheme()` 回傳 `{ theme, setTheme, resolvedTheme }`。系統主題不支援
 * （我們的 layout 是 `enableSystem={false}`）。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  /** alias of theme（不支援 system，永遠等於 theme） */
  resolvedTheme: Theme;
  setTheme: (t: Theme) => void;
}

const STORAGE_KEY = 'theme';

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  resolvedTheme: 'dark',
  setTheme: () => {},
});

export interface ThemeProviderProps {
  children: ReactNode;
  /** Class name on documentElement (only 'class' supported, matches old API) */
  attribute?: 'class';
  defaultTheme?: Theme;
  /** 保留為 props 介面相容性，本實作不支援系統主題 */
  enableSystem?: boolean;
}

export function ThemeProvider({
  children,
  defaultTheme = 'dark',
}: ThemeProviderProps) {
  // 第一次 render（SSR 與 CSR 第一次）必須一致，所以這裡只用 defaultTheme，
  // 不讀 localStorage（避免 hydration mismatch）。
  // hydration 後再透過 effect 同步 localStorage。
  const [theme, setThemeState] = useState<Theme>(defaultTheme);

  // 1) 初始化：讀 localStorage（hydration 後）
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark') {
        setThemeState(stored);
      }
    } catch {
      // ignore (private mode 等)
    }
  }, []);

  // 2) 套用 class + 同步 localStorage
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  // 3) 跨分頁同步（呼應 next-themes 行為）
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && (e.newValue === 'light' || e.newValue === 'dark')) {
        setThemeState(e.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme: theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
