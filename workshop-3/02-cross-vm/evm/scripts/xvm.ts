/**
 * xvm.ts - drive CrossVmCheckout and show BOTH sides after every step.
 *
 *   pnpm xvm status               the EVM side (orders) and the Native side (receipts)
 *   pnpm xvm checkout "note"      one transaction: an order on EVM + a receipt on Native
 *   pnpm xvm undo "note"          the Native call succeeds, then the EVM side reverts
 *   pnpm xvm native-fails         the Native contract refuses, the EVM side is undone
 *   pnpm xvm outside              call a Native contract that is NOT on the allowlist (simulation)
 *
 * Testnet only. The shop address comes from SHOP_ADDRESS or the last deploy
 * from this folder; the Native contract from RECEIPTS_CONTRACT (default: qday-receipts).
 */
import { readFileSync, existsSync } from "node:fs";
import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const REST = process.env.QORE_REST_URL?.trim() || "https://api-testnet.qore.host";
const EXPLORER = "https://dashboard.qorechain.io/explorer/tx/";
// qday-receipts on the testnet, approved for the bridge by governance (proposal 40).
const RECEIPTS = (process.env.RECEIPTS_CONTRACT?.trim() || "qor1xjayq5ev55tkzpml9klxwyshr7gdrha0nurha9jhm0f0gdckksgs3gltw8");
const BRIDGE = "0x0000000000000000000000000000000000000901" as const;

const diana = defineChain({
  id: 9800,
  name: "QoreChain testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: ["https://evm-testnet.qore.host"] } },
});

const abi = parseAbi([
  "function checkout(string note, bool failAfter) returns (bytes)",
  "function checkoutNativeFails()",
  "function orders() view returns (uint256)",
  "function receipts() view returns (string)",
  "event Ordered(uint256 indexed id, address indexed buyer, string note, bytes nativeReply)",
]);
const bridgeAbi = parseAbi(["function executeCrossVMCall(uint8 targetVM, string targetContract, bytes payload) returns (bytes)"]);

const c = { b: (s: string) => `\x1b[1m${s}\x1b[0m`, g: (s: string) => `\x1b[32m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`, d: (s: string) => `\x1b[2m${s}\x1b[0m` };

function shopAddress(): Hex {
  const env = process.env.SHOP_ADDRESS?.trim();
  if (env) return env as Hex;
  const f = "broadcast/CrossVmCheckout.s.sol/9800/run-latest.json";
  if (!existsSync(f)) throw new Error("No shop yet: run  pnpm deploy:testnet  (or set SHOP_ADDRESS in .env)");
  const run = JSON.parse(readFileSync(f, "utf8"));
  const tx = run.transactions.find((t: { transactionType: string }) => t.transactionType === "CREATE");
  return tx.contractAddress as Hex;
}

const pub = createPublicClient({ chain: diana, transport: http() });

function wallet() {
  const k = process.env.PRIVATE_KEY?.trim();
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("Set PRIVATE_KEY in .env");
  return createWalletClient({ chain: diana, transport: http(), account: privateKeyToAccount(k as Hex) });
}

async function native<T>(msg: object): Promise<T> {
  const q = Buffer.from(JSON.stringify(msg)).toString("base64");
  const r = await fetch(`${REST}/cosmwasm/wasm/v1/contract/${RECEIPTS}/smart/${q}`);
  const j = (await r.json()) as { data?: T; message?: string };
  if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
  return j.data as T;
}

type Receipt = { id: number; sender: string; note: string; height: number };

async function show(label = "now") {
  const shop = shopAddress();
  const orders = await pub.readContract({ address: shop, abi, functionName: "orders" });
  const { count } = await native<{ count: number }>({ count: {} });
  const { receipts } = await native<{ receipts: Receipt[] }>({ latest: { limit: 3 } });
  console.log(c.b(`\n${label}:`));
  console.log(`  EVM     CrossVmCheckout ${shop}   orders   = ${c.b(String(orders))}`);
  console.log(`  Native  qday-receipts   ${RECEIPTS.slice(0, 14)}…${RECEIPTS.slice(-6)}   receipts = ${c.b(String(count))}`);
  for (const r of receipts) console.log(c.d(`          #${r.id}  "${r.note}"  from ${r.sender.slice(0, 14)}…  block ${r.height}`));
  return { orders, count };
}

async function send(data: Hex, expectFail: boolean) {
  const w = wallet();
  const shop = shopAddress();
  // A transaction we expect to revert cannot be gas-estimated; give it a fixed limit
  // so it is mined and the revert is on chain for everyone to see.
  const gas = expectFail ? 600_000n : undefined;
  const hash = await w.sendTransaction({ to: shop, data, gas });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  const ok = rcpt.status === "success";
  console.log(`  tx ${hash}  ${ok ? c.g("SUCCESS") : c.r("REVERTED")}  block ${rcpt.blockNumber}`);
  console.log(c.d(`  ${EXPLORER}${hash}`));
  return rcpt;
}

const note = (args: string[]) => {
  const n = args.join(" ").trim();
  if (!n) throw new Error('give a note, for example:  pnpm xvm checkout "coffee for the team"');
  return n;
};

const cmds: Record<string, (args: string[]) => Promise<void>> = {
  async status() {
    await show();
    const target = await pub.readContract({ address: shopAddress(), abi, functionName: "receipts" });
    console.log(c.d(`\n  the shop calls ${target} through the bridge ${BRIDGE}`));
  },

  async checkout(args) {
    const before = await show("before");
    console.log(c.b("\nsending ONE transaction: count an order on EVM + record a receipt on Native"));
    await send(encodeFunctionData({ abi, functionName: "checkout", args: [note(args), false] }), false);
    const after = await show("after");
    const both = after.orders === before.orders + 1n && after.count === before.count + 1;
    console.log(both ? c.g("\nboth sides changed, in the same transaction") : c.r("\nunexpected: the two sides did not both change"));
  },

  async undo(args) {
    const before = await show("before");
    console.log(c.b("\nsending: the Native receipt is written, THEN the EVM side reverts"));
    await send(encodeFunctionData({ abi, functionName: "checkout", args: [note(args), true] }), true);
    const after = await show("after");
    const same = after.orders === before.orders && after.count === before.count;
    console.log(same ? c.g("\nnothing changed on either side: the Native receipt was undone with the EVM revert") : c.r("\nunexpected: something changed"));
  },

  async "native-fails"() {
    const before = await show("before");
    console.log(c.b("\nsending: the EVM side counts an order, THEN the Native contract refuses"));
    await send(encodeFunctionData({ abi, functionName: "checkoutNativeFails" }), true);
    const after = await show("after");
    const same = after.orders === before.orders && after.count === before.count;
    console.log(same ? c.g("\nnothing changed on either side: the EVM order was undone with the Native failure") : c.r("\nunexpected: something changed"));
  },

  async outside() {
    // A real contract on the testnet that governance has NOT put on the bridge allowlist.
    const target = process.env.OUTSIDE_CONTRACT?.trim() || "qor1gs8mnq0mzulqu602n84yqu5tyqkrusm3l8a3j4rdtnv2fqhjkzeq3pytr0";
    console.log(`simulating a direct call to the bridge for ${target} (not on the allowlist)`);
    try {
      await pub.call({
        // No key needed for a simulation; use yours if .env has one.
        account: /^0x[0-9a-fA-F]{64}$/.test(process.env.PRIVATE_KEY?.trim() ?? "") && !/^0x0{64}$/.test(process.env.PRIVATE_KEY!.trim()) ? wallet().account : undefined,
        to: BRIDGE,
        data: encodeFunctionData({ abi: bridgeAbi, functionName: "executeCrossVMCall", args: [1, target, `0x${Buffer.from('{"record":{"note":"x"}}').toString("hex")}`] }),
      });
      console.log(c.r("unexpected: the bridge accepted it"));
    } catch (e) {
      const m = (e as { details?: string; shortMessage?: string }).details ?? (e as Error).message;
      console.log(`${c.g("REFUSED by the bridge")}: ${m.split("\n")[0]}`);
    }
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || !cmds[cmd]) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
  process.exit(cmd ? 1 : 0);
}
if (!RECEIPTS) throw new Error("Set RECEIPTS_CONTRACT=qor1... in .env");
cmds[cmd](args).catch((e: Error) => {
  console.error(c.r(`error: ${e.message}`));
  process.exit(1);
});
