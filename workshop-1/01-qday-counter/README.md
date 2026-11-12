# Q-Day Counter (TypeScript, Hardhat)

The `hardhat` template of `create-qorechain-dapp`, deployed on the QoreChain testnet
`qorechain-diana`, plus a small `interact` script. It is the same project Workshop 1 scaffolds live.

After `pnpm deploy:testnet`, Ignition prints the Counter address and `pnpm interact` finds it.

## Commands

```sh
pnpm test               # tests on a local simulated chain
pnpm window status      # account, ML-DSA-87 key, EVM window
pnpm window register    # once: register the ML-DSA-87 key
pnpm window open        # hybrid-signed: open an EVM window (600 blocks, 5 txs)
pnpm build
pnpm deploy:testnet     # Hardhat Ignition, answer y
pnpm interact           # read count, increment(), read again, explorer link
pnpm interact --read    # read only
```

Wait about 10 seconds after `window open` before deploying: opening the window
advances the account's nonce. `.env` holds a testnet-only key (never commit it).
