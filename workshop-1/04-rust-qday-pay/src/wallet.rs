//! The demo wallet: one mnemonic in a 0600 key file, never printed.
//!
//! Account type: QoreChain Native secp256k1 (coin type 118, `m/44'/118'/0'/0/0`)
//! plus its ML-DSA-87 key, derived from the same mnemonic with the SDK's
//! canonical address-bound rule (the one the wallet adapter uses).

use qorechain::accounts::{derive_native_account, generate_mnemonic, Secp256k1Account};
use qorechain::authenticator::try_derive_pqc_canonical;
use qorechain::pqc::PqcKeypair;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

pub struct Wallet {
    pub classical: Secp256k1Account, // secp256k1 key + qor1 address
    pub pqc: PqcKeypair,             // ML-DSA-87 key (2592 / 4896 bytes)
}

impl Wallet {
    pub fn address(&self) -> &str {
        &self.classical.address
    }
}

/// `$QDAY_KEY_FILE`, or `~/.config/qday/rust.env`.
pub fn key_file() -> PathBuf {
    if let Ok(p) = std::env::var("QDAY_KEY_FILE") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").expect("HOME is not set");
    PathBuf::from(home).join(".config/qday/rust.env")
}

fn from_mnemonic(mnemonic: &str) -> Res<Wallet> {
    let classical = derive_native_account(mnemonic, 0)?;
    let pqc = try_derive_pqc_canonical(&classical.address, mnemonic)?;
    Ok(Wallet { classical, pqc })
}

/// Creates a new mnemonic and writes it to the key file (mode 0600).
/// Refuses to overwrite an existing key file.
pub fn create() -> Res<(Wallet, PathBuf)> {
    let path = key_file();
    if let Some(dir) = path.parent() {
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    }
    let mnemonic = generate_mnemonic(256)?;
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true) // never overwrite a funded key
        .mode(0o600)
        .open(&path)
        .map_err(|e| format!("cannot create {} ({e}); it may already exist", path.display()))?;
    writeln!(f, "# QoreChain TESTNET demo key (Workshop 1). Never fund on mainnet.")?;
    writeln!(f, "QOR_MNEMONIC=\"{mnemonic}\"")?;
    Ok((from_mnemonic(&mnemonic)?, path))
}

/// Loads the wallet from the key file.
pub fn load() -> Res<Wallet> {
    let path = key_file();
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("cannot read {} ({e}); run `qday-pay new` first", path.display()))?;
    let mnemonic = text
        .lines()
        .find_map(|l| l.trim().strip_prefix("QOR_MNEMONIC="))
        .map(|v| v.trim().trim_matches('"').to_string())
        .ok_or("no QOR_MNEMONIC line in the key file")?;
    from_mnemonic(&mnemonic)
}
