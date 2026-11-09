// 利用者の正規表現 (NG・読み上げの無音にする語・配信ホワイトリストの自動追加の語など) を、画面とは別のスレッドで実行する。
// 書き方によっては時間がかかるため、画面の中では実行しない。時間がかかりすぎたときは、呼ぶ側がこの Worker ごと止める。
// ここでは結果を返すだけで、外部とは通信しない
self.onmessage = (event) => {
  const data = event.data || {};
  const id = data.id;
  const op = data.op;
  const texts = Array.isArray(data.texts) ? data.texts : [];
  let re = null;
  try {
    re = new RegExp(String(data.source), String(data.flags || ""));
  } catch {
    // 書き方の誤りは「一致しない」「置き換えない」として返す (今までと同じ扱い)
    re = null;
  }
  const results = texts.map((t) => {
    const s = String(t);
    if (!re) return op === "replace" ? s : false;
    if (op === "test") {
      re.lastIndex = 0;
      return re.test(s);
    }
    // 画像URL置換: 一致すれば置き換えた文字列、一致しなければ false
    if (op === "rewrite") {
      re.lastIndex = 0;
      if (!re.test(s)) return false;
      re.lastIndex = 0;
      return s.replace(re, String(data.replacement ?? ""));
    }
    return s.replace(re, "");
  });
  self.postMessage({ id, results });
};
