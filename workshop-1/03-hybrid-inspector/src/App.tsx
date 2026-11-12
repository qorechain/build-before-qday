import { useEffect, useState } from "react";

import { getQorexNative, qorexSignAndBroadcast } from "@qorechain/qorex-types";

// Testnet only. The REST calls go through the Vite proxy (/lcd -> api-testnet.qore.host).
const CHAIN_ID = "qorechain-diana";
const LCD = "/lcd";
const EXPLORER = "https://explore.qore.network/tx/";
const DASHBOARD_EXPLORER = "https://dashboard.qorechain.io/explorer/tx/";
const MLDSA87_SIG_BYTES = 4627; // FIPS 204, ML-DSA-87 signature size

// ---------- minimal protobuf for MsgSend (QoreX takes the encoded message) ----------
const varint = (n: number): number[] => {
  const o: number[] = [];
  while (n > 0x7f) {
    o.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  o.push(n);
  return o;
};
const field = (no: number, b: number[]): number[] => [(no << 3) | 2, ...varint(b.length), ...b];
const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)];
const msgSendBytes = (from: string, to: string, uqor: string): number[] => [
  ...field(1, utf8(from)),
  ...field(2, utf8(to)),
  ...field(3, [...field(1, utf8("uqor")), ...field(2, utf8(uqor))]),
];

// ---------- REST helpers ----------
async function lcd<T>(path: string): Promise<{ status: number; body: T | null }> {
  const r = await fetch(`${LCD}${path}`);
  let body: T | null = null;
  try {
    body = (await r.json()) as T;
  } catch {
    body = null;
  }
  return { status: r.status, body };
}

const b64len = (s?: string): number => (s ? atob(s).length : 0);
const b64hex = (s?: string, n = 24): string => {
  if (!s) return "";
  const bin = atob(s);
  let h = "";
  for (let i = 0; i < Math.min(n, bin.length); i++) h += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return h;
};
const qor = (uqor: string | number): string => (Number(uqor) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });

interface Inspection {
  hash: string;
  height: string;
  time: string;
  code: number;
  rawLog: string;
  gasUsed: string;
  memo: string;
  msgs: string[];
  signer: string;
  classicalKeyType: string;
  classicalSigBytes: number;
  classicalSigHex: string;
  pqcType: string | null;
  pqcAlgorithm: string | null;
  pqcSigBytes: number;
  pqcSigHex: string;
  verify: Array<Record<string, string>>;
}

async function inspect(hash: string): Promise<Inspection> {
  let res: { status: number; body: any } = { status: 0, body: null };
  for (let i = 0; i < 15; i++) {
    res = await lcd<any>(`/cosmos/tx/v1beta1/txs/${hash}`);
    if (res.status === 200) break;
    await new Promise((s) => setTimeout(s, 2000));
  }
  if (res.status !== 200 || !res.body?.tx_response) throw new Error(`Transaction not found on qorechain-diana (HTTP ${res.status}).`);
  const r = res.body.tx_response;
  const tx = res.body.tx;
  const ext = [...(tx.body.extension_options ?? []), ...(tx.body.non_critical_extension_options ?? [])];
  const hyb = ext.find((x: any) => String(x["@type"]).includes("PQCHybridSignature"));
  const verify = (r.events ?? [])
    .filter((e: any) => e.type === "pqc_hybrid_verify")
    .map((e: any) => Object.fromEntries(e.attributes.map((a: any) => [a.key, a.value])));
  const firstMsg = tx.body.messages[0] ?? {};
  return {
    hash: r.txhash,
    height: r.height,
    time: r.timestamp,
    code: r.code,
    rawLog: r.raw_log,
    gasUsed: r.gas_used,
    memo: tx.body.memo,
    msgs: tx.body.messages.map((m: any) => m["@type"]),
    signer: firstMsg.from_address ?? firstMsg.sender ?? verify[0]?.address ?? "",
    classicalKeyType: tx.auth_info.signer_infos[0]?.public_key?.["@type"] ?? "",
    classicalSigBytes: b64len(tx.signatures?.[0]),
    classicalSigHex: b64hex(tx.signatures?.[0]),
    pqcType: hyb ? hyb["@type"] : null,
    pqcAlgorithm: hyb ? String(hyb.algorithm_id) : null,
    pqcSigBytes: b64len(hyb?.pqc_signature),
    pqcSigHex: b64hex(hyb?.pqc_signature),
    verify,
  };
}

function algoName(id: string | null | undefined): string {
  if (!id) return "n/a";
  if (id === "1" || id === "dilithium5" || id.toUpperCase() === "ALGORITHM_DILITHIUM5") return "ML-DSA-87 (FIPS 204)";
  return id;
}

export function App(): JSX.Element {
  const [height, setHeight] = useState<string>("...");
  const [address, setAddress] = useState<string>("");
  const [balance, setBalance] = useState<string>("");
  const [pqcKey, setPqcKey] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [amount, setAmount] = useState<string>("1");
  const [memo, setMemo] = useState<string>("Build Before Q-Day Workshop 1");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ txHash: string; code: number; shield: string } | null>(null);
  const [hash, setHash] = useState<string>(new URLSearchParams(location.search).get("tx") ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Inspection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const tick = async () => {
      const r = await lcd<any>("/cosmos/base/node/v1beta1/status").catch(() => null);
      if (r?.body?.height) setHeight(Number(r.body.height).toLocaleString("en-US"));
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (hash) void runInspect(hash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshAccount(addr: string): Promise<void> {
    const b = await lcd<any>(`/cosmos/bank/v1beta1/balances/${addr}`);
    const u = b.body?.balances?.find((x: any) => x.denom === "uqor")?.amount ?? "0";
    setBalance(qor(u));
    const p = await lcd<any>(`/qorechain/pqc/v1/account/${addr}`);
    setPqcKey(p.body?.found ? `registered (${b64len(p.body.account?.public_key)}-byte ML-DSA-87 public key)` : "not registered yet (QoreX registers it on the first send)");
  }

  async function connect(): Promise<void> {
    setError(null);
    const native = getQorexNative();
    if (!native) {
      setError("QoreX was not found in this page. Install the QoreX extension, switch it to testnet, and reload.");
      return;
    }
    try {
      await native.enable(CHAIN_ID);
      const key = await native.getKey(CHAIN_ID);
      setAddress(key.bech32Address);
      setTo((t) => t || key.bech32Address);
      await refreshAccount(key.bech32Address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function send(): Promise<void> {
    setError(null);
    setSent(null);
    setSending(true);
    try {
      const uqor = String(Math.round(Number(amount) * 1e6));
      if (!/^\d+$/.test(uqor) || uqor === "0") throw new Error("Enter an amount in QOR, for example 1.");
      const r = await qorexSignAndBroadcast({
        chainId: CHAIN_ID,
        messages: [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: msgSendBytes(address, to.trim(), uqor) }],
        memo,
      });
      setSent({ txHash: r.txHash, code: r.code, shield: String(r.shield) });
      setHash(r.txHash);
      await runInspect(r.txHash);
      await refreshAccount(address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  async function runInspect(h: string): Promise<void> {
    setError(null);
    setResult(null);
    const clean = h.trim().replace(/^0x/, "").toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(clean)) {
      setError("A transaction hash is 64 hex characters.");
      return;
    }
    setBusy(true);
    try {
      setResult(await inspect(clean));
      history.replaceState(null, "", `?tx=${clean}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const verified = result?.verify.some((v) => v.status === "verified") ?? false;
  const hybridOk = !!result && result.code === 0 && verified && result.pqcSigBytes === MLDSA87_SIG_BYTES;

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <img src="/qc-icon.png" alt="" width={32} height={32} />
          <span className="wordmark">
            <b>QORE</b>CHAIN
          </span>
          <span className="tag">Hybrid Inspector</span>
        </div>
        <div className="net">
          <span className="dot" /> qorechain-diana (testnet) &middot; block <b>{height}</b>
        </div>
      </header>

      <p className="lead">
        Every QoreChain transaction is signed twice: once with classical <b>secp256k1</b> and once with post-quantum{" "}
        <b>ML-DSA-87</b> (NIST FIPS 204). The chain checks both. This page sends one and shows you the proof.
      </p>

      <section className="card">
        <h2>
          <span className="n">1</span> Connect QoreX
        </h2>
        {!address ? (
          <button onClick={connect}>Connect QoreX</button>
        ) : (
          <div className="kv">
            <div>Address</div>
            <code>{address}</code>
            <div>Balance</div>
            <span>{balance} QOR (testnet)</span>
            <div>Post-quantum key</div>
            <span>{pqcKey}</span>
          </div>
        )}
      </section>

      <section className={`card ${address ? "" : "dim"}`}>
        <h2>
          <span className="n">2</span> Send a hybrid transaction
        </h2>
        <div className="form">
          <label>
            To
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="qor1..." disabled={!address} />
          </label>
          <label className="short">
            Amount (QOR)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} disabled={!address} />
          </label>
          <label>
            Memo
            <input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={200} disabled={!address} />
          </label>
        </div>
        <button onClick={send} disabled={!address || sending}>
          {sending ? "Waiting for QoreX approval and the block..." : "Sign with QoreX and send"}
        </button>
        {sent && (
          <p className="small">
            QoreX: code <b>{sent.code}</b>, shield <b>{sent.shield}</b>, tx <code>{sent.txHash}</code>
          </p>
        )}
      </section>

      <section className="card">
        <h2>
          <span className="n">3</span> Verify on chain
        </h2>
        <div className="row">
          <input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="Paste any diana transaction hash" />
          <button onClick={() => runInspect(hash)} disabled={busy}>
            {busy ? "Reading the chain..." : "Inspect"}
          </button>
        </div>

        {result && (
          <div className="result">
            <div className={`verdict ${hybridOk ? "ok" : "bad"}`}>
              {hybridOk ? (
                <>
                  <span className="big">Quantum-safe signature verified on chain</span>
                  <span>secp256k1 + ML-DSA-87, both checked by the validators in block {Number(result.height).toLocaleString("en-US")}</span>
                </>
              ) : (
                <>
                  <span className="big">No verified hybrid signature</span>
                  <span>
                    code {result.code}
                    {result.code !== 0 ? `: ${result.rawLog}` : ""}
                  </span>
                </>
              )}
            </div>

            <div className="sigs">
              <div className="sig">
                <h3>Classical signature</h3>
                <p className="algo">secp256k1 (ECDSA)</p>
                <div className="bar">
                  <div style={{ width: `${Math.max(1.5, (result.classicalSigBytes / MLDSA87_SIG_BYTES) * 100)}%` }} />
                </div>
                <p>
                  <b>{result.classicalSigBytes}</b> bytes &middot; key <code>{result.classicalKeyType.split(".").slice(-2).join(".")}</code>
                </p>
                <code className="hex">{result.classicalSigHex}...</code>
                <p className="hint">Breakable by a large quantum computer (Shor's algorithm).</p>
              </div>
              <div className="sig pq">
                <h3>Post-quantum signature</h3>
                <p className="algo">{algoName(result.pqcAlgorithm)}</p>
                <div className="bar">
                  <div style={{ width: `${(result.pqcSigBytes / MLDSA87_SIG_BYTES) * 100}%` }} />
                </div>
                <p>
                  <b>{result.pqcSigBytes.toLocaleString("en-US")}</b> bytes &middot; carried in{" "}
                  <code>{result.pqcType?.split(".").slice(-1)[0] ?? "none"}</code>
                </p>
                <code className="hex">{result.pqcSigHex}...</code>
                <p className="hint">Lattice-based, NIST security level 5. Built to resist quantum attacks.</p>
              </div>
            </div>

            <div className="kv">
              <div>Chain verdict</div>
              <span>
                {result.verify.length
                  ? result.verify.map((v, i) => (
                      <span key={i} className={v.status === "verified" ? "pill ok" : "pill bad"}>
                        pqc_hybrid_verify: {v.status} ({algoName(v.algorithm_id)}) for {v.address}
                      </span>
                    ))
                  : "no pqc_hybrid_verify event"}
              </span>
              <div>Transaction</div>
              <code>{result.hash}</code>
              <div>Block / time</div>
              <span>
                {Number(result.height).toLocaleString("en-US")} &middot; {new Date(result.time).toUTCString()}
              </span>
              <div>Messages</div>
              <code>{result.msgs.join(", ")}</code>
              <div>Memo</div>
              <span>{result.memo || "(none)"}</span>
              <div>Gas used</div>
              <span>{Number(result.gasUsed).toLocaleString("en-US")}</span>
              <div>Explorer</div>
              <span>
                <a href={`${EXPLORER}${result.hash}`} target="_blank" rel="noreferrer">
                  explore.qore.network
                </a>{" "}
                (switch it to Testnet) &middot;{" "}
                <a href={`${DASHBOARD_EXPLORER}${result.hash}`} target="_blank" rel="noreferrer">
                  Dashboard explorer
                </a>
              </span>
            </div>
          </div>
        )}
      </section>

      {error && <div className="error">{error}</div>}

      <footer>Testnet only. Testnet QOR has no value.</footer>
    </div>
  );
}
