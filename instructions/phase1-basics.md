# Phase 1: 基盤調整

REQUIREMENTS.md の §2.6, §2.7, §8 を参照。

## 1-1. 自動更新の間隔を可変にする

現状: 60秒固定（既存）
目標: 15〜300秒の範囲で設定可能にする

### 実装箇所
- フロントエンド: `apps/desktop/src/App.tsx` の自動更新ロジック
- 設定UI: 設定パネルにスライダーまたは数値入力を追加
- 永続化: localStorage の `desktop.autoReloadInterval` キーに保存（後のPhaseでINI移行）

### 仕様
- デフォルト: 15秒
- 範囲: 15〜300秒（15秒刻み推奨）
- 設定変更は即時反映（タイマーリセット）

---

## 1-2. 自動スクロール ON/OFF

現状: 未実装
目標: 新着レス取得時に自動スクロールする機能を追加し、ON/OFF可能にする

### 実装箇所
- フロントエンド: レス取得後のスクロール処理に条件分岐を追加
- 永続化: `desktop.autoScroll` キー（デフォルト: true）

### 仕様
- ON: 新着レス取得後、最下部に自動スクロール
- OFF: スクロール位置を維持
- 設定パネルにチェックボックスを追加

---

## 1-3. Portable INI 設定の基盤作成

現状: localStorage + JSON/SQLite で設定管理
目標: INI ファイルベースの設定管理基盤を作る（段階的移行の第一歩）

### 実装箇所
- Rust: `crates/core-store/src/lib.rs` に INI 読み書き関数を追加
- Tauri コマンド: `load_app_settings`, `save_app_settings`

### INI 構造（初期）
```ini
[App]
maxOpenTabs=20
fontSize=14
responseGap=10
autoReloadIntervalSec=15
autoScroll=true
smoothScroll=true
```

### 方針
- INI パーサーは外部クレートを使わず自前で実装（GPL回避のため軽量に）
- ファイルパス: EXE と同じディレクトリの `settings.ini`
- ファイルが存在しない場合はデフォルト値で新規作成
- 読み込みは起動時 + 設定変更時にディスクから毎回読む
