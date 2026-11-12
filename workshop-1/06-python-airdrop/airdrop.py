#!/usr/bin/env python3
"""Q-Day Airdrop: send testnet QOR to many addresses in ONE hybrid-signed tx.

Every QoreChain native transaction carries two signatures: classical secp256k1
plus post-quantum ML-DSA-87 (FIPS 204). This script uses the published Python
SDK (`pip install qorechain-sdk`, imported as `qorsdk`). Testnet only.

    python airdrop.py new                      create a key file, print the address
    python airdrop.py status                   address, balance, PQC key
    python airdrop.py register                 register the ML-DSA-87 key (idempotent)
    python airdrop.py drop FILE AMOUNT [--memo TEXT] [--yes]
    python airdrop.py verify HASH              the verification report
"""

from __future__ import annotations

import argparse
import base64
import os
import stat
import sys
from pathlib import Path

from cosmpy.protos.cosmos.bank.v1beta1.bank_pb2 import Input, Output
from cosmpy.protos.cosmos.base.v1beta1.coin_pb2 import Coin
from qorsdk import (
    CHAIN_UPGRADE_V3_2_3,
    GasPrice,
    RestClient,
    auto_fee,
    bech32_to_hex,
    build_hybrid_tx,
    build_register_pqc_key,
    derive_native_account,
    derive_pqc_canonical,
    ensure_pqc_registered,
    fetch_pqc_status,
    from_base,
    generate_mnemonic,
    hybrid_sign_and_broadcast,
    is_upgrade_applied,
    is_valid_bech32,
    msg,
    resolve_sign_bytes_version,
    send_messages,
    sign_proof_of_possession,
    to_base,
    validate_mnemonic,
    wait_for_tx,
)

# --- Testnet settings -------------------------------------------------------
CHAIN_ID = "qorechain-diana"
REST = os.environ.get("QORE_REST", "https://api-testnet.qore.host")
DENOM = "uqor"
GAS_PRICE = "0.15uqor"
GAS_MARGIN = 1.3                 # simulated gas x 1.3
MAX_GAS = 50_000_000             # the chain's per-tx gas cap
MAX_RECIPIENTS = 100
EXPLORER = "https://explore.qore.network/tx/{}"
PQC_SIG_BYTES = 4627             # ML-DSA-87 signature size
DEFAULT_KEY_FILE = Path(
    os.environ.get("QORE_KEY_FILE", "~/.config/qday/python.env")
).expanduser()
HYBRID_EXT = "/qorechain.pqc.v1.PQCHybridSignature"

# --- Tiny output helpers (no extra deps) -----------------
_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


def ok(text: str) -> str:
    return _c("32;1", text)


def warn(text: str) -> str:
    return _c("33", text)


def bad(text: str) -> str:
    return _c("31;1", text)


def dim(text: str) -> str:
    return _c("2", text)


def title(text: str) -> None:
    print()
    print(_c("36;1", text))


def row(label: str, value: object) -> None:
    print(f"  {label:<18} {value}")


def die(text: str) -> None:
    print(bad(f"error: {text}"), file=sys.stderr)
    sys.exit(1)


def qor(uqor: int | str) -> str:
    return f"{from_base(str(uqor))} QOR"


# --- Key file ----------------------------------------------------------------
def load_mnemonic(path: Path) -> str:
    if not path.exists():
        die(f"no key file at {path}. Run: python airdrop.py new")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        die(f"{path} is readable by others (mode {oct(mode)}); run: chmod 600 {path}")
    for line in path.read_text().splitlines():
        if line.startswith("QORE_MNEMONIC="):
            return line.split("=", 1)[1].strip().strip('"')
    die(f"{path} has no QORE_MNEMONIC line")
    raise AssertionError  # unreachable


class Wallet:
    """Classical key (coin type 118) + its address-bound ML-DSA-87 key."""

    def __init__(self, mnemonic: str) -> None:
        self.account = derive_native_account(mnemonic, 0)
        self.pqc = derive_pqc_canonical(self.account.address, mnemonic)
        self.address = self.account.address


def wallet_from(args: argparse.Namespace) -> Wallet:
    return Wallet(load_mnemonic(args.key_file))


# --- Chain reads ---------------------------------------------------------------
def rest() -> RestClient:
    return RestClient(REST, timeout=30.0)


def account_info(r: RestClient, address: str) -> tuple[int, int]:
    """(account_number, sequence); (0, 0) is never valid for a funded account."""
    try:
        acct = r.get(f"/cosmos/auth/v1beta1/accounts/{address}")["account"]
    except Exception:  # noqa: BLE001 - unknown account = never funded
        die(f"{address} is not on chain yet (fund it first)")
    acct = acct.get("base_account", acct)
    return int(acct["account_number"]), int(acct.get("sequence", 0))


def balance(r: RestClient, address: str) -> int:
    res = r.get(f"/cosmos/bank/v1beta1/balances/{address}/by_denom", {"denom": DENOM})
    return int(res.get("balance", {}).get("amount", 0))


def check_gas(fee: dict) -> dict:
    if int(fee["gas"]) > MAX_GAS:
        die(f"needs {fee['gas']} gas, above the {MAX_GAS:,} per-tx cap; send fewer recipients")
    return fee


# --- Commands ------------------------------------------------------------------
def cmd_new(args: argparse.Namespace) -> None:
    path: Path = args.key_file
    if path.exists() and not args.force:
        die(f"{path} already exists (use --force to replace it)")
    mnemonic = generate_mnemonic(256)
    assert validate_mnemonic(mnemonic)
    w = Wallet(mnemonic)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("# QoreChain TESTNET key (Build Before Q-Day Workshop 1). Never use on mainnet.\n")
        f.write(f'QORE_MNEMONIC="{mnemonic}"\n')
        f.write(f"QORE_ADDR={w.address}\n")
    os.chmod(path, 0o600)
    title("New testnet wallet")
    row("address", ok(w.address))
    row("key file", f"{path} (mode 600, mnemonic not shown)")
    row("next", "fund it with testnet QOR, then: python airdrop.py register")


def cmd_status(args: argparse.Namespace) -> None:
    w = wallet_from(args)
    with rest() as r:
        bal = balance(r, w.address)
    pqc = fetch_pqc_status(REST, w.address)
    title("Wallet status (qorechain-diana testnet)")
    row("address", w.address)
    row("balance", qor(bal))
    if pqc.get("registered"):
        proven = " , proof of possession verified" if pqc.get("possession_proven") else ""
        row("ML-DSA-87 key", ok(f"registered ({pqc.get('key_type', 'hybrid')}{proven})".replace(" ,", ",")))
    else:
        row("ML-DSA-87 key", warn("not registered (run: python airdrop.py register)"))


def cmd_register(args: argparse.Namespace) -> None:
    w = wallet_from(args)
    title("Register the post-quantum key")
    if fetch_pqc_status(REST, w.address).get("registered"):
        res = ensure_pqc_registered(  # verifies the key on chain is OURS
            account=w.account, pqc_keypair=w.pqc, chain_id=CHAIN_ID,
            account_number=0, rest_url=REST, fee={"amount": [], "gas": "0"},
        )
        row("status", ok("already registered") + ("" if res.get("key_verified") else warn(" (key not compared)")))
        return
    with rest() as r:
        acc_num, seq = account_info(r, w.address)
        # Simulate the exact registration message to size its gas.
        proof = b""
        if is_upgrade_applied(r, CHAIN_UPGRADE_V3_2_3, cache_key=REST):
            proof = sign_proof_of_possession(chain_id=CHAIN_ID, account=w.address, keypair=w.pqc)
        reg = build_register_pqc_key(
            sender=w.address, dilithium_pubkey=w.pqc.public_key,
            ecdsa_pubkey=w.account.public_key, proof_of_possession=proof,
        )
        sim = send_messages(account=w.account, messages=[reg], chain_id=CHAIN_ID,
                            account_number=acc_num, sequence=seq,
                            fee={"amount": [], "gas": "0"})
        fee = check_gas(auto_fee(REST, sim, gas_multiplier=GAS_MARGIN, gas_price=GAS_PRICE))
        res = ensure_pqc_registered(
            account=w.account, pqc_keypair=w.pqc, chain_id=CHAIN_ID,
            account_number=acc_num, sequence=seq, rest_url=REST, fee=fee,
        )
        if res.get("already_registered"):
            row("status", ok("already registered"))
            return
        included = wait_for_tx(r, res["tx_hash"], timeout=90)
    row("tx", included.tx_hash)
    row("height", included.height)
    row("fee", f"{qor(fee['amount'][0]['amount'])} ({fee['gas']} gas)")
    row("status", ok("ML-DSA-87 key registered"))


def read_addresses(path: Path, sender: str) -> list[str]:
    good: list[str] = []
    for n, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip().strip(",;")
        if not line or line.startswith("#"):
            continue
        valid = is_valid_bech32(line, "qor") and line == line.lower()
        if valid:
            try:
                valid = len(bech32_to_hex(line)) == 42  # 20-byte account
            except ValueError:
                valid = False
        if not valid:
            print(warn(f"  skip line {n}: not a valid qor1 address: {line[:60]!r}"))
        elif line == sender:
            print(warn(f"  skip line {n}: that is the sender itself"))
        elif line in good:
            print(warn(f"  skip line {n}: duplicate {line}"))
        else:
            good.append(line)
    return good


def build_drop(w: Wallet, recipients: list[str], each: int, memo: str,
               acc_num: int, seq: int, fee: dict, version: str):
    """ONE MsgMultiSend: one input (us), one output per recipient."""
    coins = lambda n: [Coin(denom=DENOM, amount=str(n))]  # noqa: E731
    multi = msg.bank.multi_send(
        inputs=[Input(address=w.address, coins=coins(each * len(recipients)))],
        outputs=[Output(address=a, coins=coins(each)) for a in recipients],
    )
    return build_hybrid_tx(
        account=w.account, pqc_keypair=w.pqc, messages=[multi], fee=fee, memo=memo,
        chain_id=CHAIN_ID, account_number=acc_num, sequence=seq,
        sign_bytes_version=version,
    )


def cmd_drop(args: argparse.Namespace) -> None:
    w = wallet_from(args)
    try:
        each = int(to_base(args.amount))
    except Exception:  # noqa: BLE001
        die(f"bad amount {args.amount!r}; use QOR, e.g. 0.1")
    if each <= 0:
        die("amount must be above 0")

    title(f"Reading {args.file}")
    recipients = read_addresses(Path(args.file), w.address)
    if not recipients:
        die("no valid recipients")
    if len(recipients) > MAX_RECIPIENTS:
        die(f"{len(recipients)} recipients; the limit is {MAX_RECIPIENTS} per tx")

    if not fetch_pqc_status(REST, w.address).get("registered"):
        die("the ML-DSA-87 key is not registered yet; run: python airdrop.py register")

    with rest() as r:
        acc_num, seq = account_info(r, w.address)
        bal = balance(r, w.address)
        version = resolve_sign_bytes_version(CHAIN_ID, rest_url=REST)
        # Simulate the real, hybrid-signed tx, then size gas with a 1.3x margin.
        sim = build_drop(w, recipients, each, args.memo, acc_num, seq,
                         {"amount": [], "gas": "0"}, version)
        fee = check_gas(auto_fee(REST, sim, gas_multiplier=GAS_MARGIN, gas_price=GAS_PRICE))
        fee_uqor = int(fee["amount"][0]["amount"])
        total = each * len(recipients)

        title("Q-Day Airdrop summary")
        row("from", w.address)
        row("recipients", f"{len(recipients)} (one tx, one MsgMultiSend)")
        row("each", qor(each))
        row("total", qor(total))
        row("fee", f"{qor(fee_uqor)} ({int(fee['gas']):,} gas, simulated x{GAS_MARGIN})")
        row("memo", args.memo or dim("(none)"))
        row("balance", qor(bal))
        if total + fee_uqor > bal:
            die(f"balance too low: need {qor(total + fee_uqor)}")
        if not args.yes:
            if input("\n  Send it? [y/N] ").strip().lower() not in ("y", "yes"):
                print("  cancelled")
                return

        resp = hybrid_sign_and_broadcast(
            lambda v: build_drop(w, recipients, each, args.memo, acc_num, seq, fee, v),
            chain_id=CHAIN_ID, rest_url=REST, sign_bytes_version="auto",
        )
        txr = resp.get("tx_response", {})
        if int(txr.get("code", 0)) != 0:
            die(f"refused by the node: code {txr.get('code')} {txr.get('codespace')}: {txr.get('raw_log')}")
        print(dim(f"\n  broadcast {txr['txhash']}, waiting for the block..."))
        included = wait_for_tx(r, txr["txhash"], timeout=90, poll_interval=1.0)
        report(r, included.tx_hash, w.address)


def cmd_verify(args: argparse.Namespace) -> None:
    with rest() as r:
        report(r, args.hash.upper(), None)


def _attr(a: dict, k: str) -> str:
    v = a.get(k) or ""
    return v


def report(r: RestClient, tx_hash: str, signer: str | None) -> None:
    """Prove the tx was hybrid-verified, straight from the chain's own record."""
    res = r.get(f"/cosmos/tx/v1beta1/txs/{tx_hash}")
    txr, tx = res["tx_response"], res["tx"]
    body = tx["body"]

    verify = []
    for ev in txr.get("events", []):
        if ev.get("type") == "pqc_hybrid_verify":
            attrs = {_attr(a, "key"): _attr(a, "value") for a in ev.get("attributes", [])}
            verify.append(attrs)
    ext = next((e for e in body.get("extension_options", []) if e.get("@type") == HYBRID_EXT), {})
    pqc_sig = base64.b64decode(ext.get("pqc_signature", "") or b"")
    classic = [base64.b64decode(s) for s in tx.get("signatures", [])]

    recipients, sent = 0, 0
    for m in body.get("messages", []):
        if m.get("@type") == "/cosmos.bank.v1beta1.MsgMultiSend":
            for o in m.get("outputs", []):
                recipients += 1
                sent += sum(int(c["amount"]) for c in o.get("coins", []) if c["denom"] == DENOM)
        elif m.get("@type") == "/cosmos.bank.v1beta1.MsgSend":
            recipients += 1
            sent += sum(int(c["amount"]) for c in m.get("amount", []) if c["denom"] == DENOM)

    signer = signer or (verify[0].get("address") if verify else None)
    mine = [v for v in verify if v.get("address") == signer] or verify
    status = mine[0].get("status", "?") if mine else "no pqc_hybrid_verify event"
    good = txr.get("code", 0) == 0 and status == "verified" and len(pqc_sig) == PQC_SIG_BYTES

    title("Verification report")
    row("tx hash", tx_hash)
    row("height", txr.get("height"))
    row("result", ok("success (code 0)") if txr.get("code", 0) == 0 else bad(f"code {txr.get('code')}"))
    row("signer", signer or "?")
    row("pqc_hybrid_verify", ok(status) if status == "verified" else bad(status))
    row("ML-DSA-87 sig", f"{len(pqc_sig):,} bytes" + ("" if len(pqc_sig) == PQC_SIG_BYTES else bad(f" (expected {PQC_SIG_BYTES})")))
    row("secp256k1 sig", ", ".join(f"{len(s)} bytes" for s in classic) or "?")
    row("recipients", recipients)
    if sent:
        row("sent", qor(sent))
    row("gas", f"{int(txr.get('gas_used', 0)):,} used of {int(txr.get('gas_wanted', 0)):,}")
    if body.get("memo"):
        row("memo", body["memo"])
    row("explorer", EXPLORER.format(tx_hash))
    print(dim("                     (switch the explorer to Testnet)"))
    print()
    if good:
        print("  " + ok("QUANTUM-SAFE: classical + ML-DSA-87 both verified on chain"))
    elif not ext:
        print("  " + warn("classical-only tx (normal for the one-time key registration)"))
    else:
        print("  " + bad("NOT verified as hybrid"))


def main() -> None:
    p = argparse.ArgumentParser(description="Q-Day Airdrop (QoreChain testnet)")
    p.add_argument("--key-file", type=lambda s: Path(s).expanduser(), default=DEFAULT_KEY_FILE)
    sub = p.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("new", help="create a key file and print the address")
    n.add_argument("--force", action="store_true", help="replace an existing key file")
    sub.add_parser("status", help="address, balance, PQC key")
    sub.add_parser("register", help="register the ML-DSA-87 key (idempotent)")
    d = sub.add_parser("drop", help="airdrop to every address in a file, one tx")
    d.add_argument("file")
    d.add_argument("amount", help="QOR per recipient, e.g. 0.1")
    d.add_argument("--memo", default="")
    d.add_argument("--yes", "-y", action="store_true", help="skip the confirmation")
    v = sub.add_parser("verify", help="verification report for a tx hash")
    v.add_argument("hash")
    args = p.parse_args()
    try:
        {"new": cmd_new, "status": cmd_status, "register": cmd_register,
         "drop": cmd_drop, "verify": cmd_verify}[args.cmd](args)
    except KeyboardInterrupt:
        print()
        sys.exit(130)
    except Exception as err:  # noqa: BLE001 - short message
        hint = ""
        if "HTTP 404" in str(err) and "/txs/" in str(err):
            die("transaction not found on the testnet (check the hash, or wait a few seconds)")
        if any(s in str(err).lower() for s in ("502", "503", "504", "connect", "timed out")):
            hint = " (the testnet may be pausing for an upgrade: wait a minute and retry)"
        die(f"{type(err).__name__}: {err}{hint}")


if __name__ == "__main__":
    main()
