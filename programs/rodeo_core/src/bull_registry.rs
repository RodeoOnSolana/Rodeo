use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

use crate::constants::*;
use crate::math;
use crate::RodeoError;

// ---------------------------------------------------------------------------
// Domain-separated hash prefixes for the two-level Merkle-sum tree.
// ---------------------------------------------------------------------------

const PREFIX_BULL_OWNER_LEAF: &[u8] = b"rodeo_v1_bull_owner_leaf";
const PREFIX_BULL_LEAF: &[u8] = b"rodeo_v1_bull_leaf";
const PREFIX_BULL_OWNER_NODE: &[u8] = b"rodeo_v1_bull_owner_node";
const PREFIX_BULL_NODE: &[u8] = b"rodeo_v1_bull_node";

const EMPTY_LEAF_HASH_OWNER: &[u8] = b"rodeo_v1_owner_empty";
const EMPTY_LEAF_HASH_BULL: &[u8] = b"rodeo_v1_bull_empty";

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
}

// ---------------------------------------------------------------------------
// Default empty leaves.  These are the canonical default values for a zero slot.
// ---------------------------------------------------------------------------

pub fn default_bull_leaf_hash() -> [u8; 32] {
    BullLeaf::empty().hash()
}

pub fn default_owner_leaf_hash() -> [u8; 32] {
    OwnerLeaf::empty().hash()
}

fn empty_tree_root(depth: u32, leaf_hash: [u8; 32], prefix: &[u8]) -> Result<[u8; 32]> {
    let mut current_hash = leaf_hash;
    let mut current_power = 0u64;
    for _ in 0..depth {
        let (parent_hash, _) = node_hash(
            prefix,
            &current_hash,
            current_power,
            &current_hash,
            current_power,
        )?;
        current_hash = parent_hash;
    }
    Ok(current_hash)
}

pub fn empty_bull_tree_root() -> [u8; 32] {
    empty_tree_root(
        BULL_REGISTRY_BULL_TREE_DEPTH,
        default_bull_leaf_hash(),
        PREFIX_BULL_NODE,
    )
    .expect("empty bull tree root is well-formed")
}

pub fn empty_owner_tree_root() -> [u8; 32] {
    empty_tree_root(
        BULL_REGISTRY_OWNER_TREE_DEPTH,
        default_owner_leaf_hash(),
        PREFIX_BULL_OWNER_NODE,
    )
    .expect("empty owner tree root is well-formed")
}

// ---------------------------------------------------------------------------
// Internal node hash for the Merkle-sum tree.
// The hash binds the child hashes and their total powers.
// ---------------------------------------------------------------------------

fn node_hash(
    prefix: &[u8],
    left_hash: &[u8; 32],
    left_power: u64,
    right_hash: &[u8; 32],
    right_power: u64,
) -> Result<([u8; 32], u64)> {
    let total_power = math::checked_add_u64(left_power, right_power)?;
    let hash = hashv(&[
        prefix,
        left_hash,
        &left_power.to_le_bytes(),
        right_hash,
        &right_power.to_le_bytes(),
    ])
    .to_bytes();
    Ok((hash, total_power))
}

fn owner_node_hash(
    left_hash: &[u8; 32],
    left_power: u64,
    right_hash: &[u8; 32],
    right_power: u64,
) -> Result<([u8; 32], u64)> {
    node_hash(
        PREFIX_BULL_OWNER_NODE,
        left_hash,
        left_power,
        right_hash,
        right_power,
    )
}

fn bull_node_hash(
    left_hash: &[u8; 32],
    left_power: u64,
    right_hash: &[u8; 32],
    right_power: u64,
) -> Result<([u8; 32], u64)> {
    node_hash(
        PREFIX_BULL_NODE,
        left_hash,
        left_power,
        right_hash,
        right_power,
    )
}

// ---------------------------------------------------------------------------
// Sibling entry in a Merkle path.
// `is_right` means the sibling is the RIGHT child, so the current path is the LEFT child.
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MerkleSibling {
    pub hash: [u8; 32],
    pub power: u64,
    pub is_right: bool, // true if sibling is the right child
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OwnerTreeProof {
    pub leaf_index: u32,
    pub leaf: OwnerLeaf,
    pub siblings: Vec<MerkleSibling>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BullTreeProof {
    pub leaf_index: u32,
    pub leaf: BullLeaf,
    pub siblings: Vec<MerkleSibling>,
}

// ---------------------------------------------------------------------------
// Proof verification.  Returns the leaf's in-order prefix (cumulative power before it).
// ---------------------------------------------------------------------------

pub fn verify_owner_tree_proof(expected_root: &[u8; 32], proof: &OwnerTreeProof) -> Result<u64> {
    require_eq!(
        proof.siblings.len(),
        BULL_REGISTRY_OWNER_TREE_DEPTH as usize,
        RodeoError::BullRegistryMalformedProof
    );
    require!(
        proof.leaf_index < (1u32 << BULL_REGISTRY_OWNER_TREE_DEPTH),
        RodeoError::BullRegistryMalformedProof
    );

    let mut current_hash = if proof.leaf.is_empty() {
        default_owner_leaf_hash()
    } else {
        proof.leaf.hash()
    };
    let mut current_power = if proof.leaf.is_empty() {
        0u64
    } else {
        proof.leaf.total_buck_power
    };
    let mut prefix = 0u64;

    for (level, sibling) in proof.siblings.iter().enumerate() {
        let (parent_hash, parent_power) = if sibling.is_right {
            // current is left child
            owner_node_hash(&current_hash, current_power, &sibling.hash, sibling.power)?
        } else {
            // current is right child: all leaves in the left sibling come before us
            prefix = math::checked_add_u64(prefix, sibling.power)?;
            owner_node_hash(&sibling.hash, sibling.power, &current_hash, current_power)?
        };
        current_hash = parent_hash;
        current_power = parent_power;

        let max_index = 1u32 << (level + 1);
        if proof.leaf_index >= max_index {
            return Err(error!(RodeoError::BullRegistryMalformedProof));
        }
    }

    if current_hash != *expected_root {
        return Err(error!(RodeoError::BullRegistryInvalidRoot));
    }
    Ok(prefix)
}

pub fn verify_bull_tree_proof(expected_root: &[u8; 32], proof: &BullTreeProof) -> Result<u64> {
    require_eq!(
        proof.siblings.len(),
        BULL_REGISTRY_BULL_TREE_DEPTH as usize,
        RodeoError::BullRegistryMalformedProof
    );
    require!(
        proof.leaf_index < (1u32 << BULL_REGISTRY_BULL_TREE_DEPTH),
        RodeoError::BullRegistryMalformedProof
    );

    let mut current_hash = if proof.leaf.is_empty() {
        default_bull_leaf_hash()
    } else {
        proof.leaf.hash()
    };
    let mut current_power = if proof.leaf.is_empty() {
        0u64
    } else {
        proof.leaf.buck_power as u64
    };
    let mut prefix = 0u64;

    for sibling in proof.siblings.iter() {
        let (parent_hash, parent_power) = if sibling.is_right {
            bull_node_hash(&current_hash, current_power, &sibling.hash, sibling.power)?
        } else {
            prefix = math::checked_add_u64(prefix, sibling.power)?;
            bull_node_hash(&sibling.hash, sibling.power, &current_hash, current_power)?
        };
        current_hash = parent_hash;
        current_power = parent_power;
    }

    if current_hash != *expected_root {
        return Err(error!(RodeoError::BullRegistryInvalidRoot));
    }
    Ok(prefix)
}

// ---------------------------------------------------------------------------
// Root recomputation after a leaf replacement.
// `new_leaf` may be the empty/default leaf (for removals).
// Returns the new root and the new tree total power.
// ---------------------------------------------------------------------------

fn recompute_root_with_replaced_leaf(
    siblings: &[MerkleSibling],
    leaf_index: u32,
    new_leaf_hash: &[u8; 32],
    new_leaf_power: u64,
    is_owner: bool,
) -> Result<([u8; 32], u64)> {
    require!(
        leaf_index < (1u32 << siblings.len()),
        RodeoError::BullRegistryMalformedProof
    );

    let mut current_hash = *new_leaf_hash;
    let mut current_power = new_leaf_power;

    for sibling in siblings.iter() {
        let (parent_hash, parent_power) = if sibling.is_right {
            if is_owner {
                owner_node_hash(&current_hash, current_power, &sibling.hash, sibling.power)?
            } else {
                bull_node_hash(&current_hash, current_power, &sibling.hash, sibling.power)?
            }
        } else if is_owner {
            owner_node_hash(&sibling.hash, sibling.power, &current_hash, current_power)?
        } else {
            bull_node_hash(&sibling.hash, sibling.power, &current_hash, current_power)?
        };
        current_hash = parent_hash;
        current_power = parent_power;
    }

    Ok((current_hash, current_power))
}

pub fn recompute_owner_root_after_replace(
    proof: &OwnerTreeProof,
    new_leaf: &OwnerLeaf,
) -> Result<([u8; 32], u64)> {
    let new_hash = new_leaf.hash();
    let new_power = if new_leaf.is_empty() {
        0u64
    } else {
        new_leaf.total_buck_power
    };
    recompute_root_with_replaced_leaf(
        &proof.siblings,
        proof.leaf_index,
        &new_hash,
        new_power,
        true,
    )
}

pub fn recompute_bull_root_after_replace(
    proof: &BullTreeProof,
    new_leaf: &BullLeaf,
) -> Result<([u8; 32], u64)> {
    let new_hash = new_leaf.hash();
    let new_power = if new_leaf.is_empty() {
        0u64
    } else {
        new_leaf.buck_power as u64
    };
    recompute_root_with_replaced_leaf(
        &proof.siblings,
        proof.leaf_index,
        &new_hash,
        new_power,
        false,
    )
}

// ---------------------------------------------------------------------------
// Convenience helpers for add/remove.
// ---------------------------------------------------------------------------

pub fn add_bull_to_owner_leaf(
    current_owner_leaf: &OwnerLeaf,
    bull_leaf: &BullLeaf,
    empty_leaf_proof: &BullTreeProof,
) -> Result<OwnerLeaf> {
    require!(
        empty_leaf_proof.leaf.is_empty(),
        RodeoError::BullRegistrySlotOccupied
    );
    require!(
        current_owner_leaf.is_empty() || current_owner_leaf.owner == bull_leaf.owner,
        RodeoError::BullRegistryOwnerMismatch
    );

    verify_bull_tree_proof(&current_owner_leaf.bull_tree_root, empty_leaf_proof)?;
    let (new_bull_root, _) = recompute_bull_root_after_replace(empty_leaf_proof, bull_leaf)?;

    if current_owner_leaf.is_empty() {
        Ok(OwnerLeaf {
            owner: bull_leaf.owner,
            active_bull_count: 1,
            total_buck_power: bull_leaf.buck_power as u64,
            bull_tree_root: new_bull_root,
        })
    } else {
        Ok(OwnerLeaf {
            owner: current_owner_leaf.owner,
            active_bull_count: math::checked_add_u64(current_owner_leaf.active_bull_count, 1)?,
            total_buck_power: math::checked_add_u64(
                current_owner_leaf.total_buck_power,
                bull_leaf.buck_power as u64,
            )?,
            bull_tree_root: new_bull_root,
        })
    }
}

pub fn remove_bull_from_owner_leaf(
    current_owner_leaf: &OwnerLeaf,
    bull_proof: &BullTreeProof,
) -> Result<OwnerLeaf> {
    require!(
        !bull_proof.leaf.is_empty(),
        RodeoError::BullRegistrySlotEmpty
    );
    require!(
        bull_proof.leaf.owner == current_owner_leaf.owner,
        RodeoError::BullRegistryOwnerMismatch
    );

    verify_bull_tree_proof(&current_owner_leaf.bull_tree_root, bull_proof)?;
    let (new_bull_root, _) = recompute_bull_root_after_replace(bull_proof, &BullLeaf::empty())?;

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
            bull_tree_root: new_bull_root,
        })
    }
}

// ---------------------------------------------------------------------------
// Selection helpers: derive the weighted target and check a leaf contains it.
// ---------------------------------------------------------------------------

pub fn skip_victim_interval(
    safe_draw: u64,
    victim_total_power: u64,
    victim_prefix: u64,
) -> Result<u64> {
    if safe_draw < victim_prefix {
        Ok(safe_draw)
    } else {
        math::checked_add_u64(safe_draw, victim_total_power)
    }
}

pub fn leaf_contains_target(prefix: u64, leaf_power: u64, target: u64) -> bool {
    let start = prefix;
    let end = prefix.saturating_add(leaf_power);
    start <= target && target < end
}
