---
name: stats  
description: プロジェクト統計を表示する (ソース行数、crate構成、コマンド数)  
---

Emberプロジェクトの概要統計を収集して表示する。  

以下の情報を収集:  

1. **ソース行数** — 以下のファイルの行数を `wc -l` で取得:  
   - `apps/desktop/src/App.tsx`
   - `apps/desktop/src/styles.css`
   - `apps/desktop/src-tauri/src/lib.rs`
   - `crates/core-fetch/src/lib.rs`
   - `crates/core-parse/src/lib.rs`
   - `crates/core-auth/src/lib.rs`
   - `crates/core-store/src/lib.rs`

2. **Rustワークスペース構成** — `Cargo.toml` の `[workspace] members` を表示  

3. **Tauriコマンド数** — `apps/desktop/src-tauri/src/lib.rs` 内の `#[tauri::command]` の出現回数  

4. **TypeScript型定義数** — `apps/desktop/src/App.tsx` 内の `^type ` の出現回数  

5. **最新コミット** — `git log --oneline -5` を表示  

6. **バージョン** — `apps/desktop/src-tauri/tauri.conf.json` のversionフィールド  

結果をマークダウンテーブル形式で整理して表示すること。  
