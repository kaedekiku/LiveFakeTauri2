//! 暗号化して置く部分の組み込み。
//!
//! 公開リポジトリには、ソースを暗号化したもの (sealed.bin) だけを置く。
//! カギのファイル (sealed.key。Git の対象外) があればビルドのときに復号して組み込み、`cfg(yt_sealed)` を立てる。
//! カギが無ければ何もしない (exe に入らない。リリース版はこちら)。
//! 手元に暗号化する前のソース (sealed_plain.rs。Git の対象外) があればそちらを使い、sealed.bin と食い違えば警告する。
//! 環境変数 LF_YT_SEALED_OFF があれば、カギがあっても組み込まない (リリース版と同じものを手元で確かめる用)。

use std::path::PathBuf;

include!("seal_common.rs");

fn main() {
    println!("cargo:rustc-check-cfg=cfg(yt_sealed)");
    // このフォルダのどれかが変わったら作り直す (無いファイルを直接見張ると毎回作り直しになるため、フォルダごと見張る)
    println!("cargo:rerun-if-changed=.");
    println!("cargo:rerun-if-env-changed=LF_YT_SEALED_OFF");
    if std::env::var_os("LF_YT_SEALED_OFF").is_some() {
        return;
    }
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let Ok(key_text) = std::fs::read_to_string(dir.join("sealed.key")) else {
        return;
    };
    let key = decode_key(&key_text).unwrap_or_else(|e| panic!("sealed.key: {e}"));
    let enc = std::fs::read(dir.join("sealed.bin")).unwrap_or_else(|e| panic!("sealed.bin が読めません: {e}"));
    let decrypted = decrypt(&key, &enc)
        .unwrap_or_else(|| panic!("sealed.key のカギで sealed.bin を復号できませんでした (カギが違うか、sealed.bin が壊れています)"));
    let source = match std::fs::read(dir.join("sealed_plain.rs")) {
        Ok(plain) => {
            if plain != decrypted {
                println!("cargo:warning=sealed_plain.rs が sealed.bin と違います。`cargo run -p core-youtube --example seal` で暗号化し直してください (今回は sealed_plain.rs を使います)");
            }
            plain
        }
        Err(_) => decrypted,
    };
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("sealed.rs");
    std::fs::write(&out, source).unwrap_or_else(|e| panic!("{}: {e}", out.display()));
    println!("cargo:rustc-cfg=yt_sealed");
}
