---
name: dev  
description: 開発サーバーを起動する (Tauri dev / フロントエンドのみ)  
argument-hint: "[--frontend-only]"  
---

Ember開発サーバーを起動する。  

手順:  

1. 引数に `--frontend-only` が指定された場合:  
   - `cd apps/desktop && npm run dev` を実行 (vite dev server のみ、ポート1420)
2. それ以外 (デフォルト):  
   - `cd apps/desktop && npm run tauri:dev` を実行 (フロントエンド + Tauriバックエンド同時起動)

モジュール不足エラーが発生しない限り `npm install` は実行しない。  
dev サーバーはバックグラウンドで実行し、ユーザーに停止方法 (Ctrl+C) を伝えること。  
