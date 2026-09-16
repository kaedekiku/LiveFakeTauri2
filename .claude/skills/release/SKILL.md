---
name: release
description: リリース準備を行う (バージョン更新、検証、差分確認)
argument-hint: "<バージョン> 例: 0.1.0"
---

LiveFake の指定バージョンでリリース準備を行う。

## NEW.md / README / CHANGELOG の運用

- `NEW.md` は「前回リリースからの更新内容」を実装ベースで書いたファイルで、リリースのたびに書き直す
  （最新の GitHub リリース = タグの実装と、現在の開発環境の実装を読み比べて書く。前回分の内容は残さない）
- GitHub Actions の release ワークフローは `NEW.md` の内容をそのままリリースページの本文にする
  (`body_path: NEW.md`)。文字数の心配は基本的に無用 (GitHub の上限は約 125,000 文字)。
  **`NEW.md` はタグを push する前に main へコミット済みである必要がある** (`body_path` はタグ時点のファイルを読むため、
  コミットし忘れるとワークフローがファイル無しで失敗する)
- `README.md` の「## 最新の更新 (vX.Y.Z)」セクションには `NEW.md` の内容を要約して載せる（全文だと長すぎるため）。バージョン番号も更新すること
- `CHANGELOG.md` には過去のバージョンの内容を蓄積する。リリース確定後、`NEW.md` の全文をそのバージョンの見出しの下に追記し、`NEW.md` 自体は次のバージョン向けの空の状態に戻す

## 手順

1. 現在のバージョンを以下のファイルから読み取る:
   - `apps/desktop/package.json`
   - `apps/desktop/src-tauri/tauri.conf.json`
   - `apps/desktop/src-tauri/Cargo.toml`
2. `NEW.md` の内容を確認する。無い/古い（前回リリース以降の変更を反映していない）場合は、直近のタグの実装 (`git show <前回タグ>:apps/desktop/src/App.tsx` 等、または GitHub 上のコードを参照) と現在の実装を比較して書き直す
3. バージョン差分を表示し、変更前にユーザーの確認を得る
4. 3ファイルのバージョンを更新
5. `README.md` の「## 最新の更新」セクションを `NEW.md` の要約で更新し、見出しのバージョン番号も新しいものに変える
6. `cargo check --workspace` で検証
7. `cd apps/desktop && npm run build` で検証
8. `git diff` を表示してレビュー用に提示

コミットやタグ付けは行わない。次の手順 (コミット、タグ push、latest.json 更新) をユーザーに伝えること。

手順3でユーザーの明示的な確認を得るまで、絶対にファイル変更に進まないこと。

## リリース後の必須作業: CHANGELOG.md への転記と NEW.md のクリア

タグ push → GitHub Actions のビルド・リリース公開を確認した後:

1. `NEW.md` の全文を `CHANGELOG.md` の先頭に `## v<バージョン> (YYYY/MM/DD)` の見出しを付けて追記する
2. `NEW.md` の中身を、次のバージョン向けの空のテンプレート（見出しと説明コメントのみ）に戻す
3. 上記 2 ファイルをコミットするかはユーザーに確認する（このスキル自体はコミットしない）

## リリース後の必須作業: latest.json の更新

**忘れると既存ユーザーにアプリ内アップデート通知が届かない** (v0.0.78〜v0.0.98 で更新漏れが続いた実績あり)。
タグ push → GitHub Actions のビルド完了・zip 添付を確認した後、必ず以下を実行すること:

1. リリースされた zip をダウンロード (ファイル名は `livefake-win-x64.zip` のまま保存すること — latest.json の filename に反映されるため):
   ```
   curl -sL -o /tmp/lf_rel/livefake-win-x64.zip \
     "https://github.com/kaedekiku/LiveFakeTauri2/releases/download/v<バージョン>/livefake-win-x64.zip"
   ```
2. リリースの created_at を GitHub API から取得し、latest.json を生成・検証:
   ```
   python scripts/prepare_release_metadata.py \
     --version <バージョン> \
     --released-at <created_at ISO8601> \
     --download-page-url "https://github.com/kaedekiku/LiveFakeTauri2/releases/tag/v<バージョン>" \
     --windows-zip /tmp/lf_rel/livefake-win-x64.zip
   ```
3. `apps/landing/public/latest.json` をコミットして main へ push
   (アプリは raw.githubusercontent.com の main ブランチを参照するため、push した時点で更新通知が有効になる)
