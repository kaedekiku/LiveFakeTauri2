use core_proxy::{
    protect_password, unprotect_password, update_proxy_settings,
    ProxySettings, ProxyType, UrlReplaceRule,
    parse_url_replace_rules,
};
use core_fetch::{
    create_thread, create_shitaraba_thread, create_jpnkn_thread,
    detect_site_type, is_allowed_url, fetch_bbsmenu_json, extract_bbsmenu_hosts,
    set_extra_allowed_hosts, set_shitaraba_host_override, set_jpnkn_host_override,
    BBSMENU_URL, fetch_post_form_tokens,
    fetch_subject_threads, fetch_thread_responses,
    fetch_shitaraba_thread_list, fetch_shitaraba_responses, post_shitaraba_reply,
    fetch_jpnkn_thread_list, fetch_jpnkn_responses, post_jpnkn_reply, post_5ch_reply,
    normalize_5ch_url, parse_confirm_submit_form,
    submit_post_confirm, submit_post_confirm_with_html, submit_post_finalize_from_confirm,
    CreateThreadResult, OgpCard, PostConfirmResult, PostFinalizePreview, PostFormTokens,
    PostSubmitResult, SiteType, TweetCard,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager};

mod twitch_auth;
mod twitch_badges;
mod youtube;
mod youtube_auth;
mod user_commands;
use tauri::webview::WebviewWindowBuilder;
use tauri::window::Color;
use std::sync::Mutex;

/// Multi-tab image data for the popup window.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PopupImageEntry {
    id: String,
    data_url: String,
    source_url: String,
    label: String,
}
struct ImagePopupState(Mutex<Vec<PopupImageEntry>>);

// --- Twitch チャット (匿名・読み取り専用。受信は core-twitch) ---

/// 受信中のチャンネルと、その受信タスク
struct TwitchState(Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>);

// --- OBS 表示 (ブラウザソース用のサーバー。127.0.0.1 のみ・既定オフ。実体は core-overlay) ---

struct OverlayState {
    hub: std::sync::Arc<core_overlay::OverlayHub>,
    server: Mutex<Option<core_overlay::RunningServer>>,
}

/// OBS 表示のサーバーを始める (すでに同じポートで動いていれば何もしない)。戻り値は待ち受けているポート
#[tauri::command(async)]
async fn overlay_start(state: tauri::State<'_, OverlayState>, port: u16) -> Result<u16, String> {
    if port < 1024 {
        return Err("ポートは 1024〜65535 の範囲で指定してください".into());
    }
    let old = {
        let mut guard = state.server.lock().unwrap_or_else(|e| e.into_inner());
        if guard.as_ref().map(|s| s.port()) == Some(port) {
            return Ok(port);
        }
        guard.take()
    };
    if let Some(old) = old {
        old.stop();
    }
    let server = core_overlay::start(state.hub.clone(), port).await.map_err(|e| e.to_string())?;
    let _ = core_store::append_log(&format!("overlay: start 127.0.0.1:{port}"));
    *state.server.lock().unwrap_or_else(|e| e.into_inner()) = Some(server);
    Ok(port)
}

#[tauri::command]
fn overlay_stop(state: tauri::State<'_, OverlayState>) {
    let old = state.server.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(old) = old {
        let _ = core_store::append_log(&format!("overlay: stop 127.0.0.1:{}", old.port()));
        old.stop();
    }
}

/// 表示する内容を OBS 表示へ送る (サーバーが止まっていても履歴には残り、立てたときに送られる)
#[tauri::command]
fn overlay_publish(state: tauri::State<'_, OverlayState>, items: Vec<core_overlay::OverlayComment>) {
    state.hub.publish(&items);
}

/// OBS 表示から、目印の付いた表示を消す (YouTube で削除された発言)
#[tauri::command]
fn overlay_retract(state: tauri::State<'_, OverlayState>, keys: Vec<String>) {
    state.hub.retract(&keys);
}

/// OBS 表示のレイアウト (名前 → 見た目の設定と追加 CSS) をまるごと差し替える
#[tauri::command]
fn overlay_set_layouts(
    state: tauri::State<'_, OverlayState>,
    layouts: HashMap<String, core_overlay::OverlayLayout>,
) -> Result<(), String> {
    state.hub.set_layouts(layouts).map_err(|e| e.to_string())
}

/// 同時に受信するチャンネル数の上限 (タブの開きすぎで接続が増えすぎないように)
const TWITCH_MAX_CHANNELS: usize = 20;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TwitchChatEvent {
    channel: String,
    /// 発言 ID (返信に使う。無ければ空)
    id: String,
    login: String,
    name: String,
    color: String,
    text: String,
    /// 受信した時刻 (UNIX ミリ秒)
    received_at: u64,
    /// サブスク・ビッツなどのイベント (普通の発言なら null)
    event: Option<TwitchChatEventKind>,
    /// バッジの画像 (取得がオフ・不明なら空)
    badges: Vec<twitch_badges::BadgeImage>,
    /// スタンプの位置 (本文のコードポイント単位)
    emotes: Vec<TwitchEmote>,
    /// 最後のスタンプがビッツのパワーアップで巨大化している
    giant: bool,
}

#[derive(Clone, Serialize)]
struct TwitchEmote {
    id: String,
    start: usize,
    end: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TwitchChatEventKind {
    kind: String,
    months: u32,
    count: u32,
    bits: u32,
    viewers: u32,
    recipient: String,
    reward: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TwitchStatusEvent {
    channel: String,
    /// "connecting" / "connected" / "disconnected"
    state: String,
    message: String,
}

/// Twitch ログイン (EventSub) の状態 (トークンは含めない)
#[tauri::command]
fn twitch_auth_status(state: tauri::State<'_, twitch_auth::TwitchAuthState>) -> twitch_auth::AuthStatus {
    state.status()
}

/// Twitch ログインを始める (デバイスコード方式。コードと確認ページの URL を返し、許可されるまで裏で待つ)
#[tauri::command]
async fn twitch_login_start(state: tauri::State<'_, twitch_auth::TwitchAuthState>) -> Result<twitch_auth::AuthStatus, String> {
    state.start_login().await
}

/// ログイン中なら、公式 API からスタンプの一覧 (名前と ID) を取る。掲示板に書かれたスタンプ名を画像にするのに使う
#[tauri::command]
async fn twitch_fetch_emotes(state: tauri::State<'_, twitch_auth::TwitchAuthState>, channels: Vec<String>) -> Result<Vec<twitch_auth::EmoteName>, String> {
    state.fetch_emotes(channels).await
}

/// Twitch のチャットに書き込む。送り先は、いま受信している (開いている Twitch タブの) チャンネルだけ。
/// 画面で確かめた送り先と同じかを、ここでも確かめる (閉じたタブ・知らないチャンネルには送らない)
#[tauri::command]
async fn twitch_send_chat(
    twitch: tauri::State<'_, TwitchState>,
    auth: tauri::State<'_, twitch_auth::TwitchAuthState>,
    channel: String,
    message: String,
    reply_to: Option<String>,
) -> Result<String, String> {
    let channel = core_twitch::normalize_channel(&channel).ok_or("送り先のチャンネル名が正しくありません")?;
    let open = twitch.0.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&channel);
    if !open {
        return Err(format!("#{channel} のタブが開いていないため送りませんでした"));
    }
    auth.send_chat(&channel, &message, reply_to).await
}

/// ログインしている人が使えるスタンプの一覧 (書き込み欄のスタンプの一覧)
#[tauri::command]
async fn twitch_user_emotes(auth: tauri::State<'_, twitch_auth::TwitchAuthState>, channel: String) -> Result<Vec<twitch_auth::UserEmote>, String> {
    auth.user_emotes(&channel).await
}

/// Twitch からログアウトする (Twitch 側の許可も取り消し、保存したログイン情報を消す)
#[tauri::command]
async fn twitch_logout(state: tauri::State<'_, twitch_auth::TwitchAuthState>) -> Result<(), String> {
    state.logout().await;
    Ok(())
}

/// Twitch のバッジ画像・チャンネルポイント報酬名の取得 (非公式の取得口 gql.twitch.tv) のオンオフ
#[tauri::command]
fn twitch_set_badges(state: tauri::State<'_, twitch_badges::BadgeState>, enabled: bool) -> Result<(), String> {
    state.set_enabled(enabled);
    Ok(())
}

/// 受信するチャンネルの一覧を、渡された一覧に合わせる (足りないものは受信を始め、余分なものは止める)。
/// 開いている Twitch タブの一覧を毎回まるごと渡す使い方なので、画面の再読み込みなどで食い違っても自然に揃う。
/// 戻り値は実際に受信対象にしたチャンネル名 (正規化済み)。チャット本文はログに残さない。
#[tauri::command]
fn twitch_sync(app: AppHandle, state: tauri::State<'_, TwitchState>, channels: Vec<String>) -> Result<Vec<String>, String> {
    let mut wanted: Vec<String> = channels.iter().filter_map(|c| core_twitch::normalize_channel(c)).collect();
    wanted.sort();
    wanted.dedup();
    wanted.truncate(TWITCH_MAX_CHANNELS);
    app.state::<twitch_badges::BadgeState>().set_channels(wanted.clone());
    let mut tasks = state.0.lock().unwrap_or_else(|e| e.into_inner());
    tasks.retain(|channel, handle| {
        let keep = wanted.contains(channel);
        if !keep {
            handle.abort();
            let _ = core_store::append_log(&format!("twitch: stop #{channel}"));
        }
        keep
    });
    for channel in &wanted {
        if tasks.contains_key(channel) {
            continue;
        }
        let _ = core_store::append_log(&format!("twitch: start #{channel}"));
        let (app_msg, app_status) = (app.clone(), app.clone());
        let ch_badge = channel.clone();
        let (ch_msg, ch_status) = (channel.clone(), channel.clone());
        let handle = tauri::async_runtime::spawn(core_twitch::run_channel(
            channel.clone(),
            move |m| {
                let received_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let _ = app_msg.emit(
                    "twitch-message",
                    {
                    let badge_state = app_msg.state::<twitch_badges::BadgeState>();
                    let badges = badge_state.resolve(&ch_badge, &m.badges);
                    // ログイン中の自分のチャンネルは、チャンネルポイントを EventSub 側で出すので、チャットでは普通の発言として扱う
                    let covered = app_msg.state::<twitch_auth::TwitchAuthState>().covers(&ch_badge);
                    let event = m.event.filter(|e| !(covered && e.kind == "points"));
                    TwitchChatEvent {
                        badges,
                        emotes: m.emotes.into_iter().map(|e| TwitchEmote { id: e.id, start: e.start, end: e.end }).collect(),
                        giant: m.giant,
                        id: m.id,
                        channel: ch_msg.clone(),
                        login: m.login,
                        name: m.name,
                        color: m.color,
                        text: m.text,
                        received_at,
                        event: event.map(|e| TwitchChatEventKind {
                            // 報酬名は分かれば (バッジと同じ取得口で調べた一覧から) 入れる
                            reward: if e.reward.is_empty() { badge_state.reward_title(&ch_badge, &e.reward_id).unwrap_or_default() } else { e.reward },
                            kind: e.kind,
                            months: e.months,
                            count: e.count,
                            bits: e.bits,
                            viewers: e.viewers,
                            recipient: e.recipient,
                        }),
                    }
                    },
                );
            },
            move |st| {
                let (state, message) = match st {
                    core_twitch::Status::Connecting => ("connecting", String::new()),
                    core_twitch::Status::Connected => ("connected", String::new()),
                    core_twitch::Status::Disconnected { reason, retry_in_secs } => {
                        ("disconnected", format!("{reason} ({retry_in_secs}秒後に再接続)"))
                    }
                };
                if state != "connecting" {
                    let _ = core_store::append_log(&format!("twitch: #{ch_status} {state} {message}"));
                }
                let _ = app_status.emit(
                    "twitch-status",
                    TwitchStatusEvent { channel: ch_status.clone(), state: state.to_string(), message },
                );
            },
        ));
        tasks.insert(channel.clone(), handle);
    }
    Ok(wanted)
}

/// Saved subtitle window position before moving off-screen
static SUBTITLE_SAVED_POS: Mutex<Option<(i32, i32)>> = Mutex::new(None);
/// 字幕ウィンドウのサイズ (論理ピクセル)。リサイズのたびに更新し、字幕をオフにしたときと終了時に settings.ini へ書く
/// (App.subtitleWindowWidth / App.subtitleWindowHeight)。起動時に読み戻し、字幕をオンにしたときに復元する
static SUBTITLE_SAVED_SIZE: Mutex<Option<(f64, f64)>> = Mutex::new(None);

fn subtitle_size_ok(w: f64, h: f64) -> bool {
    (120.0..=10000.0).contains(&w) && (40.0..=10000.0).contains(&h)
}

/// 覚えている字幕ウィンドウのサイズを settings.ini に書く (他の項目には触れない)
fn persist_subtitle_size() {
    let saved = *SUBTITLE_SAVED_SIZE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((w, h)) = saved {
        let mut m = HashMap::new();
        m.insert("App.subtitleWindowWidth".to_string(), format!("{}", w.round()));
        m.insert("App.subtitleWindowHeight".to_string(), format!("{}", h.round()));
        let _ = core_store::save_settings_ini(&m);
    }
}

/// 字幕ウィンドウの今のサイズを覚える
fn capture_subtitle_size(win: &tauri::WebviewWindow) {
    if let (Ok(size), Ok(scale)) = (win.inner_size(), win.scale_factor()) {
        let (w, h) = (f64::from(size.width) / scale, f64::from(size.height) / scale);
        if subtitle_size_ok(w, h) {
            *SUBTITLE_SAVED_SIZE.lock().unwrap_or_else(|e| e.into_inner()) = Some((w, h));
        }
    }
}
/// 書き込みの浮遊ウィンドウのサイズ。ユーザーがリサイズするたびに更新され、閉じて
/// 再度開いたときに同じ大きさで復元される (アプリを再起動すると初期化される、字幕ウィンドウの
/// 位置記憶と同じ扱い)。
static COMPOSE_POPUP_SAVED_SIZE: Mutex<Option<(f64, f64)>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuSummary {
    top_level_keys: usize,
    normalized_sample: String,
}

#[derive(Debug, Deserialize)]
struct LatestMetadata {
    version: String,
    released_at: Option<String>,
    download_page_url: Option<String>,
    platforms: Option<std::collections::HashMap<String, LatestPlatformAsset>>,
    /// お知らせ (任意)。形が崩れていても更新の確認そのものは失敗させないよう、値のまま受けて update_notice_for で読む
    #[serde(default)]
    notice: Option<serde_json::Value>,
}

/// 画面に出すお知らせ (latest.json の notice のうち、この版に当てはまるもの)
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct UpdateNotice {
    id: String,
    text: String,
}

/// お知らせの文の長さの上限 (文字数)
const UPDATE_NOTICE_MAX_CHARS: usize = 300;

/// latest.json の notice `{ "id": "...", "below": "0.0.122", "text": "..." }` を読み、
/// 今の版が below より古いときだけ返す。below が無い・形が違う・文が空のものは出さない。
/// 文は画面で文字としてだけ出す (HTML にしない)。制御文字は除き、長さを切る
fn update_notice_for(notice: Option<&serde_json::Value>, current_version: &str) -> Option<UpdateNotice> {
    let n = notice?.as_object()?;
    let id = n.get("id")?.as_str()?.trim();
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return None;
    }
    let below = n.get("below")?.as_str()?.trim();
    if parse_version_numbers(below).is_empty() || !is_newer_version(below, current_version) {
        return None;
    }
    let text: String = n
        .get("text")?
        .as_str()?
        .chars()
        .map(|c| if c == '\n' || c == '\t' { ' ' } else { c })
        .filter(|c| !c.is_control())
        .take(UPDATE_NOTICE_MAX_CHARS)
        .collect();
    let text = text.trim().to_string();
    if text.is_empty() {
        return None;
    }
    Some(UpdateNotice { id: id.to_string(), text })
}

#[derive(Debug, Deserialize)]
struct LatestPlatformAsset {
    sha256: String,
    size: u64,
    filename: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePlatformAsset {
    key: String,
    sha256: String,
    size: u64,
    filename: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckResult {
    metadata_url: String,
    current_version: String,
    latest_version: String,
    has_update: bool,
    released_at: Option<String>,
    download_page_url: Option<String>,
    current_platform_key: String,
    current_platform_asset: Option<UpdatePlatformAsset>,
    /// この版に当てはまるお知らせ (無ければ null)
    notice: Option<UpdateNotice>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoardCategory {
    category_name: String,
    boards: Vec<BoardEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoardEntry {
    board_name: String,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadListItem {
    thread_key: String,
    title: String,
    response_count: u32,
    thread_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadResponseItem {
    response_no: u32,
    name: String,
    mail: String,
    date_and_id: String,
    body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchResponsesResult {
    responses: Vec<ThreadResponseItem>,
    title: Option<String>,
}

/// Fetch BBS menu JSON, save to `bbs-menu.json`, fall back to cache on error.
///
/// 取得元 URL は設定 (`App.bbsmenuUrl`) でユーザーが変更できる — 5ch 側で bbsmenu.json の
/// 置き場所やファイル形式が変わった場合に、アプリの更新を待たずユーザー自身で対応できるように
/// するため。取得に成功した bbsmenu の中身に実際に登場するホスト名は `set_extra_allowed_hosts`
/// で許可リストに追加登録される (既存のハードコードされた許可リストを置き換えるのではなく上乗せ)。
async fn fetch_bbsmenu_cached() -> Result<serde_json::Value, String> {
    let client = core_proxy::apply(reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(10)), core_proxy::ProxyRole::Receive)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    let configured_url = core_store::load_settings_ini()
        .ok()
        .and_then(|m| m.get("App.bbsmenuUrl").cloned())
        .filter(|u| !u.trim().is_empty())
        .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        .unwrap_or_else(|| BBSMENU_URL.to_string());

    match fetch_bbsmenu_json(&client, &configured_url).await {
        Ok(menu) => {
            let _ = core_store::save_json("bbs-menu.json", &menu);
            set_extra_allowed_hosts(extract_bbsmenu_hosts(&menu));
            Ok(menu)
        }
        Err(e) => {
            // Fall back to cached version if available
            core_store::load_json::<serde_json::Value>("bbs-menu.json")
                .map_err(|_| format!("ネットワークエラー + キャッシュなし: {:?}", e))
        }
    }
}

#[tauri::command]
async fn fetch_bbsmenu_summary() -> Result<MenuSummary, String> {
    core_store::init_portable_layout().map_err(|e| e.to_string())?;

    let menu = fetch_bbsmenu_cached().await?;

    let top_level_keys = menu.as_object().map(|o| o.len()).unwrap_or(0);
    let normalized_sample = normalize_5ch_url("https://egg.5ch.net/test/read.cgi/software/1/");

    Ok(MenuSummary {
        top_level_keys,
        normalized_sample,
    })
}

/// Probe/debug commands are restricted to dev builds, or release builds
/// explicitly opted in via the LIVEFAKE_DIAG=1 environment variable.
fn diagnostics_allowed() -> bool {
    cfg!(debug_assertions) || std::env::var("LIVEFAKE_DIAG").map(|v| v == "1").unwrap_or(false)
}

#[tauri::command]
fn diagnostics_enabled() -> bool {
    diagnostics_allowed()
}

#[tauri::command]
async fn probe_thread_post_form(thread_url: String) -> Result<PostFormTokens, String> {
    if !diagnostics_allowed() {
        return Err("diagnostics disabled".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    fetch_post_form_tokens(&client, &thread_url).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_thread_list(thread_url: String, limit: Option<usize>) -> Result<Vec<ThreadListItem>, String> {
    if !is_allowed_url(&thread_url) {
        return Err(format!("URL not allowed: {}", thread_url));
    }
    let _ = core_store::append_log(&format!("fetch_thread_list: {}", thread_url));
    let client = core_proxy::apply(reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30)), core_proxy::ProxyRole::Receive)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(usize::MAX);
    let site = detect_site_type(&thread_url);
    let rows = match site {
        Some(SiteType::Shitaraba) => {
            fetch_shitaraba_thread_list(&client, &thread_url, limit).await
        }
        Some(SiteType::Jpnkn) => {
            fetch_jpnkn_thread_list(&client, &thread_url, limit).await
        }
        _ => {
            fetch_subject_threads(&client, &thread_url, limit).await
        }
    }.map_err(|e| {
        let _ = core_store::append_log(&format!("fetch_thread_list error: {}", e));
        e.to_string()
    })?;
    let _ = core_store::append_log(&format!("fetch_thread_list ok: {} threads", rows.len()));
    // 板側のsubject.txtが同じスレを重複して載せていることがある(したらばで確認済み)。
    // 同じスレが一覧に複数行出ると、番号や既読状態がどちらの行を指すか曖昧になるため、
    // スレURL基準で最初の1件だけ残す
    let mut seen = HashSet::new();
    Ok(rows
        .into_iter()
        .filter(|r| seen.insert(r.thread_url.clone()))
        .map(|r| ThreadListItem {
            thread_key: r.thread_key,
            title: r.title,
            response_count: r.response_count,
            thread_url: r.thread_url,
        })
        .collect())
}

#[tauri::command]
async fn fetch_thread_responses_command(
    thread_url: String,
    limit: Option<usize>,
    since_res_no: Option<u32>,
) -> Result<FetchResponsesResult, String> {
    if !is_allowed_url(&thread_url) {
        return Err(format!("URL not allowed: {}", thread_url));
    }
    let _ = core_store::append_log(&format!("fetch_responses: {}", thread_url));
    let client = core_proxy::apply(reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30)), core_proxy::ProxyRole::Receive)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(usize::MAX);
    let site = detect_site_type(&thread_url);
    let (rows, title) = match site {
        Some(SiteType::Shitaraba) => {
            // 差分取得時は範囲指定 (since+1 以降) で通信量を抑える
            fetch_shitaraba_responses(&client, &thread_url, limit, since_res_no.map(|n| n + 1)).await
        }
        Some(SiteType::Jpnkn) => {
            fetch_jpnkn_responses(&client, &thread_url, limit).await
        }
        _ => {
            fetch_thread_responses(&client, &thread_url, limit).await
        }
    }.map_err(|e| {
        let _ = core_store::append_log(&format!("fetch_responses error: {}", e));
        e.to_string()
    })?;
    let _ = core_store::append_log(&format!("fetch_responses ok: {} rows", rows.len()));
    let since = since_res_no.unwrap_or(0);
    Ok(FetchResponsesResult {
        responses: rows
            .into_iter()
            .filter(|r| r.response_no > since)
            .map(|r| ThreadResponseItem {
                response_no: r.response_no,
                name: r.name,
                mail: r.mail,
                date_and_id: r.date_and_id,
                body: r.body,
            })
            .collect(),
        title,
    })
}

#[tauri::command]
async fn debug_post_connectivity(thread_url: String) -> Result<String, String> {
    if !diagnostics_allowed() {
        return Err("diagnostics disabled".to_string());
    }
    let mut report = String::new();

    let c = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("{:?}", e))?;
    let tokens = fetch_post_form_tokens(&c, &thread_url)
        .await
        .map_err(|e| format!("tokens: {:?}", e))?;
    report.push_str(&format!("post_url={}\n", tokens.post_url));

    // Test 1: curl.exe to bbs.cgi (uses Windows Schannel/WinHTTP)
    {
        let output = Command::new("curl")
            .args(["-s", "-o", "/dev/null", "-w", "%{http_code} %{ssl_verify_result}", "-X", "POST", &tokens.post_url])
            .output();
        match output {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                let stderr = String::from_utf8_lossy(&o.stderr);
                report.push_str(&format!("curl POST bbs.cgi: out={} err={}\n", stdout.trim(), stderr.chars().take(120).collect::<String>()));
            }
            Err(e) => report.push_str(&format!("curl failed to run: {}\n", e)),
        }
    }

    // Test 2: curl.exe GET to bbs.cgi
    {
        let output = Command::new("curl")
            .args(["-s", "-o", "/dev/null", "-w", "%{http_code} %{ssl_verify_result}", &tokens.post_url])
            .output();
        match output {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                report.push_str(&format!("curl GET bbs.cgi: {}\n", stdout.trim()));
            }
            Err(e) => report.push_str(&format!("curl GET failed: {}\n", e)),
        }
    }

    // Test 3: reqwest GET to bbs.cgi (same client that fetched tokens)
    match c.get(&tokens.post_url).send().await {
        Ok(r) => report.push_str(&format!("reqwest GET bbs.cgi (reuse): status={}\n", r.status())),
        Err(e) => report.push_str(&format!("reqwest GET bbs.cgi (reuse) FAILED: {:?}\n", e)),
    }

    // Test 4: reqwest with danger_accept_invalid_certs
    {
        let c2 = reqwest::Client::builder()
            .user_agent("Monazilla/1.00 LiveFake/0.1")
            .danger_accept_invalid_certs(true)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("{:?}", e))?;
        match c2.get(&tokens.post_url).send().await {
            Ok(r) => report.push_str(&format!("reqwest GET accept_invalid_certs: status={}\n", r.status())),
            Err(e) => report.push_str(&format!("reqwest GET accept_invalid_certs FAILED: {:?}\n", e)),
        }
    }

    // Test 5: reqwest with TLS 1.2 only
    {
        let c3 = reqwest::Client::builder()
            .user_agent("Monazilla/1.00 LiveFake/0.1")
            .min_tls_version(reqwest::tls::Version::TLS_1_2)
            .max_tls_version(reqwest::tls::Version::TLS_1_2)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("{:?}", e))?;
        match c3.get(&tokens.post_url).send().await {
            Ok(r) => report.push_str(&format!("reqwest GET TLS1.2 only: status={}\n", r.status())),
            Err(e) => report.push_str(&format!("reqwest GET TLS1.2 only FAILED: {:?}\n", e)),
        }
    }

    Ok(report)
}

#[tauri::command]
async fn probe_post_confirm_empty(thread_url: String) -> Result<PostConfirmResult, String> {
    if !diagnostics_allowed() {
        return Err("diagnostics disabled".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let tokens = fetch_post_form_tokens(&client, &thread_url)
        .await
        .map_err(|e| e.to_string())?;
    let ch: Option<String> = None;
    submit_post_confirm(&client, &tokens, "", "", "", ch.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_post_confirm(
    thread_url: String,
    from: Option<String>,
    mail: Option<String>,
    message: Option<String>,
) -> Result<PostConfirmResult, String> {
    if !diagnostics_allowed() {
        return Err("diagnostics disabled".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let tokens = fetch_post_form_tokens(&client, &thread_url)
        .await
        .map_err(|e| e.to_string())?;
    let ch: Option<String> = None;
    submit_post_confirm(
        &client,
        &tokens,
        from.as_deref().unwrap_or(""),
        mail.as_deref().unwrap_or(""),
        message.as_deref().unwrap_or(""),
        ch.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_post_finalize_preview(thread_url: String) -> Result<PostFinalizePreview, String> {
    if !diagnostics_allowed() {
        return Err("diagnostics disabled".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let tokens = fetch_post_form_tokens(&client, &thread_url)
        .await
        .map_err(|e| e.to_string())?;
    let ch: Option<String> = None;
    let (_, confirm_html) = submit_post_confirm_with_html(&client, &tokens, "", "", "", ch.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    parse_confirm_submit_form(&confirm_html, &tokens.post_url).map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_post_finalize_preview_from_input(
    thread_url: String,
    from: Option<String>,
    mail: Option<String>,
    message: Option<String>,
) -> Result<PostFinalizePreview, String> {
    if !diagnostics_allowed() {
        return Err("diagnostics disabled".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let tokens = fetch_post_form_tokens(&client, &thread_url)
        .await
        .map_err(|e| e.to_string())?;
    let ch: Option<String> = None;
    let (_, confirm_html) = submit_post_confirm_with_html(
        &client,
        &tokens,
        from.as_deref().unwrap_or(""),
        mail.as_deref().unwrap_or(""),
        message.as_deref().unwrap_or(""),
        ch.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;
    parse_confirm_submit_form(&confirm_html, &tokens.post_url).map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_post_finalize_submit_empty(
    thread_url: String,
    allow_real_submit: bool,
) -> Result<PostSubmitResult, String> {
    if !diagnostics_allowed() {
        return Err("diagnostics disabled".to_string());
    }
    if !allow_real_submit {
        return Err("blocked: set allow_real_submit=true to execute final submit".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let tokens = fetch_post_form_tokens(&client, &thread_url)
        .await
        .map_err(|e| e.to_string())?;
    let ch: Option<String> = None;
    let (_, confirm_html) = submit_post_confirm_with_html(&client, &tokens, "", "", "", ch.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    submit_post_finalize_from_confirm(&client, &confirm_html, &tokens.post_url, ch.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_post_finalize_submit_from_input(
    thread_url: String,
    from: Option<String>,
    mail: Option<String>,
    message: Option<String>,
    allow_real_submit: bool,
) -> Result<PostSubmitResult, String> {
    if !diagnostics_allowed() {
        return Err("diagnostics disabled".to_string());
    }
    if !allow_real_submit {
        return Err("blocked: set allow_real_submit=true to execute final submit".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let tokens = fetch_post_form_tokens(&client, &thread_url)
        .await
        .map_err(|e| e.to_string())?;
    let ch: Option<String> = None;
    let (_, confirm_html) = submit_post_confirm_with_html(
        &client,
        &tokens,
        from.as_deref().unwrap_or(""),
        mail.as_deref().unwrap_or(""),
        message.as_deref().unwrap_or(""),
        ch.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;
    submit_post_finalize_from_confirm(&client, &confirm_html, &tokens.post_url, ch.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn post_reply_multisite(
    thread_url: String,
    from: Option<String>,
    mail: Option<String>,
    message: String,
) -> Result<String, String> {
    if !is_allowed_url(&thread_url) {
        return Err(format!("URL not allowed: {}", thread_url));
    }
    let site = detect_site_type(&thread_url);
    match site {
        Some(SiteType::Shitaraba) => {
            let client = core_proxy::apply(reqwest::Client::builder()
                .user_agent("Monazilla/1.00 LiveFake/0.1")
                .timeout(std::time::Duration::from_secs(30)), core_proxy::ProxyRole::Send)
                .map_err(|e| e.to_string())?
                .build()
                .map_err(|e| e.to_string())?;
            let result = post_shitaraba_reply(
                &client,
                &thread_url,
                from.as_deref().unwrap_or(""),
                mail.as_deref().unwrap_or(""),
                &message,
            )
            .await
            .map_err(|e| format!("{:?}", e))?;
            Ok(format!("status={}", result.status))
        }
        Some(SiteType::Jpnkn) => {
            let client = core_proxy::apply(reqwest::Client::builder()
                .user_agent("Monazilla/1.00 LiveFake/0.1")
                .timeout(std::time::Duration::from_secs(30)), core_proxy::ProxyRole::Send)
                .map_err(|e| e.to_string())?
                .build()
                .map_err(|e| e.to_string())?;
            let result = post_jpnkn_reply(
                &client,
                &thread_url,
                from.as_deref().unwrap_or(""),
                mail.as_deref().unwrap_or(""),
                &message,
            )
            .await
            .map_err(|e| format!("{:?}", e))?;
            Ok(format!("status={}", result.status))
        }
        _ => {
            // 5ch: reqwest+rustls based post (avoids Windows Schannel SSL issues)
            let ch: Option<String> = None;
            let result = post_5ch_reply(
                &thread_url,
                from.as_deref().unwrap_or(""),
                mail.as_deref().unwrap_or(""),
                &message,
                ch.as_deref(),
            )
            .await
            .map_err(|e| format!("{:?}", e))?;
            if result.contains_error {
                Err(format!("Post failed: status={} body={}", result.status, result.body_preview.chars().take(300).collect::<String>()))
            } else {
                Ok(format!("status={}", result.status))
            }
        }
    }
}

#[tauri::command]
async fn create_thread_command(
    board_url: String,
    subject: String,
    from: Option<String>,
    mail: Option<String>,
    message: String,
) -> Result<CreateThreadResult, String> {
    if !is_allowed_url(&board_url) {
        return Err(format!("URL not allowed: {}", board_url));
    }
    let from_str = from.unwrap_or_default();
    let mail_str = mail.unwrap_or_default();

    match detect_site_type(&board_url) {
        Some(SiteType::Shitaraba) => {
            let client = core_proxy::apply(reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30)), core_proxy::ProxyRole::Send)
                .map_err(|e| e.to_string())?
                .build()
                .map_err(|e| e.to_string())?;
            create_shitaraba_thread(&client, &board_url, &subject, &from_str, &mail_str, &message)
                .await
                .map_err(|e| format!("{:?}", e))
        }
        Some(SiteType::Jpnkn) => {
            let client = core_proxy::apply(reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30)), core_proxy::ProxyRole::Send)
                .map_err(|e| e.to_string())?
                .build()
                .map_err(|e| e.to_string())?;
            create_jpnkn_thread(&client, &board_url, &subject, &from_str, &mail_str, &message)
                .await
                .map_err(|e| format!("{:?}", e))
        }
        _ => {
            let cookie_header: Option<String> = None;
            create_thread(
                &board_url,
                &subject,
                &from_str,
                &mail_str,
                &message,
                cookie_header.as_deref(),
            )
            .await
            .map_err(|e| format!("{:?}", e))
        }
    }
}

fn parse_version_numbers(version: &str) -> Vec<u64> {
    let head = version.split('-').next().unwrap_or(version);
    head.split('.')
        .map(|s| s.trim().parse::<u64>().unwrap_or(0))
        .collect::<Vec<_>>()
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    let l = parse_version_numbers(latest);
    let c = parse_version_numbers(current);
    let max_len = l.len().max(c.len());
    for i in 0..max_len {
        let lv = *l.get(i).unwrap_or(&0);
        let cv = *c.get(i).unwrap_or(&0);
        if lv > cv {
            return true;
        }
        if lv < cv {
            return false;
        }
    }
    false
}

fn current_platform_key() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows-x64"
    }
    #[cfg(target_os = "macos")]
    {
        "macos-arm64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-aarch64"
    }
}

#[tauri::command]
async fn check_for_updates(
    metadata_url: Option<String>,
    current_version: Option<String>,
) -> Result<UpdateCheckResult, String> {
    let metadata_url = metadata_url
        .or_else(|| std::env::var("UPDATE_METADATA_URL").ok())
        .ok_or_else(|| "metadata_url is required (or set UPDATE_METADATA_URL)".to_string())?;

    let current_version = current_version.unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&metadata_url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("metadata fetch failed: status={}", response.status()));
    }

    let latest = response
        .json::<LatestMetadata>()
        .await
        .map_err(|e| e.to_string())?;

    let has_update = is_newer_version(&latest.version, &current_version);
    let notice = update_notice_for(latest.notice.as_ref(), &current_version);
    let platform_key = current_platform_key().to_string();
    let current_platform_asset = latest
        .platforms
        .as_ref()
        .and_then(|m| m.get(&platform_key))
        .map(|a| UpdatePlatformAsset {
            key: platform_key.clone(),
            sha256: a.sha256.clone(),
            size: a.size,
            filename: a.filename.clone(),
        });

    Ok(UpdateCheckResult {
        metadata_url,
        current_version,
        latest_version: latest.version,
        has_update,
        released_at: latest.released_at,
        download_page_url: latest.download_page_url,
        current_platform_key: platform_key,
        current_platform_asset,
        notice,
    })
}

/// Open a native file-open dialog and return the selected path, or None if cancelled.
/// `filter_name` e.g. "EXE files", `filter_ext` e.g. "*.exe"
#[tauri::command]
#[allow(clippy::needless_return)] // OS ごとの分岐で return をそろえている
fn open_file_dialog(filter_name: String, filter_ext: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStringExt;
        #[repr(C)]
        #[allow(non_snake_case, clippy::upper_case_acronyms)]
        struct OPENFILENAMEW {
            lStructSize: u32,
            hwndOwner: usize,
            hInstance: usize,
            lpstrFilter: *const u16,
            lpstrCustomFilter: *mut u16,
            nMaxCustFilter: u32,
            nFilterIndex: u32,
            lpstrFile: *mut u16,
            nMaxFile: u32,
            lpstrFileTitle: *mut u16,
            nMaxFileTitle: u32,
            lpstrInitialDir: *const u16,
            lpstrTitle: *const u16,
            Flags: u32,
            nFileOffset: u16,
            nFileExtension: u16,
            lpstrDefExt: *const u16,
            lCustData: usize,
            lpfnHook: usize,
            lpTemplateName: *const u16,
            pvReserved: usize,
            dwReserved: u32,
            FlagsEx: u32,
        }
        extern "system" {
            fn GetOpenFileNameW(lpofn: *mut OPENFILENAMEW) -> i32;
        }
        let to_wide = |s: &str| -> Vec<u16> {
            s.encode_utf16().chain(std::iter::once(0)).collect()
        };
        // Build filter: "FilterName\0*.ext\0\0"
        let filter_str = format!("{}\0{}\0", filter_name, filter_ext);
        let filter_wide: Vec<u16> = filter_str.encode_utf16().chain(std::iter::once(0)).collect();
        let title_wide = to_wide("ファイルを選択");
        let mut file_buf: Vec<u16> = vec![0u16; 512];
        let mut ofn: OPENFILENAMEW = unsafe { std::mem::zeroed() };
        ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
        ofn.lpstrFilter = filter_wide.as_ptr();
        ofn.lpstrFile = file_buf.as_mut_ptr();
        ofn.nMaxFile = file_buf.len() as u32;
        ofn.lpstrTitle = title_wide.as_ptr();
        ofn.Flags = 0x00000800 | 0x00001000; // OFN_PATHMUSTEXIST | OFN_FILEMUSTEXIST
        let result = unsafe { GetOpenFileNameW(&mut ofn) };
        if result == 0 {
            return Ok(None);
        }
        let len = file_buf.iter().position(|&c| c == 0).unwrap_or(file_buf.len());
        let path = std::ffi::OsString::from_wide(&file_buf[..len])
            .to_string_lossy()
            .to_string();
        if path.is_empty() { return Ok(None); }
        return Ok(Some(path));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (filter_name, filter_ext);
        Ok(None)
    }
}

/// Open a native folder-select dialog and return the selected path, or None if cancelled.
#[tauri::command]
#[allow(clippy::needless_return)] // OS ごとの分岐で return をそろえている
fn open_folder_dialog() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStringExt;
        #[repr(C)]
        #[allow(non_snake_case, clippy::upper_case_acronyms)]
        struct BROWSEINFOW {
            hwndOwner: usize,
            pidlRoot: usize,
            pszDisplayName: *mut u16,
            lpszTitle: *const u16,
            ulFlags: u32,
            lpfn: usize,
            lParam: usize,
            iImage: i32,
        }
        extern "system" {
            fn SHBrowseForFolderW(lpbi: *mut BROWSEINFOW) -> usize;
            fn SHGetPathFromIDListW(pidl: usize, pszPath: *mut u16) -> i32;
            fn CoTaskMemFree(pv: usize);
        }
        let title_wide: Vec<u16> = "保存先フォルダを選択".encode_utf16().chain(std::iter::once(0)).collect();
        let mut display_name: Vec<u16> = vec![0u16; 260];
        let mut bi: BROWSEINFOW = unsafe { std::mem::zeroed() };
        bi.pszDisplayName = display_name.as_mut_ptr();
        bi.lpszTitle = title_wide.as_ptr();
        bi.ulFlags = 0x00000040 | 0x00000010; // BIF_NEWDIALOGSTYLE | BIF_EDITBOX
        let pidl = unsafe { SHBrowseForFolderW(&mut bi) };
        if pidl == 0 {
            return Ok(None);
        }
        let mut path_buf: Vec<u16> = vec![0u16; 520];
        let ok = unsafe { SHGetPathFromIDListW(pidl, path_buf.as_mut_ptr()) };
        unsafe { CoTaskMemFree(pidl); }
        if ok == 0 {
            return Ok(None);
        }
        let len = path_buf.iter().position(|&c| c == 0).unwrap_or(path_buf.len());
        let path = std::ffi::OsString::from_wide(&path_buf[..len])
            .to_string_lossy()
            .to_string();
        if path.is_empty() { return Ok(None); }
        remember_picked_folder(&path);
        return Ok(Some(path));
    }
    #[cfg(not(target_os = "windows"))]
    Ok(None)
}

/// この起動中にフォルダの選択で利用者が選んだフォルダ (画像の保存先として認める)
static PICKED_FOLDERS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn remember_picked_folder(path: &str) {
    if let Ok(mut list) = PICKED_FOLDERS.lock() {
        if !list.iter().any(|f| same_folder(f, path)) {
            list.push(path.to_string());
        }
    }
}

/// 同じフォルダか (Windows は大文字・小文字を区別しない。末尾の区切り文字・/ と \ の違いは無視)
fn same_folder(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    let (a, b) = (norm(a), norm(b));
    !a.is_empty() && a == b
}

/// 画像を書いてよいフォルダか: 設定の「画像の保存先」か、この起動中にフォルダの選択で選んだフォルダだけ
fn image_folder_allowed(folder: &str, configured: Option<&str>, picked: &[String]) -> bool {
    configured.is_some_and(|c| same_folder(c, folder)) || picked.iter().any(|f| same_folder(f, folder))
}

/// Download an image from `url` and save it into `folder`.
/// Returns the full path of the saved file.
#[tauri::command]
async fn save_image_to_folder(url: String, folder: String) -> Result<String, String> {
    validate_public_http_url(&url)?;
    // 呼んだ側が指定したフォルダならどこにでも書ける、とはしない
    {
        let settings = core_store::load_settings_ini().unwrap_or_default();
        let configured = settings.get("App.imageSaveFolder").map(String::as_str);
        let picked = PICKED_FOLDERS.lock().map(|l| l.clone()).unwrap_or_default();
        if !image_folder_allowed(&folder, configured, &picked) {
            return Err("保存先は、設定の「画像の保存先」か、フォルダの選択で選んだフォルダだけです".to_string());
        }
    }
    let client = image_http_client(30)?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let (bytes, kind) = read_image_response(resp).await?;
    // 拡張子は中身の種類から決める (URL の拡張子が jpg でも中身が png なら png)
    let ext = match kind.as_str() {
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/avif" => "avif",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        "image/svg+xml" => "svg",
        "image/jpeg" | "image/jpg" | "image/pjpeg" => "jpg",
        _ => "img",
    };
    let filename = format!("{}.{}", safe_image_file_stem(&url), ext);
    let folder_path = std::path::PathBuf::from(&folder);
    let dest = folder_path.join(&filename);
    // 選んだフォルダの中に書くことを確かめる (ファイル名にドライブ名や区切り文字を混ぜて外へ書かせない)
    if dest.parent() != Some(folder_path.as_path()) {
        return Err("保存先のファイル名が正しくありません".to_string());
    }
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// 保存するファイル名 (拡張子を除く): URL の最後の部分から、ファイル名に使えない文字を除いて作る。無ければ日時
fn safe_image_file_stem(url: &str) -> String {
    let last = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.path_segments().and_then(|mut s| s.next_back().map(str::to_string)))
        .unwrap_or_default();
    let decoded = percent_decode_lossy(&last);
    let stem = decoded.split('.').next().unwrap_or("");
    let cleaned: String = stem
        .chars()
        .map(|c| if c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .take(100)
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == ' ' || c == '.' || c == '_').to_string();
    if cleaned.is_empty() {
        chrono::Local::now().format("image_%Y%m%d_%H%M%S").to_string()
    } else {
        cleaned
    }
}

/// %xx をはずす (UTF-8 として読めないものはそのまま)
fn percent_decode_lossy(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            // 文字の途中で切らないよう、バイトのまま 16 進の2桁を読む
            if let (Some(h), Some(l)) = ((bytes[i + 1] as char).to_digit(16), (bytes[i + 2] as char).to_digit(16)) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

#[cfg(test)]
mod image_safety_tests {
    use super::*;

    #[test]
    fn private_addresses_are_blocked() {
        for u in ["http://127.0.0.1/a.png", "http://192.168.1.1/", "http://10.0.0.1/", "http://100.64.1.2/", "http://0.1.2.3/",
                  "http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:192.168.0.1]/", "http://localhost/", "http://a.local/"] {
            assert!(validate_public_http_url(u).is_err(), "{u}");
        }
        for u in ["https://i.imgur.com/a.png", "http://8.8.8.8/x.jpg", "https://[2001:4860::8888]/"] {
            assert!(validate_public_http_url(u).is_ok(), "{u}");
        }
        assert!(validate_public_http_url("file:///C:/x.png").is_err());
    }

    #[test]
    fn image_type_is_sniffed() {
        assert_eq!(sniff_image_type(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff_image_type(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_image_type(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff_image_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image_type(b"\0\0\0\x1cftypavif"), Some("image/avif"));
        assert_eq!(sniff_image_type(b"<html><body>router</body></html>"), None);
        assert_eq!(sniff_image_type(&[0, 0, 1, 0, 1, 0, 16, 16]), Some("image/x-icon"));
        assert_eq!(sniff_image_type(b"<?xml version=\"1.0\"?><svg xmlns=\"x\"></svg>"), Some("image/svg+xml"));
        assert_eq!(sniff_image_type(b"  <svg viewBox=\"0 0 1 1\"></svg>"), Some("image/svg+xml"));
        assert_eq!(sniff_image_type(b"<?xml version=\"1.0\"?><rss></rss>"), None);
        assert_eq!(declared_image_type(Some("image/heic; charset=x")), Some("image/heic".to_string()));
        assert_eq!(declared_image_type(Some("text/html")), None);
        assert_eq!(declared_image_type(Some("image/x\"onerror")), None);
        assert_eq!(declared_image_type(None), None);
    }

    #[test]
    fn saved_file_names_stay_in_folder() {
        assert_eq!(safe_image_file_stem("https://example.com/img/photo.jpg?x=1"), "photo");
        assert_eq!(safe_image_file_stem("https://example.com/%E7%94%BB%E5%83%8F.png"), "画像");
        let s = safe_image_file_stem("https://example.com/C:%5CWindows%5Cevil.png");
        assert!(!s.contains(':') && !s.contains('\\'), "{s}");
        let s = safe_image_file_stem("https://example.com/..%2F..%2Fevil.png");
        assert!(!s.contains('/') && !s.starts_with('.'), "{s}");
        assert!(safe_image_file_stem("https://example.com/").starts_with("image_"));
    }
}

#[tauri::command]
fn get_data_dir() -> Result<String, String> {
    core_store::portable_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// 起動時に data\tmp へ向ける前の TEMP / TMP (外部アプリを起動するときに戻すため)
#[cfg(target_os = "windows")]
static ORIGINAL_TEMP: std::sync::OnceLock<(Option<std::ffi::OsString>, Option<std::ffi::OsString>)> =
    std::sync::OnceLock::new();

/// 外部アプリ (既定のブラウザ等) を起動する Command の TEMP / TMP を、LiveFake 起動前の値に戻す。
/// LiveFake 自身は TEMP を data\tmp に向けているため、そのままだと起動したブラウザの一時ファイルまで
/// data\tmp に作られてしまう
#[cfg(target_os = "windows")]
fn restore_original_temp(cmd: &mut Command) -> &mut Command {
    if let Some((temp, tmp)) = ORIGINAL_TEMP.get() {
        if let Some(v) = temp {
            cmd.env("TEMP", v);
        }
        if let Some(v) = tmp {
            cmd.env("TMP", v);
        }
    }
    cmd
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    // Only allow http(s). Without this, the Windows FileProtocolHandler below would
    // happily open file:// paths, UNC shares, or local executables.
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("invalid url: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("blocked url scheme: {}", parsed.scheme()));
    }

    // 確かめたあとの URL (正規化したもの) を渡す
    let url = parsed.to_string();

    #[cfg(target_os = "windows")]
    {
        restore_original_temp(&mut Command::new("rundll32"))
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("unsupported platform".to_string())
}

#[tauri::command]
async fn fetch_board_categories() -> Result<Vec<BoardCategory>, String> {
    let menu = fetch_bbsmenu_cached().await?;

    // bbsmenu.json structure: { "menu_list": [ { "category_name": "...", "category_content": [...] } ] }
    let menu_list = menu
        .get("menu_list")
        .and_then(|v| v.as_array())
        .ok_or("bbsmenu missing menu_list array")?;

    let mut categories: Vec<BoardCategory> = Vec::new();

    for cat_obj in menu_list {
        let category_name = cat_obj
            .get("category_name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        let content = match cat_obj.get("category_content").and_then(|v| v.as_array()) {
            Some(arr) => arr,
            None => continue,
        };

        let mut boards: Vec<BoardEntry> = Vec::new();
        for item in content {
            let board_name = item
                .get("board_name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let url = item
                .get("url")
                .and_then(|v| v.as_str())
                .map(normalize_5ch_url)
                .unwrap_or_default();
            if !board_name.is_empty() && !url.is_empty() {
                boards.push(BoardEntry { board_name, url });
            }
        }

        if !boards.is_empty() {
            categories.push(BoardCategory {
                category_name,
                boards,
            });
        }
    }

    Ok(categories)
}

// --- Favorites persistence ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FavoriteBoard {
    board_name: String,
    url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FavoriteThread {
    thread_url: String,
    title: String,
    board_url: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct FavoritesData {
    boards: Vec<FavoriteBoard>,
    threads: Vec<FavoriteThread>,
}

#[tauri::command]
fn load_favorites() -> Result<FavoritesData, String> {
    // Try new name first, fall back to old name and migrate
    if let Ok(data) = core_store::load_json::<FavoritesData>("board-catalog.json") {
        return Ok(data);
    }
    if let Ok(data) = core_store::load_json::<FavoritesData>("favorites.json") {
        // Migrate: save under new name, keep old file for safety
        let _ = core_store::save_json("board-catalog.json", &data);
        return Ok(data);
    }
    Ok(FavoritesData::default())
}

#[tauri::command]
fn save_favorites(favorites: FavoritesData) -> Result<(), String> {
    core_store::save_json("board-catalog.json", &favorites).map_err(|e| e.to_string())
}

// --- External boards persistence ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalBoard {
    board_name: String,
    url: String,
}

#[tauri::command]
fn load_external_boards() -> Result<Vec<ExternalBoard>, String> {
    match core_store::load_json::<Vec<ExternalBoard>>("external-boards.json") {
        Ok(data) => Ok(data),
        Err(_) => Ok(vec![]),
    }
}

#[tauri::command]
fn save_external_boards(boards: Vec<ExternalBoard>) -> Result<(), String> {
    core_store::save_json("external-boards.json", &boards).map_err(|e| e.to_string())
}

// --- Generic JSON persistence (for localStorage migration) ---

/// Save arbitrary JSON data to a named file in the data directory.
/// Allowed filenames are restricted to prevent path traversal.
#[tauri::command]
fn save_generic_json(filename: String, data: serde_json::Value) -> Result<(), String> {
    const ALLOWED: &[&str] = &[
        "bookmarks.json",
        "scroll-positions.json",
        "name-history.json",
        "my-posts.json",
        "search-history.json",
        "thread-fetch-times.json",
        "expanded-categories.json",
        "ui-state.json",
        "viewer-whitelist.json",
        "overlay-appearance.json",
        "overlay-layouts.json",
        "viewer-autoadd.json",
        "twitch-events.json",
        "twitch-teach.json",
        "twitch-emotes.json",
        "youtube-events.json",
        "post-history.json",
    ];
    if !ALLOWED.contains(&filename.as_str()) {
        return Err(format!("Filename not allowed: {}", filename));
    }
    core_store::save_json(&filename, &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_generic_json(filename: String) -> Result<serde_json::Value, String> {
    const ALLOWED: &[&str] = &[
        "bookmarks.json",
        "scroll-positions.json",
        "name-history.json",
        "my-posts.json",
        "search-history.json",
        "thread-fetch-times.json",
        "expanded-categories.json",
        "ui-state.json",
        "viewer-whitelist.json",
        "overlay-appearance.json",
        "overlay-layouts.json",
        "viewer-autoadd.json",
        "twitch-events.json",
        "twitch-teach.json",
        "twitch-emotes.json",
        "youtube-events.json",
        "post-history.json",
    ];
    if !ALLOWED.contains(&filename.as_str()) {
        return Err(format!("Filename not allowed: {}", filename));
    }
    match core_store::load_json::<serde_json::Value>(&filename) {
        Ok(data) => Ok(data),
        Err(_) => Ok(serde_json::Value::Null),
    }
}

// --- NG filter persistence ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum NgEntry {
    Simple(String),
    WithMode {
        value: String,
        mode: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none", rename = "scopeUrl")]
        scope_url: Option<String>,
    },
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct NgFilters {
    #[serde(default)]
    words: Vec<NgEntry>,
    #[serde(default)]
    ids: Vec<NgEntry>,
    #[serde(default)]
    names: Vec<NgEntry>,
    #[serde(default)]
    mails: Vec<NgEntry>,
    #[serde(default)]
    thread_words: Vec<NgEntry>,
    #[serde(default)]
    image_words: Vec<NgEntry>,
    /// 見えない文字を含むレスの NG ("off" / "abone" / "hide")。古い設定ファイルには無いので既定は空文字
    /// (フロント側で空文字や不明な値は "off" として扱う)
    #[serde(default)]
    invisible: String,
}

#[tauri::command]
fn load_ng_filters() -> Result<NgFilters, String> {
    // Try new name first, fall back to old name and migrate
    if let Ok(data) = core_store::load_json::<NgFilters>("ng-settings.json") {
        return Ok(data);
    }
    if let Ok(data) = core_store::load_json::<NgFilters>("ng_filters.json") {
        // Migrate: save under new name, keep old file for safety
        let _ = core_store::save_json("ng-settings.json", &data);
        return Ok(data);
    }
    Ok(NgFilters::default())
}

#[tauri::command]
fn save_ng_filters(filters: NgFilters) -> Result<(), String> {
    core_store::save_json("ng-settings.json", &filters).map_err(|e| e.to_string())
}

// --- OGP / X ポストカード取得 ---

/// デコード失敗で置換文字 (U+FFFD) が混入した OGP は壊れているとみなし、キャッシュを使わず取り直す。
fn ogp_card_looks_garbled(card: &OgpCard) -> bool {
    let has_repl = |s: &Option<String>| s.as_deref().is_some_and(|t| t.contains('\u{FFFD}'));
    has_repl(&card.title) || has_repl(&card.description) || has_repl(&card.site_name)
}

/// OGP カード取得時の User-Agent。掲示板用の Monazilla UA だと一般サイトに弾かれることがある。
const OGP_USER_AGENT: &str = "Mozilla/5.0 (compatible; LiveFake/0.1)";

/// カードとして表示できる情報が何も無い (タイトルも画像も無い) = 取得失敗相当。
/// このようなキャッシュは 7日ではなく 30分で再試行する。
fn ogp_card_is_empty(card: &OgpCard) -> bool {
    card.title.as_deref().is_none_or(|t| t.trim().is_empty())
        && card.image.as_deref().is_none_or(|i| i.trim().is_empty())
}

/// 本文中の外部 URL の OGP 情報を取得してカード表示用に返す。
/// キャッシュ (7日 TTL、内容が空のものは 30分) を優先し、無ければ取得して保存する。
/// 接続先の検証 (私有 IP 拒否・DNS 解決結果の検証・リダイレクト毎の再検証) は
/// `core_fetch::fetch_ogp` 側で行う。
#[tauri::command]
async fn fetch_ogp_card(url: String) -> Result<OgpCard, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("unsupported url scheme".to_string());
    }
    if url.len() > 2048 {
        return Err("url too long".to_string());
    }
    if let Ok(Some((json, age))) = core_store::load_ogp_cache_with_age(&url) {
        if let Ok(card) = serde_json::from_str::<OgpCard>(&json) {
            let retry_soon = ogp_card_is_empty(&card) && age > core_store::OGP_CACHE_RETRY_TTL_SECS;
            if !ogp_card_looks_garbled(&card) && !retry_soon {
                return Ok(card);
            }
        }
    }
    // YouTube の動画リンクは HTML が巨大で OGP が先頭 512KB に無いため oEmbed から取る
    let card = match core_fetch::fetch_youtube_card(OGP_USER_AGENT, &url).await {
        Ok(Some(card)) => card,
        Ok(None) => core_fetch::fetch_ogp(OGP_USER_AGENT, &url)
            .await
            .map_err(|e| e.to_string())?,
        Err(e) => return Err(e.to_string()),
    };
    if let Ok(json) = serde_json::to_string(&card) {
        let _ = core_store::save_ogp_cache(&url, &json);
    }
    Ok(card)
}

/// X (Twitter) のポストをカード表示用に取得する。
/// 接続先は固定の syndication エンドポイントのみ (本文由来 URL からは ID しか使わない)。
/// キャッシュは OGP と同じテーブルを `tweet:v2:<id>` キーで共用する (7日 TTL)。
#[tauri::command]
async fn fetch_tweet_card(url: String) -> Result<TweetCard, String> {
    let id = core_fetch::extract_tweet_id(&url).ok_or_else(|| "not a tweet url".to_string())?;
    let cache_key = format!("tweet:v2:{}", id);
    if let Ok(Some(json)) = core_store::load_ogp_cache(&cache_key) {
        if let Ok(card) = serde_json::from_str::<TweetCard>(&json) {
            return Ok(card);
        }
    }
    let card = core_fetch::fetch_tweet(OGP_USER_AGENT, &url)
        .await
        .map_err(|e| e.to_string())?;
    if let Ok(json) = serde_json::to_string(&card) {
        let _ = core_store::save_ogp_cache(&cache_key, &json);
    }
    Ok(card)
}

// --- OGP ドメインフィルタ (許可/ブロックリスト) ---
// block は常に除外、allow は空なら全許可・登録ありならそのドメインのみ許可。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct OgpDomainFilters {
    #[serde(default)]
    allow: Vec<String>,
    #[serde(default)]
    block: Vec<String>,
}

#[tauri::command]
fn load_ogp_domain_filters() -> Result<OgpDomainFilters, String> {
    match core_store::load_json::<OgpDomainFilters>("ogp_domain_filters.json") {
        Ok(data) => Ok(data),
        Err(_) => Ok(OgpDomainFilters::default()),
    }
}

#[tauri::command]
fn save_ogp_domain_filters(filters: OgpDomainFilters) -> Result<(), String> {
    core_store::save_json("ogp_domain_filters.json", &filters).map_err(|e| e.to_string())
}

// --- TTS dictionary persistence ---

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TtsDictEntry {
    from: String,
    to: String,
    #[serde(default)]
    full_replace: bool,
}

/// デフォルト辞書のバージョン。項目を追加したら +1 する (既存ユーザーの辞書へ一度だけマージされる)。
const TTS_DICT_DEFAULTS_VERSION: u32 = 2;

fn dict(from: &str, to: &str) -> TtsDictEntry {
    TtsDictEntry { from: from.to_string(), to: to.to_string(), full_replace: false }
}

/// デフォルト辞書。フロント側 `DEFAULT_TTS_DICT` (App.tsx) と同じ内容にすること。
/// URL 系のキーワードは読み上げ時に URL 単位 (トークン) で照合される。
fn default_tts_dict() -> Vec<TtsDictEntry> {
    vec![
        TtsDictEntry {
            from: "WebABC".to_string(),
            to: "このレスは番組表です".to_string(),
            full_replace: true,
        },
        dict("http://jbbs.shitaraba", "したらば掲示板"),
        dict("youtube", "ゆーちゅーぶ"),
        dict("youtu.be", "ゆーちゅーぶ"),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TtsDictMeta {
    #[serde(default)]
    defaults_version: u32,
}

/// 辞書を読み込む。デフォルト辞書に新しい項目が追加された場合、既存ユーザーの辞書へ
/// 「まだ無い `from` だけ」を一度だけ追記する (ユーザーが意図的に削除した項目を毎回復活させない)。
#[tauri::command]
fn load_tts_dict() -> Result<Vec<TtsDictEntry>, String> {
    let mut entries = match core_store::load_json::<Vec<TtsDictEntry>>("tts-dict.json") {
        Ok(data) => data,
        Err(_) => return Ok(default_tts_dict()),
    };
    let meta = core_store::load_json::<TtsDictMeta>("tts-dict-meta.json").unwrap_or_default();
    if meta.defaults_version < TTS_DICT_DEFAULTS_VERSION {
        let mut changed = false;
        for d in default_tts_dict() {
            if !entries.iter().any(|e| e.from.trim().eq_ignore_ascii_case(d.from.trim())) {
                entries.push(d);
                changed = true;
            }
        }
        if changed {
            if let Err(e) = core_store::save_json("tts-dict.json", &entries) {
                eprintln!("tts dict merge save failed: {e}");
            }
        }
        if let Err(e) = core_store::save_json(
            "tts-dict-meta.json",
            &TtsDictMeta { defaults_version: TTS_DICT_DEFAULTS_VERSION },
        ) {
            eprintln!("tts dict meta save failed: {e}");
        }
    }
    Ok(entries)
}

#[tauri::command]
fn save_tts_dict(entries: Vec<TtsDictEntry>) -> Result<(), String> {
    core_store::save_json("tts-dict.json", &entries).map_err(|e| e.to_string())
}

// --- TTS 読み上げ許可リスト (IP アドレス配信 URL 専用) ---
// ホスト部分が生の IP アドレスである URL は、このリストに登録されたものだけ `to` で読み上げ、
// 未登録のものは読み上げない (無音)。ドメイン名の URL は通常の読み上げ辞書で扱う。

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TtsIpAllowEntry {
    /// `192.0.2.1:8030` のように `IP[:ポート]`。ポート省略時はその IP の全ポートに一致。
    host: String,
    to: String,
}

fn default_tts_ip_allow() -> Vec<TtsIpAllowEntry> {
    Vec::new()
}

#[tauri::command]
fn load_tts_ip_allow() -> Result<Vec<TtsIpAllowEntry>, String> {
    match core_store::load_json::<Vec<TtsIpAllowEntry>>("tts-ip-allow.json") {
        Ok(data) => Ok(data),
        Err(_) => Ok(default_tts_ip_allow()),
    }
}

#[tauri::command]
fn save_tts_ip_allow(entries: Vec<TtsIpAllowEntry>) -> Result<(), String> {
    core_store::save_json("tts-ip-allow.json", &entries).map_err(|e| e.to_string())
}

// --- TTS 読み上げない辞書 ---
// 表示やあぼーんには影響せず、読み上げだけを抑制する。
// `skip_whole` = true: 一致したらそのレス全体を読み上げない / false: 一致した語句だけを無音で除去。
// names / ids は読み上げ文に含まれないため常にレス全体スキップとして扱う。

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TtsMuteEntry {
    value: String,
    #[serde(default)]
    skip_whole: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TtsMuteDict {
    #[serde(default)]
    names: Vec<TtsMuteEntry>,
    #[serde(default)]
    words: Vec<TtsMuteEntry>,
    #[serde(default)]
    ids: Vec<TtsMuteEntry>,
}

#[tauri::command]
fn load_tts_mute_dict() -> Result<TtsMuteDict, String> {
    match core_store::load_json::<TtsMuteDict>("tts-mute-dict.json") {
        Ok(data) => Ok(data),
        Err(_) => Ok(TtsMuteDict::default()),
    }
}

#[tauri::command]
fn save_tts_mute_dict(dict: TtsMuteDict) -> Result<(), String> {
    core_store::save_json("tts-mute-dict.json", &dict).map_err(|e| e.to_string())
}

// --- Read status persistence ---

/// Map of board_url -> { thread_key -> last_read_response_no }
type ReadStatusMap = HashMap<String, HashMap<String, u32>>;

#[tauri::command]
fn load_read_status() -> Result<ReadStatusMap, String> {
    match core_store::load_json::<ReadStatusMap>("read_status.json") {
        Ok(data) => Ok(data),
        Err(_) => Ok(HashMap::new()),
    }
}

#[tauri::command]
fn save_read_status(status: ReadStatusMap) -> Result<(), String> {
    core_store::save_json("read_status.json", &status).map_err(|e| e.to_string())
}

// --- Thread history (thread-history.json) ---

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadHistoryEntry {
    last_read_no: u32,
    visited_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom_title: Option<String>,
}

/// Map of board_url -> { thread_key -> ThreadHistoryEntry }
type ThreadHistoryMap = HashMap<String, HashMap<String, ThreadHistoryEntry>>;

#[tauri::command]
fn load_thread_history() -> Result<ThreadHistoryMap, String> {
    match core_store::load_json::<ThreadHistoryMap>("thread-history.json") {
        Ok(data) => Ok(data),
        Err(_) => {
            // Migrate from read_status.json if thread-history.json doesn't exist
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let old = core_store::load_json::<ReadStatusMap>("read_status.json")
                .unwrap_or_default();
            let migrated: ThreadHistoryMap = old
                .into_iter()
                .map(|(board, threads)| {
                    let entries = threads
                        .into_iter()
                        .map(|(key, no)| {
                            (key, ThreadHistoryEntry { last_read_no: no, visited_at: now, custom_title: None })
                        })
                        .collect();
                    (board, entries)
                })
                .collect();
            Ok(migrated)
        }
    }
}

#[tauri::command]
fn save_thread_history(history: ThreadHistoryMap) -> Result<(), String> {
    core_store::save_json("thread-history.json", &history).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_thread_custom_title(board_url: String, thread_key: String, title: Option<String>) -> Result<(), String> {
    let mut history = load_thread_history()?;
    let entry = history
        .entry(board_url)
        .or_default()
        .entry(thread_key)
        .or_default();
    entry.custom_title = title;
    core_store::save_json("thread-history.json", &history).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_app_settings() -> Result<HashMap<String, String>, String> {
    core_store::load_settings_ini().map_err(|e| e.to_string())
}

/// Template written to `custom.css` on first launch (all comments, no effect until edited).
const USER_CSS_TEMPLATE: &str = r#"/* LiveFake ユーザーカスタムCSS (custom.css)
 *
 * このファイルに書いたCSSはアプリ起動時に読み込まれ、標準の見た目より常に優先されます
 * (標準の見た目は CSS レイヤーにまとめてあるので、指定の強さに関係なくこちらが勝ちます)。
 * 編集後はメニュー「設定 > ユーザーCSSを再読み込み」で即座に反映できます。
 *
 * ── 基本色 (CSS変数) ─────────────────────────────
 * :root {
 *   --bg: #f0f0f0;      背景色
 *   --panel: #ffffff;   パネル背景色
 *   --line: #c0c0c0;    罫線色
 *   --ink: #1b1b1b;     文字色
 *   --sub: #555555;     補助文字色
 *   --accent: #0066cc;  アクセント色
 * }
 * ダークモード時の色は .dark { --bg: #1e1e1e; ... } で上書きします。
 *
 * ── 主なUI要素のクラス名 ─────────────────────────
 *   .menu-bar / .tool-bar        メニューバー / ツールバー
 *   .pane.boards                 板一覧ペイン
 *   .pane.threads                スレッド一覧ペイン
 *   .pane.responses              レスポンスペイン
 *   .response-block              レス1件のブロック
 *   .response-header / .response-body   レスのヘッダー / 本文
 *   .response-name / .response-id-cell  投稿者名 / ID
 *   .new-arrival-pane / .new-arrival-item   新着ペイン / 新着1件
 *   .thread-tab / .board-tab     スレッドタブ / 板タブ
 *   .thread-menu                 右クリックメニュー
 *   .anchor-popup / .id-popup    アンカー / IDポップアップ
 *   .compose-window              書き込みウィンドウ
 *   .status-bar                  ステータスバー
 *   .pane.viewer / .viewer-item  ビュワー / ビュワーの1件
 *   img.twitch-emote             Twitch のスタンプ (.giant で巨大)
 *   .settings-panel              設定画面 (data/theme/setting.css も使えます)
 *   一覧は docs/CSS_CUSTOMIZE.md を参照
 *
 * ── 例: 全体をセピア調にする ─────────────────────
 * :root { --bg: #f4ecd8; --panel: #fbf5e6; --ink: #4a3f2a; }
 *
 * ── 例: レス本文の行間を広げる ───────────────────
 * .response-body { line-height: 1.8; }
 */
"#;

// ===== Theme CSS (SIKI互換カスタムCSS) =====

/// data/theme/ 配下のファイル名ホワイトリスト (SIKIのファイル構成に準拠)
const THEME_CSS_FILES: &[(&str, &str)] = &[
    ("main.css", "全テーマ共通"),
    ("light.css", "ライトモード時のみ適用"),
    ("dark.css", "ダークモード時のみ適用"),
    ("floating.css", "字幕ウィンドウ用"),
    ("mediaviewer.css", "画像ポップアップウィンドウ用"),
    ("compose.css", "書き込みの浮遊ウィンドウ用"),
    ("postform.css", "書き込み欄用 (書き込みパネル内に限定適用)"),
    ("setting.css", "設定画面用 (設定パネル内に限定適用)"),
];
const MAX_THEME_CSS_BYTES: u64 = 512 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThemeCssFile {
    name: String,
    content: String,
    stripped_hosts: Vec<String>,
    oversized: bool,
}

fn css_external_urls_allowed() -> bool {
    core_store::load_settings_ini()
        .ok()
        .and_then(|m| m.get("App.cssAllowExternalUrls").cloned())
        .map(|v| v == "true")
        .unwrap_or(false)
}

/// `</style` 断片を除去する (style要素経由の注入でHTMLへ脱出できないようにする多層防御)
fn remove_style_close(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw.len() - i >= 7
            && bytes[i] == b'<'
            && bytes[i + 1] == b'/'
            && bytes[i + 2..i + 7].eq_ignore_ascii_case(b"style")
        {
            i += 7;
            continue;
        }
        let ch_len = raw[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        out.push_str(&raw[i..i + ch_len]);
        i += ch_len;
    }
    out
}

/// `url(...)` の閉じ括弧位置を探す (引用符内の `)` は無視)
fn find_url_close(s: &str) -> Option<usize> {
    let mut quote: Option<char> = None;
    for (idx, c) in s.char_indices() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None => {
                if c == '"' || c == '\'' {
                    quote = Some(c);
                } else if c == ')' {
                    return Some(idx);
                }
            }
        }
    }
    None
}

fn extract_css_url_host(url: &str) -> Option<String> {
    let after_scheme = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("//");
    let host: String = after_scheme
        .chars()
        .take_while(|c| !matches!(c, '/' | ':' | '?' | '#'))
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    if host.is_empty() { None } else { Some(host) }
}

/// 外部 http(s) を参照する url(...) を `none` に置換する (CSSによる外部送信対策)。
/// data: URI・相対パスは通す。除去したホスト名の一覧を返す。
fn strip_external_urls(css: &str) -> (String, Vec<String>) {
    let mut out = String::with_capacity(css.len());
    let mut hosts: Vec<String> = Vec::new();
    let bytes = css.as_bytes();
    let mut i = 0;
    while i < css.len() {
        if css.len() - i >= 4 && bytes[i..i + 4].eq_ignore_ascii_case(b"url(") {
            if let Some(close_rel) = find_url_close(&css[i + 4..]) {
                let inner = css[i + 4..i + 4 + close_rel]
                    .trim()
                    .trim_matches(|c| c == '"' || c == '\'')
                    .trim();
                let lower = inner.to_ascii_lowercase();
                if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("//") {
                    if let Some(h) = extract_css_url_host(inner) {
                        if !hosts.contains(&h) {
                            hosts.push(h);
                        }
                    }
                    out.push_str("none");
                    i = i + 4 + close_rel + 1;
                    continue;
                }
            }
        }
        let ch_len = css[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        out.push_str(&css[i..i + ch_len]);
        i += ch_len;
    }
    (out, hosts)
}

fn read_theme_css_file(name: &str, path: &std::path::Path, allow_external: bool) -> ThemeCssFile {
    let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if len > MAX_THEME_CSS_BYTES {
        return ThemeCssFile {
            name: name.to_string(),
            content: String::new(),
            stripped_hosts: Vec::new(),
            oversized: true,
        };
    }
    let raw = std::fs::read_to_string(path).unwrap_or_default();
    let no_close = remove_style_close(&raw);
    let (content, stripped_hosts) = if allow_external {
        (no_close, Vec::new())
    } else {
        strip_external_urls(&no_close)
    };
    ThemeCssFile {
        name: name.to_string(),
        content,
        stripped_hosts,
        oversized: false,
    }
}

#[cfg(test)]
mod theme_css_tests {
    use super::*;

    #[test]
    fn strip_external_urls_blocks_http_and_keeps_data_uri() {
        let css = r#".a { background: url(https://evil.example.com/x.png); }
.b { background: url("data:image/png;base64,AAAA"); }
.c { background: URL( 'http://track.jp/p?q=1' ); }"#;
        let (out, hosts) = strip_external_urls(css);
        assert!(!out.contains("evil.example.com"));
        assert!(!out.contains("track.jp"));
        assert!(out.contains("data:image/png"));
        assert!(out.contains(".a { background: none; }"));
        assert_eq!(hosts, vec!["evil.example.com".to_string(), "track.jp".to_string()]);
    }

    #[test]
    fn strip_external_urls_blocks_protocol_relative() {
        let (out, hosts) = strip_external_urls(".x { background: url(//cdn.example.net/a.gif); }");
        assert!(out.contains("background: none"));
        assert_eq!(hosts, vec!["cdn.example.net".to_string()]);
    }

    #[test]
    fn remove_style_close_strips_breakout() {
        let out = remove_style_close(".a{}</StYlE><script>alert(1)</script>");
        assert!(!out.to_lowercase().contains("</style"));
        assert!(out.contains("<script>")); // scriptタグ自体はtextContent注入なので無害
    }

    #[test]
    fn multibyte_css_survives_sanitize() {
        let css = "/* 日本語コメント */ .rb { color: red; }";
        let (out, hosts) = strip_external_urls(&remove_style_close(css));
        assert_eq!(out, css);
        assert!(hosts.is_empty());
    }
}

/// custom.css (従来) + data/theme/ 配下のSIKI互換CSS群をサニタイズ済みで返す。
/// ファイルが無ければ説明コメント入りテンプレートを生成する。
#[tauri::command]
fn load_theme_css(allow_external: Option<bool>) -> Result<Vec<ThemeCssFile>, String> {
    let dir = core_store::portable_data_dir().map_err(|e| e.to_string())?;
    let theme_dir = dir.join("theme");
    std::fs::create_dir_all(&theme_dir).map_err(|e| e.to_string())?;
    let allow = allow_external.unwrap_or_else(css_external_urls_allowed);

    let mut files = Vec::new();
    let custom_path = dir.join("custom.css");
    if !custom_path.exists() {
        std::fs::write(&custom_path, USER_CSS_TEMPLATE).map_err(|e| e.to_string())?;
    }
    files.push(read_theme_css_file("custom.css", &custom_path, allow));

    for (name, desc) in THEME_CSS_FILES {
        let path = theme_dir.join(name);
        if !path.exists() {
            let template = format!(
                "/* LiveFake カスタムCSS: {desc}\n   SIKI互換のクラス・CSS変数が使えます。詳細は docs/CSS_CUSTOMIZE.md を参照。\n   反映: メニュー「設定 > ユーザーCSSを再読み込み」(再起動不要) */\n"
            );
            std::fs::write(&path, template).map_err(|e| e.to_string())?;
        }
        files.push(read_theme_css_file(name, &path, allow));
    }
    Ok(files)
}

/// 字幕・画像ウィンドウが開いていれば floating.css / mediaviewer.css を再適用する
#[tauri::command]
fn refresh_window_css(app: AppHandle, allow_external: Option<bool>) -> Result<(), String> {
    let dir = core_store::portable_data_dir().map_err(|e| e.to_string())?;
    let theme_dir = dir.join("theme");
    let allow = allow_external.unwrap_or_else(css_external_urls_allowed);
    for (label, file) in [
        ("subtitle", "floating.css"),
        ("image_popup", "mediaviewer.css"),
        ("compose_popup", "compose.css"),
    ] {
        if let Some(win) = app.get_webview_window(label) {
            let f = read_theme_css_file(file, &theme_dir.join(file), allow);
            let js = format!(
                "if(window.__setUserCss)window.__setUserCss({})",
                serde_json::to_string(&f.content).unwrap_or_else(|_| "\"\"".to_string())
            );
            let _ = win.eval(&js);
        }
    }
    Ok(())
}

/// したらば・JPNKN のドメイン上書き設定をアプリ内部の状態に反映する。
/// 空文字列/未設定/既定値と同じ場合は上書きしない (既定のハードコードされたドメインのまま)。
fn apply_domain_overrides_from_settings(settings: &HashMap<String, String>) {
    // 一部の項目だけを保存するとき (OBS 表示のオンオフなど) は、ドメインの上書きに触れない
    if !settings.contains_key("App.shitarabaHost") && !settings.contains_key("App.jpnknHost") {
        return;
    }
    let shitaraba = settings
        .get("App.shitarabaHost")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "jbbs.shitaraba.net");
    let jpnkn = settings
        .get("App.jpnknHost")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "bbs.jpnkn.com");
    set_shitaraba_host_override(shitaraba);
    set_jpnkn_host_override(jpnkn);
}

#[tauri::command]
fn save_app_settings(settings: HashMap<String, String>) -> Result<(), String> {
    apply_domain_overrides_from_settings(&settings);
    core_store::save_settings_ini(&settings).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_event_log(level: String, message: String) -> Result<(), String> {
    let lvl = match level.to_uppercase().as_str() {
        "WARN" => "WARN",
        "ERROR" => "ERROR",
        _ => "INFO",
    };
    core_store::append_log_level(lvl, &message).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_layout_prefs(prefs: String) -> Result<(), String> {
    core_store::save_json("layout_prefs.json", &prefs).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_session_tabs(data: String) -> Result<(), String> {
    core_store::save_json("session_tabs.json", &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_session_tabs() -> Result<String, String> {
    match core_store::load_json::<String>("session_tabs.json") {
        Ok(data) => Ok(data),
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
fn save_session_board_tabs(data: String) -> Result<(), String> {
    core_store::save_json("session_board_tabs.json", &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_session_board_tabs() -> Result<String, String> {
    match core_store::load_json::<String>("session_board_tabs.json") {
        Ok(data) => Ok(data),
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
fn load_layout_prefs() -> Result<String, String> {
    match core_store::load_json::<String>("layout_prefs.json") {
        Ok(data) => Ok(data),
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
fn save_thread_cache(thread_url: String, title: String, responses_json: String) -> Result<(), String> {
    core_store::save_thread_cache(&thread_url, &title, &responses_json)
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
fn load_thread_cache(thread_url: String) -> Result<Option<String>, String> {
    core_store::load_thread_cache(&thread_url)
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
fn load_all_cached_threads() -> Result<Vec<(String, String, i64)>, String> {
    core_store::load_all_cached_threads()
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
fn delete_thread_cache(thread_url: String) -> Result<(), String> {
    core_store::delete_thread_cache(&thread_url)
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
fn quit_app() {
    std::process::exit(0);
}

#[tauri::command]
fn list_system_fonts() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        use winreg::RegKey;
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let Ok(key) = hklm.open_subkey(
            "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"
        ) else {
            return vec![];
        };
        let mut names: Vec<String> = key
            .enum_values()
            .filter_map(|item| item.ok())
            .flat_map(|(name, _)| {
                // Strip parenthetical suffix: "MS Gothic & MS UI Gothic (TrueType)" → "MS Gothic & MS UI Gothic"
                let base = if let Some(pos) = name.rfind('(') {
                    name[..pos].trim().to_string()
                } else {
                    name.trim().to_string()
                };
                // Split grouped entries: "MS Gothic & MS UI Gothic" → ["MS Gothic", "MS UI Gothic"]
                // Handle both ASCII '&' and full-width '＆'
                base.split('&')
                    .flat_map(|s| s.split('\u{FF06}')) // full-width ＆
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            })
            .filter(|s| !s.is_empty())
            .collect();
        names.sort();
        names.dedup();
        names
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![]
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    width: f64,
    height: f64,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
    #[serde(default)]
    maximized: Option<bool>,
}

#[tauri::command]
fn save_window_size(window: tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let maximized = window.is_maximized().ok();
    let pos = window.outer_position().ok();
    let state = WindowState {
        width,
        height,
        x: pos.as_ref().map(|p| p.x),
        y: pos.as_ref().map(|p| p.y),
        maximized,
    };
    core_store::save_json("window_size.json", &state).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_window_size() -> Result<Option<WindowState>, String> {
    match core_store::load_json::<WindowState>("window_size.json") {
        Ok(data) => Ok(Some(data)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn set_window_theme(window: tauri::WebviewWindow, dark: bool) -> Result<(), String> {
    use tauri::Theme;
    window.set_theme(if dark { Some(Theme::Dark) } else { Some(Theme::Light) })
        .map_err(|e| format!("{}", e))
}

// ===== Highlight Commands =====

#[tauri::command]
fn load_id_highlights() -> Result<serde_json::Value, String> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let data = core_store::load_json::<serde_json::Value>("id-highlights.json")
        .unwrap_or_else(|_| serde_json::json!({ "date": "", "highlights": {} }));
    // Purge highlights if date has changed
    let stored_date = data.get("date").and_then(|v| v.as_str()).unwrap_or("");
    if stored_date != today {
        let fresh = serde_json::json!({ "date": today, "highlights": {} });
        let _ = core_store::save_json("id-highlights.json", &fresh);
        return Ok(fresh);
    }
    Ok(data)
}

#[tauri::command]
fn save_id_highlights(data: serde_json::Value) -> Result<(), String> {
    core_store::save_json("id-highlights.json", &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_text_highlights() -> Result<serde_json::Value, String> {
    core_store::load_json::<serde_json::Value>("text-highlights.json")
        .map_err(|e| e.to_string())
        .or_else(|_| Ok(serde_json::json!([])))
}

#[tauri::command]
fn save_text_highlights(data: serde_json::Value) -> Result<(), String> {
    core_store::save_json("text-highlights.json", &data).map_err(|e| e.to_string())
}

// ===== Proxy Commands =====

/// プロキシ1組 (画面とのやりとり用)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProxyEndpointPayload {
    host: String,
    port: String,
    username: String,
    password: String,
}

/// 設定 > プロキシ (受信用 = 掲示板の読み込み・送信用 = 書き込み)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxySettingsPayload {
    enabled: bool,
    proxy_type: String,
    #[serde(default)]
    no_cache: bool,
    #[serde(default)]
    http_mode: bool,
    receive: ProxyEndpointPayload,
    send: ProxyEndpointPayload,
}

impl ProxySettingsPayload {
    fn to_settings(&self) -> ProxySettings {
        let ep = |e: &ProxyEndpointPayload| core_proxy::ProxyEndpoint {
            host: e.host.trim().to_string(),
            port: e.port.trim().to_string(),
            username: e.username.clone(),
            password: e.password.clone(),
        };
        ProxySettings {
            enabled: self.enabled,
            proxy_type: ProxyType::from_name(&self.proxy_type),
            no_cache: self.no_cache,
            http_mode: self.http_mode,
            receive: ep(&self.receive),
            send: ep(&self.send),
        }
    }
}

/// settings.ini の [Proxy] から読む。受信用は以前の1組の設定のキーをそのまま使い、
/// 送信用のキーがまだ無ければ (以前の版の設定) 受信用と同じものにする
fn proxy_payload_from_ini(map: &HashMap<String, String>) -> ProxySettingsPayload {
    let get = |k: &str| map.get(k).cloned().unwrap_or_default();
    let receive = ProxyEndpointPayload {
        host: get("Proxy.ProxyHost"),
        port: get("Proxy.ProxyPort"),
        username: get("Proxy.ProxyUsername"),
        password: unprotect_password(&get("Proxy.ProxyPassword")),
    };
    let send = if map.contains_key("Proxy.SendHost") {
        ProxyEndpointPayload {
            host: get("Proxy.SendHost"),
            port: get("Proxy.SendPort"),
            username: get("Proxy.SendUsername"),
            password: unprotect_password(&get("Proxy.SendPassword")),
        }
    } else {
        receive.clone()
    };
    ProxySettingsPayload {
        enabled: map.get("Proxy.ProxyEnabled").map(|v| v == "true").unwrap_or(false),
        proxy_type: map.get("Proxy.ProxyType").cloned().unwrap_or_else(|| "http".into()),
        no_cache: map.get("Proxy.NoCache").map(|v| v == "true").unwrap_or(false),
        http_mode: map.get("Proxy.HttpMode").map(|v| v == "true").unwrap_or(false),
        receive,
        send,
    }
}

/// 起動時: 保存してあるプロキシの設定を通信に反映する
fn init_proxy_settings() {
    let map = core_store::load_settings_ini().unwrap_or_default();
    let payload = proxy_payload_from_ini(&map);
    if payload.enabled {
        let _ = core_store::append_log(&format!(
            "proxy: enabled type={} receive={} send={} http_mode={}",
            payload.proxy_type,
            !payload.receive.host.trim().is_empty(),
            !payload.send.host.trim().is_empty(),
            payload.http_mode
        ));
    }
    update_proxy_settings(payload.to_settings());
}

#[tauri::command]
fn load_proxy_settings() -> Result<ProxySettingsPayload, String> {
    let map = core_store::load_settings_ini().unwrap_or_default();
    Ok(proxy_payload_from_ini(&map))
}

/// 保存して、次の通信から使う (パスワードは DPAPI で暗号化して保存。ログには出さない)
#[tauri::command]
fn save_proxy_settings(settings: ProxySettingsPayload) -> Result<(), String> {
    let mut updates = HashMap::new();
    updates.insert("Proxy.ProxyEnabled".to_string(), settings.enabled.to_string());
    updates.insert("Proxy.ProxyType".to_string(), ProxyType::from_name(&settings.proxy_type).as_scheme().to_string());
    updates.insert("Proxy.NoCache".to_string(), settings.no_cache.to_string());
    updates.insert("Proxy.HttpMode".to_string(), settings.http_mode.to_string());
    updates.insert("Proxy.ProxyHost".to_string(), settings.receive.host.trim().to_string());
    updates.insert("Proxy.ProxyPort".to_string(), settings.receive.port.trim().to_string());
    updates.insert("Proxy.ProxyUsername".to_string(), settings.receive.username.clone());
    updates.insert("Proxy.ProxyPassword".to_string(), protect_password(&settings.receive.password));
    updates.insert("Proxy.SendHost".to_string(), settings.send.host.trim().to_string());
    updates.insert("Proxy.SendPort".to_string(), settings.send.port.trim().to_string());
    updates.insert("Proxy.SendUsername".to_string(), settings.send.username.clone());
    updates.insert("Proxy.SendPassword".to_string(), protect_password(&settings.send.password));
    core_store::save_settings_ini(&updates).map_err(|e| e.to_string())?;
    update_proxy_settings(settings.to_settings());
    let _ = core_store::append_log(&format!("proxy: saved enabled={} type={} http_mode={}", settings.enabled, settings.proxy_type, settings.http_mode));
    Ok(())
}

// ===== ImageViewURLReplace Commands =====

const DEFAULT_IMAGE_URL_RULES: &str = "\
# Twitter/X 画像URL正規化
^https?://pbs\\.twimg\\.com/media/([^?]+)\\?format=(\\w+)&name=.*\thttps://pbs.twimg.com/media/$1?format=$2&name=orig
^https?://pbs\\.twimg\\.com/media/([^?:]+)(?::(\\w+))?$\thttps://pbs.twimg.com/media/$1?format=jpg&name=orig

# ニコニコ動画サムネイル
^https?://(?:www\\.)?nicovideo\\.jp/watch/sm(\\d+)\thttps://nicovideo.cdn.nimg.jp/thumbnails/$1/$1
";

#[tauri::command]
fn load_image_url_replace() -> Result<Vec<UrlReplaceRule>, String> {
    let path = core_store::portable_data_dir()
        .map_err(|e| e.to_string())?
        .join("ImageViewURLReplace.txt");
    let content = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        std::fs::write(&path, DEFAULT_IMAGE_URL_RULES).map_err(|e| e.to_string())?;
        DEFAULT_IMAGE_URL_RULES.to_string()
    };
    Ok(parse_url_replace_rules(&content))
}

#[tauri::command]
fn reset_image_url_replace() -> Result<Vec<UrlReplaceRule>, String> {
    let path = core_store::portable_data_dir()
        .map_err(|e| e.to_string())?
        .join("ImageViewURLReplace.txt");
    std::fs::write(&path, DEFAULT_IMAGE_URL_RULES).map_err(|e| e.to_string())?;
    Ok(parse_url_replace_rules(DEFAULT_IMAGE_URL_RULES))
}

// ===== TTS Commands =====

// SAPI コマンドは `(async)` を付けて Tauri のブロッキング用スレッドプールで実行する。
// 付けないとメインスレッド (画面の描画・入力を処理しているスレッド) 上でそのまま実行されてしまい、
// 読み上げ中は画面が固まって一切の操作を受け付けなくなる (声の取得・読み上げ・停止のいずれも同様)。
// 実際の COM 呼び出しは core_tts 側の専用常駐スレッドに一本化されているため、ここでは
// 追加のスレッド生成は不要 (core_tts::sapi_speak/sapi_stop の中で完結する)。
#[tauri::command(async)]
fn sapi_list_voices() -> Result<Vec<core_tts::VoiceInfo>, String> {
    core_tts::sapi_list_voices().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sapi_speak_text(text: String, voice_index: u32, rate: i32, volume: u32) -> Result<(), String> {
    core_tts::sapi_speak(&text, voice_index, rate, volume).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sapi_stop_speech() -> Result<(), String> {
    core_tts::sapi_stop().map_err(|e| e.to_string())
}

#[tauri::command]
fn bouyomi_speak_text(
    remote_talk_path: String,
    text: String,
    speed: i32,
    tone: i32,
    volume: i32,
    voice: i32,
) -> Result<(), String> {
    core_tts::bouyomi_speak(&remote_talk_path, &text, speed, tone, volume, voice)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn voicevox_get_speakers(endpoint: String) -> Result<Vec<core_tts::VoicevoxSpeaker>, String> {
    core_tts::voicevox_get_speakers(&endpoint)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn voicevox_speak_text(
    endpoint: String,
    text: String,
    speaker_id: i32,
    speed_scale: f64,
    pitch_scale: f64,
    intonation_scale: f64,
    volume_scale: f64,
) -> Result<(), String> {
    let wav = core_tts::voicevox_speak(
        &endpoint,
        &text,
        speaker_id,
        speed_scale,
        pitch_scale,
        intonation_scale,
        volume_scale,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Play via Win32 PlaySoundW (async, temp file)
    core_tts::play_wav_from_bytes(&wav).map_err(|e| e.to_string())
}

#[tauri::command]
async fn tts_stop() -> Result<(), String> {
    // Stop current speech and clear queue
    let mut queue = core_tts::tts_queue().lock().await;
    queue.clear();
    // Also stop SAPI if it's running (フラグを立てるだけで即座に返るため、スレッド分離は不要)
    let _ = core_tts::sapi_stop();
    Ok(())
}

// ===== Image Popup Commands =====

/// Reject non-http(s) URLs and URLs pointing at loopback / private / link-local
/// hosts, to keep attacker-supplied image URLs from being used for SSRF against
/// localhost or the LAN. This checks the literal host; a public hostname that
/// resolves to a private IP is stopped by `PublicOnlyResolver` when connecting.
fn validate_public_http_url(raw: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(raw).map_err(|e| format!("invalid url: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("blocked url scheme: {}", parsed.scheme()));
    }
    let host = parsed.host_str().ok_or_else(|| "missing host".to_string())?;
    let host_l = host.to_ascii_lowercase();
    let host_trim = host_l.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host_trim.parse::<std::net::IpAddr>() {
        let v4_blocked = |v4: std::net::Ipv4Addr| {
            let o = v4.octets();
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast()
                || o[0] == 0 // 0.0.0.0/8
                || (o[0] == 100 && (o[1] & 0xC0) == 64) // 100.64.0.0/10 (CGNAT・VPN)
        };
        let blocked = match ip {
            std::net::IpAddr::V4(v4) => v4_blocked(v4),
            std::net::IpAddr::V6(v6) => {
                let seg0 = v6.segments()[0];
                v6.is_loopback() || v6.is_unspecified()
                    || (seg0 & 0xFE00) == 0xFC00 // fc00::/7 (家庭内)
                    || (seg0 & 0xFFC0) == 0xFE80 // fe80::/10 (リンクローカル)
                    || v6.to_ipv4_mapped().map(v4_blocked).unwrap_or(false)
            }
        };
        if blocked {
            return Err("blocked private/loopback address".to_string());
        }
    } else if host_l == "localhost"
        || host_l.ends_with(".local")
        || host_l.ends_with(".localhost")
    {
        return Err("blocked local hostname".to_string());
    }
    Ok(())
}

/// 画像の取得の上限 (これより大きいものは読み込まない)
const IMAGE_MAX_BYTES: usize = 30 * 1024 * 1024;

/// 画像を取りに行く通信 (転送先も1回ずつ確かめる。家庭内・自分の PC のアドレスへの転送は止める)
fn image_http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .dns_resolver(std::sync::Arc::new(PublicOnlyResolver))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                attempt.error("too many redirects")
            } else if validate_public_http_url(attempt.url().as_str()).is_err() {
                attempt.error("blocked redirect to a private/loopback address")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

/// 画像の取得の名前解決。引いたアドレスが1つでも家庭内・自分の PC のアドレスなら接続しない。
/// 確かめたアドレスにそのままつなぐので、確かめたあとで名前の向き先を変えられても (DNS リバインディング) 家庭内へはつながらない。
/// 転送先も接続のたびにここを通る (IP アドレスで直接書かれたものは validate_public_http_url と転送の確認で止める)
struct PublicOnlyResolver;

impl reqwest::dns::Resolve for PublicOnlyResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs = public_addrs_of(&host).await?;
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// 名前を引いて、すべて公開のアドレスならその一覧を返す
async fn public_addrs_of(host: &str) -> Result<Vec<std::net::SocketAddr>, Box<dyn std::error::Error + Send + Sync>> {
    // ポートは reqwest が URL のものに置き換える
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host, 0)).await?.collect();
    if addrs.is_empty() {
        return Err(format!("{host} のアドレスが見つかりません").into());
    }
    if addrs.iter().any(|a| !core_fetch::is_public_ip(a.ip())) {
        return Err(format!("{host} は家庭内・自分の PC のアドレスを指しているため読み込みません").into());
    }
    Ok(addrs)
}

/// 中身の先頭から画像の種類を調べる (サーバーが「画像」と名乗らないこともあるので、名乗りより中身を見る)
fn sniff_image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis") {
        Some("image/avif")
    } else if bytes.starts_with(&[0, 0, 1, 0]) || bytes.starts_with(&[0, 0, 2, 0]) {
        Some("image/x-icon")
    } else if is_svg(bytes) {
        Some("image/svg+xml")
    } else {
        None
    }
}

/// SVG か (先頭の空白・BOM・XML 宣言・コメントのあとに <svg があるか)。画像として表示するだけなので、中のスクリプトは動かない
fn is_svg(bytes: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
    let t = head.trim_start_matches('\u{feff}').trim_start();
    (t.starts_with("<svg") || t.starts_with("<?xml") || t.starts_with("<!--") || t.starts_with("<!doctype svg")) && head.contains("<svg")
}

/// 中身で判断できないときの、サーバーの名乗り (Content-Type) が画像か。画像なら種類 (文字は英数字と + - . だけ)
fn declared_image_type(content_type: Option<&str>) -> Option<String> {
    let ct = content_type?.split(';').next()?.trim().to_ascii_lowercase();
    let sub = ct.strip_prefix("image/")?;
    (!sub.is_empty() && sub.len() <= 40 && sub.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.')))
        .then(|| format!("image/{sub}"))
}

/// 画像を上限つきで読み込む: (中身, 種類)。画像でなければエラー
async fn read_image_response(resp: reqwest::Response) -> Result<(Vec<u8>, String), String> {
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let declared = declared_image_type(resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()));
    if resp.content_length().is_some_and(|n| n as usize > IMAGE_MAX_BYTES) {
        return Err("画像が大きすぎます (30MB まで)".to_string());
    }
    let mut resp = resp;
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if out.len() + chunk.len() > IMAGE_MAX_BYTES {
            return Err("画像が大きすぎます (30MB まで)".to_string());
        }
        out.extend_from_slice(&chunk);
    }
    // 中身で判断し、判断できなければ名乗りで判断する (HTML などの画像でないものは止める)
    let kind = sniff_image_type(&out).map(str::to_string).or(declared).ok_or_else(|| "画像ではありませんでした".to_string())?;
    Ok((out, kind))
}

/// Fetch an image URL and return a base64 data URL.
#[tauri::command]
async fn fetch_image(url: String) -> Result<String, String> {
    validate_public_http_url(&url)?;
    let client = image_http_client(15)?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let (bytes, ct) = read_image_response(resp).await?;
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    Ok(format!("data:{};base64,{}", ct, b64))
}

/// Store the data URL and open a popup window.
/// `width` / `height` are the image's natural pixel dimensions (used for window sizing).
#[tauri::command]
async fn open_image_popup(
    app: AppHandle,
    url: String,
) -> Result<(), String> {
    // Download image as data URL
    let data_url = fetch_image(url.clone()).await?;

    // Derive label from URL filename
    let label = url.rsplit('/').next()
        .and_then(|s| s.split('?').next())
        .unwrap_or("image")
        .to_string();
    let label = if label.chars().count() > 30 {
        format!("{}…", label.chars().take(27).collect::<String>())
    } else {
        label
    };

    let entry = PopupImageEntry {
        id: format!("{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()),
        data_url,
        source_url: url,
        label,
    };

    // Add to state
    {
        let state = app.state::<ImagePopupState>();
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.push(entry.clone());
    }

    // If popup already exists and is visible, emit event to add tab and focus
    if let Some(win) = app.get_webview_window("image_popup") {
        if win.is_visible().unwrap_or(false) {
            let _ = app.emit_to("image_popup", "image-popup-add-tab", &entry);
            let _ = win.set_focus();
            return Ok(());
        }
        // Window exists but not visible (closing) — destroy and recreate
        let _ = win.destroy();
    }

    // Create new popup window
    portable_webview(WebviewWindowBuilder::new(
        &app,
        "image_popup",
        tauri::WebviewUrl::App("image_popup.html".into()),
    ))
    .title(window_title(&app, "LiveFake - 画像"))
    .inner_size(900.0, 700.0)
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Get all image entries for the popup (used on initial load).
#[tauri::command]
fn get_image_popup_data(app: AppHandle) -> Result<Vec<PopupImageEntry>, String> {
    let state = app.state::<ImagePopupState>();
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    Ok(guard.clone())
}

/// Remove a single image tab from the popup state.
#[tauri::command]
fn remove_popup_image(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<ImagePopupState>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    guard.retain(|e| e.id != id);
    Ok(())
}

/// Clear all popup image state (called when popup window closes).
#[tauri::command]
fn clear_popup_images(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ImagePopupState>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    guard.clear();
    Ok(())
}

/// ウィンドウの題名。開発の確認用のビルド (識別子が .test で終わる。tauri.test.conf.json) では「(テスト用)」を付け、
/// ふだん使っている LiveFake と見分けられるようにする
fn window_title(app: &AppHandle, base: &str) -> String {
    if app.config().identifier.ends_with(".test") { format!("{base} (テスト用)") } else { base.to_string() }
}

/// コマンドに登録するプログラムを選ぶ (.exe だけ)。選んだものは、この起動中は登録してよいものとして覚える
#[tauri::command]
fn pick_command_program() -> Result<Option<String>, String> {
    let picked = open_file_dialog("プログラム (*.exe)".to_string(), "*.exe".to_string())?;
    if let Some(path) = &picked {
        if !std::path::Path::new(path).extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) {
            return Err("選べるのは .exe だけです".to_string());
        }
        user_commands::remember_picked_program(path);
    }
    Ok(picked)
}

/// 設定の「画像の保存先」(画像ウィンドウ用。設定ファイル全体は渡さない)。未設定なら空
#[tauri::command]
fn image_save_folder() -> String {
    core_store::load_settings_ini()
        .ok()
        .and_then(|m| m.get("App.imageSaveFolder").cloned())
        .unwrap_or_default()
}

// ===== Compose Popup Window Commands =====
// スレッドタイトルバーの「書き込み」ボタンから開く、別ウィンドウの書き込み・スレ立てフォーム。
// 実際の投稿処理 (NGチェック・Cookie・自分の投稿判定など) はメインウィンドウ側の既存ロジックを
// そのまま使う。ポップアップは入力フォームを持つだけで、送信内容をイベントでメインへ渡し、
// メインが投稿を実行して結果 (成功なら閉じる、失敗ならメッセージ) をポップアップへ返す。

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct ComposePopupUpdate {
    thread_title: Option<String>,
    thread_url: Option<String>,
    default_name: Option<String>,
    default_mail: Option<String>,
    /// 指定時は本文欄に追記する (引用 `>>N` など)。置き換えではなく追記
    append_quote: Option<String>,
    /// メイン画面の現在のライト/ダーク設定。基本配色をそれに合わせて切り替える
    /// (カスタムCSSはこの上にさらに重ねて適用される)
    dark_mode: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComposePopupSubmitData {
    mode: String,
    name: String,
    mail: String,
    body: String,
    subject: Option<String>,
}

#[tauri::command]
async fn compose_popup_show(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("compose_popup") {
        let _ = win.set_focus();
        return Ok(());
    }
    let saved_size = *COMPOSE_POPUP_SAVED_SIZE.lock().unwrap_or_else(|e| e.into_inner());
    let (init_w, init_h) = saved_size.unwrap_or_else(|| {
        // 保存済みサイズが無い初回は、画面サイズの一定割合を初期値にする (4K 等の高解像度
        // モニタでも常に420x420固定という見合わない大きさで開かないようにするため)。
        if let Ok(Some(monitor)) = app.primary_monitor() {
            let scale = monitor.scale_factor();
            let logical_w = monitor.size().width as f64 / scale;
            let logical_h = monitor.size().height as f64 / scale;
            let w = (logical_w * 0.28).clamp(420.0, 900.0);
            let h = (logical_h * 0.5).clamp(420.0, 900.0);
            (w, h)
        } else {
            (420.0, 420.0)
        }
    });
    let win = portable_webview(WebviewWindowBuilder::new(
        &app,
        "compose_popup",
        tauri::WebviewUrl::App("compose_popup.html".into()),
    ))
    .title(window_title(&app, "LiveFake - 書き込み"))
    .inner_size(init_w, init_h)
    .min_inner_size(320.0, 320.0)
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let ms = monitor.size();
        let ws = win
            .outer_size()
            .unwrap_or(tauri::PhysicalSize::new(init_w as u32, init_h as u32));
        let x = (ms.width as i32 - ws.width as i32) / 2;
        let y = (ms.height as i32 - ws.height as i32) / 2;
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
    // ポップアップが閉じられたら (成功時の自動クローズ・ユーザーによる手動クローズのいずれも)
    // メインへ通知し、「引用の転送先」の判定に使う
    let handle = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            let _ = handle.emit_to("main", "compose-popup-closed", ());
        }
    });
    Ok(())
}

/// 書き込みの浮遊ウィンドウがリサイズされるたびにフロント側から呼ばれ、大きさを記憶する。
/// 次に開いたときにこのサイズで復元する
#[tauri::command]
fn compose_popup_save_size(width: f64, height: f64) -> Result<(), String> {
    if width >= 200.0 && height >= 200.0 && width <= 10000.0 && height <= 10000.0 {
        let mut guard = COMPOSE_POPUP_SAVED_SIZE.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some((width, height));
    }
    Ok(())
}

#[tauri::command]
fn compose_popup_update(app: AppHandle, data: ComposePopupUpdate) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("compose_popup") {
        let js = format!(
            "if(window.__composeUpdate)window.__composeUpdate({})",
            serde_json::to_string(&data).unwrap_or_else(|_| "{}".to_string())
        );
        let _ = win.eval(&js);
    }
    Ok(())
}

/// ポップアップ側からの送信要求をメインウィンドウへ中継する。実際の投稿処理はメイン側で行う
/// (NGフィルタ・Cookie・自分の投稿判定など既存の投稿フローをそのまま使うため)。
#[tauri::command]
fn compose_popup_submit(app: AppHandle, data: ComposePopupSubmitData) -> Result<(), String> {
    if data.mode != "reply" && data.mode != "new_thread" {
        return Err("unknown mode".to_string());
    }
    let _ = app.emit_to(
        "main",
        "compose-popup-submit",
        serde_json::json!({
            "mode": data.mode,
            "name": data.name,
            "mail": data.mail,
            "body": data.body,
            "subject": data.subject,
        }),
    );
    Ok(())
}

/// メインウィンドウでの投稿結果をポップアップへ返す。失敗時はポップアップを開いたままメッセージを表示する
/// (成功時はメイン側が compose_popup_hide で閉じるので、こちらは失敗時にのみ使われる想定)。
#[tauri::command]
fn compose_popup_result(app: AppHandle, ok: bool, message: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("compose_popup") {
        let js = format!(
            "if(window.__composeResult)window.__composeResult({}, {})",
            ok,
            serde_json::to_string(&message).unwrap_or_else(|_| "\"\"".to_string())
        );
        let _ = win.eval(&js);
    }
    Ok(())
}

#[tauri::command]
fn compose_popup_hide(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("compose_popup") {
        let _ = win.close();
    }
    Ok(())
}

// ===== Subtitle Window Commands =====

#[tauri::command]
async fn subtitle_show(app: AppHandle) -> Result<(), String> {
    let _ = core_store::append_log("subtitle_show: called");
    // Close existing window first to avoid duplicate
    if let Some(win) = app.get_webview_window("subtitle") {
        let _ = core_store::append_log("subtitle_show: closing existing window");
        let _ = win.close();
        let _ = core_store::append_log("subtitle_show: close() returned");
    }
    let _ = core_store::append_log("subtitle_show: before lock");
    let saved = SUBTITLE_SAVED_POS.lock().unwrap_or_else(|e| e.into_inner()).take();
    let (sw, sh) = SUBTITLE_SAVED_SIZE.lock().unwrap_or_else(|e| e.into_inner()).unwrap_or((800.0, 200.0));
    let _ = core_store::append_log("subtitle_show: before build");
    let win = portable_webview(WebviewWindowBuilder::new(&app, "subtitle", tauri::WebviewUrl::App("subtitle.html".into())))
        .title(window_title(&app, "LiveFake - 字幕"))
        .inner_size(sw, sh)
        .decorations(false)
        .transparent(true)
        .background_color(Color(0, 0, 0, 0))
        .resizable(true)
        .build()
        .map_err(|e| {
            let _ = core_store::append_log(&format!("subtitle_show: build FAILED: {e}"));
            e.to_string()
        })?;
    let _ = core_store::append_log("subtitle_show: window built ok");
    // リサイズのたびにサイズを覚える (オフにしたとき・終了時に保存する)
    {
        let w2 = win.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::Resized(_) = event {
                capture_subtitle_size(&w2);
                // 設定画面の幅・高さの表示を合わせる
                if let Some((w, h)) = *SUBTITLE_SAVED_SIZE.lock().unwrap_or_else(|e| e.into_inner()) {
                    let _ = w2.app_handle().emit_to("main", "subtitle-size", serde_json::json!({ "width": w.round(), "height": h.round() }));
                }
            }
        });
    }
    // Restore previous position or center on primary monitor
    if let Some((x, y)) = saved {
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    } else if let Ok(Some(monitor)) = app.primary_monitor() {
        let ms = monitor.size();
        let ws = win.outer_size().unwrap_or(tauri::PhysicalSize::new(800, 200));
        let x = (ms.width as i32 - ws.width as i32) / 2;
        let y = (ms.height as i32 - ws.height as i32) / 2;
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
    Ok(())
}

#[tauri::command]
async fn subtitle_hide(app: AppHandle) -> Result<(), String> {
    let _ = core_store::append_log("subtitle_hide: called");
    if let Some(win) = app.get_webview_window("subtitle") {
        let _ = core_store::append_log("subtitle_hide: window found");
        if let Ok(pos) = win.outer_position() {
            let mut guard = SUBTITLE_SAVED_POS.lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some((pos.x, pos.y));
        }
        capture_subtitle_size(&win);
        persist_subtitle_size();
        // Run on main thread — window close must dispatch from UI thread
        app.run_on_main_thread(move || {
            let r = win.close();
            let _ = core_store::append_log(&format!("subtitle_hide: close() ok={}", r.is_ok()));
            if r.is_err() {
                // Fallback: destroy
                let r2 = win.destroy();
                let _ = core_store::append_log(&format!("subtitle_hide: destroy() ok={}", r2.is_ok()));
            }
        }).map_err(|e| e.to_string())?;
    } else {
        let _ = core_store::append_log("subtitle_hide: window NOT found");
    }
    Ok(())
}

#[tauri::command]
async fn subtitle_reset_position(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("subtitle") {
        if let Ok(Some(monitor)) = app.primary_monitor() {
            let ms = monitor.size();
            let ws = win.outer_size().unwrap_or(tauri::PhysicalSize::new(800, 200));
            let x = (ms.width as i32 - ws.width as i32) / 2;
            let y = (ms.height as i32 - ws.height as i32) / 2;
            win.set_position(tauri::PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn subtitle_update(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("subtitle") {
        let js = format!(
            "if(window.__subtitleEntry)window.__subtitleEntry({})",
            serde_json::to_string(&data).unwrap_or_default()
        );
        let _ = win.eval(&js);
    }
    Ok(())
}

#[tauri::command]
fn subtitle_opacity(app: AppHandle, opacity: f64) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("subtitle") {
        let _ = win.eval(format!(
            "if(window.__setOpacity)window.__setOpacity({})",
            opacity
        ));
    }
    Ok(())
}

#[tauri::command]
fn subtitle_topmost(app: AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("subtitle") {
        win.set_always_on_top(enabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// メインウィンドウを常に最背面(他の全ウィンドウの下)に表示する。「常に最前面」の逆。
/// 書き込みの浮遊ウィンドウ・OBS連携ウィンドウ・字幕ウィンドウには適用しない(メインウィンドウのみ)。
#[tauri::command]
fn main_set_always_on_bottom(app: AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.set_always_on_bottom(enabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 字幕ウィンドウからの表示時間の報告をメインウィンドウへイベントで中継する。
/// `bottom_in_ms` = 最下行に達するまでの時間、`hold_ms` = 達した後の表示時間、`total_ms` = その合計 (旧形式互換)。
/// メイン側は「新着レスペインと字幕の次レス表示を同期する」設定の判断に使う。
/// 値は上限 10 分でクランプする (不具合で巨大な値が来ても新着キューが止まらないように)。
#[tauri::command]
fn subtitle_timing_report(
    app: AppHandle,
    seq: u64,
    total_ms: u64,
    bottom_in_ms: Option<u64>,
    hold_ms: Option<u64>,
) -> Result<(), String> {
    let total_ms = total_ms.min(600_000);
    let bottom_in_ms = bottom_in_ms.unwrap_or(total_ms).min(600_000);
    let hold_ms = hold_ms.unwrap_or(0).min(600_000);
    let _ = app.emit_to(
        "main",
        "subtitle-timing",
        serde_json::json!({ "seq": seq, "totalMs": total_ms, "bottomInMs": bottom_in_ms, "holdMs": hold_ms }),
    );
    Ok(())
}

/// 字幕ウィンドウからの操作 (手動スクロールによる一時停止 / ▶ 次のレス) をメインウィンドウへ中継する。
#[tauri::command]
fn subtitle_control(app: AppHandle, action: String) -> Result<(), String> {
    match action.as_str() {
        "pause" | "next" => {}
        // 字幕の右クリックのメニュー: 本体を前に出して 設定 > 字幕 > 枠・大きさ を開く
        "open-settings" => {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.unminimize();
                let _ = main.show();
                let _ = main.set_focus();
            }
        }
        "reset-position" => {
            if let Some(win) = app.get_webview_window("subtitle") {
                if let Ok(Some(monitor)) = app.primary_monitor() {
                    let ms = monitor.size();
                    let ws = win.outer_size().unwrap_or(tauri::PhysicalSize::new(800, 200));
                    let _ = win.set_position(tauri::PhysicalPosition::new((ms.width as i32 - ws.width as i32) / 2, (ms.height as i32 - ws.height as i32) / 2));
                }
            }
            return Ok(());
        }
        _ => return Err("unknown action".to_string()),
    }
    let _ = app.emit_to("main", "subtitle-control", serde_json::json!({ "action": action }));
    Ok(())
}

/// 字幕の枠: "normal" (Windows の線と影あり) / "corners" (線と影を消し、四隅に印) / "none" (文字とボタンだけ)
#[tauri::command]
fn subtitle_frame(app: AppHandle, mode: String) -> Result<(), String> {
    if !matches!(mode.as_str(), "normal" | "corners" | "none") {
        return Err("unknown frame mode".to_string());
    }
    if let Some(win) = app.get_webview_window("subtitle") {
        let _ = win.set_shadow(mode == "normal");
        let _ = win.eval(format!("if(window.__setFrameMode)window.__setFrameMode(\"{mode}\")"));
    }
    Ok(())
}

/// 字幕ウィンドウの大きさを変える (論理ピクセル)
#[tauri::command]
fn subtitle_set_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if !subtitle_size_ok(width, height) {
        return Err("大きさは 幅 120〜10000・高さ 40〜10000 で指定してください".to_string());
    }
    if let Some(win) = app.get_webview_window("subtitle") {
        win.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    }
    *SUBTITLE_SAVED_SIZE.lock().unwrap_or_else(|e| e.into_inner()) = Some((width, height));
    Ok(())
}

/// 覚えている字幕ウィンドウの大きさ (論理ピクセル。まだ無ければ既定の 800×200)
#[tauri::command]
fn subtitle_get_size() -> (f64, f64) {
    SUBTITLE_SAVED_SIZE.lock().unwrap_or_else(|e| e.into_inner()).unwrap_or((800.0, 200.0))
}

// ===== 設定のプリセット / 自動バックアップ =====
// data/presets/<名前>.json と data/settings-backup/<日時>.json。中身はフロント側が組み立てた JSON オブジェクト。
// 名前はファイル名としてのみ使い、パス区切りや親ディレクトリ参照を含むものは拒否する。

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFileInfo {
    name: String,
    saved_at: i64,
}

const SETTINGS_PRESET_DIR: &str = "presets";
const SETTINGS_BACKUP_DIR: &str = "settings-backup";
const SETTINGS_BACKUP_KEEP: usize = 20;
const SETTINGS_FILE_MAX_BYTES: usize = 4 * 1024 * 1024;

fn validate_settings_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let len = name.chars().count();
    if len == 0 || len > 64 {
        return Err("名前は 1〜64 文字で指定してください".to_string());
    }
    if name.starts_with('.') || name.ends_with('.') || name.ends_with(' ') {
        return Err("名前の先頭・末尾に . や空白は使えません".to_string());
    }
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err("名前に使えない文字 (/ \\ : * ? \" < > |) が含まれています".to_string());
    }
    // Windows の予約デバイス名 (CON, PRN, AUX, NUL, COM1-9, LPT1-9) はファイルにできない
    let upper = name.to_ascii_uppercase();
    let base = upper.split('.').next().unwrap_or("");
    let reserved = matches!(base, "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && base[3..].chars().all(|c| c.is_ascii_digit()));
    if reserved {
        return Err("その名前は使えません".to_string());
    }
    Ok(name.to_string())
}

fn settings_files_dir(sub: &str) -> Result<std::path::PathBuf, String> {
    core_store::portable_data_dir()
        .map(|d| d.join(sub))
        .map_err(|e| e.to_string())
}

fn list_settings_files(sub: &str) -> Result<Vec<SettingsFileInfo>, String> {
    let dir = settings_files_dir(sub)?;
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(out),
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if validate_settings_name(stem).is_err() {
            continue;
        }
        let saved_at = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        out.push(SettingsFileInfo { name: stem.to_string(), saved_at });
    }
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at).then_with(|| b.name.cmp(&a.name)));
    Ok(out)
}

fn read_settings_file(sub: &str, name: &str) -> Result<String, String> {
    let name = validate_settings_name(name)?;
    let path = settings_files_dir(sub)?.join(format!("{name}.json"));
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > SETTINGS_FILE_MAX_BYTES {
        return Err("ファイルが大きすぎます".to_string());
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

fn write_settings_file(sub: &str, name: &str, json: &str) -> Result<(), String> {
    let name = validate_settings_name(name)?;
    if json.len() > SETTINGS_FILE_MAX_BYTES {
        return Err("設定データが大きすぎます".to_string());
    }
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if !value.is_object() {
        return Err("設定データの形式が不正です".to_string());
    }
    core_store::save_json(&format!("{sub}/{name}.json"), &value).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_settings_presets() -> Result<Vec<SettingsFileInfo>, String> {
    list_settings_files(SETTINGS_PRESET_DIR)
}

#[tauri::command]
fn save_settings_preset(name: String, json: String) -> Result<(), String> {
    write_settings_file(SETTINGS_PRESET_DIR, &name, &json)
}

#[tauri::command]
fn load_settings_preset(name: String) -> Result<String, String> {
    read_settings_file(SETTINGS_PRESET_DIR, &name)
}

#[tauri::command]
fn delete_settings_preset(name: String) -> Result<(), String> {
    let name = validate_settings_name(&name)?;
    let path = settings_files_dir(SETTINGS_PRESET_DIR)?.join(format!("{name}.json"));
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_settings_backups() -> Result<Vec<SettingsFileInfo>, String> {
    list_settings_files(SETTINGS_BACKUP_DIR)
}

/// 自動バックアップを保存し、古いものを削除して最新 20 件だけ残す。名前 (日時) はフロント側で作る。
#[tauri::command]
fn save_settings_backup(name: String, json: String) -> Result<(), String> {
    write_settings_file(SETTINGS_BACKUP_DIR, &name, &json)?;
    let mut files = list_settings_files(SETTINGS_BACKUP_DIR)?;
    // 日時名は辞書順 = 時系列なので名前で新しい順に並べ替える
    files.sort_by(|a, b| b.name.cmp(&a.name));
    let dir = settings_files_dir(SETTINGS_BACKUP_DIR)?;
    for old in files.iter().skip(SETTINGS_BACKUP_KEEP) {
        let _ = std::fs::remove_file(dir.join(format!("{}.json", old.name)));
    }
    Ok(())
}

#[tauri::command]
fn load_settings_backup(name: String) -> Result<String, String> {
    read_settings_file(SETTINGS_BACKUP_DIR, &name)
}

/// 字幕ウィンドウのヘッダに一時停止状態と残りキュー数を表示させる。
#[tauri::command]
fn subtitle_status(app: AppHandle, paused: bool, remaining: u32) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("subtitle") {
        let _ = win.eval(format!(
            "if(window.__setStatus)window.__setStatus({})",
            serde_json::json!({ "paused": paused, "remaining": remaining })
        ));
    }
    Ok(())
}

#[tauri::command]
fn subtitle_font_size(app: AppHandle, size: u32) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("subtitle") {
        let _ = win.eval(format!(
            "if(window.__setFontSize)window.__setFontSize({})",
            size
        ));
    }
    Ok(())
}

/// 字幕の文字の影 (ドロップシャドウ) のオンオフ
#[tauri::command]
fn subtitle_text_shadow(app: AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("subtitle") {
        let _ = win.eval(format!("if(window.__setTextShadow)window.__setTextShadow({enabled})"));
    }
    Ok(())
}

#[tauri::command]
fn subtitle_meta_font_size(app: AppHandle, size: u32) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("subtitle") {
        let _ = win.eval(format!(
            "if(window.__setMetaFontSize)window.__setMetaFontSize({})",
            size
        ));
    }
    Ok(())
}

#[tauri::command]
fn subtitle_id_font_size(app: AppHandle, size: i32) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("subtitle") {
        let _ = win.eval(format!(
            "if(window.__setIdFontSize)window.__setIdFontSize({})",
            size
        ));
    }
    Ok(())
}

#[tauri::command]
fn subtitle_id_font_family(app: AppHandle, family: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("subtitle") {
        let escaped = serde_json::to_string(&family).unwrap_or_else(|_| "\"\"".to_string());
        let _ = win.eval(format!(
            "if(window.__setIdFontFamily)window.__setIdFontFamily({})",
            escaped
        ));
    }
    Ok(())
}

/// WebView2 のユーザーデータ (HTTP キャッシュ・Cookie・GPU キャッシュ等) の保存先 (data\webview)。
/// 指定しないと Tauri が %LOCALAPPDATA%\<identifier> に作るため、全ウィンドウの作成時に必ずこれを通す。
/// (同じフォルダを使う WebView は起動オプションも揃える必要がある。オプションは run() で環境変数に一括設定している)
fn portable_webview<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    match core_store::portable_data_dir() {
        Ok(dir) => builder.data_directory(dir.join("webview")),
        Err(e) => {
            let _ = core_store::append_log(&format!("webview data dir unresolved: {e}"));
            builder
        }
    }
}

/// ブラウザ (WebView2) のディスクキャッシュ上限 (MB)。settings.ini の App.webviewCacheMb。
const WEBVIEW_CACHE_MB_DEFAULT: u64 = 100;
const WEBVIEW_CACHE_MB_MIN: u64 = 10;
const WEBVIEW_CACHE_MB_MAX: u64 = 1000;

fn webview_cache_mb(settings: Option<&std::collections::HashMap<String, String>>) -> u64 {
    settings
        .and_then(|m| m.get("App.webviewCacheMb"))
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(|v| v.clamp(WEBVIEW_CACHE_MB_MIN, WEBVIEW_CACHE_MB_MAX))
        .unwrap_or(WEBVIEW_CACHE_MB_DEFAULT)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Disable WebKit2GTK's DMA-BUF renderer and GPU compositing on Wayland
    // to prevent white screen / EGL errors on some GPU/driver combinations
    // See: https://github.com/tauri-apps/tauri/issues/11988
    //      https://github.com/tauri-apps/tauri/issues/10749
    #[cfg(target_os = "linux")]
    {
        let is_wayland = std::env::var("WAYLAND_DISPLAY").is_ok()
            || std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false);
        if is_wayland {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }

    let _ = core_store::init_portable_layout();
    let _ = core_store::append_log("app started");

    // WebView2 の起動オプション。WebView2 Controller の作成前 (= Tauri Builder より前) に設定する必要がある。
    // 環境変数で渡すと全ウィンドウに同じ値が効く (同じデータフォルダを使う WebView はオプションを揃える必要がある)。
    // 環境変数は API で渡す値より優先されるため、wry の既定値 (msWebOOUI 等の無効化) も含めて組み立てる。
    #[cfg(target_os = "windows")]
    {
        let settings = core_store::load_settings_ini().ok();
        let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if !existing.trim().is_empty() {
            args.push(' ');
            args.push_str(existing.trim());
        }
        // settings.ini App.smoothScroll=false なら Chromium のスムーススクロールを無効化
        if settings.as_ref().and_then(|m| m.get("App.smoothScroll")).map(|v| v == "false").unwrap_or(false) {
            args.push_str(" --disable-smooth-scrolling");
        }
        // ディスクキャッシュの上限 (data\webview が際限なく大きくならないように)
        args.push_str(&format!(" --disk-cache-size={}", webview_cache_mb(settings.as_ref()) * 1024 * 1024));
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
        // ユーザーデータフォルダも環境変数で data\webview に揃える (portable_webview と同じ場所)
        if let Ok(dir) = core_store::portable_data_dir() {
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", dir.join("webview"));
        }
    }

    // 一時ファイルは AppData 配下の OS 一時フォルダではなく data\tmp に作る。
    // - 投稿時の一時 Cookie ファイル (core-fetch) の置き場所を設定する
    // - このプロセスと子プロセス (WebView2 等) の TEMP / TMP も data\tmp に向ける
    //   (WebView2 は実行中に TEMP へ一時ファイルを作るため。外部ブラウザを開くときは元の値に戻す)
    // 前回の異常終了などで消し残した古いファイル (1時間以上前) は起動時に消す。投稿の Cookie を含むことがあるため残さない。
    // 使用中のファイルは削除に失敗するだけで影響しない (二重起動時の実行中インスタンスのファイル等)
    if let Ok(dir) = core_store::portable_data_dir() {
        let tmp = dir.join("tmp");
        if std::fs::create_dir_all(&tmp).is_ok() {
            if let Ok(entries) = std::fs::read_dir(&tmp) {
                let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(60 * 60);
                for entry in entries.flatten() {
                    let old = entry
                        .metadata()
                        .ok()
                        .filter(|m| m.is_file())
                        .and_then(|m| m.modified().ok())
                        .map(|t| t < cutoff)
                        .unwrap_or(false);
                    if old {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
            #[cfg(target_os = "windows")]
            {
                let _ = ORIGINAL_TEMP.set((std::env::var_os("TEMP"), std::env::var_os("TMP")));
                std::env::set_var("TEMP", &tmp);
                std::env::set_var("TMP", &tmp);
            }
            core_fetch::set_work_dir(tmp);
        }
    }

    tauri::Builder::default()
        .manage(ImagePopupState(Mutex::new(Vec::new())))
        .manage(TwitchState(Mutex::new(HashMap::new())))
        .manage(twitch_badges::BadgeState::default())
        .manage(twitch_auth::TwitchAuthState::default())
        .manage(youtube::YoutubeState::default())
        .manage(youtube_auth::YoutubeAuthState::default())
        .manage(OverlayState { hub: std::sync::Arc::new(core_overlay::OverlayHub::new()), server: Mutex::new(None) })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the existing window when a second instance is launched
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .setup(|app| {
            // 保存してあるプロキシの設定を、掲示板の読み込み・書き込みに反映する
            init_proxy_settings();
            // 保存済みの Twitch ログインがあれば EventSub (入力の無い報酬・自動報酬・フォロー) を始める
            app.state::<twitch_auth::TwitchAuthState>().init(app.handle().clone());
            app.state::<youtube_auth::YoutubeAuthState>().init(app.handle().clone());
            // メインウィンドウは tauri.conf.json で "create": false にしておき、ここで作る。
            // 設定ファイルからでは WebView2 のデータフォルダを AppData 配下にしか指定できないため
            if app.get_webview_window("main").is_none() {
                if let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() {
                    portable_webview(WebviewWindowBuilder::from_config(app.handle(), &config)?).build()?;
                }
            }
            // Purge old event logs based on retention setting (default 7 days)
            let startup_settings = core_store::load_settings_ini().ok();
            let retention: u32 = startup_settings
                .as_ref()
                .and_then(|m| m.get("App.logRetentionDays").and_then(|v| v.parse().ok()))
                .unwrap_or(7);
            let _ = core_store::purge_old_logs(retention);
            // したらば/JPNKN のドメイン上書き設定を起動時に反映
            if let Some(m) = startup_settings.as_ref() {
                apply_domain_overrides_from_settings(m);
                // 字幕ウィンドウの前回のサイズ
                let w: Option<f64> = m.get("App.subtitleWindowWidth").and_then(|v| v.parse().ok());
                let h: Option<f64> = m.get("App.subtitleWindowHeight").and_then(|v| v.parse().ok());
                if let (Some(w), Some(h)) = (w, h) {
                    if subtitle_size_ok(w, h) {
                        *SUBTITLE_SAVED_SIZE.lock().unwrap_or_else(|e| e.into_inner()) = Some((w, h));
                    }
                }
            }
            let _ = core_store::append_log("App started");
            if let Ok(state) = core_store::load_json::<WindowState>("window_size.json") {
                if let Some(win) = app.get_webview_window("main") {
                    if state.maximized == Some(true) {
                        let _ = win.maximize();
                    } else {
                        let _ = win.set_size(tauri::LogicalSize::new(state.width, state.height));
                        if let (Some(x), Some(y)) = (state.x, state.y) {
                            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
                        }
                    }
                }
            }
            // Close subtitle/popup windows when main window closes
            if let Some(main_win) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main_win.on_window_event(move |event| {
                    if let tauri::WindowEvent::Destroyed = event {
                        if let Some(w) = handle.get_webview_window("subtitle") {
                            capture_subtitle_size(&w);
                            persist_subtitle_size();
                            let _ = w.close();
                        }
                        if let Some(w) = handle.get_webview_window("image_popup") { let _ = w.close(); }
                        if let Some(w) = handle.get_webview_window("compose_popup") { let _ = w.close(); }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(guard_window_commands(tauri::generate_handler![
            fetch_bbsmenu_summary,
            fetch_board_categories,
            diagnostics_enabled,
            probe_thread_post_form,
            fetch_thread_list,
            fetch_thread_responses_command,
            debug_post_connectivity,
            probe_post_confirm_empty,
            probe_post_confirm,
            probe_post_finalize_preview,
            probe_post_finalize_preview_from_input,
            probe_post_finalize_submit_empty,
            probe_post_finalize_submit_from_input,
            check_for_updates,
            get_data_dir,
            twitch_sync,
            twitch_set_badges,
            twitch_auth_status,
            twitch_login_start,
            twitch_logout,
            twitch_fetch_emotes,
            twitch_send_chat,
            twitch_user_emotes,
            youtube::youtube_methods,
            youtube::youtube_key_status,
            youtube::youtube_set_key,
            youtube::youtube_clear_key,
            youtube::youtube_sync,
            youtube::youtube_reconnect,
            youtube::youtube_quota_status,
            youtube::youtube_quota_config,
            youtube::youtube_quota_set_used,
            youtube::youtube_quota_restart_target,
            youtube::youtube_auth_status,
            youtube::youtube_auth_set_client,
            youtube::youtube_auth_clear_client,
            youtube::youtube_auth_login,
            youtube::youtube_auth_logout,
            youtube::youtube_send_chat,
            overlay_start,
            overlay_stop,
            overlay_publish,
            overlay_retract,
            overlay_set_layouts,
            open_file_dialog,
            open_folder_dialog,
            save_image_to_folder,
            open_external_url,
            load_favorites,
            save_favorites,
            load_ng_filters,
            save_ng_filters,
            load_tts_dict,
            save_tts_dict,
            load_tts_ip_allow,
            save_tts_ip_allow,
            load_tts_mute_dict,
            save_tts_mute_dict,
            fetch_ogp_card,
            fetch_tweet_card,
            load_ogp_domain_filters,
            save_ogp_domain_filters,
            load_read_status,
            load_thread_history,
            save_thread_history,
            set_thread_custom_title,
            save_read_status,
            load_app_settings,
            save_app_settings,
            load_theme_css,
            refresh_window_css,
            write_event_log,
            save_layout_prefs,
            load_layout_prefs,
            save_session_tabs,
            load_session_tabs,
            save_session_board_tabs,
            load_session_board_tabs,
            post_reply_multisite,
            create_thread_command,
            save_thread_cache,
            load_thread_cache,
            load_all_cached_threads,
            delete_thread_cache,
            set_window_theme,
            save_window_size,
            load_window_size,
            quit_app,
            load_id_highlights,
            save_id_highlights,
            load_text_highlights,
            save_text_highlights,
            load_external_boards,
            save_external_boards,
            save_generic_json,
            load_generic_json,
            load_proxy_settings,
            save_proxy_settings,
            load_image_url_replace,
            reset_image_url_replace,
            sapi_list_voices,
            sapi_speak_text,
            sapi_stop_speech,
            bouyomi_speak_text,
            voicevox_get_speakers,
            voicevox_speak_text,
            tts_stop,
            fetch_image,
            open_image_popup,
            get_image_popup_data,
            remove_popup_image,
            clear_popup_images,
            compose_popup_show,
            compose_popup_update,
            compose_popup_submit,
            compose_popup_result,
            compose_popup_hide,
            compose_popup_save_size,
            subtitle_show,
            subtitle_hide,
            subtitle_reset_position,
            subtitle_update,
            subtitle_timing_report,
            subtitle_control,
            subtitle_status,
            list_settings_presets,
            save_settings_preset,
            load_settings_preset,
            delete_settings_preset,
            list_settings_backups,
            save_settings_backup,
            load_settings_backup,
            subtitle_opacity,
            subtitle_topmost,
            main_set_always_on_bottom,
            subtitle_font_size,
            subtitle_meta_font_size,
            subtitle_text_shadow,
            subtitle_frame,
            subtitle_set_size,
            subtitle_get_size,
            subtitle_id_font_size,
            subtitle_id_font_family,
            list_system_fonts,
            image_save_folder,
            pick_command_program,
            user_commands::load_commands,
            user_commands::save_commands,
            user_commands::run_command
        ]))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// メイン以外のウィンドウが使ってよい命令 (ウィンドウの名前ごと)。ここに無い命令はメインだけが使える。
/// 字幕・画像・書き込み欄のウィンドウに万一不正なスクリプトが入っても、書き込み・設定やログイン情報の
/// 読み書き・外部 URL を開くなどはできないようにする。ウィンドウ操作などの Tauri の基本の権限は capabilities/ で分けている
const SUB_WINDOW_COMMANDS: &[(&str, &[&str])] = &[
    ("subtitle", &["subtitle_control", "subtitle_timing_report", "load_theme_css"]),
    (
        "image_popup",
        &[
            "get_image_popup_data",
            "remove_popup_image",
            "clear_popup_images",
            "image_save_folder",
            "open_folder_dialog",
            "save_image_to_folder",
            "load_theme_css",
        ],
    ),
    ("compose_popup", &["compose_popup_submit", "compose_popup_save_size", "load_theme_css"]),
];

/// そのウィンドウからその命令を呼んでよいか (メインはすべて可、知らないウィンドウはすべて不可)
fn window_may_call(label: &str, command: &str) -> bool {
    if label == "main" {
        return true;
    }
    SUB_WINDOW_COMMANDS
        .iter()
        .find(|(l, _)| *l == label)
        .is_some_and(|(_, cmds)| cmds.contains(&command))
}

/// アプリの命令の受け口の前に、ウィンドウごとの許可を確かめる (plugin: の命令はここを通らず capabilities で決まる)
fn guard_window_commands<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let label = invoke.message.webview_ref().label().to_string();
        let command = invoke.message.command().to_string();
        if !window_may_call(&label, &command) {
            eprintln!("[livefake] ウィンドウ {label} からの命令 {command} を断りました");
            invoke.resolver.reject(format!("このウィンドウからは使えない命令です: {command}"));
            return true;
        }
        handler(invoke)
    }
}

#[cfg(test)]
mod update_notice_tests {
    use super::update_notice_for;
    use serde_json::json;

    #[test]
    fn notice_only_for_versions_below() {
        let n = json!({ "id": "2026-10-security", "below": "0.0.122", "text": "セキュリティ対策のため、最新版への更新をおすすめします" });
        assert_eq!(update_notice_for(Some(&n), "0.0.121").map(|x| x.id), Some("2026-10-security".to_string()));
        assert!(update_notice_for(Some(&n), "0.0.122").is_none());
        assert!(update_notice_for(Some(&n), "0.0.123").is_none());
        assert!(update_notice_for(None, "0.0.121").is_none());
    }

    #[test]
    fn malformed_notice_is_ignored() {
        for n in [
            json!("text"),
            json!({ "id": "a", "text": "x" }),                       // below が無い
            json!({ "id": "a", "below": "abc", "text": "x" }),        // 版の形でない
            json!({ "id": "a b", "below": "1.0.0", "text": "x" }),    // id に空白
            json!({ "id": "a", "below": "1.0.0", "text": "  " }),     // 文が空
            json!({ "id": "a", "below": 5, "text": "x" }),
        ] {
            assert!(update_notice_for(Some(&n), "0.0.1").is_none(), "{n}");
        }
    }

    #[test]
    fn notice_text_is_cleaned_and_limited() {
        let long = "あ".repeat(500);
        let n = json!({ "id": "a", "below": "1.0.0", "text": format!("1行目\n2行目\u{0007}{long}") });
        let t = update_notice_for(Some(&n), "0.0.1").map(|x| x.text).unwrap_or_default();
        assert!(t.starts_with("1行目 2行目あ"));
        assert_eq!(t.chars().count(), super::UPDATE_NOTICE_MAX_CHARS);
    }
}

#[cfg(test)]
mod image_dns_tests {
    #[test]
    fn hostname_pointing_to_this_pc_is_refused() {
        // localhost は 127.0.0.1 / ::1 を指す (通信はしない。この PC の名前解決だけ)
        let r = tauri::async_runtime::block_on(super::public_addrs_of("localhost"));
        assert!(r.is_err());
    }
}

#[cfg(test)]
mod window_guard_tests {
    use super::*;

    #[test]
    fn main_may_call_everything_and_sub_windows_only_their_list() {
        assert!(window_may_call("main", "youtube_send_chat"));
        assert!(window_may_call("main", "load_app_settings"));
        assert!(window_may_call("subtitle", "subtitle_control"));
        assert!(!window_may_call("subtitle", "load_app_settings"));
        assert!(!window_may_call("subtitle", "post_reply"));
        assert!(!window_may_call("subtitle", "open_external_url"));
        assert!(window_may_call("image_popup", "save_image_to_folder"));
        assert!(!window_may_call("image_popup", "load_app_settings"));
        assert!(!window_may_call("image_popup", "save_generic_json"));
        assert!(window_may_call("compose_popup", "compose_popup_submit"));
        assert!(!window_may_call("compose_popup", "youtube_send_chat"));
        assert!(!window_may_call("unknown", "load_theme_css"));
        assert!(!window_may_call("", "load_theme_css"));
    }

    #[test]
    fn image_folder_must_be_configured_or_picked() {
        let picked = vec!["D:\\Pictures\\saved".to_string()];
        assert!(image_folder_allowed("C:\\img", Some("C:\\img"), &[]));
        assert!(image_folder_allowed("c:\\IMG\\", Some("C:\\img"), &[]));
        assert!(image_folder_allowed("D:/Pictures/saved", None, &picked));
        assert!(!image_folder_allowed("C:\\Users\\x\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup", Some("C:\\img"), &picked));
        assert!(!image_folder_allowed("C:\\img\\sub", Some("C:\\img"), &picked));
        assert!(!image_folder_allowed("", Some(""), &[]));
        assert!(!image_folder_allowed("C:\\img", None, &[]));
    }
}

#[cfg(test)]
mod settings_name_tests {
    #[test]
    fn settings_name_validation_rejects_paths_and_reserved_names() {
        assert!(super::validate_settings_name("実況用").is_ok());
        assert!(super::validate_settings_name("night mode").is_ok());
        assert!(super::validate_settings_name("").is_err());
        assert!(super::validate_settings_name("..").is_err());
        assert!(super::validate_settings_name("../x").is_err());
        assert!(super::validate_settings_name("a/b").is_err());
        assert!(super::validate_settings_name("a\\b").is_err());
        assert!(super::validate_settings_name("CON").is_err());
        assert!(super::validate_settings_name("com1").is_err());
        assert!(super::validate_settings_name(".hidden").is_err());
        assert!(super::validate_settings_name(&"あ".repeat(65)).is_err());
    }

    #[test]
    fn settings_files_roundtrip_and_backup_rotation() {
        let dir = std::env::temp_dir().join(format!("livefake-settings-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("EMBER_DATA_DIR", &dir);

        super::write_settings_file(super::SETTINGS_PRESET_DIR, "実況用", r#"{"version":1,"layout":{"a":1}}"#).unwrap();
        assert!(super::write_settings_file(super::SETTINGS_PRESET_DIR, "x", "[1,2]").is_err());
        assert!(super::write_settings_file(super::SETTINGS_PRESET_DIR, "../evil", "{}").is_err());
        assert!(super::write_settings_file(super::SETTINGS_PRESET_DIR, "bad", "{not json").is_err());
        let list = super::list_settings_files(super::SETTINGS_PRESET_DIR).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "実況用");
        assert!(dir.join("presets").join("実況用.json").exists());
        let json = super::read_settings_file(super::SETTINGS_PRESET_DIR, "実況用").unwrap();
        assert!(json.contains("\"version\": 1"));
        assert!(super::read_settings_file(super::SETTINGS_PRESET_DIR, "missing").is_err());
        super::delete_settings_preset("実況用".to_string()).unwrap();
        assert!(super::list_settings_files(super::SETTINGS_PRESET_DIR).unwrap().is_empty());

        for i in 0..22u32 {
            super::save_settings_backup(format!("20260101-{:06}", i), "{}".to_string()).unwrap();
        }
        let backups = super::list_settings_files(super::SETTINGS_BACKUP_DIR).unwrap();
        assert_eq!(backups.len(), super::SETTINGS_BACKUP_KEEP);
        let names: Vec<&str> = backups.iter().map(|b| b.name.as_str()).collect();
        assert!(names.contains(&"20260101-000021"));
        assert!(names.contains(&"20260101-000002"));
        assert!(!names.contains(&"20260101-000001"));
        assert!(!names.contains(&"20260101-000000"));

        std::env::remove_var("EMBER_DATA_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
