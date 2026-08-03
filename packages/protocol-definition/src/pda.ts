// Mirrors the PDA seed prefixes declared in programs/rodeo_core/src/constants.rs.
// Position identity is derived only from `globalConfig` and `positionId`, so
// ownership changes (marketplace sale, gift, mint theft) never move the
// Position account. Randomness requests are additionally scoped by an
// action type and a per-position action nonce, so a request can only ever
// settle the exact position, action, and nonce it was opened for.
export const PDA_SEEDS = {
  globalConfig: "global-config",
  rewardState: "reward-state",
  globalGameState: "global-game-state",
  bullAccumulator: "bull-accumulator",
  principalVault: "principal-vault",
  rewardVault: "reward-vault",
  position: "position",
  claimCooldown: "claim-cooldown",
  randomness: "randomness",
} as const;

// Stable, append-only discriminant mirroring the on-chain `ActionType` enum.
// Existing entries must never be renumbered or removed; new randomness
// action kinds must only be appended.
export const ACTION_TYPES = {
  reveal: 0,
  unstake: 1,
} as const;

export type ActionTypeName = keyof typeof ACTION_TYPES;
export type ActionTypeId = (typeof ACTION_TYPES)[ActionTypeName];
