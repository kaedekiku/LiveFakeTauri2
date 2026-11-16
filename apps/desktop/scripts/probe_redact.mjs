// 診断スクリプト (probe_*.mjs) がレポートと端末に出すものから、値を落とすための関数。
// レポートは docs/ に書かれ、リポジトリに入ることがあるので、Cookie の値・ログイン応答の本文は残さない
// (残すのは、Cookie の名前・有無と、本文の長さ・「NG」かどうかまで)

/** Set-Cookie ヘッダー (複数あるときは改行でつながっている・または配列) から、Cookie の名前だけを取り出す */
export function setCookieNames(raw) {
  if (!raw) return [];
  const lines = Array.isArray(raw) ? raw : String(raw).split(/\r?\n/);
  const names = lines.map((line) => String(line).split(';')[0].split('=')[0].trim()).filter(Boolean);
  return [...new Set(names)].sort();
}

/** ログイン応答の Set-Cookie の記録 (どのアドレスの応答に、どの名前の Cookie があったか) */
export function loginSetCookieRecord(url, raw) {
  const names = setCookieNames(raw);
  return { url, set_cookie_present: names.length > 0, set_cookie_names: names };
}

/** 応答の本文の記録 (中身は残さない) */
export function bodySummary(text) {
  if (text == null) return { received: false, length: 0, is_ng: false };
  const s = String(text);
  return { received: true, length: s.length, is_ng: s.trim() === 'NG' };
}
