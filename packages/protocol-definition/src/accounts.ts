export const ACCOUNT_VERSIONS = {
  globalConfig: 1,
  // Bumped: RewardState now owns all epoch/timestamp fields, the global
  // cowboy reward index carry, the orphaned Cowboy accrual remainder, and
  // recognizes rewards dynamically from the vault balance instead of storing
  // an unrecognized surplus field.
  rewardState: 3,
  // Bumped: Position now stores cowboy_kind/bull_tier instead of rank_or_tier,
  // carries per-position accrual remainders, and resets reward checkpoints on
  // ownership mutation.
  position: 3,
  roleStatistics: 1,
  // Bumped: BullAccumulator now owns bull_index_remainder_scaled and the
  // orphaned Bull accrual remainder; it no longer stores a cowboy_reward_index.
  bullAccumulator: 3,
  // Bumped: PendingRandomness is keyed by [position, action_type, action_nonce],
  // dropped its redundant owner field, and now snapshots the registry version
  // for unbiased randomness mapping.
  pendingRandomness: 3,
} as const;

export type AccountName = keyof typeof ACCOUNT_VERSIONS;

// Account schemas (not emitted events)

/** SocialResult PDA: [b"social-result", global_config, competition_epoch] */
export interface SocialResult {
  readonly version: number;
  readonly globalConfig: string;
  readonly competitionEpoch: bigint;
  readonly winningSuitsMask: number;
  readonly totalAmount: bigint;
  readonly merkleRoot: Uint8Array;
  readonly contentHash: Uint8Array;
  readonly attestedAt: bigint;
  readonly bump: number;
}

/** SuitClaimReceipt PDA: [b"suit-claim", social_result, leaf_nonce] */
export interface SuitClaimReceipt {
  readonly version: number;
  readonly socialResult: string;
  readonly leafNonce: bigint;
  readonly claimed: boolean;
  readonly bump: number;
}
