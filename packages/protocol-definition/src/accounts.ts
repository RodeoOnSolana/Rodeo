export const ACCOUNT_VERSIONS = {
  globalConfig: 1,
  rewardState: 1,
  // Bumped: Position identity moved from [owner, position_id] to
  // [global_config, position_id], and gained the pending-action fields
  // that lock ownership transfer while a randomness request is outstanding.
  position: 2,
  roleStatistics: 1,
  bullAccumulator: 1,
  // Bumped: PendingRandomness is now keyed by [position, action_type,
  // action_nonce] instead of [position] alone, and dropped its redundant
  // owner field in favor of Position.owner.
  pendingRandomness: 2,
} as const;

export type AccountName = keyof typeof ACCOUNT_VERSIONS;
