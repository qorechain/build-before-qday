package demo;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.qorechain.accounts.Account;
import io.github.qorechain.accounts.Accounts;
import io.github.qorechain.denom.Denom;
import io.github.qorechain.messages.TypedMessage;
import io.github.qorechain.networks.NetworkConfig;
import io.github.qorechain.networks.Networks;
import io.github.qorechain.pqc.KeyIntegrity;
import io.github.qorechain.pqc.PqcDx;
import io.github.qorechain.pqc.PqcKeypair;
import io.github.qorechain.query.ChainUpgrades;
import io.github.qorechain.query.RestClient;
import io.github.qorechain.tx.AutoGas;
import io.github.qorechain.tx.Authenticator;
import io.github.qorechain.tx.Broadcaster;
import io.github.qorechain.tx.GasPrice;
import io.github.qorechain.tx.NativeTx;
import io.github.qorechain.tx.StdFee;
import io.github.qorechain.tx.TxError;
import io.github.qorechain.tx.TxTracker;
import io.github.qorechain.utils.Bech32;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Q-Day Tip Jar: a tiny Java backend on QoreChain testnet (qorechain-diana).
 * Every transaction it sends carries a hybrid signature (secp256k1 + ML-DSA-87),
 * and the watcher only trusts incoming tips whose sender signed quantum-safe.
 */
public final class TipJar {

    static final NetworkConfig NET = Networks.get("testnet");      // qorechain-diana, public endpoints
    static final String REST = NET.endpoints.rest;
    static final String RPC = NET.endpoints.rpc;
    static final String GAS_PRICE = "0.15uqor";
    static final double GAS_MARGIN = 1.3;                          // simulated gas x 1.3
    static final int MLDSA87_SIG = 4627;

    static final Path KEY_FILE = Path.of(System.getenv().getOrDefault("TIPJAR_KEY",
            System.getProperty("user.home") + "/.config/qday/java.env"));

    static final boolean COLOR = System.getenv("NO_COLOR") == null;
    static String green(String s) { return COLOR ? "\u001b[1;32m" + s + "\u001b[0m" : s; }
    static String yellow(String s) { return COLOR ? "\u001b[1;33m" + s + "\u001b[0m" : s; }
    static String red(String s) { return COLOR ? "\u001b[1;31m" + s + "\u001b[0m" : s; }
    static String dim(String s) { return COLOR ? "\u001b[2m" + s + "\u001b[0m" : s; }
    static String bold(String s) { return COLOR ? "\u001b[1m" + s + "\u001b[0m" : s; }

    public static void main(String[] args) throws Exception {
        String cmd = args.length == 0 ? "help" : args[0];
        try {
            switch (cmd) {
                case "new" -> cmdNew(args.length > 1 && args[1].equals("--force"));
                case "status" -> cmdStatus();
                case "register" -> cmdRegister();
                case "tip" -> {
                    if (args.length < 3) { usage(); System.exit(2); }
                    String memo = args.length > 3 ? String.join(" ", List.of(args).subList(3, args.length)) : "";
                    cmdTip(args[1], args[2], memo);
                }
                case "watch" -> cmdWatch(args.length > 1 ? args[1] : null);
                default -> usage();
            }
        } catch (TxError.QoreTxException e) {
            System.err.println(red("chain refused the tx: ") + e.codespace + " " + e.code + " " + e.getMessage());
            System.err.println(dim("(if the testnet is upgrading, wait a minute and run the command again)"));
            System.exit(1);
        } catch (RuntimeException e) {
            System.err.println(red("error: ") + e.getMessage());
            System.exit(1);
        }
    }

    static void usage() {
        System.out.println("""
                Q-Day Tip Jar (QoreChain testnet, hybrid secp256k1 + ML-DSA-87)

                  new                         create the jar key (file mode 0600) and print its address
                  status                      address, balance, PQC key registered or not
                  register                    register the ML-DSA-87 key on chain (idempotent)
                  tip <qor1...> <QOR> [memo]  send a hybrid-signed tip and verify it on chain
                  watch [qor1...]             watch a jar for incoming tips, flag quantum-safe ones

                key file: %s (override with TIPJAR_KEY)""".formatted(KEY_FILE));
    }

    // ---------------------------------------------------------------- wallet

    /** The jar wallet: a coin-118 secp256k1 key plus its address-bound ML-DSA-87 key. */
    record Wallet(Account account, PqcKeypair pqc) {
        String address() { return account.address; }
    }

    static Wallet loadWallet() throws Exception {
        if (!Files.exists(KEY_FILE)) {
            throw new IllegalStateException("no key file at " + KEY_FILE + ", run `new` first");
        }
        String mnemonic = null;
        for (String line : Files.readAllLines(KEY_FILE, StandardCharsets.UTF_8)) {
            if (line.startsWith("QORE_MNEMONIC=")) {
                mnemonic = line.substring("QORE_MNEMONIC=".length()).replace("\"", "").trim();
            }
        }
        if (mnemonic == null || !Accounts.validateMnemonic(mnemonic)) {
            throw new IllegalStateException("key file " + KEY_FILE + " has no valid QORE_MNEMONIC");
        }
        Account acc = Accounts.deriveNativeAccount(mnemonic, 0);                 // m/44'/118'/0'/0/0
        PqcKeypair pqc = Authenticator.derivePqcCanonical(acc.address, mnemonic); // ML-DSA-87, address-bound
        return new Wallet(acc, pqc);
    }

    /** Signing context with the live account number and sequence. */
    static PqcDx.Signer signer(Wallet w, String memo) {
        JsonNode acc = new RestClient(REST).get("/cosmos/auth/v1beta1/accounts/" + w.address()).path("account");
        JsonNode base = acc.has("base_account") ? acc.get("base_account") : acc;
        PqcDx.Signer s = new PqcDx.Signer();
        s.sender = w.address();
        s.secp256k1PrivateKey = w.account().privateKey;
        s.secp256k1PublicKey = w.account().publicKey;
        s.pqcKeypair = w.pqc();
        s.chainId = NET.chainId;
        s.accountNumber = base.path("account_number").asLong(0);
        s.sequence = base.path("sequence").asLong(0);
        s.restUrl = REST;          // sign-bytes v1/v2 auto-detection + PQC key checks
        s.memo = memo;
        return s;
    }

    // ---------------------------------------------------------------- new

    static void cmdNew(boolean force) throws Exception {
        if (Files.exists(KEY_FILE) && !force) {
            System.out.println("key file already exists: " + KEY_FILE + " (use `new --force` to replace it)");
            System.out.println("address  " + bold(loadWallet().address()));
            return;
        }
        String mnemonic = Accounts.generateMnemonic(256);
        Account acc = Accounts.deriveNativeAccount(mnemonic, 0);
        Files.createDirectories(KEY_FILE.getParent());
        Path tmp = KEY_FILE.resolveSibling(KEY_FILE.getFileName() + ".tmp");
        Files.deleteIfExists(tmp);
        Files.createFile(tmp, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        Files.writeString(tmp, "# Q-Day Tip Jar demo key. qorechain-diana TESTNET ONLY. Never fund on mainnet.\n"
                + "QORE_MNEMONIC=\"" + mnemonic + "\"\n"
                + "QORE_ADDR=" + acc.address + "\n");
        Files.move(tmp, KEY_FILE, java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        Files.setPosixFilePermissions(KEY_FILE, PosixFilePermissions.fromString("rw-------"));
        System.out.println("new jar key   " + KEY_FILE + " (mode 0600, mnemonic not printed)");
        System.out.println("address       " + bold(acc.address));
        System.out.println(dim("next: fund it with testnet QOR, then `register`"));
    }

    // ---------------------------------------------------------------- status

    static void cmdStatus() throws Exception {
        Wallet w = loadWallet();
        RestClient rest = new RestClient(REST);
        String uqor = rest.getBalance(w.address(), "uqor").path("balance").path("amount").asText("0");
        PqcDx.PqcStatus st = PqcDx.fetchPqcStatus(REST, w.address());
        System.out.println("network   " + NET.chainId + "  " + dim(REST));
        System.out.println("address   " + bold(w.address()));
        System.out.println("balance   " + Denom.fromBase(uqor) + " QOR");
        if (!st.registered) {
            System.out.println("PQC key   " + yellow("not registered") + dim("  (run `register`)"));
        } else {
            Boolean mine = PqcDx.isRegisteredPqcKey(st, w.pqc().publicKey);
            System.out.println("PQC key   " + green("registered") + "  ML-DSA-87"
                    + (Boolean.TRUE.equals(mine) ? ", matches this wallet" : Boolean.FALSE.equals(mine) ? red(", DIFFERENT key") : "")
                    + (Boolean.TRUE.equals(st.possessionProven) ? ", proof of possession checked" : ""));
        }
    }

    // ---------------------------------------------------------------- register

    static void cmdRegister() throws Exception {
        Wallet w = loadWallet();
        PqcDx.PqcStatus st = PqcDx.fetchPqcStatus(REST, w.address());
        if (st.registered) {
            Boolean mine = PqcDx.isRegisteredPqcKey(st, w.pqc().publicKey);
            System.out.println("PQC key already registered for " + w.address()
                    + (Boolean.TRUE.equals(mine) ? green(" (this wallet's ML-DSA-87 key)") : red(" (a DIFFERENT key)")));
            return;
        }
        register(w, st);
    }

    /** One-time MsgRegisterPQCKeyV2, gas from simulation, then wait for the block. */
    static void register(Wallet w, PqcDx.PqcStatus status) {
        PqcDx.Signer s = signer(w, "");
        PqcDx.EnsureOptions opts = new PqcDx.EnsureOptions();
        opts.status = status;
        if (ChainUpgrades.isApplied(new RestClient(REST), ChainUpgrades.V3_2_3, REST)) {
            opts.proofOfPossession = KeyIntegrity.signProofOfPossession(NET.chainId, w.address(), w.pqc());
        }
        // Simulate the exact registration tx to size the gas (no fixed gas limit).
        NativeTx.Options sim = new NativeTx.Options();
        sim.messages = List.of(PqcDx.buildRegisterPqcKeyMsg(s, opts));
        sim.secp256k1PrivateKey = s.secp256k1PrivateKey;
        sim.secp256k1PublicKey = s.secp256k1PublicKey;
        sim.fee = new StdFee(List.of(), "0");
        sim.chainId = s.chainId;
        sim.accountNumber = s.accountNumber;
        sim.sequence = s.sequence;
        AutoGas.Estimate est = AutoGas.estimate(REST, NativeTx.buildAndSign(sim).txRawBytes, false, GAS_MARGIN, null);
        s.fee = GasPrice.calculateFee(est.gasWanted, GAS_PRICE);

        System.out.println("registering ML-DSA-87 key for " + bold(w.address()) + dim("  (gas " + est.gasWanted + ")"));
        PqcDx.EnsureResult r = PqcDx.ensurePqcRegistered(s, new Broadcaster(RPC), null, opts);
        if (r.txHash == null) {
            System.out.println(green("already registered"));
            return;
        }
        TxTracker.IncludedTx inc = TxTracker.waitForTx(new RestClient(REST), r.txHash, null);
        PqcDx.clearPqcStatusCache();
        System.out.println(green("registered") + "  tx " + r.txHash + "  height " + inc.height);
    }

    // ---------------------------------------------------------------- tip

    static void cmdTip(String to, String amountQor, String memo) throws Exception {
        if (!"qor".equals(Bech32.decode(to).prefix)) {
            throw new IllegalArgumentException("recipient must be a qor1... address");
        }
        String uqor = Denom.toBase(amountQor);                               // "0.5" -> "500000", exact
        Wallet w = loadWallet();
        PqcDx.PqcStatus st = PqcDx.fetchPqcStatus(REST, w.address());
        if (!st.registered) {
            register(w, st);
            st = PqcDx.fetchPqcStatus(REST, w.address());
        }

        // ---- the part that matters -------------------------------------------------
        PqcDx.Signer signer = signer(w, memo);
        PqcDx.EnsureOptions known = new PqcDx.EnsureOptions();
        known.status = st;                                                    // already checked above
        PqcDx.HybridSendPath path = PqcDx.migrateToHybrid(signer, new Broadcaster(RPC), null, known);
        TypedMessage send = NativeTx.bankSend(w.address(), to, List.of(new StdFee.Coin("uqor", uqor)));
        PqcDx.HybridSendPath.AutoSendResult sent = path.sendAuto(List.of(send), GAS_PRICE, GAS_MARGIN);
        TxTracker.IncludedTx inc = TxTracker.waitForTx(new RestClient(REST), sent.result.transactionHash, null);
        // -----------------------------------------------------------------------------

        System.out.println("tip       " + bold(amountQor + " QOR") + " -> " + to);
        System.out.println("memo      " + (memo.isEmpty() ? dim("(none)") : memo));
        System.out.println("gas       simulated " + sent.estimate.simulatedGas + " -> limit " + sent.estimate.gasWanted
                + ", fee " + Denom.fromBase(sent.fee.amount.get(0).amount) + " QOR");
        System.out.println("tx        " + sent.result.transactionHash);
        System.out.println("height    " + inc.height);
        JsonNode got = new RestClient(REST).getTx(sent.result.transactionHash);
        Verdict v = verify(got.path("tx_response"), got.path("tx"), w.address());
        System.out.println("on chain  pqc_hybrid_verify " + (v.verified ? green("status=verified") : red("NOT verified"))
                + "  address=" + w.address());
        System.out.println("sigs      secp256k1 " + v.classicalSigBytes + " B + ML-DSA-87 " + v.pqcSigBytes + " B"
                + (v.pqcSigBytes == MLDSA87_SIG ? "" : red(" (unexpected size)")));
        System.out.println(v.verified && v.pqcSigBytes == MLDSA87_SIG ? green("QUANTUM-SAFE") : red("CHECK FAILED"));
    }

    // ---------------------------------------------------------------- verification

    record Verdict(boolean verified, int pqcSigBytes, int classicalSigBytes) {}

    /** Read the hybrid-signature proof out of GET /cosmos/tx/v1beta1/txs/{hash}. */
    static Verdict verify(JsonNode txResponse, JsonNode tx, String signer) {
        boolean verified = false;
        for (JsonNode ev : txResponse.path("events")) {
            if (!"pqc_hybrid_verify".equals(ev.path("type").asText())) continue;
            String addr = null, status = null;
            for (JsonNode a : ev.path("attributes")) {
                if ("address".equals(a.path("key").asText())) addr = a.path("value").asText();
                if ("status".equals(a.path("key").asText())) status = a.path("value").asText();
            }
            if (signer.equals(addr) && "verified".equals(status)) verified = true;
        }
        int pqcLen = 0;
        JsonNode body = tx.path("body");
        List<JsonNode> exts = new ArrayList<>();
        body.path("extension_options").forEach(exts::add);
        body.path("non_critical_extension_options").forEach(exts::add);
        for (JsonNode ext : exts) {
            if ("/qorechain.pqc.v1.PQCHybridSignature".equals(ext.path("@type").asText())) {
                pqcLen = Base64.getDecoder().decode(ext.path("pqc_signature").asText("")).length;
            }
        }
        JsonNode sigs = tx.path("signatures");
        int classical = sigs.size() > 0 ? Base64.getDecoder().decode(sigs.get(0).asText("")).length : 0;
        return new Verdict(verified, pqcLen, classical);
    }

    // ---------------------------------------------------------------- watch

    static void cmdWatch(String jarArg) throws Exception {
        String jar = jarArg != null ? jarArg : loadWallet().address();
        RestClient rest = new RestClient(REST);
        String query = RestClient.buildEventQuery(List.of("transfer.recipient=" + jar));
        System.out.println(bold("Q-Day Tip Jar") + "  watching " + jar + " on " + NET.chainId);
        System.out.println(dim("policy: accept only tips whose sender signed with ML-DSA-87 (verified on chain)"));

        Set<String> seen = new HashSet<>();
        List<JsonNode> recent = new ArrayList<>();
        rest.searchTxs(query, 1, 5, "desc").path("tx_responses").forEach(recent::add);
        if (!recent.isEmpty()) System.out.println(dim("-- recent --"));
        for (int i = recent.size() - 1; i >= 0; i--) {
            seen.add(recent.get(i).path("txhash").asText());
            printTips(recent.get(i), jar, true);
        }
        System.out.println(dim("-- live (polling every 3 s, Ctrl+C to stop) --"));
        while (true) {
            Thread.sleep(3000);
            List<JsonNode> fresh = new ArrayList<>();
            try {
                rest.searchTxs(query, 1, 20, "desc").path("tx_responses").forEach(fresh::add);
            } catch (RuntimeException e) {
                System.out.println(dim("(poll failed: " + e.getMessage() + ", retrying)"));
                continue;
            }
            for (int i = fresh.size() - 1; i >= 0; i--) {
                if (seen.add(fresh.get(i).path("txhash").asText())) printTips(fresh.get(i), jar, false);
            }
        }
    }

    /** One line per MsgSend to the jar in this tx. */
    static void printTips(JsonNode txr, String jar, boolean old) {
        JsonNode body = txr.path("tx").path("body");
        String memo = body.path("memo").asText("");
        String hash = txr.path("txhash").asText();
        for (JsonNode m : body.path("messages")) {
            if (!"/cosmos.bank.v1beta1.MsgSend".equals(m.path("@type").asText())) continue;
            if (!jar.equals(m.path("to_address").asText())) continue;
            String from = m.path("from_address").asText();
            String uqor = "0";
            for (JsonNode c : m.path("amount")) if ("uqor".equals(c.path("denom").asText())) uqor = c.path("amount").asText();
            Verdict v = verify(txr, txr.path("tx"), from);
            boolean safe = v.verified && v.pqcSigBytes == MLDSA87_SIG;
            String tag = safe ? green("QUANTUM-SAFE  ") : yellow("classical only");
            String action = safe ? green("ACCEPTED") : yellow("held for review");
            String line = tag + "  +" + Denom.fromBase(uqor) + " QOR  from " + from
                    + (memo.isEmpty() ? "" : "  \"" + memo + "\"");
            System.out.println((old ? dim("  ") : "  ") + line);
            System.out.println("      " + action + dim("  height " + txr.path("height").asText()
                    + "  tx " + hash.substring(0, 12) + "..."
                    + (v.pqcSigBytes > 0 ? "  ML-DSA-87 sig " + v.pqcSigBytes + " B" : "  no ML-DSA-87 signature")));
        }
    }
}
