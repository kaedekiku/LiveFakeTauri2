# LiveFake 仕様書 (SPEC)

本書は LiveFake の技術仕様書です。実装コード (v0.0.98 時点) に基づいて記述しています。

---

## 1. プロジェクト概要

| 項目 | 内容 |
|------|------|
| 製品名 | LiveFake |
| 識別子 | io.livefake.browser |
| 種別 | デスクトップ掲示板ブラウザ (実況向け) |
| 対応サイト | 5ch.io / したらば (jbbs.shitaraba.net) / JPNKN (bbs.jpnkn.com) |
| 対応 OS | Windows 10/11 x64 (配布対象) |
| ライセンス | MIT (GPL 系ライブラリ不使用) |

---

## 2. 配布・ビルド仕様

### 2.1 配布形式

- GitHub Releases に `livefake-win-x64.zip` (単一 EXE) を添付
- タグ `v*` の push で GitHub Actions (`.github/workflows/release.yml`) が自動ビルド・添付
- Portable 形式: インストーラ不要。データはすべて実行フォルダ配下 `data/` に保存

### 2.2 必須ランタイム

- WebView2 Runtime (Windows 10/11 は通常プリインストール)

### 2.3 ビルド方法

```bash
cd apps/desktop && npm install        # 初回のみ
npx tauri dev                         # 開発
npx tauri build                       # 本番ビルド (必ずこちらを使用)
cargo check --workspace               # Rust 型チェック
cargo test --workspace                # Rust テスト
```

> リリースビルドで `cargo build --release -p livefake` を直接使うとフロントエンドが
> 埋め込まれず白画面になるため、必ず `npx tauri build` を使用する。

---

## 3. アーキテクチャ

### 3.1 技術スタック

| レイヤ | 技術 |
|--------|------|
| フレームワーク | Tauri v2 |
| フロントエンド | React + TypeScript (Vite)。`App.tsx` 単一ファイル + `styles.css` 単一ファイル |
| ランタイム npm 依存 | react / react-dom / @tauri-apps/api / lucide-react の4つのみ |
| バックエンド | Rust (ワークスペース crates) |
| HTTP | reqwest (タイムアウト30秒) |
| 永続化 | INI + JSON ファイル + SQLite (rusqlite) |

### 3.2 Rust crate 構成

```
Tauri App (livefake)
├── core-fetch  HTTP取得・投稿フロー全般 → core-parse に依存
├── core-parse  subject.txt / dat / read.cgi HTML / したらば / JPNKN パーサ (外部依存: encoding_rs のみ)
├── core-proxy  プロキシクライアント生成・ImageViewURLReplace パーサ
├── core-store  Portable 永続化 (INI/JSON/SQLite/イベントログ)
└── core-tts    SAPI / 棒読みちゃん / VOICEVOX 読み上げ
```

- 各 crate は単一 `lib.rs` 構成
- エラー処理: ライブラリ crate は `thiserror` カスタム型、Tauri コマンドは `Result<T, String>`

### 3.3 IPC 通信

- フロントは `@tauri-apps/api/core` の `invoke()` で Rust コマンドを呼び出す
- コマンド名は snake_case、パラメータは camelCase (Tauri が自動変換)
- 返却型は `#[serde(rename_all = "camelCase")]`
- `invoke()` は必ず `isTauriRuntime()` チェックで囲む (ブラウザプレビュー対応)

---

## 4. 機能仕様

### 4.1 対応サイトとサイト判別

`core_fetch::detect_site_type()` が URL のホストで判別する。

| サイト | 判別ホスト | 一覧取得 | レス取得 | エンコーディング |
|--------|-----------|---------|---------|----------------|
| 5ch | `.5ch.io` / `.5ch.net` / `.2ch.net` | subject.txt | dat (read.cgi HTML フォールバック) | Shift_JIS |
| したらば | `jbbs.shitaraba.net` | subject.txt | rawmode.cgi (DT/DD HTML パーサも保持) | EUC-JP |
| JPNKN | `bbs.jpnkn.com` | subject.txt | dat (5ch と同形式) | Shift_JIS |

- `normalize_5ch_url()`: `*.5ch.net` → `*.5ch.io` へホスト正規化
- `is_allowed_url()`: 通信先を対応ドメインに限定
- `core_parse::detect_encoding()`: UTF-8 / Shift_JIS / EUC-JP のスコアリング自動判定
- User-Agent: `Monazilla/1.00 LiveFake/0.1`

### 4.2 投稿 (サイト別)

| サイト | 投稿先 | 特記 |
|--------|--------|------|
| 5ch | `bbs.cgi` | 確認画面・UPLIFT 同意フォームの hidden fields を自動処理して再送信 |
| したらば | `jbbs.shitaraba.net/bbs/write.cgi` | 書き込み・スレ立て対応 (EUC-JP エンコード) |
| JPNKN | `bbs.jpnkn.com/test/bbs.cgi` | 書き込み・スレ立て対応 |

- `post_reply_multisite` コマンドがサイト判別して分岐
- 投稿レスポンス HTML から成功/エラー/確認画面を判定
- Cookie jar クライアントで MonaTicket 等をセッション中のみ維持 (ファイル永続化なし)

### 4.3 タブ

- 板タブ・スレタブの2段。ドラッグ並べ替え、右クリックメニュー、中クリックで閉じる
- スレタブごとにレス内容・選択レス・スクロール位置・新着開始位置をメモリキャッシュ (`tabCacheRef`)
- タブ復帰時: 最下部で離れた場合は最下部へ、それ以外は表示していたレス位置へ復元
- 最大タブ数 1〜50 (既定20)
- セッション: `session_tabs.json` / `session_board_tabs.json` に保存し起動時復元 (設定で ON/OFF)

### 4.4 自動更新

- 間隔 10〜300 秒 (既定15秒)
- アクティブタブ: 全件再取得して UI 更新 (新着があればスクロール・新着ペイン・字幕・TTS へ)
- バックグラウンドタブ: 差分取得 (sinceResNo) してキャッシュ更新・新着ペインへ
- スレ一覧もサイレント更新

### 4.5 NG フィルタ

- タイプ: words / ids / names / thread_words
- `/pattern/` 形式は正規表現 (case-insensitive)
- モード: hide (非表示) / hide-images (画像のみ非表示)
- スコープ: global / board (板URL) / thread (スレURL)
- hide 対象は新着ペイン・字幕・TTS からも除外
- 永続化: `ng-settings.json`

### 4.6 ハイライト

- 15色パレット
- ID ハイライト: ID→色マップ。保存時に日付を付与し、日付が変わると無効 (`id-highlights.json`)
- テキストハイライト: type=word (本文) / name (名前欄) (`text-highlights.json`)
- 字幕ウィンドウへ色情報を同期

### 4.7 画像

- 本文中の画像 URL を検出しサムネイル化 (サイズ 50〜600px 設定可)
- サイズ制限: HEAD リクエストの Content-Length で判定、超過は「クリックで表示」
- 画像ポップアップ: Tauri 別ウィンドウ。画像は `fetch_image` で取得し data URL 化
- ホバープレビュー: 遅延設定 (0〜2000ms) / Ctrl+ホバー即時 / Ctrl+ホイールズーム (10〜500%)
- 保存: `save_image_to_folder` で設定フォルダへ
- ImageViewURLReplace: `data/ImageViewURLReplace.txt` (TSV: pattern⇥replacement[⇥referer])

### 4.8 新着レスペイン

- 新着レスをキューに積み、1件ずつ表示 (5秒表示 → 次へ)
- 本文がペインに収まらない場合: 2秒静止 → 約8ms/px でスクロール → 5秒 → 次へ
- クリックで該当スレ・レスへジャンプ。高さ 80〜420px でリサイズ可

### 4.9 字幕ウィンドウ

- Tauri の "subtitle" ウィンドウ (半透明・ドラッグ移動可)
- メインから `subtitle_update` でスレタイ・レス番・名前・ID (ハイライト色付き)・日付・本文 HTML を送信
- コマンド: `subtitle_show / hide / reset_position / update / opacity / topmost / font_size / meta_font_size / id_font_size / id_font_family`

### 4.10 音声読み上げ (TTS)

| エンジン | 実装 |
|---------|------|
| SAPI | Windows COM (STA スレッド)。レジストリからボイス列挙、SetRate (-10〜10) / SetVolume (0〜100) |
| 棒読みちゃん | RemoteTalk.exe をコマンド起動。ヌルバイト除去・2000文字制限のインジェクション対策 |
| VOICEVOX | HTTP API (speakers → audio_query → synthesis)、PlaySoundW で WAV 再生 |

- 逐次キュー処理。前処理: HTML タグ/エンティティ除去、URL 除去 (YouTube→「ユーチューブ」)、最大文字数超過は「長文のため以下省略」
- レス番プレフィックスはサイト別 (レス/したらば/ジャパンくん N番さん)
- 読み上げ辞書: キーワード→読みの置換。「全置換」でレス全体を置換 (`tts-dict.json`)

### 4.11 プロキシ (未動作)

- 設定 UI と保存 (`settings.ini` [Proxy]) 、`core-proxy` のクライアント生成 (HTTP/SOCKS5/SOCKS4) は実装済み
- **ただし `core-fetch` の HTTP クライアントがプロキシ設定を参照していないため、現バージョンでは通信に適用されない** (既知の制限・対応予定)
- プロキシパスワードは Windows では DPAPI (ユーザースコープ) で暗号化して settings.ini に保存 (`dpapi:<base64>` 形式)。旧形式の平文値も読み込み時に後方互換で受理

### 4.12 アップデートチェック

- `latest.json` (GitHub raw: `apps/landing/public/latest.json`) を取得し semver 比較
- プラットフォームキー (windows-x64 等) 別のアセット情報 (filename / sha256 / size) に対応
- バージョン情報ダイアログで自動チェック、更新があればダウンロードページを開くボタンを表示

### 4.13 ユーザー CSS (SIKI互換)

- `data/custom.css` + SIKI互換の `data/theme/` 一式 (main / light / dark / floating / mediaviewer / postform / setting.css) を起動時に読み込み、組み込みスタイルの後に `<style>` textContent として注入 (`load_theme_css` コマンド)
- floating.css は字幕ウィンドウ、mediaviewer.css は画像ポップアップに適用 (各ウィンドウが起動時に自己読み込み + `refresh_window_css` で再適用)
- postform.css / setting.css は `@scope` で書き込みパネル / 設定パネルに限定適用
- SIKI互換のクラス (`.rcon` `.rb` `.res-name` `.mark-myself` `.newly` `.bcon` `.sv__<host>` 等) と `--color-*` テーマ変数を DOM / styles.css に付与済み
- セキュリティ: ファイル名は固定ホワイトリスト、512KB/ファイル上限、`</style` 断片除去、外部 `url(http…)` は既定でブロックし `none` に置換 (設定 `App.cssAllowExternalUrls=true` で許可、ブロック時はステータスバーにホスト名を警告表示)
- ファイルが無い場合はコメントテンプレートを自動生成
- メニュー「設定 > ユーザーCSSを再読み込み」で再注入 (再起動不要)
- 詳細: `docs/CSS_CUSTOMIZE.md`

---

## 5. Tauri コマンド一覧 (86個)

### 板・スレ取得
`fetch_bbsmenu_summary` `fetch_board_categories` `fetch_thread_list` `fetch_thread_responses_command`

### 投稿
`post_reply_multisite` `create_thread_command` `debug_post_connectivity`
プローブ系: `probe_thread_post_form` `probe_post_confirm(_empty)` `probe_post_finalize_preview(_from_input)` `probe_post_finalize_submit_(empty|from_input)`
※ `debug_post_connectivity` とプローブ系は開発ビルド限定 (リリースビルドでは環境変数 `LIVEFAKE_DIAG=1` を設定した場合のみ有効)。`diagnostics_enabled` コマンドでフロントが表示制御

### 永続化
`load/save_favorites` `load/save_ng_filters` `load/save_tts_dict` `load/save_read_status` `load/save_thread_history` `set_thread_custom_title` `load/save_app_settings` (INI) `load_theme_css` `refresh_window_css` `save/load_layout_prefs` `save/load_session_tabs` `save/load_session_board_tabs` `save/load_generic_json` (ファイル名ホワイトリスト制) `load/save_external_boards` `load/save_id_highlights` `load/save_text_highlights` `load/save_proxy_settings` `load/reset_image_url_replace` `write_event_log`

### SQLite キャッシュ
`save/load/delete_thread_cache` `load_all_cached_threads`

### TTS
`sapi_list_voices` `sapi_speak_text` `sapi_stop_speech` `bouyomi_speak_text` `voicevox_get_speakers` `voicevox_speak_text` `tts_stop`

### 画像
`fetch_image` `open_image_popup` `get_image_popup_data` `remove_popup_image` `clear_popup_images` `save_image_to_folder`

### 字幕
`subtitle_show` `subtitle_hide` `subtitle_reset_position` `subtitle_update` `subtitle_opacity` `subtitle_topmost` `subtitle_font_size` `subtitle_meta_font_size` `subtitle_id_font_size` `subtitle_id_font_family`

### ウィンドウ・アプリ
`set_window_theme` `save/load_window_size` `quit_app` `open_external_url` `open_file_dialog` `open_folder_dialog` `get_data_dir` `list_system_fonts` `check_for_updates`

---

## 6. データ永続化仕様

### 6.1 保存先

- Windows: 実行時カレントディレクトリ直下の `data/` (環境変数 `EMBER_DATA_DIR` で上書き可)
- macOS / Linux: `dirs::data_dir()/LiveFake`

### 6.2 settings.ini

| セクション | キー (既定値) |
|-----------|--------------|
| [App] | maxOpenTabs=20, fontSize=14, responseGap=10, autoReloadIntervalSec=15, autoScroll=true, smoothScroll=true, logRetentionDays=7, cssAllowExternalUrls=false (実行時に autoReload, imageSaveFolder 等を追記) |
| [Speech] | mode=off, enabled=false, maxReadLength=0, sapiVoiceIndex=0, sapiRate=0, sapiVolume=100, bouyomiPath=, voicevoxEndpoint=http://127.0.0.1:50021, voicevoxSpeakerId=0, voicevoxSpeedScale=1.0, voicevoxPitchScale=0.0, voicevoxIntonationScale=1.0, voicevoxVolumeScale=1.0 |
| [Posting] | name=, mail=, sage=false, fontSize=13 (実行時に composeOpen を追記) |
| [Proxy] | (実行時追記) ProxyEnabled / ProxyType / ProxyHost / ProxyPort / ProxyUsername / ProxyPassword (DPAPI 暗号化、旧平文値も後方互換で読込可) |

### 6.3 JSON ファイル

bbs-menu.json / board-catalog.json (お気に入り) / board-categories.json / external-boards.json /
ng-settings.json / tts-dict.json / read_status.json / thread-history.json (既読数・訪問時刻・カスタムタイトル) /
layout_prefs.json / session_tabs.json / session_board_tabs.json / window_size.json /
id-highlights.json / text-highlights.json /
bookmarks.json (栞) / scroll-positions.json / name-history.json / my-posts.json /
search-history.json / thread-fetch-times.json / expanded-categories.json / board-tree-scroll.json /
new-thread-dialog-size.json

汎用 JSON (`save/load_generic_json`) はファイル名ホワイトリストで制限。

### 6.4 SQLite (`data/cache.db`)

```sql
CREATE TABLE thread_cache (
  thread_url TEXT PRIMARY KEY,
  title TEXT,
  responses_json TEXT,   -- レス配列を JSON で丸ごと保存
  updated_at INTEGER
);
```

dat 落ちスレの閲覧 (「dat落ちキャッシュ」機能) に利用。

### 6.5 その他

- `custom.css` / `theme/*.css`: ユーザー CSS (SIKI互換構成、無ければテンプレート自動生成)
- `ImageViewURLReplace.txt`: 画像 URL 置換 TSV
- `eventlog/YYYY-MM-DD.log`: `[時刻] [INFO|WARN|ERROR] メッセージ` 形式。保持日数設定で起動時 purge

### 6.6 localStorage

フロント側の一部 UI 状態は `desktop.*` プレフィックスの localStorage も併用する。

---

## 7. セキュリティ仕様

### 7.1 通信先の限定

- `is_allowed_url()` で対応ドメイン (5ch.io / 5ch.net / 2ch.net / jbbs.shitaraba.net / bbs.jpnkn.com) に限定
- 投稿 URL は 5ch ドメインを限定検証

### 7.2 CSP

```
default-src 'self' 'unsafe-inline' 'unsafe-eval';
img-src 'self' https: http: data: blob:;
style-src 'self' 'unsafe-inline';
script-src 'self' 'unsafe-inline' 'unsafe-eval';
connect-src 'self' https: http: ws: wss:
```

### 7.3 HTML サニタイズ

- レス本文は `renderResponseBody()` でサニタイズしてから `dangerouslySetInnerHTML` に渡す
- HTML 属性内 URL は `escapeAttr()` でエスケープ
- `normalizeExternalUrl()` が `javascript:` / `data:` / `blob:` スキームをブロック

### 7.4 Cookie・認証情報

- Cookie 値 (Be3M / Be3D / sid) は DEBUG 以上のログに記録しない
- プロキシパスワードは settings.ini に平文保存 (現状の制限)

### 7.5 外部プロセス連携

- 棒読みちゃん (RemoteTalk.exe): 引数のヌルバイト除去・2000文字制限によるコマンドインジェクション対策

### 7.6 その他

- 二重起動防止 (single instance)
- メインウィンドウ破棄時に字幕・画像ポップアップウィンドウも閉じる

---

## 8. UI レイアウト

- メインウィンドウ初期サイズ 1400×900 (リサイズ可、終了時サイズ保存)
- 3ペイン構成 (板一覧 / スレ一覧 / レス表示) + 新着ペイン + 書き込みウィンドウ
- 全スプリッターはドラッグリサイズ+永続化。「レイアウトリセット」あり
- ダークモード: ルート要素 `.shell` に `.dark` クラス + OS ウィンドウテーマ連動 (`set_window_theme`)
- スタイルは `styles.css` 単一ファイル + ユーザー CSS (`custom.css`)

---

## 9. 関連ドキュメント

| ファイル | 内容 |
|---------|------|
| `README.md` | プロジェクト概要 |
| `REQUIREMENTS.md` | 機能要件定義書 |
| `docs/USER_MANUAL.md` | ユーザー向け説明書 |
| `docs/CSS_CUSTOMIZE.md` | CSS カスタマイズガイド |
