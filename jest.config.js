/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  // 2026-05-08：排除其他 worktree 的 test 干擾本 worktree 跑 npm test
  testPathIgnorePatterns: ['/node_modules/', '/\\.claude/worktrees/'],
  modulePathIgnorePatterns: ['<rootDir>/\\.claude/worktrees/'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { module: 'commonjs' } }],
  },
  // 2026-05-08：每個 test 跑前 clear all mocks（避免跨 file mock state leak）
  clearMocks: true,
  // 74 個輕量 test file 在單 worker 跑比多 worker 快（IPC overhead > 並行收益）
  // 同時解決 "worker process has failed to exit gracefully" 警告
  maxWorkers: 1,
  // Full suite has short-lived async cleanup that finishes after Jest's 1s
  // default warning threshold. detectOpenHandles reports no persistent handle.
  openHandlesTimeout: 5000,
};
module.exports = config;
