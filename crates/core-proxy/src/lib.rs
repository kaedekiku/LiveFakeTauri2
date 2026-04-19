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

// ===== Password storage (plaintext) =====

/// Store a password as-is (no encryption).
pub fn protect_password(plain: &str) -> String {
    plain.to_string()
}

/// Retrieve a stored password as-is.
pub fn unprotect_password(stored: &str) -> String {
    stored.to_string()
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

// ===== Cookie entry type =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieEntry {
    pub name: String,
    pub value: String,
    pub domain: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_unix: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issued_user_agent: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CookiesFile {
    pub version: u32,
    pub cookies: Vec<CookieEntry>,
}

/// Parse a `Set-Cookie` header value into a `CookieEntry`.
/// Returns `None` if `name=value` cannot be extracted.
pub fn parse_set_cookie(header: &str, domain: &str, user_agent: &str) -> Option<CookieEntry> {
    let mut parts = header.splitn(2, ';');
    let name_value = parts.next()?.trim();
    let (name, value) = name_value.split_once('=')?;
    let name = name.trim().to_string();
    let value = value.trim().to_string();
    if name.is_empty() {
        return None;
    }

    let rest = parts.next().unwrap_or("").to_lowercase();

    // Parse expires or max-age
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let expires_unix = if let Some(ma) = rest
        .split(';')
        .find(|p| p.trim_start().starts_with("max-age="))
    {
        ma.trim_start().trim_start_matches("max-age=").trim().parse::<i64>().ok().map(|s| now_secs + s)
    } else if let Some(exp_part) = rest
        .split(';')
        .find(|p| p.trim_start().starts_with("expires="))
    {
        // Best-effort RFC 2616 date parse (not required to be perfect)
        let date_str = exp_part.trim_start().trim_start_matches("expires=").trim();
        parse_http_date(date_str)
    } else {
        None
    };

    Some(CookieEntry {
        name,
        value,
        domain: domain.to_string(),
        expires_unix,
        issued_user_agent: if user_agent.is_empty() {
            None
        } else {
            Some(user_agent.to_string())
        },
    })
}

/// Remove expired cookies from a list. Pass current unix timestamp.
pub fn filter_valid_cookies(cookies: Vec<CookieEntry>, now_secs: i64) -> Vec<CookieEntry> {
    cookies
        .into_iter()
        .filter(|c| c.expires_unix.map_or(true, |exp| exp > now_secs))
        .collect()
}

/// Best-effort HTTP date parser.  Returns `None` if parsing fails.
fn parse_http_date(s: &str) -> Option<i64> {
    // Try common format: "Fri, 01 Jan 2100 00:00:00 GMT"
    // We extract year, month, day, H, M, S and convert to approximate unix ts.
    let months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 4 { return None; }
    // Skip weekday prefix
    let offset = if parts[0].ends_with(',') { 1 } else { 0 };
    let day: i64 = parts.get(offset)?.parse().ok()?;
    let mon_str = parts.get(offset + 1)?.to_lowercase();
    let month = months.iter().position(|&m| m == mon_str)? as i64 + 1;
    let year: i64 = parts.get(offset + 2)?.parse().ok()?;
    let time_str = parts.get(offset + 3)?;
    let mut t = time_str.split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let m: i64 = t.next()?.parse().ok()?;
    let s: i64 = t.next()?.parse().ok()?;

    // Days from epoch (1970-01-01) to year/month/day  (approx, ignores leap seconds)
    let y = year - 1970;
    let leap_days = y / 4 - y / 100 + y / 400;
    let month_days: [i64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let yday: i64 = month_days[..(month - 1) as usize].iter().sum::<i64>() + day - 1;
    let days = y * 365 + leap_days + yday;
    Some(days * 86400 + h * 3600 + m * 60 + s)
}
