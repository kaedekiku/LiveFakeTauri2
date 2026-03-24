現在のgit diffをレビューしてください。  

フォーカス: $ARGUMENTS  

手順:  

1. `git diff` (unstaged) と `git diff --cached` (staged) を取得  
2. 変更されたファイルごとに以下のチェックリストで検証:  

**Rust変更がある場合:**  
- `unwrap()` の不適切な使用がないか
- Tauriコマンドの戻り値が `Result<T, String>` か
- Cookie/認証データがINFO以上でログ出力されていないか
- URLが `normalize_5ch_url()` を通しているか
- `reqwest::Client::builder()` に `.timeout()` があるか
- 新規コマンドが `generate_handler![]` に登録されているか

**TypeScript変更がある場合:**  
- `invoke()` が `isTauriRuntime()` ガード内か
- localStorageキーが `desktop.` プレフィックスか
- 新規npm依存が追加されていないか
- `.catch(() => {})` が使われていないか
- `dangerouslySetInnerHTML` の値がサニタイズ済みか

**共通:**  
- シークレットがコミットに含まれていないか
- 新規UI機能にスモークテストがあるか

深刻度を `[重大]` `[警告]` `[軽微]` で分類して報告すること。  
