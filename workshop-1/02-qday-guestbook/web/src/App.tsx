import { ConnectButton } from "@rainbow-me/rainbowkit";
import { classifyEvmWindowRejection, evmWindowStatus, type EvmWindowRejection } from "@qorechain/evm";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { formatEther, parseAbi, type Address } from "viem";
import {
  useAccount,
  useBalance,
  useBlockNumber,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

const GUESTBOOK = import.meta.env.VITE_GUESTBOOK_ADDRESS as Address | undefined;
const REST = `${location.origin}/lcd`; // Vite proxy to https://api-testnet.qore.host
const EXPLORER = "https://explore.qore.network/tx/";

const abi = parseAbi([
  "function sign(string message)",
  "function count() view returns (uint256)",
  "function hasSigned(address) view returns (bool)",
  "function latest(uint256 limit) view returns ((address author, uint64 timestamp, string message)[])",
]);

const REMEDY: Record<EvmWindowRejection, string> = {
  "no-pqc-key": "This account has no registered ML-DSA-87 key yet. QoreX registers it on the first native send.",
  "no-window": "No EVM authorisation window is open. QoreX offers to open one in the approval; or run pnpm window open.",
  exhausted: "The window ran out of blocks, transactions or value (or it is scoped to another contract). Open a new one.",
  invalid: "The chain refused the window parameters.",
};

const short = (a: string) => `${a.slice(0, 8)}...${a.slice(-6)}`;

function WindowStatus({ address }: { address: Address }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ["evm-window", address],
    queryFn: () => evmWindowStatus({ rest: REST, address }),
    refetchInterval: 5_000,
  });
  if (isLoading) return <span>reading...</span>;
  if (error) return <span>could not read: {error.message}</span>;
  if (!data?.found) return <span className="pill bad">no window open</span>;
  return (
    <span className={data.live ? "pill ok" : "pill bad"}>
      {data.live ? "live" : "not usable"}: {data.remainingBlocks.toString()} blocks, {data.remainingTxs.toString()} txs left
    </span>
  );
}

export function App() {
  const { address, isConnected, chainId } = useAccount();
  const { data: balance } = useBalance({ address });
  const { data: block } = useBlockNumber({ watch: true });
  const [message, setMessage] = useState("Hello from Build Before Q-Day!");

  const count = useReadContract({ address: GUESTBOOK, abi, functionName: "count", query: { enabled: !!GUESTBOOK, refetchInterval: 4000 } });
  const latest = useReadContract({ address: GUESTBOOK, abi, functionName: "latest", args: [20n], query: { enabled: !!GUESTBOOK, refetchInterval: 4000 } });
  const signed = useReadContract({
    address: GUESTBOOK,
    abi,
    functionName: "hasSigned",
    args: address ? [address] : undefined,
    query: { enabled: !!GUESTBOOK && !!address, refetchInterval: 4000 },
  });

  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });
  const rejection = write.error ? classifyEvmWindowRejection(write.error) : undefined;

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <img src="/qc-icon.png" alt="" width={32} height={32} />
          <span className="wordmark">
            <b>QORE</b>CHAIN
          </span>
          <span className="tag">Q-Day Guestbook</span>
        </div>
        <div className="net">
          <span className="dot" /> EVM 9800 (diana testnet) &middot; block <b>{block?.toLocaleString("en-US") ?? "..."}</b>
        </div>
      </header>

      <p className="lead">
        A Solidity contract on the QoreChain EVM. Every write needs a post-quantum (ML-DSA-87) key and an open EVM
        authorisation window, so a stolen secp256k1 key alone cannot spend from this account.
      </p>

      {!GUESTBOOK && <div className="error">Set VITE_GUESTBOOK_ADDRESS in .env (deploy the contract first).</div>}

      <section className="card">
        <h2>
          <span className="n">1</span> Connect QoreX
        </h2>
        <ConnectButton chainStatus="full" showBalance={false} />
        {isConnected && address && (
          <div className="kv">
            <div>Account</div>
            <code>{address}</code>
            <div>Chain</div>
            <span>{chainId === 9800 ? "qorechain-diana EVM (9800)" : `wrong chain ${chainId}: switch to 9800`}</span>
            <div>Balance</div>
            <span>{balance ? `${Number(formatEther(balance.value)).toLocaleString("en-US")} QOR` : "..."}</span>
            <div>EVM window</div>
            <WindowStatus address={address} />
          </div>
        )}
      </section>

      <section className={`card ${isConnected ? "" : "dim"}`}>
        <h2>
          <span className="n">2</span> Sign the guestbook
        </h2>
        {signed.data ? (
          <p>This address has already signed. Thank you!</p>
        ) : (
          <>
            <div className="row">
              <input value={message} maxLength={140} onChange={(e) => setMessage(e.target.value)} disabled={!isConnected} />
              <button
                disabled={!isConnected || !GUESTBOOK || write.isPending || !message.trim()}
                onClick={() => write.writeContract({ address: GUESTBOOK!, abi, functionName: "sign", args: [message.trim()] })}
              >
                {write.isPending ? "Approve in QoreX..." : "Sign"}
              </button>
            </div>
            <p className="small">{message.length}/140 characters, one signature per address.</p>
          </>
        )}
        {write.data && (
          <p className="small">
            tx{" "}
            <a href={`${EXPLORER}${write.data}`} target="_blank" rel="noreferrer">
              <code>{write.data}</code>
            </a>{" "}
            {receipt.isLoading ? "waiting for the block..." : receipt.data ? `${receipt.data.status} in block ${receipt.data.blockNumber}` : ""}
          </p>
        )}
        {write.error && <div className="error">Refused: {rejection ? REMEDY[rejection] : write.error.message.split("\n")[0]}</div>}
      </section>

      <section className="card">
        <h2>
          <span className="n">3</span> On chain now: {count.data?.toString() ?? "..."} signatures
        </h2>
        {GUESTBOOK && (
          <p className="small">
            Contract <code>{GUESTBOOK}</code>
          </p>
        )}
        <div className="entries">
          {(latest.data ?? []).map((e, i) => (
            <div key={`${e.author}-${i}`} className="entry">
              <div className="msg">{e.message}</div>
              <div className="meta">
                <code>{short(e.author)}</code> &middot; {new Date(Number(e.timestamp) * 1000).toUTCString()}
              </div>
            </div>
          ))}
          {latest.data?.length === 0 && <p className="small">Be the first to sign.</p>}
        </div>
      </section>

      <footer>Testnet only. Testnet QOR has no value.</footer>
    </div>
  );
}
