use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

use crate::constants::*;
use crate::math;
use crate::sparse_tree::{
    hash_node, recompute_root_after_replace, verify_with_prefix, CompressedSparseProof,
    SparseMerkleNode, SPARSE_TREE_DEPTH,
};
use crate::RodeoError;

// ---------------------------------------------------------------------------
// Deterministic full-key sparse Merkle-sum tree invariants (BullRegistry v2).
//
// Owner tree:
//   - Sparse 256-level binary tree keyed by the full 32-byte owner Pubkey.
//   - Bit i of the owner Pubkey selects left (0) or right (1) at level i.
//   - An owner can only be stored at its canonical key path; there is exactly
//     one legal location for any wallet.
//   - An empty leaf is the canonical default OwnerLeaf.  Non-default siblings
//     in a proof are compressed into a bitmap + sibling list.
//   - Non-membership for an owner is a proof that the canonical path is empty.
//   - The tree root is a Merkle-sum root: each internal node commits to the
//     total Bull count and total buck power of its subtree.
//
// Bull tree (per owner):
//   - Sparse 256-level binary tree keyed by the full Position Pubkey.
//   - Same compression and default-node semantics as the owner tree.
//   - Each Bull leaf commits to canonical reveal state.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Domain-separated hash prefixes for the two-level Merkle-sum tree.
// ---------------------------------------------------------------------------

const PREFIX_BULL_OWNER_LEAF: &[u8] = b"rodeo_v2_bull_owner_leaf";
const PREFIX_BULL_LEAF: &[u8] = b"rodeo_v2_bull_leaf";
const PREFIX_BULL_OWNER_NODE: &[u8] = b"rodeo_v2_bull_owner_node";
const PREFIX_BULL_NODE: &[u8] = b"rodeo_v2_bull_node";

// ---------------------------------------------------------------------------
// Canonical leaf representations.  Serialization is what the Merkle hashes bind.
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct OwnerLeaf {
    pub owner: Pubkey,
    pub active_bull_count: u64,
    pub total_buck_power: u64,
    pub bull_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct BullLeaf {
    pub position: Pubkey,
    pub position_id: u64,
    pub owner: Pubkey,
    pub buck_power: u8,
    pub reveal_config_version: u64,
}

impl OwnerLeaf {
    pub fn empty() -> Self {
        Self {
            owner: Pubkey::default(),
            active_bull_count: 0,
            total_buck_power: 0,
            bull_tree_root: empty_bull_tree_root(),
        }
    }

    pub fn hash(&self) -> [u8; 32] {
        hashv(&[
            PREFIX_BULL_OWNER_LEAF,
            self.owner.as_ref(),
            &self.active_bull_count.to_le_bytes(),
            &self.total_buck_power.to_le_bytes(),
            &self.bull_tree_root,
        ])
        .to_bytes()
    }

    pub fn is_empty(&self) -> bool {
        self.owner == Pubkey::default()
    }

    pub fn to_node(&self) -> SparseMerkleNode {
        SparseMerkleNode {
            hash: if self.is_empty() {
                default_owner_leaf_hash()
            } else {
                self.hash()
            },
            count: self.active_bull_count,
            power: self.total_buck_power,
        }
    }
}

impl BullLeaf {
    pub fn empty() -> Self {
        Self {
            position: Pubkey::default(),
            position_id: 0,
            owner: Pubkey::default(),
            buck_power: 0,
            reveal_config_version: 0,
        }
    }

    pub fn hash(&self) -> [u8; 32] {
        hashv(&[
            PREFIX_BULL_LEAF,
            self.position.as_ref(),
            &self.position_id.to_le_bytes(),
            self.owner.as_ref(),
            &[self.buck_power],
            &self.reveal_config_version.to_le_bytes(),
        ])
        .to_bytes()
    }

    pub fn is_empty(&self) -> bool {
        self.position == Pubkey::default()
    }

    pub fn to_node(&self) -> SparseMerkleNode {
        SparseMerkleNode {
            hash: if self.is_empty() {
                default_bull_leaf_hash()
            } else {
                self.hash()
            },
            count: if self.is_empty() { 0 } else { 1 },
            power: self.buck_power as u64,
        }
    }
}

// ---------------------------------------------------------------------------
// Default empty leaves / roots.
// ---------------------------------------------------------------------------

pub fn default_bull_leaf_hash() -> [u8; 32] {
    BullLeaf::empty().hash()
}

pub fn default_owner_leaf_hash() -> [u8; 32] {
    OwnerLeaf::empty().hash()
}

fn default_bull_leaf_node() -> SparseMerkleNode {
    BullLeaf::empty().to_node()
}

fn default_owner_leaf_node() -> SparseMerkleNode {
    OwnerLeaf::empty().to_node()
}

pub fn empty_bull_tree_root() -> [u8; 32] {
    crate::sparse_tree::compute_default_empty_nodes(&default_bull_leaf_node(), PREFIX_BULL_NODE)
        .unwrap()
        .last()
        .unwrap()
        .hash
}

pub fn empty_owner_tree_root() -> [u8; 32] {
    crate::sparse_tree::compute_default_empty_nodes(
        &default_owner_leaf_node(),
        PREFIX_BULL_OWNER_NODE,
    )
    .unwrap()
    .last()
    .unwrap()
    .hash
}

// ---------------------------------------------------------------------------
// Compressed proof types for the BullProofBuffer.
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CompressedOwnerProof {
    pub leaf: OwnerLeaf,
    pub proof: CompressedSparseProof,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CompressedBullProof {
    pub leaf: BullLeaf,
    pub proof: CompressedSparseProof,
}

// ---------------------------------------------------------------------------
// Section bitmap flags for the V2 BullProofBuffer payload.
// ---------------------------------------------------------------------------

pub const BULL_PROOF_PAYLOAD_SCHEMA_VERSION: u8 = 2;

pub const SECTION_VICTIM_OWNER: u8 = 0b0000_0001;
pub const SECTION_SELECTED_OWNER: u8 = 0b0000_0010;
pub const SECTION_SELECTED_BULL: u8 = 0b0000_0100;
pub const SECTION_CURRENT_OWNER: u8 = 0b0000_1000;
pub const SECTION_CURRENT_BULL: u8 = 0b0001_0000;
pub const SECTION_REMOVE_BULL: u8 = 0b0010_0000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BullProofPayloadV1 {
    pub schema_version: u8,
    pub section_bitmap: u8,
    pub victim_owner: Option<CompressedOwnerProof>,
    pub selected_owner: Option<CompressedOwnerProof>,
    pub selected_bull: Option<CompressedBullProof>,
    pub current_owner: Option<CompressedOwnerProof>,
    pub current_bull: Option<CompressedBullProof>,
    pub remove_bull: Option<CompressedBullProof>,
}

pub fn verify_bull_proof_payload(bytes: &[u8]) -> Result<BullProofPayloadV1> {
    let payload = BullProofPayloadV1::try_from_slice(bytes)
        .map_err(|_| RodeoError::BullProofBufferIncomplete)?;

    require_eq!(
        payload.schema_version,
        BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
        RodeoError::BullProofBufferIncomplete
    );
    require!(
        payload.section_bitmap & !0b0011_1111 == 0,
        RodeoError::BullProofBufferIncomplete
    );

    require_eq!(
        payload.victim_owner.is_some(),
        payload.section_bitmap & SECTION_VICTIM_OWNER != 0,
        RodeoError::BullProofBufferIncomplete
    );
    require_eq!(
        payload.selected_owner.is_some(),
        payload.section_bitmap & SECTION_SELECTED_OWNER != 0,
        RodeoError::BullProofBufferIncomplete
    );
    require_eq!(
        payload.selected_bull.is_some(),
        payload.section_bitmap & SECTION_SELECTED_BULL != 0,
        RodeoError::BullProofBufferIncomplete
    );
    require_eq!(
        payload.current_owner.is_some(),
        payload.section_bitmap & SECTION_CURRENT_OWNER != 0,
        RodeoError::BullProofBufferIncomplete
    );
    require_eq!(
        payload.current_bull.is_some(),
        payload.section_bitmap & SECTION_CURRENT_BULL != 0,
        RodeoError::BullProofBufferIncomplete
    );
    require_eq!(
        payload.remove_bull.is_some(),
        payload.section_bitmap & SECTION_REMOVE_BULL != 0,
        RodeoError::BullProofBufferIncomplete
    );

    Ok(payload)
}

// ---------------------------------------------------------------------------
// Owner/Bull verification helpers.
// ---------------------------------------------------------------------------

pub fn verify_owner(
    expected_root: &[u8; 32],
    owner: &Pubkey,
    proof: &CompressedOwnerProof,
) -> Result<(u64, u64, u64)> {
    let leaf = proof.leaf.to_node();
    if !proof.leaf.is_empty() {
        require_keys_eq!(
            proof.leaf.owner,
            *owner,
            RodeoError::BullRegistryOwnerMismatch
        );
    }
    let (root, prefix) = verify_with_prefix(
        expected_root,
        &owner.to_bytes(),
        &proof.proof,
        &leaf,
        PREFIX_BULL_OWNER_NODE,
        &default_owner_leaf_node(),
    )?;
    Ok((root.count, root.power, prefix))
}

pub fn verify_bull(
    expected_bull_root: &[u8; 32],
    position: &Pubkey,
    proof: &CompressedBullProof,
) -> Result<(u64, u64, u64)> {
    let leaf = proof.leaf.to_node();
    if !proof.leaf.is_empty() {
        require_keys_eq!(
            proof.leaf.position,
            *position,
            RodeoError::BullRegistryMalformedProof
        );
    }
    let (root, prefix) = verify_with_prefix(
        expected_bull_root,
        &position.to_bytes(),
        &proof.proof,
        &leaf,
        PREFIX_BULL_NODE,
        &default_bull_leaf_node(),
    )?;
    Ok((root.count, root.power, prefix))
}

// ---------------------------------------------------------------------------
// Owner and Bull leaf mutations.
// ---------------------------------------------------------------------------

pub fn add_bull_to_owner_leaf(
    current_owner_leaf: &OwnerLeaf,
    bull_leaf: &BullLeaf,
    empty_bull_proof: &CompressedBullProof,
) -> Result<OwnerLeaf> {
    require!(
        empty_bull_proof.leaf.is_empty(),
        RodeoError::BullRegistrySlotOccupied
    );
    require!(
        current_owner_leaf.is_empty() || current_owner_leaf.owner == bull_leaf.owner,
        RodeoError::BullRegistryOwnerMismatch
    );

    let empty_leaf_node = empty_bull_proof.leaf.to_node();
    let (new_bull_root, _) = recompute_root_after_replace(
        &bull_leaf.position.to_bytes(),
        &empty_bull_proof.proof,
        &bull_leaf.to_node(),
        PREFIX_BULL_NODE,
        &default_bull_leaf_node(),
    )?;

    if current_owner_leaf.is_empty() {
        Ok(OwnerLeaf {
            owner: bull_leaf.owner,
            active_bull_count: 1,
            total_buck_power: bull_leaf.buck_power as u64,
            bull_tree_root: new_bull_root.hash,
        })
    } else {
        Ok(OwnerLeaf {
            owner: current_owner_leaf.owner,
            active_bull_count: math::checked_add_u64(current_owner_leaf.active_bull_count, 1)?,
            total_buck_power: math::checked_add_u64(
                current_owner_leaf.total_buck_power,
                bull_leaf.buck_power as u64,
            )?,
            bull_tree_root: new_bull_root.hash,
        })
    }
}

pub fn remove_bull_from_owner_leaf(
    current_owner_leaf: &OwnerLeaf,
    bull_proof: &CompressedBullProof,
) -> Result<OwnerLeaf> {
    require!(
        !bull_proof.leaf.is_empty(),
        RodeoError::BullRegistrySlotEmpty
    );
    require!(
        bull_proof.leaf.owner == current_owner_leaf.owner,
        RodeoError::BullRegistryOwnerMismatch
    );

    let (new_bull_root, _) = recompute_root_after_replace(
        &bull_proof.leaf.position.to_bytes(),
        &bull_proof.proof,
        &BullLeaf::empty().to_node(),
        PREFIX_BULL_NODE,
        &default_bull_leaf_node(),
    )?;

    let new_count = math::checked_sub_u64(current_owner_leaf.active_bull_count, 1)?;
    let new_power = math::checked_sub_u64(
        current_owner_leaf.total_buck_power,
        bull_proof.leaf.buck_power as u64,
    )?;

    if new_count == 0 {
        Ok(OwnerLeaf::empty())
    } else {
        Ok(OwnerLeaf {
            owner: current_owner_leaf.owner,
            active_bull_count: new_count,
            total_buck_power: new_power,
            bull_tree_root: new_bull_root.hash,
        })
    }
}

// ---------------------------------------------------------------------------
// Global BullRegistry mutations.
// ---------------------------------------------------------------------------

pub fn apply_owner_leaf_update(
    current_root: &[u8; 32],
    owner: &Pubkey,
    owner_proof: &CompressedOwnerProof,
    new_owner_leaf: &OwnerLeaf,
) -> Result<[u8; 32]> {
    let new_node = new_owner_leaf.to_node();
    let current = owner_proof.leaf.to_node();

    // For an add of a previously absent owner the current leaf must be empty;
    // for an update the current leaf must match the supplied owner.
    if owner_proof.leaf.is_empty() {
        require_eq!(
            new_owner_leaf.owner,
            *owner,
            RodeoError::BullRegistryOwnerMismatch
        );
    } else {
        require_keys_eq!(
            owner_proof.leaf.owner,
            *owner,
            RodeoError::BullRegistryOwnerMismatch
        );
    }

    let (recomputed, _) = recompute_root_after_replace(
        &owner.to_bytes(),
        &owner_proof.proof,
        &new_node,
        PREFIX_BULL_OWNER_NODE,
        &default_owner_leaf_node(),
    )?;

    if current_root != &[0u8; 32] {
        // The supplied proof must reconstruct the current canonical root.
        let (check_root, _) = recompute_root_after_replace(
            &owner.to_bytes(),
            &owner_proof.proof,
            &current,
            PREFIX_BULL_OWNER_NODE,
            &default_owner_leaf_node(),
        )?;
        require!(
            check_root.hash == *current_root,
            RodeoError::BullRegistryInvalidRoot
        );
    }

    Ok(recomputed.hash)
}

pub fn leaf_contains_target(prefix: u64, leaf_power: u64, target: u64) -> bool {
    target >= prefix && target < prefix.saturating_add(leaf_power)
}

pub fn skip_victim_interval(external_target: u64, victim_prefix: u64, victim_power: u64) -> u64 {
    if external_target < victim_prefix {
        external_target
    } else {
        external_target.saturating_add(victim_power)
    }
}

pub fn add_bull_to_registry(
    registry: &mut crate::state::BullRegistry,
    bull_leaf: &BullLeaf,
    owner_proof: &CompressedOwnerProof,
    bull_proof: &CompressedBullProof,
) -> Result<()> {
    let new_owner_leaf = add_bull_to_owner_leaf(&owner_proof.leaf, bull_leaf, bull_proof)?;
    registry.owner_tree_root = apply_owner_leaf_update(
        &registry.owner_tree_root,
        &bull_leaf.owner,
        owner_proof,
        &new_owner_leaf,
    )?;
    registry.total_bull_count = math::checked_add_u64(registry.total_bull_count, 1)?;
    registry.total_buck_power =
        math::checked_add_u64(registry.total_buck_power, bull_leaf.buck_power as u64)?;
    registry.registry_version = math::checked_add_u64(registry.registry_version, 1)?;
    Ok(())
}

pub fn remove_bull_from_registry(
    registry: &mut crate::state::BullRegistry,
    bull_leaf: &BullLeaf,
    owner_proof: &CompressedOwnerProof,
    bull_proof: &CompressedBullProof,
) -> Result<()> {
    let new_owner_leaf = remove_bull_from_owner_leaf(&owner_proof.leaf, bull_proof)?;
    registry.owner_tree_root = apply_owner_leaf_update(
        &registry.owner_tree_root,
        &bull_leaf.owner,
        owner_proof,
        &new_owner_leaf,
    )?;
    registry.total_bull_count = math::checked_sub_u64(registry.total_bull_count, 1)?;
    registry.total_buck_power =
        math::checked_sub_u64(registry.total_buck_power, bull_leaf.buck_power as u64)?;
    registry.registry_version = math::checked_add_u64(registry.registry_version, 1)?;
    Ok(())
}
