export const ACCOUNT_VERSIONS = {
  globalConfig: 1,
  rewardState: 1,
  position: 1,
  roleStatistics: 1,
  bullAccumulator: 1,
  pendingRandomness: 1,
} as const;

export type AccountName = keyof typeof ACCOUNT_VERSIONS;
