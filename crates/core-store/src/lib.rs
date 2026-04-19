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

pub fn save_json<T: Serialize>(relative_path: &str, value: &T) -> Result<(), StoreError> {
    let path = portable_data_dir()?.join(relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
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
            );"
        )?;
        *guard = Some(conn);
    }
    Ok(guard)
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
}
