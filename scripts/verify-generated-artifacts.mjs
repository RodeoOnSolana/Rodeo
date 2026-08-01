import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const programs = ["rodeo_core", "rodeo_market", "rodeo_router"];
const anchorToml = await readFile(resolve(root, "Anchor.toml"), "utf8");

for (const program of programs) {
  const anchorId = anchorToml.match(new RegExp(`${program}\\s*=\\s*"([1-9A-HJ-NP-Za-km-z]+)"`))?.[1];
  const rustSource = await readFile(resolve(root, `programs/${program}/src/lib.rs`), "utf8");
  const declaredId = rustSource.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/)?.[1];
  const idl = JSON.parse(await readFile(resolve(root, `target/idl/${program}.json`), "utf8"));
  const generatedSource = await readFile(resolve(root, `packages/sdk/src/generated/${program}.ts`), "utf8");
  const ids = { anchorId, declaredId, idlId: idl.address };
  if (!anchorId || Object.values(ids).some((id) => id !== anchorId)) {
    throw new Error(`${program} program ID mismatch: ${JSON.stringify(ids)}`);
  }
  if (!generatedSource.includes(`"address": "${anchorId}"`)) {
    throw new Error(`${program} generated SDK client does not contain ${anchorId}`);
  }
  console.log(`${program}: ${anchorId}`);
}
