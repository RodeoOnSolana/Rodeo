#![recursion_limit = "256"]

use std::path::PathBuf;
use std::time::Instant;

use anchor_lang::prelude::*;
use anchor_lang::AnchorSerialize;
use rodeo_core::bull_registry::{
    add_bull_to_owner_leaf, apply_owner_leaf_update, leaf_contains_target, skip_victim_interval,
    BullLeaf, BullProofPayloadV1, CompressedBullProof, CompressedOwnerProof, OwnerLeaf,
    BULL_PROOF_PAYLOAD_SCHEMA_VERSION, SECTION_CURRENT_BULL, SECTION_CURRENT_OWNER,
    SECTION_REMOVE_BULL, SECTION_SELECTED_BULL, SECTION_SELECTED_OWNER, SECTION_VICTIM_OWNER,
};
use rodeo_core::constants::*;
use rodeo_core::probability::{
    buck_power_for_tier, map_bull_tier, map_mint_theft_flag, map_role, protocol_config_v1,
    rejection_sample_draw, RandomnessDomain, RandomnessSampleContext,
};
use rodeo_core::sparse_tree::{
    hash_node, verify_with_prefix, CompressedSparseProof, SparseMerkleNode, SPARSE_TREE_DEPTH,
};
use rodeo_core::state::{ActionType, Role};
use serde_json::json;
use solana_program::hash::{hash, hashv};

// Protocol private node prefixes reproduced here for the off-chain prover.
const PREFIX_BULL_OWNER_NODE: &[u8] = b"rodeo_v2_bull_owner_node";
const PREFIX_BULL_NODE: &[u8] = b"rodeo_v2_bull_node";

const POWERS: [u8; 4] = [4, 6, 8, 10];
const BULL_DISTRIBUTION: [u64; 10] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const NO_CHILD: u32 = u32::MAX;

// ---------------------------------------------------------------------------
// Efficient Vec-backed sparse 256-bit binary trie for off-chain prover.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
struct Node {
    child: [u32; 2],
    height: u16,
    node: SparseMerkleNode,
}

impl Node {
    fn new(height: u16, default: SparseMerkleNode) -> Self {
        Self {
            child: [NO_CHILD, NO_CHILD],
            height,
            node: default,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SparseTree {
    nodes: Vec<Node>,
    defaults: Vec<SparseMerkleNode>,
    prefix: &'static [u8],
}

impl SparseTree {
    fn new(empty_leaf: &SparseMerkleNode, prefix: &'static [u8]) -> Self {
        let defaults =
            rodeo_core::sparse_tree::compute_default_empty_nodes(empty_leaf, prefix).unwrap();
        let root = Node::new(
            SPARSE_TREE_DEPTH as u16,
            defaults[SPARSE_TREE_DEPTH as usize],
        );
        Self {
            nodes: vec![root],
            defaults,
            prefix,
        }
    }

    fn bit_at(bytes: &[u8; 32], index: u32) -> bool {
        let byte_index = (index / 8) as usize;
        let bit_index = index % 8;
        (bytes[byte_index] >> bit_index) & 1 == 1
    }

    fn insert(&mut self, key: &[u8; 32], leaf: SparseMerkleNode) {
        let mut path: Vec<u32> = Vec::with_capacity(SPARSE_TREE_DEPTH as usize + 1);
        let mut current: u32 = 0;
        path.push(current);

        for h in (1..=SPARSE_TREE_DEPTH as usize).rev() {
            let bit = Self::bit_at(key, (h - 1) as u32) as usize;
            let next = if self.nodes[current as usize].child[bit] == NO_CHILD {
                let new_idx = self.nodes.len() as u32;
                let child_default = self.defaults[h - 1];
                self.nodes.push(Node::new((h - 1) as u16, child_default));
                self.nodes[current as usize].child[bit] = new_idx;
                new_idx
            } else {
                self.nodes[current as usize].child[bit]
            };
            current = next;
            path.push(current);
        }

        self.nodes[current as usize].node = leaf;

        for parent_idx in path.iter().rev().skip(1) {
            let parent_idx = *parent_idx as usize;
            let (child0, child1, h) = {
                let parent = &self.nodes[parent_idx];
                (parent.child[0], parent.child[1], parent.height as usize)
            };
            let left = if child0 == NO_CHILD {
                self.defaults[h - 1]
            } else {
                self.nodes[child0 as usize].node
            };
            let right = if child1 == NO_CHILD {
                self.defaults[h - 1]
            } else {
                self.nodes[child1 as usize].node
            };
            self.nodes[parent_idx].node = hash_node(self.prefix, &left, &right).unwrap();
        }
    }

    fn proof(&self, key: &[u8; 32]) -> CompressedSparseProof {
        let mut bitmap = [0u8; 32];
        let mut siblings_rev: Vec<SparseMerkleNode> =
            Vec::with_capacity(SPARSE_TREE_DEPTH as usize);
        let mut current: Option<u32> = Some(0);

        for h in (1..=SPARSE_TREE_DEPTH as usize).rev() {
            let bit = Self::bit_at(key, (h - 1) as u32) as usize;
            if let Some(idx) = current {
                let node = &self.nodes[idx as usize];
                let sibling_idx = node.child[1 - bit];
                if sibling_idx != NO_CHILD {
                    let sibling = self.nodes[sibling_idx as usize].node;
                    if sibling.hash != self.defaults[h - 1].hash
                        || sibling.count != self.defaults[h - 1].count
                        || sibling.power != self.defaults[h - 1].power
                    {
                        bitmap[(h - 1) / 8] |= 1 << ((h - 1) % 8);
                        siblings_rev.push(sibling);
                    }
                }
                current = if node.child[bit] == NO_CHILD {
                    None
                } else {
                    Some(node.child[bit])
                };
            }
        }

        siblings_rev.reverse();
        let leaf = current.map_or(self.defaults[0], |idx| self.nodes[idx as usize].node);

        CompressedSparseProof {
            bitmap,
            siblings: siblings_rev,
            leaf,
        }
    }

    fn root(&self) -> &SparseMerkleNode {
        &self.nodes[0].node
    }
}

// ---------------------------------------------------------------------------
// Registry construction
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct OwnerData {
    owner: Pubkey,
    owner_leaf: OwnerLeaf,
    bull_tree: Option<SparseTree>,
    bulls: Vec<BullLeaf>,
}

fn deterministic_owner(i: u64) -> Pubkey {
    Pubkey::new_from_array(hashv(&[b"owner", &i.to_le_bytes()]).to_bytes())
}

fn deterministic_bull(owner_index: u64, bull_index: u64) -> Pubkey {
    Pubkey::new_from_array(
        hashv(&[
            b"bull",
            &owner_index.to_le_bytes(),
            &bull_index.to_le_bytes(),
        ])
        .to_bytes(),
    )
}

fn build_bull_tree(bulls: &[BullLeaf]) -> SparseTree {
    let mut tree = SparseTree::new(&BullLeaf::empty().to_node(), PREFIX_BULL_NODE);
    for bull in bulls {
        tree.insert(&bull.position.to_bytes(), bull.to_node());
    }
    tree
}

fn build_bulls(
    owner_index: u64,
    bull_count: u64,
    total_count: &mut u64,
    total_power: &mut u64,
) -> Vec<BullLeaf> {
    let owner = deterministic_owner(owner_index);
    let mut bulls = Vec::with_capacity(bull_count as usize);
    for j in 0..bull_count {
        let position = deterministic_bull(owner_index, j);
        let power = POWERS[((owner_index + j) as usize) % POWERS.len()];
        let leaf = BullLeaf {
            position,
            position_id: *total_count + 1,
            owner,
            buck_power: power,
            reveal_config_version: 1,
        };
        bulls.push(leaf);
        *total_count += 1;
        *total_power += power as u64;
    }
    bulls
}

fn owner_leaf_from_bulls(owner: Pubkey, bulls: &[BullLeaf]) -> OwnerLeaf {
    let tree = build_bull_tree(bulls);
    let root = *tree.root();
    OwnerLeaf {
        owner,
        active_bull_count: bulls.len() as u64,
        total_buck_power: root.power,
        bull_tree_root: root.hash,
    }
}

fn build_registry(scale: usize) -> (SparseMerkleNode, Vec<OwnerData>, u64, u64, SparseTree) {
    let mut owners: Vec<OwnerData> = Vec::new();
    let mut total_count: u64 = 0;
    let mut total_power: u64 = 0;
    let mut owner_index: u64 = 0;

    let dense_count = if scale >= 2000 { 1000 } else { scale / 2 } as u64;
    let mut remaining = scale as u64 - dense_count;

    if dense_count > 0 {
        let owner = deterministic_owner(owner_index);
        let bulls = build_bulls(owner_index, dense_count, &mut total_count, &mut total_power);
        let owner_leaf = owner_leaf_from_bulls(owner, &bulls);
        owners.push(OwnerData {
            owner,
            owner_leaf,
            bull_tree: None,
            bulls,
        });
        owner_index += 1;
    }

    let mut pattern_idx = 0usize;
    while remaining > 0 {
        let wanted = BULL_DISTRIBUTION[pattern_idx % BULL_DISTRIBUTION.len()];
        let count = wanted.min(remaining);
        if count == 0 {
            break;
        }
        let owner = deterministic_owner(owner_index);
        let bulls = build_bulls(owner_index, count, &mut total_count, &mut total_power);
        let owner_leaf = owner_leaf_from_bulls(owner, &bulls);
        owners.push(OwnerData {
            owner,
            owner_leaf,
            bull_tree: None,
            bulls,
        });
        owner_index += 1;
        remaining -= count;
        pattern_idx += 1;
    }

    let mut owner_tree = SparseTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);
    for od in &owners {
        owner_tree.insert(&od.owner.to_bytes(), od.owner_leaf.to_node());
    }

    assert_eq!(owner_tree.root().count, total_count);
    assert_eq!(owner_tree.root().power, total_power);

    let dense_idx = if dense_count > 0 { Some(0usize) } else { None };
    let mut normal_idx = None;
    let mut one_idx = None;
    let mut multi_idx = None;
    let mut ten_idx = None;

    for (i, od) in owners.iter().enumerate() {
        if Some(i) == dense_idx {
            continue;
        }
        if normal_idx.is_none() {
            normal_idx = Some(i);
        }
        if od.bulls.len() == 1 && one_idx.is_none() {
            one_idx = Some(i);
        }
        if od.bulls.len() == 2 && multi_idx.is_none() {
            multi_idx = Some(i);
        }
        if od.bulls.len() == 10 && ten_idx.is_none() {
            ten_idx = Some(i);
        }
    }

    // Build and keep bull trees for the selected owners used in generated cases.
    for idx in [dense_idx, normal_idx, one_idx, multi_idx, ten_idx]
        .iter()
        .filter_map(|&x| x)
    {
        let od = &mut owners[idx];
        let tree = build_bull_tree(&od.bulls);
        assert_eq!(
            tree.root().hash,
            od.owner_leaf.bull_tree_root,
            "bull tree root mismatch"
        );
        od.bull_tree = Some(tree);
    }

    (
        *owner_tree.root(),
        owners,
        total_count,
        total_power,
        owner_tree,
    )
}

// Small registry for bull-subtree scaling.
// One target owner has `target_bull_count` bulls; the other owners have 1 bull.
const BULL_SUBTREE_OWNER_BASE: u64 = 2_000_000_000;

fn build_bull_subtree(
    target_bull_count: usize,
) -> (SparseMerkleNode, Vec<OwnerData>, u64, u64, SparseTree) {
    let mut owners: Vec<OwnerData> = Vec::new();
    let mut total_count: u64 = 0;
    let mut total_power: u64 = 0;

    let owner_count: u64 = 10;
    for i in 0..owner_count {
        let owner_index = BULL_SUBTREE_OWNER_BASE + i;
        let bull_count = if i == 0 { target_bull_count as u64 } else { 1 };
        let owner = deterministic_owner(owner_index);
        let bulls = build_bulls(owner_index, bull_count, &mut total_count, &mut total_power);
        let owner_leaf = owner_leaf_from_bulls(owner, &bulls);
        let bull_tree = build_bull_tree(&bulls);
        owners.push(OwnerData {
            owner,
            owner_leaf,
            bull_tree: Some(bull_tree),
            bulls,
        });
    }

    let mut owner_tree = SparseTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);
    for od in &owners {
        owner_tree.insert(&od.owner.to_bytes(), od.owner_leaf.to_node());
    }

    assert_eq!(owner_tree.root().count, total_count);
    assert_eq!(owner_tree.root().power, total_power);

    (
        *owner_tree.root(),
        owners,
        total_count,
        total_power,
        owner_tree,
    )
}

fn build_final_bull_fixture() -> (SparseMerkleNode, Vec<OwnerData>, u64, u64, SparseTree) {
    build_bull_subtree(1)
}

// ---------------------------------------------------------------------------
// Proof and payload construction
// ---------------------------------------------------------------------------

fn owner_proof_with_leaf(
    owner_tree: &SparseTree,
    owner: &Pubkey,
    leaf: OwnerLeaf,
) -> CompressedOwnerProof {
    let key = owner.to_bytes();
    CompressedOwnerProof {
        leaf,
        proof: owner_tree.proof(&key),
    }
}

fn bull_proof(od: &OwnerData, position: &Pubkey) -> CompressedBullProof {
    let tree = od
        .bull_tree
        .as_ref()
        .map_or_else(|| build_bull_tree(&od.bulls), |t| t.clone());
    let key = position.to_bytes();
    let proof = tree.proof(&key);
    if let Some(bull) = od.bulls.iter().find(|b| b.position == *position) {
        CompressedBullProof {
            leaf: bull.clone(),
            proof,
        }
    } else {
        CompressedBullProof {
            leaf: BullLeaf::empty(),
            proof,
        }
    }
}

fn siblings_hex(proof: &CompressedSparseProof) -> Vec<String> {
    proof
        .siblings
        .iter()
        .map(|s| hex::encode(s.try_to_vec().unwrap()))
        .collect()
}

fn bull_leaf_json(bull: &BullLeaf) -> serde_json::Value {
    json!({
        "position": bull.position.to_string(),
        "position_id": bull.position_id,
        "owner": bull.owner.to_string(),
        "buck_power": bull.buck_power,
        "reveal_config_version": bull.reveal_config_version,
    })
}

fn hash_array(h: &[u8; 32]) -> serde_json::Value {
    json!(h.to_vec())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SelectedOwners {
    dense: usize,
    normal: usize,
    one: usize,
    multi: usize,
    ten: Option<usize>,
}

fn select_owners(owners: &[OwnerData]) -> SelectedOwners {
    let dense = 0usize;
    let mut normal = None;
    let mut one = None;
    let mut multi = None;
    let mut ten = None;
    for (i, od) in owners.iter().enumerate() {
        if i == dense {
            continue;
        }
        if normal.is_none() {
            normal = Some(i);
        }
        if od.bulls.len() == 1 && one.is_none() {
            one = Some(i);
        }
        if od.bulls.len() == 2 && multi.is_none() {
            multi = Some(i);
        }
        if od.bulls.len() == 10 && ten.is_none() {
            ten = Some(i);
        }
    }
    SelectedOwners {
        dense,
        normal: normal.unwrap_or(dense),
        one: one.unwrap_or(dense),
        multi: multi.unwrap_or(dense),
        ten,
    }
}

// ---------------------------------------------------------------------------
// Theft target selection
// ---------------------------------------------------------------------------

fn sort_owners_by_path(owners: &[OwnerData]) -> Vec<(usize, u64, u64, u64)> {
    let mut indexed: Vec<_> = owners
        .iter()
        .enumerate()
        .map(|(i, od)| {
            let mut key = od.owner.to_bytes();
            key.reverse();
            (i, key)
        })
        .collect();
    indexed.sort_by(|a, b| a.1.cmp(&b.1));

    let mut sorted = Vec::with_capacity(owners.len());
    let mut prefix = 0u64;
    for (i, _) in indexed {
        let od = &owners[i];
        let count = od.owner_leaf.active_bull_count;
        let power = od.owner_leaf.total_buck_power;
        sorted.push((i, prefix, count, power));
        prefix = prefix.saturating_add(power);
    }
    sorted
}

fn find_owner_by_target(sorted: &[(usize, u64, u64, u64)], target: u64) -> (usize, u64, u64, u64) {
    // binary search for the last entry with prefix <= target
    let mut lo = 0usize;
    let mut hi = sorted.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if sorted[mid].1 <= target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    let idx = lo.saturating_sub(1);
    let (owner_idx, prefix, count, power) = sorted[idx];
    assert!(
        leaf_contains_target(prefix, power, target),
        "target {} not found in owner tree",
        target
    );
    (owner_idx, prefix, count, power)
}

fn find_bull_by_target(bulls: &[BullLeaf], target: u64) -> (&BullLeaf, u64, u64) {
    let mut indexed: Vec<_> = bulls
        .iter()
        .map(|b| {
            let mut key = b.position.to_bytes();
            key.reverse();
            (b, key)
        })
        .collect();
    indexed.sort_by(|a, b| a.1.cmp(&b.1));

    let mut prefix = 0u64;
    for (b, _) in indexed {
        let power = b.buck_power as u64;
        if leaf_contains_target(prefix, power, target) {
            return (b, prefix, power);
        }
        prefix = prefix.saturating_add(power);
    }
    panic!("target {} not found in bull tree", target)
}

#[allow(clippy::type_complexity)]
fn select_theft_target(
    _owner_tree: &SparseTree,
    owners: &[OwnerData],
    victim_idx: Option<usize>,
    prefer_selected_idx: usize,
    total_bull_count: u64,
    total_buck_power: u64,
    position_seed: u64,
) -> Option<(
    [u8; 32],
    Pubkey,
    u64,
    usize,
    u64,
    u64,
    BullLeaf,
    u64,
    u64,
    u64,
    u64,
)> {
    let sorted = sort_owners_by_path(owners);
    let (victim_prefix, victim_count, victim_power) = match victim_idx {
        Some(idx) => {
            let &(_, prefix, count, power) = sorted
                .iter()
                .find(|&&(i, _, _, _)| i == idx)
                .expect("victim not found in sorted owners");
            (prefix, count, power)
        }
        None => (0u64, 0u64, 0u64),
    };
    let external_count = total_bull_count - victim_count;
    let external_power = total_buck_power - victim_power;
    if external_power == 0 {
        return None;
    }

    let config = protocol_config_v1(Pubkey::default(), 0);
    let position = deterministic_bull(position_seed, 0);
    let action_nonce = 1u64;
    let victim_idx_value = victim_idx.unwrap_or(usize::MAX);

    for attempt in 1u64..=200 {
        let mut random_output = [0u8; 32];
        random_output[0..8].copy_from_slice(&attempt.to_le_bytes());
        let ctx = RandomnessSampleContext {
            random_output,
            domain: RandomnessDomain::MintTheft,
            position,
            action_nonce,
        };
        if !map_mint_theft_flag(ctx, &config).unwrap_or(false) {
            continue;
        }

        let mut owner_ctx = ctx;
        owner_ctx.domain = RandomnessDomain::OwnerSelection;
        let owner_target = match rejection_sample_draw(owner_ctx, external_power) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let safe_owner_target = skip_victim_interval(owner_target, victim_prefix, victim_power);
        let (selected_idx, selected_prefix, _selected_count, selected_power) =
            find_owner_by_target(&sorted, safe_owner_target);
        if selected_idx == victim_idx_value {
            continue;
        }
        if selected_idx != prefer_selected_idx && attempt < 100 {
            continue;
        }

        let selected_owner = &owners[selected_idx];
        let mut bull_ctx = ctx;
        bull_ctx.domain = RandomnessDomain::BullSelection;
        let bull_target = match rejection_sample_draw(bull_ctx, selected_power) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let (selected_bull, selected_bull_prefix, selected_bull_power) =
            find_bull_by_target(&selected_owner.bulls, bull_target);
        if selected_bull.owner != selected_owner.owner {
            continue;
        }

        return Some((
            random_output,
            position,
            action_nonce,
            selected_idx,
            selected_prefix,
            selected_power,
            selected_bull.clone(),
            selected_bull_prefix,
            selected_bull_power,
            external_count,
            external_power,
        ));
    }
    None
}

fn generate_case(
    name: &str,
    scale: usize,
    owner_tree_root: &[u8; 32],
    total_bull_count: u64,
    total_buck_power: u64,
    owners: &[OwnerData],
    owner_tree: &SparseTree,
    selected: &SelectedOwners,
) -> serde_json::Value {
    let mut payload = BullProofPayloadV1 {
        schema_version: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
        section_bitmap: 0,
        victim_owner: None,
        selected_owner: None,
        selected_bull: None,
        current_owner: None,
        current_bull: None,
        remove_bull: None,
    };

    let mut victim: Option<Pubkey> = None;
    let mut new_bull: Option<BullLeaf> = None;
    let mut bulls_in_selected = 0u64;
    let mut owner_siblings = Vec::new();
    let mut bull_siblings = Vec::new();
    let mut owner_non_default = 0usize;
    let mut bull_non_default = 0usize;
    let mut expected_success = true;

    let mut random_output = [0u8; 32];
    let mut position = Pubkey::default();
    let mut action_nonce = 0u64;
    let mut external_count = 0u64;
    let mut external_power = 0u64;
    let mut selected_owner_interval_start = 0u64;
    let mut selected_owner_interval_end = 0u64;
    let mut selected_bull_interval_start = 0u64;
    let mut selected_bull_interval_end = 0u64;

    let mut snapshot_root = *owner_tree_root;
    let mut snapshot_total_count = total_bull_count;
    let mut snapshot_total_power = total_buck_power;
    let mut snapshot_version = 0u64;
    let mut current_root = *owner_tree_root;
    let mut current_total_count = total_bull_count;
    let mut current_total_power = total_buck_power;
    let mut current_version = 0u64;

    match name {
        "A" => {
            let od = &owners[selected.normal];
            let proof = owner_proof_with_leaf(owner_tree, &od.owner, od.owner_leaf.clone());
            owner_siblings = siblings_hex(&proof.proof);
            owner_non_default = proof.proof.siblings.len();
            bulls_in_selected = od.owner_leaf.active_bull_count;
            payload.section_bitmap = SECTION_SELECTED_OWNER;
            payload.selected_owner = Some(proof);
        }
        "B" => {
            let absent = deterministic_owner(1_000_000 + scale as u64);
            let proof = owner_proof_with_leaf(owner_tree, &absent, OwnerLeaf::empty());
            owner_siblings = siblings_hex(&proof.proof);
            owner_non_default = proof.proof.siblings.len();
            victim = Some(absent);
            payload.section_bitmap = SECTION_VICTIM_OWNER;
            payload.victim_owner = Some(proof);
        }
        "B_NEG" => {
            let od = &owners[selected.normal];
            // An existing owner path, but with the canonical empty leaf. The
            // proof siblings are valid for the real registry, the leaf is not.
            let proof = owner_proof_with_leaf(owner_tree, &od.owner, OwnerLeaf::empty());
            owner_siblings = siblings_hex(&proof.proof);
            owner_non_default = proof.proof.siblings.len();
            victim = Some(od.owner);
            payload.section_bitmap = SECTION_VICTIM_OWNER;
            payload.victim_owner = Some(proof);
            expected_success = false;
        }
        "C" => {
            let od = &owners[selected.multi];
            let bull = &od.bulls[0];
            let oproof = owner_proof_with_leaf(owner_tree, &od.owner, od.owner_leaf.clone());
            let bproof = bull_proof(od, &bull.position);
            owner_siblings = siblings_hex(&oproof.proof);
            bull_siblings = siblings_hex(&bproof.proof);
            owner_non_default = oproof.proof.siblings.len();
            bull_non_default = bproof.proof.siblings.len();
            bulls_in_selected = od.owner_leaf.active_bull_count;
            payload.section_bitmap = SECTION_SELECTED_OWNER | SECTION_SELECTED_BULL;
            payload.selected_owner = Some(oproof);
            payload.selected_bull = Some(bproof);
        }
        "D" => {
            let od = &owners[selected.multi];
            let new_bull_index = 1_000_000u64;
            let position = deterministic_bull(selected.multi as u64, new_bull_index);
            let power = POWERS[(selected.multi + new_bull_index as usize) % POWERS.len()];
            let leaf = BullLeaf {
                position,
                position_id: total_bull_count + 1,
                owner: od.owner,
                buck_power: power,
                reveal_config_version: 1,
            };
            new_bull = Some(leaf);
            let oproof = owner_proof_with_leaf(owner_tree, &od.owner, od.owner_leaf.clone());
            let bproof = bull_proof(od, &position);
            owner_siblings = siblings_hex(&oproof.proof);
            bull_siblings = siblings_hex(&bproof.proof);
            owner_non_default = oproof.proof.siblings.len();
            bull_non_default = bproof.proof.siblings.len();
            bulls_in_selected = od.owner_leaf.active_bull_count;
            payload.section_bitmap = SECTION_CURRENT_OWNER | SECTION_CURRENT_BULL;
            payload.current_owner = Some(oproof);
            payload.current_bull = Some(bproof);
        }
        "E" => {
            let new_owner_index = 1_000_000u64 + scale as u64;
            let owner = deterministic_owner(new_owner_index);
            let new_bull_index = 0u64;
            let position = deterministic_bull(new_owner_index, new_bull_index);
            let power = POWERS[(new_owner_index as usize + new_bull_index as usize) % POWERS.len()];
            let leaf = BullLeaf {
                position,
                position_id: total_bull_count + 2,
                owner,
                buck_power: power,
                reveal_config_version: 1,
            };
            new_bull = Some(leaf);
            let oproof = owner_proof_with_leaf(owner_tree, &owner, OwnerLeaf::empty());
            let od = &owners[selected.dense];
            let bproof = bull_proof(od, &position);
            owner_siblings = siblings_hex(&oproof.proof);
            bull_siblings = siblings_hex(&bproof.proof);
            owner_non_default = oproof.proof.siblings.len();
            bull_non_default = bproof.proof.siblings.len();
            payload.section_bitmap = SECTION_CURRENT_OWNER | SECTION_CURRENT_BULL;
            payload.current_owner = Some(oproof);
            payload.current_bull = Some(bproof);
        }
        "F" => {
            let od = &owners[selected.multi];
            let bull = &od.bulls[0];
            let oproof = owner_proof_with_leaf(owner_tree, &od.owner, od.owner_leaf.clone());
            let bproof = bull_proof(od, &bull.position);
            owner_siblings = siblings_hex(&oproof.proof);
            bull_siblings = siblings_hex(&bproof.proof);
            owner_non_default = oproof.proof.siblings.len();
            bull_non_default = bproof.proof.siblings.len();
            bulls_in_selected = od.owner_leaf.active_bull_count;
            payload.section_bitmap = SECTION_CURRENT_OWNER | SECTION_REMOVE_BULL;
            payload.current_owner = Some(oproof);
            payload.remove_bull = Some(bproof);
        }
        "G" => {
            let od = &owners[selected.one];
            let bull = &od.bulls[0];
            let oproof = owner_proof_with_leaf(owner_tree, &od.owner, od.owner_leaf.clone());
            let bproof = bull_proof(od, &bull.position);
            owner_siblings = siblings_hex(&oproof.proof);
            bull_siblings = siblings_hex(&bproof.proof);
            owner_non_default = oproof.proof.siblings.len();
            bull_non_default = bproof.proof.siblings.len();
            bulls_in_selected = od.owner_leaf.active_bull_count;
            payload.section_bitmap = SECTION_CURRENT_OWNER | SECTION_REMOVE_BULL;
            payload.current_owner = Some(oproof);
            payload.remove_bull = Some(bproof);
        }
        "H" => {
            let victim_idx = selected.normal;
            let prefer_selected_idx = selected.dense;
            let position_seed = 1_000_000_000u64 + scale as u64;
            let result = select_theft_target(
                owner_tree,
                owners,
                Some(victim_idx),
                prefer_selected_idx,
                total_bull_count,
                total_buck_power,
                position_seed,
            )
            .expect("no valid theft target found");
            let (
                random_output_val,
                position_val,
                action_nonce_val,
                selected_idx,
                selected_owner_prefix,
                selected_owner_power,
                selected_bull,
                selected_bull_prefix,
                selected_bull_power,
                external_count_val,
                external_power_val,
            ) = result;

            let victim_owner = &owners[victim_idx];
            let selected_owner = &owners[selected_idx];
            let vproof = owner_proof_with_leaf(
                owner_tree,
                &victim_owner.owner,
                victim_owner.owner_leaf.clone(),
            );
            let oproof = owner_proof_with_leaf(
                owner_tree,
                &selected_owner.owner,
                selected_owner.owner_leaf.clone(),
            );
            let bproof = bull_proof(selected_owner, &selected_bull.position);
            owner_siblings = siblings_hex(&oproof.proof);
            bull_siblings = siblings_hex(&bproof.proof);
            owner_non_default = oproof.proof.siblings.len();
            bull_non_default = bproof.proof.siblings.len();
            bulls_in_selected = selected_owner.owner_leaf.active_bull_count;
            victim = Some(victim_owner.owner);
            payload.section_bitmap =
                SECTION_VICTIM_OWNER | SECTION_SELECTED_OWNER | SECTION_SELECTED_BULL;
            payload.victim_owner = Some(vproof);
            payload.selected_owner = Some(oproof);
            payload.selected_bull = Some(bproof);

            random_output = random_output_val;
            position = position_val;
            action_nonce = action_nonce_val;
            selected_owner_interval_start = selected_owner_prefix;
            selected_owner_interval_end = selected_owner_prefix + selected_owner_power;
            selected_bull_interval_start = selected_bull_prefix;
            selected_bull_interval_end = selected_bull_prefix + selected_bull_power;
            external_count = external_count_val;
            external_power = external_power_val;
        }
        "I" => {
            let prefer_selected_idx = selected.dense;
            let position_seed = 1_000_000_000u64 + scale as u64;
            let result = select_theft_target(
                owner_tree,
                owners,
                None,
                prefer_selected_idx,
                total_bull_count,
                total_buck_power,
                position_seed,
            )
            .expect("no valid theft target found");
            let (
                random_output_val,
                position_val,
                action_nonce_val,
                selected_idx,
                selected_owner_prefix,
                selected_owner_power,
                selected_bull,
                selected_bull_prefix,
                selected_bull_power,
                external_count_val,
                external_power_val,
            ) = result;

            let selected_owner = &owners[selected_idx];
            let absent = deterministic_owner(1_000_000 + scale as u64);
            let vproof = owner_proof_with_leaf(owner_tree, &absent, OwnerLeaf::empty());
            let oproof = owner_proof_with_leaf(
                owner_tree,
                &selected_owner.owner,
                selected_owner.owner_leaf.clone(),
            );
            let bproof = bull_proof(selected_owner, &selected_bull.position);
            owner_siblings = siblings_hex(&oproof.proof);
            bull_siblings = siblings_hex(&bproof.proof);
            owner_non_default = oproof.proof.siblings.len();
            bull_non_default = bproof.proof.siblings.len();
            bulls_in_selected = selected_owner.owner_leaf.active_bull_count;
            victim = Some(absent);
            payload.section_bitmap =
                SECTION_VICTIM_OWNER | SECTION_SELECTED_OWNER | SECTION_SELECTED_BULL;
            payload.victim_owner = Some(vproof);
            payload.selected_owner = Some(oproof);
            payload.selected_bull = Some(bproof);

            random_output = random_output_val;
            position = position_val;
            action_nonce = action_nonce_val;
            selected_owner_interval_start = selected_owner_prefix;
            selected_owner_interval_end = selected_owner_prefix + selected_owner_power;
            selected_bull_interval_start = selected_bull_prefix;
            selected_bull_interval_end = selected_bull_prefix + selected_bull_power;
            external_count = external_count_val;
            external_power = external_power_val;
        }
        "I_NEG" => {
            let victim_idx = selected.normal;
            let prefer_selected_idx = selected.dense;
            let position_seed = 1_000_000_000u64 + scale as u64;
            let result = select_theft_target(
                owner_tree,
                owners,
                Some(victim_idx),
                prefer_selected_idx,
                total_bull_count,
                total_buck_power,
                position_seed,
            )
            .expect("no valid theft target found");
            let (
                random_output_val,
                position_val,
                action_nonce_val,
                selected_idx,
                selected_owner_prefix,
                selected_owner_power,
                selected_bull,
                selected_bull_prefix,
                selected_bull_power,
                external_count_val,
                external_power_val,
            ) = result;

            let victim_owner = &owners[victim_idx];
            let selected_owner = &owners[selected_idx];
            let vproof = owner_proof_with_leaf(owner_tree, &victim_owner.owner, OwnerLeaf::empty());
            let oproof = owner_proof_with_leaf(
                owner_tree,
                &selected_owner.owner,
                selected_owner.owner_leaf.clone(),
            );
            let bproof = bull_proof(selected_owner, &selected_bull.position);
            owner_siblings = siblings_hex(&oproof.proof);
            bull_siblings = siblings_hex(&bproof.proof);
            owner_non_default = oproof.proof.siblings.len();
            bull_non_default = bproof.proof.siblings.len();
            bulls_in_selected = selected_owner.owner_leaf.active_bull_count;
            victim = Some(victim_owner.owner);
            payload.section_bitmap =
                SECTION_VICTIM_OWNER | SECTION_SELECTED_OWNER | SECTION_SELECTED_BULL;
            payload.victim_owner = Some(vproof);
            payload.selected_owner = Some(oproof);
            payload.selected_bull = Some(bproof);

            random_output = random_output_val;
            position = position_val;
            action_nonce = action_nonce_val;
            selected_owner_interval_start = selected_owner_prefix;
            selected_owner_interval_end = selected_owner_interval_start + selected_owner_power;
            selected_bull_interval_start = selected_bull_prefix;
            selected_bull_interval_end = selected_bull_interval_start + selected_bull_power;
            external_count = external_count_val;
            external_power = external_power_val;
            expected_success = false;
        }
        "J1" => {
            let victim_idx = selected.normal;
            let prefer_selected_idx = selected.dense;
            let position_seed = 1_000_000_000u64 + scale as u64;
            let result = select_theft_target(
                owner_tree,
                owners,
                Some(victim_idx),
                prefer_selected_idx,
                total_bull_count,
                total_buck_power,
                position_seed,
            )
            .expect("no valid theft target found");
            let (
                random_output_val,
                position_val,
                action_nonce_val,
                selected_idx,
                selected_owner_prefix,
                selected_owner_power,
                selected_bull,
                selected_bull_prefix,
                selected_bull_power,
                external_count_val,
                external_power_val,
            ) = result;

            let victim_owner = &owners[victim_idx];
            let selected_owner = &owners[selected_idx];

            // Historical proofs.
            let vproof = owner_proof_with_leaf(
                owner_tree,
                &victim_owner.owner,
                victim_owner.owner_leaf.clone(),
            );
            let oproof = owner_proof_with_leaf(
                owner_tree,
                &selected_owner.owner,
                selected_owner.owner_leaf.clone(),
            );
            let bproof = bull_proof(selected_owner, &selected_bull.position);

            // Current registry: add one extra bull to a non-final owner.
            let mut current_owners = owners.to_vec();
            let extra_owner_idx = selected.normal;
            let new_bull_owner_index = 1_000_000_000u64 + scale as u64;
            let new_bull_bull_index = 1_000_000u64;
            let new_bull_position = deterministic_bull(new_bull_owner_index, new_bull_bull_index);
            let new_bull_power =
                POWERS[((new_bull_owner_index + new_bull_bull_index) as usize) % POWERS.len()];
            let extra_bull = BullLeaf {
                position: new_bull_position,
                position_id: total_bull_count + 1,
                owner: current_owners[extra_owner_idx].owner,
                buck_power: new_bull_power,
                reveal_config_version: 1,
            };
            current_owners[extra_owner_idx].bulls.push(extra_bull);
            current_owners[extra_owner_idx].owner_leaf = owner_leaf_from_bulls(
                current_owners[extra_owner_idx].owner,
                &current_owners[extra_owner_idx].bulls,
            );
            current_owners[extra_owner_idx].bull_tree =
                Some(build_bull_tree(&current_owners[extra_owner_idx].bulls));

            let mut current_owner_tree =
                SparseTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);
            let mut computed_total_count = 0u64;
            let mut computed_total_power = 0u64;
            for od in &current_owners {
                current_owner_tree.insert(&od.owner.to_bytes(), od.owner_leaf.to_node());
                computed_total_count += od.owner_leaf.active_bull_count;
                computed_total_power += od.owner_leaf.total_buck_power;
            }
            let current_root_node = *current_owner_tree.root();

            let new_bull_leaf = BullLeaf {
                position: new_bull_position,
                position_id: computed_total_count + 1,
                owner: selected_owner.owner,
                buck_power: new_bull_power,
                reveal_config_version: 1,
            };
            new_bull = Some(new_bull_leaf);

            let current_owner_proof = owner_proof_with_leaf(
                &current_owner_tree,
                &selected_owner.owner,
                selected_owner.owner_leaf.clone(),
            );
            let current_bull_proof = bull_proof(selected_owner, &new_bull_position);

            owner_siblings = siblings_hex(&oproof.proof);
            bull_siblings = siblings_hex(&bproof.proof);
            owner_non_default = oproof.proof.siblings.len();
            bull_non_default = bproof.proof.siblings.len();
            bulls_in_selected = selected_owner.owner_leaf.active_bull_count;
            victim = Some(victim_owner.owner);
            payload.section_bitmap = SECTION_VICTIM_OWNER
                | SECTION_SELECTED_OWNER
                | SECTION_SELECTED_BULL
                | SECTION_CURRENT_OWNER
                | SECTION_CURRENT_BULL;
            payload.victim_owner = Some(vproof);
            payload.selected_owner = Some(oproof);
            payload.selected_bull = Some(bproof);
            payload.current_owner = Some(current_owner_proof);
            payload.current_bull = Some(current_bull_proof);

            random_output = random_output_val;
            position = position_val;
            action_nonce = action_nonce_val;
            selected_owner_interval_start = selected_owner_prefix;
            selected_owner_interval_end = selected_owner_interval_start + selected_owner_power;
            selected_bull_interval_start = selected_bull_prefix;
            selected_bull_interval_end = selected_bull_interval_start + selected_bull_power;
            external_count = external_count_val;
            external_power = external_power_val;

            snapshot_root = *owner_tree_root;
            snapshot_total_count = total_bull_count;
            snapshot_total_power = total_buck_power;
            snapshot_version = 0u64;
            current_root = current_root_node.hash;
            current_total_count = computed_total_count;
            current_total_power = computed_total_power;
            current_version = 1u64;
        }
        "J2" => {
            let victim_idx = selected.normal;
            let prefer_selected_idx = selected.dense;
            let position_seed = 1_000_000_000u64 + scale as u64;
            let result = select_theft_target(
                owner_tree,
                owners,
                Some(victim_idx),
                prefer_selected_idx,
                total_bull_count,
                total_buck_power,
                position_seed,
            )
            .expect("no valid theft target found");
            let (
                random_output_val,
                position_val,
                action_nonce_val,
                selected_idx,
                selected_owner_prefix,
                selected_owner_power,
                selected_bull,
                selected_bull_prefix,
                selected_bull_power,
                external_count_val,
                external_power_val,
            ) = result;

            let victim_owner = &owners[victim_idx];
            let selected_owner = &owners[selected_idx];

            // Historical proofs.
            let vproof = owner_proof_with_leaf(
                owner_tree,
                &victim_owner.owner,
                victim_owner.owner_leaf.clone(),
            );
            let oproof = owner_proof_with_leaf(
                owner_tree,
                &selected_owner.owner,
                selected_owner.owner_leaf.clone(),
            );
            let bproof = bull_proof(selected_owner, &selected_bull.position);

            // Current registry with the final owner removed.
            let mut current_owners = owners.to_vec();
            current_owners.retain(|od| od.owner != selected_owner.owner);
            let mut current_owner_tree =
                SparseTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);
            let mut computed_total_count = 0u64;
            let mut computed_total_power = 0u64;
            for od in &current_owners {
                current_owner_tree.insert(&od.owner.to_bytes(), od.owner_leaf.to_node());
                computed_total_count += od.owner_leaf.active_bull_count;
                computed_total_power += od.owner_leaf.total_buck_power;
            }
            let current_root_node = *current_owner_tree.root();

            let new_bull_owner_index = 1_000_000_000u64 + scale as u64;
            let new_bull_bull_index = 1_000_000u64;
            let new_bull_position = deterministic_bull(new_bull_owner_index, new_bull_bull_index);
            let new_bull_power =
                POWERS[((new_bull_owner_index + new_bull_bull_index) as usize) % POWERS.len()];
            let new_bull_leaf = BullLeaf {
                position: new_bull_position,
                position_id: computed_total_count + 1,
                owner: selected_owner.owner,
                buck_power: new_bull_power,
                reveal_config_version: 1,
            };
            new_bull = Some(new_bull_leaf);

            let current_owner_proof = owner_proof_with_leaf(
                &current_owner_tree,
                &selected_owner.owner,
                OwnerLeaf::empty(),
            );
            let empty_selected = OwnerData {
                owner: selected_owner.owner,
                owner_leaf: OwnerLeaf::empty(),
                bull_tree: Some(build_bull_tree(&[])),
                bulls: Vec::new(),
            };
            let current_bull_proof = bull_proof(&empty_selected, &new_bull_position);

            owner_siblings = siblings_hex(&oproof.proof);
            bull_siblings = siblings_hex(&bproof.proof);
            owner_non_default = oproof.proof.siblings.len();
            bull_non_default = bproof.proof.siblings.len();
            bulls_in_selected = selected_owner.owner_leaf.active_bull_count;
            victim = Some(victim_owner.owner);
            payload.section_bitmap = SECTION_VICTIM_OWNER
                | SECTION_SELECTED_OWNER
                | SECTION_SELECTED_BULL
                | SECTION_CURRENT_OWNER
                | SECTION_CURRENT_BULL;
            payload.victim_owner = Some(vproof);
            payload.selected_owner = Some(oproof);
            payload.selected_bull = Some(bproof);
            payload.current_owner = Some(current_owner_proof);
            payload.current_bull = Some(current_bull_proof);

            random_output = random_output_val;
            position = position_val;
            action_nonce = action_nonce_val;
            selected_owner_interval_start = selected_owner_prefix;
            selected_owner_interval_end = selected_owner_interval_start + selected_owner_power;
            selected_bull_interval_start = selected_bull_prefix;
            selected_bull_interval_end = selected_bull_interval_start + selected_bull_power;
            external_count = external_count_val;
            external_power = external_power_val;

            snapshot_root = *owner_tree_root;
            snapshot_total_count = total_bull_count;
            snapshot_total_power = total_buck_power;
            snapshot_version = 0u64;
            current_root = current_root_node.hash;
            current_total_count = computed_total_count;
            current_total_power = computed_total_power;
            current_version = 1u64;
        }
        "J_NEG" => {
            let victim_idx = selected.normal;
            let prefer_selected_idx = selected.dense;
            let position_seed = 1_000_000_000u64 + scale as u64;
            let result = select_theft_target(
                owner_tree,
                owners,
                Some(victim_idx),
                prefer_selected_idx,
                total_bull_count,
                total_buck_power,
                position_seed,
            )
            .expect("no valid theft target found");
            let (
                random_output_val,
                position_val,
                action_nonce_val,
                selected_idx,
                selected_owner_prefix,
                selected_owner_power,
                selected_bull,
                selected_bull_prefix,
                selected_bull_power,
                external_count_val,
                external_power_val,
            ) = result;

            let victim_owner = &owners[victim_idx];
            let selected_owner = &owners[selected_idx];

            // Historical proofs.
            let vproof = owner_proof_with_leaf(
                owner_tree,
                &victim_owner.owner,
                victim_owner.owner_leaf.clone(),
            );
            let oproof = owner_proof_with_leaf(
                owner_tree,
                &selected_owner.owner,
                selected_owner.owner_leaf.clone(),
            );
            let bproof = bull_proof(selected_owner, &selected_bull.position);

            // Current registry with extra bull like J1.
            let mut current_owners = owners.to_vec();
            let extra_owner_idx = selected.normal;
            let new_bull_owner_index = 1_000_000_000u64 + scale as u64;
            let new_bull_bull_index = 1_000_000u64;
            let new_bull_position = deterministic_bull(new_bull_owner_index, new_bull_bull_index);
            let new_bull_power =
                POWERS[((new_bull_owner_index + new_bull_bull_index) as usize) % POWERS.len()];
            let extra_bull = BullLeaf {
                position: new_bull_position,
                position_id: total_bull_count + 1,
                owner: current_owners[extra_owner_idx].owner,
                buck_power: new_bull_power,
                reveal_config_version: 1,
            };
            current_owners[extra_owner_idx].bulls.push(extra_bull);
            current_owners[extra_owner_idx].owner_leaf = owner_leaf_from_bulls(
                current_owners[extra_owner_idx].owner,
                &current_owners[extra_owner_idx].bulls,
            );
            current_owners[extra_owner_idx].bull_tree =
                Some(build_bull_tree(&current_owners[extra_owner_idx].bulls));

            let mut current_owner_tree =
                SparseTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);
            let mut computed_total_count = 0u64;
            let mut computed_total_power = 0u64;
            for od in &current_owners {
                current_owner_tree.insert(&od.owner.to_bytes(), od.owner_leaf.to_node());
                computed_total_count += od.owner_leaf.active_bull_count;
                computed_total_power += od.owner_leaf.total_buck_power;
            }
            let current_root_node = *current_owner_tree.root();

            let new_bull_leaf = BullLeaf {
                position: new_bull_position,
                position_id: computed_total_count + 1,
                owner: selected_owner.owner,
                buck_power: new_bull_power,
                reveal_config_version: 1,
            };
            new_bull = Some(new_bull_leaf);

            // Intentionally use the historical selected-owner proof as current-owner.
            let current_bull_proof = bull_proof(selected_owner, &new_bull_position);

            owner_siblings = siblings_hex(&oproof.proof);
            bull_siblings = siblings_hex(&bproof.proof);
            owner_non_default = oproof.proof.siblings.len();
            bull_non_default = bproof.proof.siblings.len();
            bulls_in_selected = selected_owner.owner_leaf.active_bull_count;
            victim = Some(victim_owner.owner);
            payload.section_bitmap = SECTION_VICTIM_OWNER
                | SECTION_SELECTED_OWNER
                | SECTION_SELECTED_BULL
                | SECTION_CURRENT_OWNER
                | SECTION_CURRENT_BULL;
            payload.victim_owner = Some(vproof);
            payload.selected_owner = Some(oproof.clone());
            payload.selected_bull = Some(bproof);
            payload.current_owner = Some(oproof);
            payload.current_bull = Some(current_bull_proof);

            random_output = random_output_val;
            position = position_val;
            action_nonce = action_nonce_val;
            selected_owner_interval_start = selected_owner_prefix;
            selected_owner_interval_end = selected_owner_interval_start + selected_owner_power;
            selected_bull_interval_start = selected_bull_prefix;
            selected_bull_interval_end = selected_bull_interval_start + selected_bull_power;
            external_count = external_count_val;
            external_power = external_power_val;

            snapshot_root = *owner_tree_root;
            snapshot_total_count = total_bull_count;
            snapshot_total_power = total_buck_power;
            snapshot_version = 0u64;
            current_root = current_root_node.hash;
            current_total_count = computed_total_count;
            current_total_power = computed_total_power;
            current_version = 1u64;
            expected_success = false;
        }
        _ => {}
    }

    let payload_bytes = payload.try_to_vec().unwrap();
    let section_bytes = compute_section_bytes(&payload);
    let random_output_json = if action_nonce == 0 {
        serde_json::Value::Null
    } else {
        json!(random_output.to_vec())
    };
    let position_json = if action_nonce == 0 {
        serde_json::Value::Null
    } else {
        json!(position.to_string())
    };

    json!({
        "case": name,
        "scale": scale,
        "ownerCount": owners.len(),
        "bullsInSelectedOwner": bulls_in_selected,
        "ownerTreeRoot": hash_array(owner_tree_root),
        "totalBullCount": total_bull_count,
        "totalBuckPower": total_buck_power,
        "registryVersion": snapshot_version,
        "victim": victim.map(|p| p.to_string()),
        "newBull": new_bull.as_ref().map(bull_leaf_json),
        "payloadHex": hex::encode(&payload_bytes),
        "nonDefaultOwnerSiblings": owner_non_default,
        "nonDefaultBullSiblings": bull_non_default,
        "payloadBytes": payload_bytes.len(),
        "ownerSiblings": owner_siblings,
        "bullSiblings": bull_siblings,
        "expectedSuccess": expected_success,
        "sectionBytes": section_bytes,
        "randomOutput": random_output_json,
        "position": position_json,
        "actionNonce": action_nonce,
        "externalCount": external_count,
        "externalPower": external_power,
        "selectedOwnerIntervalStart": selected_owner_interval_start,
        "selectedOwnerIntervalEnd": selected_owner_interval_end,
        "selectedBullIntervalStart": selected_bull_interval_start,
        "selectedBullIntervalEnd": selected_bull_interval_end,
        "snapshotRoot": hash_array(&snapshot_root),
        "snapshotTotalCount": snapshot_total_count,
        "snapshotTotalPower": snapshot_total_power,
        "snapshotVersion": snapshot_version,
        "currentOwnerTreeRoot": hash_array(&current_root),
        "currentTotalBullCount": current_total_count,
        "currentTotalBuckPower": current_total_power,
        "currentRegistryVersion": current_version,
    })
}

fn make_bull_subtree_case(bull_count: usize) -> serde_json::Value {
    let (owner_root, owners, total_count, total_power, owner_tree) = build_bull_subtree(bull_count);
    let owner_tree_root = owner_root.hash;
    let target = &owners[0];
    let oproof = owner_proof_with_leaf(&owner_tree, &target.owner, target.owner_leaf.clone());
    let bull = &target.bulls[0];
    let bproof = bull_proof(target, &bull.position);

    let payload = BullProofPayloadV1 {
        schema_version: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
        section_bitmap: SECTION_SELECTED_OWNER | SECTION_SELECTED_BULL,
        victim_owner: None,
        selected_owner: Some(oproof),
        selected_bull: Some(bproof),
        current_owner: None,
        current_bull: None,
        remove_bull: None,
    };
    let payload_bytes = payload.try_to_vec().unwrap();
    let section_bytes = compute_section_bytes(&payload);

    json!({
        "case": format!("BULL_{}", bull_count),
        "scale": bull_count,
        "ownerCount": owners.len(),
        "bullsInSelectedOwner": target.bulls.len() as u64,
        "ownerTreeRoot": hash_array(&owner_tree_root),
        "totalBullCount": total_count,
        "totalBuckPower": total_power,
        "registryVersion": 0u64,
        "victim": null,
        "newBull": null,
        "payloadHex": hex::encode(&payload_bytes),
        "nonDefaultOwnerSiblings": payload.selected_owner.as_ref().unwrap().proof.siblings.len(),
        "nonDefaultBullSiblings": payload.selected_bull.as_ref().unwrap().proof.siblings.len(),
        "payloadBytes": payload_bytes.len(),
        "ownerSiblings": siblings_hex(&payload.selected_owner.as_ref().unwrap().proof),
        "bullSiblings": siblings_hex(&payload.selected_bull.as_ref().unwrap().proof),
        "expectedSuccess": true,
        "sectionBytes": section_bytes,
        "randomOutput": serde_json::Value::Null,
        "position": serde_json::Value::Null,
        "actionNonce": 0u64,
        "externalCount": 0u64,
        "externalPower": 0u64,
        "selectedOwnerIntervalStart": 0u64,
        "selectedOwnerIntervalEnd": 0u64,
        "selectedBullIntervalStart": 0u64,
        "selectedBullIntervalEnd": 0u64,
        "snapshotRoot": hash_array(&owner_tree_root),
        "snapshotTotalCount": total_count,
        "snapshotTotalPower": total_power,
        "snapshotVersion": 0u64,
        "currentOwnerTreeRoot": hash_array(&owner_tree_root),
        "currentTotalBullCount": total_count,
        "currentTotalBuckPower": total_power,
        "currentRegistryVersion": 0u64,
    })
}

fn make_remove_one_case() -> serde_json::Value {
    let (owner_root, owners, total_count, total_power, owner_tree) = build_final_bull_fixture();
    let owner_tree_root = owner_root.hash;
    let target = &owners[0];
    let bull = &target.bulls[0];
    let oproof = owner_proof_with_leaf(&owner_tree, &target.owner, target.owner_leaf.clone());
    let bproof = bull_proof(target, &bull.position);

    let payload = BullProofPayloadV1 {
        schema_version: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
        section_bitmap: SECTION_CURRENT_OWNER | SECTION_REMOVE_BULL,
        victim_owner: None,
        selected_owner: None,
        selected_bull: None,
        current_owner: Some(oproof),
        current_bull: None,
        remove_bull: Some(bproof),
    };
    let payload_bytes = payload.try_to_vec().unwrap();
    let section_bytes = compute_section_bytes(&payload);

    json!({
        "case": "REMOVE_1",
        "scale": 1usize,
        "ownerCount": owners.len(),
        "bullsInSelectedOwner": target.bulls.len() as u64,
        "ownerTreeRoot": hash_array(&owner_tree_root),
        "totalBullCount": total_count,
        "totalBuckPower": total_power,
        "registryVersion": 0u64,
        "victim": null,
        "newBull": null,
        "payloadHex": hex::encode(&payload_bytes),
        "nonDefaultOwnerSiblings": payload.current_owner.as_ref().unwrap().proof.siblings.len(),
        "nonDefaultBullSiblings": payload.remove_bull.as_ref().unwrap().proof.siblings.len(),
        "payloadBytes": payload_bytes.len(),
        "ownerSiblings": siblings_hex(&payload.current_owner.as_ref().unwrap().proof),
        "bullSiblings": siblings_hex(&payload.remove_bull.as_ref().unwrap().proof),
        "expectedSuccess": true,
        "sectionBytes": section_bytes,
        "randomOutput": serde_json::Value::Null,
        "position": serde_json::Value::Null,
        "actionNonce": 0u64,
        "externalCount": 0u64,
        "externalPower": 0u64,
        "selectedOwnerIntervalStart": 0u64,
        "selectedOwnerIntervalEnd": 0u64,
        "selectedBullIntervalStart": 0u64,
        "selectedBullIntervalEnd": 0u64,
        "snapshotRoot": hash_array(&owner_tree_root),
        "snapshotTotalCount": total_count,
        "snapshotTotalPower": total_power,
        "snapshotVersion": 0u64,
        "currentOwnerTreeRoot": hash_array(&owner_tree_root),
        "currentTotalBullCount": total_count,
        "currentTotalBuckPower": total_power,
        "currentRegistryVersion": 0u64,
    })
}

fn section_len<T: AnchorSerialize>(opt: &Option<T>) -> usize {
    match opt {
        None => 0,
        Some(v) => v.try_to_vec().unwrap().len(),
    }
}

fn compute_section_bytes(payload: &BullProofPayloadV1) -> serde_json::Value {
    let header = 8usize;
    let victim = section_len(&payload.victim_owner);
    let selected_owner = section_len(&payload.selected_owner);
    let selected_bull = section_len(&payload.selected_bull);
    let current_owner = section_len(&payload.current_owner);
    let current_bull = section_len(&payload.current_bull);
    let remove_bull = section_len(&payload.remove_bull);
    let total = header
        + victim
        + selected_owner
        + selected_bull
        + current_owner
        + current_bull
        + remove_bull;
    json!({
        "header": header,
        "victim_owner": victim,
        "selected_owner": selected_owner,
        "selected_bull": selected_bull,
        "current_owner": current_owner,
        "current_bull": current_bull,
        "remove_bull": remove_bull,
        "total": total,
    })
}

// ---------------------------------------------------------------------------
// Helpers: timing / memory
// ---------------------------------------------------------------------------

fn peak_memory_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmHWM:"))
                .and_then(|l| l.split_whitespace().nth(1).and_then(|v| v.parse().ok()))
        })
        .unwrap_or(0)
}

fn case_payload_bytes(case: &serde_json::Value) -> usize {
    case["payloadHex"]
        .as_str()
        .map(|h| h.len() / 2)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Fixture generator
// ---------------------------------------------------------------------------

#[test]
#[ignore = "slow scale fixture generator"]
fn generate_sparse_scale_fixtures() {
    let full = std::env::var("RODEO_BENCH_FULL").is_ok();
    let scales: Vec<usize> = if full {
        vec![100, 1_000, 10_000, 100_000, 1_000_000]
    } else {
        vec![100, 1_000, 10_000, 100_000]
    };

    let mut all_scales: Vec<serde_json::Value> = Vec::new();
    let mut all_cases: Vec<serde_json::Value> = Vec::new();
    let mut parity: Vec<serde_json::Value> = Vec::new();
    let mut meta = json!({
        "generatedAt": format!("{:?}", std::time::SystemTime::now()),
        "full": full,
    });

    let overall_start = Instant::now();

    for scale in scales {
        eprintln!("[scale] Building fixtures for scale {} ...", scale);
        let start = Instant::now();
        let (owner_root, owners, total_count, total_power, owner_tree) = build_registry(scale);
        let owner_tree_root = owner_root.hash;
        let build_elapsed = start.elapsed();

        let selected = select_owners(&owners);

        // Rust parity: verify a sample owner and a sample bull.
        let sample_owner = &owners[selected.normal];
        let owner_key = sample_owner.owner.to_bytes();
        let owner_proof = owner_tree.proof(&owner_key);
        let (owner_recomputed, owner_prefix) = verify_with_prefix(
            &owner_tree_root,
            &owner_key,
            &owner_proof,
            &sample_owner.owner_leaf.to_node(),
            PREFIX_BULL_OWNER_NODE,
            &OwnerLeaf::empty().to_node(),
        )
        .unwrap();
        let owner_root_matches = owner_recomputed.hash == owner_tree_root;
        assert!(owner_root_matches, "owner root mismatch at scale {}", scale);
        assert_eq!(
            owner_recomputed.count, total_count,
            "owner total count mismatch"
        );
        assert_eq!(
            owner_recomputed.power, total_power,
            "owner total power mismatch"
        );

        let sample_bull = &sample_owner.bulls[0];
        let bull_key = sample_bull.position.to_bytes();
        let bull_tree = sample_owner
            .bull_tree
            .as_ref()
            .expect("sample owner must have a bull tree");
        let bull_proof = bull_tree.proof(&bull_key);
        let (bull_recomputed, bull_prefix) = verify_with_prefix(
            &sample_owner.owner_leaf.bull_tree_root,
            &bull_key,
            &bull_proof,
            &sample_bull.to_node(),
            PREFIX_BULL_NODE,
            &BullLeaf::empty().to_node(),
        )
        .unwrap();
        let bull_root_matches = bull_recomputed.hash == sample_owner.owner_leaf.bull_tree_root;
        assert!(bull_root_matches, "bull root mismatch at scale {}", scale);
        assert_eq!(
            bull_recomputed.count, sample_owner.owner_leaf.active_bull_count,
            "bull total count mismatch"
        );
        assert_eq!(
            bull_recomputed.power, sample_owner.owner_leaf.total_buck_power,
            "bull total power mismatch"
        );

        all_scales.push(json!({
            "scale": scale,
            "ownerCount": owners.len(),
            "totalBullCount": total_count,
            "totalBuckPower": total_power,
            "ownerTreeRoot": hash_array(&owner_tree_root),
            "registryVersion": 0u64,
            "generationTimeSeconds": build_elapsed.as_secs_f64(),
            "peakMemoryKb": peak_memory_kb(),
            "ownerRootMatches": owner_root_matches,
            "bullRootMatches": bull_root_matches,
            "ownerPrefix": owner_prefix,
            "bullPrefix": bull_prefix,
        }));

        for case_name in [
            "A", "B", "B_NEG", "C", "D", "E", "F", "G", "H", "I", "I_NEG", "J1", "J2", "J_NEG",
            "no-proof",
        ] {
            let case = generate_case(
                case_name,
                scale,
                &owner_tree_root,
                total_count,
                total_power,
                &owners,
                &owner_tree,
                &selected,
            );
            if case_name == "no-proof" {
                // no-proof must have an empty payload and no bull proof buffer.
            }
            all_cases.push(case);
        }

        parity.push(json!({
            "scale": scale,
            "sampleOwner": sample_owner.owner.to_string(),
            "sampleBull": sample_bull.position.to_string(),
            "ownerRootMatches": owner_root_matches,
            "bullRootMatches": bull_root_matches,
        }));

        eprintln!(
            "[scale] scale {} done in {:.2}s (peak {} KiB)",
            scale,
            build_elapsed.as_secs_f64(),
            peak_memory_kb()
        );
    }

    // Bull subtree membership scaling.
    for bull_count in [1usize, 2, 10, 100, 1_000] {
        eprintln!("[bull-subtree] Building bull subtree of {} ...", bull_count);
        let start = Instant::now();
        let case = make_bull_subtree_case(bull_count);
        let elapsed = start.elapsed();
        all_scales.push(json!({
            "scale": bull_count,
            "ownerCount": case["ownerCount"],
            "totalBullCount": case["totalBullCount"],
            "totalBuckPower": case["totalBuckPower"],
            "ownerTreeRoot": case["ownerTreeRoot"].clone(),
            "registryVersion": 0u64,
            "generationTimeSeconds": elapsed.as_secs_f64(),
            "peakMemoryKb": peak_memory_kb(),
            "ownerRootMatches": true,
            "bullRootMatches": true,
        }));
        all_cases.push(case);
    }

    // Final-bull removal / canonical empty owner.
    {
        eprintln!("[remove-one] Building final-bull removal fixture ...");
        let start = Instant::now();
        let case = make_remove_one_case();
        let elapsed = start.elapsed();
        all_scales.push(json!({
            "scale": 1,
            "ownerCount": case["ownerCount"],
            "totalBullCount": case["totalBullCount"],
            "totalBuckPower": case["totalBuckPower"],
            "ownerTreeRoot": case["ownerTreeRoot"].clone(),
            "registryVersion": 0u64,
            "generationTimeSeconds": elapsed.as_secs_f64(),
            "peakMemoryKb": peak_memory_kb(),
            "ownerRootMatches": true,
            "bullRootMatches": true,
        }));
        all_cases.push(case);
    }

    // Sort cases deterministically for stable output order.
    all_cases.sort_by(|a, b| {
        let case_a = a["case"].as_str().unwrap_or("");
        let case_b = b["case"].as_str().unwrap_or("");
        let scale_a = a["scale"].as_u64().unwrap_or(0);
        let scale_b = b["scale"].as_u64().unwrap_or(0);
        case_a.cmp(case_b).then(scale_a.cmp(&scale_b))
    });

    // Largest primitive payload / staging stats.
    let largest_payload = all_cases.iter().map(case_payload_bytes).max().unwrap_or(0);
    let largest_append_tx_count = (largest_payload + 899) / 900;

    meta["overallTimeSeconds"] = overall_start.elapsed().as_secs_f64().into();
    meta["largestPayloadBytes"] = largest_payload.into();
    meta["largestAppendTxCount"] = largest_append_tx_count.into();

    let output = json!({
        "scales": all_scales,
        "cases": all_cases,
        "parity": parity,
        "meta": meta,
    });

    // Repo-root fixture path (used by TypeScript benchmark).
    let repo_root = PathBuf::from("../../tests/integration/fixtures");
    std::fs::create_dir_all(&repo_root).unwrap();
    let out_path = repo_root.join("benchmark_fixtures.json");
    std::fs::write(&out_path, serde_json::to_string_pretty(&output).unwrap()).unwrap();
    eprintln!("Wrote {}", out_path.display());

    // Package-local fixture path for convenience.
    let pkg_local = PathBuf::from("tests/integration/fixtures");
    std::fs::create_dir_all(&pkg_local).unwrap();
    let out_path = pkg_local.join("benchmark_fixtures.json");
    std::fs::write(&out_path, serde_json::to_string_pretty(&output).unwrap()).unwrap();
    eprintln!("Wrote {}", out_path.display());
}

// ---------------------------------------------------------------------------
// SettleReveal full-path fixture generator.
// ---------------------------------------------------------------------------

const LOCALNET_PROGRAM_ID: &str = "EkEPd5wXSi3NQUHewx64cP27tDQ6uTcK5poG6AuWmy8Z";

fn derive_commitment_position(
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
    hash(&preimage).to_bytes()
}

fn derive_global_config_pda(program_id: Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_GLOBAL_CONFIG], &program_id)
}

fn derive_position_pda(
    program_id: Pubkey,
    global_config: Pubkey,
    position_id: u64,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            SEED_POSITION,
            global_config.as_ref(),
            &position_id.to_le_bytes(),
        ],
        &program_id,
    )
}

fn load_anchor_wallet_pubkey() -> Option<Pubkey> {
    let path = std::env::var("ANCHOR_WALLET").ok().or_else(|| {
        let home = std::env::var("HOME").ok()?;
        Some(format!("{}/.config/solana/id.json", home))
    })?;
    let content = std::fs::read_to_string(path).ok()?;
    let arr: Vec<u8> = serde_json::from_str(&content).ok()?;
    if arr.len() < 64 {
        return None;
    }
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&arr[32..64]);
    Some(Pubkey::new_from_array(bytes))
}

#[derive(Clone, Debug)]
struct TheftTarget {
    selected_idx: usize,
    selected_owner: Pubkey,
    selected_bull: BullLeaf,
    selected_owner_prefix: u64,
    selected_owner_power: u64,
    selected_bull_prefix: u64,
    selected_bull_power: u64,
    victim_prefix: u64,
    victim_power: u64,
    victim_count: u64,
    external_count: u64,
    external_power: u64,
    random_output: [u8; 32],
    tier: u8,
    power: u8,
}

fn build_bull_intervals(bulls: &[BullLeaf]) -> Vec<(u64, u64, BullLeaf)> {
    let mut indexed: Vec<_> = bulls
        .iter()
        .map(|b| {
            let mut key = b.position.to_bytes();
            key.reverse();
            (b.clone(), key)
        })
        .collect();
    indexed.sort_by(|a, b| a.1.cmp(&b.1));

    let mut out = Vec::with_capacity(bulls.len());
    let mut prefix = 0u64;
    for (b, _) in indexed {
        let power = b.buck_power as u64;
        out.push((prefix, power, b));
        prefix = prefix.saturating_add(power);
    }
    out
}

fn find_bull_by_intervals(
    intervals: &[(u64, u64, BullLeaf)],
    target: u64,
) -> Option<(&BullLeaf, u64, u64)> {
    if intervals.is_empty() {
        return None;
    }
    let mut lo = 0usize;
    let mut hi = intervals.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if intervals[mid].0 <= target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    let idx = lo.saturating_sub(1);
    let (prefix, power, b) = &intervals[idx];
    if leaf_contains_target(*prefix, *power, target) {
        Some((b, *prefix, *power))
    } else {
        None
    }
}

fn resolve_theft_target_for_position(
    owners: &[OwnerData],
    sorted: &[(usize, u64, u64, u64)],
    bull_intervals: &mut std::collections::HashMap<usize, Vec<(u64, u64, BullLeaf)>>,
    victim_idx: Option<usize>,
    total_bull_count: u64,
    total_buck_power: u64,
    position: Pubkey,
    action_nonce: u64,
) -> Option<TheftTarget> {
    let config = protocol_config_v1(Pubkey::default(), 0);
    let random_output = derive_commitment_position(position, ActionType::Reveal, action_nonce, 0);

    let role_ctx = RandomnessSampleContext {
        random_output,
        domain: RandomnessDomain::Role,
        position,
        action_nonce,
    };
    if map_role(role_ctx, &config).ok()? != Role::Bull {
        return None;
    }

    let theft_ctx = RandomnessSampleContext {
        random_output,
        domain: RandomnessDomain::MintTheft,
        position,
        action_nonce,
    };
    if !map_mint_theft_flag(theft_ctx, &config).ok()? {
        return None;
    }

    let (victim_count, victim_power, victim_prefix) = match victim_idx {
        Some(idx) => {
            let &(_, prefix, count, power) = sorted
                .iter()
                .find(|&&(i, _, _, _)| i == idx)
                .expect("victim not found in sorted owners");
            (count, power, prefix)
        }
        None => (0u64, 0u64, 0u64),
    };
    let external_count = total_bull_count.checked_sub(victim_count)?;
    let external_power = total_buck_power.checked_sub(victim_power)?;
    if external_count < config.min_bulls_for_theft || external_power == 0 {
        return None;
    }

    let owner_ctx = RandomnessSampleContext {
        random_output,
        domain: RandomnessDomain::OwnerSelection,
        position,
        action_nonce,
    };
    let owner_target = rejection_sample_draw(owner_ctx, external_power).ok()?;
    let safe_owner_target = skip_victim_interval(owner_target, victim_prefix, victim_power);
    let (selected_idx, selected_owner_prefix, _selected_count, selected_owner_power) =
        find_owner_by_target(&sorted, safe_owner_target);
    if Some(selected_idx) == victim_idx || selected_owner_power == 0 {
        return None;
    }

    let selected_owner = &owners[selected_idx];
    let intervals = bull_intervals
        .entry(selected_idx)
        .or_insert_with(|| build_bull_intervals(&selected_owner.bulls));

    let bull_ctx = RandomnessSampleContext {
        random_output,
        domain: RandomnessDomain::BullSelection,
        position,
        action_nonce,
    };
    let bull_target = rejection_sample_draw(bull_ctx, selected_owner_power).ok()?;
    let (selected_bull, selected_bull_prefix, selected_bull_power) =
        find_bull_by_intervals(intervals, bull_target)?;
    if selected_bull.owner != selected_owner.owner {
        return None;
    }

    let tier_ctx = RandomnessSampleContext {
        random_output,
        domain: RandomnessDomain::BullTier,
        position,
        action_nonce,
    };
    let tier = map_bull_tier(tier_ctx, &config).ok()?;
    let power = buck_power_for_tier(&config, tier);

    Some(TheftTarget {
        selected_idx,
        selected_owner: selected_owner.owner,
        selected_bull: *selected_bull,
        selected_owner_prefix,
        selected_owner_power,
        selected_bull_prefix,
        selected_bull_power,
        victim_prefix,
        victim_power,
        victim_count,
        external_count,
        external_power,
        random_output,
        tier,
        power,
    })
}

fn find_position_for_settle_reveal(
    owners: &[OwnerData],
    sorted: &[(usize, u64, u64, u64)],
    bull_intervals: &mut std::collections::HashMap<usize, Vec<(u64, u64, BullLeaf)>>,
    total_bull_count: u64,
    total_buck_power: u64,
    program_id: Pubkey,
    global_config: Pubkey,
    max_position_id: u64,
) -> Option<(u64, Pubkey, TheftTarget)> {
    for position_id in 0..max_position_id {
        let (position, _bump) = derive_position_pda(program_id, global_config, position_id);
        if let Some(target) = resolve_theft_target_for_position(
            owners,
            sorted,
            bull_intervals,
            None,
            total_bull_count,
            total_buck_power,
            position,
            0,
        ) {
            return Some((position_id, position, target));
        }
    }
    None
}

fn make_settle_reveal_case(
    case: &str,
    scale: usize,
    position_id: u64,
    position: Pubkey,
    owner_tree: &SparseTree,
    owners: &[OwnerData],
    total_bull_count: u64,
    total_buck_power: u64,
    owner_tree_root: &[u8; 32],
    target: &TheftTarget,
    victim: Pubkey,
) -> serde_json::Value {
    let selected = select_owners(owners);
    let selected_owner = &owners[target.selected_idx];

    // Historical proofs.
    let vproof = owner_proof_with_leaf(owner_tree, &victim, OwnerLeaf::empty());
    let oproof = owner_proof_with_leaf(
        owner_tree,
        &target.selected_owner,
        selected_owner.owner_leaf.clone(),
    );
    let bproof = bull_proof(selected_owner, &target.selected_bull.position);

    // Choose a non-final, non-victim owner to mutate for J1.
    let extra_owner_idx = if target.selected_idx != selected.normal {
        selected.normal
    } else {
        selected.dense
    };

    // Current registry variant.
    let (current_root, current_count, current_power, current_owner_proof, current_bull_proof) =
        if case.starts_with("J1") {
            let mut current_owners = owners.to_vec();
            let extra_owner_index = extra_owner_idx as u64;
            let extra_bull_index = 1_000_000u64;
            let extra_bull_position = deterministic_bull(extra_owner_index, extra_bull_index);
            let extra_bull_power =
                POWERS[((extra_owner_index + extra_bull_index) as usize) % POWERS.len()];
            let extra_bull = BullLeaf {
                position: extra_bull_position,
                position_id: total_bull_count + 1,
                owner: current_owners[extra_owner_idx].owner,
                buck_power: extra_bull_power,
                reveal_config_version: 1,
            };
            current_owners[extra_owner_idx].bulls.push(extra_bull);
            current_owners[extra_owner_idx].owner_leaf = owner_leaf_from_bulls(
                current_owners[extra_owner_idx].owner,
                &current_owners[extra_owner_idx].bulls,
            );
            current_owners[extra_owner_idx].bull_tree = None;

            let mut current_owner_tree =
                SparseTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);
            let mut current_total_count = 0u64;
            let mut current_total_power = 0u64;
            for od in &current_owners {
                current_owner_tree.insert(&od.owner.to_bytes(), od.owner_leaf.to_node());
                current_total_count += od.owner_leaf.active_bull_count;
                current_total_power += od.owner_leaf.total_buck_power;
            }
            let current_root_node = *current_owner_tree.root();

            let selected_owner_leaf = current_owners[target.selected_idx].owner_leaf.clone();
            let coproof = owner_proof_with_leaf(
                &current_owner_tree,
                &target.selected_owner,
                selected_owner_leaf,
            );
            let cbproof = bull_proof(&current_owners[target.selected_idx], &position);

            (
                current_root_node.hash,
                current_total_count,
                current_total_power,
                coproof,
                cbproof,
            )
        } else {
            // J2: final owner is absent from the current registry.
            let mut current_owners = owners.to_vec();
            current_owners.retain(|od| od.owner != target.selected_owner);
            let mut current_owner_tree =
                SparseTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);
            let mut current_total_count = 0u64;
            let mut current_total_power = 0u64;
            for od in &current_owners {
                current_owner_tree.insert(&od.owner.to_bytes(), od.owner_leaf.to_node());
                current_total_count += od.owner_leaf.active_bull_count;
                current_total_power += od.owner_leaf.total_buck_power;
            }
            let current_root_node = *current_owner_tree.root();

            let coproof = owner_proof_with_leaf(
                &current_owner_tree,
                &target.selected_owner,
                OwnerLeaf::empty(),
            );
            let empty_selected = OwnerData {
                owner: target.selected_owner,
                owner_leaf: OwnerLeaf::empty(),
                bull_tree: Some(build_bull_tree(&[])),
                bulls: Vec::new(),
            };
            let cbproof = bull_proof(&empty_selected, &position);

            (
                current_root_node.hash,
                current_total_count,
                current_total_power,
                coproof,
                cbproof,
            )
        };

    let new_bull = BullLeaf {
        position,
        position_id,
        owner: target.selected_owner,
        buck_power: target.power,
        reveal_config_version: 1,
    };

    let final_owner_leaf =
        add_bull_to_owner_leaf(&current_owner_proof.leaf, &new_bull, &current_bull_proof)
            .expect("final owner leaf");
    let final_root = apply_owner_leaf_update(
        &current_root,
        &target.selected_owner,
        &current_owner_proof,
        &final_owner_leaf,
    )
    .expect("final owner tree root");
    let final_total_count = current_count + 1;
    let final_total_power = current_power + target.power as u64;
    let final_registry_version = 1u64 + 1;

    let payload = BullProofPayloadV1 {
        schema_version: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
        section_bitmap: SECTION_VICTIM_OWNER
            | SECTION_SELECTED_OWNER
            | SECTION_SELECTED_BULL
            | SECTION_CURRENT_OWNER
            | SECTION_CURRENT_BULL,
        victim_owner: Some(vproof),
        selected_owner: Some(oproof.clone()),
        selected_bull: Some(bproof),
        current_owner: Some(current_owner_proof),
        current_bull: Some(current_bull_proof),
        remove_bull: None,
    };
    let payload_bytes = payload.try_to_vec().unwrap();

    json!({
        "case": case,
        "scale": scale,
        "ownerCount": owners.len(),
        "bullsInSelectedOwner": selected_owner.owner_leaf.active_bull_count,
        "ownerTreeRoot": hash_array(&final_root),
        "totalBullCount": final_total_count,
        "totalBuckPower": final_total_power,
        "registryVersion": final_registry_version,
        "victim": victim.to_string(),
        "selectedOwner": target.selected_owner.to_string(),
        "selectedBull": bull_leaf_json(&target.selected_bull),
        "newBull": bull_leaf_json(&new_bull),
        "finalOwner": target.selected_owner.to_string(),
        "tier": target.tier,
        "power": target.power,
        "payloadHex": hex::encode(&payload_bytes),
        "nonDefaultOwnerSiblings": oproof.proof.siblings.len(),
        "nonDefaultBullSiblings": payload.selected_bull.as_ref().unwrap().proof.siblings.len(),
        "payloadBytes": payload_bytes.len(),
        "ownerSiblings": siblings_hex(&oproof.proof),
        "bullSiblings": siblings_hex(&payload.selected_bull.as_ref().unwrap().proof),
        "expectedSuccess": true,
        "sectionBytes": compute_section_bytes(&payload),
        "randomOutput": json!(target.random_output.to_vec()),
        "position": position.to_string(),
        "positionId": position_id,
        "actionNonce": 0u64,
        "programId": LOCALNET_PROGRAM_ID,
        "globalConfig": derive_global_config_pda(LOCALNET_PROGRAM_ID.parse::<Pubkey>().unwrap()).0.to_string(),
        "externalCount": target.external_count,
        "externalPower": target.external_power,
        "selectedOwnerIntervalStart": target.selected_owner_prefix,
        "selectedOwnerIntervalEnd": target.selected_owner_prefix + target.selected_owner_power,
        "selectedBullIntervalStart": target.selected_bull_prefix,
        "selectedBullIntervalEnd": target.selected_bull_prefix + target.selected_bull_power,
        "snapshotRoot": hash_array(owner_tree_root),
        "snapshotTotalCount": total_bull_count,
        "snapshotTotalPower": total_buck_power,
        "snapshotVersion": 0u64,
        "currentOwnerTreeRoot": hash_array(&current_root),
        "currentTotalBullCount": current_count,
        "currentTotalBuckPower": current_power,
        "currentRegistryVersion": 1u64,
    })
}

#[test]
#[ignore = "slow settle-reveal fixture generator"]
fn generate_settle_reveal_fixtures() {
    let full = std::env::var("RODEO_BENCH_FULL").is_ok();
    let scales: Vec<usize> = if full {
        vec![4, 10_000, 100_000, 1_000_000]
    } else {
        vec![4, 10_000, 100_000]
    };

    let victim = load_anchor_wallet_pubkey().expect(
        "settle-reveal fixture generator requires ANCHOR_WALLET or ~/.config/solana/id.json",
    );

    let program_id: Pubkey = LOCALNET_PROGRAM_ID
        .parse()
        .expect("valid localnet program id");
    let (global_config, _global_bump) = derive_global_config_pda(program_id);

    let mut all_cases: Vec<serde_json::Value> = Vec::new();
    let mut meta = json!({
        "generatedAt": format!("{:?}", std::time::SystemTime::now()),
        "full": full,
    });

    let overall_start = Instant::now();

    for scale in scales {
        eprintln!("[settle-reveal] Building fixtures for scale {} ...", scale);
        let start = Instant::now();
        let (owner_root, owners, total_count, total_power, owner_tree) = build_registry(scale);
        let owner_tree_root = owner_root.hash;
        let build_elapsed = start.elapsed();

        // Ensure the staker is not one of the registered owners.
        if owners.iter().any(|od| od.owner == victim) {
            panic!("victim/staker pubkey collides with a registered owner");
        }

        let sorted = sort_owners_by_path(&owners);
        let mut bull_intervals = std::collections::HashMap::new();

        let max_position_id = if scale >= 1_000_000 {
            2_000_000
        } else {
            100_000
        };
        let search = find_position_for_settle_reveal(
            &owners,
            &sorted,
            &mut bull_intervals,
            total_count,
            total_power,
            program_id,
            global_config,
            max_position_id,
        )
        .expect("no valid SettleReveal target found");
        let (position_id, position, target) = search;

        let search_elapsed = start.elapsed();

        all_cases.push(make_settle_reveal_case(
            "J1",
            scale,
            position_id,
            position,
            &owner_tree,
            &owners,
            total_count,
            total_power,
            &owner_tree_root,
            &target,
            victim,
        ));
        all_cases.push(make_settle_reveal_case(
            "J2",
            scale,
            position_id,
            position,
            &owner_tree,
            &owners,
            total_count,
            total_power,
            &owner_tree_root,
            &target,
            victim,
        ));

        eprintln!(
            "[settle-reveal] scale {} done in {:.2}s (search {:.2}s, position_id {})",
            scale,
            search_elapsed.as_secs_f64(),
            (search_elapsed - build_elapsed).as_secs_f64(),
            position_id,
        );
    }

    meta["overallTimeSeconds"] = overall_start.elapsed().as_secs_f64().into();

    let output = json!({
        "cases": all_cases,
        "meta": meta,
    });

    let repo_root = PathBuf::from("../../tests/integration/fixtures");
    std::fs::create_dir_all(&repo_root).unwrap();
    let out_path = repo_root.join("settle_reveal_fixtures.json");
    std::fs::write(&out_path, serde_json::to_string_pretty(&output).unwrap()).unwrap();
    eprintln!("Wrote {}", out_path.display());

    let pkg_local = PathBuf::from("tests/integration/fixtures");
    std::fs::create_dir_all(&pkg_local).unwrap();
    let out_path = pkg_local.join("settle_reveal_fixtures.json");
    std::fs::write(&out_path, serde_json::to_string_pretty(&output).unwrap()).unwrap();
    eprintln!("Wrote {}", out_path.display());
}
