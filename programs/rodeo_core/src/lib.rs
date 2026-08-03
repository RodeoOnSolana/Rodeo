use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

declare_id!("EkEPd5wXSi3NQUHewx64cP27tDQ6uTcK5poG6AuWmy8Z");

pub mod constants;
pub mod math;
pub mod probability;
pub mod state;

use constants::*;
use state::*;

#[program]
pub mod rodeo_core {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        upgrade_council: Pubkey,
        treasury_council: Pubkey,
        emergency_guardians: Pubkey,
    ) -> Result<()> {
        let decimals = ctx.accounts.rodeo_mint.decimals;
        require_gte!(RODEO_DECIMALS_MAX, decimals, RodeoError::InvalidDecimals);

        let atomic_multiplier = 10u64
            .checked_pow(decimals as u32)
            .ok_or(RodeoError::InvalidDecimals)?;

        let stake_amount_atomic = math::checked_mul_u64(STAKE_AMOUNT_WHOLE_RODEO, atomic_multiplier)?;
        let expected_total_supply_atomic =
            math::checked_mul_u64(RODEO_TOTAL_SUPPLY_WHOLE, atomic_multiplier)?;

        require_eq!(
            ctx.accounts.rodeo_mint.supply,
            expected_total_supply_atomic,
            RodeoError::UnexpectedRodeoSupply
        );

        let launch_timestamp = Clock::get()?.unix_timestamp;

        let global_config = &mut ctx.accounts.global_config;
        require_eq!(global_config.version, 0, RodeoError::AlreadyInitialized);
        global_config.version = ACCOUNT_VERSION_GLOBAL_CONFIG;
        global_config.rodeo_mint = ctx.accounts.rodeo_mint.key();
        global_config.ansem_mint = ctx.accounts.ansem_mint.key();
        global_config.rodeo_decimals = decimals;
        global_config.ansem_decimals = ctx.accounts.ansem_mint.decimals;
        global_config.stake_amount_atomic = stake_amount_atomic;
        global_config.expected_total_supply_atomic = expected_total_supply_atomic;
        global_config.launch_timestamp = launch_timestamp;
        global_config.principal_vault = ctx.accounts.principal_vault.key();
        global_config.reward_vault = ctx.accounts.reward_vault.key();
        global_config.pause_new_stakes = false;
        global_config.pause_new_reveal_requests = false;
        global_config.pause_new_marketplace_listings = false;
        global_config.pause_router_swaps = false;
        global_config.upgrade_council = upgrade_council;
        global_config.treasury_council = treasury_council;
        global_config.emergency_guardians = emergency_guardians;
        global_config.bump = ctx.bumps.global_config;
        global_config.principal_vault_bump = ctx.bumps.principal_vault;
        global_config.reward_vault_bump = ctx.bumps.reward_vault;

        let reward_state = &mut ctx.accounts.reward_state;
        reward_state.version = ACCOUNT_VERSION_REWARD_STATE;
        reward_state.global_config = global_config.key();
        reward_state.current_epoch = 0;
        reward_state.epoch_started_at = launch_timestamp;
        reward_state.last_closed_epoch_timestamp = 0;
        reward_state.total_ansem_liability_atomic = 0;
        reward_state.cowboy_unmaterialized_liability_atomic = 0;
        reward_state.position_claimable_liability_atomic = 0;
        reward_state.bull_pool_liability_atomic = 0;
        reward_state.bull_pool_unallocated_liability_atomic = 0;
        reward_state.suit_vault_liability_atomic = 0;
        reward_state.recognized_reward_balance_atomic = 0;
        reward_state.ansem_emitted_atomic = 0;
        reward_state.ansem_claimed_atomic = 0;
        reward_state.orphaned_reward_released_atomic = 0;
        reward_state.cowboy_reward_index = 0;
        reward_state.cowboy_index_remainder_scaled = 0;
        reward_state.cowboy_orphaned_accrual_remainder_scaled = 0;
        reward_state.suit_epoch = 0;
        reward_state.bump = ctx.bumps.reward_state;

        let global_game_state = &mut ctx.accounts.global_game_state;
        global_game_state.version = ACCOUNT_VERSION_GLOBAL_GAME_STATE;
        global_game_state.global_config = global_config.key();
        global_game_state.total_completed_reveals = 0;
        global_game_state.live_position_count = 0;
        global_game_state.active_cowboy_count = 0;
        global_game_state.active_bull_count = 0;
        global_game_state.total_active_cowboy_weight = 0;
        global_game_state.total_active_bull_power = 0;
        global_game_state.accounted_principal_atomic = 0;
        global_game_state.bump = ctx.bumps.global_game_state;

        let bull_accumulator = &mut ctx.accounts.bull_accumulator;
        bull_accumulator.version = ACCOUNT_VERSION_BULL_ACCUMULATOR;
        bull_accumulator.global_config = global_config.key();
        bull_accumulator.reward_per_weight_scaled = 0;
        bull_accumulator.bull_index_remainder_scaled = 0;
        bull_accumulator.bull_orphaned_accrual_remainder_scaled = 0;
        bull_accumulator.bump = ctx.bumps.bull_accumulator;

        emit!(ProtocolInitialized {
            global_config: global_config.key(),
            reward_state: reward_state.key(),
            global_game_state: global_game_state.key(),
            bull_accumulator: bull_accumulator.key(),
            rodeo_mint: global_config.rodeo_mint,
            ansem_mint: global_config.ansem_mint,
            rodeo_decimals: decimals,
            ansem_decimals: global_config.ansem_decimals,
            stake_amount_atomic,
            expected_total_supply_atomic,
            launch_timestamp,
            principal_vault: global_config.principal_vault,
            reward_vault: global_config.reward_vault,
            upgrade_council,
            treasury_council,
            emergency_guardians,
        });

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(upgrade_council: Pubkey, treasury_council: Pubkey, emergency_guardians: Pubkey)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub rodeo_mint: Account<'info, Mint>,
    pub ansem_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [b"global-config"],
        bump
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + RewardState::INIT_SPACE,
        seeds = [b"reward-state", global_config.key().as_ref()],
        bump
    )]
    pub reward_state: Account<'info, RewardState>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + GlobalGameState::INIT_SPACE,
        seeds = [b"global-game-state", global_config.key().as_ref()],
        bump
    )]
    pub global_game_state: Account<'info, GlobalGameState>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + BullAccumulator::INIT_SPACE,
        seeds = [b"bull-accumulator", global_config.key().as_ref()],
        bump
    )]
    pub bull_accumulator: Account<'info, BullAccumulator>,

    #[account(
        init_if_needed,
        payer = payer,
        seeds = [b"principal-vault"],
        bump,
        token::mint = rodeo_mint,
        token::authority = global_config
    )]
    pub principal_vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = payer,
        seeds = [b"reward-vault"],
        bump,
        token::mint = ansem_mint,
        token::authority = global_config
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct ProtocolInitialized {
    pub global_config: Pubkey,
    pub reward_state: Pubkey,
    pub global_game_state: Pubkey,
    pub bull_accumulator: Pubkey,
    pub rodeo_mint: Pubkey,
    pub ansem_mint: Pubkey,
    pub rodeo_decimals: u8,
    pub ansem_decimals: u8,
    pub stake_amount_atomic: u64,
    pub expected_total_supply_atomic: u64,
    pub launch_timestamp: i64,
    pub principal_vault: Pubkey,
    pub reward_vault: Pubkey,
    pub upgrade_council: Pubkey,
    pub treasury_council: Pubkey,
    pub emergency_guardians: Pubkey,
}

#[event]
pub struct PositionOwnerChanged {
    pub position: Pubkey,
    pub previous_owner: Pubkey,
    pub new_owner: Pubkey,
    pub reason: state::OwnershipChangeReason,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum RodeoError {
    #[msg("Integer arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Protocol has already been initialized")]
    AlreadyInitialized,
    #[msg("Invalid mint account")]
    InvalidMint,
    #[msg("RODEO mint supply does not match the expected total supply")]
    UnexpectedRodeoSupply,
    #[msg("Invalid vault account")]
    InvalidVault,
    #[msg("Invalid decimals or atomic conversion failed")]
    InvalidDecimals,
    #[msg("Unauthorized initializer")]
    UnauthorizedInitializer,
    #[msg("Principal must be greater than zero")]
    ZeroPrincipal,
    #[msg("Randomness has already been settled")]
    AlreadySettled,
    #[msg("Reveal does not match the commitment")]
    InvalidReveal,
    #[msg("Position owner does not match the signer")]
    InvalidOwner,
    #[msg("No reveal action is pending for this position")]
    NoPendingRevealAction,
    #[msg("Position has a pending action and cannot be transferred")]
    PositionLocked,
    #[msg("Stake amount must equal the configured requirement")]
    StakeAmountMismatch,
    #[msg("Position has not been active long enough")]
    MinimumStakePeriodNotMet,
    #[msg("Wallet claim cooldown has not elapsed")]
    ClaimCooldownNotMet,
    #[msg("Position has no claimable ANSEM after synchronization")]
    NoClaimableRewards,
    #[msg("All elapsed epochs must be closed before this operation")]
    EpochsNotClosed,
    #[msg("Randomness outcome does not map to a valid role/cowboy_kind/bull_tier/suit")]
    InvalidProbabilityOutcome,
    #[msg("Probability table weights do not sum to denominator")]
    InvalidProbabilityTable,
    #[msg("Cannot change owner while a randomness action is pending")]
    PendingActionBlocksTransfer,
    #[msg("Cannot claim while a randomness action is pending")]
    PendingActionBlocksClaim,
    #[msg("Listing no longer matches the position state")]
    StaleListing,
    #[msg("Receipt asset does not match the position")]
    InvalidMarketReceipt,
    #[msg("Social oracle attestation signatures are invalid")]
    InvalidSocialAttestation,
    #[msg("Social competition epoch has not ended")]
    SuitCompetitionNotEnded,
    #[msg("ANSEM in the vault is not yet recognized for liability accounting")]
    UnrecognizedRewardFunding,
    #[msg("Unauthorized swap venue")]
    UnauthorizedSwapVenue,
    #[msg("Swap output below minimum")]
    SlippageExceeded,
    #[msg("New stakes are paused")]
    PausedNewStakes,
    #[msg("New reveal requests are paused")]
    PausedNewRevealRequests,
    #[msg("New marketplace listings are paused")]
    PausedNewMarketplaceListings,
    #[msg("Router swaps are paused")]
    PausedRouterSwaps,
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use constants::*;

    #[test]
    fn constants_match_typescript_expectations() {
        assert_eq!(RODEO_TOTAL_SUPPLY_WHOLE, 1_000_000_000u64);
        assert_eq!(STAKE_AMOUNT_WHOLE_RODEO, 100_000u64);
        assert_eq!(EPOCH_DURATION_SECONDS, 21_600i64);
        assert_eq!(RUNWAY_EPOCHS, 40u64);
        assert_eq!(POT_FILL_SECONDS, 43_200i64);
        assert_eq!(SUIT_EPOCHS, 28u64);
        assert_eq!(MIN_STAKE_SECONDS, 86_400i64);
        assert_eq!(UNSTAKE_TAX_BPS, 500u64);
        assert_eq!(UNSTAKE_RETURN_BPS, 9_500u64);
        assert_eq!(CLAIM_OWNER_BPS, 8_000u64);
        assert_eq!(CLAIM_BULL_POOL_BPS, 2_000u64);
        assert_eq!(EMISSION_COWBOY_BPS, 9_000u64);
        assert_eq!(EMISSION_SUITS_BPS, 1_000u64);
        assert_eq!(ACCRUAL_WEIGHT_SCALE, 10_000u128);
        assert_eq!(COWBOY_REWARD_INDEX_SCALE, 1_000_000_000_000_000_000u128);
    }

    #[test]
    fn account_versions_match_protocol_definition() {
        assert_eq!(ACCOUNT_VERSION_GLOBAL_CONFIG, 1);
        assert_eq!(ACCOUNT_VERSION_REWARD_STATE, 3);
        assert_eq!(ACCOUNT_VERSION_GLOBAL_GAME_STATE, 3);
        assert_eq!(ACCOUNT_VERSION_BULL_ACCUMULATOR, 3);
        assert_eq!(ACCOUNT_VERSION_POSITION, 3);
        assert_eq!(ACCOUNT_VERSION_WALLET_CLAIM_COOLDOWN, 1);
        assert_eq!(ACCOUNT_VERSION_PENDING_RANDOMNESS, 3);
    }

    #[test]
    fn action_type_discriminants_are_stable() {
        let mut buf = Vec::new();
        state::ActionType::Reveal.serialize(&mut buf).unwrap();
        assert_eq!(buf[0], 0);
        buf.clear();
        state::ActionType::Unstake.serialize(&mut buf).unwrap();
        assert_eq!(buf[0], 1);
    }

    #[test]
    fn whole_to_atomic_matches_typescript() {
        assert_eq!(math::whole_to_atomic(100_000, 6).unwrap(), 100_000_000_000u64);
        assert_eq!(
            math::whole_to_atomic(1_000_000_000, 6).unwrap(),
            1_000_000_000_000_000u64
        );
    }

    #[test]
    fn checked_math_rejects_overflow() {
        assert!(math::checked_add_u64(u64::MAX, 1).is_err());
        assert!(math::checked_sub_u64(0, 1).is_err());
        assert!(math::checked_mul_u64(u64::MAX, 2).is_err());
    }

    #[test]
    fn bps_split_is_exact_floor() {
        let amount = 1_000_000u64;
        let owner = math::floor_bps(amount, CLAIM_OWNER_BPS).unwrap();
        let remainder = math::bps_remainder(amount, CLAIM_OWNER_BPS).unwrap();
        assert_eq!(owner, 800_000);
        assert_eq!(remainder, 200_000);
        assert_eq!(owner + remainder, amount);
    }

    #[test]
    fn ceil_mul_div_rounds_up() {
        assert_eq!(math::ceil_mul_div_u128(10, 1, 3).unwrap(), 4);
        assert_eq!(math::ceil_mul_div_u128(9, 1, 3).unwrap(), 3);
    }

    #[test]
    fn cowboy_index_increment_with_carry() {
        let (new_index, new_remainder) = math::increment_cowboy_index(
            0,
            0,
            2_000_000,
            20_000,
            COWBOY_REWARD_INDEX_SCALE,
        )
        .unwrap();
        let expected_numerator = 2_000_000u128 * COWBOY_REWARD_INDEX_SCALE;
        assert_eq!(new_index, expected_numerator / 20_000);
        assert_eq!(new_remainder, expected_numerator % 20_000);
    }

    #[test]
    fn per_position_cowboy_accrual() {
        let current = COWBOY_REWARD_INDEX_SCALE * 3;
        let last = COWBOY_REWARD_INDEX_SCALE;
        let weight = 10_500u128;
        let (accrued, remainder) =
            math::accrue_cowboy(current, last, weight, 0, COWBOY_REWARD_INDEX_SCALE).unwrap();
        assert_eq!(accrued, 2 * weight as u64);
        assert_eq!(remainder, 0);
    }

    #[test]
    fn per_position_cowboy_accrual_with_remainder_carry() {
        let current = COWBOY_REWARD_INDEX_SCALE / 2;
        let last = 0;
        let weight = 10_000u128;
        let (accrued, remainder) =
            math::accrue_cowboy(current, last, weight, 0, COWBOY_REWARD_INDEX_SCALE).unwrap();
        assert_eq!(accrued, 0);
        assert_eq!(remainder, COWBOY_REWARD_INDEX_SCALE / 2);
    }

    #[test]
    fn probability_tables_are_valid() {
        probability::ROLE_TABLE.validate().unwrap();
        probability::COWBOY_RANK_TABLE.validate().unwrap();
        probability::BULL_TIER_TABLE.validate().unwrap();
        probability::SUIT_TABLE.validate().unwrap();
        probability::THEFT_FLAG_TABLE.validate().unwrap();
    }

    #[test]
    fn role_mapping_boundaries() {
        let mut buf = [0u8; 32];
        buf[0..8].copy_from_slice(&0u64.to_le_bytes());
        assert_eq!(probability::map_role(buf), state::Role::Cowboy);

        buf[0..8].copy_from_slice(&8_999_999u64.to_le_bytes());
        assert_eq!(probability::map_role(buf), state::Role::Cowboy);

        buf[0..8].copy_from_slice(&9_000_000u64.to_le_bytes());
        assert_eq!(probability::map_role(buf), state::Role::Bull);

        buf[0..8].copy_from_slice(&9_999_999u64.to_le_bytes());
        assert_eq!(probability::map_role(buf), state::Role::Bull);
    }

    #[test]
    fn cowboy_rank_mapping_boundaries() {
        let mut buf = [0u8; 32];
        let check = |draw: u64, expected: state::CowboyKind| {
            buf[0..8].copy_from_slice(&draw.to_le_bytes());
            assert_eq!(probability::map_cowboy_kind(buf), expected);
        };
        check(0, state::CowboyKind::Rank(4));
        check(4_047_749, state::CowboyKind::Rank(4));
        check(4_047_750, state::CowboyKind::Rank(5));
        check(4_047_750 + 2_248_749, state::CowboyKind::Rank(5));
        check(4_047_750 + 2_248_750, state::CowboyKind::Rank(6));
        let cumulative_before_desperado = 9_000_000 - 5_000;
        check(cumulative_before_desperado - 1, state::CowboyKind::Rank(10));
        check(cumulative_before_desperado, state::CowboyKind::Desperado);
        check(8_999_999, state::CowboyKind::Desperado);
    }

    #[test]
    fn bull_tier_mapping_boundaries() {
        let mut buf = [0u8; 32];
        buf[0..8].copy_from_slice(&0u64.to_le_bytes());
        assert_eq!(probability::map_bull_tier(buf), 1);
        buf[0..8].copy_from_slice(&599_999u64.to_le_bytes());
        assert_eq!(probability::map_bull_tier(buf), 1);
        buf[0..8].copy_from_slice(&600_000u64.to_le_bytes());
        assert_eq!(probability::map_bull_tier(buf), 2);
        buf[0..8].copy_from_slice(&999_999u64.to_le_bytes());
        assert_eq!(probability::map_bull_tier(buf), 4);
    }

    #[test]
    fn suit_mapping_is_uniform() {
        let mut buf = [0u8; 32];
        buf[0..8].copy_from_slice(&0u64.to_le_bytes());
        assert_eq!(probability::map_suit(buf), state::Suit::Hearts);
        buf[0..8].copy_from_slice(&2_499_999u64.to_le_bytes());
        assert_eq!(probability::map_suit(buf), state::Suit::Hearts);
        buf[0..8].copy_from_slice(&2_500_000u64.to_le_bytes());
        assert_eq!(probability::map_suit(buf), state::Suit::Diamonds);
        buf[0..8].copy_from_slice(&7_500_000u64.to_le_bytes());
        assert_eq!(probability::map_suit(buf), state::Suit::Spades);
    }

    #[test]
    fn theft_flag_boundaries() {
        let mut buf = [0u8; 32];
        buf[0..8].copy_from_slice(&0u64.to_le_bytes());
        assert!(probability::map_theft_flag(buf));
        buf[0..8].copy_from_slice(&499_999u64.to_le_bytes());
        assert!(probability::map_theft_flag(buf));
        buf[0..8].copy_from_slice(&500_000u64.to_le_bytes());
        assert!(!probability::map_theft_flag(buf));
    }

    #[test]
    fn accrual_weights_and_buck_power() {
        assert_eq!(probability::accrual_weight_for_rank(4), 10_000);
        assert_eq!(probability::accrual_weight_for_rank(10), 15_500);
        assert_eq!(probability::accrual_weight_for_rank(7), 11_800);
        assert_eq!(probability::buck_power_for_tier(1), 4);
        assert_eq!(probability::buck_power_for_tier(4), 10);
    }

    #[test]
    fn deterministic_mapping_is_stable() {
        let buf = [42u8; 32];
        let role1 = probability::map_role(buf);
        let role2 = probability::map_role(buf);
        assert_eq!(role1, role2);
    }
}
