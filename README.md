# LiveFake

**実況向け日本語掲示板ブラウザ** — Tauri v2 (Rust) + React デスクトップアプリ

5ch.io / したらば / JPNKN の3サイトに対応した Portable 形式の実況専用ブラウザです。  
ZIP を展開するだけでインストール不要で使えます。

---

## ダウンロード

[GitHub Releases](../../releases) から最新版の ZIP をダウンロードして展開してください。

| プラットフォーム | ファイル |
|----------------|---------|
| Windows 10/11 (64bit) | `livefake-win-x64.zip` |

> WebView2 Runtime が必要です。Windows 10/11 には通常プリインストール済みです。

---

## 主な機能

### 掲示板の閲覧

- **3サイト対応**: 5ch.io (Shift_JIS) / したらば (EUC-JP) / JPNKN (Shift_JIS)
- **板一覧**: 5ch BBS Menu をカテゴリーツリーで表示、検索フィルタ付き
- **スレッド一覧**: ソート・検索・未読管理・勢いバー・dat 落ちキャッシュ
- **マルチタブ**: 最大 20 タブを同時表示、ドラッグで並べ替え
- **自動リロード**: 15〜300 秒間隔で新着レスを自動取得
- **差分取得**: 前回最終レス以降のみ取得して効率化

### レス表示

- アンカーポップアップ (`>>N`, `>>N-M` 形式対応)
- ID 色分け・書き込み回数表示（多投稿者を色で識別）
- 被参照数表示 (▼N)
- 新着マーカー「ここから新着」/ "New!" ラベル
- ASCII アート自動検出・等幅フォント切替
- 画像 URL 自動検出・サムネイル表示・ライトボックス
- 自動スクロール（新着受信時に末尾へ）

### 書き込み

- 名前 / メール / 本文入力、sage 自動設定
- ダブルクリックでレス引用
- 書き込みプレビュー
- 書き込み履歴（最大 50 件）
- 新スレ立て対応
- MonaTicket 自動取得・Cookie 永続管理

### 実況特化機能

| 機能 | 説明 |
|------|------|
| **字幕ウィンドウ** | 半透明オーバーレイで新着レスを最前面表示。透明度・フォントサイズ調整可。 |
| **新着ペイン** | 画面下部に最新レスをリアルタイム表示するサブパネル |
| **音声読み上げ** | SAPI / 棒読みちゃん / VOICEVOX の3エンジン対応。新着レス自動読み上げ。 |

### フィルター・ハイライト

- **NG フィルター**: ワード / ID / 名前 / スレタイ。正規表現対応。スコープ（グローバル / ボード / スレ）設定可。
- **NG モード**: 非表示 / 画像のみ非表示
- **ハイライト**: 15 色パレットでテキスト・名前・ID を色分け。字幕ウィンドウにも同期。
- コンテキストメニューから NG 追加・ハイライト設定が即時適用

### 設定・カスタマイズ

- ライト / ダークモード
- フォント・サイズ・レス間隔のカスタマイズ
- BE / UPLIFT / どんぐり 認証対応
- HTTP / SOCKS5 プロキシ対応（パスワードは DPAPI 暗号化）
- 画像 URL 置換ルール (ImageViewURLReplace.txt) でサムネイル変換をカスタマイズ
- ウィンドウ位置・サイズ・タブを次回起動時に復元

---

## 画面構成

```
┌─────────────────────────────────────────────────┐
│ ツールバー (URL / 検索 / 設定 / 字幕トグル)       │
├──────────┬──────────────────────────────────────┤
│ 板ペイン  │ タブバー                              │
│ (ツリー)  ├──────────────────────────────────────┤
│          │ レス表示エリア                         │
│ ─────── │                                      │
│ 新着ペイン│                                      │
│          ├──────────────────────────────────────┤
│          │ 書き込みフォーム                       │
├──────────┴──────────────────────────────────────┤
│ ステータスバー                                    │
└─────────────────────────────────────────────────┘
```

各パネルはドラッグで幅・高さを自由に調整できます。

---

## キーボードショートカット

| キー | 動作 |
|------|------|
| `Enter` | URL 読み込み |
| `Ctrl+F` | 検索欄フォーカス |
| `Ctrl+W` | タブを閉じる |
| `Ctrl+R` | 再読み込み |
| `Ctrl+Tab` | 次のタブへ |
| `Ctrl+Shift+Tab` | 前のタブへ |
| `Escape` | モーダル / メニューを閉じる |

---

## 設定ファイル（Portable 形式）

全ファイルは EXE と同じフォルダに自動生成されます。

| ファイル | 内容 |
|---------|------|
| `settings.ini` | アプリ全般設定 |
| `ng-settings.json` | NG フィルター |
| `text-highlights.json` | テキスト / 名前ハイライト |
| `id-highlights.json` | ID ハイライト（当日分） |
| `cookies.json` | 認証 Cookie |
| `bbs-menu.json` | BBS Menu キャッシュ |
| `ImageViewURLReplace.txt` | 画像 URL 置換ルール（TSV） |
| `thread-cache.db` | スレッドレスキャッシュ（SQLite） |
| `eventlog/` | ログファイル |

---

## 開発者向け

### 前提条件

- Rust stable (1.77+)
- Node.js v22+
- Tauri CLI（`devDependencies` に含まれる）

### セットアップ

```bash
cd apps/desktop
npm install

# 開発サーバー起動
npx tauri dev

# 本番ビルド
npx tauri build
```

> **注意:** `cargo build --release` を直接使用しないでください。  
> フロントエンドが埋め込まれず白画面になります。必ず `npx tauri build` を使用してください。

### テスト

```bash
# Rust ユニットテスト
cargo test --workspace

# UI スモークテスト（Tauri 不要）
cd apps/desktop
npm run build && npx playwright test scripts/smoke_ui_playwright.mjs
```

### プロジェクト構成

```
LiveFakeTauri2/
├── apps/
│   ├── desktop/          # Tauri + React デスクトップアプリ（メイン）
│   │   ├── src/          # フロントエンド（App.tsx + styles.css）
│   │   └── src-tauri/    # Rust バックエンド
│   └── landing/          # 公式サイト（Cloudflare Pages）
├── crates/
│   ├── core-auth/        # BE / UPLIFT / どんぐり認証
│   ├── core-fetch/       # HTTP 取得・投稿フロー
│   ├── core-parse/       # dat / subject.txt パーサ
│   ├── core-store/       # JSON 永続化 / SQLite キャッシュ
│   ├── core-proxy/       # プロキシ / DPAPI / Cookie 管理
│   └── core-tts/         # 音声読み上げ（SAPI / 棒読みちゃん / VOICEVOX）
├── docs/                 # 技術ドキュメント
├── scripts/              # ビルド・リリーススクリプト
├── SPEC.md               # 技術仕様書
└── REQUIREMENTS.md       # 機能要件定義書
```

### ドキュメント

| ファイル | 内容 |
|---------|------|
| [SPEC.md](SPEC.md) | 技術仕様書（アーキテクチャ・API・データ形式） |
| [REQUIREMENTS.md](REQUIREMENTS.md) | 機能要件定義書 |
| [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) | 開発手順・環境構築 |
| [docs/DEPLOYMENT_RUNBOOK.md](docs/DEPLOYMENT_RUNBOOK.md) | リリース・デプロイ手順 |
| [docs/PROGRESS_TRACKER.md](docs/PROGRESS_TRACKER.md) | 実装進捗 |

---

## ライセンス

MIT License

GPL ライセンスのライブラリは使用していません。
