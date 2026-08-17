import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Idl } from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, setProvider, web3 } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccount,
  createMint,
  getAssociatedTokenAddressSync,
  mintTo,
  setAuthority,
  AuthorityType,
  TOKEN_PROGRAM_ID,
  getMint,
} from "@solana/spl-token";
import * as sb from "@switchboard-xyz/on-demand";
import { beforeAll, describe, expect, it } from "vitest";

const DEVNET_RPC = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
const DEVNET_CORE_PROGRAM_ID = process.env.RODEO_DEVNET_CORE_PROGRAM_ID
  ? new web3.PublicKey(process.env.RODEO_DEVNET_CORE_PROGRAM_ID)
  : undefined;
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new web3.PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const MPL_CORE_PROGRAM_ID = new web3.PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
);

const skipSuite = !process.env.RODEO_DEVNET_SWITCHBOARD_TEST;

async function sendIx(
  provider: AnchorProvider,
  ix: web3.TransactionInstruction,
  signers: web3.Keypair[],
): Promise<web3.TransactionSignature> {
  const commitment: web3.Commitment = "confirmed";
  const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash(commitment);
  const tx = new web3.Transaction().add(ix);
  tx.feePayer = provider.wallet.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  const sig = await provider.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });
  await provider.connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    commitment,
  );
  const status = await provider.connection.getSignatureStatus(sig);
  if (status.value?.err) {
    const txInfo = await provider.connection.getTransaction(sig, { commitment: "confirmed" });
    console.error("FAILED TX LOGS:", txInfo?.meta?.logMessages ?? []);
    throw new Error(`Transaction ${sig} failed: ${JSON.stringify(status.value.err)}`);
  }
  return sig;
}

function loadIdl(name: string): Idl {
  const root = resolve(import.meta.dirname, "../..");
  const path = resolve(root, "target/idl", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Idl;
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

function programDataAddress(programId: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  )[0];
}

describe.skipIf(skipSuite)("Rodeo devnet Switchboard On-Demand randomness", () => {
  let provider: AnchorProvider;
  let payer: web3.Keypair;
  let sbProgram: Program<Idl>;
  let queue: sb.Queue;
  let rodeoCoreProgram: Program<Idl>;

  let rodeoMint: web3.PublicKey;
  let ansemMint: web3.PublicKey;
  let payerRodeoAccount: web3.PublicKey;

  let globalConfig: web3.PublicKey;
  let principalVault: web3.PublicKey;
  let rewardVault: web3.PublicKey;
  let rewardState: web3.PublicKey;
  let globalGameState: web3.PublicKey;
  let bullAccumulator: web3.PublicKey;
  let bullRegistry: web3.PublicKey;
  let receiptCollection: web3.PublicKey;
  let receiptAuthority: web3.PublicKey;
  let protocolConfig: web3.PublicKey;

  beforeAll(async () => {
    provider = AnchorProvider.env();
    provider.opts.commitment = "confirmed";
    provider.opts.skipPreflight = true;
    setProvider(provider);
    payer = (provider.wallet as any).payer as web3.Keypair;

    const rodeoIdl = loadIdl("rodeo_core") as Idl & { address?: string };
    if (DEVNET_CORE_PROGRAM_ID) {
      rodeoIdl.address = DEVNET_CORE_PROGRAM_ID.toBase58();
    }
    rodeoCoreProgram = new Program<Idl>(rodeoIdl, provider);
    sbProgram = await sb.AnchorUtils.loadProgramFromConnection(provider.connection, provider.wallet as any);
    queue = await sb.Queue.loadDefault(sbProgram);

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
    [bullRegistry] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bull-registry"), globalConfig.toBuffer()],
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
    [protocolConfig] = deriveProtocolConfig(rodeoCoreProgram.programId, globalConfig, new BN(1));

    const existingGlobalConfig = await provider.connection.getAccountInfo(globalConfig);
    if (!existingGlobalConfig) {
      rodeoMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
      ansemMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

      const payerAnsemAccount = await createAssociatedTokenAccount(
        provider.connection,
        payer,
        ansemMint,
        payer.publicKey,
      );

      const expectedTotalSupply = 1_000_000_000_000_000n;
      payerRodeoAccount = await createAssociatedTokenAccount(
        provider.connection,
        payer,
        rodeoMint,
        payer.publicKey,
      );
      await mintTo(provider.connection, payer, rodeoMint, payerRodeoAccount, payer, expectedTotalSupply);
      await mintTo(provider.connection, payer, ansemMint, payerAnsemAccount, payer, 2_000_000_000_000_000n);

      await setAuthority(provider.connection, payer, rodeoMint, payer, AuthorityType.MintTokens, null);
      const freezeRodeo = (await getMint(provider.connection, rodeoMint)).freezeAuthority;
      if (freezeRodeo !== null) {
        await setAuthority(provider.connection, payer, rodeoMint, payer, AuthorityType.FreezeAccount, null);
      }
      await setAuthority(provider.connection, payer, ansemMint, payer, AuthorityType.MintTokens, null);
      const freezeAnsem = (await getMint(provider.connection, ansemMint)).freezeAuthority;
      if (freezeAnsem !== null) {
        await setAuthority(provider.connection, payer, ansemMint, payer, AuthorityType.FreezeAccount, null);
      }

      const programData = programDataAddress(rodeoCoreProgram.programId);
      const upgradeCouncil = web3.Keypair.generate().publicKey;
      const treasuryCouncil = web3.Keypair.generate().publicKey;
      const emergencyGuardians = web3.Keypair.generate().publicKey;
      const initIx = await rodeoCoreProgram.methods
        .initializeProtocol(upgradeCouncil, treasuryCouncil, emergencyGuardians)
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
        .instruction();
      await sendIx(provider, initIx, [payer]);
    } else {
      const gc = await (rodeoCoreProgram.account as any).globalConfig.fetch(globalConfig);
      rodeoMint = gc.rodeoMint;
      ansemMint = gc.ansemMint;
      payerRodeoAccount = getAssociatedTokenAddressSync(rodeoMint, payer.publicKey);
    }
  }, 120_000);

  it("deploys rodeo_core to devnet under the expected program ID", async () => {
    const info = await provider.connection.getAccountInfo(rodeoCoreProgram.programId);
    expect(info).not.toBeNull();
    expect(info?.executable).toBe(true);
  }, 30_000);

  it("creates a Switchboard randomness account and commits", async () => {
    const randomnessKp = web3.Keypair.generate();
    const [randomness, createIx] = await sb.Randomness.create(
      sbProgram,
      randomnessKp,
      queue.pubkey,
      payer.publicKey,
    );
    // Pick a healthy on-chain oracle for the commit. Avoid the gateway-based
    // selectRandomnessOracle path because it triggers an ESM/CJS mismatch in
    // @switchboard-xyz/common 5.8.5.
    const queueData = await queue.loadData();
    const oracleKeys = queueData.oracleKeys.slice(0, queueData.oracleKeysLen);
    let oracle: sb.Oracle | undefined;
    for (const key of oracleKeys) {
      const candidate = new sb.Oracle(sbProgram, key);
      const data = await candidate.loadData();
      const gatewayUrl = Buffer.from(data.gatewayUri).toString().replace(/\0+$/g, "");
      const validUntil = data.enclave.validUntil.toNumber();
      const heartbeat = data.lastHeartbeat.toNumber();
      const now = Math.floor(Date.now() / 1000);
      if (
        gatewayUrl.length > 0 &&
        validUntil > now &&
        now - heartbeat <= 300
      ) {
        oracle = candidate;
        console.log(`Selected oracle ${key.toBase58()} gateway ${gatewayUrl}`);
        break;
      }
    }
    if (!oracle) {
      throw new Error("No healthy Switchboard oracle found on devnet queue");
    }
    const commitIx = sbProgram.instruction.randomnessCommit({}, {
      accounts: {
        randomness: randomness.pubkey,
        queue: queue.pubkey,
        oracle: oracle.pubkey,
        recentSlothashes: sb.SPL_SYSVAR_SLOT_HASHES_ID,
        authority: payer.publicKey,
      },
    });

    const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
    const tx = new web3.Transaction().add(createIx, commitIx);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(payer, randomnessKp);
    const sig = await provider.connection.sendRawTransaction(tx.serialize());
    await provider.connection.confirmTransaction(sig, "confirmed");

    const created = await randomness.loadData();
    expect(created.seedSlot.toNumber()).toBeGreaterThan(0);

    // Sample Switchboard reveals until a Cowboy outcome settles successfully.
    // Bull outcomes require a staged BullProofBuffer, so they are expected to
    // fail with BullProofBufferIncomplete; that still proves the reveal resolved.
    let successes = 0;
    let bullCount = 0;
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const sampleRandomness = attempt === 0 ? randomness : await (async () => {
        const kp = web3.Keypair.generate();
        const [r, cIx] = await sb.Randomness.create(sbProgram, kp, queue.pubkey, payer.publicKey);
        const cIx2 = sbProgram.instruction.randomnessCommit({}, {
          accounts: {
            randomness: r.pubkey,
            queue: queue.pubkey,
            oracle: oracle.pubkey,
            recentSlothashes: sb.SPL_SYSVAR_SLOT_HASHES_ID,
            authority: payer.publicKey,
          },
        });
        const { blockhash: bh } = await provider.connection.getLatestBlockhash("confirmed");
        const txn = new web3.Transaction().add(cIx, cIx2);
        txn.feePayer = payer.publicKey;
        txn.recentBlockhash = bh;
        txn.sign(payer, kp);
        const s = await provider.connection.sendRawTransaction(txn.serialize());
        await provider.connection.confirmTransaction(s, "confirmed");
        return r;
      })();

      const ggs = await (rodeoCoreProgram.account as any).globalGameState.fetch(globalGameState);
      const positionId = ggs.nextPositionId;
      const [position] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("position"), globalConfig.toBuffer(), positionId.toArrayLike(Buffer, "le", 8)],
        rodeoCoreProgram.programId,
      );
      const [pendingRandomness] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("randomness"), position.toBuffer(), Buffer.from([0]), new BN(0).toArrayLike(Buffer, "le", 8)],
        rodeoCoreProgram.programId,
      );
      const [receiptAsset] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("receipt"), position.toBuffer()],
        rodeoCoreProgram.programId,
      );
      const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("receipt-funder"), position.toBuffer()],
        rodeoCoreProgram.programId,
      );

      const stakeIx = await rodeoCoreProgram.methods
        .stakeAndCommit(positionId, new BN(100_000_000_000))
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
          bullRegistry,
          receiptFunder,
          providerRandomnessAccount: sampleRandomness.pubkey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        } as any)
        .instruction();
      await sendIx(provider, stakeIx, [payer]);

      // Settling before reveal must fail because the randomness is unresolved.
      const prematureSettleIx = await rodeoCoreProgram.methods
        .settleReveal()
        .accounts({
          settler: payer.publicKey,
          globalConfig,
          globalGameState,
          rewardState,
          bullAccumulator,
          bullRegistry,
          position,
          pendingRandomness,
          protocolConfig,
          owner: payer.publicKey,
          receiptOwner: payer.publicKey,
          receiptAsset,
          receiptCollection,
          receiptAuthority,
          receiptFunder,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          bullProofBuffer: null,
          refundRecipient: null,
          providerRandomnessAccount: sampleRandomness.pubkey,
          systemProgram: web3.SystemProgram.programId,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        } as any)
        .instruction();
      await expect(sendIx(provider, prematureSettleIx, [payer])).rejects.toThrow();

      // Reveal and settle must be in the same transaction because the Switchboard
      // randomness get_value() check requires clock_slot == reveal_slot.
      const revealIx = await sampleRandomness.revealIx(payer.publicKey);
      const settleIx = await rodeoCoreProgram.methods
        .settleReveal()
        .accounts({
          settler: payer.publicKey,
          globalConfig,
          globalGameState,
          rewardState,
          bullAccumulator,
          bullRegistry,
          position,
          pendingRandomness,
          protocolConfig,
          owner: payer.publicKey,
          receiptOwner: payer.publicKey,
          receiptAsset,
          receiptCollection,
          receiptAuthority,
          receiptFunder,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          bullProofBuffer: null,
          refundRecipient: null,
          providerRandomnessAccount: sampleRandomness.pubkey,
          systemProgram: web3.SystemProgram.programId,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        } as any)
        .instruction();

      let combinedSig: web3.TransactionSignature | undefined;
      try {
        const combinedTx = await sb.asV0Tx({
          connection: provider.connection,
          ixs: [revealIx, settleIx],
          signers: [payer],
          computeUnitPrice: 10_000,
          computeUnitLimitMultiple: 1.3,
        });
        combinedSig = await provider.connection.sendTransaction(combinedTx, {
          maxRetries: 3,
          skipPreflight: true,
        });
        await provider.connection.confirmTransaction(combinedSig, "confirmed");
      } catch (e: any) {
        if (e.message?.includes("BullProofBufferIncomplete") || e.errorCode?.code === "BullProofBufferIncomplete") {
          bullCount++;
          console.log(`Attempt ${attempt + 1}: Bull outcome requires proof buffer`);
          continue;
        }
        throw e;
      }

      const settledPosition = await (rodeoCoreProgram.account as any).position.fetch(position);
      expect(settledPosition.pendingActionActive).toBe(false);
      expect(settledPosition.receiptAsset.toBase58()).toBe(receiptAsset.toBase58());
      successes++;
      console.log(`Attempt ${attempt + 1}: settled successfully as`, settledPosition.role.bull ? "bull" : "cowboy");
      break;
    }

    expect(successes).toBeGreaterThan(0);
    console.log(`Successful Switchboard settles: ${successes}; Bull outcomes requiring proof buffer: ${bullCount}`);
  }, 240_000);
});
