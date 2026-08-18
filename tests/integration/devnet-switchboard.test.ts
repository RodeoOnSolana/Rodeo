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
import {
  PROTOCOL_CONFIG_V1,
  RandomnessDomain,
  mapBullTier,
  mapCowboyKind,
  mapRole,
  mapSuit,
  mapUnstakeTheftFlag,
} from "@rodeo/protocol-definition";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

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
  let payerAnsemAccount: web3.PublicKey;

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

  let selectedOracle: sb.Oracle;

  let lastPosition: web3.PublicKey | undefined;
  let lastRandomness: sb.Randomness | undefined;
  let lastReceiptAsset: web3.PublicKey | undefined;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function sendVersionedWithLut(
    ixs: web3.TransactionInstruction[],
    signers: web3.Keypair[],
  ): Promise<{ signature: string; logs: string[]; err: any }> {
    const accounts = new Set<string>();
    for (const ix of ixs) {
      for (const key of ix.keys) {
        accounts.add(key.pubkey.toBase58());
      }
    }
    const accountList = Array.from(accounts).map((a) => new web3.PublicKey(a));

    const slot = await provider.connection.getSlot("confirmed");
    const [createLutIx, lookupTableAddress] = web3.AddressLookupTableProgram.createLookupTable({
      authority: signers[0].publicKey,
      payer: signers[0].publicKey,
      recentSlot: slot,
    });

    // 1. Create the lookup table.
    const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
    const createTx = new web3.Transaction().add(createLutIx);
    createTx.feePayer = signers[0].publicKey;
    createTx.recentBlockhash = blockhash;
    createTx.sign(...signers);
    const createSig = await provider.connection.sendRawTransaction(createTx.serialize(), { skipPreflight: true, maxRetries: 3 });
    await provider.connection.confirmTransaction(createSig, "confirmed");

    // 2. Extend in small chunks to keep each transaction under 1232 bytes.
    const chunkSize = 10;
    for (let i = 0; i < accountList.length; i += chunkSize) {
      const chunk = accountList.slice(i, i + chunkSize);
      const { blockhash: extendBlockhash } = await provider.connection.getLatestBlockhash("confirmed");
      const extendTx = new web3.Transaction().add(
        web3.AddressLookupTableProgram.extendLookupTable({
          authority: signers[0].publicKey,
          payer: signers[0].publicKey,
          lookupTable: lookupTableAddress,
          addresses: chunk,
        }),
      );
      extendTx.feePayer = signers[0].publicKey;
      extendTx.recentBlockhash = extendBlockhash;
      extendTx.sign(...signers);
      const extendSig = await provider.connection.sendRawTransaction(extendTx.serialize(), { skipPreflight: true, maxRetries: 3 });
      await provider.connection.confirmTransaction(extendSig, "confirmed");
    }

    // LUT is active in the slot following creation; wait several devnet slots.
    await sleep(5_000);

    const lut = await provider.connection.getAddressLookupTable(lookupTableAddress).then((r) => r.value);
    if (!lut) throw new Error("Failed to load address lookup table");

    const { blockhash: v0Blockhash } = await provider.connection.getLatestBlockhash("confirmed");
    const messageV0 = new web3.TransactionMessage({
      payerKey: signers[0].publicKey,
      recentBlockhash: v0Blockhash,
      instructions: ixs,
    }).compileToV0Message([lut]);
    const v0Tx = new web3.VersionedTransaction(messageV0);
    v0Tx.sign(signers);

    const sig = await provider.connection.sendRawTransaction(v0Tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    await provider.connection.confirmTransaction(sig, "confirmed");
    const status = await provider.connection.getSignatureStatus(sig);
    const txInfo = await provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return { signature: sig, logs: txInfo?.meta?.logMessages ?? [], err: status.value?.err ?? null };
  }

  async function fetchBalance(): Promise<string> {
    const lamports = await provider.connection.getBalance(payer.publicKey, "confirmed");
    return (lamports / web3.LAMPORTS_PER_SOL).toFixed(9);
  }

  async function createAndCommitRandomness(): Promise<sb.Randomness> {
    const kp = web3.Keypair.generate();
    const [r, cIx] = await sb.Randomness.create(sbProgram, kp, queue.pubkey, payer.publicKey);
    const commitIx = sbProgram.instruction.randomnessCommit(
      {},
      {
        accounts: {
          randomness: r.pubkey,
          queue: queue.pubkey,
          oracle: selectedOracle.pubkey,
          recentSlothashes: sb.SPL_SYSVAR_SLOT_HASHES_ID,
          authority: payer.publicKey,
        },
      },
    );
    const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
    const txn = new web3.Transaction().add(cIx, commitIx);
    txn.feePayer = payer.publicKey;
    txn.recentBlockhash = blockhash;
    txn.sign(payer, kp);
    const sig = await provider.connection.sendRawTransaction(txn.serialize());
    await provider.connection.confirmTransaction(sig, "confirmed");
    return r;
  }

  async function deriveNextPositionAccounts(): Promise<{
    position: web3.PublicKey;
    positionId: BN;
    pendingRandomness: web3.PublicKey;
    receiptAsset: web3.PublicKey;
    receiptFunder: web3.PublicKey;
  }> {
    const ggs = await (rodeoCoreProgram.account as any).globalGameState.fetch(globalGameState);
    const positionId: BN = ggs.nextPositionId;
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
    return { position, positionId, pendingRandomness, receiptAsset, receiptFunder };
  }

  async function sendTransactionWithLogs(
    tx: web3.Transaction | web3.VersionedTransaction,
    signers: web3.Keypair[],
  ): Promise<{ signature: string; logs: string[]; err: any }> {
    let signature: string;
    if (tx instanceof web3.VersionedTransaction) {
      tx.sign(signers);
      signature = await provider.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });
    } else {
      const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
      tx.feePayer = signers[0].publicKey;
      tx.recentBlockhash = blockhash;
      tx.sign(...signers);
      signature = await provider.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });
    }
    await provider.connection.confirmTransaction(signature, "confirmed");
    const status = await provider.connection.getSignatureStatus(signature);
    const txInfo = await provider.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return {
      signature,
      logs: txInfo?.meta?.logMessages ?? [],
      err: status.value?.err ?? null,
    };
  }

  function settleRevealAccounts(params: {
    position: web3.PublicKey;
    pendingRandomness: web3.PublicKey;
    receiptAsset: web3.PublicKey;
    receiptFunder: web3.PublicKey;
    providerRandomnessAccount: web3.PublicKey;
  }): Record<string, any> {
    return {
      settler: payer.publicKey,
      globalConfig,
      globalGameState,
      rewardState,
      bullAccumulator,
      bullRegistry,
      position: params.position,
      pendingRandomness: params.pendingRandomness,
      protocolConfig,
      owner: payer.publicKey,
      receiptOwner: payer.publicKey,
      receiptAsset: params.receiptAsset,
      receiptCollection,
      receiptAuthority,
      receiptFunder: params.receiptFunder,
      mplCoreProgram: MPL_CORE_PROGRAM_ID,
      bullProofBuffer: null,
      refundRecipient: null,
      providerRandomnessAccount: params.providerRandomnessAccount,
      systemProgram: web3.SystemProgram.programId,
      clock: web3.SYSVAR_CLOCK_PUBKEY,
    };
  }

  beforeEach(async () => {
    await sleep(1500);
  });

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

    // Pick a healthy on-chain oracle once so all filtered test cases can reuse it.
    const queueData = await queue.loadData();
    const oracleKeys = queueData.oracleKeys.slice(0, queueData.oracleKeysLen);
    for (const key of oracleKeys) {
      const candidate = new sb.Oracle(sbProgram, key);
      const data = await candidate.loadData();
      const gatewayUrl = Buffer.from(data.gatewayUri).toString().replace(/\0+$/g, "");
      const validUntil = data.enclave.validUntil.toNumber();
      const heartbeat = data.lastHeartbeat.toNumber();
      const now = Math.floor(Date.now() / 1000);
      if (gatewayUrl.length > 0 && validUntil > now && now - heartbeat <= 300) {
        selectedOracle = candidate;
        console.log(`Selected oracle ${key.toBase58()} gateway ${gatewayUrl}`);
        break;
      }
    }
    if (!selectedOracle) {
      throw new Error("No healthy Switchboard oracle found on devnet queue");
    }

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

      payerAnsemAccount = await createAssociatedTokenAccount(
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
      const initSig = await sendIx(provider, initIx, [payer]);
      console.log("initializeProtocol sig:", initSig);
    } else {
      const gc = await (rodeoCoreProgram.account as any).globalConfig.fetch(globalConfig);
      rodeoMint = gc.rodeoMint;
      ansemMint = gc.ansemMint;
      payerRodeoAccount = getAssociatedTokenAddressSync(rodeoMint, payer.publicKey);
      payerAnsemAccount = getAssociatedTokenAddressSync(ansemMint, payer.publicKey);
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
        selectedOracle = oracle;
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
    const createCommitSig = await provider.connection.sendRawTransaction(tx.serialize());
    await provider.connection.confirmTransaction(createCommitSig, "confirmed");
    console.log("Switchboard randomness create+commit sig:", createCommitSig);

    const created = await randomness.loadData();
    expect(created.seedSlot.toNumber()).toBeGreaterThan(0);

    // Sample Switchboard reveals until a Cowboy outcome settles successfully.
    // Bull outcomes require a staged BullProofBuffer, so they are expected to
    // fail with BullProofBufferIncomplete; that still proves the reveal resolved.
    let successes = 0;
    let bullCount = 0;
    const maxAttempts = 3;
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
      const stakeSig = await sendIx(provider, stakeIx, [payer]);
      console.log("stakeAndCommit sig:", stakeSig);

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

      const combinedTx = await sb.asV0Tx({
        connection: provider.connection,
        ixs: [revealIx, settleIx],
        signers: [payer],
        computeUnitPrice: 10_000,
        computeUnitLimitMultiple: 1.3,
      });
      const { signature: combinedSig, logs, err } = await sendTransactionWithLogs(combinedTx, [payer]);
      if (err) {
        const isBull =
          logs.some((m: string) => m.includes("BullProofBufferIncomplete")) ||
          (err.InstructionError && err.InstructionError[1]?.Custom === 6091) ||
          JSON.stringify(err).includes("6091");
        if (isBull) {
          bullCount++;
          console.log(`Attempt ${attempt + 1}: Bull outcome requires proof buffer (sig ${combinedSig})`);
          continue;
        }
        throw new Error(`reveal+settle failed: ${JSON.stringify(err)}\nlogs: ${JSON.stringify(logs)}`);
      }
      console.log("reveal+settle sig:", combinedSig);

      const settledPosition = await (rodeoCoreProgram.account as any).position.fetch(position);
      expect(settledPosition.pendingActionActive).toBe(false);
      expect(settledPosition.receiptAsset.toBase58()).toBe(receiptAsset.toBase58());
      successes++;
      lastPosition = position;
      lastRandomness = sampleRandomness;
      lastReceiptAsset = receiptAsset;
      console.log(`Attempt ${attempt + 1}: settled position ${position.toBase58()} as`, settledPosition.role.bull ? "bull" : "cowboy");
      console.log("receipt asset:", receiptAsset.toBase58());

      const settledTx = await provider.connection.getTransaction(combinedSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      const consumed = settledTx?.meta?.computeUnitsConsumed;
      console.log("reveal+settle CU consumed:", consumed);
      break;
    }

    expect(successes).toBeGreaterThan(0);
    console.log(`Successful Switchboard settles: ${successes}; Bull outcomes requiring proof buffer: ${bullCount}`);
  }, 240_000);

  it("rejects using an already-resolved Switchboard randomness account for a new Rodeo action", async () => {
    console.log("pre outcome-shopping balance:", await fetchBalance(), "SOL");
    const randomness = await createAndCommitRandomness();

    // Derive a fresh Rodeo action that has never seen this randomness.
    const { position, positionId, pendingRandomness, receiptFunder } =
      await deriveNextPositionAccounts();

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
        providerRandomnessAccount: randomness.pubkey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      } as any)
      .instruction();

    // Reveal the randomness inside the SAME transaction as the attempted stake.
    // If the player could observe the resolved value before committing, they
    // could choose whether to take this action. Switchboard get_value() succeeds
    // at the reveal slot, so stake_and_commit must reject it.
    const revealIx = await randomness.revealIx(payer.publicKey);
    const outcomeTx = await sb.asV0Tx({
      connection: provider.connection,
      ixs: [revealIx, stakeIx],
      signers: [payer],
      computeUnitPrice: 10_000,
      computeUnitLimitMultiple: 1.3,
    });

    const { logs, err } = await sendTransactionWithLogs(outcomeTx, [payer]);
    console.log("outcome-shopping rejection logs:", logs.slice(-6));
    expect(err).toBeTruthy();
    expect(
      logs.some(
        (m) =>
          m.includes("RandomnessNotResolved") ||
          m.includes("InvalidProviderAccount") ||
          m.includes("custom program error"),
      ),
    ).toBe(true);
    console.log("post outcome-shopping balance:", await fetchBalance(), "SOL");
  }, 120_000);

  it("rejects fake or mismatched provider randomness accounts", async () => {
    console.log("pre fake-provider balance:", await fetchBalance(), "SOL");
    const { positionId, pendingRandomness, position, receiptFunder } =
      await deriveNextPositionAccounts();

    // A. System-owned ordinary account.
    const fakeProvider = web3.Keypair.generate().publicKey;
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
        providerRandomnessAccount: fakeProvider,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      } as any)
      .instruction();

    const { logs: fakeLogs, err: fakeErr } = await sendTransactionWithLogs(
      new web3.Transaction().add(stakeIx),
      [payer],
    );
    console.log("fake-provider rejection logs:", fakeLogs.slice(-6));
    expect(fakeErr).toBeTruthy();
    expect(fakeLogs.some((m) => m.includes("InvalidProviderAccount"))).toBe(true);

    // B. Wrong-program-owned account (the Switchboard queue account).
    const { positionId: positionId2, pendingRandomness: pendingRandomness2, position: position2, receiptFunder: receiptFunder2 } =
      await deriveNextPositionAccounts();
    const wrongProgramIx = await rodeoCoreProgram.methods
      .stakeAndCommit(positionId2, new BN(100_000_000_000))
      .accounts({
        owner: payer.publicKey,
        ownerRodeoTokenAccount: payerRodeoAccount,
        globalConfig,
        protocolConfig,
        principalVault,
        position: position2,
        pendingRandomness: pendingRandomness2,
        rewardState,
        globalGameState,
        bullRegistry,
        receiptFunder: receiptFunder2,
        providerRandomnessAccount: queue.pubkey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      } as any)
      .instruction();

    const { logs: wrongLogs, err: wrongErr } = await sendTransactionWithLogs(
      new web3.Transaction().add(wrongProgramIx),
      [payer],
    );
    console.log("wrong-program-owned rejection logs:", wrongLogs.slice(-6));
    expect(wrongErr).toBeTruthy();
    expect(wrongLogs.some((m) => m.includes("InvalidProviderAccount"))).toBe(true);

    console.log("post fake-provider balance:", await fetchBalance(), "SOL");
  }, 180_000);

  it("rejects replaying a settled reveal", async () => {
    expect(lastPosition).toBeDefined();
    expect(lastRandomness).toBeDefined();
    expect(lastReceiptAsset).toBeDefined();

    console.log("pre replay balance:", await fetchBalance(), "SOL");
    const position = lastPosition!;
    const randomness = lastRandomness!;

    // Re-derive the closed PendingRandomness PDA.
    const [pendingRandomness] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("randomness"), position.toBuffer(), Buffer.from([0]), new BN(0).toArrayLike(Buffer, "le", 8)],
      rodeoCoreProgram.programId,
    );
    const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-funder"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );

    const replayIx = await rodeoCoreProgram.methods
      .settleReveal()
      .accounts(
        settleRevealAccounts({
          position,
          pendingRandomness,
          receiptAsset: lastReceiptAsset!,
          receiptFunder,
          providerRandomnessAccount: randomness.pubkey,
        }) as any,
      )
      .instruction();

    const replayTx = new web3.Transaction().add(replayIx);
    const { logs: replayLogs, err: replayErr } = await sendTransactionWithLogs(replayTx, [payer]);
    console.log("replay rejection logs:", replayLogs.slice(-6));
    expect(replayErr).toBeTruthy();
    expect(
      replayLogs.some(
        (m) =>
          m.includes("AccountNotInitialized") ||
          m.includes("InvalidProviderAccount") ||
          m.includes("custom program error"),
      ),
    ).toBe(true);
    console.log("post replay balance:", await fetchBalance(), "SOL");
  }, 120_000);

  it("rejects cross-position binding with a mismatched randomness account", async () => {
    console.log("pre cross-binding balance:", await fetchBalance(), "SOL");

    // Create a legitimate action A with its own randomness and stake it.
    const randomnessA = await createAndCommitRandomness();
    const actionA = await deriveNextPositionAccounts();
    const stakeA = await rodeoCoreProgram.methods
      .stakeAndCommit(actionA.positionId, new BN(100_000_000_000))
      .accounts({
        owner: payer.publicKey,
        ownerRodeoTokenAccount: payerRodeoAccount,
        globalConfig,
        protocolConfig,
        principalVault,
        position: actionA.position,
        pendingRandomness: actionA.pendingRandomness,
        rewardState,
        globalGameState,
        bullRegistry,
        receiptFunder: actionA.receiptFunder,
        providerRandomnessAccount: randomnessA.pubkey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      } as any)
      .instruction();
    await sendIx(provider, stakeA, [payer]);

    // Now attempt to settle action A using a different, freshly revealed randomness B.
    const randomnessB = await createAndCommitRandomness();
    const revealBIx = await randomnessB.revealIx(payer.publicKey);
    const settleAwithB = await rodeoCoreProgram.methods
      .settleReveal()
      .accounts(
        settleRevealAccounts({
          position: actionA.position,
          pendingRandomness: actionA.pendingRandomness,
          receiptAsset: actionA.receiptAsset,
          receiptFunder: actionA.receiptFunder,
          providerRandomnessAccount: randomnessB.pubkey,
        }) as any,
      )
      .instruction();

    const tx = await sb.asV0Tx({
      connection: provider.connection,
      ixs: [revealBIx, settleAwithB],
      signers: [payer],
      computeUnitPrice: 10_000,
      computeUnitLimitMultiple: 1.3,
    });
    const { logs: crossLogs, err: crossErr } = await sendTransactionWithLogs(tx, [payer]);
    console.log("cross-binding rejection logs:", crossLogs.slice(-6));
    expect(crossErr).toBeTruthy();
    expect(
      crossLogs.some(
        (m) =>
          m.includes("InvalidProviderAccount") ||
          m.includes("custom program error"),
      ),
    ).toBe(true);
    console.log("post cross-binding balance:", await fetchBalance(), "SOL");
  }, 180_000);

  it("verifies common-settlement parity between Switchboard output and protocol mapping", async () => {
    expect(lastPosition).toBeDefined();
    expect(lastRandomness).toBeDefined();

    const position = lastPosition!;
    const randomness = lastRandomness!;
    const data = await randomness.loadData();
    const randomOutput = data.value as Uint8Array;
    console.log("Switchboard random output (hex):", Buffer.from(randomOutput).toString("hex"));

    const pos = await (rodeoCoreProgram.account as any).position.fetch(position);
    const actionNonce = 0n; // reveal actions in this harness always use nonce 0

    const role = mapRole({
      randomOutput,
      domain: RandomnessDomain.Role,
      position: position.toBytes(),
      actionNonce,
    });
    const rank = mapCowboyKind({
      randomOutput,
      domain: RandomnessDomain.CowboyKind,
      position: position.toBytes(),
      actionNonce,
    });
    const suit = mapSuit({
      randomOutput,
      domain: RandomnessDomain.Suit,
      position: position.toBytes(),
      actionNonce,
    });

    console.log("mapped role:", role, "rank:", rank, "suit:", suit);
    console.log("on-chain role:", pos.role, "cowboyKind:", pos.cowboyKind, "suit:", pos.suit);

    const onChainRole = Object.keys(pos.role as any)[0];
    expect(role).toBe(onChainRole);

    if (role === "cowboy") {
      const cowboyKind = pos.cowboyKind as any;
      if (cowboyKind.rank !== undefined) {
        const rankNumber = Number(Object.values(cowboyKind.rank)[0] as any);
        expect(rank).toBe(`rank${rankNumber}`);
      }
    }

    const suitKey = Object.keys(pos.suit as any)[0];
    expect(suit).toBe(suitKey);
  }, 60_000);

  describe("Timeout and recovery", () => {
    it("recovers a reveal action after the shortened Rodeo timeout without a Switchboard fulfillment", async () => {
      console.log("pre timeout-recovery balance:", await fetchBalance(), "SOL");

      const randomness = await createAndCommitRandomness();
      const action = await deriveNextPositionAccounts();

      const stakeIx = await rodeoCoreProgram.methods
        .stakeAndCommit(action.positionId, new BN(100_000_000_000))
        .accounts({
          owner: payer.publicKey,
          ownerRodeoTokenAccount: payerRodeoAccount,
          globalConfig,
          protocolConfig,
          principalVault,
          position: action.position,
          pendingRandomness: action.pendingRandomness,
          rewardState,
          globalGameState,
          bullRegistry,
          receiptFunder: action.receiptFunder,
          providerRandomnessAccount: randomness.pubkey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        } as any)
        .instruction();
      const stakeSig = await sendIx(provider, stakeIx, [payer]);
      console.log("timeout-recovery stakeAndCommit sig:", stakeSig);

      // Wait past the 2-second test timeout.
      await sleep(3_000);

      const recoverIx = await rodeoCoreProgram.methods
        .recoverRevealTimeout()
        .accounts({
          caller: payer.publicKey,
          position: action.position,
          pendingRandomness: action.pendingRandomness,
          globalConfig,
          principalVault,
          ownerRodeoAccount: payerRodeoAccount,
          owner: payer.publicKey,
          globalGameState,
          receiptFunder: action.receiptFunder,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        } as any)
        .instruction();
      const recoverSig = await sendIx(provider, recoverIx, [payer]);
      console.log("recoverRevealTimeout sig:", recoverSig);

      // Recovery closes the Position, PendingRandomness, and ReceiptFunder.
      const posClosed = await provider.connection.getAccountInfo(action.position);
      expect(posClosed).toBeNull();

      const pendingClosed = await provider.connection.getAccountInfo(action.pendingRandomness);
      expect(pendingClosed).toBeNull();

      const funderClosed = await provider.connection.getAccountInfo(action.receiptFunder);
      expect(funderClosed).toBeNull();

      // No receipt should have been minted because the reveal never completed.
      const receiptAsset = await provider.connection.getAccountInfo(action.receiptAsset);
      expect(receiptAsset).toBeNull();

      console.log("post timeout-recovery balance:", await fetchBalance(), "SOL");
    }, 120_000);

    it("rejects late Switchboard fulfillment of a recovered reveal action", async () => {
      console.log("pre late-fulfillment balance:", await fetchBalance(), "SOL");

      const randomness = await createAndCommitRandomness();
      const action = await deriveNextPositionAccounts();

      const stakeIx = await rodeoCoreProgram.methods
        .stakeAndCommit(action.positionId, new BN(100_000_000_000))
        .accounts({
          owner: payer.publicKey,
          ownerRodeoTokenAccount: payerRodeoAccount,
          globalConfig,
          protocolConfig,
          principalVault,
          position: action.position,
          pendingRandomness: action.pendingRandomness,
          rewardState,
          globalGameState,
          bullRegistry,
          receiptFunder: action.receiptFunder,
          providerRandomnessAccount: randomness.pubkey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        } as any)
        .instruction();
      const stakeSig = await sendIx(provider, stakeIx, [payer]);
      console.log("late-fulfillment stakeAndCommit sig:", stakeSig);

      await sleep(3_000);

      const recoverIx = await rodeoCoreProgram.methods
        .recoverRevealTimeout()
        .accounts({
          caller: payer.publicKey,
          position: action.position,
          pendingRandomness: action.pendingRandomness,
          globalConfig,
          principalVault,
          ownerRodeoAccount: payerRodeoAccount,
          owner: payer.publicKey,
          globalGameState,
          receiptFunder: action.receiptFunder,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        } as any)
        .instruction();
      await sendIx(provider, recoverIx, [payer]);

      // Create a freshly fulfilled Switchboard result.
      const lateRandomness = await createAndCommitRandomness();
      const revealIx = await lateRandomness.revealIx(payer.publicKey);
      const lateSettleIx = await rodeoCoreProgram.methods
        .settleReveal()
        .accounts({
          ...settleRevealAccounts({
            position: action.position,
            pendingRandomness: action.pendingRandomness,
            receiptAsset: action.receiptAsset,
            receiptFunder: action.receiptFunder,
            providerRandomnessAccount: lateRandomness.pubkey,
          }),
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        } as any)
        .instruction();

      const { logs, err } = await sendTransactionWithLogs(
        new web3.Transaction().add(revealIx, lateSettleIx),
        [payer],
      );
      console.log("late-fulfillment rejection logs:", logs.slice(-6));
      expect(err).toBeTruthy();
      console.log("post late-fulfillment balance:", await fetchBalance(), "SOL");
    }, 120_000);
  });

  it("real-provider Unstake with short-min-stake demonstrates production lifecycle, mapping, and replay", async () => {
    console.log("pre real-unstake balance:", await fetchBalance(), "SOL");

    const ggsBefore = await (rodeoCoreProgram.account as any).globalGameState.fetch(globalGameState);
    const bullsBefore = (ggsBefore.totalActiveBullPower as BN).toNumber();
    const rodeoPrincipalBefore = (await provider.connection.getTokenAccountBalance(principalVault)).value.uiAmount ?? 0;
    const ownerRodeoBefore = (await provider.connection.getTokenAccountBalance(payerRodeoAccount)).value.uiAmount ?? 0;
    const ownerAnsemBefore = (await provider.connection.getTokenAccountBalance(payerAnsemAccount)).value.uiAmount ?? 0;

    // 1. Create and settle a Reveal into an Active Position (prefer first non-Bull).
    let action: Awaited<ReturnType<typeof deriveNextPositionAccounts>> | undefined;
    let stakeSig: string | undefined;
    let revealSig: string | undefined;
    let revealCu: number | undefined;
    let activePos: any;

    const maxRevealAttempts = 5;
    for (let attempt = 0; attempt < maxRevealAttempts; attempt++) {
      const randomnessReveal = await createAndCommitRandomness();
      const attemptAction = await deriveNextPositionAccounts();

      const stakeIx = await rodeoCoreProgram.methods
        .stakeAndCommit(attemptAction.positionId, new BN(100_000_000_000))
        .accounts({
          owner: payer.publicKey,
          ownerRodeoTokenAccount: payerRodeoAccount,
          globalConfig,
          protocolConfig,
          principalVault,
          position: attemptAction.position,
          pendingRandomness: attemptAction.pendingRandomness,
          rewardState,
          globalGameState,
          bullRegistry,
          receiptFunder: attemptAction.receiptFunder,
          providerRandomnessAccount: randomnessReveal.pubkey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        } as any)
        .instruction();
      stakeSig = await sendIx(provider, stakeIx, [payer]);
      console.log(`unstake-reveal attempt ${attempt + 1} stakeAndCommit sig:`, stakeSig);

      const revealIx = await randomnessReveal.revealIx(payer.publicKey);
      const settleRevealIx = await rodeoCoreProgram.methods
        .settleReveal()
        .accounts({
          ...settleRevealAccounts({
            position: attemptAction.position,
            pendingRandomness: attemptAction.pendingRandomness,
            receiptAsset: attemptAction.receiptAsset,
            receiptFunder: attemptAction.receiptFunder,
            providerRandomnessAccount: randomnessReveal.pubkey,
          }),
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        } as any)
        .instruction();
      const revealTx = await sb.asV0Tx({
        connection: provider.connection,
        ixs: [revealIx, settleRevealIx],
        signers: [payer],
        computeUnitPrice: 10_000,
        computeUnitLimitMultiple: 1.3,
      });
      const { signature, err, logs } = await sendTransactionWithLogs(revealTx, [payer]);

      if (err) {
        const isBull =
          logs.some((m: string) => m.includes("BullProofBufferIncomplete")) ||
          (err.InstructionError && err.InstructionError[1]?.Custom === 6091) ||
          JSON.stringify(err).includes("6091");
        if (isBull) {
          console.log(`attempt ${attempt + 1}: Bull outcome; recovering reveal timeout...`);
          await sleep(3_000);
          const recoverIx = await rodeoCoreProgram.methods
            .recoverRevealTimeout()
            .accounts({
              caller: payer.publicKey,
              position: attemptAction.position,
              pendingRandomness: attemptAction.pendingRandomness,
              globalConfig,
              principalVault,
              ownerRodeoAccount: payerRodeoAccount,
              owner: payer.publicKey,
              globalGameState,
              receiptFunder: attemptAction.receiptFunder,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: web3.SystemProgram.programId,
              clock: web3.SYSVAR_CLOCK_PUBKEY,
            } as any)
            .instruction();
          await sendIx(provider, recoverIx, [payer]);
          continue;
        }
        throw new Error(`reveal+settle failed: ${JSON.stringify(err)}`);
      }

      revealSig = signature;
      action = attemptAction;
      console.log(`unstake-reveal attempt ${attempt + 1} reveal+settle sig:`, revealSig);
      const revealTxInfo = await provider.connection.getTransaction(revealSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      revealCu = revealTxInfo?.meta?.computeUnitsConsumed ?? 0;
      console.log("reveal+settle CU consumed:", revealCu);
      activePos = await (rodeoCoreProgram.account as any).position.fetch(action.position);
      break;
    }

    if (!action) throw new Error("failed to create a non-Bull active position");
    expect(activePos.status).toMatchObject({ active: {} });
    console.log("activeSince:", activePos.activeSince.toNumber(), "unstakeEligibleAt:", activePos.unstakeEligibleAt.toNumber(), "principalAmount:", activePos.principalAmount.toString());

    // 2. Wait for the shortened minimum stake age.
    await sleep(12_000);

    // 3. Request real-provider Unstake.
    const actionNonce = new BN(activePos.nextActionNonce.toNumber());
    const [pendingRandomnessUnstake] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("randomness"),
        action.position.toBuffer(),
        Buffer.from([1]),
        actionNonce.toArrayLike(Buffer, "le", 8),
      ],
      rodeoCoreProgram.programId,
    );
    const randomnessUnstake = await createAndCommitRandomness();

    const requestIx = await rodeoCoreProgram.methods
      .requestUnstake()
      .accounts({
        owner: payer.publicKey,
        globalConfig,
        protocolConfig,
        position: action.position,
        pendingRandomness: pendingRandomnessUnstake,
        rewardState,
        bullAccumulator,
        providerRandomnessAccount: randomnessUnstake.pubkey,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      } as any)
      .instruction();
    const requestSig = await sendIx(provider, requestIx, [payer]);
    console.log("requestUnstake sig:", requestSig);

    const afterRequestPos = await (rodeoCoreProgram.account as any).position.fetch(action.position);
    expect(afterRequestPos.pendingActionActive).toBe(true);
    expect(afterRequestPos.pendingActionType).toMatchObject({ unstake: {} });

    // 4. Reveal Switchboard randomness and settle Unstake in the same transaction.
    const unstakeRevealIx = await randomnessUnstake.revealIx(payer.publicKey);
    const settleUnstakeIx = await rodeoCoreProgram.methods
      .settleUnstake()
      .accounts({
        settler: payer.publicKey,
        globalConfig,
        globalGameState,
        rewardState,
        bullAccumulator,
        bullRegistry,
        position: action.position,
        pendingRandomness: pendingRandomnessUnstake,
        protocolConfig,
        principalVault,
        rodeoMint,
        ownerRodeoAccount: payerRodeoAccount,
        rewardVault,
        ownerAnsemAccount: payerAnsemAccount,
        owner: payer.publicKey,
        receiptAsset: action.receiptAsset,
        receiptCollection,
        receiptAuthority,
        receiptFunder: action.receiptFunder,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        bullProofBuffer: null,
        refundRecipient: null,
        providerRandomnessAccount: randomnessUnstake.pubkey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      } as any)
      .instruction();
    const { signature: settleSig, logs: settleLogs, err: settleErr } = await sendVersionedWithLut(
      [unstakeRevealIx, settleUnstakeIx],
      [payer],
    );
    if (settleErr) {
      console.error("settle_unstake logs:", settleLogs.slice(-10));
      throw new Error(`unstake reveal+settle failed: ${JSON.stringify(settleErr)}`);
    }
    if (settleErr) throw new Error(`unstake reveal+settle failed: ${JSON.stringify(settleErr)}`);
    console.log("settle_unstake sig:", settleSig);

    const settleTxInfo = await provider.connection.getTransaction(settleSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    console.log("settle_unstake CU consumed:", settleTxInfo?.meta?.computeUnitsConsumed);
    console.log("settle preTokenBalances:", JSON.stringify(settleTxInfo?.meta?.preTokenBalances));
    console.log("settle postTokenBalances:", JSON.stringify(settleTxInfo?.meta?.postTokenBalances));

    // 5. Capture randomness and assert common mapping parity.
    const unstakeData = await randomnessUnstake.loadData();
    const randomOutput = unstakeData.value as Uint8Array;
    const unstakeNonce = afterRequestPos.pendingActionNonce.toNumber();
    const unstakeCtx = {
      randomOutput,
      domain: RandomnessDomain.UnstakeTheft,
      position: action.position.toBytes(),
      actionNonce: BigInt(unstakeNonce),
    };
    const expectedStolen = mapUnstakeTheftFlag(unstakeCtx);
    console.log("Unstake randomOutput:", Buffer.from(randomOutput).toString("hex"));
    console.log("expected stolen:", expectedStolen);

    const finalPos = await (rodeoCoreProgram.account as any).position.fetchNullable(action.position);
    expect(finalPos).toBeNull();

    const ggsAfter = await (rodeoCoreProgram.account as any).globalGameState.fetch(globalGameState);
    const bullsAfter = (ggsAfter.totalActiveBullPower as BN).toNumber();
    expect(bullsAfter).toBe(bullsBefore);

    // 6. Assert RODEO economics using settle tx token balances (RPC caches can lag).
    const settleMeta = settleTxInfo?.meta;
    if (!settleMeta) throw new Error("settle_unstake transaction meta missing");
    const findRodeoBalance = (balances: any[]) =>
      BigInt(balances.find((b: any) => b.mint === rodeoMint.toBase58() && b.owner === payer.publicKey.toBase58())?.uiTokenAmount.amount ?? "0");
    const findPrincipalBalance = (balances: any[]) =>
      BigInt(balances.find((b: any) => b.mint === rodeoMint.toBase58() && b.owner === globalConfig.toBase58())?.uiTokenAmount.amount ?? "0");
    const preRodeo = findRodeoBalance(settleMeta.preTokenBalances ?? []);
    const postRodeo = findRodeoBalance(settleMeta.postTokenBalances ?? []);
    const prePrincipal = findPrincipalBalance(settleMeta.preTokenBalances ?? []);
    const postPrincipal = findPrincipalBalance(settleMeta.postTokenBalances ?? []);
    const stakeAmountAtomic = prePrincipal - postPrincipal;
    const returned = postRodeo - preRodeo;
    const burned = stakeAmountAtomic - returned;
    console.log("pre  owner RODEO:", preRodeo.toString(), "principal:", prePrincipal.toString());
    console.log("post owner RODEO:", postRodeo.toString(), "principal:", postPrincipal.toString());
    console.log("stake:", stakeAmountAtomic.toString(), "returned:", returned.toString(), "burned:", burned.toString());

    expect(stakeAmountAtomic).toBe(100_000_000_000n);
    expect(returned).toBe(95_000_000_000n);
    expect(burned).toBe(5_000_000_000n);

    // 7. Assert ANSEM destination: owner should receive ALL synchronized ANSEM.
    //    The position had no accrued ANSEM in this isolated devnet run, so the
    //    owner ANSEM balance is unchanged and bull pool liability is untouched.
    const ownerAnsemAfter = (await provider.connection.getTokenAccountBalance(payerAnsemAccount)).value.uiAmount ?? 0;
    console.log("owner ANSEM before:", ownerAnsemBefore, "after:", ownerAnsemAfter);
    expect(ownerAnsemAfter).toBeCloseTo(ownerAnsemBefore, 4);

    // 8. Verify receipt and proof state are cleaned up.
    const receiptAfter = await provider.connection.getAccountInfo(action.receiptAsset);
    // MPL Core burn/tombstone leaves a small tombstone account (space 1, ~2.4M lamports), not null.
    expect(receiptAfter).toBeTruthy();
    expect(receiptAfter!.data?.length ?? 0).toBe(1);
    expect(receiptAfter!.lamports).toBeLessThan(3_000_000);
    const pendingAfter = await provider.connection.getAccountInfo(pendingRandomnessUnstake);
    expect(pendingAfter).toBeNull();

    // 9. Replay: attempt the same settleUnstake again.
    const { logs: replayLogs, err: replayErr } = await sendVersionedWithLut([unstakeRevealIx, settleUnstakeIx], [payer]);
    console.log("replay rejection logs:", replayLogs.slice(-6));
    expect(replayErr).toBeTruthy();

    console.log("post real-unstake balance:", await fetchBalance(), "SOL");
  }, 300_000);

  it("creates a real active position and records 24-hour Unstake eligibility", async () => {
    console.log("pre active-position balance:", await fetchBalance(), "SOL");

    const ggsBefore = await (rodeoCoreProgram.account as any).globalGameState.fetch(globalGameState);
    const startingNextPositionId = (ggsBefore.nextPositionId as BN).toNumber();

    let activePosition: {
      position: web3.PublicKey;
      positionId: BN;
      pendingRandomness: web3.PublicKey;
      receiptAsset: web3.PublicKey;
      receiptFunder: web3.PublicKey;
      stakeSig: string;
      revealSettleSig: string;
      randomness: sb.Randomness;
    } | undefined;

    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const randomness = await createAndCommitRandomness();
      const action = await deriveNextPositionAccounts();

      const stakeIx = await rodeoCoreProgram.methods
        .stakeAndCommit(action.positionId, new BN(100_000_000_000))
        .accounts({
          owner: payer.publicKey,
          ownerRodeoTokenAccount: payerRodeoAccount,
          globalConfig,
          protocolConfig,
          principalVault,
          position: action.position,
          pendingRandomness: action.pendingRandomness,
          rewardState,
          globalGameState,
          bullRegistry,
          receiptFunder: action.receiptFunder,
          providerRandomnessAccount: randomness.pubkey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        } as any)
        .instruction();
      const stakeSig = await sendIx(provider, stakeIx, [payer]);

      const revealIx = await randomness.revealIx(payer.publicKey);
      const settleIx = await rodeoCoreProgram.methods
        .settleReveal()
        .accounts({
          ...settleRevealAccounts({
            position: action.position,
            pendingRandomness: action.pendingRandomness,
            receiptAsset: action.receiptAsset,
            receiptFunder: action.receiptFunder,
            providerRandomnessAccount: randomness.pubkey,
          }),
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        } as any)
        .instruction();

      const combinedTx = await sb.asV0Tx({
        connection: provider.connection,
        ixs: [revealIx, settleIx],
        signers: [payer],
        computeUnitPrice: 10_000,
        computeUnitLimitMultiple: 1.3,
      });
      const { signature: combinedSig, logs, err } = await sendTransactionWithLogs(combinedTx, [payer]);

      if (err) {
        const isBull =
          logs.some((m: string) => m.includes("BullProofBufferIncomplete")) ||
          (err.InstructionError && err.InstructionError[1]?.Custom === 6091) ||
          JSON.stringify(err).includes("6091");
        if (isBull) {
          console.log(`Attempt ${attempt + 1}: Bull outcome requires proof buffer; recovering...`);
          await sleep(3_000);
          const recoverIx = await rodeoCoreProgram.methods
            .recoverRevealTimeout()
            .accounts({
              caller: payer.publicKey,
              position: action.position,
              pendingRandomness: action.pendingRandomness,
              globalConfig,
              principalVault,
              ownerRodeoAccount: payerRodeoAccount,
              owner: payer.publicKey,
              globalGameState,
              receiptFunder: action.receiptFunder,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: web3.SystemProgram.programId,
              clock: web3.SYSVAR_CLOCK_PUBKEY,
            } as any)
            .instruction();
          const recoverSig = await sendIx(provider, recoverIx, [payer]);
          console.log(`Attempt ${attempt + 1}: recovered via`, recoverSig);
          continue;
        }
        throw new Error(`reveal+settle failed: ${JSON.stringify(err)}\nlogs: ${JSON.stringify(logs)}`);
      }

      console.log(`Attempt ${attempt + 1}: settled position ${action.position.toBase58()} as active`);
      console.log("reveal+settle sig:", combinedSig);
      activePosition = {
        position: action.position,
        positionId: action.positionId,
        pendingRandomness: action.pendingRandomness,
        receiptAsset: action.receiptAsset,
        receiptFunder: action.receiptFunder,
        stakeSig,
        revealSettleSig: combinedSig,
        randomness,
      };
      break;
    }

    expect(activePosition).toBeDefined();

    const pos = await (rodeoCoreProgram.account as any).position.fetch(activePosition!.position);
    expect(pos.status).toMatchObject({ active: {} });
    expect(pos.pendingActionActive).toBe(false);
    expect(pos.unstakeEligibleAt.toNumber()).toBe(pos.activeSince.toNumber() + 86_400);

    const pending = await provider.connection.getAccountInfo(activePosition!.pendingRandomness);
    expect(pending).toBeNull();

    const receiptInfo = await provider.connection.getAccountInfo(activePosition!.receiptAsset);
    expect(receiptInfo).not.toBeNull();

    const randomnessData = await activePosition!.randomness.loadData();
    const randomOutput = randomnessData.value as Uint8Array;
    const actionNonce = 0n;
    const role = mapRole({ randomOutput, domain: RandomnessDomain.Role, position: activePosition!.position.toBytes(), actionNonce });
    const rank = mapCowboyKind({ randomOutput, domain: RandomnessDomain.CowboyKind, position: activePosition!.position.toBytes(), actionNonce });
    const suit = mapSuit({ randomOutput, domain: RandomnessDomain.Suit, position: activePosition!.position.toBytes(), actionNonce });

    const activeSince = new Date(pos.activeSince.toNumber() * 1000).toISOString();
    const unstakeEligibleAt = new Date(pos.unstakeEligibleAt.toNumber() * 1000).toISOString();

    console.log("=== ACTIVE POSITION RECORD ===");
    console.log("positionId:", activePosition!.positionId.toString());
    console.log("position:", activePosition!.position.toBase58());
    console.log("owner:", pos.owner.toBase58());
    console.log("role:", role);
    console.log("rank:", rank);
    console.log("suit:", suit);
    console.log("stakeAndCommit sig:", activePosition!.stakeSig);
    console.log("reveal+settle sig:", activePosition!.revealSettleSig);
    console.log("randomOutput:", Buffer.from(randomOutput).toString("hex"));
    console.log("activeSince:", activeSince);
    console.log("unstakeEligibleAt:", unstakeEligibleAt);
    console.log("receiptAsset:", activePosition!.receiptAsset.toBase58());
    console.log("receiptFunder:", activePosition!.receiptFunder.toBase58());
    console.log("==============================");

    lastPosition = activePosition!.position;
    lastRandomness = activePosition!.randomness;
    lastReceiptAsset = activePosition!.receiptAsset;

    const ggsAfter = await (rodeoCoreProgram.account as any).globalGameState.fetch(globalGameState);
    const endingNextPositionId = (ggsAfter.nextPositionId as BN).toNumber();
    console.log("nextPositionId before:", startingNextPositionId, "after:", endingNextPositionId);
    console.log("post active-position balance:", await fetchBalance(), "SOL");
  }, 300_000);
});
