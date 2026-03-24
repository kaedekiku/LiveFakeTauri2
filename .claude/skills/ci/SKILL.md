---
name: ci  
description: CIローカル再現 (.github/workflows/ci.yml 相当のチェックを一括実行)  
---

`.github/workflows/ci.yml` と同等のチェックをローカルで順次実行する。  

手順:

1. `cargo check --workspace` を実行  
2. `cd apps/desktop && npm run build` を実行 (tsc + vite)  
3. スモークUIテスト: Linux では `cd apps/desktop && bash scripts/run_smoke_ui.sh`、それ以外では `cd apps/desktop && npm run test:smoke-ui` を実行  
4. ランディングページ: `cd apps/landing && npm run check:latest` を実行  

全4ステップの結果をまとめて報告:  

- 各ステップの成功/失敗
- 失敗したステップがある場合はエラー詳細を表示
- 全ステップ成功の場合は「CI相当チェック全パス」と報告

いずれかのステップが失敗しても残りは続行すること。  
