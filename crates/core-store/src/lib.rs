use rusqlite::Connection;
use serde::{de::DeserializeOwned, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("{0}")]
    Other(String),
}

static DB: Mutex<Option<Connection>> = Mutex::new(None);

/// `save_json` の直列化ロック。Tauri コマンドは並行実行されるため、同じファイルへの
/// 書き込みが重なると (1) 一時ファイル → 本体のリネーム順序が入れ替わって古い内容で
/// 上書きされる、(2) 片方がリネーム済みの一時ファイルを掴んで失敗する、といった競合が
/// 起こりうる。プロセス全体で書き込みを直列化して防ぐ (書き込みは短時間なので十分)。
static SAVE_LOCK: Mutex<()> = Mutex::new(());

/// 一時ファイル名を一意化するためのカウンタ (同名 `.tmp` の衝突防止)。
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn default_data_dir() -> Result<PathBuf, StoreError> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let base = dirs::data_dir().ok_or_else(|| StoreError::Other("failed to resolve data dir".into()))?;
        return Ok(base.join("LiveFake"));
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Ok(std::env::current_dir()?.join("data"))
    }
}

pub fn portable_data_dir() -> Result<PathBuf, StoreError> {
    if let Ok(custom) = std::env::var("EMBER_DATA_DIR") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    default_data_dir()
}

pub fn init_portable_layout() -> Result<PathBuf, StoreError> {
    let data_dir = portable_data_dir()?;
    fs::create_dir_all(data_dir.join("logs"))?;

    let settings_path = data_dir.join("settings.json");
    if !settings_path.exists() {
        fs::write(&settings_path, "{}")?;
    }

    Ok(data_dir)
}

/// JSONをクラッシュに強い方式で保存する。
/// 一時ファイルへ書き込み→fsyncで物理ディスクへの反映を強制→アトミックにリネームして本体に反映する。
/// これにより (1) 強制終了直後でも直近の書き込みが失われにくく、(2) 書き込み途中でクラッシュしても
/// 本体ファイルは「更新前」か「更新後」のどちらかの完全な内容のまま保たれ、壊れた中途半端な
/// JSONになって復元不能になることがない。一時ファイルはアプリ専用データフォルダ内に作成するため
/// (共有の一時フォルダを使わない)、シンボリックリンク攻撃等の心配もない。
pub fn save_json<T: Serialize>(relative_path: &str, value: &T) -> Result<(), StoreError> {
    let path = portable_data_dir()?.join(relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let bytes = serde_json::to_vec_pretty(value)?;

    // 同一ファイルへの並行書き込みを直列化する (Poison してもデータ自体は壊れないので続行)。
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut tmp_name = path.as_os_str().to_os_string();
    tmp_name.push(format!(".{}.{}.tmp", std::process::id(), seq));
    let tmp_path = PathBuf::from(tmp_name);

    let write_result = (|| -> Result<(), StoreError> {
        {
            let mut file = fs::File::create(&tmp_path)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        // Windows ではウイルス対策ソフトやクラウド同期が一瞬だけ本体ファイルを掴んでいて
        // リネームが失敗することがあるため、短い間隔で数回だけ再試行する。
        let mut last_err: Option<std::io::Error> = None;
        for attempt in 0..4u32 {
            match fs::rename(&tmp_path, &path) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last_err = Some(e);
                    if attempt < 3 {
                        std::thread::sleep(std::time::Duration::from_millis(20 * (attempt as u64 + 1)));
                    }
                }
            }
        }
        Err(StoreError::Io(last_err.unwrap_or_else(|| std::io::Error::other("rename failed"))))
    })();

    if write_result.is_err() {
        // 失敗した一時ファイルを残さない (削除失敗は無視してよい)。
        let _ = fs::remove_file(&tmp_path);
    }
    write_result
}

pub fn load_json<T: DeserializeOwned>(relative_path: &str) -> Result<T, StoreError> {
    let path = portable_data_dir()?.join(relative_path);
    let content = fs::read(path)?;
    Ok(serde_json::from_slice(&content)?)
}

/// Append a timestamped log line to `eventlog/{YYYY-MM-DD}.log`.
/// Format: `[YYYY/MM/DD HH:MM:SS] [LEVEL] message`
/// `level` should be "INFO", "WARN", or "ERROR".
pub fn append_log_level(level: &str, message: &str) -> Result<(), StoreError> {
    let log_dir = portable_data_dir()?.join("eventlog");
    fs::create_dir_all(&log_dir)?;
    let now = chrono::Local::now();
    let date_str = now.format("%Y-%m-%d").to_string();
    let log_path = log_dir.join(format!("{}.log", date_str));
    let timestamp = now.format("%Y/%m/%d %H:%M:%S").to_string();
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)?;
    writeln!(file, "[{timestamp}] [{level}] {message}")?;
    Ok(())
}

/// Convenience wrapper — logs at INFO level.
pub fn append_log(message: &str) -> Result<(), StoreError> {
    append_log_level("INFO", message)
}

/// Delete eventlog files older than `retention_days` days.
/// Call once at startup. A retention_days of 0 means keep forever.
pub fn purge_old_logs(retention_days: u32) -> Result<(), StoreError> {
    if retention_days == 0 {
        return Ok(());
    }
    let log_dir = portable_data_dir()?.join("eventlog");
    if !log_dir.exists() {
        return Ok(());
    }
    let cutoff = chrono::Local::now() - chrono::Duration::days(retention_days as i64);
    let cutoff_str = cutoff.format("%Y-%m-%d").to_string();
    for entry in fs::read_dir(&log_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Keep only files matching YYYY-MM-DD.log that are older than cutoff
        if name.ends_with(".log") && name.len() == 14 {
            let date_part = &name[..10];
            if date_part < cutoff_str.as_str() {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

fn get_db() -> Result<std::sync::MutexGuard<'static, Option<Connection>>, StoreError> {
    let mut guard = DB.lock().map_err(|e| StoreError::Other(e.to_string()))?;
    if guard.is_none() {
        let db_path = portable_data_dir()?.join("cache.db");
        let conn = Connection::open(&db_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS thread_cache (
                thread_url TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                responses_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ogp_cache (
                url TEXT PRIMARY KEY,
                json TEXT NOT NULL,
                fetched_at INTEGER NOT NULL
            );"
        )?;
        *guard = Some(conn);
    }
    Ok(guard)
}

/// OGP / X ポストカードのキャッシュ有効期間 (7日)。
pub const OGP_CACHE_TTL_SECS: i64 = 7 * 24 * 60 * 60;
/// タイトルも画像も取れなかった (取得失敗とみなす) エントリの再試行間隔 (30分)。
/// 一時的な失敗や取得方法の改善後に、7日待たずにカード化できるようにする。
pub const OGP_CACHE_RETRY_TTL_SECS: i64 = 30 * 60;

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// OGP キャッシュを読む。TTL 切れのものは `None` を返す (削除は次回保存時に上書き)。
pub fn load_ogp_cache(url: &str) -> Result<Option<String>, StoreError> {
    Ok(load_ogp_cache_with_age(url)?.map(|(json, _)| json))
}

/// OGP キャッシュを経過秒数付きで読む。TTL (7日) 切れのものは `None`。
/// 呼び出し側は内容が「取得失敗相当」なら経過秒数を見て短い間隔で再試行できる。
pub fn load_ogp_cache_with_age(url: &str) -> Result<Option<(String, i64)>, StoreError> {
    let guard = get_db()?;
    let conn = guard.as_ref().ok_or_else(|| StoreError::Other("no db".into()))?;
    let mut stmt = conn.prepare("SELECT json, fetched_at FROM ogp_cache WHERE url = ?1")?;
    let result = stmt.query_row(rusqlite::params![url], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    });
    match result {
        Ok((json, fetched_at)) => {
            let age = unix_now() - fetched_at;
            if age > OGP_CACHE_TTL_SECS {
                Ok(None)
            } else {
                Ok(Some((json, age)))
            }
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn save_ogp_cache(url: &str, json: &str) -> Result<(), StoreError> {
    let guard = get_db()?;
    let conn = guard.as_ref().ok_or_else(|| StoreError::Other("no db".into()))?;
    conn.execute(
        "INSERT OR REPLACE INTO ogp_cache (url, json, fetched_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![url, json, unix_now()],
    )?;
    Ok(())
}

pub fn save_thread_cache(thread_url: &str, title: &str, responses_json: &str) -> Result<(), StoreError> {
    let guard = get_db()?;
    let conn = guard.as_ref().ok_or_else(|| StoreError::Other("no db".into()))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT OR REPLACE INTO thread_cache (thread_url, title, responses_json, updated_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![thread_url, title, responses_json, now],
    )?;
    Ok(())
}

pub fn load_thread_cache(thread_url: &str) -> Result<Option<String>, StoreError> {
    let guard = get_db()?;
    let conn = guard.as_ref().ok_or_else(|| StoreError::Other("no db".into()))?;
    let mut stmt = conn.prepare("SELECT responses_json FROM thread_cache WHERE thread_url = ?1")?;
    let result = stmt.query_row(rusqlite::params![thread_url], |row| row.get::<_, String>(0));
    match result {
        Ok(json) => Ok(Some(json)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn load_all_cached_threads() -> Result<Vec<(String, String, i64)>, StoreError> {
    let guard = get_db()?;
    let conn = guard.as_ref().ok_or_else(|| StoreError::Other("no db".into()))?;
    let mut stmt = conn.prepare(
        "SELECT thread_url, title,
                (length(responses_json) - length(replace(responses_json, '\"responseNo\"', ''))) / length('\"responseNo\"')
         FROM thread_cache ORDER BY updated_at DESC"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2).unwrap_or(0)))
    })?;
    let mut result = Vec::new();
    for r in rows {
        result.push(r?);
    }
    Ok(result)
}

pub fn delete_thread_cache(thread_url: &str) -> Result<(), StoreError> {
    let guard = get_db()?;
    let conn = guard.as_ref().ok_or_else(|| StoreError::Other("no db".into()))?;
    conn.execute("DELETE FROM thread_cache WHERE thread_url = ?1", rusqlite::params![thread_url])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// INI settings (Portable)
// ---------------------------------------------------------------------------

/// Lightweight INI file representation: section -> key -> value (all strings).
#[derive(Debug, Clone, Default)]
pub struct IniFile {
    sections: Vec<(String, Vec<(String, String)>)>,
}

impl IniFile {
    /// Parse INI text.  Supports `[Section]`, `key=value`, and `; comment` / `# comment` lines.
    pub fn parse(text: &str) -> Self {
        let mut sections: Vec<(String, Vec<(String, String)>)> = Vec::new();
        let mut current_section = String::new();
        let mut current_pairs: Vec<(String, String)> = Vec::new();

        for raw_line in text.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
                continue;
            }
            if line.starts_with('[') {
                // Save previous section
                if !current_pairs.is_empty() || !current_section.is_empty() {
                    sections.push((current_section.clone(), std::mem::take(&mut current_pairs)));
                }
                current_section = line.trim_start_matches('[').trim_end_matches(']').trim().to_string();
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                current_pairs.push((key.trim().to_string(), value.trim().to_string()));
            }
        }
        // Push last section
        if !current_pairs.is_empty() || !current_section.is_empty() {
            sections.push((current_section, current_pairs));
        }

        IniFile { sections }
    }

    /// Serialize back to INI text.
    pub fn to_string_pretty(&self) -> String {
        let mut out = String::new();
        for (section, pairs) in &self.sections {
            if !section.is_empty() {
                out.push_str(&format!("[{}]\n", section));
            }
            for (k, v) in pairs {
                out.push_str(&format!("{}={}\n", k, v));
            }
            out.push('\n');
        }
        out
    }

    /// Get a value from a specific section.
    pub fn get(&self, section: &str, key: &str) -> Option<&str> {
        for (sec, pairs) in &self.sections {
            if sec == section {
                for (k, v) in pairs {
                    if k == key {
                        return Some(v.as_str());
                    }
                }
            }
        }
        None
    }

    /// Set a value in a specific section. Creates section/key if missing.
    pub fn set(&mut self, section: &str, key: &str, value: &str) {
        for (sec, pairs) in &mut self.sections {
            if sec == section {
                for (k, v) in pairs.iter_mut() {
                    if k == key {
                        *v = value.to_string();
                        return;
                    }
                }
                pairs.push((key.to_string(), value.to_string()));
                return;
            }
        }
        self.sections.push((section.to_string(), vec![(key.to_string(), value.to_string())]));
    }

    /// Return all key-value pairs as a flat HashMap with "Section.Key" keys.
    pub fn to_flat_map(&self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        for (section, pairs) in &self.sections {
            for (k, v) in pairs {
                if section.is_empty() {
                    map.insert(k.clone(), v.clone());
                } else {
                    map.insert(format!("{}.{}", section, k), v.clone());
                }
            }
        }
        map
    }

    /// Apply a flat HashMap ("Section.Key" -> value) onto the INI, creating sections as needed.
    pub fn apply_flat_map(&mut self, map: &HashMap<String, String>) {
        for (flat_key, value) in map {
            let (section, key) = if let Some((s, k)) = flat_key.split_once('.') {
                (s, k)
            } else {
                ("", flat_key.as_str())
            };
            self.set(section, key, value);
        }
    }
}

/// Default INI content for a fresh settings.ini.
const DEFAULT_SETTINGS_INI: &str = "\
[App]
maxOpenTabs=20
fontSize=14
responseGap=10
autoReloadIntervalSec=15
autoScroll=true
smoothScroll=true
logRetentionDays=7

[Speech]
mode=off
enabled=false
maxReadLength=0
sapiVoiceIndex=0
sapiRate=0
sapiVolume=100
bouyomiPath=
voicevoxEndpoint=http://127.0.0.1:50021
voicevoxSpeakerId=0
voicevoxSpeedScale=1.0
voicevoxPitchScale=0.0
voicevoxIntonationScale=1.0
voicevoxVolumeScale=1.0

[Posting]
name=
mail=
sage=false
fontSize=13
";

/// Load `settings.ini` from the portable data directory. Returns the flat map.
pub fn load_settings_ini() -> Result<HashMap<String, String>, StoreError> {
    let path = portable_data_dir()?.join("settings.ini");
    let text = if path.exists() {
        fs::read_to_string(&path)?
    } else {
        // Create default file
        fs::write(&path, DEFAULT_SETTINGS_INI)?;
        DEFAULT_SETTINGS_INI.to_string()
    };
    let ini = IniFile::parse(&text);
    Ok(ini.to_flat_map())
}

/// Save a flat map to `settings.ini`, merging with existing content.
pub fn save_settings_ini(updates: &HashMap<String, String>) -> Result<(), StoreError> {
    let path = portable_data_dir()?.join("settings.ini");
    let mut ini = if path.exists() {
        IniFile::parse(&fs::read_to_string(&path)?)
    } else {
        IniFile::parse(DEFAULT_SETTINGS_INI)
    };
    ini.apply_flat_map(updates);
    fs::write(&path, ini.to_string_pretty())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_roundtrip_ini() {
        let ini = IniFile::parse(DEFAULT_SETTINGS_INI);
        assert_eq!(ini.get("App", "maxOpenTabs"), Some("20"));
        assert_eq!(ini.get("App", "autoReloadIntervalSec"), Some("15"));
        assert_eq!(ini.get("App", "autoScroll"), Some("true"));

        let map = ini.to_flat_map();
        assert_eq!(map.get("App.fontSize"), Some(&"14".to_string()));
    }

    #[test]
    fn set_creates_missing_section() {
        let mut ini = IniFile::default();
        ini.set("New", "key", "val");
        assert_eq!(ini.get("New", "key"), Some("val"));
    }

    #[test]
    fn apply_flat_map_works() {
        let mut ini = IniFile::parse(DEFAULT_SETTINGS_INI);
        let mut updates = HashMap::new();
        updates.insert("App.autoReloadIntervalSec".to_string(), "30".to_string());
        updates.insert("Speech.enabled".to_string(), "false".to_string());
        ini.apply_flat_map(&updates);
        assert_eq!(ini.get("App", "autoReloadIntervalSec"), Some("30"));
        assert_eq!(ini.get("Speech", "enabled"), Some("false"));
    }

    // EMBER_DATA_DIR はプロセス全体の環境変数なので、この crate 内で他にそれを触るテストが
    // 増えた場合は並列実行の競合に注意すること(現状はこのテストのみが使用)
    #[test]
    fn save_json_roundtrip_via_tmp_rename() {
        let dir = std::env::temp_dir().join(format!(
            "livefake_core_store_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        std::env::set_var("EMBER_DATA_DIR", &dir);

        let value = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        save_json("roundtrip.json", &value).unwrap();
        let loaded: Vec<String> = load_json("roundtrip.json").unwrap();
        assert_eq!(loaded, value);

        // 本体ファイルのみが残り、一時ファイルは残らないこと
        assert!(dir.join("roundtrip.json").exists());
        assert!(!dir.join("roundtrip.json.tmp").exists());

        // 前回クラッシュ等で .tmp が残っていても、次の保存で問題なく上書きされること
        fs::write(dir.join("roundtrip.json.tmp"), b"stale").unwrap();
        let value2 = vec!["x".to_string()];
        save_json("roundtrip.json", &value2).unwrap();
        let loaded2: Vec<String> = load_json("roundtrip.json").unwrap();
        assert_eq!(loaded2, value2);

        std::env::remove_var("EMBER_DATA_DIR");
        let _ = fs::remove_dir_all(&dir);
    }
}
