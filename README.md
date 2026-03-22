# Ember

5ch.io 専用ブラウザ（Tauri + React デスクトップアプリ）。

## 構成
- `apps/desktop`: Tauri + React のデスクトップアプリ置き場
- `crates/core-fetch`: 取得処理
- `crates/core-parse`: `bbsmenu.json` / `subject.txt` / dat パーサ
- `crates/core-store`: 永続化（SQLite/設定）
- `crates/core-auth`: `BE` / `UPLIFT` 認証連携
- `docs`: 仕様・検証記録
- `scripts`: 補助スクリプト
- `data`: ポータブル保存先（実行時利用）

## 最初にやること
1. `docs/5ch_browser_spec.md` を最新化
2. `scripts/validate_5ch_io.py` を実行して到達性を確認
3. Tauri プロジェクト初期化
4. core crate を workspace 化

## Linux ビルド

### 必要なシステムパッケージ

**Debian / Ubuntu:**
```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

**Fedora / RHEL:**
```bash
sudo dnf install webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel patchelf
```

**SUSE Linux Enterprise / openSUSE:**
```bash
sudo zypper install webkit2gtk3-devel gtk3-devel libappindicator3-devel librsvg-devel patchelf
```

### ビルド・実行

```bash
cd apps/desktop
npm install
npm run tauri:dev      # 開発モード
npm run tauri:build    # リリースビルド
```

リリースビルドスクリプト（AppImage / .deb / .rpm を一括生成）:
```bash
bash scripts/build_linux_release.sh
```

### 注意事項
- X11 / Wayland の両方に対応（GTK が自動検出）
- X11 を強制する場合: `GDK_BACKEND=x11 ./ember`
- データは `~/.local/share/Ember/` に保存（`$XDG_DATA_HOME` 準拠）
- カスタムデータディレクトリ: `export EMBER_DATA_DIR=/path/to/dir`
- AppImage の実行: `chmod +x ember_*.AppImage && ./ember_*.AppImage`

## 既定方針
- ZIP 展開で即実行（インストーラーなし）
- 5ch ドメインは `5ch.io` 正規化
- `BE` / `UPLIFT` は MVP 必須

