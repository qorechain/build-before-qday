//! qday-pay: hybrid (secp256k1 + ML-DSA-87) payments on QoreChain testnet.
//! Build Before Q-Day, Workshop 1.

mod chain;
mod wallet;

use chain::line;
use qorechain::msg::cosmos::bank_send_any;
use qorechain::pqc_dx::{fetch_pqc_status, PqcDx};
use qorechain::tx::{
    broadcast_and_wait, build_hybrid_tx, estimate_fee, wait_for_tx, BroadcastMode,
    BuildHybridTxParams, Fee, Message, WaitOptions,
};
use qorechain::{from_base, get_network, to_base, RestClient, SignBytesMode, SignBytesResolver};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

const GAS_PRICE: &str = "0.15uqor"; // chain floor is 0.1uqor
const GAS_MARGIN: f64 = 1.3; //        gas limit = simulated gas x 1.3

struct Net {
    chain_id: String,
    rest_url: String,
    rest: RestClient,
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = run(&args).await {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

async fn run(args: &[String]) -> Res<()> {
    // Testnet only: the SDK preset for qorechain-diana.
    let preset = get_network("testnet")?;
    let chain_id = preset.chain_id.clone().unwrap_or_default();
    if chain_id != "qorechain-diana" {
        return Err("this demo runs on the qorechain-diana testnet only".into());
    }
    let rest_url = preset.endpoint("rest")?;
    let net = Net { rest: RestClient::new(rest_url.clone()), chain_id, rest_url };

    match args.first().map(String::as_str) {
        Some("new") => cmd_new(),
        Some("status") => cmd_status(&net).await,
        Some("register") => cmd_register(&net).await,
        Some("send") if args.len() >= 3 => {
            let memo = flag(args, "--memo").unwrap_or_default();
            cmd_send(&net, &args[1], &args[2], &memo).await
        }
        Some("verify") if args.len() >= 2 => verify(&net, &args[1]).await,
        _ => {
            println!("qday-pay: hybrid post-quantum payments on QoreChain testnet\n");
            println!("  qday-pay new");
            println!("  qday-pay status");
            println!("  qday-pay register");
            println!("  qday-pay send <qor1to> <amount_qor> [--memo text]");
            println!("  qday-pay verify <tx_hash>");
            Ok(())
        }
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).cloned()
}

// ---------------------------------------------------------------- new
fn cmd_new() -> Res<()> {
    let (w, path) = wallet::create()?;
    println!("\n  New testnet account (mnemonic saved, not shown)\n");
    line("address", w.address());
    line("key file", format!("{} (0600)", path.display()));
    println!("\n  Next: fund it with testnet QOR, then `qday-pay status`.\n");
    Ok(())
}

// ---------------------------------------------------------------- status
async fn cmd_status(net: &Net) -> Res<()> {
    let w = wallet::load()?;
    let bal = chain::balance_uqor(&net.rest, w.address()).await?;
    let pqc = fetch_pqc_status(&net.rest_url, w.address()).await?;
    let height = chain::latest_height(&net.rest_url).await?;
    println!();
    line("network", format!("{} (testnet)", net.chain_id));
    line("address", w.address());
    line("balance", format!("{} QOR", from_base(&bal.to_string(), 6)?));
    line("ML-DSA-87", if pqc.registered { "registered on chain" } else { "NOT registered (run `qday-pay register`)" });
    line("block", height);
    println!();
    Ok(())
}

// ---------------------------------------------------------------- register
async fn cmd_register(net: &Net) -> Res<()> {
    let w = wallet::load()?;
    let (account_number, sequence) = chain::account_info(&net.rest, w.address()).await?;
    let mut dx = PqcDx {
        sender: w.address().to_string(),
        private_key: w.classical.private_key.clone(),
        public_key: w.classical.public_key.clone(),
        pqc_public_key: w.pqc.public_key.clone(),
        pqc_secret_key: w.pqc.secret_key.clone(),
        chain_id: net.chain_id.clone(),
        account_number,
        sequence,
        fee: Fee::default(),
        key_type: String::new(),
        rest_url: net.rest_url.clone(),
        mode: BroadcastMode::Sync,
        qor: None,
        sign_bytes: SignBytesMode::Auto,
    };
    println!();
    if !fetch_pqc_status(&net.rest_url, w.address()).await?.registered {
        // Simulate the registration (with its proof of possession) for the gas.
        let draft = dx.build_register_with_proof_of_possession(dx.proof_of_possession()?)?;
        dx.fee = estimate_fee(&net.rest_url, &draft.tx_raw_bytes, GAS_MARGIN, GAS_PRICE).await?;
    }
    // Idempotent: sends MsgRegisterPQCKeyV2 only when no key is registered,
    // and fails if the account holds a different key.
    let r = dx.ensure_pqc_registered().await?;
    match r.tx_hash {
        None => line("ML-DSA-87", "already registered (key matches this wallet)"),
        Some(hash) => {
            let res = wait_for_tx(&net.rest_url, &hash, WaitOptions::default()).await?;
            line("ML-DSA-87", "registered (MsgRegisterPQCKeyV2 + proof of possession)");
            line("tx", &hash);
            line("block", res.height);
            line("gas", format!("{} used / {} wanted", res.gas_used, res.gas_wanted));
        }
    }
    line("address", w.address());
    println!();
    Ok(())
}

// ---------------------------------------------------------------- send
async fn cmd_send(net: &Net, to: &str, amount_qor: &str, memo: &str) -> Res<()> {
    let w = wallet::load()?;
    if !qorechain::is_valid_bech32(to, Some("qor")) {
        return Err(format!("not a qor1 address: {to}").into());
    }
    let uqor = to_base(amount_qor, 6)?;
    let (account_number, sequence) = chain::account_info(&net.rest, w.address()).await?;

    // The payment: a plain bank MsgSend.
    let send = bank_send_any(w.address(), to, vec![coin(&uqor)]);
    // Which hybrid sign-bytes form this network verifies (asked once, cached).
    let version = SignBytesResolver::new()
        .resolve(SignBytesMode::Auto, &net.chain_id, Some(&net.rest_url))
        .await?;

    let mut params = BuildHybridTxParams {
        private_key: w.classical.private_key.clone(), // secp256k1 half
        public_key: w.classical.public_key.clone(),
        pqc_secret_key: w.pqc.secret_key.clone(),     // ML-DSA-87 half
        pqc_public_key: w.pqc.public_key.clone(),
        messages: vec![Message { type_url: send.type_url, value: send.value }],
        fee: Fee::default(),
        chain_id: net.chain_id.clone(),
        account_number,
        sequence,
        memo: memo.to_string(),
        timeout_height: 0,
        include_pqc_public_key: false, // key registered with `qday-pay register`
        sign_bytes_version: Some(version),
    };

    // 1. sign a draft, simulate it, gas = simulated x 1.3
    let draft = build_hybrid_tx(params.clone())?;
    params.fee = estimate_fee(&net.rest_url, &draft.tx_raw_bytes, GAS_MARGIN, GAS_PRICE).await?;
    // 2. sign for real: secp256k1 + ML-DSA-87
    let tx = build_hybrid_tx(params.clone())?;
    // 3. broadcast and wait for the block
    println!();
    line("sending", format!("{amount_qor} QOR -> {to}"));
    line("fee", format!("{} uqor (gas {})", params.fee.amount[0].amount, params.fee.gas));
    let res = broadcast_and_wait(&net.rest_url, &tx.tx_raw_bytes, WaitOptions::default()).await?;
    line("included", format!("block {}", res.height));
    println!();
    // 4. read it back from the chain and verify
    verify(net, &res.tx_hash).await
}

fn coin(uqor: &str) -> cosmrs::proto::cosmos::base::v1beta1::Coin {
    cosmrs::proto::cosmos::base::v1beta1::Coin { denom: "uqor".into(), amount: uqor.into() }
}

// ---------------------------------------------------------------- verify
async fn verify(net: &Net, hash: &str) -> Res<()> {
    if !chain::verify(&net.rest, hash).await? {
        std::process::exit(2);
    }
    println!();
    Ok(())
}
