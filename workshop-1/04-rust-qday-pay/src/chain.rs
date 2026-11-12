//! Small REST reads and the verification report.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use qorechain::RestClient;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

pub const EXPLORER: &str = "https://explore.qore.network/tx/";

/// One aligned "label  value" line, easy to read.
pub fn line(label: &str, value: impl std::fmt::Display) {
    println!("  {label:<12} {value}");
}

/// (account_number, sequence) of an account that exists on chain.
pub async fn account_info(rest: &RestClient, addr: &str) -> Res<(u64, u64)> {
    let v = rest
        .get(&format!("cosmos/auth/v1beta1/accounts/{addr}"), &[])
        .await
        .map_err(|_| format!("account {addr} not found on chain yet; fund it first"))?;
    let a = &v["account"];
    let a = if a["base_account"].is_object() { &a["base_account"] } else { a };
    let num = |k: &str| a[k].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0);
    Ok((num("account_number"), num("sequence")))
}

/// Spendable uqor balance.
pub async fn balance_uqor(rest: &RestClient, addr: &str) -> Res<u128> {
    let v = rest.get_all_balances(addr).await?;
    let uqor = v["balances"].as_array().into_iter().flatten()
        .find(|c| c["denom"] == "uqor")
        .and_then(|c| c["amount"].as_str()?.parse().ok());
    Ok(uqor.unwrap_or(0))
}

pub async fn latest_height(rest_url: &str) -> Res<String> {
    let v = qorechain::get_latest_block(rest_url).await?;
    Ok(v["block"]["header"]["height"].as_str().unwrap_or("?").to_string())
}

/// Reads a tx back from the chain and proves it was hybrid-verified.
/// Returns true when the chain says `pqc_hybrid_verify status=verified`.
pub async fn verify(rest: &RestClient, hash: &str) -> Res<bool> {
    let hash = hash.trim().to_uppercase();
    let v = rest.get(&format!("cosmos/tx/v1beta1/txs/{hash}"), &[]).await?;
    let (resp, tx) = (&v["tx_response"], &v["tx"]);

    // 1. The chain's own verdict: the pqc_hybrid_verify event.
    let event = resp["events"].as_array().into_iter().flatten()
        .find(|e| e["type"] == "pqc_hybrid_verify");
    let attr = |k: &str| {
        event.and_then(|e| e["attributes"].as_array()?.iter().find(|a| a["key"] == k))
            .and_then(|a| a["value"].as_str()).unwrap_or("-").to_string()
    };
    // 2. The two signatures carried by the tx.
    let classical = tx["signatures"][0].as_str().map(b64_len).unwrap_or(0);
    let pqc = tx["body"]["extension_options"].as_array().into_iter().flatten()
        .find(|x| x["@type"] == "/qorechain.pqc.v1.PQCHybridSignature")
        .and_then(|x| x["pqc_signature"].as_str()).map(b64_len).unwrap_or(0);

    let ok = resp["code"].as_u64() == Some(0) && attr("status") == "verified" && pqc == 4627;
    line("tx", &hash);
    line("block", resp["height"].as_str().unwrap_or("?"));
    line("memo", tx["body"]["memo"].as_str().filter(|m| !m.is_empty()).unwrap_or("-"));
    line("classical", format!("secp256k1   {classical} bytes"));
    line("quantum", format!("ML-DSA-87   {pqc} bytes"));
    line("chain says", format!("pqc_hybrid_verify status={} ({})", attr("status"), attr("address")));
    println!();
    if ok {
        println!("  VERIFIED: secp256k1 + ML-DSA-87");
    } else {
        println!("  NOT VERIFIED as hybrid (code {}, see the lines above)", resp["code"]);
    }
    println!();
    line("explorer", format!("{EXPLORER}{hash}"));
    line("", "(switch the explorer to Testnet)");
    Ok(ok)
}

fn b64_len(s: &str) -> usize {
    B64.decode(s).map(|b| b.len()).unwrap_or(0)
}
