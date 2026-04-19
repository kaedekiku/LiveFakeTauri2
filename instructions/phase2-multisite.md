# Phase 2: マルチサイト対応

REQUIREMENTS.md の §2.1.2, §2.1.3, §2.2, §3.3.2, §3.3.3 を参照。

## 2-1. core-parse にしたらばパーサー追加

### 実装箇所
- `crates/core-parse/src/lib.rs` に以下を追加:
  - `parse_shitaraba_thread_list(body: &[u8]) -> Vec<ThreadEntry>` — subject.txt パース（EUC-JP）
  - `parse_shitaraba_responses(body: &[u8]) -> Vec<Response>` — レスHTML解析（DT/DDタグペア）
  - `detect_encoding(body: &[u8]) -> &str` — UTF-8 / Shift_JIS / EUC-JP 自動判定

### したらばレス形式
```html
<dt>1 名前：<font color="green"><b>名前</b></font>：2026/04/01(火) 12:00:00 ID:abcdef0</dt>
<dd>本文テキスト<br><br></dd>
```

### エンコーディング自動検出（REQUIREMENTS §2.2）
- UTF-8 / Shift_JIS / EUC-JP の3候補を試行
- スコアリング: 置換文字(U+FFFD) × -10 / 日本語含有 +20 / `<>` 含有 +5
- 最高スコアのエンコーディングを採用
- 依存: `encoding_rs` crate（core-parse は外部依存なしの方針だが、encoding_rs は MIT なので例外的に追加可）

### テスト
- したらばのサンプル HTML をテストデータとして用意
- `cargo test -p core-parse` で動作確認

---

## 2-2. core-fetch にしたらばフェッチャー追加

### 実装箇所
- `crates/core-fetch/src/lib.rs` に以下を追加:
  - `fetch_shitaraba_thread_list(category: &str, board_id: &str) -> Result<Vec<ThreadEntry>>`
  - `fetch_shitaraba_responses(category: &str, board_id: &str, thread_key: &str) -> Result<Vec<Response>>`

### URL パターン
- スレッド一覧: `https://jbbs.shitaraba.net/{category}/{board_id}/subject.txt`
- レス取得: `https://jbbs.shitaraba.net/bbs/rawmode.cgi/{category}/{board_id}/{thread_key}/`

---

## 2-3 / 2-4. JPNKN パーサー＋フェッチャー追加

### URL パターン
- スレッド一覧: `https://bbs.jpnkn.com/{board}/subject.txt`
- レス取得: `https://bbs.jpnkn.com/{board}/dat/{thread_key}.dat`
- エンコーディング: Shift_JIS
- dat形式は5chと同一フォーマット（既存パーサーを流用可能）

---

## 2-5. フロントエンドURL判定・表示統合

### 実装箇所
- `apps/desktop/src/App.tsx` に URL 判定関数を追加:

```typescript
type SiteType = 'fivech' | 'shitaraba' | 'jpnkn';

function detectSiteType(url: string): SiteType | null {
  if (/\.(5ch\.io|5ch\.net|2ch\.net)/.test(url)) return 'fivech';
  if (/jbbs\.shitaraba\.net/.test(url)) return 'shitaraba';
  if (/bbs\.jpnkn\.com/.test(url)) return 'jpnkn';
  return null;
}
```

- Tauri invoke 呼び出しを siteType に応じて分岐
- レス表示は共通の Response 型で統一（パーサー側で吸収済み）

---

## 2-6. したらば / JPNKN 書き込み機能

### したらば（REQUIREMENTS §3.3.2）
- 送信先: `https://jbbs.shitaraba.net/bbs/write.cgi`
- エンコーディング: EUC-JP URL エンコード
- Referer ヘッダ必須
- 成功判定: `write_done.cgi` リダイレクト or 「書き込みが完了しました」テキスト

### JPNKN（REQUIREMENTS §3.3.3）
- 送信先: `https://bbs.jpnkn.com/test/bbs.cgi`
- エンコーディング: Shift_JIS URL エンコード
- 5ch互換フォーム形式

### 実装箇所
- `crates/core-fetch/src/lib.rs` に `post_shitaraba_reply`, `post_jpnkn_reply` 等を追加
- Tauri コマンド: 既存の `post_reply` を siteType 引数で分岐させるか、サイト別コマンドを追加
