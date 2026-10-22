//! Twitch チャットの受信 (匿名 IRC over WebSocket。ログイン不要・読み取り専用)。
//!
//! `justinfanNNNNN` という匿名ユーザーで `irc-ws.chat.twitch.tv` に接続し、指定したチャンネルの発言 (PRIVMSG) と
//! お知らせ (USERNOTICE: サブスク・ギフト・レイドなど) を受け取る。こちらから発言することはない。
//! 接続が切れたら待ち時間を延ばしながら再接続する。
//!
//! イベントはログインなしで分かるものだけを扱う (TchViewer と同じ): USERNOTICE と、PRIVMSG の bits /
//! custom-reward-id / msg-id タグ。フォローや入力の無いチャンネルポイント報酬はログインが要るので扱わない。

use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use thiserror::Error;
use tokio_tungstenite::tungstenite::Message;

const IRC_URL: &str = "wss://irc-ws.chat.twitch.tv:443";
/// 接続 (TLS・WebSocket のハンドシェイク) を待つ上限
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Twitch は約5分ごとに PING を送ってくる。これより長く何も届かなければ切れたとみなして再接続する
const IDLE_TIMEOUT: Duration = Duration::from_secs(6 * 60);
/// 再接続までの待ち時間 (失敗が続くと倍々に延ばす)
const RETRY_MIN: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(60);
/// 1行の長さの上限 (Twitch の発言は最大500文字。タグを含めても十分な余裕を持たせる)
const MAX_LINE_BYTES: usize = 16 * 1024;

#[derive(Debug, Error)]
pub enum TwitchError {
    #[error("接続できませんでした: {0}")]
    Connect(String),
    #[error("接続がタイムアウトしました")]
    ConnectTimeout,
    #[error("一定時間何も届かなかったため切断しました")]
    Idle,
    #[error("Twitch から再接続を求められました")]
    ReconnectRequested,
    #[error("通信エラー: {0}")]
    Io(String),
    #[error("サーバーが接続を閉じました")]
    Closed,
}

/// 受信した1件の発言
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    /// 発言 ID (id タグ。英数字と - だけ。返信に使う。無ければ空)
    pub id: String,
    /// ログイン名 (英数字と `_`。ID 代わりに使う)
    pub login: String,
    /// 表示名 (無ければログイン名)
    pub name: String,
    /// 名前の色 (`#RRGGBB`。未設定なら空)
    pub color: String,
    pub text: String,
    /// イベント (サブスク・ビッツなど)。普通の発言なら None
    pub event: Option<ChatEvent>,
    /// バッジのタグ (例: "broadcaster/1,subscriber/12")。画像への変換は受け取った側で行う
    pub badges: String,
    /// スタンプの位置 (本文のコードポイント単位。開始位置の順)
    pub emotes: Vec<Emote>,
    /// ビッツのパワーアップで巨大化したスタンプを含む (巨大になるのは最後のスタンプ)
    pub giant: bool,
}

/// スタンプ1つの位置 (`id` は英数字と `_` `-` だけ。画像のアドレスに使う)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Emote {
    pub id: String,
    pub start: usize,
    pub end: usize,
}

/// emotes タグ ("25:0-4,12-16/1902:6-10") を読む。形の合わないものは捨て、本文の長さを超えるものも捨てる
fn parse_emotes(spec: &str, text_chars: usize) -> Vec<Emote> {
    let mut out = Vec::new();
    for part in spec.split('/') {
        let Some((id, ranges)) = part.split_once(':') else { continue };
        if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
            continue;
        }
        for r in ranges.split(',') {
            let Some((s, e)) = r.split_once('-') else { continue };
            let (Ok(s), Ok(e)) = (s.parse::<usize>(), e.parse::<usize>()) else { continue };
            if s <= e && e < text_chars && out.len() < 200 {
                out.push(Emote { id: id.to_string(), start: s, end: e });
            }
        }
    }
    out.sort_by_key(|e| e.start);
    // 重なっているものは捨てる
    let mut last_end: Option<usize> = None;
    out.retain(|e| {
        let ok = last_end.is_none_or(|le| e.start > le);
        if ok {
            last_end = Some(e.end);
        }
        ok
    });
    out
}

/// Twitch のイベントの種類と中身 (読み上げる文・表示は画面側で作る)
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChatEvent {
    /// "sub" / "resub" / "subgift" / "submysterygift" / "giftpaidupgrade" / "bits" / "raid" / "watchstreak" / "points" / "announcement"
    pub kind: String,
    pub months: u32,
    pub count: u32,
    pub bits: u32,
    pub viewers: u32,
    /// ギフトを受け取った人の表示名
    pub recipient: String,
    /// チャンネルポイントの報酬名 (分からなければ空)
    pub reward: String,
    /// チャンネルポイントの報酬 ID (報酬名を調べるのに使う。無ければ空)
    pub reward_id: String,
}

impl ChatEvent {
    fn new(kind: &str) -> Self {
        Self { kind: kind.into(), ..Default::default() }
    }
}

/// IRC の USERNOTICE をイベントにする。扱わない種類なら None
fn event_from_usernotice(tag: &dyn Fn(&str) -> String) -> Option<ChatEvent> {
    let p = |k: &str| tag(&format!("msg-param-{k}"));
    let n = |k: &str| p(k).parse::<u32>().unwrap_or(0);
    let e = match tag("msg-id").as_str() {
        "sub" | "resub" => {
            let mut e = ChatEvent::new(if tag("msg-id") == "sub" { "sub" } else { "resub" });
            e.months = n("cumulative-months").max(1);
            e
        }
        "subgift" | "anonsubgift" => {
            let mut e = ChatEvent::new("subgift");
            e.recipient = p("recipient-display-name");
            if e.recipient.trim().is_empty() {
                e.recipient = p("recipient-user-name");
            }
            e.months = n("months");
            e
        }
        "submysterygift" | "anonsubmysterygift" => {
            let mut e = ChatEvent::new("submysterygift");
            e.count = n("mass-gift-count").max(1);
            e
        }
        "giftpaidupgrade" | "anongiftpaidupgrade" | "primepaidupgrade" => ChatEvent::new("giftpaidupgrade"),
        "raid" => {
            let mut e = ChatEvent::new("raid");
            e.viewers = n("viewerCount");
            e
        }
        "viewermilestone" if p("category") == "watch-streak" => {
            let mut e = ChatEvent::new("watchstreak");
            e.count = n("value");
            e
        }
        "announcement" => ChatEvent::new("announcement"),
        _ => return None,
    };
    Some(e)
}

/// 接続状態の通知
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Connecting,
    Connected,
    /// 切断した。理由と、次に再接続するまでの秒数
    Disconnected { reason: String, retry_in_secs: u64 },
}

/// "name" / "#name" / "https://www.twitch.tv/name" などからチャンネル名を取り出す。
/// Twitch のチャンネル名の規則 (英小文字・数字・`_`、1〜25文字) に合わないものは None。
/// IRC の命令に埋め込むので、改行などが紛れ込まないよう、ここで厳密に検査する。
pub fn normalize_channel(raw: &str) -> Option<String> {
    let s = raw.trim().to_ascii_lowercase();
    let s = s
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.")
        .trim_start_matches("m.")
        .trim_start_matches("twitch.tv/")
        .trim_start_matches('#');
    let name = s.split(['/', '?', '#']).next().unwrap_or("");
    let valid = (1..=25).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    valid.then(|| name.to_string())
}

fn unescape_tag(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut it = v.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('s') => out.push(' '),
            Some(':') => out.push(';'),
            Some('\\') => out.push('\\'),
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some(o) => out.push(o),
            None => {}
        }
    }
    out
}

/// IRC の1行が発言 (PRIVMSG) かイベント (扱う種類の USERNOTICE) なら読み取る。それ以外 (参加通知など) は None。
pub fn parse_privmsg(line: &str) -> Option<ChatMessage> {
    parse_line(line).map(|(m, _)| m)
}

/// 色のタグ (#RRGGBB 以外は空にする)
fn sanitize_color(color: &str) -> String {
    if color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|b| b.is_ascii_hexdigit()) {
        color.to_string()
    } else {
        String::new()
    }
}

/// バッジのタグ (英数字・_・-・/・, だけ。長すぎるものは切る)
fn sanitize_badges(tag: &str) -> String {
    if tag.len() > 512 || !tag.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'/' | b',')) {
        return String::new();
    }
    tag.to_string()
}

/// [`parse_privmsg`] の本体。まとめてギフトの重複を除くため、ギフトの ID も返す
fn parse_line(line: &str) -> Option<(ChatMessage, Vec<String>)> {
    let mut tags: Vec<(&str, String)> = Vec::new();
    let mut rest = line;
    if let Some(r) = rest.strip_prefix('@') {
        let (t, r) = r.split_once(' ')?;
        for kv in t.split(';') {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            tags.push((k, unescape_tag(v)));
        }
        rest = r;
    }
    let tag = |key: &str| tags.iter().find(|(k, _)| *k == key).map(|(_, v)| v.as_str()).unwrap_or("");
    let gift_ids: Vec<String> = ["msg-param-community-gift-id", "msg-param-origin-id"]
        .iter()
        .map(|k| tag(k).to_string())
        .filter(|v| !v.is_empty())
        .collect();
    // :login!login@login.tmi.twitch.tv PRIVMSG #channel :text
    // :tmi.twitch.tv USERNOTICE #channel[ :text]
    let rest = rest.strip_prefix(':')?;
    let (prefix, rest) = rest.split_once(' ')?;
    if let Some(r) = rest.strip_prefix("USERNOTICE ") {
        let event = event_from_usernotice(&|k: &str| tag(k).to_string())?;
        let text = r.split_once(" :").map(|(_, t)| t.to_string()).unwrap_or_default();
        // ログイン名は ID 代わりに使うので、英数字と _ 以外が来たら使わない
        let login = tag("login").to_ascii_lowercase();
        let login = if !login.is_empty() && login.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') { login } else { "twitch".to_string() };
        let display = tag("display-name");
        let name = if display.trim().is_empty() { login.clone() } else { display.to_string() };
        let badges = sanitize_badges(tag("badges"));
        let emotes = parse_emotes(tag("emotes"), text.chars().count());
        return Some((ChatMessage { id: message_id(tag("id")), login, name, color: sanitize_color(tag("color")), text, event: Some(event), badges, emotes, giant: false }, gift_ids));
    }
    let rest = rest.strip_prefix("PRIVMSG ")?;
    let (_, text) = rest.split_once(" :")?;
    let login = prefix.split('!').next()?.to_string();
    if login.is_empty() {
        return None;
    }
    let mut text = text.to_string();
    // /me で送った発言は \x01ACTION ...\x01 で包まれている
    if let Some(a) = text.strip_prefix("\u{1}ACTION ").and_then(|t| t.strip_suffix('\u{1}')) {
        text = a.to_string();
    }
    let display = tag("display-name");
    let name = if display.trim().is_empty() { login.clone() } else { display.to_string() };
    // ビッツの応援・チャンネルポイント (入力つきの報酬)・ハイライトメッセージはイベントとして扱う
    let event = if let Ok(bits) = tag("bits").parse::<u32>() {
        let mut e = ChatEvent::new("bits");
        e.bits = bits;
        Some(e)
    } else if !tag("custom-reward-id").is_empty() {
        let mut e = ChatEvent::new("points");
        e.reward_id = tag("custom-reward-id").chars().take(64).collect();
        Some(e)
    } else if tag("msg-id") == "highlighted-message" {
        let mut e = ChatEvent::new("points");
        e.reward = "メッセージをハイライト".into();
        Some(e)
    } else {
        None
    };
    let emotes = parse_emotes(tag("emotes"), text.chars().count());
    // パワーアップでスタンプを巨大化したメッセージには msg-id=gigantified-emote-message が付く
    let giant = !emotes.is_empty() && tag("msg-id") == "gigantified-emote-message";
    Some((ChatMessage { id: message_id(tag("id")), login, name, color: sanitize_color(tag("color")), text, event, badges: sanitize_badges(tag("badges")), emotes, giant }, gift_ids))
}

/// 発言 ID (英数字と - の 1〜64 文字。形が違えば空)
fn message_id(v: &str) -> String {
    if (1..=64).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        v.to_string()
    } else {
        String::new()
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 指定チャンネルのチャットを受信し続ける (タスクを中断するまで戻らない)。
/// `channel` は [`normalize_channel`] を通した値であること。
pub async fn run_channel<M, S>(channel: String, mut on_message: M, mut on_status: S)
where
    M: FnMut(ChatMessage) + Send,
    S: FnMut(Status) + Send,
{
    let Some(channel) = normalize_channel(&channel) else {
        on_status(Status::Disconnected { reason: "チャンネル名が不正です".into(), retry_in_secs: 0 });
        return;
    };
    let mut retry = RETRY_MIN;
    loop {
        on_status(Status::Connecting);
        let started = std::time::Instant::now();
        let result = connect_once(&channel, &mut on_message, &mut on_status).await;
        // しばらく安定して受信できていたなら、次の待ち時間は最短に戻す
        if started.elapsed() > Duration::from_secs(60) {
            retry = RETRY_MIN;
        }
        let reason = match result {
            Ok(()) => TwitchError::Closed.to_string(),
            Err(e) => e.to_string(),
        };
        on_status(Status::Disconnected { reason, retry_in_secs: retry.as_secs() });
        tokio::time::sleep(retry).await;
        retry = (retry * 2).min(RETRY_MAX);
    }
}

async fn connect_once<M, S>(channel: &str, on_message: &mut M, on_status: &mut S) -> Result<(), TwitchError>
where
    M: FnMut(ChatMessage) + Send,
    S: FnMut(Status) + Send,
{
    let (ws, _) = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(IRC_URL))
        .await
        .map_err(|_| TwitchError::ConnectTimeout)?
        .map_err(|e| TwitchError::Connect(e.to_string()))?;
    let (mut tx, mut rx) = ws.split();
    let nick = format!("justinfan{}", 10000 + (u64::from(std::process::id()) * 7919 + now_ms()) % 80000);
    for line in [
        "CAP REQ :twitch.tv/tags twitch.tv/commands".to_string(),
        "PASS SCHMOOPIIE".to_string(),
        format!("NICK {nick}"),
        format!("JOIN #{channel}"),
    ] {
        tx.send(Message::text(line)).await.map_err(|e| TwitchError::Io(e.to_string()))?;
    }
    on_status(Status::Connected);
    // まとめてギフトの後に1件ずつ届くギフトの通知は、まとめて1回にする (同じギフト ID を持つ)
    let mut bomb_ids: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    loop {
        let next = tokio::time::timeout(IDLE_TIMEOUT, rx.next()).await.map_err(|_| TwitchError::Idle)?;
        let Some(msg) = next else { return Ok(()) };
        let msg = msg.map_err(|e| TwitchError::Io(e.to_string()))?;
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => return Ok(()),
            _ => continue,
        };
        for line in text.split("\r\n").filter(|l| !l.is_empty() && l.len() <= MAX_LINE_BYTES) {
            if line.starts_with("PING") {
                tx.send(Message::text("PONG :tmi.twitch.tv")).await.map_err(|e| TwitchError::Io(e.to_string()))?;
                continue;
            }
            if line.contains(" RECONNECT") && line.starts_with(":tmi.twitch.tv") {
                return Err(TwitchError::ReconnectRequested);
            }
            if let Some((m, gift_ids)) = parse_line(line) {
                match m.event.as_ref().map(|e| e.kind.as_str()) {
                    Some("submysterygift") => {
                        bomb_ids.extend(gift_ids);
                        while bomb_ids.len() > 200 {
                            bomb_ids.pop_front();
                        }
                    }
                    Some("subgift") if gift_ids.iter().any(|g| bomb_ids.contains(g)) => continue,
                    _ => {}
                }
                on_message(m);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_channel_accepts_common_forms() {
        assert_eq!(normalize_channel("https://www.twitch.tv/Some_One?x=1").as_deref(), Some("some_one"));
        assert_eq!(normalize_channel("twitch.tv/abc/videos").as_deref(), Some("abc"));
        assert_eq!(normalize_channel("https://m.twitch.tv/abc").as_deref(), Some("abc"));
        assert_eq!(normalize_channel("#abc").as_deref(), Some("abc"));
        assert_eq!(normalize_channel("  Abc_123  ").as_deref(), Some("abc_123"));
    }

    #[test]
    fn normalize_channel_rejects_injection_and_invalid() {
        assert_eq!(normalize_channel("a\r\nJOIN #b"), None);
        assert_eq!(normalize_channel("a b"), None);
        assert_eq!(normalize_channel(""), None);
        assert_eq!(normalize_channel("あいう"), None);
        assert_eq!(normalize_channel(&"a".repeat(26)), None);
        assert_eq!(normalize_channel("abc-def"), None);
    }

    #[test]
    fn parse_privmsg_reads_tags() {
        let line = "@badges=subscriber/12;color=#FF0000;display-name=テスト;emotes=25:0-4 :foo!foo@foo.tmi.twitch.tv PRIVMSG #bar :Kappa こんにちは";
        let m = parse_privmsg(line).unwrap();
        assert_eq!(m.name, "テスト");
        assert_eq!(m.login, "foo");
        assert_eq!(m.color, "#FF0000");
        assert_eq!(m.text, "Kappa こんにちは");
    }

    #[test]
    fn parse_privmsg_handles_action_escape_and_fallbacks() {
        let m = parse_privmsg(":foo!foo@foo.tmi.twitch.tv PRIVMSG #bar :\u{1}ACTION 手を振る\u{1}").unwrap();
        assert_eq!((m.name.as_str(), m.text.as_str(), m.color.as_str()), ("foo", "手を振る", ""));
        let m = parse_privmsg("@display-name=A\\sB;color=red :a!a@a.tmi.twitch.tv PRIVMSG #bar :x").unwrap();
        assert_eq!((m.name.as_str(), m.color.as_str()), ("A B", ""));
    }

    #[test]
    fn parse_privmsg_ignores_other_commands() {
        assert!(parse_privmsg(":tmi.twitch.tv 001 justinfan1 :Welcome").is_none());
        assert!(parse_privmsg("@msg-id=ritual :tmi.twitch.tv USERNOTICE #bar :はじめまして").is_none());
        assert!(parse_privmsg("PING :tmi.twitch.tv").is_none());
        assert!(parse_privmsg(":foo!foo@foo.tmi.twitch.tv JOIN #bar").is_none());
    }

    #[test]
    fn usernotice_events() {
        let m = parse_privmsg("@display-name=ハナコ;login=hanako;msg-id=resub;msg-param-cumulative-months=12 :tmi.twitch.tv USERNOTICE #bar :いつも見てます").unwrap();
        let e = m.event.unwrap();
        assert_eq!((e.kind.as_str(), e.months, m.name.as_str(), m.login.as_str(), m.text.as_str()), ("resub", 12, "ハナコ", "hanako", "いつも見てます"));
        let m = parse_privmsg("@display-name=A;msg-id=raid;msg-param-viewerCount=30;login=a :tmi.twitch.tv USERNOTICE #bar").unwrap();
        let e = m.event.unwrap();
        assert_eq!((e.kind.as_str(), e.viewers, m.text.as_str()), ("raid", 30, ""));
        let m = parse_privmsg("@msg-id=subgift;login=b;display-name=B;msg-param-recipient-display-name=たろう :tmi.twitch.tv USERNOTICE #bar").unwrap();
        assert_eq!(m.event.unwrap().recipient, "たろう");
        let m = parse_privmsg("@msg-id=viewermilestone;msg-param-category=watch-streak;msg-param-value=5;login=c :tmi.twitch.tv USERNOTICE #bar :きた").unwrap();
        assert_eq!(m.event.unwrap().count, 5);
        // ログイン名に変な文字が来たら使わない
        let m = parse_privmsg("@msg-id=announcement;login=a\\sb :tmi.twitch.tv USERNOTICE #bar :お知らせ").unwrap();
        assert_eq!((m.login.as_str(), m.event.unwrap().kind.as_str()), ("twitch", "announcement"));
    }

    #[test]
    fn privmsg_events() {
        let m = parse_privmsg("@bits=100;display-name=B :b!b@b.tmi.twitch.tv PRIVMSG #bar :Cheer100 がんばれ").unwrap();
        let e = m.event.unwrap();
        assert_eq!((e.kind.as_str(), e.bits), ("bits", 100));
        let m = parse_privmsg("@custom-reward-id=abc;display-name=C :c!c@c.tmi.twitch.tv PRIVMSG #bar :リクエスト").unwrap();
        assert_eq!(m.event.unwrap().reward_id, "abc");
        let m = parse_privmsg("@badges=broadcaster/1,subscriber/12 :f!f@f.tmi.twitch.tv PRIVMSG #bar :x").unwrap();
        assert_eq!(m.badges, "broadcaster/1,subscriber/12");
        let m = parse_privmsg("@badges=a/1<script> :f!f@f.tmi.twitch.tv PRIVMSG #bar :x").unwrap();
        assert_eq!(m.badges, "");
        let m = parse_privmsg("@msg-id=highlighted-message :d!d@d.tmi.twitch.tv PRIVMSG #bar :目立つ").unwrap();
        assert_eq!(m.event.unwrap().reward, "メッセージをハイライト");
        assert!(parse_privmsg(":e!e@e.tmi.twitch.tv PRIVMSG #bar :ふつう").unwrap().event.is_none());
    }

    #[test]
    fn emotes_and_giant() {
        let m = parse_privmsg("@emotes=25:0-4,12-16/1902:6-10 :a!a@a.tmi.twitch.tv PRIVMSG #bar :Kappa Keepo Kappa").unwrap();
        assert_eq!(m.emotes.iter().map(|e| (e.id.as_str(), e.start, e.end)).collect::<Vec<_>>(), vec![("25", 0, 4), ("1902", 6, 10), ("25", 12, 16)]);
        assert!(!m.giant);
        let m = parse_privmsg("@emotes=emotesv2_abc:3-7;msg-id=gigantified-emote-message :a!a@a.tmi.twitch.tv PRIVMSG #bar :やあ kaede").unwrap();
        assert_eq!((m.emotes.len(), m.giant), (1, true));
        // 本文より長い位置・変な ID は捨てる
        let m = parse_privmsg("@emotes=25:0-40/a<b:0-1 :a!a@a.tmi.twitch.tv PRIVMSG #bar :Kappa").unwrap();
        assert!(m.emotes.is_empty());
    }

    #[test]
    fn gift_bomb_ids_are_returned() {
        let (m, ids) = parse_line("@msg-id=submysterygift;login=g;msg-param-mass-gift-count=5;msg-param-origin-id=xyz :tmi.twitch.tv USERNOTICE #bar").unwrap();
        assert_eq!((m.event.unwrap().count, ids), (5, vec!["xyz".to_string()]));
    }
}
