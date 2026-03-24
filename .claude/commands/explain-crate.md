指定されたRustクレートの構造を解説してください。  

対象: $ARGUMENTS  

以下を調査・報告すること:  

1. **概要** — クレートの責務を1〜2文で  
2. **公開API** — `pub fn` / `pub struct` / `pub enum` の一覧と簡易説明  
3. **依存関係** — `Cargo.toml` の依存crate一覧  
4. **エラー型** — カスタムエラー型がある場合はそのバリアント  
5. **Tauriとの接続** — このクレートの関数が `apps/desktop/src-tauri/src/lib.rs` のどのTauriコマンドから呼ばれているか  
6. **テスト** — `#[cfg(test)]` や `#[test]` の有無とテスト内容の概要  

クレート名の例: `core-fetch`, `core-parse`, `core-auth`, `core-store`, `src-tauri`  

引数が空の場合は全クレートの一覧と各1行の概要を表示すること。  
