import { createHash } from "crypto";
import { web3 } from "@coral-xyz/anchor";

type PublicKey = web3.PublicKey;
const { PublicKey } = web3;

// ---------------------------------------------------------------------------
// Constants — must match programs/rodeo_core/src/bull_registry.rs
// ---------------------------------------------------------------------------

export const SPARSE_TREE_DEPTH = 256;
export const SPARSE_TREE_BITMAP_BYTES = 32;

export const PREFIX_BULL_OWNER_NODE = Buffer.from("rodeo_v2_bull_owner_node", "utf8");
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

export class SparseTree {
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

// ---------------------------------------------------------------------------
// Benchmark fixture generation
// ---------------------------------------------------------------------------

export const RANDOMNESS_DOMAIN_REVEAL = 0;
export const RANDOMNESS_DOMAIN_UNSTAKE = 1;
export const RANDOMNESS_DOMAIN_MINT_THEFT = 2;
export const RANDOMNESS_DOMAIN_UNSTAKE_THEFT = 3;
export const RANDOMNESS_DOMAIN_ROLE = 4;
export const RANDOMNESS_DOMAIN_COWBOY_KIND = 5;
export const RANDOMNESS_DOMAIN_BULL_TIER = 6;
export const RANDOMNESS_DOMAIN_SUIT = 7;
export const RANDOMNESS_DOMAIN_OWNER_SELECTION = 8;
export const RANDOMNESS_DOMAIN_BULL_SELECTION = 9;

const RANDOMNESS_DOMAIN_PREFIX = Buffer.from("rodeo_randomness_v1", "utf8");
const REJECTION_SAMPLING_MAX_RETRIES = 64;
const PROBABILITY_DENOMINATOR = 10_000_000n;

export interface RandomnessSampleContext {
  randomOutput: Uint8Array;
  domain: number;
  position: PublicKey;
  actionNonce: bigint;
}

export function rejectionSampleDraw(
  ctx: RandomnessSampleContext,
  denominator: bigint,
): bigint {
  if (denominator <= 0n) {
    throw new Error("rejectionSampleDraw denominator must be positive");
  }

  const PREIMAGE_LEN =
    RANDOMNESS_DOMAIN_PREFIX.length + 1 + 32 + 32 + 8 + 8;
  const preimage = Buffer.alloc(PREIMAGE_LEN);
  let off = 0;

  RANDOMNESS_DOMAIN_PREFIX.copy(preimage, off);
  off += RANDOMNESS_DOMAIN_PREFIX.length;
  preimage.writeUInt8(ctx.domain, off);
  off += 1;
  Buffer.from(ctx.randomOutput).copy(preimage, off);
  off += 32;
  ctx.position.toBuffer().copy(preimage, off);
  off += 32;
  preimage.writeBigUInt64LE(ctx.actionNonce, off);
  off += 8;

  const rangeSize = 1n << 64n;
  const limit = rangeSize - (rangeSize % denominator);

  for (let retry = 0; retry < REJECTION_SAMPLING_MAX_RETRIES; retry++) {
    preimage.writeBigUInt64LE(BigInt(retry), off);
    const digest = createHash("sha256").update(preimage).digest();

    for (let chunkIndex = 0; chunkIndex < 4; chunkIndex++) {
      const chunk = digest.subarray(chunkIndex * 8, (chunkIndex + 1) * 8);
      const candidate = BigInt("0x" + chunk.toString("hex"));
      if (candidate < limit) {
        return candidate % denominator;
      }
    }
  }

  throw new Error("RejectionSamplingExhausted");
}

export function deriveCommitment(
  position: PublicKey,
  actionType: number,
  actionNonce: bigint,
  protocolEpoch: bigint,
): Uint8Array {
  const buf = Buffer.alloc(32 + 1 + 8 + 8);
  position.toBuffer().copy(buf, 0);
  buf.writeUInt8(actionType, 32);
  buf.writeBigUInt64LE(actionNonce, 33);
  buf.writeBigUInt64LE(protocolEpoch, 41);
  return createHash("sha256").update(buf).digest();
}

const BENCHMARK_POWERS = [4, 6, 8, 10];
const BENCHMARK_BULL_DISTRIBUTION = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function le64Bytes(x: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(x), 0);
  return b;
}

function sha256Bytes(parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

function deterministicOwner(index: number): PublicKey {
  return new PublicKey(
    sha256Bytes([Buffer.from("owner"), le64Bytes(index)]),
  );
}

function deterministicBull(ownerIndex: number, bullIndex: number): PublicKey {
  return new PublicKey(
    sha256Bytes([
      Buffer.from("bull"),
      le64Bytes(ownerIndex),
      le64Bytes(bullIndex),
    ]),
  );
}

function buildBullsForOwner(
  ownerIndex: number,
  count: number,
  startCount: number,
): { owner: PublicKey; bulls: BullLeaf[]; nextCount: number } {
  const owner = deterministicOwner(ownerIndex);
  const bulls: BullLeaf[] = [];
  let c = startCount;
  for (let j = 0; j < count; j++) {
    const position = deterministicBull(ownerIndex, j);
    const power = BENCHMARK_POWERS[(ownerIndex + j) % BENCHMARK_POWERS.length];
    c++;
    bulls.push({
      position,
      positionId: BigInt(c),
      owner,
      buckPower: power,
      revealConfigVersion: 1n,
    });
  }
  return { owner, bulls, nextCount: c };
}

export function buildBullTreeForOwner(bulls: BullLeaf[]): SparseTree {
  const tree = new SparseTree(
    bullLeafToNode(emptyBullLeaf()),
    PREFIX_BULL_NODE,
  );
  for (const bull of bulls) {
    tree.insert(bull.position.toBuffer(), bullLeafToNode(bull));
  }
  return tree;
}

export interface BenchmarkOwnerTree {
  ownerTree: SparseTree;
  ownerBulls: Map<string, BullLeaf[]>;
  ownerList: PublicKey[];
  totalPower: bigint;
  totalCount: bigint;
}

export async function buildBenchmarkOwnerTree(scale: number): Promise<BenchmarkOwnerTree> {
  if (scale < 0) throw new Error("buildBenchmarkOwnerTree scale must be >= 0");

  const ownerTree = new SparseTree(
    ownerLeafToNode(emptyOwnerLeaf()),
    PREFIX_BULL_OWNER_NODE,
  );
  const ownerBulls = new Map<string, BullLeaf[]>();
  const ownerList: PublicKey[] = [];
  let totalCount = 0;
  let totalPower = 0n;
  let ownerIndex = 0;

  async function addOwner(count: number) {
    const { owner, bulls, nextCount } = buildBullsForOwner(
      ownerIndex,
      count,
      totalCount,
    );
    const bullTree = buildBullTreeForOwner(bulls);
    const bullRoot = bullTree.getRoot();
    const ownerLeaf: OwnerLeaf = {
      owner,
      activeBullCount: BigInt(bulls.length),
      totalBuckPower: bullRoot.power,
      bullTreeRoot: bullRoot.hash,
    };
    ownerTree.insert(owner.toBuffer(), ownerLeafToNode(ownerLeaf));
    ownerBulls.set(owner.toBase58(), bulls);
    ownerList.push(owner);
    totalCount = nextCount;
    totalPower += bullRoot.power;
    ownerIndex += 1;
    // Yield so long-running synchronous tree construction does not starve
    // the Vitest worker RPC loop (which otherwise trips the onTaskUpdate
    // heartbeat timeout for 100K-scale fixtures).
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const denseCount = scale >= 2000 ? 1000 : Math.floor(scale / 2);
  let remaining = scale - denseCount;

  if (denseCount > 0) await addOwner(denseCount);

  let patternIdx = 0;
  while (remaining > 0) {
    const wanted =
      BENCHMARK_BULL_DISTRIBUTION[
        patternIdx % BENCHMARK_BULL_DISTRIBUTION.length
      ];
    const count = Math.min(wanted, remaining);
    await addOwner(count);
    remaining -= count;
    patternIdx += 1;
  }

  return { ownerTree, ownerBulls, ownerList, totalPower, totalCount: BigInt(totalCount) };
}

export function findOwnerByPower(
  ownerTree: SparseTree,
  owners: PublicKey[],
  target: bigint,
): PublicKey {
  for (const owner of owners) {
    const proof = ownerTree.proof(owner.toBuffer());
    const prefix = sparseProofPrefix(
      owner.toBuffer(),
      proof,
      PREFIX_BULL_OWNER_NODE,
    );
    if (leafContainsTarget(prefix, proof.leaf.power, target)) {
      return owner;
    }
  }
  throw new Error(`No owner interval contains target ${target}`);
}

export function findBullByPower(
  bullTree: SparseTree,
  bulls: BullLeaf[],
  target: bigint,
): BullLeaf {
  for (const bull of bulls) {
    const proof = bullTree.proof(bull.position.toBuffer());
    const prefix = sparseProofPrefix(
      bull.position.toBuffer(),
      proof,
      PREFIX_BULL_NODE,
    );
    if (leafContainsTarget(prefix, proof.leaf.power, target)) {
      return bull;
    }
  }
  throw new Error(`No bull interval contains target ${target}`);
}

export function mapMintTheftFlag(
  randomOutput: Uint8Array,
  position: PublicKey,
  actionNonce: bigint,
): boolean {
  const draw = rejectionSampleDraw(
    { randomOutput, domain: RANDOMNESS_DOMAIN_MINT_THEFT, position, actionNonce },
    PROBABILITY_DENOMINATOR,
  );
  // V1 mint_theft_weights: [500_000, 9_500_000] -> index 0 is "theft"
  return draw < 500_000n;
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

/**
 * Build a full five-section mint-theft SettleReveal payload.
 * Sections: VICTIM_OWNER + SELECTED_OWNER + SELECTED_BULL + CURRENT_OWNER + CURRENT_BULL
 *
 * For J1 the selected owner is expected to exist in the current registry.
 * For J2 the selected owner may be absent and `currentRegistry` should omit it,
 * causing the helper to produce canonical empty owner/bull proofs.
 */
export function buildFullTheftRevealPayload(
  historicalRegistry: BuiltRegistry,
  currentRegistry: BuiltRegistry,
  victimOwner: PublicKey,
  selectedOwner: PublicKey,
  selectedBullPosition: PublicKey,
  newBull: BullLeaf,
): BullProofPayloadV1 {
  const vproof = ownerProof(historicalRegistry, victimOwner);
  const oproof = ownerProof(historicalRegistry, selectedOwner);
  const bproof = bullProof(historicalRegistry, selectedOwner, selectedBullPosition);
  const cOwnerProof = ownerProof(currentRegistry, newBull.owner);
  const cBullProof = bullProof(currentRegistry, newBull.owner, newBull.position);
  return {
    schemaVersion: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
    sectionBitmap:
      SECTION_VICTIM_OWNER |
      SECTION_SELECTED_OWNER |
      SECTION_SELECTED_BULL |
      SECTION_CURRENT_OWNER |
      SECTION_CURRENT_BULL,
    victimOwner: vproof,
    selectedOwner: oproof,
    selectedBull: bproof,
    currentOwner: cOwnerProof,
    currentBull: cBullProof,
    removeBull: null,
  };
}

/**
 * Build a Reveal payload that carries a victim section but no selected owner,
 * because the random draw did NOT trigger a mint-theft.
 * Sections: VICTIM_OWNER + CURRENT_OWNER + CURRENT_BULL
 */
export function buildRevealWithVictimPayload(
  historicalRegistry: BuiltRegistry,
  currentRegistry: BuiltRegistry,
  victimOwner: PublicKey,
  newBull: BullLeaf,
): BullProofPayloadV1 {
  const vproof = ownerProof(historicalRegistry, victimOwner);
  const oproof = ownerProof(currentRegistry, newBull.owner);
  const bproof = bullProof(currentRegistry, newBull.owner, newBull.position);
  return {
    schemaVersion: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
    sectionBitmap: SECTION_VICTIM_OWNER | SECTION_CURRENT_OWNER | SECTION_CURRENT_BULL,
    victimOwner: vproof,
    selectedOwner: null,
    selectedBull: null,
    currentOwner: oproof,
    currentBull: bproof,
    removeBull: null,
  };
}

export function leafContainsTarget(prefix: bigint, leafPower: bigint, target: bigint): boolean {
  return target >= prefix && target < prefix + leafPower;
}

export function skipVictimInterval(externalTarget: bigint, victimPrefix: bigint, victimPower: bigint): bigint {
  return externalTarget < victimPrefix ? externalTarget : externalTarget + victimPower;
}

/**
 * Recompute the cumulative prefix (power of all lexicographically smaller leaves)
 * for a given key from its compressed sparse proof.  The verification logic must
 * exactly mirror `verify_with_prefix` in `programs/rodeo_core/src/sparse_tree.rs`.
 */
export function sparseProofPrefix(
  key: Uint8Array,
  proof: CompressedSparseProof,
  prefixConstant: Buffer,
): bigint {
  const defaults = emptyNodesForPrefix(prefixConstant);
  let current = proof.leaf;
  let currentDefault = defaults[0];
  let prefix = 0n;
  let siblingIdx = 0;

  for (let h = 1; h <= SPARSE_TREE_DEPTH; h++) {
    const bitIndex = h - 1;
    const byteIndex = Math.floor(bitIndex / 8);
    const bitInByte = bitIndex % 8;
    const bit = ((key[byteIndex] >> bitInByte) & 1) === 1;
    const siblingIsNonDefault = (proof.bitmap[byteIndex] & (1 << bitInByte)) !== 0;
    const sibling = siblingIsNonDefault ? proof.siblings[siblingIdx++] : currentDefault;

    if (bit) {
      prefix += sibling.power;
    }

    const [left, right] = bit ? [sibling, current] : [current, sibling];
    current = hashNode(prefixConstant, left, right);
    currentDefault = defaults[h];
  }

  return prefix;
}

/**
 * Locate the owner whose power interval contains the given target.
 * The caller is responsible for ensuring `target` lies inside [0, totalPower).
 */
export function findOwnerByTarget(
  registry: BuiltRegistry,
  target: bigint,
  excludeOwner?: PublicKey,
): PublicKey {
  for (const entry of registry.entries) {
    if (excludeOwner && entry.owner.equals(excludeOwner)) continue;
    const oproof = ownerProof(registry, entry.owner);
    const prefix = sparseProofPrefix(entry.owner.toBuffer(), oproof.proof, PREFIX_BULL_OWNER_NODE);
    const power = oproof.proof.leaf.power;
    if (leafContainsTarget(prefix, power, target)) {
      return entry.owner;
    }
  }
  throw new Error(`No owner interval contains target ${target}`);
}

/**
 * Locate the bull whose power interval contains the given target inside an
 * owner's bull tree.
 */
export function findBullByTarget(
  registry: BuiltRegistry,
  owner: PublicKey,
  target: bigint,
): BullLeaf {
  const entry = registry.entries.find((e) => e.owner.equals(owner));
  if (!entry) throw new Error(`Owner ${owner.toBase58()} not in registry`);
  for (const bull of entry.bulls) {
    const bproof = bullProof(registry, owner, bull.position);
    const prefix = sparseProofPrefix(bull.position.toBuffer(), bproof.proof, PREFIX_BULL_NODE);
    const power = bproof.proof.leaf.power;
    if (leafContainsTarget(prefix, power, target)) {
      return bull;
    }
  }
  throw new Error(`No bull interval contains target ${target} for owner ${owner.toBase58()}`);
}
