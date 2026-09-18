#!/usr/bin/env node
// PostToolUse(Edit|Write) hook: App.tsx を編集した際、SIKI互換のエイリアスクラス名
// (docs/CSS_CUSTOMIZE.md 記載) が誤って消えていないかを確認する。
// 書き込みウィンドウの再設計時に .postform-foot を誤って落とした事故の再発防止。
const REQUIRED_CLASSES = ["postform-foot", "postform-write"];

let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input);
    const filePath = payload.tool_input && payload.tool_input.file_path;
    if (!filePath || !/App\.tsx$/.test(filePath)) return;

    const fs = require("fs");
    if (!fs.existsSync(filePath)) return;
    const source = fs.readFileSync(filePath, "utf8");

    const missing = REQUIRED_CLASSES.filter((cls) => !source.includes(cls));
    if (missing.length > 0) {
      console.log(
        "警告: SIKI互換クラス " + missing.map((c) => "'" + c + "'").join(", ") +
        " が " + filePath + " から見つかりません(docs/CSS_CUSTOMIZE.mdのSIKI互換対応表を参照)。"
      );
    }
  } catch (e) {
    // 入力の解析に失敗した場合は何もしない(フックが原因で編集をブロックしない)
  }
});
