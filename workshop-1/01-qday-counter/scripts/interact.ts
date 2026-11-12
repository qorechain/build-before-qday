/**
 * interact.ts - read and increment the deployed Counter on qorechain-diana.
 *   pnpm interact          read count, call increment(), read again
 *   pnpm interact --read   read only
 * Address from COUNTER_ADDRESS or the Ignition deployment.
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

const abi = parseAbi(["function count() view returns (uint256)", "function increment()"]);

function counterAddress(): Address {
  if (process.env.COUNTER_ADDRESS) return process.env.COUNTER_ADDRESS as Address;
  const f = "ignition/deployments/chain-9800/deployed_addresses.json";
  if (existsSync(f)) {
    const d = JSON.parse(readFileSync(f, "utf8")) as Record<string, Address>;
    if (d["CounterModule#Counter"]) return d["CounterModule#Counter"];
  }
  throw new Error("Deploy first (pnpm deploy:testnet) or set COUNTER_ADDRESS");
}

const pub = createPublicClient({ chain: qorechainTestnet, transport: http() });
const address = counterAddress();
console.log(`Counter ${address} on qorechain-diana EVM (9800)`);
console.log(`count: ${await pub.readContract({ address, abi, functionName: "count" })}`);
if (process.argv[2] !== "--read") {
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const wallet = createWalletClient({ account, chain: qorechainTestnet, transport: http() });
  const gas = await pub.estimateContractGas({ address, abi, functionName: "increment", account });
  const hash = await wallet.writeContract({ address, abi, functionName: "increment", gas: (gas * 13n) / 10n });
  console.log(`increment tx: ${hash}`);
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log(`status: ${rc.status} in block ${rc.blockNumber}`);
  console.log(`count: ${await pub.readContract({ address, abi, functionName: "count" })}`);
  console.log(`explorer: https://explore.qore.network/tx/${hash} (switch to Testnet)`);
}
