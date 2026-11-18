# Ask the chain: the QoreChain MCP server

**Package:** `@qorechain/mcp` (and its terminal twin `@qorechain/qore-cli`). Nothing to install
in this folder: `npx` downloads them when you run them.

## What it is

MCP (Model Context Protocol) is a standard way for coding assistants and other AI tools to use
outside tools. The QoreChain MCP server gives them **read access** to the chain: blocks,
transactions, accounts, the state of an account's ML-DSA-87 key, fee estimates and simulations.
It has 14 tools.

It **never signs, never holds keys and never broadcasts**. If you ask it for a transfer, it gives
you an unsigned document, and you sign it in your own wallet.

## Add it to your MCP client

Any MCP client works. Most use a config like this:

```json
{
  "mcpServers": {
    "qorechain": {
      "command": "npx",
      "args": ["-y", "@qorechain/mcp"]
    }
  }
}
```

`npx -y` downloads the server the first time and starts it. Your client then lists its tools,
for example `get_pq_status`, `get_transaction`, `get_address_info`, `read_contract`,
`estimate_fee`, `simulate_tx` and `prepare_transfer`.

## The same questions from the terminal

`qore-cli` gives you the same answers without an AI client. Try these three questions with the
results of the two other demos:

```sh
npx -y @qorechain/qore-cli pq status <hash of an agent payment>
```
Was the agent's payment signed post-quantum? Expected: `tier: pqc`, `verified: true`. It is a
native transaction, signed with both keys and checked by the chain.

```sh
npx -y @qorechain/qore-cli pq status <hash of the vault withdrawal>
```
And the vault withdrawal? Expected: `tier: classical`, `reason: evm_lane`. That is an honest
answer: EVM transactions carry no ML-DSA-87 signature. They are protected by the EVM window and,
here, by the vault contract, which checks an ML-DSA-87 signature itself.

```sh
npx -y @qorechain/qore-cli pq status <your 0x or qor1 address>
```
And the account? Expected: `registered: true`, `possession_proven: true`, and the EVM window
with what is left of it.

## A visual client (optional)

To click through the tools without an AI assistant:

```sh
npx -y @modelcontextprotocol/inspector npx -y @qorechain/mcp
```

Then: **Connect**, **Tools**, **List Tools**, pick `get_pq_status`, put an address or a hash in
`target`, and **Run Tool**.
