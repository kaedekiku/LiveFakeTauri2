# Phase 4: ハイライト・コンテキストメニュー

REQUIREMENTS.md の §16 を参照。

## 4-1. 15色パレット + ハイライトJSON

### 色定義
```typescript
const HIGHLIGHT_COLORS = [
  { name: "赤",     color: "#FF0000" },
  { name: "橙",     color: "#FF8000" },
  { name: "金",     color: "#FFD700" },
  { name: "黄緑",   color: "#00FF00" },
  { name: "緑",     color: "#00CC00" },
  { name: "水色",   color: "#00FFFF" },
  { name: "空色",   color: "#0080FF" },
  { name: "青",     color: "#0000FF" },
  { name: "紫",     color: "#8000FF" },
  { name: "ピンク", color: "#FF00FF" },
  { name: "桃",     color: "#FF69B4" },
  { name: "茶",     color: "#A0522D" },
  { name: "灰",     color: "#808080" },
  { name: "黒",     color: "#000000" },
  { name: "白",     color: "#FFFFFF" }
];
```

### データファイル

**id-highlights.json**
```json
{
  "date": "2026-04-08",
  "highlights": {
    "abcdef0": "#FF0000",
    "xyz1234": "#0000FF"
  }
}
```
- `date` が今日でなければ全消去（日別リセット）

**text-highlights.json**
```json
[
  { "pattern": "キーワード", "color": "#FFD700", "type": "word" },
  { "pattern": "名無しさん", "color": "#00CC00", "type": "name" }
]
```

### Tauri コマンド
- `load_id_highlights` / `save_id_highlights`
- `load_text_highlights` / `save_text_highlights`
- core-store の JSON 永続化を使うか、独立ファイルで管理

---

## 4-2. 右クリックコンテキストメニュー

### 実装箇所
- `apps/desktop/src/App.tsx` のレス表示エリアに `onContextMenu` ハンドラを追加
- メニューコンポーネントを React で実装（絶対配置 div）

### 表示条件（REQUIREMENTS §16.2）

```typescript
function buildContextMenuItems(e: React.MouseEvent): MenuItem[] {
  const selection = window.getSelection()?.toString().trim() || '';
  const resEl = (e.target as HTMLElement).closest('[data-res-id]');
  const id = resEl?.getAttribute('data-res-id') || null;
  const nameEl = (e.target as HTMLElement).closest('.res-name');
  const name = nameEl?.textContent?.trim() || null;

  const items: MenuItem[] = [];

  if (selection) {
    items.push({
      label: `「${selection.slice(0, 20)}」をハイライト`,
      type: 'text-highlight', value: selection,
      submenu: HIGHLIGHT_COLORS
    });
  }
  if (id) {
    items.push({
      label: `ID:${id} をハイライト`,
      type: 'id-highlight', value: id,
      submenu: HIGHLIGHT_COLORS
    });
  }
  if (name) {
    items.push({
      label: `名前「${name.slice(0, 15)}」をハイライト`,
      type: 'name-highlight', value: name,
      submenu: HIGHLIGHT_COLORS
    });
  }
  // 解除（既存ハイライトがある場合）
  // セパレーター
  // トグル: オートリロード / オートスクロール / 読み上げ
  return items;
}
```

### 色サブメニュー
- 親項目ホバーで右側に 5×3 グリッドを展開
- 各セルは色付き正方形（20×20px）、ホバーで色名ツールチップ
- クリックで即時適用 → メニュー閉じる

### メニュー閉じ処理
- メニュー外クリック / Escape キー / 項目選択

---

## 4-3. ハイライト即時反映 + 字幕同期

### レスレンダリングへの反映
- レス描画関数内で `idHighlights` / `textHighlights` を参照
- ID一致 → ヘッダーの ID 部分の `color` を設定色に
- テキスト一致 → `<span style="background:色">` で囲む
- 名前一致 → 名前フィールドに背景色適用

### 字幕ウィンドウ同期
- ハイライト変更時に Tauri event でハイライトデータを字幕ウィンドウに送信
- 字幕側でも同じハイライトロジックを適用
