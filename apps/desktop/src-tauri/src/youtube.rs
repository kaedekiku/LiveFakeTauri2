//! YouTube ライブ配信のチャット (読み取り専用。受信は core-youtube)
//!
//! - 受信するのは、開いている YouTube タブの配信だけ (画面から一覧をまるごと渡す。Twitch と同じ使い方)
//! - 公式 API の API キーは Windows の DPAPI で暗号化して data/youtube-api-key.bin に保存する
//!   (同じ PC・同じ Windows ユーザーでだけ復号できる。暗号化できないときは保存しない)。
//!   画面には「設定済みかどうか」だけを返し、キーそのものは渡さない。ログにも書かない
//! - チャットの本文はログに残さない
//! - 公式 API の使用量 (クォータ) の目安を data/youtube-quota.json に数える (日付・使った量・目標の数え始め。キーは入れない)。
//!   LiveFake が呼んだ分だけで、同じキーをほかで使った分は入らない。「何時間もたせる」が設定されていれば、
//!   残りの量から呼ぶ間隔を延ばす (core_youtube::quota)。設定を変えてもつなぎ直さない (受信中のタスクが毎回聞きに来る)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// 同時に受信する配信の数の上限
const MAX_VIDEOS: usize = 10;
const KEY_FILE: &str = "youtube-api-key.bin";
const QUOTA_FILE: &str = "youtube-quota.json";
/// 1日の上限の既定値と、設定できる範囲
const QUOTA_LIMIT_DEFAULT: u32 = 10_000;
const QUOTA_LIMIT_MAX: u32 = 10_000_000;
/// 目標の時間 (時間) の上限
const TARGET_HOURS_MAX: u32 = 48;
/// 公式 API の受信がこの時間 (秒) 止まっていたら、目標の時間の数え始めを捨てる (つなぎ直し・タブの開き直しでは数え直さない)
const TARGET_IDLE_RESET_SECS: i64 = 30 * 60;

#[derive(Default)]
pub struct YoutubeState {
    /// 受信中の配信 (動画 ID → 方式と設定の印・受信タスク)
    tasks: Mutex<HashMap<String, (String, tauri::async_runtime::JoinHandle<()>)>>,
    /// 公式 API の API キー (読み込んだもの)。None はまだ読んでいない
    key: Mutex<Option<Option<String>>>,
    /// 公式 API の使用量
    quota: Arc<QuotaBook>,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// data/youtube-quota.json の中身
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct QuotaFile {
    version: u32,
    /// 太平洋時間の日付 (この日の使用量)
    day: String,
    used: u32,
    /// 目標の時間の数え始め (UTC の秒)
    target_start: Option<i64>,
    /// 最後に公式 API で受信していた時刻 (UTC の秒)
    last_active: i64,
}

struct QuotaInner {
    file: QuotaFile,
    loaded: bool,
    /// 何時間もたせるか (0 は目標なし)
    target_hours: u32,
    limit: u32,
    /// 取得に使わず残しておく量
    reserve: u32,
    /// 公式 API で受信している配信の数
    active: u32,
}

/// 公式 API の使用量の帳簿 (同じ API キーの配信すべてで1つ)
pub struct QuotaBook {
    inner: Mutex<QuotaInner>,
    app: Mutex<Option<AppHandle>>,
}

impl Default for QuotaBook {
    fn default() -> Self {
        Self {
            inner: Mutex::new(QuotaInner { file: QuotaFile::default(), loaded: false, target_hours: 0, limit: QUOTA_LIMIT_DEFAULT, reserve: 0, active: 0 }),
            app: Mutex::new(None),
        }
    }
}

/// 画面へ送る使用量 ("youtube-quota")
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaView {
    day: String,
    used: u32,
    limit: u32,
    reserve: u32,
    active: u32,
    target_hours: u32,
    /// 目標の終わり (UTC のミリ秒)。目標なし・まだ受信していないときは null
    target_end: Option<i64>,
    interval_secs: u64,
    reachable: bool,
    lasts_secs: u64,
    until_reset_secs: u64,
}

fn quota_path() -> Option<std::path::PathBuf> {
    core_store::portable_data_dir().ok().map(|d| d.join(QUOTA_FILE))
}

impl QuotaBook {
    fn lock(&self) -> std::sync::MutexGuard<'_, QuotaInner> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !g.loaded {
            g.loaded = true;
            if let Some(f) = quota_path().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<QuotaFile>(&t).ok()) {
                g.file = f;
            }
        }
        // 太平洋時間の0時を過ぎたら数え直す (表示だけのときも)
        let today = core_youtube::quota::pacific_day(now_secs());
        if g.file.day != today {
            g.file.day = today;
            g.file.used = 0;
        }
        g
    }

    fn save(inner: &QuotaInner) {
        let mut f = inner.file.clone();
        f.version = 1;
        if let (Some(path), Ok(text)) = (quota_path(), serde_json::to_string(&f)) {
            let _ = std::fs::write(path, text);
        }
    }

    fn target_end(inner: &QuotaInner) -> Option<i64> {
        (inner.target_hours > 0).then_some(())?;
        // 受信していないまま時間がたった数え始めは、次に受信を始めたときに数え直すので使わない
        if inner.active == 0 && now_secs() - inner.file.last_active > TARGET_IDLE_RESET_SECS {
            return None;
        }
        inner.file.target_start.map(|s| s + i64::from(inner.target_hours) * 3_600)
    }

    fn plan(inner: &QuotaInner, min_secs: u64) -> core_youtube::quota::PlanOutput {
        let now = now_secs();
        core_youtube::quota::plan(core_youtube::quota::PlanInput {
            now,
            // まだ数え始めていなければ、今から始めたとして決める (画面の見込みのため。受信を始めると数え始めが入る)
            target_end: Self::target_end(inner).or_else(|| (inner.target_hours > 0).then(|| now + i64::from(inner.target_hours) * 3_600)),
            used: inner.file.used,
            limit: inner.limit,
            reserve: inner.reserve,
            active: inner.active,
            min_secs,
        })
    }

    fn view_of(inner: &QuotaInner, min_secs: u64) -> QuotaView {
        let o = Self::plan(inner, min_secs);
        QuotaView {
            day: inner.file.day.clone(),
            used: inner.file.used,
            limit: inner.limit,
            reserve: inner.reserve,
            active: inner.active,
            target_hours: inner.target_hours,
            target_end: Self::target_end(inner).map(|s| s * 1000),
            interval_secs: o.interval_secs,
            reachable: o.reachable,
            lasts_secs: o.lasts_secs,
            until_reset_secs: o.until_reset_secs,
        }
    }

    /// 今の使用量を画面へ知らせる (最短の間隔は画面の設定。受信中のタスクの値と同じ)
    fn emit(&self, inner: &QuotaInner) {
        let min = MIN_INTERVAL.load(std::sync::atomic::Ordering::Relaxed);
        if let Some(app) = self.app.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = app.emit("youtube-quota", Self::view_of(inner, min));
        }
    }

    fn update(&self, f: impl FnOnce(&mut QuotaInner)) {
        let mut g = self.lock();
        f(&mut g);
        Self::save(&g);
        self.emit(&g);
    }

    /// 公式 API での受信を始める (終わる・止めるときに数を戻す印を返す)
    fn enter(self: &Arc<Self>) -> ActiveGuard {
        let now = now_secs();
        self.update(|g| {
            g.active += 1;
            let stale = now - g.file.last_active > TARGET_IDLE_RESET_SECS;
            if g.active == 1 && (g.file.target_start.is_none() || stale) {
                g.file.target_start = Some(now);
            }
            g.file.last_active = now;
        });
        ActiveGuard(self.clone())
    }

    fn view(&self, min_secs: u64) -> QuotaView {
        Self::view_of(&self.lock(), min_secs)
    }
}

/// 公式 API で受信しているあいだ持つ印 (タスクが終わる・止められると数を戻す)
struct ActiveGuard(Arc<QuotaBook>);

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        let now = now_secs();
        self.0.update(|g| {
            g.active = g.active.saturating_sub(1);
            g.file.last_active = now;
        });
    }
}

impl core_youtube::QuotaPlan for QuotaBook {
    fn charge(&self, units: u32) {
        let now = now_secs();
        self.update(|g| {
            g.file.used = g.file.used.saturating_add(units);
            g.file.last_active = now;
        });
    }

    fn exhausted(&self) {
        self.update(|g| g.file.used = g.file.used.max(g.limit));
    }

    fn interval(&self, min_interval: Duration) -> Duration {
        Duration::from_secs(Self::plan(&self.lock(), min_interval.as_secs()).interval_secs)
    }
}

/// 画面で設定した最短の間隔 (秒。使用量の見込みの計算に使う)
static MIN_INTERVAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(core_youtube::API_MIN_INTERVAL_SECS);

impl YoutubeState {
    fn api_key(&self) -> Option<String> {
        let mut guard = self.key.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(load_key());
        }
        guard.clone().flatten()
    }

    /// 公式 API での受信を止める (キーを変えたとき。次の同期でつなぎ直す)
    fn stop_api_tasks(&self) {
        let mut tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        tasks.retain(|_, (sig, handle)| {
            let keep = !sig.starts_with(&format!("{}:", core_youtube::API_METHOD_ID));
            if !keep {
                handle.abort();
            }
            keep
        });
    }
}

fn key_path() -> Option<std::path::PathBuf> {
    core_store::portable_data_dir().ok().map(|d| d.join(KEY_FILE))
}

fn load_key() -> Option<String> {
    let stored = std::fs::read_to_string(key_path()?).ok()?;
    if !stored.starts_with("dpapi:") {
        return None;
    }
    let key = core_proxy::unprotect_password(stored.trim());
    core_youtube::api_key_ok(&key).then_some(key)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodView {
    id: String,
    label: String,
    description: String,
    needs_key: bool,
}

/// この exe で使える取得方法
#[tauri::command]
pub fn youtube_methods() -> Vec<MethodView> {
    core_youtube::methods()
        .into_iter()
        .map(|m| MethodView { id: m.id.into(), label: m.label.into(), description: m.description.into(), needs_key: m.needs_key })
        .collect()
}

/// 公式 API の API キーが設定済みか (キーそのものは返さない)
#[tauri::command]
pub fn youtube_key_status(state: tauri::State<'_, YoutubeState>) -> bool {
    state.api_key().is_some()
}

/// 公式 API の API キーを保存する (DPAPI で暗号化できないときは保存しない)
#[tauri::command]
pub fn youtube_set_key(state: tauri::State<'_, YoutubeState>, key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if !core_youtube::api_key_ok(&key) {
        return Err("API キーの形が違います (英数字と - _ の文字列です)".into());
    }
    let protected = core_proxy::protect_password(&key);
    if !protected.starts_with("dpapi:") {
        return Err("API キーを暗号化できなかったため、保存しませんでした".into());
    }
    let path = key_path().ok_or("保存先のフォルダが見つかりません")?;
    std::fs::write(&path, protected).map_err(|e| format!("保存できませんでした: {e}"))?;
    *state.key.lock().unwrap_or_else(|e| e.into_inner()) = Some(Some(key));
    state.stop_api_tasks();
    // 別のプロジェクトのキーかもしれないので、使用量の目安を数え直す
    state.quota.update(|g| g.file.used = 0);
    let _ = core_store::append_log("youtube: api key saved");
    Ok(())
}

/// 公式 API の API キーを削除する
#[tauri::command]
pub fn youtube_clear_key(state: tauri::State<'_, YoutubeState>) -> Result<(), String> {
    if let Some(path) = key_path() {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("削除できませんでした: {e}"))?;
        }
    }
    *state.key.lock().unwrap_or_else(|e| e.into_inner()) = Some(None);
    state.stop_api_tasks();
    state.quota.update(|g| g.file.used = 0);
    let _ = core_store::append_log("youtube: api key removed");
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmojiView {
    start: usize,
    end: usize,
    name: String,
    url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventView {
    kind: String,
    amount: String,
    months: u32,
    count: u32,
    level: String,
    item: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageView {
    id: String,
    channel_id: String,
    name: String,
    text: String,
    emojis: Vec<EmojiView>,
    owner: bool,
    moderator: bool,
    member: bool,
    verified: bool,
    event: Option<EventView>,
}

/// 画面へ送る1回分 ("youtube-message")
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessagesEvent {
    video: String,
    received_at: u64,
    messages: Vec<MessageView>,
    /// 削除された発言 ID
    deleted: Vec<String>,
    /// 発言がまとめて削除された投稿者のチャンネル ID
    deleted_authors: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    video: String,
    /// "connecting" / "live" / "retrying" / "ended" / "stopped"
    state: String,
    message: String,
    title: String,
}

fn emit_status(app: &AppHandle, video: &str, state: &str, message: String, title: String) {
    let _ = app.emit("youtube-status", StatusEvent { video: video.to_string(), state: state.to_string(), message, title });
}

/// 受信する配信の一覧を、渡された一覧に合わせる (足りないものは受信を始め、余分なものは止める)。
/// 方式・間隔が変わった配信はつなぎ直す。戻り値は受信対象にした動画 ID
#[tauri::command]
pub fn youtube_sync(app: AppHandle, state: tauri::State<'_, YoutubeState>, videos: Vec<String>, method: String, min_interval: u64) -> Result<Vec<String>, String> {
    let mut wanted: Vec<String> = videos.into_iter().filter(|v| core_youtube::is_video_id(v)).collect();
    wanted.sort();
    wanted.dedup();
    wanted.truncate(MAX_VIDEOS);
    let sig = format!("{method}:{min_interval}");
    *state.quota.app.lock().unwrap_or_else(|e| e.into_inner()) = Some(app.clone());
    MIN_INTERVAL.store(min_interval.clamp(core_youtube::API_MIN_INTERVAL_SECS, core_youtube::API_MAX_INTERVAL_SECS), std::sync::atomic::Ordering::Relaxed);
    let mut tasks = state.tasks.lock().unwrap_or_else(|e| e.into_inner());
    tasks.retain(|video, (old_sig, handle)| {
        let keep = wanted.contains(video) && *old_sig == sig;
        if !keep {
            handle.abort();
            let _ = core_store::append_log(&format!("youtube: stop {video}"));
        }
        keep
    });
    let needs_start: Vec<String> = wanted.iter().filter(|v| !tasks.contains_key(*v)).cloned().collect();
    if needs_start.is_empty() {
        return Ok(wanted);
    }
    let is_api = method == core_youtube::API_METHOD_ID;
    let quota: Arc<dyn core_youtube::QuotaPlan> = state.quota.clone();
    let parsed = core_youtube::method_from_id(&method, state.api_key(), min_interval, Some(quota));
    for video in needs_start {
        let m = match &parsed {
            Ok(m) => m.clone(),
            Err(reason) => {
                // 受信できない理由 (API キーが無いなど) を知らせる。タスクは作らないので、設定を直して同期し直せば始まる
                emit_status(&app, &video, "stopped", reason.clone(), String::new());
                continue;
            }
        };
        let _ = core_store::append_log(&format!("youtube: start {video} ({method})"));
        let (app_msg, app_status) = (app.clone(), app.clone());
        let (v_msg, v_status) = (video.clone(), video.clone());
        // 公式 API で受信しているあいだの数 (使用量の見込みと間隔の計算に使う)
        let guard = is_api.then(|| state.quota.enter());
        let run = core_youtube::run(
            video.clone(),
            m,
            move |updates| {
                let received_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let mut ev = MessagesEvent { video: v_msg.clone(), received_at, messages: Vec::new(), deleted: Vec::new(), deleted_authors: Vec::new() };
                for u in updates {
                    match u {
                        core_youtube::Update::Message(m) => ev.messages.push(MessageView {
                            id: m.id,
                            channel_id: m.channel_id,
                            name: m.name,
                            text: m.text,
                            emojis: m.emojis.into_iter().map(|e| EmojiView { start: e.start, end: e.end, name: e.name, url: e.url }).collect(),
                            owner: m.roles.owner,
                            moderator: m.roles.moderator,
                            member: m.roles.member,
                            verified: m.roles.verified,
                            event: m.event.map(|e| EventView { kind: e.kind, amount: e.amount, months: e.months, count: e.count, level: e.level, item: e.item }),
                        }),
                        core_youtube::Update::Deleted(id) => ev.deleted.push(id),
                        core_youtube::Update::DeletedByAuthor(ch) => ev.deleted_authors.push(ch),
                    }
                }
                let _ = app_msg.emit("youtube-message", ev);
            },
            move |st| {
                let (state, message, title) = match st {
                    core_youtube::Status::Connecting => ("connecting", String::new(), String::new()),
                    core_youtube::Status::Live { title } => ("live", String::new(), title),
                    core_youtube::Status::Retrying { reason, retry_in_secs } => ("retrying", format!("{reason} ({retry_in_secs}秒後にやり直します)"), String::new()),
                    core_youtube::Status::Ended => ("ended", "配信が終わりました".to_string(), String::new()),
                    core_youtube::Status::Stopped { reason } => ("stopped", reason, String::new()),
                };
                if state != "connecting" {
                    let _ = core_store::append_log(&format!("youtube: {v_status} {state} {message}"));
                }
                emit_status(&app_status, &v_status, state, message, title);
            },
        );
        let handle = tauri::async_runtime::spawn(async move {
            let _guard = guard;
            run.await;
        });
        tasks.insert(video, (sig.clone(), handle));
    }
    Ok(wanted)
}

/// 配信につなぎ直す (止まった・終わった受信を捨てる。次の同期で始め直す)
#[tauri::command]
pub fn youtube_reconnect(state: tauri::State<'_, YoutubeState>, video: String) {
    let mut tasks = state.tasks.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, handle)) = tasks.remove(&video) {
        handle.abort();
    }
}

/// 公式 API の使用量の目安 (min_interval は画面で設定した最短の間隔)
#[tauri::command]
pub fn youtube_quota_status(state: tauri::State<'_, YoutubeState>, min_interval: u64) -> QuotaView {
    state.quota.view(min_interval.clamp(core_youtube::API_MIN_INTERVAL_SECS, core_youtube::API_MAX_INTERVAL_SECS))
}

/// 何時間もたせるか (0 は目標なし)・1日の上限・取得に使わず残しておく量を設定する (つなぎ直さない)
#[tauri::command]
pub fn youtube_quota_config(app: AppHandle, state: tauri::State<'_, YoutubeState>, target_hours: u32, daily_limit: u32, reserve: u32) {
    *state.quota.app.lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
    let limit = daily_limit.clamp(1, QUOTA_LIMIT_MAX);
    state.quota.update(|g| {
        g.target_hours = target_hours.min(TARGET_HOURS_MAX);
        g.limit = limit;
        g.reserve = reserve.min(limit);
    });
}

/// 使用量の目安を、Google Cloud のコンソールに出ている値に合わせる
#[tauri::command]
pub fn youtube_quota_set_used(state: tauri::State<'_, YoutubeState>, used: u32) {
    state.quota.update(|g| g.file.used = used.min(QUOTA_LIMIT_MAX));
}

/// 目標の時間を今から数え直す (受信していなければ、次に受信を始めたときから)
#[tauri::command]
pub fn youtube_quota_restart_target(state: tauri::State<'_, YoutubeState>) {
    let now = now_secs();
    state.quota.update(|g| g.file.target_start = (g.active > 0).then_some(now));
}

// ===== 書き込み (ログインと送信は youtube_auth) =====

/// 書き込みのログインの状態 (トークンは返さない)
#[tauri::command]
pub fn youtube_auth_status(auth: tauri::State<'_, crate::youtube_auth::YoutubeAuthState>) -> crate::youtube_auth::AuthStatus {
    auth.status()
}

/// 自分で作った OAuth クライアント (ID とシークレット) を保存する (暗号化して保存。画面には設定済みかだけ返す)
#[tauri::command]
pub async fn youtube_auth_set_client(auth: tauri::State<'_, crate::youtube_auth::YoutubeAuthState>, client_id: String, client_secret: String) -> Result<crate::youtube_auth::AuthStatus, String> {
    auth.set_client(client_id, client_secret).await
}

#[tauri::command]
pub async fn youtube_auth_clear_client(auth: tauri::State<'_, crate::youtube_auth::YoutubeAuthState>) -> Result<crate::youtube_auth::AuthStatus, String> {
    Ok(auth.clear_client().await)
}

/// Google にログインする (コードを表示し、ブラウザで許可されるまで待つ)
#[tauri::command]
pub async fn youtube_auth_login(state: tauri::State<'_, YoutubeState>, auth: tauri::State<'_, crate::youtube_auth::YoutubeAuthState>) -> Result<crate::youtube_auth::AuthStatus, String> {
    let quota: Arc<dyn core_youtube::QuotaPlan> = state.quota.clone();
    auth.start_login(quota).await
}

/// ログアウト (Google 側の許可も取り消す)
#[tauri::command]
pub async fn youtube_auth_logout(auth: tauri::State<'_, crate::youtube_auth::YoutubeAuthState>) -> Result<crate::youtube_auth::AuthStatus, String> {
    Ok(auth.logout().await)
}

/// チャットに書き込む。送り先は開いている (受信中の) YouTube タブの配信だけ。
/// 書き込めたら、その発言をすぐタブに出す ("youtube-message"。あとで受信に同じ発言が来ても、画面側が発言 ID で重複を除く)
#[tauri::command]
pub async fn youtube_send_chat(
    app: AppHandle,
    state: tauri::State<'_, YoutubeState>,
    auth: tauri::State<'_, crate::youtube_auth::YoutubeAuthState>,
    video: String,
    message: String,
) -> Result<String, String> {
    if !core_youtube::is_video_id(&video) {
        return Err("送り先の配信が正しくありません".into());
    }
    let open = state.tasks.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&video);
    if !open {
        return Err("送り先の配信のタブが開いていない (受信していない) ため送りませんでした".into());
    }
    let quota: Arc<dyn core_youtube::QuotaPlan> = state.quota.clone();
    let sent = auth.send_chat(&video, &message, quota).await?;
    let received_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let id = sent.id.clone();
    if !id.is_empty() {
        let mut tb_text: String = sent.text.chars().filter(|c| !c.is_control()).take(1000).collect();
        tb_text = tb_text.trim().to_string();
        let ev = MessagesEvent {
            video: video.clone(),
            received_at,
            messages: vec![MessageView {
                id: sent.id,
                channel_id: sent.channel_id,
                name: sent.name,
                text: tb_text,
                emojis: Vec::new(),
                owner: false,
                moderator: false,
                member: false,
                verified: false,
                event: None,
            }],
            deleted: Vec::new(),
            deleted_authors: Vec::new(),
        };
        let _ = app.emit("youtube-message", ev);
    }
    Ok(id)
}
