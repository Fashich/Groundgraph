# Toolchain and dependency versions

Pinned versions the on-chain program, the SDK and the devnet scripts were built and tested with (checked 12 Oct 2026).
Versions marked "exact" are pinned with `=` or an exact number; the rest follow the caret ranges in the manifests and the committed lockfiles.

## On-chain program and Rust tests

| Component | Version | Notes |
|---|---|---|
| Anchor (`anchor-lang`, `anchor-cli`) | 1.2.1 (exact) | `init-if-needed` feature enabled; `anchor-spl` is not used, SPL Token CPIs are raw `invoke_signed` calls (smaller binary, fewer moving parts) |
| `pyth-solana-receiver-sdk` | 2.0.0 (exact) | `PriceUpdateV2`, receiver program `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` |
| Solana CLI / Agave | 4.3.0 | `cargo-build-sbf` 4.4.0 with platform-tools v1.57 (rustc 1.95.0 inside) |
| Program binary | SBPF v3, about 266 KB | `opt-level = "z"`, fat LTO, `panic = "abort"`, cdylib only (no rlib) |
| Host Rust | 1.95.0 (stock) | builds the program and runs the program unit tests: `cargo test -p groundgraph --lib` |
| Host Rust for LiteSVM tests | 1.99.0 (extra toolchain) | `litesvm` 0.18.0 requires rustc 1.97.1 or newer: `cargo +1.99.0 test -p groundgraph-tests` |
| `litesvm` (Rust) | 0.18.0 (exact) | loads the SBPF v3 build without changes |
| `proptest` | 1.12.0 (exact) | |
| Workspace MSRV | 1.89.0 | `rust-version` in the root `Cargo.toml` |

Build and test commands (use `CARGO_BUILD_JOBS=2` on small machines):

```
cargo build-sbf --manifest-path programs/groundgraph/Cargo.toml --sbf-out-dir target/deploy
cargo test -p groundgraph --lib                    # math unit + property tests, writes the parity vectors
cargo +1.99.0 test -p groundgraph-tests            # LiteSVM integration suite (also `anchor test`)
cargo +1.99.0 test -p groundgraph-tests --test cu -- --nocapture   # compute unit table
```

## TypeScript

| Component | Version | Notes |
|---|---|---|
| Node.js | 22.22.2 | |
| pnpm | 10.28.0 | workspace; install and run through `flock /tmp/gg-pnpm.lock pnpm ...` on the shared machine |
| TypeScript | 5.9.3 | strict |
| `@solana/web3.js` | 1.99.0 (exact) | v1 API on purpose, to match wallet adapters |
| `@solana/spl-token` | 0.4.15 (exact) | used by the scripts and the end to end test |
| `vitest` | 5.0.3 | SDK tests |
| `fast-check` | 4.10.2 | SDK property tests |
| `litesvm` (npm) | 1.6.0 | end to end test of the SDK against the real binary; uses the `@solana/kit` transaction shape, converted from web3.js `VersionedTransaction` in the test |
| `tsx` | 4.23.15 | runs the devnet scripts |

The SDK has no runtime dependencies other than `@solana/web3.js` and `@solana/spl-token`. The Anchor IDL is vendored as `packages/sdk/src/idl/groundgraph.json` (`pnpm --filter @groundgraph/sdk sync-idl` copies it from `programs/groundgraph/idl/`), and account layouts, instruction accounts and event discriminators are all derived from it.

## Cluster

| Item | Value |
|---|---|
| Cluster | Solana devnet, `https://api.devnet.solana.com` |
| Program id | `5W8BS9j9ZFH7Uscjq2Sh7tU5SVmvf7Ay3fJMDjTnRPCC` |
| Pyth receiver program | `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` |
| Pyth push oracle program (sponsored feeds, shard 0) | `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT` |
| Devnet rent rate observed | about 5,080 lamports per byte (rent-exempt minimum for a 280,045 byte ProgramData account: 1.4233 SOL) |

Pyth feed ids (USD pairs) are in `packages/sdk/src/constants.ts` (`PYTH_FEEDS`); the sponsored push feed account for each is derived with `pythPushFeedAddress` (seeds `[u16 LE shard, feed_id]` under the push oracle program) and was verified to exist on devnet with the matching embedded feed id.
