// agent.mjs - a bill-paying agent whose limits are enforced by QoreChain itself.
// QoreChain diana testnet only. Never prints key material.
//
// Three keys, three roles:
//   owner   your account (hybrid secp256k1 + ML-DSA-87). Holds the money, sets the rules.
//   agent   an ed25519 key the agent holds. It can ask to spend from the owner's
//           account, but only inside the rules the owner wrote on chain.
//   gas     the agent's small fee wallet (hybrid). It submits the agent's requests
//           and pays the fees. It never holds the owner's money.
//
//   node agent.mjs init                          create the agent key and its gas wallet
//   node agent.mjs owner-init                    create a throwaway owner account (testnet)
//   node agent.mjs whoami                        addresses of owner, agent and gas wallet
//   node agent.mjs register owner|gas            register the account's ML-DSA-87 key (once)
//   node agent.mjs link <perTxQOR> <dailyQOR> [hours]   owner links the agent with limits
//   node agent.mjs rules                         what the chain enforces for this agent
//   node agent.mjs pay <to> <QOR> [memo]         the agent pays one bill
//   node agent.mjs run <bills.json>              the agent pays a list of bills
//   node agent.mjs revoke                        owner revokes the agent
//   node agent.mjs balance                       balances of owner and gas wallet
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StargateClient } from "@cosmjs/stargate";
import { ed25519 } from "@noble/curves/ed25519";
import {
  EthNativeSigner, deriveUnifiedAccount, generateMnemonic, fetchPqcStatus,
  buildRegisterPqcKeyMsg, signProofOfPossession,
  signAuthenticatorLinkEd25519, linkAuthenticatorMsgs, revokeAuthenticatorMsg,
  buildPhantomExecuteCosmos, fetchAuthNonce, fetchSpendingRules, fetchAuthenticators,
  decodeAuthenticatorExecutions,
} from "@qorechain/sdk";

const CHAIN_ID = "qorechain-diana";
const REST = process.env.QORE_REST ?? "https://api-testnet.qore.host";
const RPC = process.env.QORE_RPC ?? "https://rpc-testnet.qore.host";
const EXPLORER = "https://explore.qore.network/tx/";
const DIR = process.env.QDAY_DIR ?? join(homedir(), ".config", "qday");
const OWNER_ENV = process.env.OWNER_ENV ?? join(DIR, "owner.env");
const AGENT_ENV = process.env.AGENT_ENV ?? join(DIR, "agent.env");

const readEnv = (file) => {
  if (!existsSync(file)) throw new Error(`missing ${file}: run "node agent.mjs ${file === AGENT_ENV ? "init" : "owner-init"}" first`);
  return Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"(.*)"$/, "$1")]));
};
const writeSecret = (file, lines) => {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (existsSync(file)) throw new Error(`${file} already exists; not overwriting`);
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
};
const toUqor = (qor) => {
  if (!/^\d+(\.\d{1,6})?$/.test(String(qor))) throw new Error(`amount in QOR, e.g. 1 or 0.5 (got "${qor}")`);
  const [i, f = ""] = String(qor).split(".");
  return (BigInt(i) * 1000000n + BigInt((f + "000000").slice(0, 6))).toString();
};
const fmt = (uqor) => `${(Number(uqor) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} QOR`;
const hex = (b) => Buffer.from(b).toString("hex");

const owner = async () => deriveUnifiedAccount(readEnv(OWNER_ENV).QORE_MNEMONIC, 0);
const gas = async () => deriveUnifiedAccount(readEnv(AGENT_ENV).GAS_MNEMONIC, 0);
const agentKey = () => {
  const sk = Uint8Array.from(Buffer.from(readEnv(AGENT_ENV).AGENT_ED25519_KEY, "hex"));
  const pk = ed25519.getPublicKey(sk);
  return { sk, pk, wallet: { publicKey: pk, async signMessage(m) { return { signature: ed25519.sign(m, sk) }; } } };
};

async function getJson(path) {
  const r = await fetch(`${REST}${path}`);
  return r.status === 200 ? r.json() : null;
}
async function balance(addr) {
  const b = await getJson(`/cosmos/bank/v1beta1/balances/${addr}`);
  return b?.balances?.find((x) => x.denom === "uqor")?.amount ?? "0";
}

// Sign with the account's keys and broadcast. mode: "hybrid" (normal) or
// "classical" (only for the one-time ML-DSA key registration).
async function broadcast(acc, messages, memo, mode = "hybrid") {
  const a = await getJson(`/cosmos/auth/v1beta1/accounts/${acc.cosmos}`);
  const base = a?.account?.base_account ?? a?.account ?? {};
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: REST });
  const transport = await StargateClient.connect(RPC);
  const req = { chainId: CHAIN_ID, accountNumber: BigInt(base.account_number ?? 0), sequence: BigInt(base.sequence ?? 0), memo, messages };
  try {
    let gasLimit = 800000;
    try { const sim = await signer.simulate?.(transport, req); if (sim) gasLimit = Math.ceil(Number(sim) * 1.4); } catch { /* keep the generous default */ }
    const fee = { amount: [{ denom: "uqor", amount: String(Math.ceil(gasLimit * 0.15)) }], gas: String(gasLimit) };
    return await signer.signAndBroadcast(transport, { ...req, fee });
  } finally { transport.disconnect(); }
}

// The chain's own record of the transaction: code and the hybrid check.
async function onChain(hash) {
  for (let i = 0; i < 20; i++) {
    const t = await getJson(`/cosmos/tx/v1beta1/txs/${hash}`);
    if (t) {
      const ev = t.tx_response.events.filter((e) => e.type === "pqc_hybrid_verify")
        .map((e) => Object.fromEntries(e.attributes.map((x) => [x.key, x.value])));
      return { code: t.tx_response.code, events: t.tx_response.events, hybrid: ev.some((e) => e.status === "verified") };
    }
    await new Promise((s) => setTimeout(s, 3000));
  }
  return null;
}

const cmds = {
  async init() {
    const sk = randomBytes(32);
    const gasMnemonic = generateMnemonic(256);
    writeSecret(AGENT_ENV, [
      "# Build Before Q-Day agent keys. QoreChain diana TESTNET only. Never fund on mainnet.",
      `AGENT_ED25519_KEY=${sk.toString("hex")}`,
      `GAS_MNEMONIC="${gasMnemonic}"`,
    ]);
    const g = await deriveUnifiedAccount(gasMnemonic, 0);
    console.log(`agent key   ed25519 ${hex(ed25519.getPublicKey(sk)).slice(0, 16)}...  (saved in ${AGENT_ENV})`);
    console.log(`gas wallet  ${g.cosmos}`);
    console.log(`\nNext: send ~3 testnet QOR to the gas wallet, then: node agent.mjs register gas`);
  },
  async "owner-init"() {
    const m = generateMnemonic(256);
    writeSecret(OWNER_ENV, ["# Build Before Q-Day owner account. QoreChain diana TESTNET only.", `QORE_MNEMONIC="${m}"`]);
    console.log(`owner       ${(await deriveUnifiedAccount(m, 0)).cosmos}  (saved in ${OWNER_ENV})`);
  },
  async whoami() {
    const o = existsSync(OWNER_ENV) ? (await owner()).cosmos : "(no owner yet)";
    console.log(`owner       ${o}`);
    if (existsSync(AGENT_ENV)) {
      console.log(`agent key   ed25519 ${hex(agentKey().pk).slice(0, 16)}...`);
      console.log(`gas wallet  ${(await gas()).cosmos}`);
    }
  },
  async register(who) {
    const acc = who === "gas" ? await gas() : await owner();
    const st = await fetchPqcStatus({ rest: REST, address: acc.cosmos });
    if (st.registered) { console.log(`${acc.cosmos}: ML-DSA-87 key already registered`); return; }
    const pop = signProofOfPossession({ chainId: CHAIN_ID, account: acc.cosmos, keypair: acc.pqc });
    const msg = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession: pop });
    const res = await broadcast(acc, [msg], "register ML-DSA-87 key", "classical");
    console.log(res.code === 0 ? `${acc.cosmos}: ML-DSA-87 key registered  ${res.transactionHash}` : `REFUSED code ${res.code}: ${res.rawLog}`);
    if (res.code) process.exitCode = 1;
  },
  async link(perTx, daily, hours = "24") {
    const o = await owner(), k = agentKey();
    const proof = signAuthenticatorLinkEd25519({ chainId: CHAIN_ID, account: o.cosmos, privateKey: k.sk });
    const msgs = linkAuthenticatorMsgs({
      owner: o.cosmos, chainId: CHAIN_ID, ...proof,
      permissions: ["send"],
      expiryUnix: Math.floor(Date.now() / 1000) + Number(hours) * 3600,
      label: "bill-payer agent",
      spendingRule: { id: "agent", enabled: true, perTxLimit: toUqor(perTx), dailyLimit: toUqor(daily), allowedDenoms: ["uqor"] },
    });
    const res = await broadcast(o, msgs, "link bill-payer agent");
    if (res.code) { console.log(`REFUSED code ${res.code}: ${res.rawLog}`); process.exitCode = 1; return; }
    const c = await onChain(res.transactionHash);
    console.log(`agent linked to ${o.cosmos}`);
    console.log(`  may do      send QOR only`);
    console.log(`  per payment ${perTx} QOR   per day ${daily} QOR   expires in ${hours} h`);
    console.log(`  owner tx    ${res.transactionHash}  ${c?.hybrid ? "hybrid ML-DSA-87: verified" : ""}`);
  },
  async rules() {
    const o = await owner(), k = agentKey();
    const [r, auths, n] = await Promise.all([
      fetchSpendingRules({ rest: REST, address: o.cosmos }),
      fetchAuthenticators({ rest: REST, address: o.cosmos }),
      fetchAuthNonce({ rest: REST, address: o.cosmos, pubkey: k.pk }),
    ]);
    const me = auths.find((a) => a.pubkeyHex.toLowerCase() === hex(k.pk));
    console.log(`account ${o.cosmos}  balance ${fmt(await balance(o.cosmos))}`);
    for (const x of r.rules) console.log(`  rule "${x.id}" ${x.enabled ? "on" : "off"}: per payment ${fmt(x.perTxLimit)}, per day ${fmt(x.dailyLimit)}, denoms ${x.allowedDenoms.join(",") || "any"}`);
    if (!me) { console.log("  agent key: not linked"); return; }
    console.log(`  agent key: ${me.revoked ? "REVOKED" : "linked"}, may: ${me.permissions.join(",")}, expires ${new Date(Number(me.expiryUnix) * 1000).toISOString().slice(0, 16)}Z, payments made: ${n.nonce}`);
  },
  async pay(to, qor, memo = "agent payment") {
    const o = await owner(), g = await gas(), k = agentKey();
    const { nonce } = await fetchAuthNonce({ rest: REST, address: o.cosmos, pubkey: k.pk });
    const msg = await buildPhantomExecuteCosmos({ wallet: k.wallet, relayer: g.cosmos, chainId: CHAIN_ID, account: o.cosmos, to, amount: `${toUqor(qor)}uqor`, nonce });
    let res;
    try { res = await broadcast(g, [msg], memo); } catch (e) {
      const why = String(e?.message ?? e).match(/: ([^:()]*(revoked|expired|not permitted)[^()]*)\)/)?.[1] ?? String(e?.message ?? e);
      console.log(`  ${qor} QOR -> ${to.slice(0, 14)}...  REFUSED BY THE CHAIN: ${why}`);
      process.exitCode = 1; return false;
    }
    if (res.code) { console.log(`  ${qor} QOR -> ${to}: REFUSED code ${res.code}: ${res.rawLog}`); process.exitCode = 1; return false; }
    const c = await onChain(res.transactionHash);
    const [x] = decodeAuthenticatorExecutions({ msgResponses: res.msgResponses ?? [], events: c?.events ?? res.events ?? [] }, [msg]);
    if (x && !x.success) {
      console.log(`  ${qor} QOR -> ${to.slice(0, 14)}...  REFUSED BY THE CHAIN: ${x.reason || x.vmError || "execution failed"}`);
      console.log(`      ${EXPLORER}${res.transactionHash}`);
      return false;
    }
    console.log(`  ${qor} QOR -> ${to.slice(0, 14)}...  PAID  (${memo})${c?.hybrid ? "  hybrid ML-DSA-87: verified" : ""}`);
    console.log(`      ${EXPLORER}${res.transactionHash}`);
    return true;
  },
  async run(file) {
    const bills = JSON.parse(readFileSync(file, "utf8"));
    console.log(`agent: ${bills.length} bills to pay from ${(await owner()).cosmos}\n`);
    let paid = 0;
    for (const b of bills) {
      console.log(`- ${b.name}: ${b.qor} QOR`);
      if (await cmds.pay(b.to, String(b.qor), b.name)) paid++;
    }
    console.log(`\nagent: ${paid} paid, ${bills.length - paid} refused by the chain`);
    process.exitCode = 0;
  },
  async revoke() {
    const o = await owner(), k = agentKey();
    const res = await broadcast(o, [revokeAuthenticatorMsg({ owner: o.cosmos, scheme: "ed25519", pubkey: k.pk })], "revoke agent");
    console.log(res.code === 0 ? `agent revoked  ${res.transactionHash}` : `REFUSED code ${res.code}: ${res.rawLog}`);
    if (res.code) process.exitCode = 1;
  },
  async balance() {
    const o = await owner(), g = await gas();
    console.log(`owner       ${o.cosmos}  ${fmt(await balance(o.cosmos))}`);
    console.log(`gas wallet  ${g.cosmos}  ${fmt(await balance(g.cosmos))}`);
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmds[cmd]) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(cmd ? 1 : 0);
}
cmds[cmd](...args).catch((e) => { console.error(`error: ${e?.message ?? e}`); process.exitCode = 1; });
