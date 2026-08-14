use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::{hash as sol_hash, hashv};

use crate::empty_nodes::empty_nodes_for_prefix;
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

/// Canonical compressed sparse Merkle proof.
///
/// Path derivation:
///   - key is a 32-byte Pubkey.
///   - level i uses bit i of the key, with bit 0 as the LSB of bytes[0].
///   - bit = 0 -> left child; bit = 1 -> right child.
///   - The leaf is at level 0 and the root is at level SPARSE_TREE_DEPTH.
///
/// Bitmap semantics:
///   - 32 bytes (256 bits), one bit per tree level.
///   - bit i set (1) means a non-default sibling for level i is provided.
///   - bit i clear (0) means the canonical empty node for level i is used.
///   - The LSB of bitmap[0] is level 0; bitmap[31] is the last byte.
///
/// Siblings:
///   - Provided in strictly ascending level order (0, 1, ..., 255).
///   - The number of siblings must equal the number of set bits.
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

#[inline(always)]
#[inline(always)]

pub fn hash_node(
    prefix: &[u8],
    left: &SparseMerkleNode,
    right: &SparseMerkleNode,
) -> Result<SparseMerkleNode> {
    let count = math::checked_add_u64(left.count, right.count)?;
    let power = math::checked_add_u64(left.power, right.power)?;

    // Flatten the hash preimage into a stack buffer and use the single-buffer
    // sol_hash entry point.  This avoids the multi-slice hashv path that has
    // been observed to allocate in the SBF runtime for many sibling levels.
    let mut buf = [0u8; 256];
    let mut off = 0usize;
    let append = |buf: &mut [u8; 256], off: &mut usize, bytes: &[u8]| {
        let end = *off + bytes.len();
        buf[*off..end].copy_from_slice(bytes);
        *off = end;
    };
    append(&mut buf, &mut off, prefix);
    append(&mut buf, &mut off, &left.hash);
    append(&mut buf, &mut off, &left.count.to_le_bytes());
    append(&mut buf, &mut off, &left.power.to_le_bytes());
    append(&mut buf, &mut off, &right.hash);
    append(&mut buf, &mut off, &right.count.to_le_bytes());
    append(&mut buf, &mut off, &right.power.to_le_bytes());
    let hash = sol_hash(&buf[..off]).to_bytes();
    Ok(SparseMerkleNode { hash, count, power })
}

/// Compute the canonical empty root for a tree whose empty leaf is `leaf`.
pub fn compute_empty_root(leaf: &SparseMerkleNode, node_prefix: &[u8]) -> Result<SparseMerkleNode> {
    let mut current = *leaf;
    for _ in 0..SPARSE_TREE_DEPTH {
        current = hash_node(node_prefix, &current, &current)?;
    }
    Ok(current)
}

/// Canonical compressed-proof validation: every set bit must have a sibling,
/// every provided sibling must correspond to a set bit, and no bits above the
/// tree depth may be set.  Trailing/leading extra siblings are rejected.
fn validate_compressed_proof(proof: &CompressedSparseProof) -> Result<()> {
    let set_bits = proof
        .bitmap
        .iter()
        .map(|b| b.count_ones() as usize)
        .sum::<usize>();
    require_eq!(
        proof.siblings.len(),
        set_bits,
        RodeoError::BullRegistryMalformedProof
    );

    // The last 4 bits of the last byte are unused because SPARSE_TREE_DEPTH = 256
    // and 256 % 8 == 0, so all 32 bytes are consumed exactly.  No stray bits.
    Ok(())
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
    validate_compressed_proof(proof)?;

    let mut current = *leaf;
    let empty_table = empty_nodes_for_prefix(node_prefix);
    let mut current_default = empty_table[0];
    let mut sibling_iter = proof.siblings.iter();

    for level in 0..SPARSE_TREE_DEPTH {
        let sibling = if bitmap_bit_set(&proof.bitmap, level) {
            sibling_iter
                .next()
                .copied()
                .ok_or(RodeoError::BullRegistryMalformedProof)?
        } else {
            current_default
        };

        current = if bit_at_256(key, level) {
            hash_node(node_prefix, &sibling, &current)?
        } else {
            hash_node(node_prefix, &current, &sibling)?
        };

        current_default = empty_table[(level + 1) as usize];
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
    validate_compressed_proof(proof)?;

    let mut current = *new_leaf;
    let empty_table = empty_nodes_for_prefix(node_prefix);
    let mut current_default = empty_table[0];
    let mut sibling_iter = proof.siblings.iter();

    for level in 0..SPARSE_TREE_DEPTH {
        let sibling = if bitmap_bit_set(&proof.bitmap, level) {
            sibling_iter
                .next()
                .copied()
                .ok_or(RodeoError::BullRegistryMalformedProof)?
        } else {
            current_default
        };

        current = if bit_at_256(key, level) {
            hash_node(node_prefix, &sibling, &current)?
        } else {
            hash_node(node_prefix, &current, &sibling)?
        };

        current_default = empty_table[(level + 1) as usize];
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
    validate_compressed_proof(proof)?;

    let mut current = *leaf;
    let empty_table = empty_nodes_for_prefix(node_prefix);
    let mut current_default = empty_table[0];
    let mut prefix = 0u64;
    let mut sibling_iter = proof.siblings.iter();

    for level in 0..SPARSE_TREE_DEPTH {
        let sibling = if bitmap_bit_set(&proof.bitmap, level) {
            sibling_iter
                .next()
                .copied()
                .ok_or(RodeoError::BullRegistryMalformedProof)?
        } else {
            current_default
        };

        current = if bit_at_256(key, level) {
            prefix = math::checked_add_u64(prefix, sibling.power)?;
            hash_node(node_prefix, &sibling, &current)?
        } else {
            hash_node(node_prefix, &current, &sibling)?
        };

        current_default = empty_table[(level + 1) as usize];
    }

    if current.hash != *expected_root {
        return Err(error!(RodeoError::BullRegistryInvalidRoot));
    }
    Ok((current, prefix))
}

/// Compute the default empty nodes for a tree.  Test-only helper.
/// The production verifier now derives these on-the-fly to avoid a heap
/// allocation per verification.
pub fn compute_default_empty_nodes(
    empty_leaf: &SparseMerkleNode,
    node_prefix: &[u8],
) -> Result<Vec<SparseMerkleNode>> {
    let mut nodes = Vec::with_capacity(SPARSE_TREE_DEPTH as usize + 1);
    nodes.push(*empty_leaf);
    let mut current = *empty_leaf;
    for _ in 0..SPARSE_TREE_DEPTH {
        current = hash_node(node_prefix, &current, &current)?;
        nodes.push(current);
    }
    Ok(nodes)
}

// ---------------------------------------------------------------------------
// Borrowed / allocation-light sparse proof types and verifiers.
// ---------------------------------------------------------------------------

/// Checked cursor over a borrowed byte slice.
pub struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    pub fn pos(&self) -> usize {
        self.pos
    }

    pub fn is_empty(&self) -> bool {
        self.pos >= self.data.len()
    }

    pub fn read_u8(&mut self) -> Result<u8> {
        require!(
            self.pos < self.data.len(),
            RodeoError::BullProofBufferIncomplete
        );
        let v = self.data[self.pos];
        self.pos += 1;
        Ok(v)
    }

    pub fn read_u32(&mut self) -> Result<u32> {
        require!(
            self.pos + 4 <= self.data.len(),
            RodeoError::BullProofBufferIncomplete
        );
        let v =
            u32::from_le_bytes(<[u8; 4]>::try_from(&self.data[self.pos..self.pos + 4]).unwrap());
        self.pos += 4;
        Ok(v)
    }

    pub fn read_u64(&mut self) -> Result<u64> {
        require!(
            self.pos + 8 <= self.data.len(),
            RodeoError::BullProofBufferIncomplete
        );
        let v =
            u64::from_le_bytes(<[u8; 8]>::try_from(&self.data[self.pos..self.pos + 8]).unwrap());
        self.pos += 8;
        Ok(v)
    }

    pub fn read_pubkey(&mut self) -> Result<Pubkey> {
        let bytes = self.read_fixed::<32>()?;
        Ok(Pubkey::new_from_array(bytes))
    }

    pub fn read_hash(&mut self) -> Result<[u8; 32]> {
        self.read_fixed::<32>()
    }

    pub fn read_fixed<const N: usize>(&mut self) -> Result<[u8; N]> {
        require!(
            self.pos + N <= self.data.len(),
            RodeoError::BullProofBufferIncomplete
        );
        let v = <[u8; N]>::try_from(&self.data[self.pos..self.pos + N])
            .map_err(|_| error!(RodeoError::BullProofBufferIncomplete))?;
        self.pos += N;
        Ok(v)
    }

    pub fn read_slice(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .pos
            .checked_add(len)
            .ok_or(RodeoError::ArithmeticOverflow)?;
        require!(
            end <= self.data.len(),
            RodeoError::BullProofBufferIncomplete
        );
        let slice = &self.data[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    pub fn read_node(&mut self) -> Result<SparseMerkleNode> {
        let hash = self.read_hash()?;
        let count = self.read_u64()?;
        let power = self.read_u64()?;
        Ok(SparseMerkleNode { hash, count, power })
    }
}

/// Compressed sparse proof with borrowed sibling bytes.
#[derive(Clone, Copy)]
pub struct CompressedSparseProofRef<'a> {
    pub bitmap: [u8; SPARSE_TREE_BITMAP_BYTES],
    pub siblings: &'a [u8],
    pub leaf: SparseMerkleNode,
}

impl<'a> CompressedSparseProofRef<'a> {
    pub fn from_cursor(cursor: &mut Cursor<'a>) -> Result<Self> {
        let bitmap = cursor.read_fixed::<SPARSE_TREE_BITMAP_BYTES>()?;
        let siblings_len = cursor.read_u32()? as usize;
        let sibling_bytes = siblings_len
            .checked_mul(48)
            .ok_or(RodeoError::ArithmeticOverflow)?;
        let siblings = cursor.read_slice(sibling_bytes)?;
        let leaf = cursor.read_node()?;
        Ok(Self {
            bitmap,
            siblings,
            leaf,
        })
    }

    pub fn sibling_count(&self) -> usize {
        self.siblings.len() / 48
    }
}

fn read_node_from_slice(siblings: &[u8], offset: usize) -> Result<SparseMerkleNode> {
    require!(
        offset + 48 <= siblings.len(),
        RodeoError::BullRegistryMalformedProof
    );
    let hash: [u8; 32] = <[u8; 32]>::try_from(&siblings[offset..offset + 32])
        .map_err(|_| error!(RodeoError::BullRegistryMalformedProof))?;
    let count =
        u64::from_le_bytes(<[u8; 8]>::try_from(&siblings[offset + 32..offset + 40]).unwrap());
    let power =
        u64::from_le_bytes(<[u8; 8]>::try_from(&siblings[offset + 40..offset + 48]).unwrap());
    Ok(SparseMerkleNode { hash, count, power })
}

fn validate_compressed_proof_ref(proof: &CompressedSparseProofRef) -> Result<()> {
    let set_bits = proof
        .bitmap
        .iter()
        .map(|b| b.count_ones() as usize)
        .sum::<usize>();
    require_eq!(
        proof.siblings.len(),
        set_bits * 48,
        RodeoError::BullRegistryMalformedProof
    );
    Ok(())
}

pub fn verify_ref(
    expected_root: &[u8; 32],
    key: &[u8; 32],
    proof: &CompressedSparseProofRef<'_>,
    leaf: &SparseMerkleNode,
    node_prefix: &[u8],
    empty_leaf: &SparseMerkleNode,
) -> Result<SparseMerkleNode> {
    validate_compressed_proof_ref(proof)?;

    let mut current = *leaf;
    let empty_table = empty_nodes_for_prefix(node_prefix);
    let mut current_default = empty_table[0];
    let mut sibling_offset = 0usize;

    for level in 0..SPARSE_TREE_DEPTH {
        let sibling = if bitmap_bit_set(&proof.bitmap, level) {
            let node = read_node_from_slice(proof.siblings, sibling_offset)?;
            sibling_offset += 48;
            node
        } else {
            current_default
        };

        current = if bit_at_256(key, level) {
            hash_node(node_prefix, &sibling, &current)?
        } else {
            hash_node(node_prefix, &current, &sibling)?
        };

        current_default = empty_table[(level + 1) as usize];
    }

    require!(
        current.hash == *expected_root,
        RodeoError::BullRegistryInvalidRoot
    );
    Ok(current)
}
#[inline(always)]

pub fn verify_with_prefix_ref(
    expected_root: &[u8; 32],
    key: &[u8; 32],
    proof: &CompressedSparseProofRef<'_>,
    leaf: &SparseMerkleNode,
    node_prefix: &[u8],
    empty_leaf: &SparseMerkleNode,
) -> Result<(SparseMerkleNode, u64)> {
    validate_compressed_proof_ref(proof)?;

    let mut current = *leaf;
    let empty_table = empty_nodes_for_prefix(node_prefix);
    let mut current_default = empty_table[0];
    let mut prefix = 0u64;
    let mut sibling_offset = 0usize;

    for level in 0..SPARSE_TREE_DEPTH {
        let sibling = if bitmap_bit_set(&proof.bitmap, level) {
            let node = read_node_from_slice(proof.siblings, sibling_offset)?;
            sibling_offset += 48;
            node
        } else {
            current_default
        };

        current = if bit_at_256(key, level) {
            prefix = math::checked_add_u64(prefix, sibling.power)?;
            hash_node(node_prefix, &sibling, &current)?
        } else {
            hash_node(node_prefix, &current, &sibling)?
        };

        current_default = empty_table[(level + 1) as usize];
    }

    require!(
        current.hash == *expected_root,
        RodeoError::BullRegistryInvalidRoot
    );
    Ok((current, prefix))
}

pub fn recompute_root_after_replace_ref(
    key: &[u8; 32],
    proof: &CompressedSparseProofRef<'_>,
    new_leaf: &SparseMerkleNode,
    node_prefix: &[u8],
    empty_leaf: &SparseMerkleNode,
) -> Result<SparseMerkleNode> {
    validate_compressed_proof_ref(proof)?;

    let mut current = *new_leaf;
    let empty_table = empty_nodes_for_prefix(node_prefix);
    let mut current_default = empty_table[0];
    let mut sibling_offset = 0usize;

    for level in 0..SPARSE_TREE_DEPTH {
        let sibling = if bitmap_bit_set(&proof.bitmap, level) {
            let node = read_node_from_slice(proof.siblings, sibling_offset)?;
            sibling_offset += 48;
            node
        } else {
            current_default
        };

        current = if bit_at_256(key, level) {
            hash_node(node_prefix, &sibling, &current)?
        } else {
            hash_node(node_prefix, &current, &sibling)?
        };

        current_default = empty_table[(level + 1) as usize];
    }

    Ok(current)
}
