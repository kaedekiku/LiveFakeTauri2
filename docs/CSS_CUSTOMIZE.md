# CSS カスタマイズガイド

LiveFake は UI の見た目をユーザー自身が CSS で自由にカスタマイズできます。
このガイドでは、カスタム CSS の仕組み・書き方・主要な UI 要素のクラスリファレンス・実用レシピを解説します。

---

## 1. 仕組み

### 1.1 custom.css とは

- EXE と同じフォルダの **`data/custom.css`** がカスタム CSS ファイルです
- アプリ起動時に自動で読み込まれ、**標準スタイルの後**に適用されます
  （同じ詳細度のセレクタならユーザー CSS が優先されます）
- 初回起動時、コメントで書き方の説明が入ったテンプレートが自動生成されます

### 1.2 反映方法

| タイミング | 操作 |
|-----------|------|
| 起動時 | 自動で読み込まれる |
| 編集後すぐ | メニュー **「設定 > ユーザーCSSを再読み込み」** — 再起動不要 |

再読み込みの成否はステータスバーに表示されます。

### 1.3 制約

- `@import url(...)` や外部 CSS・外部フォントの読み込みは CSP により**ブロックされます**
  （`background-image: url(https://...)` の画像参照は可能です）
- CSS の文法エラーがあっても起動は失敗しません（エラー行以降のルールが無視されるだけです）

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

`data/custom.css` の中身をすべて削除（またはファイル自体を削除）して
「設定 > ユーザーCSSを再読み込み」を実行すれば標準の見た目に戻ります。
ファイルを削除した場合は次回起動時にテンプレートが再生成されます。
