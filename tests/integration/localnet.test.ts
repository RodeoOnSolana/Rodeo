import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Idl } from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, setProvider, web3 } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import { beforeAll, describe, expect, it } from "vitest";

const localnetAvailable = Boolean(process.env.ANCHOR_PROVIDER_URL && process.env.ANCHOR_WALLET);
const root = resolve(import.meta.dirname, "../..");

function loadIdl(name: string): Idl {
  const path = resolve(root, "target/idl", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Idl;
}

const expectedProgramIds = {
  RodeoCore: "EkEPd5wXSi3NQUHewx64cP27tDQ6uTcK5poG6AuWmy8Z",
  RodeoMarket: "9vhrgTdridvE1uuxPenqDW9RVKdu3A5Dc2DzKVbaew8n",
  RodeoRouter: "CFQUWHE88YWrtnu9yADgEAB1MrPAYvdAjUbRwbTLafxD",
} as const;

// Mirrors the on-chain `ActionType` discriminants in programs/rodeo_core/src/lib.rs.
const ACTION_TYPE = {
  reveal: 0,
  unstake: 1,
} as const;

describe.skipIf(!localnetAvailable)("Anchor localnet workspace", () => {
  let provider: AnchorProvider;
  let payer: web3.Keypair;
  const programs = {} as Record<keyof typeof expectedProgramIds, Program>;

  let rodeoMint: web3.PublicKey;
  let globalConfig: web3.PublicKey;
  let principalVault: web3.PublicKey;
  let rewardVault: web3.PublicKey;
  let ownerRodeoAccount: web3.PublicKey;
  let nextPositionId = 1;

  function derivePosition(positionId: BN): [web3.PublicKey, number] {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), globalConfig.toBuffer(), positionId.toArrayLike(Buffer, "le", 8)],
      programs.RodeoCore.programId,
    );
  }

  function deriveRandomness(
    position: web3.PublicKey,
    actionType: number,
    actionNonce: BN,
  ): [web3.PublicKey, number] {
    return web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("randomness"),
        position.toBuffer(),
        Buffer.from([actionType]),
        actionNonce.toArrayLike(Buffer, "le", 8),
      ],
      programs.RodeoCore.programId,
    );
  }

  async function openPosition(principalAmount: bigint) {
    const program = programs.RodeoCore;
    const positionId = new BN(nextPositionId++);
    const [position] = derivePosition(positionId);
    const [pendingRandomness] = deriveRandomness(position, ACTION_TYPE.reveal, new BN(0));
    const secret = randomBytes(32);
    const commitment = createHash("sha256").update(secret).digest();

    await program.methods
      .stakeAndCommit(positionId, new BN(principalAmount.toString()), [...commitment])
      .accounts({
        owner: payer.publicKey,
        globalConfig,
        rodeoMint,
        ownerRodeoAccount,
        principalVault,
        position,
        pendingRandomness,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    return { positionId, position, pendingRandomness, secret, commitment };
  }

  function reveal(position: web3.PublicKey, pendingRandomness: web3.PublicKey, secret: Uint8Array) {
    return programs.RodeoCore.methods
      .mockReveal([...secret])
      .accounts({
        owner: payer.publicKey,
        globalConfig,
        position,
        pendingRandomness,
      })
      .rpc();
  }

  beforeAll(async () => {
    provider = AnchorProvider.env();
    setProvider(provider);
    payer = (provider.wallet as unknown as { payer: web3.Keypair }).payer;

    programs.RodeoCore = new Program(loadIdl("rodeo_core"), provider);
    programs.RodeoMarket = new Program(loadIdl("rodeo_market"), provider);
    programs.RodeoRouter = new Program(loadIdl("rodeo_router"), provider);

    if (!localnetAvailable) return;

    const ansemMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    rodeoMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

    [globalConfig] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      programs.RodeoCore.programId,
    );
    [principalVault] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("principal-vault")],
      programs.RodeoCore.programId,
    );
    [rewardVault] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward-vault")],
      programs.RodeoCore.programId,
    );

    await programs.RodeoCore.methods
      .initializeConfig()
      .accounts({
        payer: payer.publicKey,
        rodeoMint,
        ansemMint,
        globalConfig,
        principalVault,
        rewardVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    ownerRodeoAccount = await createAssociatedTokenAccount(provider.connection, payer, rodeoMint, payer.publicKey);
    await mintTo(provider.connection, payer, rodeoMint, ownerRodeoAccount, payer, 1_000_000_000n);
  });

  it("deploys all Phase 0 program boundaries under the pinned IDs", async () => {
    for (const [name, expectedId] of Object.entries(expectedProgramIds)) {
      const program = programs[name as keyof typeof expectedProgramIds];
      expect(program.programId.toBase58()).toBe(expectedId);
      expect(await provider.connection.getAccountInfo(program.programId)).not.toBeNull();
    }
  }, 30_000);

  it("derives Position from global_config and position_id, stakes, commits, reveals once, and rejects a duplicate reveal", async () => {
    const accounts = programs.RodeoCore.account as unknown as {
      position: { fetch(address: web3.PublicKey): Promise<any> };
      pendingRandomness: { fetch(address: web3.PublicKey): Promise<any> };
    };

    const principalAmount = 25_000_000n;
    const { positionId, position, pendingRandomness, secret, commitment } = await openPosition(principalAmount);

    const [expectedPosition] = derivePosition(positionId);
    expect(position.toBase58()).toBe(expectedPosition.toBase58());

    // This is the first stake in the suite, so the vault holds exactly this deposit.
    const vaultBefore = await getAccount(provider.connection, principalVault);
    expect(vaultBefore.amount).toBe(principalAmount);

    const pendingAfterStake = await accounts.pendingRandomness.fetch(pendingRandomness);
    expect(Buffer.from(pendingAfterStake.commitment)).toEqual(commitment);
    expect(pendingAfterStake.settled).toBe(false);
    expect(pendingAfterStake.actionNonce.toString()).toBe("0");
    expect(pendingAfterStake.actionType).toHaveProperty("reveal");

    await expect(reveal(position, pendingRandomness, randomBytes(32))).rejects.toThrow();

    await reveal(position, pendingRandomness, secret);

    const revealedPosition = await accounts.position.fetch(position);
    const revealedPending = await accounts.pendingRandomness.fetch(pendingRandomness);
    expect(revealedPending.settled).toBe(true);
    expect(revealedPosition.settlementNonce.toString()).toBe("1");
    expect(revealedPosition.status).toHaveProperty("active");
    expect(revealedPosition.pendingActionActive).toBe(false);
    expect(Buffer.from(revealedPosition.mockRandomness).equals(Buffer.alloc(32))).toBe(false);

    await expect(reveal(position, pendingRandomness, secret)).rejects.toThrow();
  }, 30_000);

  it("changes Position ownership without changing the Position PDA and revokes the previous owner's authority", async () => {
    const accounts = programs.RodeoCore.account as unknown as {
      position: { fetch(address: web3.PublicKey): Promise<any> };
    };
    const { positionId, position, pendingRandomness, secret } = await openPosition(1_000_000n);
    await reveal(position, pendingRandomness, secret);

    const [pdaBeforeTransfer] = derivePosition(positionId);
    const newOwner = web3.Keypair.generate();

    await programs.RodeoCore.methods
      .transferPosition(newOwner.publicKey)
      .accounts({ owner: payer.publicKey, position })
      .rpc();

    const afterTransfer = await accounts.position.fetch(position);
    expect(afterTransfer.owner.toBase58()).toBe(newOwner.publicKey.toBase58());

    const [pdaAfterTransfer] = derivePosition(positionId);
    expect(pdaAfterTransfer.toBase58()).toBe(pdaBeforeTransfer.toBase58());
    expect(position.toBase58()).toBe(pdaAfterTransfer.toBase58());

    // The previous owner is no longer authorized to act on the position.
    await expect(
      programs.RodeoCore.methods
        .transferPosition(payer.publicKey)
        .accounts({ owner: payer.publicKey, position })
        .rpc(),
    ).rejects.toThrow();

    // The new owner is authorized.
    await programs.RodeoCore.methods
      .transferPosition(payer.publicKey)
      .accounts({ owner: newOwner.publicKey, position })
      .signers([newOwner])
      .rpc();

    const afterReturn = await accounts.position.fetch(position);
    expect(afterReturn.owner.toBase58()).toBe(payer.publicKey.toBase58());
  }, 30_000);

  it("blocks transferring a position with a pending random action until it is resolved through reveal", async () => {
    const accounts = programs.RodeoCore.account as unknown as {
      position: { fetch(address: web3.PublicKey): Promise<any> };
    };
    const { position, pendingRandomness, secret } = await openPosition(1_000_000n);
    const newOwner = web3.Keypair.generate();

    await expect(
      programs.RodeoCore.methods
        .transferPosition(newOwner.publicKey)
        .accounts({ owner: payer.publicKey, position })
        .rpc(),
    ).rejects.toThrow();

    await reveal(position, pendingRandomness, secret);

    await programs.RodeoCore.methods
      .transferPosition(newOwner.publicKey)
      .accounts({ owner: payer.publicKey, position })
      .rpc();

    const afterTransfer = await accounts.position.fetch(position);
    expect(afterTransfer.owner.toBase58()).toBe(newOwner.publicKey.toBase58());
  }, 30_000);

  it("rejects settling a randomness request against a different position", async () => {
    const positionA = await openPosition(1_000_000n);
    const positionB = await openPosition(1_000_000n);

    await expect(reveal(positionA.position, positionB.pendingRandomness, positionA.secret)).rejects.toThrow();
    await expect(reveal(positionB.position, positionA.pendingRandomness, positionB.secret)).rejects.toThrow();

    // Both positions remain independently revealable afterwards.
    await reveal(positionA.position, positionA.pendingRandomness, positionA.secret);
    await reveal(positionB.position, positionB.pendingRandomness, positionB.secret);
  }, 30_000);

  it("rejects settling a randomness request with the wrong action type", async () => {
    const { position, pendingRandomness, secret } = await openPosition(1_000_000n);
    const [wrongTypeAddress] = deriveRandomness(position, ACTION_TYPE.unstake, new BN(0));

    await expect(reveal(position, wrongTypeAddress, secret)).rejects.toThrow();

    await reveal(position, pendingRandomness, secret);
  }, 30_000);

  it("rejects settling a randomness request with the wrong nonce", async () => {
    const { position, pendingRandomness, secret } = await openPosition(1_000_000n);
    const [wrongNonceAddress] = deriveRandomness(position, ACTION_TYPE.reveal, new BN(1));

    await expect(reveal(position, wrongNonceAddress, secret)).rejects.toThrow();

    await reveal(position, pendingRandomness, secret);
  }, 30_000);
});
