# 更新履歴 (CHANGELOG)

リリース済みバージョンの更新内容です。次のリリースに向けた変更点は [NEW.md](NEW.md) に書き、リリース時にここへ転記します。

## v0.0.108 (2026/09/21)

## 新機能

- NG に「画像NG」カテゴリを追加しました。指定した単語を本文に含むレスの画像だけを
  非表示にする専用のカテゴリで、設定パネルの NG タブに節タブとして追加されています
  (先頭に機能の説明を表示)

## 変更

- 「画像のみ非表示」モードをワード/ID/名前/メールから切り離し、上記の「画像NG」
  カテゴリに一本化しました (既存の登録内容が変わることはありません)
- 設定パネルの NG タブで、節タブ(ワード/ID/名前/メール/スレタイ/画像NG)ごとの
  追加フォームから「種類」を選ぶプルダウンを廃止しました。節タブを開いている時点で
  種類は決まっているため、その種類で固定して追加されます
- ワード節タブのみ、追加フォームに「通常/正規表現」の入力形式プルダウンを残しました
  (正規表現を選ぶと `/パターン/` の形式で登録されます。挙動は今までと同じです)
- ツールバーの簡易 NG パネル(節タブを持たない一覧画面)は、これまでどおり種類を
  選ぶプルダウン(正規表現込み)を残し、選択肢に「画像NG」を追加しました

## 修正

## セキュリティ

## 設定ファイルの互換性

## v0.0.107 (2026/09/21)

## 新機能

- NG に「通常あぼ～ん」モードを追加しました。レスを非表示にせず、名前・メール欄・投稿日を
  「あぼ～ん」に、本文を理由表示付きの「あぼ～ん」に置き換えて残します。本文の「あぼ～ん」に
  マウスオーバーすると、一致した NG 内容 (例:「NGワード: ○○」) がツールチップで表示されます
- NG に「メール欄」カテゴリを追加しました
- NG のモード (透明あぼ～ん / 通常あぼ～ん / 画像のみ非表示) を種類ごとではなく**項目 1 件ごと**に
  選択できるようにしました。登録時のドロップダウンのほか、登録済みの項目も一覧から後で変更できます
- 通常あぼ～んのレスも新着ペイン・字幕ウィンドウに表示されるようにしました (名前・メール・投稿日・
  本文は同様に「あぼ～ん」表示)
- 設定パネルの NG タブに「通常あぼ～んを『あぼーん』と読み上げる」チェックボックスを追加しました
  (既定 ON。OFF にすると通常あぼ～んのレスも読み上げをスキップします)

## 変更

- 従来の NG (レスを非表示にする方式) を「透明あぼ～ん」と呼ぶようにしました
- 「画像NG」を「画像のみ非表示」に改称しました (スレタイ NG のモード選択肢からは除外)
- スレタイ NG のモード・スコープの選択肢を、他の NG 種類と同じ形式に統一しました
  (スレタイ NG では「画像のみ非表示」「このスレ」は選べません)

## 修正

- NG のスコープ (この板のみ / このスレのみ) を設定しても、アプリ再起動後に全体スコープへ
  戻ってしまう不具合を修正しました

## セキュリティ

## 設定ファイルの互換性

- `ng-settings.json` の `thread_words` (スレタイ NG) が、文字列の配列から他の NG 種類と同じ
  オブジェクト形式に対応しました。既存の文字列エントリはそのまま読み込め、透明あぼ～ん・全体
  スコープとして扱われます
- `ng-settings.json` に `mails` (メール欄 NG) フィールドが追加されました (未設定時は空)

## v0.0.106 (2026/09/20)

## 新機能

## 変更

- 説明書 (docs/USER_MANUAL.md) の画面構成の図が環境によって崩れて表示される問題があったため、箇条書きに書き直し
- 説明書の「返信専用」「返信・新スレ立て」等の表記を、5ch用語に合わせて「レス専用」「レス・新スレ立て」に統一

## 修正

- アプリを起動した直後など、板やスレをまだ一度も開いていない状態で、開発用のダミーのスレ(「プローブスレッド」「認証テスト」)やダミーのレスが実際のデータのように表示されてしまう不具合を修正

## セキュリティ

## 設定ファイルの互換性

## v0.0.105 (2026/09/20)

## 新機能

- メインウィンドウを常に他の全ウィンドウの下に表示する「常に最背面」機能を追加(常に最前面の逆)。設定 → 表示 → 全般
- NG・読み上げない辞書・読み上げ許可リストの登録内容を隠せる「登録項目のマスク」機能を追加(既定でON)。配信画面を共有する際などに、登録した語句が映り込むのを防げます。該当する設定タブの先頭にあるチェックボックスで切り替えられます

## 変更

## 修正

## セキュリティ

## 設定ファイルの互換性

## v0.0.104 (2026/09/18)

## 新機能

- 設定画面から板一覧(bbsmenu)の取得先URLを変更できるように。5ch側でドメインや形式が変わった場合もユーザー側で対応可能に(※将来のドメイン変更に備えた機能のため、作者側では実際のドメイン切り替わり時の動作は未確認です)
- したらば・JPNKNのドメインも設定で上書きできるように(将来ドメインが変わった場合の備え。※こちらも作者側では動作未確認です)
- レス内のしたらば・JPNKNの板URLをクリックした際、外部ブラウザではなくアプリ内の板タブとして開くように変更
- 書き込み用の浮遊ウィンドウがダークモードに対応。ウィンドウサイズを記憶し、次回起動時に復元
- 書き込み浮遊ウィンドウもカスタムCSS(`theme/compose.css`)に対応

## 変更

## 修正

- 自動更新が有効な状態で板のスレ一覧を見ていると、並び順の変化により選択中スレ・既読状態・右クリックメニューの対象が別のスレを指してしまうことがある不具合を修正(スレの識別方法をURLベースに変更)
- したらばの板によっては一覧取得時に同じスレが重複して表示されることがある不具合を修正
- 右クリックメニューの項目数が増えた際、ウィンドウの端でメニューが画面外にはみ出て一部隠れることがある不具合を修正

## セキュリティ

## 設定ファイルの互換性

## v0.0.103 (2026/09/16)

### v0.0.103 の変更（今回）

#### 書き込み

- **画面上部のメニューバーが書き込み・投稿直後に消える不具合を修正しました**（v0.0.102 での修正は不十分でした）。原因は、着〜/サイズ〜KB のバーを、ユーザーがドラッグで高さを決める書き込みウィンドウの中に置いていたことでした。名前欄・本文欄・送信ボタン・結果メッセージなどの合計の高さが書き込みウィンドウの高さを超えると中身がはみ出し、それをきっかけに画面全体がスクロールしてメニューバーが押し出されていました。着〜バーを書き込みウィンドウの外（ステータスバー）に移すことで解消しました
- **下部の書き込みウィンドウを返信専用にしました**。新スレ立ては、スレッドタイトルバーの「書き込み」から開く浮遊ウィンドウで行います（浮遊ウィンドウには元々この機能があります）
- 書き込みウィンドウのレイアウトを見直し、省スペース化しました
  - ヘッダーは「本文」「プレビュー」タブの切り替えに変更（バー全体のクリックで格納・展開できるのは従来どおりです）
  - 名前・メール・sage・文字数/行数・送信ボタンを1行にまとめました
  - 「プレビュー」タブでは、実際に投稿された後の見た目（掲示板の生データに近いプレーンテキスト形式）を確認できます
- 着〜/サイズ〜KB・画像/動画/外部リンクフィルタのバーを、下部のステータスバー（「boards loaded: ~」等を表示している場所）に統合しました。スレを開いているときだけこの内容に切り替わります

### カスタム CSS

- 上記のレイアウト変更にあわせて、`docs/CSS_CUSTOMIZE.md` の書き込みウィンドウ・ステータスバーの節を実装に合わせて書き直しました
- `.response-nav-bar` は `.status-nav-bar` に変わりました（ステータスバー内の要素になったため）。`.compose-target` `.compose-actions` `.compose-meta` は無くなりました
- 書き込みの浮遊ウィンドウは、現時点では `data/custom.css` / `data/theme/` によるカスタマイズに対応していません（別ウィンドウですが、字幕・画像ポップアップと違いテーマ用のCSSファイルをまだ用意していません）

---

### v0.0.102 の主な変更（前回リリース、再掲）

#### v0.0.102 の変更

##### 音声読み上げ

- SAPI 読み上げ中に画面全体の操作を受け付けなくなる不具合を修正。読み上げ関連の処理をメインスレッドから切り離し、読み上げ中も画面を操作できます
- 上記にあわせて、読み上げの停止が実際に効くようになりました（以前は停止ボタンを押しても今読んでいる内容は止まりませんでした）
- 複数レスをまとめて読み上げる（「このレスから読み上げ」など）と、内部の判定順序の不具合で最後の1件しか実際には再生されない不具合を修正
- 「読み上げを今すぐ停止」を、スレッドタイトルバーとレスの右クリックメニューから直接呼べるように（従来は設定画面からのみ）
- 読み上げ文字数の既定値を 100 文字に変更（従来は無制限）
- 棒読みちゃんの実行ファイルパスが、起動直後の保存タイミングや設定画面の「保存しない」操作で消えてしまう不具合を修正

##### 書き込み（v0.0.102 時点）

- スレッドタイトルバーの「書き込み」ボタンから、独立したウィンドウで書き込み・スレ立てができるように（字幕ウィンドウと同じ仕組みの別ウィンドウ）。投稿・スレ立てが成功すると自動的に閉じる
  - ウィンドウを開いたままスレッドを切り替えて投稿すると意図しないスレッドに投稿されてしまう不具合を修正（投稿先はウィンドウを開いた時点のスレッドに固定）

##### 表示

- ダークモード時、確認ダイアログの「キャンセル」等のボタンが背景と同化して読みにくかった不具合を修正

#### v0.0.101 の主な変更（v0.0.102 リリースノートより再掲）

##### 新機能

- **リンクカード**: 本文中の URL を OGP 情報（タイトル・説明・画像）付きのカードで表示。X (Twitter) のポスト・YouTube 動画に対応（既定 OFF、通信先ドメイン制限あり）
- **設定画面の再構成**: 節タブ・検索窓・「設定を保存」ボタン方式（保存せず閉じると元の値に戻る）・プリセット保存/読込・自動バックアップ・リセット機能
- **新着レスペイン・字幕ウィンドウ**: 自動スクロールの詳細設定、両者の表示同期、字幕のスクロールバー・一時停止
- **レスヘッダ統一**: 5ch 風の表示順に統一し、項目ごとに表示/非表示を選択可能に。したらばの ID 取得にも対応
- **読み上げ許可リスト・読み上げない辞書**を新設
- **URL バーの右クリックメニュー**（貼り付けて移動 等）、**入力欄の履歴**（板検索・お気に入り検索など）

##### 変更・セキュリティ

- タブ切り替え時のレス位置ずれ対策、字幕ウィンドウの設定保存、セッション保存の堅牢化（クラッシュ耐性）
- カスタム CSS のヘッダ構造を SIKI 互換に整理（`.rh` 直下の flex 子・`.res-col`・`.th-cardlist` など）
- リンクカード取得の SSRF 対策一式、プリセット名のパス検証、クリップボード読み取りの安全策

詳細は [CHANGELOG.md](CHANGELOG.md) の v0.0.101・v0.0.102 の項目をご参照ください。

### 設定ファイルの互換性

- 旧バージョンの `data` フォルダはそのまま使えます。今回新しく追加されるファイルはありません

## v0.0.102 (2026/09/16)

### v0.0.102 の変更（今回）

#### 音声読み上げ

- **SAPI 読み上げ中に画面全体の操作を受け付けなくなる不具合を修正**しました。読み上げ関連の処理をメインスレッドから切り離し、読み上げ中も画面を操作できます
- 上記にあわせて、**読み上げの停止が実際に効くように**なりました（以前は停止ボタンを押しても今読んでいる内容は止まりませんでした）
- 複数レスをまとめて読み上げる（「このレスから読み上げ」など）と、内部の判定順序の不具合で**最後の1件しか実際には再生されない**不具合を修正しました
- 「読み上げを今すぐ停止」を、スレッドタイトルバーとレスの右クリックメニューから直接呼べるようにしました（従来は設定画面からのみ）
- 読み上げ文字数の既定値を 100 文字に変更しました（従来は無制限）
- 棒読みちゃんの実行ファイルパスが、起動直後の保存タイミングや設定画面の「保存しない」操作で消えてしまう不具合を修正しました

#### 書き込み

- スレッドタイトルバーの「書き込み」ボタンから、**独立したウィンドウで書き込み・スレ立てができる**ようになりました（字幕ウィンドウと同じ仕組みの別ウィンドウ）。名前・メール・sage・本文・レス/新スレ切替に対応し、投稿・スレ立てが成功すると自動的に閉じます。ウィンドウを開いている間のレス引用もそちらに反映されます
  - このウィンドウを開いたままスレッドを切り替えて投稿すると、意図しないスレッドに投稿されてしまう不具合を修正しました（投稿先はウィンドウを開いた時点のスレッドに固定されます）
- 書き込み・投稿の直後に**画面上部のメニューバーが一時的に見えなくなる**不具合を修正しました（ページ全体が意図せずスクロールしてしまうことが原因でした）
- 着〜/サイズ〜KB・画像/動画/外部リンクフィルタのバーを、レス表示欄の中から書き込みウィンドウの下（展開・格納どちらの状態でも一番下）に移動しました

#### 表示

- ダークモード時、確認ダイアログの「キャンセル」等のボタンが背景と同化して読みにくかった不具合を修正しました

---

### v0.0.101 の主な変更（前回リリース、再掲）

#### 新機能

- **リンクカード**: 本文中の URL を OGP 情報（タイトル・説明・画像）付きのカードで表示。X (Twitter) のポスト・YouTube 動画に対応（既定 OFF、通信先ドメイン制限あり）
- **設定画面の再構成**: 節タブ・検索窓・「設定を保存」ボタン方式（保存せず閉じると元の値に戻る）・プリセット保存/読込・自動バックアップ・リセット機能
- **新着レスペイン・字幕ウィンドウ**: 自動スクロールの詳細設定、両者の表示同期、字幕のスクロールバー・一時停止
- **レスヘッダ統一**: 5ch 風の表示順に統一し、項目ごとに表示/非表示を選択可能に。したらばの ID 取得にも対応
- **読み上げ許可リスト・読み上げない辞書**を新設
- **URL バーの右クリックメニュー**（貼り付けて移動 等）、**入力欄の履歴**（板検索・お気に入り検索など）

#### 変更・セキュリティ

- タブ切り替え時のレス位置ずれ対策、字幕ウィンドウの設定保存、セッション保存の堅牢化（クラッシュ耐性）
- カスタム CSS のヘッダ構造を SIKI 互換に整理（`.rh` 直下の flex 子・`.res-col`・`.th-cardlist` など）
- リンクカード取得の SSRF 対策一式、プリセット名のパス検証、クリップボード読み取りの安全策

詳細は [CHANGELOG.md](CHANGELOG.md) の v0.0.101 の項目をご参照ください。

### 設定ファイルの互換性

- 旧バージョンの `data` フォルダはそのまま使えます。今回新しく追加されるファイルはありません（v0.0.101 で追加されたファイル群から変更はありません）

## v0.0.101 (2026/09/16)

### 新機能

#### リンクカード（OGP / X ポスト / YouTube）

- 本文中の URL を、ページのタイトル・説明・画像付きのカードで表示します（設定 › 表示 › リンクカード。**既定は OFF**）
- X (Twitter) のポストは本文・画像・動画付きのカードで表示。`video.twimg.com` の動画はその場で再生できます
- YouTube のリンクは oEmbed からタイトル・チャンネル・サムネイルを取得してカード化します
- 通信先のドメインを許可 / ブロックリストで制限できます。取得結果は 7 日間キャッシュ（タイトルも画像も取れなかったものは 30 分で再試行）
- 新着レスペインと字幕ウィンドウにもカードを出せます（それぞれ設定で ON/OFF）

#### 設定画面の再構成と保存方式

- 分類の中を節タブ（表示 / 字幕 / 読み上げ辞書 / NG / ハイライト）で分割し、上部に**設定項目の検索窓**を追加。検索語の履歴を候補として表示します
- 値の設定は変更するとすぐ画面に反映されますが、ファイルへの保存は**「設定を保存」ボタン**を押したときだけ行います。保存せずに閉じる・別の分類へ移るときは確認が出て、「保存しない」を選ぶと開いたときの値に戻ります（NG・辞書・ハイライトなどの登録内容はこれまでどおり登録時に保存）
- **プリセット**: 現在の値の設定に名前を付けて保存・読み込み・削除（`data\presets\<名前>.json`）
- **自動バックアップ**: 「設定を保存」とリセットの前に、直前の設定（登録内容を含む）を `data\settings-backup\` に保存（最新 20 件）。設定画面から復元できます
- **リセット**: 値の設定を初期値に戻します。NG・ハイライト・辞書などの登録内容も含めるかを選べます
- 読み上げ辞書・許可リスト・読み上げない辞書・NG・ハイライトの一覧に件数表示と絞り込み入力

#### 新着レスペイン・字幕ウィンドウ

- 自動スクロールの値（短いレスの表示時間・スクロール開始までの待ち時間・速度・スクロール後の表示時間）を新着ペインと字幕で別々に設定できます（上限: 120 秒 / 20 秒 / 100 ms/px）
- 字幕ウィンドウの自動スクロールとスクロールバー表示。手動でスクロールすると自動送りを一時停止し、ヘッダの ▶ で次のレスへ進みます
- **新着レスペインと字幕の同期**（設定で ON/OFF）: 両方が最下行まで表示し終えてから、長い方の「スクロール後の表示時間」を待って次へ進みます
- 字幕の ID ハイライト色と書き込み回数の色が、流し始めた後に登録した分も反映されるようになりました

#### レスヘッダ

- レス表示欄・新着ペイン・字幕のヘッダを 5ch 風の「番号 名前：名前 [メール] 投稿日：日時 ID (n/回数)」に統一し、項目ごとに表示 / 非表示を選べます（非表示分は詰めて表示）
- ヘッダ項目を全て非表示にしたときはレス間に罫線を自動で引きます。「レス間に罫線を常に表示」設定も追加

#### 音声読み上げ

- 「全置換」を「全文置換」に改称。URL は単語単位ではなく URL 単位で辞書照合します
- 既定の辞書項目に「WebABC」「したらば掲示板」「YouTube」を追加（既存の辞書には一度だけ追加されます）
- **読み上げ許可リスト**: IP アドレス直指定の配信 URL を登録した読み方で読み上げます（未登録の IP は読み上げません）
- **読み上げない辞書**: 名前 / 本文のワード / ID を登録して読み上げ対象から外せます（正規表現可）

#### そのほか

- URL バーの右クリックメニュー（貼り付けて移動 / 貼り付け / コピー / すべて選択）。「貼り付けて移動」はクリップボードの先頭行が URL の形式のときだけ移動します
- 入力欄の履歴: 板の検索・お気に入り検索・設定の一覧絞り込み・スレ立てのタイトルとメール欄で、以前入力した値を候補に出します（設定 › 表示 › 全般の「履歴を消去」でまとめて消せます）

### 変更

- したらば: レスの ID を取得するようになりました（rawmode.cgi には ID が無いため read.cgi の HTML から取得。差分は範囲指定で取得）。ID の無い古いキャッシュは自動更新時に一度だけ全件取り直します
- タブ切り替え直後のレス位置ずれ対策: 画像やカードの読み込みで高さが変わるあいだレス表示欄を隠し（最長 0.4 秒）、レス表示欄のサムネイルは固定サイズの枠で表示します。最下行に合わせた後は、ユーザーがスクロールするまで最下行に追従します
- 字幕ウィンドウのフォントサイズ・透明度・最前面の設定をファイルに保存するようになりました（これまでは起動のたびに初期値でした）
- 読み上げ辞書などの入力枠の幅を統一
- 入力時のコンフェティ演出を削除
- セッション保存を含む全ての JSON 保存を「一時ファイルに書いて fsync してから置き換える」方式に変更。強制終了時にスレタブが失われたり、設定ファイルが途中まで書かれた状態で壊れたりしなくなりました

### カスタム CSS（SIKI 互換の拡充）

- ヘッダの各項目が `.rh` の直接の子として並ぶようになり、SIKI の `order` による並べ替えレシピがそのまま使えます
- ID の列を `.res-col[data-type="id"]`、書き込み回数を `.cnt`、被参照 (▼N) を `.res-replies`、リンクカードを `.th-cardlist` として参照できます
- ヘッダ全非表示時の罫線は `.response-block.no-header`、常時罫線は `.response-scroll.always-divider` で見た目を変えられます
- 詳細は [docs/CSS_CUSTOMIZE.md](https://github.com/kaedekiku/LiveFakeTauri2/blob/main/docs/CSS_CUSTOMIZE.md)（実装に合わせて全面的に書き直しました）

### セキュリティ

- リンクカードの取得は、私有・予約 IP アドレスの拒否、DNS 解決結果の全アドレス検証と接続先の固定、リダイレクトごとの再検証、HTML 以外の Content-Type は読まない、512KB 上限、ユーザー情報付き URL の拒否、で保護しています。動画の再生は CSP で `video.twimg.com` のみ許可、画像・動画の取得にリファラは送りません
- プリセット名はファイル名としてのみ使い、パス区切り・親フォルダ参照・Windows の予約名を拒否します
- 「貼り付けて移動」はメニューを選んだときだけクリップボードを読み、内容をログや設定ファイルに残しません

### 設定ファイルの互換性

- 旧バージョンの `data` フォルダはそのまま使えます
- 追加されるファイル: `tts-ip-allow.json`（読み上げ許可リスト）、`tts-mute-dict.json`（読み上げない辞書）、`tts-dict-meta.json`、`ogp_domain_filters.json`、`input-history.json`、`presets\`、`settings-backup\`
- `cache.db` にリンクカードのキャッシュ表 `ogp_cache` が追加されます

本文が無いバージョンは、そのリリースまでのコミット件名を一覧にしています。


## v0.0.100 (2026/07/17)

### 新機能: SIKI 互換カスタム CSS

汎用掲示板ブラウザ **SIKI と互換のカスタム CSS** に対応しました。SIKI の wiki 等で共有されているカスタマイズレシピの多くをそのまま流用できます。

- **ファイル構成**: `data/theme/` に SIKI と同じ 7 ファイル (`main.css` / `light.css` / `dark.css` / `floating.css`(字幕ウィンドウ) / `mediaviewer.css`(画像ポップアップ) / `postform.css` / `setting.css`) を配置可能。初回起動時に説明コメント付きテンプレートを自動生成します。従来の `data/custom.css` もそのまま使えます
- **互換セレクタ**: `.rcon` `.rb` `.res-name` `.rc-id` `.mark-myself` `.mark-anchor` `.newly` `.aa` `.bcon` `#threadPane` `.popupfield` など SIKI と同名のクラス/IDを付与。板ごとの条件スタイル用 `.sv__<ホスト名>` にも対応
- **互換テーマ変数**: `--color-boardTab-activeBackground` `--color-thread-resMyselfBackground` など SIKI 0.27.0 以降と同名の変数を上書き可能
- **SIKI との違い**: 反映は再起動不要 (メニュー「設定 > ユーザーCSSを再読み込み」)
- 詳細・対応表: [docs/CSS_CUSTOMIZE.md](https://github.com/kaedekiku/LiveFakeTauri2/blob/main/docs/CSS_CUSTOMIZE.md)

#### 安全対策

ネット上で配布されている CSS の貼り付けを想定し、CSS 内の `url(http…)` による外部サーバー参照は**既定で無効化**されます (該当箇所のみ除去し、ブロックしたホスト名をステータスバーに表示)。`url(data:…)` 形式の画像埋め込みは通信が発生しないため常に使えます。必要な場合のみ設定「カスタムCSSの外部URL参照を許可 (非推奨)」をオンにしてください。

### その他

- 設定ファイルの互換性: 旧バージョンの `data` フォルダはそのまま利用できます


## v0.0.99 (2026/07/15)

### 重要なお知らせ

本バージョンには**セキュリティ関連の修正**が含まれています(内容の詳細は公開しません)。旧バージョンをご利用の方は速やかに更新してください。

なお、本更新に起因する不具合への対応は **2026/07/22 頃まで** となります。問題を見つけた場合はお早めにご報告ください。

### 変更点

- IDポップアップの表示位置を修正しました。レス数が少ない・フォントが小さい場合に画面最上部に表示されてしまい、ポップアップへカーソルを移動できなかった問題を解消。小さいポップアップはIDのすぐ横に表示され、大きい場合は従来どおり画面全高で表示されます
- BE / UPLIFT / どんぐりログイン機能を廃止しました(`cookies.json` は使用されなくなります)
- プロキシパスワードの保存形式を変更しました。既存の設定は自動移行されます(設定ファイルを別のPCへコピーした場合のみ、プロキシパスワードの再入力が必要です)
- 書き込みウィンドウの「接続診断」ボタンを開発ビルド限定にしました
- ドキュメント類を整理しました

### 設定ファイルの互換性

旧バージョンの設定ファイル(`data` フォルダ)はそのまま利用できます。フォルダごと差し替え・上書きで移行可能です。


## v0.0.98 (2026/07/01)

- IDポップアップ横表示・スマート縦位置・サイズ設定拡張


## v0.0.97 (2026/07/01)

- 書き込みウィンドウを1行レイアウトに変更


## v0.0.96 (2026/06/30)

- IDポップアップ最大幅設定・テキスト折り返し全文表示


## v0.0.95 (2026/06/30)

- 書き込みウィンドウ高さ永続化の修正


## v0.0.94 (2026/06/30)

- 書き込み高さ永続化・ポップアップフォント拡張・URL右クリックコピー


## v0.0.92 (2026/06/26)

- TTS辞書・IDフォント設定・字幕ヘッダー順変更


## v0.0.91 (2026/05/13)

- 書き込み送信後もウィンドウを閉じないよう変更


## v0.0.90 (2026/05/13)

- 書き込みウィンドウの名前・メール・sageを1行表示に変更


## v0.0.89 (2026/05/12)

- 書き込みパネルを常時表示の折りたたみ式に変更・高さ可変対応・タブ切替スクロール補正修正


## v0.0.88 (2026/05/09)

- scrollHeightポーリングでスクロール位置補正を正常化


## v0.0.87 (2026/05/09)

- ResizeObserverで画像ロード後のスクロール位置ズレを補正


## v0.0.86 (2026/05/09)

- フォントピッカー改善 (&区切り分割・フォントプレビュー付きドロップダウン)


## v0.0.85 (2026/05/09)

- 画像プレビュー設定追加・lazy→eagerで最新レス位置ズレ修正


## v0.0.84 (2026/05/09)

- PCインストール済みフォント選択・太字機能を追加


## v0.0.83 (2026/05/09)

- 5ch投稿SSL修正 (curl→reqwest+rustls)

- fix: 5ch投稿をcurlからreqwest+rustlsに変更しSSL接続エラーを修正


## v0.0.82 (2026/05/09)

- 板一覧の表示/非表示トグル機能とボタンを追加


## v0.0.81 (2026/05/08)

- 字幕ウィンドウの表示をキュー管理に変更し複数レス到着時に順番に表示


## v0.0.80 (2026/05/08)

- レスヘッダのフォントサイズを設定から変更可能に


## v0.0.79 (2026/05/08)

- 自動更新間隔を10〜300秒・1秒刻みに変更


## v0.0.78 (2026/04/28)

- NGされたレスを新着ペイン/字幕/読み上げから除外

- fix: NGされたレスを新着ペイン/字幕/読み上げから除外


## v0.0.77 (2026/04/26)

- 検索機能の2モード化、Linux/Mac削除、ドキュメント整備

- docs(readme): プロキシ機能が未動作である旨を明記し実装対応予定セクションを追加

- docs(readme): 謝辞セクションを追加

- docs: ユーザー説明書を追加し SPEC.md と LICENSE を整備

- feat(search): レス抽出/スレ内検索の2モード化と検索UIの再配置

- docs(readme): 古い画面構成図・キーボードショートカット・開発者向け説明を削除

- chore: Linux/Mac ビルド関連を削除し Windows 専用に統一


## v0.0.76 (2026/04/25)

- タブドラッグ修正・localStorage完全撤廃 (Portable完全対応)

- refactor: 残り 3 キーを localStorage から save_generic_json に移行 (Step B)

- refactor: localStorage の二重書き込みを廃止し IPC/ファイル永続化に一本化 (Step A)

- fix: タブドラッグ並び替えの修正と新着ペイン挙動の改善


## v0.0.75 (2026/04/22)

### Changes
- Windows専用リリース（Linux・macOS対応を廃止）
- ドキュメント整備


## v0.0.74 (2026/04/22)

### Changes
- タブ切り替え時のスクロール位置復元を修正（最下部にいた場合は最下部に復元）
- 更新チェックURLのデフォルト値を設定


## v0.0.73 (2026/04/21)

### Changes
- 字幕ウィンドウ改善（open/close・ドラッグ・位置リセット・連動クローズ）
- 新着ペインの自動更新状態を再起動後も維持
- Windows専用リリース（macOS対応を廃止）


## v0.0.72 (2026/04/20)

- fix: CI/Release ワークフロー修正 + スモークテスト用フォールバックデータ復元

- fix: CI/Release ワークフローのビルドエラー修正

- OSS公開準備 (README/SPEC/gitignore整備、Windows自動リリース追加)

- 画像アップロード機能 (tadaup.jp)


## v0.0.70 (2026/04/08)

- スレ全体をコピー機能を追加 (レス/タブ右クリックメニュー)

- fix: copyWholeThread の HTMLエンティティデコード改善 + 認証設定保存メッセージ表示

- feat: add "copy whole thread" to response and tab context menus

- fix: update smoke test to expect pointer cursor on thread tabs


## v0.0.69 (2026/04/07)

- スレタブのカーソルをpointerに統一

- feat: show copy notification on Mac command copy button


## v0.0.68 (2026/04/07)

- >N, >>N-M (範囲), >>N,M (カンマ区切り) 形式のアンカー認識とポップアップ表示に対応


## v0.0.67 (2026/04/07)

- >11 や >>11,12 形式のアンカーを認識するように改善


## v0.0.66 (2026/04/07)

- fix: sync src-tauri/Cargo.toml version to 0.0.66 and fix /release skill

- 自動更新間隔の設定を永続化


## v0.0.65 (2026/04/06)

- fix: include quit_app command in Rust backend

- ファイル→終了メニューをWindows限定に変更（Macでは非表示）


## v0.0.64 (2026/04/06)

- ファイル→終了でアプリが正しく終了するように修正

- fix: typo embar -> ember in README

- fix: remove duplicate deb/rpm deps and add package metadata


## v0.0.63 (2026/04/06)

- IDポップアップ内のアンカーポップアップ対応


## v0.0.62 (2026/04/06)

- スレッド一覧のソート順安定化（既読更新で並び替わらないように修正）


## v0.0.61 (2026/04/05)

- (リリースノート無し)


## v0.0.60 (2026/04/05)

- (リリースノート無し)


## v0.0.59 (2026/04/03)

- IDをコピーがレス番号ではなくポスターIDをコピーするよう修正


## v0.0.58 (2026/04/03)

- スレ一覧の既読・新着カラムでソート可能に


## v0.0.57 (2026/04/03)

- Ctrl+Shift+Tで閉じたタブを再度開く機能を追加


## v0.0.56 (2026/04/03)

- お気に入りモードでスレ既読状態が正しく永続化されるよう修正


## v0.0.55 (2026/04/03)

- お気に入り表示から通常表示に戻した際の既読状態表示を修正


## v0.0.54 (2026/04/03)

- お気に入りスレ表示時にdat落ちスレをグレーアウト表示


## v0.0.53 (2026/04/03)

- お気に入りスレ表示時に各スレの新着数を自動確認


## v0.0.52 (2026/04/02)

- AAレスの自動検出と最適化表示を追加


## v0.0.51 (2026/04/02)

- Wayland環境でのWebKit2GTKホワイトスクリーンを防止 (PR #12)

- fix: disable WebKit2GTK DMA-BUF renderer and GPU compositing on Wayland to prevent white screen


## v0.0.50 (2026/04/02)

- fix response scroll clipping by bottom nav bar

- fix: pin AppImage toolchain to stable releases and restore Linux bundle config

- add release automation script and update docs


## v0.0.49 (2026/04/01)

- thumb size/hover delay settings, :// URL support, BE icon domain fix, session restore toggle

- feat: persist thread tabs and last board across app restarts


## v0.0.48 (2026/04/01)

- fix my-post highlight lost on board re-select

- fix: remove linuxdeploy auto-bundled TLS libs from AppImage


## v0.0.47 (2026/04/01)

- add response link filters, tab double-click fetch, ignore OS reduced-motion for confetti


## v0.0.46 (2026/04/01)

- ignore OS reduced-motion for typing confetti

- fix: don't bundle TLS deps in AppImage, use host system's trust store


## v0.0.45 (2026/04/01)

- apply custom font to board pane buttons and list


## v0.0.44 (2026/04/01)

- fix favorites-only view, add thread history menu

- docs: warn against direct cargo build for release

- fix: remove unused mut on confirm response variable


## v0.0.43 (2026/03/31)

- feat: hover preview option, favorites-only thread view, favorites search


## v0.0.42 (2026/03/31)

- feat: differentiate response number and name colors


## v0.0.41 (2026/03/31)

- feat: highlight replies to own posts and landing page system requirements


## v0.0.40 (2026/03/31)

- (リリースノート無し)


## v0.0.39 (2026/03/31)

- feat: image size limit setting and delete explosion effect


## v0.0.38 (2026/03/30)

- fix: persist compose font size across restarts

- fix: update latest.json with correct windows zip hash for v0.0.37


## v0.0.37 (2026/03/30)

- feat: fix settings scroll and highlight own posts


## v0.0.36 (2026/03/30)

- chore: bump desktop version to 0.0.36

- feat: enable thread list sorting by last fetched


## v0.0.35 (2026/03/30)

- chore: bump desktop version to 0.0.35

- feat: add NGID quick action menu on id click


## v0.0.34 (2026/03/30)

- fix: stabilize anchor popup chaining and prep v0.0.34


## v0.0.33 (2026/03/30)

- chore: bump desktop version to 0.0.33

- ux: map F5/Ctrl+R to board/thread refresh by URL

- ui: split reload button and add reload dropdown actions


## v0.0.32 (2026/03/29)

- typing confetti toggle + release metadata


## v0.0.31 (2026/03/29)

- sort fix, fav reorder, 5ch.net redirect, submit key, single instance


## v0.0.30 (2026/03/29)

- search history, image hover tooltip


## v0.0.29 (2026/03/29)

- board button drag reorder, keep sort on refresh option


## v0.0.28 (2026/03/29)

- widen response ID cell max-width


## v0.0.27 (2026/03/29)

- board button bar wrap, anchor popup fit-content width


## v0.0.26 (2026/03/29)

- window size persistence, CLAUDE.md

- fix: add lucide-react to runtime dependency list

- Merge PR #7: ウィンドウサイズの永続化 & CLAUDE.md追加

- fix: address review issues in window size persistence

- docs: add CLAUDE.md with project overview, dev commands, and conventions

- feat: persist and restore window size across app restarts


## v0.0.25 (2026/03/28)

- board button bar, expanded URL recognition, landing page command block

- feat: add board button bar for quick access to favorite boards

- feat: recognize truncated URL schemes (ps://, bare domain) as links

- Merge PR #6: fix AppImage Fcitx5/IBus Japanese input + rename Linux artifacts

- fix: improve CI warnings for missing IM modules and guard immodules.cache regen

- chore: rename Linux artifact filenames to include platform prefix

- fix: bundle Fcitx5/IBus GTK3 IM modules in AppImage for Japanese input support

- chore: change new thread icon to FilePenLine


## v0.0.24 (2026/03/27)

- Lucide icons, BE/UPLIFT cookie filter by provider, image preview layout, scroll fixes


## v0.0.23 (2026/03/26)

- per-pane font size, cookie jar fix, logout cookie clear, post logging, Linux CI

- Merge PR #5: Linux-only CI release workflow

- ci: keep only Linux builds in release workflow

- ci: add release workflow for all platforms on v* tag push


## v0.0.22 (2026/03/26)

- fix silent post failure caused by stale cookie jar reuse


## v0.0.21 (2026/03/26)

- per-pane font size control (boards/threads/responses)


## v0.0.20 (2026/03/26)

- post flow logging, clear login cookies on logout, error detail display

- clear login cookies on logout (BE/UPLIFT/Donguri)


## v0.0.19 (2026/03/26)

- add post flow logging to app.log and show response body in error messages


## v0.0.18 (2026/03/26)

- fix post flow with retry, ID sequence display, new thread URL cleanup

- feat: show ID sequence number as (x/n) format


## v0.0.17 (2026/03/26)

- fix post finalize flow, new thread URL normalization, auto-focus compose

- feat: auto-focus compose body textarea on open


## v0.0.16 (2026/03/26)

- fix URL bar not updating when reopening active tab thread


## v0.0.15 (2026/03/26)

- fix emoji color rendering on Windows via @font-face unicode-range


## v0.0.14 (2026/03/26)

- add emoji font families for correct rendering

- fix: add emoji font families for correct emoji rendering


## v0.0.13 (2026/03/26)

- fix cache purge persistence and strict post success detection

- fix: strict post success detection using full response body

- landing: Linux版はソースビルド案内に変更

- revert contributor MCP settings from settings.local.json

- Added Linux AArch64 (ARM64) support


## v0.0.12 (2026/03/25)

- fix cache purge not clearing persisted read status


## v0.0.11 (2026/03/25)

- fix new-response fetch error and cache purge

- MCP server version and remove non-existent fetch package

- Add Claude Code skills and slash commands for project workflows

- Add per-pane font size scaling via View menu

- Add drag-resize functionality for thread list columns

- Add Claude Code project configuration


## v0.0.10 (2026/03/23)

- fix dark mode context menu styling

- fix: support NgEntry objects in Rust NgFilters for persistence


## v0.0.9 (2026/03/23)

- per-entry NG mode, post-submit updates

- feat: per-entry NG mode (hide vs image-only), post-submit list update

- docs: add Mac/Linux build scripts to deployment runbook

- docs: reorganize documentation and clean up obsolete files


## v0.0.8 (2026/03/23)

- fix dat-ochi mode, date format, version display

- fix: dat-ochi mode board filtering, empty titles, date format

- fix: filter dat-ochi list by current board, use YYYY/MM/DD hh:mm format

- fix: read app version from package.json instead of hardcoding

- fix: update Cargo.toml version to 0.0.7 and refresh latest.json


## v0.0.7 (2026/03/23)

- archived thread support, UI improvements

- fix: remove bookmark button smoke test assertion

- fix: update smoke tests for removed undo-close and mouse-based tab drag

- fix: prevent false new-response markers on first thread open

- feat: archived thread support, image width limit, remove undo-close


## v0.0.6 (2026/03/23)

- fix macOS startup crash

- fix: remove window state persistence to fix macOS startup crash

- fix: use dynamic imports and delayed init for window state restore


## v0.0.5 (2026/03/23)

- window state persistence, fix new-marker on first open, UI tweaks


## v0.0.4 (2026/03/23)

- merge Linux support, tab drag-drop, date in last-fetch

- ui: tab drag-drop via mouse events, show date in last-fetch column

-      1	feat: add Linux support (X11/Wayland, RHEL/SLES/openSUSE/Debian)      2      3	- core-store: use XDG data directory on Linux (~/.local/share/Ember)      4	- ci: add rust-check-linux job with Tauri system dependencies      5	- scripts: add build_linux_release.sh (AppImage/deb/rpm)      6	- scripts: add bash test scripts (run_smoke_ui.sh, run_e2e.sh)      7	- latest.json: add linux-x64 platform placeholder      8	- README: document Linux build prerequisites and notes      9     10	Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>


## v0.0.3 (2026/03/23)

- popup image interactions, dat落ちモード fix, thread title bar fix


## v0.0.2 (2026/03/23)

- popup flip, update check, watchoi, keyboard shortcuts, UI improvements

- post: hide curl consoles and improve success detection

- core-store: use user data dir on macos

- landing: add mac quarantine workaround note

- landing: add update instructions for windows and mac

- landing: update copy and split install steps by platform

- landing: adjust migration copy to mention siki

- landing: add install guide and asset file links

- landing: refine motivation copy and add x/issues links


## v0.0.1 (2026/03/21)

- desktop: add landing and bmc links to about dialog

- landing: switch pages project to ember-5ch

- landing: add cloudflare pages deploy command

- landing: rename page title to Ember

- landing: rename hero brand to Ember

- landing: add github link and favicon

- landing: add medium-style screenshot zoom

- landing: add project motivation copy and bmc link

- landing: redesign top page with screenshots

- desktop: add SQLite cache, thread NG filter, new-response marker, dark mode improvements

- desktop: keep hover preview after ctrl release

- desktop: keep fixed thread columns and persist board-tree scroll

- desktop: keep thread-list search box always visible via sticky toolbar

- desktop: highlight matched query text in thread and response searches

- desktop: widen anchor popup and keep it open while hovering popup content

- desktop: decode numeric entities in titles, enlarge BE icon, smooth response scrolling

- desktop: persist thread/response pane size in px and fix speed header bleed

- desktop: remove thumbnail loading pulse animation to stop flicker

- desktop: keep ctrl-hover preview open, wheel zoom via global handler, unify ID/BE display

- desktop/auth: fullscreen top-left image preview and stabilize ctrl-hover

- desktop/auth: debounce hover preview close and tighten BE login diagnostics

- desktop/auth: support s:// image links, harden BE click and login

- desktop/auth: fix hover flicker, BE login form, ID popup, BE extraction

- fix: BE login auto-save, image CSP broadened, checkbox layout

- desktop: add 7 features - tab close, auth settings, image CSP, search

- fix: increase E2E settings panel wait to avoid flaky timeout

- desktop: redesign UI to match Live5ch appearance

- fix: update E2E tests for column offset and toolbar button rename

- docs: update progress and handover with latest UI and logging features

- desktop: remove response fetch limit (was clamped to 2000)

- core-store: add file logging to data/logs/app.log

- desktop: streamline status bar and show NG count in nav info

- desktop: add ID color coding, response jump input, and compose font size setting

- desktop: add board search filter, response loading indicator, and auto-scroll to new responses

- desktop: remove meta bars and dev panel, fix name HTML tag stripping

- docs: update progress with confirm form parser fix and probe results

- fix: support unquoted HTML attributes in confirm form parser

- desktop: add image loading placeholder and tab response count display

- docs: update progress with 2-pane layout and block viewer refactor

- desktop: add tab response count badge, new-response jump button, and dark theme for block view

- desktop: improve auto-refresh selection retention and new response tracking

- desktop: refactor to 2-pane layout with block response viewer and UI polish

- fix: decode subject.txt as Shift_JIS and persist board list with expand state

- docs: add developer guide with architecture and command reference

- desktop: extend E2E tests to 28 items covering new UI features

- docs: update progress with post history and speed gradient

- desktop: add post history panel and speed gradient coloring

- docs: update progress, handover, and localize deployment runbook

- desktop: add settings panel, thread double-click bookmark jump

- desktop: add dark theme, NG regex, and bookmark navigation

- docs: update progress and handover with latest UI features

- desktop: add compose preview, text selection quoting, and row striping

- desktop: add ID popup, speed bar, and response row striping

- desktop: add response ID column with occurrence count and back-reference display

- desktop: add URL linkification, thread NG filter, back-refs, and compose persistence

- desktop: add menu dropdowns, shortcuts help, and font size setting

- docs: update progress with lightbox, nav bar, compose drag, 50 smoke tests

- desktop: add response nav bar, draggable compose, and splitter inline

- desktop: add response jump, tab context menu, and browser open

- desktop: add image lightbox, new count column, and tab drag reorder

- docs: update progress with thread tabs, sort, and menu improvements

- desktop: add response body copy and NG name actions

- desktop: add sortable thread list columns

- desktop: add thread tabs, post auto-reload, and image thumbnails

- desktop: localize UI to Japanese

- docs: update progress with E2E 28 items

- desktop: extend E2E tests to 28 items covering new features

- docs: update progress with search, auto-refresh, board tabs

- desktop: add board pane tabs with favorite threads view

- desktop: add thread search filter and auto-refresh toggle

- docs: update progress with favorites, NG filter, read persistence

- desktop: add read status persistence and post result feedback

- desktop: add favorites, NG filtering, and persistence via core-store

- docs: update progress with E2E test suite and bbsmenu parser fix

- desktop: add E2E test suite and fix bbsmenu board category parser

- docs: update progress with board tree, anchor features, and reply shortcuts

- desktop: add double-click reply and R-key quick quote shortcuts

- desktop: add anchor hover popup for response preview

- desktop: add board tree, anchor jump, and compose UX improvements

- docs: update progress and handover with probe results and UI improvements

- desktop: refine geronimo UI with sticky headers and interaction polish

- desktop: improve geronimo-compatible UI with HTML rendering and styling

- desktop: wire real dat response fetching into thread reader

- scripts: add post-flow probe runner with strict exit behavior

- core-fetch: add subject-url resolution regression tests

- scripts: block real submit probe when message is empty

- docs: record runtime status bar and web-preview guard

- desktop: show runtime mode and guard thread fetch outside tauri

- desktop: make status bar dynamic and support Enter in URL bar

- docs: sync undo-close toolbar and latest probe updates

- desktop: add undo-close toolbar action and fix close history

- scripts: extend post flow probe with confirm/finalize safety flow

- desktop: hide and cleanup cmd processes in smoke-ui runner

- docs: note undo-close and ci smoke coverage updates

- ci: run desktop smoke-ui test on windows

- desktop: extend smoke test coverage for keyboard navigation

- desktop: add undo-close thread action and validate in smoke test

- docs: add smoke test workflow to tracker and handover

- desktop: add playwright smoke test runner for ui interactions

- desktop: add keyboard navigation for thread and response rows

- docs: record row-info and context-menu behavior updates

- desktop: wire response menu actions to compose and clipboard

- desktop: add row info bars and thread menu actions

- desktop: keep context menus inside viewport

- docs: sync tracker and handover with latest desktop UI work

- desktop: add keyboard resizing shortcuts for pane layout

- desktop: persist pane sizes and add layout reset

- desktop: add draggable pane splitters for three-pane layout

- docs: refresh handover and ignore tauri runtime data

- desktop: improve thread load status and subject URL parsing

- desktop: match live5ch response menu and tab shortcuts

- desktop: add keyboard shortcuts for thread loading and compose

- desktop: load thread list from subject.txt

- desktop: align UI with live5ch screenshots 3 and 4

- desktop: add URL bar and split response/developer panes

- Add post flow trace and improve three-pane interaction

- Show auth/update state in desktop status bar

- Add GitHub Actions CI for desktop and landing builds

- Show latest.json metadata on landing page

- Wire compose input to confirm/finalize posting commands

- Add floating compose window and update progress tracker

- Add one-shot release metadata preparation workflow

- Add latest.json validator and advance geronimo-style desktop layout

- Enhance update metadata handling and simplify latest.json generation

- Add deployment runbook, latest.json generator, and landing app

- Add confirm-to-submit posting flow scaffolding

- Add update check flow and clean generated artifacts handling

- Update docs: macOS Apple Silicon only and Pages Vite+React

- Implement dynamic post token extraction and confirm probe

- Implement auth/fetch probes and update docs

- Initialize project, docs, probes, and MIT license
