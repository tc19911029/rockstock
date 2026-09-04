import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
      }],
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-*/**",
    ".next-preview/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
    ".vercel/**",
    "scripts/**",
    "artifacts/**",
    "tmp/**",
    "docs/.obsidian/**",
    // 2026-05-08：忽略 git worktree（其他 session 的 work，不是本 worktree 範圍）
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
