//! YouTube ライブ配信のチャットの受信 (読み取り専用。こちらから書き込むことはない)。
//!
//! - 公式 API: YouTube Data API v3 (利用者が自分で用意した API キー)。videos.list でチャットの ID を調べ (1 クォータ)、
//!   liveChatMessages.list を繰り返し呼ぶ (1回 5 クォータ)。呼ぶ間隔は API が指示する間隔と設定した最短間隔の長いほう。
//!   API キーは URL に入れず `x-goog-api-key` ヘッダーで送る (エラー文やログに出ないように)
//! - 使った量 (クォータ) はアプリ側の [`QuotaPlan`] に知らせ、呼ぶ間隔もそこに聞く (目標の時間もつように延ばすため)。
//!   日の区切り (太平洋時間の0時) と、目標の時間から間隔を決める計算は [`quota`] にある
//! - 暗号化して置く取得方法は、カギがあるときだけ組み込まれる (build.rs)。リリース版には入らない
//!
//! 開けるのはライブ配信 (配信中・配信予定) の URL だけ。アーカイブや普通の動画、チャンネルの URL は扱わない。
//! 最初に取れる「接続前の発言」は流さない (Twitch と同じく、つないだ後の発言だけ)。

use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;


/// 再接続までの待ち時間 (失敗が続くと倍々に延ばす)
const RETRY_MIN: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(60);
/// 本文・名前などの長さの上限 (文字数)
const MAX_TEXT_CHARS: usize = 1000;
const MAX_NAME_CHARS: usize = 100;
const MAX_FIELD_CHARS: usize = 100;
/// 1回に受け取る応答の大きさの上限
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
/// 公式 API: 呼ぶ間隔の範囲 (秒)
pub const API_MIN_INTERVAL_SECS: u64 = 5;
pub const API_MAX_INTERVAL_SECS: u64 = 120;

const API_BASE: &str = "https://www.googleapis.com/youtube/v3";
/// 公式 API の1回の呼び出しで使うクォータ (videos.list / liveChatMessages.list)
pub const COST_VIDEOS_LIST: u32 = 1;
pub const COST_CHAT_LIST: u32 = 5;

/// 公式 API の ID (画面の設定と Rust の間で使う)
pub const API_METHOD_ID: &str = "api";

#[derive(Debug, Error)]
pub enum YoutubeError {
    #[error("{0}")]
    Http(String),
}

/// 取得方法の説明 (画面の選択肢に出す)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MethodInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// API キーが要る
    pub needs_key: bool,
}

/// この exe で使える取得方法
pub fn methods() -> Vec<MethodInfo> {
    #[allow(unused_mut)]
    let mut v = vec![MethodInfo {
        id: API_METHOD_ID,
        label: "YouTube Data API (公式)",
        description: "YouTube 公式の API を使います。Google Cloud で作った API キーが必要です。1日に使える回数に上限があります。",
        needs_key: true,
    }];
    #[cfg(yt_sealed)]
    v.push(sealed::info());
    v
}

// ===== URL =====

/// 動画 ID (英数字と - _ の 11 文字)
pub fn is_video_id(s: &str) -> bool {
    s.len() == 11 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// ライブ配信の URL から動画 ID を取り出す。受け付ける形:
/// youtube.com/watch?v=ID / youtube.com/live/ID / youtu.be/ID (www. m. あり・https:// なしも可)
pub fn video_id_from_url(input: &str) -> Option<String> {
    let v = input.trim();
    if v.is_empty() || v.len() > 2048 {
        return None;
    }
    let with_scheme = if v.starts_with("http://") || v.starts_with("https://") { v.to_string() } else { format!("https://{v}") };
    let u = url::Url::parse(&with_scheme).ok()?;
    let host = u.host_str()?.to_ascii_lowercase();
    let mut segs = u.path_segments()?.filter(|s| !s.is_empty());
    let id = match host.as_str() {
        "youtube.com" | "www.youtube.com" | "m.youtube.com" => match segs.next()? {
            "watch" => u.query_pairs().find(|(k, _)| k == "v").map(|(_, v)| v.into_owned())?,
            "live" => segs.next()?.to_string(),
            _ => return None,
        },
        "youtu.be" => segs.next()?.to_string(),
        _ => return None,
    };
    is_video_id(&id).then_some(id)
}

/// タブに使う URL (動画 ID はあらかじめ確かめたもの)
pub fn watch_url(video_id: &str) -> String {
    format!("https://www.youtube.com/watch?v={video_id}")
}

// ===== 受け取るもの =====

/// 投稿者の立場
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Roles {
    pub owner: bool,
    pub moderator: bool,
    pub member: bool,
    pub verified: bool,
}

/// チャンネル独自の絵文字の位置 (本文のコードポイント単位。end を含む) と画像
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Emoji {
    pub start: usize,
    pub end: usize,
    pub name: String,
    pub url: String,
}

/// スーパーチャット・メンバー加入などのイベント
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChatEvent {
    /// superchat / supersticker / member / milestone / gift / giftreceived / jewels
    pub kind: String,
    /// 金額の表示 (例: "¥1,000")。お金のやり取りはしない。表示するだけ
    pub amount: String,
    pub months: u32,
    pub count: u32,
    /// メンバーシップのレベル名
    pub level: String,
    /// ステッカー・ギフトの名前
    pub item: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    /// YouTube の発言 ID (削除の知らせと照らし合わせる)
    pub id: String,
    /// 投稿者のチャンネル ID (UC で始まる 24 文字。分からなければ空)
    pub channel_id: String,
    pub name: String,
    pub text: String,
    pub emojis: Vec<Emoji>,
    pub roles: Roles,
    pub event: Option<ChatEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(clippy::large_enum_variant)] // 発言がほとんどなので、箱に入れずにそのまま持つ
pub enum Update {
    Message(ChatMessage),
    /// 発言が削除された (発言 ID)
    Deleted(String),
    /// この投稿者の発言がまとめて削除された (ブロック・タイムアウトなど。チャンネル ID)
    DeletedByAuthor(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Connecting,
    /// 受信中 (配信のタイトル)
    Live { title: String },
    /// 一時的な失敗。少し待ってやり直す
    Retrying { reason: String, retry_in_secs: u64 },
    /// 配信が終わった
    Ended,
    /// やり直しても直らない理由で止めた (配信中でない・API キーが違う・上限に達した など)
    Stopped { reason: String },
}

/// 公式 API の使用量を数え、呼ぶ間隔を決めるもの (アプリ側が持つ。同じ API キーの配信すべてで1つを使う)
pub trait QuotaPlan: Send + Sync {
    /// 呼んだ分を足す (応答が返ってきた呼び出しだけ)
    fn charge(&self, units: u32);
    /// 今日の上限に達したと API に言われた
    fn exhausted(&self);
    /// 次に呼ぶまでの間隔 (設定した最短の間隔より短くはしない)
    fn interval(&self, min_interval: Duration) -> Duration;
}

/// 取得方法と、その設定
#[derive(Clone)]
pub enum Method {
    Api { key: String, min_interval: Duration, quota: Option<Arc<dyn QuotaPlan>> },
    #[cfg(yt_sealed)]
    Sealed,
}

impl std::fmt::Debug for Method {
    // API キーは出さない
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Method::Api { min_interval, .. } => write!(f, "Api {{ min_interval: {min_interval:?} }}"),
            #[cfg(yt_sealed)]
            Method::Sealed => write!(f, "Sealed"),
        }
    }
}

/// 画面で選ばれた方式の ID から取得方法を作る (quota は公式 API の使用量を数えるもの)
pub fn method_from_id(id: &str, api_key: Option<String>, min_interval_secs: u64, quota: Option<Arc<dyn QuotaPlan>>) -> Result<Method, String> {
    if id == API_METHOD_ID {
        let key = api_key.filter(|k| api_key_ok(k)).ok_or_else(|| "API キーが設定されていません (設定 > YouTube)".to_string())?;
        let secs = min_interval_secs.clamp(API_MIN_INTERVAL_SECS, API_MAX_INTERVAL_SECS);
        return Ok(Method::Api { key, min_interval: Duration::from_secs(secs), quota });
    }
    let _ = &quota;
    #[cfg(yt_sealed)]
    if id == sealed::ID {
        return Ok(Method::Sealed);
    }
    Err("この取得方法は使えません".to_string())
}

/// API キーの形 (英数字と - _ の 20〜100 文字。Google の API キーは "AIza" で始まる 39 文字)
pub fn api_key_ok(key: &str) -> bool {
    (20..=100).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 1つのライブ配信のチャットを受け取り続ける。配信が終わるか、止める理由があれば戻る。
/// 呼んだ側はタスクを abort して止めてよい
pub async fn run<F, G>(video_id: String, method: Method, mut on_updates: F, mut on_status: G)
where
    F: FnMut(Vec<Update>) + Send,
    G: FnMut(Status) + Send,
{
    if !is_video_id(&video_id) {
        on_status(Status::Stopped { reason: "動画 ID が正しくありません".into() });
        return;
    }
    match method {
        Method::Api { key, min_interval, quota } => run_api(&video_id, &key, min_interval, quota.as_deref(), &mut on_updates, &mut on_status).await,
        #[cfg(yt_sealed)]
        Method::Sealed => sealed::run(&video_id, &mut on_updates, &mut on_status).await,
    }
}

// ===== 共通の部品 =====

/// 制御文字を除き、長さを切り詰める
pub(crate) fn clean(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control() || *c == '\n').map(|c| if c == '\n' { ' ' } else { c }).take(max).collect()
}

/// 投稿者のチャンネル ID (UC + 英数字と - _ の 22 文字)。形が違えば空
pub(crate) fn channel_id_or_empty(s: &str) -> String {
    let ok = s.len() == 24 && s.starts_with("UC") && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok { s.to_string() } else { String::new() }
}

/// 発言 ID (英数字と一部の記号の 1〜256 文字)。形が違えば空
pub(crate) fn message_id_or_empty(s: &str) -> String {
    let ok = (1..=256).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'=' | b'%' | b':' | b'+' | b'/'));
    if ok { s.to_string() } else { String::new() }
}

/// 絵文字の画像アドレスは YouTube の画像配信サーバー (yt3/yt4.ggpht.com) のものだけ使う
pub fn emoji_url_ok(url: &str) -> bool {
    let rest = url.strip_prefix("https://yt3.ggpht.com/").or_else(|| url.strip_prefix("https://yt4.ggpht.com/"));
    match rest {
        Some(r) => !r.is_empty() && url.len() <= 512 && r.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'=' | b'/' | b'.' | b'~')),
        None => false,
    }
}

/// 本文を組み立てる (チャンネル独自の絵文字は名前を前後の空白で区切って入れ、位置を覚える)
#[derive(Default)]
pub(crate) struct TextBuilder {
    text: String,
    chars: usize,
    emojis: Vec<Emoji>,
}

impl TextBuilder {
    pub(crate) fn push_text(&mut self, s: &str) {
        for c in s.chars() {
            if self.chars >= MAX_TEXT_CHARS {
                return;
            }
            if c.is_control() && c != '\n' {
                continue;
            }
            self.text.push(if c == '\n' { ' ' } else { c });
            self.chars += 1;
        }
    }

    /// 絵文字。画像が使えないもの・名前が長すぎるものは名前だけ入れる
    #[cfg_attr(not(yt_sealed), allow(dead_code))]
    pub(crate) fn push_emoji(&mut self, name: &str, url: &str) {
        let name: String = name.chars().filter(|c| !c.is_control() && !c.is_whitespace()).take(64).collect();
        if name.is_empty() {
            return;
        }
        let n = name.chars().count();
        let need_space = !self.text.is_empty() && !self.text.ends_with(' ');
        if self.chars + n + 2 > MAX_TEXT_CHARS {
            return;
        }
        if need_space {
            self.text.push(' ');
            self.chars += 1;
        }
        let start = self.chars;
        self.text.push_str(&name);
        self.chars += n;
        if emoji_url_ok(url) && self.emojis.len() < 200 {
            self.emojis.push(Emoji { start, end: start + n - 1, name, url: url.to_string() });
        }
        self.text.push(' ');
        self.chars += 1;
    }

    pub(crate) fn finish(mut self) -> (String, Vec<Emoji>) {
        // 末尾の空白を落とす (絵文字の位置は前にあるので変わらない)
        while self.text.ends_with(' ') {
            self.text.pop();
        }
        let n = self.text.chars().count();
        self.emojis.retain(|e| e.end < n);
        (self.text, self.emojis)
    }
}

/// 応答の本文を上限つきで読む
pub(crate) async fn read_body(resp: reqwest::Response) -> Result<Vec<u8>, YoutubeError> {
    if resp.content_length().is_some_and(|n| n as usize > MAX_BODY_BYTES) {
        return Err(YoutubeError::Http("応答が大きすぎます".into()));
    }
    let mut resp = resp;
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| YoutubeError::Http(net_error(e)))? {
        if out.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(YoutubeError::Http("応答が大きすぎます".into()));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// 通信エラーの文 (URL は含めない)
pub(crate) fn net_error(e: reqwest::Error) -> String {
    let e = e.without_url();
    if e.is_timeout() {
        "通信がタイムアウトしました".into()
    } else if e.is_connect() {
        "接続できませんでした".into()
    } else {
        format!("通信エラー: {}", clean(&e.to_string(), 120))
    }
}

pub(crate) fn http_client(user_agent: &str) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(user_agent)
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(net_error)
}

fn str_of<'a>(v: &'a Value, path: &[&str]) -> &'a str {
    let mut cur = v;
    for p in path {
        cur = &cur[*p];
    }
    cur.as_str().unwrap_or("")
}

fn u32_of(v: &Value, path: &[&str]) -> u32 {
    let mut cur = v;
    for p in path {
        cur = &cur[*p];
    }
    cur.as_u64().or_else(|| cur.as_str().and_then(|s| s.parse().ok())).map(|n| n.min(u32::MAX as u64) as u32).unwrap_or(0)
}

// ===== 公式 API (YouTube Data API v3) =====

/// API の失敗の分け方
#[derive(Debug, PartialEq, Eq)]
enum ApiFail {
    /// 少し待ってやり直す
    Retry(String),
    /// 配信 (チャット) が終わった
    Ended,
    /// やり直しても直らない
    Stop(String),
}

/// API のエラー応答を分ける (エラー文に API キーは含まれない)
fn classify_api_error(status: u16, body: &[u8]) -> ApiFail {
    let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let err = &v["error"];
    let mut reasons: Vec<String> = Vec::new();
    for list in [&err["errors"], &err["details"]] {
        if let Some(a) = list.as_array() {
            reasons.extend(a.iter().filter_map(|e| e["reason"].as_str()).map(str::to_string));
        }
    }
    let message = clean(err["message"].as_str().unwrap_or(""), 160);
    let has = |r: &str| reasons.iter().any(|x| x.eq_ignore_ascii_case(r));
    if has("quotaExceeded") || has("dailyLimitExceeded") {
        return ApiFail::Stop("今日の API の上限 (クォータ) に達しました。太平洋時間の0時 (日本時間の16〜17時) に戻ります".into());
    }
    if has("rateLimitExceeded") || has("userRateLimitExceeded") {
        return ApiFail::Retry("呼ぶ間隔が短すぎると言われました".into());
    }
    if has("keyInvalid") || has("API_KEY_INVALID") || message.contains("API key not valid") {
        return ApiFail::Stop("API キーが正しくありません (設定 > YouTube)".into());
    }
    if has("accessNotConfigured") || has("SERVICE_DISABLED") {
        return ApiFail::Stop("API キーのプロジェクトで YouTube Data API v3 が有効になっていません".into());
    }
    if has("ipRefererBlocked") || has("API_KEY_HTTP_REFERRER_BLOCKED") || has("API_KEY_IP_ADDRESS_BLOCKED") || has("API_KEY_SERVICE_BLOCKED") {
        return ApiFail::Stop("API キーの制限 (使える場所・API の指定) のため使えません".into());
    }
    if has("liveChatEnded") {
        return ApiFail::Ended;
    }
    if has("liveChatDisabled") {
        return ApiFail::Stop("この配信はチャットがオフになっています".into());
    }
    if has("liveChatNotFound") {
        return ApiFail::Stop("チャットが見つかりません (配信が終わったか、削除されました)".into());
    }
    if status == 429 || status >= 500 {
        return ApiFail::Retry(format!("YouTube の API が応答しませんでした ({status})"));
    }
    if message.is_empty() {
        ApiFail::Stop(format!("YouTube の API がエラーを返しました ({status})"))
    } else {
        ApiFail::Stop(format!("YouTube の API がエラーを返しました ({status}): {message}"))
    }
}

/// 上限に達したというエラーか
fn is_quota_error(body: &[u8]) -> bool {
    let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let err = &v["error"];
    [&err["errors"], &err["details"]].iter().filter_map(|l| l.as_array()).flatten().filter_map(|e| e["reason"].as_str()).any(|r| {
        r.eq_ignore_ascii_case("quotaExceeded") || r.eq_ignore_ascii_case("dailyLimitExceeded")
    })
}

/// API を呼ぶ。応答が返ってきたら (エラーでも) 使った分を quota に足す
async fn api_get(client: &reqwest::Client, key: &str, path: &str, query: &[(&str, &str)], quota: Option<&dyn QuotaPlan>, cost: u32) -> Result<Value, ApiFail> {
    let resp = client
        .get(format!("{API_BASE}/{path}"))
        .query(query)
        .header("x-goog-api-key", key)
        .send()
        .await
        .map_err(|e| ApiFail::Retry(net_error(e)))?;
    let status = resp.status().as_u16();
    if let Some(q) = quota {
        q.charge(cost);
    }
    let body = read_body(resp).await.map_err(|e| ApiFail::Retry(e.to_string()))?;
    if !(200..300).contains(&status) {
        if let Some(q) = quota.filter(|_| is_quota_error(&body)) {
            q.exhausted();
        }
        return Err(classify_api_error(status, &body));
    }
    serde_json::from_slice(&body).map_err(|_| ApiFail::Retry("API の応答を読めませんでした".into()))
}

/// 動画からチャットの ID とタイトルを調べる。ライブ配信 (配信中・配信予定) でなければ止める
async fn api_resolve(client: &reqwest::Client, key: &str, video_id: &str, quota: Option<&dyn QuotaPlan>) -> Result<(String, String), ApiFail> {
    let v = api_get(
        client,
        key,
        "videos",
        &[
            ("part", "snippet,liveStreamingDetails"),
            ("id", video_id),
            ("fields", "items(snippet(title,liveBroadcastContent),liveStreamingDetails(activeLiveChatId,actualEndTime))"),
        ],
        quota,
        COST_VIDEOS_LIST,
    )
    .await?;
    resolve_from_videos(&v)
}

fn resolve_from_videos(v: &Value) -> Result<(String, String), ApiFail> {
    let Some(item) = v["items"].as_array().and_then(|a| a.first()) else {
        return Err(ApiFail::Stop("動画が見つかりません (非公開・削除済みか、URL が違います)".into()));
    };
    let title = clean(str_of(item, &["snippet", "title"]), 200);
    let content = str_of(item, &["snippet", "liveBroadcastContent"]);
    let chat_id = str_of(item, &["liveStreamingDetails", "activeLiveChatId"]);
    if content != "live" && content != "upcoming" {
        let ended = !str_of(item, &["liveStreamingDetails", "actualEndTime"]).is_empty();
        return Err(ApiFail::Stop(if ended {
            "この配信は終わっています (アーカイブには対応していません)".into()
        } else {
            "ライブ配信ではありません (普通の動画には対応していません)".into()
        }));
    }
    if chat_id.is_empty() || chat_id.len() > 256 || !chat_id.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(ApiFail::Stop("この配信はチャットがありません (オフになっているか、まだ始まっていません)".into()));
    }
    Ok((chat_id.to_string(), title))
}

/// liveChatMessages.list の応答の1件を読む。None は扱わない種類。Err(()) はチャットが終わった知らせ
fn parse_api_item(item: &Value) -> Result<Option<Update>, ()> {
    let sn = &item["snippet"];
    let ad = &item["authorDetails"];
    let ty = sn["type"].as_str().unwrap_or("");
    let id = message_id_or_empty(item["id"].as_str().unwrap_or(""));
    match ty {
        "chatEndedEvent" => return Err(()),
        "messageDeletedEvent" => {
            let target = message_id_or_empty(str_of(sn, &["messageDeletedDetails", "deletedMessageId"]));
            return Ok((!target.is_empty()).then_some(Update::Deleted(target)));
        }
        "tombstone" => return Ok((!id.is_empty()).then_some(Update::Deleted(id))),
        "userBannedEvent" => {
            let ch = channel_id_or_empty(str_of(sn, &["userBannedDetails", "bannedUserDetails", "channelId"]));
            return Ok((!ch.is_empty()).then_some(Update::DeletedByAuthor(ch)));
        }
        _ => {}
    }
    let field = |path: &[&str]| clean(str_of(sn, path), MAX_FIELD_CHARS);
    let (text, event) = match ty {
        "textMessageEvent" => {
            let t = str_of(sn, &["textMessageDetails", "messageText"]);
            (if t.is_empty() { str_of(sn, &["displayMessage"]) } else { t }.to_string(), None)
        }
        "superChatEvent" => (
            str_of(sn, &["superChatDetails", "userComment"]).to_string(),
            Some(ChatEvent { kind: "superchat".into(), amount: field(&["superChatDetails", "amountDisplayString"]), ..Default::default() }),
        ),
        "superStickerEvent" => (
            String::new(),
            Some(ChatEvent {
                kind: "supersticker".into(),
                amount: field(&["superStickerDetails", "amountDisplayString"]),
                item: field(&["superStickerDetails", "superStickerMetadata", "altText"]),
                ..Default::default()
            }),
        ),
        "newSponsorEvent" => (String::new(), Some(ChatEvent { kind: "member".into(), level: field(&["newSponsorDetails", "memberLevelName"]), ..Default::default() })),
        "memberMilestoneChatEvent" => (
            str_of(sn, &["memberMilestoneChatDetails", "userComment"]).to_string(),
            Some(ChatEvent {
                kind: "milestone".into(),
                months: u32_of(sn, &["memberMilestoneChatDetails", "memberMonth"]),
                level: field(&["memberMilestoneChatDetails", "memberLevelName"]),
                ..Default::default()
            }),
        ),
        "membershipGiftingEvent" => (
            String::new(),
            Some(ChatEvent {
                kind: "gift".into(),
                count: u32_of(sn, &["membershipGiftingDetails", "giftMembershipsCount"]),
                level: field(&["membershipGiftingDetails", "giftMembershipsLevelName"]),
                ..Default::default()
            }),
        ),
        "giftMembershipReceivedEvent" => (
            String::new(),
            Some(ChatEvent { kind: "giftreceived".into(), level: field(&["giftMembershipReceivedDetails", "memberLevelName"]), ..Default::default() }),
        ),
        "giftEvent" => (
            String::new(),
            Some(ChatEvent {
                kind: "jewels".into(),
                item: field(&["giftDetails", "giftName"]),
                count: u32_of(sn, &["giftDetails", "comboCount"]).max(1),
                ..Default::default()
            }),
        ),
        _ => return Ok(None),
    };
    let mut tb = TextBuilder::default();
    tb.push_text(&text);
    let (text, emojis) = tb.finish();
    let channel = {
        let c = channel_id_or_empty(ad["channelId"].as_str().unwrap_or(""));
        if c.is_empty() { channel_id_or_empty(sn["authorChannelId"].as_str().unwrap_or("")) } else { c }
    };
    Ok(Some(Update::Message(ChatMessage {
        id,
        channel_id: channel,
        name: clean(ad["displayName"].as_str().unwrap_or(""), MAX_NAME_CHARS),
        text,
        emojis,
        roles: Roles {
            owner: ad["isChatOwner"].as_bool().unwrap_or(false),
            moderator: ad["isChatModerator"].as_bool().unwrap_or(false),
            member: ad["isChatSponsor"].as_bool().unwrap_or(false),
            verified: ad["isVerified"].as_bool().unwrap_or(false),
        },
        event,
    })))
}

/// 1回分の応答を読む: (届いたもの, 次のページの印, API が指示する待ち時間, 終わったか)
fn parse_api_list(v: &Value) -> (Vec<Update>, Option<String>, Option<Duration>, bool) {
    let mut out = Vec::new();
    let mut ended = !v["offlineAt"].as_str().unwrap_or("").is_empty();
    if let Some(items) = v["items"].as_array() {
        for it in items {
            match parse_api_item(it) {
                Ok(Some(u)) => out.push(u),
                Ok(None) => {}
                Err(()) => ended = true,
            }
        }
    }
    let token = v["nextPageToken"].as_str().filter(|t| !t.is_empty() && t.len() <= 512 && t.bytes().all(|b| b.is_ascii_graphic())).map(str::to_string);
    let wait = v["pollingIntervalMillis"].as_u64().map(Duration::from_millis);
    (out, token, wait, ended)
}

async fn run_api(
    video_id: &str,
    key: &str,
    min_interval: Duration,
    quota: Option<&dyn QuotaPlan>,
    on_updates: &mut (dyn FnMut(Vec<Update>) + Send),
    on_status: &mut (dyn FnMut(Status) + Send),
) {
    let client = match http_client("LiveFake") {
        Ok(c) => c,
        Err(e) => {
            on_status(Status::Stopped { reason: e });
            return;
        }
    };
    let mut backoff = RETRY_MIN;
    on_status(Status::Connecting);
    let (chat_id, title) = loop {
        match api_resolve(&client, key, video_id, quota).await {
            Ok(v) => break v,
            Err(ApiFail::Retry(reason)) => {
                on_status(Status::Retrying { reason, retry_in_secs: backoff.as_secs() });
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(RETRY_MAX);
            }
            Err(ApiFail::Ended) => {
                on_status(Status::Ended);
                return;
            }
            Err(ApiFail::Stop(reason)) => {
                on_status(Status::Stopped { reason });
                return;
            }
        }
    };
    on_status(Status::Live { title: title.clone() });
    backoff = RETRY_MIN;
    let mut page_token: Option<String> = None;
    let mut first = true;
    let mut retrying = false;
    loop {
        let mut query: Vec<(&str, &str)> = vec![("liveChatId", &chat_id), ("part", "id,snippet,authorDetails"), ("maxResults", "2000"), ("hl", "ja")];
        if let Some(t) = page_token.as_deref() {
            query.push(("pageToken", t));
        }
        match api_get(&client, key, "liveChat/messages", &query, quota, COST_CHAT_LIST).await {
            Ok(v) => {
                if retrying {
                    retrying = false;
                    on_status(Status::Live { title: title.clone() });
                }
                backoff = RETRY_MIN;
                let (updates, token, wait, ended) = parse_api_list(&v);
                // 最初の応答は「つなぐ前の発言」なので流さない
                if !first && !updates.is_empty() {
                    on_updates(updates);
                }
                first = false;
                if ended {
                    on_status(Status::Ended);
                    return;
                }
                if token.is_some() {
                    page_token = token;
                }
                // API が指示する間隔・設定した最短の間隔・目標の時間もたせるための間隔の、いちばん長いもの
                let planned = quota.map(|q| q.interval(min_interval)).unwrap_or(min_interval);
                let wait = wait.unwrap_or(min_interval).max(min_interval).max(planned).min(Duration::from_secs(API_MAX_INTERVAL_SECS));
                tokio::time::sleep(wait).await;
            }
            Err(ApiFail::Retry(reason)) => {
                retrying = true;
                on_status(Status::Retrying { reason, retry_in_secs: backoff.as_secs() });
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(RETRY_MAX);
            }
            Err(ApiFail::Ended) => {
                on_status(Status::Ended);
                return;
            }
            Err(ApiFail::Stop(reason)) => {
                on_status(Status::Stopped { reason });
                return;
            }
        }
    }
}

// ===== 公式 API の使用量 =====

pub mod quota {
    //! 公式 API の使用量 (クォータ) の計算 (通信はしない)。
    //!
    //! - 1日の上限は太平洋時間の0時に戻る (夏時間: 3月の第2日曜 2:00 から 11月の第1日曜 2:00 まで。UTC で 10:00 / 9:00)
    //! - 目標の時間もたせる: 残りのクォータを、目標の終わり (か、上限が戻るとき) までの時間に割り振って、呼ぶ間隔を決める

    use crate::{API_MAX_INTERVAL_SECS, COST_CHAT_LIST};

    const DAY: i64 = 86_400;
    const HOUR: i64 = 3_600;

    /// 1970-01-01 からの日数 → (年, 月, 日)
    fn civil_from_days(z: i64) -> (i64, u32, u32) {
        let z = z + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        let y = yoe + era * 400 + i64::from(m <= 2);
        (y, m, d)
    }

    /// (年, 月, 日) → 1970-01-01 からの日数
    fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
        let y = if m <= 2 { y - 1 } else { y };
        let era = y.div_euclid(400);
        let yoe = y.rem_euclid(400);
        let m = i64::from(m);
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }

    /// その月の第 n 日曜日 (1970-01-01 からの日数)
    fn nth_sunday(y: i64, m: u32, n: i64) -> i64 {
        let first = days_from_civil(y, m, 1);
        let weekday = (first + 4).rem_euclid(7); // 0 = 日曜 (1970-01-01 は木曜)
        first + (7 - weekday) % 7 + 7 * (n - 1)
    }

    /// 太平洋時間と UTC の差 (秒。夏時間は -7 時間、それ以外は -8 時間)
    pub fn pacific_offset_secs(utc: i64) -> i64 {
        let (y, _, _) = civil_from_days(utc.div_euclid(DAY));
        let start = nth_sunday(y, 3, 2) * DAY + 10 * HOUR;
        let end = nth_sunday(y, 11, 1) * DAY + 9 * HOUR;
        if (start..end).contains(&utc) { -7 * HOUR } else { -8 * HOUR }
    }

    /// 上限を数える日 (太平洋時間の日付。"YYYY-MM-DD")
    pub fn pacific_day(utc: i64) -> String {
        let (y, m, d) = civil_from_days((utc + pacific_offset_secs(utc)).div_euclid(DAY));
        format!("{y:04}-{m:02}-{d:02}")
    }

    /// 次に上限が戻る時刻 (UTC の秒。太平洋時間の次の0時)
    pub fn next_pacific_reset(utc: i64) -> i64 {
        let local_midnight = ((utc + pacific_offset_secs(utc)).div_euclid(DAY) + 1) * DAY;
        // 夏時間の切り替えは 2:00 なので、0時の前後で差は変わらない
        local_midnight - pacific_offset_secs(local_midnight + 8 * HOUR)
    }

    /// 間隔を決めるのに使う値
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct PlanInput {
        /// 今 (UTC の秒)
        pub now: i64,
        /// 目標の終わり (UTC の秒)。None は目標なし (いつも最短の間隔)
        pub target_end: Option<i64>,
        /// 今日使った量
        pub used: u32,
        /// 1日の上限
        pub limit: u32,
        /// 取得に使わず残しておく量 (書き込み用など)
        pub reserve: u32,
        /// 公式 API で受信している配信の数
        pub active: u32,
        /// 設定した最短の間隔 (秒)
        pub min_secs: u64,
    }

    /// 決めた間隔と、その見込み
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct PlanOutput {
        /// 呼ぶ間隔 (秒)
        pub interval_secs: u64,
        /// 目標の時間もつ見込みか (目標なしのときは true)
        pub reachable: bool,
        /// この間隔のまま受信すると、残りを使い切るまでの時間 (秒)
        pub lasts_secs: u64,
        /// 上限が戻るまでの時間 (秒)
        pub until_reset_secs: u64,
    }

    pub fn plan(p: PlanInput) -> PlanOutput {
        let max = API_MAX_INTERVAL_SECS;
        let min = p.min_secs.clamp(1, max);
        let per_round = u64::from(COST_CHAT_LIST) * u64::from(p.active.max(1));
        let remaining = u64::from(p.limit.saturating_sub(p.used).saturating_sub(p.reserve));
        let rounds = remaining / per_round;
        let reset = next_pacific_reset(p.now);
        let until_reset_secs = (reset - p.now).max(0) as u64;
        let (interval_secs, reachable) = match p.target_end.filter(|end| *end > p.now) {
            Some(end) => {
                // 目標の終わりより先に上限が戻るなら、戻るときまでもてばよい (戻った後は、また残りから決め直す)
                let horizon = (end.min(reset) - p.now).max(1) as u64;
                if rounds == 0 {
                    (max, false)
                } else {
                    let need = horizon.div_ceil(rounds);
                    (need.clamp(min, max), need <= max)
                }
            }
            None => (min, true),
        };
        PlanOutput { interval_secs, reachable, lasts_secs: rounds * interval_secs, until_reset_secs }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// UTC の日時 → 秒
        fn utc(y: i64, m: u32, d: u32, h: i64, min: i64) -> i64 {
            days_from_civil(y, m, d) * DAY + h * HOUR + min * 60
        }

        #[test]
        fn civil_round_trip() {
            for z in [-1, 0, 1, 10_957, 20_744, 20_758, 47_482] {
                let (y, m, d) = civil_from_days(z);
                assert_eq!(days_from_civil(y, m, d), z);
            }
            assert_eq!(civil_from_days(0), (1970, 1, 1));
            assert_eq!(nth_sunday(2026, 3, 2), days_from_civil(2026, 3, 8));
            assert_eq!(nth_sunday(2026, 11, 1), days_from_civil(2026, 11, 1));
            assert_eq!(nth_sunday(2027, 3, 2), days_from_civil(2027, 3, 14));
        }

        #[test]
        fn pacific_dst_edges() {
            // 2026年: 夏時間は 3/8 10:00 UTC から 11/1 9:00 UTC まで
            assert_eq!(pacific_offset_secs(utc(2026, 3, 8, 9, 59)), -8 * HOUR);
            assert_eq!(pacific_offset_secs(utc(2026, 3, 8, 10, 0)), -7 * HOUR);
            assert_eq!(pacific_offset_secs(utc(2026, 10, 18, 5, 0)), -7 * HOUR);
            assert_eq!(pacific_offset_secs(utc(2026, 11, 1, 8, 59)), -7 * HOUR);
            assert_eq!(pacific_offset_secs(utc(2026, 11, 1, 9, 0)), -8 * HOUR);
            assert_eq!(pacific_offset_secs(utc(2026, 1, 15, 0, 0)), -8 * HOUR);
        }

        #[test]
        fn pacific_day_and_reset() {
            // 日本時間 2026-10-18 14:00 (UTC 05:00) は太平洋時間 10/17 22:00。次に戻るのは日本時間 16:00 (UTC 07:00)
            let now = utc(2026, 10, 18, 5, 0);
            assert_eq!(pacific_day(now), "2026-10-17");
            assert_eq!(next_pacific_reset(now), utc(2026, 10, 18, 7, 0));
            assert_eq!(pacific_day(utc(2026, 10, 18, 7, 0)), "2026-10-18");
            assert_eq!(pacific_day(utc(2026, 10, 18, 6, 59)), "2026-10-17");
            // 冬は日本時間 17:00 (UTC 08:00)
            assert_eq!(next_pacific_reset(utc(2026, 12, 1, 3, 0)), utc(2026, 12, 1, 8, 0));
            // 夏時間が終わる日: 太平洋時間 11/1 0:00 は夏時間 (UTC 07:00)、11/2 0:00 は冬時間 (UTC 08:00)
            assert_eq!(next_pacific_reset(utc(2026, 11, 1, 3, 0)), utc(2026, 11, 1, 7, 0));
            assert_eq!(next_pacific_reset(utc(2026, 11, 1, 7, 0)), utc(2026, 11, 2, 8, 0));
        }

        #[test]
        fn plan_without_target_uses_min() {
            let now = utc(2026, 10, 18, 8, 0);
            let o = plan(PlanInput { now, target_end: None, used: 0, limit: 10_000, reserve: 0, active: 1, min_secs: 10 });
            assert_eq!(o.interval_secs, 10);
            assert!(o.reachable);
            assert_eq!(o.lasts_secs, 2_000 * 10); // 10,000 / 5 回 × 10 秒 = 約 5.6 時間
        }

        #[test]
        fn plan_target_stretches_interval() {
            // 上限が戻った直後に 8 時間の目標: 10,000 / 5 = 2,000 回を 8 時間に → 15 秒ごと
            let now = utc(2026, 10, 18, 7, 0);
            let o = plan(PlanInput { now, target_end: Some(now + 8 * HOUR), used: 0, limit: 10_000, reserve: 0, active: 1, min_secs: 10 });
            assert_eq!(o.interval_secs, 15);
            assert!(o.reachable);
            // 書き込み用に 1,200 残す → 1,760 回 → 17 秒ごと
            let o = plan(PlanInput { now, target_end: Some(now + 8 * HOUR), used: 0, limit: 10_000, reserve: 1_200, active: 1, min_secs: 10 });
            assert_eq!(o.interval_secs, 17);
            // 配信が2つ → 1回り 10 → 1,000 回 → 29 秒ごと
            let o = plan(PlanInput { now, target_end: Some(now + 8 * HOUR), used: 0, limit: 10_000, reserve: 0, active: 2, min_secs: 10 });
            assert_eq!(o.interval_secs, 29);
            // 目標が短ければ最短の間隔のまま
            let o = plan(PlanInput { now, target_end: Some(now + HOUR), used: 0, limit: 10_000, reserve: 0, active: 1, min_secs: 10 });
            assert_eq!(o.interval_secs, 10);
        }

        #[test]
        fn plan_target_until_reset() {
            // 上限が戻るまで 1 時間・目標は 6 時間先: 戻るまでもてばよいので、残り 500 (100 回) を 1 時間に → 36 秒ごと
            let now = utc(2026, 10, 18, 6, 0);
            let o = plan(PlanInput { now, target_end: Some(now + 6 * HOUR), used: 9_500, limit: 10_000, reserve: 0, active: 1, min_secs: 10 });
            assert_eq!(o.interval_secs, 36);
            assert!(o.reachable);
            assert_eq!(o.until_reset_secs, 3_600);
        }

        #[test]
        fn plan_target_unreachable() {
            let now = utc(2026, 10, 18, 7, 0);
            // 残り 100 (20 回) で 8 時間はもたない → いちばん長い間隔にして、もたないと知らせる
            let o = plan(PlanInput { now, target_end: Some(now + 8 * HOUR), used: 9_900, limit: 10_000, reserve: 0, active: 1, min_secs: 10 });
            assert_eq!(o.interval_secs, API_MAX_INTERVAL_SECS);
            assert!(!o.reachable);
            assert_eq!(o.lasts_secs, 20 * API_MAX_INTERVAL_SECS);
            // 使い切っている
            let o = plan(PlanInput { now, target_end: Some(now + HOUR), used: 10_000, limit: 10_000, reserve: 0, active: 1, min_secs: 10 });
            assert!(!o.reachable);
            assert_eq!(o.lasts_secs, 0);
            // 目標の時刻を過ぎたら最短の間隔に戻す
            let o = plan(PlanInput { now, target_end: Some(now - 1), used: 9_900, limit: 10_000, reserve: 0, active: 1, min_secs: 10 });
            assert_eq!(o.interval_secs, 10);
        }
    }
}

// ===== 暗号化して置く取得方法 (カギがあるときだけ組み込まれる) =====

#[cfg(yt_sealed)]
mod sealed {
    include!(concat!(env!("OUT_DIR"), "/sealed.rs"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn video_id_from_live_urls() {
        let id = "abcDEF12_-x";
        for u in [
            format!("https://www.youtube.com/watch?v={id}"),
            format!("youtube.com/watch?v={id}&t=10"),
            format!("https://m.youtube.com/watch?feature=share&v={id}"),
            format!("https://www.youtube.com/live/{id}?si=xyz"),
            format!("https://youtu.be/{id}"),
        ] {
            assert_eq!(video_id_from_url(&u).as_deref(), Some(id), "{u}");
        }
        for u in [
            "https://www.youtube.com/@channel",
            "https://www.youtube.com/@channel/live",
            "https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx",
            "https://www.youtube.com/watch?v=short",
            "https://evil.example/watch?v=abcDEF12_-x",
            "https://www.youtube.com.evil.example/watch?v=abcDEF12_-x",
            "javascript:alert(1)",
            "",
        ] {
            assert_eq!(video_id_from_url(u), None, "{u}");
        }
        assert_eq!(watch_url(id), format!("https://www.youtube.com/watch?v={id}"));
    }

    #[test]
    fn method_needs_valid_key() {
        assert!(method_from_id(API_METHOD_ID, None, 10, None).is_err());
        assert!(method_from_id(API_METHOD_ID, Some("bad key!".into()), 10, None).is_err());
        let m = method_from_id(API_METHOD_ID, Some("AIzaSyA-abcdefghijklmnopqrstuvwxyz0123".into()), 1, None).unwrap();
        match m {
            Method::Api { min_interval, .. } => assert_eq!(min_interval, Duration::from_secs(API_MIN_INTERVAL_SECS)),
            #[allow(unreachable_patterns)]
            _ => panic!(),
        }
        assert!(!format!("{:?}", method_from_id(API_METHOD_ID, Some("AIzaSyA-abcdefghijklmnopqrstuvwxyz0123".into()), 10, None).unwrap()).contains("AIza"));
        assert!(method_from_id("nope", None, 10, None).is_err());
        assert_eq!(methods()[0].id, API_METHOD_ID);
    }

    #[test]
    fn classify_errors() {
        let body = |reason: &str| json!({ "error": { "code": 403, "message": "x", "errors": [{ "reason": reason }] } }).to_string().into_bytes();
        assert!(matches!(classify_api_error(403, &body("quotaExceeded")), ApiFail::Stop(m) if m.contains("上限")));
        assert!(matches!(classify_api_error(403, &body("liveChatEnded")), ApiFail::Ended));
        assert!(matches!(classify_api_error(403, &body("rateLimitExceeded")), ApiFail::Retry(_)));
        assert!(matches!(classify_api_error(403, &body("accessNotConfigured")), ApiFail::Stop(m) if m.contains("有効")));
        let invalid = json!({ "error": { "code": 400, "message": "API key not valid. Please pass a valid API key.", "errors": [{ "reason": "badRequest" }] } }).to_string();
        assert!(matches!(classify_api_error(400, invalid.as_bytes()), ApiFail::Stop(m) if m.contains("API キー")));
        assert!(matches!(classify_api_error(503, b"oops"), ApiFail::Retry(_)));
        assert!(matches!(classify_api_error(404, &body("liveChatNotFound")), ApiFail::Stop(_)));
        assert!(is_quota_error(&body("quotaExceeded")));
        assert!(!is_quota_error(&body("rateLimitExceeded")));
        assert!(!is_quota_error(b"oops"));
    }

    #[test]
    fn resolve_only_live() {
        let v = |content: &str, chat: &str| json!({ "items": [{ "snippet": { "title": "配信", "liveBroadcastContent": content }, "liveStreamingDetails": { "activeLiveChatId": chat } }] });
        assert_eq!(resolve_from_videos(&v("live", "Cg0KC2Fi")).unwrap(), ("Cg0KC2Fi".to_string(), "配信".to_string()));
        assert!(resolve_from_videos(&v("upcoming", "Cg0KC2Fi")).is_ok());
        assert!(matches!(resolve_from_videos(&v("none", "")), Err(ApiFail::Stop(_))));
        assert!(matches!(resolve_from_videos(&v("live", "")), Err(ApiFail::Stop(_))));
        assert!(matches!(resolve_from_videos(&json!({ "items": [] })), Err(ApiFail::Stop(_))));
    }

    #[test]
    fn parse_api_items() {
        let author = json!({ "channelId": "UCabcdefghijklmnopqrstuv", "displayName": "なまえ", "isChatOwner": false, "isChatModerator": true, "isChatSponsor": true, "isVerified": false });
        let list = json!({
            "pollingIntervalMillis": 3000,
            "nextPageToken": "next1",
            "items": [
                { "id": "LCC.m1", "snippet": { "type": "textMessageEvent", "displayMessage": "こんにちは\u{0007}", "textMessageDetails": { "messageText": "こんにちは\u{0007}" } }, "authorDetails": author },
                { "id": "LCC.m2", "snippet": { "type": "superChatEvent", "superChatDetails": { "amountDisplayString": "¥1,000", "userComment": "応援" } }, "authorDetails": author },
                { "id": "LCC.m3", "snippet": { "type": "memberMilestoneChatEvent", "memberMilestoneChatDetails": { "memberMonth": 12, "memberLevelName": "ファン", "userComment": "" } }, "authorDetails": author },
                { "id": "LCC.m4", "snippet": { "type": "membershipGiftingEvent", "membershipGiftingDetails": { "giftMembershipsCount": 5, "giftMembershipsLevelName": "ファン" } }, "authorDetails": author },
                { "id": "LCC.m5", "snippet": { "type": "messageDeletedEvent", "messageDeletedDetails": { "deletedMessageId": "LCC.m1" } }, "authorDetails": author },
                { "id": "LCC.m6", "snippet": { "type": "userBannedEvent", "userBannedDetails": { "bannedUserDetails": { "channelId": "UCzzzzzzzzzzzzzzzzzzzzzz" } } }, "authorDetails": author },
                { "id": "LCC.m7", "snippet": { "type": "pollEvent" }, "authorDetails": author }
            ]
        });
        let (ups, token, wait, ended) = parse_api_list(&list);
        assert_eq!(token.as_deref(), Some("next1"));
        assert_eq!(wait, Some(Duration::from_millis(3000)));
        assert!(!ended);
        assert_eq!(ups.len(), 6);
        let Update::Message(m) = &ups[0] else { panic!() };
        assert_eq!((m.id.as_str(), m.text.as_str(), m.name.as_str(), m.channel_id.as_str()), ("LCC.m1", "こんにちは", "なまえ", "UCabcdefghijklmnopqrstuv"));
        assert!(m.roles.moderator && m.roles.member && !m.roles.owner && m.event.is_none());
        let Update::Message(sc) = &ups[1] else { panic!() };
        assert_eq!(sc.event.as_ref().map(|e| (e.kind.as_str(), e.amount.as_str())), Some(("superchat", "¥1,000")));
        assert_eq!(sc.text, "応援");
        let Update::Message(ms) = &ups[2] else { panic!() };
        assert_eq!(ms.event.as_ref().map(|e| (e.kind.as_str(), e.months)), Some(("milestone", 12)));
        let Update::Message(g) = &ups[3] else { panic!() };
        assert_eq!(g.event.as_ref().map(|e| (e.kind.as_str(), e.count)), Some(("gift", 5)));
        assert_eq!(ups[4], Update::Deleted("LCC.m1".into()));
        assert_eq!(ups[5], Update::DeletedByAuthor("UCzzzzzzzzzzzzzzzzzzzzzz".into()));
        let (_, _, _, ended) = parse_api_list(&json!({ "items": [{ "id": "x", "snippet": { "type": "chatEndedEvent" } }] }));
        assert!(ended);
        let (_, _, _, ended) = parse_api_list(&json!({ "offlineAt": "2026-10-18T00:00:00Z", "items": [] }));
        assert!(ended);
    }

    #[test]
    fn text_builder_emojis() {
        let mut tb = TextBuilder::default();
        tb.push_text("わら");
        tb.push_emoji(":_kusa:", "https://yt3.ggpht.com/abc=w48-h48-c-k-nd");
        tb.push_text("すごい");
        tb.push_emoji(":_bad:", "https://evil.example/x.png");
        let (text, emojis) = tb.finish();
        assert_eq!(text, "わら :_kusa: すごい :_bad:");
        assert_eq!(emojis.len(), 1);
        let cps: Vec<char> = text.chars().collect();
        let e = &emojis[0];
        assert_eq!(cps[e.start..=e.end].iter().collect::<String>(), ":_kusa:");
        assert!(emoji_url_ok("https://yt4.ggpht.com/a-b_c=s48"));
        assert!(!emoji_url_ok("https://yt3.ggpht.com/a\"onerror=x"));
        assert!(!emoji_url_ok("http://yt3.ggpht.com/abc"));
    }

    #[test]
    fn ids_are_checked() {
        assert_eq!(channel_id_or_empty("UCabcdefghijklmnopqrstuv"), "UCabcdefghijklmnopqrstuv");
        assert_eq!(channel_id_or_empty("UC<script>"), "");
        assert_eq!(message_id_or_empty("ChwKGkNJ-_=%3D"), "ChwKGkNJ-_=%3D");
        assert_eq!(message_id_or_empty("a b"), "");
        assert!(api_key_ok("AIzaSyA-abcdefghijklmnopqrstuvwxyz0123"));
        assert!(!api_key_ok("short"));
    }
}
