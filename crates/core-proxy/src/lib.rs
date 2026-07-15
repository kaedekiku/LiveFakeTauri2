use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProxyError {
    #[error("reqwest error: {0}")]
    Reqwest(#[from] reqwest::Error),
    #[error("{0}")]
    Other(String),
}

// ===== ProxyType =====

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProxyType {
    #[default]
    Http,
    Socks5,
    Socks4,
}

impl ProxyType {
    pub fn as_scheme(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Socks5 => "socks5",
            Self::Socks4 => "socks4",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "socks5" => Self::Socks5,
            "socks4" => Self::Socks4,
            _ => Self::Http,
        }
    }
}

// ===== ProxySettings =====

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    pub enabled: bool,
    #[serde(default)]
    pub proxy_type: ProxyType,
    pub host: String,
    pub port: String,
    pub username: String,
    /// Always plaintext in memory; encryption happens only at persist time.
    pub password: String,
}

// ===== Global proxy state =====

pub fn proxy_settings() -> &'static Mutex<ProxySettings> {
    static SETTINGS: OnceLock<Mutex<ProxySettings>> = OnceLock::new();
    SETTINGS.get_or_init(|| Mutex::new(ProxySettings::default()))
}

/// Replace the global proxy settings. Called when the user saves proxy config.
pub fn update_proxy_settings(settings: ProxySettings) {
    if let Ok(mut guard) = proxy_settings().lock() {
        *guard = settings;
    }
}

// ===== Client builder =====

/// Build a reqwest Client using the current global proxy settings.
pub fn build_client(
    user_agent: &str,
    timeout_secs: u64,
) -> Result<reqwest::Client, ProxyError> {
    let settings = proxy_settings()
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    build_proxied_client(&settings, user_agent, timeout_secs)
}

/// Build a reqwest Client with explicit proxy settings.
pub fn build_proxied_client(
    settings: &ProxySettings,
    user_agent: &str,
    timeout_secs: u64,
) -> Result<reqwest::Client, ProxyError> {
    let mut builder = reqwest::Client::builder()
        .user_agent(user_agent)
        .timeout(Duration::from_secs(timeout_secs));

    if settings.enabled && !settings.host.is_empty() {
        let port = settings.port.parse::<u16>().unwrap_or(8080);
        let proxy_url = if settings.username.is_empty() {
            format!(
                "{}://{}:{}",
                settings.proxy_type.as_scheme(),
                settings.host,
                port
            )
        } else {
            format!(
                "{}://{}:{}@{}:{}",
                settings.proxy_type.as_scheme(),
                percent_encode(&settings.username),
                percent_encode(&settings.password),
                settings.host,
                port
            )
        };
        let proxy = reqwest::Proxy::all(&proxy_url).map_err(ProxyError::Reqwest)?;
        builder = builder.proxy(proxy);
    }

    Ok(builder.build()?)
}

fn percent_encode(s: &str) -> String {
    let mut result = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(b as char);
            }
            _ => result.push_str(&format!("%{:02X}", b)),
        }
    }
    result
}

// ===== Password storage (DPAPI on Windows) =====

const DPAPI_PREFIX: &str = "dpapi:";

/// Encrypt a password for persistence. On Windows this uses DPAPI
/// (current-user scope) and returns `dpapi:<base64>`. On other platforms,
/// or if encryption fails, the plaintext is stored as-is.
pub fn protect_password(plain: &str) -> String {
    if plain.is_empty() {
        return String::new();
    }
    #[cfg(windows)]
    if let Some(cipher) = dpapi::protect(plain.as_bytes()) {
        use base64::Engine as _;
        return format!(
            "{}{}",
            DPAPI_PREFIX,
            base64::engine::general_purpose::STANDARD.encode(cipher)
        );
    }
    plain.to_string()
}

/// Decrypt a stored password. Values without the `dpapi:` prefix are
/// treated as legacy plaintext (backward compat with existing settings.ini).
pub fn unprotect_password(stored: &str) -> String {
    let Some(b64) = stored.strip_prefix(DPAPI_PREFIX) else {
        return stored.to_string();
    };
    #[cfg(windows)]
    {
        use base64::Engine as _;
        if let Ok(cipher) = base64::engine::general_purpose::STANDARD.decode(b64) {
            if let Some(plain) = dpapi::unprotect(&cipher) {
                if let Ok(s) = String::from_utf8(plain) {
                    return s;
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = b64;
    String::new()
}

#[cfg(windows)]
mod dpapi {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };

    fn take_blob(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: on success DPAPI fills pbData with cbData bytes allocated
        // via LocalAlloc; we copy them out and free the buffer.
        let out = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
        unsafe {
            let _ = LocalFree(HLOCAL(blob.pbData as _));
        }
        out
    }

    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .ok()?;
        }
        Some(take_blob(output))
    }

    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .ok()?;
        }
        Some(take_blob(output))
    }
}

#[cfg(all(test, windows))]
mod password_tests {
    use super::*;

    #[test]
    fn dpapi_roundtrip_works() {
        let stored = protect_password("s3cret-パスワード");
        assert!(stored.starts_with(DPAPI_PREFIX));
        assert_eq!(unprotect_password(&stored), "s3cret-パスワード");
    }

    #[test]
    fn legacy_plaintext_passthrough() {
        assert_eq!(unprotect_password("plain-legacy"), "plain-legacy");
        assert_eq!(protect_password(""), "");
        assert_eq!(unprotect_password(""), "");
    }
}

// ===== ImageViewURLReplace rule type =====

/// One row from ImageViewURLReplace.txt.
/// The `pattern` is a JS-compatible regex string.
/// URL transformation is applied in the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlReplaceRule {
    pub pattern: String,
    pub replacement: String,
    pub referer: Option<String>,
}

/// Parse TSV rules file content into rule structs.
/// Format per line: `pattern<TAB>replacement[<TAB>referer]`
/// Lines starting with `#` or blank are skipped.
pub fn parse_url_replace_rules(content: &str) -> Vec<UrlReplaceRule> {
    let mut rules = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = trimmed.splitn(3, '\t').collect();
        if parts.len() < 2 {
            continue;
        }
        rules.push(UrlReplaceRule {
            pattern: parts[0].to_string(),
            replacement: parts[1].to_string(),
            referer: parts.get(2).filter(|s| !s.is_empty()).map(|s| s.to_string()),
        });
    }
    rules
}

