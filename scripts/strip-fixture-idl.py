#!/usr/bin/env python3
"""Strip test-only fixture/benchmark instructions from production Anchor IDLs.

The `anchor idl build` macro currently emits every `#[program]` instruction it
sees, including items guarded by `#[cfg(feature = "test-fixtures")]`.  The
compiled SBF for the default feature profile does not contain those
instructions, but the generated JSON/TS still does.  This script removes them
so the production IDL/SDK only expose the real protocol surface.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def strip_idl(path: Path) -> None:
    data = json.loads(path.read_text())
    instructions = data.get("instructions", [])
    before = len(instructions)
    instructions = [
        ix for ix in instructions
        if not (
            ix.get("name", "").startswith("test_fixture_")
            or ix.get("name", "").startswith("benchmark_")
        )
    ]
    data["instructions"] = instructions
    path.write_text(json.dumps(data, indent=2))
    after = len(instructions)
    print(f"{path}: {before} -> {after} instructions", file=sys.stderr)


def strip_types(path: Path) -> None:
    text = path.read_text()
    # The generated TS contains method names that map to snake_case IDL names.
    # Anchor types list each instruction as a method plus a discriminator
    # constant.  We remove the method block and its associated constant.
    pattern = r"(?m)^\s+testFixture[A-Za-z0-9_]+\(.*?(?:^\s+\});)"
    text = re.sub(pattern, "", text, flags=re.DOTALL)
    pattern = r"(?m)^\s+benchmark[A-Za-z0-9_]+\(.*?(?:^\s+\});)"
    text = re.sub(pattern, "", text, flags=re.DOTALL)
    # Also remove any type named with the fixture/benchmark prefix
    text = re.sub(r"(?m)^\s*testFixture[A-Za-z0-9_]+?: [^\n]+\n", "", text)
    text = re.sub(r"(?m)^\s*benchmark[A-Za-z0-9_]+?: [^\n]+\n", "", text)
    path.write_text(text)
    print(f"{path}: fixture/benchmark method types stripped", file=sys.stderr)


def main():
    idl_dir = ROOT / "target" / "idl"
    types_dir = ROOT / "target" / "types"
    for idl_path in idl_dir.glob("rodeo_core.json"):
        strip_idl(idl_path)
    for types_path in types_dir.glob("rodeo_core.ts"):
        strip_types(types_path)


if __name__ == "__main__":
    main()
