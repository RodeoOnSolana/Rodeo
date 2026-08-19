import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { web3 } from "@coral-xyz/anchor";
import {
  emptyBullTreeRoot,
  emptyOwnerTreeRoot,
  emptyBullLeaf,
  emptyOwnerLeaf,
  bullLeafToNode,
  ownerLeafToNode,
  buildRegistry,
  ownerProof,
  bullProof,
  buildRevealPayload,
  buildUnstakePayload,
  serializeBullProofPayload,
  BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
  SECTION_CURRENT_OWNER,
  SECTION_CURRENT_BULL,
  SECTION_REMOVE_BULL,
  type BullLeaf,
  type RegistryEntry,
} from "./sparse-tree.js";

const { PublicKey } = web3;

describe("sparse-tree empty roots match Rust vectors", () => {
  it("bull empty tree root matches", () => {
    const root = emptyBullTreeRoot();
    const expected = Buffer.from(
      "269a9cb55bcaaa36e148dd4756cf592c885bfde6d673c5d85a5fac36c795900a",
      "hex",
    );
    expect(Buffer.from(root).equals(expected)).toBe(true);
  });

  it("owner empty tree root matches", () => {
    const root = emptyOwnerTreeRoot();
    const expected = Buffer.from(
      "fc9d820da617ac19826763348201ab5fa6d3e87dcdcc0c5f249158e0be228ff1",
      "hex",
    );
    expect(Buffer.from(root).equals(expected)).toBe(true);
  });

  it("bull empty leaf hash matches", () => {
    const leaf = emptyBullLeaf();
    const node = bullLeafToNode(leaf);
    const expected = Buffer.from(
      "6ff60ba69cde96cd1edd1543e8eee777fb455d347f10b6d71f9ddeefa29b17bb",
      "hex",
    );
    expect(Buffer.from(node.hash).equals(expected)).toBe(true);
  });

  it("owner empty leaf hash matches", () => {
    const leaf = emptyOwnerLeaf();
    const node = ownerLeafToNode(leaf);
    const expected = Buffer.from(
      "e17d9492c0d38c157d68fde9bb55dcbf707cf2eafeadd7489541b241858707f4",
      "hex",
    );
    expect(Buffer.from(node.hash).equals(expected)).toBe(true);
  });
});

describe("sparse-tree registry construction", () => {
  it("empty registry root matches empty owner tree root", () => {
    const registry = buildRegistry([]);
    expect(Buffer.from(registry.rootNode.hash).equals(
      Buffer.from(emptyOwnerTreeRoot()),
    )).toBe(true);
    expect(registry.rootNode.count).toBe(0n);
    expect(registry.rootNode.power).toBe(0n);
  });

  it("single owner single bull registry has correct root", () => {
    const owner = PublicKey.unique();
    const position = PublicKey.unique();
    const bull: BullLeaf = {
      position,
      positionId: 1n,
      owner,
      buckPower: 4,
      revealConfigVersion: 1n,
    };
    const entries: RegistryEntry[] = [{ owner, bulls: [bull] }];
    const registry = buildRegistry(entries);

    expect(registry.rootNode.count).toBe(1n);
    expect(registry.rootNode.power).toBe(4n);
  });

  it("owner proof for existing owner returns correct leaf", () => {
    const owner = PublicKey.unique();
    const position = PublicKey.unique();
    const bull: BullLeaf = {
      position,
      positionId: 1n,
      owner,
      buckPower: 6,
      revealConfigVersion: 1n,
    };
    const entries: RegistryEntry[] = [{ owner, bulls: [bull] }];
    const registry = buildRegistry(entries);

    const proof = ownerProof(registry, owner);
    expect(proof.leaf.owner.equals(owner)).toBe(true);
    expect(proof.leaf.activeBullCount).toBe(1n);
    expect(proof.leaf.totalBuckPower).toBe(6n);
  });

  it("owner proof for absent owner returns empty leaf", () => {
    const owner = PublicKey.unique();
    const position = PublicKey.unique();
    const bull: BullLeaf = {
      position,
      positionId: 1n,
      owner,
      buckPower: 4,
      revealConfigVersion: 1n,
    };
    const entries: RegistryEntry[] = [{ owner, bulls: [bull] }];
    const registry = buildRegistry(entries);

    const absent = PublicKey.unique();
    const proof = ownerProof(registry, absent);
    expect(proof.leaf.owner.equals(PublicKey.default)).toBe(true);
    expect(proof.leaf.activeBullCount).toBe(0n);
  });

  it("bull proof for existing bull returns correct leaf", () => {
    const owner = PublicKey.unique();
    const position = PublicKey.unique();
    const bull: BullLeaf = {
      position,
      positionId: 1n,
      owner,
      buckPower: 8,
      revealConfigVersion: 1n,
    };
    const entries: RegistryEntry[] = [{ owner, bulls: [bull] }];
    const registry = buildRegistry(entries);

    const proof = bullProof(registry, owner, position);
    expect(proof.leaf.position.equals(position)).toBe(true);
    expect(proof.leaf.buckPower).toBe(8);
  });

  it("bull proof for absent bull returns empty leaf", () => {
    const owner = PublicKey.unique();
    const position = PublicKey.unique();
    const bull: BullLeaf = {
      position,
      positionId: 1n,
      owner,
      buckPower: 8,
      revealConfigVersion: 1n,
    };
    const entries: RegistryEntry[] = [{ owner, bulls: [bull] }];
    const registry = buildRegistry(entries);

    const absentPosition = PublicKey.unique();
    const proof = bullProof(registry, owner, absentPosition);
    expect(proof.leaf.position.equals(PublicKey.default)).toBe(true);
  });
});

describe("sparse-tree payload serialization", () => {
  it("reveal payload has correct section bitmap", () => {
    const owner = PublicKey.unique();
    const position = PublicKey.unique();
    const bull: BullLeaf = {
      position,
      positionId: 1n,
      owner,
      buckPower: 4,
      revealConfigVersion: 1n,
    };
    const entries: RegistryEntry[] = [{ owner, bulls: [bull] }];
    const registry = buildRegistry(entries);

    const newBull: BullLeaf = {
      position: PublicKey.unique(),
      positionId: 2n,
      owner,
      buckPower: 6,
      revealConfigVersion: 1n,
    };
    const payload = buildRevealPayload(registry, newBull);
    expect(payload.schemaVersion).toBe(BULL_PROOF_PAYLOAD_SCHEMA_VERSION);
    expect(payload.sectionBitmap).toBe(SECTION_CURRENT_OWNER | SECTION_CURRENT_BULL);
  });

  it("unstake payload has correct section bitmap", () => {
    const owner = PublicKey.unique();
    const position = PublicKey.unique();
    const bull: BullLeaf = {
      position,
      positionId: 1n,
      owner,
      buckPower: 4,
      revealConfigVersion: 1n,
    };
    const entries: RegistryEntry[] = [{ owner, bulls: [bull] }];
    const registry = buildRegistry(entries);

    const payload = buildUnstakePayload(registry, owner, position);
    expect(payload.schemaVersion).toBe(BULL_PROOF_PAYLOAD_SCHEMA_VERSION);
    expect(payload.sectionBitmap).toBe(SECTION_CURRENT_OWNER | SECTION_REMOVE_BULL);
  });

  it("serialized payload starts with schema version 2", () => {
    const owner = PublicKey.unique();
    const position = PublicKey.unique();
    const bull: BullLeaf = {
      position,
      positionId: 1n,
      owner,
      buckPower: 4,
      revealConfigVersion: 1n,
    };
    const entries: RegistryEntry[] = [{ owner, bulls: [bull] }];
    const registry = buildRegistry(entries);

    const payload = buildUnstakePayload(registry, owner, position);
    const bytes = serializeBullProofPayload(payload);
    expect(bytes[0]).toBe(2); // schema_version
    expect(bytes[1]).toBe(SECTION_CURRENT_OWNER | SECTION_REMOVE_BULL); // section_bitmap
  });
});
