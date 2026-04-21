# デプロイ手順書

## 概要

- デスクトップバイナリ: GitHub Releases（ZIP配布）
- 公式サイト + 更新メタデータ: Cloudflare Pages
- メタデータ: `apps/landing/public/latest.json`

## リリース手順（手動）

### 1. バージョン更新

以下の3ファイルのバージョンを更新する:

- `apps/desktop/package.json` → `"version": "X.Y.Z"`
- `apps/desktop/src-tauri/tauri.conf.json` → `"version": "X.Y.Z"`
- `apps/desktop/src-tauri/Cargo.toml` → `version = "X.Y.Z"`

`/release` スキルで自動化:

```bash
/release X.Y.Z
```

### 2. 検証 & コミット & プッシュ

```bash
cargo check --workspace
cd apps/desktop && npm run build && npm run test:smoke-ui
git add -A && git commit -m "vX.Y.Z: <変更概要>" && git push
git tag vX.Y.Z && git push origin vX.Y.Z
```

### 3. Windows ビルド

```bash
cd apps/desktop && npx tauri build
```

ZIPを作成して `out/` に配置:

```powershell
cd target/release
Compress-Archive -Path LiveFake.exe -DestinationPath ..\..\out\livefake-win-x64.zip -Force
```

### 4. latest.json 更新

```bash
python scripts/prepare_release_metadata.py \
  --version X.Y.Z \
  --released-at "2026-XX-XXT00:00:00+09:00" \
  --download-page-url "https://github.com/kaedekiku/LiveFakeTauri2/releases/tag/vX.Y.Z" \
  --windows-zip out/livefake-win-x64.zip
```

コミット & プッシュ:

```bash
git add apps/landing/public/latest.json
git commit -m "release: update latest.json for vX.Y.Z"
git push
```

### 5. GitHub Release 作成

```bash
gh release create vX.Y.Z \
  out/livefake-win-x64.zip \
  --title "vX.Y.Z" \
  --notes "## Changes
- ..."
```

### 6. Cloudflare Pages デプロイ

```bash
cd apps/landing
npx wrangler pages deploy public --project-name livefake
```

### 7. リリース後の確認

- 旧バージョンのアプリで更新チェック → `hasUpdate=true`
- 新バージョンのアプリで更新チェック → `hasUpdate=false`（最新版です）
- ダウンロードページリンクが正しいこと

## 運用ルール

- ZIP ファイルは GitHub Releases でホスティング（Pages には置かない）
- ファイル名は固定: `livefake-win-x64.zip`
- `latest.json` にシークレット情報を含めない
- `npx tauri build` ではなく `cargo build --release -p livefake` を直接実行するとフロントエンドが埋め込まれず白画面になる
