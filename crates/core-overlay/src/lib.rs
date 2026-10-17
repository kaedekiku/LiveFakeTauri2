//! OBS のブラウザソース向けの表示サーバー (TchViewer の方式を移植)。
//!
//! - 待ち受けは 127.0.0.1 だけ。外の PC からは見えない
//! - 配るのは OBS が読むものだけ: オーバーレイのページ (/overlay.html)、レイアウトごとの見た目の設定 (/api/appearance)
//!   と追加 CSS (/layout.css)、表示する内容の配信 (/ws)。設定を変える窓口は持たない (LiveFake 本体とは Tauri の命令でやり取りする)
//! - レイアウトは名前を付けて複数持てる (OBS 側は overlay.html?layout=名前 で使い分ける。「標準」は必ずある)
//! - DNS リバインディング対策として、Host ヘッダーが 127.0.0.1 / localhost (+ 待ち受けポート) 以外の要求は拒否する
//! - WebSocket は CORS の対象外なので、普通のブラウザで開いた悪意のあるページからの接続を防ぐため、
//!   Origin ヘッダーがあるときは同じ 127.0.0.1 / localhost (+ ポート) のときだけ受け付ける (OBS は同じ場所から開くので通る)

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use thiserror::Error;
use tokio::sync::{broadcast, oneshot};

const OVERLAY_HTML: &str = include_str!("../overlay.html");
/// ページの中の版の置き場所 (配るときにページの中身から計算した版に置き換える)
const PAGE_VERSION_PLACEHOLDER: &str = "__LF_PAGE_VERSION__";

/// OBS 表示のページの版 (ページの中身の FNV-1a ハッシュ)。LiveFake を更新してページが変わると版も変わる
fn page_version() -> &'static str {
    static V: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    V.get_or_init(|| {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in OVERLAY_HTML.bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        format!("{h:016x}")
    })
}

/// 配るページ (版を埋め込んだもの)
fn page_html() -> &'static str {
    static P: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    P.get_or_init(|| OVERLAY_HTML.replace(PAGE_VERSION_PLACEHOLDER, page_version()))
}
/// 再接続した OBS に送り直すための履歴の件数
const HISTORY_MAX: usize = 200;
/// 見た目の設定 (JSON) の大きさの上限
const APPEARANCE_MAX_BYTES: usize = 32 * 1024;
/// レイアウトの追加 CSS の大きさの上限
const CSS_MAX_BYTES: usize = 256 * 1024;
/// レイアウトの数・名前の長さの上限
const LAYOUTS_MAX: usize = 50;
const LAYOUT_NAME_MAX_CHARS: usize = 40;
/// 消せない既定のレイアウト
pub const DEFAULT_LAYOUT: &str = "標準";
/// 1件の文字列項目の長さの上限 (文字数)
const FIELD_MAX_CHARS: usize = 5000;

#[derive(Debug, Error)]
pub enum OverlayError {
    #[error("ポート {0} は使用中です (別のソフトが使っているか、LiveFake がすでに起動しています)")]
    PortInUse(u16),
    #[error("ポート {port} で待ち受けできませんでした: {message}")]
    Bind { port: u16, message: String },
    #[error("見た目の設定が大きすぎるか、形式が違います")]
    InvalidAppearance,
    #[error("レイアウト名「{0}」は使えません (1〜40文字。\\ / : * ? \" < > | % # & と前後の空白・ピリオドは不可)")]
    InvalidLayoutName(String),
    #[error("追加 CSS が大きすぎます (256KB まで)")]
    CssTooLarge,
    #[error("レイアウトが多すぎます ({0} 個まで)")]
    TooManyLayouts(usize),
}

/// 表示する1件 (LiveFake の画面側から受け取る)
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayComment {
    /// "twitch" / "youtube" / "5ch" / "shitaraba" / "jpnkn"
    pub source: String,
    pub site: String,
    #[serde(default)]
    pub no: Option<u32>,
    pub name: String,
    /// 掲示板の ID (Twitch は空)
    #[serde(default)]
    pub uid: String,
    pub text: String,
    /// Twitch の名前の色 (#RRGGBB。無ければ空)
    #[serde(default)]
    pub color: String,
    /// Twitch のイベント (サブスク・ビッツなど)。普通の発言なら None
    #[serde(default)]
    pub event: Option<OverlayEvent>,
    /// Twitch のバッジ (画像アドレスは static-cdn.jtvnw.net/badges/v1/<uuid> だけ通す)
    #[serde(default)]
    pub badge_list: Vec<OverlayBadge>,
    /// Twitch のスタンプの位置 (本文のコードポイント単位)
    #[serde(default)]
    pub emotes: Vec<OverlayEmote>,
    /// 最後のスタンプが巨大化している
    #[serde(default)]
    pub giant: bool,
    /// 後で消すときの目印 (YouTube で削除された発言を消すのに使う。英数字と一部の記号のみ)
    #[serde(default)]
    pub key: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct OverlayEmote {
    pub id: String,
    pub start: usize,
    pub end: usize,
    /// このスタンプだけ巨大表示する (掲示板などで「BIG」+スタンプ名と書かれたもの)
    #[serde(default)]
    pub giant: bool,
    /// YouTube のチャンネル独自の絵文字の画像 (YouTube の画像配信サーバーのものだけ通す)。Twitch は空
    #[serde(default)]
    pub url: String,
}

fn emote_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// YouTube の絵文字の画像アドレス (yt3/yt4.ggpht.com だけ。表示側でも同じ検査をする)
fn youtube_emoji_url_ok(url: &str) -> bool {
    let rest = url.strip_prefix("https://yt3.ggpht.com/").or_else(|| url.strip_prefix("https://yt4.ggpht.com/"));
    rest.is_some_and(|r| {
        !r.is_empty() && url.len() <= 512 && r.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'=' | b'/' | b'.' | b'~'))
    })
}

/// 消すときの目印として使えるか
fn key_ok(key: &str) -> bool {
    (1..=300).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'=' | b'%' | b':' | b'+' | b'/'))
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct OverlayBadge {
    #[serde(default)]
    pub title: String,
    pub url: String,
}

const BADGE_PREFIX: &str = "https://static-cdn.jtvnw.net/badges/v1/";

fn badge_ok(url: &str) -> bool {
    url.strip_prefix(BADGE_PREFIX)
        .is_some_and(|u| !u.is_empty() && u.len() <= 64 && u.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
}

/// OBS 表示に出すイベントの見出し
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayEvent {
    /// 種類 (英小文字のみ。CSS のクラス名 .ev-種類 に使う)
    pub kind: String,
    /// 種類の表示名 (サブスク など)
    pub label: String,
    /// 1行の要約 (ハナコさんがサブスクしました など)
    pub summary: String,
}

/// レイアウト1つ分 (見た目の設定と追加 CSS)
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OverlayLayout {
    pub appearance: serde_json::Value,
    pub css: String,
}

/// レイアウト名として使えるか (URL の ?layout= に入るので、紛らわしい文字は受け付けない)
pub fn layout_name_ok(name: &str) -> bool {
    let n = name.chars().count();
    (1..=LAYOUT_NAME_MAX_CHARS).contains(&n)
        && name.trim() == name
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.chars().any(|c| c.is_control() || "\\/:*?\"<>|%#&".contains(c))
}

fn clip(s: &str) -> String {
    s.chars().filter(|c| !c.is_control() || *c == '\n').take(FIELD_MAX_CHARS).collect()
}

/// 表示内容の配信と、見た目の設定を持つ。サーバーを止めたり立て直したりしても残る
pub struct OverlayHub {
    tx: broadcast::Sender<String>,
    history: Mutex<VecDeque<String>>,
    layouts: Mutex<HashMap<String, OverlayLayout>>,
    boot: u64,
    seq: AtomicU64,
}

impl Default for OverlayHub {
    fn default() -> Self {
        Self::new()
    }
}

impl OverlayHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(1024);
        let boot = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut layouts = HashMap::new();
        layouts.insert(DEFAULT_LAYOUT.to_string(), OverlayLayout { appearance: serde_json::json!({}), css: String::new() });
        Self { tx, history: Mutex::new(VecDeque::new()), layouts: Mutex::new(layouts), boot, seq: AtomicU64::new(0) }
    }

    /// 表示する内容を配る (出どころが不明なものは捨てる)
    pub fn publish(&self, items: &[OverlayComment]) {
        for c in items.iter().take(HISTORY_MAX) {
            if !matches!(c.source.as_str(), "twitch" | "youtube" | "5ch" | "shitaraba" | "jpnkn") {
                continue;
            }
            let color = if c.color.len() == 7 && c.color.starts_with('#') && c.color[1..].bytes().all(|b| b.is_ascii_hexdigit()) {
                c.color.clone()
            } else {
                String::new()
            };
            // スタンプは正しい ID と本文の範囲内の位置だけ (掲示板に書かれたスタンプ名も画像にするので出どころは問わない)
            let n = c.text.chars().count();
            let emotes: Vec<serde_json::Value> = c
                .emotes
                .iter()
                .filter(|e| emote_id_ok(&e.id) && e.start <= e.end && e.end < n)
                .filter(|e| e.url.is_empty() || (c.source == "youtube" && youtube_emoji_url_ok(&e.url)))
                .take(200)
                .map(|e| {
                    let mut v = serde_json::json!({ "id": e.id, "start": e.start, "end": e.end, "giant": e.giant });
                    if !e.url.is_empty() {
                        v["url"] = serde_json::Value::String(e.url.clone());
                    }
                    v
                })
                .collect();
            // Twitch・YouTube のチャットはイベント (サブスク・スーパーチャットなど) の見出しを出せる
            let chat = matches!(c.source.as_str(), "twitch" | "youtube");
            let id = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
            let msg = serde_json::json!({
                "type": "comment",
                "id": id,
                "boot": self.boot,
                "source": c.source,
                "site": clip(&c.site),
                "no": c.no,
                "name": clip(&c.name),
                "uid": clip(&c.uid),
                "text": clip(&c.text),
                "color": color,
                "badgeList": if c.source == "twitch" {
                    c.badge_list.iter().filter(|b| badge_ok(&b.url)).take(10)
                        .map(|b| serde_json::json!({ "title": clip(&b.title), "url": b.url })).collect::<Vec<_>>()
                } else { Vec::new() },
                "emotes": emotes,
                "giant": c.source == "twitch" && c.giant,
                "key": if key_ok(&c.key) { c.key.clone() } else { String::new() },
                "event": c.event.as_ref().filter(|_| chat).map(|e| serde_json::json!({
                    "kind": e.kind.chars().filter(|ch| ch.is_ascii_lowercase()).take(20).collect::<String>(),
                    "label": clip(&e.label),
                    "summary": clip(&e.summary),
                })),
            })
            .to_string();
            {
                let mut h = self.history.lock().unwrap_or_else(|e| e.into_inner());
                h.push_back(msg.clone());
                while h.len() > HISTORY_MAX {
                    h.pop_front();
                }
            }
            let _ = self.tx.send(msg);
        }
    }

    /// 目印 (key) の付いた表示を消す (YouTube で削除された発言)。履歴からも除き、表示中の OBS に知らせる
    pub fn retract(&self, keys: &[String]) {
        let keys: Vec<&String> = keys.iter().filter(|k| key_ok(k)).take(HISTORY_MAX).collect();
        if keys.is_empty() {
            return;
        }
        {
            let mut h = self.history.lock().unwrap_or_else(|e| e.into_inner());
            h.retain(|msg| {
                let k = serde_json::from_str::<serde_json::Value>(msg).ok().and_then(|v| v["key"].as_str().map(str::to_string)).unwrap_or_default();
                k.is_empty() || !keys.iter().any(|x| **x == k)
            });
        }
        let _ = self.tx.send(serde_json::json!({ "type": "remove", "keys": keys }).to_string());
    }

    /// レイアウトの一覧をまるごと差し替え、変わったものを表示中の OBS に知らせる (値の検証は表示側でも行う)。
    /// 「標準」が無ければ空の設定で足す
    pub fn set_layouts(&self, layouts: HashMap<String, OverlayLayout>) -> Result<(), OverlayError> {
        if layouts.len() > LAYOUTS_MAX {
            return Err(OverlayError::TooManyLayouts(LAYOUTS_MAX));
        }
        for (name, l) in &layouts {
            if !layout_name_ok(name) {
                return Err(OverlayError::InvalidLayoutName(name.clone()));
            }
            if !(l.appearance.is_object() || l.appearance.is_null()) || l.appearance.to_string().len() > APPEARANCE_MAX_BYTES {
                return Err(OverlayError::InvalidAppearance);
            }
            if l.css.len() > CSS_MAX_BYTES {
                return Err(OverlayError::CssTooLarge);
            }
        }
        let mut next = layouts;
        next.entry(DEFAULT_LAYOUT.to_string()).or_default();
        let mut guard = self.layouts.lock().unwrap_or_else(|e| e.into_inner());
        for (name, l) in &next {
            let old = guard.get(name);
            if old.map(|o| o.appearance != l.appearance).unwrap_or(true) {
                let _ = self.tx.send(serde_json::json!({ "type": "appearance", "layout": name, "appearance": l.appearance }).to_string());
            }
            if old.map(|o| o.css != l.css).unwrap_or(true) {
                let _ = self.tx.send(serde_json::json!({ "type": "layout_css", "layout": name }).to_string());
            }
        }
        *guard = next;
        Ok(())
    }

    /// 指定のレイアウト (無い・使えない名前なら「標準」) の名前と中身
    fn layout(&self, name: Option<&str>) -> (String, OverlayLayout) {
        let guard = self.layouts.lock().unwrap_or_else(|e| e.into_inner());
        let name = name.map(str::trim).filter(|n| guard.contains_key(*n)).unwrap_or(DEFAULT_LAYOUT).to_string();
        let l = guard.get(&name).cloned().unwrap_or_default();
        (name, l)
    }

    fn recent(&self, n: usize) -> Vec<String> {
        let h = self.history.lock().unwrap_or_else(|e| e.into_inner());
        h.iter().skip(h.len().saturating_sub(n)).cloned().collect()
    }
}

#[derive(Clone)]
struct ServerState {
    hub: Arc<OverlayHub>,
    port: u16,
}

/// 動いているサーバー。drop か [`RunningServer::stop`] で止まり、ポートを空ける
pub struct RunningServer {
    port: u16,
    shutdown: Option<oneshot::Sender<()>>,
}

impl RunningServer {
    pub fn port(&self) -> u16 {
        self.port
    }
    pub fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

/// 127.0.0.1:port で待ち受けを始める。待ち受けに失敗したら (使用中など) エラーを返す。
/// tokio のランタイム上で呼ぶこと
pub async fn start(hub: Arc<OverlayHub>, port: u16) -> Result<RunningServer, OverlayError> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            OverlayError::PortInUse(port)
        } else {
            OverlayError::Bind { port, message: e.to_string() }
        }
    })?;
    let (tx, rx) = oneshot::channel::<()>();
    let router = router(ServerState { hub, port });
    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
    });
    Ok(RunningServer { port, shutdown: Some(tx) })
}

fn router(state: ServerState) -> Router {
    Router::new()
        // OBS のブラウザソースが古いページを使い続けないよう、保存させない (更新後もすぐ新しいページになる)
        .route("/overlay.html", get(|| async { ([(header::CACHE_CONTROL, "no-store")], Html(page_html())).into_response() }))
        .route("/api/appearance", get(get_appearance))
        .route("/layout.css", get(get_layout_css))
        .route("/ws", get(ws))
        .layer(middleware::from_fn_with_state(state.clone(), check_host))
        .with_state(state)
}

/// Host ヘッダーがこの PC の待ち受けポート宛てか
pub fn host_allowed(host: &str, port: u16) -> bool {
    [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")].iter().any(|a| a.eq_ignore_ascii_case(host))
}

/// Origin ヘッダーが無い (OBS などのアプリ・同じ場所からの読み込み) か、同じ 127.0.0.1 / localhost のページか
pub fn origin_allowed(origin: Option<&str>, port: u16) -> bool {
    match origin {
        None => true,
        Some(o) => [format!("http://127.0.0.1:{port}"), format!("http://localhost:{port}")].iter().any(|a| a.eq_ignore_ascii_case(o)),
    }
}

async fn check_host(State(state): State<ServerState>, req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !host_allowed(host, state.port) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    next.run(req).await
}

async fn get_appearance(State(state): State<ServerState>, Query(q): Query<HashMap<String, String>>) -> Response {
    let (name, l) = state.hub.layout(q.get("layout").map(String::as_str));
    let mut res = Json(serde_json::json!({ "layout": name, "appearance": l.appearance })).into_response();
    res.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    res
}

/// レイアウトの追加 CSS (OBS 側で <link> として読み込む)
async fn get_layout_css(State(state): State<ServerState>, Query(q): Query<HashMap<String, String>>) -> Response {
    let (_, l) = state.hub.layout(q.get("layout").map(String::as_str));
    ([(header::CONTENT_TYPE, "text/css; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], l.css).into_response()
}

async fn ws(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let origin = headers.get(header::ORIGIN).and_then(|h| h.to_str().ok());
    if !origin_allowed(origin, state.port) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let n = q.get("history").and_then(|s| s.parse::<usize>().ok()).unwrap_or(15).min(HISTORY_MAX);
    upgrade.on_upgrade(move |socket| stream_to(socket, state.hub, n))
}

async fn stream_to(mut socket: WebSocket, hub: Arc<OverlayHub>, history: usize) {
    // 先に購読してから履歴を送る (取りこぼし防止。重複は表示側が id で除く)
    let mut rx = hub.tx.subscribe();
    // 最初にページの版を知らせる (古いページのままなら、表示側が自分で読み込み直す)
    let hello = serde_json::json!({ "type": "hello", "pageVersion": page_version() }).to_string();
    if socket.send(Message::Text(hello.into())).await.is_err() {
        return;
    }
    for d in hub.recent(history) {
        if socket.send(Message::Text(d.into())).await.is_err() {
            return;
        }
    }
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Ok(d) => if socket.send(Message::Text(d.into())).await.is_err() { return },
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            },
            incoming = socket.recv() => match incoming {
                // 表示側からは何も受け取らない (切断の検知だけ)
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                _ => {}
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn host_check() {
        assert!(host_allowed("127.0.0.1:11290", 11290));
        assert!(host_allowed("localhost:11290", 11290));
        assert!(host_allowed("LOCALHOST:11290", 11290));
        assert!(!host_allowed("127.0.0.1:11280", 11290));
        assert!(!host_allowed("evil.example:11290", 11290));
        assert!(!host_allowed("", 11290));
    }

    #[test]
    fn origin_check() {
        assert!(origin_allowed(None, 11290));
        assert!(origin_allowed(Some("http://127.0.0.1:11290"), 11290));
        assert!(origin_allowed(Some("http://localhost:11290"), 11290));
        assert!(!origin_allowed(Some("https://evil.example"), 11290));
        assert!(!origin_allowed(Some("http://127.0.0.1:11291"), 11290));
        assert!(!origin_allowed(Some("null"), 11290));
    }

    #[test]
    fn page_has_embedded_version() {
        let html = page_html();
        assert!(!html.contains(PAGE_VERSION_PLACEHOLDER));
        assert!(html.contains(page_version()));
        assert_eq!(page_version().len(), 16);
    }

    /// OBS 表示には画像のサムネイルやリンクカードを出さない (配信に不適切な画像・リンクが映らないように)。
    /// 送るのは決まった項目だけで、本文の URL はそのままの文字として送る (表示側も textContent で描く)
    #[test]
    fn publish_never_sends_thumbnails_or_cards() {
        let hub = OverlayHub::new();
        let text = "見て https://example.com/a.jpg https://example.com/page";
        hub.publish(&[OverlayComment {
            source: "twitch".into(),
            site: "Twitch".into(),
            no: None,
            name: "a".into(),
            uid: String::new(),
            text: text.into(),
            color: String::new(),
            event: None,
            badge_list: Vec::new(),
            emotes: Vec::new(),
            giant: false,
            key: String::new(),
        }]);
        let h = hub.recent(1);
        let v: serde_json::Value = serde_json::from_str(&h[0]).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["badgeList", "boot", "color", "emotes", "event", "giant", "id", "key", "name", "no", "site", "source", "text", "type", "uid"]);
        assert_eq!(v["text"], text);
    }

    #[test]
    fn publish_filters_and_clips() {
        let hub = OverlayHub::new();
        let c = |source: &str| OverlayComment {
            source: source.into(),
            site: "5ch".into(),
            no: Some(1),
            name: "名前".into(),
            uid: "abc".into(),
            text: "あ".repeat(6000),
            color: "red".into(),
            event: Some(OverlayEvent { kind: "sub<script>".into(), label: "サブスク".into(), summary: "Aさんがサブスク".into() }),
            emotes: vec![OverlayEmote { id: "25".into(), start: 0, end: 0, giant: false, url: String::new() }, OverlayEmote { id: "x\"y".into(), start: 0, end: 0, giant: false, url: String::new() }],
            giant: true,
            key: String::new(),
            badge_list: vec![
                OverlayBadge { title: "配信者".into(), url: "https://static-cdn.jtvnw.net/badges/v1/5527c58c-fb7d-422d-b71b-f309dcb85cc1".into() },
                OverlayBadge { title: "x".into(), url: "https://evil.example/a".into() },
            ],
        };
        hub.publish(&[c("5ch"), c("unknown"), c("twitch")]);
        let h = hub.recent(10);
        assert_eq!(h.len(), 2);
        let v: serde_json::Value = serde_json::from_str(&h[0]).unwrap();
        assert_eq!(v["type"], "comment");
        // イベントは Twitch のものだけ。種類は英小文字だけに絞る
        assert!(v["event"].is_null());
        let tw: serde_json::Value = serde_json::from_str(&h[1]).unwrap();
        assert_eq!(tw["event"]["kind"], "subscript");
        // バッジは Twitch のものだけ、正しい画像アドレスだけ
        assert_eq!(tw["badgeList"].as_array().unwrap().len(), 1);
        assert_eq!(v["badgeList"].as_array().unwrap().len(), 0);
        // スタンプは正しい ID だけ (掲示板に書かれたスタンプ名も画像にするので、出どころは問わない)
        assert_eq!(tw["emotes"].as_array().unwrap().len(), 1);
        assert_eq!(v["emotes"].as_array().unwrap().len(), 1);
        assert_eq!((tw["giant"].as_bool(), v["giant"].as_bool()), (Some(true), Some(false)));
        assert_eq!(v["text"].as_str().unwrap().chars().count(), FIELD_MAX_CHARS);
        assert_eq!(v["color"], "");
    }

    /// YouTube: イベントの見出しを出せる・絵文字の画像は YouTube の画像配信サーバーだけ・削除された発言は消せる
    #[test]
    fn youtube_comments_and_retract() {
        let hub = OverlayHub::new();
        let c = |key: &str, url: &str| OverlayComment {
            source: "youtube".into(),
            site: "YouTube".into(),
            no: None,
            name: "a".into(),
            uid: String::new(),
            text: ":_kusa: わら".into(),
            color: String::new(),
            event: Some(OverlayEvent { kind: "superchat".into(), label: "スーパーチャット".into(), summary: "aさんがスーパーチャット".into() }),
            badge_list: Vec::new(),
            emotes: vec![OverlayEmote { id: "yt_kusa".into(), start: 0, end: 6, giant: false, url: url.into() }],
            giant: true,
            key: key.into(),
        };
        hub.publish(&[c("yt:v1:m1", "https://yt3.ggpht.com/k=w48"), c("bad key\"", "https://evil.example/x.png")]);
        let h = hub.recent(10);
        let a: serde_json::Value = serde_json::from_str(&h[0]).unwrap();
        let b: serde_json::Value = serde_json::from_str(&h[1]).unwrap();
        assert_eq!(a["event"]["kind"], "superchat");
        assert_eq!(a["emotes"][0]["url"], "https://yt3.ggpht.com/k=w48");
        assert_eq!(b["emotes"].as_array().unwrap().len(), 0);
        assert_eq!((a["key"].as_str(), b["key"].as_str()), (Some("yt:v1:m1"), Some("")));
        assert_eq!(a["giant"], false);
        let mut rx = hub.tx.subscribe();
        hub.retract(&["yt:v1:m1".to_string()]);
        assert_eq!(hub.recent(10).len(), 1);
        let m: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(m["type"], "remove");
        assert_eq!(m["keys"][0], "yt:v1:m1");
    }

    fn lay(appearance: serde_json::Value, css: &str) -> OverlayLayout {
        OverlayLayout { appearance, css: css.into() }
    }

    #[test]
    fn layouts_are_validated() {
        let hub = OverlayHub::new();
        let ok: HashMap<_, _> = [("配信A".to_string(), lay(serde_json::json!({"maxItems": 10}), ".msg{color:red}"))].into();
        assert!(hub.set_layouts(ok).is_ok());
        // 「標準」は自動で足される
        assert_eq!(hub.layout(Some("標準")).0, "標準");
        assert_eq!(hub.layout(Some("配信A")).1.css, ".msg{color:red}");
        // 無い名前は「標準」
        assert_eq!(hub.layout(Some("ない")).0, "標準");
        let bad_name: HashMap<_, _> = [("a/b".to_string(), lay(serde_json::json!({}), ""))].into();
        assert!(hub.set_layouts(bad_name).is_err());
        let bad_ap: HashMap<_, _> = [("x".to_string(), lay(serde_json::json!([1, 2]), ""))].into();
        assert!(hub.set_layouts(bad_ap).is_err());
        let big_css: HashMap<_, _> = [("x".to_string(), lay(serde_json::json!({}), &"a".repeat(CSS_MAX_BYTES + 1)))].into();
        assert!(hub.set_layouts(big_css).is_err());
    }

    #[test]
    fn layout_names() {
        assert!(layout_name_ok("標準"));
        assert!(layout_name_ok("配信 2"));
        assert!(!layout_name_ok(""));
        assert!(!layout_name_ok(" 前に空白"));
        assert!(!layout_name_ok("a?b"));
        assert!(!layout_name_ok("a&b"));
        assert!(!layout_name_ok(&"あ".repeat(41)));
    }

    async fn raw_get(port: u16, host: &str, path: &str) -> String {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).await.unwrap();
        String::from_utf8_lossy(&buf).into_owned()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn server_serves_and_rejects_bad_host_then_stops() {
        let hub = Arc::new(OverlayHub::new());
        // 空いているポートを探してから使う
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let server = start(hub.clone(), port).await.unwrap();
        let ok = raw_get(port, &format!("127.0.0.1:{port}"), "/overlay.html").await;
        assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
        assert!(ok.contains("<html"));
        let bad = raw_get(port, "evil.example", "/overlay.html").await;
        assert!(bad.starts_with("HTTP/1.1 403"), "{bad}");
        // 同じポートでもう一つは立てられない
        assert!(matches!(start(hub.clone(), port).await, Err(OverlayError::PortInUse(_))));
        server.stop();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        // 止めたあとは同じポートで立て直せる
        let again = start(hub, port).await;
        assert!(again.is_ok());
    }
}
