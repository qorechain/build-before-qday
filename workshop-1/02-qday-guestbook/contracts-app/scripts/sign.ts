/**
 * sign.ts - sign the guestbook from the CLI with PRIVATE_KEY (the window must be open).
 *   pnpm sign "Hello from the workshop"
 *   pnpm sign --read            list the latest entries
 * The contract address comes from GUESTBOOK_ADDRESS, or from the Ignition deployment.
 */
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
// qorechain-diana EVM (same values as qorechainTestnet in @qorechain/evm).
const qorechainTestnet = defineChain({
  id: 9800,
  name: "QoreChain Testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: ["https://evm-testnet.qore.host"] } },
  blockExplorers: { default: { name: "QoreChain Explorer", url: "https://explore.qore.network" } },
});

// Short, actionable errors instead of a stack trace.
function explain(err: unknown): never {
  const m = err instanceof Error ? (err as Error & { shortMessage?: string }).shortMessage ?? err.message : String(err);
  const full = err instanceof Error ? err.message : String(err);
  const named = /Error: (\w+)\(/.exec(full)?.[1];
  console.error(`refused: ${m.split("\n")[0]}${named ? ` (${named})` : ""}`);
  if (/window|pqc|authori[sz]ation/i.test(m)) console.error("hint: open an EVM window first: pnpm window open (then wait ~10 s)");
  process.exit(1);
}
process.on("unhandledRejection", explain);
process.on("uncaughtException", explain);

const abi = parseAbi([
  "function sign(string message)",
  "error AlreadySigned()",
  "error BadLength()",
  "function count() view returns (uint256)",
  "function latest(uint256 limit) view returns ((address author, uint64 timestamp, string message)[])",
]);

function guestbookAddress(): Address {
  if (process.env.GUESTBOOK_ADDRESS) return process.env.GUESTBOOK_ADDRESS as Address;
  const f = "ignition/deployments/chain-9800/deployed_addresses.json";
  if (existsSync(f)) {
    const d = JSON.parse(readFileSync(f, "utf8")) as Record<string, Address>;
    if (d["QDayGuestbookModule#QDayGuestbook"]) return d["QDayGuestbookModule#QDayGuestbook"];
  }
  throw new Error("Deploy first (pnpm deploy:testnet) or set GUESTBOOK_ADDRESS");
}

const pub = createPublicClient({ chain: qorechainTestnet, transport: http() });
const address = guestbookAddress();
const arg = process.argv.slice(2).join(" ").trim();

if (!arg || arg === "--read") {
  const n = await pub.readContract({ address, abi, functionName: "count" });
  const rows = await pub.readContract({ address, abi, functionName: "latest", args: [10n] });
  console.log(`guestbook ${address}: ${n} signatures`);
  for (const r of rows) console.log(`  ${new Date(Number(r.timestamp) * 1000).toISOString()}  ${r.author}  ${r.message}`);
} else {
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const wallet = createWalletClient({ account, chain: qorechainTestnet, transport: http() });
  const gas = await pub.estimateContractGas({ address, abi, functionName: "sign", args: [arg], account });
  const hash = await wallet.writeContract({ address, abi, functionName: "sign", args: [arg], gas: (gas * 13n) / 10n });
  console.log(`tx: ${hash}`);
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log(`status: ${rc.status} in block ${rc.blockNumber}`);
}
