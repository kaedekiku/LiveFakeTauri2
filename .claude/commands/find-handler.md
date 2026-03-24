指定されたTauriコマンドまたはフロントエンド機能の実装箇所を特定してください。  

検索対象: $ARGUMENTS  

以下を調査して報告:  

1. **Rust側** — `apps/desktop/src-tauri/src/lib.rs` 内の `#[tauri::command]` 関数  
   - 関数シグネチャ (引数・戻り値)
   - 呼び出しているライブラリcrate関数

2. **ライブラリcrate** — 実際のロジックが実装されている箇所  
   - `crates/core-fetch/src/lib.rs`
   - `crates/core-parse/src/lib.rs`
   - `crates/core-auth/src/lib.rs`
   - `crates/core-store/src/lib.rs`

3. **フロントエンド** — `apps/desktop/src/App.tsx` 内の:  
   - `invoke("command_name")` の呼び出し箇所 (行番号)
   - 対応するTypeScript型定義
   - UIのどの部分から呼ばれるか (イベントハンドラ、useEffect等)

4. **データフロー図** — Rustからフロントエンドへのデータの流れを簡潔に示す  

引数が空の場合は全Tauriコマンドの一覧を表示すること。  
