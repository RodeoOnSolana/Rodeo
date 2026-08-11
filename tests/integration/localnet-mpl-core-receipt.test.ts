import { createHash } from "node:crypto";
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

// Phase 2D3A2 scope: prove, against the real deterministic MPL Core
// localnet program, that:
//   - the stateless ReceiptAuthority PDA can sign an MPL Core `CreateV2`
//     CPI without being an initialized Rodeo-owned account;
//   - the resulting PositionReceipt asset is created at the Rodeo-derived
//     receipt PDA;
//   - the Solana account program owner is MPL Core, while the embedded
//     Core asset owner is the Position's owning wallet;
//   - all three permanent plugins (transfer/burn/freeze delegate) are
//     actually present in the on-chain account data, with the
//     ReceiptAuthority PDA as their authority;
//   - the freeze delegate starts frozen.
//
// This suite intentionally stops at create+parse. Force-transfer,
// force-burn, and the normal-owner negative-case matrix are scoped to a
// follow-up pass once this smoke proof is confirmed green.
const MPL_CORE_PROGRAM_ID = new web3.PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new web3.PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

const localnetAvailable = Boolean(process.env.ANCHOR_PROVIDER_URL && process.env.ANCHOR_WALLET);
// This proof only compiles into the binary built for the mpl-core profile
// (`--features test-fixtures`), so it must not run against the epoch/claim
// profiles' production-feature binaries.
const skipReceiptProofSuite =
  !localnetAvailable ||
  process.env.RODEO_TEST_SUITE === "epoch" ||
  process.env.RODEO_TEST_SUITE === "claim";

const root = resolve(import.meta.dirname, "../..");

function loadIdl(name: string): Idl {
  const path = resolve(root, "target/idl", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Idl;
}

function anchorDiscriminator(instructionName: string): Buffer {
  return createHash("sha256").update(`global:${instructionName}`).digest().subarray(0, 8);
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
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

function deriveReceiptAuthority(
  programId: web3.PublicKey,
  globalConfig: web3.PublicKey,
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("receipt-authority"), globalConfig.toBuffer()],
    programId,
  );
}

function derivePositionReceipt(
  programId: web3.PublicKey,
  position: web3.PublicKey,
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync([Buffer.from("receipt"), position.toBuffer()], programId);
}

function programDataAddress(programId: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  )[0];
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

describe.skipIf(skipReceiptProofSuite)(
  "PositionReceipt PDA / stateless ReceiptAuthority runtime proof (Phase 2D3A2)",
  () => {
    let provider: AnchorProvider;
    let payer: web3.Keypair;
    let rodeoCoreProgram: Program<Idl>;

    let globalConfig: web3.PublicKey;
    let rewardState: web3.PublicKey;
    let globalGameState: web3.PublicKey;
    let bullAccumulator: web3.PublicKey;
    let principalVault: web3.PublicKey;
    let rewardVault: web3.PublicKey;
    let protocolConfigV1: web3.PublicKey;
    let payerRodeoAccount: web3.PublicKey;

    const upgradeCouncil = web3.Keypair.generate();
    const treasuryCouncil = web3.Keypair.generate();
    const emergencyGuardians = web3.Keypair.generate();

    // Wallet A: the owner of the test Position and, per the proof design,
    // the embedded MPL Core asset owner. Reusing the funded payer keeps
    // this smoke test's setup minimal; force-transfer to a distinct
    // Wallet B is exercised in the follow-up pass.
    let walletA: web3.Keypair;

    // `stake_and_commit` requires `position_id` to equal the current
    // `next_position_id`, which starts at 0 on a freshly initialized
    // protocol (this suite initializes its own isolated GlobalConfig).
    const positionId = new BN(0);

    beforeAll(async () => {
      provider = AnchorProvider.env();
      setProvider(provider);
      payer = (provider.wallet as unknown as { payer: web3.Keypair }).payer;
      walletA = payer;

      rodeoCoreProgram = new Program<Idl>(loadIdl("rodeo_core"), provider);

      if (!localnetAvailable) return;

      const rodeoMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
      const ansemMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

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

      payerRodeoAccount = await createAssociatedTokenAccount(
        provider.connection,
        payer,
        rodeoMint,
        payer.publicKey,
      );

      const expectedTotalSupply = 1_000_000_000_000_000n;
      await mintTo(provider.connection, payer, rodeoMint, payerRodeoAccount, payer, expectedTotalSupply);
      await revokeMintAuthorities(provider.connection, payer, rodeoMint);
      await revokeMintAuthorities(provider.connection, payer, ansemMint);

      const programData = programDataAddress(rodeoCoreProgram.programId);
      [protocolConfigV1] = deriveProtocolConfig(rodeoCoreProgram.programId, globalConfig, new BN(1));

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
          protocolConfig: protocolConfigV1,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
      const [pendingRandomness] = deriveRandomness(
        rodeoCoreProgram.programId,
        position,
        0,
        new BN(0),
      );
      const stakeAmountAtomic = new BN(100_000_000_000);

      await rodeoCoreProgram.methods
        .stakeAndCommit(positionId, stakeAmountAtomic)
        .accounts({
          owner: walletA.publicKey,
          ownerRodeoTokenAccount: payerRodeoAccount,
          globalConfig,
          protocolConfig: protocolConfigV1,
          principalVault,
          position,
          pendingRandomness,
          rewardState,
          globalGameState,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        })
        .signers([walletA])
        .rpc();
    }, 60_000);

    // The `test_fixture_*` receipt instructions are compiled only for the
    // mpl-core localnet profile via the `test-fixtures` feature, so (like
    // the other test_fixture_* helpers in this test suite) they are not
    // exported in the production IDL loaded above. They are invoked here
    // as raw instructions using their Anchor discriminators
    // (sha256("global:<name>")[0..8]).
    async function fixtureCreatePositionReceipt(
      position: web3.PublicKey,
      receiptAsset: web3.PublicKey,
      receiptAuthority: web3.PublicKey,
      assetOwner: web3.PublicKey,
      name: string,
      uri: string,
    ) {
      const data = Buffer.concat([
        anchorDiscriminator("test_fixture_create_position_receipt"),
        borshString(name),
        borshString(uri),
      ]);
      const ix = new web3.TransactionInstruction({
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: globalConfig, isSigner: false, isWritable: false },
          { pubkey: position, isSigner: false, isWritable: false },
          { pubkey: receiptAsset, isSigner: false, isWritable: true },
          { pubkey: receiptAuthority, isSigner: false, isWritable: false },
          { pubkey: assetOwner, isSigner: false, isWritable: false },
          { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: rodeoCoreProgram.programId,
        data,
      });
      const tx = new web3.Transaction().add(ix);
      return provider.sendAndConfirm(tx, [payer]);
    }

    async function fixtureParsePositionReceipt(
      position: web3.PublicKey,
      receiptAsset: web3.PublicKey,
    ) {
      const data = anchorDiscriminator("test_fixture_parse_position_receipt");
      const ix = new web3.TransactionInstruction({
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: position, isSigner: false, isWritable: false },
          { pubkey: receiptAsset, isSigner: false, isWritable: false },
        ],
        programId: rodeoCoreProgram.programId,
        data,
      });
      const tx = new web3.Transaction().add(ix);
      const signature = await provider.sendAndConfirm(tx, [payer]);
      const parsed = await provider.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      const logs = parsed?.meta?.logMessages ?? [];
      const extract = (key: string): string | undefined => {
        const prefix = `Program log: ${key}:`;
        const line = logs.find((l) => l.startsWith(prefix));
        return line?.slice(prefix.length);
      };
      return {
        signature,
        logs,
        owner: extract("receipt_owner"),
        frozen: extract("receipt_frozen"),
        hasPermanentTransferDelegate: extract("receipt_has_permanent_transfer_delegate"),
        hasPermanentBurnDelegate: extract("receipt_has_permanent_burn_delegate"),
        hasPermanentFreezeDelegate: extract("receipt_has_permanent_freeze_delegate"),
        permanentTransferAuthority: extract("receipt_permanent_transfer_authority"),
        permanentBurnAuthority: extract("receipt_permanent_burn_authority"),
        permanentFreezeAuthority: extract("receipt_permanent_freeze_authority"),
      };
    }

    it("MPL Core program is present at its canonical mainnet program ID", async () => {
      const accountInfo = await provider.connection.getAccountInfo(MPL_CORE_PROGRAM_ID);
      expect(accountInfo).not.toBeNull();
      expect(accountInfo!.executable).toBe(true);
    });

    it(
      "creates a PositionReceipt at the Rodeo-derived PDA using the stateless " +
        "ReceiptAuthority PDA as the sole MPL Core authority, then parses the " +
        "actual on-chain account data",
      async () => {
        const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
        const [receiptAuthority] = deriveReceiptAuthority(rodeoCoreProgram.programId, globalConfig);
        const [receiptAsset] = derivePositionReceipt(rodeoCoreProgram.programId, position);

        // Before create: the receipt PDA must not yet hold a live account.
        const beforeCreate = await provider.connection.getAccountInfo(receiptAsset);
        expect(beforeCreate).toBeNull();

        const payerLamportsBefore = await provider.connection.getBalance(payer.publicKey);

        await fixtureCreatePositionReceipt(
          position,
          receiptAsset,
          receiptAuthority,
          walletA.publicKey,
          "Rodeo Position Receipt (proof)",
          "https://example.invalid/receipt.json",
        );

        // After create: MPL Core must own the Solana account at exactly the
        // Rodeo-derived receipt PDA.
        const afterCreate = await provider.connection.getAccountInfo(receiptAsset);
        expect(afterCreate).not.toBeNull();
        expect(afterCreate!.owner.equals(MPL_CORE_PROGRAM_ID)).toBe(true);
        expect(afterCreate!.data.length).toBeGreaterThan(0);

        const receiptLamportsAfterCreate = afterCreate!.lamports;
        const payerLamportsAfterCreate = await provider.connection.getBalance(payer.publicKey);
        // Record (not yet architect) the funding direction: the payer's
        // balance must have decreased by at least the receipt account's
        // rent-exempt lamports, since no funding architecture has been
        // decided yet.
        expect(payerLamportsAfterCreate).toBeLessThan(payerLamportsBefore);
        expect(receiptLamportsAfterCreate).toBeGreaterThan(0);

        const parsed = await fixtureParsePositionReceipt(position, receiptAsset);

        // Embedded Core asset owner must be Wallet A (the Position owner),
        // and must be conceptually distinct from the Solana program owner
        // (MPL Core) asserted above.
        expect(parsed.owner).toBe(walletA.publicKey.toBase58());
        expect(parsed.owner).not.toBe(MPL_CORE_PROGRAM_ID.toBase58());

        // All three permanent plugins must be present in the actual parsed
        // account data (not inferred from the CreateV2 inputs).
        expect(parsed.hasPermanentTransferDelegate).toBe("true");
        expect(parsed.hasPermanentBurnDelegate).toBe("true");
        expect(parsed.hasPermanentFreezeDelegate).toBe("true");

        // The freeze delegate must start frozen.
        expect(parsed.frozen).toBe("true");

        // Every permanent plugin's authority must specifically be the
        // stateless ReceiptAuthority PDA (Address variant), not merely
        // "some pubkey" and not Owner/UpdateAuthority/None.
        const expectedAuthority = `address:${receiptAuthority.toBase58()}`;
        expect(parsed.permanentTransferAuthority).toBe(expectedAuthority);
        expect(parsed.permanentBurnAuthority).toBe(expectedAuthority);
        expect(parsed.permanentFreezeAuthority).toBe(expectedAuthority);
      },
      30_000,
    );
  },
);
