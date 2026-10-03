---
name: test  
description: プロジェクトのテストを実行する (Rust / E2E / ランディング)  
argument-hint: "[rust|e2e|landing|all]"  
---

LiveFakeプロジェクトのテストを実行する。  
引数でテスト種別を選択:  

- `rust` — プロジェクトルートから `cargo test --workspace` を実行
- `e2e` — `cd apps/desktop && npm run test:e2e` を実行 (Tauriアプリを起動し、実際の5chサーバーと通信して検証する)
- `landing` — `cd apps/landing && npm run check:latest` を実行
- `all` (引数なしの場合のデフォルト) — rust, landing の順に実行

各テストスイートの出力からパス/失敗件数を集計して報告する。  
`all` モードでは `e2e` はスキップする。(Tauriアプリの起動と実サーバーへの通信が必要なため)  
