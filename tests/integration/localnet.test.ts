import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnchorProvider, BN, Idl, Program, setProvider, web3 } from "@coral-xyz/anchor";
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

describe.skipIf(!localnetAvailable)("Anchor localnet workspace", () => {
  let provider: AnchorProvider;
  let payer: web3.Keypair;
  const programs = {} as Record<keyof typeof expectedProgramIds, Program>;

  beforeAll(() => {
    provider = AnchorProvider.env();
    setProvider(provider);
    payer = (provider.wallet as unknown as { payer: web3.Keypair }).payer;

    programs.RodeoCore = new Program(
      loadIdl("rodeo_core"),
      new web3.PublicKey(expectedProgramIds.RodeoCore),
      provider,
    );
    programs.RodeoMarket = new Program(
      loadIdl("rodeo_market"),
      new web3.PublicKey(expectedProgramIds.RodeoMarket),
      provider,
    );
    programs.RodeoRouter = new Program(
      loadIdl("rodeo_router"),
      new web3.PublicKey(expectedProgramIds.RodeoRouter),
      provider,
    );
  });

  it("deploys all Phase 0 program boundaries under the pinned IDs", async () => {
    for (const [name, expectedId] of Object.entries(expectedProgramIds)) {
      const program = programs[name as keyof typeof expectedProgramIds];
      expect(program.programId.toBase58()).toBe(expectedId);
      expect(await provider.connection.getAccountInfo(program.programId)).not.toBeNull();
    }
  }, 30_000);

  it("stakes, enforces the commitment, reveals once, and rejects duplicate reveal", async () => {
    const program = programs.RodeoCore;
    const accounts = program.account as unknown as {
      position: { fetch(address: web3.PublicKey): Promise<any> };
      pendingRandomness: { fetch(address: web3.PublicKey): Promise<any> };
    };
    const rodeoMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const ansemMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const [globalConfig] = web3.PublicKey.findProgramAddressSync([Buffer.from("global-config")], program.programId);
    const [principalVault] = web3.PublicKey.findProgramAddressSync([Buffer.from("principal-vault")], program.programId);
    const [rewardVault] = web3.PublicKey.findProgramAddressSync([Buffer.from("reward-vault")], program.programId);

    await program.methods.initializeConfig().accounts({
      payer: payer.publicKey,
      rodeoMint,
      ansemMint,
      globalConfig,
      principalVault,
      rewardVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
      rent: web3.SYSVAR_RENT_PUBKEY,
    }).rpc();

    const ownerRodeoAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      rodeoMint,
      payer.publicKey,
    );
    const principalAmount = 25_000_000n;
    await mintTo(provider.connection, payer, rodeoMint, ownerRodeoAccount, payer, principalAmount);

    const positionId = new BN(1);
    const [position] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), payer.publicKey.toBuffer(), positionId.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );
    const [pendingRandomness] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pending-randomness"), position.toBuffer()],
      program.programId,
    );
    const secret = randomBytes(32);
    const commitment = createHash("sha256").update(secret).digest();

    await program.methods.stakeAndCommit(positionId, new BN(principalAmount.toString()), [...commitment]).accounts({
      owner: payer.publicKey,
      globalConfig,
      rodeoMint,
      ownerRodeoAccount,
      principalVault,
      position,
      pendingRandomness,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
    }).rpc();

    const vault = await getAccount(provider.connection, principalVault);
    const pendingAfterStake = await accounts.pendingRandomness.fetch(pendingRandomness);
    expect(vault.amount).toBe(principalAmount);
    expect(Buffer.from(pendingAfterStake.commitment)).toEqual(commitment);
    expect(pendingAfterStake.settled).toBe(false);

    await expect(program.methods.mockReveal([...randomBytes(32)]).accounts({
      owner: payer.publicKey,
      position,
      pendingRandomness,
    }).rpc()).rejects.toThrow();

    await program.methods.mockReveal([...secret]).accounts({
      owner: payer.publicKey,
      position,
      pendingRandomness,
    }).rpc();

    const revealedPosition = await accounts.position.fetch(position);
    const revealedPending = await accounts.pendingRandomness.fetch(pendingRandomness);
    expect(revealedPending.settled).toBe(true);
    expect(revealedPosition.settlementNonce.toString()).toBe("1");
    expect(revealedPosition.status).toHaveProperty("active");
    expect(Buffer.from(revealedPosition.mockRandomness).equals(Buffer.alloc(32))).toBe(false);

    await expect(program.methods.mockReveal([...secret]).accounts({
      owner: payer.publicKey,
      position,
      pendingRandomness,
    }).rpc()).rejects.toThrow();
  }, 30_000);
});
