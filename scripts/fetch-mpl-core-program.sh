#!/usr/bin/env bash
# Fetches the live Metaplex Core on-chain program binary from mainnet-beta so
# it can be loaded deterministically into `solana-test-validator` at genesis
# (see the `[[test.genesis]]` entry in Anchor.toml).
#
# Why a mainnet dump instead of a prebuilt release asset: the `mpl-core`
# Rust crate we depend on (see programs/rodeo_core/Cargo.toml) is the client
# SDK, published from the `clients/rust` subdirectory of the
# metaplex-foundation/mpl-core monorepo; it does not contain the on-chain
# program. The metaplex-foundation/mpl-core GitHub Releases only publish a
# prebuilt `mpl_core_program.so` for a sparse subset of tags (0.9.x, 0.10.0,
# 0.11.0, 0.12.0+ ...), and there is no `release/core@0.11.1` or
# `release/core@0.11.2` tag matching our pinned client version. Building the
# on-chain program from source at the exact commit the client was published
# from is a follow-up option (tracked in docs/mpl-core-integration-proof.md);
# for this PR we use the single canonical, publicly verifiable source of
# truth for "what mpl-core actually enforces today": the live mainnet-beta
# deployment at CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d.
#
# This is NOT a silent dump: the resulting binary's SHA-256 is always printed
# and written next to the binary, is never committed to git (see
# .gitignore), and is recomputed on every CI run so any unannounced mainnet
# upgrade shows up as a visible hash change in CI output/step summary rather
# than a stale, silently-trusted blob in version control.
set -euo pipefail

MPL_CORE_PROGRAM_ID="CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/vendor/mpl-core"
OUT_SO="${OUT_DIR}/mpl_core_program.so"
OUT_SHA="${OUT_SO}.sha256"
CLUSTER_URL="${MPL_CORE_DUMP_URL:-https://api.mainnet-beta.solana.com}"

mkdir -p "${OUT_DIR}"

echo "Dumping ${MPL_CORE_PROGRAM_ID} from ${CLUSTER_URL} ..."
solana program dump -u "${CLUSTER_URL}" "${MPL_CORE_PROGRAM_ID}" "${OUT_SO}"

sha256sum "${OUT_SO}" | tee "${OUT_SHA}"

echo ""
echo "Metaplex Core program binary fetched:"
echo "  Program ID:   ${MPL_CORE_PROGRAM_ID}"
echo "  Source:       live mainnet-beta deployment (${CLUSTER_URL})"
echo "  Local path:   ${OUT_SO}"
echo "  SHA-256:      $(cut -d' ' -f1 "${OUT_SHA}")"

if [ -n "${MPL_CORE_EXPECTED_SHA256:-}" ]; then
  ACTUAL_SHA256="$(cut -d' ' -f1 "${OUT_SHA}")"
  if [ "${ACTUAL_SHA256}" != "${MPL_CORE_EXPECTED_SHA256}" ]; then
    echo ""
    echo "ERROR: fetched Metaplex Core program SHA-256 does not match the pinned" >&2
    echo "MPL_CORE_EXPECTED_SHA256. This means the mainnet-beta deployment has" >&2
    echo "changed since the pin was recorded. Do not proceed silently -- update" >&2
    echo "the pin in docs/mpl-core-integration-proof.md only after deliberately" >&2
    echo "reviewing what changed upstream." >&2
    echo "  expected: ${MPL_CORE_EXPECTED_SHA256}" >&2
    echo "  actual:   ${ACTUAL_SHA256}" >&2
    exit 1
  fi
  echo "  Pin check:    OK (matches MPL_CORE_EXPECTED_SHA256)"
else
  echo "  Pin check:    SKIPPED (MPL_CORE_EXPECTED_SHA256 not set yet -- see"
  echo "                docs/mpl-core-integration-proof.md)"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Metaplex Core program binary"
    echo ""
    echo "| Field | Value |"
    echo "| --- | --- |"
    echo "| Program ID | \`${MPL_CORE_PROGRAM_ID}\` |"
    echo "| Source | live mainnet-beta deployment (\`${CLUSTER_URL}\`) |"
    echo "| SHA-256 | \`$(cut -d' ' -f1 "${OUT_SHA}")\` |"
    echo "| Size (bytes) | $(stat -c%s "${OUT_SO}" 2>/dev/null || stat -f%z "${OUT_SO}") |"
  } >> "${GITHUB_STEP_SUMMARY}"
fi
