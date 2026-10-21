//! YouTube のチャットへの書き込み (Google アカウントでのログインと、liveChatMessages.insert)
//!
//! - ログインは利用者が自分の Google Cloud プロジェクトで作った OAuth クライアント (種類:「テレビと入力が限られたデバイス」) で行う。
//!   LiveFake にクライアントを埋め込まない (埋め込むと全利用者で1つのクォータを分け合うことになるため)。
//!   方式はデバイスコード方式 (画面に出たコードをブラウザで入力する。PC で待ち受けはしない)
//! - 求める許可は `https://www.googleapis.com/auth/youtube` (チャットへの書き込みに要る。デバイスコード方式で使える YouTube の許可はこれと読み取り専用だけ)。
//!   この許可はチャンネルの管理全体に及ぶので、トークンは Windows の DPAPI で暗号化して data/youtube-auth.bin に保存し、
//!   画面にもログにも出さない。クライアント ID・シークレットも data/youtube-oauth-client.bin に暗号化して保存する (暗号化できないときは保存しない)
//! - 接続先は oauth2.googleapis.com と www.googleapis.com だけ。ログアウトでは Google 側の許可も取り消す
//! - 書き込み先は、開いている (受信中の) YouTube タブの配信だけ。チャットの ID は Rust 側で動画から調べる (画面から受け取らない)
//! - 使ったクォータ (チャンネルの確認 1・チャットの ID 1・書き込み 20) は受信と同じ帳簿に数える
//! - 本文はログに残さない

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const SCOPE: &str = "https://www.googleapis.com/auth/youtube";
const DEVICE_URL: &str = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const API_BASE: &str = "https://www.googleapis.com/youtube/v3";
/// 1件の長さの上限 (YouTube のチャットの決まり)
pub const CHAT_MAX_CHARS: usize = 200;
/// 続けて送るときの間隔の下限 (連打の防止)
const SEND_GAP: Duration = Duration::from_secs(2);
/// 書き込み1回で使うクォータ
pub const COST_INSERT: u32 = 20;
const COST_CHANNELS_LIST: u32 = 1;
const COST_VIDEOS_LIST: u32 = 1;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn data_path(name: &str) -> Option<std::path::PathBuf> {
    core_store::portable_data_dir().ok().map(|d| d.join(name))
}

/// 暗号化して保存する (暗号化できないときは保存しない)
fn save_protected(name: &str, plain: &str, what: &str) -> Result<(), String> {
    let enc = core_proxy::protect_password(plain);
    if !enc.starts_with("dpapi:") {
        return Err(format!("{what}を暗号化できなかったため、保存しませんでした"));
    }
    let path = data_path(name).ok_or("データフォルダが見つかりません")?;
    let tmp = path.with_extension("bin.tmp");
    std::fs::write(&tmp, enc).map_err(|e| format!("保存できませんでした: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("保存できませんでした: {e}"))
}

fn load_protected(name: &str) -> Option<String> {
    let stored = std::fs::read_to_string(data_path(name)?).ok()?;
    if !stored.starts_with("dpapi:") {
        return None;
    }
    Some(core_proxy::unprotect_password(stored.trim()))
}

fn remove_file(name: &str) {
    if let Some(p) = data_path(name) {
        let _ = std::fs::remove_file(p);
    }
}

const CLIENT_FILE: &str = "youtube-oauth-client.bin";
const AUTH_FILE: &str = "youtube-auth.bin";

/// 利用者が作った OAuth クライアント
#[derive(Clone, Serialize, Deserialize)]
struct Client {
    id: String,
    secret: String,
}

/// クライアント ID の形 (xxxx.apps.googleusercontent.com)
pub fn client_id_ok(s: &str) -> bool {
    s.len() <= 200
        && s.ends_with(".apps.googleusercontent.com")
        && s.len() > ".apps.googleusercontent.com".len()
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
}

/// クライアントシークレットの形 (英数字と - _ の 10〜100 文字)
pub fn client_secret_ok(s: &str) -> bool {
    (10..=100).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct AuthData {
    access_token: String,
    refresh_token: String,
    /// アクセストークンの期限 (UNIX 秒)
    expires_at: u64,
    /// 発行を受けたクライアント ID (クライアントを変えたら使わない)
    client_id: String,
    channel_id: String,
    channel_title: String,
}

/// 画面に出す状態 (トークン・シークレットは含めない)
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    /// OAuth クライアントを設定済みか
    pub client_set: bool,
    pub logged_in: bool,
    /// 書き込むチャンネル (表示名)
    pub channel_title: String,
    /// "none" / "waiting" (コード入力待ち) / "ready" / "error"
    pub state: String,
    pub message: String,
    pub user_code: String,
    pub verification_uri: String,
}

/// 書き込んだ発言 (自分の書き込みをすぐタブに出すため)
pub struct Sent {
    pub id: String,
    pub channel_id: String,
    pub name: String,
    pub text: String,
}

#[derive(Default)]
pub struct YoutubeAuthState(Arc<Inner>);

#[derive(Default)]
struct Inner {
    app: Mutex<Option<AppHandle>>,
    http: Mutex<Option<reqwest::Client>>,
    client: Mutex<Option<Client>>,
    auth: Mutex<Option<AuthData>>,
    status: Mutex<AuthStatus>,
    login_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// 動画 ID → チャットの ID (書き込み先)
    chat_ids: Mutex<HashMap<String, String>>,
    last_sent: Mutex<Option<Instant>>,
    /// 書き込み中 (同時に2つ送らない)
    sending: Mutex<bool>,
}

/// Google の OAuth のエラー応答 ("error" と "error_description")
fn oauth_error(body: &[u8]) -> (String, String) {
    let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let clean = |s: &str| s.chars().filter(|c| !c.is_control()).take(160).collect::<String>();
    (clean(v["error"].as_str().unwrap_or("")), clean(v["error_description"].as_str().unwrap_or("")))
}

fn client_error_hint(code: &str, desc: &str) -> String {
    let d = desc.to_ascii_lowercase();
    if d.contains("client type") || code == "unauthorized_client" {
        "クライアントの種類が「テレビと入力が限られたデバイス」ではありません。Google Cloud で作り直してください".into()
    } else if code == "invalid_client" {
        "クライアント ID かシークレットが違います (設定 > YouTube > 書き込み で入れ直してください)".into()
    } else if code == "invalid_scope" || d.contains("scope") {
        "求めた許可が受け付けられませんでした (YouTube Data API v3 が有効か確かめてください)".into()
    } else if code == "access_denied" {
        "ログインが取り消されたか、テストユーザーに入っていないアカウントです (同意画面の「テストユーザー」に自分を追加してください)".into()
    } else if desc.is_empty() {
        format!("Google がエラーを返しました ({code})")
    } else {
        format!("Google がエラーを返しました ({code}: {desc})")
    }
}

/// 書き込みの API のエラーを利用者向けの文にする
fn send_error(status: u16, body: &[u8]) -> (String, bool) {
    let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let err = &v["error"];
    let reasons: Vec<&str> = [&err["errors"], &err["details"]].iter().filter_map(|l| l.as_array()).flatten().filter_map(|e| e["reason"].as_str()).collect();
    let has = |r: &str| reasons.iter().any(|x| x.eq_ignore_ascii_case(r));
    let quota = has("quotaExceeded") || has("dailyLimitExceeded");
    let msg = if quota {
        "今日の API の上限 (クォータ) に達しているため送れませんでした".to_string()
    } else if has("liveChatEnded") {
        "配信のチャットが終わっているため送れませんでした".into()
    } else if has("liveChatDisabled") {
        "この配信はチャットがオフになっています".into()
    } else if has("liveChatNotFound") {
        "チャットが見つかりません (配信が終わったか、削除されました)".into()
    } else if has("rateLimitExceeded") || status == 429 {
        "書き込みが多すぎると言われました。少し待ってから送ってください".into()
    } else if has("messageTextInvalid") {
        "この本文は送れないと言われました".into()
    } else if has("insufficientPermissions") || has("ACCESS_TOKEN_SCOPE_INSUFFICIENT") {
        "書き込みの許可がありません。ログインし直してください".into()
    } else if status == 403 {
        "このチャットに書き込めませんでした (ブロック・タイムアウト中、またはメンバー・登録者限定などのチャットの設定のため)".into()
    } else {
        let m: String = err["message"].as_str().unwrap_or("").chars().filter(|c| !c.is_control()).take(160).collect();
        if m.is_empty() { format!("送れませんでした (HTTP {status})") } else { format!("送れませんでした (HTTP {status}: {m})") }
    };
    (msg, quota)
}

impl YoutubeAuthState {
    /// 起動時に1回: 保存済みのクライアント・ログイン情報を読む
    pub fn init(&self, app: AppHandle) {
        *lock(&self.0.app) = Some(app);
        let client = load_protected(CLIENT_FILE).and_then(|t| serde_json::from_str::<Client>(&t).ok()).filter(|c| client_id_ok(&c.id) && client_secret_ok(&c.secret));
        let auth = load_protected(AUTH_FILE).and_then(|t| serde_json::from_str::<AuthData>(&t).ok());
        // 別のクライアントで発行されたログイン情報は使わない
        let auth = auth.filter(|a| client.as_ref().is_some_and(|c| c.id == a.client_id));
        let (client_set, logged_in, title) = (client.is_some(), auth.is_some(), auth.as_ref().map(|a| a.channel_title.clone()).unwrap_or_default());
        *lock(&self.0.client) = client;
        *lock(&self.0.auth) = auth;
        self.0.set_status(|s| {
            s.client_set = client_set;
            s.logged_in = logged_in;
            s.channel_title = title;
            s.state = if logged_in { "ready".into() } else { "none".into() };
        });
    }

    pub fn status(&self) -> AuthStatus {
        lock(&self.0.status).clone()
    }

    /// OAuth クライアントを保存する (変えたらログアウトする)
    pub async fn set_client(&self, id: String, secret: String) -> Result<AuthStatus, String> {
        let (id, secret) = (id.trim().to_string(), secret.trim().to_string());
        if !client_id_ok(&id) {
            return Err("クライアント ID の形が違います (…apps.googleusercontent.com で終わる文字列です)".into());
        }
        if !client_secret_ok(&secret) {
            return Err("クライアント シークレットの形が違います".into());
        }
        let c = Client { id, secret };
        save_protected(CLIENT_FILE, &serde_json::to_string(&c).map_err(|e| e.to_string())?, "クライアントの情報")?;
        let changed = lock(&self.0.client).as_ref().is_none_or(|old| old.id != c.id);
        *lock(&self.0.client) = Some(c);
        if changed {
            self.0.logout().await;
        }
        self.0.set_status(|s| s.client_set = true);
        self.0.log("oauth client saved");
        Ok(self.status())
    }

    /// OAuth クライアントを削除する (ログアウトもする)
    pub async fn clear_client(&self) -> AuthStatus {
        self.0.logout().await;
        *lock(&self.0.client) = None;
        remove_file(CLIENT_FILE);
        self.0.set_status(|s| s.client_set = false);
        self.0.log("oauth client removed");
        self.status()
    }

    pub async fn start_login(&self, quota: Arc<dyn core_youtube::QuotaPlan>) -> Result<AuthStatus, String> {
        Inner::start_login(&self.0, quota).await
    }

    pub async fn logout(&self) -> AuthStatus {
        self.0.logout().await;
        self.status()
    }

    /// チャットに書き込む (送り先の配信が開いているタブかどうかは呼ぶ側で確かめる)
    pub async fn send_chat(&self, video: &str, text: &str, quota: Arc<dyn core_youtube::QuotaPlan>) -> Result<Sent, String> {
        Inner::send_chat(&self.0, video, text, quota).await
    }
}

impl Inner {
    fn http(&self) -> reqwest::Client {
        lock(&self.http)
            .get_or_insert_with(|| reqwest::Client::builder().timeout(Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none()).build().unwrap_or_default())
            .clone()
    }

    fn set_status(&self, f: impl FnOnce(&mut AuthStatus)) {
        let st = {
            let mut s = lock(&self.status);
            f(&mut s);
            s.clone()
        };
        if let Some(app) = lock(&self.app).as_ref() {
            let _ = app.emit("youtube-auth", st);
        }
    }

    fn log(&self, msg: &str) {
        let _ = core_store::append_log(&format!("youtube-auth: {msg}"));
    }

    fn client(&self) -> Result<Client, String> {
        lock(&self.client).clone().ok_or_else(|| "OAuth クライアントが設定されていません (設定 > YouTube > 書き込み)".into())
    }

    async fn start_login(self: &Arc<Self>, quota: Arc<dyn core_youtube::QuotaPlan>) -> Result<AuthStatus, String> {
        let c = self.client()?;
        let r = self
            .http()
            .post(DEVICE_URL)
            .form(&[("client_id", c.id.as_str()), ("scope", SCOPE)])
            .send()
            .await
            .map_err(|e| format!("Google に接続できません: {}", e.without_url()))?;
        let status = r.status().as_u16();
        let body = r.bytes().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            let (code, desc) = oauth_error(&body);
            return Err(format!("ログインを始められません: {}", client_error_hint(&code, &desc)));
        }
        let v: Value = serde_json::from_slice(&body).map_err(|_| "応答の形式が違います")?;
        let device_code = v["device_code"].as_str().filter(|s| !s.is_empty() && s.len() <= 512).ok_or("応答の形式が違います")?.to_string();
        let user_code: String = v["user_code"].as_str().unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(32).collect();
        let uri = v["verification_url"].as_str().or_else(|| v["verification_uri"].as_str()).unwrap_or("").to_string();
        // 開くのは Google の確認ページだけ (偽のページへ誘導されないように)
        if !(uri == "https://www.google.com/device" || uri.starts_with("https://www.google.com/device?")) || user_code.is_empty() {
            return Err("想定外のログインページが返されたため中止しました".into());
        }
        let interval = v["interval"].as_u64().unwrap_or(5).clamp(1, 30);
        let expires = v["expires_in"].as_u64().unwrap_or(1800).min(1800);
        self.set_status(|s| {
            s.state = "waiting".into();
            s.message = "ブラウザで Google にログインし、表示されたコードを入力して許可してください".into();
            s.user_code = user_code.clone();
            s.verification_uri = uri.clone();
        });
        let me = Arc::clone(self);
        let task = tauri::async_runtime::spawn(async move { me.poll_login(c, device_code, interval, expires, quota).await });
        if let Some(old) = lock(&self.login_task).replace(task) {
            old.abort();
        }
        Ok(lock(&self.status).clone())
    }

    fn login_failed(&self, msg: String) {
        self.set_status(|s| {
            s.state = "error".into();
            s.message = msg;
            s.user_code.clear();
            s.verification_uri.clear();
        });
    }

    async fn poll_login(self: Arc<Self>, c: Client, device_code: String, mut interval: u64, expires: u64, quota: Arc<dyn core_youtube::QuotaPlan>) {
        let deadline = now() + expires;
        let http = self.http();
        while now() < deadline {
            tokio::time::sleep(Duration::from_secs(interval)).await;
            let r = http
                .post(TOKEN_URL)
                .form(&[
                    ("client_id", c.id.as_str()),
                    ("client_secret", c.secret.as_str()),
                    ("device_code", device_code.as_str()),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ])
                .send()
                .await;
            let Ok(r) = r else { continue };
            let ok = r.status().is_success();
            let body = r.bytes().await.unwrap_or_default();
            if !ok {
                let (code, desc) = oauth_error(&body);
                match code.as_str() {
                    "authorization_pending" => continue,
                    "slow_down" => {
                        interval = (interval + 5).min(60);
                        continue;
                    }
                    "expired_token" => return self.login_failed("時間切れになりました。もう一度ログインしてください".into()),
                    _ => return self.login_failed(client_error_hint(&code, &desc)),
                }
            }
            let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let access = v["access_token"].as_str().unwrap_or("").to_string();
            let refresh = v["refresh_token"].as_str().unwrap_or("").to_string();
            let granted = v["scope"].as_str().unwrap_or("");
            if access.is_empty() || refresh.is_empty() {
                return self.login_failed("ログインの応答の形式が違います".into());
            }
            if !granted.split_whitespace().any(|s| s == SCOPE) {
                return self.login_failed("YouTube の許可が与えられませんでした (許可の画面で YouTube の項目にチェックを入れてください)".into());
            }
            let expires_at = now() + v["expires_in"].as_u64().unwrap_or(3600).min(86_400);
            match channel_of(&http, &access, quota.as_ref()).await {
                Ok((channel_id, channel_title)) => {
                    let a = AuthData { access_token: access, refresh_token: refresh, expires_at, client_id: c.id.clone(), channel_id, channel_title: channel_title.clone() };
                    let save_note = serde_json::to_string(&a).map_err(|e| e.to_string()).and_then(|t| save_protected(AUTH_FILE, &t, "ログイン情報")).err();
                    *lock(&self.auth) = Some(a);
                    self.set_status(|s| {
                        s.logged_in = true;
                        s.channel_title = channel_title;
                        s.state = "ready".into();
                        s.message = save_note.map(|m| format!("{m} (次回の起動ではログインし直しになります)")).unwrap_or_default();
                        s.user_code.clear();
                        s.verification_uri.clear();
                    });
                    self.log("logged in");
                }
                Err(e) => {
                    // 使えないトークンは取り消しておく
                    let _ = http.post(REVOKE_URL).form(&[("token", access.as_str())]).send().await;
                    self.login_failed(e);
                }
            }
            return;
        }
        self.login_failed("時間切れになりました。もう一度ログインしてください".into());
    }

    /// ログアウト (Google 側の許可も取り消し、保存した情報を消す)
    async fn logout(&self) {
        if let Some(t) = lock(&self.login_task).take() {
            t.abort();
        }
        let a = lock(&self.auth).take();
        if let Some(a) = a {
            let _ = self.http().post(REVOKE_URL).form(&[("token", a.refresh_token.as_str())]).send().await;
            self.log("logged out");
        }
        remove_file(AUTH_FILE);
        lock(&self.chat_ids).clear();
        let client_set = lock(&self.client).is_some();
        self.set_status(|s| *s = AuthStatus { client_set, state: "none".into(), ..Default::default() });
    }

    /// 期限が近ければ更新したアクセストークンを返す
    async fn valid_token(&self, force_refresh: bool) -> Result<String, String> {
        let a = lock(&self.auth).clone().ok_or("YouTube に書き込むには、設定 > YouTube > 書き込み でログインしてください")?;
        if !force_refresh && a.expires_at > now() + 60 {
            return Ok(a.access_token);
        }
        let c = self.client()?;
        let r = self
            .http()
            .post(TOKEN_URL)
            .form(&[("client_id", c.id.as_str()), ("client_secret", c.secret.as_str()), ("refresh_token", a.refresh_token.as_str()), ("grant_type", "refresh_token")])
            .send()
            .await
            .map_err(|e| format!("Google に接続できません: {}", e.without_url()))?;
        let status = r.status().as_u16();
        let body = r.bytes().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            let (code, _) = oauth_error(&body);
            if code == "invalid_grant" || code == "invalid_client" || code == "unauthorized_client" {
                // 取り消された・期限切れ (同意画面が「テスト」のままだと 7 日で切れる)
                *lock(&self.auth) = None;
                remove_file(AUTH_FILE);
                let msg = "ログインの期限が切れたか、取り消されました。もう一度ログインしてください (同意画面が「テスト」のままだと 7 日で切れます)".to_string();
                let client_set = lock(&self.client).is_some();
                self.set_status(|s| *s = AuthStatus { client_set, state: "error".into(), message: msg.clone(), ..Default::default() });
                self.log("token expired or revoked");
                return Err(msg);
            }
            return Err(format!("ログインを更新できませんでした (HTTP {status})"));
        }
        let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let access = v["access_token"].as_str().filter(|s| !s.is_empty()).ok_or("ログインの更新の応答の形式が違います")?.to_string();
        let expires_at = now() + v["expires_in"].as_u64().unwrap_or(3600).min(86_400);
        let saved = {
            let mut g = lock(&self.auth);
            let Some(cur) = g.as_mut() else { return Err("ログアウトしました".into()) };
            cur.access_token = access.clone();
            cur.expires_at = expires_at;
            if let Some(rt) = v["refresh_token"].as_str().filter(|s| !s.is_empty()) {
                cur.refresh_token = rt.to_string();
            }
            cur.clone()
        };
        if let Ok(t) = serde_json::to_string(&saved) {
            let _ = save_protected(AUTH_FILE, &t, "ログイン情報");
        }
        Ok(access)
    }

    /// 動画のチャットの ID (覚えていなければ videos.list で調べる)
    async fn chat_id(&self, video: &str, token: &str, quota: &dyn core_youtube::QuotaPlan) -> Result<String, String> {
        if let Some(id) = lock(&self.chat_ids).get(video).cloned() {
            return Ok(id);
        }
        let r = self
            .http()
            .get(format!("{API_BASE}/videos"))
            .query(&[("part", "liveStreamingDetails"), ("id", video), ("fields", "items(liveStreamingDetails(activeLiveChatId))")])
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("YouTube に接続できません: {}", e.without_url()))?;
        quota.charge(COST_VIDEOS_LIST);
        let status = r.status().as_u16();
        let body = r.bytes().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(send_error(status, &body).0);
        }
        let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let id = v["items"][0]["liveStreamingDetails"]["activeLiveChatId"].as_str().unwrap_or("");
        if id.is_empty() || id.len() > 256 || !id.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("この配信のチャットが見つかりません (配信が終わったか、チャットがオフです)".into());
        }
        let mut g = lock(&self.chat_ids);
        if g.len() > 50 {
            g.clear();
        }
        g.insert(video.to_string(), id.to_string());
        Ok(id.to_string())
    }

    async fn send_chat(self: &Arc<Self>, video: &str, text: &str, quota: Arc<dyn core_youtube::QuotaPlan>) -> Result<Sent, String> {
        let text: String = text.chars().map(|c| if c == '\n' || c == '\r' { ' ' } else { c }).filter(|c| !c.is_control()).collect();
        let text = text.trim().to_string();
        let n = text.chars().count();
        if n == 0 {
            return Err("本文が空です".into());
        }
        if n > CHAT_MAX_CHARS {
            return Err(format!("長すぎます ({CHAT_MAX_CHARS} 文字まで)"));
        }
        {
            let mut sending = lock(&self.sending);
            if *sending {
                return Err("前の書き込みを送っているところです".into());
            }
            if lock(&self.last_sent).is_some_and(|t| t.elapsed() < SEND_GAP) {
                return Err("続けて送るときは 2 秒あけてください".into());
            }
            *sending = true;
        }
        let result = self.send_inner(video, &text, quota.as_ref()).await;
        *lock(&self.last_sent) = Some(Instant::now());
        *lock(&self.sending) = false;
        if result.is_ok() {
            self.log("message sent");
        }
        result
    }

    async fn send_inner(&self, video: &str, text: &str, quota: &dyn core_youtube::QuotaPlan) -> Result<Sent, String> {
        let mut token = self.valid_token(false).await?;
        let chat_id = self.chat_id(video, &token, quota).await?;
        let body = json!({ "snippet": { "liveChatId": chat_id, "type": "textMessageEvent", "textMessageDetails": { "messageText": text } } });
        for attempt in 0..2 {
            let r = self
                .http()
                .post(format!("{API_BASE}/liveChat/messages"))
                .query(&[("part", "snippet")])
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("YouTube に接続できません (送れたか分かりません。チャットを確かめてください): {}", e.without_url()))?;
            let status = r.status().as_u16();
            let resp = r.bytes().await.unwrap_or_default();
            if status == 401 && attempt == 0 {
                // アクセストークンの期限切れ (送られていない)。更新して1回だけやり直す
                token = self.valid_token(true).await?;
                continue;
            }
            quota.charge(COST_INSERT);
            if !(200..300).contains(&status) {
                let (msg, exhausted) = send_error(status, &resp);
                if exhausted {
                    quota.exhausted();
                }
                if status == 404 || msg.contains("終わって") {
                    lock(&self.chat_ids).remove(video);
                }
                return Err(msg);
            }
            let v: Value = serde_json::from_slice(&resp).unwrap_or(Value::Null);
            let (channel_id, name) = lock(&self.auth).as_ref().map(|a| (a.channel_id.clone(), a.channel_title.clone())).unwrap_or_default();
            let sn = &v["snippet"];
            let shown = sn["textMessageDetails"]["messageText"].as_str().or_else(|| sn["displayMessage"].as_str()).unwrap_or(text);
            return Ok(Sent {
                id: v["id"].as_str().unwrap_or("").to_string(),
                channel_id: sn["authorChannelId"].as_str().map(str::to_string).unwrap_or(channel_id),
                name,
                text: shown.to_string(),
            });
        }
        Err("送れませんでした (ログインを確かめてください)".into())
    }
}

/// ログインしたアカウントのチャンネル (ID と表示名)
async fn channel_of(http: &reqwest::Client, token: &str, quota: &dyn core_youtube::QuotaPlan) -> Result<(String, String), String> {
    let r = http
        .get(format!("{API_BASE}/channels"))
        .query(&[("part", "snippet"), ("mine", "true"), ("fields", "items(id,snippet(title))")])
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("YouTube に接続できません: {}", e.without_url()))?;
    quota.charge(COST_CHANNELS_LIST);
    let status = r.status().as_u16();
    let body = r.bytes().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let reason = v["error"]["errors"][0]["reason"].as_str().unwrap_or("");
        if reason == "accessNotConfigured" || reason == "SERVICE_DISABLED" {
            return Err("このプロジェクトで YouTube Data API v3 が有効になっていません".into());
        }
        return Err(format!("チャンネルを確かめられませんでした (HTTP {status})"));
    }
    let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let item = &v["items"][0];
    let id = core_youtube_channel_id(item["id"].as_str().unwrap_or(""));
    if id.is_empty() {
        return Err("このアカウントには YouTube チャンネルがありません (チャットに書き込むにはチャンネルが要ります)".into());
    }
    let title: String = item["snippet"]["title"].as_str().unwrap_or("").chars().filter(|c| !c.is_control()).take(100).collect();
    Ok((id, if title.is_empty() { "(名前なし)".into() } else { title }))
}

/// チャンネル ID の形 (UC + 22 文字)。違えば空
fn core_youtube_channel_id(s: &str) -> String {
    let ok = s.len() == 24 && s.starts_with("UC") && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok { s.to_string() } else { String::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_shapes() {
        assert!(client_id_ok("123456789012-abcdefghijklmnop.apps.googleusercontent.com"));
        assert!(!client_id_ok(".apps.googleusercontent.com"));
        assert!(!client_id_ok("123.apps.googleusercontent.com.evil.example"));
        assert!(!client_id_ok("12 3.apps.googleusercontent.com"));
        assert!(client_secret_ok("GOCSPX-abcdefghijklmnopqrstuvwx"));
        assert!(!client_secret_ok("short"));
        assert!(!client_secret_ok("GOCSPX abc defghijkl"));
    }

    #[test]
    fn send_errors() {
        let body = |reason: &str| json!({ "error": { "code": 403, "message": "x", "errors": [{ "reason": reason }] } }).to_string().into_bytes();
        assert!(send_error(403, &body("quotaExceeded")).1);
        assert!(send_error(403, &body("liveChatEnded")).0.contains("終わって"));
        assert!(send_error(403, &body("forbidden")).0.contains("書き込めません"));
        assert!(send_error(429, &body("rateLimitExceeded")).0.contains("多すぎ"));
        assert!(!send_error(400, &body("messageTextInvalid")).1);
    }

    #[test]
    fn oauth_errors() {
        let (code, _) = oauth_error(br#"{"error":"authorization_pending","error_description":"Precondition Required"}"#);
        assert_eq!(code, "authorization_pending");
        assert!(client_error_hint("invalid_client", "Invalid client type.").contains("テレビ"));
        assert!(client_error_hint("invalid_client", "The OAuth client was not found.").contains("違います"));
        assert!(client_error_hint("access_denied", "").contains("テストユーザー"));
        assert_eq!(core_youtube_channel_id("UCabcdefghijklmnopqrstuv"), "UCabcdefghijklmnopqrstuv");
        assert_eq!(core_youtube_channel_id("UC<x>"), "");
    }
}
