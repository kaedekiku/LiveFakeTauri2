// 診断スクリプトが Cookie の値・ログイン応答の本文を残さないことの確認 (通信はしない)
// 使い方: node --test scripts/probe_redact.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bodySummary, loginSetCookieRecord, setCookieNames } from './probe_redact.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const VALUE = 'DUMMYVALUE0123456789';

test('Set-Cookie は名前だけを残す (値・属性は残さない)', () => {
  const raw = `form_uid=${VALUE}; Path=/; HttpOnly\nDMDM=${VALUE}2; Domain=.5ch.io; Secure`;
  const rec = loginSetCookieRecord('https://be.5ch.io/_login', raw);
  const out = JSON.stringify(rec);
  assert.ok(!out.includes(VALUE), out);
  assert.ok(!/HttpOnly|Domain=/.test(out), out);
  // 対照: 有無と名前は分かる
  assert.equal(rec.set_cookie_present, true);
  assert.deepEqual(rec.set_cookie_names, ['DMDM', 'form_uid']);
  assert.deepEqual(setCookieNames([`a=${VALUE}`, `b=${VALUE}`]), ['a', 'b']);
  assert.deepEqual(loginSetCookieRecord('u', ''), { url: 'u', set_cookie_present: false, set_cookie_names: [] });
});

test('応答の本文は、長さと NG かどうかだけを残す', () => {
  const out = JSON.stringify(bodySummary(`<html>uid=${VALUE}</html>`));
  assert.ok(!out.includes(VALUE), out);
  assert.deepEqual(bodySummary(' NG\n'), { received: true, length: 4, is_ng: true });
  assert.deepEqual(bodySummary(null), { received: false, length: 0, is_ng: false });
});

test('診断スクリプトが、Set-Cookie の値・応答の本文をそのまま書き出していない', () => {
  const files = fs.readdirSync(here).filter((f) => /^probe_.*\.mjs$/.test(f) && !f.startsWith('probe_redact'));
  assert.ok(files.length >= 5, String(files.length));
  for (const f of files) {
    const src = fs.readFileSync(path.join(here, f), 'utf8');
    // Set-Cookie のヘッダーを、そのままレポートの値にしていない
    assert.ok(!/set_cookie_raw/.test(src), `${f}: set_cookie_raw`);
    assert.ok(!/:\s*setCookie\s*[,}]/.test(src), `${f}: setCookie をそのまま書いている`);
    // 応答の本文を、切り取っただけで書き出していない
    assert.ok(!/(loginPostBody|PostBody)[^\n]*\.slice\(/.test(src), `${f}: 本文を切り取って書いている`);
  }
});
