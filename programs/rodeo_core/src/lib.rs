use anchor_lang::prelude::*;
use anchor_spl::token::{Burn, Mint, Token, TokenAccount, Transfer};

declare_id!("EkEPd5wXSi3NQUHewx64cP27tDQ6uTcK5poG6AuWmy8Z");

pub mod bull_registry;
pub mod constants;
pub mod math;
pub mod probability;
pub mod receipt;
pub mod sparse_tree;
pub mod state;

use bull_registry::*;
use constants::*;
use mpl_core::instructions::{
    BurnV1Builder, CreateCollectionV2Builder, CreateV2Builder, TransferV1Builder, UpdateV1Builder,
};
use mpl_core::types::{DataState, Plugin, PluginAuthority, PluginAuthorityPair, PluginType};
use receipt::*;
use state::*;

#[cfg(not(feature = "mock-randomness"))]
use switchboard_on_demand::accounts::RandomnessAccountData;

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
        global_config.current_config_version = 1;
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
        global_game_state.next_position_id = 0;
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

        let protocol_config = &mut ctx.accounts.protocol_config;
        let mut v1_config =
            probability::protocol_config_v1(global_config.key(), ctx.bumps.protocol_config);
        v1_config.config_version = 1;
        probability::validate_protocol_config(&v1_config)?;
        protocol_config.set_inner(v1_config);

        let bull_registry = &mut ctx.accounts.bull_registry;
        bull_registry.version = ACCOUNT_VERSION_BULL_REGISTRY;
        bull_registry.global_config = global_config.key();
        bull_registry.owner_tree_root = bull_registry::empty_owner_tree_root();
        bull_registry.total_bull_count = 0;
        bull_registry.total_buck_power = 0;
        bull_registry.registry_version = 0;
        bull_registry.bump = ctx.bumps.bull_registry;

        // Create the official Rodeo PositionReceipt Collection. This is a
        // one-time action paid for by the initializer and uses the stateless
        // ReceiptAuthority PDA as the update authority.
        let global_config_key = global_config.key();
        let (receipt_authority, receipt_authority_bump) = receipt_authority_pda(&global_config_key);
        let (collection, _collection_bump) = receipt_collection_pda(&global_config_key);

        require_keys_eq!(
            ctx.accounts.receipt_authority.key(),
            receipt_authority,
            RodeoError::InvalidCoreAssetOwner
        );
        require_keys_eq!(
            ctx.accounts.receipt_collection.key(),
            collection,
            RodeoError::InvalidCoreAssetOwner
        );

        let collection_ix = CreateCollectionV2Builder::new()
            .collection(collection)
            .update_authority(Some(receipt_authority))
            .payer(ctx.accounts.payer.key())
            .system_program(solana_program::system_program::ID)
            .name(RECEIPT_COLLECTION_NAME.to_string())
            .uri(RECEIPT_COLLECTION_URI.to_string())
            .instruction();

        let account_infos = [
            ctx.accounts.receipt_collection.to_account_info(),
            ctx.accounts.receipt_authority.to_account_info(),
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ];
        let authority_seeds = [
            SEED_RECEIPT_AUTHORITY,
            global_config_key.as_ref(),
            &[receipt_authority_bump],
        ];
        let collection_seeds = [
            SEED_RECEIPT_COLLECTION,
            global_config_key.as_ref(),
            &[ctx.bumps.receipt_collection],
        ];

        solana_program::program::invoke_signed(
            &collection_ix,
            &account_infos,
            &[&collection_seeds, &authority_seeds],
        )
        .map_err(|e: ProgramError| Into::<Error>::into(e))?;

        emit!(ProtocolInitialized {
            global_config: global_config.key(),
            reward_state: reward_state.key(),
            global_game_state: global_game_state.key(),
            bull_accumulator: bull_accumulator.key(),
            bull_registry: bull_registry.key(),
            protocol_config: protocol_config.key(),
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
            current_config_version: 1,
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
        require_eq!(
            position_id,
            ctx.accounts.global_game_state.next_position_id,
            RodeoError::InvalidPositionId
        );

        #[cfg(feature = "mock-randomness")]
        let (provider_program, provider_randomness_account, commitment, committed_slot) = {
            let commitment = derive_commitment(
                ctx.accounts.position.key(),
                ActionType::Reveal,
                action_nonce,
                ctx.accounts.reward_state.current_epoch,
            );
            (Pubkey::default(), Pubkey::default(), commitment, clock.slot)
        };

        #[cfg(not(feature = "mock-randomness"))]
        let (provider_program, provider_randomness_account, commitment, committed_slot) = {
            let randomness_account = ctx
                .accounts
                .provider_randomness_account
                .as_ref()
                .ok_or(RodeoError::InvalidProviderAccount)?;
            require!(
                randomness_account.owner == &switchboard_on_demand::ON_DEMAND_MAINNET_PID
                    || randomness_account.owner == &switchboard_on_demand::ON_DEMAND_DEVNET_PID,
                RodeoError::InvalidProviderAccount
            );
            let randomness_data = RandomnessAccountData::parse(randomness_account.data.borrow())
                .map_err(|_| RodeoError::InvalidProviderAccount)?;
            require!(
                randomness_data.get_value(clock.slot).is_err(),
                RodeoError::RandomnessNotResolved
            );
            (
                *randomness_account.owner,
                randomness_account.key(),
                randomness_data.seed_slothash,
                randomness_data.seed_slot,
            )
        };

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

        // Create and prefund the System-Program-owned ReceiptFunder PDA.
        // The player supplies the SOL; Rodeo signs for the PDA address.
        let position_key = position.key();
        let (receipt_funder, receipt_funder_bump) = receipt_funder_pda(&position_key);
        require_keys_eq!(
            ctx.accounts.receipt_funder.key(),
            receipt_funder,
            RodeoError::InvalidCoreAssetOwner
        );

        let funder_create_ix = solana_program::system_instruction::create_account(
            ctx.accounts.owner.key,
            &receipt_funder,
            RECEIPT_RESERVE_LAMPORTS,
            0,
            &solana_program::system_program::ID,
        );
        let funder_account_infos = [
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.receipt_funder.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ];
        let funder_seeds = [
            SEED_RECEIPT_FUNDER,
            position_key.as_ref(),
            &[receipt_funder_bump],
        ];

        solana_program::program::invoke_signed(
            &funder_create_ix,
            &funder_account_infos,
            &[&funder_seeds],
        )
        .map_err(|e: ProgramError| Into::<Error>::into(e))?;

        // Initialize the reveal PendingRandomness account.
        let pending_randomness = &mut ctx.accounts.pending_randomness;
        pending_randomness.version = ACCOUNT_VERSION_PENDING_RANDOMNESS;
        pending_randomness.position = position.key();
        pending_randomness.action_type = ActionType::Reveal;
        pending_randomness.action_nonce = action_nonce;
        pending_randomness.provider_program = provider_program;
        pending_randomness.provider_randomness_account = provider_randomness_account;
        pending_randomness.commitment = commitment;
        pending_randomness.committed_slot = committed_slot;
        pending_randomness.committed_protocol_epoch = ctx.accounts.reward_state.current_epoch;
        pending_randomness.timeout_timestamp = now
            .checked_add(RANDOMNESS_TIMEOUT_SECONDS)
            .ok_or(RodeoError::ArithmeticOverflow)?;
        pending_randomness.registry_root_snapshot = ctx.accounts.bull_registry.owner_tree_root;
        pending_randomness.registry_version_snapshot = ctx.accounts.bull_registry.registry_version;
        pending_randomness.registry_total_count_snapshot =
            ctx.accounts.bull_registry.total_bull_count;
        pending_randomness.registry_total_power_snapshot =
            ctx.accounts.bull_registry.total_buck_power;
        pending_randomness.config_version_snapshot =
            ctx.accounts.global_config.current_config_version;
        pending_randomness.settled = false;
        pending_randomness.bump = ctx.bumps.pending_randomness;

        // Update global counters.
        let game_state = &mut ctx.accounts.global_game_state;
        game_state.next_position_id = math::checked_add_u64(game_state.next_position_id, 1)?;
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
            committed_slot,
            committed_protocol_epoch: ctx.accounts.reward_state.current_epoch,
            timeout_timestamp: pending_randomness.timeout_timestamp,
            provider_program,
            provider_randomness_account,
            vrf_key: Some(provider_randomness_account),
            callback_id: None,
            registry_root_snapshot: pending_randomness.registry_root_snapshot,
            registry_version_snapshot: pending_randomness.registry_version_snapshot,
            registry_total_count_snapshot: pending_randomness.registry_total_count_snapshot,
            registry_total_power_snapshot: pending_randomness.registry_total_power_snapshot,
            config_version_snapshot: pending_randomness.config_version_snapshot,
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
        {
            // Deterministic mock randomness: the production settlement path is
            // the same; only the source of `random_output` changes once a real
            // provider is wired. Compute the mock result here and delegate to
            // the provider-independent common reveal settlement.
            let position_key = position.key();
            let action_type = pending_randomness.action_type;
            let action_nonce = pending_randomness.action_nonce;
            let protocol_epoch = pending_randomness.committed_protocol_epoch;
            let random_output =
                derive_commitment(position_key, action_type, action_nonce, protocol_epoch);
            return settle_reveal_common(&mut ctx, random_output);
        }

        #[cfg(not(feature = "mock-randomness"))]
        {
            // Production builds use Switchboard On-Demand verifiable randomness.
            // The provider randomness account must be the same one recorded at
            // stake time, must be owned by the expected Switchboard program, and
            // must have revealed a value for the current slot before settlement.
            let clock = &ctx.accounts.clock;
            let random_output = {
                let randomness_account = ctx
                    .accounts
                    .provider_randomness_account
                    .as_ref()
                    .ok_or(RodeoError::InvalidProviderAccount)?;
                require_keys_eq!(
                    randomness_account.key(),
                    pending_randomness.provider_randomness_account,
                    RodeoError::InvalidProviderAccount
                );
                require!(
                    randomness_account.owner == &pending_randomness.provider_program,
                    RodeoError::InvalidProviderAccount
                );
                let randomness_data =
                    RandomnessAccountData::parse(randomness_account.data.borrow())
                        .map_err(|_| RodeoError::InvalidProviderAccount)?;
                require!(
                    randomness_data.seed_slot == pending_randomness.committed_slot,
                    RodeoError::InvalidProviderAccount
                );
                randomness_data
                    .get_value(clock.slot)
                    .map_err(|_| RodeoError::RandomnessNotReady)?
            };
            settle_reveal_common(&mut ctx, random_output)
        }
    }

    pub fn recover_reveal_timeout(ctx: Context<RecoverRevealTimeout>) -> Result<()> {
        let position = &mut ctx.accounts.position;
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

        // If no receipt was created (reveal never completed), refund the
        // unused ReceiptFunder reserve to the Position owner.
        require!(
            position.receipt_asset == Pubkey::default(),
            RodeoError::InvalidCoreAssetOwner
        );

        let position_key = position.key();
        let (funder, funder_bump) = receipt_funder_pda(&position_key);
        require_keys_eq!(
            ctx.accounts.receipt_funder.key(),
            funder,
            RodeoError::InvalidCoreAssetOwner
        );

        let funder_lamports = ctx.accounts.receipt_funder.to_account_info().lamports();
        if funder_lamports > 0 {
            require_keys_eq!(
                ctx.accounts.owner.key(),
                position.owner,
                RodeoError::InvalidOwner
            );
            let funder_close_ix = solana_program::system_instruction::transfer(
                &funder,
                ctx.accounts.owner.key,
                funder_lamports,
            );
            let funder_close_account_infos = [
                ctx.accounts.receipt_funder.to_account_info(),
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ];
            let funder_seeds = [SEED_RECEIPT_FUNDER, position_key.as_ref(), &[funder_bump]];
            solana_program::program::invoke_signed(
                &funder_close_ix,
                &funder_close_account_infos,
                &[&funder_seeds],
            )?;
        }

        // The reveal action is now permanently resolved by timeout; clear the
        // pending-action lock so the same position cannot be recovered or settled
        // again and downstream instructions treat the reveal as complete.
        position.pending_action_active = false;
        position.pending_action_type = ActionType::Reveal;
        position.pending_action_nonce = 0;

        emit!(RandomnessTimeoutRecovered {
            position: position.key(),
            action_type: ActionType::Reveal,
            action_nonce: pending_randomness.action_nonce,
            recovery_action: TimeoutRecoveryAction::CloseAndRefundPrincipal,
        });

        Ok(())
    }

    pub fn close_epochs(ctx: Context<CloseEpochs>, max_epochs: u8) -> Result<()> {
        require!(max_epochs > 0, RodeoError::InvalidEpochBatch);
        let to_process = max_epochs.min(CLOSE_EPOCH_BATCH_MAX);
        let now = Clock::get()?.unix_timestamp;

        let reward_state = &mut ctx.accounts.reward_state;
        let bull_accumulator = &mut ctx.accounts.bull_accumulator;
        let global_game_state = &ctx.accounts.global_game_state;
        let reward_vault = &ctx.accounts.reward_vault;

        require_keys_eq!(
            reward_vault.key(),
            ctx.accounts.global_config.reward_vault,
            RodeoError::InvalidRewardVault
        );

        // Materialize any orphaned sub-atomic remainder that has reached scale
        // before computing free ANSEM for the next epoch.
        convert_orphaned_remainders(reward_state, bull_accumulator)?;

        let actual_reward_vault_balance = reward_vault.amount;
        let start_epoch = reward_state.current_epoch;
        let mut processed: u64 = 0;

        for _ in 0..to_process {
            let next_boundary = reward_state
                .last_closed_epoch_timestamp
                .checked_add(EPOCH_DURATION_SECONDS)
                .ok_or(RodeoError::ArithmeticOverflow)?;
            if now < next_boundary {
                break;
            }

            // Snapshot values at the epoch boundary before applying emission.
            let snapshot_recognized = reward_state.recognized_reward_balance_atomic;
            let snapshot_total_liability = reward_state.total_ansem_liability_atomic;
            let snapshot_cowboy_weight = global_game_state.total_active_cowboy_weight;
            let snapshot_bull_power = global_game_state.total_active_bull_power;
            let snapshot_timestamp = reward_state.epoch_started_at;

            let mut epoch_emission: u64 = 0;
            let mut free_ansem: u64 = 0;
            let mut cowboy_emission: u64 = 0;
            let mut suit_contribution: u64 = 0;

            if now >= reward_state.epoch_started_at {
                let backed_balance = std::cmp::min(
                    actual_reward_vault_balance,
                    reward_state.recognized_reward_balance_atomic,
                );
                free_ansem = if backed_balance >= reward_state.total_ansem_liability_atomic {
                    backed_balance - reward_state.total_ansem_liability_atomic
                } else {
                    0
                };

                epoch_emission = if free_ansem >= RUNWAY_EPOCHS as u64 {
                    free_ansem / RUNWAY_EPOCHS as u64
                } else {
                    0
                };

                cowboy_emission = math::floor_bps(epoch_emission, EMISSION_COWBOY_BPS as u64)?;
                suit_contribution = epoch_emission - cowboy_emission;
            }

            if epoch_emission > 0 {
                if cowboy_emission > 0 && global_game_state.total_active_cowboy_weight > 0 {
                    let (new_index, new_remainder) = math::increment_cowboy_index(
                        reward_state.cowboy_reward_index,
                        reward_state.cowboy_index_remainder_scaled,
                        cowboy_emission,
                        global_game_state.total_active_cowboy_weight,
                        COWBOY_REWARD_INDEX_SCALE,
                    )?;
                    reward_state.cowboy_reward_index = new_index;
                    reward_state.cowboy_index_remainder_scaled = new_remainder;
                    reward_state.cowboy_unmaterialized_liability_atomic = math::checked_add_u64(
                        reward_state.cowboy_unmaterialized_liability_atomic,
                        cowboy_emission,
                    )?;
                    reward_state.total_ansem_liability_atomic = math::checked_add_u64(
                        reward_state.total_ansem_liability_atomic,
                        cowboy_emission,
                    )?;
                }

                if suit_contribution > 0 {
                    reward_state.suit_vault_liability_atomic = math::checked_add_u64(
                        reward_state.suit_vault_liability_atomic,
                        suit_contribution,
                    )?;
                    reward_state.total_ansem_liability_atomic = math::checked_add_u64(
                        reward_state.total_ansem_liability_atomic,
                        suit_contribution,
                    )?;
                }

                reward_state.ansem_emitted_atomic =
                    math::checked_add_u64(reward_state.ansem_emitted_atomic, epoch_emission)?;
            }

            reward_state.current_epoch = math::checked_add_u64(reward_state.current_epoch, 1)?;
            reward_state.epoch_started_at = next_boundary;
            reward_state.last_closed_epoch_timestamp = next_boundary;
            processed = math::checked_add_u64(processed, 1)?;

            emit!(EpochClosed {
                epoch: reward_state.current_epoch,
                cowboy_emission,
                suit_vault_contribution: suit_contribution,
                free_ansem,
                total_cowboy_weight: snapshot_cowboy_weight,
                total_bull_power: snapshot_bull_power,
                recognized_reward_balance_atomic: snapshot_recognized,
                total_ansem_liability_atomic: snapshot_total_liability,
                snapshot_timestamp,
            });
        }

        require!(processed > 0, RodeoError::NoElapsedEpoch);

        emit!(EpochsClosed {
            start_epoch,
            end_epoch: reward_state.current_epoch,
            epochs_processed: processed,
            last_closed_timestamp: reward_state.last_closed_epoch_timestamp,
        });

        Ok(())
    }

    pub fn recognize_rewards(ctx: Context<RecognizeRewards>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require_elapsed_epochs_closed(&ctx.accounts.reward_state, now)?;

        let reward_state = &mut ctx.accounts.reward_state;
        let reward_vault = &ctx.accounts.reward_vault;

        require_keys_eq!(
            reward_vault.key(),
            ctx.accounts.global_config.reward_vault,
            RodeoError::InvalidRewardVault
        );
        require_keys_eq!(
            reward_vault.mint,
            ctx.accounts.global_config.ansem_mint,
            RodeoError::InvalidAnsemMint
        );

        let actual_balance = reward_vault.amount;
        require!(
            actual_balance >= reward_state.recognized_reward_balance_atomic,
            RodeoError::InsufficientRecognizedRewards
        );
        let surplus = actual_balance - reward_state.recognized_reward_balance_atomic;
        let to_recognize = std::cmp::min(amount, surplus);
        require!(to_recognize > 0, RodeoError::InsufficientRecognizedRewards);

        let new_recognized = reward_state
            .recognized_reward_balance_atomic
            .checked_add(to_recognize)
            .ok_or(RodeoError::ArithmeticOverflow)?;
        require!(
            new_recognized <= actual_balance,
            RodeoError::InsufficientRecognizedRewards
        );
        reward_state.recognized_reward_balance_atomic = new_recognized;

        emit!(RewardFundingRecognized {
            amount_atomic: to_recognize,
            recognized_reward_balance_atomic: new_recognized,
            actual_reward_vault_balance: actual_balance,
        });

        Ok(())
    }

    pub fn claim_position(ctx: Context<ClaimPosition>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require_elapsed_epochs_closed(&ctx.accounts.reward_state, now)?;

        let owner = ctx.accounts.owner.key();
        let position_key = ctx.accounts.position.key();
        let position = &mut ctx.accounts.position;
        require_eq!(position.owner, owner, RodeoError::InvalidOwner);
        require!(
            position.status == PositionStatus::Active,
            RodeoError::InvalidRole
        );
        require!(
            !position.pending_action_active,
            RodeoError::PendingActionBlocksClaim
        );

        // Synchronize role-specific rewards.
        sync_cowboy_rewards(position, &mut ctx.accounts.reward_state)?;
        sync_bull_rewards(
            position,
            position_key,
            &mut ctx.accounts.bull_accumulator,
            &mut ctx.accounts.reward_state,
        )?;

        let claimable = position.claimable_ansem_atomic;
        require!(claimable > 0, RodeoError::NoClaimableRewards);

        // Wallet-level cooldown.
        let cooldown = &mut ctx.accounts.wallet_claim_cooldown;
        if cooldown.version == 0 {
            cooldown.version = ACCOUNT_VERSION_WALLET_CLAIM_COOLDOWN;
            cooldown.global_config = ctx.accounts.global_config.key();
            cooldown.wallet = owner;
            cooldown.last_claimed_at = 0;
            cooldown.bump = ctx.bumps.wallet_claim_cooldown;
        }
        require!(
            now >= cooldown
                .last_claimed_at
                .checked_add(CLAIM_COOLDOWN_SECONDS)
                .ok_or(RodeoError::ArithmeticOverflow)?,
            RodeoError::ClaimCooldownNotMet
        );

        // Validate vault and destination.
        require_keys_eq!(
            ctx.accounts.reward_vault.key(),
            ctx.accounts.global_config.reward_vault,
            RodeoError::InvalidRewardVault
        );
        require_keys_eq!(
            ctx.accounts.reward_vault.mint,
            ctx.accounts.global_config.ansem_mint,
            RodeoError::InvalidAnsemMint
        );
        require_keys_eq!(
            ctx.accounts.owner_ansem_account.mint,
            ctx.accounts.global_config.ansem_mint,
            RodeoError::InvalidRewardDestination
        );
        require_keys_eq!(
            ctx.accounts.owner_ansem_account.owner,
            owner,
            RodeoError::InvalidRewardDestination
        );

        let reward_state = &mut ctx.accounts.reward_state;
        let game_state = &ctx.accounts.global_game_state;
        let bull_accumulator = &mut ctx.accounts.bull_accumulator;

        // Pay according to role.
        let owner_amount: u64;
        let bull_pool_amount: u64;
        let reward_paid_reason: RewardPaidReason;
        match position.role {
            Role::Cowboy => {
                let (owner_bps, _bull_pool_bps) = if position.cowboy_kind == CowboyKind::Desperado {
                    (DESPERADO_CLAIM_OWNER_BPS, DESPERADO_CLAIM_BULL_POOL_BPS)
                } else {
                    (CLAIM_OWNER_BPS, CLAIM_BULL_POOL_BPS)
                };
                owner_amount = math::floor_bps(claimable, owner_bps)?;
                bull_pool_amount = math::checked_sub_u64(claimable, owner_amount)?;
                reward_paid_reason = if position.cowboy_kind == CowboyKind::Desperado {
                    RewardPaidReason::DesperadoClaim
                } else {
                    RewardPaidReason::CowboyClaim
                };

                require_gte!(
                    reward_state.position_claimable_liability_atomic,
                    claimable,
                    RodeoError::LiabilityUnderflow
                );
                require_gte!(
                    reward_state.recognized_reward_balance_atomic,
                    owner_amount,
                    RodeoError::InsufficientRecognizedRewards
                );
                require_gte!(
                    reward_state.total_ansem_liability_atomic,
                    owner_amount,
                    RodeoError::LiabilityUnderflow
                );

                reward_state.position_claimable_liability_atomic = math::checked_sub_u64(
                    reward_state.position_claimable_liability_atomic,
                    claimable,
                )?;
                reward_state.total_ansem_liability_atomic =
                    math::checked_sub_u64(reward_state.total_ansem_liability_atomic, owner_amount)?;
                reward_state.recognized_reward_balance_atomic = math::checked_sub_u64(
                    reward_state.recognized_reward_balance_atomic,
                    owner_amount,
                )?;
                reward_state.ansem_claimed_atomic =
                    math::checked_add_u64(reward_state.ansem_claimed_atomic, owner_amount)?;

                transfer_ansem_from_vault(
                    owner_amount,
                    &*ctx.accounts.global_config,
                    ctx.accounts.reward_vault.to_account_info(),
                    ctx.accounts.owner_ansem_account.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                )?;

                let source = if position.cowboy_kind == CowboyKind::Desperado {
                    BullPoolSource::DesperadoClaimTax
                } else {
                    BullPoolSource::CowboyClaimTax
                };
                distribute_bull_pool_contribution(
                    source,
                    bull_pool_amount,
                    reward_state,
                    bull_accumulator,
                    game_state,
                )?;

                emit!(RewardPaid {
                    position: position.key(),
                    owner,
                    amount_atomic: owner_amount,
                    recognized_reward_balance_atomic: reward_state.recognized_reward_balance_atomic,
                    reason: reward_paid_reason,
                });
            }
            Role::Bull => {
                owner_amount = claimable;
                bull_pool_amount = 0;
                reward_paid_reason = RewardPaidReason::BullClaim;

                require_gte!(
                    reward_state.position_claimable_liability_atomic,
                    claimable,
                    RodeoError::LiabilityUnderflow
                );
                require_gte!(
                    reward_state.recognized_reward_balance_atomic,
                    claimable,
                    RodeoError::InsufficientRecognizedRewards
                );
                require_gte!(
                    reward_state.total_ansem_liability_atomic,
                    claimable,
                    RodeoError::LiabilityUnderflow
                );

                reward_state.position_claimable_liability_atomic = math::checked_sub_u64(
                    reward_state.position_claimable_liability_atomic,
                    claimable,
                )?;
                reward_state.total_ansem_liability_atomic =
                    math::checked_sub_u64(reward_state.total_ansem_liability_atomic, claimable)?;
                reward_state.recognized_reward_balance_atomic = math::checked_sub_u64(
                    reward_state.recognized_reward_balance_atomic,
                    claimable,
                )?;
                reward_state.ansem_claimed_atomic =
                    math::checked_add_u64(reward_state.ansem_claimed_atomic, claimable)?;

                transfer_ansem_from_vault(
                    claimable,
                    &*ctx.accounts.global_config,
                    ctx.accounts.reward_vault.to_account_info(),
                    ctx.accounts.owner_ansem_account.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                )?;

                emit!(RewardPaid {
                    position: position.key(),
                    owner,
                    amount_atomic: claimable,
                    recognized_reward_balance_atomic: reward_state.recognized_reward_balance_atomic,
                    reason: reward_paid_reason,
                });
            }
            _ => return err!(RodeoError::InvalidRole),
        }

        position.claimable_ansem_atomic = 0;
        cooldown.last_claimed_at = now;

        emit!(PositionClaimed {
            position: position.key(),
            owner,
            owner_amount,
            bull_pool_amount,
        });

        Ok(())
    }

    pub fn request_unstake(ctx: Context<RequestUnstake>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require_elapsed_epochs_closed(&ctx.accounts.reward_state, now)?;

        let owner = ctx.accounts.owner.key();
        let position_key = ctx.accounts.position.key();
        let position = &mut ctx.accounts.position;

        require_eq!(position.owner, owner, RodeoError::InvalidOwner);
        require!(
            position.status == PositionStatus::Active,
            RodeoError::InvalidRole
        );
        require!(
            !position.pending_action_active,
            RodeoError::PendingActionConflict
        );
        require!(
            now >= position.unstake_eligible_at,
            RodeoError::MinimumStakePeriodNotMet
        );

        // Synchronize current role rewards before opening the pending action.
        sync_cowboy_rewards(position, &mut ctx.accounts.reward_state)?;
        sync_bull_rewards(
            position,
            position_key,
            &mut ctx.accounts.bull_accumulator,
            &mut ctx.accounts.reward_state,
        )?;

        let action_nonce = position.next_action_nonce;
        let clock = Clock::get()?;
        let protocol_epoch = ctx.accounts.reward_state.current_epoch;

        let commitment = derive_commitment(
            position.key(),
            ActionType::Unstake,
            action_nonce,
            protocol_epoch,
        );

        position.pending_action_active = true;
        position.pending_action_type = ActionType::Unstake;
        position.pending_action_nonce = action_nonce;
        position.next_action_nonce = math::checked_add_u64(action_nonce, 1)?;

        let pending_randomness = &mut ctx.accounts.pending_randomness;
        pending_randomness.version = ACCOUNT_VERSION_PENDING_RANDOMNESS;
        pending_randomness.position = position.key();
        pending_randomness.action_type = ActionType::Unstake;
        pending_randomness.action_nonce = action_nonce;
        pending_randomness.provider_program = Pubkey::default();
        pending_randomness.provider_randomness_account = Pubkey::default();
        pending_randomness.commitment = commitment;
        pending_randomness.committed_slot = clock.slot;
        pending_randomness.committed_protocol_epoch = protocol_epoch;
        pending_randomness.timeout_timestamp = now
            .checked_add(RANDOMNESS_TIMEOUT_SECONDS)
            .ok_or(RodeoError::ArithmeticOverflow)?;
        pending_randomness.registry_root_snapshot = [0u8; 32];
        pending_randomness.registry_version_snapshot = 0;
        pending_randomness.registry_total_count_snapshot = 0;
        pending_randomness.registry_total_power_snapshot = 0;
        pending_randomness.config_version_snapshot =
            ctx.accounts.global_config.current_config_version;
        pending_randomness.settled = false;
        pending_randomness.bump = ctx.bumps.pending_randomness;

        emit!(UnstakeRequested {
            position: position.key(),
            owner,
            action_nonce,
            requested_at: now,
            config_version: pending_randomness.config_version_snapshot,
        });
        emit!(RandomnessRequested {
            position: position.key(),
            action_type: ActionType::Unstake,
            action_nonce,
            committed_slot: clock.slot,
            committed_protocol_epoch: protocol_epoch,
            timeout_timestamp: pending_randomness.timeout_timestamp,
            provider_program: Pubkey::default(),
            provider_randomness_account: Pubkey::default(),
            vrf_key: None,
            callback_id: None,
            registry_root_snapshot: pending_randomness.registry_root_snapshot,
            registry_version_snapshot: pending_randomness.registry_version_snapshot,
            registry_total_count_snapshot: pending_randomness.registry_total_count_snapshot,
            registry_total_power_snapshot: pending_randomness.registry_total_power_snapshot,
            config_version_snapshot: pending_randomness.config_version_snapshot,
            commitment,
        });

        Ok(())
    }

    pub fn settle_unstake(mut ctx: Context<SettleUnstake>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require_elapsed_epochs_closed(&ctx.accounts.reward_state, now)?;

        let position = &ctx.accounts.position;
        let pending_randomness = &ctx.accounts.pending_randomness;

        require!(
            position.pending_action_active,
            RodeoError::PendingActionConflict
        );
        require!(
            position.pending_action_type == ActionType::Unstake,
            RodeoError::WrongActionType
        );
        require!(
            position.status == PositionStatus::Active,
            RodeoError::InvalidRole
        );
        require!(
            pending_randomness.position == position.key(),
            RodeoError::InvalidPendingRandomness
        );
        require!(
            pending_randomness.action_type == ActionType::Unstake,
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
        return settle_unstake_mock(&mut ctx);

        #[cfg(not(feature = "mock-randomness"))]
        {
            // Production builds require a verified randomness proof. The Switchboard
            // adapter is intentionally not implemented in Phase 2C2B.
            err!(RodeoError::RandomnessNotReady)
        }
    }

    pub fn recover_unstake_timeout(ctx: Context<RecoverUnstakeTimeout>) -> Result<()> {
        let position = &ctx.accounts.position;
        let pending_randomness = &ctx.accounts.pending_randomness;
        let now = Clock::get()?.unix_timestamp;

        require!(
            position.status == PositionStatus::Active,
            RodeoError::InvalidRole
        );
        require!(
            position.pending_action_active,
            RodeoError::PendingActionConflict
        );
        require!(
            position.pending_action_type == ActionType::Unstake,
            RodeoError::WrongActionType
        );
        require!(
            pending_randomness.position == position.key(),
            RodeoError::InvalidPendingRandomness
        );
        require!(
            pending_randomness.action_type == ActionType::Unstake,
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

        let position = &mut ctx.accounts.position;
        position.pending_action_active = false;
        position.pending_action_type = ActionType::Reveal;
        position.pending_action_nonce = 0;

        emit!(RandomnessTimeoutRecovered {
            position: position.key(),
            action_type: ActionType::Unstake,
            action_nonce: pending_randomness.action_nonce,
            recovery_action: TimeoutRecoveryAction::CancelUnstake,
        });

        Ok(())
    }

    pub fn initialize_bull_proof(
        ctx: Context<InitializeBullProof>,
        action_type: ActionType,
        expected_payload_length: u32,
        nonce: u64,
    ) -> Result<()> {
        require!(
            action_type == ActionType::Reveal || action_type == ActionType::Unstake,
            RodeoError::BullProofBufferIncomplete
        );
        require_gte!(
            BULL_PROOF_BUFFER_MAX_PAYLOAD as u32,
            expected_payload_length,
            RodeoError::BullProofBufferOversized
        );

        let pending_randomness = &ctx.accounts.pending_randomness;
        require!(
            pending_randomness.action_type == action_type,
            RodeoError::BullProofBufferIncomplete
        );
        require!(
            !pending_randomness.settled,
            RodeoError::RandomnessAlreadyAvailable
        );

        let position = &ctx.accounts.position;
        require_keys_eq!(
            pending_randomness.position,
            position.key(),
            RodeoError::InvalidPendingRandomness
        );
        require_keys_eq!(
            position.key(),
            ctx.accounts.bull_proof_buffer.position,
            RodeoError::BullProofBufferWrongPosition
        );

        let buffer = &mut ctx.accounts.bull_proof_buffer;
        buffer.version = ACCOUNT_VERSION_BULL_PROOF_BUFFER;
        buffer.schema_version = BULL_PROOF_BUFFER_SCHEMA_VERSION;
        buffer.action_type = action_type;
        buffer.pending_randomness = pending_randomness.key();
        buffer.position = position.key();
        buffer.snapshot_root = pending_randomness.registry_root_snapshot;
        buffer.snapshot_version = pending_randomness.registry_version_snapshot;
        buffer.snapshot_total_count = pending_randomness.registry_total_count_snapshot;
        buffer.snapshot_total_power = pending_randomness.registry_total_power_snapshot;
        buffer.refund_recipient = ctx.accounts.prover.key();
        buffer.expiry_timestamp = pending_randomness.timeout_timestamp;
        buffer.nonce = nonce;
        buffer.expected_payload_length = expected_payload_length;
        buffer.finalized = false;
        buffer.consumed = false;
        buffer.bump = ctx.bumps.bull_proof_buffer;
        buffer.payload = Vec::new();

        Ok(())
    }

    pub fn append_bull_proof(
        ctx: Context<AppendBullProof>,
        nonce: u64,
        offset: u32,
        chunk: Vec<u8>,
    ) -> Result<()> {
        let buffer = &mut ctx.accounts.bull_proof_buffer;
        require!(!buffer.finalized, RodeoError::BullProofBufferFinalized);
        require_keys_eq!(
            buffer.refund_recipient,
            ctx.accounts.prover.key(),
            RodeoError::BullProofBufferWrongProver
        );
        require_eq!(
            offset,
            buffer.payload.len() as u32,
            RodeoError::BullProofBufferOffsetGap
        );

        let new_len = (offset as usize)
            .checked_add(chunk.len())
            .ok_or(RodeoError::ArithmeticOverflow)?;
        require_gte!(
            buffer.expected_payload_length as usize,
            new_len,
            RodeoError::BullProofBufferOversized
        );
        require_gte!(
            BULL_PROOF_BUFFER_MAX_PAYLOAD,
            new_len,
            RodeoError::BullProofBufferOversized
        );

        buffer.payload.extend_from_slice(&chunk);
        Ok(())
    }

    pub fn finalize_bull_proof(ctx: Context<FinalizeBullProof>, nonce: u64) -> Result<()> {
        let buffer = &mut ctx.accounts.bull_proof_buffer;
        require!(!buffer.finalized, RodeoError::BullProofBufferFinalized);
        require_keys_eq!(
            buffer.refund_recipient,
            ctx.accounts.prover.key(),
            RodeoError::BullProofBufferWrongProver
        );
        require_eq!(
            buffer.payload.len() as u32,
            buffer.expected_payload_length,
            RodeoError::BullProofBufferIncomplete
        );

        buffer.finalized = true;
        Ok(())
    }

    pub fn close_bull_proof(ctx: Context<CloseBullProof>, nonce: u64) -> Result<()> {
        let buffer = &ctx.accounts.bull_proof_buffer;
        let now = Clock::get()?.unix_timestamp;
        require!(
            buffer.consumed || now >= buffer.expiry_timestamp,
            RodeoError::BullProofBufferNotAbandoned
        );
        Ok(())
    }

    /// Benchmark fixture for the sparse-tree verifier.  It exercises the exact
    /// production verification and add/remove paths and then restores the
    /// registry so the benchmark is non-destructive.  Compute units are read
    /// from the Solana runtime after the transaction.
    pub fn benchmark_sparse_tree(
        ctx: Context<BenchmarkSparseTree>,
        victim: Option<Pubkey>,
        new_bull: Option<BullLeaf>,
        payload: Vec<u8>,
    ) -> Result<()> {
        let payload = bull_registry::verify_bull_proof_payload(&payload)?;
        let registry = &mut ctx.accounts.bull_registry;

        let snapshot = SparseTreeBenchmarkSnapshot {
            owner_tree_root: registry.owner_tree_root,
            total_bull_count: registry.total_bull_count,
            total_buck_power: registry.total_buck_power,
            registry_version: registry.registry_version,
        };

        // 1. Owner membership / non-membership.
        if let Some(ref key) = victim {
            if let Some(ref proof) = payload.victim_owner {
                bull_registry::verify_owner(&snapshot.owner_tree_root, key, proof)?;
            }
        }

        // 2. Selected owner + Bull (composed theft selection).
        if let Some(ref selected_owner) = payload.selected_owner {
            let selected_key = selected_owner.leaf.owner;
            bull_registry::verify_owner(&snapshot.owner_tree_root, &selected_key, selected_owner)?;

            if let Some(ref selected_bull) = payload.selected_bull {
                bull_registry::verify_bull(
                    &selected_owner.leaf.bull_tree_root,
                    &selected_bull.leaf.position,
                    selected_bull,
                )?;
            }
        }

        // 3. Bull add (under existing or absent owner).
        if let Some(ref bull_leaf) = new_bull {
            if let (Some(ref owner_proof), Some(ref bull_proof)) = (
                payload.current_owner.as_ref(),
                payload.current_bull.as_ref(),
            ) {
                bull_registry::add_bull_to_registry(registry, bull_leaf, owner_proof, bull_proof)?;
            }
        }

        // 4. Bull remove.
        if let Some(ref owner_proof) = payload.current_owner {
            if let Some(ref remove_bull) = payload.remove_bull {
                bull_registry::remove_bull_from_registry(
                    registry,
                    &remove_bull.leaf,
                    owner_proof,
                    remove_bull,
                )?;
            }
        }

        // Restore registry to keep the fixture non-destructive.
        registry.owner_tree_root = snapshot.owner_tree_root;
        registry.total_bull_count = snapshot.total_bull_count;
        registry.total_buck_power = snapshot.total_buck_power;
        registry.registry_version = snapshot.registry_version;

        emit!(SparseTreeBenchmarked {
            owner_tree_root: snapshot.owner_tree_root,
            total_bull_count: snapshot.total_bull_count,
            total_buck_power: snapshot.total_buck_power,
            registry_version: snapshot.registry_version,
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

    /// Test-only fixture to fund the reward vault and mark those funds as
    /// recognized, bypassing the production recognition rules. This gives the
    /// claim-profile tests a deterministic reserve to pay out.
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_recognize_rewards(
        ctx: Context<TestFixtureRecognizeRewards>,
        amount: u64,
    ) -> Result<()> {
        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.payer_ansem_account.to_account_info(),
                to: ctx.accounts.reward_vault.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        );
        anchor_spl::token::transfer(cpi, amount)?;

        let reward_state = &mut ctx.accounts.reward_state;
        reward_state.recognized_reward_balance_atomic =
            math::checked_add_u64(reward_state.recognized_reward_balance_atomic, amount)?;
        Ok(())
    }

    /// Test-only fixture to put a position into a deterministic, claim-ready
    /// state and to credit the matching liability bucket. This removes the need
    /// for real epoch closures in the claim-profile suite while leaving the
    /// production claim/recognize guards untouched.
    #[cfg(feature = "test-fixtures")]
    #[allow(clippy::too_many_arguments)]
    pub fn test_fixture_prepare_position(
        ctx: Context<TestFixturePreparePosition>,
        position_id: u64,
        role_code: u8,
        cowboy_kind_code: u8,
        accrual_weight: u32,
        buck_power: u8,
        claimable: u64,
        position_claimable_liability_delta: u64,
    ) -> Result<()> {
        let _ = position_id;

        let position = &mut ctx.accounts.position;
        position.role = match role_code {
            1 => Role::Cowboy,
            2 => Role::Bull,
            _ => Role::Unassigned,
        };
        position.cowboy_kind = match cowboy_kind_code {
            0..=10 => CowboyKind::Rank(cowboy_kind_code),
            254 => CowboyKind::Desperado,
            _ => CowboyKind::Unassigned,
        };
        position.accrual_weight = accrual_weight;
        position.buck_power = buck_power;
        position.status = PositionStatus::Active;
        position.pending_action_active = false;
        position.unstake_eligible_at = 0;
        position.claimable_ansem_atomic = claimable;
        position.last_cowboy_reward_index = ctx.accounts.reward_state.cowboy_reward_index;
        position.cowboy_accrual_remainder_scaled = 0;
        position.last_bull_reward_per_weight =
            ctx.accounts.bull_accumulator.reward_per_weight_scaled;
        position.bull_accrual_remainder_scaled = 0;

        let reward_state = &mut ctx.accounts.reward_state;
        reward_state.position_claimable_liability_atomic = math::checked_add_u64(
            reward_state.position_claimable_liability_atomic,
            position_claimable_liability_delta,
        )?;
        reward_state.total_ansem_liability_atomic = math::checked_add_u64(
            reward_state.total_ansem_liability_atomic,
            position_claimable_liability_delta,
        )?;

        Ok(())
    }

    /// Test-only fixture to create a ProtocolConfig V2 with altered reveal
    /// probabilities. Used to prove historical snapshot behavior on localnet.
    #[cfg(feature = "test-fixtures")]
    pub fn create_protocol_config_v2_fixture(
        ctx: Context<CreateProtocolConfigFixture>,
        config_version: u64,
    ) -> Result<()> {
        require_eq!(config_version, 2, RodeoError::InvalidProbabilityTable);

        let mut config = probability::protocol_config_v1(
            ctx.accounts.global_config.key(),
            ctx.bumps.protocol_config,
        );
        config.config_version = 2;
        config.role_weights = [4_500_000, 5_500_000];
        config.cowboy_rank_weights = [
            2_023_875, 1_124_375, 584_675, 359_800, 224_875, 134_925, 44_975, 2_500,
        ];
        config.bull_tier_weights = [3_300_000, 1_375_000, 550_000, 275_000];

        // Make V2 materially different for unstake settlement in both
        // dimensions: principal split (20/80) and theft probability (50/50).
        config.unstake_tax_bps = 2_000;
        config.unstake_return_bps = 8_000;
        config.unstake_theft_weights = [5_000_000, 5_000_000];

        probability::validate_protocol_config(&config)?;
        ctx.accounts.protocol_config.set_inner(config);

        Ok(())
    }

    /// Test-only fixture to activate an already-created ProtocolConfig.
    #[cfg(feature = "test-fixtures")]
    pub fn set_current_config_version_fixture(
        ctx: Context<SetCurrentConfigVersionFixture>,
    ) -> Result<()> {
        ctx.accounts.global_config.current_config_version =
            ctx.accounts.protocol_config.config_version;
        Ok(())
    }

    /// Test-only fixture to set the per-position scaled accrual remainders and
    /// reward checkpoints. Used to establish deterministic boundary state for
    /// orphaned-remainder materialization tests.
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_set_position_remainders(
        ctx: Context<TestFixtureSetPositionRemainders>,
        position_id: u64,
        cowboy_accrual_remainder_scaled: u128,
        bull_accrual_remainder_scaled: u128,
        last_cowboy_reward_index: u128,
        last_bull_reward_per_weight: u128,
    ) -> Result<()> {
        let _ = position_id;
        let position = &mut ctx.accounts.position;
        position.cowboy_accrual_remainder_scaled = cowboy_accrual_remainder_scaled;
        position.bull_accrual_remainder_scaled = bull_accrual_remainder_scaled;
        position.last_cowboy_reward_index = last_cowboy_reward_index;
        position.last_bull_reward_per_weight = last_bull_reward_per_weight;
        Ok(())
    }

    /// Test-only fixture to set the global orphaned-remainder fields and the
    /// liability buckets needed to exercise close_epoch conversion. Used to
    /// establish deterministic boundary state for orphaned-remainder
    /// materialization tests.
    #[allow(clippy::too_many_arguments)]
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_set_orphaned_remainder(
        ctx: Context<TestFixtureSetOrphanedRemainder>,
        cowboy_orphaned_accrual_remainder_scaled: u128,
        bull_orphaned_accrual_remainder_scaled: u128,
        cowboy_unmaterialized_liability_atomic: u64,
        bull_pool_liability_atomic: u64,
        total_ansem_liability_atomic: u64,
        recognized_reward_balance_atomic: u64,
        last_closed_epoch_timestamp: i64,
        epoch_started_at: i64,
    ) -> Result<()> {
        let reward_state = &mut ctx.accounts.reward_state;
        reward_state.cowboy_orphaned_accrual_remainder_scaled =
            cowboy_orphaned_accrual_remainder_scaled;
        reward_state.cowboy_unmaterialized_liability_atomic =
            cowboy_unmaterialized_liability_atomic;
        reward_state.total_ansem_liability_atomic = total_ansem_liability_atomic;
        reward_state.recognized_reward_balance_atomic = recognized_reward_balance_atomic;
        reward_state.last_closed_epoch_timestamp = last_closed_epoch_timestamp;
        reward_state.epoch_started_at = epoch_started_at;

        let bull_accumulator = &mut ctx.accounts.bull_accumulator;
        bull_accumulator.bull_orphaned_accrual_remainder_scaled =
            bull_orphaned_accrual_remainder_scaled;
        reward_state.bull_pool_liability_atomic = bull_pool_liability_atomic;

        Ok(())
    }

    /// Test-only fixture to advance the global position-id counter. This lets
    /// the claim-profile suite search for a deterministic position PDA without
    /// staking every skipped id.
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_advance_next_position_id(
        ctx: Context<TestFixtureAdvanceNextPositionId>,
        next_position_id: u64,
    ) -> Result<()> {
        require_gte!(
            next_position_id,
            ctx.accounts.global_game_state.next_position_id,
            RodeoError::InvalidPositionId
        );
        ctx.accounts.global_game_state.next_position_id = next_position_id;
        Ok(())
    }

    /// Test-only fixture that creates a Core PositionReceipt at the deterministic
    /// PDA for the given Position. Proves stateless ReceiptAuthority signing.
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_create_position_receipt(
        ctx: Context<TestFixtureCreatePositionReceipt>,
        name: String,
        uri: String,
    ) -> Result<()> {
        let (receipt_authority, receipt_authority_bump) =
            receipt_authority_pda(&ctx.accounts.global_config.key());
        let (receipt_asset, receipt_asset_bump) =
            position_receipt_pda(&ctx.accounts.position.key());

        require_keys_eq!(
            ctx.accounts.receipt_authority.key(),
            receipt_authority,
            RodeoError::InvalidCoreAssetOwner
        );
        require_keys_eq!(
            ctx.accounts.receipt_asset.key(),
            receipt_asset,
            RodeoError::InvalidCoreAssetOwner
        );

        let plugins = vec![
            PluginAuthorityPair {
                plugin: Plugin::PermanentTransferDelegate(
                    mpl_core::types::PermanentTransferDelegate {},
                ),
                authority: Some(PluginAuthority::Address {
                    address: receipt_authority,
                }),
            },
            PluginAuthorityPair {
                plugin: Plugin::PermanentBurnDelegate(mpl_core::types::PermanentBurnDelegate {}),
                authority: Some(PluginAuthority::Address {
                    address: receipt_authority,
                }),
            },
            PluginAuthorityPair {
                plugin: Plugin::PermanentFreezeDelegate(mpl_core::types::PermanentFreezeDelegate {
                    frozen: true,
                }),
                authority: Some(PluginAuthority::Address {
                    address: receipt_authority,
                }),
            },
        ];

        let instruction = CreateV2Builder::new()
            .asset(receipt_asset)
            .authority(Some(receipt_authority))
            .payer(ctx.accounts.authority.key())
            .owner(Some(ctx.accounts.asset_owner.key()))
            .system_program(solana_program::system_program::ID)
            .data_state(DataState::AccountState)
            .name(name)
            .uri(uri)
            .plugins(plugins)
            .instruction();

        let account_infos = [
            ctx.accounts.receipt_asset.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
            ctx.accounts.receipt_authority.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.asset_owner.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
        ];

        let global_config_key = ctx.accounts.global_config.key();
        let position_key = ctx.accounts.position.key();
        let receipt_authority_seeds = [
            SEED_RECEIPT_AUTHORITY,
            global_config_key.as_ref(),
            &[receipt_authority_bump],
        ];
        let receipt_asset_seeds = [
            SEED_POSITION_RECEIPT,
            position_key.as_ref(),
            &[receipt_asset_bump],
        ];

        solana_program::program::invoke_signed(
            &instruction,
            &account_infos,
            &[&receipt_authority_seeds, &receipt_asset_seeds],
        )
        .map_err(Into::into)
    }

    /// Test-only fixture that force-transfers the frozen receipt using the
    /// permanent transfer delegate controlled by the stateless ReceiptAuthority.
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_force_transfer_position_receipt(
        ctx: Context<TestFixtureForceTransferPositionReceipt>,
        new_owner: Pubkey,
    ) -> Result<()> {
        let (receipt_authority, receipt_authority_bump) =
            receipt_authority_pda(&ctx.accounts.global_config.key());

        let instruction = TransferV1Builder::new()
            .asset(*ctx.accounts.receipt_asset.key)
            .payer(ctx.accounts.authority.key())
            .authority(Some(receipt_authority))
            .new_owner(new_owner)
            .system_program(Some(solana_program::system_program::ID))
            .instruction();

        let account_infos = [
            ctx.accounts.receipt_asset.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.receipt_authority.to_account_info(),
            ctx.accounts.new_owner_account.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
        ];
        let global_config_key = ctx.accounts.global_config.key();
        let seeds = [
            SEED_RECEIPT_AUTHORITY,
            global_config_key.as_ref(),
            &[receipt_authority_bump],
        ];

        solana_program::program::invoke_signed(&instruction, &account_infos, &[&seeds])
            .map_err(Into::into)
    }

    /// Same as `test_fixture_force_transfer_position_receipt`, but for a
    /// receipt that belongs to the official Rodeo receipt Collection: MPL
    /// Core's `TransferV1` requires the collection account when the asset's
    /// `UpdateAuthority` is `Collection(...)` (otherwise it rejects with
    /// `MissingCollection`).
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_force_transfer_position_receipt_in_collection(
        ctx: Context<TestFixtureForceTransferPositionReceiptInCollection>,
        new_owner: Pubkey,
    ) -> Result<()> {
        let (receipt_authority, receipt_authority_bump) =
            receipt_authority_pda(&ctx.accounts.global_config.key());

        let instruction = TransferV1Builder::new()
            .asset(*ctx.accounts.receipt_asset.key)
            .collection(Some(*ctx.accounts.collection.key))
            .payer(ctx.accounts.authority.key())
            .authority(Some(receipt_authority))
            .new_owner(new_owner)
            .system_program(Some(solana_program::system_program::ID))
            .instruction();

        let account_infos = [
            ctx.accounts.receipt_asset.to_account_info(),
            ctx.accounts.collection.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.receipt_authority.to_account_info(),
            ctx.accounts.new_owner_account.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
        ];
        let global_config_key = ctx.accounts.global_config.key();
        let seeds = [
            SEED_RECEIPT_AUTHORITY,
            global_config_key.as_ref(),
            &[receipt_authority_bump],
        ];

        solana_program::program::invoke_signed(&instruction, &account_infos, &[&seeds])
            .map_err(Into::into)
    }

    /// Test-only fixture that force-burns the frozen receipt using the
    /// permanent burn delegate controlled by the stateless ReceiptAuthority.
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_force_burn_position_receipt(
        ctx: Context<TestFixtureForceBurnPositionReceipt>,
    ) -> Result<()> {
        let (receipt_authority, receipt_authority_bump) =
            receipt_authority_pda(&ctx.accounts.global_config.key());

        let instruction = BurnV1Builder::new()
            .asset(*ctx.accounts.receipt_asset.key)
            .payer(ctx.accounts.authority.key())
            .authority(Some(receipt_authority))
            .system_program(Some(solana_program::system_program::ID))
            .instruction();

        let account_infos = [
            ctx.accounts.receipt_asset.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.receipt_authority.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
        ];
        let global_config_key = ctx.accounts.global_config.key();
        let seeds = [
            SEED_RECEIPT_AUTHORITY,
            global_config_key.as_ref(),
            &[receipt_authority_bump],
        ];

        solana_program::program::invoke_signed(&instruction, &account_infos, &[&seeds])
            .map_err(Into::into)
    }

    /// Test-only fixture that creates the official Rodeo receipt Collection
    /// at the deterministic receipt-collection PDA, with the stateless
    /// ReceiptAuthority PDA as its update authority. Proves the collection
    /// PDA derivation and that `CreateCollectionV2` accepts a Rodeo PDA as
    /// both the collection address (self-signing via `invoke_signed`) and
    /// its update authority (recorded, not required to sign at creation).
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_create_receipt_collection(
        ctx: Context<TestFixtureCreateReceiptCollection>,
        name: String,
        uri: String,
    ) -> Result<()> {
        let (receipt_authority, receipt_authority_bump) =
            receipt_authority_pda(&ctx.accounts.global_config.key());
        let (collection, collection_bump) =
            receipt_collection_pda(&ctx.accounts.global_config.key());

        require_keys_eq!(
            ctx.accounts.receipt_authority.key(),
            receipt_authority,
            RodeoError::InvalidCoreAssetOwner
        );
        require_keys_eq!(
            ctx.accounts.collection.key(),
            collection,
            RodeoError::InvalidCoreAssetOwner
        );

        let instruction = CreateCollectionV2Builder::new()
            .collection(collection)
            .update_authority(Some(receipt_authority))
            .payer(ctx.accounts.authority.key())
            .system_program(solana_program::system_program::ID)
            .name(name)
            .uri(uri)
            .instruction();

        let account_infos = [
            ctx.accounts.collection.to_account_info(),
            ctx.accounts.receipt_authority.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ];

        let global_config_key = ctx.accounts.global_config.key();
        let collection_seeds = [
            SEED_RECEIPT_COLLECTION,
            global_config_key.as_ref(),
            &[collection_bump],
        ];
        let receipt_authority_seeds = [
            SEED_RECEIPT_AUTHORITY,
            global_config_key.as_ref(),
            &[receipt_authority_bump],
        ];

        solana_program::program::invoke_signed(
            &instruction,
            &account_infos,
            &[&collection_seeds, &receipt_authority_seeds],
        )
        .map_err(Into::into)
    }

    /// Test-only fixture that creates a Core PositionReceipt inside the
    /// official Rodeo receipt Collection. Unlike
    /// `test_fixture_create_position_receipt`, this omits a per-asset
    /// `update_authority`, so the created asset's `UpdateAuthority` resolves
    /// to `Collection(receipt_collection)`, meaning only whoever controls
    /// the collection (the ReceiptAuthority PDA) can update its metadata.
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_create_position_receipt_in_collection(
        ctx: Context<TestFixtureCreatePositionReceiptInCollection>,
        name: String,
        uri: String,
    ) -> Result<()> {
        let (receipt_authority, receipt_authority_bump) =
            receipt_authority_pda(&ctx.accounts.global_config.key());
        let (receipt_asset, receipt_asset_bump) =
            position_receipt_pda(&ctx.accounts.position.key());
        let (collection, _collection_bump) =
            receipt_collection_pda(&ctx.accounts.global_config.key());

        require_keys_eq!(
            ctx.accounts.receipt_authority.key(),
            receipt_authority,
            RodeoError::InvalidCoreAssetOwner
        );
        require_keys_eq!(
            ctx.accounts.receipt_asset.key(),
            receipt_asset,
            RodeoError::InvalidCoreAssetOwner
        );
        require_keys_eq!(
            ctx.accounts.collection.key(),
            collection,
            RodeoError::InvalidCoreAssetOwner
        );

        let plugins = vec![
            PluginAuthorityPair {
                plugin: Plugin::PermanentTransferDelegate(
                    mpl_core::types::PermanentTransferDelegate {},
                ),
                authority: Some(PluginAuthority::Address {
                    address: receipt_authority,
                }),
            },
            PluginAuthorityPair {
                plugin: Plugin::PermanentBurnDelegate(mpl_core::types::PermanentBurnDelegate {}),
                authority: Some(PluginAuthority::Address {
                    address: receipt_authority,
                }),
            },
            PluginAuthorityPair {
                plugin: Plugin::PermanentFreezeDelegate(mpl_core::types::PermanentFreezeDelegate {
                    frozen: true,
                }),
                authority: Some(PluginAuthority::Address {
                    address: receipt_authority,
                }),
            },
        ];

        let instruction = CreateV2Builder::new()
            .asset(receipt_asset)
            .collection(Some(collection))
            .authority(Some(receipt_authority))
            .payer(ctx.accounts.authority.key())
            .owner(Some(ctx.accounts.asset_owner.key()))
            // No per-asset update_authority: leaving this unset while
            // `collection` is set makes the asset's `UpdateAuthority`
            // resolve to `Collection(collection)`.
            .system_program(solana_program::system_program::ID)
            .data_state(DataState::AccountState)
            .name(name)
            .uri(uri)
            .plugins(plugins)
            .instruction();

        let account_infos = [
            ctx.accounts.receipt_asset.to_account_info(),
            ctx.accounts.collection.to_account_info(),
            ctx.accounts.receipt_authority.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.asset_owner.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
        ];

        let global_config_key = ctx.accounts.global_config.key();
        let position_key = ctx.accounts.position.key();
        let receipt_authority_seeds = [
            SEED_RECEIPT_AUTHORITY,
            global_config_key.as_ref(),
            &[receipt_authority_bump],
        ];
        let receipt_asset_seeds = [
            SEED_POSITION_RECEIPT,
            position_key.as_ref(),
            &[receipt_asset_bump],
        ];

        solana_program::program::invoke_signed(
            &instruction,
            &account_infos,
            &[&receipt_authority_seeds, &receipt_asset_seeds],
        )
        .map_err(Into::into)
    }

    /// Test-only fixture that updates a PositionReceipt's name/URI using the
    /// stateless ReceiptAuthority PDA, authorized because it controls the
    /// asset's collection (and the asset itself carries no per-asset update
    /// authority override).
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_update_position_receipt_metadata(
        ctx: Context<TestFixtureUpdatePositionReceiptMetadata>,
        new_name: Option<String>,
        new_uri: Option<String>,
    ) -> Result<()> {
        let (receipt_authority, receipt_authority_bump) =
            receipt_authority_pda(&ctx.accounts.global_config.key());

        let mut builder = UpdateV1Builder::new();
        builder
            .asset(*ctx.accounts.receipt_asset.key)
            .collection(Some(*ctx.accounts.collection.key))
            .payer(ctx.accounts.authority.key())
            .authority(Some(receipt_authority))
            .system_program(solana_program::system_program::ID);
        if let Some(new_name) = new_name {
            builder.new_name(new_name);
        }
        if let Some(new_uri) = new_uri {
            builder.new_uri(new_uri);
        }
        let instruction = builder.instruction();

        let account_infos = [
            ctx.accounts.receipt_asset.to_account_info(),
            ctx.accounts.collection.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.receipt_authority.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
        ];

        let global_config_key = ctx.accounts.global_config.key();
        let seeds = [
            SEED_RECEIPT_AUTHORITY,
            global_config_key.as_ref(),
            &[receipt_authority_bump],
        ];

        solana_program::program::invoke_signed(&instruction, &account_infos, &[&seeds])
            .map_err(Into::into)
    }

    /// Test-only fixture that creates and prefunds a SYSTEM-OWNED
    /// ReceiptFunder PDA for a given Position. The PDA address is derived by
    /// Rodeo, but it is owned by the System Program so that MPL Core can
    /// debit it as the `payer` in `CreateV2`/`BurnV1` and Rodeo can still
    /// sign for it via `invoke_signed`.
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_create_receipt_funder(
        ctx: Context<TestFixtureCreateReceiptFunder>,
        funding_lamports: u64,
    ) -> Result<()> {
        let (funder, funder_bump) = receipt_funder_pda(&ctx.accounts.position.key());
        require_keys_eq!(
            ctx.accounts.funder.key(),
            funder,
            RodeoError::InvalidCoreAssetOwner
        );

        // Create a System-Program-owned PDA with zero data and the requested
        // funding. The caller pays the `from` side; Rodeo signs for the `to`
        // PDA. Ownership by the System Program is the key detail that lets
        // MPL Core use the PDA as a `payer`.
        let create_ix = solana_program::system_instruction::create_account(
            ctx.accounts.authority.key,
            &funder,
            funding_lamports,
            0,
            &solana_program::system_program::ID,
        );
        let account_infos = [
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.funder.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ];
        let position_key = ctx.accounts.position.key();
        let funder_seeds = [SEED_RECEIPT_FUNDER, position_key.as_ref(), &[funder_bump]];

        solana_program::program::invoke_signed(&create_ix, &account_infos, &[&funder_seeds])
            .map_err(Into::into)
    }

    /// Test-only fixture that creates a PositionReceipt inside the official
    /// Rodeo Collection using a prefunded Rodeo-owned ReceiptFunder PDA as
    /// the MPL Core `CreateV2` payer. Proves that a user-prefunded PDA can
    /// pay Core rent and that Rodeo can sign for it.
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_create_position_receipt_in_collection_via_funder(
        ctx: Context<TestFixtureCreatePositionReceiptInCollectionViaFunder>,
        name: String,
        uri: String,
    ) -> Result<()> {
        let (receipt_authority, receipt_authority_bump) =
            receipt_authority_pda(&ctx.accounts.global_config.key());
        let (receipt_asset, receipt_asset_bump) =
            position_receipt_pda(&ctx.accounts.position.key());
        let (collection, _collection_bump) =
            receipt_collection_pda(&ctx.accounts.global_config.key());
        let (funder, funder_bump) = receipt_funder_pda(&ctx.accounts.position.key());

        require_keys_eq!(
            ctx.accounts.receipt_authority.key(),
            receipt_authority,
            RodeoError::InvalidCoreAssetOwner
        );
        require_keys_eq!(
            ctx.accounts.receipt_asset.key(),
            receipt_asset,
            RodeoError::InvalidCoreAssetOwner
        );
        require_keys_eq!(
            ctx.accounts.collection.key(),
            collection,
            RodeoError::InvalidCoreAssetOwner
        );
        require_keys_eq!(
            ctx.accounts.funder.key(),
            funder,
            RodeoError::InvalidCoreAssetOwner
        );

        let plugins = vec![
            PluginAuthorityPair {
                plugin: Plugin::PermanentTransferDelegate(
                    mpl_core::types::PermanentTransferDelegate {},
                ),
                authority: Some(PluginAuthority::Address {
                    address: receipt_authority,
                }),
            },
            PluginAuthorityPair {
                plugin: Plugin::PermanentBurnDelegate(mpl_core::types::PermanentBurnDelegate {}),
                authority: Some(PluginAuthority::Address {
                    address: receipt_authority,
                }),
            },
            PluginAuthorityPair {
                plugin: Plugin::PermanentFreezeDelegate(mpl_core::types::PermanentFreezeDelegate {
                    frozen: true,
                }),
                authority: Some(PluginAuthority::Address {
                    address: receipt_authority,
                }),
            },
        ];

        let instruction = CreateV2Builder::new()
            .asset(receipt_asset)
            .collection(Some(collection))
            .authority(Some(receipt_authority))
            .payer(funder)
            .owner(Some(ctx.accounts.asset_owner.key()))
            .system_program(solana_program::system_program::ID)
            .data_state(DataState::AccountState)
            .name(name)
            .uri(uri)
            .plugins(plugins)
            .instruction();

        let account_infos = [
            ctx.accounts.receipt_asset.to_account_info(),
            ctx.accounts.collection.to_account_info(),
            ctx.accounts.receipt_authority.to_account_info(),
            ctx.accounts.funder.to_account_info(),
            ctx.accounts.asset_owner.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
        ];

        let global_config_key = ctx.accounts.global_config.key();
        let position_key = ctx.accounts.position.key();
        let receipt_authority_seeds = [
            SEED_RECEIPT_AUTHORITY,
            global_config_key.as_ref(),
            &[receipt_authority_bump],
        ];
        let receipt_asset_seeds = [
            SEED_POSITION_RECEIPT,
            position_key.as_ref(),
            &[receipt_asset_bump],
        ];
        let funder_seeds = [SEED_RECEIPT_FUNDER, position_key.as_ref(), &[funder_bump]];

        solana_program::program::invoke_signed(
            &instruction,
            &account_infos,
            &[
                &receipt_authority_seeds,
                &receipt_asset_seeds,
                &funder_seeds,
            ],
        )
        .map_err(Into::into)
    }

    /// Test-only fixture that force-burns a collection-member PositionReceipt,
    /// using the System-Program-owned ReceiptFunder PDA as the MPL Core
    /// `BurnV1` payer. Proves the burn refund lands in the funder PDA.
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_force_burn_position_receipt_in_collection(
        ctx: Context<TestFixtureForceBurnPositionReceiptInCollection>,
    ) -> Result<()> {
        let (receipt_authority, receipt_authority_bump) =
            receipt_authority_pda(&ctx.accounts.global_config.key());
        let (funder, funder_bump) = receipt_funder_pda(&ctx.accounts.position.key());

        require_keys_eq!(
            ctx.accounts.receipt_authority.key(),
            receipt_authority,
            RodeoError::InvalidCoreAssetOwner
        );
        require_keys_eq!(
            ctx.accounts.funder.key(),
            funder,
            RodeoError::InvalidCoreAssetOwner
        );

        let instruction = BurnV1Builder::new()
            .asset(*ctx.accounts.receipt_asset.key)
            .collection(Some(*ctx.accounts.collection.key))
            .authority(Some(receipt_authority))
            .payer(funder)
            .system_program(Some(solana_program::system_program::ID))
            .instruction();

        let account_infos = [
            ctx.accounts.receipt_asset.to_account_info(),
            ctx.accounts.collection.to_account_info(),
            ctx.accounts.funder.to_account_info(),
            ctx.accounts.receipt_authority.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
        ];

        let global_config_key = ctx.accounts.global_config.key();
        let position_key = ctx.accounts.position.key();
        let receipt_authority_seeds = [
            SEED_RECEIPT_AUTHORITY,
            global_config_key.as_ref(),
            &[receipt_authority_bump],
        ];
        let funder_seeds = [SEED_RECEIPT_FUNDER, position_key.as_ref(), &[funder_bump]];

        solana_program::program::invoke_signed(
            &instruction,
            &account_infos,
            &[&receipt_authority_seeds, &funder_seeds],
        )
        .map_err(Into::into)
    }

    /// Test-only fixture that closes a Rodeo-owned ReceiptFunder PDA, sending
    /// its remaining lamports to the `beneficiary` (usually the original
    /// Position owner). Proves the timeout/no-reveal refund path is
    /// recoverable.
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_close_receipt_funder(
        ctx: Context<TestFixtureCloseReceiptFunder>,
    ) -> Result<()> {
        let (funder, funder_bump) = receipt_funder_pda(&ctx.accounts.position.key());
        require_keys_eq!(
            ctx.accounts.funder.key(),
            funder,
            RodeoError::InvalidCoreAssetOwner
        );

        let funder_lamports = ctx.accounts.funder.to_account_info().lamports();

        // Transfer all lamports to the beneficiary. The transaction fee is
        // paid by `authority` (Rodeo caller), not the funder, so the funder
        // balance is exhausted. The PDA is System-Program-owned, so a signed
        // `transfer` CPI from the funder is valid.
        if funder_lamports > 0 {
            let transfer_ix = solana_program::system_instruction::transfer(
                &funder,
                ctx.accounts.beneficiary.key,
                funder_lamports,
            );
            let account_infos = [
                ctx.accounts.funder.to_account_info(),
                ctx.accounts.beneficiary.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ];
            let position_key = ctx.accounts.position.key();
            let funder_seeds = [SEED_RECEIPT_FUNDER, position_key.as_ref(), &[funder_bump]];
            solana_program::program::invoke_signed(&transfer_ix, &account_infos, &[&funder_seeds])?;
        }

        Ok(())
    }

    /// Test-only fixture that transitions a collection-member PositionReceipt's
    /// `UpdateAuthority` to `None` using the collection-level ReceiptAuthority
    /// PDA, then proves the asset can no longer have its metadata updated.
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_relinquish_update_authority(
        ctx: Context<TestFixtureRelinquishUpdateAuthority>,
    ) -> Result<()> {
        let (receipt_authority, receipt_authority_bump) =
            receipt_authority_pda(&ctx.accounts.global_config.key());

        let instruction = UpdateV1Builder::new()
            .asset(*ctx.accounts.receipt_asset.key)
            .collection(Some(*ctx.accounts.collection.key))
            .payer(ctx.accounts.authority.key())
            .authority(Some(receipt_authority))
            .system_program(solana_program::system_program::ID)
            .new_update_authority(mpl_core::types::UpdateAuthority::None)
            .instruction();

        let account_infos = [
            ctx.accounts.receipt_asset.to_account_info(),
            ctx.accounts.collection.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.receipt_authority.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
        ];

        let global_config_key = ctx.accounts.global_config.key();
        let seeds = [
            SEED_RECEIPT_AUTHORITY,
            global_config_key.as_ref(),
            &[receipt_authority_bump],
        ];

        solana_program::program::invoke_signed(&instruction, &account_infos, &[&seeds])
            .map_err(Into::into)
    }

    /// Test-only fixture that parses a PositionReceipt Core asset and emits a
    /// `PositionReceiptParsed` event. Proves manual, non-Anchor Core parsing.
    #[cfg(feature = "test-fixtures")]
    pub fn test_fixture_parse_position_receipt(
        ctx: Context<TestFixtureParsePositionReceipt>,
    ) -> Result<()> {
        let asset = parse_core_asset(&ctx.accounts.receipt_asset.to_account_info())?;
        let owner = asset.owner.ok_or(RodeoError::InvalidCoreAssetOwner)?;

        let permanent_transfer = asset.plugins.get(&PluginType::PermanentTransferDelegate);
        let permanent_burn = asset.plugins.get(&PluginType::PermanentBurnDelegate);
        let permanent_freeze = asset.plugins.get(&PluginType::PermanentFreezeDelegate);

        let frozen = match permanent_freeze {
            Some(p) => match &p.data {
                Plugin::PermanentFreezeDelegate(inner) => inner.frozen,
                _ => false,
            },
            None => false,
        };

        // Localnet tests load only the production IDL (test-fixture
        // instructions/events are never part of it), so this event cannot be
        // decoded client-side via `addEventListener`. These `msg!` lines are
        // the only way for the TS proof tests to read back the values that
        // were actually parsed from the on-chain Core account, without
        // hand-rolling a byte-level MPL Core account decoder in TypeScript.
        // They report exactly the same values the event above carries.
        msg!("receipt_owner:{}", owner);
        msg!("receipt_frozen:{}", frozen);
        msg!("receipt_name:{}", asset.name);
        msg!("receipt_uri:{}", asset.uri);
        msg!(
            "receipt_update_authority:{}",
            format_update_authority(&asset.update_authority)
        );
        msg!(
            "receipt_has_permanent_transfer_delegate:{}",
            permanent_transfer.is_some()
        );
        msg!(
            "receipt_has_permanent_burn_delegate:{}",
            permanent_burn.is_some()
        );
        msg!(
            "receipt_has_permanent_freeze_delegate:{}",
            permanent_freeze.is_some()
        );
        msg!(
            "receipt_permanent_transfer_authority:{}",
            format_plugin_authority(permanent_transfer.map(|p| p.authority.clone()))
        );
        msg!(
            "receipt_permanent_burn_authority:{}",
            format_plugin_authority(permanent_burn.map(|p| p.authority.clone()))
        );
        msg!(
            "receipt_permanent_freeze_authority:{}",
            format_plugin_authority(permanent_freeze.map(|p| p.authority.clone()))
        );

        emit!(PositionReceiptParsed {
            receipt_asset: *ctx.accounts.receipt_asset.key,
            owner,
            has_permanent_transfer_delegate: permanent_transfer.is_some(),
            has_permanent_burn_delegate: permanent_burn.is_some(),
            has_permanent_freeze_delegate: permanent_freeze.is_some(),
            frozen,
            permanent_transfer_authority: permanent_transfer
                .map(|p| ReceiptPluginAuthority::from(p.authority.clone())),
            permanent_burn_authority: permanent_burn
                .map(|p| ReceiptPluginAuthority::from(p.authority.clone())),
            permanent_freeze_authority: permanent_freeze
                .map(|p| ReceiptPluginAuthority::from(p.authority.clone())),
        });

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
    pub global_config: Box<Account<'info, GlobalConfig>>,
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
pub struct TestFixtureRecognizeRewards<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_REWARD_STATE, global_config.key().as_ref()],
        bump = reward_state.bump,
    )]
    pub reward_state: Box<Account<'info, RewardState>>,

    #[account(
        mut,
        token::mint = global_config.ansem_mint,
        token::authority = global_config,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = global_config.ansem_mint,
        token::authority = authority,
    )]
    pub payer_ansem_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
#[instruction(position_id: u64)]
pub struct TestFixturePreparePosition<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_REWARD_STATE, global_config.key().as_ref()],
        bump = reward_state.bump,
    )]
    pub reward_state: Box<Account<'info, RewardState>>,

    #[account(
        mut,
        seeds = [SEED_BULL_ACCUMULATOR, global_config.key().as_ref()],
        bump = bull_accumulator.bump,
    )]
    pub bull_accumulator: Box<Account<'info, BullAccumulator>>,

    #[account(
        mut,
        seeds = [SEED_POSITION, global_config.key().as_ref(), &position_id.to_le_bytes()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
#[instruction(next_position_id: u64)]
pub struct TestFixtureAdvanceNextPositionId<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_GLOBAL_GAME_STATE, global_config.key().as_ref()],
        bump = global_game_state.bump,
    )]
    pub global_game_state: Box<Account<'info, GlobalGameState>>,
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
#[instruction(config_version: u64)]
pub struct CreateProtocolConfigFixture<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [
            SEED_PROTOCOL_CONFIG,
            global_config.key().as_ref(),
            &config_version.to_le_bytes(),
        ],
        bump,
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
pub struct SetCurrentConfigVersionFixture<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        seeds = [
            SEED_PROTOCOL_CONFIG,
            global_config.key().as_ref(),
            &protocol_config.config_version.to_le_bytes(),
        ],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
#[instruction(
    position_id: u64,
    cowboy_accrual_remainder_scaled: u128,
    bull_accrual_remainder_scaled: u128,
    last_cowboy_reward_index: u128,
    last_bull_reward_per_weight: u128
)]
pub struct TestFixtureSetPositionRemainders<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_POSITION, global_config.key().as_ref(), &position_id.to_le_bytes()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
#[allow(clippy::too_many_arguments)]
#[instruction(
    cowboy_orphaned_accrual_remainder_scaled: u128,
    bull_orphaned_accrual_remainder_scaled: u128,
    cowboy_unmaterialized_liability_atomic: u64,
    bull_pool_liability_atomic: u64,
    total_ansem_liability_atomic: u64,
    recognized_reward_balance_atomic: u64,
    last_closed_epoch_timestamp: i64,
    epoch_started_at: i64
)]
pub struct TestFixtureSetOrphanedRemainder<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_REWARD_STATE, global_config.key().as_ref()],
        bump = reward_state.bump,
    )]
    pub reward_state: Box<Account<'info, RewardState>>,

    #[account(
        mut,
        seeds = [SEED_BULL_ACCUMULATOR, global_config.key().as_ref()],
        bump = bull_accumulator.bump,
    )]
    pub bull_accumulator: Box<Account<'info, BullAccumulator>>,
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
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        init,
        payer = payer,
        space = 8 + RewardState::INIT_SPACE,
        seeds = [SEED_REWARD_STATE, global_config.key().as_ref()],
        bump
    )]
    pub reward_state: Box<Account<'info, RewardState>>,

    #[account(
        init,
        payer = payer,
        space = 8 + GlobalGameState::INIT_SPACE,
        seeds = [SEED_GLOBAL_GAME_STATE, global_config.key().as_ref()],
        bump
    )]
    pub global_game_state: Box<Account<'info, GlobalGameState>>,

    #[account(
        init,
        payer = payer,
        space = 8 + BullAccumulator::INIT_SPACE,
        seeds = [SEED_BULL_ACCUMULATOR, global_config.key().as_ref()],
        bump
    )]
    pub bull_accumulator: Box<Account<'info, BullAccumulator>>,

    #[account(
        init,
        payer = payer,
        space = 8 + BullRegistry::INIT_SPACE,
        seeds = [SEED_BULL_REGISTRY, global_config.key().as_ref()],
        bump
    )]
    pub bull_registry: Box<Account<'info, BullRegistry>>,

    #[account(
        init,
        payer = payer,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [SEED_PROTOCOL_CONFIG, global_config.key().as_ref(), &[1, 0, 0, 0, 0, 0, 0, 0]],
        bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

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

    /// CHECK: The official Rodeo PositionReceipt Collection PDA. Created by
    /// `initialize_protocol` via the MPL Core `CreateCollectionV2` CPI.
    #[account(
        mut,
        seeds = [SEED_RECEIPT_COLLECTION, global_config.key().as_ref()],
        bump,
    )]
    pub receipt_collection: UncheckedAccount<'info>,

    /// CHECK: Stateless ReceiptAuthority PDA used as the collection update
    /// authority and as the signer for all receipt lifecycle actions.
    #[account(
        seeds = [SEED_RECEIPT_AUTHORITY, global_config.key().as_ref()],
        bump,
    )]
    pub receipt_authority: UncheckedAccount<'info>,

    /// CHECK: MPL Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

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
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        seeds = [
            SEED_PROTOCOL_CONFIG,
            global_config.key().as_ref(),
            &global_config.current_config_version.to_le_bytes(),
        ],
        bump = protocol_config.bump,
        constraint = protocol_config.config_version == global_config.current_config_version @ RodeoError::InvalidProbabilityTable,
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

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
    pub position: Box<Account<'info, Position>>,

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
    pub pending_randomness: Box<Account<'info, PendingRandomness>>,

    #[account(
        seeds = [SEED_REWARD_STATE, global_config.key().as_ref()],
        bump = reward_state.bump,
    )]
    pub reward_state: Box<Account<'info, RewardState>>,

    #[account(
        mut,
        seeds = [SEED_GLOBAL_GAME_STATE, global_config.key().as_ref()],
        bump = global_game_state.bump,
    )]
    pub global_game_state: Box<Account<'info, GlobalGameState>>,

    #[account(
        seeds = [SEED_BULL_REGISTRY, global_config.key().as_ref()],
        bump = bull_registry.bump,
    )]
    pub bull_registry: Box<Account<'info, BullRegistry>>,

    /// CHECK: The System-Program-owned ReceiptFunder PDA for this Position.
    /// Created and prefunded by the player during stake_and_commit; it is
    /// later used as the MPL Core payer for receipt create/burn.
    #[account(
        mut,
        seeds = [SEED_RECEIPT_FUNDER, position.key().as_ref()],
        bump,
    )]
    pub receipt_funder: UncheckedAccount<'info>,

    /// CHECK: Switchboard On-Demand randomness account used for the reveal.
    /// Required in production builds; ignored when the `mock-randomness` feature is enabled.
    pub provider_randomness_account: Option<AccountInfo<'info>>,

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
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_GLOBAL_GAME_STATE, global_config.key().as_ref()],
        bump = global_game_state.bump,
    )]
    pub global_game_state: Box<Account<'info, GlobalGameState>>,

    #[account(
        mut,
        seeds = [SEED_REWARD_STATE, global_config.key().as_ref()],
        bump = reward_state.bump,
    )]
    pub reward_state: Box<Account<'info, RewardState>>,

    #[account(
        mut,
        seeds = [SEED_BULL_ACCUMULATOR, global_config.key().as_ref()],
        bump = bull_accumulator.bump,
    )]
    pub bull_accumulator: Box<Account<'info, BullAccumulator>>,

    #[account(
        mut,
        seeds = [SEED_BULL_REGISTRY, global_config.key().as_ref()],
        bump = bull_registry.bump,
    )]
    pub bull_registry: Box<Account<'info, BullRegistry>>,

    #[account(
        mut,
        seeds = [SEED_POSITION, global_config.key().as_ref(), &position.position_id.to_le_bytes()],
        bump = position.bump,
        constraint = position.pending_action_active @ RodeoError::PendingActionConflict,
        constraint = position.pending_action_type == ActionType::Reveal @ RodeoError::WrongActionType,
    )]
    pub position: Box<Account<'info, Position>>,

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
    pub pending_randomness: Box<Account<'info, PendingRandomness>>,

    /// Proof buffer is optional.  It is required when mint theft or new-Bull
    /// current-mutation proof data is needed, and must be omitted when no
    /// proof is required.
    #[account(mut)]
    pub bull_proof_buffer: Option<Box<Account<'info, BullProofBuffer>>>,

    /// CHECK: Receives the proof-buffer rent refund when a buffer is consumed.
    #[account(mut)]
    pub refund_recipient: Option<AccountInfo<'info>>,

    #[account(
        seeds = [
            SEED_PROTOCOL_CONFIG,
            global_config.key().as_ref(),
            &pending_randomness.config_version_snapshot.to_le_bytes(),
        ],
        bump = protocol_config.bump,
        constraint = protocol_config.config_version == pending_randomness.config_version_snapshot @ RodeoError::InvalidProbabilityTable,
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: Account receives reclaimed rent and is validated against the position owner.
    /// Also used as the embedded Core asset owner for the PositionReceipt.
    #[account(mut, constraint = owner.key() == position.owner @ RodeoError::InvalidOwner)]
    pub owner: AccountInfo<'info>,

    /// CHECK: The new Core Asset account at the PositionReceipt PDA.
    #[account(
        mut,
        seeds = [SEED_POSITION_RECEIPT, position.key().as_ref()],
        bump,
    )]
    pub receipt_asset: UncheckedAccount<'info>,

    /// CHECK: The official Rodeo receipt Collection this asset is created into.
    #[account(
        mut,
        seeds = [SEED_RECEIPT_COLLECTION, global_config.key().as_ref()],
        bump,
    )]
    pub receipt_collection: UncheckedAccount<'info>,

    /// CHECK: Stateless ReceiptAuthority PDA used as the Core plugin authority
    /// and asset-creation authority.
    #[account(
        seeds = [SEED_RECEIPT_AUTHORITY, global_config.key().as_ref()],
        bump,
    )]
    pub receipt_authority: UncheckedAccount<'info>,

    /// CHECK: The ReceiptFunder PDA paying MPL Core `CreateV2` rent.
    #[account(
        mut,
        seeds = [SEED_RECEIPT_FUNDER, position.key().as_ref()],
        bump,
    )]
    pub receipt_funder: UncheckedAccount<'info>,

    /// CHECK: MPL Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    /// CHECK: Switchboard On-Demand randomness account used to settle the reveal.
    /// Required in production builds; ignored when the `mock-randomness` feature is enabled.
    pub provider_randomness_account: Option<AccountInfo<'info>>,

    pub system_program: Program<'info, System>,
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
    pub position: Box<Account<'info, Position>>,

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
    pub pending_randomness: Box<Account<'info, PendingRandomness>>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

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
    /// Also receives the unused ReceiptFunder reserve when the reveal times out.
    #[account(mut)]
    pub owner: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [SEED_GLOBAL_GAME_STATE, global_config.key().as_ref()],
        bump = global_game_state.bump,
    )]
    pub global_game_state: Box<Account<'info, GlobalGameState>>,

    /// CHECK: The prefunded ReceiptFunder PDA, closed and refunded to `owner`
    /// because the reveal was never completed and no receipt was created.
    #[account(
        mut,
        seeds = [SEED_RECEIPT_FUNDER, position.key().as_ref()],
        bump,
    )]
    pub receipt_funder: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
#[instruction(max_epochs: u8)]
pub struct CloseEpochs<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_REWARD_STATE, global_config.key().as_ref()],
        bump = reward_state.bump,
    )]
    pub reward_state: Box<Account<'info, RewardState>>,

    #[account(
        seeds = [SEED_GLOBAL_GAME_STATE, global_config.key().as_ref()],
        bump = global_game_state.bump,
    )]
    pub global_game_state: Box<Account<'info, GlobalGameState>>,

    #[account(
        mut,
        seeds = [SEED_BULL_ACCUMULATOR, global_config.key().as_ref()],
        bump = bull_accumulator.bump,
    )]
    pub bull_accumulator: Box<Account<'info, BullAccumulator>>,

    #[account(
        mut,
        constraint = reward_vault.key() == global_config.reward_vault @ RodeoError::InvalidRewardVault,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
#[instruction(amount: u64)]
pub struct RecognizeRewards<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_REWARD_STATE, global_config.key().as_ref()],
        bump = reward_state.bump,
    )]
    pub reward_state: Box<Account<'info, RewardState>>,

    #[account(
        constraint = reward_vault.key() == global_config.reward_vault @ RodeoError::InvalidRewardVault,
        constraint = reward_vault.mint == global_config.ansem_mint @ RodeoError::InvalidAnsemMint,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct ClaimPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_REWARD_STATE, global_config.key().as_ref()],
        bump = reward_state.bump,
    )]
    pub reward_state: Box<Account<'info, RewardState>>,

    #[account(
        mut,
        seeds = [SEED_GLOBAL_GAME_STATE, global_config.key().as_ref()],
        bump = global_game_state.bump,
    )]
    pub global_game_state: Box<Account<'info, GlobalGameState>>,

    #[account(
        mut,
        seeds = [SEED_BULL_ACCUMULATOR, global_config.key().as_ref()],
        bump = bull_accumulator.bump,
    )]
    pub bull_accumulator: Box<Account<'info, BullAccumulator>>,

    #[account(
        mut,
        seeds = [SEED_POSITION, global_config.key().as_ref(), &position.position_id.to_le_bytes()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + WalletClaimCooldown::INIT_SPACE,
        seeds = [SEED_CLAIM_COOLDOWN, global_config.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub wallet_claim_cooldown: Account<'info, WalletClaimCooldown>,

    #[account(
        mut,
        constraint = reward_vault.key() == global_config.reward_vault @ RodeoError::InvalidRewardVault,
        constraint = reward_vault.mint == global_config.ansem_mint @ RodeoError::InvalidAnsemMint,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = owner_ansem_account.mint == global_config.ansem_mint @ RodeoError::InvalidRewardDestination,
        constraint = owner_ansem_account.owner == owner.key() @ RodeoError::InvalidRewardDestination,
    )]
    pub owner_ansem_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct RequestUnstake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        seeds = [
            SEED_PROTOCOL_CONFIG,
            global_config.key().as_ref(),
            &global_config.current_config_version.to_le_bytes(),
        ],
        bump = protocol_config.bump,
        constraint = protocol_config.config_version == global_config.current_config_version @ RodeoError::InvalidProbabilityTable,
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [SEED_POSITION, global_config.key().as_ref(), &position.position_id.to_le_bytes()],
        bump = position.bump,
        constraint = position.status == PositionStatus::Active @ RodeoError::InvalidRole,
        constraint = !position.pending_action_active @ RodeoError::PendingActionConflict,
        constraint = position.owner == owner.key() @ RodeoError::InvalidOwner,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        init,
        payer = owner,
        space = 8 + PendingRandomness::INIT_SPACE,
        seeds = [
            SEED_RANDOMNESS,
            position.key().as_ref(),
            &[ActionType::Unstake as u8],
            &position.next_action_nonce.to_le_bytes(),
        ],
        bump
    )]
    pub pending_randomness: Box<Account<'info, PendingRandomness>>,

    #[account(
        mut,
        seeds = [SEED_REWARD_STATE, global_config.key().as_ref()],
        bump = reward_state.bump,
    )]
    pub reward_state: Box<Account<'info, RewardState>>,

    #[account(
        mut,
        seeds = [SEED_BULL_ACCUMULATOR, global_config.key().as_ref()],
        bump = bull_accumulator.bump,
    )]
    pub bull_accumulator: Box<Account<'info, BullAccumulator>>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct SettleUnstake<'info> {
    #[account(mut)]
    pub settler: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_GLOBAL_GAME_STATE, global_config.key().as_ref()],
        bump = global_game_state.bump,
    )]
    pub global_game_state: Box<Account<'info, GlobalGameState>>,

    #[account(
        mut,
        seeds = [SEED_REWARD_STATE, global_config.key().as_ref()],
        bump = reward_state.bump,
    )]
    pub reward_state: Box<Account<'info, RewardState>>,

    #[account(
        mut,
        seeds = [SEED_BULL_ACCUMULATOR, global_config.key().as_ref()],
        bump = bull_accumulator.bump,
    )]
    pub bull_accumulator: Box<Account<'info, BullAccumulator>>,

    #[account(
        mut,
        close = owner,
        seeds = [SEED_POSITION, global_config.key().as_ref(), &position.position_id.to_le_bytes()],
        bump = position.bump,
        constraint = position.status == PositionStatus::Active @ RodeoError::InvalidRole,
        constraint = position.pending_action_active @ RodeoError::PendingActionConflict,
        constraint = position.pending_action_type == ActionType::Unstake @ RodeoError::WrongActionType,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        close = owner,
        seeds = [
            SEED_RANDOMNESS,
            position.key().as_ref(),
            &[ActionType::Unstake as u8],
            &position.pending_action_nonce.to_le_bytes(),
        ],
        bump = pending_randomness.bump,
        constraint = pending_randomness.position == position.key() @ RodeoError::InvalidPendingRandomness,
        constraint = pending_randomness.action_type == ActionType::Unstake @ RodeoError::WrongActionType,
        constraint = pending_randomness.action_nonce == position.pending_action_nonce @ RodeoError::InvalidPendingRandomness,
    )]
    pub pending_randomness: Box<Account<'info, PendingRandomness>>,

    #[account(
        seeds = [
            SEED_PROTOCOL_CONFIG,
            global_config.key().as_ref(),
            &pending_randomness.config_version_snapshot.to_le_bytes(),
        ],
        bump = protocol_config.bump,
        constraint = protocol_config.config_version == pending_randomness.config_version_snapshot @ RodeoError::InvalidProbabilityTable,
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [SEED_PRINCIPAL_VAULT],
        bump = global_config.principal_vault_bump,
        constraint = principal_vault.mint == global_config.rodeo_mint @ RodeoError::InvalidPrincipalVault,
        constraint = principal_vault.owner == global_config.key() @ RodeoError::InvalidPrincipalVault,
    )]
    pub principal_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = rodeo_mint.key() == global_config.rodeo_mint @ RodeoError::InvalidMint,
    )]
    pub rodeo_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = owner_rodeo_account.mint == global_config.rodeo_mint @ RodeoError::InvalidRodeoDestination,
        constraint = owner_rodeo_account.owner == position.owner @ RodeoError::InvalidRodeoDestination,
    )]
    pub owner_rodeo_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = reward_vault.key() == global_config.reward_vault @ RodeoError::InvalidRewardVault,
        constraint = reward_vault.mint == global_config.ansem_mint @ RodeoError::InvalidAnsemMint,
    )]
    pub reward_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = owner_ansem_account.mint == global_config.ansem_mint @ RodeoError::InvalidRewardDestination,
        constraint = owner_ansem_account.owner == position.owner @ RodeoError::InvalidRewardDestination,
    )]
    pub owner_ansem_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: Account receives reclaimed rent and is validated against the position owner.
    /// Also receives the residual ReceiptFunder SOL after receipt burn.
    #[account(mut, constraint = owner.key() == position.owner @ RodeoError::InvalidOwner)]
    pub owner: AccountInfo<'info>,

    /// CHECK: The PositionReceipt Core Asset to be burned.
    #[account(
        mut,
        seeds = [SEED_POSITION_RECEIPT, position.key().as_ref()],
        bump,
        constraint = receipt_asset.key() == position.receipt_asset @ RodeoError::InvalidCoreAssetOwner,
    )]
    pub receipt_asset: UncheckedAccount<'info>,

    /// CHECK: The official Rodeo receipt Collection this asset belongs to.
    #[account(
        mut,
        seeds = [SEED_RECEIPT_COLLECTION, global_config.key().as_ref()],
        bump,
    )]
    pub receipt_collection: UncheckedAccount<'info>,

    /// CHECK: Stateless ReceiptAuthority PDA used to sign the `BurnV1` CPI.
    #[account(
        seeds = [SEED_RECEIPT_AUTHORITY, global_config.key().as_ref()],
        bump,
    )]
    pub receipt_authority: UncheckedAccount<'info>,

    /// CHECK: The ReceiptFunder PDA that paid the create rent and receives the burn refund.
    #[account(
        mut,
        seeds = [SEED_RECEIPT_FUNDER, position.key().as_ref()],
        bump,
    )]
    pub receipt_funder: UncheckedAccount<'info>,

    /// CHECK: MPL Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct RecoverUnstakeTimeout<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_POSITION, global_config.key().as_ref(), &position.position_id.to_le_bytes()],
        bump = position.bump,
        constraint = position.status == PositionStatus::Active @ RodeoError::InvalidRole,
        constraint = position.pending_action_active @ RodeoError::PendingActionConflict,
        constraint = position.pending_action_type == ActionType::Unstake @ RodeoError::WrongActionType,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        close = owner,
        seeds = [
            SEED_RANDOMNESS,
            position.key().as_ref(),
            &[ActionType::Unstake as u8],
            &position.pending_action_nonce.to_le_bytes(),
        ],
        bump = pending_randomness.bump,
        constraint = pending_randomness.position == position.key() @ RodeoError::InvalidPendingRandomness,
        constraint = pending_randomness.action_type == ActionType::Unstake @ RodeoError::WrongActionType,
        constraint = pending_randomness.action_nonce == position.pending_action_nonce @ RodeoError::InvalidPendingRandomness,
    )]
    pub pending_randomness: Box<Account<'info, PendingRandomness>>,

    /// CHECK: Account receives reclaimed rent and is validated against the position owner.
    #[account(mut, constraint = owner.key() == position.owner @ RodeoError::InvalidOwner)]
    pub owner: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
#[instruction(action_type: ActionType, expected_payload_length: u32, nonce: u64)]
pub struct InitializeBullProof<'info> {
    #[account(mut)]
    pub prover: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        seeds = [
            SEED_POSITION,
            global_config.key().as_ref(),
            &position.position_id.to_le_bytes(),
        ],
        bump = position.bump,
        constraint = position.pending_action_active @ RodeoError::PendingActionConflict,
        constraint = position.pending_action_type == pending_randomness.action_type @ RodeoError::WrongActionType,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        seeds = [
            SEED_RANDOMNESS,
            position.key().as_ref(),
            &[pending_randomness.action_type as u8],
            &position.pending_action_nonce.to_le_bytes(),
        ],
        bump = pending_randomness.bump,
        constraint = pending_randomness.position == position.key() @ RodeoError::InvalidPendingRandomness,
        constraint = pending_randomness.action_nonce == position.pending_action_nonce @ RodeoError::InvalidPendingRandomness,
    )]
    pub pending_randomness: Box<Account<'info, PendingRandomness>>,

    #[account(
        init,
        payer = prover,
        space = 8 + BullProofBuffer::INIT_SPACE,
        seeds = [
            SEED_BULL_PROOF_BUFFER,
            pending_randomness.key().as_ref(),
            prover.key().as_ref(),
            &nonce.to_le_bytes(),
        ],
        bump,
    )]
    pub bull_proof_buffer: Box<Account<'info, BullProofBuffer>>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(nonce: u64, offset: u32, chunk: Vec<u8>)]
pub struct AppendBullProof<'info> {
    #[account(mut)]
    pub prover: Signer<'info>,

    #[account(
        mut,
        seeds = [
            SEED_BULL_PROOF_BUFFER,
            bull_proof_buffer.pending_randomness.as_ref(),
            prover.key().as_ref(),
            &nonce.to_le_bytes(),
        ],
        bump = bull_proof_buffer.bump,
        constraint = !bull_proof_buffer.finalized @ RodeoError::BullProofBufferFinalized,
        constraint = bull_proof_buffer.refund_recipient == prover.key() @ RodeoError::BullProofBufferWrongProver,
    )]
    pub bull_proof_buffer: Box<Account<'info, BullProofBuffer>>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct FinalizeBullProof<'info> {
    #[account(mut)]
    pub prover: Signer<'info>,

    #[account(
        mut,
        seeds = [
            SEED_BULL_PROOF_BUFFER,
            bull_proof_buffer.pending_randomness.as_ref(),
            prover.key().as_ref(),
            &nonce.to_le_bytes(),
        ],
        bump = bull_proof_buffer.bump,
        constraint = bull_proof_buffer.refund_recipient == prover.key() @ RodeoError::BullProofBufferWrongProver,
    )]
    pub bull_proof_buffer: Box<Account<'info, BullProofBuffer>>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CloseBullProof<'info> {
    /// CHECK: The original prover is used to re-derive the buffer PDA.
    pub prover: AccountInfo<'info>,

    #[account(
        mut,
        close = refund_recipient,
        seeds = [
            SEED_BULL_PROOF_BUFFER,
            bull_proof_buffer.pending_randomness.as_ref(),
            prover.key().as_ref(),
            &nonce.to_le_bytes(),
        ],
        bump = bull_proof_buffer.bump,
    )]
    pub bull_proof_buffer: Box<Account<'info, BullProofBuffer>>,

    /// CHECK: Receives the refunded lamports recorded in the buffer.
    #[account(mut, address = bull_proof_buffer.refund_recipient)]
    pub refund_recipient: AccountInfo<'info>,

    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct BenchmarkSparseTree<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_BULL_REGISTRY, global_config.key().as_ref()],
        bump = bull_registry.bump,
    )]
    pub bull_registry: Box<Account<'info, BullRegistry>>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
struct SparseTreeBenchmarkSnapshot {
    pub owner_tree_root: [u8; 32],
    pub total_bull_count: u64,
    pub total_buck_power: u64,
    pub registry_version: u64,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct SparseTreeBenchmarked {
    pub owner_tree_root: [u8; 32],
    pub total_bull_count: u64,
    pub total_buck_power: u64,
    pub registry_version: u64,
}

#[event]
pub struct ProtocolInitialized {
    pub global_config: Pubkey,
    pub reward_state: Pubkey,
    pub global_game_state: Pubkey,
    pub bull_accumulator: Pubkey,
    pub bull_registry: Pubkey,
    pub protocol_config: Pubkey,
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
    pub current_config_version: u64,
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
    pub registry_total_count_snapshot: u64,
    pub registry_total_power_snapshot: u64,
    pub config_version_snapshot: u64,
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
    pub config_version: u64,
}

#[event]
pub struct ReceiptCreated {
    pub position: Pubkey,
    pub position_id: u64,
    pub receipt_asset: Pubkey,
    pub owner: Pubkey,
    pub collection: Pubkey,
}

#[event]
pub struct ReceiptBurned {
    pub position: Pubkey,
    pub position_id: u64,
    pub receipt_asset: Pubkey,
    pub owner: Pubkey,
    pub collection: Pubkey,
}

#[event]
pub struct RandomnessSettled {
    pub position: Pubkey,
    pub action_type: ActionType,
    pub action_nonce: u64,
    pub settlement_nonce: u64,
    pub committed_slot: u64,
    pub committed_protocol_epoch: u64,
    pub settled_at: i64,
    pub config_version_snapshot: u64,
}

#[event]
pub struct RandomnessTimeoutRecovered {
    pub position: Pubkey,
    pub action_type: ActionType,
    pub action_nonce: u64,
    pub recovery_action: TimeoutRecoveryAction,
}

#[event]
pub struct UnstakeRequested {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub action_nonce: u64,
    pub requested_at: i64,
    pub config_version: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AnsemUnstakeFate {
    ToOwner,
    ToBullPool,
    Immune,
}

#[event]
pub struct PositionUnstaked {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub principal_amount: u64,
    pub principal_returned: u64,
    pub principal_burned: u64,
    pub ansem_fate: AnsemUnstakeFate,
    pub synchronized_ansem: u64,
    pub ansem_paid_to_owner: u64,
    pub ansem_routed_to_bull_pool: u64,
    pub settlement_nonce: u64,
    pub config_version: u64,
}

#[event]
pub struct EpochClosed {
    pub epoch: u64,
    pub cowboy_emission: u64,
    pub suit_vault_contribution: u64,
    pub free_ansem: u64,
    pub total_cowboy_weight: u128,
    pub total_bull_power: u64,
    pub recognized_reward_balance_atomic: u64,
    pub total_ansem_liability_atomic: u64,
    pub snapshot_timestamp: i64,
}

#[event]
pub struct EpochsClosed {
    pub start_epoch: u64,
    pub end_epoch: u64,
    pub epochs_processed: u64,
    pub last_closed_timestamp: i64,
}

#[event]
pub struct RewardFundingRecognized {
    pub amount_atomic: u64,
    pub recognized_reward_balance_atomic: u64,
    pub actual_reward_vault_balance: u64,
}

#[event]
pub struct PositionClaimed {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub owner_amount: u64,
    pub bull_pool_amount: u64,
}

#[event]
pub struct RewardPaid {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub amount_atomic: u64,
    pub recognized_reward_balance_atomic: u64,
    pub reason: RewardPaidReason,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum RewardPaidReason {
    CowboyClaim,
    DesperadoClaim,
    BullClaim,
    UnstakeSettlement,
    SuitReward,
}

#[event]
pub struct BullPoolContribution {
    pub epoch: u64,
    pub amount_atomic: u64,
    pub source: BullPoolSource,
}

#[event]
pub struct BullRewardDistributed {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub amount_atomic: u64,
    pub reward_per_weight_scaled: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum BullPoolSource {
    CowboyClaimTax,
    DesperadoClaimTax,
    UnstakeTheft,
}

#[event]
pub struct OrphanedRewardReleased {
    pub reward_source: OrphanedRewardSource,
    pub amount_atomic: u64,
    pub remaining_remainder_scaled: u128,
    pub total_ansem_liability_atomic_after: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum OrphanedRewardSource {
    Cowboy,
    Bull,
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
    #[msg("position_id must equal the next global position id")]
    InvalidPositionId,
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
    #[msg("Invalid epoch batch size")]
    InvalidEpochBatch,
    #[msg("No elapsed epoch to close")]
    NoElapsedEpoch,
    #[msg("Reward vault is invalid for the configured mint or authority")]
    InvalidRewardVault,
    #[msg("ANSEM mint account is invalid")]
    InvalidAnsemMint,
    #[msg("Reward destination account is invalid")]
    InvalidRewardDestination,
    #[msg("Insufficient recognized rewards for the requested operation")]
    InsufficientRecognizedRewards,
    #[msg("Liability underflow")]
    LiabilityUnderflow,
    #[msg("Invalid reward index ordering")]
    InvalidRewardIndex,
    #[msg("Position role is invalid for this operation")]
    InvalidRole,
    #[msg("Position is not yet eligible for unstake")]
    UnstakeNotEligible,
    #[msg("No unstake action is pending for this position")]
    NoPendingUnstakeAction,
    #[msg("Unstake has already been settled")]
    UnstakeAlreadySettled,
    #[msg("RODEO destination account is invalid")]
    InvalidRodeoDestination,
    #[msg("Account is not owned by the MPL Core program")]
    InvalidCoreAssetProgramOwner,
    #[msg("Failed to deserialize a Core asset account")]
    CoreAssetDeserializationFailed,
    #[msg("Missing or malformed permanent transfer delegate")]
    MissingPermanentTransferDelegate,
    #[msg("Missing or malformed permanent burn delegate")]
    MissingPermanentBurnDelegate,
    #[msg("Missing or malformed permanent freeze delegate")]
    MissingPermanentFreezeDelegate,
    #[msg("Core receipt asset is frozen")]
    CoreAssetFrozen,
    #[msg("Core receipt asset is not frozen")]
    CoreAssetNotFrozen,
    #[msg("Core receipt asset is not owned by the expected address")]
    InvalidCoreAssetOwner,
    #[msg("BullRegistry Merkle proof is malformed or incomplete")]
    BullRegistryMalformedProof,
    #[msg("BullRegistry Merkle root does not match the canonical root")]
    BullRegistryInvalidRoot,
    #[msg("BullRegistry proof leaf is not the expected empty slot")]
    BullRegistrySlotOccupied,
    #[msg("BullRegistry proof leaf is not the expected occupied slot")]
    BullRegistrySlotEmpty,
    #[msg("BullRegistry owner bucket does not match the leaf owner")]
    BullRegistryOwnerMismatch,
    #[msg("BullRegistry proof buffer is not finalized")]
    BullProofBufferNotFinalized,
    #[msg("BullRegistry proof buffer has already been consumed")]
    BullProofBufferAlreadyConsumed,
    #[msg("BullRegistry proof buffer is bound to a different account")]
    BullProofBufferBindingMismatch,
    #[msg("BullProofBuffer payload length must be greater than zero")]
    BullProofBufferEmptyPayload,
    #[msg("BullProofBuffer payload exceeds the schema maximum")]
    BullProofBufferOversized,
    #[msg("BullProofBuffer append offset is not sequential")]
    BullProofBufferOffsetGap,
    #[msg("BullProofBuffer is bound to a different Position")]
    BullProofBufferWrongPosition,
    #[msg("BullProofBuffer can only be written by the original prover")]
    BullProofBufferWrongProver,
    #[msg("BullProofBuffer has already been finalized")]
    BullProofBufferFinalized,
    #[msg("BullProofBuffer payload is incomplete or wrong length")]
    BullProofBufferIncomplete,
    #[msg("BullProofBuffer cannot be closed before expiry or consumption")]
    BullProofBufferNotAbandoned,
    #[msg("No eligible external Bull exists for this theft")]
    NoEligibleExternalBull,
    #[msg("The provided randomness account is not a valid Switchboard randomness account")]
    InvalidProviderAccount,
    #[msg("The Switchboard randomness account has not yet been revealed for this slot")]
    RandomnessNotResolved,
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

/// Require that all currently elapsed epochs have been closed.
fn require_elapsed_epochs_closed(reward_state: &RewardState, now: i64) -> Result<()> {
    let next_boundary = reward_state
        .last_closed_epoch_timestamp
        .checked_add(EPOCH_DURATION_SECONDS)
        .ok_or(RodeoError::ArithmeticOverflow)?;
    require!(now < next_boundary, RodeoError::EpochsNotClosed);
    Ok(())
}

/// Synchronize a Cowboy (or Desperado) position with the global Cowboy reward index.
fn sync_cowboy_rewards(position: &mut Position, reward_state: &mut RewardState) -> Result<()> {
    if position.role != Role::Cowboy {
        return Ok(());
    }
    require!(
        reward_state.cowboy_reward_index >= position.last_cowboy_reward_index,
        RodeoError::InvalidRewardIndex
    );

    let weight = position.accrual_weight as u128;
    let (accrued, new_remainder) = math::accrue_cowboy(
        reward_state.cowboy_reward_index,
        position.last_cowboy_reward_index,
        weight,
        position.cowboy_accrual_remainder_scaled,
        COWBOY_REWARD_INDEX_SCALE,
    )?;

    position.last_cowboy_reward_index = reward_state.cowboy_reward_index;
    position.cowboy_accrual_remainder_scaled = new_remainder;

    if accrued > 0 {
        require_gte!(
            reward_state.cowboy_unmaterialized_liability_atomic,
            accrued,
            RodeoError::LiabilityUnderflow
        );
        position.claimable_ansem_atomic =
            math::checked_add_u64(position.claimable_ansem_atomic, accrued)?;
        reward_state.cowboy_unmaterialized_liability_atomic =
            math::checked_sub_u64(reward_state.cowboy_unmaterialized_liability_atomic, accrued)?;
        reward_state.position_claimable_liability_atomic =
            math::checked_add_u64(reward_state.position_claimable_liability_atomic, accrued)?;
    }

    Ok(())
}

/// Synchronize a Bull position with the global Bull reward-per-weight accumulator.
fn sync_bull_rewards(
    position: &mut Position,
    position_key: Pubkey,
    bull_accumulator: &mut BullAccumulator,
    reward_state: &mut RewardState,
) -> Result<()> {
    if position.role != Role::Bull {
        return Ok(());
    }
    require!(
        bull_accumulator.reward_per_weight_scaled >= position.last_bull_reward_per_weight,
        RodeoError::InvalidRewardIndex
    );

    let power = position.buck_power as u128;
    let (accrued, new_remainder) = math::accrue_bull(
        bull_accumulator.reward_per_weight_scaled,
        position.last_bull_reward_per_weight,
        power,
        position.bull_accrual_remainder_scaled,
        REWARD_PER_WEIGHT_SCALE,
    )?;

    position.last_bull_reward_per_weight = bull_accumulator.reward_per_weight_scaled;
    position.bull_accrual_remainder_scaled = new_remainder;

    if accrued > 0 {
        require_gte!(
            reward_state.bull_pool_liability_atomic,
            accrued,
            RodeoError::LiabilityUnderflow
        );
        position.claimable_ansem_atomic =
            math::checked_add_u64(position.claimable_ansem_atomic, accrued)?;
        reward_state.bull_pool_liability_atomic =
            math::checked_sub_u64(reward_state.bull_pool_liability_atomic, accrued)?;
        reward_state.position_claimable_liability_atomic =
            math::checked_add_u64(reward_state.position_claimable_liability_atomic, accrued)?;

        emit!(BullRewardDistributed {
            position: position_key,
            owner: position.owner,
            amount_atomic: accrued,
            reward_per_weight_scaled: bull_accumulator.reward_per_weight_scaled,
        });
    }

    Ok(())
}

/// Route a claim-tax contribution into the Bull reward pool, updating the
/// accumulator when there is active Bull power.
fn distribute_bull_pool_contribution(
    source: BullPoolSource,
    contribution: u64,
    reward_state: &mut RewardState,
    bull_accumulator: &mut BullAccumulator,
    game_state: &GlobalGameState,
) -> Result<()> {
    if contribution == 0 {
        return Ok(());
    }

    let total_power = game_state.total_active_bull_power as u128;
    if total_power > 0 {
        let (new_index, new_remainder) = math::increment_bull_index(
            bull_accumulator.reward_per_weight_scaled,
            bull_accumulator.bull_index_remainder_scaled,
            contribution,
            total_power,
            REWARD_PER_WEIGHT_SCALE,
        )?;
        bull_accumulator.reward_per_weight_scaled = new_index;
        bull_accumulator.bull_index_remainder_scaled = new_remainder;
        reward_state.bull_pool_liability_atomic =
            math::checked_add_u64(reward_state.bull_pool_liability_atomic, contribution)?;
    } else {
        reward_state.bull_pool_unallocated_liability_atomic = math::checked_add_u64(
            reward_state.bull_pool_unallocated_liability_atomic,
            contribution,
        )?;
    }

    emit!(BullPoolContribution {
        epoch: reward_state.current_epoch,
        amount_atomic: contribution,
        source,
    });

    Ok(())
}

/// Transfer ANSEM out of the program-controlled reward vault.
fn transfer_ansem_from_vault<'info>(
    amount: u64,
    global_config: &Account<'info, GlobalConfig>,
    reward_vault: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
) -> Result<()> {
    let seeds: &[&[u8]] = &[SEED_GLOBAL_CONFIG, &[global_config.bump]];
    let signer: &[&[&[u8]]] = &[seeds];
    let transfer_ctx = CpiContext::new_with_signer(
        token_program,
        anchor_spl::token::Transfer {
            from: reward_vault,
            to: destination,
            authority: global_config.to_account_info(),
        },
        signer,
    );
    anchor_spl::token::transfer(transfer_ctx, amount)
}

/// Materialize whole-atomic ANSEM from global orphaned-remainder fields when
/// they reach their respective scales. Released ANSEM becomes free balance for
/// future epochs; no token transfer occurs and recognized balance is unchanged.
fn convert_orphaned_remainders(
    reward_state: &mut RewardState,
    bull_accumulator: &mut BullAccumulator,
) -> Result<()> {
    // Cowboy orphan materialization.
    let cowboy_whole = reward_state
        .cowboy_orphaned_accrual_remainder_scaled
        .checked_div(COWBOY_REWARD_INDEX_SCALE)
        .ok_or(RodeoError::DivisionByZero)?;
    if cowboy_whole > 0 {
        let cowboy_whole_u64 = math::u128_to_u64(cowboy_whole)?;
        require_gte!(
            reward_state.cowboy_unmaterialized_liability_atomic,
            cowboy_whole_u64,
            RodeoError::LiabilityUnderflow
        );
        let cowboy_remainder = reward_state
            .cowboy_orphaned_accrual_remainder_scaled
            .checked_rem(COWBOY_REWARD_INDEX_SCALE)
            .ok_or(RodeoError::DivisionByZero)?;

        reward_state.cowboy_orphaned_accrual_remainder_scaled = cowboy_remainder;
        reward_state.cowboy_unmaterialized_liability_atomic = math::checked_sub_u64(
            reward_state.cowboy_unmaterialized_liability_atomic,
            cowboy_whole_u64,
        )?;
        reward_state.total_ansem_liability_atomic =
            math::checked_sub_u64(reward_state.total_ansem_liability_atomic, cowboy_whole_u64)?;
        reward_state.orphaned_reward_released_atomic = math::checked_add_u64(
            reward_state.orphaned_reward_released_atomic,
            cowboy_whole_u64,
        )?;

        emit!(OrphanedRewardReleased {
            reward_source: OrphanedRewardSource::Cowboy,
            amount_atomic: cowboy_whole_u64,
            remaining_remainder_scaled: cowboy_remainder,
            total_ansem_liability_atomic_after: reward_state.total_ansem_liability_atomic,
        });
    }

    // Bull orphan materialization.
    let bull_whole = bull_accumulator
        .bull_orphaned_accrual_remainder_scaled
        .checked_div(REWARD_PER_WEIGHT_SCALE)
        .ok_or(RodeoError::DivisionByZero)?;
    if bull_whole > 0 {
        let bull_whole_u64 = math::u128_to_u64(bull_whole)?;
        require_gte!(
            reward_state.bull_pool_liability_atomic,
            bull_whole_u64,
            RodeoError::LiabilityUnderflow
        );
        let bull_remainder = bull_accumulator
            .bull_orphaned_accrual_remainder_scaled
            .checked_rem(REWARD_PER_WEIGHT_SCALE)
            .ok_or(RodeoError::DivisionByZero)?;

        bull_accumulator.bull_orphaned_accrual_remainder_scaled = bull_remainder;
        reward_state.bull_pool_liability_atomic =
            math::checked_sub_u64(reward_state.bull_pool_liability_atomic, bull_whole_u64)?;
        reward_state.total_ansem_liability_atomic =
            math::checked_sub_u64(reward_state.total_ansem_liability_atomic, bull_whole_u64)?;
        reward_state.orphaned_reward_released_atomic =
            math::checked_add_u64(reward_state.orphaned_reward_released_atomic, bull_whole_u64)?;

        emit!(OrphanedRewardReleased {
            reward_source: OrphanedRewardSource::Bull,
            amount_atomic: bull_whole_u64,
            remaining_remainder_scaled: bull_remainder,
            total_ansem_liability_atomic_after: reward_state.total_ansem_liability_atomic,
        });
    }

    Ok(())
}

fn settle_reveal_common(ctx: &mut Context<SettleReveal>, random_output: [u8; 32]) -> Result<()> {
    use crate::probability;

    let config: &ProtocolConfig = &**ctx.accounts.protocol_config;

    let position_key = ctx.accounts.position.key();
    let action_type = ctx.accounts.pending_randomness.action_type;
    let action_nonce = ctx.accounts.pending_randomness.action_nonce;
    let protocol_epoch = ctx.accounts.pending_randomness.committed_protocol_epoch;

    let role = probability::map_role(
        probability::RandomnessSampleContext {
            random_output,
            domain: probability::RandomnessDomain::Role,
            position: position_key,
            action_nonce,
        },
        config,
    )?;

    let suit = probability::map_suit(
        probability::RandomnessSampleContext {
            random_output,
            domain: probability::RandomnessDomain::Suit,
            position: position_key,
            action_nonce,
        },
        config,
    )?;

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
    position.reveal_config_version = pending_randomness.config_version_snapshot;

    pending_randomness.settled = true;

    let game_state = &mut ctx.accounts.global_game_state;
    game_state.total_completed_reveals =
        math::checked_add_u64(game_state.total_completed_reveals, 1)?;

    let active_since = position.active_since;
    let unstake_eligible_at = position.unstake_eligible_at;
    let settlement_nonce = position.settlement_nonce;
    let final_owner = position.owner;
    let config_version = position.reveal_config_version;

    match role {
        Role::Cowboy => {
            let kind = probability::map_cowboy_kind(
                probability::RandomnessSampleContext {
                    random_output,
                    domain: probability::RandomnessDomain::CowboyKind,
                    position: position_key,
                    action_nonce,
                },
                config,
            )?;
            let weight = match kind {
                CowboyKind::Rank(rank) if (4..=10).contains(&rank) => {
                    probability::accrual_weight_for_cowboy_index(config, (rank - 4) as usize)
                }
                CowboyKind::Desperado => probability::accrual_weight_for_cowboy_index(config, 7),
                _ => 0,
            };

            // Defensive: a valid map_cowboy_kind must produce either a rank or desperado.
            require!(
                weight > 0 || matches!(kind, CowboyKind::Unassigned),
                RodeoError::InvalidProbabilityOutcome
            );

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
        }
        Role::Bull => {
            let tier = probability::map_bull_tier(
                probability::RandomnessSampleContext {
                    random_output,
                    domain: probability::RandomnessDomain::BullTier,
                    position: position_key,
                    action_nonce,
                },
                config,
            )?;
            let power = probability::buck_power_for_tier(config, tier);

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
        }
        Role::Unassigned => {
            return Err(error!(RodeoError::InvalidProbabilityOutcome));
        }
    }

    // Create the collection-member PositionReceipt for the now-finalized
    // Position. The funder (prefunded by the owner at stake) pays Core rent.
    let (receipt_authority, receipt_authority_bump) =
        receipt_authority_pda(&ctx.accounts.global_config.key());
    let (receipt_asset, receipt_asset_bump) = position_receipt_pda(&position_key);
    let (collection, _collection_bump) = receipt_collection_pda(&ctx.accounts.global_config.key());
    let (funder, funder_bump) = receipt_funder_pda(&position_key);

    require_keys_eq!(
        ctx.accounts.receipt_authority.key(),
        receipt_authority,
        RodeoError::InvalidCoreAssetOwner
    );
    require_keys_eq!(
        ctx.accounts.receipt_asset.key(),
        receipt_asset,
        RodeoError::InvalidCoreAssetOwner
    );
    require_keys_eq!(
        ctx.accounts.receipt_collection.key(),
        collection,
        RodeoError::InvalidCoreAssetOwner
    );
    require_keys_eq!(
        ctx.accounts.receipt_funder.key(),
        funder,
        RodeoError::InvalidCoreAssetOwner
    );

    let name = format!("{}{}", RECEIPT_NAME_PREFIX, position.position_id);
    let uri = format!(
        "{}{}{}",
        RECEIPT_METADATA_BASE_URI, position.position_id, RECEIPT_METADATA_URI_SUFFIX
    );

    let plugins = vec![
        PluginAuthorityPair {
            plugin: Plugin::PermanentTransferDelegate(
                mpl_core::types::PermanentTransferDelegate {},
            ),
            authority: Some(PluginAuthority::Address {
                address: receipt_authority,
            }),
        },
        PluginAuthorityPair {
            plugin: Plugin::PermanentBurnDelegate(mpl_core::types::PermanentBurnDelegate {}),
            authority: Some(PluginAuthority::Address {
                address: receipt_authority,
            }),
        },
        PluginAuthorityPair {
            plugin: Plugin::PermanentFreezeDelegate(mpl_core::types::PermanentFreezeDelegate {
                frozen: true,
            }),
            authority: Some(PluginAuthority::Address {
                address: receipt_authority,
            }),
        },
    ];

    let create_ix = CreateV2Builder::new()
        .asset(receipt_asset)
        .collection(Some(collection))
        .authority(Some(receipt_authority))
        .payer(funder)
        .owner(Some(ctx.accounts.owner.key()))
        .system_program(solana_program::system_program::ID)
        .data_state(DataState::AccountState)
        .name(name)
        .uri(uri)
        .plugins(plugins)
        .instruction();

    let account_infos = [
        ctx.accounts.receipt_asset.to_account_info(),
        ctx.accounts.receipt_collection.to_account_info(),
        ctx.accounts.receipt_authority.to_account_info(),
        ctx.accounts.receipt_funder.to_account_info(),
        ctx.accounts.owner.to_account_info(),
        ctx.accounts.mpl_core_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.mpl_core_program.to_account_info(),
    ];

    let global_config_key = ctx.accounts.global_config.key();
    let receipt_authority_seeds = [
        SEED_RECEIPT_AUTHORITY,
        global_config_key.as_ref(),
        &[receipt_authority_bump],
    ];
    let receipt_asset_seeds = [
        SEED_POSITION_RECEIPT,
        position_key.as_ref(),
        &[receipt_asset_bump],
    ];
    let funder_seeds = [SEED_RECEIPT_FUNDER, position_key.as_ref(), &[funder_bump]];

    solana_program::program::invoke_signed(
        &create_ix,
        &account_infos,
        &[
            &receipt_authority_seeds,
            &receipt_asset_seeds,
            &funder_seeds,
        ],
    )
    .map_err(|e: ProgramError| Into::<Error>::into(e))?;

    position.receipt_asset = receipt_asset;

    emit!(PositionRevealed {
        position: position_key,
        role: position.role,
        cowboy_kind: position.cowboy_kind,
        bull_tier: position.bull_tier,
        suit: position.suit,
        final_owner: position.owner,
        previous_owner: None,
        stolen: false,
        receipt_asset,
        active_since,
        unstake_eligible_at,
        settlement_nonce,
        config_version,
    });

    emit!(ReceiptCreated {
        position: position_key,
        position_id: position.position_id,
        receipt_asset,
        owner: position.owner,
        collection,
    });

    emit!(RandomnessSettled {
        position: position_key,
        action_type,
        action_nonce,
        settlement_nonce,
        committed_slot: pending_randomness.committed_slot,
        committed_protocol_epoch: pending_randomness.committed_protocol_epoch,
        settled_at: now,
        config_version_snapshot: pending_randomness.config_version_snapshot,
    });

    Ok(())
}

#[cfg(feature = "mock-randomness")]
fn settle_unstake_mock(ctx: &mut Context<SettleUnstake>) -> Result<()> {
    use crate::probability;

    let config: &ProtocolConfig = &**ctx.accounts.protocol_config;

    let now = Clock::get()?.unix_timestamp;
    let position_key = ctx.accounts.position.key();
    let action_type = ctx.accounts.pending_randomness.action_type;
    let action_nonce = ctx.accounts.pending_randomness.action_nonce;
    let protocol_epoch = ctx.accounts.pending_randomness.committed_protocol_epoch;

    // Deterministic random bytes that are domain-separated and bound to the
    // position, action type, action nonce, and protocol epoch.
    let random_output = derive_commitment(position_key, action_type, action_nonce, protocol_epoch);

    let position = &mut ctx.accounts.position;
    let pending_randomness = &mut ctx.accounts.pending_randomness;

    // Final reward synchronization before disposition.
    sync_cowboy_rewards(position, &mut ctx.accounts.reward_state)?;
    sync_bull_rewards(
        position,
        position_key,
        &mut ctx.accounts.bull_accumulator,
        &mut ctx.accounts.reward_state,
    )?;

    let claimable = position.claimable_ansem_atomic;
    let principal = position.principal_amount;

    // RODEO principal settlement using the historical ProtocolConfig.
    let returned = math::floor_bps(principal, config.unstake_return_bps)?;
    let burned = math::checked_sub_u64(principal, returned)?;

    if burned > 0 {
        let seeds: &[&[u8]] = &[SEED_GLOBAL_CONFIG, &[ctx.accounts.global_config.bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.rodeo_mint.to_account_info(),
                from: ctx.accounts.principal_vault.to_account_info(),
                authority: ctx.accounts.global_config.to_account_info(),
            },
            signer,
        );
        anchor_spl::token::burn(cpi, burned)?;
    }

    if returned > 0 {
        let seeds: &[&[u8]] = &[SEED_GLOBAL_CONFIG, &[ctx.accounts.global_config.bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.principal_vault.to_account_info(),
                to: ctx.accounts.owner_rodeo_account.to_account_info(),
                authority: ctx.accounts.global_config.to_account_info(),
            },
            signer,
        );
        anchor_spl::token::transfer(transfer_ctx, returned)?;
    }

    let reward_state = &mut ctx.accounts.reward_state;
    let game_state = &mut ctx.accounts.global_game_state;
    let bull_accumulator = &mut ctx.accounts.bull_accumulator;

    let owner = position.owner;
    let settlement_nonce = math::checked_add_u64(position.settlement_nonce, 1)?;
    position.settlement_nonce = settlement_nonce;

    let ansem_fate = match position.role {
        Role::Cowboy => {
            let stolen = if position.cowboy_kind == CowboyKind::Desperado {
                false
            } else {
                probability::map_unstake_theft_flag(
                    probability::RandomnessSampleContext {
                        random_output,
                        domain: probability::RandomnessDomain::UnstakeTheft,
                        position: position_key,
                        action_nonce,
                    },
                    config,
                )?
            };

            if stolen {
                distribute_bull_pool_contribution(
                    BullPoolSource::UnstakeTheft,
                    claimable,
                    reward_state,
                    bull_accumulator,
                    &**game_state,
                )?;

                require_gte!(
                    reward_state.position_claimable_liability_atomic,
                    claimable,
                    RodeoError::LiabilityUnderflow
                );
                reward_state.position_claimable_liability_atomic = math::checked_sub_u64(
                    reward_state.position_claimable_liability_atomic,
                    claimable,
                )?;

                AnsemUnstakeFate::ToBullPool
            } else {
                if claimable > 0 {
                    require_gte!(
                        reward_state.position_claimable_liability_atomic,
                        claimable,
                        RodeoError::LiabilityUnderflow
                    );
                    require_gte!(
                        reward_state.recognized_reward_balance_atomic,
                        claimable,
                        RodeoError::InsufficientRecognizedRewards
                    );
                    require_gte!(
                        reward_state.total_ansem_liability_atomic,
                        claimable,
                        RodeoError::LiabilityUnderflow
                    );

                    transfer_ansem_from_vault(
                        claimable,
                        &*ctx.accounts.global_config,
                        ctx.accounts.reward_vault.to_account_info(),
                        ctx.accounts.owner_ansem_account.to_account_info(),
                        ctx.accounts.token_program.to_account_info(),
                    )?;

                    reward_state.position_claimable_liability_atomic = math::checked_sub_u64(
                        reward_state.position_claimable_liability_atomic,
                        claimable,
                    )?;
                    reward_state.total_ansem_liability_atomic = math::checked_sub_u64(
                        reward_state.total_ansem_liability_atomic,
                        claimable,
                    )?;
                    reward_state.recognized_reward_balance_atomic = math::checked_sub_u64(
                        reward_state.recognized_reward_balance_atomic,
                        claimable,
                    )?;
                    reward_state.ansem_claimed_atomic =
                        math::checked_add_u64(reward_state.ansem_claimed_atomic, claimable)?;

                    emit!(RewardPaid {
                        position: position_key,
                        owner,
                        amount_atomic: claimable,
                        recognized_reward_balance_atomic: reward_state
                            .recognized_reward_balance_atomic,
                        reason: RewardPaidReason::UnstakeSettlement,
                    });
                }

                if position.cowboy_kind == CowboyKind::Desperado {
                    AnsemUnstakeFate::Immune
                } else {
                    AnsemUnstakeFate::ToOwner
                }
            }
        }
        Role::Bull => {
            if claimable > 0 {
                require_gte!(
                    reward_state.position_claimable_liability_atomic,
                    claimable,
                    RodeoError::LiabilityUnderflow
                );
                require_gte!(
                    reward_state.recognized_reward_balance_atomic,
                    claimable,
                    RodeoError::InsufficientRecognizedRewards
                );
                require_gte!(
                    reward_state.total_ansem_liability_atomic,
                    claimable,
                    RodeoError::LiabilityUnderflow
                );

                transfer_ansem_from_vault(
                    claimable,
                    &*ctx.accounts.global_config,
                    ctx.accounts.reward_vault.to_account_info(),
                    ctx.accounts.owner_ansem_account.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                )?;

                reward_state.position_claimable_liability_atomic = math::checked_sub_u64(
                    reward_state.position_claimable_liability_atomic,
                    claimable,
                )?;
                reward_state.total_ansem_liability_atomic =
                    math::checked_sub_u64(reward_state.total_ansem_liability_atomic, claimable)?;
                reward_state.recognized_reward_balance_atomic = math::checked_sub_u64(
                    reward_state.recognized_reward_balance_atomic,
                    claimable,
                )?;
                reward_state.ansem_claimed_atomic =
                    math::checked_add_u64(reward_state.ansem_claimed_atomic, claimable)?;

                emit!(RewardPaid {
                    position: position_key,
                    owner,
                    amount_atomic: claimable,
                    recognized_reward_balance_atomic: reward_state.recognized_reward_balance_atomic,
                    reason: RewardPaidReason::UnstakeSettlement,
                });
            }

            require_gte!(
                game_state.active_bull_count,
                1,
                RodeoError::ArithmeticUnderflow
            );
            game_state.active_bull_count = math::checked_sub_u64(game_state.active_bull_count, 1)?;
            require_gte!(
                game_state.total_active_bull_power,
                position.buck_power as u64,
                RodeoError::ArithmeticUnderflow
            );
            game_state.total_active_bull_power = math::checked_sub_u64(
                game_state.total_active_bull_power,
                position.buck_power as u64,
            )?;

            AnsemUnstakeFate::ToOwner
        }
        Role::Unassigned => {
            return Err(error!(RodeoError::InvalidRole));
        }
    };

    // Remove Cowboy/Desperado population weight if a Cowboy was handled above.
    if position.role == Role::Cowboy {
        require_gte!(
            game_state.active_cowboy_count,
            1,
            RodeoError::ArithmeticUnderflow
        );
        game_state.active_cowboy_count = math::checked_sub_u64(game_state.active_cowboy_count, 1)?;
        require_gte!(
            game_state.total_active_cowboy_weight,
            position.accrual_weight as u128,
            RodeoError::ArithmeticUnderflow
        );
        game_state.total_active_cowboy_weight = math::checked_sub_u128(
            game_state.total_active_cowboy_weight,
            position.accrual_weight as u128,
        )?;
    }

    // Move per-position accrual remainders to orphaned global remainders before close.
    if position.cowboy_accrual_remainder_scaled > 0 {
        reward_state.cowboy_orphaned_accrual_remainder_scaled = math::checked_add_u128(
            reward_state.cowboy_orphaned_accrual_remainder_scaled,
            position.cowboy_accrual_remainder_scaled,
        )?;
    }
    if position.bull_accrual_remainder_scaled > 0 {
        bull_accumulator.bull_orphaned_accrual_remainder_scaled = math::checked_add_u128(
            bull_accumulator.bull_orphaned_accrual_remainder_scaled,
            position.bull_accrual_remainder_scaled,
        )?;
    }

    // Materialize any orphaned sub-atomic remainder that has reached scale
    // after the exiting position's carry has been added.
    convert_orphaned_remainders(reward_state, bull_accumulator)?;

    // Update principal accounting and live position count.
    game_state.live_position_count = math::checked_sub_u64(game_state.live_position_count, 1)?;
    game_state.accounted_principal_atomic =
        math::checked_sub_u64(game_state.accounted_principal_atomic, principal)?;

    position.claimable_ansem_atomic = 0;
    pending_randomness.settled = true;

    // Burn the PositionReceipt and close the ReceiptFunder, returning the
    // remaining SOL reserve to the current owner. The receipt must already
    // exist (reveal was successful) because `position.receipt_asset` is set.
    let global_config_key = ctx.accounts.global_config.key();
    let (receipt_authority, receipt_authority_bump) = receipt_authority_pda(&global_config_key);
    let (collection, _collection_bump) = receipt_collection_pda(&global_config_key);
    let (funder, funder_bump) = receipt_funder_pda(&position_key);

    require_keys_eq!(
        ctx.accounts.receipt_authority.key(),
        receipt_authority,
        RodeoError::InvalidCoreAssetOwner
    );
    require_keys_eq!(
        ctx.accounts.receipt_collection.key(),
        collection,
        RodeoError::InvalidCoreAssetOwner
    );
    require_keys_eq!(
        ctx.accounts.receipt_funder.key(),
        funder,
        RodeoError::InvalidCoreAssetOwner
    );
    require_keys_eq!(
        ctx.accounts.receipt_asset.key(),
        position.receipt_asset,
        RodeoError::InvalidCoreAssetOwner
    );

    let burn_ix = BurnV1Builder::new()
        .asset(position.receipt_asset)
        .collection(Some(collection))
        .authority(Some(receipt_authority))
        .payer(funder)
        .system_program(Some(solana_program::system_program::ID))
        .instruction();

    let burn_account_infos = [
        ctx.accounts.receipt_asset.to_account_info(),
        ctx.accounts.receipt_collection.to_account_info(),
        ctx.accounts.receipt_funder.to_account_info(),
        ctx.accounts.receipt_authority.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.mpl_core_program.to_account_info(),
    ];
    let receipt_authority_seeds = [
        SEED_RECEIPT_AUTHORITY,
        global_config_key.as_ref(),
        &[receipt_authority_bump],
    ];
    let funder_seeds = [SEED_RECEIPT_FUNDER, position_key.as_ref(), &[funder_bump]];

    solana_program::program::invoke_signed(
        &burn_ix,
        &burn_account_infos,
        &[&receipt_authority_seeds, &funder_seeds],
    )
    .map_err(|e: ProgramError| Into::<Error>::into(e))?;

    let funder_lamports = ctx.accounts.receipt_funder.to_account_info().lamports();
    if funder_lamports > 0 {
        let funder_close_ix = solana_program::system_instruction::transfer(
            &funder,
            ctx.accounts.owner.key,
            funder_lamports,
        );
        let funder_close_account_infos = [
            ctx.accounts.receipt_funder.to_account_info(),
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ];
        solana_program::program::invoke_signed(
            &funder_close_ix,
            &funder_close_account_infos,
            &[&funder_seeds],
        )?;
    }

    emit!(ReceiptBurned {
        position: position_key,
        position_id: position.position_id,
        receipt_asset: position.receipt_asset,
        owner,
        collection,
    });

    position.receipt_asset = Pubkey::default();

    emit!(PositionUnstaked {
        position: position_key,
        owner,
        principal_amount: principal,
        principal_returned: returned,
        principal_burned: burned,
        ansem_fate,
        synchronized_ansem: claimable,
        ansem_paid_to_owner: if ansem_fate == AnsemUnstakeFate::ToBullPool {
            0
        } else {
            claimable
        },
        ansem_routed_to_bull_pool: if ansem_fate == AnsemUnstakeFate::ToBullPool {
            claimable
        } else {
            0
        },
        settlement_nonce,
        config_version: pending_randomness.config_version_snapshot,
    });
    emit!(RandomnessSettled {
        position: position_key,
        action_type,
        action_nonce,
        settlement_nonce,
        committed_slot: pending_randomness.committed_slot,
        committed_protocol_epoch: pending_randomness.committed_protocol_epoch,
        settled_at: now,
        config_version_snapshot: pending_randomness.config_version_snapshot,
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

    #[cfg(not(feature = "mock-randomness"))]
    use switchboard_on_demand::{Discriminator, ON_DEMAND_DEVNET_PID, ON_DEMAND_MAINNET_PID};

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
            position: Pubkey::new_from_array([tag + 7; 32]),
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
        assert_eq!(ACCOUNT_VERSION_GLOBAL_CONFIG, 2);
        assert_eq!(ACCOUNT_VERSION_REWARD_STATE, 3);
        assert_eq!(ACCOUNT_VERSION_GLOBAL_GAME_STATE, 4);
        assert_eq!(ACCOUNT_VERSION_BULL_ACCUMULATOR, 3);
        assert_eq!(ACCOUNT_VERSION_POSITION, 4);
        assert_eq!(ACCOUNT_VERSION_WALLET_CLAIM_COOLDOWN, 1);
        assert_eq!(ACCOUNT_VERSION_PENDING_RANDOMNESS, 4);
        assert_eq!(ACCOUNT_VERSION_PROTOCOL_CONFIG, 1);
    }

    #[test]
    fn account_init_space_values() {
        assert_eq!(GlobalConfig::INIT_SPACE, 266);
        assert_eq!(RewardState::INIT_SPACE, 194);
        assert_eq!(GlobalGameState::INIT_SPACE, 106);
        assert_eq!(BullAccumulator::INIT_SPACE, 82);
        assert_eq!(Position::INIT_SPACE, 239);
        assert_eq!(WalletClaimCooldown::INIT_SPACE, 74);
        assert_eq!(PendingRandomness::INIT_SPACE, 228);
        assert_eq!(ProtocolConfig::INIT_SPACE, 350);
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
        // A weight-1 position with a half-scale index delta produces no whole
        // atoms and carries the entire scaled product as a per-position remainder.
        let current = COWBOY_REWARD_INDEX_SCALE / 2;
        let last = 0;
        let weight = 1u128;
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
        let config = probability::protocol_config_v1(Pubkey::default(), 0);
        let ctx = sample_ctx(probability::RandomnessDomain::Role, 4);
        let first = probability::map_role(ctx, &config).unwrap();
        let second = probability::map_role(ctx, &config).unwrap();
        assert_eq!(first, second);
        assert!(first == state::Role::Cowboy || first == state::Role::Bull);
    }

    #[test]
    fn map_cowboy_kind_is_stable_and_valid() {
        let config = probability::protocol_config_v1(Pubkey::default(), 0);
        let ctx = sample_ctx(probability::RandomnessDomain::CowboyKind, 5);
        let kind = probability::map_cowboy_kind(ctx, &config).unwrap();
        assert!(matches!(
            kind,
            state::CowboyKind::Rank(4 | 5 | 6 | 7 | 8 | 9 | 10) | state::CowboyKind::Desperado
        ));
        assert_eq!(probability::map_cowboy_kind(ctx, &config).unwrap(), kind);
    }

    #[test]
    fn map_bull_tier_is_stable_and_valid() {
        let config = probability::protocol_config_v1(Pubkey::default(), 0);
        let ctx = sample_ctx(probability::RandomnessDomain::BullTier, 6);
        let tier = probability::map_bull_tier(ctx, &config).unwrap();
        assert!((1..=4).contains(&tier));
        assert_eq!(probability::map_bull_tier(ctx, &config).unwrap(), tier);
    }

    #[test]
    fn map_suit_is_stable_and_valid() {
        let config = probability::protocol_config_v1(Pubkey::default(), 0);
        let ctx = sample_ctx(probability::RandomnessDomain::Suit, 7);
        let suit = probability::map_suit(ctx, &config).unwrap();
        assert!(matches!(
            suit,
            state::Suit::Hearts | state::Suit::Diamonds | state::Suit::Clubs | state::Suit::Spades
        ));
        assert_eq!(probability::map_suit(ctx, &config).unwrap(), suit);
    }

    #[test]
    fn theft_flag_helpers_are_distinct_domains() {
        let config = probability::protocol_config_v1(Pubkey::default(), 0);
        let mint_ctx = sample_ctx(probability::RandomnessDomain::MintTheft, 2);
        let unstake_ctx = sample_ctx(probability::RandomnessDomain::UnstakeTheft, 3);
        // The outputs are deterministic booleans; this just verifies both helpers run.
        let _ = probability::map_mint_theft_flag(mint_ctx, &config).unwrap();
        let _ = probability::map_unstake_theft_flag(unstake_ctx, &config).unwrap();
    }

    #[test]
    fn accrual_weights_and_buck_power() {
        let config = probability::protocol_config_v1(Pubkey::default(), 0);
        assert_eq!(
            probability::accrual_weight_for_cowboy_index(&config, 0),
            10_000
        );
        assert_eq!(
            probability::accrual_weight_for_cowboy_index(&config, 6),
            15_500
        );
        assert_eq!(
            probability::accrual_weight_for_cowboy_index(&config, 3),
            11_800
        );
        assert_eq!(
            probability::accrual_weight_for_cowboy_index(&config, 7),
            10_000
        );
        assert_eq!(probability::buck_power_for_tier(&config, 1), 4);
        assert_eq!(probability::buck_power_for_tier(&config, 4), 10);
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
        assert_eq!(new_index, 100_000_000_000_000_000_000_000u128);
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
        assert_eq!(SEED_CLAIM_COOLDOWN, b"claim_cooldown");
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
        let _ = test_fixture_recognize_rewards
            as fn(Context<TestFixtureRecognizeRewards>, u64) -> Result<()>;
        let _ = test_fixture_prepare_position
            as fn(
                Context<TestFixturePreparePosition>,
                u64,
                u8,
                u8,
                u32,
                u8,
                u64,
                u64,
            ) -> Result<()>;
        let _ = test_fixture_set_position_remainders
            as fn(
                Context<TestFixtureSetPositionRemainders>,
                u64,
                u128,
                u128,
                u128,
                u128,
            ) -> Result<()>;
        let _ = test_fixture_set_orphaned_remainder
            as fn(
                Context<TestFixtureSetOrphanedRemainder>,
                u128,
                u128,
                u64,
                u64,
                u64,
                u64,
                i64,
                i64,
            ) -> Result<()>;
        let _ = test_fixture_advance_next_position_id
            as fn(Context<TestFixtureAdvanceNextPositionId>, u64) -> Result<()>;
    }

    fn dummy_position() -> state::Position {
        state::Position {
            version: ACCOUNT_VERSION_POSITION,
            owner: Pubkey::default(),
            position_id: 1,
            principal_amount: 0,
            role: state::Role::Cowboy,
            status: state::PositionStatus::Active,
            cowboy_kind: state::CowboyKind::Rank(4),
            bull_tier: 0,
            suit: state::Suit::Unassigned,
            opened_at: 0,
            active_since: 0,
            unstake_eligible_at: 0,
            accrual_weight: 10_000,
            buck_power: 0,
            last_cowboy_reward_index: 0,
            last_bull_reward_per_weight: 0,
            cowboy_accrual_remainder_scaled: 0,
            bull_accrual_remainder_scaled: 0,
            claimable_ansem_atomic: 0,
            settlement_nonce: 0,
            state_version: 0,
            listing_nonce: 0,
            receipt_asset: Pubkey::default(),
            pending_action_active: false,
            pending_action_type: state::ActionType::Reveal,
            pending_action_nonce: 0,
            next_action_nonce: 0,
            reveal_config_version: 0,
            bump: 0,
        }
    }

    fn dummy_reward_state() -> state::RewardState {
        state::RewardState {
            version: ACCOUNT_VERSION_REWARD_STATE,
            global_config: Pubkey::default(),
            current_epoch: 0,
            epoch_started_at: 0,
            last_closed_epoch_timestamp: 0,
            total_ansem_liability_atomic: 0,
            cowboy_unmaterialized_liability_atomic: 100_000,
            position_claimable_liability_atomic: 0,
            bull_pool_liability_atomic: 0,
            bull_pool_unallocated_liability_atomic: 0,
            suit_vault_liability_atomic: 0,
            recognized_reward_balance_atomic: 0,
            ansem_emitted_atomic: 0,
            ansem_claimed_atomic: 0,
            orphaned_reward_released_atomic: 0,
            cowboy_reward_index: COWBOY_REWARD_INDEX_SCALE * 5,
            cowboy_index_remainder_scaled: 0,
            cowboy_orphaned_accrual_remainder_scaled: 0,
            suit_epoch: 0,
            bump: 0,
        }
    }

    #[test]
    fn sync_cowboy_rewards_accrues_exact_amount() {
        let mut pos = dummy_position();
        let mut reward = dummy_reward_state();
        sync_cowboy_rewards(&mut pos, &mut reward).unwrap();

        // Index delta = 5 * scale; weight = 10_000 => accrued = 5 * 10_000 = 50_000.
        assert_eq!(pos.claimable_ansem_atomic, 50_000);
        assert_eq!(reward.cowboy_unmaterialized_liability_atomic, 50_000);
        assert_eq!(reward.position_claimable_liability_atomic, 50_000);
        assert_eq!(pos.last_cowboy_reward_index, reward.cowboy_reward_index);
    }

    #[test]
    fn sync_cowboy_rewards_preserves_total_liability() {
        let mut pos = dummy_position();
        let mut reward = dummy_reward_state();
        let before = reward.total_ansem_liability_atomic;
        sync_cowboy_rewards(&mut pos, &mut reward).unwrap();
        assert_eq!(reward.total_ansem_liability_atomic, before);
    }

    fn dummy_bull_accumulator() -> state::BullAccumulator {
        state::BullAccumulator {
            version: ACCOUNT_VERSION_BULL_ACCUMULATOR,
            global_config: Pubkey::default(),
            reward_per_weight_scaled: REWARD_PER_WEIGHT_SCALE * 3,
            bull_index_remainder_scaled: 0,
            bull_orphaned_accrual_remainder_scaled: 0,
            bump: 0,
        }
    }

    #[test]
    fn sync_bull_rewards_accrues_exact_amount() {
        let mut pos = dummy_position();
        pos.role = state::Role::Bull;
        pos.buck_power = 4;
        let mut reward = dummy_reward_state();
        reward.bull_pool_liability_atomic = 12;
        let mut acc = dummy_bull_accumulator();
        sync_bull_rewards(&mut pos, Pubkey::default(), &mut acc, &mut reward).unwrap();

        // Index delta = 3 * scale; power = 4 => accrued = 12.
        assert_eq!(pos.claimable_ansem_atomic, 12);
        assert_eq!(reward.bull_pool_liability_atomic, 0);
        assert_eq!(reward.position_claimable_liability_atomic, 12);
        assert_eq!(
            pos.last_bull_reward_per_weight,
            acc.reward_per_weight_scaled
        );
    }

    #[test]
    fn distribute_bull_pool_contribution_updates_accumulator() {
        let mut reward = dummy_reward_state();
        let mut acc = dummy_bull_accumulator();
        let game = state::GlobalGameState {
            version: ACCOUNT_VERSION_GLOBAL_GAME_STATE,
            global_config: Pubkey::default(),
            next_position_id: 0,
            total_completed_reveals: 0,
            live_position_count: 0,
            active_cowboy_count: 0,
            active_bull_count: 1,
            total_active_cowboy_weight: 0,
            total_active_bull_power: 4,
            accounted_principal_atomic: 0,
            bump: 0,
        };
        distribute_bull_pool_contribution(
            BullPoolSource::CowboyClaimTax,
            12,
            &mut reward,
            &mut acc,
            &game,
        )
        .unwrap();

        assert_eq!(reward.bull_pool_liability_atomic, 12);
        assert_eq!(
            acc.reward_per_weight_scaled,
            REWARD_PER_WEIGHT_SCALE * 3 + (12 * REWARD_PER_WEIGHT_SCALE / 4)
        );
    }

    #[test]
    fn derive_commitment_is_deterministic_and_domain_separated() {
        let position = Pubkey::new_from_array([1u8; 32]);
        let nonce1 = 1u64;
        let nonce2 = 2u64;
        let epoch1 = 0u64;

        let a = derive_commitment(position, ActionType::Unstake, nonce1, epoch1);
        let b = derive_commitment(position, ActionType::Unstake, nonce1, epoch1);
        let c = derive_commitment(position, ActionType::Reveal, nonce1, epoch1);
        let d = derive_commitment(position, ActionType::Unstake, nonce2, epoch1);

        assert_eq!(a, b, "same inputs must produce same commitment");
        assert_ne!(a, c, "action type changes commitment");
        assert_ne!(a, d, "action nonce changes commitment");
        assert_eq!(a.len(), 32, "commitment is a 32-byte SHA-256 digest");
    }

    #[test]
    fn map_unstake_theft_flag_is_deterministic() {
        let config = probability::protocol_config_v1(Pubkey::default(), 0);

        let context = probability::RandomnessSampleContext {
            random_output: [0u8; 32],
            domain: probability::RandomnessDomain::UnstakeTheft,
            position: Pubkey::default(),
            action_nonce: 0,
        };

        let a = probability::map_unstake_theft_flag(context, &config).unwrap();
        let b = probability::map_unstake_theft_flag(context, &config).unwrap();
        assert_eq!(a, b, "same context must produce same theft flag");
    }

    #[test]
    fn unstake_rodeo_split_uses_config_version() {
        let mut v1 = probability::protocol_config_v1(Pubkey::default(), 0);
        v1.unstake_tax_bps = 500;
        v1.unstake_return_bps = 9_500;

        let mut v2 = v1.clone();
        v2.unstake_tax_bps = 2_000;
        v2.unstake_return_bps = 8_000;

        let principal = 100_000_000_000u64;
        let v1_returned = math::floor_bps(principal, v1.unstake_return_bps).unwrap();
        let v2_returned = math::floor_bps(principal, v2.unstake_return_bps).unwrap();

        assert_eq!(v1_returned, 95_000_000_000);
        assert_eq!(v2_returned, 80_000_000_000);
        assert!(v2_returned < v1_returned, "V2 tax must return less RODEO");
    }

    #[test]
    fn convert_orphaned_remainders_cowboy_below_scale() {
        let mut reward = dummy_reward_state();
        reward.total_ansem_liability_atomic = 100_000;
        reward.cowboy_unmaterialized_liability_atomic = 100_000;
        let mut acc = dummy_bull_accumulator();
        reward.cowboy_orphaned_accrual_remainder_scaled = COWBOY_REWARD_INDEX_SCALE - 1;

        convert_orphaned_remainders(&mut reward, &mut acc).unwrap();

        assert_eq!(
            reward.cowboy_orphaned_accrual_remainder_scaled,
            COWBOY_REWARD_INDEX_SCALE - 1
        );
        assert_eq!(reward.cowboy_unmaterialized_liability_atomic, 100_000);
        assert_eq!(reward.total_ansem_liability_atomic, 100_000);
        assert_eq!(reward.orphaned_reward_released_atomic, 0);
        assert_eq!(reward.recognized_reward_balance_atomic, 0);
    }

    #[test]
    fn convert_orphaned_remainders_cowboy_exact_scale() {
        let mut reward = dummy_reward_state();
        reward.total_ansem_liability_atomic = 100_000;
        reward.cowboy_unmaterialized_liability_atomic = 100_000;
        let mut acc = dummy_bull_accumulator();
        reward.cowboy_orphaned_accrual_remainder_scaled = COWBOY_REWARD_INDEX_SCALE;

        convert_orphaned_remainders(&mut reward, &mut acc).unwrap();

        assert_eq!(reward.cowboy_orphaned_accrual_remainder_scaled, 0);
        assert_eq!(reward.cowboy_unmaterialized_liability_atomic, 100_000 - 1);
        assert_eq!(reward.total_ansem_liability_atomic, 100_000 - 1);
        assert_eq!(reward.orphaned_reward_released_atomic, 1);
        assert_eq!(reward.recognized_reward_balance_atomic, 0);
    }

    #[test]
    fn convert_orphaned_remainders_cowboy_multiple_and_remainder() {
        let mut reward = dummy_reward_state();
        reward.total_ansem_liability_atomic = 100_000;
        reward.cowboy_unmaterialized_liability_atomic = 100_000;
        let mut acc = dummy_bull_accumulator();
        reward.cowboy_orphaned_accrual_remainder_scaled = 2 * COWBOY_REWARD_INDEX_SCALE + 500;

        convert_orphaned_remainders(&mut reward, &mut acc).unwrap();

        assert_eq!(reward.cowboy_orphaned_accrual_remainder_scaled, 500);
        assert_eq!(reward.cowboy_unmaterialized_liability_atomic, 100_000 - 2);
        assert_eq!(reward.total_ansem_liability_atomic, 100_000 - 2);
        assert_eq!(reward.orphaned_reward_released_atomic, 2);
    }

    #[test]
    fn convert_orphaned_remainders_bull_below_scale() {
        let mut reward = dummy_reward_state();
        reward.total_ansem_liability_atomic = 100;
        reward.bull_pool_liability_atomic = 100;
        let mut acc = dummy_bull_accumulator();
        acc.bull_orphaned_accrual_remainder_scaled = REWARD_PER_WEIGHT_SCALE - 1;

        convert_orphaned_remainders(&mut reward, &mut acc).unwrap();

        assert_eq!(
            acc.bull_orphaned_accrual_remainder_scaled,
            REWARD_PER_WEIGHT_SCALE - 1
        );
        assert_eq!(reward.bull_pool_liability_atomic, 100);
        assert_eq!(reward.total_ansem_liability_atomic, 100);
        assert_eq!(reward.orphaned_reward_released_atomic, 0);
        assert_eq!(reward.recognized_reward_balance_atomic, 0);
    }

    #[test]
    fn convert_orphaned_remainders_bull_exact_scale() {
        let mut reward = dummy_reward_state();
        reward.total_ansem_liability_atomic = 100;
        reward.bull_pool_liability_atomic = 100;
        let mut acc = dummy_bull_accumulator();
        acc.bull_orphaned_accrual_remainder_scaled = REWARD_PER_WEIGHT_SCALE;

        convert_orphaned_remainders(&mut reward, &mut acc).unwrap();

        assert_eq!(acc.bull_orphaned_accrual_remainder_scaled, 0);
        assert_eq!(reward.bull_pool_liability_atomic, 99);
        assert_eq!(reward.total_ansem_liability_atomic, 99);
        assert_eq!(reward.orphaned_reward_released_atomic, 1);
        assert_eq!(reward.recognized_reward_balance_atomic, 0);
    }

    #[test]
    fn convert_orphaned_remainders_bull_multiple_and_remainder() {
        let mut reward = dummy_reward_state();
        reward.total_ansem_liability_atomic = 100;
        reward.bull_pool_liability_atomic = 100;
        let mut acc = dummy_bull_accumulator();
        acc.bull_orphaned_accrual_remainder_scaled = 3 * REWARD_PER_WEIGHT_SCALE + 700;

        convert_orphaned_remainders(&mut reward, &mut acc).unwrap();

        assert_eq!(acc.bull_orphaned_accrual_remainder_scaled, 700);
        assert_eq!(reward.bull_pool_liability_atomic, 97);
        assert_eq!(reward.total_ansem_liability_atomic, 97);
        assert_eq!(reward.orphaned_reward_released_atomic, 3);
    }

    #[test]
    fn convert_orphaned_remainders_underflow_protection() {
        let mut reward = dummy_reward_state();
        reward.total_ansem_liability_atomic = 0;
        reward.cowboy_unmaterialized_liability_atomic = 0;
        let mut acc = dummy_bull_accumulator();
        reward.cowboy_orphaned_accrual_remainder_scaled = COWBOY_REWARD_INDEX_SCALE;

        assert!(convert_orphaned_remainders(&mut reward, &mut acc).is_err());
    }

    #[test]
    fn convert_orphaned_remainders_overflow_protection() {
        let mut reward = dummy_reward_state();
        reward.orphaned_reward_released_atomic = u64::MAX;
        reward.total_ansem_liability_atomic = 1;
        reward.cowboy_unmaterialized_liability_atomic = 1;
        let mut acc = dummy_bull_accumulator();
        reward.cowboy_orphaned_accrual_remainder_scaled = COWBOY_REWARD_INDEX_SCALE;

        assert!(convert_orphaned_remainders(&mut reward, &mut acc).is_err());
    }

    #[test]
    fn convert_orphaned_remainders_zero_is_noop() {
        let mut reward = dummy_reward_state();
        let before_total = reward.total_ansem_liability_atomic;
        let before_released = reward.orphaned_reward_released_atomic;
        let mut acc = dummy_bull_accumulator();

        convert_orphaned_remainders(&mut reward, &mut acc).unwrap();

        assert_eq!(reward.total_ansem_liability_atomic, before_total);
        assert_eq!(reward.orphaned_reward_released_atomic, before_released);
    }

    #[cfg(not(feature = "mock-randomness"))]
    fn switchboard_randomness_account_data(
        seed_slot: u64,
        reveal_slot: u64,
        value: [u8; 32],
    ) -> Vec<u8> {
        let mut data = vec![0u8; RandomnessAccountData::size()];
        data[0..8].copy_from_slice(RandomnessAccountData::DISCRIMINATOR);
        data[8 + 96..8 + 104].copy_from_slice(&seed_slot.to_le_bytes());
        data[8 + 136..8 + 144].copy_from_slice(&reveal_slot.to_le_bytes());
        data[8 + 144..8 + 176].copy_from_slice(&value);
        data
    }

    #[test]
    #[cfg(not(feature = "mock-randomness"))]
    fn switchboard_randomness_parses_and_returns_value_for_reveal_slot() {
        let seed_slot = 123u64;
        let reveal_slot = 456u64;
        let value = [7u8; 32];
        let mut data = switchboard_randomness_account_data(seed_slot, reveal_slot, value);
        let mut lamports = 0u64;
        let owner = ON_DEMAND_MAINNET_PID;
        let key = Pubkey::new_unique();
        let info = AccountInfo::new(
            &key,
            false,
            false,
            &mut lamports,
            &mut data,
            &owner,
            false,
            0,
        );

        let parsed = RandomnessAccountData::parse(info.data.borrow()).unwrap();
        assert_eq!(parsed.seed_slot, seed_slot);
        assert_eq!(parsed.reveal_slot, reveal_slot);
        assert_eq!(parsed.value, value);
        assert_eq!(parsed.get_value(reveal_slot).unwrap(), value);
        assert!(parsed.get_value(reveal_slot + 1).is_err());
        assert!(parsed.get_value(reveal_slot - 1).is_err());
    }

    #[test]
    #[cfg(not(feature = "mock-randomness"))]
    fn switchboard_randomness_parse_rejects_invalid_discriminator() {
        let mut data = vec![0u8; RandomnessAccountData::size()];
        data[0..8].copy_from_slice(&[1u8; 8]);
        let mut lamports = 0u64;
        let owner = ON_DEMAND_MAINNET_PID;
        let key = Pubkey::new_unique();
        let info = AccountInfo::new(
            &key,
            false,
            false,
            &mut lamports,
            &mut data,
            &owner,
            false,
            0,
        );
        assert!(RandomnessAccountData::parse(info.data.borrow()).is_err());
    }

    #[test]
    #[cfg(not(feature = "mock-randomness"))]
    fn switchboard_randomness_parse_rejects_short_data() {
        let mut data = vec![0u8; 7];
        let mut lamports = 0u64;
        let owner = ON_DEMAND_MAINNET_PID;
        let key = Pubkey::new_unique();
        let info = AccountInfo::new(
            &key,
            false,
            false,
            &mut lamports,
            &mut data,
            &owner,
            false,
            0,
        );
        assert!(RandomnessAccountData::parse(info.data.borrow()).is_err());
    }

    #[test]
    #[cfg(not(feature = "mock-randomness"))]
    fn switchboard_program_ids_are_non_default_and_distinct() {
        assert_ne!(ON_DEMAND_MAINNET_PID, Pubkey::default());
        assert_ne!(ON_DEMAND_DEVNET_PID, Pubkey::default());
        assert_ne!(ON_DEMAND_MAINNET_PID, ON_DEMAND_DEVNET_PID);
    }
}
