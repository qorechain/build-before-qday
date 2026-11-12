# Hybrid Inspector (TypeScript, React + QoreX)

Shows what a QoreChain hybrid signature looks like, on the testnet `qorechain-diana`.

1. **Connect QoreX** (`window.qorex.native`): address, balance, ML-DSA-87 key status.
2. **Send** QOR with a memo through `qorexSignAndBroadcast` (`@qorechain/qorex-types`):
   QoreX signs with secp256k1 and ML-DSA-87 and broadcasts.
3. **Verify** any diana transaction hash: the classical signature (64 bytes), the
   ML-DSA-87 signature (4,627 bytes, FIPS 204) in the `PQCHybridSignature` extension,
   and the chain's own verdict, the `pqc_hybrid_verify` event. Links to the explorer.

```sh
pnpm dev     # http://localhost:5173  (add ?tx=<HASH> to open a transaction directly)
```

The REST calls go through the Vite proxy `/lcd` -> `https://api-testnet.qore.host`,
because the public REST endpoint sends no CORS headers. Testnet only.
