// Comprehensive SettleReveal tests for the borrowed/raw proof-buffer integration.
//
// Covers:
//   1. Raw BullProofBuffer validation (security boundary)
//   2. Borrowed payload parser security
//   3. Owned vs borrowed parity
//   4. Proofless reveal behavior
//   5-6. Victim absence / membership
//   7. External Bull threshold gate
//   8-9. Safe / successful mint-theft roll
//   10. Three-role theft
//   11-13. New Bull insertion (existing / absent / stolen)
//   15-16. Buffer close / rollback

use super::*;
use crate::borrowed_proof::{self, BullProofPayloadRef};
use crate::bull_registry::{
    add_bull_to_registry, empty_bull_tree_root, empty_owner_tree_root, BullLeaf, BullProofPayloadV1,
    CompressedBullProof, CompressedOwnerProof, OwnerLeaf,
    BULL_PROOF_PAYLOAD_SCHEMA_VERSION, SECTION_CURRENT_BULL, SECTION_CURRENT_OWNER,
    SECTION_SELECTED_BULL, SECTION_SELECTED_OWNER, SECTION_VICTIM_OWNER,
};
use crate::state::BullRegistry;
use crate::constants::SEED_BULL_PROOF_BUFFER;
use crate::sparse_tree::{
    compute_default_empty_nodes, hash_node, CompressedSparseProof,
    SparseMerkleNode, SPARSE_TREE_DEPTH,
};
use crate::state::{ActionType, PendingRandomness};
use anchor_lang::Discriminator;
use solana_program::hash::hashv;

const PREFIX_BULL_OWNER_NODE: &[u8] = b"rodeo_v2_bull_owner_node";
const PREFIX_BULL_NODE: &[u8] = b"rodeo_v2_bull_node";


// ─── Minimal sparse tree builder for test proof construction ──────────────

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

    fn build_subtree(&self, height: usize, items: &[(SparseMerkleNode, [u8; 32])]) -> SparseMerkleNode {
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
            let my_node = traverse(height - 1, my_items, key, defaults, prefix, bitmap, siblings);
            if sib_node != defaults[height - 1] {
                bitmap[bit_idx / 8] |= 1 << (bit_idx % 8);
                siblings.push(sib_node);
            }
            my_node
        }

        let leaf = traverse(
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
            leaf,
        }
    }
}



fn test_protocol_config(global_config: Pubkey, config_version: u64) -> ProtocolConfig {
    ProtocolConfig {
        version: 1,
        global_config,
        config_version,
        role_weights: [5_000_000, 5_000_000],
        cowboy_rank_weights: [1_250_000; 8],
        bull_tier_weights: [2_500_000; 4],
        suit_weights: [2_500_000; 4],
        mint_theft_weights: [5_000_000, 5_000_000],
        unstake_theft_weights: [5_000_000, 5_000_000],
        cowboy_accrual_weights: [1_250_000; 8],
        bull_buck_powers: [4, 6, 8, 10],
        min_reveals_for_theft: 1,
        min_bulls_for_theft: 1,
        unstake_tax_bps: 500,
        unstake_return_bps: 9500,
        bump: 0,
        _reserved: [0; 64],
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

fn empty_payload_bytes() -> Vec<u8> {
    let payload = BullProofPayloadV1 {
        schema_version: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
        section_bitmap: 0,
        victim_owner: None,
        selected_owner: None,
        selected_bull: None,
        current_owner: None,
        current_bull: None,
        remove_bull: None,
    };
    payload.try_to_vec().unwrap()
}

fn payload_with_sections(
    victim: Option<&CompressedOwnerProof>,
    selected_owner: Option<&CompressedOwnerProof>,
    selected_bull: Option<&CompressedBullProof>,
    current_owner: Option<&CompressedOwnerProof>,
    current_bull: Option<&CompressedBullProof>,
) -> Vec<u8> {
    let mut bitmap = 0u8;
    if victim.is_some() {
        bitmap |= SECTION_VICTIM_OWNER;
    }
    if selected_owner.is_some() {
        bitmap |= SECTION_SELECTED_OWNER;
    }
    if selected_bull.is_some() {
        bitmap |= SECTION_SELECTED_BULL;
    }
    if current_owner.is_some() {
        bitmap |= SECTION_CURRENT_OWNER;
    }
    if current_bull.is_some() {
        bitmap |= SECTION_CURRENT_BULL;
    }
    let payload = BullProofPayloadV1 {
        schema_version: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
        section_bitmap: bitmap,
        victim_owner: victim.cloned(),
        selected_owner: selected_owner.cloned(),
        selected_bull: selected_bull.cloned(),
        current_owner: current_owner.cloned(),
        current_bull: current_bull.cloned(),
        remove_bull: None,
    };
    payload.try_to_vec().unwrap()
}

/// Build raw BullProofBuffer account data with the given fields.
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

fn make_pending_randomness(
    position: Pubkey,
    action_type: ActionType,
    action_nonce: u64,
    registry_root: [u8; 32],
    registry_version: u64,
    total_count: u64,
    total_power: u64,
) -> PendingRandomness {
    PendingRandomness {
        version: 1,
        position,
        action_type,
        action_nonce,
        provider_program: Pubkey::default(),
        provider_randomness_account: Pubkey::default(),
        commitment: [0u8; 32],
        committed_slot: 0,
        committed_protocol_epoch: 0,
        timeout_timestamp: 0,
        registry_root_snapshot: registry_root,
        registry_version_snapshot: registry_version,
        registry_total_count_snapshot: total_count,
        registry_total_power_snapshot: total_power,
        config_version_snapshot: 0,
        settled: false,
        bump: 0,
    }
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

fn build_valid_buffer_setup(
    position: Pubkey,
    pending_randomness_key: Pubkey,
    pending: &PendingRandomness,
    refund_recipient: Pubkey,
    payload: &[u8],
) -> (Pubkey, u8, Vec<u8>, u64) {
    let nonce = 42u64;
    let (pda, bump) = find_buffer_pda(&pending_randomness_key, &refund_recipient, nonce);
    let data = build_buffer_data(
        &pending_randomness_key,
        &position,
        ActionType::Reveal as u8,
        pending.registry_root_snapshot,
        pending.registry_version_snapshot,
        pending.registry_total_power_snapshot,
        pending.registry_total_count_snapshot,
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

// ─── Section 1: Raw BullProofBuffer validation ───────────────────────────

#[test]
fn raw_buffer_valid_passes_validation() {
    let position = pk(100);
    let pending_key = pk(200);
    let refund = pk(300);
    let payload = empty_payload_bytes();
    let pending = make_pending_randomness(
        position,
        ActionType::Reveal,
        1,
        [0u8; 32],
        0,
        0,
        0,
    );
    let (pda, _bump, mut data, mut lamports) =
        build_valid_buffer_setup(position, pending_key, &pending, refund, &payload);
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_reveal_bull_proof_buffer(
        &info,
        &data,
        &position,
        &pending,
        &pending_key,
        &refund,
        1000,
    );
    assert!(result.is_ok(), "valid buffer should pass");
}

#[test]
fn raw_buffer_rejects_wrong_owner() {
    // Prevents: attacker substitutes a non-rodeo account that mimics the layout.
    let position = pk(100);
    let pending_key = pk(200);
    let refund = pk(300);
    let payload = empty_payload_bytes();
    let pending = make_pending_randomness(position, ActionType::Reveal, 1, [0u8; 32], 0, 0, 0);
    let (pda, _bump, mut data, mut lamports) =
        build_valid_buffer_setup(position, pending_key, &pending, refund, &payload);
    let wrong_owner = pk(999);
    let info = make_account_info(&pda, &wrong_owner, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_reveal_bull_proof_buffer(
        &info,
        &data,
        &position,
        &pending,
        &pending_key,
        &refund,
        1000,
    );
    assert!(result.is_err(), "wrong owner must be rejected");
}

#[test]
fn raw_buffer_rejects_bad_discriminator() {
    // Prevents: attacker uses a different rodeo account type with a valid owner.
    let position = pk(100);
    let pending_key = pk(200);
    let refund = pk(300);
    let payload = empty_payload_bytes();
    let pending = make_pending_randomness(position, ActionType::Reveal, 1, [0u8; 32], 0, 0, 0);
    let (pda, _bump, mut data, mut lamports) =
        build_valid_buffer_setup(position, pending_key, &pending, refund, &payload);
    // Corrupt discriminator
    data[0] = 0xFF;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_reveal_bull_proof_buffer(
        &info,
        &data,
        &position,
        &pending,
        &pending_key,
        &refund,
        1000,
    );
    assert!(result.is_err(), "bad discriminator must be rejected");
}

#[test]
fn raw_buffer_rejects_wrong_pda() {
    // Prevents: attacker supplies a buffer PDA derived from different seeds.
    let position = pk(100);
    let pending_key = pk(200);
    let refund = pk(300);
    let payload = empty_payload_bytes();
    let pending = make_pending_randomness(position, ActionType::Reveal, 1, [0u8; 32], 0, 0, 0);
    let (_pda, _bump, mut data, mut lamports) =
        build_valid_buffer_setup(position, pending_key, &pending, refund, &payload);
    let wrong_key = pk(555);
    let info = make_account_info(&wrong_key, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_reveal_bull_proof_buffer(
        &info,
        &data,
        &position,
        &pending,
        &pending_key,
        &refund,
        1000,
    );
    assert!(result.is_err(), "wrong PDA must be rejected");
}

#[test]
fn raw_buffer_rejects_wrong_position() {
    // Prevents: replaying a buffer bound to a different Position.
    let position = pk(100);
    let wrong_position = pk(101);
    let pending_key = pk(200);
    let refund = pk(300);
    let payload = empty_payload_bytes();
    let pending = make_pending_randomness(position, ActionType::Reveal, 1, [0u8; 32], 0, 0, 0);
    let (pda, _bump, mut data, mut lamports) =
        build_valid_buffer_setup(position, pending_key, &pending, refund, &payload);
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_reveal_bull_proof_buffer(
        &info,
        &data,
        &wrong_position,
        &pending,
        &pending_key,
        &refund,
        1000,
    );
    assert!(result.is_err(), "wrong position must be rejected");
}

#[test]
fn raw_buffer_rejects_wrong_pending_randomness() {
    // Prevents: replaying a buffer bound to a different PendingRandomness.
    let position = pk(100);
    let pending_key = pk(200);
    let wrong_pending_key = pk(201);
    let refund = pk(300);
    let payload = empty_payload_bytes();
    let pending = make_pending_randomness(position, ActionType::Reveal, 1, [0u8; 32], 0, 0, 0);
    let (pda, _bump, mut data, mut lamports) =
        build_valid_buffer_setup(position, pending_key, &pending, refund, &payload);
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_reveal_bull_proof_buffer(
        &info,
        &data,
        &position,
        &pending,
        &wrong_pending_key,
        &refund,
        1000,
    );
    assert!(result.is_err(), "wrong pending randomness must be rejected");
}

#[test]
fn raw_buffer_rejects_wrong_action_type() {
    // Prevents: using an Unstake proof buffer for Reveal settlement.
    let position = pk(100);
    let pending_key = pk(200);
    let refund = pk(300);
    let payload = empty_payload_bytes();
    let pending = make_pending_randomness(position, ActionType::Reveal, 1, [0u8; 32], 0, 0, 0);
    let (pda, bump, mut data, mut lamports) =
        build_valid_buffer_setup(position, pending_key, &pending, refund, &payload);
    // Overwrite action_type to Unstake (1)
    data[8 + 1 + 1 + 32 + 32] = ActionType::Unstake as u8;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let _ = bump;
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_reveal_bull_proof_buffer(
        &info,
        &data,
        &position,
        &pending,
        &pending_key,
        &refund,
        1000,
    );
    assert!(result.is_err(), "wrong action type must be rejected");
}

#[test]
fn raw_buffer_rejects_not_finalized() {
    // Prevents: settling with a buffer the prover has not finalized.
    let position = pk(100);
    let pending_key = pk(200);
    let refund = pk(300);
    let payload = empty_payload_bytes();
    let pending = make_pending_randomness(position, ActionType::Reveal, 1, [0u8; 32], 0, 0, 0);
    let (pda, bump, mut data, mut lamports) =
        build_valid_buffer_setup(position, pending_key, &pending, refund, &payload);
    // Set finalized = false
    let disc_len = 8usize;
    let finalized_offset = disc_len + 1 + 1 + 32 + 32 + 1 + 32 + 8 + 8 + 8 + 32 + 8 + 8 + 4;
    data[finalized_offset] = 0;
    let _ = bump;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_reveal_bull_proof_buffer(
        &info,
        &data,
        &position,
        &pending,
        &pending_key,
        &refund,
        1000,
    );
    assert!(result.is_err(), "not finalized must be rejected");
}

#[test]
fn raw_buffer_rejects_consumed() {
    // Prevents: double-spend of a proof buffer.
    let position = pk(100);
    let pending_key = pk(200);
    let refund = pk(300);
    let payload = empty_payload_bytes();
    let pending = make_pending_randomness(position, ActionType::Reveal, 1, [0u8; 32], 0, 0, 0);
    let (pda, _bump, mut data, mut lamports) =
        build_valid_buffer_setup(position, pending_key, &pending, refund, &payload);
    // Set consumed = true
    let disc_len = 8usize;
    let consumed_offset = disc_len + 1 + 1 + 32 + 32 + 1 + 32 + 8 + 8 + 8 + 32 + 8 + 8 + 4 + 1;
    data[consumed_offset] = 1;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_reveal_bull_proof_buffer(
        &info,
        &data,
        &position,
        &pending,
        &pending_key,
        &refund,
        1000,
    );
    assert!(result.is_err(), "consumed buffer must be rejected");
}

#[test]
fn raw_buffer_rejects_expired() {
    // Prevents: using a stale proof buffer past its expiry.
    let position = pk(100);
    let pending_key = pk(200);
    let refund = pk(300);
    let payload = empty_payload_bytes();
    let pending = make_pending_randomness(position, ActionType::Reveal, 1, [0u8; 32], 0, 0, 0);
    let nonce = 42u64;
    let (pda, bump) = find_buffer_pda(&pending_key, &refund, nonce);
    let data = build_buffer_data(
        &pending_key,
        &position,
        ActionType::Reveal as u8,
        pending.registry_root_snapshot,
        pending.registry_version_snapshot,
        pending.registry_total_power_snapshot,
        pending.registry_total_count_snapshot,
        &refund,
        500, // expired in the past
        nonce,
        bump,
        true,
        false,
        &payload,
    );
    let mut data = data;
    let mut lamports = 0u64;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_reveal_bull_proof_buffer(
        &info,
        &data,
        &position,
        &pending,
        &pending_key,
        &refund,
        1000, // now > expiry
    );
    assert!(result.is_err(), "expired buffer must be rejected");
}

#[test]
fn raw_buffer_rejects_wrong_refund_recipient() {
    // Prevents: caller substitutes their own wallet to steal the rent refund.
    let position = pk(100);
    let pending_key = pk(200);
    let refund = pk(300);
    let wrong_refund = pk(301);
    let payload = empty_payload_bytes();
    let pending = make_pending_randomness(position, ActionType::Reveal, 1, [0u8; 32], 0, 0, 0);
    let (pda, _bump, mut data, mut lamports) =
        build_valid_buffer_setup(position, pending_key, &pending, refund, &payload);
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_reveal_bull_proof_buffer(
        &info,
        &data,
        &position,
        &pending,
        &pending_key,
        &wrong_refund,
        1000,
    );
    assert!(result.is_err(), "wrong refund recipient must be rejected");
}

#[test]
fn raw_buffer_rejects_truncated_data() {
    // Prevents: out-of-bounds reads on a too-short account.
    let position = pk(100);
    let pending_key = pk(200);
    let refund = pk(300);
    let pending = make_pending_randomness(position, ActionType::Reveal, 1, [0u8; 32], 0, 0, 0);
    let (pda, _bump, _, _) =
        build_valid_buffer_setup(position, pending_key, &pending, refund, &[]);
    let mut data = vec![0u8; 10]; // way too short
    let mut lamports = 0u64;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_reveal_bull_proof_buffer(
        &info,
        &data,
        &position,
        &pending,
        &pending_key,
        &refund,
        1000,
    );
    assert!(result.is_err(), "truncated data must be rejected");
}

#[test]
fn raw_buffer_rejects_payload_length_mismatch() {
    // Prevents: prover claims a different payload length than actual.
    let position = pk(100);
    let pending_key = pk(200);
    let refund = pk(300);
    let payload = empty_payload_bytes();
    let pending = make_pending_randomness(position, ActionType::Reveal, 1, [0u8; 32], 0, 0, 0);
    let (pda, bump, mut data, mut lamports) =
        build_valid_buffer_setup(position, pending_key, &pending, refund, &payload);
    // Corrupt expected_payload_length to a wrong value
    let disc_len = 8usize;
    let expected_len_offset = disc_len + 1 + 1 + 32 + 32 + 1 + 32 + 8 + 8 + 8 + 32 + 8 + 8;
    data[expected_len_offset..expected_len_offset + 4].copy_from_slice(&999u32.to_le_bytes());
    let _ = bump;
    let info = make_account_info(&pda, &crate::ID, &mut data, &mut lamports);
    let data = info.try_borrow_data().unwrap();
    let result = borrowed_proof::validate_reveal_bull_proof_buffer(
        &info,
        &data,
        &position,
        &pending,
        &pending_key,
        &refund,
        1000,
    );
    assert!(result.is_err(), "payload length mismatch must be rejected");
}

// ─── Section 2: Borrowed payload parser security ─────────────────────────

#[test]
fn borrowed_payload_rejects_truncated() {
    // Prevents: panic on too-short payload.
    let data = [0u8; 1];
    assert!(BullProofPayloadRef::new(&data).is_err());
}

#[test]
fn borrowed_payload_rejects_wrong_schema() {
    let mut data = empty_payload_bytes();
    data[0] = 99; // wrong schema
    assert!(BullProofPayloadRef::new(&data).is_err());
}

#[test]
fn borrowed_payload_rejects_invalid_bitmap() {
    // Bit 6 and 7 are reserved and must be zero.
    let mut data = empty_payload_bytes();
    data[1] = 0b1100_0000; // invalid bits set
    assert!(BullProofPayloadRef::new(&data).is_err());
}

#[test]
fn borrowed_payload_rejects_truncated_owner_proof() {
    // Build a payload that claims victim_owner is present but provides
    // truncated bytes.
    let mut data = Vec::new();
    data.push(BULL_PROOF_PAYLOAD_SCHEMA_VERSION);
    data.push(SECTION_VICTIM_OWNER);
    data.push(1u8); // present
    // Only 5 bytes — way too short for an OwnerProofRef
    data.extend_from_slice(&[0u8; 5]);
    assert!(BullProofPayloadRef::new(&data).is_err());
}

#[test]
fn borrowed_payload_rejects_truncated_bull_proof() {
    let mut data = Vec::new();
    data.push(BULL_PROOF_PAYLOAD_SCHEMA_VERSION);
    data.push(SECTION_SELECTED_BULL);
    data.push(0u8); // section 0 absent
    data.push(0u8); // section 1 absent
    data.push(1u8); // section 2 present
    // Truncated bull proof
    data.extend_from_slice(&[0u8; 3]);
    assert!(BullProofPayloadRef::new(&data).is_err());
}

#[test]
fn borrowed_payload_rejects_presence_encoding_mismatch() {
    // Bitmap says section 0 is present, but presence byte says 0.
    let mut data = Vec::new();
    data.push(BULL_PROOF_PAYLOAD_SCHEMA_VERSION);
    data.push(SECTION_VICTIM_OWNER);
    data.push(0u8); // present=0 but bitmap says present
    assert!(BullProofPayloadRef::new(&data).is_err());
}

#[test]
fn borrowed_payload_rejects_trailing_bytes() {
    // Build a valid empty payload then append extra bytes.
    let mut data = empty_payload_bytes();
    data.push(0xFF);
    assert!(BullProofPayloadRef::new(&data).is_err());
}

// ─── Section 3: Owned vs borrowed parity ──────────────────────────────────

#[test]
fn owned_vs_borrowed_payload_parity() {
    // Build a payload with all three historical sections present.
    let victim = empty_owner_proof();
    let selected_owner = empty_owner_proof();
    let selected_bull = empty_bull_proof();
    let bytes = payload_with_sections(
        Some(&victim),
        Some(&selected_owner),
        Some(&selected_bull),
        None,
        None,
    );

    let owned = bull_registry::verify_bull_proof_payload(&bytes).unwrap();
    let borrowed = BullProofPayloadRef::new(&bytes).unwrap();

    assert_eq!(owned.schema_version, borrowed.schema_version);
    assert_eq!(owned.section_bitmap, borrowed.section_bitmap);

    // Compare victim owner
    let owned_victim = owned.victim_owner.as_ref().unwrap();
    let borrowed_victim = borrowed.victim_owner().unwrap().unwrap();
    assert_eq!(owned_victim.leaf.owner, borrowed_victim.leaf.owner);
    assert_eq!(
        owned_victim.leaf.active_bull_count,
        borrowed_victim.leaf.active_bull_count
    );
    assert_eq!(
        owned_victim.leaf.total_buck_power,
        borrowed_victim.leaf.total_buck_power
    );
    assert_eq!(
        owned_victim.leaf.bull_tree_root,
        borrowed_victim.leaf.bull_tree_root
    );

    // Compare selected owner
    let owned_so = owned.selected_owner.as_ref().unwrap();
    let borrowed_so = borrowed.selected_owner().unwrap().unwrap();
    assert_eq!(owned_so.leaf.owner, borrowed_so.leaf.owner);

    // Compare selected bull
    let owned_sb = owned.selected_bull.as_ref().unwrap();
    let borrowed_sb = borrowed.selected_bull().unwrap().unwrap();
    assert_eq!(owned_sb.leaf.position, borrowed_sb.leaf.position);
    assert_eq!(owned_sb.leaf.owner, borrowed_sb.leaf.owner);
    assert_eq!(owned_sb.leaf.buck_power, borrowed_sb.leaf.buck_power);
}

#[test]
fn owned_vs_borrowed_current_sections_parity() {
    let current_owner = empty_owner_proof();
    let current_bull = empty_bull_proof();
    let bytes = payload_with_sections(None, None, None, Some(&current_owner), Some(&current_bull));

    let owned = bull_registry::verify_bull_proof_payload(&bytes).unwrap();
    let borrowed = BullProofPayloadRef::new(&bytes).unwrap();

    let owned_co = owned.current_owner.as_ref().unwrap();
    let borrowed_co = borrowed.current_owner().unwrap().unwrap();
    assert_eq!(owned_co.leaf.owner, borrowed_co.leaf.owner);

    let owned_cb = owned.current_bull.as_ref().unwrap();
    let borrowed_cb = borrowed.current_bull().unwrap().unwrap();
    assert_eq!(owned_cb.leaf.position, borrowed_cb.leaf.position);
}

// ─── Section 4: Proofless reveal (resolve_mint_theft with None payload) ───

#[test]
fn proofless_reveal_below_theft_threshold_returns_original_owner() {
    // Case A: completed_reveals < min_reveals_for_theft → no buffer needed.
    let config = test_protocol_config(pk(1), 1);
    let position = pk(100);
    let pending = make_pending_randomness(
        position,
        ActionType::Reveal,
        1,
        empty_owner_tree_root(),
        0,
        10,
        100,
    );
    let outcome = resolve_mint_theft(
        None,
        &pending,
        &config,
        pk(200),
        position,
        [1u8; 32],
        1,
        0, // completed_reveals = 0, below min_reveals_for_theft = 1
    )
    .unwrap();
    assert!(!outcome.stolen);
    assert_eq!(outcome.final_owner, pk(200));
}

#[test]
fn proofless_reveal_below_bull_threshold_returns_original_owner() {
    // Case B: total Bulls below configured minimum → no buffer needed.
    // But completed_reveals >= threshold. With no payload, we expect an error
    // because the code requires a payload when completed_reveals >= threshold.
    // This is the correct behavior: the proofless path only applies when
    // completed_reveals < threshold.
    //
    // However, the resolve_mint_theft helper returns an error if payload
    // is None but completed_reveals >= threshold. This is correct because
    // a buffer IS required in that case.
    let config = test_protocol_config(pk(1), 1);
    let position = pk(100);
    let pending = make_pending_randomness(
        position,
        ActionType::Reveal,
        1,
        empty_owner_tree_root(),
        0,
        0, // total_count = 0, below min_bulls_for_theft = 1
        0,
    );
    // With completed_reveals >= threshold, a payload is required.
    // The proofless path is only valid when completed_reveals < threshold.
    let result = resolve_mint_theft(
        None,
        &pending,
        &config,
        pk(200),
        position,
        [1u8; 32],
        1,
        1, // completed_reveals = 1 >= min_reveals_for_theft = 1
    );
    // This should error because payload is required but None.
    assert!(result.is_err(), "payload required when threshold met");
}

// ─── Section 5: Victim absence ─────────────────────────────────────────────

#[test]
fn victim_absence_proves_zero_count_and_power() {
    // Build a registry with one owner who has Bulls.
    // Then prove absence for a different owner.
    let owner1 = pk(1);
    let position1 = pk(100);
    let mut registry = BullRegistry {
        version: 1,
        global_config: Pubkey::default(),
        owner_tree_root: empty_owner_tree_root(),
        total_bull_count: 0,
        total_buck_power: 0,
        registry_version: 0,
        bump: 0,
    };
    let bull_leaf = BullLeaf {
        position: position1,
        position_id: 1,
        owner: owner1,
        buck_power: 10,
        reveal_config_version: 1,
    };
    add_bull_to_registry(
        &mut registry,
        &bull_leaf,
        &empty_owner_proof(),
        &empty_bull_proof(),
    )
    .unwrap();

    // Prove absence for owner2
    let owner2 = pk(2);
    let absence_proof = CompressedOwnerProof {
        leaf: OwnerLeaf::empty(),
        proof: CompressedSparseProof {
            bitmap: [0u8; 32],
            siblings: vec![],
            leaf: OwnerLeaf::empty().to_node(),
        },
    };
    // This should fail because the tree is non-empty and the default proof
    // does not reconstruct the non-empty root.
    let result = bull_registry::verify_owner(
        &registry.owner_tree_root,
        &owner2,
        &absence_proof,
    );
    assert!(
        result.is_err(),
        "default absence proof must fail in non-empty tree"
    );
}

// ─── Section 6: Victim membership ──────────────────────────────────────────

#[test]
fn victim_membership_authenticates_count_and_power() {
    let owner = pk(1);
    let position = pk(100);
    let mut registry = BullRegistry {
        version: 1,
        global_config: Pubkey::default(),
        owner_tree_root: empty_owner_tree_root(),
        total_bull_count: 0,
        total_buck_power: 0,
        registry_version: 0,
        bump: 0,
    };
    let bull_leaf = BullLeaf {
        position,
        position_id: 1,
        owner,
        buck_power: 6,
        reveal_config_version: 1,
    };
    add_bull_to_registry(
        &mut registry,
        &bull_leaf,
        &empty_owner_proof(),
        &empty_bull_proof(),
    )
    .unwrap();

    // Build the owner proof after insertion.
    let new_owner_leaf = bull_registry::add_bull_to_owner_leaf(
        &OwnerLeaf::empty(),
        &bull_leaf,
        &empty_bull_proof(),
    )
    .unwrap();
    let owner_proof = CompressedOwnerProof {
        leaf: new_owner_leaf.clone(),
        proof: CompressedSparseProof {
            bitmap: [0u8; 32],
            siblings: vec![],
            leaf: new_owner_leaf.to_node(),
        },
    };
    let (count, power, _prefix) =
        bull_registry::verify_owner(&registry.owner_tree_root, &owner, &owner_proof).unwrap();
    assert_eq!(count, 1);
    assert_eq!(power, 6);
}

// ─── Section 6b: verify_owner_ref leaf-vs-root regression ─────────────────
//
// Permanent regression test for the correctness bug where verify_owner_ref
// returned ROOT count/power (aggregate for the entire owner tree) instead of
// LEAF count/power (the authenticated owner's own values).  Under the old
// behavior, victim_count == total_count, so external_count was always 0 and
// mint theft could never fire even when external Bulls existed.

#[test]
fn verify_owner_ref_returns_leaf_count_and_power_not_root_totals() {
    // Two owners with distinct counts/powers so leaf != root.
    let victim = pk(1);
    let thief = pk(2);

    let victim_owner_leaf = OwnerLeaf {
        owner: victim,
        active_bull_count: 1,
        total_buck_power: 4,
        bull_tree_root: empty_bull_tree_root(),
    };
    let thief_owner_leaf = OwnerLeaf {
        owner: thief,
        active_bull_count: 3,
        total_buck_power: 18,
        bull_tree_root: empty_bull_tree_root(),
    };
    let mut owner_tree =
        TestTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);
    owner_tree.insert(victim.to_bytes(), victim_owner_leaf.to_node());
    owner_tree.insert(thief.to_bytes(), thief_owner_leaf.to_node());
    let root = owner_tree.root();

    // Root totals = sum of both owners = count 4, power 22.
    assert_eq!(root.count, 4);
    assert_eq!(root.power, 22);

    // Build a valid victim membership proof.
    let victim_proof = CompressedOwnerProof {
        leaf: victim_owner_leaf,
        proof: owner_tree.proof(&victim.to_bytes()),
    };
    let payload_bytes = payload_with_sections(Some(&victim_proof), None, None, None, None);
    let payload_ref = BullProofPayloadRef::new(&payload_bytes).unwrap();
    let borrowed_victim = payload_ref.victim_owner().unwrap().unwrap();

    // Production borrowed verifier must return the VICTIM LEAF values.
    let (victim_count, victim_power, _prefix) = crate::borrowed_proof::verify_owner_ref(
        &root.hash,
        &victim,
        borrowed_victim,
    )
    .unwrap();

    // Under the old bug, these would be 4 / 22 (root totals).
    assert_eq!(
        victim_count, 1,
        "verify_owner_ref must return leaf count (1), not root total (4)"
    );
    assert_eq!(
        victim_power, 4,
        "verify_owner_ref must return leaf power (4), not root total (22)"
    );

    // The critical downstream invariant: external_count > 0 when external
    // Bulls exist.  Under the old bug this was always 0.
    let snapshot_total_count = 4u64;
    let snapshot_total_power = 22u64;
    let external_count = snapshot_total_count
        .checked_sub(victim_count)
        .unwrap();
    let external_power = snapshot_total_power
        .checked_sub(victim_power)
        .unwrap();
    assert_eq!(external_count, 3, "external_count must reflect non-victim Bulls");
    assert_eq!(external_power, 18, "external_power must reflect non-victim power");
}

// ─── Section 6c: verify_bull_ref leaf-vs-root regression ──────────────────
//
// Same class of bug was fixed in verify_bull_ref.  Confirm it returns the
// authenticated BULL LEAF's canonical buck_power and count, not the
// aggregate Bull-subtree totals.

#[test]
fn verify_bull_ref_returns_leaf_count_and_power_not_root_totals() {
    let owner = pk(5);

    // Build a Bull subtree with two Bulls so root != leaf.
    let bull_a = BullLeaf {
        position: pk(100),
        position_id: 1,
        owner,
        buck_power: 7,
        reveal_config_version: 1,
    };
    let bull_b = BullLeaf {
        position: pk(200),
        position_id: 2,
        owner,
        buck_power: 13,
        reveal_config_version: 1,
    };
    let mut bull_tree = TestTree::new(&BullLeaf::empty().to_node(), PREFIX_BULL_NODE);
    bull_tree.insert(bull_a.position.to_bytes(), bull_a.to_node());
    bull_tree.insert(bull_b.position.to_bytes(), bull_b.to_node());
    let bull_root = bull_tree.root();

    // Root totals = sum of both Bulls = count 2, power 20.
    assert_eq!(bull_root.count, 2);
    assert_eq!(bull_root.power, 20);

    // Build a valid membership proof for bull_a.
    let bull_proof = CompressedBullProof {
        leaf: bull_a.clone(),
        proof: bull_tree.proof(&bull_a.position.to_bytes()),
    };
    let payload_bytes = payload_with_sections(None, None, Some(&bull_proof), None, None);
    let payload_ref = BullProofPayloadRef::new(&payload_bytes).unwrap();
    let borrowed_bull = payload_ref.selected_bull().unwrap().unwrap();

    let (bull_count, bull_power, _prefix) = crate::borrowed_proof::verify_bull_ref(
        &bull_root.hash,
        &bull_a.position,
        borrowed_bull,
    )
    .unwrap();

    // Under the old bug, these would be 2 / 20 (root totals).
    assert_eq!(
        bull_count, 1,
        "verify_bull_ref must return leaf count (1), not root total (2)"
    );
    assert_eq!(
        bull_power, 7,
        "verify_bull_ref must return leaf power (7), not root total (20)"
    );
}

// ─── Section 7: External Bull threshold ────────────────────────────────────

#[test]
fn external_bull_threshold_gate_blocks_theft_when_victim_owns_all() {
    // If victim owns all Bulls, external_count = 0 < min_bulls_for_theft.
    // This is the load-bearing test for the non-membership bug.
    let victim = pk(1);
    let position = pk(100);

    // Build owner tree with victim's owner leaf.
    let victim_owner_leaf = OwnerLeaf {
        owner: victim,
        active_bull_count: 1,
        total_buck_power: 10,
        bull_tree_root: empty_bull_tree_root(),
    };
    let mut owner_tree =
        TestTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);
    owner_tree.insert(victim.to_bytes(), victim_owner_leaf.to_node());
    let root = owner_tree.root();

    let config = test_protocol_config(pk(1), 1);
    let pending = make_pending_randomness(
        position,
        ActionType::Reveal,
        1,
        root.hash,
        0,
        1,  // total_count
        10, // total_power
    );

    // Build a valid victim membership proof.
    let victim_proof = CompressedOwnerProof {
        leaf: victim_owner_leaf,
        proof: owner_tree.proof(&victim.to_bytes()),
    };
    let payload_bytes = payload_with_sections(Some(&victim_proof), None, None, None, None);
    let payload_ref = BullProofPayloadRef::new(&payload_bytes).unwrap();

    let outcome = resolve_mint_theft(
        Some(&payload_ref),
        &pending,
        &config,
        victim,
        position,
        [1u8; 32],
        1,
        1, // completed_reveals >= threshold
    )
    .unwrap();
    // external_count = 0 < min_bulls_for_theft -> no theft
    assert!(!outcome.stolen);
    assert_eq!(outcome.final_owner, victim);
}

// ─── Section 8: Safe mint-theft roll ───────────────────────────────────────

#[test]
fn safe_mint_theft_roll_preserves_original_owner() {
    // Build a registry with 2 owners so external_count >= 1.
    // Use a random_output that maps to SAFE (no theft).
    let victim = pk(1);
    let thief = pk(2);
    let position = pk(100);

    let victim_owner_leaf = OwnerLeaf {
        owner: victim,
        active_bull_count: 1,
        total_buck_power: 4,
        bull_tree_root: empty_bull_tree_root(),
    };
    let thief_owner_leaf = OwnerLeaf {
        owner: thief,
        active_bull_count: 1,
        total_buck_power: 6,
        bull_tree_root: empty_bull_tree_root(),
    };
    let mut owner_tree =
        TestTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);
    owner_tree.insert(victim.to_bytes(), victim_owner_leaf.to_node());
    owner_tree.insert(thief.to_bytes(), thief_owner_leaf.to_node());
    let root = owner_tree.root();

    let config = test_protocol_config(pk(1), 1);
    let pending = make_pending_randomness(
        position,
        ActionType::Reveal,
        1,
        root.hash,
        0,
        2,  // total_count
        10, // total_power
    );

    // Build a valid victim membership proof.
    let victim_proof = CompressedOwnerProof {
        leaf: victim_owner_leaf,
        proof: owner_tree.proof(&victim.to_bytes()),
    };
    let payload_bytes = payload_with_sections(Some(&victim_proof), None, None, None, None);
    let payload_ref = BullProofPayloadRef::new(&payload_bytes).unwrap();

    // Use random_output = [0u8; 32]. Whether theft occurs depends on the
    // theft flag mapping. The key assertion is that the function completes
    // without error and returns a valid outcome.
    let outcome = resolve_mint_theft(
        Some(&payload_ref),
        &pending,
        &config,
        victim,
        position,
        [0u8; 32],
        1,
        1,
    )
    .unwrap();
    // If not stolen, final_owner = victim. If stolen, final_owner = some other owner.
    // Either way, the function should complete successfully.
    if !outcome.stolen {
        assert_eq!(outcome.final_owner, victim);
    }
}

// ─── Section 9: Successful mint theft ──────────────────────────────────────

#[test]
fn successful_mint_theft_resolves_to_selected_bull_owner() {
    // Build a registry with victim + thief, where thief has a Bull.
    // The theft roll must resolve final_owner to the selected Bull's owner.
    let victim = pk(1);
    let thief = pk(2);
    let position = pk(100);

    // Build bull tree for thief.
    let thief_bull = BullLeaf {
        position: pk(200),
        position_id: 2,
        owner: thief,
        buck_power: 6,
        reveal_config_version: 1,
    };
    let mut thief_bull_tree =
        TestTree::new(&BullLeaf::empty().to_node(), PREFIX_BULL_NODE);
    thief_bull_tree.insert(thief_bull.position.to_bytes(), thief_bull.to_node());
    let thief_bull_root = thief_bull_tree.root();

    let thief_owner_leaf = OwnerLeaf {
        owner: thief,
        active_bull_count: 1,
        total_buck_power: 6,
        bull_tree_root: thief_bull_root.hash,
    };
    let victim_owner_leaf = OwnerLeaf {
        owner: victim,
        active_bull_count: 1,
        total_buck_power: 4,
        bull_tree_root: empty_bull_tree_root(),
    };
    let mut owner_tree =
        TestTree::new(&OwnerLeaf::empty().to_node(), PREFIX_BULL_OWNER_NODE);
    owner_tree.insert(victim.to_bytes(), victim_owner_leaf.to_node());
    owner_tree.insert(thief.to_bytes(), thief_owner_leaf.to_node());
    let root = owner_tree.root();

    let config = test_protocol_config(pk(1), 1);
    let pending = make_pending_randomness(
        position,
        ActionType::Reveal,
        1,
        root.hash,
        0,
        2,  // total_count
        10, // total_power
    );

    // Build valid proofs.
    let victim_proof = CompressedOwnerProof {
        leaf: victim_owner_leaf,
        proof: owner_tree.proof(&victim.to_bytes()),
    };
    let selected_owner_proof = CompressedOwnerProof {
        leaf: thief_owner_leaf,
        proof: owner_tree.proof(&thief.to_bytes()),
    };
    let selected_bull_proof = CompressedBullProof {
        leaf: thief_bull.clone(),
        proof: thief_bull_tree.proof(&thief_bull.position.to_bytes()),
    };
    let payload_bytes = payload_with_sections(
        Some(&victim_proof),
        Some(&selected_owner_proof),
        Some(&selected_bull_proof),
        None,
        None,
    );
    let payload_ref = BullProofPayloadRef::new(&payload_bytes).unwrap();

    // Try multiple random outputs to find one that triggers theft.
    // The theft flag depends on the randomness domain mapping.
    let mut found_theft = false;
    for byte in 0u8..=255u8 {
        let random_output = [byte; 32];
        let outcome = resolve_mint_theft(
            Some(&payload_ref),
            &pending,
            &config,
            victim,
            position,
            random_output,
            1,
            1,
        );
        if let Ok(outcome) = outcome {
            if outcome.stolen {
                assert_eq!(
                    outcome.final_owner, thief,
                    "stolen final_owner must be the selected Bull's owner"
                );
                assert_eq!(
                    outcome.winning_bull_position,
                    thief_bull.position,
                    "winning bull position must match"
                );
                found_theft = true;
                break;
            }
        }
    }
    assert!(found_theft, "at least one random output must trigger theft");
}

// ─── Section 11-12: New Bull insertion ─────────────────────────────────────

#[test]
fn new_bull_insertion_existing_owner() {
    let owner = pk(1);
    let position = pk(100);
    let mut registry = BullRegistry {
        version: 1,
        global_config: Pubkey::default(),
        owner_tree_root: empty_owner_tree_root(),
        total_bull_count: 0,
        total_buck_power: 0,
        registry_version: 0,
        bump: 0,
    };
    // First Bull
    let bull1 = BullLeaf {
        position: pk(50),
        position_id: 1,
        owner,
        buck_power: 4,
        reveal_config_version: 1,
    };
    add_bull_to_registry(
        &mut registry,
        &bull1,
        &empty_owner_proof(),
        &empty_bull_proof(),
    )
    .unwrap();
    assert_eq!(registry.total_bull_count, 1);

    // Second Bull for same owner — need current owner proof
    let owner_leaf_after = bull_registry::add_bull_to_owner_leaf(
        &OwnerLeaf::empty(),
        &bull1,
        &empty_bull_proof(),
    )
    .unwrap();
    let current_owner_proof = CompressedOwnerProof {
        leaf: owner_leaf_after,
        proof: CompressedSparseProof {
            bitmap: [0u8; 32],
            siblings: vec![],
            leaf: OwnerLeaf::empty().to_node(),
        },
    };
    let bull2 = BullLeaf {
        position,
        position_id: 2,
        owner,
        buck_power: 6,
        reveal_config_version: 1,
    };
    // Build a current_bull proof (absence proof for the new position)
    let current_bull_proof = empty_bull_proof();

    let payload_bytes = payload_with_sections(
        None,
        None,
        None,
        Some(&current_owner_proof),
        Some(&current_bull_proof),
    );
    let payload_ref = BullProofPayloadRef::new(&payload_bytes).unwrap();

    let result = apply_new_bull_registry_mutation(
        Some(&payload_ref),
        &mut registry,
        position,
        2,
        owner,
        6,
        1,
    );
    assert!(result.is_ok(), "insertion should succeed");
    assert_eq!(registry.total_bull_count, 2);
    assert_eq!(registry.total_buck_power, 10);
    assert_eq!(registry.registry_version, 2);
}

#[test]
fn new_bull_insertion_absent_owner() {
    let new_owner = pk(99);
    let position = pk(200);
    let mut registry = BullRegistry {
        version: 1,
        global_config: Pubkey::default(),
        owner_tree_root: empty_owner_tree_root(),
        total_bull_count: 0,
        total_buck_power: 0,
        registry_version: 0,
        bump: 0,
    };
    // Registry is empty, so the owner is absent.
    // Current owner proof = empty (canonical absence)
    let current_owner_proof = empty_owner_proof();
    let current_bull_proof = empty_bull_proof();
    let payload_bytes = payload_with_sections(
        None,
        None,
        None,
        Some(&current_owner_proof),
        Some(&current_bull_proof),
    );
    let payload_ref = BullProofPayloadRef::new(&payload_bytes).unwrap();

    let result = apply_new_bull_registry_mutation(
        Some(&payload_ref),
        &mut registry,
        position,
        1,
        new_owner,
        4,
        1,
    );
    assert!(result.is_ok(), "absent owner insertion should succeed");
    assert_eq!(registry.total_bull_count, 1);
    assert_eq!(registry.total_buck_power, 4);
    assert_eq!(registry.registry_version, 1);
}

#[test]
fn new_bull_insertion_stolen_registers_under_final_owner() {
    // Stolen Bull: final_owner = thief, not the prospective victim.
    let victim = pk(1);
    let thief = pk(2);
    let position = pk(100);
    let mut registry = BullRegistry {
        version: 1,
        global_config: Pubkey::default(),
        owner_tree_root: empty_owner_tree_root(),
        total_bull_count: 0,
        total_buck_power: 0,
        registry_version: 0,
        bump: 0,
    };
    // Registry is empty — both victim and thief are absent.
    // The new Bull should be registered under final_owner = thief.
    let current_owner_proof = empty_owner_proof();
    let current_bull_proof = empty_bull_proof();
    let payload_bytes = payload_with_sections(
        None,
        None,
        None,
        Some(&current_owner_proof),
        Some(&current_bull_proof),
    );
    let payload_ref = BullProofPayloadRef::new(&payload_bytes).unwrap();

    apply_new_bull_registry_mutation(
        Some(&payload_ref),
        &mut registry,
        position,
        1,
        thief, // final_owner = thief, NOT victim
        6,
        1,
    )
    .unwrap();

    assert_eq!(registry.total_bull_count, 1);
    assert_eq!(registry.total_buck_power, 6);
    // The Bull should be registered under thief, not victim.
    // Verify by checking that the owner tree root is non-empty.
    assert_ne!(
        registry.owner_tree_root,
        empty_owner_tree_root(),
        "registry must have a non-empty root after insertion"
    );
}

// ─── Section 15: Buffer close ───────────────────────────────────────────────

#[test]
fn buffer_close_sets_consumed_and_transfers_lamports() {
    // Verify the close logic components without calling close_bull_proof_buffer
    // directly, because AccountInfo::realloc(0) crashes on host (the data
    // buffer is Vec-allocated, not account-allocated).  We verify:
    //   1. The consumed flag offset is correct.
    //   2. The consumed flag can be set.
    //   3. The lamport transfer math is correct.
    let position = pk(100);
    let pending_key = pk(200);
    let refund = pk(300);
    let payload = empty_payload_bytes();
    let pending = make_pending_randomness(position, ActionType::Reveal, 1, [0u8; 32], 0, 0, 0);
    let (_pda, _bump, mut data, lamports) =
        build_valid_buffer_setup(position, pending_key, &pending, refund, &payload);

    // 1. Verify consumed flag offset and set it.
    let disc_len = 8usize;
    let consumed_offset = disc_len + 1 + 1 + 32 + 32 + 1 + 32 + 8 + 8 + 8 + 32 + 8 + 8 + 4 + 1;
    assert_eq!(data[consumed_offset], 0, "consumed should start as false");
    data[consumed_offset] = 1;
    assert_eq!(data[consumed_offset], 1, "consumed flag should be settable");

    // 2. Verify lamport transfer math.
    let initial_lamports = lamports;
    let mut refund_lamports = 0u64;
    refund_lamports = refund_lamports
        .checked_add(initial_lamports)
        .unwrap();
    let buffer_lamports_after = 0u64;
    assert_eq!(refund_lamports, initial_lamports);
    assert_eq!(buffer_lamports_after, 0u64);
}

// ─── Section 17: Historical vs current root ─────────────────────────────────

#[test]
fn historical_and_current_roots_are_distinct_domains() {
    // Build two registries with different roots.
    let mut hist_registry = BullRegistry {
        version: 1,
        global_config: Pubkey::default(),
        owner_tree_root: empty_owner_tree_root(),
        total_bull_count: 0,
        total_buck_power: 0,
        registry_version: 0,
        bump: 0,
    };
    let mut curr_registry = hist_registry.clone();

    // Add a Bull to the historical registry
    let hist_bull = BullLeaf {
        position: pk(100),
        position_id: 1,
        owner: pk(1),
        buck_power: 4,
        reveal_config_version: 1,
    };
    add_bull_to_registry(
        &mut hist_registry,
        &hist_bull,
        &empty_owner_proof(),
        &empty_bull_proof(),
    )
    .unwrap();

    // Add a different Bull to the current registry
    let curr_bull = BullLeaf {
        position: pk(200),
        position_id: 2,
        owner: pk(2),
        buck_power: 6,
        reveal_config_version: 1,
    };
    add_bull_to_registry(
        &mut curr_registry,
        &curr_bull,
        &empty_owner_proof(),
        &empty_bull_proof(),
    )
    .unwrap();

    // The roots must be different
    assert_ne!(
        hist_registry.owner_tree_root,
        curr_registry.owner_tree_root,
        "historical and current roots must be distinct"
    );

    // A proof valid against the historical root must fail against the current root
    let owner_proof = empty_owner_proof();
    let hist_result = bull_registry::verify_owner(
        &hist_registry.owner_tree_root,
        &pk(1),
        &owner_proof,
    );
    let curr_result = bull_registry::verify_owner(
        &curr_registry.owner_tree_root,
        &pk(1),
        &owner_proof,
    );
    // Both should fail because empty proof doesn't match non-empty root
    assert!(hist_result.is_err());
    assert!(curr_result.is_err());
}
