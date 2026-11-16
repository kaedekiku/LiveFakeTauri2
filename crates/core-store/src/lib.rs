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

/// 起動してから読もうとして「あるのに読めなかった」データファイル (ロック中など)。
/// その起動の間は上書きしない (「無い」と同じに扱って空・既定値で上書きすると、中身を失うため)。
/// あとで読めたら外す。「無い」ファイル・形の壊れたファイルは対象にしない
static UNREADABLE: Mutex<Option<std::collections::HashSet<PathBuf>>> = Mutex::new(None);
/// 起動してから読もうとして「中身が壊れていて読めなかった」データファイル (写し <名前>.broken-<秒> を残してある)
static BROKEN: Mutex<Option<std::collections::HashSet<PathBuf>>> = Mutex::new(None);
/// その起動の間は上書きしないと決めたデータファイル (hold_overwrite)
static HELD: Mutex<Option<std::collections::HashSet<PathBuf>>> = Mutex::new(None);

/// 中身が壊れていて読めなかったファイルの写しを、同じフォルダに残す (起動ごとに1回。上書きされても手で直せるように)。
/// 写しを残せなかったときは、その起動の間は元のファイルを上書きしない (読めなかったファイルと同じ扱い)
fn keep_broken_copy(path: &std::path::Path, bytes: &[u8]) {
    let mut g = BROKEN.lock().unwrap_or_else(|e| e.into_inner());
    let set = g.get_or_insert_with(Default::default);
    if set.contains(path) {
        return;
    }
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".broken-{secs}"));
    match write_atomic(&PathBuf::from(name), bytes) {
        Ok(()) => {
            set.insert(path.to_path_buf());
        }
        Err(e) => {
            eprintln!("core-store: 壊れたファイルの写しを残せませんでした (上書きしないようにします): {e}");
            drop(g);
            mark_unreadable(path, false);
        }
    }
}

fn mark_unreadable(path: &std::path::Path, readable: bool) {
    let mut g = UNREADABLE.lock().unwrap_or_else(|e| e.into_inner());
    let set = g.get_or_insert_with(Default::default);
    if readable {
        set.remove(path);
    } else {
        set.insert(path.to_path_buf());
    }
}

fn is_unreadable(path: &std::path::Path) -> bool {
    UNREADABLE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|s| s.contains(path)).unwrap_or(false)
        || HELD.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|s| s.contains(path)).unwrap_or(false)
}

/// 読み取りの結果を覚える (読めた・無い → 外す。あるのに読めない → 覚える)
fn note_read<T>(path: &std::path::Path, result: &std::io::Result<T>) {
    match result {
        Ok(_) => mark_unreadable(path, true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => mark_unreadable(path, true),
        Err(_) => mark_unreadable(path, false),
    }
}

fn refuse_if_unreadable(path: &std::path::Path) -> Result<(), StoreError> {
    if is_unreadable(path) {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Err(StoreError::Other(format!(
            "{name} は起動したときに読み込めなかったため、上書きしていません (起動し直すと読み直します)"
        )));
    }
    Ok(())
}

/// 一時ファイルに書いて fsync し、本体に置き換える (途中で止まっても、本体は前か後の完全な内容のまま)
fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), StoreError> {
    let path = path.to_path_buf();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut tmp_name = path.as_os_str().to_os_string();
    tmp_name.push(format!(".{}.{}.tmp", std::process::id(), seq));
    let tmp_path = PathBuf::from(tmp_name);

    let write_result = (|| -> Result<(), StoreError> {
        {
            let mut file = fs::File::create(&tmp_path)?;
            file.write_all(bytes)?;
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

fn default_data_dir() -> Result<PathBuf, StoreError> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let base = dirs::data_dir().ok_or_else(|| StoreError::Other("failed to resolve data dir".into()))?;
        return Ok(base.join("LiveFake"));
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        // Portable 形式: 実行ファイル (livefake.exe) と同じフォルダの data\ に保存する。
        // 以前は起動時の作業フォルダ基準だったため、ショートカットの「作業フォルダー」などが
        // exe と別の場所だと data\ もそちらに作られていた。その環境の設定を失わないよう、
        // exe 側に data\ が無く作業フォルダ側にある場合だけは作業フォルダ側を使い続ける。
        static RESOLVED: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        if let Some(dir) = RESOLVED.get() {
            return Ok(dir.clone());
        }
        let cwd_data = std::env::current_dir()?.join("data");
        let exe_data = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("data")));
        let dir = match exe_data {
            Some(exe_data) if exe_data.is_dir() || !cwd_data.is_dir() => exe_data,
            _ => cwd_data,
        };
        Ok(RESOLVED.get_or_init(|| dir).clone())
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
    save_json_path(&portable_data_dir()?.join(relative_path), value)
}

/// save_json の中身 (保存先のパスを受け取る。テストでは一時フォルダのパスを渡す)
fn save_json_path<T: Serialize>(path: &std::path::Path, value: &T) -> Result<(), StoreError> {
    let bytes = serde_json::to_vec_pretty(value)?;
    // 同一ファイルへの並行書き込みを直列化する (Poison してもデータ自体は壊れないので続行)。
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    refuse_if_unreadable(path)?;
    write_atomic(path, &bytes)
}

pub fn load_json<T: DeserializeOwned>(relative_path: &str) -> Result<T, StoreError> {
    load_json_path(&portable_data_dir()?.join(relative_path))
}

/// load_json の中身 (読むファイルのパスを受け取る)
fn load_json_path<T: DeserializeOwned>(path: &std::path::Path) -> Result<T, StoreError> {
    let read = fs::read(path);
    note_read(path, &read);
    let bytes = read?;
    match serde_json::from_slice(&bytes) {
        Ok(v) => Ok(v),
        Err(e) => {
            // 中身が壊れていて読めない: 写しを残してから、無いのと同じに扱う (本体はこのあと上書きされうる)
            keep_broken_copy(path, &bytes);
            Err(e.into())
        }
    }
}


/// 起動してから「あるのに読めなかった」データファイル (その起動の間は上書きしない)
/// 読めたら Some、無い・中身が壊れていた (写しを残した) ら None、あるのに読めない (ロック中など) ならエラー。
/// 「無い」と「読めない」を分けたい読み込み (配信へ出す前に効かせる辞書など) に使う
pub fn load_json_opt<T: DeserializeOwned>(relative_path: &str) -> Result<Option<T>, StoreError> {
    match load_json(relative_path) {
        Ok(v) => Ok(Some(v)),
        Err(StoreError::Io(e)) if e.kind() != std::io::ErrorKind::NotFound => Err(StoreError::Io(e)),
        Err(_) => Ok(None),
    }
}

/// 配信の前に効かせる辞書 (NG・読み上げない辞書など) を読む。
/// 無いときだけ None (空として使う)。あるのに読めない・中身が壊れている・形が違うときはエラー
/// (空として通すと、効かせるはずの語がそのまま配信へ出るため)。壊れていたら写しを残し、読めるまで上書きしない
pub fn load_json_strict_opt<T: DeserializeOwned>(relative_path: &str) -> Result<Option<T>, StoreError> {
    load_json_strict_opt_path(&portable_data_dir()?.join(relative_path))
}

fn load_json_strict_opt_path<T: DeserializeOwned>(path: &std::path::Path) -> Result<Option<T>, StoreError> {
    match load_json_path(path) {
        Ok(v) => Ok(Some(v)),
        Err(StoreError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(StoreError::Io(e)) => Err(StoreError::Io(e)),
        Err(e) => {
            // 壊れている・形が違う (写しは load_json_path が残した): 読めるまで上書きしない
            mark_unreadable(path, false);
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            Err(StoreError::Other(format!(
                "{name} の中身が壊れているか、形が違います (写しを「{name}.broken-数字」として残しました)。直すか消すと、自動で読み直して再開します ({e})"
            )))
        }
    }
}

/// 配信の前に効かせる辞書で、項目を省略できるもの (NG・読み上げない辞書) を読む。load_json_strict_opt と同じに加えて、
/// 中身のある JSON なのに知っている項目 (known) が1つも無いときも、壊れたファイルと同じに扱う
/// (項目がすべて省略できるので、知らない形でも空として読めてしまい、効かないまま配信へ出たり、空で上書きしたりするため)。
/// 古い形式 (項目の一部だけ) と、空の {} は読める
pub fn load_json_strict_known_opt<T: DeserializeOwned>(relative_path: &str, known: &[&str]) -> Result<Option<T>, StoreError> {
    load_json_strict_known_opt_path(&portable_data_dir()?.join(relative_path), known)
}

fn load_json_strict_known_opt_path<T: DeserializeOwned>(path: &std::path::Path, known: &[&str]) -> Result<Option<T>, StoreError> {
    let Some(v) = load_json_strict_opt_path::<serde_json::Value>(path)? else {
        return Ok(None);
    };
    // オブジェクト ({...}) だけを読む。配列は、項目を順に並べたものとして別の項目に読めてしまうので読まない
    let shape_ok = match &v {
        serde_json::Value::Object(m) => m.is_empty() || m.keys().any(|k| known.contains(&k.as_str())),
        _ => false,
    };
    let parsed: Result<T, StoreError> = if shape_ok {
        serde_json::from_value(v).map_err(StoreError::from)
    } else {
        Err(StoreError::Other(if v.is_object() {
            format!("読み込める項目 ({}) が1つもありません", known.join("・"))
        } else {
            "{ } で囲んだ形ではありません".to_string()
        }))
    };
    parsed.map(Some).map_err(|e| {
        if let Ok(bytes) = fs::read(path) {
            keep_broken_copy(path, &bytes);
        }
        mark_unreadable(path, false);
        broken_dict_error(path, e)
    })
}

/// 配信の前に効かせる辞書が壊れている・形が違うときの知らせ
fn broken_dict_error(path: &std::path::Path, e: StoreError) -> StoreError {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    StoreError::Other(format!(
        "{name} の中身が壊れているか、形が違います (写しを「{name}.broken-数字」として残しました)。直すか消すと、自動で読み直して再開します ({e})"
    ))
}

/// その起動の間、このデータファイルを上書きしない (使えない分を外して使い続けるのに、元のファイルの写しを残せなかったときなど)。
/// 起動時の「読み込めなかったファイル」の知らせには載せない (呼んだ側が知らせる)
pub fn hold_overwrite(relative_path: &str) {
    if let Ok(dir) = portable_data_dir() {
        hold_overwrite_path(&dir.join(relative_path));
    }
}

fn hold_overwrite_path(path: &std::path::Path) {
    HELD.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(Default::default).insert(path.to_path_buf());
}

/// データファイルの写しを「<名前>.broken-<秒>」として残す (一部だけ使えなかったファイルを、使える分だけにして使い続けるとき)。
/// 起動時の「壊れていた」の知らせには載せない (呼んだ側が、使えなかった分を知らせる)。戻り値は写しの名前
pub fn keep_dated_copy(relative_path: &str) -> Result<String, StoreError> {
    let path = portable_data_dir()?.join(relative_path);
    let bytes = fs::read(&path)?;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".broken-{secs}"));
    let copy = PathBuf::from(name);
    write_atomic(&copy, &bytes)?;
    Ok(copy.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
}

/// JSON の文字列を中に持つファイル (タブの一覧・画面の設定) を読む。中の JSON が valid でなければ、写しを残して空を返す
pub fn load_json_string_checked(relative_path: &str, valid: impl Fn(&serde_json::Value) -> bool) -> Result<String, StoreError> {
    load_json_string_checked_path(&portable_data_dir()?.join(relative_path), valid)
}

fn load_json_string_checked_path(path: &std::path::Path, valid: impl Fn(&serde_json::Value) -> bool) -> Result<String, StoreError> {
    let s = load_json_path::<String>(path)?;
    // 外側は読めても、中の JSON (タブの一覧など) が壊れていたら、壊れたファイルと同じに扱う (写しを残し、空として返す)
    let ok = serde_json::from_str::<serde_json::Value>(&s).map(|v| valid(&v)).unwrap_or(false);
    if ok {
        return Ok(s);
    }
    if let Ok(bytes) = fs::read(path) {
        keep_broken_copy(path, &bytes);
    }
    Ok(String::new())
}

/// 中身が壊れていて読めなかったデータファイル (写しを残してある。画面側が知らせる)
pub fn broken_paths() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = BROKEN.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|s| s.iter().cloned().collect()).unwrap_or_default();
    v.sort();
    v
}

pub fn unreadable_paths() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = UNREADABLE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|s| s.iter().cloned().collect()).unwrap_or_default();
    v.sort();
    v
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
    load_settings_ini_path(&portable_data_dir()?.join("settings.ini"))
}

fn load_settings_ini_path(path: &std::path::Path) -> Result<HashMap<String, String>, StoreError> {
    let path = path.to_path_buf();
    let read = fs::read_to_string(&path);
    note_read(&path, &read);
    let text = match read {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Create default file
            write_atomic(&path, DEFAULT_SETTINGS_INI.as_bytes())?;
            DEFAULT_SETTINGS_INI.to_string()
        }
        Err(e) => return Err(e.into()),
    };
    let ini = IniFile::parse(&text);
    Ok(ini.to_flat_map())
}

/// `settings.ini` を読むだけ (無ければ作らない。「読めなかった」の覚えも変えない)。無ければ None。
/// 起動したときに読めなかったファイルを、あとで読み直して確かめるときに使う
/// (load_settings_ini で読み直すと「読めた」と覚え直し、画面が持っている既定値で上書きできるようになってしまう)
pub fn peek_settings_ini() -> Result<Option<HashMap<String, String>>, StoreError> {
    peek_settings_ini_path(&portable_data_dir()?.join("settings.ini"))
}

fn peek_settings_ini_path(path: &std::path::Path) -> Result<Option<HashMap<String, String>>, StoreError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(IniFile::parse(&text).to_flat_map())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Save a flat map to `settings.ini`, merging with existing content.
pub fn save_settings_ini(updates: &HashMap<String, String>) -> Result<(), StoreError> {
    save_settings_ini_path(&portable_data_dir()?.join("settings.ini"), updates)
}

fn save_settings_ini_path(path: &std::path::Path, updates: &HashMap<String, String>) -> Result<(), StoreError> {
    let path = path.to_path_buf();
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // 起動したときに読めなかった設定ファイルは上書きしない (既定値で全体を上書きしてしまうため)
    refuse_if_unreadable(&path)?;
    let mut ini = match fs::read_to_string(&path) {
        Ok(t) => IniFile::parse(&t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => IniFile::parse(DEFAULT_SETTINGS_INI),
        Err(e) => return Err(e.into()),
    };
    ini.apply_flat_map(updates);
    // 一時ファイルに書いてから置き換える (途中で止まっても、壊れた設定ファイルを残さない)
    write_atomic(&path, ini.to_string_pretty().as_bytes())
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

    fn guard_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("livefake_core_store_guard_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Windows: 共有なしで開いて、ほかからは読めなくする (GPT の試験と同じロックのしかた)
    #[cfg(windows)]
    fn lock_exclusive(path: &std::path::Path) -> fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn json_unreadable_at_load_is_not_overwritten() {
        let dir = guard_test_dir("json");
        let path = dir.join("tabs.json");
        save_json_path(&path, &vec!["a", "b"]).unwrap();
        let lock = lock_exclusive(&path);
        // 読めない: 「無い」(空) ではなくエラー
        assert!(load_json_path::<Vec<String>>(&path).is_err());
        drop(lock);
        // 読めなかったファイルは、その起動の間は上書きしない
        assert!(save_json_path(&path, &Vec::<String>::new()).is_err());
        assert_eq!(load_json_path::<Vec<String>>(&path).unwrap(), vec!["a", "b"]);
        assert!(!unreadable_paths().contains(&path), "読めたら一覧から外れる");
        // 読めたあとは保存できる
        save_json_path(&path, &vec!["c"]).unwrap();
        assert_eq!(load_json_path::<Vec<String>>(&path).unwrap(), vec!["c"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_json_is_kept_as_copy() {
        let dir = guard_test_dir("broken");
        let path = dir.join("session_tabs.json");
        fs::write(&path, b"\"{\\\"tabs\\\":[1,2").unwrap(); // 末尾が欠けた JSON
        assert!(load_json_path::<String>(&path).is_err());
        // 壊れていた中身は写しとして残る (手で直せるように)
        let copies: Vec<_> = fs::read_dir(&dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("session_tabs.json.broken-")).collect();
        assert_eq!(copies.len(), 1, "写しを1つ残す");
        assert_eq!(fs::read(copies[0].path()).unwrap(), b"\"{\\\"tabs\\\":[1,2");
        assert!(broken_paths().contains(&path), "知らせる一覧に入る");
        // 写しがあるので、本体は保存してよい (アプリはそのまま使える)
        save_json_path(&path, &"{}".to_string()).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_copy_failure_blocks_overwrite() {
        let dir = guard_test_dir("broken_copyfail");
        let path = dir.join("tabs2.json");
        fs::write(&path, b"[1,2").unwrap();
        // 写しの置き場所をふさぐ (同じ名前のフォルダを、この先数秒ぶん置いておく)
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        for s in now.saturating_sub(1)..now + 6 {
            fs::create_dir_all(dir.join(format!("tabs2.json.broken-{s}"))).unwrap();
        }
        assert!(load_json_path::<Vec<u32>>(&path).is_err());
        // 写しを残せなかったので、元のファイルは上書きしない
        assert!(save_json_path(&path, &Vec::<u32>::new()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"[1,2");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn inner_json_broken_is_kept_as_copy() {
        let dir = guard_test_dir("inner_broken");
        let path = dir.join("session_tabs2.json");
        // 外側は正しい JSON の文字列だが、中のタブの一覧が壊れている
        save_json_path(&path, &"{\"tabs\":5}".to_string()).unwrap();
        let v = load_json_string_checked_path(&path, |v| v.get("tabs").map(|t| t.is_array()).unwrap_or(false)).unwrap();
        assert_eq!(v, "", "壊れた中身は返さない (空として扱う)");
        let copies: Vec<_> = fs::read_dir(&dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("session_tabs2.json.broken-")).collect();
        assert_eq!(copies.len(), 1, "写しを残す");
        assert!(broken_paths().contains(&path));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn strict_load_missing_is_none_and_broken_is_error() {
        let dir = guard_test_dir("strict");
        let path = dir.join("dict2.json");
        // 無い: 空として使う (初めて使うとき)
        assert!(matches!(load_json_strict_opt_path::<Vec<u32>>(&path), Ok(None)));
        // 壊れている: エラー (空として通さない)。写しを残し、元のファイルは上書きしない
        fs::write(&path, b"[1,2").unwrap();
        let e = load_json_strict_opt_path::<Vec<u32>>(&path);
        assert!(e.is_err(), "壊れた辞書は空として通さない");
        assert!(e.err().map(|e| e.to_string()).unwrap_or_default().contains("dict2.json"));
        assert!(fs::read_dir(&dir).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("dict2.json.broken-")));
        assert!(save_json_path(&path, &Vec::<u32>::new()).is_err(), "壊れている間は上書きしない");
        assert_eq!(fs::read(&path).unwrap(), b"[1,2");
        // 形が違う (JSON としては読める): 同じくエラー
        fs::write(&path, b"{\"a\":1}").unwrap();
        assert!(load_json_strict_opt_path::<Vec<u32>>(&path).is_err());
        // 直したら読めて、保存もできる
        fs::write(&path, b"[1,2]").unwrap();
        assert_eq!(load_json_strict_opt_path::<Vec<u32>>(&path).unwrap(), Some(vec![1, 2]));
        assert!(save_json_path(&path, &vec![1u32, 2, 3]).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[derive(serde::Deserialize, Default, Debug)]
    struct DictLike {
        #[serde(default)]
        words: Vec<String>,
        #[serde(default)]
        ids: Vec<String>,
    }

    #[test]
    fn strict_known_rejects_unknown_shape() {
        let dir = guard_test_dir("strict_known");
        let path = dir.join("dict3.json");
        let known = ["words", "ids"];
        // 知らない形 (一段深い): 空として通さない。写しを残し、上書きしない
        fs::write(&path, br#"{"dictionary":{"words":["a"]}}"#).unwrap();
        assert!(load_json_strict_known_opt_path::<DictLike>(&path, &known).is_err(), "知らない形は空として通さない");
        assert!(fs::read_dir(&dir).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("dict3.json.broken-")));
        assert!(save_json_path(&path, &Vec::<u32>::new()).is_err(), "読めるまで上書きしない");
        // 空の {}・古い形式 (一部の項目だけ)・知らない項目が混ざっていても知っている項目があるもの は読める
        fs::write(&path, b"{}").unwrap();
        assert!(load_json_strict_known_opt_path::<DictLike>(&path, &known).unwrap().is_some());
        fs::write(&path, br#"{"words":["a"]}"#).unwrap();
        assert_eq!(load_json_strict_known_opt_path::<DictLike>(&path, &known).unwrap().unwrap().words, vec!["a".to_string()]);
        fs::write(&path, br#"{"ids":["x"],"extra":1}"#).unwrap();
        assert_eq!(load_json_strict_known_opt_path::<DictLike>(&path, &known).unwrap().unwrap().ids, vec!["x".to_string()]);
        // 無い: None
        let _ = fs::remove_file(&path);
        assert!(load_json_strict_known_opt_path::<DictLike>(&path, &known).unwrap().is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn strict_known_rejects_array_and_held_file_is_not_overwritten() {
        let dir = guard_test_dir("strict_array");
        let path = dir.join("dict4.json");
        let known = ["words", "ids"];
        // 配列: 項目を順に並べたものとして読めてしまう (words に入るはずの語が別の項目に入る) ので、読まない
        fs::write(&path, br#"[["a"],["b"]]"#).unwrap();
        assert!(load_json_strict_known_opt_path::<DictLike>(&path, &known).is_err(), "配列の辞書は読まない");
        assert!(save_json_path(&path, &Vec::<u32>::new()).is_err(), "読めるまで上書きしない");
        // 上書きしないと決めたファイル
        let held = dir.join("tabs5.json");
        fs::write(&held, b"\"old\"").unwrap();
        hold_overwrite_path(&held);
        assert!(save_json_path(&held, &"new".to_string()).is_err(), "上書きしない");
        assert_eq!(fs::read(&held).unwrap(), b"\"old\"");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn json_missing_is_not_blocked() {
        let dir = guard_test_dir("missing");
        let path = dir.join("none.json");
        assert!(load_json_path::<Vec<String>>(&path).is_err());
        // 無いファイルは、作ってよい
        save_json_path(&path, &vec!["x"]).unwrap();
        assert_eq!(load_json_path::<Vec<String>>(&path).unwrap(), vec!["x"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn ini_unreadable_at_load_is_not_overwritten() {
        let dir = guard_test_dir("ini");
        let path = dir.join("settings.ini");
        fs::write(&path, "[App]\nboardLogMode=off\n").unwrap();
        let lock = lock_exclusive(&path);
        assert!(load_settings_ini_path(&path).is_err());
        drop(lock);
        let mut up = HashMap::new();
        up.insert("App.boardLogMode".to_string(), "all".to_string());
        assert!(save_settings_ini_path(&path, &up).is_err());
        assert!(fs::read_to_string(&path).unwrap().contains("boardLogMode=off"));
        // 読めたあとは保存でき、途中の一時ファイルは残らない
        assert_eq!(load_settings_ini_path(&path).unwrap().get("App.boardLogMode").map(|s| s.as_str()), Some("off"));
        save_settings_ini_path(&path, &up).unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("boardLogMode=all"));
        assert!(fs::read_dir(&dir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")));
        let _ = fs::remove_dir_all(&dir);
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
