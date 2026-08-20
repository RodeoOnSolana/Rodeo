# Rodeo Localnet Suite Feature Matrix

Each localnet integration suite requires its own `rodeo_core` SBF artifact. Do
not reuse one test artifact across suites; the features change protocol
constants, timeouts, and available instructions.

| Suite | `rodeo_core` features | `rodeo_market` / `rodeo_router` features | Artifact source | Loaded at | Special constants |
|---|---|---|---|---|---|
| `claim` | `mock-randomness,test-short-timeout,test-fixtures,test-short-claim-cooldown` | default | `cargo build-sbf --features mock-randomness test-short-timeout test-fixtures test-short-claim-cooldown` | `target/deploy/rodeo_core.so` | Reveal timeout shortened |
| `epoch` | `mock-randomness,test-short-timeout,test-fixtures,test-short-claim-cooldown,test-short-epoch` | default | `cargo build-sbf --features mock-randomness test-short-timeout test-fixtures test-short-claim-cooldown test-short-epoch` | `target/deploy/rodeo_core.so` | Short epochs; production `MIN_STAKE_SECONDS = 86,400` |
| `architecture-f` | `mock-randomness,test-fixtures` (plus the short timeout/epoch/claim-cooldown helpers from the local test harness are not required) | default | `cargo build-sbf --features mock-randomness test-fixtures` | `target/deploy/rodeo_core.so` | Fixture instructions available |
| `production-buffer` | `mock-randomness` only — **no `test-fixtures`** | default | `cargo build-sbf --features mock-randomness` | `target/deploy/rodeo_core.so` | `BULL_PROOF_BUFFER_MAX_PAYLOAD = 16,384`; full staged account = 16,578 bytes |
| `benchmark` (sparse-tree SBF benchmark) | `mock-randomness,test-fixtures` | default | `cargo build-sbf --features mock-randomness test-fixtures` | `target/deploy/rodeo_core.so` | Fixture instructions + `benchmark_sparse_tree` |
| production / SDK gen | default (no short/test features) | default | `anchor build` / `cargo build-sbf` | `target/deploy/rodeo_core.so` | `BULL_PROOF_BUFFER_MAX_PAYLOAD = 16,384`; `MIN_STAKE_SECONDS = 86,400` |

## Runners

- `scripts/run-localnet-suite.sh claim`
- `scripts/run-localnet-suite.sh epoch`
- `RODEO_TEST_SUITE=architecture-f anchor test --skip-build --no-idl`  
  (after building the Architecture F artifact)
- `RODEO_TEST_SUITE=production-buffer anchor test --skip-build --no-idl`  
  (after building the mock-randomness-only artifact)
- `RODEO_TEST_SUITE=benchmark anchor test --skip-build --no-idl`  
  (after building the sparse-benchmark artifact)

Each runner must rebuild the appropriate `rodeo_core.so` and copy it into
`target/deploy` before launching a fresh validator. Reusing an artifact built
for a different suite will cause subtle failures (wrong buffer capacity, wrong
timeouts, missing fixture instructions, etc.).

## Production constants (default / no test features)

```rust
BULL_PROOF_BUFFER_MAX_PAYLOAD = 16_384;
MIN_STAKE_SECONDS             = 86_400;
```

These are overridden only by the feature flags above; they are never weakened
in production code.
