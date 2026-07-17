# CSS カスタマイズガイド

LiveFake は UI の見た目をユーザー自身が CSS で自由にカスタマイズできます。
このガイドでは、カスタム CSS の仕組み・書き方・主要な UI 要素のクラスリファレンス・実用レシピを解説します。

---

## 1. 仕組み

### 1.1 カスタム CSS ファイル一覧

- EXE と同じフォルダの **`data/custom.css`** がメインのカスタム CSS ファイルです
- アプリ起動時に自動で読み込まれ、**標準スタイルの後**に適用されます
  （同じ詳細度のセレクタならユーザー CSS が優先されます）
- 初回起動時、コメントで書き方の説明が入ったテンプレートが自動生成されます

さらに、汎用掲示板ブラウザ **SIKI と同じファイル構成**の `data/theme/` フォルダにも対応しています。
SIKI のカスタム CSS の知識・レシピをほぼそのまま流用できます（→ [6. SIKI 互換カスタマイズ](#6-siki-互換カスタマイズ)）。

| ファイル (`data/theme/`) | 適用先 | SIKI での対応ファイル |
|---|---|---|
| `main.css` | メインウィンドウ全体（全テーマ共通） | `theme\main.css` |
| `light.css` | ライトモード時のみ | `_default_.theme\user.css` 相当 |
| `dark.css` | ダークモード時のみ | ダーク系テーマの `user.css` 相当 |
| `floating.css` | 字幕ウィンドウ | `floating.css`（実況ウィンドウ） |
| `mediaviewer.css` | 画像ポップアップウィンドウ | `mediaviewer.css` |
| `postform.css` | 書き込みパネル（`@scope` で書き込み欄に限定適用） | `postform.css` |
| `setting.css` | 設定パネル（同上） | `setting.css` |

適用順（後勝ち）: 標準スタイル → `custom.css` → `main.css` → `light.css`/`dark.css` → `postform.css`/`setting.css`

### 1.2 反映方法

| タイミング | 操作 |
|-----------|------|
| 起動時 | 自動で読み込まれる |
| 編集後すぐ | メニュー **「設定 > ユーザーCSSを再読み込み」** — 再起動不要 |

再読み込みの成否はステータスバーに表示されます。

### 1.3 制約とセキュリティ

- `@import url(...)` や外部 CSS・外部フォントの読み込みは CSP により**ブロックされます**
- **`url(http://…)` / `url(https://…)` による外部サーバーへの画像参照は、既定で無効化されます**
  （該当の `url(...)` は `none` に置換され、ブロックしたホスト名がステータスバーに表示されます）。
  どうしても必要な場合は設定「カスタムCSSの外部URL参照を許可」をオンにできますが、**非推奨**です
- `url(data:image/png;base64,…)` 形式（画像データの直接埋め込み）は通信が発生しないため**常に使えます**。
  手元の画像を使いたい場合は data: URI に変換して埋め込んでください
- 1 ファイルあたりのサイズ上限は 512KB です（超過したファイルは読み込まれません）
- CSS の文法エラーがあっても起動は失敗しません（エラー行以降のルールが無視されるだけです）

> ⚠️ **ネット上で配布されている CSS を貼り付ける際の注意**
> CSS には JavaScript を使わずに、外部サーバーへの画像読み込みを利用して
> 「誰が・いつ・何を表示しているか」を送信させる既知の手法があります。
> 外部 URL ブロックが既定で有効なのはこの対策です。出所の分からない CSS に
> `url(http…)` が含まれていた場合は、その部分を削除して使ってください。

---

## 2. 基本: CSS 変数で全体の配色を変える

LiveFake の配色は 6 つの CSS 変数で構成されており、これを上書きするだけで全体のテーマが変わります。

### 2.1 変数一覧

| 変数 | 役割 | ライト初期値 | ダーク初期値 |
|------|------|------------|------------|
| `--bg` | 全体の背景色（body・新着ペイン） | `#f0f0f0` | `#1e1e1e` |
| `--panel` | パネル背景色（3ペイン・アクティブタブ） | `#ffffff` | `#252526` |
| `--line` | 罫線・境界線の色 | `#c0c0c0` | `#3c3c3c` |
| `--ink` | 基本文字色 | `#1b1b1b` | `#d4d4d4` |
| `--sub` | 補助文字色（メタ情報・日付等） | `#555555` | `#9e9e9e` |
| `--accent` | アクセント色（リンク・強調） | `#0066cc` | `#4da6ff` |
| `--bg-light` | ダークモード専用の明るめ背景 | — | `#2d2d30` |

### 2.2 ライトモードの配色を変える

```css
:root {
  --bg: #f4ecd8;      /* セピア調の背景 */
  --panel: #fbf5e6;
  --ink: #4a3f2a;
}
```

### 2.3 ダークモードの配色を変える

ダークモードは、アプリのルート要素（`.shell`）に `.dark` クラスが付くことで切り替わります。
ダークモード時の変数は `.dark { ... }` で上書きします。

```css
.dark {
  --bg: #10141c;      /* より深い青系ダーク */
  --panel: #1a2030;
  --accent: #6ab0ff;
}
```

> ⚠️ `:root.dark` や `html.dark` では効きません。`.dark` は `<html>` ではなく
> アプリのルート `<div class="shell">` に付与されるためです。

---

## 3. UI 要素クラスリファレンス

ピンポイントで特定の要素だけを変えたい場合は、以下のクラスを直接指定します。

### 3.1 画面の大枠

| クラス | 要素 |
|--------|------|
| `.shell` | アプリ全体のルート（`.dark` が付く要素） |
| `.menu-bar` / `.menu-item` / `.menu-dropdown` | メニューバー / 各メニュー / ドロップダウン |
| `.tool-bar` / `.address-input` | ツールバー / アドレス入力欄 |
| `.board-button-bar` / `.board-btn` | お気に入り板ボタンバー |
| `.status-bar` | 最下部のステータスバー |
| `.pane` | 3ペイン共通（下記と組み合わせ） |
| `.pane.boards` | 板一覧ペイン（左） |
| `.pane.threads` | スレッド一覧ペイン |
| `.pane.responses` | レス表示ペイン |
| `.pane-splitter` | ペイン境界のリサイザー |

### 3.2 板一覧ペイン

| クラス | 要素 |
|--------|------|
| `.board-tree` | 板ツリー全体 |
| `.board-category` / `.category-toggle` | カテゴリ / 開閉ボタン |
| `.board-item` | 板 1 件 |
| `.board-search` / `.fav-search` | 板検索欄 / お気に入り検索欄 |
| `.fav-threads-list` / `.fav-star` | お気に入りスレ一覧 / ★マーク |

### 3.3 タブ

| クラス | 要素 |
|--------|------|
| `.board-tab-bar` / `.board-tab` / `.board-tab.active` | 板タブバー / 板タブ / アクティブ板タブ |
| `.thread-tab-bar` / `.thread-tab` / `.thread-tab.active` | スレタブバー / スレタブ / アクティブスレタブ |
| `.thread-tab-title` / `.thread-tab-close` / `.tab-res-count` | タブのタイトル / ×ボタン / レス数バッジ |

### 3.4 スレッド一覧

| クラス | 要素 |
|--------|------|
| `.threads-toolbar` / `.thread-search` | スレ一覧ツールバー / スレ検索欄 |
| `.threads-table-wrap` | スレ一覧テーブルのスクロール領域 |
| `.sortable-th` | ソート可能な列見出し |
| `.thread-title-cell` | スレタイトルのセル |
| `.unread-row` / `.has-unread-row` | 未読スレ / 未読レスありスレの行 |
| `.dat-ochi-row` | dat 落ちスレの行 |
| `.speed-bar` / `.speed-cell` | 勢いバー / 勢いのセル |

### 3.5 レス表示（1 レスの構造）

レス 1 件は以下の入れ子構造です。

```text
.response-block            ← レス1件の外枠
│   （状態クラス: .selected 選択中 / .my-post 自分の投稿 / .reply-to-me 自分宛）
├─ .response-header        ← ヘッダー行
│   ├─ .response-no            レス番号
│   ├─ .my-post-label          [自分] ラベル
│   ├─ .reply-to-me-label      [自分宛] ラベル
│   ├─ .response-name          投稿者名
│   ├─ .response-mail          [メール欄]（sage は .response-mail-sage）
│   ├─ .response-watchoi       (ワッチョイ)
│   ├─ .back-ref-trigger       ▼N 被参照数
│   └─ .response-header-right  ← ヘッダー右側
│       ├─ .response-new-marker    New! マーカー
│       ├─ .response-date          日付
│       ├─ .response-id-cell       ID:xxxx
│       ├─ .response-id-count      (n/総数) ID出現回数
│       └─ .response-be-link       BE:xxxx
└─ .response-body          ← 本文（AA 表示時は .aa が付く）
```

その他のレスペイン要素:

| クラス | 要素 |
|--------|------|
| `.response-scroll` | レスのスクロール領域 |
| `.thread-title-bar` | スレタイトルバー |
| `.response-search-bar` | スレ内検索バー |
| `.response-nav-bar` | 下部ナビバー（着数・Top/New/Last ボタン） |
| `.anchor-ref` | 本文中の `>>N` アンカーリンク |
| `.body-link` | 本文中の URL リンク |
| `.response-thumb` / `.response-thumbs-row` | 画像サムネイル / サムネイル行 |

### 3.6 ポップアップ・メニュー

| クラス | 要素 |
|--------|------|
| `.anchor-popup` / `.anchor-popup-header` / `.anchor-popup-body` | アンカーポップアップ |
| `.id-popup` / `.id-popup-item` | ID ポップアップ（同一 ID レス一覧） |
| `.back-ref-popup` | 被参照ポップアップ |
| `.thread-menu` | 右クリックメニュー全般 |
| `.hover-preview` | 画像ホバープレビュー |
| `.lightbox-overlay` | 画像ライトボックス |

### 3.7 新着レスペイン

| クラス | 要素 |
|--------|------|
| `.new-arrival-pane` | 新着ペイン全体 |
| `.new-arrival-header` / `.new-arrival-title` | ヘッダー / タイトル |
| `.new-arrival-item` | 新着レス 1 件 |
| `.new-arrival-meta` / `.new-arrival-res-no` / `.new-arrival-name` / `.new-arrival-time` / `.new-arrival-id` | メタ情報（レス番号・名前・時刻・ID） |
| `.new-arrival-thread-title` | スレタイトル表示 |
| `.new-arrival-body` | 本文 |

### 3.8 書き込みウィンドウ

| クラス | 要素 |
|--------|------|
| `.compose-window` | 書き込みウィンドウ全体（表示中は `.compose-window--open`） |
| `.compose-header` / `.compose-target` | ヘッダー / 書き込み先表示 |
| `.compose-input` / `.compose-body` | 名前・メール入力欄 / 本文入力欄 |
| `.compose-preview` | プレビュー表示 |
| `.compose-result-ok` / `.compose-result-err` | 投稿結果（成功 / 失敗） |

### 3.9 設定パネル

| クラス | 要素 |
|--------|------|
| `.settings-panel` | 設定パネル本体 |
| `.settings-nav` / `.settings-nav-item` | 左側ナビ / ナビ項目 |
| `.settings-row` | 設定 1 行 |

---

## 4. レシピ集

### 4.1 レス本文の行間・余白を広げる

```css
.response-body { line-height: 1.8; }
.response-block { padding: 6px 8px; }
```

### 4.2 選択中のレスを目立たせる

```css
.response-block.selected {
  background: #fff3c4;
  border-left: 3px solid #e6a700;
}
.dark .response-block.selected {
  background: #3a3520;
}
```

### 4.3 自分の投稿・自分宛レスの色を変える

```css
.response-block.my-post   { background: #e8f4e8; }
.response-block.reply-to-me { background: #fde8e8; }
```

### 4.4 レス番号・名前欄の色を変える

```css
.response-no   { color: #cc4400; font-weight: bold; }
.response-name { color: #227722; }
```

### 4.5 sage を薄く表示する

```css
.response-mail-sage { opacity: 0.4; }
```

### 4.6 新着ペインを大きな文字のシアター風にする

```css
.new-arrival-pane { background: #000; }
.new-arrival-body { color: #fff; text-shadow: 0 0 4px rgba(255,255,255,0.3); }
.new-arrival-meta { opacity: 0.6; }
```

### 4.7 タブを角丸にする

```css
.thread-tab, .board-tab {
  border-radius: 6px 6px 0 0;
  margin-right: 2px;
}
```

### 4.8 スクロールバーの見た目を変える

```css
.response-scroll::-webkit-scrollbar { width: 10px; }
.response-scroll::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: 5px;
}
```

### 4.9 未読スレ行を強調する

```css
.has-unread-row .thread-title-cell { font-weight: bold; color: var(--accent); }
```

### 4.10 メニューバー・ステータスバーを隠してミニマルにする

```css
.status-bar { display: none; }
```

> メニューバーを消すと設定にアクセスできなくなるため非推奨です。

---

## 5. 注意事項

### 5.1 設定画面と重複する項目

フォントの種類・サイズ・レス間隔・各ペインの文字サイズなどは**設定パネルから変更でき、
インラインスタイル（CSS より優先）で適用されます**。これらは custom.css ではなく
設定画面から変更してください。CSS で無理に上書きするには `!important` が必要になり、
設定画面の操作と競合します。

同様に、ID ハイライト色・テキストハイライト色は機能側（右クリックメニューの 15 色パレット）で
管理されているため、CSS での上書きは推奨しません。

### 5.2 クラス名の互換性

クラス名はアプリのバージョンアップで変更・追加・削除されることがあります。
更新後に見た目が崩れた場合は custom.css の該当ルールを見直してください。

### 5.3 元に戻したいとき

`data/custom.css`（および `data/theme/` 内の各ファイル）の中身をすべて削除
（またはファイル自体を削除）して「設定 > ユーザーCSSを再読み込み」を実行すれば
標準の見た目に戻ります。ファイルを削除した場合は次回起動時にテンプレートが再生成されます。

---

## 6. SIKI 互換カスタマイズ

汎用掲示板ブラウザ [SIKI](https://wikiwiki.jp/siki-app/カスタムCSS) のカスタム CSS と
**同じセレクタ・変数名**を使えるようにしています。SIKI の wiki のレシピの多くが
そのまま、または少しの修正で動きます。

### 6.1 SIKI 互換セレクタ対応表

| SIKI のセレクタ | 意味 | LiveFake での付与先 |
|---|---|---|
| `.rcon` | レス全体 | `.response-block` と同じ要素 |
| `.rh` | レスヘッダー行 | `.response-header` と同じ要素 |
| `.rb` | レス本文 | `.response-body` と同じ要素 |
| `.res-num` | レス番号 | `.response-no` と同じ要素 |
| `.res-name` / `.mname` | 名前欄 | `.response-name` と同じ要素 |
| `.res-mail` | メール欄 | `.response-mail` と同じ要素 |
| `.sage` | sage のメール欄 | メール欄が sage のとき付与 |
| `.res-date` | 日時 | `.response-date` と同じ要素 |
| `.rc-id` | ID 表示 | `.response-id-cell` と同じ要素 |
| `.mark-myself` | 自分のレス | `.my-post` と同時に付与 |
| `.mark-anchor` | 自分への返信 | `.reply-to-me` と同時に付与 |
| `.newly` | 新着レス | 新着範囲のレスに付与 |
| `.aa` | AA 判定されたレス | レス全体と本文の両方に付与（`.aa .rb` が使える） |
| `.th-container` | レス表示のスクロールコンテナ | `.response-scroll` と同じ要素 |
| `#threadPane` | スレ表示ペイン | レスペイン（`.pane.responses`） |
| `#boardPane` | スレ一覧ペイン | スレ一覧ペイン（`.pane.threads`） |
| `.bcon` / `.bcon.odd` / `.bcon.cursor` | スレ一覧の行 / 偶数行 / 選択行 | スレ一覧テーブルの `<tr>` |
| `.thread-tabs .tab` / `.tab.active` | スレタブ | `.thread-tab` と同じ要素 |
| `.thread-tabs .title` | スレタブのタイトル | `.thread-tab-title` と同じ要素 |
| `.board-tabs .tab` | 板タブ | `.board-tab` と同じ要素 |
| `.popupfield` | ポップアップコンテナ | ID・アンカー・逆参照ポップアップの根本 |
| `.popup-main` | ポップアップ本体 | ポップアップ内のレス表示部 |
| `.postform` | 書き込み欄 | `.compose-window` と同じ要素 |
| `.postform-foot` / `.postform-write` | 書き込み欄のフッター / 書き込みボタン | 送信ボタン行 / 送信ボタン |
| `.sv__<ホスト名>` | サイト・板別の条件スタイル | レスペインに付与（例: `.sv__jbbs_shitaraba_net`。ホスト名の記号は `_` に変換） |

SIKI と DOM 構造そのものは異なるため、`order` による並べ替えなど構造依存のレシピは
調整が必要な場合があります。要素の実際の構造は本ガイドの 3 章を参照してください。

### 6.2 SIKI 互換 CSS 変数

SIKI 0.27.0 以降と同名のテーマ変数を定義しており、上書きするとアプリ側の該当箇所に反映されます。

```
--color-boardTab-activeBackground      板タブ (アクティブ) の背景
--color-boardTab-inactiveBackground    板タブ (非アクティブ) の背景
--color-threadTab-activeBackground     スレタブ (アクティブ) の背景
--color-threadTab-inactiveBackground   スレタブ (非アクティブ) の背景
--color-thread-searchHighlightBackground  スレ内検索ヒットの背景
--color-thread-resMyselfBackground     自分のレスの背景
--color-board-background               スレ一覧の背景
--color-board-cursorBackground         スレ一覧の選択行の背景
--color-board-highlightBackground      スレ一覧の縞模様 (偶数行) の背景
```

使用例（SIKI wiki のレシピがそのまま動きます）:

```css
/* 自分のレスの背景色 */
.mark-myself {
  --color-thread-resMyselfBackground: yellow;
}

/* アクティブなスレタブの背景 */
#threadPane .tab {
  background-color: var(--color-threadTab-activeBackground);
}
```

ダークモード側だけ変えたい場合は `dark.css` に書くか、`.dark { --color-…: …; }` で上書きします。

### 6.3 使えるモダン CSS

WebView2 (Chromium) ベースのため、SIKI の高度なレシピで使われる以下がすべて動作します:

- `:has()` / `:not()` — 条件付きスタイル（例: `#threadPane .rh:has(.res-mail:not(:empty)) .res-name { color: blue; }`）
- `color-mix()` / `linear-gradient()`
- CSS ネスト（`& span { … }` 記法）
- `@scope`

### 6.4 SIKI との違い

| 項目 | SIKI | LiveFake |
|---|---|---|
| 反映方法 | 再起動が必要 | メニュー「設定 > ユーザーCSSを再読み込み」で**再起動不要** |
| テーマ別 CSS | `.theme` フォルダごと | `light.css` / `dark.css` の 2 ファイル |
| ダークモードの起点 | テーマによる | `.shell` 要素の `.dark` クラス |
| 外部 URL 画像 | 制限なし | **既定でブロック**（設定で許可可、1.3 参照） |
| 開発者ツール (Ctrl+Shift+I) | 常時使用可 | 開発ビルドのみ（本ガイドのクラスリファレンスを参照してください） |
