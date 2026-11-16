use core_proxy::{
    unprotect_password, update_proxy_settings,
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

mod auth_file;
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

/// OBS 表示をすべて消す (配信への出力の緊急停止)。履歴も消すので、OBS をつなぎ直しても出ない
#[tauri::command]
fn overlay_clear(state: tauri::State<'_, OverlayState>) {
    state.hub.clear();
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
async fn twitch_logout(state: tauri::State<'_, twitch_auth::TwitchAuthState>) -> Result<twitch_auth::AuthStatus, String> {
    state.logout().await;
    // 済んでいないこと (Twitch 側の取り消し・この PC のファイルの削除) があれば、message に入っている
    Ok(state.status())
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

    let configured_url = core_store::load_settings_ini()
        .ok()
        .and_then(|m| m.get("App.bbsmenuUrl").cloned())
        .filter(|u| !u.trim().is_empty())
        .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        .unwrap_or_else(|| BBSMENU_URL.to_string());

    match fetch_bbsmenu_json("Monazilla/1.00 LiveFake/0.1", &configured_url).await {
        Ok(menu) => {
            let _ = core_store::save_json("bbs-menu.json", &menu);
            set_extra_allowed_hosts(core_fetch::keep_public_board_hosts(extract_bbsmenu_hosts(&menu)).await);
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
                .timeout(std::time::Duration::from_secs(30))
                .redirect(core_fetch::post_redirect_policy()), core_proxy::ProxyRole::Send)
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
                .timeout(std::time::Duration::from_secs(30))
                .redirect(core_fetch::post_redirect_policy()), core_proxy::ProxyRole::Send)
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
                .timeout(std::time::Duration::from_secs(30))
                .redirect(core_fetch::post_redirect_policy()), core_proxy::ProxyRole::Send)
                .map_err(|e| e.to_string())?
                .build()
                .map_err(|e| e.to_string())?;
            create_shitaraba_thread(&client, &board_url, &subject, &from_str, &mail_str, &message)
                .await
                .map_err(|e| format!("{:?}", e))
        }
        Some(SiteType::Jpnkn) => {
            let client = core_proxy::apply(reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .redirect(core_fetch::post_redirect_policy()), core_proxy::ProxyRole::Send)
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

/// フォルダをエクスプローラーで開く (呼ぶ側で決めた場所だけ。利用者の入力したパスは渡さない)
fn open_folder_in_explorer(dir: &std::path::Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err("フォルダがありません".into());
    }
    #[cfg(target_os = "windows")]
    {
        restore_original_temp(&mut Command::new("explorer.exe")).arg(dir).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(dir).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".to_string())
}

// ===== 掲示板のログ =====
// 開いたスレ (設定で選んだスレ) のレスを、data/logs/<5ch|shitaraba|jpnkn>/<板>/<スレ番号>.jsonl (配信ログビュワー用) と
// .dat (5ch と同じ形・Shift_JIS。ほかの専ブラ用) に書き足す。日数・容量を過ぎたものは古いものから消す。
// パスは、対応している掲示板のスレの URL から取り出し、形を確かめた板名とスレ番号だけで作る (ほかの場所には書かない)。外部へは送らない
/// 書き足し・削除のどちらも、この鍵を持っている間だけファイルに触る (調べてから消すまでの間に書き足されないように)
static BOARD_LOG_LOCK: Mutex<Option<BoardLogState>> = Mutex::new(None);
#[derive(Default)]
struct BoardLogState {
    /// JSONL に書いてある最後のレス番号 (ファイルごと)
    last: HashMap<std::path::PathBuf, u32>,
    /// dat の行数と JSONL のレスの数が合うかを確かめたファイル (起動ごとに1回)
    dat_checked: HashSet<std::path::PathBuf>,
    /// dat が合わないが、直すのに要るレスがそろわなかったファイルと、足りないレス番号 (この起動の間は書き足しを続け、
    /// 画面側が足りない番号を手元にそろえてスレ全体を渡したらやり直す。次の起動では、もう一度はじめから確かめる)
    dat_pending: HashMap<std::path::PathBuf, Vec<u32>>,
}
/// 1ファイルの大きさの上限 (1スレ1000レスなら数MB。超えたらそのファイルには書かない)
const BOARD_LOG_FILE_MAX: u64 = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoardLogRes {
    no: u32,
    #[serde(default)]
    name: String,
    #[serde(default)]
    mail: String,
    /// 掲示板の「日付 ID」の欄そのまま (dat 用)
    #[serde(default)]
    date_and_id: String,
    /// 本文 (掲示板の HTML のまま。dat 用)
    #[serde(default)]
    body: String,
    /// 以下は JSONL 用 (タグを除いた文字)
    #[serde(default)]
    name_text: String,
    #[serde(default)]
    uid: String,
    #[serde(default)]
    posted: String,
    #[serde(default)]
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoardLogAppendResult {
    written: usize,
    /// ログのファイルを新しく作ったが、最初のレスから書けていない (画面側は、スレ全体を渡し直す)
    need_full: bool,
    /// dat を直す待ちのとき、直すのに足りないレス番号 (画面側は、これが手元に全部そろったら一度だけスレ全体を渡す)
    repair_missing: Vec<u32>,
}

fn board_log_dir_path() -> Result<std::path::PathBuf, String> {
    core_store::portable_data_dir().map(|p| p.join("logs")).map_err(|e| e.to_string())
}

fn board_log_name_ok(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// スレの URL から、ログの置き場所 (サイト・板のフォルダ名・スレ番号) を取り出す。対応している掲示板のスレの形でなければ None
fn board_log_location(thread_url: &str) -> Option<(&'static str, String, String)> {
    if !core_fetch::is_allowed_url(thread_url) {
        return None;
    }
    let site = core_fetch::detect_site_type(thread_url)?;
    let url = reqwest::Url::parse(thread_url).ok()?;
    let segs: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    let (site_dir, board, key) = match site {
        core_fetch::SiteType::Shitaraba => {
            if segs.len() < 5 || segs[0] != "bbs" || segs[1] != "read.cgi" {
                return None;
            }
            ("shitaraba", format!("{}_{}", segs[2], segs[3]), segs[4].to_string())
        }
        core_fetch::SiteType::FiveCh | core_fetch::SiteType::Jpnkn => {
            if segs.len() < 4 || segs[0] != "test" || segs[1] != "read.cgi" {
                return None;
            }
            (if site == core_fetch::SiteType::Jpnkn { "jpnkn" } else { "5ch" }, segs[2].to_string(), segs[3].to_string())
        }
    };
    if !board_log_name_ok(&board, 80) || key.is_empty() || key.len() > 20 || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((site_dir, board, key))
}

fn board_log_clip(s: &str, max: usize) -> String {
    s.chars().filter(|c| *c != '\0').take(max).collect()
}

/// dat の1行の欄 (改行と、欄の区切りの "<>" を含めない)
fn board_log_dat_field(s: &str) -> String {
    board_log_clip(s, 20000).replace(['\r', '\n'], " ").replace("<>", "&lt;&gt;")
}

fn board_log_now() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z").to_string()
}

/// JSONL に書いてあるレス番号 (小さい順・重複なし)。読めなかったときはエラー (0件として扱うと、次に書くとき重複する)
fn board_log_jsonl_nos(path: &std::path::Path) -> Result<Vec<u32>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("ログを読めませんでした: {e}"))?;
    let mut nos: Vec<u32> = text
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter_map(|v| v.get("no").and_then(|n| n.as_u64()))
        .filter_map(|n| u32::try_from(n).ok())
        .collect();
    nos.sort_unstable();
    nos.dedup();
    Ok(nos)
}

/// dat の行 (5ch と同じ1行1レスの形: 名前<>メール<>日付 ID<>本文<>スレタイ。スレタイは1行目だけ)
fn board_log_dat_lines(rows: &[&BoardLogRes], title: &str, title_on_first: bool) -> String {
    let mut text = String::new();
    for (i, r) in rows.iter().enumerate() {
        let t = if title_on_first && i == 0 { board_log_dat_field(title) } else { String::new() };
        text.push_str(&format!(
            "{}<>{}<>{}<>{}<>{}\n",
            board_log_dat_field(&r.name),
            board_log_dat_field(&r.mail),
            board_log_dat_field(&r.date_and_id),
            board_log_dat_field(&r.body),
            t
        ));
    }
    text
}

/// dat の行数と JSONL のレスの数を比べる (前の版で片方だけ消えた・書けなかった組を見つける)
enum DatCheck {
    /// 合っている、または直したので、このまま書き足す
    Done,
    /// 合っていない。スレ全体を渡してもらえれば作り直せる
    NeedFull,
    /// 合っていないが、渡されたレスでは足りないので直せない (直す待ち)。足りないレス番号
    Short(Vec<u32>),
}

/// 合っていなければ、渡されたスレ全体のレスから dat を作り直す (JSONL にある番号が全部そろうときだけ。JSONL は変えない)
fn board_log_check_dat(jsonl: &std::path::Path, dat: &std::path::Path, nos: &[u32], responses: &[BoardLogRes], full: bool, title: &str, max: u64) -> Result<DatCheck, String> {
    let dat_lines = std::fs::read(dat).map(|b| b.iter().filter(|&&c| c == b'\n').count()).unwrap_or(0);
    if nos.is_empty() || dat_lines == nos.len() {
        return Ok(DatCheck::Done);
    }
    if !full {
        return Ok(DatCheck::NeedFull);
    }
    let by_no: HashMap<u32, &BoardLogRes> = responses.iter().map(|r| (r.no, r)).collect();
    let missing: Vec<u32> = nos.iter().copied().filter(|n| !by_no.contains_key(n)).collect();
    if !missing.is_empty() {
        eprintln!("board log: dat を作り直すためのレスがそろっていません ({} 件足りない: {})", missing.len(), jsonl.display());
        return Ok(DatCheck::Short(missing));
    }
    let rows: Vec<&BoardLogRes> = nos.iter().filter_map(|n| by_no.get(n).copied()).collect();
    let bytes = core_fetch::encode_shift_jis(&board_log_dat_lines(&rows, title, true));
    if bytes.len() as u64 > max {
        // 上限を超えて作り直せない (足りない番号は無いので、画面側からは頼み直さない)
        return Ok(DatCheck::Short(Vec::new()));
    }
    // 別の名前に書いてから置き換える (途中で失敗しても、元の dat は残る)
    let tmp = dat.with_extension("dat.tmp");
    if let Err(e) = std::fs::write(&tmp, &bytes).and_then(|_| std::fs::rename(&tmp, dat)) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("dat を作り直せませんでした: {e}"));
    }
    Ok(DatCheck::Done)
}

/// ファイルに書き足す。書けなかったときは書く前の状態に戻す (前から無かったファイルは消す・あったファイルは元の長さに切り詰める)
fn board_log_append_bytes(path: &std::path::Path, bytes: &[u8], before: Option<u64>) -> Result<(), String> {
    use std::io::Write;
    let result = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| f.write_all(bytes).and_then(|_| f.flush()));
    if let Err(e) = result {
        board_log_restore(path, before);
        return Err(e.to_string());
    }
    Ok(())
}

/// 書き足す前の状態に戻す (失敗しても、ほかに手は無いので知らせるだけ)
fn board_log_restore(path: &std::path::Path, before: Option<u64>) {
    let r = match before {
        None => match std::fs::remove_file(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        },
        Some(len) => std::fs::OpenOptions::new().write(true).open(path).and_then(|f| f.set_len(len)),
    };
    if let Err(e) = r {
        eprintln!("board log: 書く前の状態に戻せませんでした: {e}");
    }
}

/// JSONL と dat に書き足す。両方とも「今の大きさ + これから書く分」が上限に収まるときだけ書き、
/// dat を先に書いて、JSONL を書けなかったら dat も書く前に戻す (どちらか片方だけ書いた状態を残さない)
fn board_log_write_pair(jsonl: &std::path::Path, jsonl_bytes: &[u8], dat: &std::path::Path, dat_bytes: &[u8], max: u64) -> Result<(), String> {
    let jsonl_before = std::fs::metadata(jsonl).ok().map(|m| m.len());
    let dat_before = std::fs::metadata(dat).ok().map(|m| m.len());
    if jsonl_before.unwrap_or(0) + jsonl_bytes.len() as u64 > max || dat_before.unwrap_or(0) + dat_bytes.len() as u64 > max {
        return Err("ログのファイルが上限 (1ファイル 64MB) を超えるため、書いていません".into());
    }
    board_log_append_bytes(dat, dat_bytes, dat_before)?;
    if let Err(e) = board_log_append_bytes(jsonl, jsonl_bytes, jsonl_before) {
        board_log_restore(dat, dat_before);
        return Err(e);
    }
    Ok(())
}

/// JSONL の1行 (1レス)
fn board_log_jsonl_line(r: &BoardLogRes, at: &str, src: &str, title: &str, thread_url: &str, board: &str) -> String {
    let mut m = serde_json::Map::new();
    m.insert("v".into(), 1.into());
    m.insert("at".into(), at.into());
    m.insert("src".into(), src.into());
    let mut put = |k: &str, v: String| {
        if !v.is_empty() {
            m.insert(k.into(), v.into());
        }
    };
    put("where", title.to_string());
    put("url", thread_url.to_string());
    put("board", board_log_clip(board, 200));
    put("name", board_log_clip(&r.name_text, 300));
    put("uid", board_log_clip(&r.uid, 200));
    put("mail", board_log_clip(&r.mail, 300));
    put("posted", board_log_clip(&r.posted, 200));
    put("text", board_log_clip(&r.text, 20000));
    m.insert("no".into(), r.no.into());
    serde_json::Value::Object(m).to_string()
}

/// dat の1行のスレタイの欄 (5つ目の欄) を入れ替える (並べ直したとき、スレタイを1行目だけにするため)
fn board_log_dat_set_title(line: &[u8], title_field: &[u8]) -> Vec<u8> {
    let mut seps = 0;
    let mut i = 0;
    while i + 1 < line.len() {
        if line[i] == b'<' && line[i + 1] == b'>' {
            seps += 1;
            if seps == 4 {
                let mut v = line[..i + 2].to_vec();
                v.extend_from_slice(title_field);
                return v;
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    line.to_vec()
}

/// 書いてあるログに抜けがあり、スレ全体を渡されたとき: JSONL と dat を番号順に作り直す。
/// 元からある行はそのまま使い (書いた時刻なども変えない)、抜けていたレスと新しいレスだけを作る。
/// 一時ファイルに書いてから、元の組を「消す予定」の名前に移して置き換える。途中で失敗したら元の組に戻す (何も変えない)
#[allow(clippy::too_many_arguments)]
fn board_log_rebuild_in_order(dir: &std::path::Path, key: &str, jsonl: &std::path::Path, dat: &std::path::Path, responses: &[BoardLogRes], have: &HashSet<u32>, thread_url: &str, title: &str, board: &str, site_dir: &str) -> Result<usize, String> {
    let jsonl_text = std::fs::read_to_string(jsonl).map_err(|e| format!("ログを読めませんでした: {e}"))?;
    let dat_bytes = std::fs::read(dat).map_err(|e| format!("dat を読めませんでした: {e}"))?;
    let mut header: Vec<String> = Vec::new();
    let mut records: Vec<(u32, String)> = Vec::new();
    for l in jsonl_text.lines().filter(|l| !l.trim().is_empty()) {
        match serde_json::from_str::<serde_json::Value>(l).ok().and_then(|v| v.get("no").and_then(|n| n.as_u64())) {
            Some(n) => records.push((n as u32, l.to_string())),
            None => header.push(l.to_string()),
        }
    }
    let dat_lines: Vec<&[u8]> = dat_bytes.split(|&c| c == b'\n').filter(|l| !l.is_empty()).collect();
    if dat_lines.len() != records.len() {
        // dat と JSONL が食い違っている (dat を直す処理に任せる): 並べ直さない
        return Err("ログの dat と JSONL の件数が合わないため、抜けを補えませんでした".into());
    }
    let at = board_log_now();
    let src = match site_dir { "shitaraba" => "shitaraba", "jpnkn" => "jpnkn", _ => "5ch" };
    let mut merged: Vec<(u32, String, Vec<u8>)> = records.into_iter().zip(dat_lines).map(|((n, j), d)| (n, j, d.to_vec())).collect();
    let mut added = 0;
    let mut seen: HashSet<u32> = have.clone();
    for r in responses.iter().filter(|r| r.no <= 100_000) {
        if seen.insert(r.no) {
            let d = core_fetch::encode_shift_jis(&board_log_dat_lines(&[r], title, false));
            let d = d.strip_suffix(b"\n").unwrap_or(&d).to_vec();
            merged.push((r.no, board_log_jsonl_line(r, &at, src, title, thread_url, board), d));
            added += 1;
        }
    }
    merged.sort_by_key(|(n, _, _)| *n);
    let title_field = core_fetch::encode_shift_jis(&board_log_dat_field(title));
    let mut new_jsonl = String::new();
    for h in &header {
        new_jsonl.push_str(h);
        new_jsonl.push('\n');
    }
    let mut new_dat: Vec<u8> = Vec::new();
    for (i, (_, j, d)) in merged.iter().enumerate() {
        new_jsonl.push_str(j);
        new_jsonl.push('\n');
        new_dat.extend_from_slice(&board_log_dat_set_title(d, if i == 0 { &title_field } else { b"" }));
        new_dat.push(b'\n');
    }
    if new_jsonl.len() as u64 > BOARD_LOG_FILE_MAX || new_dat.len() as u64 > BOARD_LOG_FILE_MAX {
        return Err("ログのファイルが上限 (1ファイル 64MB) を超えるため、抜けを補えませんでした".into());
    }
    let jsonl_tmp = dir.join(format!("{key}.jsonl.tmp"));
    let dat_tmp = dir.join(format!("{key}.dat.tmp"));
    // 元の組は <番号>.jsonl.prev / <番号>.dat.prev に移す (途中で止まっても、次の起動の削除の前に戻せるように。
    // 削除の処理が片付ける名前 (.jsonl.del など) にはしない)
    let jsonl_old = dir.join(format!("{key}.jsonl.prev"));
    let dat_old = dir.join(format!("{key}.dat.prev"));
    let cleanup_tmp = || {
        let _ = std::fs::remove_file(&jsonl_tmp);
        let _ = std::fs::remove_file(&dat_tmp);
    };
    let done = dir.join(format!("{key}.rebuilt"));
    if done.exists() {
        if let Err(e) = std::fs::remove_file(&done) {
            return Err(format!("前回の作り直しで残った目印のファイル ({key}.rebuilt) を消せなかったため、番号順の作り直しをやめました: {e}"));
        }
    }
    if let Err(e) = std::fs::write(&jsonl_tmp, new_jsonl.as_bytes()).and_then(|_| std::fs::write(&dat_tmp, &new_dat)) {
        cleanup_tmp();
        return Err(format!("抜けを補うログを書けませんでした: {e}"));
    }
    // 元の組を「消す予定」の名前に移す (使用中なら移せないので、何も変えずにやめる)
    if let Err(e) = std::fs::rename(dat, &dat_old) {
        cleanup_tmp();
        return Err(format!("ログを置き換えられませんでした: {e}"));
    }
    if let Err(e) = std::fs::rename(jsonl, &jsonl_old) {
        let _ = std::fs::rename(&dat_old, dat);
        cleanup_tmp();
        return Err(format!("ログを置き換えられませんでした: {e}"));
    }
    let placed = std::fs::rename(&dat_tmp, dat).and_then(|_| std::fs::rename(&jsonl_tmp, jsonl));
    if let Err(e) = placed {
        // 途中まで置いたものを外し、元の組に戻す
        let _ = std::fs::remove_file(dat);
        let _ = std::fs::remove_file(jsonl);
        let back = std::fs::rename(&dat_old, dat).and_then(|_| std::fs::rename(&jsonl_old, jsonl));
        if let Err(e2) = back {
            eprintln!("board log: 元のログに戻せませんでした (別名で残っています): {e2}");
        }
        cleanup_tmp();
        return Err(format!("ログを置き換えられませんでした: {e}"));
    }
    // 置き終えた印を書いてから、元の組を消す (消し残しても、次に書き足す・整理するときに、印を見て消し直せるように)
    board_log_finish_rebuild(dir, key);
    Ok(added)
}

/// 番号順の作り直しで、新しい組を置き終えたあとの片付け: 「置き終えた」印 (<番号>.rebuilt) を書いてから、元の組を消す。
/// 両方消せたら印も消す。印を書けなければ元の組は消さない (4つのファイルがそろった状態は「置き終えた」と分かる)
fn board_log_finish_rebuild(dir: &std::path::Path, key: &str) {
    let done = dir.join(format!("{key}.rebuilt"));
    let jprev = dir.join(format!("{key}.jsonl.prev"));
    let dprev = dir.join(format!("{key}.dat.prev"));
    if !done.exists() {
        if let Err(e) = std::fs::write(&done, b"") {
            eprintln!("board log: 置き終えた印を書けませんでした (元の組は次に片付けます): {e}");
            return;
        }
    }
    let _ = std::fs::remove_file(&dprev);
    let _ = std::fs::remove_file(&jprev);
    if !jprev.exists() && !dprev.exists() {
        let _ = std::fs::remove_file(&done);
    }
}

/// 番号順の作り直しが途中で止まっていたら、完全な組に戻す (元の組か、置き終えた新しい組のどちらか)。
/// 書き足し・削除と同じ鍵を持っているときに呼ぶ。途中の一時ファイルも片付ける。
/// 戻せなかったとき (使用中など) はエラー: 呼んだ側は、そのスレのログに書き足さず、整理でも触らない
/// (戻さずに書き足すと、新しい組と取り違えて元の組を消してしまうため)
fn board_log_recover(dir: &std::path::Path, key: &str) -> Result<(), String> {
    let jsonl = dir.join(format!("{key}.jsonl"));
    let dat = dir.join(format!("{key}.dat"));
    let jprev = dir.join(format!("{key}.jsonl.prev"));
    let dprev = dir.join(format!("{key}.dat.prev"));
    let held = |e: std::io::Error| format!("ログ ({key}) の作り直しの途中から戻せませんでした (使用中など)。戻せるまで、このスレのログへの書き足しを止めています: {e}");
    let done = dir.join(format!("{key}.rebuilt"));
    // 元の組は「dat → JSONL」の順に移すので、JSONL と dat がどちらもあるのに元の組の名残があるのは、新しい組を置き終えたあとだけ
    // (前の版の片付けで、古い dat だけ消し残した状態も含む)
    if done.exists() || (jsonl.exists() && dat.exists() && (jprev.exists() || dprev.exists())) {
        // 新しい組を両方置き終えたあと (元の組を消し終える前) に止まった: 新しい組のまま、元の組の名残を消す。
        // 消せなかった分 (使用中など) は、印を残して次の回に消し直す (新しい組はそろっているので、書き足しは続ける)
        board_log_finish_rebuild(dir, key);
    } else if jprev.exists() || dprev.exists() {
        // 置き終える前に止まった: 元の組に戻す。置きかけの新しい dat を外すのは、元の JSONL も移したあと (= 新しい dat を置いた段階) だけ
        if dprev.exists() {
            if dat.exists() {
                if !jprev.exists() {
                    return Err(format!("ログ ({key}) の作り直しの途中の状態が分かりません。このスレのログへの書き足しを止めています"));
                }
                std::fs::remove_file(&dat).map_err(held)?;
            }
            std::fs::rename(&dprev, &dat).map_err(held)?;
        }
        if jprev.exists() && !jsonl.exists() {
            std::fs::rename(&jprev, &jsonl).map_err(held)?;
        }
        if jprev.exists() || dprev.exists() {
            return Err(format!("ログ ({key}) の作り直しの途中から戻せませんでした。このスレのログへの書き足しを止めています"));
        }
    }
    let _ = std::fs::remove_file(dir.join(format!("{key}.jsonl.tmp")));
    let _ = std::fs::remove_file(dir.join(format!("{key}.dat.tmp")));
    Ok(())
}

/// スレのレスをログに書き足す (書いていないレス番号のものだけ)。
/// 新しくファイルを作るときに、渡されたレスが最初からでなければ書かずに need_full を返す (full = true なら、そのまま書く)
#[tauri::command(async)]
fn board_log_append(thread_url: String, title: String, board: String, responses: Vec<BoardLogRes>, full: Option<bool>) -> Result<BoardLogAppendResult, String> {
    board_log_append_in(&board_log_dir_path()?, thread_url, title, board, responses, full)
}

/// board_log_append の中身 (logs のフォルダを受け取る。テストでは一時フォルダを渡す)
fn board_log_append_in(base: &std::path::Path, thread_url: String, title: String, board: String, responses: Vec<BoardLogRes>, full: Option<bool>) -> Result<BoardLogAppendResult, String> {
    let Some((site_dir, board_dir, key)) = board_log_location(&thread_url) else {
        return Err("ログを残せるスレの URL ではありません".into());
    };
    let dir = base.join(site_dir).join(&board_dir);
    let jsonl = dir.join(format!("{key}.jsonl"));
    let dat = dir.join(format!("{key}.dat"));
    let mut guard = BOARD_LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state = guard.get_or_insert_with(BoardLogState::default);
    board_log_recover(&dir, &key)?;
    let jsonl_exists = jsonl.is_file();
    let title = board_log_clip(&title, 300);
    // この起動で初めて触るログ (と、直す待ちのログにスレ全体を渡されたとき): 書いてあるレス番号を読み、dat の行数と合うかを確かめる。
    // 読めなかったら何も覚えずにエラーにする (次の回に読み直す)
    let retry_pending = full.unwrap_or(false) && state.dat_pending.contains_key(&jsonl);
    if jsonl_exists && (!state.dat_checked.contains(&jsonl) || retry_pending) {
        let nos = board_log_jsonl_nos(&jsonl)?;
        // 直す待ちのログは、この起動の間はスレ全体を頼み直さない (毎回スレ全体を送らせないため)
        let full_now = full.unwrap_or(false);
        match board_log_check_dat(&jsonl, &dat, &nos, &responses, full_now, &title, BOARD_LOG_FILE_MAX)? {
            DatCheck::NeedFull if !state.dat_pending.contains_key(&jsonl) => {
                return Ok(BoardLogAppendResult { written: 0, need_full: true, repair_missing: Vec::new() });
            }
            DatCheck::NeedFull => {}
            DatCheck::Short(missing) => { state.dat_pending.insert(jsonl.clone(), missing); }
            DatCheck::Done => { state.dat_pending.remove(&jsonl); }
        }
        state.last.insert(jsonl.clone(), nos.last().copied().unwrap_or(0));
        state.dat_checked.insert(jsonl.clone());
    }
    let last = if jsonl_exists {
        match state.last.get(&jsonl) {
            Some(n) => *n,
            None => {
                let n = board_log_jsonl_nos(&jsonl)?.last().copied().unwrap_or(0);
                state.last.insert(jsonl.clone(), n);
                n
            }
        }
    } else {
        0
    };
    // スレ全体を渡されたとき: 書いてある番号と照らし合わせ、抜け (あとで取れた古いレス) があれば、2つのファイルを番号順に作り直す
    if jsonl_exists && full.unwrap_or(false) && !state.dat_pending.contains_key(&jsonl) {
        let nos = board_log_jsonl_nos(&jsonl)?;
        let have: HashSet<u32> = nos.iter().copied().collect();
        if responses.iter().any(|r| r.no < last && r.no <= 100_000 && !have.contains(&r.no)) {
            let added = board_log_rebuild_in_order(&dir, &key, &jsonl, &dat, &responses, &have, &thread_url, &title, &board, site_dir)?;
            let max_no = responses.iter().map(|r| r.no).filter(|n| *n <= 100_000).max().unwrap_or(last).max(last);
            state.last.insert(jsonl.clone(), max_no);
            state.dat_checked.insert(jsonl.clone());
            return Ok(BoardLogAppendResult { written: added, need_full: false, repair_missing: Vec::new() });
        }
    }
    let mut rows: Vec<&BoardLogRes> = responses.iter().filter(|r| r.no > last && r.no <= 100_000).collect();
    rows.sort_by_key(|r| r.no);
    rows.dedup_by_key(|r| r.no);
    // 直す待ちのログなら、足りないレス番号を毎回返す (画面側が、そろったときに一度だけスレ全体を渡せるように)
    let missing_of = |st: &BoardLogState| -> Vec<u32> { st.dat_pending.get(&jsonl).map(|m| m.iter().copied().take(2000).collect()).unwrap_or_default() };
    if rows.is_empty() {
        return Ok(BoardLogAppendResult { written: 0, need_full: false, repair_missing: missing_of(state) });
    }
    if !jsonl_exists && !full.unwrap_or(false) && rows.first().map(|r| r.no > 1).unwrap_or(false) {
        return Ok(BoardLogAppendResult { written: 0, need_full: true, repair_missing: Vec::new() });
    }
    let at = board_log_now();
    let src = match site_dir { "shitaraba" => "shitaraba", "jpnkn" => "jpnkn", _ => "5ch" };
    let mut out = String::new();
    if !jsonl_exists {
        out.push_str(&serde_json::json!({ "v": 1, "type": "start", "at": at, "title": title, "url": thread_url }).to_string());
        out.push('\n');
    }
    for r in &rows {
        out.push_str(&board_log_jsonl_line(r, &at, src, &title, &thread_url, &board));
        out.push('\n');
    }
    // JSONL が無いのに dat が残っているとき (前の版・削除の途中で止まった): 残っていた dat は消さずに別名
    // (<スレ番号>.<日時>.dat.bak) へ移してから新しく作る。作るのに失敗したら元の名前に戻す。
    // 渡されたレスで元の行を全部作り直せたときだけ別名のほうを消し、足りなければ過去の分として残す (日数・容量の削除の対象)
    let mut backup: Option<std::path::PathBuf> = None;
    if !jsonl_exists && dat.is_file() {
        let bak = dir.join(format!("{key}.{}.dat.bak", chrono::Local::now().format("%Y%m%d%H%M%S%3f")));
        std::fs::rename(&dat, &bak).map_err(|e| format!("前の dat を別名にできませんでした: {e}"))?;
        backup = Some(bak);
        state.dat_pending.remove(&jsonl);
    }
    let dat_exists = std::fs::metadata(&dat).map(|m| m.len() > 0).unwrap_or(false);
    let dat_text = board_log_dat_lines(&rows, &title, !dat_exists);
    // JSONL と dat は「両方書けた」か「どちらも書いていない」かのどちらかにする (片方だけだと、次の回に重複・欠落する)
    let written = std::fs::create_dir_all(&dir)
        .map_err(|e| e.to_string())
        .and_then(|_| board_log_write_pair(&jsonl, out.as_bytes(), &dat, &core_fetch::encode_shift_jis(&dat_text), BOARD_LOG_FILE_MAX));
    if let Err(e) = written {
        if let Some(bak) = &backup {
            if let Err(e2) = std::fs::rename(bak, &dat) {
                eprintln!("board log: 別名にした dat を戻せませんでした: {e2}");
            }
        }
        return Err(e);
    }
    // 別名のほうを消すのは、元の dat の各行が新しい dat にそのまま入っているときだけ (行数や番号の数では判断しない。
    // 欠番のある dat だと、同じ行数でも別のレスになるため)。そうでなければ、日数・容量の決まりで消えるまで残す
    if let Some(bak) = backup {
        let old = std::fs::read(&bak).unwrap_or_default();
        let new = std::fs::read(&dat).unwrap_or_default();
        // 同じ行が複数あるとき (同じ中身の投稿) も取りこぼさないよう、行ごとの数まで照らし合わせる
        let mut counts: HashMap<&[u8], i64> = HashMap::new();
        for l in new.split(|&c| c == b'\n').filter(|l| !l.is_empty()) {
            *counts.entry(l).or_insert(0) += 1;
        }
        let mut covered = !old.is_empty();
        for l in old.split(|&c| c == b'\n').filter(|l| !l.is_empty()) {
            let c = counts.entry(l).or_insert(0);
            *c -= 1;
            if *c < 0 {
                covered = false;
            }
        }
        if covered {
            let _ = std::fs::remove_file(&bak);
        }
    }
    if !jsonl_exists {
        // 削除の途中で止まった「消す予定」の JSONL (消せなくても、日数・容量の削除のときに片付ける)
        let _ = std::fs::remove_file(jsonl.with_extension("jsonl.del"));
    }
    let max_no = rows.last().map(|r| r.no).unwrap_or(last);
    state.last.insert(jsonl.clone(), max_no.max(last));
    // 新しく作ったログは、作った時点で dat と合っている
    state.dat_checked.insert(jsonl.clone());
    Ok(BoardLogAppendResult { written: rows.len(), need_full: false, repair_missing: missing_of(state) })
}

/// 日数・容量を過ぎたログを消す (最後に書いた時刻が古いスレから)。days・max_mb が 0 なら、その決まりは使わない。
/// 消すのは logs の下の 5ch・shitaraba・jpnkn の板のフォルダの中の .jsonl・.dat だけ (ほかのファイル・フォルダには触らない)
#[tauri::command(async)]
fn board_log_prune(days: u32, max_mb: u32) -> Result<usize, String> {
    board_log_prune_in(&board_log_dir_path()?, days, max_mb)
}

/// board_log_prune の中身 (logs のフォルダを受け取る。テストでは一時フォルダを渡す)
fn board_log_prune_in(base: &std::path::Path, days: u32, max_mb: u32) -> Result<usize, String> {
    let base = base.to_path_buf();
    // 調べ始めてから消し終わるまで、書き足しと同じ鍵を持つ (調べたあとに書き足したスレを、古い時刻のまま消さないように)
    let mut guard = BOARD_LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // スレごと (板のフォルダ + スレ番号) に、ファイルと最後に書いた時刻と大きさをまとめる
    #[derive(Default)]
    struct Item { jsonl: Option<std::path::PathBuf>, dat: Option<std::path::PathBuf>, modified: Option<std::time::SystemTime>, size: u64 }
    let mut items: HashMap<std::path::PathBuf, Item> = HashMap::new();
    for site in ["5ch", "shitaraba", "jpnkn"] {
        let Ok(boards) = std::fs::read_dir(base.join(site)) else { continue };
        for b in boards.flatten() {
            if !b.file_type().map(|t| t.is_dir()).unwrap_or(false) || !board_log_name_ok(&b.file_name().to_string_lossy(), 80) {
                continue;
            }
            // 番号順の作り直しが途中で止まっていたら、片付ける前に完全な組に戻す (戻さずに片付けると JSONL を失う)。
            // 戻せなかったスレのファイルには、この回は触らない
            let mut held: HashSet<String> = HashSet::new();
            if let Ok(pre) = std::fs::read_dir(b.path()) {
                let keys: HashSet<String> = pre
                    .flatten()
                    .filter_map(|f| {
                        let n = f.file_name().to_string_lossy().into_owned();
                        n.strip_suffix(".jsonl.prev").or_else(|| n.strip_suffix(".dat.prev")).or_else(|| n.strip_suffix(".rebuilt")).filter(|k| !k.is_empty() && k.len() <= 20 && k.bytes().all(|c| c.is_ascii_digit())).map(str::to_string)
                    })
                    .collect();
                for k in keys {
                    if let Err(e) = board_log_recover(&b.path(), &k) {
                        eprintln!("board log: {e}");
                        held.insert(k);
                    }
                }
            }
            let Ok(files) = std::fs::read_dir(b.path()) else { continue };
            for f in files.flatten() {
                if !f.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let name = f.file_name().to_string_lossy().into_owned();
                if name.split('.').next().map(|k| held.contains(k)).unwrap_or(false) {
                    continue;
                }
                let digits = |t: &str| !t.is_empty() && t.len() <= 20 && t.bytes().all(|c| c.is_ascii_digit());
                // 前の削除で消し残った「消す予定」のファイル (<番号>.jsonl.del) と、dat を作り直す途中の一時ファイル
                // (<番号>.dat.tmp) は片付ける (書き足しと同じ鍵を持っているので、作り直しの途中ではない)
                if let Some(stem) = name.strip_suffix(".jsonl.del").or_else(|| name.strip_suffix(".dat.tmp")).or_else(|| name.strip_suffix(".jsonl.tmp")) {
                    if digits(stem) {
                        let _ = std::fs::remove_file(f.path());
                    }
                    continue;
                }
                // 作り直す前の dat を別名で残したもの (<番号>.<日時>.dat.bak): 1つずつ、日数・容量の決まりで消す
                if let Some(stem) = name.strip_suffix(".dat.bak") {
                    if let Some((a, b2)) = stem.split_once('.') {
                        if digits(a) && digits(b2) {
                            if let Ok(meta) = f.metadata() {
                                let item = items.entry(f.path()).or_default();
                                item.dat = Some(f.path());
                                item.size += meta.len();
                                item.modified = Some(meta.modified().unwrap_or(std::time::UNIX_EPOCH));
                            }
                        }
                    }
                    continue;
                }
                let Some((stem, ext)) = name.rsplit_once('.') else { continue };
                if !(ext == "jsonl" || ext == "dat") || stem.is_empty() || stem.len() > 20 || !stem.bytes().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                let Ok(meta) = f.metadata() else { continue };
                let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                let item = items.entry(b.path().join(stem)).or_default();
                if ext == "jsonl" { item.jsonl = Some(f.path()); } else { item.dat = Some(f.path()); }
                item.size += meta.len();
                if item.modified.map(|m| modified > m).unwrap_or(true) {
                    item.modified = Some(modified);
                }
            }
        }
    }
    let mut list: Vec<Item> = items.into_values().collect();
    list.sort_by_key(|i| i.modified);
    let now = std::time::SystemTime::now();
    let mut total: u64 = list.iter().map(|i| i.size).sum();
    let max = (max_mb as u64) * 1024 * 1024;
    let mut removed = 0;
    for item in &list {
        let modified = item.modified.unwrap_or(std::time::UNIX_EPOCH);
        let too_old = days > 0 && now.duration_since(modified).map(|d| d.as_secs() > days as u64 * 86400).unwrap_or(false);
        let too_big = max > 0 && total > max;
        if !(too_old || too_big) {
            continue;
        }
        // JSONL と dat は組で消す (片方でも消せなければ、両方残して次の機会にやり直す)
        if board_log_remove_pair(item.jsonl.as_deref(), item.dat.as_deref()) {
            removed += item.jsonl.iter().count() + item.dat.iter().count();
            total = total.saturating_sub(item.size);
        }
    }
    // 覚えている最後のレス番号・確かめ済みの印は、消したファイルの分を忘れる
    if removed > 0 {
        if let Some(state) = guard.as_mut() {
            state.last.retain(|p, _| p.is_file());
            state.dat_checked.retain(|p| p.is_file());
        }
    }
    Ok(removed)
}

/// スレのログ (JSONL と dat) を組で消す。片方でも消せなければ両方残して false を返す (片方だけ消えた状態を残さない)。
/// JSONL を先に「消す予定」の名前に変え (使用中なら変えられない)、dat を消せたら JSONL も消す。dat を消せなければ名前を戻す
fn board_log_remove_pair(jsonl: Option<&std::path::Path>, dat: Option<&std::path::Path>) -> bool {
    let pending = match jsonl {
        Some(j) => {
            let del = j.with_extension("jsonl.del");
            if std::fs::rename(j, &del).is_err() {
                return false;
            }
            Some((j, del))
        }
        None => None,
    };
    if let Some(d) = dat {
        if let Err(e) = std::fs::remove_file(d) {
            if e.kind() != std::io::ErrorKind::NotFound {
                if let Some((j, del)) = &pending {
                    if let Err(e) = std::fs::rename(del, j) {
                        eprintln!("board log: 消す予定にしたログを戻せませんでした: {e}");
                    }
                }
                return false;
            }
        }
    }
    if let Some((_, del)) = pending {
        // 消せなくても、次の削除のときに片付ける
        let _ = std::fs::remove_file(&del);
    }
    true
}

/// 掲示板のログのフォルダ (無ければ作る) をエクスプローラーで開く
#[tauri::command]
fn board_log_open_folder() -> Result<(), String> {
    let dir = board_log_dir_path()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open_folder_in_explorer(&dir)
}

#[cfg(test)]
mod board_log_tests {
    use super::*;

    #[test]
    fn location_from_thread_url() {
        assert_eq!(board_log_location("https://mao.5ch.io/test/read.cgi/ngt/9240230711/"), Some(("5ch", "ngt".to_string(), "9240230711".to_string())));
        assert_eq!(board_log_location("https://jbbs.shitaraba.net/bbs/read.cgi/game/12345/1700000000/"), Some(("shitaraba", "game_12345".to_string(), "1700000000".to_string())));
        assert_eq!(board_log_location("https://bbs.jpnkn.com/test/read.cgi/abc/1700000000/"), Some(("jpnkn", "abc".to_string(), "1700000000".to_string())));
        assert!(board_log_location("https://evil.example/test/read.cgi/a/1/").is_none());
        assert!(board_log_location("https://mao.5ch.io/test/read.cgi/../1/").is_none());
        assert!(board_log_location("https://mao.5ch.io/test/read.cgi/ngt/12ab/").is_none());
        assert!(board_log_location("https://mao.5ch.io/ngt/subject.txt").is_none());
    }

    #[test]
    fn dat_field_has_no_separator_or_newline() {
        let f = board_log_dat_field("a<>b\nc");
        assert!(!f.contains("<>") && !f.contains('\n'));
        let sj = core_fetch::encode_shift_jis("テスト😀");
        assert_eq!(core_fetch::decode_shift_jis(&sj), "テスト&#128512;");
    }

    fn test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("livefake_board_log_test_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("test dir");
        dir
    }

    fn len(p: &std::path::Path) -> Option<u64> {
        std::fs::metadata(p).ok().map(|m| m.len())
    }

    #[test]
    fn write_pair_writes_both() {
        let dir = test_dir("both");
        let (j, d) = (dir.join("1.jsonl"), dir.join("1.dat"));
        board_log_write_pair(&j, b"{\"no\":1}\n", &d, b"a<>b<>c<>d<>t\n", 1024).expect("write");
        board_log_write_pair(&j, b"{\"no\":2}\n", &d, b"a<>b<>c<>e<>\n", 1024).expect("write");
        assert_eq!(std::fs::read_to_string(&j).expect("jsonl"), "{\"no\":1}\n{\"no\":2}\n");
        assert_eq!(std::fs::read_to_string(&d).expect("dat").lines().count(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_pair_over_limit_writes_neither() {
        let dir = test_dir("limit");
        let (j, d) = (dir.join("1.jsonl"), dir.join("1.dat"));
        board_log_write_pair(&j, b"0123456789", &d, b"0123456789", 20).expect("first");
        // dat だけが上限を超える: どちらも書かない
        assert!(board_log_write_pair(&j, b"x", &d, b"0123456789AB", 20).is_err());
        assert_eq!((len(&j), len(&d)), (Some(10), Some(10)));
        // JSONL だけが上限を超える: どちらも書かない
        assert!(board_log_write_pair(&j, b"0123456789AB", &d, b"x", 20).is_err());
        assert_eq!((len(&j), len(&d)), (Some(10), Some(10)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    // テストで読み取り専用にしたファイルを元に戻すため (Unix で誰でも書けるようになる、という注意はこのテストには当たらない)
    #[allow(clippy::permissions_set_readonly_false)]
    fn write_pair_rolls_back_dat_when_jsonl_fails() {
        let dir = test_dir("rollback");
        let (j, d) = (dir.join("1.jsonl"), dir.join("1.dat"));
        board_log_write_pair(&j, b"{\"no\":1}\n", &d, b"line1\n", 1024).expect("first");
        // JSONL を書けなくする (読み取り専用): dat も書く前の長さに戻る
        let mut perm = std::fs::metadata(&j).expect("meta").permissions();
        perm.set_readonly(true);
        std::fs::set_permissions(&j, perm.clone()).expect("readonly");
        assert!(board_log_write_pair(&j, b"{\"no\":2}\n", &d, b"line2\n", 1024).is_err());
        assert_eq!(std::fs::read_to_string(&d).expect("dat"), "line1\n");
        assert_eq!(std::fs::read_to_string(&j).expect("jsonl"), "{\"no\":1}\n");
        perm.set_readonly(false);
        std::fs::set_permissions(&j, perm).expect("writable");
        // 書けるようになれば、同じ分を二重にせずに書ける
        board_log_write_pair(&j, b"{\"no\":2}\n", &d, b"line2\n", 1024).expect("retry");
        assert_eq!(std::fs::read_to_string(&j).expect("jsonl"), "{\"no\":1}\n{\"no\":2}\n");
        assert_eq!(std::fs::read_to_string(&d).expect("dat"), "line1\nline2\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_pair_removes_both() {
        let dir = test_dir("rm_both");
        let (j, d) = (dir.join("1.jsonl"), dir.join("1.dat"));
        std::fs::write(&j, "a").expect("jsonl");
        std::fs::write(&d, "b").expect("dat");
        assert!(board_log_remove_pair(Some(&j), Some(&d)));
        assert!(!j.exists() && !d.exists() && !dir.join("1.jsonl.del").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_pair_keeps_both_when_dat_cannot_be_removed() {
        let dir = test_dir("rm_keep");
        let (j, d) = (dir.join("1.jsonl"), dir.join("1.dat"));
        std::fs::write(&j, "a").expect("jsonl");
        // dat を消せない (同じ名前のフォルダがあって中身もある): JSONL も元の名前のまま残る
        std::fs::create_dir_all(d.join("x")).expect("dir in the way");
        assert!(!board_log_remove_pair(Some(&j), Some(&d)));
        assert_eq!(std::fs::read_to_string(&j).expect("jsonl kept"), "a");
        assert!(!dir.join("1.jsonl.del").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn res(no: u32) -> BoardLogRes {
        BoardLogRes {
            no,
            name: format!("n{no}"),
            mail: String::new(),
            date_and_id: "2026/11/16 ID:abc".into(),
            body: format!("b{no}"),
            name_text: format!("n{no}"),
            uid: "abc".into(),
            posted: "2026/11/16".into(),
            text: format!("b{no}"),
        }
    }

    #[test]
    fn check_dat_rebuilds_mismatched_dat_from_full_rows() {
        let dir = test_dir("check_dat");
        let (j, d) = (dir.join("1.jsonl"), dir.join("1.dat"));
        std::fs::write(&j, "{\"type\":\"start\"}\n{\"no\":1}\n{\"no\":2}\n{\"no\":3}\n").expect("jsonl");
        std::fs::write(&d, "only3<><><>b3<>\n").expect("dat");
        let nos = board_log_jsonl_nos(&j).expect("nos");
        assert_eq!(nos, vec![1, 2, 3]);
        // 行数が合わない: 途中のレスしか無いときは、スレ全体を頼む
        assert!(matches!(board_log_check_dat(&j, &d, &nos, &[res(4)], false, "t", 1 << 20).expect("check"), DatCheck::NeedFull));
        // スレ全体があれば、JSONL の番号の分で dat を作り直す (JSONL は変えない)
        let all = vec![res(1), res(2), res(3), res(4)];
        assert!(matches!(board_log_check_dat(&j, &d, &nos, &all, true, "t", 1 << 20).expect("check"), DatCheck::Done));
        let text = std::fs::read_to_string(&d).expect("dat");
        assert_eq!(text.lines().count(), 3);
        assert!(text.starts_with("n1<><>2026/11/16 ID:abc<>b1<>t\n") && text.ends_with("b3<>\n"));
        assert!(!dir.join("1.dat.tmp").exists());
        // 足りないレスがあれば作り直さない (直す待ち。そのまま書き足しに進む)
        std::fs::write(&d, "x<><><>y<>\n").expect("dat");
        assert!(matches!(board_log_check_dat(&j, &d, &nos, &[res(1), res(3)], true, "t", 1 << 20).expect("check"), DatCheck::Short(ref m) if m == &vec![2]));
        assert_eq!(std::fs::read_to_string(&d).expect("dat"), "x<><><>y<>\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn jsonl_nos_errors_when_unreadable() {
        let dir = test_dir("nos_err");
        // 読めない (ファイルの場所にフォルダがある): 0件ではなくエラー
        std::fs::create_dir_all(dir.join("1.jsonl")).expect("dir");
        assert!(board_log_jsonl_nos(&dir.join("1.jsonl")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    const URL: &str = "https://mao.5ch.io/test/read.cgi/ngt/9240230711/";

    fn append(base: &std::path::Path, rows: &[u32], full: bool) -> Result<BoardLogAppendResult, String> {
        board_log_append_in(base, URL.into(), "t".into(), "ngt".into(), rows.iter().map(|n| res(*n)).collect(), Some(full))
    }

    fn files(base: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
        let d = base.join("5ch").join("ngt");
        (d.join("9240230711.jsonl"), d.join("9240230711.dat"))
    }

    fn jsonl_nos_of(p: &std::path::Path) -> Vec<u32> {
        std::fs::read_to_string(p).expect("jsonl").lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter_map(|v| v.get("no").and_then(|n| n.as_u64()).map(|n| n as u32))
            .collect()
    }

    fn dat_lines_of(p: &std::path::Path) -> usize {
        std::fs::read(p).expect("dat").iter().filter(|&&c| c == b'\n').count()
    }

    #[test]
    fn append_after_read_error_does_not_duplicate() {
        let base = test_dir("append_readerr");
        let (j, d) = files(&base);
        assert_eq!(append(&base, &[1, 2], true).expect("first").written, 2);
        // 別の起動のつもりで覚えた番号を忘れさせ、JSONL を読めなくする (読み取り専用ではなく、名前を変えて無くす代わりにフォルダにする)
        if let Some(st) = BOARD_LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner()).as_mut() { st.last.remove(&j); st.dat_checked.remove(&j); }
        let saved = std::fs::read(&j).expect("save");
        std::fs::remove_file(&j).expect("rm");
        std::fs::create_dir_all(&j).expect("dir in the way");
        assert!(append(&base, &[1, 2, 3], true).is_err());
        // 読めるようになったら、重複せずに 3 だけ足す
        std::fs::remove_dir_all(&j).expect("rmdir");
        std::fs::write(&j, saved).expect("restore");
        append(&base, &[1, 2, 3], true).expect("retry");
        assert_eq!(jsonl_nos_of(&j), vec![1, 2, 3]);
        assert_eq!(dat_lines_of(&d), 3);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn append_replaces_leftover_dat_when_jsonl_is_missing() {
        let base = test_dir("append_datonly");
        let (j, d) = files(&base);
        std::fs::create_dir_all(d.parent().expect("parent")).expect("dir");
        // dat だけが残っている (前の版・削除の途中で止まった): 足さずに作り直す
        std::fs::write(&d, "old1<><><>x<>t\nold2<><><>y<>\n").expect("dat");
        std::fs::write(j.with_extension("jsonl.del"), "{}\n").expect("del");
        append(&base, &[1, 2, 3], true).expect("write");
        assert_eq!(jsonl_nos_of(&j), vec![1, 2, 3]);
        assert_eq!(dat_lines_of(&d), 3);
        assert!(!j.with_extension("jsonl.del").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn append_repairs_dat_later_when_rows_become_available() {
        let base = test_dir("append_pending");
        let (j, d) = files(&base);
        append(&base, &[1, 2, 3], true).expect("first");
        // 別の起動のつもり: dat が1行に減っている
        std::fs::write(&d, "n1<><><>b1<>t\n").expect("dat");
        if let Some(st) = BOARD_LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner()).as_mut() { st.last.remove(&j); st.dat_checked.remove(&j); st.dat_pending.remove(&j); }
        // 新しいレスだけ: スレ全体を頼む
        assert!(append(&base, &[4], false).expect("need full").need_full);
        // スレ全体を渡されたが、2 が無い: 直す待ちにして、書き足しは続ける (スレ全体を頼み直さない)
        let r = append(&base, &[1, 3, 4], true).expect("short");
        assert!(!r.need_full && r.written == 1);
        assert!(!append(&base, &[5], false).expect("append").need_full);
        assert_eq!(jsonl_nos_of(&j), vec![1, 2, 3, 4, 5]);
        // あとでレスが全部そろって渡されたら、dat を JSONL に合わせて作り直す
        append(&base, &[1, 2, 3, 4, 5], true).expect("repair");
        assert_eq!(dat_lines_of(&d), 5);
        assert_eq!(jsonl_nos_of(&j), vec![1, 2, 3, 4, 5]);
        let _ = std::fs::remove_dir_all(&base);
    }

    fn bak_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut v: Vec<_> = std::fs::read_dir(dir).expect("dir").flatten().map(|e| e.path())
            .filter(|p| p.to_string_lossy().ends_with(".dat.bak")).collect();
        v.sort();
        v
    }

    #[cfg(windows)]
    fn lock_exclusive(path: &std::path::Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().read(true).share_mode(0).open(path).expect("lock")
    }

    #[cfg(windows)]
    #[test]
    fn locked_prev_holds_append_and_prune() {
        // 作り直しの途中 (元の組を .prev に移したあと) で止まり、次の起動で .jsonl.prev がロックされている
        let (base, j, d) = interrupted_rebuild("recover_locked", 3);
        let dir = d.parent().expect("p").to_path_buf();
        let jprev = dir.join("9240230711.jsonl.prev");
        let lock = lock_exclusive(&jprev);
        // 戻せない間は書き足さない (4 番だけの新しい JSONL を作らない)
        assert!(append(&base, &[4], false).is_err(), "戻せない間は書き足しをエラーにする");
        assert!(!j.exists(), "4 番だけの JSONL を作らない");
        // 整理しても、元の組を消さない
        board_log_prune_in(&base, 0, 0).expect("prune");
        assert!(jprev.exists(), "整理で元の JSONL を消さない");
        drop(lock);
        // ロックが外れたら、元の組 (1・3) に戻してから書き足す
        append(&base, &[4], false).expect("after unlock");
        assert_eq!(jsonl_nos_of(&j), vec![1, 3, 4]);
        assert_eq!(dat_lines_of(&d), 3);
        assert!(!jprev.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn locked_old_dat_after_rebuild_keeps_logging() {
        // 新しい組 (1・2・3) を置き終えたあと、元の組を消す前に止まった。次の起動で古い dat (.dat.prev) が使用中
        let (base, j, d) = interrupted_rebuild("rebuilt_lock", 5);
        let dir = d.parent().expect("p").to_path_buf();
        let dprev = dir.join("9240230711.dat.prev");
        let lock = lock_exclusive(&dprev);
        append(&base, &[4], false).expect("古い dat が使用中でも、新しい組には書き足せる");
        assert_eq!(jsonl_nos_of(&j), vec![1, 2, 3, 4]);
        board_log_prune_in(&base, 0, 0).expect("prune");
        drop(lock);
        // ロックが外れたあとも書き足せ、古い組の消し残しと印が片付く
        append(&base, &[5], false).expect("解除後も書き足せる");
        assert_eq!(jsonl_nos_of(&j), vec![1, 2, 3, 4, 5]);
        assert_eq!(dat_lines_of(&d), 5);
        let names: Vec<String> = std::fs::read_dir(&dir).expect("dir").flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().all(|n| !n.contains(".prev") && !n.contains(".rebuilt")), "{names:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn old_version_leftover_dat_prev_is_cleaned() {
        // 前の版の片付けで、古い dat (.dat.prev) だけ消し残した状態 (新しい組 1・2・3 はそろっている)
        let (base, j, d) = interrupted_rebuild("rebuilt_legacy", 5);
        let dir = d.parent().expect("p").to_path_buf();
        std::fs::remove_file(dir.join("9240230711.jsonl.prev")).expect("jprev");
        append(&base, &[4], false).expect("新しい組に書き足せる");
        assert_eq!(jsonl_nos_of(&j), vec![1, 2, 3, 4]);
        let names: Vec<String> = std::fs::read_dir(&dir).expect("dir").flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().all(|n| !n.contains(".prev") && !n.contains(".rebuilt")), "{names:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn tabs_copy_failure_holds_file_and_tells_screen() {
        let out = r#"{"tabs":[],"activeIndex":0,"dropped":1}"#.to_string();
        let mut held = false;
        let res = keep_copy_or_hold(out.clone(), || Err("書けません".into()), || held = true);
        assert!(held, "写しを残せなければ、上書きしない");
        let v: serde_json::Value = serde_json::from_str(&res).expect("json");
        assert_eq!(v["copyFailed"], true, "画面へ知らせる");
        let mut held2 = false;
        assert_eq!(keep_copy_or_hold(out.clone(), || Ok("copy".into()), || held2 = true), out);
        assert!(!held2);
    }

    #[test]
    fn session_tabs_invalid_entries_are_dropped() {
        let raw = r#"{"tabs":[{"threadUrl":"https://a/1/","title":"A"},null,{"title":"URL なし"},{"threadUrl":"https://b/2/","title":5}],"activeIndex":3}"#;
        let (out, dropped) = sanitize_session_tabs(raw, "threadUrl");
        assert_eq!(dropped, 2, "null と URL の無い1件を外す");
        let v: serde_json::Value = serde_json::from_str(&out).expect("json");
        let tabs = v["tabs"].as_array().expect("tabs");
        assert_eq!(tabs.len(), 2);
        assert_eq!(tabs[1]["title"], "", "題名が文字列でなければ空にする");
        assert_eq!(v["activeIndex"], 1, "表示していたタブ (4件目) の位置を、外した分だけずらす");
        assert_eq!(v["dropped"], 2);
        // 正常な一覧はそのまま
        let ok = r#"{"tabs":[{"threadUrl":"https://a/1/","title":"A"}],"activeIndex":0}"#;
        assert_eq!(sanitize_session_tabs(ok, "threadUrl"), (ok.to_string(), 0));
        // 板のタブ (boardUrl)
        let (_, d2) = sanitize_session_tabs(r#"{"tabs":[{"boardUrl":"https://a/b/","title":"B"},null],"activeIndex":0}"#, "boardUrl");
        assert_eq!(d2, 1);
    }

    #[test]
    fn leftover_dat_is_kept_as_backup_when_rows_do_not_cover_it() {
        let base = test_dir("bak_keep");
        let (j, d) = files(&base);
        let dir = d.parent().expect("parent").to_path_buf();
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(&d, "o1<><><>x<>t\no2<><><>y<>\no3<><><>z<>\n").expect("dat");
        // 手元に 1 番しか無い: 新しく作ってよいが、元の 3 行は別名で残す (消さない)
        let r = append(&base, &[1], true).expect("write");
        assert!(!r.need_full);
        assert_eq!(jsonl_nos_of(&j), vec![1]);
        assert_eq!(dat_lines_of(&d), 1);
        let baks = bak_files(&dir);
        assert_eq!(baks.len(), 1, "元の dat を別名で残す");
        assert_eq!(dat_lines_of(&baks[0]), 3);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// アプリが作るのと同じ形の dat (行の中身が一字一句そろう)
    fn dat_of(nos: &[u32]) -> Vec<u8> {
        let rows: Vec<BoardLogRes> = nos.iter().map(|n| res(*n)).collect();
        let refs: Vec<&BoardLogRes> = rows.iter().collect();
        core_fetch::encode_shift_jis(&board_log_dat_lines(&refs, "t", true))
    }

    #[test]
    fn leftover_dat_backup_is_removed_when_rows_cover_it() {
        let base = test_dir("bak_cover");
        let (j, d) = files(&base);
        let dir = d.parent().expect("parent").to_path_buf();
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(&d, dat_of(&[1, 2])).expect("dat");
        // 元の各行が新しい dat にそのまま入る: 別名は残さない
        append(&base, &[1, 2, 3], true).expect("write");
        assert_eq!(jsonl_nos_of(&j), vec![1, 2, 3]);
        assert_eq!(dat_lines_of(&d), 3);
        assert!(bak_files(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn leftover_dat_and_partial_rows_asks_for_full() {
        let base = test_dir("bak_needfull");
        let (j, d) = files(&base);
        std::fs::create_dir_all(d.parent().expect("parent")).expect("dir");
        std::fs::write(&d, "o1<><><>x<>t\n").expect("dat");
        // 新しいレスしか無い (スレ全体ではない): まずスレ全体を頼む。何も変えない
        assert!(append(&base, &[5], false).expect("need").need_full);
        assert!(!j.exists());
        assert_eq!(dat_lines_of(&d), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn leftover_dat_is_untouched_when_rebuild_fails() {
        let base = test_dir("bak_locked");
        let (j, d) = files(&base);
        let dir = d.parent().expect("parent").to_path_buf();
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(&d, dat_of(&[1, 2])).expect("dat");
        let del = j.with_extension("jsonl.del");
        std::fs::write(&del, "{}\n").expect("del");
        // 残っていた dat がロックされていて別名にできない: 何も変えずにエラー (元の dat は消えない)
        let lock = lock_exclusive(&d);
        assert!(append(&base, &[1, 2], true).is_err());
        drop(lock);
        assert_eq!(dat_lines_of(&d), 2);
        assert!(!j.exists());
        assert!(bak_files(&dir).is_empty());
        // ロックが外れれば作り直せる (元の 2 行は手元のレスで作り直せるので、別名は残らない)
        append(&base, &[1, 2], true).expect("retry");
        assert_eq!(jsonl_nos_of(&j), vec![1, 2]);
        assert_eq!(dat_lines_of(&d), 2);
        assert!(!del.exists());
        assert!(bak_files(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn leftover_dat_with_gaps_keeps_backup() {
        let base = test_dir("bak_gaps");
        let (j, d) = files(&base);
        let dir = d.parent().expect("parent").to_path_buf();
        std::fs::create_dir_all(&dir).expect("dir");
        // 古い dat は 1 番と 3 番の 2 行 (欠番あり)。手元には 1 番と 2 番: 行数は同じでも、3 番は作り直せない
        let old1 = String::from_utf8(core_fetch::encode_shift_jis(&board_log_dat_lines(&[&res(1)], "t", true))).unwrap_or_default();
        let old3 = String::from_utf8(core_fetch::encode_shift_jis(&board_log_dat_lines(&[&res(3)], "t", false))).unwrap_or_default();
        std::fs::write(&d, format!("{old1}{old3}")).expect("dat");
        append(&base, &[1, 2], true).expect("write");
        assert_eq!(jsonl_nos_of(&j), vec![1, 2]);
        let baks = bak_files(&dir);
        assert_eq!(baks.len(), 1, "3 番の行を作り直せていないので、別名を残す");
        assert!(std::fs::read_to_string(&baks[0]).expect("bak").contains("b3"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn later_full_rows_fill_gaps_in_number_order() {
        let base = test_dir("fill_gaps");
        let (j, d) = files(&base);
        // 1 番と 3 番だけが書かれている (2 番は手元に無かった)
        append(&base, &[1, 3], true).expect("first");
        assert_eq!(jsonl_nos_of(&j), vec![1, 3]);
        // あとで 1〜4 番がそろってスレ全体を渡された: 抜けていた 2 番も、番号順に補う
        append(&base, &[1, 2, 3, 4], true).expect("fill");
        assert_eq!(jsonl_nos_of(&j), vec![1, 2, 3, 4]);
        assert_eq!(dat_lines_of(&d), 4);
        let text = std::fs::read_to_string(&d).expect("dat");
        let bodies: Vec<&str> = text.lines().map(|l| l.split("<>").nth(3).unwrap_or("")).collect();
        assert_eq!(bodies, vec!["b1", "b2", "b3", "b4"], "dat も番号順");
        let titles: Vec<&str> = text.lines().map(|l| l.split("<>").nth(4).unwrap_or("")).collect();
        assert_eq!(titles, vec!["t", "", "", ""], "スレタイは 1 行目だけ");
        assert!(bak_files(d.parent().expect("p")).is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn fill_gaps_keeps_old_pair_when_rebuild_fails() {
        let base = test_dir("fill_fail");
        let (j, d) = files(&base);
        append(&base, &[1, 3], true).expect("first");
        let before_j = std::fs::read(&j).expect("j");
        let before_d = std::fs::read(&d).expect("d");
        // dat がロックされていて置き換えられない: 何も変えずにエラー
        let lock = lock_exclusive(&d);
        assert!(append(&base, &[1, 2, 3, 4], true).is_err());
        drop(lock);
        assert_eq!(std::fs::read(&j).expect("j"), before_j);
        assert_eq!(std::fs::read(&d).expect("d"), before_d);
        // ロックが外れれば補える
        append(&base, &[1, 2, 3, 4], true).expect("retry");
        assert_eq!(jsonl_nos_of(&j), vec![1, 2, 3, 4]);
        assert_eq!(dat_lines_of(&d), 4);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn leftover_dat_with_duplicate_lines_keeps_backup() {
        let base = test_dir("bak_dup");
        let (_j, d) = files(&base);
        let dir = d.parent().expect("parent").to_path_buf();
        std::fs::create_dir_all(&dir).expect("dir");
        // 2 番と 3 番がまったく同じ中身の投稿 (同じ行が2つ。1行目はスレタイが付くので避ける)。古い dat は 1・2・3 の3行
        let same = |no: u32| BoardLogRes { no, name: "同じ".into(), mail: String::new(), date_and_id: "2026/11/16 ID:x".into(), body: "同じ本文".into(), name_text: "同じ".into(), uid: "x".into(), posted: "2026/11/16".into(), text: "同じ本文".into() };
        let rows_old = [res(1), same(2), same(3)];
        let refs: Vec<&BoardLogRes> = rows_old.iter().collect();
        std::fs::write(&d, core_fetch::encode_shift_jis(&board_log_dat_lines(&refs, "t", true))).expect("dat");
        // 手元には 1 番と 2 番だけ: 新しい dat は 2 行。同じ行は 1 回しか入らないので、別名は残す
        let r = board_log_append_in(&base, URL.into(), "t".into(), "ngt".into(), vec![res(1), same(2)], Some(true)).expect("write");
        assert!(!r.need_full);
        assert_eq!(bak_files(&dir).len(), 1, "同じ行の数まで照らし合わせ、足りなければ別名を残す");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 番号順に作り直す途中で止まった状態を作る (止まった段階: 2 = dat だけ移した / 3 = 両方移した / 4 = 新しい dat を置いた / 5 = 両方置いた)
    fn interrupted_rebuild(name: &str, step: u32) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let base = test_dir(name);
        let (j, d) = files(&base);
        append(&base, &[1, 3], true).expect("first");
        let dir = d.parent().expect("p").to_path_buf();
        let (jprev, dprev) = (dir.join("9240230711.jsonl.prev"), dir.join("9240230711.dat.prev"));
        let new_j = b"{\"type\":\"start\"}\n{\"no\":1}\n{\"no\":2}\n{\"no\":3}\n";
        let new_d = b"a<><><>1<>t\na<><><>2<>\na<><><>3<>\n";
        std::fs::write(dir.join("9240230711.jsonl.tmp"), new_j).expect("jt");
        std::fs::write(dir.join("9240230711.dat.tmp"), new_d).expect("dt");
        if step >= 2 { std::fs::rename(&d, &dprev).expect("2"); }
        if step >= 3 { std::fs::rename(&j, &jprev).expect("3"); }
        if step >= 4 { std::fs::rename(dir.join("9240230711.dat.tmp"), &d).expect("4"); }
        if step >= 5 { std::fs::rename(dir.join("9240230711.jsonl.tmp"), &j).expect("5"); }
        (base, j, d)
    }

    #[test]
    fn interrupted_rebuild_is_recovered_on_prune() {
        for step in [2u32, 3, 4] {
            let (base, j, d) = interrupted_rebuild(&format!("recover_{step}"), step);
            // 日数・容量とも無制限で削除を動かす (起動したときと同じ): 元の組 (1・3) に戻り、何も失わない
            board_log_prune_in(&base, 0, 0).expect("prune");
            assert_eq!(jsonl_nos_of(&j), vec![1, 3], "段階 {step}: JSONL が元に戻る");
            assert_eq!(dat_lines_of(&d), 2, "段階 {step}: dat が元に戻る");
            let names: Vec<String> = std::fs::read_dir(d.parent().expect("p")).expect("dir").flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            assert!(names.iter().all(|n| !n.contains(".prev") && !n.contains(".tmp")), "段階 {step}: 途中のファイルが残らない: {names:?}");
            let _ = std::fs::remove_dir_all(&base);
        }
        // 両方置き終わったあと (消す前) に止まった: 新しい組 (1・2・3) のまま、元の組の名残を片付ける
        let (base, j, d) = interrupted_rebuild("recover_5", 5);
        board_log_prune_in(&base, 0, 0).expect("prune");
        assert_eq!(jsonl_nos_of(&j), vec![1, 2, 3]);
        assert_eq!(dat_lines_of(&d), 3);
        let names: Vec<String> = std::fs::read_dir(d.parent().expect("p")).expect("dir").flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().all(|n| !n.contains(".prev") && !n.contains(".tmp")), "{names:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn short_repair_reports_missing_numbers() {
        let base = test_dir("repair_missing");
        let (j, d) = files(&base);
        append(&base, &[1, 2, 3], true).expect("first");
        std::fs::write(&d, "n1<><><>b1<>t\n").expect("dat");
        if let Some(st) = BOARD_LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner()).as_mut() { st.last.remove(&j); st.dat_checked.remove(&j); st.dat_pending.remove(&j); }
        assert!(append(&base, &[4], false).expect("need full").need_full);
        // 2 が足りない: 足りない番号を画面側に返す (画面側は、そろったらスレ全体を一度だけ渡す)
        let r = append(&base, &[1, 3, 4], true).expect("short");
        assert_eq!(r.repair_missing, vec![2]);
        // ふだんの書き足しでも、直す待ちの間は足りない番号を返し続ける
        let r2 = append(&base, &[5], false).expect("append");
        assert_eq!(r2.repair_missing, vec![2]);
        // そろって渡されたら直り、足りない番号は空になる
        let r3 = append(&base, &[1, 2, 3, 4, 5], true).expect("repair");
        assert!(r3.repair_missing.is_empty());
        assert_eq!(dat_lines_of(&d), 5);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn prune_handles_backup_and_temp_files() {
        let base = test_dir("prune_bak");
        let dir = base.join("5ch").join("ngt");
        std::fs::create_dir_all(&dir).expect("dir");
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(10 * 86400);
        let set_old = |p: &std::path::Path| { std::fs::File::options().write(true).open(p).expect("open").set_modified(old).expect("mtime"); };
        // 古い別名の dat・作り直し途中の一時ファイル・消す予定の JSONL・新しいログの組
        let bak = dir.join("100.20261101000000000.dat.bak");
        std::fs::write(&bak, "a<><><>b<>\n").expect("bak");
        set_old(&bak);
        std::fs::write(dir.join("100.dat.tmp"), "x").expect("tmp");
        std::fs::write(dir.join("100.jsonl.del"), "x").expect("del");
        std::fs::write(dir.join("200.jsonl"), "{}\n").expect("jsonl");
        std::fs::write(dir.join("200.dat"), "a<><><>b<>\n").expect("dat");
        // 名前の形が違うものには触らない
        std::fs::write(dir.join("memo.txt"), "keep").expect("other");
        board_log_prune_in(&base, 5, 0).expect("prune");
        assert!(!bak.exists(), "日数を過ぎた別名の dat は消す");
        assert!(!dir.join("100.dat.tmp").exists() && !dir.join("100.jsonl.del").exists(), "途中のファイルは片付ける");
        assert!(dir.join("200.jsonl").exists() && dir.join("200.dat").exists(), "新しいログは残す");
        assert!(dir.join("memo.txt").exists(), "ほかのファイルには触らない");
        // 容量: 別名の dat も数に入る
        let bak2 = dir.join("300.20261101000000000.dat.bak");
        std::fs::write(&bak2, vec![b'a'; 2 * 1024 * 1024]).expect("big bak");
        set_old(&bak2);
        board_log_prune_in(&base, 0, 1).expect("prune size");
        assert!(!bak2.exists(), "容量の上限にも別名の dat を数える (古いものから消す)");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn write_pair_removes_new_dat_when_jsonl_fails() {
        let dir = test_dir("newfile");
        let (j, d) = (dir.join("1.jsonl"), dir.join("1.dat"));
        // JSONL の場所にフォルダがあって書けない: 新しく作った dat は消える
        std::fs::create_dir_all(&j).expect("dir in the way");
        assert!(board_log_write_pair(&j, b"{\"no\":1}\n", &d, b"line1\n", 1024).is_err());
        assert!(!d.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 起動してから「あるのに読めなかった」データファイルの名前 (その起動の間は上書きしない。画面側が知らせる)
#[tauri::command]
fn data_unreadable_files() -> Vec<String> {
    let base = core_store::portable_data_dir().ok();
    // 壊れていたファイルは名前の後ろに印を付ける (画面側で分けて知らせる)
    let broken = core_store::broken_paths().into_iter().map(|p| { let mut s = p.into_os_string(); s.push("\u{1}broken"); std::path::PathBuf::from(s) });
    core_store::unreadable_paths()
        .into_iter()
        .chain(broken)
        .map(|p| base.as_ref().and_then(|b| p.strip_prefix(b).ok()).map(|r| r.to_string_lossy().into_owned()).unwrap_or_else(|| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
        .collect()
}

/// データフォルダをエクスプローラーで開く (Web ページを開く命令は http(s) しか受け付けないため、別に用意する)
#[tauri::command]
fn open_data_folder() -> Result<(), String> {
    let dir = core_store::portable_data_dir().map_err(|e| e.to_string())?;
    open_folder_in_explorer(&dir)
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
    // あるのに読めないときはエラー (無い・壊れていたときは null)。読めなかったファイルは、その起動の間は上書きしない
    Ok(core_store::load_json_opt::<serde_json::Value>(&filename).map_err(|e| e.to_string())?.unwrap_or(serde_json::Value::Null))
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
    // あるのに読めない (ロック中など) ときはエラーにする (画面側は、読めるまで配信への出力を止めて読み直す)。
    // 無いときは空の NG (初めて使うとき)
    // Try new name first, fall back to old name and migrate
    // 壊れている・形が違うときもエラー (空として通さない。古い名前のファイルで上書きもしない)
    // 中身のある JSON なのに知っている項目が1つも無いときも同じ (知らない形を空として読まない)
    const KNOWN: &[&str] = &["words", "ids", "names", "mails", "thread_words", "image_words", "invisible"];
    if let Some(data) = core_store::load_json_strict_known_opt::<NgFilters>("ng-settings.json", KNOWN).map_err(|e| e.to_string())? {
        return Ok(data);
    }
    if let Some(data) = core_store::load_json_strict_known_opt::<NgFilters>("ng_filters.json", KNOWN).map_err(|e| e.to_string())? {
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
    // あるのに読めないときはエラー (画面側は、読めるまで配信への出力を止めて読み直す)。無いときは空
    // 壊れている・形が違うときもエラー (空として通すと、読ませない語を読み上げるため)
    // 中身のある JSON なのに知っている項目が1つも無いときも同じ (知らない形を空として読み、空で上書きしないように)
    Ok(core_store::load_json_strict_known_opt::<TtsMuteDict>("tts-mute-dict.json", &["names", "words", "ids"]).map_err(|e| e.to_string())?.unwrap_or_default())
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

/// 保存したタブの一覧を1件ずつ確かめる。URL (url_key: threadUrl / boardUrl) が文字列でないもの (null など) は外し、
/// 題名が文字列でなければ空にする。表示していたタブの位置も、外した分だけずらす。
/// 戻り値は (確かめたあとの一覧の JSON。外した件数を "dropped" に入れる, 外した件数)
fn sanitize_session_tabs(raw: &str, url_key: &str) -> (String, usize) {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(raw) else { return (String::new(), 0) };
    let Some(tabs) = v.get("tabs").and_then(|t| t.as_array()).cloned() else { return (String::new(), 0) };
    let active = v.get("activeIndex").and_then(|a| a.as_u64()).unwrap_or(0) as usize;
    let mut kept: Vec<serde_json::Value> = Vec::new();
    let mut new_active = 0usize;
    for (i, t) in tabs.into_iter().enumerate() {
        let ok = t.get(url_key).and_then(|u| u.as_str()).map(|u| !u.trim().is_empty()).unwrap_or(false);
        if !ok {
            continue;
        }
        let mut t = t;
        if let Some(obj) = t.as_object_mut() {
            if !obj.get("title").map(|x| x.is_string()).unwrap_or(false) {
                obj.insert("title".into(), serde_json::Value::String(String::new()));
            }
        }
        if i <= active {
            new_active = kept.len();
        }
        kept.push(t);
    }
    let total = v.get("tabs").and_then(|t| t.as_array()).map(|a| a.len()).unwrap_or(0);
    let dropped = total - kept.len();
    if dropped == 0 {
        return (raw.to_string(), 0);
    }
    if let Some(obj) = v.as_object_mut() {
        obj.insert("tabs".into(), serde_json::Value::Array(kept));
        obj.insert("activeIndex".into(), serde_json::json!(new_active));
        obj.insert("dropped".into(), serde_json::json!(dropped));
    }
    (v.to_string(), dropped)
}

/// 使えない分を外した一覧を返す前に、元のファイルの写しを残す。残せなかったら、その起動の間はファイルを上書きせず、
/// 一覧に "copyFailed": true を入れて画面へ知らせる (画面は「写しを残せなかったので、このファイルには保存しません」と知らせる)
fn keep_copy_or_hold(out: String, keep: impl FnOnce() -> Result<String, String>, hold: impl FnOnce()) -> String {
    if let Err(e) = keep() {
        eprintln!("写しを残せませんでした (この起動の間は上書きしません): {e}");
        hold();
        if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&out) {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("copyFailed".into(), serde_json::Value::Bool(true));
                return v.to_string();
            }
        }
    }
    out
}

/// 保存したタブの一覧を読み、1件ずつ確かめる (外したものがあれば、元のファイルの写しを残す)
fn load_session_tabs_file(file: &str, url_key: &str) -> String {
    let raw = core_store::load_json_string_checked(file, |v| v.get("tabs").map(|t| t.is_array()).unwrap_or(false)).unwrap_or_default();
    if raw.is_empty() {
        return raw;
    }
    let (out, dropped) = sanitize_session_tabs(&raw, url_key);
    if dropped == 0 {
        return out;
    }
    keep_copy_or_hold(out, || core_store::keep_dated_copy(file).map_err(|e| e.to_string()), || core_store::hold_overwrite(file))
}

#[tauri::command]
fn load_session_tabs() -> Result<String, String> {
    // 中のタブの一覧まで読めて初めて「読めた」とする (中だけ壊れていたら、写しを残して空を返す)。
    // 一覧の中の壊れた1件 (null など) は外して、残りを戻す (外したら写しを残し、件数を画面へ渡す)
    Ok(load_session_tabs_file("session_tabs.json", "threadUrl"))
}

#[tauri::command]
fn save_session_board_tabs(data: String) -> Result<(), String> {
    core_store::save_json("session_board_tabs.json", &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_session_board_tabs() -> Result<String, String> {
    Ok(load_session_tabs_file("session_board_tabs.json", "boardUrl"))
}

#[tauri::command]
fn load_layout_prefs() -> Result<String, String> {
    Ok(core_store::load_json_string_checked("layout_prefs.json", |v| v.is_object()).unwrap_or_default())
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

/// 読めなかった設定ファイルを、通信の前に読み直す (読めたら、保存してあるプロキシの設定を返す)。
/// 読めなかったことの覚えは変えない (画面が持っている既定値で、設定ファイルを上書きできるようにしないため)
fn reload_proxy_settings() -> Option<core_proxy::ProxySettings> {
    let map = core_store::peek_settings_ini().ok()?.unwrap_or_default();
    let payload = proxy_payload_from_ini(&map);
    let _ = core_store::append_log(&format!("proxy: 設定ファイルを読めるようになったので、保存してある設定を反映しました enabled={}", payload.enabled));
    Some(payload.to_settings())
}

/// 起動時: 保存してあるプロキシの設定を通信に反映する。
/// 設定ファイルがあるのに読めないとき (ほかのプログラムが使用中など) は、プロキシを使う設定かどうかが分からないので、
/// 読めるまで掲示板との通信を通さない (既定値の「使わない」で通信して、接続元を伝えてしまわないように)
fn init_proxy_settings() {
    let map = match core_store::load_settings_ini() {
        Ok(map) => map,
        Err(e) => {
            let _ = core_store::append_log_level("WARN", &format!("proxy: 設定ファイルを読めないため、読めるまで掲示板との通信を止めます: {e}"));
            core_proxy::hold_until_readable(reload_proxy_settings);
            return;
        }
    };
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
    // 読めないときに既定値 (使わない) を「保存してある設定」として返さない (画面からそのまま保存されると、設定が消えるため)
    // 「起動したときに読めなかった」の覚えは変えない読み方をする (ここで読めたことにすると、画面の既定値で設定ファイルを上書きできるようになる)
    let map = core_store::peek_settings_ini().map_err(|e| format!("設定ファイル (settings.ini) を読めませんでした: {e}"))?.unwrap_or_default();
    Ok(proxy_payload_from_ini(&map))
}

/// 保存して、次の通信から使う (パスワードは DPAPI で暗号化して保存。ログには出さない)
#[tauri::command]
fn save_proxy_settings(settings: ProxySettingsPayload) -> Result<(), String> {
    // 両方とも成功してから書き込む。失敗時は既存の設定と実行中の接続を維持する。
    let receive_password = core_proxy::protect_password_for_storage(&settings.receive.password)?;
    let send_password = core_proxy::protect_password_for_storage(&settings.send.password)?;
    let mut updates = HashMap::new();
    updates.insert("Proxy.ProxyEnabled".to_string(), settings.enabled.to_string());
    updates.insert("Proxy.ProxyType".to_string(), ProxyType::from_name(&settings.proxy_type).as_scheme().to_string());
    updates.insert("Proxy.NoCache".to_string(), settings.no_cache.to_string());
    updates.insert("Proxy.HttpMode".to_string(), settings.http_mode.to_string());
    updates.insert("Proxy.ProxyHost".to_string(), settings.receive.host.trim().to_string());
    updates.insert("Proxy.ProxyPort".to_string(), settings.receive.port.trim().to_string());
    updates.insert("Proxy.ProxyUsername".to_string(), settings.receive.username.clone());
    updates.insert("Proxy.ProxyPassword".to_string(), receive_password);
    updates.insert("Proxy.SendHost".to_string(), settings.send.host.trim().to_string());
    updates.insert("Proxy.SendPort".to_string(), settings.send.port.trim().to_string());
    updates.insert("Proxy.SendUsername".to_string(), settings.send.username.clone());
    updates.insert("Proxy.SendPassword".to_string(), send_password);
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
    // 読み上げの「今すぐ停止」の回数 (合成中に止めたら、合成が終わっても再生しない・再生中なら待つのをやめる)
    let gen = core_tts::wav_stop_gen();
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
    // 止められる形で再生し、終わるまで待つ (読み上げを順番どおりにするため)。
    // 合成している間に止めたときは再生しない (確認と再生の開始は、停止と同じ鍵の中で行う)。止めたら待つのをやめる
    let duration = core_tts::wav_duration(&wav).unwrap_or(std::time::Duration::from_secs(30)).min(std::time::Duration::from_secs(600));
    if !core_tts::play_wav_async_if(wav, gen).map_err(|e| e.to_string())? {
        return Ok(());
    }
    let started = std::time::Instant::now();
    while started.elapsed() < duration + std::time::Duration::from_millis(100) {
        if core_tts::wav_stop_gen() != gen {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Ok(())
}

#[tauri::command]
async fn tts_stop() -> Result<(), String> {
    // Stop current speech and clear queue
    // VOICEVOX の再生中の音も止める (停止の回数も進め、合成中のものは再生しない)
    core_tts::stop_wav();
    let mut queue = core_tts::tts_queue().lock().await;
    queue.clear();
    // Also stop SAPI if it's running (フラグを立てるだけで即座に返るため、スレッド分離は不要)
    let _ = core_tts::sapi_stop();
    // 棒読みちゃんにすでに渡した文章も止める (残りを取り消し、今の行を飛ばす)。最後に止めてから何も渡していなければ、何もしない。
    // RemoteTalk.exe の終わりを待つので、別のスレッドで行う
    if let Ok(Err(e)) = tauri::async_runtime::spawn_blocking(core_tts::bouyomi_stop).await {
        let _ = core_store::append_log_level("WARN", &format!("tts: 棒読みちゃんに停止を伝えられませんでした: {e}"));
    }
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
        // DNS 解決時と IP 直書きで同じ判定を使う (NAT64 / 6to4 等も含む)。
        if !core_fetch::is_public_ip(ip) {
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
        .no_proxy()
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
    if resp.content_length().is_some_and(|n| n > IMAGE_MAX_BYTES as u64) {
        return Err("画像が大きすぎます (30MB まで)".to_string());
    }
    let mut resp = resp;
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if out.len().saturating_add(chunk.len()) > IMAGE_MAX_BYTES {
            return Err("画像が大きすぎます (30MB まで)".to_string());
        }
        out.extend_from_slice(&chunk);
    }
    // 中身で判断し、判断できなければ名乗りで判断する (HTML などの画像でないものは止める)
    let kind = sniff_image_type(&out).map(str::to_string).or(declared).ok_or_else(|| "画像ではありませんでした".to_string())?;
    Ok((out, kind))
}

/// 自動表示の画像の通信 (同じサーバーの画像が続いても接続を作り直さないよう、1つを使い回す)
fn inline_image_client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let c = image_http_client(30)?;
    Ok(CLIENT.get_or_init(|| c).clone())
}

/// 自動表示用の画像も、DNS と各転送先を検証してから WebView に渡す。
/// 画像データは再エンコードしない (GIF 等のアニメーションを維持)。全部をメモリに読むので、
/// 大きすぎる画像・終わらない応答で重くならないよう、画像ウィンドウと同じ 30MB の上限を付ける。
/// 利用者のサイズ設定は従来どおり HEAD で判定する。
async fn inline_image_response(request: tauri::http::Request<Vec<u8>>) -> Result<tauri::http::Response<Vec<u8>>, String> {
    let head = request.method() == tauri::http::Method::HEAD;
    if !head && request.method() != tauri::http::Method::GET {
        return Err("画像は GET / HEAD だけで取得できます".into());
    }
    let uri = reqwest::Url::parse(&request.uri().to_string()).map_err(|e| e.to_string())?;
    let url = uri.query_pairs().find(|(k, _)| k == "url").map(|(_, v)| v.into_owned()).ok_or("画像 URL がありません")?;
    validate_public_http_url(&url)?;
    let client = inline_image_client()?;
    let response = if head { client.head(&url) } else { client.get(&url) }
        .send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let mut builder = tauri::http::Response::builder()
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "Content-Length")
        .header("Cache-Control", "private, max-age=300")
        .header("X-Content-Type-Options", "nosniff");
    if head {
        if let Some(n) = response.headers().get(reqwest::header::CONTENT_LENGTH) {
            builder = builder.header("Content-Length", n);
        }
        return builder.body(Vec::new()).map_err(|e| e.to_string());
    }
    let (bytes, kind) = read_image_response(response).await?;
    builder.header("Content-Type", kind).body(bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod inline_image_security_tests {
    use super::*;

    #[test]
    fn inline_images_cannot_request_private_addresses_or_non_http_schemes() {
        for url in ["http://127.0.0.1/a.jpg", "http://192.168.1.1/a.jpg",
            "http://[::1]/a.jpg", "file:///C:/Windows/win.ini", "http://localhost/a.jpg",
            "http://198.18.0.1/a.jpg", "http://224.0.0.1/a.jpg", "http://[64:ff9b::7f00:1]/a.jpg"] {
            for method in ["GET", "HEAD"] {
                let query: String = reqwest::Url::parse_with_params("http://safe-image.localhost/", &[("url", url)]).unwrap().into();
                let request = tauri::http::Request::builder().method(method).uri(query).body(Vec::new()).unwrap();
                assert!(tauri::async_runtime::block_on(inline_image_response(request)).is_err(), "{url}");
            }
        }
    }

    #[test]
    fn image_protocol_rejects_post_and_missing_target() {
        for method in ["GET", "POST"] {
            let request = tauri::http::Request::builder().method(method)
                .uri("http://safe-image.localhost/").body(Vec::new()).unwrap();
            assert!(tauri::async_runtime::block_on(inline_image_response(request)).is_err());
        }
    }
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
        // 正規表現の試し直しが多すぎたら、時間のかからない仕組みに切り替える (利用者の NG などの正規表現で画面が固まらないように)。
        // i を付けない・後方参照や先読みを使わない正規表現に効く (利用者の正規表現は画面側で i を使わない形に書き換えて使う)
        args.push_str(" --js-flags=--enable-experimental-regexp-engine-on-excessive-backtracks");
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
        .register_asynchronous_uri_scheme_protocol("safe-image", |_ctx, request, responder| {
            tauri::async_runtime::spawn(async move {
                let response = inline_image_response(request).await.unwrap_or_else(|_| {
                    tauri::http::Response::builder().status(403)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Cache-Control", "no-store")
                        .body(Vec::new()).expect("static image error response")
                });
                responder.respond(response);
            });
        })
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
            open_data_folder,
            board_log_append,
            board_log_prune,
            data_unreadable_files,
            board_log_open_folder,
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
            overlay_clear,
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

    /// EMBER_DATA_DIR (プロセス全体の環境変数) を触る試験どうしが、同時に走らないようにする
    static DATA_DIR_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    // 保存してあるプロキシの設定を読めない間は、掲示板との通信を通さない (プロキシなしで出ていかない)。
    // 読めるようになったら、保存し直さなくても設定どおりに通信する
    #[cfg(windows)]
    #[test]
    fn unreadable_settings_do_not_drop_the_proxy() {
        use std::os::windows::fs::OpenOptionsExt;
        let _env = DATA_DIR_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("livefake-proxy-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("EMBER_DATA_DIR", &dir);
        let ini = dir.join("settings.ini");
        let builder = || reqwest::Client::builder().timeout(std::time::Duration::from_secs(30));
        let via_proxy = || core_proxy::transport_url("https://mi.5ch.io/x", core_proxy::ProxyRole::Receive) == "http://mi.5ch.net/x";

        // 初回 (ファイルが無い): プロキシなしで通信できる
        super::init_proxy_settings();
        assert!(core_proxy::apply(builder(), core_proxy::ProxyRole::Receive).is_ok());
        assert!(!via_proxy());

        // プロキシを有効にした設定を、ほかのプログラムが使用中 (読めない)
        std::fs::write(&ini, "[Proxy]\nProxyEnabled=true\nProxyType=http\nHttpMode=true\nProxyHost=127.0.0.1\nProxyPort=8080\nSendHost=127.0.0.1\nSendPort=8080\n").unwrap();
        let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&ini).unwrap();
        super::init_proxy_settings();
        assert!(core_proxy::apply(builder(), core_proxy::ProxyRole::Receive).is_err(), "読めない間は、読み込みの通信を通さない");
        assert!(core_proxy::apply(builder(), core_proxy::ProxyRole::Send).is_err(), "読めない間は、書き込みの通信を通さない");
        // 設定画面には、既定値 (無効) を「保存してある設定」として返さない
        assert!(super::load_proxy_settings().is_err());

        // 使用中でなくなったら、保存し直さなくても、次の通信からプロキシを使う
        drop(lock);
        assert!(core_proxy::apply(builder(), core_proxy::ProxyRole::Receive).is_ok());
        assert!(core_proxy::apply(builder(), core_proxy::ProxyRole::Send).is_ok());
        assert!(via_proxy(), "読めるようになったら、保存してある設定 (プロキシを使う) で通信する");
        assert!(super::load_proxy_settings().unwrap().enabled);

        // 対照: はっきり無効にしてある設定なら、プロキシなしで通信できる
        std::fs::write(&ini, "[Proxy]\nProxyEnabled=false\nProxyHost=127.0.0.1\nProxyPort=8080\n").unwrap();
        super::init_proxy_settings();
        assert!(core_proxy::apply(builder(), core_proxy::ProxyRole::Receive).is_ok());
        assert!(!via_proxy());

        std::env::remove_var("EMBER_DATA_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_files_roundtrip_and_backup_rotation() {
        let _env = DATA_DIR_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
