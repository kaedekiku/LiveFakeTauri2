// 暗号化して置くソースの暗号化・復号 (build.rs と examples/seal.rs の両方から include! で読み込む)。
// カギ: 1行の文字列 "LFYTB1:" + 32 バイトの乱数の base64 (URL 用・= なし)
// 暗号化したファイル: "LFYB1" (5 バイト) + nonce (12 バイト) + AES-256-GCM の暗号文 (先頭の5バイトも改ざん検出の対象)

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;

const KEY_PREFIX: &str = "LFYTB1:";
const MAGIC: &[u8] = b"LFYB1";
const NONCE_LEN: usize = 12;

#[allow(dead_code)]
fn encode_key(key: &[u8; 32]) -> String {
    format!("{KEY_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key))
}

/// カギのファイルの中身 (前後の空白・改行は無視) から、カギの 32 バイトを取り出す
fn decode_key(text: &str) -> Result<[u8; 32], String> {
    let line = text.trim();
    let b64 = line.strip_prefix(KEY_PREFIX).ok_or_else(|| "カギの形式が違います (LFYTB1: で始まる1行です)".to_string())?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(b64)
        .map_err(|_| "カギの形式が違います (文字が欠けているか、余計な文字があります)".to_string())?;
    bytes.try_into().map_err(|_| "カギの長さが違います".to_string())
}

#[allow(dead_code)]
fn encrypt(key: &[u8; 32], nonce: &[u8; NONCE_LEN], plain: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let body = cipher
        .encrypt(Nonce::from_slice(nonce), Payload { msg: plain, aad: MAGIC })
        .map_err(|_| "暗号化できませんでした".to_string())?;
    let mut out = Vec::with_capacity(MAGIC.len() + NONCE_LEN + body.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&body);
    Ok(out)
}

/// 復号する。カギが違う・ファイルが壊れている・書き換えられているときは None
fn decrypt(key: &[u8; 32], data: &[u8]) -> Option<Vec<u8>> {
    let rest = data.strip_prefix(MAGIC)?;
    if rest.len() < NONCE_LEN {
        return None;
    }
    let (nonce, body) = rest.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    cipher.decrypt(Nonce::from_slice(nonce), Payload { msg: body, aad: MAGIC }).ok()
}
