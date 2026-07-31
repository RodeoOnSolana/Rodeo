import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const programs = ["rodeo_core", "rodeo_market", "rodeo_router"];
const outputDirectory = resolve(import.meta.dirname, "../target/deploy");

function base58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

await mkdir(outputDirectory, { recursive: true });
for (const program of programs) {
  const seed = createHash("sha256").update(`rodeo-localnet-program-key-v1:${program}`).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  const keypair = [...seed, ...publicKey];
  await writeFile(resolve(outputDirectory, `${program}-keypair.json`), `${JSON.stringify(keypair)}\n`, { mode: 0o600 });
  console.log(`${program}: ${base58(publicKey)}`);
}
