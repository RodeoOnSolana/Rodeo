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
        position.bump = ctx.bumps.position;

        let pending = &mut ctx.accounts.pending_randomness;
        pending.version = ACCOUNT_VERSION_V1;
        pending.position = position.key();
        pending.owner = ctx.accounts.owner.key();
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
        require_keys_eq!(pending.owner, ctx.accounts.owner.key(), RodeoError::InvalidOwner);
        require!(hashv(&[&secret]).to_bytes() == pending.commitment, RodeoError::InvalidReveal);

        let position = &mut ctx.accounts.position;
        require!(
            position.status == PositionStatus::RandomnessPending,
            RodeoError::AlreadySettled
        );
        let position_key = position.key();
        let randomness = hashv(&[b"rodeo-local-mock-v1", &secret, position_key.as_ref()]).to_bytes();

        pending.settled = true;
        position.mock_randomness = randomness;
        position.status = PositionStatus::Active;
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
    #[account(
        init,
        payer = owner,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", owner.key().as_ref(), &position_id.to_le_bytes()],
        bump
    )]
    pub position: Account<'info, Position>,
    #[account(
        init,
        payer = owner,
        space = 8 + PendingRandomness::INIT_SPACE,
        seeds = [b"pending-randomness", position.key().as_ref()],
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
        mut,
        has_one = owner,
        seeds = [b"position", owner.key().as_ref(), &position.position_id.to_le_bytes()],
        bump = position.bump
    )]
    pub position: Account<'info, Position>,
    #[account(
        mut,
        has_one = position,
        has_one = owner,
        seeds = [b"pending-randomness", position.key().as_ref()],
        bump = pending_randomness.bump
    )]
    pub pending_randomness: Account<'info, PendingRandomness>,
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
    pub owner: Pubkey,
    pub position_id: u64,
    pub principal_amount: u64,
    pub role: Role,
    pub status: PositionStatus,
    pub opened_epoch: u64,
    pub settlement_nonce: u64,
    pub mock_randomness: [u8; 32],
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
    pub owner: Pubkey,
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
}
