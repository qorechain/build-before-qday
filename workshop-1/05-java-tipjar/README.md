# Q-Day Tip Jar (Java)

A tiny Java backend on the QoreChain testnet (`qorechain-diana`) built with the
published Maven artifact `io.github.qorechain:qorechain-sdk:0.13.0`.

Every transaction it sends carries a **hybrid signature**: classical secp256k1
plus post-quantum ML-DSA-87 (FIPS 204, 4627-byte signature). The `watch` command
is the shop-backend story: it watches the jar address and only accepts tips
whose sender's signature was hybrid-verified on chain.

Testnet only. Never fund the demo key on mainnet.

## Build once

```bash
mvn -q package            # Java 21+, produces target/tipjar.jar (about 8 s from an empty Maven cache)
```

## Commands

```bash
./tipjar new                              # create the key file (mode 0600), print the address
./tipjar status                           # address, balance, PQC key registered or not
./tipjar register                         # register the ML-DSA-87 key (idempotent)
./tipjar tip <qor1...> <QOR> [memo]       # send a hybrid-signed tip, wait for the block, verify it
./tipjar watch [qor1...]                  # watch a jar for tips, QUANTUM-SAFE vs classical only
```

`./tipjar` just runs `java -jar target/tipjar.jar` (it also hides a JDK 24+
protobuf warning). `mvn -q exec:java -Dexec.args="status"` works too.

- Key file: `~/.config/qday/java.env` (override with `TIPJAR_KEY`).
  The mnemonic is never printed.
- Account type: a classic **coin-118** QoreChain account (`m/44'/118'/0'/0/0`,
  `/cosmos.crypto.secp256k1.PubKey`). Its ML-DSA-87 key is derived from the
  mnemonic and bound to the address (`Authenticator.derivePqcCanonical`). The
  Java SDK's one-call path (`PqcDx`) signs this account type.
- Gas: every transaction is simulated first and gets the simulated gas x 1.3.
  No fixed gas limit. Gas price 0.15uqor.
- Set `NO_COLOR=1` to turn off colours.

## The code that matters

```java
PqcDx.Signer signer = new PqcDx.Signer();                 // keys, chain id, account number, sequence
signer.secp256k1PrivateKey = account.privateKey;           // classical half
signer.pqcKeypair = Authenticator.derivePqcCanonical(account.address, mnemonic); // ML-DSA-87 half
signer.chainId = "qorechain-diana";
signer.restUrl = Networks.get("testnet").endpoints.rest;   // sign-bytes v1/v2 + key checks

PqcDx.HybridSendPath path = PqcDx.migrateToHybrid(signer, new Broadcaster(rpc), null, opts); // registers once
TypedMessage tip = NativeTx.bankSend(from, to, List.of(new StdFee.Coin("uqor", "500000")));
var sent = path.sendAuto(List.of(tip), "0.15uqor", 1.3);  // simulate, price, hybrid-sign, broadcast
TxTracker.waitForTx(new RestClient(rest), sent.result.transactionHash, null);
```

Proof on chain: `GET /cosmos/tx/v1beta1/txs/{hash}` has an event
`pqc_hybrid_verify` with `address=<signer>` and `status=verified`, and the body
extension `/qorechain.pqc.v1.PQCHybridSignature` carries a 4627-byte
`pqc_signature`. The watcher reads exactly that for every incoming transfer
(tx search `transfer.recipient='<jar>'`).

## Notes

- The one-time key registration (`MsgRegisterPQCKeyV2`) is signed classically
  by design: the chain exempts it, since there is no PQC key to sign with yet.
  It carries a proof of possession signed with the new ML-DSA-87 key.
- The public testnet endpoints have a per-IP rate limit; the watcher polls every 3 s.
