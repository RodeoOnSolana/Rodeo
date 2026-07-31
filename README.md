# Rodeo Phase 0

Phase 0 scaffolding for the Rodeo Solana risk-to-earn protocol. Economic behavior is intentionally absent until Rodeo Protocol Specification v1 is supplied.

## Prerequisites

- Node.js 22+
- pnpm 10.30.3
- Rust and Cargo
- Solana CLI
- Anchor CLI 0.31.1

## Commands

```sh
pnpm install
pnpm test
pnpm typecheck
anchor test
```

For a persistent local validator, run `solana-test-validator`, then:

```sh
pnpm anchor:deploy:localnet
pnpm sdk:generate
```

The first local deployment synchronizes generated local program keypairs into the declared program IDs and rebuilds before deploying.

See `docs/architecture-report.md` and `docs/assumptions-and-open-questions.md` before adding game logic.
