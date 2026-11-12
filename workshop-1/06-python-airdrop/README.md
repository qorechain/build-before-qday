# Q-Day Airdrop (Python)

Send testnet QOR to a whole list of addresses in **one** transaction, signed with
both a classical secp256k1 key and a post-quantum ML-DSA-87 (FIPS 204) key, then
prove from the chain's own record that both signatures were verified.

Testnet only (`qorechain-diana`). Uses the published SDK `qorechain-sdk==0.13.0`
(imported as `qorsdk`). One dependency, nothing else.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt     # about 15 seconds on a fresh venv
source .venv/bin/activate
```

## Commands

```bash
python airdrop.py new                 # new key file (mode 600), prints the address
python airdrop.py status              # address, balance, post-quantum key
python airdrop.py register            # register the ML-DSA-87 key once (idempotent)
python airdrop.py drop addresses.txt 0.1 --memo "Build Before Q-Day Workshop 1"
python airdrop.py verify <TX_HASH>    # the verification report on its own
```

- The key file defaults to `~/.config/qday/python.env`
  (override with `--key-file` or `QORE_KEY_FILE`). The mnemonic is never printed.
- `drop` reads one address per line. Blank lines, `#` comments, duplicates,
  the sender itself and anything that is not a valid `qor1` account address are
  skipped with a warning. It shows a summary and asks before sending (`--yes`
  skips the question). At most 100 recipients per transaction.
- Gas is never fixed: the real hybrid-signed transaction is simulated first and
  the limit is the simulated gas x 1.3, priced at 0.15 uqor per gas.
- See `addresses.example.txt` for a sample list (it includes an invalid line and
  a duplicate on purpose).

## The code that matters

```python
from qorsdk import (derive_native_account, derive_pqc_canonical, msg, build_hybrid_tx,
                    auto_fee, hybrid_sign_and_broadcast, wait_for_tx,
                    resolve_sign_bytes_version)

account = derive_native_account(mnemonic)                   # classical secp256k1 key
pqc = derive_pqc_canonical(account.address, mnemonic)       # ML-DSA-87 key, same mnemonic

drop = msg.bank.multi_send(                                 # ONE message, N recipients
    inputs=[Input(address=account.address, coins=[Coin(denom="uqor", amount=str(each * len(to)))])],
    outputs=[Output(address=a, coins=[Coin(denom="uqor", amount=str(each))]) for a in to])

build = lambda fee, v: build_hybrid_tx(account=account, pqc_keypair=pqc, messages=[drop], fee=fee,
    memo=memo, chain_id="qorechain-diana", account_number=num, sequence=seq, sign_bytes_version=v)

v = resolve_sign_bytes_version("qorechain-diana", rest_url=REST)                 # "v2" on diana
fee = auto_fee(REST, build({"amount": [], "gas": "0"}, v), gas_multiplier=1.3)  # simulate
res = hybrid_sign_and_broadcast(lambda v: build(fee, v), chain_id="qorechain-diana", rest_url=REST)
included = wait_for_tx(rest, res["tx_response"]["txhash"])
```

The post-quantum key is registered once with `ensure_pqc_registered(...)`, which
does nothing if the same key is already on chain.

## How the proof works

`verify` reads `GET /cosmos/tx/v1beta1/txs/{hash}` from the public testnet REST
endpoint and checks:

- an event of type `pqc_hybrid_verify` for the signer with `status=verified`;
- the `/qorechain.pqc.v1.PQCHybridSignature` body extension carries a
  4,627-byte ML-DSA-87 signature (next to the 64-byte secp256k1 one);
- the transaction succeeded (code 0), and how many recipients it paid.

Open the link it prints on https://explore.qore.network and switch the explorer
to Testnet.

## Notes

- Account type: coin type 118 (`m/44'/118'/0'/0/0`), the path `build_hybrid_tx`
  and `ensure_pqc_registered` take. The ML-DSA-87 key is derived from the same
  mnemonic and bound to the address (`derive_pqc_canonical`).
- The one-time registration transaction is signed classically (a key cannot
  co-sign its own registration). Every transaction after it is hybrid.
- If a broadcast fails while the testnet is upgrading, wait a minute and retry.
