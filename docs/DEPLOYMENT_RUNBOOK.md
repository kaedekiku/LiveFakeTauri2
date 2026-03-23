# デプロイ手順書

## 概要

- デスクトップバイナリ: GitHub Releases（ZIP配布）
- 公式サイト + 更新メタデータ: Cloudflare Pages
- メタデータ: `apps/landing/public/latest.json`

## リリース手順

### 1. バージョン更新

以下の3ファイルのバージョンを更新する:

- `apps/desktop/package.json` → `"version": "X.Y.Z"`
- `apps/desktop/src-tauri/tauri.conf.json` → `"version": "X.Y.Z"`
- `apps/desktop/src-tauri/Cargo.toml` → `version = "X.Y.Z"`

> フロントエンドのバージョン表示は `package.json` から自動取得（`vite.config.ts` の `__APP_VERSION__`）。

### 2. コミット & プッシュ

```bash
git add -A && git commit -m "vX.Y.Z: <変更概要>" && git push
```

### 3. Windows ビルド

```bash
cd apps/desktop
npx tauri build
```

成果物: `target/release/ember.exe`

ZIP作成:
```powershell
cd target/release
Compress-Archive -Path ember.exe -DestinationPath ember-win-x64.zip
```

### 4. macOS ビルド

Mac環境で:
```bash
bash scripts/build_mac_release.sh
```

`git pull` → `npm install` → `npx tauri build` → DMGをZIP化 → `out/ember-mac-arm64.zip` を生成。
ハッシュとサイズは `out/build-info.txt` に出力される。

### 5. Linux ビルド（任意）

Linux環境で:
```bash
bash scripts/build_linux_release.sh
```

AppImage / .deb / .rpm を生成し、`out/ember-linux-x64.zip` を作成。

### 6. ハッシュ・サイズ取得

Mac/Linuxビルドは `out/build-info.txt` を参照。Windows:
```bash
sha256sum ember-win-x64.zip && wc -c < ember-win-x64.zip
```

### 7. latest.json 更新

`apps/landing/public/latest.json` を更新:

```json
{
  "version": "X.Y.Z",
  "released_at": "2026-XX-XXTXX:XX:XX+09:00",
  "download_page_url": "https://github.com/kiyohken2000/5ch-browser-template/releases/tag/vX.Y.Z",
  "platforms": {
    "windows-x64": {
      "sha256": "<sha256>",
      "size": <bytes>,
      "filename": "ember-win-x64.zip"
    },
    "macos-arm64": {
      "sha256": "<sha256>",
      "size": <bytes>,
      "filename": "ember-mac-arm64.zip"
    },
    "linux-x64": {
      "sha256": "",
      "size": 0,
      "filename": "ember-linux-x64.zip"
    }
  }
}
```

コミット & プッシュ。

### 8. GitHub Release 作成

```bash
gh release create vX.Y.Z \
  ember-win-x64.zip \
  ember-mac-arm64.zip \
  --title "vX.Y.Z" \
  --notes "## Changes\n\n- ..."
```

### 9. Cloudflare Pages デプロイ

```bash
cd apps/landing
npx wrangler pages deploy public --project-name ember-5ch
```

### 10. リリース後の確認

- 旧バージョンのアプリで更新チェック → `hasUpdate=true`
- 新バージョンのアプリで更新チェック → `hasUpdate=false`（最新版です）
- ダウンロードページリンクが正しいこと

## 運用ルール

- ZIP ファイルは GitHub Releases でホスティング（Pages には置かない）
- ファイル名は固定: `ember-win-x64.zip`, `ember-mac-arm64.zip`
- `latest.json` にシークレット情報を含めない
