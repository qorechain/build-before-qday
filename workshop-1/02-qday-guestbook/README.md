# Q-Day Guestbook (TypeScript: Solidity + React + QoreX)

An on-chain guestbook on the QoreChain EVM. Anyone can sign it once per address with
a message of up to 140 characters. The web page connects QoreX through RainbowKit,
shows the account's EVM window and lists the latest signatures live.

Deploy your own copy (below), then put its address in `web/.env` as `VITE_GUESTBOOK_ADDRESS`.

| Folder | What |
|---|---|
| `contracts-app/` | Hardhat project: `contracts/QDayGuestbook.sol`, tests, Ignition deploy, `pnpm sign` |
| `web/` | Vite + React + wagmi + RainbowKit with the QoreX wallet (`@qorechain/qorex-rainbowkit`) |

## Contracts

```sh
cd contracts-app
pnpm test
pnpm window open && sleep 10 && pnpm deploy:testnet
pnpm sign "Hello from the workshop"   # sign from the CLI
pnpm sign --read                      # list the latest entries
```

## Web

```sh
cd web
pnpm dev     # http://localhost:5174
```

`web/.env` sets `VITE_GUESTBOOK_ADDRESS`. The page reads the chain over the EVM
RPC and the EVM window over REST through the Vite proxy `/lcd` (the public REST
endpoint sends no CORS headers). Signing from QoreX needs a coin-60 account with a
registered ML-DSA-87 key; QoreX offers to open the EVM window in its approval.
