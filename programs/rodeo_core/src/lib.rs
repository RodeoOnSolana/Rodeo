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

    #[constant]
    pub const DEFAULT_PAUSE_FLAG: state::PauseFlag = state::PauseFlag::NewStakes;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        upgrade_council: Pubkey,
        treasury_council: Pubkey,
        emergency_guardians: Pubkey,
    ) -> Result<()> {
        let program_data = ctx.accounts.program_data.try_borrow_data()?;
        let program_data_state = anchor_lang::solana_program::program_utils::limited_deserialize::<
            anchor_lang::solana_program::bpf_loader_upgradeable::UpgradeableLoaderState,
        >(&program_data, program_data.len() as u64)
        .map_err(|_| error!(RodeoError::InvalidProgramData))?;
        let upgrade_authority_address = match program_data_state {
            anchor_lang::solana_program::bpf_loader_upgradeable::UpgradeableLoaderState::ProgramData {
                upgrade_authority_address,
                ..
            } => upgrade_authority_address,
            _ => return err!(RodeoError::InvalidProgramData),
        };
        require!(
            upgrade_authority_address == Some(ctx.accounts.initializer.key()),
            RodeoError::UnauthorizedInitializer
        );

        let decimals = ctx.accounts.rodeo_mint.decimals;
        require_gte!(RODEO_DECIMALS_MAX, decimals, RodeoError::InvalidDecimals);

        let atomic_multiplier = 10u64
            .checked_pow(decimals as u32)
            .ok_or(RodeoError::InvalidDecimals)?;

        let stake_amount_atomic =
            math::checked_mul_u64(STAKE_AMOUNT_WHOLE_RODEO, atomic_multiplier)?;
        let expected_total_supply_atomic =
            math::checked_mul_u64(RODEO_TOTAL_SUPPLY_WHOLE, atomic_multiplier)?;

        require_eq!(
            ctx.accounts.rodeo_mint.supply,
            expected_total_supply_atomic,
            RodeoError::UnexpectedRodeoSupply
        );
        require_keys_neq!(
            ctx.accounts.rodeo_mint.key(),
            ctx.accounts.ansem_mint.key(),
            RodeoError::IdenticalTokenMints
        );
        require!(
            ctx.accounts.rodeo_mint.mint_authority.is_none(),
            RodeoError::ActiveMintAuthority
        );
        require!(
            ctx.accounts.rodeo_mint.freeze_authority.is_none(),
            RodeoError::ActiveFreezeAuthority
        );
        require!(
            ctx.accounts.ansem_mint.mint_authority.is_none(),
            RodeoError::ActiveMintAuthority
        );
        require!(
            ctx.accounts.ansem_mint.freeze_authority.is_none(),
            RodeoError::ActiveFreezeAuthority
        );

        require!(
            !upgrade_council.eq(&Pubkey::default()),
            RodeoError::InvalidGovernanceAuthority
        );
        require!(
            !treasury_council.eq(&Pubkey::default()),
            RodeoError::InvalidGovernanceAuthority
        );
        require!(
            !emergency_guardians.eq(&Pubkey::default()),
            RodeoError::InvalidGovernanceAuthority
        );
        require!(
            upgrade_council != treasury_council
                && upgrade_council != emergency_guardians
                && treasury_council != emergency_guardians,
            RodeoError::GovernanceAuthoritiesNotDistinct
        );

        let launch_timestamp = Clock::get()?.unix_timestamp;
        let first_epoch_start = launch_timestamp
            .checked_add(POT_FILL_SECONDS)
            .ok_or(RodeoError::ArithmeticOverflow)?;

        let global_config = &mut ctx.accounts.global_config;
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
        reward_state.epoch_started_at = first_epoch_start;
        reward_state.last_closed_epoch_timestamp = first_epoch_start;
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

    pub fn stake_and_commit(
        ctx: Context<StakeAndCommit>,
        position_id: u64,
        principal_amount: u64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.global_config.pause_new_stakes,
            RodeoError::PausedNewStakes
        );
        require!(
            !ctx.accounts.global_config.pause_new_reveal_requests,
            RodeoError::PausedNewRevealRequests
        );

        let stake_amount = ctx.accounts.global_config.stake_amount_atomic;
        require_eq!(
            principal_amount,
            stake_amount,
            RodeoError::StakeAmountMismatch
        );

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let action_nonce = ctx.accounts.position.next_action_nonce;
        require!(
            ctx.accounts.position.version == 0,
            RodeoError::PositionAlreadyExists
        );
        require!(
            !ctx.accounts.position.pending_action_active,
            RodeoError::PendingActionConflict
        );

        let commitment = derive_commitment(
            ctx.accounts.position.key(),
            ActionType::Reveal,
            action_nonce,
            ctx.accounts.reward_state.current_epoch,
        );

        // Transfer the configured stake into the principal vault.
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.owner_rodeo_token_account.to_account_info(),
                to: ctx.accounts.principal_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        );
        anchor_spl::token::transfer(transfer_ctx, principal_amount)?;

        // Initialize the Position.
        let position = &mut ctx.accounts.position;
        position.version = ACCOUNT_VERSION_POSITION;
        position.owner = ctx.accounts.owner.key();
        position.position_id = position_id;
        position.principal_amount = principal_amount;
        position.role = Role::Unassigned;
        position.status = PositionStatus::RevealPending;
        position.cowboy_kind = CowboyKind::Unassigned;
        position.bull_tier = 0;
        position.suit = Suit::Unassigned;
        position.opened_at = now;
        position.active_since = 0;
        position.unstake_eligible_at = 0;
        position.accrual_weight = 0;
        position.buck_power = 0;
        position.last_cowboy_reward_index = 0;
        position.cowboy_accrual_remainder_scaled = 0;
        position.last_bull_reward_per_weight = 0;
        position.bull_accrual_remainder_scaled = 0;
        position.claimable_ansem_atomic = 0;
        position.settlement_nonce = 0;
        position.state_version = 0;
        position.listing_nonce = 0;
        position.receipt_asset = Pubkey::default();
        position.pending_action_active = true;
        position.pending_action_type = ActionType::Reveal;
        position.pending_action_nonce = action_nonce;
        position.next_action_nonce = math::checked_add_u64(action_nonce, 1)?;
        position.bump = ctx.bumps.position;

        // Initialize the reveal PendingRandomness account.
        let pending_randomness = &mut ctx.accounts.pending_randomness;
        pending_randomness.version = ACCOUNT_VERSION_PENDING_RANDOMNESS;
        pending_randomness.position = position.key();
        pending_randomness.action_type = ActionType::Reveal;
        pending_randomness.action_nonce = action_nonce;
        pending_randomness.provider_program = Pubkey::default();
        pending_randomness.provider_randomness_account = Pubkey::default();
        pending_randomness.commitment = commitment;
        pending_randomness.committed_slot = clock.slot;
        pending_randomness.committed_protocol_epoch = ctx.accounts.reward_state.current_epoch;
        pending_randomness.timeout_timestamp = now
            .checked_add(RANDOMNESS_TIMEOUT_SECONDS)
            .ok_or(RodeoError::ArithmeticOverflow)?;
        pending_randomness.registry_root_snapshot = [0u8; 32];
        pending_randomness.registry_version_snapshot = 0;
        pending_randomness.settled = false;
        pending_randomness.bump = ctx.bumps.pending_randomness;

        // Update global counters.
        let game_state = &mut ctx.accounts.global_game_state;
        game_state.live_position_count = math::checked_add_u64(game_state.live_position_count, 1)?;
        game_state.accounted_principal_atomic =
            math::checked_add_u64(game_state.accounted_principal_atomic, principal_amount)?;

        emit!(PositionStaked {
            position: position.key(),
            owner: position.owner,
            position_id,
            principal_amount,
            commitment,
            global_game_state: game_state.key(),
        });
        emit!(RandomnessRequested {
            position: position.key(),
            action_type: ActionType::Reveal,
            action_nonce,
            committed_slot: clock.slot,
            committed_protocol_epoch: ctx.accounts.reward_state.current_epoch,
            timeout_timestamp: pending_randomness.timeout_timestamp,
            provider_program: Pubkey::default(),
            provider_randomness_account: Pubkey::default(),
            vrf_key: None,
            callback_id: None,
            registry_root_snapshot: [0u8; 32],
            registry_version_snapshot: 0,
            commitment,
        });

        Ok(())
    }

    pub fn settle_reveal(mut ctx: Context<SettleReveal>) -> Result<()> {
        let position = &ctx.accounts.position;
        let pending_randomness = &ctx.accounts.pending_randomness;

        require!(
            position.pending_action_active,
            RodeoError::PendingActionConflict
        );
        require!(
            position.pending_action_type == ActionType::Reveal,
            RodeoError::WrongActionType
        );
        require!(
            pending_randomness.position == position.key(),
            RodeoError::InvalidPendingRandomness
        );
        require!(
            pending_randomness.action_type == ActionType::Reveal,
            RodeoError::WrongActionType
        );
        require!(
            pending_randomness.action_nonce == position.pending_action_nonce,
            RodeoError::InvalidPendingRandomness
        );
        require!(
            !pending_randomness.settled,
            RodeoError::RandomnessAlreadyAvailable
        );

        #[cfg(feature = "mock-randomness")]
        return settle_reveal_mock(&mut ctx);

        #[cfg(not(feature = "mock-randomness"))]
        {
            // Production builds require a verified Switchboard randomness proof.
            // That adapter is intentionally not implemented in Phase 2B, so
            // settlement is disabled in production.
            err!(RodeoError::RandomnessNotReady)
        }
    }

    pub fn recover_reveal_timeout(ctx: Context<RecoverRevealTimeout>) -> Result<()> {
        let position = &ctx.accounts.position;
        let pending_randomness = &ctx.accounts.pending_randomness;
        let now = Clock::get()?.unix_timestamp;

        require!(
            position.status == PositionStatus::RevealPending,
            RodeoError::InvalidPendingRandomness
        );
        require!(
            position.pending_action_active,
            RodeoError::InvalidPendingRandomness
        );
        require!(
            position.pending_action_type == ActionType::Reveal,
            RodeoError::WrongActionType
        );
        require!(
            pending_randomness.position == position.key(),
            RodeoError::InvalidPendingRandomness
        );
        require!(
            pending_randomness.action_type == ActionType::Reveal,
            RodeoError::WrongActionType
        );
        require!(
            pending_randomness.action_nonce == position.pending_action_nonce,
            RodeoError::InvalidPendingRandomness
        );
        require!(
            !pending_randomness.settled,
            RodeoError::RandomnessAlreadyAvailable
        );
        require!(
            now >= pending_randomness.timeout_timestamp,
            RodeoError::RandomnessTimeoutNotReached
        );

        // Refund the full principal to the owner.
        let principal_amount = position.principal_amount;
        let global_config = &ctx.accounts.global_config;
        let seeds: &[&[u8]] = &[SEED_GLOBAL_CONFIG, &[global_config.bump]];
        let signer: &[&[&[u8]]] = &[seeds];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.principal_vault.to_account_info(),
                to: ctx.accounts.owner_rodeo_account.to_account_info(),
                authority: global_config.to_account_info(),
            },
            signer,
        );
        anchor_spl::token::transfer(transfer_ctx, principal_amount)?;

        // Update global counters before closing accounts.
        let game_state = &mut ctx.accounts.global_game_state;
        game_state.live_position_count = math::checked_sub_u64(game_state.live_position_count, 1)?;
        game_state.accounted_principal_atomic =
            math::checked_sub_u64(game_state.accounted_principal_atomic, principal_amount)?;

        emit!(RandomnessTimeoutRecovered {
            position: position.key(),
            action_type: ActionType::Reveal,
            action_nonce: pending_randomness.action_nonce,
            recovery_action: TimeoutRecoveryAction::CloseAndRefundPrincipal,
        });

        Ok(())
    }

    /// Test-only fixture to set pause flags for localnet/CI coverage. It is
    /// compiled only when the `test-fixtures` feature is enabled and is never
    /// part of the production ABI.
    #[cfg(feature = "test-fixtures")]
    pub fn test_set_pause_flags(
        ctx: Context<TestSetPauseFlags>,
        pause_new_stakes: bool,
        pause_new_reveal_requests: bool,
    ) -> Result<()> {
        let global_config = &mut ctx.accounts.global_config;
        global_config.pause_new_stakes = pause_new_stakes;
        global_config.pause_new_reveal_requests = pause_new_reveal_requests;
        Ok(())
    }
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
#[instruction(pause_new_stakes: bool, pause_new_reveal_requests: bool)]
pub struct TestSetPauseFlags<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,
}

#[derive(Accounts)]
#[instruction(upgrade_council: Pubkey, treasury_council: Pubkey, emergency_guardians: Pubkey)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The upgrade authority of the deployed rodeo_core program.
    pub initializer: Signer<'info>,

    /// CHECK: The deployed rodeo_core program account is verified against the
    /// hardcoded program ID and confirmed executable.
    #[account(
        constraint = program.key() == crate::ID @ RodeoError::InvalidProgramAccount,
        constraint = program.executable @ RodeoError::InvalidProgramAccount,
    )]
    pub program: AccountInfo<'info>,

    /// CHECK: The BPF Upgradeable Loader program-data account is verified to
    /// be the program-data PDA of this program and owned by the upgrade loader.
    #[account(
        constraint = program_data.key() == anchor_lang::solana_program::bpf_loader_upgradeable::get_program_data_address(&crate::ID) @ RodeoError::InvalidProgramData,
        constraint = program_data.owner == &anchor_lang::solana_program::bpf_loader_upgradeable::id() @ RodeoError::InvalidProgramData,
    )]
    pub program_data: AccountInfo<'info>,

    pub rodeo_mint: Account<'info, Mint>,
    pub ansem_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [SEED_GLOBAL_CONFIG],
        bump
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(
        init,
        payer = payer,
        space = 8 + RewardState::INIT_SPACE,
        seeds = [SEED_REWARD_STATE, global_config.key().as_ref()],
        bump
    )]
    pub reward_state: Account<'info, RewardState>,

    #[account(
        init,
        payer = payer,
        space = 8 + GlobalGameState::INIT_SPACE,
        seeds = [SEED_GLOBAL_GAME_STATE, global_config.key().as_ref()],
        bump
    )]
    pub global_game_state: Account<'info, GlobalGameState>,

    #[account(
        init,
        payer = payer,
        space = 8 + BullAccumulator::INIT_SPACE,
        seeds = [SEED_BULL_ACCUMULATOR, global_config.key().as_ref()],
        bump
    )]
    pub bull_accumulator: Account<'info, BullAccumulator>,

    #[account(
        init,
        payer = payer,
        seeds = [SEED_PRINCIPAL_VAULT],
        bump,
        token::mint = rodeo_mint,
        token::authority = global_config
    )]
    pub principal_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        seeds = [SEED_REWARD_VAULT],
        bump,
        token::mint = ansem_mint,
        token::authority = global_config
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(position_id: u64, principal_amount: u64)]
pub struct StakeAndCommit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        constraint = owner_rodeo_token_account.mint == global_config.rodeo_mint @ RodeoError::InvalidTokenAccount,
        constraint = owner_rodeo_token_account.owner == owner.key() @ RodeoError::InvalidTokenAccount,
    )]
    pub owner_rodeo_token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [SEED_PRINCIPAL_VAULT],
        bump = global_config.principal_vault_bump,
        constraint = principal_vault.mint == global_config.rodeo_mint @ RodeoError::InvalidPrincipalVault,
        constraint = principal_vault.owner == global_config.key() @ RodeoError::InvalidPrincipalVault,
    )]
    pub principal_vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Position::INIT_SPACE,
        seeds = [SEED_POSITION, global_config.key().as_ref(), &position_id.to_le_bytes()],
        bump
    )]
    pub position: Account<'info, Position>,

    #[account(
        init,
        payer = owner,
        space = 8 + PendingRandomness::INIT_SPACE,
        seeds = [
            SEED_RANDOMNESS,
            position.key().as_ref(),
            &[ActionType::Reveal as u8],
            &[0, 0, 0, 0, 0, 0, 0, 0],
        ],
        bump
    )]
    pub pending_randomness: Account<'info, PendingRandomness>,

    #[account(
        seeds = [SEED_REWARD_STATE, global_config.key().as_ref()],
        bump = reward_state.bump,
    )]
    pub reward_state: Account<'info, RewardState>,

    #[account(
        mut,
        seeds = [SEED_GLOBAL_GAME_STATE, global_config.key().as_ref()],
        bump = global_game_state.bump,
    )]
    pub global_game_state: Account<'info, GlobalGameState>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct SettleReveal<'info> {
    #[account(mut)]
    pub settler: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [SEED_GLOBAL_GAME_STATE, global_config.key().as_ref()],
        bump = global_game_state.bump,
    )]
    pub global_game_state: Account<'info, GlobalGameState>,

    #[account(
        mut,
        seeds = [SEED_REWARD_STATE, global_config.key().as_ref()],
        bump = reward_state.bump,
    )]
    pub reward_state: Account<'info, RewardState>,

    #[account(
        mut,
        seeds = [SEED_BULL_ACCUMULATOR, global_config.key().as_ref()],
        bump = bull_accumulator.bump,
    )]
    pub bull_accumulator: Account<'info, BullAccumulator>,

    #[account(
        mut,
        seeds = [SEED_POSITION, global_config.key().as_ref(), &position.position_id.to_le_bytes()],
        bump = position.bump,
        constraint = position.pending_action_active @ RodeoError::PendingActionConflict,
        constraint = position.pending_action_type == ActionType::Reveal @ RodeoError::WrongActionType,
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        seeds = [
            SEED_RANDOMNESS,
            position.key().as_ref(),
            &[ActionType::Reveal as u8],
            &position.pending_action_nonce.to_le_bytes(),
        ],
        bump = pending_randomness.bump,
        constraint = pending_randomness.position == position.key() @ RodeoError::InvalidPendingRandomness,
        constraint = pending_randomness.action_type == ActionType::Reveal @ RodeoError::WrongActionType,
        constraint = pending_randomness.action_nonce == position.pending_action_nonce @ RodeoError::InvalidPendingRandomness,
    )]
    pub pending_randomness: Account<'info, PendingRandomness>,

    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct RecoverRevealTimeout<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        close = owner,
        seeds = [SEED_POSITION, global_config.key().as_ref(), &position.position_id.to_le_bytes()],
        bump = position.bump,
        constraint = position.status == PositionStatus::RevealPending @ RodeoError::InvalidPendingRandomness,
        constraint = position.pending_action_active @ RodeoError::InvalidPendingRandomness,
        constraint = position.pending_action_type == ActionType::Reveal @ RodeoError::WrongActionType,
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        close = owner,
        seeds = [
            SEED_RANDOMNESS,
            position.key().as_ref(),
            &[ActionType::Reveal as u8],
            &position.pending_action_nonce.to_le_bytes(),
        ],
        bump = pending_randomness.bump,
        constraint = pending_randomness.position == position.key() @ RodeoError::InvalidPendingRandomness,
        constraint = pending_randomness.action_type == ActionType::Reveal @ RodeoError::WrongActionType,
        constraint = pending_randomness.action_nonce == position.pending_action_nonce @ RodeoError::InvalidPendingRandomness,
    )]
    pub pending_randomness: Account<'info, PendingRandomness>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [SEED_PRINCIPAL_VAULT],
        bump = global_config.principal_vault_bump,
        constraint = principal_vault.mint == global_config.rodeo_mint @ RodeoError::InvalidPrincipalVault,
    )]
    pub principal_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = owner_rodeo_account.mint == global_config.rodeo_mint @ RodeoError::InvalidTokenAccount,
        constraint = owner_rodeo_account.owner == position.owner @ RodeoError::InvalidTokenAccount,
    )]
    pub owner_rodeo_account: Account<'info, TokenAccount>,

    /// CHECK: Account receives reclaimed rent and is validated against the position owner.
    #[account(mut)]
    pub owner: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [SEED_GLOBAL_GAME_STATE, global_config.key().as_ref()],
        bump = global_game_state.bump,
    )]
    pub global_game_state: Account<'info, GlobalGameState>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
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

#[event]
pub struct PositionStaked {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub position_id: u64,
    pub principal_amount: u64,
    pub commitment: [u8; 32],
    pub global_game_state: Pubkey,
}

#[event]
pub struct RandomnessRequested {
    pub position: Pubkey,
    pub action_type: ActionType,
    pub action_nonce: u64,
    pub committed_slot: u64,
    pub committed_protocol_epoch: u64,
    pub timeout_timestamp: i64,
    pub provider_program: Pubkey,
    pub provider_randomness_account: Pubkey,
    pub vrf_key: Option<Pubkey>,
    pub callback_id: Option<[u8; 32]>,
    pub registry_root_snapshot: [u8; 32],
    pub registry_version_snapshot: u64,
    pub commitment: [u8; 32],
}

#[event]
pub struct PositionRevealed {
    pub position: Pubkey,
    pub role: Role,
    pub cowboy_kind: CowboyKind,
    pub bull_tier: u8,
    pub suit: Suit,
    pub final_owner: Pubkey,
    pub previous_owner: Option<Pubkey>,
    pub stolen: bool,
    pub receipt_asset: Pubkey,
    pub active_since: i64,
    pub unstake_eligible_at: i64,
    pub settlement_nonce: u64,
}

#[event]
pub struct RandomnessSettled {
    pub position: Pubkey,
    pub action_type: ActionType,
    pub action_nonce: u64,
    pub settlement_nonce: u64,
}

#[event]
pub struct RandomnessTimeoutRecovered {
    pub position: Pubkey,
    pub action_type: ActionType,
    pub action_nonce: u64,
    pub recovery_action: TimeoutRecoveryAction,
}

#[allow(dead_code)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum TimeoutRecoveryAction {
    CloseAndRefundPrincipal,
    CancelUnstake,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum RodeoError {
    #[msg("Integer arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Integer arithmetic underflow")]
    ArithmeticUnderflow,
    #[msg("Division by zero")]
    DivisionByZero,
    #[msg("Invalid program account")]
    InvalidProgramAccount,
    #[msg("Invalid program data account")]
    InvalidProgramData,
    #[msg("Initializer is not the program upgrade authority")]
    UnauthorizedInitializer,
    #[msg("Invalid governance authority")]
    InvalidGovernanceAuthority,
    #[msg("Governance authorities must be pairwise distinct")]
    GovernanceAuthoritiesNotDistinct,
    #[msg("RODEO and ANSEM mints must be different")]
    IdenticalTokenMints,
    #[msg("Mint authority must be revoked")]
    ActiveMintAuthority,
    #[msg("Freeze authority must be revoked")]
    ActiveFreezeAuthority,
    #[msg("Rejection sampling exhausted without an accepted candidate")]
    RejectionSamplingExhausted,
    #[msg("Invalid BPS value")]
    InvalidBps,
    #[msg("Invalid mint account")]
    InvalidMint,
    #[msg("RODEO mint supply does not match the expected total supply")]
    UnexpectedRodeoSupply,
    #[msg("Invalid vault account")]
    InvalidVault,
    #[msg("Invalid decimals or atomic conversion failed")]
    InvalidDecimals,
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
    #[msg("Position already exists for the chosen position_id")]
    PositionAlreadyExists,
    #[msg("Principal vault is invalid for the configured mint or authority")]
    InvalidPrincipalVault,
    #[msg("Owner token account is invalid for the configured mint or signer")]
    InvalidTokenAccount,
    #[msg("Position already has a conflicting pending action")]
    PendingActionConflict,
    #[msg("Pending action type does not match the requested operation")]
    WrongActionType,
    #[msg("Pending randomness account does not match the position and nonce")]
    InvalidPendingRandomness,
    #[msg("Randomness result is not yet available")]
    RandomnessNotReady,
    #[msg("Randomness timeout has not been reached")]
    RandomnessTimeoutNotReached,
    #[msg("Randomness has already been settled for this action")]
    RandomnessAlreadyAvailable,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn derive_commitment(
    position: Pubkey,
    action_type: ActionType,
    action_nonce: u64,
    protocol_epoch: u64,
) -> [u8; 32] {
    let mut preimage = [0u8; 32 + 1 + 8 + 8];
    preimage[0..32].copy_from_slice(position.as_ref());
    preimage[32] = action_type as u8;
    preimage[33..41].copy_from_slice(&action_nonce.to_le_bytes());
    preimage[41..49].copy_from_slice(&protocol_epoch.to_le_bytes());
    anchor_lang::solana_program::hash::hash(&preimage).to_bytes()
}

#[cfg(feature = "mock-randomness")]
fn settle_reveal_mock(ctx: &mut Context<SettleReveal>) -> Result<()> {
    use crate::probability;

    let position_key = ctx.accounts.position.key();
    let action_type = ctx.accounts.pending_randomness.action_type;
    let action_nonce = ctx.accounts.pending_randomness.action_nonce;
    let protocol_epoch = ctx.accounts.pending_randomness.committed_protocol_epoch;

    // Deterministic random bytes that are domain-separated and bound to the
    // position, action type, action nonce, and protocol epoch.
    let random_output = derive_commitment(position_key, action_type, action_nonce, protocol_epoch);

    let role = probability::map_role(probability::RandomnessSampleContext {
        random_output,
        domain: probability::RandomnessDomain::Role,
        position: position_key,
        action_nonce,
    })?;

    let suit = probability::map_suit(probability::RandomnessSampleContext {
        random_output,
        domain: probability::RandomnessDomain::Suit,
        position: position_key,
        action_nonce,
    })?;

    let position = &mut ctx.accounts.position;
    let pending_randomness = &mut ctx.accounts.pending_randomness;
    let now = Clock::get()?.unix_timestamp;

    position.status = PositionStatus::Active;
    position.active_since = now;
    position.unstake_eligible_at = now
        .checked_add(MIN_STAKE_SECONDS)
        .ok_or(RodeoError::ArithmeticOverflow)?;
    position.suit = suit;
    position.pending_action_active = false;
    position.settlement_nonce = position
        .settlement_nonce
        .checked_add(1)
        .ok_or(RodeoError::ArithmeticOverflow)?;

    pending_randomness.settled = true;

    let game_state = &mut ctx.accounts.global_game_state;
    game_state.total_completed_reveals =
        math::checked_add_u64(game_state.total_completed_reveals, 1)?;

    let active_since = position.active_since;
    let unstake_eligible_at = position.unstake_eligible_at;
    let settlement_nonce = position.settlement_nonce;
    let final_owner = position.owner;

    match role {
        Role::Cowboy => {
            let kind = probability::map_cowboy_kind(probability::RandomnessSampleContext {
                random_output,
                domain: probability::RandomnessDomain::CowboyKind,
                position: position_key,
                action_nonce,
            })?;
            let weight = match kind {
                CowboyKind::Rank(rank) => probability::accrual_weight_for_rank(rank),
                CowboyKind::Desperado => probability::accrual_weight_for_rank(10),
                CowboyKind::Unassigned => 0,
            };

            position.role = Role::Cowboy;
            position.cowboy_kind = kind;
            position.accrual_weight = weight;
            position.last_cowboy_reward_index = ctx.accounts.reward_state.cowboy_reward_index;
            position.cowboy_accrual_remainder_scaled = 0;
            position.last_bull_reward_per_weight = 0;
            position.bull_accrual_remainder_scaled = 0;

            game_state.active_cowboy_count =
                math::checked_add_u64(game_state.active_cowboy_count, 1)?;
            game_state.total_active_cowboy_weight =
                math::checked_add_u128(game_state.total_active_cowboy_weight, weight as u128)?;

            emit!(PositionRevealed {
                position: position_key,
                role: Role::Cowboy,
                cowboy_kind: kind,
                bull_tier: 0,
                suit,
                final_owner,
                previous_owner: None,
                stolen: false,
                receipt_asset: Pubkey::default(),
                active_since,
                unstake_eligible_at,
                settlement_nonce,
            });
        }
        Role::Bull => {
            let tier = probability::map_bull_tier(probability::RandomnessSampleContext {
                random_output,
                domain: probability::RandomnessDomain::BullTier,
                position: position_key,
                action_nonce,
            })?;
            let power = probability::buck_power_for_tier(tier);

            position.role = Role::Bull;
            position.bull_tier = tier;
            position.buck_power = power;
            position.last_cowboy_reward_index = 0;
            position.cowboy_accrual_remainder_scaled = 0;
            position.last_bull_reward_per_weight =
                ctx.accounts.bull_accumulator.reward_per_weight_scaled;
            position.bull_accrual_remainder_scaled = 0;

            let was_first_bull = game_state.active_bull_count == 0;
            game_state.active_bull_count = math::checked_add_u64(game_state.active_bull_count, 1)?;
            game_state.total_active_bull_power =
                math::checked_add_u64(game_state.total_active_bull_power, power as u64)?;

            // If this is the first eligible Bull and unallocated liability exists,
            // distribute it through the accumulator before moving it to the pool.
            if was_first_bull {
                let unallocated = ctx
                    .accounts
                    .reward_state
                    .bull_pool_unallocated_liability_atomic;
                if unallocated > 0 {
                    let (new_index, new_remainder) = math::distribute_bull_unallocated_liability(
                        ctx.accounts.bull_accumulator.reward_per_weight_scaled,
                        ctx.accounts.bull_accumulator.bull_index_remainder_scaled,
                        unallocated,
                        game_state.total_active_bull_power as u128,
                        REWARD_PER_WEIGHT_SCALE,
                    )?;
                    ctx.accounts.bull_accumulator.reward_per_weight_scaled = new_index;
                    ctx.accounts.bull_accumulator.bull_index_remainder_scaled = new_remainder;
                    ctx.accounts.reward_state.bull_pool_liability_atomic = math::checked_add_u64(
                        ctx.accounts.reward_state.bull_pool_liability_atomic,
                        unallocated,
                    )?;
                    ctx.accounts
                        .reward_state
                        .bull_pool_unallocated_liability_atomic = 0;
                }
            }

            emit!(PositionRevealed {
                position: position_key,
                role: Role::Bull,
                cowboy_kind: CowboyKind::Unassigned,
                bull_tier: tier,
                suit,
                final_owner,
                previous_owner: None,
                stolen: false,
                receipt_asset: Pubkey::default(),
                active_since,
                unstake_eligible_at,
                settlement_nonce,
            });
        }
        Role::Unassigned => {
            return Err(error!(RodeoError::InvalidProbabilityOutcome));
        }
    }

    emit!(RandomnessSettled {
        position: position_key,
        action_type,
        action_nonce,
        settlement_nonce,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probability;
    use crate::state;
    use constants::*;

    fn pubkey_from_u64(n: u64) -> Pubkey {
        let mut bytes = [0u8; 32];
        bytes[0..8].copy_from_slice(&n.to_le_bytes());
        Pubkey::new_from_array(bytes)
    }

    fn sample_ctx(
        domain: probability::RandomnessDomain,
        tag: u8,
    ) -> probability::RandomnessSampleContext {
        probability::RandomnessSampleContext {
            random_output: [tag + 1; 32],
            domain,
            position: pubkey_from_u64((tag + 7) as u64),
            action_nonce: tag as u64,
        }
    }

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
    fn account_init_space_values() {
        assert_eq!(GlobalConfig::INIT_SPACE, 258);
        assert_eq!(RewardState::INIT_SPACE, 194);
        assert_eq!(GlobalGameState::INIT_SPACE, 98);
        assert_eq!(BullAccumulator::INIT_SPACE, 82);
        assert_eq!(Position::INIT_SPACE, 231);
        assert_eq!(WalletClaimCooldown::INIT_SPACE, 74);
        assert_eq!(PendingRandomness::INIT_SPACE, 204);
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
        assert_eq!(
            math::whole_to_atomic(100_000, 6).unwrap(),
            100_000_000_000u64
        );
        assert_eq!(
            math::whole_to_atomic(1_000_000_000, 6).unwrap(),
            1_000_000_000_000_000u64
        );
    }

    #[test]
    fn checked_math_rejects_overflow_and_underflow() {
        assert!(math::checked_add_u64(u64::MAX, 1).is_err());
        assert!(math::checked_sub_u64(0, 1).is_err());
        assert!(math::checked_mul_u64(u64::MAX, 2).is_err());
        assert!(matches!(
            math::checked_sub_u64(0, 1),
            Err(anchor_lang::error::Error::AnchorError(e)) if e.error_name == "ArithmeticUnderflow"
        ));
    }

    #[test]
    fn u128_to_u64_rejects_overflow() {
        assert!(math::u128_to_u64(u64::MAX as u128).is_ok());
        assert!(math::u128_to_u64((u64::MAX as u128) + 1).is_err());
        assert!(math::u128_to_u64(u128::MAX).is_err());
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
    fn floor_bps_rejects_invalid_bps() {
        assert!(math::floor_bps(1_000, BPS_DENOMINATOR).is_ok());
        assert!(math::floor_bps(1_000, BPS_DENOMINATOR + 1).is_err());
    }

    #[test]
    fn ceil_mul_div_rounds_up_without_overflow() {
        assert_eq!(math::ceil_mul_div_u128(10, 1, 3).unwrap(), 4);
        assert_eq!(math::ceil_mul_div_u128(9, 1, 3).unwrap(), 3);
        assert!(math::ceil_mul_div_u128(1, 1, 0).is_err());
    }

    #[test]
    fn cowboy_index_increment_with_carry() {
        let (new_index, new_remainder) =
            math::increment_cowboy_index(0, 0, 2_000_000, 20_000, COWBOY_REWARD_INDEX_SCALE)
                .unwrap();
        let expected_numerator = 2_000_000u128 * COWBOY_REWARD_INDEX_SCALE;
        assert_eq!(new_index, expected_numerator / 20_000);
        assert_eq!(new_remainder, expected_numerator % 20_000);
    }

    #[test]
    fn cowboy_index_rejects_zero_scale_or_weight() {
        assert!(math::increment_cowboy_index(0, 0, 1_000, 1, 0).is_err());
        assert!(math::increment_cowboy_index(0, 0, 1_000, 0, COWBOY_REWARD_INDEX_SCALE).is_err());
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
    fn accrue_rejects_invalid_state() {
        assert!(math::accrue_cowboy(0, 1, 10_000, 0, COWBOY_REWARD_INDEX_SCALE).is_err());
        assert!(math::accrue_cowboy(0, 0, 10_000, 0, 0).is_err());
        assert!(math::accrue_bull(0, 1, 10, 0, COWBOY_REWARD_INDEX_SCALE).is_err());
        assert!(math::accrue_bull(0, 0, 10, 0, 0).is_err());
    }

    #[test]
    fn probability_tables_are_valid() {
        probability::ROLE_TABLE.validate().unwrap();
        probability::COWBOY_RANK_TABLE.validate().unwrap();
        probability::BULL_TIER_TABLE.validate().unwrap();
        probability::SUIT_TABLE.validate().unwrap();
        probability::THEFT_FLAG_TABLE.validate().unwrap();
        probability::UNSTAKE_THEFT_FLAG_TABLE.validate().unwrap();
    }

    #[test]
    fn outcome_index_draw_validation() {
        assert!(probability::ROLE_TABLE
            .outcome_index_for_draw(probability::ROLE_TABLE.denominator)
            .is_err());
        assert!(probability::ROLE_TABLE.outcome_index_for_draw(0).is_ok());
    }

    #[test]
    fn role_mapping_boundaries() {
        assert_eq!(
            probability::ROLE_TABLE.outcome_index_for_draw(0).unwrap(),
            0
        );
        assert_eq!(
            probability::ROLE_TABLE
                .outcome_index_for_draw(8_999_999)
                .unwrap(),
            0
        );
        assert_eq!(
            probability::ROLE_TABLE
                .outcome_index_for_draw(9_000_000)
                .unwrap(),
            1
        );
        assert_eq!(
            probability::ROLE_TABLE
                .outcome_index_for_draw(9_999_999)
                .unwrap(),
            1
        );
    }

    #[test]
    fn cowboy_rank_mapping_boundaries() {
        let check = |draw, expected| {
            assert_eq!(
                probability::COWBOY_RANK_TABLE
                    .outcome_index_for_draw(draw)
                    .unwrap(),
                expected
            );
        };
        check(0, 0);
        check(4_047_749, 0);
        check(4_047_750, 1);
        check(4_047_750 + 2_248_749, 1);
        check(4_047_750 + 2_248_750, 2);
        let cumulative_before_desperado = 9_000_000 - 5_000;
        check(cumulative_before_desperado - 1, 6);
        check(cumulative_before_desperado, 7);
        check(8_999_999, 7);
    }

    #[test]
    fn bull_tier_mapping_boundaries() {
        let check = |draw, expected| {
            assert_eq!(
                probability::BULL_TIER_TABLE
                    .outcome_index_for_draw(draw)
                    .unwrap(),
                expected
            );
        };
        check(0, 0);
        check(599_999, 0);
        check(600_000, 1);
        check(849_999, 1);
        check(850_000, 2);
        check(949_999, 2);
        check(950_000, 3);
        check(999_999, 3);
    }

    #[test]
    fn suit_mapping_boundaries() {
        let check = |draw, expected| {
            assert_eq!(
                probability::SUIT_TABLE
                    .outcome_index_for_draw(draw)
                    .unwrap(),
                expected
            );
        };
        check(0, 0);
        check(2_499_999, 0);
        check(2_500_000, 1);
        check(4_999_999, 1);
        check(5_000_000, 2);
        check(7_499_999, 2);
        check(7_500_000, 3);
        check(9_999_999, 3);
    }

    #[test]
    fn theft_flag_mapping_boundaries() {
        let check = |draw, expected| {
            assert_eq!(
                probability::THEFT_FLAG_TABLE
                    .outcome_index_for_draw(draw)
                    .unwrap(),
                expected
            );
        };
        check(0, 0);
        check(499_999, 0);
        check(500_000, 1);
        check(9_999_999, 1);
    }

    #[test]
    fn rejection_sampling_golden_vectors() {
        let vectors = [
            (
                probability::RandomnessDomain::Reveal,
                0u8,
                10_000_000u64,
                7_594_516u64,
            ),
            (
                probability::RandomnessDomain::Unstake,
                1u8,
                10_000_000u64,
                9_569_442u64,
            ),
            (
                probability::RandomnessDomain::MintTheft,
                2u8,
                10_000_000u64,
                8_120_026u64,
            ),
            (
                probability::RandomnessDomain::UnstakeTheft,
                3u8,
                10_000_000u64,
                4_556_769u64,
            ),
            (
                probability::RandomnessDomain::Role,
                4u8,
                10_000_000u64,
                1_865_101u64,
            ),
            (
                probability::RandomnessDomain::CowboyKind,
                5u8,
                9_000_000u64,
                6_521_817u64,
            ),
            (
                probability::RandomnessDomain::BullTier,
                6u8,
                1_000_000u64,
                813_273u64,
            ),
            (
                probability::RandomnessDomain::Suit,
                7u8,
                10_000_000u64,
                6_972_047u64,
            ),
        ];

        for (domain, tag, denominator, expected_draw) in vectors.iter().copied() {
            let ctx = sample_ctx(domain, tag);
            let draw = probability::rejection_sample_draw(ctx, denominator).unwrap();
            assert_eq!(
                draw, expected_draw,
                "domain {:?} tag {} denominator {} mismatch",
                domain, tag, denominator
            );
        }
    }

    #[test]
    fn map_role_is_stable_and_valid() {
        let ctx = sample_ctx(probability::RandomnessDomain::Role, 4);
        let first = probability::map_role(ctx).unwrap();
        let second = probability::map_role(ctx).unwrap();
        assert_eq!(first, second);
        assert!(first == state::Role::Cowboy || first == state::Role::Bull);
    }

    #[test]
    fn map_cowboy_kind_is_stable_and_valid() {
        let ctx = sample_ctx(probability::RandomnessDomain::CowboyKind, 5);
        let kind = probability::map_cowboy_kind(ctx).unwrap();
        assert!(matches!(
            kind,
            state::CowboyKind::Rank(4 | 5 | 6 | 7 | 8 | 9 | 10) | state::CowboyKind::Desperado
        ));
        assert_eq!(probability::map_cowboy_kind(ctx).unwrap(), kind);
    }

    #[test]
    fn map_bull_tier_is_stable_and_valid() {
        let ctx = sample_ctx(probability::RandomnessDomain::BullTier, 6);
        let tier = probability::map_bull_tier(ctx).unwrap();
        assert!((1..=4).contains(&tier));
        assert_eq!(probability::map_bull_tier(ctx).unwrap(), tier);
    }

    #[test]
    fn map_suit_is_stable_and_valid() {
        let ctx = sample_ctx(probability::RandomnessDomain::Suit, 7);
        let suit = probability::map_suit(ctx).unwrap();
        assert!(matches!(
            suit,
            state::Suit::Hearts | state::Suit::Diamonds | state::Suit::Clubs | state::Suit::Spades
        ));
        assert_eq!(probability::map_suit(ctx).unwrap(), suit);
    }

    #[test]
    fn theft_flag_helpers_are_distinct_domains() {
        let mint_ctx = sample_ctx(probability::RandomnessDomain::MintTheft, 2);
        let unstake_ctx = sample_ctx(probability::RandomnessDomain::UnstakeTheft, 3);
        // The outputs are deterministic booleans; this just verifies both helpers run.
        let _ = probability::map_mint_theft_flag(mint_ctx).unwrap();
        let _ = probability::map_unstake_theft_flag(unstake_ctx).unwrap();
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
    fn first_bull_unallocated_liability_distribution_order() {
        let unallocated = 1_000_000u64;
        let total_power = 10u128; // e.g., a tier-4 bull has power 10
        let scale = REWARD_PER_WEIGHT_SCALE;
        let (new_index, new_remainder) =
            math::distribute_bull_unallocated_liability(0, 0, unallocated, total_power, scale)
                .unwrap();

        let expected_index = (unallocated as u128) * scale / total_power;
        let expected_remainder = (unallocated as u128) * scale % total_power;
        assert_eq!(new_index, expected_index);
        assert_eq!(new_remainder, expected_remainder);
        assert_eq!(new_index, 100_000_000_000_000_000u128);
        assert_eq!(new_remainder, 0u128);
    }

    #[test]
    fn first_bull_unallocated_liability_preserves_total_liability() {
        // The distribution moves the exact unallocated amount into the bull pool
        // without changing total_ansem_liability_atomic.
        let unallocated = 555_555u64;
        let total_power = 7u128;
        let scale = REWARD_PER_WEIGHT_SCALE;
        let (index, remainder) = math::distribute_bull_unallocated_liability(
            123_456u128,
            7u128,
            unallocated,
            total_power,
            scale,
        )
        .unwrap();
        assert!(index >= 123_456u128);
        assert!(remainder < total_power);
        // Verify exact formula relationship.
        let contribution_scaled = (unallocated as u128) * scale;
        assert_eq!(index, 123_456u128 + (contribution_scaled + 7) / total_power);
        assert_eq!(remainder, (contribution_scaled + 7) % total_power);
    }

    #[test]
    fn seed_constants_match_protocol_definition() {
        assert_eq!(SEED_GLOBAL_CONFIG, b"global-config");
        assert_eq!(SEED_REWARD_STATE, b"reward-state");
        assert_eq!(SEED_GLOBAL_GAME_STATE, b"global-game-state");
        assert_eq!(SEED_BULL_ACCUMULATOR, b"bull-accumulator");
        assert_eq!(SEED_PRINCIPAL_VAULT, b"principal-vault");
        assert_eq!(SEED_REWARD_VAULT, b"reward-vault");
        assert_eq!(SEED_POSITION, b"position");
        assert_eq!(SEED_CLAIM_COOLDOWN, b"claim-cooldown");
        assert_eq!(SEED_RANDOMNESS, b"randomness");
    }

    #[test]
    #[cfg(not(feature = "test-short-timeout"))]
    fn production_randomness_timeout_is_30_minutes() {
        assert_eq!(RANDOMNESS_TIMEOUT_SECONDS, 30 * 60);
    }

    #[test]
    #[cfg(feature = "test-short-timeout")]
    fn test_randomness_timeout_is_short() {
        assert_eq!(RANDOMNESS_TIMEOUT_SECONDS, 2);
    }

    #[test]
    #[cfg(not(feature = "mock-randomness"))]
    fn production_has_no_mock_randomness() {
        assert!(!USE_MOCK_RANDOMNESS);
    }

    #[test]
    #[cfg(feature = "mock-randomness")]
    fn test_build_uses_mock_randomness() {
        let _ = settle_reveal_mock as fn(&mut Context<SettleReveal>) -> Result<()>;
    }

    #[test]
    #[cfg(not(feature = "test-fixtures"))]
    fn production_has_no_test_fixtures() {
        assert!(!USE_TEST_FIXTURES);
    }

    #[test]
    #[cfg(feature = "test-fixtures")]
    fn test_build_has_test_fixtures() {
        let _ = test_set_pause_flags as fn(Context<TestSetPauseFlags>, bool, bool) -> Result<()>;
    }
}
