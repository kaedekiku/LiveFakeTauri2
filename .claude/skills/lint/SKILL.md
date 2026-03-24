---
name: lint  
description: Lint一括実行 (cargo clippy + TypeScript型チェック)  
argument-hint: "[rust|ts|all]"  
---

EmberプロジェクトのLintを実行する。引数で対象を選択:  

- `rust` — `cargo clippy --workspace -- -D warnings` を実行
- `ts` — `cd apps/desktop && npx tsc --noEmit` を実行
- `all` (引数なしの場合のデフォルト) — rust, ts の順に両方実行

各ステップの結果 (警告数、エラー数) を集計して報告する。  
いずれかのステップでエラーがあっても、残りのステップは続行すること。  
