# The bill payer: an AI agent whose limits the chain enforces

**Language:** JavaScript (Node.js). **Package:** `@qorechain/sdk`.
**Network:** the QoreChain testnet `qorechain-diana` only. Test QOR has no value.

## The problem

If you give a bot your private key, its spending limits live in its own code. One bug, one prompt
injection or one stolen server, and those limits are gone.

On QoreChain the limits can live **on chain**. The agent gets its own key, linked to your account
under rules the chain checks on every payment. If the agent goes rogue, the chain still refuses
anything over the limit.

## Three keys, three roles

| Key | Who holds it | What it can do |
|---|---|---|
| **Owner** | you | Your normal account, signed with both secp256k1 and ML-DSA-87. Holds the money, links the agent and writes the rules. |
| **Agent key** | the agent | An ed25519 key. It can ask to spend from the owner's account, only inside the rules. It holds no money. |
| **Gas wallet** | the agent | A small separate account that submits the agent's requests and pays the fees. It never holds the owner's money. |

The rules in this example: the agent may only **send QOR**, at most **1 QOR per payment** and
**3 QOR per day**, and the link **expires after 24 hours**.

Open [`agent.mjs`](agent.mjs) and look at the `pay` command: **there is no limit check in it**.
The agent simply tries to pay. Every limit you will see comes from the chain.

## What you need

- Node.js 20 or newer ([nodejs.org](https://nodejs.org))
- Test QOR from the [faucet](https://dashboard.qorechain.io/faucet) for two accounts: the owner
  and the gas wallet

## Run it, step by step

```sh
npm install
```
Downloads the packages in `package.json`: the QoreChain SDK, CosmJS (to talk to the chain) and
`@noble/curves` (for the ed25519 agent key).

### Step 1: create the keys

```sh
node agent.mjs init
```
Creates the agent's ed25519 key and its gas wallet, and saves them in
`~/.config/qday/agent.env`, readable only by you. It prints the gas wallet's `qor1...` address.

```sh
node agent.mjs owner-init
```
Creates a throwaway owner account for the testnet and saves it in `~/.config/qday/owner.env`.
(To use an account you already have, put `QORE_MNEMONIC="..."` in that file instead.)

The keys never leave your computer and are never printed. Never put them in your repo.

```sh
node agent.mjs whoami
```
Prints the three addresses: owner, agent key and gas wallet.

### Step 2: fund the owner and the gas wallet

Paste each `qor1...` address into the [faucet](https://dashboard.qorechain.io/faucet).
The owner needs a few QOR for the bills; the gas wallet needs about 3 QOR for fees.

```sh
node agent.mjs balance
```
Checks that both have QOR.

### Step 3: register the post-quantum keys (once)

```sh
node agent.mjs register owner
node agent.mjs register gas
```
Each account puts its ML-DSA-87 public key on chain, with a proof that it owns it. From then on,
both accounts sign every transaction with two keys: secp256k1 and ML-DSA-87. You do this once
per account.

### Step 4: link the agent, with limits

```sh
node agent.mjs link 1 3
```
The owner sends **one** transaction, signed with both keys, that:

- links the agent's ed25519 key to the owner's account (the agent key signs a proof that it
  agrees to be linked, so nobody can link a key they do not own);
- gives it one permission: `send`;
- writes a spending rule: 1 QOR per payment, 3 QOR per day, only `uqor`;
- sets an expiry: 24 hours (add a third number for a different number of hours, at most 30 days).

You should see `agent linked` and `hybrid ML-DSA-87: verified`.

```sh
node agent.mjs rules
```
Reads back from the chain what it will enforce: the rule, the permission, the expiry, and how
many payments the agent has made.

### Step 5: let the agent pay the bills

```sh
node agent.mjs run bills.json
```
The agent tries to pay the five bills in [`bills.json`](bills.json), 8.2 QOR in total.
For each bill it signs a request with its ed25519 key, and the gas wallet submits it.

What you should see:

| Bill | Amount | Result | Why |
|---|---|---|---|
| Server hosting | 0.8 | PAID | |
| Domain renewal | 0.5 | PAID | |
| Invoice from an unknown sender | 5 | REFUSED BY THE CHAIN | over the 1 QOR per-payment limit |
| API credits | 1 | PAID | |
| Monitoring | 0.9 | REFUSED BY THE CHAIN | over the 3 QOR daily limit: 2.3 spent, 0.7 left |

The refusals come from the chain, not from the agent's code. Open a PAID link in the explorer to
see the payment.

A note on the explorer: a refused payment still appears as a transaction with code 0. The
transaction itself was accepted into a block, but the payment inside it was refused. That is why
the same signed request can never be replayed. `agent.mjs` reads the result of the payment
inside, which is what it prints.

### Step 6: revoke the agent

```sh
node agent.mjs revoke
```
One transaction from the owner, and the agent key is switched off.

```sh
node agent.mjs pay qor1s90l5nnwfjznf4cdj3p4pf2p7uk32axf8800yu 0.1 "after revoke"
```
Tries one more payment. You should see `REFUSED BY THE CHAIN: linked key is unbound or revoked`.

So if an agent is ever compromised, the most you can lose is its daily limit, and one transaction
stops it.

To run the demo again, start with a fresh agent key: move `~/.config/qday/agent.env` somewhere
else (after moving the gas wallet's QOR out) and run `node agent.mjs init` again.

## All commands

```
node agent.mjs init                          create the agent key and its gas wallet
node agent.mjs owner-init                    create a throwaway owner account (testnet)
node agent.mjs whoami                        addresses of owner, agent and gas wallet
node agent.mjs register owner|gas            register the account's ML-DSA-87 key (once)
node agent.mjs link <perTxQOR> <dailyQOR> [hours]   owner links the agent with limits
node agent.mjs rules                         what the chain enforces for this agent
node agent.mjs pay <to> <QOR> [memo]         the agent pays one bill
node agent.mjs run <bills.json>              the agent pays a list of bills
node agent.mjs revoke                        owner revokes the agent
node agent.mjs balance                       balances of owner and gas wallet
```

Settings you can change with environment variables: `QORE_REST`, `QORE_RPC` (your own node),
`QDAY_DIR` (where the key files live).

## Learn more

- Account abstraction and authenticators: [docs.qorechain.io/sdk/guides/authenticators](https://docs.qorechain.io/sdk/guides/authenticators)
- The fest and the bounties: [build.qorechain.io](https://build.qorechain.io)
