5ch.ioとの接続問題をデバッグしてください。  

症状: $ARGUMENTS  

以下の手順でデバッグすること:  

1. **到達性確認** — `python3 scripts/validate_5ch_io.py` を実行して基本的な接続を確認  

2. **エンドポイント別確認**:  
   - 板メニュー: `https://menu.5ch.io/bbsmenu.json` へのGET
   - スレッド一覧: `https://<server>.5ch.io/<board>/subject.txt` (Shift_JIS)
   - スレッドデータ: dat形式 (Shift_JIS, `<>`区切り)

3. **コード調査** — 関連するRustコードを確認:  
   - `crates/core-fetch/src/lib.rs` — フェッチロジック
   - `crates/core-parse/src/lib.rs` — パースロジック
   - `crates/core-auth/src/lib.rs` — 認証フロー
   - `apps/desktop/src-tauri/src/lib.rs` — Tauriコマンド

4. **よくある原因**:  
   - Shift_JISデコード漏れ (UTF-8前提になっていないか)
   - `5ch.net` → `5ch.io` の正規化漏れ
   - Cookie送信スコープの不一致 (`.uplift.5ch.io` vs `<server>.5ch.io`)
   - reqwest タイムアウト設定の欠如
   - 確認フォームHTML内の引用符なし属性のパース失敗

原因の特定と修正案を提示すること。  
