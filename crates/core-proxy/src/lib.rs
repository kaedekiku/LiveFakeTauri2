use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
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
//
// 受信用 (掲示板の読み込み) と送信用 (書き込み・スレ立て) で別のプロキシを使える (JaneXeno の設定と同じ考え方)。
// 画像・リンクカード・Twitch・YouTube・更新の確認はプロキシを通さない (家庭内アドレスへの接続を防ぐ検査を保つため)。
//
// http_mode: 2chAPIProxy などのローカルのプロキシに 5ch の通信を処理させるため、5ch へのアドレスを
// `http://○○.5ch.net/…` の形にしてプロキシへ渡す (2chAPIProxy は https の通信を中身を見ずに通すため)。
// 暗号化しない通信を外へ出さないよう、プロキシの種類が HTTP で、ホストがこの PC (localhost など) のときだけ働く。
// プロキシから 5ch までを https にするかはプロキシ側の設定 (2chAPIProxy の「2chへのアクセスにhttps(TLS)を利用する」)。

/// プロキシ1組 (ホスト・ポート・認証)
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyEndpoint {
    pub host: String,
    pub port: String,
    pub username: String,
    /// Always plaintext in memory; encryption happens only at persist time.
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    pub enabled: bool,
    #[serde(default)]
    pub proxy_type: ProxyType,
    /// プロキシに古い控え (キャッシュ) を返さないよう頼む (Cache-Control: no-cache)
    #[serde(default)]
    pub no_cache: bool,
    /// 5ch の通信を http でローカルのプロキシに渡す
    #[serde(default)]
    pub http_mode: bool,
    #[serde(default)]
    pub receive: ProxyEndpoint,
    #[serde(default)]
    pub send: ProxyEndpoint,
}

/// どの通信か
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyRole {
    /// 掲示板の読み込み (板一覧・スレ一覧・レス)
    Receive,
    /// 書き込み・スレ立て
    Send,
}

impl ProxySettings {
    fn endpoint(&self, role: ProxyRole) -> &ProxyEndpoint {
        match role {
            ProxyRole::Receive => &self.receive,
            ProxyRole::Send => &self.send,
        }
    }

    /// この通信でプロキシを使うか (有効で、ホストが書いてある)
    pub fn uses_proxy(&self, role: ProxyRole) -> bool {
        self.enabled && !self.endpoint(role).host.trim().is_empty()
    }

    /// この通信で 5ch を http で渡すか (HTTP 形式のローカルのプロキシのときだけ)
    pub fn http_mode_active(&self, role: ProxyRole) -> bool {
        self.uses_proxy(role) && self.http_mode && self.proxy_type == ProxyType::Http && is_local_host(&self.endpoint(role).host)
    }

    /// プロキシのアドレス (例: `http://user:pass@127.0.0.1:8080`)。SOCKS は名前の問い合わせ (DNS) もプロキシに任せる形にする
    pub fn proxy_url(&self, role: ProxyRole) -> Option<String> {
        if !self.uses_proxy(role) {
            return None;
        }
        let ep = self.endpoint(role);
        let scheme = match self.proxy_type {
            ProxyType::Http => "http",
            ProxyType::Socks5 => "socks5h",
            ProxyType::Socks4 => "socks4a",
        };
        let port = port_or_default(&ep.port);
        let host = ep.host.trim();
        let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_string() };
        Some(if ep.username.is_empty() {
            format!("{scheme}://{host}:{port}")
        } else {
            format!("{scheme}://{}:{}@{host}:{port}", percent_encode(&ep.username), percent_encode(&ep.password))
        })
    }
}

/// ポート (数字でなければ 8080)
fn port_or_default(port: &str) -> u16 {
    port.trim().parse::<u16>().ok().filter(|p| *p > 0).unwrap_or(8080)
}

/// この PC を指すホストか (localhost・127.x.x.x・::1)
pub fn is_local_host(host: &str) -> bool {
    let h = host.trim().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    h == "localhost" || h == "::1" || h.parse::<std::net::Ipv4Addr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

/// 5ch (5ch.io / 5ch.net / 2ch.net / bbspink.com) のホストか
fn is_5ch_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    ["5ch.io", "5ch.net", "2ch.net", "bbspink.com"].iter().any(|d| h == *d || h.ends_with(&format!(".{d}")))
}

// ===== Global proxy state =====

pub fn proxy_settings() -> &'static Mutex<ProxySettings> {
    static SETTINGS: OnceLock<Mutex<ProxySettings>> = OnceLock::new();
    SETTINGS.get_or_init(|| Mutex::new(ProxySettings::default()))
}

/// Replace the global proxy settings. Called when the user saves proxy config and at startup.
pub fn update_proxy_settings(settings: ProxySettings) {
    if let Ok(mut guard) = proxy_settings().lock() {
        *guard = settings;
    }
}

fn current() -> ProxySettings {
    proxy_settings().lock().map(|g| g.clone()).unwrap_or_default()
}

// ===== 通信への反映 =====

/// クライアントの作り方にプロキシ (と、キャッシュを使わない指定) を足す。プロキシを使わない設定なら何もしない
pub fn apply(builder: reqwest::ClientBuilder, role: ProxyRole) -> Result<reqwest::ClientBuilder, ProxyError> {
    apply_with(&current(), builder, role)
}

pub fn apply_with(settings: &ProxySettings, builder: reqwest::ClientBuilder, role: ProxyRole) -> Result<reqwest::ClientBuilder, ProxyError> {
    let Some(url) = settings.proxy_url(role) else {
        return Ok(builder);
    };
    let proxy = reqwest::Proxy::all(&url).map_err(|_| ProxyError::Other("プロキシの設定が正しくありません (ホスト・ポートを確かめてください)".into()))?;
    let mut builder = builder.proxy(proxy);
    if settings.no_cache {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::CACHE_CONTROL, reqwest::header::HeaderValue::from_static("no-cache"));
        headers.insert(reqwest::header::PRAGMA, reqwest::header::HeaderValue::from_static("no-cache"));
        builder = builder.default_headers(headers);
    }
    Ok(builder)
}

/// 実際に送るときのアドレス。http_mode が働くときは、5ch の https のアドレスを `http://○○.5ch.net/…` にする
/// (2chAPIProxy が処理するのは http の 5ch.net 形式。5ch.io への置き換えと https 化はプロキシ側が行う)。
/// それ以外はそのまま返す。画面に出す・保存するアドレスには使わない (送る直前だけに使う)
pub fn transport_url(url: &str, role: ProxyRole) -> String {
    transport_url_with(&current(), url, role)
}

pub fn transport_url_with(settings: &ProxySettings, url: &str, role: ProxyRole) -> String {
    if !settings.http_mode_active(role) {
        return url.to_string();
    }
    // https のほか、リダイレクトで返ってきた http の 5ch.io も 5ch.net の形にそろえる
    let Some(rest) = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) else {
        return url.to_string();
    };
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if host.contains('@') || host.contains(':') || !is_5ch_host(host) {
        return url.to_string();
    }
    let host = match host.to_ascii_lowercase().strip_suffix(".5ch.io") {
        Some(sub) => format!("{sub}.5ch.net"),
        None => host.to_string(),
    };
    format!("http://{host}{path}")
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

#[cfg(test)]
mod proxy_tests {
    use super::*;

    fn settings(ty: ProxyType, host: &str, http_mode: bool) -> ProxySettings {
        let ep = ProxyEndpoint { host: host.into(), port: "8080".into(), username: String::new(), password: String::new() };
        ProxySettings { enabled: true, proxy_type: ty, no_cache: false, http_mode, receive: ep.clone(), send: ep }
    }

    #[test]
    fn proxy_urls() {
        let s = settings(ProxyType::Http, "localhost", false);
        assert_eq!(s.proxy_url(ProxyRole::Receive).as_deref(), Some("http://localhost:8080"));
        let mut s5 = settings(ProxyType::Socks5, "127.0.0.1", false);
        s5.send.port = "abc".into();
        s5.send.username = "u@x".into();
        s5.send.password = "p:w".into();
        assert_eq!(s5.proxy_url(ProxyRole::Receive).as_deref(), Some("socks5h://127.0.0.1:8080"));
        assert_eq!(s5.proxy_url(ProxyRole::Send).as_deref(), Some("socks5h://u%40x:p%3Aw@127.0.0.1:8080"));
        assert_eq!(settings(ProxyType::Socks4, "::1", false).proxy_url(ProxyRole::Send).as_deref(), Some("socks4a://[::1]:8080"));
        let mut off = settings(ProxyType::Http, "localhost", false);
        off.enabled = false;
        assert_eq!(off.proxy_url(ProxyRole::Receive), None);
        let mut no_send = settings(ProxyType::Http, "localhost", false);
        no_send.send.host = " ".into();
        assert!(no_send.uses_proxy(ProxyRole::Receive) && !no_send.uses_proxy(ProxyRole::Send));
    }

    #[test]
    fn http_mode_only_for_local_http_proxy() {
        let s = settings(ProxyType::Http, "localhost", true);
        assert_eq!(transport_url_with(&s, "https://mi.5ch.io/news4vip/dat/1.dat", ProxyRole::Receive), "http://mi.5ch.net/news4vip/dat/1.dat");
        assert_eq!(transport_url_with(&s, "https://mi.5ch.io/test/bbs.cgi", ProxyRole::Send), "http://mi.5ch.net/test/bbs.cgi");
        assert_eq!(transport_url_with(&s, "https://mi.5ch.net/test/read.cgi/a/1/", ProxyRole::Send), "http://mi.5ch.net/test/read.cgi/a/1/");
        assert_eq!(transport_url_with(&s, "https://kilauea.bbspink.com/x/dat/1.dat", ProxyRole::Receive), "http://kilauea.bbspink.com/x/dat/1.dat");
        assert_eq!(transport_url_with(&s, "http://mi.5ch.io/test/bbs.cgi?guid=ON", ProxyRole::Send), "http://mi.5ch.net/test/bbs.cgi?guid=ON");
        // 5ch 以外・偽装したホストはそのまま
        assert_eq!(transport_url_with(&s, "https://jbbs.shitaraba.net/bbs/write.cgi", ProxyRole::Send), "https://jbbs.shitaraba.net/bbs/write.cgi");
        assert_eq!(transport_url_with(&s, "https://5ch.io.evil.example/x", ProxyRole::Send), "https://5ch.io.evil.example/x");
        assert_eq!(transport_url_with(&s, "https://evil.example@mi.5ch.io/x", ProxyRole::Send), "https://evil.example@mi.5ch.io/x");
        // 外のプロキシ・SOCKS・切り替えオフでは http にしない
        assert_eq!(transport_url_with(&settings(ProxyType::Http, "proxy.example.com", true), "https://mi.5ch.io/x", ProxyRole::Receive), "https://mi.5ch.io/x");
        assert_eq!(transport_url_with(&settings(ProxyType::Socks5, "localhost", true), "https://mi.5ch.io/x", ProxyRole::Receive), "https://mi.5ch.io/x");
        assert_eq!(transport_url_with(&settings(ProxyType::Http, "localhost", false), "https://mi.5ch.io/x", ProxyRole::Receive), "https://mi.5ch.io/x");
    }

    #[test]
    fn local_hosts() {
        for h in ["localhost", "127.0.0.1", "127.0.0.2", "::1", "[::1]", " LOCALHOST "] {
            assert!(is_local_host(h), "{h}");
        }
        for h in ["192.168.0.1", "proxy.example.com", "localhost.evil.example", ""] {
            assert!(!is_local_host(h), "{h}");
        }
    }

    #[test]
    fn apply_builds_client() {
        let mut s = settings(ProxyType::Http, "localhost", true);
        s.no_cache = true;
        assert!(apply_with(&s, reqwest::Client::builder(), ProxyRole::Receive).and_then(|b| b.build().map_err(ProxyError::from)).is_ok());
        s.receive.host = "bad host!".into();
        assert!(apply_with(&s, reqwest::Client::builder(), ProxyRole::Receive).is_err());
    }
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

