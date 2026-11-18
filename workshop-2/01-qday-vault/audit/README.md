# Two-stage QCAI audit

An AI audit catches a lot early, before you deploy. It does not replace a human audit before
mainnet. Here is the flow we used for QDayVault.

## Stage 1: audit the draft

1. Go to [dashboard.qorechain.io](https://dashboard.qorechain.io), sign in, open **AI Audit**.
2. Paste [`QDayVault_v0_buggy.sol`](QDayVault_v0_buggy.sol), the first draft. Do not deploy it.
3. Pick an EVM/Solidity setting, for example **Ethereum (EVM/Solidity)**. The QoreChain setting
   is for CosmWasm contracts.
4. Run it and read the findings.

Our result: score 45/100, risk HIGH, 6 findings.

## Fix every finding, with a test

| # | Severity | Finding | Fix in `QDayVault_v1_fixed.sol` | Test |
|---|---|---|---|---|
| 1 | Critical | Reentrancy in `withdraw`: money sent before the state changes | the nonce is increased and the event emitted before the transfer | `test_signatureWorksOnce` |
| 2 | High | Anyone can call `setGuardian` and take over the vault | no setter at all: `guardian` is `immutable` | (no function left to test) |
| 3 | High | The result of the transfer is ignored | `if (!ok) revert TransferFailed()` | |
| 4 | Medium | The signed message `abi.encodePacked(to, amount)` can be replayed | the message binds a tag, the chain id, the vault address, the recipient, the amount and a nonce | `test_signatureIsBoundToAmountAndRecipient`, `test_signatureWorksOnce` |
| 5 | Medium | The amount is not checked against the balance | the transfer fails and the whole transaction reverts | |
| 6 | Low | The key status call costs gas | accepted: it is a precompile read | |

One thing the auditor did not flag, and we fixed anyway: the guardian's key must exist and must
have a proof of possession (`GuardianKeyNotRegistered`, `GuardianKeyNotProven`, tests
`test_revertsWhenGuardianHasNoKey` and `test_revertsWhenKeyWasNotProven`).

Compare the two files side by side to see every change:

```sh
diff QDayVault_v0_buggy.sol QDayVault_v1_fixed.sol
```

`QDayVault_v1_fixed.sol` is the same contract as `../src/QDayVault.sol`.

## Stage 2: audit the final contract

Run the audit again on the fixed contract, with the same setting, before you submit. Zero
findings is not required. What matters is that every Stage 1 finding was handled: fixed, covered
by a test, or explained.

For your own project, keep in your repo:

- `docs/audit/` with both reports, each with its date;
- `docs/AUDIT.md` with a table like the one above;
- one line in your README pointing to it.

For Solidity, the quantum readiness rating shows "Not scored". That is expected: on the EVM the
ML-DSA-87 check is done by the chain, through the precompile. Explain your post-quantum design in
`docs/AUDIT.md`.
