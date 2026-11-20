# QoreSeal: encrypt a message to a QoreChain address

**Language:** JavaScript (Node.js). **Packages:** `@qorechain/qoreseal`, `@qorechain/qoresign`.
**Network:** the QoreChain testnet `qorechain-diana` only. Test QOR has no value.

## What it does, in plain words

You want to send a private message to someone, and all you know is their QoreChain address
(`qor1...`). This app shows how:

- Every account can put a **post-quantum encryption key** on chain: ML-KEM-1024 (NIST FIPS 203).
  Anyone can read it, like a public phone book.
- The account also signs a small **recipient card** with its two signing keys (classical and
  ML-DSA-87). The card ties the encryption keys to the account, so nobody can slip in a fake key.
- To send, you read the key from the chain, check the card, and **seal** the message into an
  envelope. Only the owner of the address can open it.
- The encryption happens on your computer. The chain never sees the message, only the public key.

What you will see happen:

1. Alice registers her keys.
2. Anyone looks up Alice's key by her address.
3. A message is sealed to Alice. Alice opens it. **Eve cannot.**
4. Change one bit of the envelope: it **no longer opens**.
5. One message sealed to Alice **and** Bob at once: each opens it with their own key.
6. Alice **rotates** her key: the old card is refused, new messages use the new key, and old
   messages still open with the old key.

### Words you will see

- **ML-KEM-1024:** a post-quantum key exchange. Used here to agree on a secret key for each
  envelope. It is combined with a classical X25519 key, so the envelope stays safe as long as
  either one holds.
- **ML-DSA-87:** a post-quantum signature (NIST FIPS 204). On QoreChain every native
  transaction is signed with it **and** with the classical secp256k1 key.
- **Envelope:** the sealed message, saved as a text file (`inbox/*.qoreseal`) that you can send
  any way you like: email, chat, a file, a contract.

## What you need

| Tool | Why | Install |
|---|---|---|
| Node.js 20 or newer | runs `seal.mjs` | [nodejs.org](https://nodejs.org) |
| Some test QOR | pays the fees for registering keys (a few hundredths of a QOR) | [dashboard.qorechain.io/faucet](https://dashboard.qorechain.io/faucet) |

## Step by step

### Step 1: install

```sh
npm install
```
Downloads the exact package versions in `package-lock.json`: QoreSeal, QoreSign (the hybrid
signer), and a few cosmjs helpers that build the transaction.

```sh
node seal.mjs help
```
Lists every command.

### Step 2: create three testnet accounts

```sh
node seal.mjs init alice
node seal.mjs init bob
node seal.mjs init eve
```
Each command makes a new account and saves its secret words in
`~/.config/qday-w3/<name>.json`, readable only by you. Nothing secret is ever printed.
(Set `QDAY_DIR` to keep them somewhere else.)

### Step 3: fund Alice

Paste Alice's `qor1...` address (printed by `init`) into the
[faucet](https://dashboard.qorechain.io/faucet).

```sh
node seal.mjs whoami
```
Shows each account: address, balance, and whether its keys are on chain yet (`no` for now).

### Step 4: Alice registers her keys

```sh
node seal.mjs register alice
```
Two transactions:

1. **The ML-DSA-87 signing key**, with a proof that Alice owns it. This is the only transaction
   the chain accepts signed with the classical key alone, because it does not know her
   post-quantum key yet.
2. **The ML-KEM-1024 encryption key** (1,568 bytes), signed with both keys. From now on, anyone
   can read it from the chain.

Then it signs Alice's **recipient card** and saves it as `cards/alice.json`. In a real app you
would publish the card next to the address (a profile page, a contract, an API).

### Step 5: share QOR with Bob and Eve, and register Bob

```sh
node seal.mjs fund alice bob 3
node seal.mjs fund alice eve 3
```
Sends 3 test QOR from Alice to Bob and to Eve. Like every transaction after registration, it is
signed with **both** keys (secp256k1 and ML-DSA-87), and the chain checks both. That is why Alice
registers first: an account with no ML-DSA-87 key on chain can only register one.

```sh
node seal.mjs register bob
```
Bob is needed for Step 9, where one message goes to two people. Eve stays unregistered: she is
the outsider who will try to read Alice's mail.

### Step 6: look Alice up, like a sender would

```sh
node seal.mjs lookup alice
```
Reads `GET /qorechain/pqc/v1/kem/<address>` from the public REST API: the algorithm
(`ML-KEM-1024`), the 1,568-byte public key and the block it was registered at. Then it checks
the card against that key and against Alice's ML-DSA-87 key on chain: `card valid`.

You can do this for any address: `node seal.mjs lookup qor1...`.

### Step 7: seal a message to Alice, and open it

```sh
node seal.mjs send alice "Payroll for March: 12,400 QOR to the team"
```
Reads Alice's key from the chain, checks her card and seals the message. A 41-character message
becomes about 1,760 bytes: most of that is the post-quantum key material. The envelope is saved
in `inbox/`.

```sh
node seal.mjs open alice
```
`OPENED by alice with encryption key #0` and the message.

```sh
node seal.mjs open eve
```
`CANNOT OPEN: eve holds none of the keys this envelope was sealed to`. Eve has the file, but not
Alice's key.

### Step 8: tamper with it

```sh
node seal.mjs tamper alice
```
Flips one bit of the envelope and tries to open it: `REFUSED ... (DECRYPTION_FAILED)`.
The envelope is authenticated, so any change is caught. Nobody can edit a sealed message.

### Step 9: one message, two recipients

```sh
node seal.mjs send alice,bob "Board memo: Q4 budget"
node seal.mjs open bob
node seal.mjs open alice
```
One envelope, sealed to both addresses. Each opens it with their own key. Eve still cannot.

### Step 10: rotate Alice's key

```sh
node seal.mjs rotate alice
```
Derives Alice's **next** encryption key (#1) from the same secret words and registers it on
chain. It **replaces** the old one. Then it checks the **old** card against the chain:
`refused: the card names a different ML-KEM-1024 key than the registered one`. Senders who
check the card can no longer seal to the old key. A new card is signed.

```sh
node seal.mjs open alice inbox/$(ls inbox | head -1)
```
Opens the **first** envelope, sealed before the rotation:
`OPENED by alice with encryption key #0 (an older key)`. The old key was never stored: it is
derived again from the secret words, so rotating never locks you out of old mail.

```sh
node seal.mjs inspect
```
Shows what is inside an envelope without the secret: version, purpose, recipients, sizes.

## How the code works

Everything is in [`seal.mjs`](seal.mjs). The QoreSeal calls that matter:

| Call | What it does |
|---|---|
| `deriveSealKeys({ mnemonic, index })` | the encryption keys of key number `index`, derived from the secret words |
| `buildRegisterKemKeyMessage({ sender, mlkemPublicKey })` | the `MsgRegisterKEMKey` transaction message that puts the key on chain |
| `signRecipientCard({ chainId, address, keys, classicalKey, pqKey })` | the card, signed with both of the account's signing keys |
| `verifyRecipientCard({ card, chainId, address, mlkemPublicKey, pqPublicKey })` | throws unless the card matches the keys on chain |
| `sealToAddresses({ rest, chainId, purpose, recipients, plaintext })` | reads each key from the chain, checks each card, seals |
| `open({ chainId, purpose, envelope, keys })` | opens it, or throws |
| `envelopeToText` / `envelopeFromText` | the envelope as a text file and back |

`purpose` (here `qday-note`) is part of what is sealed: an envelope made for one app cannot be
opened as if it came from another.

## If something goes wrong

| You see | What to do |
|---|---|
| `does not exist on chain yet: fund ... first` | the account has no QOR: use the faucet or `fund` |
| `no ML-KEM key registered for this address` | run `register` for that account first |
| `hybrid mode needs the recipient card` | the `cards/<name>.json` file is missing: run `register <name>` (it writes the card again) |
| `no envelope yet` | run `send` first |
| `account has no PQC key and classical fallback is disabled` | that account has not registered yet: run `register <name>` before `fund` from it |
| `refused: ...` on a transaction | read the message: usually not enough QOR, or the public testnet API is rate limiting you; wait a few seconds |

## Safety

Testnet only. The files in `~/.config/qday-w3/` hold secret words: never commit or share them,
and never reuse them on mainnet. `cards/` and `inbox/` are local and listed in `.gitignore`.

## Learn more

- The fest, the Encrypted Apps track and the bounties: [build.qorechain.io](https://build.qorechain.io)
- QoreSeal on npm: [@qorechain/qoreseal](https://www.npmjs.com/package/@qorechain/qoreseal)
