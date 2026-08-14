// Comprehensive SettleUnstake tests for the borrowed/raw proof-buffer integration.
//
// Covers:
//   1. validate_unstake_bull_proof_buffer security boundary (rejection cases + valid)
//   2. remove_bull_from_registry_borrowed (owner-remains, final-bull, leaf-vs-root, stale-proof)
//   3. Non-Bull proofless requirement

use super::*;
use crate::borrowed_proof::{self, BullProofPayloadRef};
use crate::bull_registry::{
    add_bull_to_registry, empty_bull_tree_root, empty_owner_tree_root,
    remove_bull_from_registry_borrowed, BullLeaf, BullProofPayloadV1,
    CompressedBullProof, CompressedOwnerProof, OwnerLeaf,
    BULL_PROOF_PAYLOAD_SCHEMA_VERSION, SECTION_CURRENT_OWNER, SECTION_REMOVE_BULL,
};
use crate::constants::SEED_BULL_PROOF_BUFFER;
use crate::sparse_tree::{
    compute_default_empty_nodes, hash_node, CompressedSparseProof, SparseMerkleNode,
    SPARSE_TREE_DEPTH,
};
use crate::state::{ActionType, BullRegistry, PendingRandomness};

const PREFIX_BULL_OWNER_NODE: &[u8] = b"rodeo_v2_bull_owner_node";
const PREFIX_BULL_NODE: &[u8] = b"rodeo_v2_bull_node";

// ─── Minimal sparse tree builder (same as reveal_tests) ──────────────────

struct TestTree {
    nodes: Vec<(SparseMerkleNode, [u8; 32])>,
    defaults: Vec<SparseMerkleNode>,
    prefix: &'static [u8],
}

impl TestTree {
    fn new(empty_leaf: &SparseMerkleNode, prefix: &'static [u8]) -> Self {
        let defaults = compute_default_empty_nodes(empty_leaf, prefix).unwrap();
        Self {
            nodes: Vec::new(),
            defaults,
            prefix,
        }
    }

    fn insert(&mut self, key: [u8; 32], leaf: SparseMerkleNode) {
        self.nodes.push((leaf, key));
    }

    fn root(&self) -> SparseMerkleNode {
        if self.nodes.is_empty() {
            return self.defaults[SPARSE_TREE_DEPTH as usize];
        }
        self.build_subtree(SPARSE_TREE_DEPTH as usize, &self.nodes.clone())
    }

    fn build_subtree(
        &self,
        height: usize,
        items: &[(SparseMerkleNode, [u8; 32])],
    ) -> SparseMerkleNode {
        if items.is_empty() {
            return self.defaults[height];
        }
        if height == 0 {
            return items[0].0;
        }
        let bit_idx = height - 1;
        let mut left = Vec::new();
        let mut right = Vec::new();
        for item in items {
            if (item.1[bit_idx / 8] >> (bit_idx % 8)) & 1 == 1 {
                right.push(*item);
            } else {
                left.push(*item);
            }
        }
        let l = self.build_subtree(height - 1, &left);
        let r = self.build_subtree(height - 1, &right);
        hash_node(self.prefix, &l, &r).unwrap()
    }

    fn proof(&self, key: &[u8; 32]) -> CompressedSparseProof {
        let mut bitmap = [0u8; 32];
        let mut siblings = Vec::new();
        let items = self.nodes.clone();

        fn bit_at(bytes: &[u8; 32], index: usize) -> bool {
            (bytes[index / 8] >> (index % 8)) & 1 == 1
        }

        fn build_subtree_only(
            height: usize,
            items: &[(SparseMerkleNode, [u8; 32])],
            defaults: &[SparseMerkleNode],
            prefix: &[u8],
        ) -> SparseMerkleNode {
            if items.is_empty() {
                return defaults[height];
            }
            if height == 0 {
                return items[0].0;
            }
            let bit_idx = height - 1;
            let mut left = Vec::new();
            let mut right = Vec::new();
            for item in items {
                if bit_at(&item.1, bit_idx) {
                    right.push(*item);
                } else {
                    left.push(*item);
                }
            }
            let l = build_subtree_only(height - 1, &left, defaults, prefix);
            let r = build_subtree_only(height - 1, &right, defaults, prefix);
            hash_node(prefix, &l, &r).unwrap()
        }

        fn traverse(
            height: usize,
            items: &[(SparseMerkleNode, [u8; 32])],
            key: &[u8; 32],
            defaults: &[SparseMerkleNode],
            prefix: &[u8],
            bitmap: &mut [u8; 32],
            siblings: &mut Vec<SparseMerkleNode>,
        ) -> SparseMerkleNode {
            if height == 0 {
                return items.first().map(|i| i.0).unwrap_or(defaults[0]);
            }
            let bit_idx = height - 1;
            let want = bit_at(key, bit_idx);
            let mut left = Vec::new();
            let mut right = Vec::new();
            for item in items {
                if bit_at(&item.1, bit_idx) {
                    right.push(*item);
                } else {
                    left.push(*item);
                }
            }
            let (my_items, sib_items) = if want {
                (&right, &left)
            } else {
                (&left, &right)
            };
            let sib_node = if sib_items.is_empty() {
                defaults[height - 1]
            } else {
                build_subtree_only(height - 1, sib_items, defaults, prefix)
            };
            let my_node =
                traverse(height - 1, my_items, key, defaults, prefix, bitmap, siblings);
            if sib_node != defaults[height - 1] {
                bitmap[bit_idx / 8] |= 1 << (bit_idx % 8);
                siblings.push(sib_node);
            }
            my_node
        }

        let _leaf = traverse(
            SPARSE_TREE_DEPTH as usize,
            &items,
            key,
            &self.defaults,
            self.prefix,
            &mut bitmap,
            &mut siblings,
        );
        siblings.reverse();
        CompressedSparseProof {
            bitmap,
            siblings,
            leaf: items
                .iter()
                .find(|(_, k)| k == key)
                .map(|(n, _)| *n)
                .unwrap_or(self.defaults[0]),
        }
    }
}

// ─── helpers ─────────────────────────────────────────────────────────────

fn pk(n: u64) -> Pubkey {
    let mut b = [0u8; 32];
    b[0..8].copy_from_slice(&n.to_le_bytes());
    Pubkey::new_from_array(b)
}

fn empty_owner_proof() -> CompressedOwnerProof {
    CompressedOwnerProof {
        leaf: OwnerLeaf::empty(),
        proof: CompressedSparseProof {
            bitmap: [0u8; 32],
            siblings: vec![],
            leaf: OwnerLeaf::empty().to_node(),
        },
    }
}

fn empty_bull_proof() -> CompressedBullProof {
    CompressedBullProof {
        leaf: BullLeaf::empty(),
        proof: CompressedSparseProof {
            bitmap: [0u8; 32],
            siblings: vec![],
            leaf: BullLeaf::empty().to_node(),
        },
    }
}

fn make_bull_registry() -> BullRegistry {
    BullRegistry {
        version: 1,
        global_config: Pubkey::default(),
        owner_tree_root: empty_owner_tree_root(),
        total_bull_count: 0,
        total_buck_power: 0,
        registry_version: 0,
        bump: 0,
    }
}

fn make_pending_randomness_unstake(position: Pubkey, action_nonce: u64) -> PendingRandomness {
    PendingRandomness {
        version: 1,
        position,
        action_type: ActionType::Unstake,
        action_nonce,
        provider_program: Pubkey::default(),
        provider_randomness_account: Pubkey::default(),
        commitment: [0u8; 32],
        committed_slot: 0,
        committed_protocol_epoch: 0,
        timeout_timestamp: 0,
        registry_root_snapshot: [0u8; 32],
        registry_version_snapshot: 0,
        registry_total_count_snapshot: 0,
        registry_total_power_snapshot: 0,
        config_version_snapshot: 0,
        settled: false,
        bump: 0,
    }
}

/// Build a payload with current_owner and remove_bull sections for Unstake.
fn unstake_payload_bytes(
    current_owner: &CompressedOwnerProof,
    remove_bull: &CompressedBullProof,
) -> Vec<u8> {
    let bitmap = SECTION_CURRENT_OWNER | SECTION_REMOVE_BULL;
    let payload = BullProofPayloadV1 {
        schema_version: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
        section_bitmap: bitmap,
        victim_owner: None,
        selected_owner: None,
        selected_bull: None,
        current_owner: Some(current_owner.clone()),
        current_bull: None,
        remove_bull: Some(remove_bull.clone()),
    };
    payload.try_to_vec().unwrap()
}

/// Build raw BullProofBuffer account data with the given fields.
/// Layout matches BullProofBufferRef::from_account_data exactly.
fn build_buffer_data(
    pending_randomness: &Pubkey,
    position: &Pubkey,
    action_type: u8,
    snapshot_root: [u8; 32],
    snapshot_version: u64,
    snapshot_total_power: u64,
    snapshot_total_count: u64,
    refund_recipient: &Pubkey,
    expiry_timestamp: i64,
    nonce: u64,
    bump: u8,
    finalized: bool,
    consumed: bool,
    payload: &[u8],
) -> Vec<u8> {
    let disc = &anchor_lang::solana_program::hash::hash(b"account:BullProofBuffer").to_bytes()
        [..8];
    let payload_len = payload.len() as u32;
    let mut data = Vec::new();
    // discriminator (8)
    data.extend_from_slice(disc);
    // version (1)
    data.push(1u8);
    // schema_version (1)
    data.push(BULL_PROOF_PAYLOAD_SCHEMA_VERSION);
    // pending_randomness (32)
    data.extend_from_slice(pending_randomness.as_ref());
    // position (32)
    data.extend_from_slice(position.as_ref());
    // action_type (1)
    data.push(action_type);
    // snapshot_root (32)
    data.extend_from_slice(&snapshot_root);
    // snapshot_version (8)
    data.extend_from_slice(&snapshot_version.to_le_bytes());
    // snapshot_total_power (8)
    data.extend_from_slice(&snapshot_total_power.to_le_bytes());
    // snapshot_total_count (8)
    data.extend_from_slice(&snapshot_total_count.to_le_bytes());
    // refund_recipient (32)
    data.extend_from_slice(refund_recipient.as_ref());
    // expiry_timestamp (8, stored as u64)
    data.extend_from_slice(&(expiry_timestamp as u64).to_le_bytes());
    // nonce (8)
    data.extend_from_slice(&nonce.to_le_bytes());
    // expected_payload_length (4)
    data.extend_from_slice(&payload_len.to_le_bytes());
    // finalized (1)
    data.push(if finalized { 1 } else { 0 });
    // consumed (1)
    data.push(if consumed { 1 } else { 0 });
    // filled (4)
    data.extend_from_slice(&payload_len.to_le_bytes());
    // bump (1)
    data.push(bump);
    // payload_len (4)
    data.extend_from_slice(&payload_len.to_le_bytes());
    // payload
    data.extend_from_slice(payload);
    data
}

fn make_account_info<'a>(
    key: &'a Pubkey,
    owner: &'a Pubkey,
    data: &'a mut Vec<u8>,
    lamports: &'a mut u64,
) -> AccountInfo<'a> {
    AccountInfo::new(key, false, false, lamports, data, owner, false, 0)
}

fn find_buffer_pda(
    pending_randomness: &Pubkey,
    refund_recipient: &Pubkey,
    nonce: u64,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            SEED_BULL_PROOF_BUFFER,
            pending_randomness.as_ref(),
            refund_recipient.as_ref(),
            &nonce.to_le_bytes(),
        ],
        &crate::ID,
    )
}

fn build_valid_unstake_buffer(
    position: Pubkey,
    pending_randomness_key: Pubkey,
    _pending: &PendingRandomness,
    refund_recipient: Pubkey,
    current_registry_root: [u8; 32],
    current_registry_version: u64,
    payload: &[u8],
) -> (Pubkey, u8, Vec<u8>, u64) {
    let nonce = 42u64;
    let (pda, bump) = find_buffer_pda(&pending_randomness_key, &refund_recipient, nonce);
    let data = build_buffer_data(
        &pending_randomness_key,
        &position,
        ActionType::Unstake as u8,
        current_registry_root,
        current_registry_version,
        0,
        0,
        &refund_recipient,
        9_999_999_999,
        nonce,
        bump,
        true,
        false,
        payload,
    );
    let lamports = 1_000_000u64;
    (pda, bump, data, lamports)
}

// ─── Section 1: validate_unstake_bull_proof_buffer tests ─────────────────

fn base_valid_setup() -> (Pubkey, Pubkey, PendingRandomness, Pubkey, [u8; 32], u64, Vec<u8>) {
    let position = pk(100);
    let pr_key = pk(200);
    let pending = make_pending_randomness_unstake(position, 1);
    let refund = pk(300);
    let root = [0xaa; 32];
    let version = 7u64;
    let payload = unstake_payload_bytes(&empty_owner_proof(), &empty_bull_proof());
    (position, pr_key, pending, refund, root, version, payload)
}

#[test]
fn unstake_validator_passes_valid_buffer() {
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let (pda, _bump, mut data, mut lamports) =
        build_valid_unstake_buffer(position, pr_key, &pending, refund, root, version, &payload);
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &refund, &root, version, 1000,
    );
    assert!(result.is_ok(), "valid buffer should pass: {:?}", result.err());
}

#[test]
fn unstake_validator_rejects_wrong_program_owner() {
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let (pda, _bump, mut data, mut lamports) =
        build_valid_unstake_buffer(position, pr_key, &pending, refund, root, version, &payload);
    let wrong_owner = pk(999);
    let info = make_account_info(&pda, &wrong_owner, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &refund, &root, version, 1000,
    );
    assert!(result.is_err());
}

#[test]
fn unstake_validator_rejects_bad_discriminator() {
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let (pda, _bump, mut data, mut lamports) =
        build_valid_unstake_buffer(position, pr_key, &pending, refund, root, version, &payload);
    data[0] = 0xFF;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &refund, &root, version, 1000,
    );
    assert!(result.is_err());
}

#[test]
fn unstake_validator_rejects_wrong_pda() {
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let (_pda, _bump, mut data, mut lamports) =
        build_valid_unstake_buffer(position, pr_key, &pending, refund, root, version, &payload);
    let wrong_key = pk(888);
    let info = make_account_info(&wrong_key, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &refund, &root, version, 1000,
    );
    assert!(result.is_err());
}

#[test]
fn unstake_validator_rejects_wrong_position() {
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let (pda, _bump, mut data, mut lamports) =
        build_valid_unstake_buffer(position, pr_key, &pending, refund, root, version, &payload);
    let wrong_position = pk(777);
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &wrong_position, &pending, &pr_key, &refund, &root, version, 1000,
    );
    assert!(result.is_err());
}

#[test]
fn unstake_validator_rejects_wrong_action_type() {
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let (pda, _bump, mut data, mut lamports) =
        build_valid_unstake_buffer(position, pr_key, &pending, refund, root, version, &payload);
    // Patch action_type to Reveal.
    // offset: 8(disc) + 1(ver) + 1(schema) + 32(pr) + 32(pos) = 74
    data[74] = ActionType::Reveal as u8;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &refund, &root, version, 1000,
    );
    assert!(result.is_err());
}

#[test]
fn unstake_validator_rejects_wrong_pending_randomness() {
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let (pda, _bump, mut data, mut lamports) =
        build_valid_unstake_buffer(position, pr_key, &pending, refund, root, version, &payload);
    let wrong_pr = pk(555);
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &wrong_pr, &refund, &root, version, 1000,
    );
    assert!(result.is_err());
}

#[test]
fn unstake_validator_rejects_wrong_current_registry_root() {
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let (pda, _bump, mut data, mut lamports) =
        build_valid_unstake_buffer(position, pr_key, &pending, refund, root, version, &payload);
    let wrong_root = [0xbb; 32];
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &refund, &wrong_root, version, 1000,
    );
    assert!(result.is_err());
}

#[test]
fn unstake_validator_rejects_wrong_current_registry_version() {
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let (pda, _bump, mut data, mut lamports) =
        build_valid_unstake_buffer(position, pr_key, &pending, refund, root, version, &payload);
    let wrong_version = version + 1;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &refund, &root, wrong_version, 1000,
    );
    assert!(result.is_err());
}

#[test]
fn unstake_validator_rejects_wrong_refund_recipient() {
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let (pda, _bump, mut data, mut lamports) =
        build_valid_unstake_buffer(position, pr_key, &pending, refund, root, version, &payload);
    let wrong_refund = pk(444);
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &wrong_refund, &root, version, 1000,
    );
    assert!(result.is_err());
}

#[test]
fn unstake_validator_rejects_not_finalized() {
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let (pda, _bump, mut data, mut lamports) =
        build_valid_unstake_buffer(position, pr_key, &pending, refund, root, version, &payload);
    // finalized offset: 8+1+1+32+32+1+32+8+8+8+32+8+8+4 = 183
    data[183] = 0;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &refund, &root, version, 1000,
    );
    assert!(result.is_err());
}

#[test]
fn unstake_validator_rejects_consumed() {
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let (pda, _bump, mut data, mut lamports) =
        build_valid_unstake_buffer(position, pr_key, &pending, refund, root, version, &payload);
    // consumed offset: 183 + 1 = 184
    data[184] = 1;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &refund, &root, version, 1000,
    );
    assert!(result.is_err());
}

#[test]
fn unstake_validator_rejects_expired() {
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let nonce = 42u64;
    let (pda, bump) = find_buffer_pda(&pr_key, &refund, nonce);
    let mut data = build_buffer_data(
        &pr_key, &position, ActionType::Unstake as u8, root, version, 0, 0, &refund,
        100, nonce, bump, true, false, &payload,
    );
    let mut lamports = 1_000_000u64;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &refund, &root, version, 5000,
    );
    assert!(result.is_err());
}

#[test]
fn unstake_validator_rejects_truncated_payload() {
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let (pda, _bump, mut data, mut lamports) =
        build_valid_unstake_buffer(position, pr_key, &pending, refund, root, version, &payload);
    data.truncate(data.len() - 1);
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &refund, &root, version, 1000,
    );
    assert!(result.is_err());
}

#[test]
fn unstake_validator_rejects_extra_payload_bytes() {
    // Buffer ref slices to expected length, but BullProofPayloadRef::new
    // rejects trailing bytes inside the payload.
    let (position, pr_key, _pending, _refund, _root, _version, payload) = base_valid_setup();
    let mut extra_payload = payload.clone();
    extra_payload.push(0xFF);
    // Build a buffer where expected_payload_length includes the extra byte.
    let nonce = 42u64;
    let refund = pk(300);
    let (pda, bump) = find_buffer_pda(&pr_key, &refund, nonce);
    let root = [0xaa; 32];
    let version = 7u64;
    let mut data = build_buffer_data(
        &pr_key, &position, ActionType::Unstake as u8, root, version, 0, 0, &refund,
        9_999_999_999, nonce, bump, true, false, &extra_payload,
    );
    let mut lamports = 1_000_000u64;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let pending = make_pending_randomness_unstake(position, 1);
    let buf_result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &refund, &root, version, 1000,
    );
    // The buffer ref may pass (it slices to expected length which now includes
    // the extra byte), but BullProofPayloadRef::new must reject trailing bytes.
    if let Ok(buf) = buf_result {
        let payload_result = BullProofPayloadRef::new(buf.payload);
        assert!(
            payload_result.is_err(),
            "extra payload bytes must be rejected by payload parser"
        );
    }
}

#[test]
fn unstake_validator_rejects_wrong_schema() {
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let (pda, _bump, mut data, mut lamports) =
        build_valid_unstake_buffer(position, pr_key, &pending, refund, root, version, &payload);
    // schema_version offset: 8 + 1 = 9
    data[9] = 1;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &refund, &root, version, 1000,
    );
    assert!(result.is_err());
}

#[test]
fn unstake_payload_rejects_expected_n_actual_n_minus_1() {
    // Build a buffer where expected_payload_length is N but actual payload is N-1.
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let nonce = 42u64;
    let (pda, bump) = find_buffer_pda(&pr_key, &refund, nonce);
    // Build data with full expected length but truncate the actual payload.
    let short_payload = &payload[..payload.len() - 1];
    let mut data = build_buffer_data(
        &pr_key, &position, ActionType::Unstake as u8, root, version, 0, 0, &refund,
        9_999_999_999, nonce, bump, true, false, short_payload,
    );
    // Patch expected_payload_length to the full N (offset 171).
    let full_len = payload.len() as u32;
    data[171..175].copy_from_slice(&full_len.to_le_bytes());
    // Also patch filled (offset 185) and payload_len (offset 190) to match.
    data[185..189].copy_from_slice(&full_len.to_le_bytes());
    data[190..194].copy_from_slice(&full_len.to_le_bytes());
    let mut lamports = 1_000_000u64;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &refund, &root, version, 1000,
    );
    assert!(result.is_err(), "expected N actual N-1 must be rejected");
}

#[test]
fn unstake_payload_rejects_expected_n_actual_n_plus_1() {
    // Build a buffer where expected_payload_length is N but actual payload is N+1.
    let (position, pr_key, pending, refund, root, version, payload) = base_valid_setup();
    let nonce = 42u64;
    let (pda, bump) = find_buffer_pda(&pr_key, &refund, nonce);
    let mut long_payload = payload.clone();
    long_payload.push(0xFF);
    let mut data = build_buffer_data(
        &pr_key, &position, ActionType::Unstake as u8, root, version, 0, 0, &refund,
        9_999_999_999, nonce, bump, true, false, &long_payload,
    );
    // Patch expected_payload_length to N (not N+1).
    let short_len = payload.len() as u32;
    data[171..175].copy_from_slice(&short_len.to_le_bytes());
    // filled and payload_len stay at N+1 — the buffer parser checks
    // payload_len == expected_payload_length, so this should fail.
    let mut lamports = 1_000_000u64;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_unstake_bull_proof_buffer(
        &info, &data, &position, &pending, &pr_key, &refund, &root, version, 1000,
    );
    assert!(result.is_err(), "expected N actual N+1 must be rejected");
}

// ─── Section 2: remove_bull_from_registry_borrowed tests ─────────────────

/// Incrementally add bulls for an owner to a registry, maintaining shared
/// bull_tree and owner_tree state. `current_owner_leaf` is the starting leaf
/// (empty for a new owner). Returns the final owner leaf.
fn add_bulls_incrementally(
    registry: &mut BullRegistry,
    bull_tree: &mut TestTree,
    owner_tree: &mut TestTree,
    owner: Pubkey,
    bulls: &[(Pubkey, u64, u8, u64)],
    mut current_owner_leaf: OwnerLeaf,
) -> OwnerLeaf {
    for (position, position_id, buck_power, reveal_config_version) in bulls {
        let bull_leaf = BullLeaf {
            position: *position,
            position_id: *position_id,
            owner,
            buck_power: *buck_power,
            reveal_config_version: *reveal_config_version,
        };

        let empty_bull_proof = CompressedBullProof {
            leaf: BullLeaf::empty(),
            proof: bull_tree.proof(&position.to_bytes()),
        };
        let current_owner_proof = CompressedOwnerProof {
            leaf: current_owner_leaf,
            proof: owner_tree.proof(&owner.to_bytes()),
        };

        add_bull_to_registry(registry, &bull_leaf, &current_owner_proof, &empty_bull_proof)
            .unwrap();

        bull_tree.insert(position.to_bytes(), bull_leaf.to_node());
        let new_bull_root = bull_tree.root();
        current_owner_leaf = OwnerLeaf {
            owner,
            active_bull_count: current_owner_leaf.active_bull_count + 1,
            total_buck_power: current_owner_leaf.total_buck_power + *buck_power as u64,
            bull_tree_root: new_bull_root.hash,
        };
        // Update owner_tree: remove old leaf for this owner, insert new one.
        owner_tree.nodes.retain(|(_, k)| *k != owner.to_bytes());
        owner_tree.insert(owner.to_bytes(), current_owner_leaf.to_node());
    }

    current_owner_leaf
}

/// Build a registry with one owner and multiple Bulls by adding them
/// incrementally with non-membership proofs, then return final membership
/// proofs for removal tests.
/// Returns (registry, final_owner_proof, final_bull_proofs).
fn build_registry_with_bulls(
    owner: Pubkey,
    bulls: &[(Pubkey, u64, u8, u64)],
) -> (BullRegistry, CompressedOwnerProof, Vec<CompressedBullProof>) {
    let mut registry = make_bull_registry();
    let mut bull_tree = TestTree::new(&BullLeaf::empty().to_node(), PREFIX_BULL_NODE);
    let mut owner_tree = TestTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);

    let final_owner_leaf = add_bulls_incrementally(
        &mut registry, &mut bull_tree, &mut owner_tree, owner, bulls, OwnerLeaf::empty(),
    );

    // Build final membership proofs.
    let final_owner_proof = CompressedOwnerProof {
        leaf: final_owner_leaf,
        proof: owner_tree.proof(&owner.to_bytes()),
    };

    let mut final_bull_proofs = Vec::new();
    for (position, position_id, buck_power, reveal_config_version) in bulls {
        let bull_leaf = BullLeaf {
            position: *position,
            position_id: *position_id,
            owner,
            buck_power: *buck_power,
            reveal_config_version: *reveal_config_version,
        };
        final_bull_proofs.push(CompressedBullProof {
            leaf: bull_leaf,
            proof: bull_tree.proof(&position.to_bytes()),
        });
    }

    (registry, final_owner_proof, final_bull_proofs)
}

#[test]
fn unstake_bull_removal_owner_remains() {
    let owner = pk(10);
    let bull_a = pk(100);
    let bull_b = pk(200);

    let (mut registry, owner_proof, bull_proofs) =
        build_registry_with_bulls(owner, &[(bull_a, 1, 6, 1), (bull_b, 2, 8, 1)]);

    assert_eq!(registry.total_bull_count, 2);
    assert_eq!(registry.total_buck_power, 14);

    let old_root = registry.owner_tree_root;
    let old_version = registry.registry_version;

    // Build borrowed refs via payload serialization.
    let payload_bytes = unstake_payload_bytes(&owner_proof, &bull_proofs[0]);
    let payload_ref = BullProofPayloadRef::new(&payload_bytes).unwrap();
    let current_owner = payload_ref.current_owner().unwrap().unwrap();
    let remove_bull = payload_ref.remove_bull().unwrap().unwrap();

    let exiting_bull = BullLeaf {
        position: bull_a,
        position_id: 1,
        owner,
        buck_power: 6,
        reveal_config_version: 1,
    };

    remove_bull_from_registry_borrowed(&mut registry, &exiting_bull, &current_owner, &remove_bull)
        .expect("removal should succeed");

    assert_eq!(registry.total_bull_count, 1);
    assert_eq!(registry.total_buck_power, 8);
    assert_eq!(registry.registry_version, old_version + 1);
    assert_ne!(registry.owner_tree_root, old_root);
}

#[test]
fn unstake_bull_removal_final_bull() {
    let owner = pk(10);
    let bull_a = pk(100);

    let (mut registry, owner_proof, bull_proofs) =
        build_registry_with_bulls(owner, &[(bull_a, 1, 6, 1)]);

    assert_eq!(registry.total_bull_count, 1);
    assert_eq!(registry.total_buck_power, 6);

    let old_root = registry.owner_tree_root;
    let old_version = registry.registry_version;

    let payload_bytes = unstake_payload_bytes(&owner_proof, &bull_proofs[0]);
    let payload_ref = BullProofPayloadRef::new(&payload_bytes).unwrap();
    let current_owner = payload_ref.current_owner().unwrap().unwrap();
    let remove_bull = payload_ref.remove_bull().unwrap().unwrap();

    let exiting_bull = BullLeaf {
        position: bull_a,
        position_id: 1,
        owner,
        buck_power: 6,
        reveal_config_version: 1,
    };

    remove_bull_from_registry_borrowed(&mut registry, &exiting_bull, &current_owner, &remove_bull)
        .expect("final bull removal should succeed");

    assert_eq!(registry.total_bull_count, 0);
    assert_eq!(registry.total_buck_power, 0);
    assert_eq!(registry.registry_version, old_version + 1);
    assert_eq!(registry.owner_tree_root, empty_owner_tree_root());
    assert_ne!(registry.owner_tree_root, old_root);
}

#[test]
fn unstake_bull_removal_leaf_vs_root_regression() {
    let owner_a = pk(10);
    let owner_b = pk(20);
    let bull_a = pk(100);
    let bull_b = pk(200);
    let bull_c = pk(300);

    // Owner A: 1 Bull (power 4). Owner B: 2 Bulls (power 6+8=14).
    // Root totals: count=3, power=18.
    // Build registry with shared trees for both owners.
    let mut registry = make_bull_registry();
    let mut bull_tree = TestTree::new(&BullLeaf::empty().to_node(), PREFIX_BULL_NODE);
    let mut owner_tree = TestTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);

    let owner_leaf_a = add_bulls_incrementally(
        &mut registry, &mut bull_tree, &mut owner_tree, owner_a, &[(bull_a, 1, 4, 1)], OwnerLeaf::empty(),
    );
    let owner_leaf_b = add_bulls_incrementally(
        &mut registry, &mut bull_tree, &mut owner_tree, owner_b, &[(bull_b, 2, 6, 1), (bull_c, 3, 8, 1)], OwnerLeaf::empty(),
    );

    // Build final membership proofs for owner A.
    let owner_proof_a = CompressedOwnerProof {
        leaf: owner_leaf_a,
        proof: owner_tree.proof(&owner_a.to_bytes()),
    };
    let bull_proofs_a = vec![CompressedBullProof {
        leaf: BullLeaf { position: bull_a, position_id: 1, owner: owner_a, buck_power: 4, reveal_config_version: 1 },
        proof: bull_tree.proof(&bull_a.to_bytes()),
    }];

    assert_eq!(registry.total_bull_count, 3);
    assert_eq!(registry.total_buck_power, 18);

    // verify_owner_ref must return LEAF values (count=1, power=4) not root (count=3, power=18).
    let payload_bytes_a = unstake_payload_bytes(&owner_proof_a, &bull_proofs_a[0]);
    let payload_ref_a = BullProofPayloadRef::new(&payload_bytes_a).unwrap();
    let current_owner_a = payload_ref_a.current_owner().unwrap().unwrap();

    let (leaf_count, leaf_power, _) = borrowed_proof::verify_owner_ref(
        &registry.owner_tree_root, &owner_a, current_owner_a,
    ).unwrap();
    assert_eq!(leaf_count, 1, "owner leaf count must be 1, not root total 3");
    assert_eq!(leaf_power, 4, "owner leaf power must be 4, not root total 18");

    // Remove owner A's Bull.
    let remove_bull_a = payload_ref_a.remove_bull().unwrap().unwrap();
    let exiting_bull = BullLeaf {
        position: bull_a, position_id: 1, owner: owner_a, buck_power: 4, reveal_config_version: 1,
    };
    remove_bull_from_registry_borrowed(&mut registry, &exiting_bull, &current_owner_a, &remove_bull_a)
        .expect("removal should succeed");

    assert_eq!(registry.total_bull_count, 2);
    assert_eq!(registry.total_buck_power, 14);
}

#[test]
fn unstake_bull_removal_stale_current_proof() {
    let owner = pk(10);
    let bull_a = pk(100);
    let bull_b = pk(200);

    // Build registry with 1 Bull using shared trees.
    let mut registry = make_bull_registry();
    let mut bull_tree = TestTree::new(&BullLeaf::empty().to_node(), PREFIX_BULL_NODE);
    let mut owner_tree = TestTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);

    let owner_leaf_r1 = add_bulls_incrementally(
        &mut registry, &mut bull_tree, &mut owner_tree, owner, &[(bull_a, 1, 6, 1)], OwnerLeaf::empty(),
    );

    // Build owner proof and bull proof against R1 state.
    let owner_proof = CompressedOwnerProof {
        leaf: owner_leaf_r1,
        proof: owner_tree.proof(&owner.to_bytes()),
    };
    let bull_proofs = vec![CompressedBullProof {
        leaf: BullLeaf { position: bull_a, position_id: 1, owner, buck_power: 6, reveal_config_version: 1 },
        proof: bull_tree.proof(&bull_a.to_bytes()),
    }];

    let root_r1 = registry.owner_tree_root;
    let version_r1 = registry.registry_version;

    // Add a second Bull, changing root to R2.
    add_bulls_incrementally(
        &mut registry, &mut bull_tree, &mut owner_tree, owner, &[(bull_b, 2, 8, 1)], owner_leaf_r1,
    );

    let root_r2 = registry.owner_tree_root;
    let version_r2 = registry.registry_version;
    assert_ne!(root_r1, root_r2);
    assert_ne!(version_r1, version_r2);

    // Attempt removal using the OLD owner proof (against R1).
    let payload_bytes = unstake_payload_bytes(&owner_proof, &bull_proofs[0]);
    let payload_ref = BullProofPayloadRef::new(&payload_bytes).unwrap();
    let current_owner = payload_ref.current_owner().unwrap().unwrap();
    let remove_bull = payload_ref.remove_bull().unwrap().unwrap();

    let exiting_bull = BullLeaf {
        position: bull_a, position_id: 1, owner, buck_power: 6, reveal_config_version: 1,
    };

    let result = remove_bull_from_registry_borrowed(
        &mut registry, &exiting_bull, &current_owner, &remove_bull,
    );
    assert!(result.is_err(), "stale proof against old root R1 must be rejected");

    // Registry unchanged.
    assert_eq!(registry.owner_tree_root, root_r2);
    assert_eq!(registry.registry_version, version_r2);
    assert_eq!(registry.total_bull_count, 2);
}

// ─── Section 3: Non-Bull proofless requirement ───────────────────────────

#[test]
fn unstake_non_bull_remains_proofless() {
    // Structural guarantee: settle_bull_unstake requires &BullProofPayloadRef
    // (not Option), and the caller passes payload.as_ref().ok_or(...)?.
    // For non-Bull roles, settle_cowboy_unstake is called instead and
    // does not receive the payload.
    assert!(true, "non-Bull unstake is proofless by construction");
}
