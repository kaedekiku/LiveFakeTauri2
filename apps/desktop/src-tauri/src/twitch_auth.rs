//! Twitch ログイン (デバイスコード方式) と EventSub (WebSocket)。TchViewer の eventsub.rs を移植
//!
//! チャットの流れ (IRC) に届かないもの (入力の無いチャンネルポイント報酬・自動報酬・フォロー) を受け取る。
//! - ログイン: 公開型クライアントのデバイスコード方式 (クライアントシークレットは使わない)
//!   求める許可は読み取りだけ: channel:read:redemptions (報酬の引き換え) / moderator:read:followers (フォロー)
//! - 受け取れるのはログインしたアカウント自身のチャンネルのイベントだけ (配信者本人向け)
//! - ログイン情報は Windows の DPAPI で暗号化して data/twitch-auth.bin に保存 (同じ PC・同じ Windows ユーザーでだけ復号できる)。
//!   暗号化できないときは保存しない。画面側にトークンは渡さず、ログにも書かない
//! - 接続先は id.twitch.tv / api.twitch.tv / eventsub.wss.twitch.tv だけ。接続先の変更指示も同じホストのときだけ従う
//! - 通知は message_id で重複を除き、10分より古い通知は捨てる

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::Message;

/// LiveFake の公開型クライアント ID (秘密の値ではない。dev.twitch.tv で「公開」として登録したもの)
pub const CLIENT_ID: &str = "hctqgizcwg8scjj9tsh47bs162uy2q";
/// 求める許可: 報酬の引き換え・フォロー (自分のチャンネルのイベント)・チャットへの書き込み・自分が使えるスタンプの一覧
const SCOPES: &str = "channel:read:redemptions moderator:read:followers user:write:chat user:read:emotes";
/// 書き込みに要る許可 (以前の版でログインした人は持っていないので、ログインし直しが要る)
const CHAT_SCOPES: [&str; 2] = ["user:write:chat", "user:read:emotes"];
/// 書き込みの上限 (ふつうのアカウントは 30 秒に 20 件。超えると Twitch 側で無視されるので手前で止める)
const SEND_LIMIT: usize = 20;
const SEND_WINDOW: Duration = Duration::from_secs(30);
/// 1件の長さの上限 (Twitch の決まり)
pub const CHAT_MAX_CHARS: usize = 500;
const EVENTSUB_URL: &str = "wss://eventsub.wss.twitch.tv/ws";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct AuthData {
    access_token: String,
    refresh_token: String,
    /// アクセストークンの期限 (UNIX 秒)
    expires_at: u64,
    user_id: String,
    login: String,
    /// 発行を受けたクライアント ID (違うクライアントで発行されたものは使わない)
    #[serde(default)]
    client_id: String,
    /// 許可された範囲 (ログインの確認で受け取る。以前の版の保存には無い)
    #[serde(default)]
    scopes: Vec<String>,
}

impl AuthData {
    fn can_chat(&self) -> bool {
        CHAT_SCOPES.iter().all(|s| self.scopes.iter().any(|x| x == s))
    }
}

/// 画面に出す状態 (トークンは含めない)
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub logged_in: bool,
    pub login: String,
    /// "none" / "waiting" (コード入力待ち) / "connecting" / "connected" / "error"
    pub state: String,
    pub message: String,
    pub user_code: String,
    pub verification_uri: String,
    /// チャットに書き込める (書き込みの許可を持っている)
    pub can_chat: bool,
}

/// 画面へ送るイベント ("twitch-message" と同じ形。lib.rs の TwitchChatEvent と揃える)
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventMessage {
    channel: String,
    login: String,
    name: String,
    color: String,
    text: String,
    received_at: u64,
    event: EventKind,
    badges: Vec<Value>,
    emotes: Vec<Value>,
    giant: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventKind {
    kind: String,
    months: u32,
    count: u32,
    bits: u32,
    viewers: u32,
    recipient: String,
    reward: String,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn auth_path() -> Option<std::path::PathBuf> {
    core_store::portable_data_dir().ok().map(|d| d.join("twitch-auth.bin"))
}

fn load_auth() -> Option<AuthData> {
    let stored = std::fs::read_to_string(auth_path()?).ok()?;
    if !stored.starts_with("dpapi:") {
        return None;
    }
    let plain = core_proxy::unprotect_password(stored.trim());
    let a: AuthData = serde_json::from_str(&plain).ok()?;
    // 以前のクライアント ID で発行されたログイン情報は使えないので捨てる (ログインし直しになる)
    if a.client_id != CLIENT_ID {
        let _ = std::fs::remove_file(auth_path()?);
        return None;
    }
    Some(a)
}

/// Twitch の認証の窓口のエラー応答を、利用者向けの文に直す (トークンなどは含まれない)
fn auth_error(status: u16, body: &[u8]) -> String {
    let msg = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_default();
    let lower = msg.to_ascii_lowercase();
    let hint = if lower.contains("invalid client") {
        "クライアント ID が Twitch に登録されていません (LiveFake の不具合です。最新版を確認してください)"
    } else if lower.contains("client secret") || lower.contains("confidential") {
        "クライアントの種類が「公開」になっていません"
    } else if lower.contains("scope") {
        "求めた許可の指定が受け付けられませんでした"
    } else {
        ""
    };
    let msg: String = msg.chars().filter(|c| !c.is_control()).take(120).collect();
    match (hint.is_empty(), msg.is_empty()) {
        (false, _) => format!("ログインを始められません: {hint} (HTTP {status}: {msg})"),
        (true, false) => format!("ログインを始められません (HTTP {status}: {msg})"),
        (true, true) => format!("ログインを始められません (HTTP {status})"),
    }
}

fn save_auth(a: &AuthData) -> Result<(), String> {
    let plain = serde_json::to_string(a).map_err(|e| e.to_string())?;
    let enc = core_proxy::protect_password(&plain);
    // 暗号化できなかった (平文のまま返ってきた) ときは保存しない
    if !enc.starts_with("dpapi:") {
        return Err("ログイン情報を暗号化できないため保存しませんでした (次回の起動ではログインし直しになります)".into());
    }
    let path = auth_path().ok_or("データフォルダが見つかりません")?;
    let tmp = path.with_extension("bin.tmp");
    std::fs::write(&tmp, enc).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
}

/// ログイン名・チャンネル名として使えるか (英小文字・数字・_、1〜25文字)
fn login_ok(s: &str) -> bool {
    (1..=25).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

async fn validate(http: &reqwest::Client, token: &str) -> Result<(String, String, Vec<String>), String> {
    let r = http
        .get("https://id.twitch.tv/oauth2/validate")
        .header("Authorization", format!("OAuth {token}"))
        .send()
        .await
        .map_err(|e| format!("Twitch に接続できません: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("ログインを確認できません (HTTP {})", r.status().as_u16()));
    }
    let v: Value = serde_json::from_slice(&r.bytes().await.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let id = v.get("user_id").and_then(|x| x.as_str()).ok_or("ユーザー ID を取得できません")?.to_string();
    let login = v.get("login").and_then(|x| x.as_str()).unwrap_or("").to_ascii_lowercase();
    if !login_ok(&login) || id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("ログインの確認結果の形式が違います".into());
    }
    let scopes = v
        .get("scopes")
        .and_then(|x| x.as_array())
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str())
        .filter(|s| s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b':' || b == b'_'))
        .take(30)
        .map(str::to_string)
        .collect();
    Ok((id, login, scopes))
}

async fn refresh(http: &reqwest::Client, a: &AuthData) -> Result<AuthData, String> {
    let r = http
        .post("https://id.twitch.tv/oauth2/token")
        .form(&[("client_id", CLIENT_ID), ("grant_type", "refresh_token"), ("refresh_token", a.refresh_token.as_str())])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err("ログインの有効期限が切れました。もう一度ログインしてください".into());
    }
    let t: TokenResponse = serde_json::from_slice(&r.bytes().await.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(AuthData { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: now() + t.expires_in, ..a.clone() })
}

/// ログインの状態 (Tauri の State として持つ。タスクとは Arc で共有する)
#[derive(Default)]
pub struct TwitchAuthState(Arc<Inner>);

#[derive(Default)]
pub struct Inner {
    app: Mutex<Option<AppHandle>>,
    http: Mutex<Option<reqwest::Client>>,
    auth: Mutex<Option<AuthData>>,
    status: Mutex<AuthStatus>,
    login_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// チャンネル名 → ユーザー ID (書き込みの送り先)
    broadcaster_ids: Mutex<HashMap<String, String>>,
    /// 最近書き込んだ時刻 (30 秒に 20 件までにするため)
    sent_at: Mutex<VecDeque<std::time::Instant>>,
    eventsub_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    eventsub_connected: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl TwitchAuthState {
    /// 起動時に1回: 画面への通知先を覚え、保存済みのログイン情報があれば EventSub を始める
    pub fn init(&self, app: AppHandle) {
        *lock(&self.0.app) = Some(app);
        if let Some(a) = load_auth() {
            *lock(&self.0.auth) = Some(a.clone());
            self.0.set_status(|s| {
                s.logged_in = true;
                s.login = a.login.clone();
                s.state = "connecting".into();
                s.can_chat = a.can_chat();
            });
            self.0.restart_eventsub();
        } else {
            self.0.set_status(|s| s.state = "none".into());
        }
    }

    pub fn status(&self) -> AuthStatus {
        lock(&self.0.status).clone()
    }

    /// ログイン中のチャンネルのイベントを EventSub で受け取れているか (チャット側の報酬表示を止める判定)
    pub fn covers(&self, channel: &str) -> bool {
        self.0.eventsub_connected.load(Ordering::SeqCst) && lock(&self.0.status).login.eq_ignore_ascii_case(channel)
    }

    pub async fn start_login(&self) -> Result<AuthStatus, String> {
        Inner::start_login(&self.0).await
    }

    pub async fn logout(&self) {
        Inner::logout(&self.0).await
    }

    /// ログイン中なら、公式 API からグローバルスタンプと指定チャンネルのスタンプの一覧 (名前と ID) を取る
    pub async fn fetch_emotes(&self, channels: Vec<String>) -> Result<Vec<EmoteName>, String> {
        Inner::fetch_emotes(&self.0, channels).await
    }

    /// チャットに書き込む (送り先のチャンネルが開いているタブかどうかは呼ぶ側で確かめる)
    pub async fn send_chat(&self, channel: &str, message: &str, reply_to: Option<String>) -> Result<String, String> {
        Inner::send_chat(&self.0, channel, message, reply_to).await
    }

    /// ログインしている人が使えるスタンプの一覧 (指定チャンネルのフォロワー限定スタンプも含める)
    pub async fn user_emotes(&self, channel: &str) -> Result<Vec<UserEmote>, String> {
        Inner::user_emotes(&self.0, channel).await
    }
}

/// 使えるスタンプ1つ (書き込み欄のスタンプの一覧に出す)
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserEmote {
    pub id: String,
    pub name: String,
    /// スタンプの持ち主 (チャンネルの表示名。グローバルなどは空)
    pub owner: String,
    /// 持ち主のチャンネル名 (英小文字。開いているチャンネルのスタンプを一覧の先頭にするのに使う)
    pub owner_login: String,
    pub emote_type: String,
    pub animated: bool,
}

/// 書き込みに失敗した理由を、利用者向けの文に直す
fn send_error(status: u16, body: &[u8]) -> String {
    let msg = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(|m| m.chars().filter(|c| !c.is_control()).take(120).collect::<String>()))
        .unwrap_or_default();
    let head = match status {
        401 => "書き込む許可がありません。設定 > Twitch でログインし直してください",
        403 => "このチャンネルには書き込めません (BAN・タイムアウト・フォロワー限定・サブスク限定など)",
        422 => "長すぎます (500 文字まで)",
        429 => "書き込みが多すぎます。少し待ってから送ってください",
        _ => "書き込めませんでした",
    };
    if msg.is_empty() { format!("{head} (HTTP {status})") } else { format!("{head} (HTTP {status}: {msg})") }
}

/// スタンプの名前と ID (掲示板に書かれたスタンプ名を画像にするのに使う)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct EmoteName {
    pub name: String,
    pub id: String,
}

/// 英数字と _ の名前・ID だけ使う (記号のスタンプは普通の文章で誤爆しやすいので除く)
fn emote_name_ok(name: &str, id: &str) -> bool {
    (2..=64).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && (1..=64).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn emote_list(v: &Value) -> Vec<EmoteName> {
    v.get("data")
        .and_then(|d| d.as_array())
        .into_iter()
        .flatten()
        .take(5000)
        .filter_map(|e| {
            let name = e.get("name")?.as_str()?;
            let id = e.get("id")?.as_str()?;
            emote_name_ok(name, id).then(|| EmoteName { name: name.to_string(), id: id.to_string() })
        })
        .collect()
}

impl Inner {
    fn http(&self) -> reqwest::Client {
        lock(&self.http)
            .get_or_insert_with(|| reqwest::Client::builder().timeout(Duration::from_secs(30)).build().unwrap_or_default())
            .clone()
    }

    fn set_status(&self, f: impl FnOnce(&mut AuthStatus)) {
        let st = {
            let mut s = lock(&self.status);
            f(&mut s);
            s.clone()
        };
        if let Some(app) = lock(&self.app).as_ref() {
            let _ = app.emit("twitch-auth", st);
        }
    }

    fn log(&self, msg: &str) {
        let _ = core_store::append_log(&format!("twitch-auth: {msg}"));
    }

    /// ログインを始める (コードを表示し、利用者がブラウザで許可するまで待つ)
    async fn start_login(self: &Arc<Self>) -> Result<AuthStatus, String> {
        let r = self
            .http()
            .post("https://id.twitch.tv/oauth2/device")
            .form(&[("client_id", CLIENT_ID), ("scopes", SCOPES)])
            .send()
            .await
            .map_err(|e| format!("Twitch に接続できません: {e}"))?;
        if !r.status().is_success() {
            let status = r.status().as_u16();
            let body = r.bytes().await.unwrap_or_default();
            return Err(auth_error(status, &body));
        }
        let v: Value = serde_json::from_slice(&r.bytes().await.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let device_code = v.get("device_code").and_then(|x| x.as_str()).ok_or("応答の形式が違います")?.to_string();
        let user_code: String = v.get("user_code").and_then(|x| x.as_str()).unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(32).collect();
        let uri = v.get("verification_uri").and_then(|x| x.as_str()).unwrap_or("").to_string();
        // 開くのは Twitch の確認ページだけ (偽のページへ誘導されないように)
        if !uri.starts_with("https://www.twitch.tv/activate") || uri.len() > 300 {
            return Err("想定外のログインページが返されたため中止しました".into());
        }
        let interval = v.get("interval").and_then(|x| x.as_u64()).unwrap_or(5).clamp(1, 30);
        let expires = v.get("expires_in").and_then(|x| x.as_u64()).unwrap_or(1800).min(1800);
        self.set_status(|s| {
            s.state = "waiting".into();
            s.message = "ブラウザで Twitch にログインし、表示されたコードを入力して許可してください".into();
            s.user_code = user_code.clone();
            s.verification_uri = uri.clone();
        });
        let me = Arc::clone(self);
        let task = tauri::async_runtime::spawn(async move { me.poll_login(device_code, interval, expires).await });
        if let Some(old) = lock(&self.login_task).replace(task) {
            old.abort();
        }
        Ok(lock(&self.status).clone())
    }

    async fn poll_login(self: Arc<Self>, device_code: String, mut interval: u64, expires: u64) {
        let deadline = now() + expires;
        let http = self.http();
        while now() < deadline {
            tokio::time::sleep(Duration::from_secs(interval)).await;
            let r = http
                .post("https://id.twitch.tv/oauth2/token")
                .form(&[
                    ("client_id", CLIENT_ID),
                    ("scopes", SCOPES),
                    ("device_code", device_code.as_str()),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ])
                .send()
                .await;
            let Ok(r) = r else { continue };
            let ok = r.status().is_success();
            let body = r.bytes().await.unwrap_or_default();
            if !ok {
                let msg = String::from_utf8_lossy(&body);
                if msg.contains("authorization_pending") {
                    continue;
                }
                if msg.contains("slow_down") {
                    interval = (interval + 5).min(60);
                    continue;
                }
                self.set_status(|s| {
                    s.state = "error".into();
                    s.message = "ログインが取り消されたか、時間切れになりました".into();
                    s.user_code.clear();
                });
                return;
            }
            let Ok(t) = serde_json::from_slice::<TokenResponse>(&body) else {
                self.set_status(|s| {
                    s.state = "error".into();
                    s.message = "ログインの応答の形式が違います".into();
                });
                return;
            };
            match validate(&http, &t.access_token).await {
                Ok((user_id, login, scopes)) => {
                    let a = AuthData {
                        access_token: t.access_token,
                        refresh_token: t.refresh_token,
                        expires_at: now() + t.expires_in,
                        user_id,
                        login: login.clone(),
                        client_id: CLIENT_ID.to_string(),
                        scopes,
                    };
                    let can_chat = a.can_chat();
                    let save_note = save_auth(&a).err();
                    *lock(&self.auth) = Some(a);
                    self.set_status(|s| {
                        s.logged_in = true;
                        s.login = login.clone();
                        s.state = "connecting".into();
                        s.message = save_note.clone().unwrap_or_default();
                        s.user_code.clear();
                        s.can_chat = can_chat;
                    });
                    self.log(&format!("ログインしました: {login}"));
                    self.restart_eventsub();
                }
                Err(e) => self.set_status(|s| {
                    s.state = "error".into();
                    s.message = e;
                    s.user_code.clear();
                }),
            }
            return;
        }
        self.set_status(|s| {
            s.state = "error".into();
            s.message = "時間切れになりました。もう一度ログインしてください".into();
            s.user_code.clear();
        });
    }

    /// ログアウト (Twitch 側の許可も取り消し、保存した情報を消す)
    async fn logout(self: &Arc<Self>) {
        if let Some(t) = lock(&self.login_task).take() {
            t.abort();
        }
        if let Some(t) = lock(&self.eventsub_task).take() {
            t.abort();
        }
        self.eventsub_connected.store(false, Ordering::SeqCst);
        let a = lock(&self.auth).take();
        if let Some(a) = a {
            let _ = self
                .http()
                .post("https://id.twitch.tv/oauth2/revoke")
                .form(&[("client_id", CLIENT_ID), ("token", a.access_token.as_str())])
                .send()
                .await;
        }
        if let Some(p) = auth_path() {
            let _ = std::fs::remove_file(p);
        }
        self.set_status(|s| *s = AuthStatus { state: "none".into(), ..Default::default() });
        self.log("ログアウトしました");
    }

    async fn helix_get(self: &Arc<Self>, url: &str) -> Result<Value, String> {
        let a = self.valid_token().await?;
        let r = self
            .http()
            .get(url)
            .header("Client-Id", CLIENT_ID)
            .header("Authorization", format!("Bearer {}", a.access_token))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(format!("HTTP {}", r.status().as_u16()));
        }
        let bytes = r.bytes().await.map_err(|e| e.to_string())?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("応答が大きすぎます".into());
        }
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }

    async fn fetch_emotes(self: &Arc<Self>, channels: Vec<String>) -> Result<Vec<EmoteName>, String> {
        if lock(&self.auth).is_none() {
            return Err("ログインしていません".into());
        }
        let mut out = emote_list(&self.helix_get("https://api.twitch.tv/helix/chat/emotes/global").await?);
        let logins: Vec<String> = channels.into_iter().map(|c| c.to_ascii_lowercase()).filter(|c| login_ok(c)).take(20).collect();
        if !logins.is_empty() {
            let q = logins.iter().map(|l| format!("login={l}")).collect::<Vec<_>>().join("&");
            let users = self.helix_get(&format!("https://api.twitch.tv/helix/users?{q}")).await?;
            let ids: Vec<String> = users
                .get("data")
                .and_then(|d| d.as_array())
                .into_iter()
                .flatten()
                .filter_map(|u| u.get("id")?.as_str().map(str::to_string))
                .filter(|id| !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit()))
                .collect();
            for id in ids {
                match self.helix_get(&format!("https://api.twitch.tv/helix/chat/emotes?broadcaster_id={id}")).await {
                    Ok(v) => out.extend(emote_list(&v)),
                    Err(e) => self.log(&format!("チャンネルのスタンプ一覧を取得できません: {e}")),
                }
            }
        }
        out.truncate(10000);
        Ok(out)
    }

    /// チャンネル名 → ユーザー ID (書き込みの送り先に使う。覚えておく)
    async fn broadcaster_id(self: &Arc<Self>, channel: &str) -> Result<String, String> {
        if let Some(id) = lock(&self.broadcaster_ids).get(channel).cloned() {
            return Ok(id);
        }
        let v = self.helix_get(&format!("https://api.twitch.tv/helix/users?login={channel}")).await?;
        let id = v
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|a| a.first())
            .and_then(|u| u.get("id")?.as_str().map(str::to_string))
            .filter(|id| !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit()))
            .ok_or("チャンネルが見つかりません")?;
        let mut map = lock(&self.broadcaster_ids);
        if map.len() > 200 {
            map.clear();
        }
        map.insert(channel.to_string(), id.clone());
        Ok(id)
    }

    async fn send_chat(self: &Arc<Self>, channel: &str, message: &str, reply_to: Option<String>) -> Result<String, String> {
        let channel = channel.to_ascii_lowercase();
        if !login_ok(&channel) {
            return Err("送り先のチャンネル名が正しくありません".into());
        }
        // 改行は送れないので空白にする。前後の空白は落とす
        let message: String = message.chars().map(|c| if c == '\n' || c == '\r' { ' ' } else { c }).filter(|c| !c.is_control()).collect();
        let message = message.trim();
        if message.is_empty() {
            return Err("本文が空です".into());
        }
        if message.chars().count() > CHAT_MAX_CHARS {
            return Err(format!("長すぎます ({CHAT_MAX_CHARS} 文字まで)"));
        }
        let reply_to = reply_to.filter(|r| (1..=64).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
        let a = self.valid_token().await?;
        if !a.can_chat() {
            return Err("書き込む許可がありません。設定 > Twitch でログインし直してください".into());
        }
        // 30 秒に 20 件まで (超えると Twitch に無視されるので手前で止める)
        {
            let mut sent = lock(&self.sent_at);
            let now = std::time::Instant::now();
            while sent.front().is_some_and(|t| now.duration_since(*t) > SEND_WINDOW) {
                sent.pop_front();
            }
            if sent.len() >= SEND_LIMIT {
                return Err("書き込みが多すぎます (30 秒に 20 件まで)。少し待ってから送ってください".into());
            }
            sent.push_back(now);
        }
        let broadcaster_id = self.broadcaster_id(&channel).await?;
        let mut body = json!({ "broadcaster_id": broadcaster_id, "sender_id": a.user_id, "message": message });
        if let Some(r) = reply_to {
            body["reply_parent_message_id"] = Value::String(r);
        }
        let r = self
            .http()
            .post("https://api.twitch.tv/helix/chat/messages")
            .header("Client-Id", CLIENT_ID)
            .header("Authorization", format!("Bearer {}", a.access_token))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Twitch に接続できません: {}", e.without_url()))?;
        let status = r.status().as_u16();
        let bytes = r.bytes().await.map_err(|e| e.to_string())?;
        if !(200..300).contains(&status) {
            let e = send_error(status, &bytes);
            self.log(&format!("書き込み失敗 #{channel}: HTTP {status}"));
            return Err(e);
        }
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| "応答の形式が違います".to_string())?;
        let d = v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()).cloned().unwrap_or(Value::Null);
        if d.get("is_sent").and_then(|x| x.as_bool()) != Some(true) {
            let reason = d
                .get("drop_reason")
                .and_then(|r| r.get("message").and_then(|m| m.as_str()).or_else(|| r.get("code").and_then(|c| c.as_str())))
                .unwrap_or("理由は分かりません");
            let reason: String = reason.chars().filter(|c| !c.is_control()).take(160).collect();
            self.log(&format!("書き込みが届きませんでした #{channel}"));
            return Err(format!("Twitch に届きませんでした: {reason}"));
        }
        self.log(&format!("書き込みました #{channel}"));
        Ok(d.get("message_id").and_then(|x| x.as_str()).unwrap_or("").chars().take(64).collect())
    }

    async fn user_emotes(self: &Arc<Self>, channel: &str) -> Result<Vec<UserEmote>, String> {
        let a = self.valid_token().await?;
        if !a.can_chat() {
            return Err("スタンプの一覧を見る許可がありません。設定 > Twitch でログインし直してください".into());
        }
        let channel = channel.to_ascii_lowercase();
        let bid = if login_ok(&channel) { self.broadcaster_id(&channel).await.ok() } else { None };
        let mut out: Vec<(UserEmote, String)> = Vec::new();
        // 同じスタンプが2回届くことがある (フォロワー限定のスタンプ) ので、ID で1つにまとめる
        let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut after: Option<String> = None;
        for _ in 0..30 {
            let mut url = format!("https://api.twitch.tv/helix/chat/emotes/user?user_id={}", a.user_id);
            if let Some(b) = &bid {
                url.push_str(&format!("&broadcaster_id={b}"));
            }
            if let Some(c) = &after {
                url.push_str(&format!("&after={c}"));
            }
            let v = self.helix_get(&url).await?;
            for e in v.get("data").and_then(|d| d.as_array()).into_iter().flatten() {
                let (Some(id), Some(name)) = (e.get("id").and_then(|x| x.as_str()), e.get("name").and_then(|x| x.as_str())) else { continue };
                // ID は画像のアドレスに使うので英数字と _ - だけ。名前は空白・制御文字を含まないもの
                if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
                    continue;
                }
                if name.is_empty() || name.chars().count() > 64 || name.chars().any(|c| c.is_whitespace() || c.is_control()) {
                    continue;
                }
                let owner_id: String = e.get("owner_id").and_then(|x| x.as_str()).unwrap_or("").chars().filter(|c| c.is_ascii_digit()).take(20).collect();
                let emote_type: String = e.get("emote_type").and_then(|x| x.as_str()).unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric()).take(20).collect();
                let animated = e.get("format").and_then(|f| f.as_array()).is_some_and(|f| f.iter().any(|x| x.as_str() == Some("animated")));
                if !seen_ids.insert(id.to_string()) {
                    continue;
                }
                out.push((UserEmote { id: id.into(), name: name.into(), owner: String::new(), owner_login: String::new(), emote_type, animated }, owner_id));
                if out.len() >= 5000 {
                    break;
                }
            }
            after = v
                .get("pagination")
                .and_then(|p| p.get("cursor"))
                .and_then(|c| c.as_str())
                // 続きの印は 600〜700 文字ほどある (長さで切ると2ページ目以降が取れず、チャンネルのスタンプが抜ける)
                .filter(|c| !c.is_empty() && c.len() <= 4096 && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'=' || b == b'.'))
                .map(str::to_string);
            if after.is_none() || out.len() >= 5000 {
                break;
            }
        }
        // 持ち主の表示名 (100 件ずつ)
        let mut owner_ids: Vec<String> = out.iter().map(|(_, o)| o.clone()).filter(|o| !o.is_empty() && o != "0").collect();
        owner_ids.sort();
        owner_ids.dedup();
        let mut names: HashMap<String, (String, String)> = HashMap::new();
        for chunk in owner_ids.chunks(100).take(10) {
            let q = chunk.iter().map(|id| format!("id={id}")).collect::<Vec<_>>().join("&");
            if let Ok(v) = self.helix_get(&format!("https://api.twitch.tv/helix/users?{q}")).await {
                for u in v.get("data").and_then(|d| d.as_array()).into_iter().flatten() {
                    if let (Some(id), Some(dn)) = (u.get("id").and_then(|x| x.as_str()), u.get("display_name").and_then(|x| x.as_str())) {
                        let login = u.get("login").and_then(|x| x.as_str()).map(str::to_ascii_lowercase).filter(|l| login_ok(l)).unwrap_or_default();
                        names.insert(id.to_string(), (dn.chars().filter(|c| !c.is_control()).take(40).collect(), login));
                    }
                }
            }
        }
        Ok(out
            .into_iter()
            .map(|(mut e, owner_id)| {
                if let Some((display, login)) = names.get(&owner_id) {
                    e.owner = display.clone();
                    e.owner_login = login.clone();
                }
                e
            })
            .collect())
    }

    fn restart_eventsub(self: &Arc<Self>) {
        let me = Arc::clone(self);
        let task = tauri::async_runtime::spawn(async move { me.eventsub_loop().await });
        if let Some(old) = lock(&self.eventsub_task).replace(task) {
            old.abort();
        }
    }

    /// 期限が近ければ更新したトークンを返す
    async fn valid_token(self: &Arc<Self>) -> Result<AuthData, String> {
        let a = lock(&self.auth).clone().ok_or("ログインしていません")?;
        if a.expires_at > now() + 300 {
            return Ok(a);
        }
        let fresh = refresh(&self.http(), &a).await?;
        if let Err(e) = save_auth(&fresh) {
            self.log(&e);
        }
        *lock(&self.auth) = Some(fresh.clone());
        Ok(fresh)
    }

    async fn eventsub_loop(self: Arc<Self>) {
        let mut url = EVENTSUB_URL.to_string();
        loop {
            match self.eventsub_session(&url).await {
                Ok(Some(next)) => {
                    url = next; // Twitch からの接続先変更 (同じホストのみ)
                    continue;
                }
                Ok(None) => {}
                Err(e) => {
                    self.eventsub_connected.store(false, Ordering::SeqCst);
                    let fatal = e.contains("ログイン");
                    self.set_status(|s| {
                        s.state = "error".into();
                        s.message = e.clone();
                    });
                    self.log(&format!("EventSub: {e}"));
                    if fatal {
                        return;
                    }
                }
            }
            url = EVENTSUB_URL.to_string();
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    }

    /// 1回分の接続。接続先の変更指示があれば Some(新しい URL)
    async fn eventsub_session(self: &Arc<Self>, url: &str) -> Result<Option<String>, String> {
        let (ws, _) = tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async(url))
            .await
            .map_err(|_| "接続がタイムアウトしました".to_string())?
            .map_err(|e| format!("接続できません: {e}"))?;
        let (mut tx, mut rx) = ws.split();
        let mut keepalive = 30u64;
        let mut seen: VecDeque<String> = VecDeque::new();
        loop {
            let msg = match tokio::time::timeout(Duration::from_secs(keepalive + 15), rx.next()).await {
                Ok(Some(Ok(m))) => m,
                Ok(Some(Err(e))) => return Err(format!("切断されました: {e}")),
                Ok(None) => return Err("切断されました".into()),
                Err(_) => return Err("応答がありません".into()),
            };
            let text = match msg {
                Message::Text(t) => t.to_string(),
                Message::Ping(p) => {
                    let _ = tx.send(Message::Pong(p)).await;
                    continue;
                }
                Message::Close(_) => return Err("切断されました".into()),
                _ => continue,
            };
            if text.len() > 256 * 1024 {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            let meta = &v["metadata"];
            let id = meta["message_id"].as_str().unwrap_or("").to_string();
            if !id.is_empty() {
                if seen.contains(&id) {
                    continue;
                }
                seen.push_back(id);
                while seen.len() > 300 {
                    seen.pop_front();
                }
            }
            // 10分より古い通知は捨てる (送り直し対策)
            if let Some(ts) = meta["message_timestamp"].as_str().and_then(parse_rfc3339) {
                if ts + 600 < now() {
                    continue;
                }
            }
            match meta["message_type"].as_str().unwrap_or("") {
                "session_welcome" => {
                    keepalive = v["payload"]["session"]["keepalive_timeout_seconds"].as_u64().unwrap_or(30).clamp(10, 600);
                    let session = v["payload"]["session"]["id"].as_str().unwrap_or("").to_string();
                    self.subscribe_all(&session).await?;
                    self.eventsub_connected.store(true, Ordering::SeqCst);
                    self.set_status(|s| {
                        s.state = "connected".into();
                        s.message.clear();
                    });
                }
                "session_reconnect" => {
                    let next = v["payload"]["session"]["reconnect_url"].as_str().unwrap_or("");
                    // 接続先の変更は Twitch の EventSub のホストのときだけ従う
                    if next.starts_with("wss://eventsub.wss.twitch.tv/") {
                        return Ok(Some(next.to_string()));
                    }
                    return Err("想定外の接続先が指示されたため接続し直します".into());
                }
                "notification" => self.on_notification(&v["payload"]),
                "revocation" => {
                    let t = v["payload"]["subscription"]["type"].as_str().unwrap_or("");
                    self.log(&format!("受け取りが取り消されました: {t}"));
                }
                _ => {} // session_keepalive など
            }
        }
    }

    async fn subscribe_all(self: &Arc<Self>, session: &str) -> Result<(), String> {
        let a = self.valid_token().await?;
        let uid = a.user_id.as_str();
        let subs = [
            ("channel.channel_points_custom_reward_redemption.add", "1", json!({ "broadcaster_user_id": uid })),
            ("channel.channel_points_automatic_reward_redemption.add", "2", json!({ "broadcaster_user_id": uid })),
            ("channel.follow", "2", json!({ "broadcaster_user_id": uid, "moderator_user_id": uid })),
        ];
        let mut failed = Vec::new();
        for (ty, ver, cond) in subs {
            let body = json!({ "type": ty, "version": ver, "condition": cond, "transport": { "method": "websocket", "session_id": session } });
            let r = self
                .http()
                .post("https://api.twitch.tv/helix/eventsub/subscriptions")
                .header("Client-Id", CLIENT_ID)
                .header("Authorization", format!("Bearer {}", a.access_token))
                .header("Content-Type", "application/json")
                .body(body.to_string())
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if r.status().as_u16() == 401 {
                return Err("ログインの有効期限が切れました。もう一度ログインしてください".into());
            }
            if !r.status().is_success() {
                failed.push(format!("{ty} (HTTP {})", r.status().as_u16()));
            }
        }
        if !failed.is_empty() {
            self.log(&format!("受け取れないイベントがあります: {}", failed.join(", ")));
        }
        Ok(())
    }

    fn on_notification(&self, p: &Value) {
        let ty = p["subscription"]["type"].as_str().unwrap_or("");
        let e = &p["event"];
        let clip = |v: &Value, n: usize| -> String { v.as_str().unwrap_or("").chars().take(n).collect() };
        let login = e["user_login"].as_str().unwrap_or("").to_ascii_lowercase();
        let login = if login_ok(&login) { login } else { "twitch".to_string() };
        let name = { let n = clip(&e["user_name"], 50); if n.trim().is_empty() { login.clone() } else { n } };
        let channel = e["broadcaster_user_login"].as_str().unwrap_or("").to_ascii_lowercase();
        if !login_ok(&channel) {
            return;
        }
        let mut ev = EventKind { kind: String::new(), months: 0, count: 0, bits: 0, viewers: 0, recipient: String::new(), reward: String::new() };
        let text = match ty {
            "channel.channel_points_custom_reward_redemption.add" => {
                ev.kind = "points".into();
                ev.reward = clip(&e["reward"]["title"], 100);
                clip(&e["user_input"], 500)
            }
            "channel.channel_points_automatic_reward_redemption.add" => {
                ev.kind = "points".into();
                ev.reward = automatic_reward_name(e["reward"]["type"].as_str().unwrap_or(""));
                clip(&e["message"]["text"], 500)
            }
            "channel.follow" => {
                ev.kind = "follow".into();
                String::new()
            }
            _ => return,
        };
        let msg = EventMessage {
            channel,
            login,
            name,
            color: String::new(),
            text,
            received_at: now() * 1000,
            event: ev,
            badges: Vec::new(),
            emotes: Vec::new(),
            giant: false,
        };
        if let Some(app) = lock(&self.app).as_ref() {
            let _ = app.emit("twitch-message", msg);
        }
    }
}

/// 自動報酬の種類 → 表示名 (種類の名前は Twitch 側で増えることがある。知らないものはそのまま出す)
fn automatic_reward_name(kind: &str) -> String {
    match kind {
        "single_message_bypass_sub_mode" => "サブスク限定モード中にメッセージを送信",
        "send_highlighted_message" => "メッセージをハイライト",
        "random_sub_emote_unlock" => "ランダムなスタンプを解除",
        "chosen_sub_emote_unlock" => "スタンプを選んで解除",
        "chosen_modified_sub_emote_unlock" => "加工済みスタンプを解除",
        "message_effect" => "メッセージエフェクト",
        "gigantify_an_emote" => "スタンプを巨大化",
        "celebration" => "画面上のセレブレーション",
        other => return other.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(60).collect(),
    }
    .to_string()
}

/// "2026-10-11T04:12:34.123456Z" → UNIX 秒 (時刻ライブラリを増やさないための最小限の解析)
fn parse_rfc3339(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[10] != b'T' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d, hh, mm, ss) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    // days_from_civil (Howard Hinnant)
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86400 + hh * 3600 + mm * 60 + ss).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2026-10-11T00:00:00.123Z"), Some(1_791_676_800));
        assert!(parse_rfc3339("x").is_none());
    }

    #[test]
    fn auth_errors_are_explained() {
        let m = auth_error(400, br#"{"status":400,"message":"invalid client"}"#);
        assert!(m.contains("クライアント ID") && m.contains("HTTP 400"));
        assert_eq!(auth_error(500, b"oops"), "ログインを始められません (HTTP 500)");
    }

    #[test]
    fn emote_names_are_filtered() {
        let v = serde_json::json!({ "data": [
            { "id": "25", "name": "Kappa" }, { "id": "1", "name": ":)" }, { "id": "a b", "name": "Bad" }, { "id": "emotesv2_x", "name": "kaede1Hi" }
        ]});
        assert_eq!(emote_list(&v), vec![EmoteName { name: "Kappa".into(), id: "25".into() }, EmoteName { name: "kaede1Hi".into(), id: "emotesv2_x".into() }]);
    }

    #[test]
    fn names() {
        assert!(login_ok("abc_12"));
        assert!(!login_ok("Abc"));
        assert!(!login_ok("a b"));
        assert_eq!(automatic_reward_name("gigantify_an_emote"), "スタンプを巨大化");
        assert_eq!(automatic_reward_name("new_kind<x>"), "new_kindx");
    }

    #[cfg(windows)]
    #[test]
    fn auth_roundtrip_is_encrypted() {
        let a = AuthData { access_token: "tok".into(), refresh_token: "ref".into(), expires_at: 1, user_id: "1".into(), login: "x".into(), client_id: CLIENT_ID.into(), scopes: vec!["user:write:chat".into()] };
        let enc = core_proxy::protect_password(&serde_json::to_string(&a).unwrap());
        assert!(enc.starts_with("dpapi:"));
        assert!(!enc.contains("tok"));
        let back: AuthData = serde_json::from_str(&core_proxy::unprotect_password(&enc)).unwrap();
        assert_eq!(back.access_token, "tok");
        // 書き込みには、書き込みとスタンプの一覧の両方の許可が要る
        assert!(!back.can_chat());
        let full = AuthData { scopes: CHAT_SCOPES.iter().map(|s| s.to_string()).collect(), ..back };
        assert!(full.can_chat());
        // 以前の版の保存 (scopes が無い) も読める
        let old: AuthData = serde_json::from_str(r#"{"access_token":"a","refresh_token":"b","expires_at":1,"user_id":"1","login":"x","client_id":"c"}"#).unwrap();
        assert!(old.scopes.is_empty() && !old.can_chat());
    }

    #[test]
    fn send_error_messages() {
        assert!(send_error(403, b"{}").contains("書き込めません"));
        assert!(send_error(401, br#"{"message":"Missing scope"}"#).contains("ログインし直して"));
        assert!(send_error(429, b"").contains("多すぎます"));
    }
}
