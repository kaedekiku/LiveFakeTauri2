# Phase 3: 実況向け機能

REQUIREMENTS.md の §6, §10 を参照。

## 3-1. 新着レス専用ペイン

### 仕様（REQUIREMENTS §1.1）
- メインコンテンツエリアの下部に配置
- 上下ドラッグで高さ変更可能（80〜420px、デフォルト150px）
- 最新のレスをリアルタイム表示（新着取得のたびに更新）
- 表示要素: スレッドタイトル / レス番号・名前・ID・日時 / 本文

### 実装箇所
- `apps/desktop/src/App.tsx` にペインコンポーネントを追加
- `apps/desktop/src/styles.css` にスタイル追加
- リサイザーは既存の板/スレ分割と同様のドラッグ実装を流用

---

## 3-2. 字幕ポップアップウィンドウ

### 仕様（REQUIREMENTS §6）
- 別ウィンドウ（Tauri WebviewWindow）で実装
- 背景: `rgba(26, 26, 46, opacity)` デフォルト濃紺
- テキスト色: `#ffffff`
- フォント: MS UI Gothic, Meiryo, 絵文字対応
- ドラッグ移動可能（`data-tauri-drag-region`）
- decorations なし、透過対応

### 表示要素
- メタ行: スレッドタイトル / 投稿者名 / ID（色付き） / 日時（小フォント 8〜48px、デフォルト12px）
- 本文: 大フォント（10〜96px、デフォルト28px）、テキストハイライト付き

### 制御
- Show/Hide トグル（ツールバーボタン）
- 背景透明度: 0.1〜1.0（リアルタイム変更）
- Always on Top: トグル可能
- フォントサイズ: 設定から変更

### Tauri コマンド
- `subtitle_show` / `subtitle_hide` / `subtitle_update`
- `subtitle_opacity` / `subtitle_topmost` / `subtitle_font_size` / `subtitle_meta_font_size`

### 実装方針
- `apps/desktop/src/subtitle.html` + `apps/desktop/src/subtitle.tsx` を新規作成
- メインウィンドウからは Tauri event でデータを送信
- XSS防止: eval() は使わず、Tauri event リスナーでデータ受信

---

## 3-3. 音声読み上げ（core-tts crate 新規作成）

### crate 構成
```
crates/core-tts/
├── Cargo.toml
└── src/
    └── lib.rs
```

### Cargo.toml 依存
```toml
[dependencies]
reqwest = { version = "0.12", features = ["json"] }
rodio = "0.19"           # VOICEVOX WAV再生
thiserror = "2"

[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
    "Win32_Media_Speech",
    "Win32_System_Com",
    "Win32_Foundation"
]}
```

### SAPI（REQUIREMENTS §10.1）
- `#[cfg(target_os = "windows")]` で条件コンパイル
- COM初期化は STA スレッドで実行（`tokio::task::spawn_blocking` + `CoInitializeEx(COINIT_APARTMENTTHREADED)`）
- 音声一覧取得: `sapi_list_voices() -> Vec<VoiceInfo>`
- 読み上げ: `sapi_speak(text, voice_index, rate, volume)`

### 棒読みちゃん（REQUIREMENTS §10.2）
- RemoteTalk.exe をプロセス起動: `/Talk <text> <speed> <tone> <volume> <voice>`
- セキュリティ: ヌルバイト除去、2000文字制限、ファイル名が RemoteTalk.exe であることを検証

### VOICEVOX（REQUIREMENTS §10.3）
- HTTP API: `audio_query` → `synthesis` → rodio で WAV 再生
- スピーカー一覧取得: GET `/speakers`
- 音声合成: POST `/audio_query` → POST `/synthesis`

### Tauri コマンド
- `sapi_list_voices`, `sapi_speak_text`
- `bouyomi_speak_text`
- `voicevox_get_speakers`, `voicevox_speak_text`

### フロントエンド
- 設定パネルに「音声」タブを追加
- モード切替: SAPI / 棒読みちゃん / VOICEVOX
- 新着レス受信時に自動読み上げ（Speech.enabled が true の場合）

### 読み上げ省略（REQUIREMENTS §10.4）
- `Speech.maxReadLength` 設定: 10〜300文字、または 0（無制限）
- デフォルト: 0（無制限）
- 指定文字数を超えるレスは指定文字数まで読み上げて残りを省略
- 設定UIにスライダーまたは数値入力 + 「無制限」チェックボックスを追加

### レス番号右クリック読み上げ（REQUIREMENTS §10.5）
- レス番号要素に `.res-number` クラスを付与
- 右クリックメニューに「このレスから読み上げ」を表示（Phase 4 のコンテキストメニューと統合）
- 実装: 現在の読み上げを即座に停止（SAPI: `ISpVoice::Speak` に `SPF_PURGEBEFORESPEAK` / VOICEVOX: rodio の Sink を stop）し、指定レス番号から順番にキューに入れて読み上げ開始
- 読み上げキュー: `Vec<Response>` で管理、1レス読み上げ完了後に次のレスへ
- NG非表示レスはスキップ
