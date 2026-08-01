# Rodeo Phase 0

Phase 0 scaffolding for the Rodeo Solana risk-to-earn protocol. Economic behavior is intentionally absent until Rodeo Protocol Specification v1 is supplied.

## Prerequisites

- Node.js 22+
- pnpm 10.30.3
- Rust 1.85.1
- Solana/Agave CLI 2.1.0
- Anchor CLI 0.31.1

## Commands

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm program-keys:localnet
anchor build
pnpm sdk:generate
pnpm sdk:validate
anchor test --skip-build
```

For a persistent local validator, run `solana-test-validator`, then:

```sh
pnpm anchor:deploy:localnet
pnpm sdk:generate
```

Local program identities are deterministically generated under ignored `target/deploy` output. They are public test fixtures derived from repository labels and must never be reused outside local testing.

See `docs/architecture-report.md` and `docs/assumptions-and-open-questions.md` before adding game logic.
