//! YouTube ライブ配信のチャット (読み取り専用。受信は core-youtube)
//!
//! - 受信するのは、開いている YouTube タブの配信だけ (画面から一覧をまるごと渡す。Twitch と同じ使い方)
//! - 公式 API の API キーは Windows の DPAPI で暗号化して data/youtube-api-key.bin に保存する
//!   (同じ PC・同じ Windows ユーザーでだけ復号できる。暗号化できないときは保存しない)。
//!   画面には「設定済みかどうか」だけを返し、キーそのものは渡さない。ログにも書かない
//! - チャットの本文はログに残さない

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// 同時に受信する配信の数の上限
const MAX_VIDEOS: usize = 10;
const KEY_FILE: &str = "youtube-api-key.bin";

#[derive(Default)]
pub struct YoutubeState {
    /// 受信中の配信 (動画 ID → 方式と設定の印・受信タスク)
    tasks: Mutex<HashMap<String, (String, tauri::async_runtime::JoinHandle<()>)>>,
    /// 公式 API の API キー (読み込んだもの)。None はまだ読んでいない
    key: Mutex<Option<Option<String>>>,
}

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
    let parsed = core_youtube::method_from_id(&method, state.api_key(), min_interval);
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
        let handle = tauri::async_runtime::spawn(core_youtube::run(
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
        ));
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
