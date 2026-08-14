use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use crate::bull_registry::{
    default_bull_leaf_node, default_owner_leaf_node, BullLeaf, CompressedBullProof,
    CompressedOwnerProof, OwnerLeaf, BULL_PROOF_PAYLOAD_SCHEMA_VERSION, SECTION_CURRENT_BULL,
    SECTION_CURRENT_OWNER, SECTION_REMOVE_BULL, SECTION_SELECTED_BULL, SECTION_SELECTED_OWNER,
    SECTION_VICTIM_OWNER,
};
use crate::sparse_tree::{
    verify_with_prefix_ref, CompressedSparseProofRef, Cursor, SparseMerkleNode,
};
use crate::RodeoError;

// ---------------------------------------------------------------------------
// Borrowed views over a finalized BullProofBuffer and its payload.
//
// These types exist solely to avoid materializing the payload or the sibling
// vector into the SBF heap.  They read directly from account data / payload
// bytes and keep only small Copy/Copy-on-the-stack state.
// ---------------------------------------------------------------------------

const BULL_PROOF_BUFFER_DISCRIMINATOR_LEN: usize = 8;
const BULL_PROOF_BUFFER_VERSION_OFFSET: usize = BULL_PROOF_BUFFER_DISCRIMINATOR_LEN;
const BULL_PROOF_BUFFER_SCHEMA_VERSION_OFFSET: usize = BULL_PROOF_BUFFER_VERSION_OFFSET + 1;
const BULL_PROOF_BUFFER_POSITION_OFFSET: usize = BULL_PROOF_BUFFER_SCHEMA_VERSION_OFFSET + 1 + 32; // pending_randomness
const BULL_PROOF_BUFFER_ACTION_TYPE_OFFSET: usize = BULL_PROOF_BUFFER_POSITION_OFFSET + 32;
const BULL_PROOF_BUFFER_SNAPSHOT_ROOT_OFFSET: usize = BULL_PROOF_BUFFER_ACTION_TYPE_OFFSET + 1;
const BULL_PROOF_BUFFER_SNAPSHOT_VERSION_OFFSET: usize =
    BULL_PROOF_BUFFER_SNAPSHOT_ROOT_OFFSET + 32;
const BULL_PROOF_BUFFER_SNAPSHOT_TOTAL_POWER_OFFSET: usize =
    BULL_PROOF_BUFFER_SNAPSHOT_VERSION_OFFSET + 8;
const BULL_PROOF_BUFFER_SNAPSHOT_TOTAL_COUNT_OFFSET: usize =
    BULL_PROOF_BUFFER_SNAPSHOT_TOTAL_POWER_OFFSET + 8;
const BULL_PROOF_BUFFER_REFUND_RECIPIENT_OFFSET: usize =
    BULL_PROOF_BUFFER_SNAPSHOT_TOTAL_COUNT_OFFSET + 8;
const BULL_PROOF_BUFFER_EXPIRY_OFFSET: usize = BULL_PROOF_BUFFER_REFUND_RECIPIENT_OFFSET + 32;
const BULL_PROOF_BUFFER_NONCE_OFFSET: usize = BULL_PROOF_BUFFER_EXPIRY_OFFSET + 8;
const BULL_PROOF_BUFFER_EXPECTED_PAYLOAD_LEN_OFFSET: usize = BULL_PROOF_BUFFER_NONCE_OFFSET + 8;
const BULL_PROOF_BUFFER_FINALIZED_OFFSET: usize = BULL_PROOF_BUFFER_EXPECTED_PAYLOAD_LEN_OFFSET + 4;
const BULL_PROOF_BUFFER_CONSUMED_OFFSET: usize = BULL_PROOF_BUFFER_FINALIZED_OFFSET + 1;
const BULL_PROOF_BUFFER_FILLED_OFFSET: usize = BULL_PROOF_BUFFER_CONSUMED_OFFSET + 1;
const BULL_PROOF_BUFFER_BUMP_OFFSET: usize = BULL_PROOF_BUFFER_FILLED_OFFSET + 4;
const BULL_PROOF_BUFFER_PAYLOAD_LEN_OFFSET: usize = BULL_PROOF_BUFFER_BUMP_OFFSET + 1;
const BULL_PROOF_BUFFER_PAYLOAD_OFFSET: usize = BULL_PROOF_BUFFER_PAYLOAD_LEN_OFFSET + 4;

fn read_pubkey_from(data: &[u8], offset: usize) -> Result<Pubkey> {
    let bytes: [u8; 32] = data
        .get(offset..offset + 32)
        .ok_or(RodeoError::BullProofBufferIncomplete)?
        .try_into()
        .map_err(|_| RodeoError::BullProofBufferIncomplete)?;
    Ok(Pubkey::new_from_array(bytes))
}

fn read_u32_from(data: &[u8], offset: usize) -> Result<u32> {
    let bytes: [u8; 4] = data
        .get(offset..offset + 4)
        .ok_or(RodeoError::BullProofBufferIncomplete)?
        .try_into()
        .map_err(|_| RodeoError::BullProofBufferIncomplete)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_u64_from(data: &[u8], offset: usize) -> Result<u64> {
    let bytes: [u8; 8] = data
        .get(offset..offset + 8)
        .ok_or(RodeoError::BullProofBufferIncomplete)?
        .try_into()
        .map_err(|_| RodeoError::BullProofBufferIncomplete)?;
    Ok(u64::from_le_bytes(bytes))
}

#[derive(Clone, Copy)]
pub struct BullProofBufferRef<'a> {
    pub data: &'a [u8],
    pub payload: &'a [u8],
    pub pending_randomness: Pubkey,
    pub position: Pubkey,
    pub action_type: u8,
    pub snapshot_root: [u8; 32],
    pub snapshot_version: u64,
    pub snapshot_total_count: u64,
    pub snapshot_total_power: u64,
    pub refund_recipient: Pubkey,
    pub expiry_timestamp: i64,
    pub nonce: u64,
    pub expected_payload_length: u32,
    pub finalized: bool,
    pub consumed: bool,
    pub bump: u8,
}

impl<'a> BullProofBufferRef<'a> {
    pub fn from_account_data(data: &'a [u8]) -> Result<Self> {
        require!(
            data.len() >= BULL_PROOF_BUFFER_PAYLOAD_OFFSET,
            RodeoError::BullProofBufferIncomplete
        );

        let version = data[BULL_PROOF_BUFFER_VERSION_OFFSET];
        require_eq!(version, 1u8, RodeoError::BullProofBufferIncomplete);

        let schema_version = data[BULL_PROOF_BUFFER_SCHEMA_VERSION_OFFSET];
        require_eq!(
            schema_version,
            BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
            RodeoError::BullProofBufferIncomplete
        );

        let pending_randomness =
            read_pubkey_from(data, BULL_PROOF_BUFFER_SCHEMA_VERSION_OFFSET + 1)?;
        let position = read_pubkey_from(data, BULL_PROOF_BUFFER_POSITION_OFFSET)?;
        let action_type = data[BULL_PROOF_BUFFER_ACTION_TYPE_OFFSET];
        let snapshot_root: [u8; 32] = data
            .get(
                BULL_PROOF_BUFFER_SNAPSHOT_ROOT_OFFSET..BULL_PROOF_BUFFER_SNAPSHOT_ROOT_OFFSET + 32,
            )
            .ok_or(RodeoError::BullProofBufferIncomplete)?
            .try_into()
            .map_err(|_| RodeoError::BullProofBufferIncomplete)?;
        let snapshot_version = read_u64_from(data, BULL_PROOF_BUFFER_SNAPSHOT_VERSION_OFFSET)?;
        let snapshot_total_power =
            read_u64_from(data, BULL_PROOF_BUFFER_SNAPSHOT_TOTAL_POWER_OFFSET)?;
        let snapshot_total_count =
            read_u64_from(data, BULL_PROOF_BUFFER_SNAPSHOT_TOTAL_COUNT_OFFSET)?;
        let refund_recipient = read_pubkey_from(data, BULL_PROOF_BUFFER_REFUND_RECIPIENT_OFFSET)?;
        let expiry_timestamp = read_u64_from(data, BULL_PROOF_BUFFER_EXPIRY_OFFSET)? as i64;
        let nonce = read_u64_from(data, BULL_PROOF_BUFFER_NONCE_OFFSET)?;
        let expected_payload_length =
            read_u32_from(data, BULL_PROOF_BUFFER_EXPECTED_PAYLOAD_LEN_OFFSET)?;
        let finalized = data[BULL_PROOF_BUFFER_FINALIZED_OFFSET] != 0;
        let consumed = data[BULL_PROOF_BUFFER_CONSUMED_OFFSET] != 0;
        let bump = data[BULL_PROOF_BUFFER_BUMP_OFFSET];
        let filled = read_u32_from(data, BULL_PROOF_BUFFER_FILLED_OFFSET)?;
        let payload_len = read_u32_from(data, BULL_PROOF_BUFFER_PAYLOAD_LEN_OFFSET)? as usize;
        require!(
            payload_len as u32 == expected_payload_length,
            RodeoError::BullProofBufferIncomplete
        );

        let payload_end = BULL_PROOF_BUFFER_PAYLOAD_OFFSET
            .checked_add(payload_len)
            .ok_or(RodeoError::ArithmeticOverflow)?;
        require!(
            data.len() >= payload_end,
            RodeoError::BullProofBufferIncomplete
        );
        let payload = &data[BULL_PROOF_BUFFER_PAYLOAD_OFFSET..payload_end];

        Ok(Self {
            data,
            payload,
            pending_randomness,
            position,
            action_type,
            snapshot_root,
            snapshot_version,
            snapshot_total_count,
            snapshot_total_power,
            refund_recipient,
            expiry_timestamp,
            nonce,
            expected_payload_length,
            finalized,
            consumed,
            bump,
        })
    }
}

#[derive(Clone, Copy)]
pub struct OwnerProofRef<'a> {
    /// Full borrowed section bytes (used to re-materialize an owned copy only
    /// when a test-fixture or legacy mutation path requires it).
    pub data: &'a [u8],
    pub leaf: OwnerLeaf,
    pub proof: CompressedSparseProofRef<'a>,
}

impl<'a> OwnerProofRef<'a> {
    pub fn from_bytes(data: &'a [u8]) -> Result<Self> {
        let mut cursor = Cursor::new(data);
        let owner = cursor.read_pubkey()?;
        let active_bull_count = cursor.read_u64()?;
        let total_buck_power = cursor.read_u64()?;
        let bull_tree_root = cursor.read_hash()?;
        let leaf = OwnerLeaf {
            owner,
            active_bull_count,
            total_buck_power,
            bull_tree_root,
        };
        let proof = CompressedSparseProofRef::from_cursor(&mut cursor)?;
        require!(cursor.is_empty(), RodeoError::BullProofBufferIncomplete);
        Ok(Self { data, leaf, proof })
    }

    pub fn to_owned(&self) -> Result<CompressedOwnerProof> {
        CompressedOwnerProof::try_from_slice(self.data)
            .map_err(|_| error!(RodeoError::BullProofBufferIncomplete))
    }
}

#[derive(Clone, Copy)]
pub struct BullProofRef<'a> {
    pub data: &'a [u8],
    pub leaf: BullLeaf,
    pub proof: CompressedSparseProofRef<'a>,
}

impl<'a> BullProofRef<'a> {
    pub fn from_bytes(data: &'a [u8]) -> Result<Self> {
        let mut cursor = Cursor::new(data);
        let position = cursor.read_pubkey()?;
        let position_id = cursor.read_u64()?;
        let owner = cursor.read_pubkey()?;
        let buck_power = cursor.read_u8()?;
        let reveal_config_version = cursor.read_u64()?;
        let leaf = BullLeaf {
            position,
            position_id,
            owner,
            buck_power,
            reveal_config_version,
        };
        let proof = CompressedSparseProofRef::from_cursor(&mut cursor)?;
        require!(cursor.is_empty(), RodeoError::BullProofBufferIncomplete);
        Ok(Self { data, leaf, proof })
    }

    pub fn to_owned(&self) -> Result<CompressedBullProof> {
        CompressedBullProof::try_from_slice(self.data)
            .map_err(|_| error!(RodeoError::BullProofBufferIncomplete))
    }
}

#[derive(Clone, Copy)]
pub struct BullProofPayloadRef<'a> {
    pub schema_version: u8,
    pub section_bitmap: u8,
    pub sections: [Option<&'a [u8]>; 6],
}

impl<'a> BullProofPayloadRef<'a> {
    pub fn new(data: &'a [u8]) -> Result<Self> {
        let mut cursor = Cursor::new(data);
        let schema_version = cursor.read_u8()?;
        require_eq!(
            schema_version,
            BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
            RodeoError::BullProofBufferIncomplete
        );

        let section_bitmap = cursor.read_u8()?;
        require!(
            section_bitmap & !0b0011_1111 == 0,
            RodeoError::BullProofBufferIncomplete
        );

        let mut sections: [Option<&'a [u8]>; 6] = [None; 6];

        for i in 0..6 {
            let present = cursor.read_u8()?;
            let expected = (section_bitmap & (1u8 << i)) != 0;
            require!(
                (present == 0 || present == 1),
                RodeoError::BullProofBufferIncomplete
            );
            require!(
                (present == 1) == expected,
                RodeoError::BullProofBufferIncomplete
            );

            if present == 1 {
                let start = cursor.pos();
                match i {
                    0 | 1 | 3 => OwnerProofRef::skip(&mut cursor)?,
                    2 | 4 | 5 => BullProofRef::skip(&mut cursor)?,
                    _ => return Err(error!(RodeoError::BullProofBufferIncomplete)),
                }
                let end = cursor.pos();
                sections[i] = Some(&data[start..end]);
            }
        }

        require!(cursor.is_empty(), RodeoError::BullProofBufferIncomplete);

        Ok(Self {
            schema_version,
            section_bitmap,
            sections,
        })
    }

    pub fn victim_owner(&self) -> Result<Option<OwnerProofRef<'a>>> {
        match self.sections[0] {
            Some(data) => Ok(Some(OwnerProofRef::from_bytes(data)?)),
            None => Ok(None),
        }
    }

    pub fn selected_owner(&self) -> Result<Option<OwnerProofRef<'a>>> {
        match self.sections[1] {
            Some(data) => Ok(Some(OwnerProofRef::from_bytes(data)?)),
            None => Ok(None),
        }
    }

    pub fn selected_bull(&self) -> Result<Option<BullProofRef<'a>>> {
        match self.sections[2] {
            Some(data) => Ok(Some(BullProofRef::from_bytes(data)?)),
            None => Ok(None),
        }
    }

    pub fn current_owner(&self) -> Result<Option<OwnerProofRef<'a>>> {
        match self.sections[3] {
            Some(data) => Ok(Some(OwnerProofRef::from_bytes(data)?)),
            None => Ok(None),
        }
    }

    pub fn current_bull(&self) -> Result<Option<BullProofRef<'a>>> {
        match self.sections[4] {
            Some(data) => Ok(Some(BullProofRef::from_bytes(data)?)),
            None => Ok(None),
        }
    }

    pub fn remove_bull(&self) -> Result<Option<BullProofRef<'a>>> {
        match self.sections[5] {
            Some(data) => Ok(Some(BullProofRef::from_bytes(data)?)),
            None => Ok(None),
        }
    }
}

impl<'a> OwnerProofRef<'a> {
    fn skip(cursor: &mut Cursor<'a>) -> Result<()> {
        let _owner = cursor.read_pubkey()?;
        let _active_bull_count = cursor.read_u64()?;
        let _total_buck_power = cursor.read_u64()?;
        let _bull_tree_root = cursor.read_hash()?;
        CompressedSparseProofRef::from_cursor(cursor)?;
        Ok(())
    }
}

impl<'a> BullProofRef<'a> {
    fn skip(cursor: &mut Cursor<'a>) -> Result<()> {
        let _position = cursor.read_pubkey()?;
        let _position_id = cursor.read_u64()?;
        let _owner = cursor.read_pubkey()?;
        let _buck_power = cursor.read_u8()?;
        let _reveal_config_version = cursor.read_u64()?;
        CompressedSparseProofRef::from_cursor(cursor)?;
        Ok(())
    }
}

pub fn verify_owner_ref(
    expected_root: &[u8; 32],
    owner: &Pubkey,
    proof: OwnerProofRef<'_>,
) -> Result<(u64, u64, u64)> {
    let leaf = proof.leaf.to_node();
    if !proof.leaf.is_empty() {
        require_keys_eq!(
            proof.leaf.owner,
            *owner,
            RodeoError::BullRegistryOwnerMismatch
        );
    }
    let (_root, prefix) = verify_with_prefix_ref(
        expected_root,
        &owner.to_bytes(),
        &proof.proof,
        &leaf,
        crate::bull_registry::PREFIX_BULL_OWNER_NODE,
        &default_owner_leaf_node(),
    )?;
    // Return the leaf's count/power (the owner's own values), not the root's
    // (which are the total for the entire tree).  Callers compute
    // external_count = total - victim_count, so victim_count must be the
    // victim's own count, not the total.
    Ok((leaf.count, leaf.power, prefix))
}

pub fn verify_bull_ref(
    expected_bull_root: &[u8; 32],
    position: &Pubkey,
    proof: BullProofRef<'_>,
) -> Result<(u64, u64, u64)> {
    let leaf = proof.leaf.to_node();
    if !proof.leaf.is_empty() {
        require_keys_eq!(
            proof.leaf.position,
            *position,
            RodeoError::BullRegistryMalformedProof
        );
    }
    let (_root, prefix) = verify_with_prefix_ref(
        expected_bull_root,
        &position.to_bytes(),
        &proof.proof,
        &leaf,
        crate::bull_registry::PREFIX_BULL_NODE,
        &default_bull_leaf_node(),
    )?;
    Ok((leaf.count, leaf.power, prefix))
}

// ---------------------------------------------------------------------------
// Generic raw BullProofBuffer loader + Reveal-specific validator.
// ---------------------------------------------------------------------------

use crate::constants::SEED_BULL_PROOF_BUFFER;
use crate::state::{ActionType, BullProofBuffer, PendingRandomness};

pub fn load_bull_proof_buffer_ref<'a>(
    info: &AccountInfo,
    data: &'a [u8],
) -> Result<BullProofBufferRef<'a>> {
    require!(info.owner == &crate::ID, RodeoError::InvalidProgramAccount);
    require!(
        data.len() >= BULL_PROOF_BUFFER_PAYLOAD_OFFSET,
        RodeoError::BullProofBufferIncomplete
    );
    let expected_disc = &anchor_lang::solana_program::hash::hash(b"account:BullProofBuffer")
        .to_bytes()[..BULL_PROOF_BUFFER_DISCRIMINATOR_LEN];
    require!(
        &data[..BULL_PROOF_BUFFER_DISCRIMINATOR_LEN] == expected_disc,
        RodeoError::InvalidProgramAccount
    );
    BullProofBufferRef::from_account_data(data)
}

pub fn validate_reveal_bull_proof_buffer<'a>(
    info: &AccountInfo,
    data: &'a [u8],
    position: &Pubkey,
    pending_randomness: &PendingRandomness,
    pending_randomness_key: &Pubkey,
    refund_recipient: &Pubkey,
    now: i64,
) -> Result<BullProofBufferRef<'a>> {
    let buffer = load_bull_proof_buffer_ref(info, data)?;

    let expected_pda = Pubkey::create_program_address(
        &[
            SEED_BULL_PROOF_BUFFER,
            buffer.pending_randomness.as_ref(),
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
        buffer.pending_randomness,
        *pending_randomness_key,
        RodeoError::InvalidPendingRandomness
    );
    require_keys_eq!(
        buffer.position,
        *position,
        RodeoError::BullProofBufferWrongPosition
    );
    require!(
        buffer.action_type == ActionType::Reveal as u8,
        RodeoError::WrongActionType
    );
    require!(
        buffer.action_type == pending_randomness.action_type as u8,
        RodeoError::WrongActionType
    );
    require!(
        buffer.refund_recipient == *refund_recipient,
        RodeoError::BullProofBufferWrongProver
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

/// Close a raw BullProofBuffer account without materializing payload Vec.
/// Sets the consumed flag, transfers all lamports to the refund recipient,
/// and reclaims the account data.
pub fn close_bull_proof_buffer(buffer: &AccountInfo, refund: &AccountInfo) -> Result<()> {
    {
        let mut data = buffer
            .try_borrow_mut_data()
            .map_err(|_| RodeoError::BullProofBufferIncomplete)?;
        require!(
            data.len() > BULL_PROOF_BUFFER_CONSUMED_OFFSET,
            RodeoError::BullProofBufferIncomplete
        );
        data[BULL_PROOF_BUFFER_CONSUMED_OFFSET] = 1;
    }

    let lamports = **buffer.lamports.borrow();
    **refund.lamports.borrow_mut() = refund
        .lamports()
        .checked_add(lamports)
        .ok_or(RodeoError::ArithmeticOverflow)?;
    **buffer.lamports.borrow_mut() = 0;

    buffer
        .realloc(0, false)
        .map_err(|_| error!(RodeoError::BullProofBufferIncomplete))?;
    Ok(())
}
