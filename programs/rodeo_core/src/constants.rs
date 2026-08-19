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

#[cfg(feature = "test-short-min-stake")]
pub const MIN_STAKE_SECONDS: i64 = 10;
#[cfg(not(feature = "test-short-min-stake"))]
pub const MIN_STAKE_SECONDS: i64 = 24 * 60 * 60;

#[cfg(feature = "test-short-claim-cooldown")]
pub const CLAIM_COOLDOWN_SECONDS: i64 = 2;
#[cfg(not(feature = "test-short-claim-cooldown"))]
pub const CLAIM_COOLDOWN_SECONDS: i64 = 60 * 60;
#[cfg(feature = "test-short-timeout")]
pub const RANDOMNESS_TIMEOUT_SECONDS: i64 = 2;
#[cfg(not(feature = "test-short-timeout"))]
pub const RANDOMNESS_TIMEOUT_SECONDS: i64 = 30 * 60;

#[cfg(feature = "test-short-timeout")]
pub const BULL_PROOF_BUFFER_TTL_SECONDS: i64 = 60;
#[cfg(not(feature = "test-short-timeout"))]
pub const BULL_PROOF_BUFFER_TTL_SECONDS: i64 = 30 * 60;

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
pub const SEED_BULL_REGISTRY: &[u8] = b"bull-registry";
pub const SEED_BULL_PROOF_BUFFER: &[u8] = b"bull-proof-buffer";
pub const SEED_PRINCIPAL_VAULT: &[u8] = b"principal-vault";
pub const SEED_REWARD_VAULT: &[u8] = b"reward-vault";
pub const SEED_POSITION: &[u8] = b"position";
pub const SEED_CLAIM_COOLDOWN: &[u8] = b"claim_cooldown";
pub const SEED_RANDOMNESS: &[u8] = b"randomness";
pub const SEED_PROTOCOL_CONFIG: &[u8] = b"protocol-config";
pub const SEED_RECEIPT_AUTHORITY: &[u8] = b"receipt-authority";
pub const SEED_POSITION_RECEIPT: &[u8] = b"receipt";
pub const SEED_RECEIPT_COLLECTION: &[u8] = b"receipt-collection";
pub const SEED_RECEIPT_FUNDER: &[u8] = b"receipt-funder";

// PositionReceipt v1 configuration. The reserve covers the measured MPL
// Core `CreateV2` rent for a collection-member frozen receipt plus a small
// buffer to keep the zero-data ReceiptFunder PDA rent-exempt. The net SOL
// cost to a player is only the unrecoverable tombstone rent; the rest is
// refunded when the Position exits successfully.
pub const RECEIPT_RESERVE_LAMPORTS: u64 = 5_500_000;

// v1 metadata is code-pinned; callers cannot supply arbitrary URIs.
pub const RECEIPT_NAME_PREFIX: &str = "Rodeo Position #";
pub const RECEIPT_METADATA_BASE_URI: &str = "https://rodeo.invalid/receipts/";
pub const RECEIPT_METADATA_URI_SUFFIX: &str = ".json";

pub const RECEIPT_COLLECTION_NAME: &str = "Rodeo Position Receipts";
pub const RECEIPT_COLLECTION_URI: &str = "https://rodeo.invalid/collection/receipts.json";

pub const ACCOUNT_VERSION_GLOBAL_CONFIG: u8 = 2;
pub const ACCOUNT_VERSION_REWARD_STATE: u8 = 3;
pub const ACCOUNT_VERSION_GLOBAL_GAME_STATE: u8 = 4;
pub const ACCOUNT_VERSION_BULL_ACCUMULATOR: u8 = 3;
pub const ACCOUNT_VERSION_POSITION: u8 = 4;
pub const ACCOUNT_VERSION_WALLET_CLAIM_COOLDOWN: u8 = 1;
pub const ACCOUNT_VERSION_PENDING_RANDOMNESS: u8 = 4;
pub const ACCOUNT_VERSION_PROTOCOL_CONFIG: u8 = 1;
pub const ACCOUNT_VERSION_BULL_REGISTRY: u8 = 1;
pub const ACCOUNT_VERSION_BULL_PROOF_BUFFER: u8 = 1;

// BullRegistry v1: two-level ordered binary Merkle-sum tree.
// Owner tree depth 20 -> up to 2^20 owner buckets.
// Per-owner Bull tree depth 20 -> up to 2^20 Bull leaves per owner.
// These are compile-time parameters for the v1 proof format.
pub const BULL_REGISTRY_OWNER_TREE_DEPTH: u32 = 20;
pub const BULL_REGISTRY_BULL_TREE_DEPTH: u32 = 20;

// Worst-case serialized proof payload for a single reveal:
// up to six full proof sections (victim owner, selected owner, selected bull,
// current owner, current bull, remove bull), each path up to 20 siblings,
// plus leaf structs and per-section metadata.  16 KiB is comfortably above
// the v1 benchmarked worst case and still well within Solana's 10 MiB
// per-account data limit.  The one-shot allocate is capped by the runtime's
// 10,240-byte per-instruction data-growth limit (≈320 32-byte siblings after
// the fixed 194-byte header); larger logical payloads are filled via staged
// `expand_bull_proof` calls, so the prover pays additional rent but the cap
// is not weakened.
pub const BULL_PROOF_BUFFER_SCHEMA_VERSION: u8 = 2;
#[cfg(not(feature = "test-fixtures"))]
pub const BULL_PROOF_BUFFER_MAX_PAYLOAD: usize = 16_384;
#[cfg(feature = "test-fixtures")]
pub const BULL_PROOF_BUFFER_MAX_PAYLOAD: usize = 5_000;

// Account layout: 8-byte discriminator + 182 bytes fixed fields + 4-byte Vec
// length prefix + payload. The first payload byte is at account-data offset 194.
pub const BULL_PROOF_BUFFER_PAYLOAD_OFFSET: usize = 194;

// The Solana runtime limits account-data growth in a single CPI to
// MAX_PERMITTED_DATA_INCREASE (10,240 bytes). A fresh `initialize_bull_proof`
// can therefore create at most a 10,240-byte account in one instruction,
// i.e. 10,240 - 194 = 10,046 bytes of payload. Larger logical payloads keep
// MAX_PAYLOAD = 16,384 but require an explicit `expand_bull_proof` instruction.
pub const BULL_PROOF_BUFFER_ONE_SHOT_MAX_PAYLOAD: u32 =
    10_240u32 - BULL_PROOF_BUFFER_PAYLOAD_OFFSET as u32;

// Same runtime constant, expressed in account-data bytes. This is the largest
// growth permitted in one `expand_bull_proof` call and is used for assertions.
pub const BULL_PROOF_BUFFER_EXPAND_MAX_DELTA: usize = 10_240;

/// Returns the account-data size used by `initialize_bull_proof` for a given
/// `expected_payload_length`. It always allocates at least the fixed header
/// plus `expected_payload_length` when it fits in one CPI, otherwise it caps at
/// the one-shot limit and leaves full expansion to `expand_bull_proof`.
pub const fn bull_proof_buffer_init_space(expected_payload_length: u32) -> usize {
    let capped_payload = if expected_payload_length <= BULL_PROOF_BUFFER_ONE_SHOT_MAX_PAYLOAD {
        expected_payload_length
    } else {
        BULL_PROOF_BUFFER_ONE_SHOT_MAX_PAYLOAD
    };
    BULL_PROOF_BUFFER_PAYLOAD_OFFSET + (capped_payload as usize)
}

// Compile-time guards for the production-safe default configuration. These are
// always checked when the crate is compiled with the corresponding features.
#[cfg(not(feature = "test-short-timeout"))]
const _: () = assert!(RANDOMNESS_TIMEOUT_SECONDS == 30 * 60);
#[cfg(feature = "test-short-timeout")]
const _: () = assert!(RANDOMNESS_TIMEOUT_SECONDS == 2);

#[cfg(not(feature = "test-short-timeout"))]
const _: () = assert!(BULL_PROOF_BUFFER_TTL_SECONDS == 30 * 60);
#[cfg(feature = "test-short-timeout")]
const _: () = assert!(BULL_PROOF_BUFFER_TTL_SECONDS == 60);

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

#[cfg(not(feature = "test-short-min-stake"))]
const _: () = assert!(MIN_STAKE_SECONDS == 24 * 60 * 60);
#[cfg(feature = "test-short-min-stake")]
const _: () = assert!(MIN_STAKE_SECONDS == 10);
