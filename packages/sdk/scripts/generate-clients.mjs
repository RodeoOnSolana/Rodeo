import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const idlDirectory = resolve(root, "target/idl");
const outputDirectory = resolve(import.meta.dirname, "../src/generated");
const idlFiles = (await readdir(idlDirectory)).filter((file) => file.endsWith(".json")).sort();

if (idlFiles.length === 0) throw new Error("No Anchor IDLs found; run `anchor build` first");
await mkdir(outputDirectory, { recursive: true });

const exports = [];
for (const idlFile of idlFiles) {
  const stem = idlFile.slice(0, -5);
  const identifier = stem.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  const idl = JSON.parse(await readFile(resolve(idlDirectory, idlFile), "utf8"));
  const source = `import type { Idl } from "@coral-xyz/anchor";\n\nexport const ${identifier}Idl = ${JSON.stringify(idl, null, 2)} as const satisfies Idl;\nexport type ${identifier[0].toUpperCase()}${identifier.slice(1)}Idl = typeof ${identifier}Idl;\n`;
  await writeFile(resolve(outputDirectory, `${stem}.ts`), source);
  exports.push(`export * from "./${stem}.js";`);
}
await writeFile(resolve(outputDirectory, "index.ts"), `${exports.join("\n")}\n`);
