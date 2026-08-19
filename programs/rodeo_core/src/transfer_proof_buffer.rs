use anchor_lang::prelude::*;

use crate::{
    borrowed_proof::{
        load_bull_proof_buffer_ref, BullProofPayloadRef, BULL_PROOF_BUFFER_CONSUMED_OFFSET,
    },
    constants::{
        ACCOUNT_VERSION_BULL_PROOF_BUFFER, BULL_PROOF_BUFFER_MAX_PAYLOAD,
        BULL_PROOF_BUFFER_SCHEMA_VERSION, BULL_PROOF_BUFFER_TTL_SECONDS, SEED_BULL_REGISTRY,
        SEED_BULL_TRANSFER_PROOF_BUFFER, SEED_POSITION,
    },
    state::{ActionType, BullProofBuffer, BullRegistry, GlobalConfig, Position},
    RodeoError,
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

fn validate_transfer_buffer<'a>(
    info: &AccountInfo,
    data: &'a [u8],
    position: &Pubkey,
    expected_action: ActionType,
    prover: &Pubkey,
    bull_registry: &BullRegistry,
    now: i64,
) -> Result<crate::borrowed_proof::BullProofBufferRef<'a>> {
    let buffer = load_bull_proof_buffer_ref(info, data)?;

    let expected_pda = Pubkey::create_program_address(
        &[
            SEED_BULL_TRANSFER_PROOF_BUFFER,
            buffer.position.as_ref(),
            buffer.refund_recipient.as_ref(),
            &buffer.nonce.to_le_bytes(),
            &[buffer.bump],
        ],
        &crate::ID,
    )
    .map_err(|_| error!(RodeoError::InvalidBullProofBufferPda))?;
    require!(
        info.key() == expected_pda,
        RodeoError::InvalidBullProofBufferPda
    );

    require_keys_eq!(
        buffer.position,
        *position,
        RodeoError::BullProofBufferWrongPosition
    );
    require!(
        buffer.action_type == expected_action as u8,
        RodeoError::WrongActionType
    );
    require_keys_eq!(
        buffer.refund_recipient,
        *prover,
        RodeoError::BullProofBufferWrongProver
    );

    // Transfer buffers always bind against the CURRENT registry.
    require!(
        buffer.snapshot_root == bull_registry.owner_tree_root,
        RodeoError::BullRegistryInvalidRoot
    );
    require!(
        buffer.snapshot_version == bull_registry.registry_version,
        RodeoError::BullRegistryInvalidRoot
    );

    require!(
        buffer.expected_payload_length > 0,
        RodeoError::BullProofBufferIncomplete
    );
    require!(buffer.finalized, RodeoError::BullProofBufferNotFinalized);
    require!(!buffer.consumed, RodeoError::BullProofBufferAlreadyConsumed);
    require!(
        now < buffer.expiry_timestamp,
        RodeoError::BullProofBufferExpired
    );

    Ok(buffer)
}

pub fn validate_prepare_transfer_bull_proof_buffer<'a>(
    info: &AccountInfo,
    data: &'a [u8],
    position: &Pubkey,
    owner: &Pubkey,
    bull_registry: &BullRegistry,
    now: i64,
) -> Result<BullProofPayloadRef<'a>> {
    let buffer = validate_transfer_buffer(
        info,
        data,
        position,
        ActionType::PrepareTransfer,
        owner,
        bull_registry,
        now,
    )?;
    let payload = BullProofPayloadRef::new(buffer.payload)?;
    require!(
        payload.current_owner()?.is_some(),
        RodeoError::BullProofBufferIncomplete
    );
    require!(
        payload.remove_bull()?.is_some(),
        RodeoError::BullProofBufferIncomplete
    );
    Ok(payload)
}

pub fn validate_activate_position_bull_proof_buffer<'a>(
    info: &AccountInfo,
    data: &'a [u8],
    position: &Pubkey,
    owner: &Pubkey,
    bull_registry: &BullRegistry,
    now: i64,
) -> Result<BullProofPayloadRef<'a>> {
    let buffer = validate_transfer_buffer(
        info,
        data,
        position,
        ActionType::ActivatePosition,
        owner,
        bull_registry,
        now,
    )?;
    let payload = BullProofPayloadRef::new(buffer.payload)?;
    require!(
        payload.current_owner()?.is_some(),
        RodeoError::BullProofBufferIncomplete
    );
    require!(
        payload.current_bull()?.is_some(),
        RodeoError::BullProofBufferIncomplete
    );
    Ok(payload)
}

pub fn validate_native_transfer_remove_bull_proof_buffer<'a>(
    info: &AccountInfo,
    data: &'a [u8],
    position: &Pubkey,
    seller: &Pubkey,
    bull_registry: &BullRegistry,
    now: i64,
) -> Result<BullProofPayloadRef<'a>> {
    let buffer = validate_transfer_buffer(
        info,
        data,
        position,
        ActionType::NativeTransferRemove,
        seller,
        bull_registry,
        now,
    )?;
    let payload = BullProofPayloadRef::new(buffer.payload)?;
    require!(
        payload.current_owner()?.is_some(),
        RodeoError::BullProofBufferIncomplete
    );
    require!(
        payload.remove_bull()?.is_some(),
        RodeoError::BullProofBufferIncomplete
    );
    Ok(payload)
}

pub fn validate_native_transfer_add_bull_proof_buffer<'a>(
    info: &AccountInfo,
    data: &'a [u8],
    position: &Pubkey,
    buyer: &Pubkey,
    bull_registry: &BullRegistry,
    now: i64,
) -> Result<BullProofPayloadRef<'a>> {
    let buffer = validate_transfer_buffer(
        info,
        data,
        position,
        ActionType::NativeTransferAdd,
        buyer,
        bull_registry,
        now,
    )?;
    let payload = BullProofPayloadRef::new(buffer.payload)?;
    require!(
        payload.current_owner()?.is_some(),
        RodeoError::BullProofBufferIncomplete
    );
    require!(
        payload.current_bull()?.is_some(),
        RodeoError::BullProofBufferIncomplete
    );
    Ok(payload)
}

pub fn mark_transfer_buffer_consumed(buffer: &AccountInfo) -> Result<()> {
    let mut data = buffer
        .try_borrow_mut_data()
        .map_err(|_| RodeoError::BullProofBufferIncomplete)?;
    require!(
        data.len() > BULL_PROOF_BUFFER_CONSUMED_OFFSET,
        RodeoError::BullProofBufferIncomplete
    );
    data[BULL_PROOF_BUFFER_CONSUMED_OFFSET] = 1;
    Ok(())
}

pub fn validate_native_transfer_composite_bull_proof_buffer<'a>(
    info: &AccountInfo,
    data: &'a [u8],
    position: &Pubkey,
    seller: &Pubkey,
    bull_registry: &BullRegistry,
    now: i64,
) -> Result<crate::borrowed_proof::NativeTransferBullPayloadRef<'a>> {
    let buffer = validate_transfer_buffer(
        info,
        data,
        position,
        ActionType::NativeTransferComposite,
        seller,
        bull_registry,
        now,
    )?;
    let payload = crate::borrowed_proof::NativeTransferBullPayloadRef::new(buffer.payload)?;
    require!(
        payload.seller_owner()?.is_some(),
        RodeoError::BullProofBufferIncomplete
    );
    require!(
        payload.remove_bull()?.is_some(),
        RodeoError::BullProofBufferIncomplete
    );
    require!(
        payload.buyer_owner()?.is_some(),
        RodeoError::BullProofBufferIncomplete
    );
    require!(
        payload.add_bull()?.is_some(),
        RodeoError::BullProofBufferIncomplete
    );
    Ok(payload)
}

// ---------------------------------------------------------------------------
// Transfer BullProofBuffer instructions
// ---------------------------------------------------------------------------

fn bull_proof_buffer_init_space(payload_len: u32) -> usize {
    8 + BullProofBuffer::INIT_SPACE + payload_len as usize
}

#[derive(Accounts)]
#[instruction(action_type: ActionType, expected_payload_length: u32, nonce: u64)]
pub struct InitializeTransferBullProof<'info> {
    #[account(mut)]
    pub prover: Signer<'info>,

    #[account(
        seeds = [crate::constants::SEED_GLOBAL_CONFIG],
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
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        init,
        payer = prover,
        space = bull_proof_buffer_init_space(expected_payload_length),
        seeds = [
            SEED_BULL_TRANSFER_PROOF_BUFFER,
            position.key().as_ref(),
            prover.key().as_ref(),
            &nonce.to_le_bytes(),
        ],
        bump
    )]
    pub bull_proof_buffer: Box<Account<'info, BullProofBuffer>>,

    #[account(
        seeds = [SEED_BULL_REGISTRY, global_config.key().as_ref()],
        bump = bull_registry.bump,
    )]
    pub bull_registry: Box<Account<'info, BullRegistry>>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn initialize_transfer_bull_proof(
    ctx: Context<InitializeTransferBullProof>,
    action_type: ActionType,
    expected_payload_length: u32,
    nonce: u64,
) -> Result<()> {
    require!(
        action_type == ActionType::PrepareTransfer
            || action_type == ActionType::ActivatePosition
            || action_type == ActionType::NativeTransferRemove
            || action_type == ActionType::NativeTransferAdd
            || action_type == ActionType::NativeTransferComposite,
        RodeoError::BullProofBufferIncomplete
    );
    require_gte!(
        BULL_PROOF_BUFFER_MAX_PAYLOAD as u32,
        expected_payload_length,
        RodeoError::BullProofBufferOversized
    );

    let buffer = &mut ctx.accounts.bull_proof_buffer;
    buffer.version = ACCOUNT_VERSION_BULL_PROOF_BUFFER;
    buffer.schema_version = BULL_PROOF_BUFFER_SCHEMA_VERSION;
    buffer.action_type = action_type;
    // For transfer buffers we reuse the pending_randomness field as the binding
    // key (position PDA) so that the same account type works for both use cases.
    buffer.pending_randomness = ctx.accounts.position.key();
    buffer.position = ctx.accounts.position.key();
    buffer.snapshot_root = ctx.accounts.bull_registry.owner_tree_root;
    buffer.snapshot_version = ctx.accounts.bull_registry.registry_version;
    buffer.snapshot_total_count = ctx.accounts.bull_registry.total_bull_count;
    buffer.snapshot_total_power = ctx.accounts.bull_registry.total_buck_power;
    buffer.refund_recipient = ctx.accounts.prover.key();
    buffer.expiry_timestamp = Clock::get()?
        .unix_timestamp
        .checked_add(BULL_PROOF_BUFFER_TTL_SECONDS)
        .ok_or(RodeoError::ArithmeticOverflow)?;
    buffer.nonce = nonce;
    buffer.expected_payload_length = expected_payload_length;
    buffer.finalized = false;
    buffer.consumed = false;
    buffer.bump = ctx.bumps.bull_proof_buffer;
    buffer.payload = Vec::new();
    Ok(())
}

#[derive(Accounts)]
#[instruction(nonce: u64, offset: u32, chunk: Vec<u8>)]
pub struct AppendTransferBullProof<'info> {
    #[account(mut)]
    pub prover: Signer<'info>,

    #[account(
        mut,
        seeds = [
            SEED_BULL_TRANSFER_PROOF_BUFFER,
            bull_proof_buffer.position.as_ref(),
            prover.key().as_ref(),
            &nonce.to_le_bytes(),
        ],
        bump = bull_proof_buffer.bump,
        constraint = !bull_proof_buffer.finalized @ RodeoError::BullProofBufferFinalized,
        constraint = bull_proof_buffer.refund_recipient == prover.key() @ RodeoError::BullProofBufferWrongProver,
    )]
    pub bull_proof_buffer: Box<Account<'info, BullProofBuffer>>,
}

pub fn append_transfer_bull_proof(
    ctx: Context<AppendTransferBullProof>,
    _nonce: u64,
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

    let account_data_len = buffer.to_account_info().data_len();
    let required_len = crate::constants::BULL_PROOF_BUFFER_PAYLOAD_OFFSET
        + (buffer.expected_payload_length as usize);
    require_gte!(
        account_data_len,
        required_len,
        RodeoError::BullProofBufferNotExpanded
    );

    buffer.payload.extend_from_slice(&chunk);
    Ok(())
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct FinalizeTransferBullProof<'info> {
    #[account(mut)]
    pub prover: Signer<'info>,

    #[account(
        mut,
        seeds = [
            SEED_BULL_TRANSFER_PROOF_BUFFER,
            bull_proof_buffer.position.as_ref(),
            prover.key().as_ref(),
            &nonce.to_le_bytes(),
        ],
        bump = bull_proof_buffer.bump,
        constraint = bull_proof_buffer.refund_recipient == prover.key() @ RodeoError::BullProofBufferWrongProver,
    )]
    pub bull_proof_buffer: Box<Account<'info, BullProofBuffer>>,
}

pub fn finalize_transfer_bull_proof(
    ctx: Context<FinalizeTransferBullProof>,
    _nonce: u64,
) -> Result<()> {
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

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CloseTransferBullProof<'info> {
    /// CHECK: The original prover is used to re-derive the buffer PDA.
    pub prover: AccountInfo<'info>,

    #[account(
        mut,
        close = refund_recipient,
        seeds = [
            SEED_BULL_TRANSFER_PROOF_BUFFER,
            bull_proof_buffer.position.as_ref(),
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

pub fn close_transfer_bull_proof(_ctx: Context<CloseTransferBullProof>, _nonce: u64) -> Result<()> {
    // Anchor `close = refund_recipient` reclaims the account.
    Ok(())
}
