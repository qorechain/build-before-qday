import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

describe("QDayGuestbook", async () => {
  const { viem } = await network.create();

  it("stores a signature and lists newest first", async () => {
    const [a, b] = await viem.getWalletClients();
    const gb = await viem.deployContract("QDayGuestbook");
    await gb.write.sign(["hello from A"], { account: a.account });
    await gb.write.sign(["hello from B"], { account: b.account });
    assert.equal(await gb.read.count(), 2n);
    const latest = (await gb.read.latest([10n])) as readonly { message: string }[];
    assert.equal(latest[0].message, "hello from B");
    assert.equal(latest[1].message, "hello from A");
  });

  it("refuses a second signature from the same address", async () => {
    const gb = await viem.deployContract("QDayGuestbook");
    await gb.write.sign(["once"]);
    await viem.assertions.revertWithCustomError(gb.write.sign(["twice"]), gb, "AlreadySigned");
  });

  it("refuses empty and too long messages", async () => {
    const gb = await viem.deployContract("QDayGuestbook");
    await viem.assertions.revertWithCustomError(gb.write.sign([""]), gb, "BadLength");
    await viem.assertions.revertWithCustomError(gb.write.sign(["x".repeat(141)]), gb, "BadLength");
  });
});
