# QDayVault: a vault that survives a leaked ECDSA key

**Language:** Solidity + TypeScript. **Tools:** Foundry, pnpm, `@qorechain/sdk`.
**Network:** the QoreChain testnet `qorechain-diana` only (EVM chain id 9800). Test QOR has no value.

## What it does, in plain words

A normal wallet key (secp256k1, the "ECDSA" key MetaMask uses) could one day be broken by a
quantum computer. This vault is built so that a stolen ECDSA key is not enough to take the money.

- The money sits in the contract.
- To take money out, the **guardian** signs the withdrawal with a **post-quantum key**
  (ML-DSA-87, NIST FIPS 204).
- The contract checks that signature itself, on chain, with QoreChain's `pqcVerify` precompile.
- Anyone can submit the signed withdrawal (you, a bot, a relayer). What matters is the signature,
  not who sends it.

An attacker who stole your ECDSA key can send transactions, but cannot make the guardian's
ML-DSA-87 signature, so the vault refuses them.

### Two words you will see a lot

- **Precompile:** a built-in contract at a fixed address that the chain runs natively.
  QoreChain has two for post-quantum keys:
  - `pqcVerify` at `0x0000000000000000000000000000000000000a01` checks an ML-DSA-87 signature;
  - `pqcKeyStatus` at `0x0000000000000000000000000000000000000a02` returns the ML-DSA-87 key an
    account registered on chain, and whether the account proved it owns that key.
- **EVM window:** on QoreChain, EVM transactions (MetaMask style, ECDSA only) are accepted only
  while the account has an open window. The window is opened by a transaction signed with
  **both** keys, so an ECDSA key alone can never open one. A window has a budget: how many
  blocks it stays open, how many transactions it lets through, and how much value they can move.

## How the contract works

Open [`src/QDayVault.sol`](src/QDayVault.sol). The important function is `withdraw`:

```solidity
(bool registered,, bytes memory pubkey, bool proven) = PQC_KEYS.pqcKeyStatus(guardian);
if (!registered || pubkey.length == 0) revert GuardianKeyNotRegistered();
if (!proven) revert GuardianKeyNotProven();

uint256 n = nonce;
if (!PQC_VERIFY.pqcVerify(pubkey, mldsaSignature, withdrawalMessage(to, amount, n))) revert BadPqcSignature();

nonce = n + 1;
emit Withdrawn(to, amount, n);
(bool ok,) = to.call{value: amount}("");
if (!ok) revert TransferFailed();
```

Line by line, and why:

1. **Read the guardian's key from the chain.** The key is 2,592 bytes, so we do not store it in
   the contract. Reading it every time also means that if the guardian rotates the key on chain,
   the vault follows automatically.
2. **Refuse a key that was never proven.** "Proven" means the account signed a proof that it owns
   the key when it registered it. Without this check, someone could register a key they do not own.
3. **Verify the signature over an exact message.** `withdrawalMessage` packs a fixed tag, the chain
   id, the vault address, the recipient, the amount and the nonce. So a signature is valid for one
   withdrawal, on one vault, on one chain, once.
4. **Increase the nonce before sending the money.** The same signature cannot be used twice, and
   the state is updated before the external call (the "checks, effects, interactions" order that
   protects against reentrancy).
5. **Check that the transfer worked.** If it failed, the whole transaction is undone.

## What you need

| Tool | Why | Install |
|---|---|---|
| Node.js 20 or newer | runs the TypeScript helpers | [nodejs.org](https://nodejs.org) |
| pnpm | installs packages and runs the scripts | `npm install -g pnpm` |
| Foundry (`forge`, `cast`) | compiles, tests and deploys Solidity | [getfoundry.sh](https://getfoundry.sh), then `foundryup` |
| Some test QOR | pays fees and the 1 QOR deposit | [dashboard.qorechain.io/faucet](https://dashboard.qorechain.io/faucet) |

## Part 1: run the tests (no account needed)

```sh
pnpm install
```
Downloads the JavaScript packages listed in `package.json` (the QoreChain SDK, viem, tsx).

```sh
pnpm forge-std
```
Downloads `forge-std`, Foundry's standard library, into `lib/`. The tests and the deploy
script import it. You only do this once.

```sh
forge test
```
Compiles the contract and runs the 8 tests in [`test/QDayVault.t.sol`](test/QDayVault.t.sol).
You should see `8 passed; 0 failed`.

Why this works without a chain: Foundry's local EVM does not have QoreChain's precompiles, so
the tests put small stand-in contracts at the two precompile addresses with `vm.etch`. The tests
check the logic (good signature pays, bad signature is refused, a signature works once, an
unproven key is refused). The real precompiles run in Part 2.

## Part 2: deploy and use it on the testnet

### Step 1: create a testnet-only account

```sh
cast wallet new
```
Prints a new address and private key. **Use it for the testnet only.**

```sh
cp .env.example .env
```
Creates your own settings file. `.env` is listed in `.gitignore`, so it is never committed.

Open `.env` and set `PRIVATE_KEY` to the private key from `cast wallet new`.

```sh
pnpm window recovery-code
```
Prints a recovery code that starts with `QRC1-`. Your ML-DSA-87 key is derived from it.
Put it in `.env` as `QORE_PQC_RECOVERY_CODE` and keep a copy somewhere safe, apart from the
private key. Always use the same code: a different code means a different post-quantum key.

### Step 2: fund the account

```sh
pnpm window status
```
Prints your account in two formats, `0x...` and `qor1...`. They are the same account.
Paste the `qor1...` address into the [faucet](https://dashboard.qorechain.io/faucet).

### Step 3: register your post-quantum key (once)

```sh
pnpm window register
```
Puts your ML-DSA-87 public key on chain, with a proof that you own it. You do this once per
account. After it, `pnpm window status` shows `PQC key: registered`.

This is the only transaction the chain accepts signed with the ECDSA key alone, because at this
point the chain does not know your post-quantum key yet.

### Step 4: open a scoped EVM window

```sh
pnpm window:scoped
```
Sends a transaction signed with both keys that opens an EVM window of **600 blocks
(about 15 minutes), 3 transactions and 2 QOR** of value plus fees. That is enough for the deploy
and one withdrawal, and nothing more.

Why "scoped": if your ECDSA key leaks while the window is open, the damage is capped at that
budget. When the window ends, the EVM lane is closed again.

**Wait about 10 seconds** before the next step. Opening the window used one nonce of your
account, and the next block has to include it first.

### Step 5: deploy the vault

```sh
pnpm deploy:testnet
```
Runs [`script/QDayVault.s.sol`](script/QDayVault.s.sol) with Foundry: it deploys `QDayVault` with
a 1 QOR deposit and makes **you** the guardian. Look for `QDayVault 0x...` in the output.
It goes through because your window is open. In Foundry's output, "ETH" means QOR.

```sh
pnpm vault status
```
Shows the vault's address, balance (1 QOR), guardian (you) and nonce (0).
The helper finds the vault this folder deployed last, so you do not have to copy the address.

### Step 6: the attack (simulation)

```sh
pnpm vault attack 0x1b6dF9880065e7758c6e82741c50cEaD80664937 0.5
```
Plays an attacker who has your ECDSA key but not your ML-DSA-87 key. It signs the withdrawal
with a random ML-DSA-87 key and asks the chain what would happen.
You should see `BLOCKED by the vault: BadPqcSignature`.

It is only a simulation, so it costs nothing and does not use your window.
Any address works as the recipient; the one above is just an example.

### Step 7: the real withdrawal

```sh
pnpm vault withdraw 0x1b6dF9880065e7758c6e82741c50cEaD80664937 0.5
```
Signs the withdrawal with **your** ML-DSA-87 key (the message is 157 bytes, the signature 4,627
bytes) and sends it. The vault checks it with `pqcVerify` and pays.
You should see `WITHDRAWN tx 0x...` and an explorer link.

```sh
pnpm window status
```
Shows what is left of the window: 1 transaction. Exactly the budget you gave it.

### If something goes wrong

| You see | What it means | What to do |
|---|---|---|
| `REFUSED: Missing or invalid parameters` on deploy or withdraw | no live EVM window: it expired or was used up | `pnpm window status`, then `pnpm window:scoped`, wait 10 s, try again |
| `does not exist on chain yet` | the account has no QOR yet | use the faucet (Step 2) |
| `PQC key: not registered` | Step 3 was skipped | `pnpm window register` |
| `GuardianKeyNotRegistered` | the guardian has no ML-DSA-87 key on chain | register it (Step 3) |
| `No vault yet` | nothing deployed from this folder | Step 5, or set `VAULT_ADDRESS` in `.env` |

## The two-stage audit

The [`audit/`](audit) folder has the first draft of this contract, with real bugs, and the fixed
version. It shows how to use the QCAI audit before you deploy. See [`audit/README.md`](audit/README.md).

## Files

```
src/QDayVault.sol          the vault
test/QDayVault.t.sol       Foundry tests, with stand-ins for the precompiles
script/QDayVault.s.sol     deploy script (optional: GUARDIAN, VAULT_DEPOSIT_WEI)
scripts/window.ts          pnpm window: status, register, open, recovery-code
scripts/vault.ts           pnpm vault: status, attack, withdraw
audit/                     the buggy draft, the fixed contract, and what changed
.env.example               the settings to copy into .env
```

## Learn more

- EVM precompiles: [docs.qorechain.io/developer-guide/evm-precompiles](https://docs.qorechain.io/developer-guide/evm-precompiles)
- The fest and the bounties: [build.qorechain.io](https://build.qorechain.io)
