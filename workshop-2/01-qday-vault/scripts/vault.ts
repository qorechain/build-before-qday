/**
 * vault.ts - use a deployed QDayVault on the qorechain-diana testnet.
 *
 *   pnpm vault status                   balance, guardian, nonce, guardian key on chain
 *   pnpm vault withdraw <to> <QOR>      the guardian signs with ML-DSA-87, the tx is sent
 *   pnpm vault attack <to> <QOR>        an attacker with the secp256k1 key but NOT the
 *                                       ML-DSA-87 key tries (simulated: nothing is spent)
 *
 * The vault is the one this folder last deployed (or VAULT_ADDRESS from .env).
 * The guardian is the account in .env (QORE_MNEMONIC, or PRIVATE_KEY + QORE_PQC_RECOVERY_CODE),
 * the same account `pnpm window` uses. PRIVATE_KEY sends the transaction.
 */
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, formatEther, toHex, BaseError, ContractFunctionRevertedError, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync } from "node:fs";
import { deriveUnifiedAccount, unifiedAccountFromSeed, generatePqcKeypair, pqcSign, fetchPqcStatus } from "@qorechain/sdk";

const diana = defineChain({
  id: 9800,
  name: "QoreChain Testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: ["https://evm-testnet.qore.host"] } },
});
const REST = process.env.QORE_REST_URL?.trim() || "https://api-testnet.qore.host";
const abi = parseAbi([
  "function guardian() view returns (address)",
  "function nonce() view returns (uint256)",
  "function withdrawalMessage(address to, uint256 amount, uint256 nonce) view returns (bytes)",
  "function withdraw(address to, uint256 amount, bytes mldsaSignature)",
  "error GuardianKeyNotRegistered()",
  "error GuardianKeyNotProven()",
  "error BadPqcSignature()",
  "error TransferFailed()",
]);

// VAULT_ADDRESS from .env, or else the vault this folder last deployed to the testnet.
function latestDeploy(): string {
  const f = "broadcast/QDayVault.s.sol/9800/run-latest.json";
  if (!existsSync(f)) return "";
  const run = JSON.parse(readFileSync(f, "utf8")) as { transactions?: { contractName?: string; contractAddress?: string }[] };
  return run.transactions?.find((t) => t.contractName === "QDayVault")?.contractAddress ?? "";
}
const vault = ((process.env.VAULT_ADDRESS ?? "").trim() || latestDeploy()) as Hex;
if (!/^0x[0-9a-fA-F]{40}$/.test(vault)) throw new Error("No vault yet: run pnpm deploy:testnet (or set VAULT_ADDRESS in .env)");
const pub = createPublicClient({ chain: diana, transport: http() });

function why(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? r.shortMessage;
    return e.shortMessage;
  }
  return String(e);
}

async function prepare(to: string, qor: string) {
  const amount = parseEther(qor);
  const n = await pub.readContract({ address: vault, abi, functionName: "nonce" });
  const message = await pub.readContract({ address: vault, abi, functionName: "withdrawalMessage", args: [to as Hex, amount, n] });
  return { amount, n, message: Uint8Array.from(Buffer.from(message.slice(2), "hex")) };
}

const sender = () => {
  const k = process.env.PRIVATE_KEY?.trim();
  if (!k) throw new Error("Set PRIVATE_KEY in .env");
  return privateKeyToAccount(k as Hex);
};

// The guardian's keys: the same account `pnpm window` uses.
async function guardianAccount() {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (mnemonic) return deriveUnifiedAccount(mnemonic, 0);
  const key = process.env.PRIVATE_KEY?.trim();
  const recoveryCode = process.env.QORE_PQC_RECOVERY_CODE?.trim();
  if (!key || !recoveryCode) throw new Error("Set QORE_MNEMONIC, or PRIVATE_KEY and QORE_PQC_RECOVERY_CODE, in .env");
  return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), { recoveryCode });
}

const commands: Record<string, (...a: string[]) => Promise<void>> = {
  async status() {
    const [bal, guardian, n] = await Promise.all([
      pub.getBalance({ address: vault }),
      pub.readContract({ address: vault, abi, functionName: "guardian" }),
      pub.readContract({ address: vault, abi, functionName: "nonce" }),
    ]);
    console.log(`vault     ${vault}  ${formatEther(bal)} QOR`);
    console.log(`guardian  ${guardian}`);
    console.log(`nonce     ${n} withdrawals so far`);
  },
  async withdraw(to, qor) {
    const g = await guardianAccount();
    const st = await fetchPqcStatus({ rest: REST, address: g.cosmos });
    if (!st.registered) throw new Error(`guardian ${g.cosmos} has no ML-DSA-87 key on chain: pnpm window register`);
    const { amount, n, message } = await prepare(to, qor);
    const signature = pqcSign(g.pqc.secretKey, message);
    console.log(`guardian signs withdrawal #${n}: ${qor} QOR to ${to}`);
    console.log(`  message ${message.length} bytes, ML-DSA-87 signature ${signature.length} bytes`);
    const wallet = createWalletClient({ account: sender(), chain: diana, transport: http() });
    try {
      const hash = await wallet.writeContract({ address: vault, abi, functionName: "withdraw", args: [to as Hex, amount, toHex(signature)], gas: 1_000_000n });
      const r = await pub.waitForTransactionReceipt({ hash });
      console.log(`  ${r.status === "success" ? "WITHDRAWN" : "REVERTED"}  tx ${hash}  gas ${r.gasUsed}`);
      console.log(`  https://explore.qore.network/tx/${hash}`);
    } catch (e) {
      console.log(`  REFUSED: ${why(e)}`);
      if (/window|authori[sz]|invalid parameters/i.test(why(e))) console.log("  (no live EVM window: check with pnpm window status, open a new one with pnpm window:scoped, wait ~10 s)");
      process.exitCode = 1;
    }
  },
  async attack(to, qor) {
    // The attacker stole the secp256k1 key, so they can send transactions, but they
    // do not have the guardian's ML-DSA-87 key: they sign with a key of their own.
    const { amount, n, message } = await prepare(to, qor);
    const forged = pqcSign(generatePqcKeypair().secretKey, message);
    console.log(`attacker tries withdrawal #${n}: ${qor} QOR to ${to}, with a forged ML-DSA-87 signature`);
    try {
      await pub.simulateContract({ account: sender(), address: vault, abi, functionName: "withdraw", args: [to as Hex, amount, toHex(forged)], gas: 1_000_000n });
      console.log("  unexpected: the simulation passed");
      process.exitCode = 1;
    } catch (e) {
      console.log(`  BLOCKED by the vault: ${why(e)}`);
    }
  },
};

const [cmd = "status", ...args] = process.argv.slice(2);
const run = commands[cmd];
if (!run) { console.error(`Use: status | withdraw <to> <QOR> | attack <to> <QOR>`); process.exit(1); }
run(...args).catch((e) => { console.error(why(e)); process.exitCode = 1; });
