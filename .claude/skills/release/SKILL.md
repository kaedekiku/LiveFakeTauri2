---
name: release
description: リリース準備を行う (バージョン更新、検証、差分確認)
argument-hint: "<バージョン> 例: 0.1.0"
---

LiveFake の指定バージョンでリリース準備を行う。

## README / CHANGELOG の運用 (NEW.md は v0.0.119 で廃止)

- 前回リリースからの更新内容のメモは、作業のたびに Claude のメモリ (release-draft) に書きためる (GitHub には置かない)
- `README.md` の「## 最新の更新 (vX.Y.Z)」の `<!-- release-notes:start -->` 〜 `<!-- release-notes:end -->` の間に、メモを要約して書く。
  GitHub Actions の release ワークフローはこの印の間を切り出してリリースページの本文にする (タグ時点の README を読むので、タグの前に main へコミットしておく)
- `CHANGELOG.md` の先頭に `## vX.Y.Z (YYYY/MM/DD)` を足し、要約と、メモの詳しい内容を残す (タグの前に同じコミットで行ってよい)
- 本文のリンクは、リリースページでも開けるよう `https://github.com/kaedekiku/LiveFakeTauri2/blob/main/...` の形で書く

## 手順

1. 現在のバージョンを以下のファイルから読み取る:
   - `apps/desktop/package.json`
   - `apps/desktop/src-tauri/tauri.conf.json`
   - `apps/desktop/src-tauri/Cargo.toml`
2. 更新内容のメモ (release-draft) を確認する。足りなければ、直近のタグの実装 (`git show <前回タグ>:apps/desktop/src/App.tsx` 等) と現在の実装を比較して補う
3. バージョン差分を表示し、変更前にユーザーの確認を得る
4. 3ファイルのバージョンを更新
5. `README.md` の「## 最新の更新」の印の間をメモの要約で書き換え、見出しのバージョン番号も新しいものに変える。`CHANGELOG.md` にも追記する
6. `cargo check --workspace` で検証
   あわせて `python scripts/generate_third_party_licenses.py --check` を実行し、失敗したら生成し直してコミットする
   (release ワークフローでも同じ確認をしており、古いままタグを push するとビルドが失敗する)
7. `cd apps/desktop && npm run build` で検証
8. `git diff` を表示してレビュー用に提示

コミットやタグ付けは行わない。次の手順 (コミット、タグ push、latest.json 更新) をユーザーに伝えること。

手順3でユーザーの明示的な確認を得るまで、絶対にファイル変更に進まないこと。

## リリース後の必須作業: メモの片付け

タグ push → GitHub Actions のビルド・リリース公開を確認した後、更新内容のメモ (release-draft) を次のバージョン向けに空にする。

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
   お知らせ (notice) は、指定しなければ今の latest.json のものを引き継ぐ。セキュリティの修正などで古い版の人に更新を呼びかけるときは
   `--notice-id <英数字の id> --notice-below <この版より古い人に出す> --notice-text "<300 文字まで>"` を足す (`--clear-notice` で消す)。
   お知らせを出すのは v0.0.124 以降の版だけ (それより前の版は読み飛ばす)
3. `apps/landing/public/latest.json` をコミットして main へ push
   (アプリは raw.githubusercontent.com の main ブランチを参照するため、push した時点で更新通知が有効になる)
