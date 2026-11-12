import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Deploys QDayGuestbook. On QoreChain the deployer needs a registered ML-DSA-87
 * key and a live EVM authorisation window first: pnpm window open.
 */
export default buildModule("QDayGuestbookModule", (m) => {
  const guestbook = m.contract("QDayGuestbook");
  return { guestbook };
});
