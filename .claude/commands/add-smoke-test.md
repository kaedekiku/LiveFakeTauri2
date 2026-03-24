スモークテストケースを追加してください。  

テスト対象: $ARGUMENTS  

`apps/desktop/scripts/smoke_ui_playwright.mjs` に新しいアサーションを追加する。  

手順:  

1. 既存テストのパターンを確認して、同じスタイルで追加  
2. テストは静的な `dist/index.html` をPlaywright (headless Chromium) で開いて検証する  
   - Tauri IPC は使えない — DOM構造・CSS・表示テキストの検証のみ
3. `assert(condition, "説明メッセージ")` 形式を使用  
4. テスト追加後、`cd apps/desktop && npm run build && bash scripts/run_smoke_ui.sh` で動作確認  

テストが失敗する場合は原因を分析して修正すること。  
