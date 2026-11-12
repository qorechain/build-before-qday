# Build Before Q-Day

Example apps from the **Build Before Q-Day** live workshops on [QoreChain](https://www.qorechain.io),
the Layer 1 where every native transaction is signed twice: with classical secp256k1 and with
post-quantum ML-DSA-87 (NIST FIPS 204). The chain checks both.

Every app here runs on the testnet `qorechain-diana` and uses the published QoreChain SDKs
from each language's registry. Testnet QOR has no value.

- Fest, levels and rules: [build.qorechain.io](https://build.qorechain.io)
- Step-by-step guides for each workshop: [docs.qorechain.io](https://docs.qorechain.io)
- SDKs: [github.com/qorechain/qorechain-sdk](https://github.com/qorechain/qorechain-sdk)

## Workshop 1: your first hybrid-signed transaction (12 November 2026)

| App | Language, package | What it shows |
|---|---|---|
| [01-qday-counter](workshop-1/01-qday-counter) | TypeScript, Hardhat, `create-qorechain-dapp` | Register the ML-DSA-87 key, open an EVM window, deploy and call a contract |
| [02-qday-guestbook](workshop-1/02-qday-guestbook) | TypeScript, Solidity + React, `@qorechain/qorex-rainbowkit` | An on-chain guestbook signed from the QoreX wallet |
| [03-hybrid-inspector](workshop-1/03-hybrid-inspector) | TypeScript, React, `@qorechain/qorex-types` | Send QOR from QoreX and see both signatures and the chain's verdict |
| [04-rust-qday-pay](workshop-1/04-rust-qday-pay) | Rust, crates.io `qorechain-sdk` | A CLI that pays with a hybrid signature and verifies it on chain |
| [05-java-tipjar](workshop-1/05-java-tipjar) | Java 21, Maven Central `io.github.qorechain:qorechain-sdk` | A backend that only accepts payments signed post-quantum |
| [06-python-airdrop](workshop-1/06-python-airdrop) | Python, PyPI `qorechain-sdk` | Pay many addresses in one hybrid-signed transaction |

## Testnet

| | |
|---|---|
| Cosmos chain id | `qorechain-diana` |
| EVM chain id | `9800` |
| REST / RPC / EVM JSON-RPC | `https://api-testnet.qore.host`, `https://rpc-testnet.qore.host`, `https://evm-testnet.qore.host` |
| Faucet | [dashboard.qorechain.io/faucet](https://dashboard.qorechain.io/faucet) (sign in, 100 QOR once every 24 hours) |
| Explorer | [explore.qore.network](https://explore.qore.network) (switch to Testnet) |

## Safety

Use testnet-only keys. Never commit `.env` files or key files, and never reuse a testnet key
on mainnet.

## License

Apache-2.0
