# LiveFake — CLAUDE.md

実況向け掲示板ブラウザ (Tauri v2 + Reactデスクトップアプリ)

## リポジトリ構成

```
├── apps/
│   ├── desktop/          # Tauri + Reactデスクトップアプリ (メインプロダクト)
│   │   ├── src/          # フロントエンド (App.tsx単一ファイル + styles.css)
│   │   └── src-tauri/    # Rustバックエンド (Tauriコマンド定義)
│   └── landing/          # 公式サイト (Cloudflare Pages)
├── crates/
│   ├── core-auth/        # BE / UPLIFT / どんぐり認証
│   ├── core-fetch/       # HTTP取得・投稿フロー (core-parseに依存)
│   ├── core-parse/       # dat / subject.txt / bbsmenuパーサ (依存なし)
│   └── core-store/       # JSON永続化 / SQLiteキャッシュ
├── docs/                 # DEVELOPER_GUIDE / DEPLOYMENT_RUNBOOK / PROGRESS_TRACKER
└── scripts/              # ビルド・リリース・プローブ用スクリプト
```

### crate 依存関係

```
Tauri App (livefake)
├── core-auth   (認証: reqwest, thiserror)
├── core-fetch  (HTTP取得: reqwest, encoding_rs) → core-parse
├── core-store  (永続化: rusqlite, dirs)
└── core-parse  (パーサ: 外部依存なし)
```

## 開発コマンド

```bash
# --- セットアップ ---
cd apps/desktop && npm install

# --- 開発サーバー ---
cd apps/desktop && npx tauri dev          # Tauri + Vite (フル)
cd apps/desktop && npx vite --port 1420   # フロントエンドのみ

# --- ビルド ---
cd apps/desktop && npx tauri build            # 本番ビルド (Tauri)
cd apps/desktop && npx tsc && npx vite build  # フロントエンドのみ
cargo check --workspace                       # Rust型チェック

# --- テスト ---
cargo test --workspace                    # Rustユニットテスト
cargo test --workspace -- --ignored       # ネットワーク接続テスト含む
cd apps/desktop && npx playwright test scripts/smoke_ui_playwright.mjs  # UIスモークテスト

# --- Lint ---
cargo clippy --workspace -- -D warnings  # Rust lint
cd apps/desktop && npx tsc --noEmit      # TypeScript型チェック
```

## スキル (スラッシュコマンド)

| コマンド | 用途 |
|---------|------|
| `/build` | フルビルド (Rust + フロントエンド + Tauri) |
| `/dev` | 開発サーバー起動 |
| `/test` | テスト実行 (`rust\|smoke\|e2e\|landing\|all`) |
| `/lint` | Lint一括実行 (`rust\|ts\|all`) |
| `/ci` | CI再現 (チェック一括実行) |
| `/deps` | 依存関係の更新・監査 |
| `/smoke` | Playwright スモークテスト |
| `/probe` | 5ch.io 接続プローブ |
| `/release` | リリース準備 (バージョン更新・検証) |
| `/stats` | プロジェクト統計表示 |
| `/landing` | ランディングページ操作 |

## コマンド (対話型ガイド)

| コマンド | 用途 |
|---------|------|
| `/add-command` | 新規Tauriコマンド追加ガイド |
| `/add-smoke-test` | スモークテストケース追加ガイド |
| `/debug-5ch` | 5ch.io接続問題デバッグ |
| `/explain-crate` | Rustクレート構造解説 |
| `/find-handler` | Tauriコマンド/機能の実装箇所特定 |
| `/migration-check` | 破壊的変更の影響範囲チェック |
| `/review-diff` | git diffレビュー |
| `/summarize` | 最近の変更要約 |

## アーキテクチャ要点

- **フロントエンド**: `App.tsx` 単一ファイルモノリス。状態は `useState`/`useEffect` で完結。外部UIライブラリ不使用
- **スタイル**: `styles.css` 単一ファイル。`.dark` クラスでダークモード切替
- **ランタイム依存**: react, react-dom, @tauri-apps/api, lucide-react のみ
- **Tauri IPC**: `invoke()` は `isTauriRuntime()` チェックで囲む。コマンド名は snake_case、パラメータはcamelCase
- **Rust crate**: 各crateは単一 `lib.rs` を維持 (2000行超まで分割しない)
- **エラー処理**: Tauriコマンドは `Result<T, String>`、ライブラリcrateは `thiserror` カスタム型
- **5ch固有**: レスポンスは Shift_JIS デコード必須、URLは `normalize_5ch_url()` を通す
- **永続化**: localStorage (`desktop.*` プレフィックス) + JSON/SQLite (core-store 経由)

## コード規約

詳細は `.claude/rules/` を参照:  

- **Rust**: `.claude/rules/rust.md` — エラー処理、シリアライズ、5ch固有ルール、テスト
- **React/TypeScript**: `.claude/rules/react.md` — IPC、永続化、スタイリング、セキュリティ

### 重要な禁止事項
- `unwrap()` 禁止 (ネットワーク応答・ファイルI/O)
- `.catch(() => {})` 禁止 — エラーは `console.warn` でログ
- 新規npm依存の無断追加禁止
- Cookie値 (`Be3M`, `Be3D`, `sid`) のDEBUG以上でのログ記録禁止
- `App.tsx` の分割禁止 (明示的指示がない限り)
- リリースビルドで `cargo build --release -p livefake` を直接使用禁止 — 必ず `npx tauri build` を通すこと (フロントエンドが埋め込まれず白画面になる)

## ドキュメント

| ファイル | 内容 |
|---------|------|
| `docs/DEVELOPER_GUIDE.md` | 技術仕様・アーキテクチャ・開発手順 |
| `docs/DEPLOYMENT_RUNBOOK.md` | リリース・デプロイ手順 |
| `docs/PROGRESS_TRACKER.md` | 実装進捗・未実装タスク |

## リリース

リリースフローの詳細は `docs/DEPLOYMENT_RUNBOOK.md` を参照。

- `/release` スキル — バージョン更新・検証・差分確認（コミットやビルドは行わない）
- タグ push (`git push origin v<バージョン>`) で GitHub Actions が Windows ビルド・Release 作成を自動実行
- `scripts/prepare_release_metadata.py` で `latest.json` を生成・検証

---

## LiveFakeTauri2 固有ルール

本プロジェクトは LiveFake (5ch-browser-template ベース) の、実況向け機能を追加したフォーク版である。

### 必読ドキュメント

- `REQUIREMENTS.md` — 全機能の要件定義書。実装前に必ず該当セクションを確認すること。

### 追加対応サイト

| サイト | エンコーディング | 備考 |
|--------|----------------|------|
| したらば (`jbbs.shitaraba.net`) | EUC-JP | HTML形式(DT/DDタグ) |
| JPNKN (`bbs.jpnkn.com`) | Shift_JIS | dat形式 |

### ライセンス制約

- **GPL ライセンスのライブラリは使用禁止**（GPLv2 / GPLv3 / AGPL いずれも不可）
- Rust crate 追加時は `cargo deny check licenses` で確認
- npm パッケージ追加時は `npx license-checker --excludePrivatePackages --failOn "GPL-2.0;GPL-3.0;AGPL-3.0"` で確認
  (`--excludePrivatePackages` は `"private": true` の livefake 自身を除外するために必要)

### 設定ファイル方針

- Portable 形式: 全設定ファイルは EXE 同梱フォルダに保存
- 既存の localStorage 依存は段階的にファイルベース（INI/JSON）に移行
- INI ファイル（`settings.ini`）: App / Speech / Proxy / Posting / Window セクション
- JSON ファイル: ng-settings / id-highlights / text-highlights / cookies / board-catalog / thread-history

### 新規 crate 追加時の規約

- `crates/` 配下に作成し、Cargo.toml の workspace members に追加
- 既存 crate の依存関係パターンに従う（core-parse は外部依存なし等）
- エラー処理: ライブラリ crate は `thiserror` カスタム型

### Windows 固有機能

- SAPI（COM）: STA スレッドで実行すること
- 棒読みちゃん: コマンドインジェクション対策必須（ヌルバイト除去・2000文字制限）

### 実装優先順

Phase 1: 基盤調整（自動更新間隔可変、自動スクロール、Portable設定）
Phase 2: マルチサイト対応（したらば、JPNKN の閲覧・書き込み）
Phase 3: 実況機能（新着ペイン、字幕ポップアップ、音声読み上げ）
Phase 4: ハイライト・コンテキストメニュー（15色、トグル）
Phase 5: インフラ（プロキシ、ImageViewURLReplace、Cookie管理）
