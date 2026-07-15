---
name: release
description: リリース準備を行う (バージョン更新、検証、差分確認)
argument-hint: "<バージョン> 例: 0.1.0"
---

LiveFake の指定バージョンでリリース準備を行う。

手順:

1. 現在のバージョンを以下のファイルから読み取る:
   - `apps/desktop/package.json`
   - `apps/desktop/src-tauri/tauri.conf.json`
   - `apps/desktop/src-tauri/Cargo.toml`
2. バージョン差分を表示し、変更前にユーザーの確認を得る
3. 3ファイルのバージョンを更新
4. `cargo check --workspace` で検証
5. `cd apps/desktop && npm run build` で検証
6. `git diff` を表示してレビュー用に提示

コミットやタグ付けは行わない。次の手順 (コミット、タグ push、latest.json 更新) をユーザーに伝えること。

手順2でユーザーの明示的な確認を得るまで、絶対にファイル変更に進まないこと。

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
