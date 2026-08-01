use anchor_lang::{prelude::*, solana_program::hash::hashv};
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

declare_id!("EkEPd5wXSi3NQUHewx64cP27tDQ6uTcK5poG6AuWmy8Z");

#[program]
pub mod rodeo_core {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.global_config;
        config.version = ACCOUNT_VERSION_V1;
        config.rodeo_mint = ctx.accounts.rodeo_mint.key();
        config.ansem_mint = ctx.accounts.ansem_mint.key();
        config.principal_vault = ctx.accounts.principal_vault.key();
        config.reward_vault = ctx.accounts.reward_vault.key();
        config.bump = ctx.bumps.global_config;
        config.principal_vault_bump = ctx.bumps.principal_vault;
        config.reward_vault_bump = ctx.bumps.reward_vault;
        Ok(())
    }

    pub fn stake_and_commit(
        ctx: Context<StakeAndCommit>,
        position_id: u64,
        principal_amount: u64,
        commitment: [u8; 32],
    ) -> Result<()> {
        require!(principal_amount > 0, RodeoError::ZeroPrincipal);

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.owner_rodeo_account.to_account_info(),
                    mint: ctx.accounts.rodeo_mint.to_account_info(),
                    to: ctx.accounts.principal_vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            principal_amount,
            ctx.accounts.rodeo_mint.decimals,
        )?;

        let position = &mut ctx.accounts.position;
        position.version = ACCOUNT_VERSION_V1;
        position.owner = ctx.accounts.owner.key();
        position.position_id = position_id;
        position.principal_amount = principal_amount;
        position.role = Role::Unassigned;
        position.status = PositionStatus::RandomnessPending;
        position.opened_epoch = 0;
        position.settlement_nonce = 0;
        position.mock_randomness = [0; 32];
        // The very first randomness action opened for a freshly created position is
        // always a reveal at nonce zero; later action kinds will draw from
        // `next_action_nonce` so every randomness request address is unique even
        // when the same action type is requested again later.
        position.pending_action_active = true;
        position.pending_action_type = ActionType::Reveal;
        position.pending_action_nonce = 0;
        position.next_action_nonce = 1;
        position.bump = ctx.bumps.position;

        let pending = &mut ctx.accounts.pending_randomness;
        pending.version = ACCOUNT_VERSION_V1;
        pending.position = position.key();
        pending.action_type = ActionType::Reveal;
        pending.action_nonce = 0;
        pending.commitment = commitment;
        pending.committed_slot = Clock::get()?.slot;
        pending.settled = false;
        pending.bump = ctx.bumps.pending_randomness;

        emit!(PositionStaked {
            position: position.key(),
            owner: position.owner,
            principal_amount,
            commitment,
        });
        Ok(())
    }

    pub fn mock_reveal(ctx: Context<MockReveal>, secret: [u8; 32]) -> Result<()> {
        let pending = &mut ctx.accounts.pending_randomness;
        require!(!pending.settled, RodeoError::AlreadySettled);
        require!(
            hashv(&[&secret]).to_bytes() == pending.commitment,
            RodeoError::InvalidReveal
        );

        let position = &mut ctx.accounts.position;
        require!(
            position.pending_action_active && position.pending_action_type == ActionType::Reveal,
            RodeoError::NoPendingRevealAction
        );

        let position_key = position.key();
        let randomness =
            hashv(&[b"rodeo-local-mock-v1", &secret, position_key.as_ref()]).to_bytes();

        pending.settled = true;
        position.mock_randomness = randomness;
        position.status = PositionStatus::Active;
        position.pending_action_active = false;
        position.settlement_nonce = position
            .settlement_nonce
            .checked_add(1)
            .ok_or(RodeoError::ArithmeticOverflow)?;

        emit!(MockRandomnessRevealed {
            position: position_key,
            owner: position.owner,
            randomness,
            settlement_nonce: position.settlement_nonce,
        });
        Ok(())
    }

    /// Changes `Position.owner` without changing the Position PDA. This is the
    /// single generic authority-transfer primitive that a future marketplace
    /// sale, gift, or mint-theft resolution is expected to call; Phase 0 only
    /// requires that the current owner authorize the change and that no
    /// randomness action is left unresolved across the transfer.
    pub fn transfer_position(ctx: Context<TransferPosition>, new_owner: Pubkey) -> Result<()> {
        let position = &mut ctx.accounts.position;
        require!(!position.pending_action_active, RodeoError::PositionLocked);

        let previous_owner = position.owner;
        position.owner = new_owner;

        emit!(PositionOwnerChanged {
            position: position.key(),
            previous_owner,
            new_owner,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rodeo_mint: Account<'info, Mint>,
    pub ansem_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [b"global-config"],
        bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(
        init,
        payer = payer,
        seeds = [b"principal-vault"],
        bump,
        token::mint = rodeo_mint,
        token::authority = global_config
    )]
    pub principal_vault: Account<'info, TokenAccount>,
    #[account(
        init,
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

#[derive(Accounts)]
#[instruction(position_id: u64)]
pub struct StakeAndCommit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"global-config"],
        bump = global_config.bump,
        has_one = rodeo_mint,
        has_one = principal_vault
    )]
    pub global_config: Account<'info, GlobalConfig>,
    pub rodeo_mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = rodeo_mint,
        token::authority = owner
    )]
    pub owner_rodeo_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        address = global_config.principal_vault,
        token::mint = rodeo_mint,
        token::authority = global_config
    )]
    pub principal_vault: Account<'info, TokenAccount>,
    // Position identity is derived only from the global config and the
    // caller-chosen position ID. It intentionally excludes the owner so that
    // ownership can change (marketplace sale, gift, mint theft) without the
    // Position account ever having to move.
    #[account(
        init,
        payer = owner,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", global_config.key().as_ref(), &position_id.to_le_bytes()],
        bump
    )]
    pub position: Account<'info, Position>,
    // The reveal action opened here is always the first action for a brand
    // new position, so its action type and nonce are fixed constants; later
    // randomness actions are addressed through `position.pending_action_nonce`.
    #[account(
        init,
        payer = owner,
        space = 8 + PendingRandomness::INIT_SPACE,
        seeds = [
            b"randomness",
            position.key().as_ref(),
            &[ActionType::Reveal as u8],
            &0u64.to_le_bytes()
        ],
        bump
    )]
    pub pending_randomness: Account<'info, PendingRandomness>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MockReveal<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"global-config"],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        has_one = owner @ RodeoError::InvalidOwner,
        seeds = [b"position", global_config.key().as_ref(), &position.position_id.to_le_bytes()],
        bump = position.bump
    )]
    pub position: Account<'info, Position>,
    // Re-deriving the address from the position, a fixed reveal action type,
    // and the position's currently pending action nonce means a randomness
    // request can only ever settle the exact position, action type, and
    // nonce it was opened for; anything else fails PDA/account validation
    // before the instruction body runs.
    #[account(
        mut,
        has_one = position,
        seeds = [
            b"randomness",
            position.key().as_ref(),
            &[ActionType::Reveal as u8],
            &position.pending_action_nonce.to_le_bytes()
        ],
        bump = pending_randomness.bump
    )]
    pub pending_randomness: Account<'info, PendingRandomness>,
}

#[derive(Accounts)]
pub struct TransferPosition<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ RodeoError::InvalidOwner
    )]
    pub position: Account<'info, Position>,
}

pub const ACCOUNT_VERSION_V1: u8 = 1;

#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub version: u8,
    pub rodeo_mint: Pubkey,
    pub ansem_mint: Pubkey,
    pub principal_vault: Pubkey,
    pub reward_vault: Pubkey,
    pub bump: u8,
    pub principal_vault_bump: u8,
    pub reward_vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RewardState {
    pub version: u8,
    pub global_config: Pubkey,
    pub current_epoch: u64,
    pub epoch_started_at: i64,
    pub fee_revenue_atomic: u64,
    pub ansem_emitted_atomic: u64,
    pub ansem_claimed_atomic: u64,
    pub ansem_liability_atomic: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub version: u8,
    // Mutable: ownership can change without the Position PDA changing.
    pub owner: Pubkey,
    pub position_id: u64,
    pub principal_amount: u64,
    pub role: Role,
    pub status: PositionStatus,
    pub opened_epoch: u64,
    pub settlement_nonce: u64,
    pub mock_randomness: [u8; 32],
    // Whether a randomness action is currently outstanding for this
    // position. While `true`, `transfer_position` is rejected.
    pub pending_action_active: bool,
    // The kind of the currently outstanding action; only meaningful while
    // `pending_action_active` is true.
    pub pending_action_type: ActionType,
    // The nonce of the currently outstanding action; used to re-derive the
    // exact `PendingRandomness` PDA that must settle it.
    pub pending_action_nonce: u64,
    // Monotonic source of nonces for every randomness action ever opened by
    // this position, so no two actions (even of the same type) ever collide
    // on the same PDA.
    pub next_action_nonce: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RoleStatistics {
    pub version: u8,
    pub global_config: Pubkey,
    pub epoch: u64,
    pub cowboy_population: u64,
    pub bull_population: u64,
    pub cowboy_principal_atomic: u64,
    pub bull_principal_atomic: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BullAccumulator {
    pub version: u8,
    pub global_config: Pubkey,
    pub epoch: u64,
    pub total_weight: u128,
    pub reward_per_weight_scaled: u128,
    pub division_remainder_atomic: u128,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PendingRandomness {
    pub version: u8,
    pub position: Pubkey,
    pub action_type: ActionType,
    pub action_nonce: u64,
    pub commitment: [u8; 32],
    pub committed_slot: u64,
    pub settled: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum Role {
    Unassigned,
    Cowboy,
    Bull,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum PositionStatus {
    RandomnessPending,
    Active,
    Settled,
}

/// Stable, append-only discriminant for the kind of randomness action a
/// `PendingRandomness` account represents. Existing variants must never be
/// reordered or removed; new action kinds must only be appended.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum ActionType {
    Reveal,
    Unstake,
}

#[event]
pub struct PositionStaked {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub principal_amount: u64,
    pub commitment: [u8; 32],
}

#[event]
pub struct MockRandomnessRevealed {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub randomness: [u8; 32],
    pub settlement_nonce: u64,
}

#[event]
pub struct PositionOwnerChanged {
    pub position: Pubkey,
    pub previous_owner: Pubkey,
    pub new_owner: Pubkey,
}

#[error_code]
pub enum RodeoError {
    #[msg("Principal must be greater than zero")]
    ZeroPrincipal,
    #[msg("Randomness has already been settled")]
    AlreadySettled,
    #[msg("Reveal does not match the commitment")]
    InvalidReveal,
    #[msg("Position owner does not match the signer")]
    InvalidOwner,
    #[msg("Integer arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("No reveal action is pending for this position")]
    NoPendingRevealAction,
    #[msg("Position has a pending action and cannot be transferred")]
    PositionLocked,
}
