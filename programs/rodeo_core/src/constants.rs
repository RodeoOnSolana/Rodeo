pub const RODEO_DECIMALS_MAX: u8 = 9;
pub const RODEO_TOTAL_SUPPLY_WHOLE: u64 = 1_000_000_000;
pub const STAKE_AMOUNT_WHOLE_RODEO: u64 = 100_000;

#[cfg(feature = "test-short-epoch")]
pub const EPOCH_DURATION_SECONDS: i64 = 2;
#[cfg(not(feature = "test-short-epoch"))]
pub const EPOCH_DURATION_SECONDS: i64 = 6 * 60 * 60;

pub const RUNWAY_WINDOW_SECONDS: i64 = 10 * 24 * 60 * 60;
pub const RUNWAY_EPOCHS: u64 = (RUNWAY_WINDOW_SECONDS / EPOCH_DURATION_SECONDS) as u64;

#[cfg(feature = "test-short-epoch")]
pub const POT_FILL_SECONDS: i64 = 2;
#[cfg(not(feature = "test-short-epoch"))]
pub const POT_FILL_SECONDS: i64 = 12 * 60 * 60;
pub const SUIT_EPOCH_DAYS: u64 = 7;
pub const SUIT_EPOCHS: u64 = SUIT_EPOCH_DAYS * 24 * 60 * 60 / (EPOCH_DURATION_SECONDS as u64);

pub const MIN_STAKE_SECONDS: i64 = 24 * 60 * 60;

#[cfg(feature = "test-short-claim-cooldown")]
pub const CLAIM_COOLDOWN_SECONDS: i64 = 2;
#[cfg(not(feature = "test-short-claim-cooldown"))]
pub const CLAIM_COOLDOWN_SECONDS: i64 = 60 * 60;
#[cfg(feature = "test-short-timeout")]
pub const RANDOMNESS_TIMEOUT_SECONDS: i64 = 2;
#[cfg(not(feature = "test-short-timeout"))]
pub const RANDOMNESS_TIMEOUT_SECONDS: i64 = 30 * 60;

#[cfg(feature = "mock-randomness")]
pub const USE_MOCK_RANDOMNESS: bool = true;
#[cfg(not(feature = "mock-randomness"))]
pub const USE_MOCK_RANDOMNESS: bool = false;

#[cfg(feature = "test-fixtures")]
pub const USE_TEST_FIXTURES: bool = true;
#[cfg(not(feature = "test-fixtures"))]
pub const USE_TEST_FIXTURES: bool = false;

pub const CLOSE_EPOCH_BATCH_MAX: u8 = 8;

pub const BPS_DENOMINATOR: u64 = 10_000;
pub const UNSTAKE_TAX_BPS: u64 = 500;
pub const UNSTAKE_RETURN_BPS: u64 = 9_500;
pub const CLAIM_OWNER_BPS: u64 = 8_000;
pub const CLAIM_BULL_POOL_BPS: u64 = 2_000;
pub const DESPERADO_CLAIM_OWNER_BPS: u64 = 9_800;
pub const DESPERADO_CLAIM_BULL_POOL_BPS: u64 = 200;
pub const MINT_THEFT_BPS: u64 = 500;
pub const UNSTAKE_ANSEM_THEFT_BPS: u64 = 500;
pub const MARKETPLACE_FEE_BPS: u64 = 500;

pub const MIN_REVEALS_FOR_THEFT: u64 = 50;
pub const MIN_BULLS_FOR_THEFT: u64 = 3;

pub const EMISSION_COWBOY_BPS: u64 = 9_000;
pub const EMISSION_SUITS_BPS: u64 = 1_000;
pub const SUIT_EQUAL_SPLIT_BPS: u64 = 5_000;
pub const SUIT_PROPORTIONAL_SPLIT_BPS: u64 = 5_000;

pub const REVENUE_ANSEM_BPS: u64 = 7_000;
pub const REVENUE_TEAM_BPS: u64 = 1_500;
pub const REVENUE_BUYBACK_BPS: u64 = 1_000;
pub const REVENUE_SECURITY_BPS: u64 = 500;

pub const ACCRUAL_WEIGHT_SCALE: u128 = 10_000;
pub const COWBOY_REWARD_INDEX_SCALE: u128 = 1_000_000_000_000_000_000;
pub const REWARD_PER_WEIGHT_SCALE: u128 = 1_000_000_000_000_000_000;

pub const PROBABILITY_DENOMINATOR: u64 = 10_000_000;

pub const REJECTION_SAMPLING_MAX_RETRIES: u64 = 64;
pub const RANDOMNESS_DOMAIN_PREFIX: &[u8] = b"rodeo_randomness_v1";

pub const SEED_GLOBAL_CONFIG: &[u8] = b"global-config";
pub const SEED_REWARD_STATE: &[u8] = b"reward-state";
pub const SEED_GLOBAL_GAME_STATE: &[u8] = b"global-game-state";
pub const SEED_BULL_ACCUMULATOR: &[u8] = b"bull-accumulator";
pub const SEED_PRINCIPAL_VAULT: &[u8] = b"principal-vault";
pub const SEED_REWARD_VAULT: &[u8] = b"reward-vault";
pub const SEED_POSITION: &[u8] = b"position";
pub const SEED_CLAIM_COOLDOWN: &[u8] = b"claim_cooldown";
pub const SEED_RANDOMNESS: &[u8] = b"randomness";
pub const SEED_PROTOCOL_CONFIG: &[u8] = b"protocol-config";

pub const ACCOUNT_VERSION_GLOBAL_CONFIG: u8 = 2;
pub const ACCOUNT_VERSION_REWARD_STATE: u8 = 3;
pub const ACCOUNT_VERSION_GLOBAL_GAME_STATE: u8 = 4;
pub const ACCOUNT_VERSION_BULL_ACCUMULATOR: u8 = 3;
pub const ACCOUNT_VERSION_POSITION: u8 = 4;
pub const ACCOUNT_VERSION_WALLET_CLAIM_COOLDOWN: u8 = 1;
pub const ACCOUNT_VERSION_PENDING_RANDOMNESS: u8 = 4;
pub const ACCOUNT_VERSION_PROTOCOL_CONFIG: u8 = 1;

// Compile-time guards for the production-safe default configuration. These are
// always checked when the crate is compiled with the corresponding features.
#[cfg(not(feature = "test-short-timeout"))]
const _: () = assert!(RANDOMNESS_TIMEOUT_SECONDS == 30 * 60);
#[cfg(feature = "test-short-timeout")]
const _: () = assert!(RANDOMNESS_TIMEOUT_SECONDS == 2);

#[cfg(not(feature = "mock-randomness"))]
const _: () = assert!(!USE_MOCK_RANDOMNESS);
#[cfg(feature = "mock-randomness")]
const _: () = assert!(USE_MOCK_RANDOMNESS);

#[cfg(not(feature = "test-fixtures"))]
const _: () = assert!(!USE_TEST_FIXTURES);
#[cfg(feature = "test-fixtures")]
const _: () = assert!(USE_TEST_FIXTURES);

#[cfg(not(feature = "test-short-epoch"))]
const _: () = assert!(EPOCH_DURATION_SECONDS == 6 * 60 * 60);
#[cfg(feature = "test-short-epoch")]
const _: () = assert!(EPOCH_DURATION_SECONDS == 2);

#[cfg(not(feature = "test-short-epoch"))]
const _: () = assert!(POT_FILL_SECONDS == 12 * 60 * 60);
#[cfg(feature = "test-short-epoch")]
const _: () = assert!(POT_FILL_SECONDS == 2);

#[cfg(not(feature = "test-short-claim-cooldown"))]
const _: () = assert!(CLAIM_COOLDOWN_SECONDS == 60 * 60);
#[cfg(feature = "test-short-claim-cooldown")]
const _: () = assert!(CLAIM_COOLDOWN_SECONDS == 2);
