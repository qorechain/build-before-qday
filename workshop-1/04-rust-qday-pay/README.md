# qday-pay (Rust)

Build Before Q-Day, Workshop 1. A tiny Rust CLI that pays in QOR on the
QoreChain **testnet** (`qorechain-diana`) with a **hybrid signature**: classical
secp256k1 plus post-quantum ML-DSA-87 (FIPS 204), then reads the transaction
back and proves the chain verified both halves.

It uses only the published crate `qorechain-sdk = "0.13"` (imported as
`qorechain`).

## Run it

```bash
cargo run --release -- new                     # new account, mnemonic saved to a 0600 key file
cargo run --release -- status                  # address, balance, PQC key, latest block
cargo run --release -- register                # register the ML-DSA-87 key (once, idempotent)
cargo run --release -- send qor1... 1 --memo "Build Before Q-Day Workshop 1 (Rust)"
cargo run --release -- verify <TX_HASH>        # the verification report for any tx
```

The key file defaults to `~/.config/qday/rust.env` (override
with `QDAY_KEY_FILE`). The mnemonic is never printed. Get testnet QOR before
`register`: the account must exist on chain to pay the registration fee.

## The account

QoreChain Native secp256k1, coin type 118 (`m/44'/118'/0'/0/0`, a `qor1...`
address), plus an ML-DSA-87 key derived from the same mnemonic with the SDK's
canonical address-bound rule (`authenticator::try_derive_pqc_canonical`). One
mnemonic restores both keys.

## The SDK code that matters (`src/main.rs`, `send`)

```rust
let send = bank_send_any(w.address(), to, vec![coin(&uqor)]);           // MsgSend
let draft = build_hybrid_tx(params.clone())?;                           // secp256k1 + ML-DSA-87
params.fee = estimate_fee(rest, &draft.tx_raw_bytes, 1.3, "0.15uqor").await?; // simulate, gas x 1.3
let tx = build_hybrid_tx(params)?;                                      // sign for real
let res = broadcast_and_wait(rest, &tx.tx_raw_bytes, WaitOptions::default()).await?;
```

Registration is one idempotent call: `PqcDx::ensure_pqc_registered()` sends
`MsgRegisterPQCKeyV2` with a proof of possession only when no key is
registered yet.

## How "verified" is decided

`verify` reads `GET /cosmos/tx/v1beta1/txs/{hash}` and checks three things:

- the tx succeeded (`code 0`);
- the chain emitted `pqc_hybrid_verify` with `status=verified` for the signer;
- the body carries a `/qorechain.pqc.v1.PQCHybridSignature` extension with a
  4627-byte ML-DSA-87 signature (next to the 64-byte secp256k1 signature).

Explorer: `https://explore.qore.network/tx/<HASH>` (switch the explorer to
Testnet).

Testnet only. The network preset is the SDK's `testnet` and the CLI refuses to
run against any other chain id.
