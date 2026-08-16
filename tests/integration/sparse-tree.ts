import { createHash } from "crypto";
import { web3 } from "@coral-xyz/anchor";

type PublicKey = web3.PublicKey;
const { PublicKey } = web3;

// ---------------------------------------------------------------------------
// Constants — must match programs/rodeo_core/src/bull_registry.rs
// ---------------------------------------------------------------------------

export const SPARSE_TREE_DEPTH = 256;
export const SPARSE_TREE_BITMAP_BYTES = 32;

const PREFIX_BULL_OWNER_NODE = Buffer.from("rodeo_v2_bull_owner_node", "utf8");
const PREFIX_BULL_NODE = Buffer.from("rodeo_v2_bull_node", "utf8");
const PREFIX_BULL_OWNER_LEAF = Buffer.from("rodeo_v2_bull_owner_leaf", "utf8");
const PREFIX_BULL_LEAF = Buffer.from("rodeo_v2_bull_leaf", "utf8");

export const BULL_PROOF_PAYLOAD_SCHEMA_VERSION = 2;
export const SECTION_VICTIM_OWNER = 0b0000_0001;
export const SECTION_SELECTED_OWNER = 0b0000_0010;
export const SECTION_SELECTED_BULL = 0b0000_0100;
export const SECTION_CURRENT_OWNER = 0b0000_1000;
export const SECTION_CURRENT_BULL = 0b0001_0000;
export const SECTION_REMOVE_BULL = 0b0010_0000;

// ---------------------------------------------------------------------------
// SparseMerkleNode — must match programs/rodeo_core/src/sparse_tree.rs
// ---------------------------------------------------------------------------

export interface SparseMerkleNode {
  hash: Uint8Array; // 32 bytes
  count: bigint;
  power: bigint;
}

// ---------------------------------------------------------------------------
// Hashing — must match programs/rodeo_core/src/sparse_tree.rs::hash_node
// ---------------------------------------------------------------------------

function hashNode(
  prefix: Buffer,
  left: SparseMerkleNode,
  right: SparseMerkleNode,
): SparseMerkleNode {
  const count = left.count + right.count;
  const power = left.power + right.power;
  const buf = Buffer.alloc(
    prefix.length + 32 + 8 + 8 + 32 + 8 + 8,
  );
  let off = 0;
  prefix.copy(buf, off); off += prefix.length;
  buf.set(left.hash, off); off += 32;
  buf.writeBigUInt64LE(left.count, off); off += 8;
  buf.writeBigUInt64LE(left.power, off); off += 8;
  buf.set(right.hash, off); off += 32;
  buf.writeBigUInt64LE(right.count, off); off += 8;
  buf.writeBigUInt64LE(right.power, off); off += 8;
  const hash = createHash("sha256").update(buf).digest();
  return { hash, count, power };
}

// ---------------------------------------------------------------------------
// Leaf types — must match programs/rodeo_core/src/bull_registry.rs
// ---------------------------------------------------------------------------

export interface OwnerLeaf {
  owner: PublicKey;
  activeBullCount: bigint;
  totalBuckPower: bigint;
  bullTreeRoot: Uint8Array; // 32 bytes
}

export interface BullLeaf {
  position: PublicKey;
  positionId: bigint;
  owner: PublicKey;
  buckPower: number;
  revealConfigVersion: bigint;
}

function ownerLeafHash(leaf: OwnerLeaf): Uint8Array {
  const buf = Buffer.alloc(
    PREFIX_BULL_OWNER_LEAF.length + 32 + 8 + 8 + 32,
  );
  let off = 0;
  PREFIX_BULL_OWNER_LEAF.copy(buf, off); off += PREFIX_BULL_OWNER_LEAF.length;
  buf.set(leaf.owner.toBuffer(), off); off += 32;
  buf.writeBigUInt64LE(leaf.activeBullCount, off); off += 8;
  buf.writeBigUInt64LE(leaf.totalBuckPower, off); off += 8;
  buf.set(leaf.bullTreeRoot, off); off += 32;
  return createHash("sha256").update(buf).digest();
}

function bullLeafHash(leaf: BullLeaf): Uint8Array {
  const buf = Buffer.alloc(
    PREFIX_BULL_LEAF.length + 32 + 8 + 32 + 1 + 8,
  );
  let off = 0;
  PREFIX_BULL_LEAF.copy(buf, off); off += PREFIX_BULL_LEAF.length;
  buf.set(leaf.position.toBuffer(), off); off += 32;
  buf.writeBigUInt64LE(leaf.positionId, off); off += 8;
  buf.set(leaf.owner.toBuffer(), off); off += 32;
  buf.writeUInt8(leaf.buckPower, off); off += 1;
  buf.writeBigUInt64LE(leaf.revealConfigVersion, off); off += 8;
  return createHash("sha256").update(buf).digest();
}

export function ownerLeafToNode(leaf: OwnerLeaf): SparseMerkleNode {
  const isEmpty = leaf.owner.equals(PublicKey.default);
  if (isEmpty) {
    return computeOwnerEmptyNodes()[0];
  }
  return {
    hash: ownerLeafHash(leaf),
    count: leaf.activeBullCount,
    power: leaf.totalBuckPower,
  };
}

export function bullLeafToNode(leaf: BullLeaf): SparseMerkleNode {
  const isEmpty = leaf.position.equals(PublicKey.default);
  if (isEmpty) {
    return computeBullEmptyNodes()[0];
  }
  return {
    hash: bullLeafHash(leaf),
    count: 1n,
    power: BigInt(leaf.buckPower),
  };
}

export function emptyOwnerLeaf(): OwnerLeaf {
  return {
    owner: PublicKey.default,
    activeBullCount: 0n,
    totalBuckPower: 0n,
    bullTreeRoot: emptyBullTreeRoot(),
  };
}

export function emptyBullLeaf(): BullLeaf {
  return {
    position: PublicKey.default,
    positionId: 0n,
    owner: PublicKey.default,
    buckPower: 0,
    revealConfigVersion: 0n,
  };
}

// ---------------------------------------------------------------------------
// Empty node tables — computed once and cached
// ---------------------------------------------------------------------------

let _emptyBullNodesCache: SparseMerkleNode[] | null = null;
let _emptyOwnerNodesCache: SparseMerkleNode[] | null = null;

function computeEmptyNodes(emptyLeaf: SparseMerkleNode, prefix: Buffer): SparseMerkleNode[] {
  const nodes: SparseMerkleNode[] = [emptyLeaf];
  let current = emptyLeaf;
  for (let i = 0; i < SPARSE_TREE_DEPTH; i++) {
    current = hashNode(prefix, current, current);
    nodes.push(current);
  }
  return nodes;
}

// Compute the empty bull leaf hash directly (without recursion)
function computeBullEmptyNodes(): SparseMerkleNode[] {
  if (_emptyBullNodesCache) return _emptyBullNodesCache;
  // The empty bull leaf has position = default, so its hash is the hash of
  // the leaf with all-zero fields.
  const emptyLeafHash = bullLeafHash(emptyBullLeaf());
  const emptyLeafNode: SparseMerkleNode = { hash: emptyLeafHash, count: 0n, power: 0n };
  _emptyBullNodesCache = computeEmptyNodes(emptyLeafNode, PREFIX_BULL_NODE);
  return _emptyBullNodesCache;
}

function computeOwnerEmptyNodes(): SparseMerkleNode[] {
  if (_emptyOwnerNodesCache) return _emptyOwnerNodesCache;
  const emptyLeafHash = ownerLeafHash(emptyOwnerLeaf());
  const emptyLeafNode: SparseMerkleNode = { hash: emptyLeafHash, count: 0n, power: 0n };
  _emptyOwnerNodesCache = computeEmptyNodes(emptyLeafNode, PREFIX_BULL_OWNER_NODE);
  return _emptyOwnerNodesCache;
}

export function emptyBullTreeRoot(): Uint8Array {
  return computeBullEmptyNodes()[SPARSE_TREE_DEPTH].hash;
}

export function emptyOwnerTreeRoot(): Uint8Array {
  return computeOwnerEmptyNodes()[SPARSE_TREE_DEPTH].hash;
}

function emptyNodesForPrefix(prefix: Buffer): SparseMerkleNode[] {
  if (prefix.equals(PREFIX_BULL_NODE)) {
    return computeBullEmptyNodes();
  } else if (prefix.equals(PREFIX_BULL_OWNER_NODE)) {
    return computeOwnerEmptyNodes();
  }
  throw new Error("unknown sparse tree prefix");
}

// ---------------------------------------------------------------------------
// SparseTree — in-memory trie for proof construction
// ---------------------------------------------------------------------------

interface TrieNode {
  children: [TrieNode | null, TrieNode | null];
  height: number;
  node: SparseMerkleNode;
}

class SparseTree {
  private root: TrieNode;
  private defaults: SparseMerkleNode[];
  private prefix: Buffer;

  constructor(emptyLeaf: SparseMerkleNode, prefix: Buffer) {
    this.defaults = emptyNodesForPrefix(prefix);
    this.prefix = prefix;
    this.root = {
      children: [null, null],
      height: SPARSE_TREE_DEPTH,
      node: this.defaults[SPARSE_TREE_DEPTH],
    };
  }

  private static bitAt(key: Uint8Array, index: number): boolean {
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;
    return ((key[byteIndex] >> bitIndex) & 1) === 1;
  }

  insert(key: Uint8Array, leaf: SparseMerkleNode): void {
    const path: TrieNode[] = [];
    let current = this.root;
    path.push(current);
    for (let h = SPARSE_TREE_DEPTH; h > 0; h--) {
      const bit = SparseTree.bitAt(key, h - 1) ? 1 : 0;
      if (!current.children[bit]) {
        current.children[bit] = {
          children: [null, null],
          height: h - 1,
          node: this.defaults[h - 1],
        };
      }
      current = current.children[bit]!;
      path.push(current);
    }
    current.node = leaf;

    // Recompute hashes bottom-up
    for (let i = path.length - 2; i >= 0; i--) {
      const node = path[i];
      const h = node.height;
      const left = node.children[0]?.node ?? this.defaults[h - 1];
      const right = node.children[1]?.node ?? this.defaults[h - 1];
      node.node = hashNode(this.prefix, left, right);
    }
  }

  proof(key: Uint8Array): CompressedSparseProof {
    const bitmap = new Uint8Array(SPARSE_TREE_BITMAP_BYTES);
    const siblingsRev: SparseMerkleNode[] = [];
    let current: TrieNode | null = this.root;

    for (let h = SPARSE_TREE_DEPTH; h > 0; h--) {
      const bit = SparseTree.bitAt(key, h - 1) ? 1 : 0;
      if (current) {
        const siblingNode = current.children[1 - bit]?.node ?? this.defaults[h - 1];
        const defaultNode = this.defaults[h - 1];
        if (
          siblingNode.hash.length !== defaultNode.hash.length ||
          !Buffer.from(siblingNode.hash).equals(Buffer.from(defaultNode.hash)) ||
          siblingNode.count !== defaultNode.count ||
          siblingNode.power !== defaultNode.power
        ) {
          bitmap[Math.floor((h - 1) / 8)] |= 1 << ((h - 1) % 8);
          siblingsRev.push(siblingNode);
        }
        current = current.children[bit];
      } else {
        break;
      }
    }

    siblingsRev.reverse();
    const leaf = current ? current.node : this.defaults[0];

    return { bitmap, siblings: siblingsRev, leaf };
  }

  getRoot(): SparseMerkleNode {
    return this.root.node;
  }
}

// ---------------------------------------------------------------------------
// Proof verification — must match SparseTree::proof layout
// ---------------------------------------------------------------------------

function verifyCompressedSparseProof(
  key: Uint8Array,
  leaf: SparseMerkleNode,
  proof: CompressedSparseProof,
  prefix: Buffer,
): SparseMerkleNode {
  const defaults = emptyNodesForPrefix(prefix);
  let current = leaf;
  let siblingIdx = 0;
  for (let h = 1; h <= SPARSE_TREE_DEPTH; h++) {
    const bitIndex = h - 1;
    const byteIndex = Math.floor(bitIndex / 8);
    const bitInByte = bitIndex % 8;
    const bit = ((key[byteIndex] >> bitInByte) & 1) === 1;
    const siblingIsNonDefault = (proof.bitmap[byteIndex] & (1 << bitInByte)) !== 0;
    const sibling = siblingIsNonDefault ? proof.siblings[siblingIdx++] : defaults[h - 1];
    const [left, right] = bit ? [sibling, current] : [current, sibling];
    current = hashNode(prefix, left, right);
  }
  if (siblingIdx !== proof.siblings.length) {
    throw new Error("proof sibling count does not match bitmap");
  }
  return current;
}

export function verifyOwnerProof(
  owner: PublicKey,
  proof: CompressedOwnerProof,
  expectedRoot?: SparseMerkleNode,
): SparseMerkleNode {
  const root = verifyCompressedSparseProof(
    owner.toBuffer(),
    proof.proof.leaf,
    proof.proof,
    PREFIX_BULL_OWNER_NODE,
  );
  if (expectedRoot) {
    if (!Buffer.from(root.hash).equals(Buffer.from(expectedRoot.hash))) {
      throw new Error("owner proof root hash mismatch");
    }
    if (root.count !== expectedRoot.count || root.power !== expectedRoot.power) {
      throw new Error("owner proof root count/power mismatch");
    }
  }
  return root;
}

export function verifyBullProof(
  position: PublicKey,
  proof: CompressedBullProof,
  expectedRoot?: SparseMerkleNode,
): SparseMerkleNode {
  const root = verifyCompressedSparseProof(
    position.toBuffer(),
    proof.proof.leaf,
    proof.proof,
    PREFIX_BULL_NODE,
  );
  if (expectedRoot) {
    if (!Buffer.from(root.hash).equals(Buffer.from(expectedRoot.hash))) {
      throw new Error("bull proof root hash mismatch");
    }
    if (root.count !== expectedRoot.count || root.power !== expectedRoot.power) {
      throw new Error("bull proof root count/power mismatch");
    }
  }
  return root;
}

// ---------------------------------------------------------------------------
// Compressed proof types — must match Rust borsh serialization
// ---------------------------------------------------------------------------

export interface CompressedSparseProof {
  bitmap: Uint8Array; // 32 bytes
  siblings: SparseMerkleNode[];
  leaf: SparseMerkleNode;
}

export interface CompressedOwnerProof {
  leaf: OwnerLeaf;
  proof: CompressedSparseProof;
}

export interface CompressedBullProof {
  leaf: BullLeaf;
  proof: CompressedSparseProof;
}

export interface BullProofPayloadV1 {
  schemaVersion: number;
  sectionBitmap: number;
  victimOwner: CompressedOwnerProof | null;
  selectedOwner: CompressedOwnerProof | null;
  selectedBull: CompressedBullProof | null;
  currentOwner: CompressedOwnerProof | null;
  currentBull: CompressedBullProof | null;
  removeBull: CompressedBullProof | null;
}

// ---------------------------------------------------------------------------
// Borsh serialization — must match Anchor's borsh layout
// ---------------------------------------------------------------------------

class BorshWriter {
  private buf: Buffer[] = [];

  writeU8(v: number): void {
    const b = Buffer.alloc(1);
    b.writeUInt8(v, 0);
    this.buf.push(b);
  }

  writeU32(v: number): void {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v, 0);
    this.buf.push(b);
  }

  writeU64(v: bigint): void {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v, 0);
    this.buf.push(b);
  }

  writeBytes(v: Uint8Array): void {
    this.buf.push(Buffer.from(v));
  }

  writeOption<T>(v: T | null, writeFn: (v: T) => void): void {
    if (v === null) {
      this.writeU8(0);
    } else {
      this.writeU8(1);
      writeFn(v);
    }
  }

  writeVec<T>(v: T[], writeFn: (v: T) => void): void {
    this.writeU32(v.length);
    for (const item of v) writeFn(item);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.buf);
  }
}

function writeSparseMerkleNode(w: BorshWriter, n: SparseMerkleNode): void {
  w.writeBytes(n.hash); // [u8; 32] — fixed array, no length prefix
  w.writeU64(n.count);
  w.writeU64(n.power);
}

function writeCompressedSparseProof(w: BorshWriter, p: CompressedSparseProof): void {
  w.writeBytes(p.bitmap); // [u8; 32] — fixed array
  w.writeVec(p.siblings, (s) => writeSparseMerkleNode(w, s));
  writeSparseMerkleNode(w, p.leaf);
}

function writeOwnerLeaf(w: BorshWriter, l: OwnerLeaf): void {
  w.writeBytes(l.owner.toBuffer()); // Pubkey = [u8; 32]
  w.writeU64(l.activeBullCount);
  w.writeU64(l.totalBuckPower);
  w.writeBytes(l.bullTreeRoot); // [u8; 32]
}

function writeBullLeaf(w: BorshWriter, l: BullLeaf): void {
  w.writeBytes(l.position.toBuffer()); // Pubkey = [u8; 32]
  w.writeU64(l.positionId);
  w.writeBytes(l.owner.toBuffer()); // Pubkey = [u8; 32]
  w.writeU8(l.buckPower);
  w.writeU64(l.revealConfigVersion);
}

function writeCompressedOwnerProof(w: BorshWriter, p: CompressedOwnerProof): void {
  writeOwnerLeaf(w, p.leaf);
  writeCompressedSparseProof(w, p.proof);
}

function writeCompressedBullProof(w: BorshWriter, p: CompressedBullProof): void {
  writeBullLeaf(w, p.leaf);
  writeCompressedSparseProof(w, p.proof);
}

export function serializeBullProofPayload(payload: BullProofPayloadV1): Buffer {
  const w = new BorshWriter();
  w.writeU8(payload.schemaVersion);
  w.writeU8(payload.sectionBitmap);
  w.writeOption(payload.victimOwner, (v) => writeCompressedOwnerProof(w, v));
  w.writeOption(payload.selectedOwner, (v) => writeCompressedOwnerProof(w, v));
  w.writeOption(payload.selectedBull, (v) => writeCompressedBullProof(w, v));
  w.writeOption(payload.currentOwner, (v) => writeCompressedOwnerProof(w, v));
  w.writeOption(payload.currentBull, (v) => writeCompressedBullProof(w, v));
  w.writeOption(payload.removeBull, (v) => writeCompressedBullProof(w, v));
  return w.toBuffer();
}

// ---------------------------------------------------------------------------
// Registry model — builds owner and bull trees from registry state
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  owner: PublicKey;
  bulls: BullLeaf[];
}

export interface RegistryState {
  ownerTreeRoot: Uint8Array;
  totalBullCount: bigint;
  totalBuckPower: bigint;
  registryVersion: bigint;
  entries: RegistryEntry[];
}

export interface BuiltRegistry {
  ownerTree: SparseTree;
  bullTrees: Map<string, SparseTree>; // keyed by owner.toBase58()
  entries: RegistryEntry[];
  rootNode: SparseMerkleNode;
}

export function buildRegistry(entries: RegistryEntry[]): BuiltRegistry {
  const bullTrees = new Map<string, SparseTree>();
  const ownerLeaves: OwnerLeaf[] = [];

  for (const entry of entries) {
    const bullTree = new SparseTree(bullLeafToNode(emptyBullLeaf()), PREFIX_BULL_NODE);
    for (const bull of entry.bulls) {
      bullTree.insert(bull.position.toBuffer(), bullLeafToNode(bull));
    }
    const bullRoot = bullTree.getRoot();
    bullTrees.set(entry.owner.toBase58(), bullTree);

    ownerLeaves.push({
      owner: entry.owner,
      activeBullCount: BigInt(entry.bulls.length),
      totalBuckPower: bullRoot.power,
      bullTreeRoot: bullRoot.hash,
    });
  }

  const ownerTree = new SparseTree(ownerLeafToNode(emptyOwnerLeaf()), PREFIX_BULL_OWNER_NODE);
  for (const ol of ownerLeaves) {
    ownerTree.insert(ol.owner.toBuffer(), ownerLeafToNode(ol));
  }

  return {
    ownerTree,
    bullTrees,
    entries,
    rootNode: ownerTree.getRoot(),
  };
}

export function ownerProof(
  registry: BuiltRegistry,
  owner: PublicKey,
): CompressedOwnerProof {
  const entry = registry.entries.find((e) => e.owner.equals(owner));
  if (entry) {
    const bullTree = registry.bullTrees.get(owner.toBase58())!;
    const bullRoot = bullTree.getRoot();
    const leaf: OwnerLeaf = {
      owner,
      activeBullCount: BigInt(entry.bulls.length),
      totalBuckPower: bullRoot.power,
      bullTreeRoot: bullRoot.hash,
    };
    return {
      leaf,
      proof: registry.ownerTree.proof(owner.toBuffer()),
    };
  } else {
    return {
      leaf: emptyOwnerLeaf(),
      proof: registry.ownerTree.proof(owner.toBuffer()),
    };
  }
}

export function bullProof(
  registry: BuiltRegistry,
  owner: PublicKey,
  position: PublicKey,
): CompressedBullProof {
  const entry = registry.entries.find((e) => e.owner.equals(owner));
  const bullTree = registry.bullTrees.get(owner.toBase58());
  const bull = entry?.bulls.find((b) => b.position.equals(position));

  if (bull && bullTree) {
    return {
      leaf: bull,
      proof: bullTree.proof(position.toBuffer()),
    };
  } else {
    return {
      leaf: emptyBullLeaf(),
      proof: bullTree
        ? bullTree.proof(position.toBuffer())
        : new SparseTree(bullLeafToNode(emptyBullLeaf()), PREFIX_BULL_NODE).proof(position.toBuffer()),
    };
  }
}

// ---------------------------------------------------------------------------
// Payload builders for Reveal and Unstake
// ---------------------------------------------------------------------------

/**
 * Build a Bull reveal proof payload for a new Bull insertion.
 * Sections: CURRENT_OWNER (non-membership for owner) + CURRENT_BULL (non-membership for bull)
 */
export function buildRevealPayload(
  registry: BuiltRegistry,
  newBull: BullLeaf,
): BullProofPayloadV1 {
  const oproof = ownerProof(registry, newBull.owner);
  const bproof = bullProof(registry, newBull.owner, newBull.position);
  return {
    schemaVersion: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
    sectionBitmap: SECTION_CURRENT_OWNER | SECTION_CURRENT_BULL,
    victimOwner: null,
    selectedOwner: null,
    selectedBull: null,
    currentOwner: oproof,
    currentBull: bproof,
    removeBull: null,
  };
}

/**
 * Build a Bull unstake proof payload for removing a Bull.
 * Sections: CURRENT_OWNER (membership for owner) + REMOVE_BULL (membership for bull)
 */
export function buildUnstakePayload(
  registry: BuiltRegistry,
  owner: PublicKey,
  position: PublicKey,
): BullProofPayloadV1 {
  const oproof = ownerProof(registry, owner);
  const bproof = bullProof(registry, owner, position);
  return {
    schemaVersion: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
    sectionBitmap: SECTION_CURRENT_OWNER | SECTION_REMOVE_BULL,
    victimOwner: null,
    selectedOwner: null,
    selectedBull: null,
    currentOwner: oproof,
    currentBull: null,
    removeBull: bproof,
  };
}

/**
 * Build a mint-theft reveal payload with victim/selected sections.
 * Sections: VICTIM_OWNER + SELECTED_OWNER + SELECTED_BULL
 */
export function buildTheftRevealPayload(
  registry: BuiltRegistry,
  victimOwner: PublicKey,
  selectedOwner: PublicKey,
  selectedBullPosition: PublicKey,
): BullProofPayloadV1 {
  const vproof = ownerProof(registry, victimOwner);
  const oproof = ownerProof(registry, selectedOwner);
  const bproof = bullProof(registry, selectedOwner, selectedBullPosition);
  return {
    schemaVersion: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
    sectionBitmap: SECTION_VICTIM_OWNER | SECTION_SELECTED_OWNER | SECTION_SELECTED_BULL,
    victimOwner: vproof,
    selectedOwner: oproof,
    selectedBull: bproof,
    currentOwner: null,
    currentBull: null,
    removeBull: null,
  };
}
