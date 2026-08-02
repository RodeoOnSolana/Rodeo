export const ACCOUNT_VERSIONS = {
  globalConfig: 1,
  // Bumped: RewardState now owns all epoch/timestamp fields and the global
  // cowboy reward index carry, and recognizes rewards dynamically from the
  // vault balance instead of storing an unrecognized surplus field.
  rewardState: 2,
  // Bumped: Position now stores cowboy_kind/bull_tier instead of rank_or_tier,
  // carries per-position accrual remainders, and resets reward checkpoints on
  // ownership mutation.
  position: 3,
  roleStatistics: 1,
  // Bumped: BullAccumulator now owns bull_index_remainder_scaled and no
  // longer stores a cowboy_reward_index.
  bullAccumulator: 2,
  // Bumped: PendingRandomness is keyed by [position, action_type, action_nonce],
  // dropped its redundant owner field, and now snapshots the registry version
  // for unbiased randomness mapping.
  pendingRandomness: 3,
} as const;

export type AccountName = keyof typeof ACCOUNT_VERSIONS;
