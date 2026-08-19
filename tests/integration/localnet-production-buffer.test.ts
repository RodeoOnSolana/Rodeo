import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Idl } from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, setProvider, web3 } from "@coral-xyz/anchor";
import {
  AuthorityType,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getMint,
  mintTo,
  setAuthority,
} from "@solana/spl-token";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveBullProofBufferPda, deriveBullRegistryPda } from "./bull-registry-tracker.js";

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new web3.PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

const MPL_CORE_PROGRAM_ID = new web3.PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
);

const BULL_PROOF_BUFFER_PAYLOAD_OFFSET = 194;
const BULL_PROOF_BUFFER_ONE_SHOT_MAX_PAYLOAD = 10_240 - BULL_PROOF_BUFFER_PAYLOAD_OFFSET;
const BULL_PROOF_BUFFER_MAX_PAYLOAD = 16_384;
const BULL_PROOF_BUFFER_EXPAND_MAX_DELTA = 10_240;

const localnetAvailable = Boolean(process.env.ANCHOR_PROVIDER_URL && process.env.ANCHOR_WALLET);
const root = resolve(import.meta.dirname, "../..");

function loadIdl(name: string): Idl {
  const path = resolve(root, "target/idl", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Idl;
}

function programDataAddress(programId: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  )[0];
}

function derivePosition(
  programId: web3.PublicKey,
  globalConfig: web3.PublicKey,
  positionId: BN,
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("position"), globalConfig.toBuffer(), positionId.toArrayLike(Buffer, "le", 8)],
    programId,
  );
}

function deriveRandomness(
  programId: web3.PublicKey,
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
    programId,
  );
}

function deriveProtocolConfig(
  programId: web3.PublicKey,
  globalConfig: web3.PublicKey,
  configVersion: BN,
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("protocol-config"),
      globalConfig.toBuffer(),
      configVersion.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  );
}

function deriveStakeAccounts(
  programId: web3.PublicKey,
  globalConfig: web3.PublicKey,
  positionId: BN,
) {
  const [position] = derivePosition(programId, globalConfig, positionId);
  const [pendingRandomness] = deriveRandomness(programId, position, 0, new BN(0));
  return { position, pendingRandomness };
}

function patchProviderForHttpConfirmation(provider: AnchorProvider) {
  const connection = provider.connection;
  const COMMITMENT_ORDER: Record<string, number> = {
    processed: 0,
    confirmed: 1,
    finalized: 2,
  };
  connection.confirmTransaction = async (
    signatureOrStrategy: web3.TransactionSignature | web3.TransactionConfirmationStrategy,
    commitment?: web3.Commitment,
  ): Promise<web3.RpcResponseAndContext<web3.SignatureStatus>> => {
    const pollForSignature = async (
      signature: string,
    ): Promise<web3.RpcResponseAndContext<web3.SignatureStatus>> => {
      const targetCommitment = commitment ?? (connection.commitment as web3.Commitment) ?? "finalized";
      const targetOrder = COMMITMENT_ORDER[targetCommitment] ?? 2;
      for (let attempt = 0; attempt < 120; attempt++) {
        const status = await connection.getSignatureStatus(signature);
        if (
          status.value?.confirmations !== null &&
          status.value?.confirmationStatus !== undefined
        ) {
          const currentOrder = COMMITMENT_ORDER[status.value.confirmationStatus] ?? 0;
          if (currentOrder >= targetOrder) {
            return status as unknown as web3.RpcResponseAndContext<web3.SignatureStatus>;
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`Transaction not confirmed: ${signature}`);
    };
    if (typeof signatureOrStrategy === "string") {
      return pollForSignature(signatureOrStrategy);
    }
    return pollForSignature(signatureOrStrategy.signature);
  };
}

async function revokeMintAuthorities(
  connection: web3.Connection,
  payer: web3.Keypair,
  mint: web3.PublicKey,
) {
  await setAuthority(connection, payer, mint, payer, AuthorityType.MintTokens, null);
  const freezeAuthority = (await getMint(connection, mint)).freezeAuthority;
  if (freezeAuthority !== null) {
    await setAuthority(connection, payer, mint, payer, AuthorityType.FreezeAccount, null);
  }
}

describe.skipIf(!localnetAvailable)("Production-size BullProofBuffer (16 KiB)", () => {
  let provider: AnchorProvider;
  let payer: web3.Keypair;
  let rodeoCoreProgram: Program<Idl>;

  let rodeoMint: web3.PublicKey;
  let ansemMint: web3.PublicKey;
  let payerRodeoAccount: web3.PublicKey;
  let payerAnsemAccount: web3.PublicKey;

  const upgradeCouncil = web3.Keypair.generate();
  const treasuryCouncil = web3.Keypair.generate();
  const emergencyGuardians = web3.Keypair.generate();

  let globalConfig: web3.PublicKey;
  let principalVault: web3.PublicKey;
  let rewardVault: web3.PublicKey;
  let rewardState: web3.PublicKey;
  let globalGameState: web3.PublicKey;
  let bullAccumulator: web3.PublicKey;
  let bullRegistry: web3.PublicKey;
  let protocolConfig: web3.PublicKey;
  let receiptCollection: web3.PublicKey;
  let receiptAuthority: web3.PublicKey;

  const stakeAmountAtomic = new BN(100_000_000_000);
  const expectedTotalSupplyAtomic = new BN(1_000_000_000_000_000);

  beforeAll(async () => {
    provider = AnchorProvider.env();
    setProvider(provider);
    patchProviderForHttpConfirmation(provider);
    payer = (provider.wallet as unknown as { payer: web3.Keypair }).payer;

    rodeoCoreProgram = new Program<Idl>(loadIdl("rodeo_core"), provider);

    rodeoMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    ansemMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

    [globalConfig] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      rodeoCoreProgram.programId,
    );
    [principalVault] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("principal-vault")],
      rodeoCoreProgram.programId,
    );
    [rewardVault] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward-vault")],
      rodeoCoreProgram.programId,
    );
    [rewardState] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward-state"), globalConfig.toBuffer()],
      rodeoCoreProgram.programId,
    );
    [globalGameState] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global-game-state"), globalConfig.toBuffer()],
      rodeoCoreProgram.programId,
    );
    [bullAccumulator] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bull-accumulator"), globalConfig.toBuffer()],
      rodeoCoreProgram.programId,
    );
    [receiptCollection] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-collection"), globalConfig.toBuffer()],
      rodeoCoreProgram.programId,
    );
    [receiptAuthority] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-authority"), globalConfig.toBuffer()],
      rodeoCoreProgram.programId,
    );
    [bullRegistry] = deriveBullRegistryPda(rodeoCoreProgram.programId, globalConfig);

    payerRodeoAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      rodeoMint,
      payer.publicKey,
    );
    payerAnsemAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      ansemMint,
      payer.publicKey,
    );

    await mintTo(
      provider.connection,
      payer,
      rodeoMint,
      payerRodeoAccount,
      payer,
      BigInt(expectedTotalSupplyAtomic.toString()),
    );
    await mintTo(
      provider.connection,
      payer,
      ansemMint,
      payerAnsemAccount,
      payer,
      2_000_000_000_000_000n,
    );
    await revokeMintAuthorities(provider.connection, payer, rodeoMint);
    await revokeMintAuthorities(provider.connection, payer, ansemMint);

    const programData = programDataAddress(rodeoCoreProgram.programId);
    [protocolConfig] = deriveProtocolConfig(rodeoCoreProgram.programId, globalConfig, new BN(1));

    await rodeoCoreProgram.methods
      .initializeProtocol(
        upgradeCouncil.publicKey,
        treasuryCouncil.publicKey,
        emergencyGuardians.publicKey,
      )
      .accounts({
        payer: payer.publicKey,
        initializer: provider.wallet.publicKey,
        program: rodeoCoreProgram.programId,
        programData,
        rodeoMint,
        ansemMint,
        globalConfig,
        rewardState,
        globalGameState,
        bullAccumulator,
        principalVault,
        rewardVault,
        protocolConfig,
        receiptCollection,
        receiptAuthority,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
  }, 90_000);

  async function stakeAndCommit(positionId: BN) {
    const { position, pendingRandomness } = deriveStakeAccounts(
      rodeoCoreProgram.programId,
      globalConfig,
      positionId,
    );
    const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-funder"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );

    await rodeoCoreProgram.methods
      .stakeAndCommit(positionId, stakeAmountAtomic)
      .accounts({
        owner: payer.publicKey,
        ownerRodeoTokenAccount: payerRodeoAccount,
        globalConfig,
        protocolConfig,
        principalVault,
        position,
        pendingRandomness,
        rewardState,
        globalGameState,
        receiptFunder,
        providerRandomnessAccount: web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    return { position, pendingRandomness };
  }

  it("initializes and expands a production-size 16,384-byte BullProofBuffer via real SBF instructions", async () => {
    const positionId = new BN(0);
    const { position, pendingRandomness } = await stakeAndCommit(positionId);

    const nonce = new BN(1);
    const [bufferPda] = deriveBullProofBufferPda(
      rodeoCoreProgram.programId,
      pendingRandomness,
      payer.publicKey,
      nonce,
    );

    // The one-shot init allocates only up to the runtime per-CPI realloc limit
    // (10,240 bytes of account data), even though the logical payload cap is
    // 16,384 bytes. The buffer must then be expanded to its full size.
    const initAccountDataBytes = BULL_PROOF_BUFFER_PAYLOAD_OFFSET + BULL_PROOF_BUFFER_ONE_SHOT_MAX_PAYLOAD;
    const fullAccountDataBytes = BULL_PROOF_BUFFER_PAYLOAD_OFFSET + BULL_PROOF_BUFFER_MAX_PAYLOAD;
    const fullRent = await provider.connection.getMinimumBalanceForRentExemption(fullAccountDataBytes);
    const airdropSig = await provider.connection.requestAirdrop(
      payer.publicKey,
      fullRent + 500_000_000,
    );
    await provider.connection.confirmTransaction(airdropSig);

    await rodeoCoreProgram.methods
      .initializeBullProof({ reveal: {} }, BULL_PROOF_BUFFER_MAX_PAYLOAD, nonce)
      .accounts({
        prover: payer.publicKey,
        globalConfig,
        position,
        pendingRandomness,
        bullProofBuffer: bufferPda,
        bullRegistry,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    let info = await provider.connection.getAccountInfo(bufferPda);
    expect(info).not.toBeNull();
    expect(info!.data.length).toBe(initAccountDataBytes);

    await rodeoCoreProgram.methods
      .expandBullProofBuffer(nonce)
      .accounts({
        prover: payer.publicKey,
        pendingRandomness,
        bullProofBuffer: bufferPda,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    info = await provider.connection.getAccountInfo(bufferPda);
    expect(info).not.toBeNull();

    console.log({
      oneShotAccountDataBytes: initAccountDataBytes,
      fullAccountDataBytes,
      actualAccountDataBytes: info!.data.length,
      expectedPayloadCapacity: BULL_PROOF_BUFFER_MAX_PAYLOAD,
      fixedHeaderBytes: BULL_PROOF_BUFFER_PAYLOAD_OFFSET,
      actualLamports: info!.lamports,
      fullRentExempt: fullRent,
    });

    expect(info!.data.length).toBe(fullAccountDataBytes);
    expect(info!.lamports).toBe(fullRent);
  }, 120_000);
});
