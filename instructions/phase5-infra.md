# Phase 5: インフラ・セキュリティ

REQUIREMENTS.md の §5.2, §11, §12, §4 を参照。

## 5-1. プロキシ（core-proxy crate 新規作成）

### crate 構成
```
crates/core-proxy/
├── Cargo.toml
└── src/
    └── lib.rs
```

### 対応タイプ（REQUIREMENTS §11.3）
- HTTP プロキシ
- SOCKS5 プロキシ
- SOCKS4 プロキシ

### 実装方針
- reqwest の `Proxy` を使用してクライアントを構築
- 設定変更時に新しい reqwest::Client を再構築
- core-fetch の既存クライアント生成を proxy 設定対応に拡張

### Tauri コマンド
- `load_proxy_settings` → INI [Proxy] セクションから読み込み（パスワードは復号済み）
- `save_proxy_settings` → INI に保存（パスワードは DPAPI 暗号化）

### 設定値
```ini
[Proxy]
ProxyEnabled=false
ProxyType=http
ProxyHost=
ProxyPort=
ProxyUsername=
ProxyPassword=DPAPI:base64...
```

---

## 5-2. DPAPI 暗号化（Windows）

### 実装箇所
- `crates/core-proxy/src/lib.rs` または独立モジュール

### 仕様（REQUIREMENTS §11.1）
- Windows: `CryptProtectData` / `CryptUnprotectData` 使用
- 保存形式: `DPAPI:` + Base64(暗号化バイト)
- `DPAPI:` プレフィックスなし = 平文（旧バージョン互換）
- 非Windows: 平文のまま保存（後方互換性）

### 依存
```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
    "Win32_Security_Cryptography",
    "Win32_Foundation"
]}
base64 = "0.22"
```

---

## 5-3. ImageViewURLReplace エンジン

### 実装箇所
- Rust バックエンド: ルールファイル読み込み + URL変換ロジック
- Tauri コマンド: `load_image_url_replace`, `reset_image_url_replace`, `open_image_url_replace_file`

### ルールファイル（REQUIREMENTS §5.2）
- ファイル: `ImageViewURLReplace.txt`
- フォーマット: TSV（タブ区切り）
  ```
  検索正規表現<TAB>置換文字列<TAB>リファラ（省略可）
  ```
- `#` で始まる行はコメント
- 空行は無視

### デフォルトルール
```
# Twitter/X 画像URL正規化
^https?://pbs\.twimg\.com/media/([^?]+)\?format=(\w+)&name=.*	https://pbs.twimg.com/media/$1?format=$2&name=orig
^https?://pbs\.twimg\.com/media/([^?:]+)(?::(\w+))?$	https://pbs.twimg.com/media/$1?format=jpg&name=orig

# ニコニコ動画サムネイル
^https?://(?:www\.)?nicovideo\.jp/watch/sm(\d+)	https://nicovideo.cdn.nimg.jp/thumbnails/$1/$1
```

### 画像取得時の適用
- `fetch_image` コマンド内で URL 変換を適用
- リファラ指定がある場合は Referer ヘッダを付与

---

## 5-4. Cookie 永続化

### 仕様（REQUIREMENTS §4）
- ファイル: `cookies.json`

```json
{
  "version": 1,
  "cookies": [
    {
      "name": "MonaTicket",
      "value": "xxxx",
      "domain": "eagle.5ch.io",
      "expires_unix": 1780000000,
      "issued_user_agent": "Mozilla/5.0 ..."
    }
  ]
}
```

### 実装方針
- 既存の書き込みCookie管理を拡張
- Set-Cookie ヘッダ自動解析（expires / max-age 形式対応）
- 有効期限切れ Cookie の自動フィルタリング
- 5ch系: UA不一致の Cookie をフィルタリング
- MonaTicket 失敗時: 自動削除 → 1回のみ再取得試行
- したらば / JPNKN 用の Cookie も同ファイルで管理
