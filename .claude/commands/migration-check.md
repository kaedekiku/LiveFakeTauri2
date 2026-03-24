破壊的変更の影響範囲をチェックしてください。  

変更内容: $ARGUMENTS  

以下の観点で影響を分析:  

1. **Tauriコマンドインターフェース** — コマンドの引数や戻り値型を変更する場合:  
   - Rust側の `#[tauri::command]` 関数シグネチャ
   - TypeScript側の型定義 (`apps/desktop/src/App.tsx` 先頭部分)
   - フロントエンドの `invoke()` 呼び出し箇所全て

2. **永続化データ** — JSON/SQLiteスキーマを変更する場合:  
   - `core-store` の読み書き関数
   - localStorageキー (`desktop.*`)
   - 既存ユーザーデータとの互換性

3. **CSS** — クラス名やセレクタを変更する場合:  
   - `apps/desktop/src/styles.css` での定義
   - `App.tsx` での `className` 参照
   - スモークテストのセレクタ (`scripts/smoke_ui_playwright.mjs`)

4. **ワークスペース依存** — crateの公開APIを変更する場合:  
   - 他のcrateからの参照 (`use core_xxx::...`)
   - `src-tauri/src/lib.rs` からの `use` 文

影響を受けるファイルの一覧と、必要な修正箇所を具体的に示すこと。  
