export const RODEO_DECIMALS_MAX = 9; // reject configurations that would overflow u64 intermediates

export const RODEO_TOTAL_SUPPLY_WHOLE = 1_000_000_000n;
export const STAKE_AMOUNT_WHOLE_RODEO = 100_000n;

export function rodeoTotalSupplyAtomic(decimals: bigint | number): bigint {
  const d = BigInt(decimals);
  if (d > BigInt(RODEO_DECIMALS_MAX)) throw new RangeError("RODEO decimals too large");
  return RODEO_TOTAL_SUPPLY_WHOLE * 10n ** d;
}

export function stakeAmountAtomic(decimals: bigint | number): bigint {
  const d = BigInt(decimals);
  if (d > BigInt(RODEO_DECIMALS_MAX)) throw new RangeError("RODEO decimals too large");
  return STAKE_AMOUNT_WHOLE_RODEO * 10n ** d;
}

export const EPOCH_DURATION_SECONDS = 6n * 60n * 60n;
export const RUNWAY_WINDOW_SECONDS = 10n * 24n * 60n * 60n;
export const RUNWAY_EPOCHS = RUNWAY_WINDOW_SECONDS / EPOCH_DURATION_SECONDS;
export const POT_FILL_SECONDS = 12n * 60n * 60n;
export const SUIT_EPOCH_DAYS = 7n;
export const SUIT_EPOCHS = SUIT_EPOCH_DAYS * 24n * 60n * 60n / EPOCH_DURATION_SECONDS;

export const MIN_STAKE_SECONDS = 24n * 60n * 60n;

export const BPS_DENOMINATOR = 10_000n;
export const UNSTAKE_TAX_BPS = 500n;
export const UNSTAKE_RETURN_BPS = 9_500n;
export const CLAIM_OWNER_BPS = 8_000n;
export const CLAIM_BULL_POOL_BPS = 2_000n;
export const DESPERADO_CLAIM_OWNER_BPS = 9_800n;
export const DESPERADO_CLAIM_BULL_POOL_BPS = 200n;
export const MINT_THEFT_BPS = 500n;
export const UNSTAKE_ANSEM_THEFT_BPS = 500n;
export const MARKETPLACE_FEE_BPS = 500n;

export const MIN_REVEALS_FOR_THEFT = 50n;
export const MIN_BULLS_FOR_THEFT = 3n;

export const EMISSION_COWBOY_BPS = 9_000n;
export const EMISSION_SUITS_BPS = 1_000n;
export const SUIT_EQUAL_SPLIT_BPS = 5_000n;
export const SUIT_PROPORTIONAL_SPLIT_BPS = 5_000n;

export const REVENUE_ANSEM_BPS = 7_000n;
export const REVENUE_TEAM_BPS = 1_500n;
export const REVENUE_BUYBACK_BPS = 1_000n;
export const REVENUE_SECURITY_BPS = 500n;

export const CLAIM_COOLDOWN_SECONDS = 60n * 60n;
export const MAX_POSTS_PER_X_ACCOUNT_PER_SUIT_EPOCH = 3n;
export const RANDOMNESS_TIMEOUT_SECONDS = 30n * 60n;
export const CLOSE_EPOCH_BATCH_MAX = 8n;

export const ACCRUAL_WEIGHT_SCALE = 10_000n;
export const COWBOY_REWARD_INDEX_SCALE = 1_000_000_000_000_000_000n;
export const REWARD_PER_WEIGHT_SCALE = 1_000_000_000_000_000_000n;

export const PROBABILITY_DENOMINATOR = 10_000_000n;

export const REJECTION_SAMPLING_MAX_RETRIES = 64;

export const RANDOMNESS_DOMAIN_PREFIX = new TextEncoder().encode("rodeo_randomness_v1");

export enum RandomnessDomain {
  Reveal = 0,
  Unstake = 1,
  MintTheft = 2,
  UnstakeTheft = 3,
  Role = 4,
  CowboyKind = 5,
  BullTier = 6,
  Suit = 7,
  OwnerSelection = 8,
  BullSelection = 9,
}

export const SEED_GLOBAL_CONFIG = Buffer.from("global-config");
export const SEED_REWARD_STATE = Buffer.from("reward-state");
export const SEED_GLOBAL_GAME_STATE = Buffer.from("global-game-state");
export const SEED_BULL_ACCUMULATOR = Buffer.from("bull-accumulator");
export const SEED_PRINCIPAL_VAULT = Buffer.from("principal-vault");
export const SEED_REWARD_VAULT = Buffer.from("reward-vault");
export const SEED_POSITION = Buffer.from("position");
export const SEED_CLAIM_COOLDOWN = Buffer.from("claim_cooldown");
export const SEED_RANDOMNESS = Buffer.from("randomness");
export const SEED_PROTOCOL_CONFIG = Buffer.from("protocol-config");
