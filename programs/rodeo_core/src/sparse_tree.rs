use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

use crate::math;
use crate::RodeoError;

pub const SPARSE_TREE_DEPTH: u32 = 256;
pub const SPARSE_TREE_BITMAP_BYTES: usize = (SPARSE_TREE_DEPTH as usize + 7) / 8;

/// A sparse Merkle-sum node.  The hash commits to count and power, so a root
/// cannot change population/totals without changing.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct SparseMerkleNode {
    pub hash: [u8; 32],
    pub count: u64,
    pub power: u64,
}

/// Compressed sparse Merkle proof.  The path is implied by the key.  The
/// bitmap marks which levels contain non-default siblings; omitted levels use
/// the precomputed default node for that depth.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CompressedSparseProof {
    /// 256-bit bitmap, one bit per level (0 = default sibling, 1 = provided).
    pub bitmap: [u8; SPARSE_TREE_BITMAP_BYTES],
    /// Non-default siblings in level order from the leaf (level 0) up.
    pub siblings: Vec<SparseMerkleNode>,
    /// The leaf node being proved.
    pub leaf: SparseMerkleNode,
}

fn bit_at_256(bytes: &[u8; 32], index: u32) -> bool {
    let byte_index = (index / 8) as usize;
    let bit_index = index % 8;
    (bytes[byte_index] >> bit_index) & 1 == 1
}

fn bitmap_bit_set(bitmap: &[u8; SPARSE_TREE_BITMAP_BYTES], index: u32) -> bool {
    let byte_index = (index / 8) as usize;
    let bit_index = index % 8;
    if byte_index >= bitmap.len() {
        return false;
    }
    (bitmap[byte_index] >> bit_index) & 1 == 1
}

pub fn hash_node(
    prefix: &[u8],
    left: &SparseMerkleNode,
    right: &SparseMerkleNode,
) -> Result<SparseMerkleNode> {
    let count = math::checked_add_u64(left.count, right.count)?;
    let power = math::checked_add_u64(left.power, right.power)?;
    let hash = hashv(&[
        prefix,
        &left.hash,
        &left.count.to_le_bytes(),
        &left.power.to_le_bytes(),
        &right.hash,
        &right.count.to_le_bytes(),
        &right.power.to_le_bytes(),
    ])
    .to_bytes();
    Ok(SparseMerkleNode { hash, count, power })
}

/// Compute default nodes for an empty sparse tree.  `nodes[0]` is the empty
/// leaf and `nodes[SPARSE_TREE_DEPTH]` is the empty root.
pub fn compute_default_empty_nodes(
    leaf: &SparseMerkleNode,
    node_prefix: &[u8],
) -> Result<Vec<SparseMerkleNode>> {
    let mut nodes = Vec::with_capacity((SPARSE_TREE_DEPTH + 1) as usize);
    nodes.push(*leaf);
    for _ in 0..SPARSE_TREE_DEPTH {
        let last = nodes.last().unwrap();
        let parent = hash_node(node_prefix, last, last)?;
        nodes.push(parent);
    }
    Ok(nodes)
}

/// Verify a compressed sparse Merkle-sum proof for `key` against an expected
/// root hash.  Returns the authenticated root node (hash, count, power).
pub fn verify(
    expected_root: &[u8; 32],
    key: &[u8; 32],
    proof: &CompressedSparseProof,
    leaf: &SparseMerkleNode,
    node_prefix: &[u8],
    empty_leaf: &SparseMerkleNode,
) -> Result<SparseMerkleNode> {
    let default_nodes = compute_default_empty_nodes(empty_leaf, node_prefix)?;

    let mut current = *leaf;
    let mut sibling_iter = proof.siblings.iter();

    for level in 0..SPARSE_TREE_DEPTH {
        let sibling = if bitmap_bit_set(&proof.bitmap, level) {
            sibling_iter
                .next()
                .copied()
                .ok_or(RodeoError::BullRegistryMalformedProof)?
        } else {
            default_nodes[level as usize]
        };

        current = if bit_at_256(key, level) {
            hash_node(node_prefix, &sibling, &current)?
        } else {
            hash_node(node_prefix, &current, &sibling)?
        };
    }

    if current.hash != *expected_root {
        return Err(error!(RodeoError::BullRegistryInvalidRoot));
    }
    Ok(current)
}

/// Recompute a root after replacing the leaf at `key`'s canonical path with
/// `new_leaf`, using the same compressed siblings as the original proof.
/// Returns the new root node.
pub fn recompute_root_after_replace(
    key: &[u8; 32],
    proof: &CompressedSparseProof,
    new_leaf: &SparseMerkleNode,
    node_prefix: &[u8],
    empty_leaf: &SparseMerkleNode,
) -> Result<SparseMerkleNode> {
    let default_nodes = compute_default_empty_nodes(empty_leaf, node_prefix)?;

    let mut current = *new_leaf;
    let mut sibling_iter = proof.siblings.iter();

    for level in 0..SPARSE_TREE_DEPTH {
        let sibling = if bitmap_bit_set(&proof.bitmap, level) {
            sibling_iter
                .next()
                .copied()
                .ok_or(RodeoError::BullRegistryMalformedProof)?
        } else {
            default_nodes[level as usize]
        };

        current = if bit_at_256(key, level) {
            hash_node(node_prefix, &sibling, &current)?
        } else {
            hash_node(node_prefix, &current, &sibling)?
        };
    }

    Ok(current)
}

/// Compute the prefix power (cumulative power of all keys lexicographically
/// smaller in path order) while verifying.  This is the same traversal as
/// `verify` but accumulates left-sibling power when the path turns right.
pub fn verify_with_prefix(
    expected_root: &[u8; 32],
    key: &[u8; 32],
    proof: &CompressedSparseProof,
    leaf: &SparseMerkleNode,
    node_prefix: &[u8],
    empty_leaf: &SparseMerkleNode,
) -> Result<(SparseMerkleNode, u64)> {
    let default_nodes = compute_default_empty_nodes(empty_leaf, node_prefix)?;

    let mut current = *leaf;
    let mut prefix = 0u64;
    let mut sibling_iter = proof.siblings.iter();

    for level in 0..SPARSE_TREE_DEPTH {
        let sibling = if bitmap_bit_set(&proof.bitmap, level) {
            sibling_iter
                .next()
                .copied()
                .ok_or(RodeoError::BullRegistryMalformedProof)?
        } else {
            default_nodes[level as usize]
        };

        current = if bit_at_256(key, level) {
            prefix = math::checked_add_u64(prefix, sibling.power)?;
            hash_node(node_prefix, &sibling, &current)?
        } else {
            hash_node(node_prefix, &current, &sibling)?
        };
    }

    if current.hash != *expected_root {
        return Err(error!(RodeoError::BullRegistryInvalidRoot));
    }
    Ok((current, prefix))
}
