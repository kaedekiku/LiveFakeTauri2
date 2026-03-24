新しいTauriコマンドを追加してください。  

要件: $ARGUMENTS  

以下の手順に従って実装すること:  

1. **Rust側** — `apps/desktop/src-tauri/src/lib.rs` に:  
   - 必要な型を `#[derive(Serialize)]` + `#[serde(rename_all = "camelCase")]` で定義
   - `#[tauri::command]` 関数を追加 (戻り値は `Result<T, String>`)
   - `tauri::generate_handler![...]` マクロに関数名を追加

2. **TypeScript型** — `apps/desktop/src/App.tsx` の先頭の型定義セクションに対応する型を追加  

3. **フロントエンド呼び出し** — `App.tsx` 内で `invoke()` を呼ぶ箇所を追加  
   - 必ず `isTauriRuntime()` ガード内で呼び出す
   - `.catch(() => {})` は禁止 — `console.warn` でエラーログを出力

4. **検証** — `cargo check --workspace` と `cd apps/desktop && npx tsc --noEmit` が通ることを確認  

コマンド名はRust側 snake_case、TypeScript側は invoke 時に snake_case のまま使用。  
パラメータ名はTypeScript側 camelCase (Tauriが自動変換)  
