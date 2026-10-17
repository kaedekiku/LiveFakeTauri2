//! Twitch のバッジ画像とチャンネルポイント報酬の名前 (非公式の取得方法。TchViewer の badges.rs を移植)
//!
//! Twitch のサイト自身が使っている GraphQL の取得口 (gql.twitch.tv) から、グローバルバッジと
//! チャンネル独自のバッジ (サブスク・ビッツなど) の画像アドレス、チャンネルポイント報酬の ID と名前を取得する。
//! - 非公式のため、Twitch 側の変更で使えなくなることがある。設定 > Twitch で取得をオフにできる
//! - 取得は受信するチャンネルが変わったときと1時間ごと。結果はメモリに置き、data/badges-cache.json にも保存して
//!   取得に失敗したときの予備にする。Twitch の開発者向け規約 (保存は24時間のキャッシュまで) に合わせ、
//!   取得から24時間を過ぎた一覧はファイルからもメモリからも捨てる
//! - 受け取った画像アドレスは static-cdn.jtvnw.net/badges/v1/<uuid> の形のものだけ使う
//! - 送るのはチャンネル名 (英小文字・数字・_ のみ) だけで、ログイン情報などは送らない

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

/// Twitch のウェブサイトが公開している Client-Id (非公式の利用)
const WEB_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const GQL_URL: &str = "https://gql.twitch.tv/gql";
pub const IMAGE_PREFIX: &str = "https://static-cdn.jtvnw.net/badges/v1/";
const REFRESH: Duration = Duration::from_secs(3600);
/// 一覧を持っておける時間 (秒)
const KEEP_SECS: u64 = 24 * 3600;

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct BadgeImage {
    pub title: String,
    /// 画像アドレス (末尾のサイズ指定 /1 を除いたもの。表示側で /1〜/3 を付ける)
    pub url: String,
}

/// "setID/version" → 画像
type BadgeMap = HashMap<String, BadgeImage>;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BadgeStore {
    pub global: BadgeMap,
    /// チャンネル名 (小文字) → そのチャンネル独自のバッジ
    pub channels: HashMap<String, BadgeMap>,
    /// チャンネル名 → チャンネルポイント報酬の ID と名前
    #[serde(default)]
    pub rewards: HashMap<String, HashMap<String, String>>,
    /// 取得した時刻 (UNIX 秒)。24時間を過ぎたら使わない
    #[serde(default)]
    pub fetched_at: u64,
}

impl BadgeStore {
    fn expired(&self, now: u64) -> bool {
        self.fetched_at == 0 || self.fetched_at + KEEP_SECS < now
    }

    /// IRC の badges タグ (例: "broadcaster/1,subscriber/12") を画像に変換する。チャンネル独自のものを優先
    pub fn resolve(&self, channel: &str, tag: &str) -> Vec<BadgeImage> {
        let ch = self.channels.get(channel);
        tag.split(',')
            .filter(|b| !b.is_empty())
            .take(10)
            .filter_map(|b| ch.and_then(|m| m.get(b)).or_else(|| self.global.get(b)).cloned())
            .collect()
    }

    pub fn reward_title(&self, channel: &str, id: &str) -> Option<String> {
        self.rewards.get(channel).and_then(|m| m.get(id)).cloned()
    }
}

/// 取得の状態 (Tauri の State として持つ。取得タスクとは Arc で共有する)
#[derive(Default)]
pub struct BadgeState(Arc<BadgeInner>);

#[derive(Default)]
pub struct BadgeInner {
    pub store: RwLock<BadgeStore>,
    pub enabled: AtomicBool,
    channels: Mutex<Vec<String>>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl std::ops::Deref for BadgeState {
    type Target = BadgeInner;
    fn deref(&self) -> &BadgeInner {
        &self.0
    }
}

impl BadgeState {
    /// 取得がオンならバッジと報酬名を返す (オフなら何も返さない)
    pub fn resolve(&self, channel: &str, tag: &str) -> Vec<BadgeImage> {
        if !self.enabled.load(Ordering::SeqCst) {
            return Vec::new();
        }
        self.store.read().unwrap_or_else(|e| e.into_inner()).resolve(channel, tag)
    }

    pub fn reward_title(&self, channel: &str, id: &str) -> Option<String> {
        if !self.enabled.load(Ordering::SeqCst) || id.is_empty() {
            return None;
        }
        self.store.read().unwrap_or_else(|e| e.into_inner()).reward_title(channel, id)
    }

    /// 取得のオンオフ。オンにしたら今のチャンネルで取得し直す
    pub fn set_enabled(&self, enabled: bool) {
        let was = self.enabled.swap(enabled, Ordering::SeqCst);
        if enabled && !was {
            let channels = self.channels.lock().unwrap_or_else(|e| e.into_inner()).clone();
            self.restart(channels);
        } else if !enabled {
            if let Some(t) = self.task.lock().unwrap_or_else(|e| e.into_inner()).take() {
                t.abort();
            }
        }
    }

    /// 受信するチャンネルが変わったら取得し直す
    pub fn set_channels(&self, channels: Vec<String>) {
        let changed = {
            let mut cur = self.channels.lock().unwrap_or_else(|e| e.into_inner());
            let changed = *cur != channels;
            *cur = channels.clone();
            changed
        };
        if changed && self.enabled.load(Ordering::SeqCst) {
            self.restart(channels);
        }
    }

    fn restart(&self, channels: Vec<String>) {
        let mut task = self.task.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(t) = task.take() {
            t.abort();
        }
        // チャンネル名はクエリに埋め込むので、英数字と _ だけに限る (normalize_channel 済みだが念のため)
        let channels: Vec<String> = channels
            .into_iter()
            .filter(|c| !c.is_empty() && c.len() <= 25 && c.bytes().all(|x| x.is_ascii_lowercase() || x.is_ascii_digit() || x == b'_'))
            .collect();
        if channels.is_empty() {
            return;
        }
        let inner = Arc::clone(&self.0);
        *task = Some(tauri::async_runtime::spawn(async move { run(inner, channels).await }));
    }
}

fn cache_path() -> Option<std::path::PathBuf> {
    core_store::portable_data_dir().ok().map(|d| d.join("badges-cache.json"))
}

fn load_cache() -> BadgeStore {
    let store: BadgeStore = cache_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // 24時間を過ぎた (または時刻の無い古い形式の) 一覧はファイルごと捨てる
    if store.expired(now_secs()) {
        if let Some(p) = cache_path() {
            let _ = std::fs::remove_file(p);
        }
        return BadgeStore::default();
    }
    store
}

fn save_cache(store: &BadgeStore) {
    if let (Some(p), Ok(s)) = (cache_path(), serde_json::to_string(store)) {
        let _ = std::fs::write(p, s);
    }
}

/// GraphQL の応答の配列を BadgeMap にする (形式・画像アドレスを確かめる)
fn to_map(v: Option<&Value>) -> BadgeMap {
    let mut m = BadgeMap::new();
    for b in v.and_then(|x| x.as_array()).into_iter().flatten().take(2000) {
        let (Some(set), Some(ver), Some(url)) = (
            b.get("setID").and_then(|x| x.as_str()),
            b.get("version").and_then(|x| x.as_str()),
            b.get("imageURL").and_then(|x| x.as_str()),
        ) else {
            continue;
        };
        let Some(rest) = url.strip_prefix(IMAGE_PREFIX) else { continue };
        // <uuid>/<size> の形だけ受け付ける
        let uuid = rest.split('/').next().unwrap_or("");
        if uuid.is_empty() || uuid.len() > 64 || !uuid.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            continue;
        }
        let title = b.get("title").and_then(|x| x.as_str()).unwrap_or("").chars().take(100).collect();
        let key: String = format!("{set}/{ver}").chars().take(100).collect();
        m.insert(key, BadgeImage { title, url: format!("{IMAGE_PREFIX}{uuid}") });
    }
    m
}

async fn fetch(client: &reqwest::Client, channels: &[String]) -> Result<BadgeStore, String> {
    let fields = "setID version title imageURL(size: NORMAL)";
    let users: String = channels
        .iter()
        .enumerate()
        .map(|(i, ch)| {
            format!("u{i}: user(login: \"{ch}\") {{ broadcastBadges {{ {fields} }} channel {{ communityPointsSettings {{ customRewards {{ id title }} }} }} }}")
        })
        .collect::<Vec<_>>()
        .join(" ");
    let query = format!("query {{ badges {{ {fields} }} {users} }}");
    let res = client
        .post(GQL_URL)
        .header("Client-Id", WEB_CLIENT_ID)
        .header("Content-Type", "application/json")
        .body(json!({ "query": query }).to_string())
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("応答が大きすぎます".into());
    }
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let data = v.get("data").ok_or("応答の形式が変わった可能性があります")?;
    let global = to_map(data.get("badges"));
    if global.is_empty() {
        return Err("グローバルバッジを取得できません (応答の形式が変わった可能性があります)".into());
    }
    let mut store = BadgeStore { global, channels: HashMap::new(), rewards: HashMap::new(), fetched_at: now_secs() };
    for (i, ch) in channels.iter().enumerate() {
        let u = data.get(format!("u{i}"));
        store.channels.insert(ch.clone(), to_map(u.and_then(|u| u.get("broadcastBadges"))));
        let rewards: HashMap<String, String> = u
            .and_then(|u| u.pointer("/channel/communityPointsSettings/customRewards"))
            .and_then(|r| r.as_array())
            .into_iter()
            .flatten()
            .take(500)
            .filter_map(|r| {
                let id = r.get("id")?.as_str()?;
                (id.len() <= 64).then(|| (id.to_string(), r.get("title").and_then(|t| t.as_str()).unwrap_or("").chars().take(100).collect()))
            })
            .collect();
        store.rewards.insert(ch.clone(), rewards);
    }
    Ok(store)
}

/// 取得を続けるタスク (チャンネルが変わるたびに作り直される)
async fn run(state: Arc<BadgeInner>, channels: Vec<String>) {
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(30)).build() {
        Ok(c) => c,
        Err(_) => return,
    };
    loop {
        match fetch(&client, &channels).await {
            Ok(store) => {
                let n: usize = store.channels.values().map(|m| m.len()).sum();
                let _ = core_store::append_log(&format!("twitch: バッジを取得 (グローバル{}件 / チャンネル{}件)", store.global.len(), n));
                save_cache(&store);
                *state.store.write().unwrap_or_else(|e| e.into_inner()) = store;
            }
            Err(e) => {
                let cache = load_cache();
                let note = if cache.global.is_empty() { "前回の一覧もありません" } else { "前回取得した一覧を使います" };
                let _ = core_store::append_log(&format!("twitch: バッジを取得できません ({note}): {e}"));
                let mut cur = state.store.write().unwrap_or_else(|e| e.into_inner());
                if !cache.global.is_empty() {
                    *cur = cache;
                } else if cur.expired(now_secs()) {
                    // 取り直せないまま24時間を過ぎたら、メモリの一覧も捨てる
                    *cur = BadgeStore::default();
                }
            }
        }
        tokio::time::sleep(REFRESH).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_resolve() {
        let v = json!([
            { "setID": "subscriber", "version": "12", "title": "1年", "imageURL": "https://static-cdn.jtvnw.net/badges/v1/eca7fc07-0f88-42ba-bad5-1b7d4feeb1cd/1" },
            { "setID": "evil", "version": "1", "title": "x", "imageURL": "https://evil.example/badges/v1/abc/1" },
            { "setID": "bad", "version": "1", "title": "x", "imageURL": "https://static-cdn.jtvnw.net/badges/v1/<script>/1" }
        ]);
        let m = to_map(Some(&v));
        assert_eq!(m.len(), 1);
        assert_eq!(m["subscriber/12"].url, "https://static-cdn.jtvnw.net/badges/v1/eca7fc07-0f88-42ba-bad5-1b7d4feeb1cd");
        let mut store = BadgeStore::default();
        store.global.insert("broadcaster/1".into(), BadgeImage { title: "配信者".into(), url: "g".into() });
        store.channels.insert("foo".into(), m);
        let r = store.resolve("foo", "broadcaster/1,subscriber/12,unknown/1");
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].title, "配信者");
    }

    #[test]
    fn old_lists_expire() {
        let now = 1_000_000;
        assert!(BadgeStore::default().expired(now));
        assert!(!BadgeStore { fetched_at: now - 3600, ..Default::default() }.expired(now));
        assert!(BadgeStore { fetched_at: now - KEEP_SECS - 1, ..Default::default() }.expired(now));
    }

    #[test]
    fn disabled_state_resolves_nothing() {
        let st = BadgeState::default();
        st.store.write().unwrap().global.insert("a/1".into(), BadgeImage { title: "A".into(), url: "u".into() });
        assert!(st.resolve("x", "a/1").is_empty());
        st.enabled.store(true, Ordering::SeqCst);
        assert_eq!(st.resolve("x", "a/1").len(), 1);
    }
}
