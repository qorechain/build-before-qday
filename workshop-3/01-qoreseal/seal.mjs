// QoreSeal demo for Workshop 3: encrypt to a QoreChain address.
// Testnet (qorechain-diana) only. Keys live in ~/.config/qday-w3/<name>.json,
// readable only by you, and are never printed.
//
//   node seal.mjs help

import { encodeSecp256k1Pubkey } from "@cosmjs/amino";
import { encodePubkey, makeAuthInfoBytes } from "@cosmjs/proto-signing";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  addressFromPublicKey, buildRegisterPqKeyMessage, deriveCanonicalPqKey, deriveClassicalKey, signHybrid, toHex as hex,
} from "@qorechain/qoresign";
import { fetchPqKeyStatus, simulateTx, submitWithSignBytesFallback, broadcastTx } from "@qorechain/qoresign/network";
import {
  buildRegisterKemKeyMessage, deriveSealKeys, describeKemRegistryError, envelopeFromText, envelopeToText,
  open, parseEnvelope, signRecipientCard, toHex, verifyRecipientCard,
} from "@qorechain/qoreseal";
import { fetchKemKey, sealToAddresses } from "@qorechain/qoreseal/network";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REST = process.env.QORE_REST ?? "https://api-testnet.qore.host";
const CHAIN_ID = "qorechain-diana";
const EXPLORER = "https://dashboard.qorechain.io/explorer/tx/";
const PURPOSE = "qday-note";
const KEYDIR = process.env.QDAY_DIR ?? path.join(os.homedir(), ".config", "qday-w3");
const HERE = path.dirname(new URL(import.meta.url).pathname);
const CARDS = path.join(HERE, "cards");
const INBOX = path.join(HERE, "inbox");

const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };
const short = (a) => `${a.slice(0, 10)}…${a.slice(-6)}`;

// ---------- accounts ----------

function keyFile(name) {
  if (!/^[a-z0-9-]{1,20}$/.test(name ?? "")) throw new Error("use a short lowercase name, for example alice");
  return path.join(KEYDIR, `${name}.json`);
}

function load(name) {
  const f = keyFile(name);
  if (!fs.existsSync(f)) throw new Error(`no account "${name}": run  node seal.mjs init ${name}`);
  const saved = JSON.parse(fs.readFileSync(f, "utf8"));
  const classical = deriveClassicalKey({ mnemonic: saved.mnemonic });
  const address = addressFromPublicKey(classical.publicKey, "secp256k1").bech32;
  const pq = deriveCanonicalPqKey({ mnemonic: saved.mnemonic, address });
  const index = saved.kemIndex ?? 0;
  const sealKeys = (i) => deriveSealKeys({ mnemonic: saved.mnemonic, index: i });
  return { name, file: f, saved, classical, address, pq, index, sealKeys };
}

function save(acc) {
  fs.writeFileSync(acc.file, JSON.stringify(acc.saved), { mode: 0o600 });
}

// ---------- chain helpers ----------

async function getJson(p) {
  const r = await fetch(`${REST}${p}`);
  return r.ok ? r.json() : null;
}

async function balance(address) {
  const b = await getJson(`/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uqor`);
  return Number(b?.balance?.amount ?? 0) / 1e6;
}

async function sendTx(acc, msgs, mode = "hybrid", memo = "") {
  const info = (await getJson(`/cosmos/auth/v1beta1/account_info/${acc.address}`))?.info;
  if (!info) throw new Error(`${acc.name} does not exist on chain yet: fund ${acc.address} first`);
  const bodyBytes = TxBody.encode(TxBody.fromPartial({ messages: msgs, memo })).finish();
  const sign = (gas) =>
    signHybrid({
      chainId: CHAIN_ID,
      accountNumber: BigInt(info.account_number),
      bodyBytes,
      authInfoBytes: makeAuthInfoBytes(
        [{ pubkey: encodePubkey(encodeSecp256k1Pubkey(acc.classical.publicKey)), sequence: BigInt(info.sequence ?? "0") }],
        [{ denom: "uqor", amount: ((gas + 9n) / 10n).toString() }],
        Number(gas), undefined, undefined, 1,
      ),
      classicalKey: acc.classical,
      pqKey: acc.pq,
      mode,
    }).txBytes;
  const sim = await simulateTx({ rest: REST, txBytes: sign(600_000n) });
  const res = mode === "hybrid"
    ? await submitWithSignBytesFallback({ rest: REST, chainId: CHAIN_ID, sign: () => sign(sim.suggestedGasLimit) })
    : await broadcastTx({ rest: REST, txBytes: sign(sim.suggestedGasLimit) });
  if (res.code !== 0) throw new Error(`refused: ${describeKemRegistryError(res.codespace, res.code) ?? res.log}`);
  for (let i = 0; i < 40; i++) {
    const tx = await getJson(`/cosmos/tx/v1beta1/txs/${res.txhash}`);
    if (tx) {
      if (tx.tx_response.code !== 0) throw new Error(`failed in block: ${tx.tx_response.raw_log}`);
      return res.txhash;
    }
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  throw new Error(`${res.txhash} was not committed`);
}

// ---------- cards and envelopes ----------

function cardPath(name) { return path.join(CARDS, `${name}.json`); }

function writeCard(acc) {
  fs.mkdirSync(CARDS, { recursive: true });
  const card = signRecipientCard({ chainId: CHAIN_ID, address: acc.address, keys: acc.sealKeys(acc.index), classicalKey: acc.classical, pqKey: acc.pq });
  fs.writeFileSync(cardPath(acc.name), JSON.stringify(card, null, 2));
  return card;
}

function readCard(name) {
  const f = cardPath(name);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}

// ---------- commands ----------

const cmds = {
  async init(name) {
    fs.mkdirSync(KEYDIR, { recursive: true, mode: 0o700 });
    const f = keyFile(name);
    if (fs.existsSync(f)) { console.log(`${name} already exists: ${load(name).address}`); return; }
    fs.writeFileSync(f, JSON.stringify({ mnemonic: generateMnemonic(wordlist, 256), kemIndex: 0 }), { mode: 0o600 });
    const acc = load(name);
    console.log(`${c.b(name)} created: ${acc.address}`);
    console.log(c.d(`keys saved in ${f} (only you can read it). Fund the address from the faucet.`));
  },

  async whoami() {
    const names = fs.existsSync(KEYDIR) ? fs.readdirSync(KEYDIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
    for (const n of names) {
      const acc = load(n);
      const kem = await fetchKemKey({ rest: REST, address: acc.address });
      const pq = await fetchPqKeyStatus({ rest: REST, address: acc.address });
      console.log(`${c.b(n.padEnd(6))} ${acc.address}  ${(await balance(acc.address)).toFixed(2)} QOR  ML-DSA-87: ${pq.registered ? "yes" : "no"}  ML-KEM-1024: ${kem.registered ? `yes (key #${acc.index})` : "no"}`);
    }
  },

  // Pay test QOR from one of your accounts to another (testnet).
  async fund(from, to, qor = "2") {
    const a = load(from);
    const dest = to.startsWith("qor1") ? to : load(to).address;
    const msg = { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: MsgSend.encode({ fromAddress: a.address, toAddress: dest, amount: [{ denom: "uqor", amount: String(Math.round(Number(qor) * 1e6)) }] }).finish() };
    const tx = await sendTx(a, [msg]);
    console.log(`sent ${qor} QOR to ${short(dest)}  ${EXPLORER}${tx}`);
  },

  // Step 1: put both public keys on chain.
  async register(name) {
    const acc = load(name);
    const pq = await fetchPqKeyStatus({ rest: REST, address: acc.address });
    if (!pq.registered) {
      console.log("1/2 registering the ML-DSA-87 signing key (with proof of possession)...");
      const msg = buildRegisterPqKeyMessage({ chainId: CHAIN_ID, account: acc.address, pqKey: acc.pq, classicalPublicKey: acc.classical.publicKey });
      const tx = await sendTx(acc, [msg], "classicalOnly");
      console.log(`    ${c.g("done")}  ${EXPLORER}${tx}`);
    } else {
      console.log(`1/2 ML-DSA-87 signing key: already registered`);
    }
    const keys = acc.sealKeys(acc.index);
    const kem = await fetchKemKey({ rest: REST, address: acc.address });
    if (kem.registered && toHex(kem.publicKey) === toHex(keys.mlkemPublicKey)) {
      console.log(`2/2 ML-KEM-1024 encryption key #${acc.index}: already registered`);
    } else {
      console.log(`2/2 registering the ML-KEM-1024 encryption key #${acc.index} (${keys.mlkemPublicKey.length} bytes), signed with both keys...`);
      const tx = await sendTx(acc, [buildRegisterKemKeyMessage({ sender: acc.address, mlkemPublicKey: keys.mlkemPublicKey })]);
      console.log(`    ${c.g("done")}  ${EXPLORER}${tx}`);
    }
    writeCard(acc);
    console.log(`recipient card signed and published to cards/${name}.json`);
  },

  // What anyone can read about an address.
  async lookup(name) {
    const address = name.startsWith("qor1") ? name : load(name).address;
    const kem = await fetchKemKey({ rest: REST, address });
    console.log(`GET ${REST}/qorechain/pqc/v1/kem/${address}`);
    if (!kem.registered) { console.log(c.r("no ML-KEM key registered for this address")); return; }
    console.log(`  algorithm     ML-KEM-1024 (FIPS 203)`);
    console.log(`  public key    ${kem.publicKey.length} bytes  ${toHex(kem.publicKey).slice(0, 32)}…`);
    console.log(`  registered at block ${kem.registeredHeight}`);
    const card = name.startsWith("qor1") ? null : readCard(name);
    if (card) {
      try {
        const pq = await fetchPqKeyStatus({ rest: REST, address });
        verifyRecipientCard({ card, chainId: CHAIN_ID, address, mlkemPublicKey: kem.publicKey, pqPublicKey: pq.publicKey });
        console.log(`  card          ${c.g("valid")}: signed by the account, X25519 key bound to the key on chain`);
      } catch (e) {
        console.log(`  card          ${c.r("NOT valid")}: ${e.message}`);
      }
    }
  },

  // Step 2: anyone encrypts to an address. Only the address and the card are needed.
  async send(to, ...words) {
    const text = words.join(" ");
    if (!text) throw new Error('usage: node seal.mjs send alice "your message"');
    const names = to.split(",");
    const recipients = names.map((n) => ({ address: load(n).address, card: readCard(n) ?? undefined }));
    const envelope = await sealToAddresses({ rest: REST, chainId: CHAIN_ID, purpose: PURPOSE, recipients, plaintext: new TextEncoder().encode(text) });
    fs.mkdirSync(INBOX, { recursive: true });
    const file = path.join(INBOX, `${Date.now()}.qoreseal`);
    const armored = envelopeToText(envelope);
    fs.writeFileSync(file, armored);
    console.log(`read the ML-KEM-1024 key of ${names.join(" and ")} from the chain, checked the card, sealed`);
    console.log(`${text.length} characters in, ${envelope.length} bytes out  ->  ${path.relative(process.cwd(), file)}`);
    console.log(c.d(armored.slice(0, 120) + "…"));
  },

  // Step 3: the recipient opens it. Tries the current key, then older keys.
  async open(name, file) {
    const acc = load(name);
    const f = file ?? latestEnvelope();
    const envelope = envelopeFromText(fs.readFileSync(f, "utf8").trim());
    for (let i = acc.index; i >= 0; i--) {
      try {
        const pt = open({ chainId: CHAIN_ID, purpose: PURPOSE, envelope, keys: acc.sealKeys(i) });
        console.log(`${c.g("OPENED")} by ${name} with encryption key #${i}${i !== acc.index ? " (an older key)" : ""}:`);
        console.log(`  "${new TextDecoder().decode(pt)}"`);
        return;
      } catch { /* try the next key */ }
    }
    console.log(`${c.r("CANNOT OPEN")}: ${name} holds none of the keys this envelope was sealed to`);
    process.exitCode = 1;
  },

  // Change one byte and try again.
  async tamper(name, file) {
    const acc = load(name);
    const f = file ?? latestEnvelope();
    const envelope = envelopeFromText(fs.readFileSync(f, "utf8").trim());
    envelope[envelope.length - 20] ^= 0x01;
    try {
      open({ chainId: CHAIN_ID, purpose: PURPOSE, envelope, keys: acc.sealKeys(acc.index) });
      console.log(c.r("opened a tampered envelope (should never happen)"));
    } catch (e) {
      console.log(`${c.g("REFUSED")}: one bit changed, the envelope no longer opens (${e.code ?? e.message})`);
    }
  },

  async inspect(file) {
    const f = file ?? latestEnvelope();
    const env = parseEnvelope(envelopeFromText(fs.readFileSync(f, "utf8").trim()));
    console.log(JSON.stringify(env, (k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : typeof v === "bigint" ? String(v) : v), 2).slice(0, 1500));
  },

  // Key rotation: move to the next key, register it, sign a new card.
  async rotate(name) {
    const acc = load(name);
    acc.saved.kemIndex = acc.index + 1;
    save(acc);
    const next = load(name);
    console.log(`rotating ${name}: encryption key #${acc.index} -> #${next.index}`);
    const oldCard = readCard(name);
    const tx = await sendTx(next, [buildRegisterKemKeyMessage({ sender: next.address, mlkemPublicKey: next.sealKeys(next.index).mlkemPublicKey })]);
    console.log(`  new ML-KEM-1024 key registered (replaces the old one)  ${EXPLORER}${tx}`);
    if (oldCard) {
      const kem = await fetchKemKey({ rest: REST, address: next.address });
      try {
        verifyRecipientCard({ card: oldCard, chainId: CHAIN_ID, address: next.address, mlkemPublicKey: kem.publicKey, pqPublicKey: next.pq.publicKey });
        console.log(c.r("  the old card still verifies (should not happen)"));
      } catch (e) {
        console.log(`  the old card is now ${c.g("refused")}: ${e.message}`);
      }
    }
    writeCard(next);
    console.log(`  new card published to cards/${name}.json`);
    console.log(c.d("  old envelopes still need the old key: it is derived again from the same mnemonic, index " + acc.index));
  },
};

function latestEnvelope() {
  const files = fs.existsSync(INBOX) ? fs.readdirSync(INBOX).filter((f) => f.endsWith(".qoreseal")).sort() : [];
  if (!files.length) throw new Error("no envelope yet: run  node seal.mjs send <name> \"message\"");
  return path.join(INBOX, files.at(-1));
}

const HELP = `
QoreSeal demo (testnet). Accounts are short names: alice, bob, eve.

  node seal.mjs init <name>                create a testnet account (keys stay on this computer)
  node seal.mjs whoami                     every account: address, QOR, keys on chain
  node seal.mjs fund <from> <to> [QOR]     move test QOR between your accounts
  node seal.mjs register <name>            put the ML-DSA-87 and ML-KEM-1024 public keys on chain, sign the card
  node seal.mjs lookup <name|qor1...>      what anyone can read: the key on chain, and whether the card is valid
  node seal.mjs send <name[,name]> "text"  encrypt to one or more addresses
  node seal.mjs open <name> [file]         decrypt the latest envelope (or a file)
  node seal.mjs tamper <name> [file]       flip one bit and try to open it
  node seal.mjs inspect [file]             what is inside an envelope, without the secret
  node seal.mjs rotate <name>              move to a new encryption key; old envelopes still open
`;

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || !cmds[cmd]) { console.log(HELP); process.exit(cmd && cmd !== "help" ? 1 : 0); }
try {
  await cmds[cmd](...args);
} catch (e) {
  console.error(c.r(`error: ${e.message}`));
  process.exit(1);
}
