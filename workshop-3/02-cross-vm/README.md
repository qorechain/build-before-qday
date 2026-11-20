# Cross-VM checkout: an EVM contract that writes into a Native contract, atomically

**Languages:** Solidity + TypeScript (the EVM side), Rust (the Native side).
**Tools:** Foundry, pnpm, `@qorechain/sdk`, viem. **Network:** the QoreChain testnet
`qorechain-diana` only (EVM chain id 9800). Test QOR has no value. On mainnet, cross-VM calls
are paused for now.

## What it does, in plain words

QoreChain runs more than one virtual machine on the same chain: the **EVM** (Solidity, MetaMask
style) and **QoreChain Native** (CosmWasm contracts in Rust), plus a Solana-compatible lane.
They share one state and one block.

This app is a tiny shop:

- **`CrossVmCheckout`** (Solidity, EVM) counts orders.
- **`qday-receipts`** (Rust, Native) keeps a receipt book.
- One call to `checkout("coffee for the team")` does both, **in the same transaction**: the order
  count goes up on the EVM side and a receipt is written on the Native side.

The point is **atomicity**: both sides change together or neither does.

| Command | What happens | Result |
|---|---|---|
| `checkout` | order +1 on EVM, receipt +1 on Native | both change |
| `undo` | the Native receipt is written, **then** the EVM side reverts | neither changes: the receipt is undone too |
| `native-fails` | the order is counted, **then** the Native contract refuses | neither changes: the order is undone too |
| `outside` | ask the bridge to call a Native contract governance has not approved | refused by the chain |

### Words you will see

- **The bridge precompile** at `0x0000000000000000000000000000000000000901`: a built-in contract
  the chain runs natively. You call
  `executeCrossVMCall(uint8 targetVM, string targetContract, bytes payload)`, where `targetVM`
  is `1` for Native, `targetContract` is the `qor1...` address, and `payload` is the Native
  contract's JSON message.
- **The allowlist:** the bridge only reaches Native contracts that **governance** has approved.
  The list is public, in the crossvm parameters
  (`GET https://api-testnet.qore.host/qorechain/crossvm/v1/params`), and each entry is pinned to
  the contract's code, so an approved contract cannot be swapped for different code later.
- **EVM window:** EVM transactions (ECDSA only) are accepted only while the account has an open
  window, which is opened by a transaction signed with both keys (classical and ML-DSA-87).
  See Workshop 2 for the full story.

### The Native contract you will call

`qday-receipts` is on the testnet allowlist (governance proposal 40, code id 865):

```
qor1xjayq5ev55tkzpml9klxwyshr7gdrha0nurha9jhm0f0gdckksgs3gltw8
```

It has no admin, so nobody can change it. **You can use it from your own contracts for the
Cross-VM track.** Its source is in [`native/`](native): see "The Native side" below.

## How the EVM contract works

Open [`evm/src/CrossVmCheckout.sol`](evm/src/CrossVmCheckout.sol):

```solidity
function checkout(string calldata note, bool failAfter) external returns (bytes memory reply) {
    _checkNote(bytes(note));
    orders += 1;
    reply = _callNative(bytes(string.concat('{"record":{"note":"', note, '"}}')));
    if (failAfter) revert EvmSideFailed();
    emit Ordered(orders, msg.sender, note, reply);
}

function _callNative(bytes memory payload) private returns (bytes memory) {
    (bool ok, bytes memory ret) =
        BRIDGE.call(abi.encodeWithSignature("executeCrossVMCall(uint8,string,bytes)", NATIVE, receipts, payload));
    if (!ok) revert BridgeCallFailed(ret);
    if (ret.length == 0) revert BridgeNotActive();
    if (ret.length >= 64 && uint256(bytes32(ret)) == 32) return abi.decode(ret, (bytes));
    return ret;
}
```

Line by line, and why:

1. **Check the note.** It goes inside a JSON string, so it must be 1 to 140 printable characters
   with no `"` and no `\`. Otherwise a note like `x"},"fail":{` could change the message the
   Native contract receives.
2. **Count the order.** A normal EVM state change.
3. **Call the bridge.** The Native contract runs right there, inside this transaction. On the
   Native side, the **sender is this EVM contract** (its own `qor1...` account), not your
   wallet. That is why every receipt shows which contract wrote it.
4. **If the bridge call failed, revert.** A Native failure becomes an EVM revert, and the whole
   transaction is undone.
5. **No reply means no bridge.** On a chain where the precompile is not active, a call to that
   address "succeeds" with empty data. Treat that as an error, never as success.
6. **Decode the reply.** The bridge returns the Native reply as ABI-encoded `bytes`; the code
   also accepts raw bytes.
7. **`failAfter`** reverts after the Native call succeeded: it shows that the receipt written on
   the Native side is undone as well.

Use a normal `call`, not a `staticcall` or a view function: the bridge refuses static calls,
because the Native side may write state.

## What you need

| Tool | Why | Install |
|---|---|---|
| Node.js 20 or newer | runs the TypeScript helpers | [nodejs.org](https://nodejs.org) |
| pnpm | installs packages and runs the scripts | `npm install -g pnpm` |
| Foundry (`forge`, `cast`) | compiles, tests and deploys Solidity | [getfoundry.sh](https://getfoundry.sh), then `foundryup` |
| Some test QOR | fees and the window budget | [dashboard.qorechain.io/faucet](https://dashboard.qorechain.io/faucet) |
| Rust (optional) | only to build and test the Native contract yourself | [rustup.rs](https://rustup.rs) |

All commands below run in the `evm/` folder unless said otherwise:

```sh
cd evm
```

## Part 1: run the tests (no account needed)

```sh
pnpm install
pnpm forge-std
forge test
```
`pnpm install` downloads the JavaScript packages; `pnpm forge-std` downloads Foundry's standard
library into `lib/` (once). `forge test` runs the 5 tests in
[`test/CrossVmCheckout.t.sol`](evm/test/CrossVmCheckout.t.sol). You should see
`5 passed; 0 failed`.

Foundry's local EVM has no QoreChain bridge, so the tests put a small fake bridge at `0x...0901`
with `vm.etch`. They check: the exact JSON message sent, `failAfter` reverts everything, a
Native failure reverts the EVM side, a note cannot inject JSON, and an inactive bridge is an
error. The real bridge runs in Part 2.

## Part 2: deploy and use it on the testnet

### Step 1: an account with a post-quantum key

If you did Workshop 2, copy your `.env` from there (same account, key already registered) and
add the `RECEIPTS_CONTRACT` line from [`.env.example`](evm/.env.example). Otherwise:

```sh
cast wallet new
cp .env.example .env
```
Put the private key in `.env` as `PRIVATE_KEY`. **Testnet only.**

```sh
pnpm window recovery-code
```
Put the `QRC1-...` code in `.env` as `QORE_PQC_RECOVERY_CODE` and keep a copy apart from the
private key. Your ML-DSA-87 key is derived from it.

```sh
pnpm window status
```
Paste the `qor1...` address into the [faucet](https://dashboard.qorechain.io/faucet), then:

```sh
pnpm window register
```
Puts your ML-DSA-87 key on chain (once per account). `pnpm window status` now shows
`PQC key: registered`.

### Step 2: open a scoped EVM window

```sh
pnpm window:scoped
```
Opens a window of **1,200 blocks (about 28 minutes), 6 transactions and 3 QOR** of value plus
fees. Enough for the deploy and the three demo transactions, nothing more.

Your wallet calls **your own contract**; the contract then calls the bridge with its own
identity. So the window only needs to admit the call to your contract.

**Wait about 10 seconds** before the next step, so the window transaction is in a block.

### Step 3: deploy the shop

```sh
pnpm deploy:testnet
```
Deploys `CrossVmCheckout` pointing at `RECEIPTS_CONTRACT`. Look for `CrossVmCheckout 0x...`.
(In Foundry's output, "ETH" means QOR.)

```sh
pnpm xvm status
```
Shows both sides: `orders` on your EVM contract and the receipts count on `qday-receipts`, with
the latest three receipts. Other builders write into the same receipt book, so its count is
probably not zero: what matters is how it **changes**.

### Step 4: a contract the chain has not approved

```sh
pnpm xvm outside
```
Simulates a direct bridge call to a real Native contract that is **not** on the allowlist:
`REFUSED by the bridge: ... is not allowlisted`. Free, and it uses no window transaction.

### Step 5: one transaction, two VMs

```sh
pnpm xvm checkout "coffee for the team"
```
`before`, the transaction (`SUCCESS`), `after`: orders +1 **and** receipts +1, and the new
receipt with your note, sent `from` your contract's `qor1...` address.
Then `both sides changed, in the same transaction`.

### Step 6: the EVM side fails after the Native call

```sh
pnpm xvm undo "this receipt must disappear"
```
The Native receipt is written, then the EVM side reverts. The transaction is mined as
`REVERTED`, and `before` and `after` are identical: `nothing changed on either side`.
The receipt that was written on the Native side is gone too.

### Step 7: the Native side refuses

```sh
pnpm xvm native-fails
```
The order is counted on the EVM side, then `qday-receipts` refuses (`{"fail":{}}`).
`REVERTED`, numbers identical: the EVM order is undone too.

Each transaction has an explorer link. Open it on
[dashboard.qorechain.io/explorer](https://dashboard.qorechain.io/explorer) with the network
selector on **Testnet**.

### If something goes wrong

| You see | What it means | What to do |
|---|---|---|
| `Missing or invalid parameters` on deploy or a transaction | no live EVM window | `pnpm window status`, then `pnpm window:scoped`, wait 10 s, try again |
| `No shop yet` | nothing deployed from this folder | Step 3, or set `SHOP_ADDRESS` in `.env` |
| `BridgeCallFailed` with `not allowlisted` | the target is not approved by governance | use `qday-receipts` (the address above) |
| `BridgeNotActive` | the bridge precompile is not active on that network | use the testnet |
| `BadNote` | the note is empty, too long, or has `"` or `\` | use plain text up to 140 characters |

## The Native side

[`native/`](native) is the full source of `qday-receipts` (CosmWasm 2, Rust):

| Message | What it does |
|---|---|
| `{"record":{"note":"..."}}` | adds a receipt: id, sender, note, block height |
| `{"fail":{}}` | always refuses (to show atomicity) |
| `{"count":{}}` (query) | how many receipts |
| `{"receipt":{"id":1}}` (query) | one receipt |
| `{"latest":{"limit":3}}` (query) | the newest receipts, newest first, at most 20 |

Run its tests:

```sh
cd native
cargo test
```
You should see 3 tests pass.

Uploading Native contracts on the testnet goes through governance, so you do not need to deploy
this one: it is already live. To check that the code on chain is this source, build it with the
CosmWasm optimizer and compare checksums. The code on chain was built on an Apple Silicon Mac
with the arm64 image, so use the same one (the x86 image produces a different checksum):

```sh
docker run --rm -v "$(pwd)":/code \
  --mount type=volume,source="$(basename "$(pwd)")_cache",target=/target \
  --mount type=volume,source=registry_cache,target=/usr/local/cargo/registry \
  cosmwasm/optimizer-arm64:0.16.1
cat artifacts/checksums.txt
```
The checksum should be `6ebfc32fb9a9c8a412fdb071fb2c317b780ba05f637b8a4d274001c95fb5c43c`, the
same `data_hash` the chain shows for code 865:

```sh
curl -s "https://api-testnet.qore.host/cosmwasm/wasm/v1/code/865" | head -c 400
```

Read the receipt book from anywhere, no account needed:

```sh
curl -s "https://api-testnet.qore.host/cosmwasm/wasm/v1/contract/qor1xjayq5ev55tkzpml9klxwyshr7gdrha0nurha9jhm0f0gdckksgs3gltw8/smart/$(printf '{"latest":{"limit":3}}' | base64)"
```

## Files

```
evm/src/CrossVmCheckout.sol         the shop: counts orders, writes receipts through the bridge
evm/test/CrossVmCheckout.t.sol      Foundry tests, with a fake bridge
evm/script/CrossVmCheckout.s.sol    deploy script (reads RECEIPTS_CONTRACT and PRIVATE_KEY)
evm/scripts/window.ts               pnpm window: status, register, open, recovery-code
evm/scripts/xvm.ts                  pnpm xvm: status, checkout, undo, native-fails, outside
evm/.env.example                    the settings to copy into .env
native/src/lib.rs                   qday-receipts, the Native contract
```

## Learn more

- The fest, the Cross-VM track and the bounties: [build.qorechain.io](https://build.qorechain.io)
- EVM precompiles: [docs.qorechain.io/developer-guide/evm-precompiles](https://docs.qorechain.io/developer-guide/evm-precompiles)
