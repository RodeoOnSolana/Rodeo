import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { rodeoCoreIdl } from "@rodeo/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const eventsPath = resolve(__dirname, "../events.ts");

function toCamelCase(name: string): string {
  return name.replace(/^([A-Z])/, (c) => c.toLowerCase());
}

describe("event schema parity", () => {
  it("every IDL event has a matching ProtocolEventEnvelope in events.ts", () => {
    const eventsSource = readFileSync(eventsPath, "utf8");

    const idlNames = rodeoCoreIdl.events.map((e) => e.name);
    const declaredNames = new Set<string>();
    const envelopeRegex = /ProtocolEventEnvelope<"([^"]+)"/g;
    const nameRegex = /readonly name:\s*"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = envelopeRegex.exec(eventsSource)) !== null) {
      declaredNames.add(match[1]);
    }
    while ((match = nameRegex.exec(eventsSource)) !== null) {
      declaredNames.add(match[1]);
    }

    for (const idlName of idlNames) {
      const camel = toCamelCase(idlName);
      if (!declaredNames.has(camel)) {
        throw new Error(`Missing protocol event for IDL event ${idlName} (expected ${camel})`);
      }
    }

    const idlCamelNames = new Set(idlNames.map(toCamelCase));
    const offChainOnlyNames = new Set([
      "listingCancelled",
      "listingCreated",
      "positionGifted",
      "positionSold",
      "receiptBurned",
      "receiptCreated",
      "suitRewardClaimed",
    ]);
    for (const name of declaredNames) {
      if (offChainOnlyNames.has(name)) continue;
      if (!idlCamelNames.has(name)) {
        throw new Error(`Protocol event ${name} has no matching IDL event`);
      }
    }
  });
});
