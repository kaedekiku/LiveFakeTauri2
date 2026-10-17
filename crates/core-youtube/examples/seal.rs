//! 暗号化して置くソースの暗号化 (作者の手元で使う)。
//!
//!   cargo run -p core-youtube --example seal              sealed_plain.rs を暗号化して sealed.bin に書く
//!   cargo run -p core-youtube --example seal -- --open    sealed.bin を復号して sealed_plain.rs に書く (新しく取り出した作業場所で)
//!   cargo run -p core-youtube --example seal -- --new-key sealed.key を作る (すでにあれば作らない)
//!   cargo run -p core-youtube --example seal -- --new-key --force
//!                                                         カギを作り直して sealed_plain.rs を暗号化し直す (古いカギは使えなくなる)
//!
//! sealed.key と sealed_plain.rs は Git の対象外。カギの中身は画面に出さない

use std::path::PathBuf;

include!("../seal_common.rs");

fn main() {
    if let Err(e) = run() {
        eprintln!("seal: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let key_path = dir.join("sealed.key");
    let plain_path = dir.join("sealed_plain.rs");
    let enc_path = dir.join("sealed.bin");
    let flag = |f: &str| args.iter().any(|a| a == f);

    if flag("--new-key") {
        if key_path.exists() && !flag("--force") {
            return Err(format!("{} はすでにあります (作り直すなら --force)", key_path.display()));
        }
        let mut key = [0u8; 32];
        aes_gcm::aead::rand_core::RngCore::fill_bytes(&mut aes_gcm::aead::OsRng, &mut key);
        std::fs::write(&key_path, format!("{}\n", encode_key(&key))).map_err(|e| e.to_string())?;
        println!("カギを作りました: {}", key_path.display());
        if !plain_path.exists() {
            return Ok(());
        }
    }

    let key = decode_key(&std::fs::read_to_string(&key_path).map_err(|e| format!("{}: {e}", key_path.display()))?)?;
    if flag("--open") {
        let enc = std::fs::read(&enc_path).map_err(|e| format!("{}: {e}", enc_path.display()))?;
        let plain = decrypt(&key, &enc).ok_or("復号できませんでした (カギが違うか、sealed.bin が壊れています)")?;
        std::fs::write(&plain_path, plain).map_err(|e| e.to_string())?;
        println!("復号しました: {}", plain_path.display());
        return Ok(());
    }
    let plain = std::fs::read(&plain_path).map_err(|e| format!("{}: {e}", plain_path.display()))?;
    let mut nonce = [0u8; NONCE_LEN];
    aes_gcm::aead::rand_core::RngCore::fill_bytes(&mut aes_gcm::aead::OsRng, &mut nonce);
    let enc = encrypt(&key, &nonce, &plain)?;
    // 書く前に、同じカギで戻せることを確かめる
    if decrypt(&key, &enc).as_deref() != Some(&plain[..]) {
        return Err("暗号化したものを復号して確かめられませんでした".into());
    }
    std::fs::write(&enc_path, enc).map_err(|e| e.to_string())?;
    println!("暗号化しました: {} ({} バイト)", enc_path.display(), plain.len());
    Ok(())
}
