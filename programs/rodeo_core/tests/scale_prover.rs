use std::path::PathBuf;
use std::time::Instant;

use anchor_lang::prelude::*;
use anchor_lang::AnchorSerialize;
use rodeo_core::bull_registry::{
    BullLeaf, BullProofPayloadV1, CompressedBullProof, CompressedOwnerProof, OwnerLeaf,
    BULL_PROOF_PAYLOAD_SCHEMA_VERSION, SECTION_CURRENT_BULL, SECTION_CURRENT_OWNER,
    SECTION_REMOVE_BULL, SECTION_SELECTED_BULL, SECTION_SELECTED_OWNER, SECTION_VICTIM_OWNER,
};
use rodeo_core::sparse_tree::{
    hash_node, verify_with_prefix, CompressedSparseProof, SparseMerkleNode, SPARSE_TREE_DEPTH,
};
use serde_json::json;
use solana_program::hash::hashv;

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
        .expect("bull tree required for selected owner");
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
            let selected_idx = selected.dense;
            let selected_owner = &owners[selected_idx];
            let bull = &selected_owner.bulls[0];
            let vproof = owner_proof_with_leaf(
                owner_tree,
                &owners[victim_idx].owner,
                owners[victim_idx].owner_leaf.clone(),
            );
            let oproof = owner_proof_with_leaf(
                owner_tree,
                &selected_owner.owner,
                selected_owner.owner_leaf.clone(),
            );
            let bproof = bull_proof(selected_owner, &bull.position);
            owner_siblings = siblings_hex(&oproof.proof);
            bull_siblings = siblings_hex(&bproof.proof);
            owner_non_default = oproof.proof.siblings.len();
            bull_non_default = bproof.proof.siblings.len();
            bulls_in_selected = selected_owner.owner_leaf.active_bull_count;
            victim = Some(owners[victim_idx].owner);
            payload.section_bitmap =
                SECTION_VICTIM_OWNER | SECTION_SELECTED_OWNER | SECTION_SELECTED_BULL;
            payload.victim_owner = Some(vproof);
            payload.selected_owner = Some(oproof);
            payload.selected_bull = Some(bproof);
        }
        "I" => {
            let selected_idx = selected.dense;
            let selected_owner = &owners[selected_idx];
            let bull_idx = selected_owner.bulls.len() / 2;
            let bull = &selected_owner.bulls[bull_idx];
            let oproof = owner_proof_with_leaf(
                owner_tree,
                &selected_owner.owner,
                selected_owner.owner_leaf.clone(),
            );
            let bproof = bull_proof(selected_owner, &bull.position);
            owner_siblings = siblings_hex(&oproof.proof);
            bull_siblings = siblings_hex(&bproof.proof);
            owner_non_default = oproof.proof.siblings.len();
            bull_non_default = bproof.proof.siblings.len();
            bulls_in_selected = selected_owner.owner_leaf.active_bull_count;
            victim = Some(selected_owner.owner);
            payload.section_bitmap =
                SECTION_VICTIM_OWNER | SECTION_SELECTED_OWNER | SECTION_SELECTED_BULL;
            payload.victim_owner = Some(owner_proof_with_leaf(
                owner_tree,
                &selected_owner.owner,
                selected_owner.owner_leaf.clone(),
            ));
            payload.selected_owner = Some(oproof);
            payload.selected_bull = Some(bproof);
        }
        _ => {}
    }

    let payload_bytes = payload.try_to_vec().unwrap();

    json!({
        "case": name,
        "scale": scale,
        "ownerCount": owners.len(),
        "bullsInSelectedOwner": bulls_in_selected,
        "ownerTreeRoot": hash_array(owner_tree_root),
        "totalBullCount": total_bull_count,
        "totalBuckPower": total_buck_power,
        "registryVersion": 0u64,
        "victim": victim.map(|p| p.to_string()),
        "newBull": new_bull.as_ref().map(bull_leaf_json),
        "payloadHex": hex::encode(&payload_bytes),
        "nonDefaultOwnerSiblings": owner_non_default,
        "nonDefaultBullSiblings": bull_non_default,
        "payloadBytes": payload_bytes.len(),
        "ownerSiblings": owner_siblings,
        "bullSiblings": bull_siblings,
        "expectedSuccess": expected_success,
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
        vec![100, 1_000, 10_000]
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
            "A", "B", "B_NEG", "C", "D", "E", "F", "G", "H", "I", "no-proof",
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
