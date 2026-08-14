use std::path::PathBuf;

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

#[derive(Clone, Debug, PartialEq, Eq)]
struct TrieNode {
    children: [Option<Box<TrieNode>>; 2],
    height: usize,
    node: SparseMerkleNode,
}

impl TrieNode {
    fn new(height: usize, defaults: &[SparseMerkleNode]) -> Self {
        Self {
            children: [None, None],
            height,
            node: defaults[height],
        }
    }
}

#[derive(Clone)]
struct SparseTree {
    root: TrieNode,
    defaults: Vec<SparseMerkleNode>,
    prefix: &'static [u8],
}

impl SparseTree {
    fn new(empty_leaf: &SparseMerkleNode, prefix: &'static [u8]) -> Self {
        let defaults =
            rodeo_core::sparse_tree::compute_default_empty_nodes(empty_leaf, prefix).unwrap();
        let root = TrieNode::new(SPARSE_TREE_DEPTH as usize, &defaults);
        Self {
            root,
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
        let mut path: Vec<*mut TrieNode> = Vec::with_capacity(SPARSE_TREE_DEPTH as usize + 1);
        let mut current = &mut self.root as *mut TrieNode;
        path.push(current);
        unsafe {
            for h in (1..=SPARSE_TREE_DEPTH as usize).rev() {
                let bit = Self::bit_at(key, (h - 1) as u32) as usize;
                let node = &mut *current;
                if node.children[bit].is_none() {
                    node.children[bit] = Some(Box::new(TrieNode::new(h - 1, &self.defaults)));
                }
                current = node.children[bit].as_mut().unwrap().as_mut() as *mut TrieNode;
                path.push(current);
            }
            let leaf_node = &mut *current;
            leaf_node.node = leaf;

            for ptr in path.iter().rev().skip(1) {
                let node = &mut **ptr;
                let h = node.height;
                let left = if let Some(ref c) = node.children[0] {
                    c.node
                } else {
                    self.defaults[h - 1]
                };
                let right = if let Some(ref c) = node.children[1] {
                    c.node
                } else {
                    self.defaults[h - 1]
                };
                node.node = hash_node(self.prefix, &left, &right).unwrap();
            }
        }
    }

    fn proof(&self, key: &[u8; 32]) -> CompressedSparseProof {
        let mut bitmap = [0u8; 32];
        let mut siblings_rev = Vec::with_capacity(SPARSE_TREE_DEPTH as usize);
        let mut current: Option<&TrieNode> = Some(&self.root);

        for h in (1..=SPARSE_TREE_DEPTH as usize).rev() {
            let bit = Self::bit_at(key, (h - 1) as u32) as usize;
            if let Some(node) = current {
                let sibling = if let Some(ref child) = node.children[1 - bit] {
                    child.node
                } else {
                    self.defaults[h - 1]
                };
                if sibling != self.defaults[h - 1] {
                    bitmap[(h - 1) / 8] |= 1 << ((h - 1) % 8);
                    siblings_rev.push(sibling);
                }
                current = node.children[bit].as_deref();
            }
        }

        siblings_rev.reverse();
        let leaf = current.map(|n| n.node).unwrap_or(self.defaults[0]);

        CompressedSparseProof {
            bitmap,
            siblings: siblings_rev,
            leaf,
        }
    }

    fn root(&self) -> &SparseMerkleNode {
        &self.root.node
    }
}

struct OwnerData {
    owner: Pubkey,
    owner_leaf: OwnerLeaf,
    bull_tree: SparseTree,
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

fn build_registry(scale: usize) -> (SparseMerkleNode, Vec<OwnerData>, u64, u64) {
    let mut owners = Vec::new();
    let mut total_count: u64 = 0;
    let mut total_power: u64 = 0;
    let mut owner_index: u64 = 0;

    let dense_count = if scale >= 2000 { 1000 } else { scale / 2 } as u64;
    let mut remaining = scale as u64 - dense_count;

    if dense_count > 0 {
        let owner = deterministic_owner(owner_index);
        let mut bulls = Vec::with_capacity(dense_count as usize);
        for j in 0..dense_count {
            let position = deterministic_bull(owner_index, j);
            let power = POWERS[((owner_index + j) as usize) % POWERS.len()];
            let leaf = BullLeaf {
                position,
                position_id: total_count + 1,
                owner,
                buck_power: power,
                reveal_config_version: 1,
            };
            bulls.push(leaf);
            total_count += 1;
            total_power += power as u64;
        }
        let mut bull_tree = SparseTree::new(&BullLeaf::empty().to_node(), PREFIX_BULL_NODE);
        for bull in &bulls {
            let key = bull.position.to_bytes();
            bull_tree.insert(&key, bull.to_node());
        }
        let root = *bull_tree.root();
        let owner_leaf = OwnerLeaf {
            owner,
            active_bull_count: bulls.len() as u64,
            total_buck_power: root.power,
            bull_tree_root: root.hash,
        };
        owners.push(OwnerData {
            owner,
            owner_leaf,
            bull_tree,
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
        let mut bulls = Vec::with_capacity(count as usize);
        for j in 0..count {
            let position = deterministic_bull(owner_index, j);
            let power = POWERS[((owner_index + j) as usize) % POWERS.len()];
            let leaf = BullLeaf {
                position,
                position_id: total_count + 1,
                owner,
                buck_power: power,
                reveal_config_version: 1,
            };
            bulls.push(leaf);
            total_count += 1;
            total_power += power as u64;
        }
        let mut bull_tree = SparseTree::new(&BullLeaf::empty().to_node(), PREFIX_BULL_NODE);
        for bull in &bulls {
            let key = bull.position.to_bytes();
            bull_tree.insert(&key, bull.to_node());
        }
        let root = *bull_tree.root();
        let owner_leaf = OwnerLeaf {
            owner,
            active_bull_count: bulls.len() as u64,
            total_buck_power: root.power,
            bull_tree_root: root.hash,
        };
        owners.push(OwnerData {
            owner,
            owner_leaf,
            bull_tree,
            bulls,
        });
        owner_index += 1;
        remaining -= count;
        pattern_idx += 1;
    }

    let mut owner_tree = SparseTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);
    for od in &owners {
        let key = od.owner.to_bytes();
        owner_tree.insert(&key, od.owner_leaf.to_node());
    }

    assert_eq!(owner_tree.root().count, total_count);
    assert_eq!(owner_tree.root().power, total_power);

    (*owner_tree.root(), owners, total_count, total_power)
}

fn owner_proof(
    owner_tree: &SparseTree,
    owners: &[OwnerData],
    owner_key: &Pubkey,
) -> CompressedOwnerProof {
    if let Some(od) = owners.iter().find(|o| o.owner == *owner_key) {
        let key = od.owner.to_bytes();
        CompressedOwnerProof {
            leaf: od.owner_leaf.clone(),
            proof: owner_tree.proof(&key),
        }
    } else {
        let key = owner_key.to_bytes();
        CompressedOwnerProof {
            leaf: OwnerLeaf::empty(),
            proof: owner_tree.proof(&key),
        }
    }
}

fn bull_proof(od: &OwnerData, position: &Pubkey) -> CompressedBullProof {
    if let Some(bull) = od.bulls.iter().find(|b| b.position == *position) {
        let key = bull.position.to_bytes();
        CompressedBullProof {
            leaf: bull.clone(),
            proof: od.bull_tree.proof(&key),
        }
    } else {
        let key = position.to_bytes();
        CompressedBullProof {
            leaf: BullLeaf::empty(),
            proof: od.bull_tree.proof(&key),
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

fn generate_case(
    name: &str,
    scale: usize,
    owner_tree_root: &[u8; 32],
    total_bull_count: u64,
    total_buck_power: u64,
    owners: &[OwnerData],
    owner_tree: &SparseTree,
    dense_idx: Option<usize>,
    normal_idx: Option<usize>,
    one_idx: Option<usize>,
    multi_idx: Option<usize>,
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

    let first_non_dense = normal_idx.or(dense_idx).unwrap_or(0);
    let dense = dense_idx.unwrap_or(first_non_dense);
    let multi = multi_idx.unwrap_or(first_non_dense);
    let one = one_idx.unwrap_or(first_non_dense);

    match name {
        "A" => {
            let od = &owners[first_non_dense];
            let proof = owner_proof(owner_tree, owners, &od.owner);
            owner_siblings = siblings_hex(&proof.proof);
            owner_non_default = proof.proof.siblings.len();
            bulls_in_selected = od.owner_leaf.active_bull_count;
            payload.section_bitmap = SECTION_SELECTED_OWNER;
            payload.selected_owner = Some(proof);
        }
        "B" => {
            let absent = deterministic_owner(1_000_000 + scale as u64);
            let proof = owner_proof(owner_tree, owners, &absent);
            owner_siblings = siblings_hex(&proof.proof);
            owner_non_default = proof.proof.siblings.len();
            payload.section_bitmap = SECTION_SELECTED_OWNER;
            payload.selected_owner = Some(proof);
        }
        "C" => {
            let od = &owners[multi];
            let bull = &od.bulls[0];
            let oproof = owner_proof(owner_tree, owners, &od.owner);
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
            let od = &owners[multi];
            let new_bull_index = 1_000_000u64;
            let position = deterministic_bull(multi as u64, new_bull_index);
            let power = POWERS[(multi + new_bull_index as usize) % POWERS.len()];
            let leaf = BullLeaf {
                position,
                position_id: total_bull_count + 1,
                owner: od.owner,
                buck_power: power,
                reveal_config_version: 1,
            };
            new_bull = Some(leaf);
            let oproof = owner_proof(owner_tree, owners, &od.owner);
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
            let oproof = owner_proof(owner_tree, owners, &owner);
            let od = if owner == owners[0].owner {
                &owners[0]
            } else {
                // The owner is absent, but we need a dummy bull tree for the target position.
                // Use the first owner's tree as a stand-in for the absent path; the proof
                // will be a default one regardless because the slot is empty.
                &owners[0]
            };
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
            let od = &owners[multi];
            let bull = &od.bulls[0];
            let oproof = owner_proof(owner_tree, owners, &od.owner);
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
            let od = &owners[one];
            let bull = &od.bulls[0];
            let oproof = owner_proof(owner_tree, owners, &od.owner);
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
            let victim_idx = first_non_dense;
            let selected = &owners[dense];
            let bull = &selected.bulls[0];
            let vproof = owner_proof(owner_tree, owners, &owners[victim_idx].owner);
            let oproof = owner_proof(owner_tree, owners, &selected.owner);
            let bproof = bull_proof(selected, &bull.position);
            owner_siblings = siblings_hex(&oproof.proof);
            bull_siblings = siblings_hex(&bproof.proof);
            owner_non_default = oproof.proof.siblings.len();
            bull_non_default = bproof.proof.siblings.len();
            bulls_in_selected = selected.owner_leaf.active_bull_count;
            victim = Some(owners[victim_idx].owner);
            payload.section_bitmap =
                SECTION_VICTIM_OWNER | SECTION_SELECTED_OWNER | SECTION_SELECTED_BULL;
            payload.victim_owner = Some(vproof);
            payload.selected_owner = Some(oproof);
            payload.selected_bull = Some(bproof);
        }
        "I" => {
            let selected = &owners[dense];
            let bull_idx = selected.bulls.len() / 2;
            let bull = &selected.bulls[bull_idx];
            let oproof = owner_proof(owner_tree, owners, &selected.owner);
            let bproof = bull_proof(selected, &bull.position);
            owner_siblings = siblings_hex(&oproof.proof);
            bull_siblings = siblings_hex(&bproof.proof);
            owner_non_default = oproof.proof.siblings.len();
            bull_non_default = bproof.proof.siblings.len();
            bulls_in_selected = selected.owner_leaf.active_bull_count;
            victim = Some(selected.owner);
            payload.section_bitmap =
                SECTION_VICTIM_OWNER | SECTION_SELECTED_OWNER | SECTION_SELECTED_BULL;
            payload.victim_owner = Some(owner_proof(owner_tree, owners, &selected.owner));
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
    })
}

#[test]
#[ignore = "slow fixture generator"]
fn generate_sparse_benchmark_fixtures() {
    let full = std::env::var("RODEO_BENCH_FULL").is_ok();
    let scales: Vec<usize> = if full {
        vec![100, 1_000, 10_000, 100_000, 1_000_000]
    } else {
        vec![100, 1_000, 10_000]
    };

    let mut all_scales = Vec::new();
    let mut all_cases = Vec::new();
    let mut parity = Vec::new();

    for scale in scales {
        eprintln!("Building fixtures for scale {} ...", scale);
        let (owner_root, owners, total_count, total_power) = build_registry(scale);
        let owner_tree_root = owner_root.hash;
        let mut owner_tree = SparseTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);
        for od in &owners {
            let key = od.owner.to_bytes();
            owner_tree.insert(&key, od.owner_leaf.to_node());
        }

        let dense_idx = if scale >= 2000 || (scale >= 100 && scale / 2 > 0) {
            Some(0usize)
        } else {
            None
        };
        let mut normal_idx = None;
        let mut one_idx = None;
        let mut multi_idx = None;
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
            if od.bulls.len() > 1 && multi_idx.is_none() {
                multi_idx = Some(i);
            }
        }

        all_scales.push(json!({
            "scale": scale,
            "ownerCount": owners.len(),
            "totalBullCount": total_count,
            "totalBuckPower": total_power,
            "ownerTreeRoot": hash_array(&owner_tree_root),
            "registryVersion": 0u64,
        }));

        for case in ["A", "B", "C", "D", "E", "F", "G", "H", "I", "no-proof"] {
            all_cases.push(generate_case(
                case,
                scale,
                &owner_tree_root,
                total_count,
                total_power,
                &owners,
                &owner_tree,
                dense_idx,
                normal_idx,
                one_idx,
                multi_idx,
            ));
        }

        // Parity: verify a sample owner and a sample bull using rodeo_core::sparse_tree::verify_with_prefix.
        let sample_owner_idx = normal_idx.or(dense_idx).unwrap_or(0);
        let od = &owners[sample_owner_idx];
        let owner_key = od.owner.to_bytes();
        let owner_proof = owner_tree.proof(&owner_key);
        let (owner_recomputed, owner_prefix) = verify_with_prefix(
            &owner_tree_root,
            &owner_key,
            &owner_proof,
            &od.owner_leaf.to_node(),
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

        let sample_bull = &od.bulls[0];
        let bull_key = sample_bull.position.to_bytes();
        let bull_proof = od.bull_tree.proof(&bull_key);
        let (bull_recomputed, bull_prefix) = verify_with_prefix(
            &od.owner_leaf.bull_tree_root,
            &bull_key,
            &bull_proof,
            &sample_bull.to_node(),
            PREFIX_BULL_NODE,
            &BullLeaf::empty().to_node(),
        )
        .unwrap();
        let bull_root_matches = bull_recomputed.hash == od.owner_leaf.bull_tree_root;
        assert!(bull_root_matches, "bull root mismatch at scale {}", scale);
        assert_eq!(
            bull_recomputed.count, od.owner_leaf.active_bull_count,
            "bull total count mismatch"
        );
        assert_eq!(
            bull_recomputed.power, od.owner_leaf.total_buck_power,
            "bull total power mismatch"
        );

        parity.push(json!({
            "scale": scale,
            "sampleOwner": od.owner.to_string(),
            "sampleBull": sample_bull.position.to_string(),
            "ownerRootMatches": owner_root_matches,
            "bullRootMatches": bull_root_matches,
            "ownerPrefix": owner_prefix,
            "bullPrefix": bull_prefix,
        }));
    }

    let output = json!({
        "scales": all_scales,
        "cases": all_cases,
        "parity": parity,
    });

    let out_dir = PathBuf::from("tests/integration/fixtures");
    std::fs::create_dir_all(&out_dir).unwrap();
    let out_path = out_dir.join("benchmark_fixtures.json");
    std::fs::write(&out_path, serde_json::to_string_pretty(&output).unwrap()).unwrap();
    eprintln!("Wrote {}", out_path.display());
}
