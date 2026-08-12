use crate::constants::*;
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub version: u8,
    pub rodeo_mint: Pubkey,
    pub ansem_mint: Pubkey,
    pub rodeo_decimals: u8,
    pub ansem_decimals: u8,
    pub stake_amount_atomic: u64,
    pub expected_total_supply_atomic: u64,
    pub launch_timestamp: i64,
    pub principal_vault: Pubkey,
    pub reward_vault: Pubkey,
    pub pause_new_stakes: bool,
    pub pause_new_reveal_requests: bool,
    pub pause_new_marketplace_listings: bool,
    pub pause_router_swaps: bool,
    pub upgrade_council: Pubkey,
    pub treasury_council: Pubkey,
    pub emergency_guardians: Pubkey,
    pub current_config_version: u64,
    pub bump: u8,
    pub principal_vault_bump: u8,
    pub reward_vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub version: u8,
    pub global_config: Pubkey,
    pub config_version: u64,
    pub role_weights: [u64; 2],
    pub cowboy_rank_weights: [u64; 8],
    pub bull_tier_weights: [u64; 4],
    pub suit_weights: [u64; 4],
    pub mint_theft_weights: [u64; 2],
    pub unstake_theft_weights: [u64; 2],
    pub cowboy_accrual_weights: [u32; 8],
    pub bull_buck_powers: [u8; 4],
    pub min_reveals_for_theft: u64,
    pub min_bulls_for_theft: u64,
    pub unstake_tax_bps: u64,
    pub unstake_return_bps: u64,
    pub bump: u8,
    pub _reserved: [u8; 64],
}

#[account]
#[derive(InitSpace)]
pub struct RewardState {
    pub version: u8,
    pub global_config: Pubkey,
    pub current_epoch: u64,
    pub epoch_started_at: i64,
    pub last_closed_epoch_timestamp: i64,
    pub total_ansem_liability_atomic: u64,
    pub cowboy_unmaterialized_liability_atomic: u64,
    pub position_claimable_liability_atomic: u64,
    pub bull_pool_liability_atomic: u64,
    pub bull_pool_unallocated_liability_atomic: u64,
    pub suit_vault_liability_atomic: u64,
    pub recognized_reward_balance_atomic: u64,
    pub ansem_emitted_atomic: u64,
    pub ansem_claimed_atomic: u64,
    pub orphaned_reward_released_atomic: u64,
    pub cowboy_reward_index: u128,
    pub cowboy_index_remainder_scaled: u128,
    pub cowboy_orphaned_accrual_remainder_scaled: u128,
    pub suit_epoch: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct GlobalGameState {
    pub version: u8,
    pub global_config: Pubkey,
    pub next_position_id: u64,
    pub total_completed_reveals: u64,
    pub live_position_count: u64,
    pub active_cowboy_count: u64,
    pub active_bull_count: u64,
    pub total_active_cowboy_weight: u128,
    pub total_active_bull_power: u64,
    pub accounted_principal_atomic: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BullAccumulator {
    pub version: u8,
    pub global_config: Pubkey,
    pub reward_per_weight_scaled: u128,
    pub bull_index_remainder_scaled: u128,
    pub bull_orphaned_accrual_remainder_scaled: u128,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BullRegistry {
    pub version: u8,
    pub global_config: Pubkey,
    /// Merkle-sum root of the owner tree.
    pub owner_tree_root: [u8; 32],
    /// Total active Bull Position count across all owners.
    pub total_bull_count: u64,
    /// Total active buck power across all owners.
    pub total_buck_power: u64,
    /// Monotonically increasing version. Incremented on every canonical root change.
    pub registry_version: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BullProofBuffer {
    pub version: u8,
    /// Schema version of the payload layout.
    pub schema_version: u8,
    /// The PendingRandomness this buffer is bound to.
    pub pending_randomness: Pubkey,
    /// The Position being settled.
    pub position: Pubkey,
    /// The action this proof buffer is for (Reveal or Unstake).
    pub action_type: ActionType,
    /// Snapshot root the proof must be verified against.
    pub snapshot_root: [u8; 32],
    /// Snapshot version the proof must be verified against.
    pub snapshot_version: u64,
    /// Historical snapshot total power used for external-weight calculation.
    pub snapshot_total_power: u64,
    /// Historical snapshot total Bull count used for threshold checks.
    pub snapshot_total_count: u64,
    /// The party that funded the buffer and receives its rent on close.
    pub refund_recipient: Pubkey,
    /// Timestamp after which the buffer is abandonable even if unconsumed.
    pub expiry_timestamp: i64,
    /// Nonce used in the PDA derivation to allow multiple buffers per prover.
    pub nonce: u64,
    /// Expected total payload length in bytes. Finalize enforces exact match.
    pub expected_payload_length: u32,
    /// True once the prover has finalized the payload; settlement may then consume it.
    pub finalized: bool,
    /// True once the buffer has been consumed by settlement.
    pub consumed: bool,
    /// Bump for the proof-buffer PDA.
    pub bump: u8,
    /// Serialized proof payload (variable length, bounded by `BULL_PROOF_BUFFER_MAX_PAYLOAD`).
    #[max_len(BULL_PROOF_BUFFER_MAX_PAYLOAD)]
    pub payload: Vec<u8>,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub version: u8,
    pub owner: Pubkey,
    pub position_id: u64,
    pub principal_amount: u64,
    pub role: Role,
    pub status: PositionStatus,
    pub cowboy_kind: CowboyKind,
    pub bull_tier: u8,
    pub suit: Suit,
    pub opened_at: i64,
    pub active_since: i64,
    pub unstake_eligible_at: i64,
    pub accrual_weight: u32,
    pub buck_power: u8,
    pub last_cowboy_reward_index: u128,
    pub last_bull_reward_per_weight: u128,
    pub cowboy_accrual_remainder_scaled: u128,
    pub bull_accrual_remainder_scaled: u128,
    pub claimable_ansem_atomic: u64,
    pub settlement_nonce: u64,
    pub state_version: u64,
    pub listing_nonce: u64,
    pub receipt_asset: Pubkey,
    pub pending_action_active: bool,
    pub pending_action_type: ActionType,
    pub pending_action_nonce: u64,
    pub next_action_nonce: u64,
    pub reveal_config_version: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct WalletClaimCooldown {
    pub version: u8,
    pub global_config: Pubkey,
    pub wallet: Pubkey,
    pub last_claimed_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PendingRandomness {
    pub version: u8,
    pub position: Pubkey,
    pub action_type: ActionType,
    pub action_nonce: u64,
    pub provider_program: Pubkey,
    pub provider_randomness_account: Pubkey,
    pub commitment: [u8; 32],
    pub committed_slot: u64,
    pub committed_protocol_epoch: u64,
    pub timeout_timestamp: i64,
    pub registry_root_snapshot: [u8; 32],
    pub registry_version_snapshot: u64,
    pub registry_total_count_snapshot: u64,
    pub registry_total_power_snapshot: u64,
    pub config_version_snapshot: u64,
    pub settled: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum Role {
    Unassigned,
    Cowboy,
    Bull,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum PositionStatus {
    RevealPending,
    Active,
}

/// Stable, append-only discriminant for randomness actions.
/// Variants must never be reordered. Existing discriminants:
/// Reveal = 0, Unstake = 1.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum ActionType {
    Reveal,
    Unstake,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum Suit {
    Unassigned,
    Hearts,
    Diamonds,
    Clubs,
    Spades,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum CowboyKind {
    Unassigned,
    Rank(u8),
    Desperado,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum PauseFlag {
    NewStakes,
    NewRevealRequests,
    NewMarketplaceListings,
    RouterSwaps,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum OwnershipChangeReason {
    Sale,
    Gift,
    MintTheft,
}
