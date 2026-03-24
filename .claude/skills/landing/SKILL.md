---
name: landing  
description: ランディングページの操作 (dev / build / latest.json検証)  
argument-hint: "[dev|build|check]"  
---

Emberランディングページ (`apps/landing/`) を操作する。  
引数で操作を選択:  

- `dev` — `cd apps/landing && npm run dev` を実行 (開発サーバー起動)
- `build` — `cd apps/landing && npm run build` を実行
- `check` (引数なしの場合のデフォルト) — `cd apps/landing && npm run check:latest` を実行 (latest.json の検証)

モジュール不足エラーが発生しない限り `npm install` は実行しない。  
`dev` モードではバックグラウンドで実行し、ユーザーに停止方法を伝えること。  
