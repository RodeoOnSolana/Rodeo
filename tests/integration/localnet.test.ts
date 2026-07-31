import { AnchorProvider, setProvider, workspace } from "@coral-xyz/anchor";
import { describe, expect, it } from "vitest";

const localnetAvailable = Boolean(process.env.ANCHOR_PROVIDER_URL && process.env.ANCHOR_WALLET);

describe.skipIf(!localnetAvailable)("Anchor localnet workspace", () => {
  it("deploys all Phase 0 program boundaries", async () => {
    const provider = AnchorProvider.env();
    setProvider(provider);
    const programs = [workspace.RodeoCore, workspace.RodeoMarket, workspace.RodeoRouter];
    for (const program of programs) {
      expect(await provider.connection.getAccountInfo(program.programId)).not.toBeNull();
    }
  });
});
