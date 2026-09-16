use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum TtsError {
    #[error("SAPI error: {0}")]
    Sapi(String),
    #[error("Bouyomi error: {0}")]
    Bouyomi(String),
    #[error("VOICEVOX error: {0}")]
    Voicevox(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("HTTP error: {0}")]
    Http(String),
    #[error("Not supported on this platform")]
    NotSupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub index: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct VoicevoxSpeaker {
    pub name: String,
    pub speaker_uuid: String,
    pub styles: Vec<VoicevoxStyle>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicevoxStyle {
    pub name: String,
    pub id: i32,
}

/// TTS read queue item
#[derive(Debug, Clone)]
pub struct TtsQueueItem {
    pub response_no: u32,
    pub text: String,
}

/// Global TTS queue for managing read-aloud
pub struct TtsQueue {
    items: Vec<TtsQueueItem>,
    current_index: usize,
    is_speaking: bool,
}

impl TtsQueue {
    pub fn new() -> Self {
        Self {
            items: Vec::new(),
            current_index: 0,
            is_speaking: false,
        }
    }

    pub fn clear(&mut self) {
        self.items.clear();
        self.current_index = 0;
        self.is_speaking = false;
    }

    pub fn set_items(&mut self, items: Vec<TtsQueueItem>) {
        self.items = items;
        self.current_index = 0;
        self.is_speaking = true;
    }

    pub fn next(&mut self) -> Option<TtsQueueItem> {
        if self.current_index < self.items.len() {
            let item = self.items[self.current_index].clone();
            self.current_index += 1;
            Some(item)
        } else {
            self.is_speaking = false;
            None
        }
    }

    pub fn append(&mut self, items: Vec<TtsQueueItem>) {
        self.items.extend(items);
    }

    pub fn is_speaking(&self) -> bool {
        self.is_speaking
    }
}

impl Default for TtsQueue {
    fn default() -> Self {
        Self::new()
    }
}

/// Lazy-initialized global TTS queue
pub fn tts_queue() -> &'static Arc<Mutex<TtsQueue>> {
    use std::sync::OnceLock;
    static QUEUE: OnceLock<Arc<Mutex<TtsQueue>>> = OnceLock::new();
    QUEUE.get_or_init(|| Arc::new(Mutex::new(TtsQueue::new())))
}

/// Truncate text based on max_read_length setting (0 = unlimited)
pub fn truncate_text(text: &str, max_read_length: u32) -> String {
    if max_read_length == 0 {
        return text.to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    if chars.len() as u32 <= max_read_length {
        text.to_string()
    } else {
        chars[..max_read_length as usize].iter().collect()
    }
}

// ===== SAPI (Windows only) =====

#[cfg(target_os = "windows")]
pub fn sapi_list_voices() -> Result<Vec<VoiceInfo>, TtsError> {
    use windows::Win32::Media::Speech::*;
    use windows::Win32::System::Com::*;
    use windows::core::*;

    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| TtsError::Sapi(format!("CoInitializeEx: {}", e)))?;

        let cat: ISpObjectTokenCategory = CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL)
            .map_err(|e| TtsError::Sapi(format!("CoCreateInstance category: {}", e)))?;
        cat.SetId(&HSTRING::from("HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices"), false)
            .map_err(|e| TtsError::Sapi(format!("SetId: {}", e)))?;

        let tokens = cat
            .EnumTokens(None, None)
            .map_err(|e| TtsError::Sapi(format!("EnumTokens: {}", e)))?;

        let mut count: u32 = 0;
        tokens
            .GetCount(&mut count)
            .map_err(|e| TtsError::Sapi(format!("GetCount: {}", e)))?;

        let mut voices = Vec::new();
        for i in 0..count {
            let token: ISpObjectToken = tokens
                .Item(i)
                .map_err(|e| TtsError::Sapi(format!("Item: {}", e)))?;
            let name = token.GetStringValue(None)
                .ok()
                .and_then(|s| s.to_string().ok())
                .unwrap_or_else(|| format!("Voice {}", i));
            voices.push(VoiceInfo { index: i, name });
        }

        CoUninitialize();
        Ok(voices)
    }
}

#[cfg(not(target_os = "windows"))]
pub fn sapi_list_voices() -> Result<Vec<VoiceInfo>, TtsError> {
    Err(TtsError::NotSupported)
}

// SAPI の読み上げは専用の常駐スレッド (1本) 上でのみ行う。COM の音声オブジェクト (ISpVoice) は
// 作成したスレッド以外から直接呼び出せない (アパートメント制約) ため、読み上げ・停止の両方を
// 必ず同じスレッドから実行する必要がある。設計:
//   - 常駐スレッドが ISpVoice を1つだけ作成し、使い回す (呼び出しのたびに作り直さない)
//   - 読み上げ要求はチャネル経由でこのスレッドに渡し、完了 (自然終了 or 停止による中断) まで
//     呼び出し元 (Tauri コマンド) をブロックして待たせる。フロント側から見た「読み終わるまで待つ」
//     という挙動 (新着レスの逐次読み上げに必要) は変えない
//   - 停止は `SAPI_STOP_REQUESTED` フラグを立てるだけ。実際の中断 (Speak を購入フラグ付きで
//     呼び直す) は常駐スレッド自身がポーリング中に検知して行うので、COM のスレッド制約に触れない
#[cfg(target_os = "windows")]
static SAPI_STOP_REQUESTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "windows")]
struct SapiSpeakRequest {
    text: String,
    voice_index: u32,
    rate: i32,
    volume: u32,
    resp: std::sync::mpsc::Sender<Result<(), TtsError>>,
}

#[cfg(target_os = "windows")]
fn sapi_worker_sender() -> &'static std::sync::mpsc::Sender<SapiSpeakRequest> {
    use std::sync::OnceLock;
    static SENDER: OnceLock<std::sync::mpsc::Sender<SapiSpeakRequest>> = OnceLock::new();
    SENDER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<SapiSpeakRequest>();
        // panic しても呼び出し元を永久に待たせない (send/recv が失敗として返る) よう、
        // Builder 経由で spawn し、万一パニックしてもプロセス全体は道連れにしない
        let spawn_result = std::thread::Builder::new()
            .name("sapi-worker".to_string())
            .spawn(move || sapi_worker_loop(rx));
        if let Err(e) = spawn_result {
            eprintln!("SAPI worker thread failed to start: {e}");
        }
        tx
    })
}

#[cfg(target_os = "windows")]
fn sapi_worker_loop(rx: std::sync::mpsc::Receiver<SapiSpeakRequest>) {
    use windows::Win32::Media::Speech::*;
    use windows::Win32::System::Com::*;

    let init_ok = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok() };
    if !init_ok {
        for req in rx {
            let _ = req
                .resp
                .send(Err(TtsError::Sapi("CoInitializeEx failed in SAPI worker thread".to_string())));
        }
        return;
    }
    let voice: ISpVoice = match unsafe { CoCreateInstance(&SpVoice, None, CLSCTX_ALL) } {
        Ok(v) => v,
        Err(e) => {
            for req in rx {
                let _ = req
                    .resp
                    .send(Err(TtsError::Sapi(format!("CoCreateInstance: {e}"))));
            }
            unsafe { CoUninitialize() };
            return;
        }
    };

    for req in rx {
        // 万一 SAPI 呼び出し中にパニックしても、常駐スレッドを落とさず・応答も必ず返す
        // (これが無いと以後の全ての読み上げ要求が永久に応答待ちになってしまう)
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            sapi_speak_interruptible(&voice, &req.text, req.voice_index, req.rate, req.volume)
        }))
        .unwrap_or_else(|_| Err(TtsError::Sapi("SAPI worker panicked while speaking".to_string())));
        let _ = req.resp.send(result);
    }
    unsafe { CoUninitialize() };
}

/// 1件のテキストを読み上げる。`SPF_ASYNC` で発話を開始した後、短い間隔でポーリングして
/// 終了 (自然終了 or `SAPI_STOP_REQUESTED` による中断) を待つ。中断時は同じスレッドから
/// 購入フラグ付きで `Speak` を呼び直すことで、COM のスレッド制約に触れずに即座に停止できる。
#[cfg(target_os = "windows")]
fn sapi_speak_interruptible(
    voice: &windows::Win32::Media::Speech::ISpVoice,
    text: &str,
    voice_index: u32,
    rate: i32,
    volume: u32,
) -> Result<(), TtsError> {
    use windows::Win32::Media::Speech::*;
    use windows::Win32::System::Com::*;
    use windows::core::*;

    // 前回の発話が自然終了した後に残っている可能性のある古い停止フラグは、
    // 新しい発話の開始時にクリアする (無関係な次の読み上げを巻き込んで止めないため)
    SAPI_STOP_REQUESTED.store(false, std::sync::atomic::Ordering::SeqCst);

    unsafe {
        let cat: ISpObjectTokenCategory = CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL)
            .map_err(|e| TtsError::Sapi(format!("CoCreateInstance category: {}", e)))?;
        cat.SetId(&HSTRING::from("HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices"), false)
            .map_err(|e| TtsError::Sapi(format!("SetId: {}", e)))?;
        let tokens = cat
            .EnumTokens(None, None)
            .map_err(|e| TtsError::Sapi(format!("EnumTokens: {}", e)))?;
        let mut count: u32 = 0;
        tokens
            .GetCount(&mut count)
            .map_err(|e| TtsError::Sapi(format!("GetCount: {}", e)))?;

        if voice_index < count {
            let token: ISpObjectToken = tokens
                .Item(voice_index)
                .map_err(|e| TtsError::Sapi(format!("Item: {}", e)))?;
            voice
                .SetVoice(&token)
                .map_err(|e| TtsError::Sapi(format!("SetVoice: {}", e)))?;
        }

        voice
            .SetRate(rate)
            .map_err(|e| TtsError::Sapi(format!("SetRate: {}", e)))?;
        voice
            .SetVolume(volume as u16)
            .map_err(|e| TtsError::Sapi(format!("SetVolume: {}", e)))?;

        let text_wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        voice
            .Speak(
                PCWSTR(text_wide.as_ptr()),
                (SPF_PURGEBEFORESPEAK.0 | SPF_ASYNC.0) as u32,
                None,
            )
            .map_err(|e| TtsError::Sapi(format!("Speak: {}", e)))?;

        loop {
            if SAPI_STOP_REQUESTED.swap(false, std::sync::atomic::Ordering::SeqCst) {
                let empty: Vec<u16> = vec![0];
                // 同じスレッド・同じ音声オブジェクトからの呼び出しなので COM のスレッド制約に触れない
                let _ = voice.Speak(PCWSTR(empty.as_ptr()), SPF_PURGEBEFORESPEAK.0 as u32, None);
                break;
            }
            // 状態確認の前に必ず一度スリープする (sleep してから確認、の順を守る)。
            // Speak() 呼び出し直後は SAPI エンジンが「話し始めた」状態にまだ遷移していないことがあり、
            // 間を置かずに GetStatus すると dwRunningState が更新前 (終了扱い) のまま読めてしまう。
            // これを先に確認してしまうと、複数レスを連続で読み上げる際に「まだ話し始めていないのに
            // 終わったと誤判定 → 次のレスが購入フラグ付きで割り込み」を繰り返し、結果として
            // 最後の1件しか実際には再生されない (それより前は全て一瞬で打ち切られる) 不具合になる。
            std::thread::sleep(std::time::Duration::from_millis(30));
            let mut status = SPVOICESTATUS::default();
            voice
                .GetStatus(&mut status, std::ptr::null_mut())
                .map_err(|e| TtsError::Sapi(format!("GetStatus: {}", e)))?;
            if status.dwRunningState != SPRS_IS_SPEAKING.0 as u32 {
                break;
            }
        }
        // text_wide はここまで生きている必要がある (Speak が SPF_ASYNC で戻った後も
        // エンジンが参照し続ける可能性があるため、ポーリングループが終わるまで保持する)
        drop(text_wide);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn sapi_speak(text: &str, voice_index: u32, rate: i32, volume: u32) -> Result<(), TtsError> {
    let (resp_tx, resp_rx) = std::sync::mpsc::channel();
    sapi_worker_sender()
        .send(SapiSpeakRequest {
            text: text.to_string(),
            voice_index,
            rate,
            volume,
            resp: resp_tx,
        })
        .map_err(|_| TtsError::Sapi("SAPI worker thread is not available".to_string()))?;
    resp_rx
        .recv()
        .map_err(|_| TtsError::Sapi("SAPI worker thread stopped responding".to_string()))?
}

#[cfg(not(target_os = "windows"))]
pub fn sapi_speak(_text: &str, _voice_index: u32, _rate: i32, _volume: u32) -> Result<(), TtsError> {
    Err(TtsError::NotSupported)
}

/// 読み上げ中断の要求を出す。実際の中断は常駐スレッド (`sapi_speak_interruptible`) が
/// ポーリング中に検知して行うため、この関数自体は COM を一切呼ばず即座に返る。
#[cfg(target_os = "windows")]
pub fn sapi_stop() -> Result<(), TtsError> {
    SAPI_STOP_REQUESTED.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn sapi_stop() -> Result<(), TtsError> {
    Err(TtsError::NotSupported)
}

// ===== Bouyomichan (RemoteTalk.exe) =====

/// Speak via bouyomichan's RemoteTalk.exe
/// Security: null bytes removed, 2000 char limit, filename verified
pub fn bouyomi_speak(
    remote_talk_path: &str,
    text: &str,
    speed: i32,
    tone: i32,
    volume: i32,
    voice: i32,
) -> Result<(), TtsError> {
    // Validate path ends with RemoteTalk.exe
    let path = std::path::Path::new(remote_talk_path);
    let file_name = path
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("");
    if !file_name.eq_ignore_ascii_case("RemoteTalk.exe") {
        return Err(TtsError::Bouyomi(
            "Invalid path: must point to RemoteTalk.exe".to_string(),
        ));
    }
    if !path.exists() {
        return Err(TtsError::Bouyomi(format!(
            "RemoteTalk.exe not found: {}",
            remote_talk_path
        )));
    }

    // Sanitize text: remove null bytes, limit to 2000 chars
    let sanitized: String = text.replace('\0', "");
    let truncated: String = sanitized.chars().take(2000).collect();

    // RemoteTalk.exe uses positional arguments:
    //   RemoteTalk /T [text] [speed] [tone] [volume] [voice]
    //   speed: -1=default, 50~300
    //   tone:  -1=default, 50~200
    //   volume: -1=default, 0~100
    //   voice: 0=default, 1~8=built-in, 9+=SAPI
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new(remote_talk_path)
            .arg("/T")
            .arg(&truncated)
            .arg(speed.to_string())
            .arg(tone.to_string())
            .arg(volume.to_string())
            .arg(voice.to_string())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| TtsError::Bouyomi(format!("Failed to start RemoteTalk.exe: {}", e)))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new(remote_talk_path)
            .arg("/T")
            .arg(&truncated)
            .arg(speed.to_string())
            .arg(tone.to_string())
            .arg(volume.to_string())
            .arg(voice.to_string())
            .spawn()
            .map_err(|e| TtsError::Bouyomi(format!("Failed to start RemoteTalk.exe: {}", e)))?;
    }

    Ok(())
}

// ===== VOICEVOX (HTTP API) =====

/// Get VOICEVOX speakers list
pub async fn voicevox_get_speakers(
    endpoint: &str,
) -> Result<Vec<VoicevoxSpeaker>, TtsError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| TtsError::Http(e.to_string()))?;

    let url = format!("{}/speakers", endpoint.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| TtsError::Http(format!("GET /speakers: {}", e)))?;

    if !resp.status().is_success() {
        return Err(TtsError::Voicevox(format!(
            "GET /speakers returned {}",
            resp.status()
        )));
    }

    let speakers: Vec<VoicevoxSpeaker> = resp
        .json()
        .await
        .map_err(|e| TtsError::Http(format!("parse speakers: {}", e)))?;

    Ok(speakers)
}

/// Speak text via VOICEVOX HTTP API (audio_query → synthesis → play)
pub async fn voicevox_speak(
    endpoint: &str,
    text: &str,
    speaker_id: i32,
    speed_scale: f64,
    pitch_scale: f64,
    intonation_scale: f64,
    volume_scale: f64,
) -> Result<Vec<u8>, TtsError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| TtsError::Http(e.to_string()))?;

    let base = endpoint.trim_end_matches('/');

    // Step 1: audio_query
    let query_url = format!("{}/audio_query?text={}&speaker={}", base, urlencoding(text), speaker_id);
    let query_resp = client
        .post(&query_url)
        .send()
        .await
        .map_err(|e| TtsError::Http(format!("POST /audio_query: {}", e)))?;

    if !query_resp.status().is_success() {
        return Err(TtsError::Voicevox(format!(
            "POST /audio_query returned {}",
            query_resp.status()
        )));
    }

    let mut query: serde_json::Value = query_resp
        .json()
        .await
        .map_err(|e| TtsError::Http(format!("parse audio_query: {}", e)))?;

    // Apply user params
    if let Some(obj) = query.as_object_mut() {
        obj.insert("speedScale".to_string(), serde_json::json!(speed_scale));
        obj.insert("pitchScale".to_string(), serde_json::json!(pitch_scale));
        obj.insert("intonationScale".to_string(), serde_json::json!(intonation_scale));
        obj.insert("volumeScale".to_string(), serde_json::json!(volume_scale));
    }

    // Step 2: synthesis
    let synth_url = format!("{}/synthesis?speaker={}", base, speaker_id);
    let synth_resp = client
        .post(&synth_url)
        .header("Content-Type", "application/json")
        .body(query.to_string())
        .send()
        .await
        .map_err(|e| TtsError::Http(format!("POST /synthesis: {}", e)))?;

    if !synth_resp.status().is_success() {
        return Err(TtsError::Voicevox(format!(
            "POST /synthesis returned {}",
            synth_resp.status()
        )));
    }

    let wav_bytes = synth_resp
        .bytes()
        .await
        .map_err(|e| TtsError::Http(format!("read wav: {}", e)))?;

    Ok(wav_bytes.to_vec())
}

/// Play WAV bytes via Win32 PlaySoundW (Windows only).
/// Writes to a fixed temp file and plays synchronously (blocks until playback completes).
#[cfg(windows)]
pub fn play_wav_from_bytes(wav: &[u8]) -> Result<(), TtsError> {
    use windows::Win32::Media::Audio::{PlaySoundW, SND_FILENAME, SND_NODEFAULT, SND_SYNC};
    use windows::core::PCWSTR;

    let tmp_path = std::env::temp_dir().join("livefake_voicevox.wav");
    std::fs::write(&tmp_path, wav)?;

    let wide: Vec<u16> = tmp_path
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0u16))
        .collect();

    unsafe {
        let _ = PlaySoundW(PCWSTR(wide.as_ptr()), None, SND_SYNC | SND_FILENAME | SND_NODEFAULT);
    }

    Ok(())
}

#[cfg(not(windows))]
pub fn play_wav_from_bytes(_wav: &[u8]) -> Result<(), TtsError> {
    Err(TtsError::NotSupported)
}

/// Simple URL encoding for VOICEVOX API
fn urlencoding(text: &str) -> String {
    let mut encoded = String::new();
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_text_unlimited() {
        assert_eq!(truncate_text("hello", 0), "hello");
    }

    #[test]
    fn truncate_text_within_limit() {
        assert_eq!(truncate_text("hello", 10), "hello");
    }

    #[test]
    fn truncate_text_exceeds_limit() {
        assert_eq!(truncate_text("こんにちは世界", 3), "こんに");
    }

    #[test]
    fn tts_queue_basic() {
        let mut q = TtsQueue::new();
        q.set_items(vec![
            TtsQueueItem { response_no: 1, text: "a".to_string() },
            TtsQueueItem { response_no: 2, text: "b".to_string() },
        ]);
        assert!(q.is_speaking());
        let item = q.next().unwrap();
        assert_eq!(item.response_no, 1);
        let item = q.next().unwrap();
        assert_eq!(item.response_no, 2);
        assert!(q.next().is_none());
        assert!(!q.is_speaking());
    }

    #[test]
    fn bouyomi_rejects_invalid_path() {
        let result = bouyomi_speak("C:\\malware.exe", "test", 0, 0, 0, 0);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("RemoteTalk.exe"));
    }
}
