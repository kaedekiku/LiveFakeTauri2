use reqwest::cookie::{CookieStore, Jar};
use reqwest::{redirect::Policy, Client};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Command;
use std::sync::Arc;
use thiserror::Error;
use url::Url;
use core_parse::{parse_dat_line, parse_subject_line};
use encoding_rs::{EUC_JP, SHIFT_JIS};

pub const BBSMENU_URL: &str = "https://menu.5ch.io/bbsmenu.json";

#[derive(Debug, Error)]
pub enum FetchError {
    #[error("request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("url parse failed: {0}")]
    Url(#[from] url::ParseError),
    #[error("unexpected status: {0}")]
    HttpStatus(reqwest::StatusCode),
    #[error("parse failed: {0}")]
    Parse(String),
    /// SSRF 対策で接続を拒否した (私有アドレス・ループバック等)。
    #[error("blocked: {0}")]
    Blocked(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostCookieReport {
    pub target_url: String,
    pub cookie_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostFormTokens {
    pub thread_url: String,
    pub post_url: String,
    pub bbs: String,
    pub key: String,
    pub time: String,
    pub oekaki_thread1: Option<String>,
    pub has_message_textarea: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostConfirmResult {
    pub post_url: String,
    pub status: u16,
    pub content_type: Option<String>,
    pub contains_confirm: bool,
    pub contains_error: bool,
    pub body_preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostFinalizePreview {
    pub action_url: String,
    pub field_names: Vec<String>,
    pub field_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostSubmitResult {
    pub action_url: String,
    pub status: u16,
    pub content_type: Option<String>,
    pub contains_error: bool,
    pub body_preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectThread {
    pub thread_key: String,
    pub title: String,
    pub response_count: u32,
    pub thread_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResponse {
    pub response_no: u32,
    pub name: String,
    pub mail: String,
    pub date_and_id: String,
    pub body: String,
}

fn parse_dat_title(line: &str) -> Option<String> {
    let mut it = line.split("<>");
    let _name = it.next()?;
    let _mail = it.next()?;
    let _date_and_id = it.next()?;
    let _body = it.next()?;
    let title = it.next()?.trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

#[derive(Debug, Clone)]
struct ConfirmSubmitForm {
    action_url: String,
    fields: Vec<(String, String)>,
}

pub fn resolve_subject_url_from_thread_url(thread_url: &str) -> Result<String, FetchError> {
    let normalized = normalize_5ch_url(thread_url);
    let parsed = Url::parse(&normalized)?;
    let mut segs = parsed
        .path_segments()
        .ok_or_else(|| FetchError::Parse("path segments".into()))?;
    let parts = segs.by_ref().collect::<Vec<_>>();
    if parts.is_empty() {
        return Err(FetchError::Parse("path segments".into()));
    }

    let board = if parts.len() >= 2 && parts[parts.len() - 1] == "subject.txt" {
        parts[parts.len() - 2]
    } else if parts.len() >= 4 && parts[0] == "test" && parts[1] == "read.cgi" {
        parts[2]
    } else if !parts[0].is_empty() && parts[0] != "test" {
        parts[0]
    } else {
        return Err(FetchError::Parse(
            "unsupported url; use thread url, board url, or subject.txt".into(),
        ));
    };

    let host = parsed
        .host_str()
        .ok_or_else(|| FetchError::Parse("thread host".into()))?;
    Ok(format!("{}://{}/{}/subject.txt", parsed.scheme(), host, board))
}

pub async fn fetch_subject_threads(
    client: &Client,
    thread_url: &str,
    _limit: usize,
) -> Result<Vec<SubjectThread>, FetchError> {
    let subject_url = resolve_subject_url_from_thread_url(thread_url)?;
    let response = client.get(&subject_url).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(FetchError::HttpStatus(status));
    }
    let bytes = response.bytes().await?;
    let (decoded, _, _) = SHIFT_JIS.decode(&bytes);
    let body = decoded.into_owned();

    let subject = Url::parse(&subject_url)?;
    let host = subject
        .host_str()
        .ok_or_else(|| FetchError::Parse("thread host".into()))?;
    let mut segs = subject
        .path_segments()
        .ok_or_else(|| FetchError::Parse("path segments".into()))?;
    let board = segs
        .next()
        .ok_or_else(|| FetchError::Parse("board segment".into()))?;
    if board.is_empty() {
        return Err(FetchError::Parse("board segment".into()));
    }

    let mut out = Vec::new();
    for line in body.lines() {
        if let Some(entry) = parse_subject_line(line) {
            out.push(SubjectThread {
                thread_key: entry.thread_key.clone(),
                title: entry.title,
                response_count: entry.response_count,
                thread_url: format!(
                    "{}://{}/test/read.cgi/{}/{}/",
                    subject.scheme(),
                    host,
                    board,
                    entry.thread_key
                ),
            });
        }
    }
    Ok(out)
}

pub fn build_cookie_client(user_agent: &str) -> Result<(Client, Arc<Jar>), FetchError> {
    let jar = Arc::new(Jar::default());
    let client = Client::builder()
        .user_agent(user_agent)
        .cookie_provider(jar.clone())
        .redirect(Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    Ok((client, jar))
}

pub fn normalize_5ch_url(input: &str) -> String {
    if let Ok(mut parsed) = Url::parse(input) {
        if let Some(host) = parsed.host_str().map(|h| h.to_string()) {
            if host.ends_with(".5ch.net") {
                let new_host = format!("{}.5ch.io", &host[..host.len() - ".5ch.net".len()]);
                let _ = parsed.set_host(Some(&new_host));
            } else if host == "5ch.net" {
                let _ = parsed.set_host(Some("5ch.io"));
            }
        }
        return parsed.to_string();
    }

    input.replace("5ch.net", "5ch.io")
}

pub async fn fetch_bbsmenu_json(client: &Client) -> Result<Value, FetchError> {
    let response = client.get(BBSMENU_URL).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(FetchError::HttpStatus(status));
    }
    Ok(response.json::<Value>().await?)
}

pub fn seed_cookie(jar: &Jar, url: &str, cookie: &str) -> Result<(), FetchError> {
    let parsed = Url::parse(url)?;
    jar.add_cookie_str(cookie, &parsed);
    Ok(())
}

pub fn cookie_names_for_url(jar: &Jar, url: &str) -> Result<Vec<String>, FetchError> {
    let parsed = Url::parse(url)?;
    let raw = jar
        .cookies(&parsed)
        .and_then(|v| v.to_str().ok().map(|s| s.to_string()))
        .unwrap_or_default();

    let mut names = Vec::new();
    for part in raw.split(';') {
        let seg = part.trim();
        if seg.is_empty() {
            continue;
        }
        if let Some((name, _)) = seg.split_once('=') {
            names.push(name.trim().to_string());
        }
    }
    names.sort();
    names.dedup();
    Ok(names)
}

pub fn probe_post_cookie_scope(jar: &Jar, post_url: &str) -> Result<PostCookieReport, FetchError> {
    let cookie_names = cookie_names_for_url(jar, post_url)?;
    Ok(PostCookieReport {
        target_url: post_url.to_string(),
        cookie_names,
    })
}

// --------------------------------------------------------------------------
// SSRF 対策: 接続先アドレス検証
// --------------------------------------------------------------------------

/// IPv4 アドレスが「インターネット上の公開アドレス」か判定する。
/// 予約済み範囲 (RFC 1918 私有・ループバック・リンクローカル・CGNAT・文書用・
/// マルチキャスト・将来予約) のみ false。それ以外の公開 IP (自宅サーバ等) は true。
fn ipv4_is_public(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    !(o[0] == 0 // 0.0.0.0/8 (this network)
        || o[0] == 10 // 10.0.0.0/8
        || (o[0] == 100 && (o[1] & 0xC0) == 64) // 100.64.0.0/10 (CGNAT)
        || o[0] == 127 // 127.0.0.0/8
        || (o[0] == 169 && o[1] == 254) // 169.254.0.0/16 (link-local / クラウドメタデータ)
        || (o[0] == 172 && (o[1] & 0xF0) == 16) // 172.16.0.0/12
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24
        || (o[0] == 192 && o[1] == 0 && o[2] == 2) // 192.0.2.0/24 (TEST-NET-1)
        || (o[0] == 192 && o[1] == 168) // 192.168.0.0/16
        || (o[0] == 198 && (o[1] & 0xFE) == 18) // 198.18.0.0/15 (benchmark)
        || (o[0] == 198 && o[1] == 51 && o[2] == 100) // 198.51.100.0/24 (TEST-NET-2)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113) // 203.0.113.0/24 (TEST-NET-3)
        || o[0] >= 224) // 224.0.0.0/4 マルチキャスト, 240.0.0.0/4 予約, 255.255.255.255
}

/// IPv6 アドレスが公開アドレスか判定する。IPv4 埋め込み形式 (mapped / compatible /
/// NAT64 / 6to4) は埋め込まれた IPv4 を取り出して `ipv4_is_public` で判定する。
fn ipv6_is_public(ip: std::net::Ipv6Addr) -> bool {
    if ip.is_unspecified() || ip.is_loopback() {
        return false;
    }
    let s = ip.segments();
    // ::ffff:a.b.c.d (IPv4-mapped) / ::a.b.c.d (IPv4-compatible)
    if let Some(v4) = ip.to_ipv4() {
        return ipv4_is_public(v4);
    }
    // 64:ff9b::/96 (NAT64)
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6].iter().all(|x| *x == 0) {
        let v4 = std::net::Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
        return ipv4_is_public(v4);
    }
    // 2002::/16 (6to4)
    if s[0] == 0x2002 {
        let v4 = std::net::Ipv4Addr::new((s[1] >> 8) as u8, s[1] as u8, (s[2] >> 8) as u8, s[2] as u8);
        return ipv4_is_public(v4);
    }
    !((s[0] & 0xfe00) == 0xfc00 // fc00::/7 (unique local)
        || (s[0] & 0xffc0) == 0xfe80 // fe80::/10 (link-local)
        || (s[0] & 0xff00) == 0xff00 // ff00::/8 (multicast)
        || (s[0] == 0x2001 && s[1] == 0x0db8)) // 2001:db8::/32 (文書用)
}

/// 接続先として許可できる公開 IP アドレスか。
pub fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => ipv4_is_public(v4),
        std::net::IpAddr::V6(v6) => ipv6_is_public(v6),
    }
}

/// OGP 取得対象 URL を検証する (スキーム・認証情報・ホスト) と同時に DNS を解決し、
/// 解決結果の **全アドレス** が公開 IP であることを確認する。
/// 戻り値は `(ドメイン名 (IP リテラルなら None), 解決済みアドレス一覧)`。
/// 呼び出し側はこのアドレスを HTTP クライアントに固定して接続する (DNS リバインディング対策)。
async fn validate_ogp_target(url: &Url) -> Result<(Option<String>, Vec<std::net::SocketAddr>), FetchError> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(FetchError::Blocked("unsupported scheme".into()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(FetchError::Blocked("userinfo in url".into()));
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| FetchError::Blocked("no port".into()))?;
    match url.host() {
        Some(url::Host::Ipv4(v4)) => {
            if !ipv4_is_public(v4) {
                return Err(FetchError::Blocked("private address".into()));
            }
            Ok((None, vec![std::net::SocketAddr::new(v4.into(), port)]))
        }
        Some(url::Host::Ipv6(v6)) => {
            if !ipv6_is_public(v6) {
                return Err(FetchError::Blocked("private address".into()));
            }
            Ok((None, vec![std::net::SocketAddr::new(v6.into(), port)]))
        }
        Some(url::Host::Domain(domain)) => {
            let lower = domain.to_ascii_lowercase();
            if lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local") {
                return Err(FetchError::Blocked("local hostname".into()));
            }
            let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((lower.as_str(), port))
                .await
                .map_err(|e| FetchError::Blocked(format!("dns failed: {e}")))?
                .collect();
            if addrs.is_empty() {
                return Err(FetchError::Blocked("dns returned no address".into()));
            }
            if addrs.iter().any(|a| !is_public_ip(a.ip())) {
                return Err(FetchError::Blocked("resolves to private address".into()));
            }
            Ok((Some(lower), addrs))
        }
        None => Err(FetchError::Blocked("no host".into())),
    }
}

// --------------------------------------------------------------------------
// OGP (Open Graph Protocol) カード取得
// --------------------------------------------------------------------------

/// 本文中の URL から抽出した OGP メタ情報。フロントの「リンクカード」表示に使う。
/// 取得できなかったフィールドは `None`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OgpCard {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub site_name: Option<String>,
}

/// og タグは `<head>` 内にあるので、本文全体を読み込まず先頭のみで打ち切る上限。
pub const OGP_MAX_BYTES: usize = 512 * 1024;
/// 手動で追従するリダイレクトの最大回数 (各ホップで接続先を再検証する)。
const OGP_MAX_REDIRECTS: usize = 5;

/// 生バイト先頭から `charset=` を拾って encoding を推定 (Content-Type ヘッダ欠落時)。
fn detect_meta_charset(bytes: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    let head = &bytes[..bytes.len().min(4096)];
    let text = String::from_utf8_lossy(head).to_ascii_lowercase();
    let idx = text.find("charset=")?;
    // `charset="shift-jis"` のようにクォートで囲まれる場合があるため先頭の空白・引用符を除去
    let rest = text[idx + "charset=".len()..]
        .trim_start()
        .trim_start_matches(['"', '\'']);
    let label: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    encoding_rs::Encoding::for_label(label.as_bytes())
}

/// 相対 URL (og:image が相対パスの場合) をページ URL 基準で絶対化する。
fn resolve_url(base: &str, maybe_relative: &str) -> String {
    match Url::parse(base).and_then(|b| b.join(maybe_relative)) {
        Ok(u) => u.to_string(),
        Err(_) => maybe_relative.to_string(),
    }
}

/// HTML エンティティ (`&amp;` `&#39;` `&#x3042;` 等) を文字に戻す。未知のものはそのまま残す。
fn decode_html_entities(input: &str) -> String {
    if !input.contains('&') {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp..];
        let Some(semi) = after.find(';').filter(|i| *i <= 12) else {
            out.push('&');
            rest = &after[1..];
            continue;
        };
        let entity = &after[1..semi];
        let decoded: Option<char> = if let Some(hex) = entity.strip_prefix("#x").or_else(|| entity.strip_prefix("#X")) {
            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
        } else if let Some(dec) = entity.strip_prefix('#') {
            dec.parse::<u32>().ok().and_then(char::from_u32)
        } else {
            match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some('\u{a0}'),
                _ => None,
            }
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &after[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// タグ内部 (`<meta` の直後から `>` の手前まで) の属性を `(小文字属性名, 値)` で列挙する。
/// 属性の順序・引用符の有無・単一引用符を問わない寛容な実装。
fn parse_tag_attrs(tag: &str) -> Vec<(String, String)> {
    let b = tag.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        let start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' && b[i] != b'/' {
            i += 1;
        }
        if i == start {
            i += 1;
            continue;
        }
        let name = tag[start..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let quote = b[i];
                i += 1;
                let vs = i;
                while i < b.len() && b[i] != quote {
                    i += 1;
                }
                value = tag[vs..i].to_string();
                if i < b.len() {
                    i += 1;
                }
            } else {
                let vs = i;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                value = tag[vs..i].to_string();
            }
        }
        out.push((name, value));
    }
    out
}

/// `from` 以降で、引用符の外側にある最初の `>` の位置を返す。
fn find_tag_end(bytes: &[u8], from: usize) -> Option<usize> {
    let mut quote: Option<u8> = None;
    for (i, &c) in bytes.iter().enumerate().skip(from) {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None => {
                if c == b'"' || c == b'\'' {
                    quote = Some(c);
                } else if c == b'>' {
                    return Some(i);
                }
            }
        }
    }
    None
}

/// HTML から `<meta property|name=... content=...>` を集めた辞書と `<title>` を取り出す。
/// 同じキーが複数あれば最初のものを採用する。
fn collect_meta(html: &str) -> (std::collections::HashMap<String, String>, Option<String>) {
    // ASCII 小文字化は byte 長を変えないので、元文字列と同じオフセットで扱える
    let lower = html.to_ascii_lowercase();
    let lb = lower.as_bytes();
    let mut metas: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut pos = 0;
    while let Some(rel) = lower[pos..].find("<meta") {
        let start = pos + rel;
        let after = start + "<meta".len();
        pos = after;
        // `<metadata` 等を除外
        if !matches!(lb.get(after), Some(c) if c.is_ascii_whitespace() || *c == b'/' || *c == b'>') {
            continue;
        }
        let Some(end) = find_tag_end(lb, after) else {
            break;
        };
        let attrs = parse_tag_attrs(&html[after..end]);
        pos = end + 1;
        let key = attrs
            .iter()
            .find(|(n, _)| n == "property")
            .or_else(|| attrs.iter().find(|(n, _)| n == "name"))
            .map(|(_, v)| v.trim().to_ascii_lowercase());
        let content = attrs.iter().find(|(n, _)| n == "content").map(|(_, v)| v.as_str());
        if let (Some(key), Some(content)) = (key, content) {
            let value = decode_html_entities(content.trim());
            if !key.is_empty() && !value.is_empty() {
                metas.entry(key).or_insert(value);
            }
        }
    }

    let title = lower.find("<title").and_then(|ts| {
        let open_end = find_tag_end(lb, ts + "<title".len())?;
        let close = lower[open_end + 1..].find("</title")?;
        let text = &html[open_end + 1..open_end + 1 + close];
        let text = decode_html_entities(text).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    });
    (metas, title)
}

/// HTML 文字列から OGP を抽出する純粋関数 (ネットワーク不要・テスト対象)。
/// `url` はカードに記録する URL、相対 `og:image` の解決基準にもなる。
pub fn parse_ogp(url: &str, html: &str) -> OgpCard {
    parse_ogp_with_base(url, url, html)
}

/// `base` はリダイレクト後の最終 URL (相対 `og:image` の解決基準)。
fn parse_ogp_with_base(url: &str, base: &str, html: &str) -> OgpCard {
    let (metas, doc_title) = collect_meta(html);
    let get = |k: &str| metas.get(k).cloned();
    let title = get("og:title").or(doc_title);
    let description = get("og:description").or_else(|| get("description"));
    let image = get("og:image")
        .or_else(|| get("og:image:url"))
        .or_else(|| get("og:image:secure_url"))
        .map(|img| resolve_url(base, &img));
    let site_name = get("og:site_name");

    OgpCard {
        url: url.to_string(),
        title,
        description,
        image,
        site_name,
    }
}

/// Content-Type が HTML/XHTML/XML 系か (それ以外は動画ストリーム等なので本文を読まない)。
fn content_type_is_html(ct: Option<&str>) -> bool {
    match ct {
        None => true, // ヘッダ欠落時は本文を読んで判断する (上限つき)
        Some(ct) => {
            let media = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            media.is_empty() || media.contains("html") || media.contains("xml")
        }
    }
}

fn charset_from_content_type(ct: Option<&str>) -> Option<String> {
    ct.and_then(|ct| {
        ct.split(';').find_map(|part| {
            part.trim()
                .strip_prefix("charset=")
                .map(|c| c.trim_matches('"').to_string())
        })
    })
}

/// 外部 URL の HTML を取得し OGP メタ情報を抽出する (SSRF 対策版)。
///
/// - 各ホップ (初回要求 + リダイレクト) ごとに URL を検証し、DNS 解決結果が公開 IP で
///   あることを確認したうえで、その IP に接続先を固定して要求する
/// - リダイレクトは自動追従せず、`Location` を自前で解決して最大 `OGP_MAX_REDIRECTS` 回まで追う
/// - Content-Type が HTML 系でなければ本文を読まず空カードを返す (ストリーム配信 URL 対策)
/// - 本文は `OGP_MAX_BYTES` で打ち切り、Shift_JIS/EUC-JP 等は encoding_rs でデコードする
pub async fn fetch_ogp(user_agent: &str, url: &str) -> Result<OgpCard, FetchError> {
    let original = Url::parse(url)?;
    let mut current = original.clone();

    for _hop in 0..=OGP_MAX_REDIRECTS {
        let (domain, addrs) = validate_ogp_target(&current).await?;
        let mut builder = Client::builder()
            .user_agent(user_agent)
            .redirect(Policy::none())
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30));
        if let Some(domain) = domain.as_deref() {
            // 検証済みアドレスに固定 (検証後に DNS 応答が変わっても私有 IP へ接続しない)
            builder = builder.resolve_to_addrs(domain, &addrs);
        }
        let client = builder.build()?;

        let mut resp = client.get(current.as_str()).send().await?;
        let status = resp.status();
        if status.is_redirection() {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or(FetchError::HttpStatus(status))?;
            current = current.join(location)?;
            continue;
        }
        if !status.is_success() {
            return Err(FetchError::HttpStatus(status));
        }

        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        if !content_type_is_html(content_type.as_deref()) {
            return Ok(OgpCard {
                url: url.to_string(),
                title: None,
                description: None,
                image: None,
                site_name: None,
            });
        }
        let header_charset = charset_from_content_type(content_type.as_deref());

        // <head> が収まる程度まで読んで打ち切る
        let mut buf: Vec<u8> = Vec::with_capacity(16 * 1024);
        while let Some(chunk) = resp.chunk().await? {
            buf.extend_from_slice(&chunk);
            if buf.len() >= OGP_MAX_BYTES {
                buf.truncate(OGP_MAX_BYTES);
                break;
            }
        }

        let encoding = header_charset
            .as_deref()
            .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
            .or_else(|| detect_meta_charset(&buf))
            .unwrap_or(encoding_rs::UTF_8);
        let (html, _, _) = encoding.decode(&buf);

        return Ok(parse_ogp_with_base(url, current.as_str(), &html));
    }
    Err(FetchError::Blocked("too many redirects".into()))
}

// --------------------------------------------------------------------------
// YouTube カード取得 (oEmbed)
// --------------------------------------------------------------------------

/// YouTube の動画 URL から video ID (11文字) を取り出す。
/// 対応: `youtube.com/watch?v=ID`, `youtu.be/ID`, `youtube.com/shorts|live|embed|v/ID` (`www.` `m.` 付き可)。
pub fn extract_youtube_video_id(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host_owned = parsed.host_str()?.to_ascii_lowercase();
    let host: &str = host_owned
        .strip_prefix("www.")
        .or_else(|| host_owned.strip_prefix("m."))
        .unwrap_or(host_owned.as_str());
    let segs: Vec<&str> = parsed.path_segments()?.filter(|s| !s.is_empty()).collect();
    let id: Option<String> = if host == "youtu.be" {
        segs.first().map(|s| s.to_string())
    } else if host == "youtube.com" || host == "youtube-nocookie.com" {
        match segs.first().copied() {
            Some("watch") => parsed
                .query_pairs()
                .find(|(k, _)| k == "v")
                .map(|(_, v)| v.into_owned()),
            Some("shorts") | Some("live") | Some("embed") | Some("v") => segs.get(1).map(|s| s.to_string()),
            _ => None,
        }
    } else {
        None
    };
    id.filter(|s| s.len() == 11 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
}

/// YouTube の動画リンクは視聴ページの HTML が 1MB 超で `<title>`/og タグが先頭 512KB に収まらないため、
/// 公式 oEmbed API (数百バイトの JSON) からタイトル・チャンネル名・サムネイルを取ってカードにする。
/// YouTube の動画 URL でなければ `Ok(None)` (呼び出し側で通常の OGP 取得へフォールバック)。
/// 接続先は固定の `www.youtube.com/oembed` のみ (本文由来 URL からは video ID しか使わない)。
pub async fn fetch_youtube_card(user_agent: &str, url: &str) -> Result<Option<OgpCard>, FetchError> {
    let Some(id) = extract_youtube_video_id(url) else {
        return Ok(None);
    };
    let watch = format!("https://www.youtube.com/watch?v={id}");
    let endpoint = Url::parse_with_params(
        "https://www.youtube.com/oembed",
        &[("url", watch.as_str()), ("format", "json")],
    )?;
    let client = Client::builder()
        .user_agent(user_agent)
        .redirect(Policy::limited(3))
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let resp = client.get(endpoint).send().await?;
    if !resp.status().is_success() {
        return Err(FetchError::HttpStatus(resp.status()));
    }
    let json: Value = resp.json().await?;
    let text_field = |key: &str| {
        json.get(key)
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let title = text_field("title");
    let author = text_field("author_name");
    let image = text_field("thumbnail_url")
        .filter(|u| is_http_url(u))
        .or_else(|| Some(format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg")));
    Ok(Some(OgpCard {
        url: url.to_string(),
        title,
        description: author,
        image,
        site_name: Some("YouTube".to_string()),
    }))
}

// --------------------------------------------------------------------------
// X (Twitter) ポストカード取得
// --------------------------------------------------------------------------

/// ポストに添付された画像1枚。`width`/`height` はアスペクト比確保 (レイアウトシフト防止) 用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TweetPhoto {
    pub url: String,
    pub width: u32,
    pub height: u32,
}

/// X のポストを自前 DOM で「埋め込み風」に描画するためのデータ。
/// x.com は通常の HTTP クライアントに OGP を返さないため `fetch_ogp` では取得できず、
/// 公式埋め込み (widgets.js) が内部で叩くのと同じ syndication エンドポイントを使う。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TweetCard {
    pub url: String,
    pub id: String,
    pub text: String,
    pub author_name: String,
    pub author_handle: String,
    pub author_avatar: Option<String>,
    pub is_verified: bool,
    /// ISO8601 (例 `2026-07-20T04:09:19.000Z`)。表示整形はフロント側で行う。
    pub created_at: Option<String>,
    pub favorite_count: Option<u64>,
    pub reply_count: Option<u64>,
    pub photos: Vec<TweetPhoto>,
    /// 動画/GIF が添付されている。
    pub has_video: bool,
    /// 直接再生用の mp4 URL (最高ビットレートの variant)。取得できなければ None で導線表示にフォールバック。
    #[serde(default)]
    pub video_url: Option<String>,
    /// 動画のポスター (サムネイル) 画像。
    #[serde(default)]
    pub video_poster: Option<String>,
    /// animated_gif は無音ループ再生させる。
    #[serde(default)]
    pub is_gif: bool,
    /// 引用元ポストの要約 (あれば)。
    pub quoted_author: Option<String>,
    pub quoted_text: Option<String>,
}

/// X のポスト URL から status ID を取り出す。
/// 対応: `x.com` / `twitter.com` (`www.` `mobile.` 付き)、`/i/web/status/<id>` 形式も含む。
pub fn extract_tweet_id(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let host = host.strip_prefix("mobile.").unwrap_or(host);
    if host != "x.com" && host != "twitter.com" {
        return None;
    }
    // 期待パス: /<user>/status/<id> または /i/web/status/<id>
    let segments: Vec<&str> = parsed.path_segments()?.filter(|s| !s.is_empty()).collect();
    let idx = segments
        .iter()
        .position(|s| *s == "status" || *s == "statuses")?;
    let id = segments.get(idx + 1)?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((*id).to_string())
}

/// syndication API が要求する `token` を生成する。
/// 公式埋め込みと同じ算出式 `((id / 1e15) * PI).toString(36)` から `0` と `.` を除いたもの。
/// (token が空だとレスポンスが `{}` になるため必須)
fn syndication_token(id: &str) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let n: f64 = id.parse().unwrap_or(0.0);
    let v = ((n / 1e15) * std::f64::consts::PI).abs();

    let mut int_part = v.trunc();
    let mut out = String::new();
    if int_part < 1.0 {
        out.push('0');
    }
    let mut int_digits = Vec::new();
    while int_part >= 1.0 {
        int_digits.push(DIGITS[(int_part % 36.0) as usize] as char);
        int_part = (int_part / 36.0).trunc();
    }
    out.extend(int_digits.iter().rev());

    // 小数部を base36 で展開 (JS の Number#toString(36) 相当の桁数で十分)
    let mut frac = v.fract();
    for _ in 0..16 {
        if frac == 0.0 {
            break;
        }
        frac *= 36.0;
        let d = frac.trunc();
        out.push(DIGITS[(d as usize).min(35)] as char);
        frac -= d;
    }

    let token: String = out.chars().filter(|c| *c != '0' && *c != '.').collect();
    if token.is_empty() {
        "a".to_string()
    } else {
        token
    }
}

/// X のポストを取得してカード表示用データに変換する。
/// 接続先は固定の syndication エンドポイント (cdn.syndication.twimg.com) のみ。
pub async fn fetch_tweet(user_agent: &str, url: &str) -> Result<TweetCard, FetchError> {
    let id = extract_tweet_id(url).ok_or_else(|| FetchError::Parse("not a tweet url".into()))?;
    let endpoint = format!(
        "https://cdn.syndication.twimg.com/tweet-result?id={}&lang=ja&token={}",
        id,
        syndication_token(&id)
    );
    let client = Client::builder()
        .user_agent(user_agent)
        .redirect(Policy::limited(5))
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let resp = client.get(&endpoint).send().await?;
    if !resp.status().is_success() {
        return Err(FetchError::HttpStatus(resp.status()));
    }
    // 削除済み/非公開ポストでは JSON ではなく HTML のエラーページが返るため、
    // ここでの parse 失敗は「カードを出さない」で正常扱いにする (呼び出し側で素リンクへフォールバック)。
    let body = resp.text().await?;
    let json: Value = serde_json::from_str(&body)
        .map_err(|_| FetchError::Parse("tweet unavailable".into()))?;
    parse_tweet(url, &id, &json)
}

fn is_http_url(u: &str) -> bool {
    u.starts_with("https://") || u.starts_with("http://")
}

/// syndication JSON からカードを組み立てる純粋関数 (ネットワーク不要・テスト対象)。
fn parse_tweet(url: &str, id: &str, json: &Value) -> Result<TweetCard, FetchError> {
    // 削除済みは `TweetTombstone`、token 欠落時は `{}` が返る
    if json.get("__typename").and_then(Value::as_str) != Some("Tweet") {
        return Err(FetchError::Parse("tweet unavailable".into()));
    }
    let user = json.get("user");
    let author_name = user
        .and_then(|u| u.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let author_handle = user
        .and_then(|u| u.get("screen_name"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let photos = json
        .get("photos")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let url = p.get("url").and_then(Value::as_str).filter(|u| is_http_url(u))?;
                    Some(TweetPhoto {
                        url: url.to_string(),
                        width: p.get("width").and_then(Value::as_u64).unwrap_or(0) as u32,
                        height: p.get("height").and_then(Value::as_u64).unwrap_or(0) as u32,
                    })
                })
                .take(4)
                .collect()
        })
        .unwrap_or_default();

    // mediaDetails から動画/GIF を1件拾い、直接再生用の mp4 (最高ビットレート) と
    // ポスター画像を取り出す。取得できなければ has_video のみ true にして導線表示にする。
    let (has_video, is_gif, video_url, video_poster) = json
        .get("mediaDetails")
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter().find(|m| {
                matches!(
                    m.get("type").and_then(Value::as_str),
                    Some("video") | Some("animated_gif")
                )
            })
        })
        .map(|m| {
            let is_gif = m.get("type").and_then(Value::as_str) == Some("animated_gif");
            let poster = m
                .get("media_url_https")
                .and_then(Value::as_str)
                .filter(|u| is_http_url(u))
                .map(str::to_string);
            let url = m
                .get("video_info")
                .and_then(|v| v.get("variants"))
                .and_then(Value::as_array)
                .and_then(|variants| {
                    variants
                        .iter()
                        .filter(|v| {
                            v.get("content_type").and_then(Value::as_str) == Some("video/mp4")
                        })
                        .max_by_key(|v| v.get("bitrate").and_then(Value::as_u64).unwrap_or(0))
                        .and_then(|v| v.get("url").and_then(Value::as_str))
                        .filter(|u| is_http_url(u))
                        .map(str::to_string)
                });
            (true, is_gif, url, poster)
        })
        .unwrap_or((false, false, None, None));

    let quoted = json.get("quoted_tweet");
    let quoted_author = quoted
        .and_then(|q| q.get("user"))
        .and_then(|u| u.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let quoted_text = quoted
        .and_then(|q| q.get("text"))
        .and_then(Value::as_str)
        .map(|t| tweet_display_text(t, quoted));

    Ok(TweetCard {
        url: url.to_string(),
        id: id.to_string(),
        text: tweet_display_text(
            json.get("text").and_then(Value::as_str).unwrap_or_default(),
            Some(json),
        ),
        author_name,
        author_handle,
        author_avatar: user
            .and_then(|u| u.get("profile_image_url_https"))
            .and_then(Value::as_str)
            .filter(|u| is_http_url(u))
            .map(str::to_string),
        is_verified: user
            .and_then(|u| u.get("is_blue_verified"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || user
                .and_then(|u| u.get("verified"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        created_at: json
            .get("created_at")
            .and_then(Value::as_str)
            .map(str::to_string),
        favorite_count: json.get("favorite_count").and_then(Value::as_u64),
        reply_count: json.get("conversation_count").and_then(Value::as_u64),
        photos,
        has_video,
        video_url,
        video_poster,
        is_gif,
        quoted_author,
        quoted_text,
    })
}

/// 本文を表示用に整える。
/// - 末尾に付く画像の t.co リンクを `display_text_range` で切り落とす
/// - 本文中の t.co リンクを `entities.urls` の展開後 URL に置換する
///
/// `display_text_range` は UTF-16 コード単位のインデックスなので、`char` ではなく
/// UTF-16 に変換してから切る (絵文字はサロゲートペアで2カウントされるため)。
fn tweet_display_text(text: &str, source: Option<&Value>) -> String {
    let mut out = text.to_string();

    if let Some(range) = source
        .and_then(|s| s.get("display_text_range"))
        .and_then(Value::as_array)
    {
        let start = range.first().and_then(Value::as_u64).unwrap_or(0) as usize;
        let end = range.get(1).and_then(Value::as_u64).map(|v| v as usize);
        let units: Vec<u16> = out.encode_utf16().collect();
        let end = end.unwrap_or(units.len()).min(units.len());
        if start <= end {
            out = String::from_utf16_lossy(&units[start..end]);
        }
    }

    if let Some(urls) = source
        .and_then(|s| s.get("entities"))
        .and_then(|e| e.get("urls"))
        .and_then(Value::as_array)
    {
        for u in urls {
            let (Some(short), Some(expanded)) = (
                u.get("url").and_then(Value::as_str),
                u.get("expanded_url").and_then(Value::as_str),
            ) else {
                continue;
            };
            out = out.replace(short, expanded);
        }
    }

    out.trim().to_string()
}

fn extract_attr(snippet: &str, attr: &str) -> Option<String> {
    // Try double-quoted: attr="value"
    let p1 = format!("{attr}=\"");
    if let Some(i) = snippet.find(&p1) {
        let v = &snippet[i + p1.len()..];
        let end = v.find('"')?;
        return Some(v[..end].to_string());
    }
    // Try single-quoted: attr='value'
    let p2 = format!("{attr}='");
    if let Some(i) = snippet.find(&p2) {
        let v = &snippet[i + p2.len()..];
        let end = v.find('\'')?;
        return Some(v[..end].to_string());
    }
    // Try unquoted: attr=value (terminated by space, > or end)
    let p3 = format!("{attr}=");
    if let Some(i) = snippet.find(&p3) {
        let after = &snippet[i + p3.len()..];
        // Skip if next char is a quote (already handled above)
        if after.starts_with('"') || after.starts_with('\'') {
            return None;
        }
        let end = after.find(|c: char| c.is_whitespace() || c == '>' || c == '"' || c == '\'').unwrap_or(after.len());
        if end > 0 {
            return Some(after[..end].to_string());
        }
    }
    None
}

fn extract_input_value(html: &str, name: &str) -> Option<String> {
    for marker in [format!("name=\"{name}\""), format!("name='{name}'")] {
        if let Some(idx) = html.find(&marker) {
            let end = (idx + 400).min(html.len());
            let snippet = &html[idx..end];
            if let Some(v) = extract_attr(snippet, "value") {
                return Some(v);
            }
        }
    }
    None
}

fn detect_post_form_action(html: &str) -> Option<String> {
    let bbs_idx = html.find("bbs.cgi")?;
    let form_idx = html[..bbs_idx].rfind("<form").unwrap_or(0);
    let end = (bbs_idx + 300).min(html.len());
    let snippet = &html[form_idx..end];
    extract_attr(snippet, "action")
}

fn resolve_post_url(thread_url: &str, action: &str) -> Result<String, FetchError> {
    if let Some(stripped) = action.strip_prefix("//") {
        return Ok(format!("https://{stripped}"));
    }
    let base = Url::parse(thread_url)?;
    Ok(base.join(action)?.to_string())
}

pub fn resolve_dat_url_from_thread_url(thread_url: &str) -> Result<String, FetchError> {
    let normalized = normalize_5ch_url(thread_url);
    let parsed = Url::parse(&normalized)?;
    let mut segs = parsed
        .path_segments()
        .ok_or_else(|| FetchError::Parse("path segments".into()))?;
    let parts = segs.by_ref().collect::<Vec<_>>();

    if !(parts.len() >= 4 && parts[0] == "test" && parts[1] == "read.cgi") {
        return Err(FetchError::Parse(
            "thread url format; expected /test/read.cgi/{board}/{key}/".into(),
        ));
    }
    let board = parts[2];
    let key = parts[3];
    if board.is_empty() || key.is_empty() {
        return Err(FetchError::Parse("thread url format".into()));
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| FetchError::Parse("thread host".into()))?;
    Ok(format!("{}://{}/{}/dat/{}.dat", parsed.scheme(), host, board, key))
}

/// Returns (responses, optional_title). Title is only set when fetched from read.cgi HTML fallback.
pub async fn fetch_thread_responses(
    client: &Client,
    thread_url: &str,
    limit: usize,
) -> Result<(Vec<ThreadResponse>, Option<String>), FetchError> {
    let dat_url = resolve_dat_url_from_thread_url(thread_url)?;
    let response = client.get(&dat_url).send().await?;
    let status = response.status();

    if status.is_success() {
        let bytes = response.bytes().await?;
        let (decoded, _, _) = SHIFT_JIS.decode(&bytes);
        let body = decoded.into_owned();

        let mut out = Vec::new();
        let mut dat_title: Option<String> = None;
        for (idx, line) in body.lines().enumerate() {
            if idx == 0 {
                dat_title = parse_dat_title(line);
            }
            if let Some(row) = parse_dat_line(line) {
                out.push(ThreadResponse {
                    response_no: (idx + 1) as u32,
                    name: row.name,
                    mail: row.mail,
                    date_and_id: row.date_and_id,
                    body: row.body,
                });
                if out.len() >= limit {
                    break;
                }
            }
        }
        if !out.is_empty() {
            return Ok((out, dat_title));
        }
    }

    // Fallback: fetch read.cgi HTML (for archived/過去ログ threads)
    let html_response = client.get(thread_url).send().await?;
    if !html_response.status().is_success() {
        return Err(FetchError::HttpStatus(html_response.status()));
    }
    let html_bytes = html_response.bytes().await?;
    let (html_decoded, _, _) = SHIFT_JIS.decode(&html_bytes);
    let html_body = html_decoded.into_owned();

    let result = core_parse::parse_read_cgi_html(&html_body);
    let (entries, title) = if !result.entries.is_empty() {
        (result.entries, result.title)
    } else {
        // Try UTF-8 if Shift-JIS didn't work
        let html_utf8 = String::from_utf8_lossy(&html_bytes).into_owned();
        let result_utf8 = core_parse::parse_read_cgi_html(&html_utf8);
        if result_utf8.entries.is_empty() {
            return Err(FetchError::Parse("no responses found in HTML".into()));
        }
        (result_utf8.entries, result_utf8.title)
    };

    Ok((entries.into_iter().enumerate().take(limit).map(|(i, e)| ThreadResponse {
        response_no: (i + 1) as u32,
        name: e.name,
        mail: e.mail,
        date_and_id: e.date_and_id,
        body: e.body,
    }).collect(), title))
}

// ---------------------------------------------------------------------------
// Site type detection
// ---------------------------------------------------------------------------

/// Identifies which BBS site a URL belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SiteType {
    FiveCh,
    Shitaraba,
    Jpnkn,
}

/// Return true if the URL is in the allowed backend access list.
/// Allowed: *.5ch.io, *.5ch.net, *.2ch.net, jbbs.shitaraba.net, bbs.jpnkn.com,
///          menu.5ch.io (BBS menu), *.uplift.5ch.io (auth).
pub fn is_allowed_url(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else { return false; };
    let host = match parsed.host_str() {
        Some(h) => h,
        None => return false,
    };
    host.ends_with(".5ch.io")
        || host.ends_with(".5ch.net")
        || host.ends_with(".2ch.net")
        || host == "jbbs.shitaraba.net"
        || host == "bbs.jpnkn.com"
}

/// Detect the BBS site type from a URL string.
pub fn detect_site_type(url: &str) -> Option<SiteType> {
    if url.contains(".5ch.io") || url.contains(".5ch.net") || url.contains(".2ch.net") {
        Some(SiteType::FiveCh)
    } else if url.contains("jbbs.shitaraba.net") {
        Some(SiteType::Shitaraba)
    } else if url.contains("bbs.jpnkn.com") {
        Some(SiteType::Jpnkn)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// したらば (jbbs.shitaraba.net) fetch
// ---------------------------------------------------------------------------

/// Parse shitaraba board URL into (category, board_id).
/// e.g. `https://jbbs.shitaraba.net/game/12345/` → ("game", "12345")
fn parse_shitaraba_board(url: &str) -> Result<(String, String), FetchError> {
    let parsed = Url::parse(url).map_err(|_| FetchError::Parse("invalid shitaraba url".into()))?;
    let segs: Vec<&str> = parsed.path_segments()
        .ok_or_else(|| FetchError::Parse("no path".into()))?
        .filter(|s| !s.is_empty())
        .collect();
    // Possible patterns:
    //   /{category}/{board_id}/  (board URL)
    //   /bbs/read.cgi/{category}/{board_id}/{thread_key}/  (thread URL)
    //   /{category}/{board_id}/subject.txt
    if segs.len() >= 4 && segs[0] == "bbs" && (segs[1] == "read.cgi" || segs[1] == "rawmode.cgi") {
        return Ok((segs[2].to_string(), segs[3].to_string()));
    }
    if segs.len() >= 2 && segs[0] != "bbs" {
        return Ok((segs[0].to_string(), segs[1].to_string()));
    }
    Err(FetchError::Parse("cannot parse shitaraba board from url".into()))
}

/// Parse shitaraba thread URL into (category, board_id, thread_key).
fn parse_shitaraba_thread(url: &str) -> Result<(String, String, String), FetchError> {
    let parsed = Url::parse(url).map_err(|_| FetchError::Parse("invalid shitaraba url".into()))?;
    let segs: Vec<&str> = parsed.path_segments()
        .ok_or_else(|| FetchError::Parse("no path".into()))?
        .filter(|s| !s.is_empty())
        .collect();
    // /bbs/read.cgi/{category}/{board_id}/{thread_key}/
    if segs.len() >= 5 && segs[0] == "bbs" && (segs[1] == "read.cgi" || segs[1] == "rawmode.cgi") {
        return Ok((segs[2].to_string(), segs[3].to_string(), segs[4].to_string()));
    }
    Err(FetchError::Parse("cannot parse shitaraba thread url".into()))
}

/// Fetch shitaraba thread list (subject.txt).
pub async fn fetch_shitaraba_thread_list(
    client: &Client,
    url: &str,
    limit: usize,
) -> Result<Vec<SubjectThread>, FetchError> {
    let (category, board_id) = parse_shitaraba_board(url)?;
    let subject_url = format!("https://jbbs.shitaraba.net/{}/{}/subject.txt", category, board_id);
    let response = client.get(&subject_url).send().await?;
    if !response.status().is_success() {
        return Err(FetchError::HttpStatus(response.status()));
    }
    let bytes = response.bytes().await?;
    let entries = core_parse::parse_shitaraba_thread_list(&bytes);
    Ok(entries.into_iter().take(limit).map(|e| SubjectThread {
        thread_url: format!("https://jbbs.shitaraba.net/bbs/read.cgi/{}/{}/{}/", category, board_id, e.thread_key),
        thread_key: e.thread_key,
        title: e.title,
        response_count: e.response_count,
    }).collect())
}

/// Fetch shitaraba thread responses via read.cgi HTML (DT/DD format).
/// read.cgi の `<title>` は「スレ名 - スレキー - したらば掲示板」なので、スレ名だけにする。
fn strip_shitaraba_title_suffix(title: &str, thread_key: &str) -> String {
    let t = title.trim();
    let with_key = format!(" - {} - したらば掲示板", thread_key);
    if let Some(s) = t.strip_suffix(with_key.as_str()) {
        return s.trim().to_string();
    }
    if let Some(s) = t.strip_suffix(" - したらば掲示板") {
        return s.trim().to_string();
    }
    t.to_string()
}

/// したらばのレスを取得する。
/// `rawmode.cgi` は軽量だが **ID を含まない** ため、ID・書き込み回数を表示できるよう `read.cgi` の HTML を使う。
/// `from_no` を渡すと `read.cgi/.../{from_no}-` の範囲指定で差分だけ取得し通信量を抑える
/// (範囲指定でもレス 1 は常に含まれるので、呼び出し側で `since` による絞り込みを行う)。
pub async fn fetch_shitaraba_responses(
    client: &Client,
    url: &str,
    limit: usize,
    from_no: Option<u32>,
) -> Result<(Vec<ThreadResponse>, Option<String>), FetchError> {
    let (category, board_id, thread_key) = parse_shitaraba_thread(url)?;
    let base_url = format!(
        "https://jbbs.shitaraba.net/bbs/read.cgi/{}/{}/{}/",
        category, board_id, thread_key
    );
    let page_url = match from_no {
        Some(n) if n > 1 => format!("{}{}-", base_url, n),
        _ => base_url.clone(),
    };
    let resp = client
        .get(&page_url)
        .header("Referer", &base_url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(FetchError::HttpStatus(resp.status()));
    }
    let bytes = resp.bytes().await?;
    let (entries, title) = core_parse::parse_shitaraba_html_responses(&bytes);
    let title = title.map(|t| strip_shitaraba_title_suffix(&t, &thread_key));
    Ok((entries.into_iter().take(limit).map(|(no, e)| ThreadResponse {
        response_no: no,
        name: e.name,
        mail: e.mail,
        date_and_id: e.date_and_id,
        body: e.body,
    }).collect(), title))
}

/// URL-encode a string as EUC-JP bytes.
fn url_encode_euc_jp(text: &str) -> String {
    let (bytes, _, _) = EUC_JP.encode(text);
    url_encode_sjis_bytes(&bytes) // same percent-encoding logic
}

/// URL-encode a string as Shift_JIS bytes.
fn url_encode_sjis(text: &str) -> String {
    let (bytes, _, _) = SHIFT_JIS.encode(text);
    url_encode_sjis_bytes(&bytes)
}

/// Post a reply to したらば.
pub async fn post_shitaraba_reply(
    client: &Client,
    thread_url: &str,
    from: &str,
    mail: &str,
    message: &str,
) -> Result<PostSubmitResult, FetchError> {
    let (category, board_id, thread_key) = parse_shitaraba_thread(thread_url)?;
    let post_url = "https://jbbs.shitaraba.net/bbs/write.cgi";
    let referer = format!("https://jbbs.shitaraba.net/bbs/read.cgi/{}/{}/{}/", category, board_id, thread_key);

    // Build EUC-JP form body
    let body = format!(
        "DIR={}&BBS={}&KEY={}&NAME={}&MAIL={}&MESSAGE={}&TIME={}&submit={}",
        url_encode_euc_jp(&category),
        url_encode_euc_jp(&board_id),
        url_encode_euc_jp(&thread_key),
        url_encode_euc_jp(from),
        url_encode_euc_jp(mail),
        url_encode_euc_jp(message),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        url_encode_euc_jp("書き込む"),
    );

    let resp = client.post(post_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Referer", &referer)
        .body(body)
        .send()
        .await?;

    let status = resp.status().as_u16();
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let resp_bytes = resp.bytes().await?;
    let resp_text = core_parse::decode_euc_jp(&resp_bytes);

    let contains_error = resp_text.contains("ERROR") || resp_text.contains("エラー");
    let is_success = resp_text.contains("書き込みが完了しました")
        || resp_text.contains("write_done.cgi")
        || (status >= 300 && status < 400); // redirect to write_done

    Ok(PostSubmitResult {
        action_url: post_url.to_string(),
        status,
        content_type: ct,
        contains_error: contains_error && !is_success,
        body_preview: resp_text.chars().take(500).collect(),
    })
}

// ---------------------------------------------------------------------------
// JPNKN (bbs.jpnkn.com) fetch
// ---------------------------------------------------------------------------

/// Parse JPNKN board from URL.
/// e.g. `https://bbs.jpnkn.com/test/read.cgi/boardname/12345/` → ("boardname", Some("12345"))
fn parse_jpnkn_board(url: &str) -> Result<String, FetchError> {
    let parsed = Url::parse(url).map_err(|_| FetchError::Parse("invalid jpnkn url".into()))?;
    let segs: Vec<&str> = parsed.path_segments()
        .ok_or_else(|| FetchError::Parse("no path".into()))?
        .filter(|s| !s.is_empty())
        .collect();
    // /test/read.cgi/{board}/{thread_key}/
    if segs.len() >= 3 && segs[0] == "test" && segs[1] == "read.cgi" {
        return Ok(segs[2].to_string());
    }
    // /{board}/subject.txt or /{board}/
    if !segs.is_empty() && segs[0] != "test" {
        return Ok(segs[0].to_string());
    }
    Err(FetchError::Parse("cannot parse jpnkn board from url".into()))
}

/// Parse JPNKN thread URL into (board, thread_key).
fn parse_jpnkn_thread(url: &str) -> Result<(String, String), FetchError> {
    let parsed = Url::parse(url).map_err(|_| FetchError::Parse("invalid jpnkn url".into()))?;
    let segs: Vec<&str> = parsed.path_segments()
        .ok_or_else(|| FetchError::Parse("no path".into()))?
        .filter(|s| !s.is_empty())
        .collect();
    if segs.len() >= 4 && segs[0] == "test" && segs[1] == "read.cgi" {
        return Ok((segs[2].to_string(), segs[3].to_string()));
    }
    Err(FetchError::Parse("cannot parse jpnkn thread url".into()))
}

/// Fetch JPNKN thread list (subject.txt).
pub async fn fetch_jpnkn_thread_list(
    client: &Client,
    url: &str,
    limit: usize,
) -> Result<Vec<SubjectThread>, FetchError> {
    let board = parse_jpnkn_board(url)?;
    let subject_url = format!("https://bbs.jpnkn.com/{}/subject.txt", board);
    let response = client.get(&subject_url).send().await?;
    if !response.status().is_success() {
        return Err(FetchError::HttpStatus(response.status()));
    }
    let bytes = response.bytes().await?;
    let entries = core_parse::parse_jpnkn_thread_list(&bytes);
    Ok(entries.into_iter().take(limit).map(|e| SubjectThread {
        thread_url: format!("https://bbs.jpnkn.com/test/read.cgi/{}/{}/", board, e.thread_key),
        thread_key: e.thread_key,
        title: e.title,
        response_count: e.response_count,
    }).collect())
}

/// Fetch JPNKN thread responses (dat file).
pub async fn fetch_jpnkn_responses(
    client: &Client,
    url: &str,
    limit: usize,
) -> Result<(Vec<ThreadResponse>, Option<String>), FetchError> {
    let (board, thread_key) = parse_jpnkn_thread(url)?;
    let dat_url = format!("https://bbs.jpnkn.com/{}/dat/{}.dat", board, thread_key);
    let response = client.get(&dat_url).send().await?;
    if !response.status().is_success() {
        return Err(FetchError::HttpStatus(response.status()));
    }
    let bytes = response.bytes().await?;
    let (entries, title) = core_parse::parse_jpnkn_responses(&bytes);
    Ok((entries.into_iter().take(limit).map(|(no, e)| ThreadResponse {
        response_no: no,
        name: e.name,
        mail: e.mail,
        date_and_id: e.date_and_id,
        body: e.body,
    }).collect(), title))
}

/// Post a reply to 5ch.io via reqwest+rustls (avoids Windows Schannel SSL issues).
pub async fn post_5ch_reply(
    thread_url: &str,
    from: &str,
    mail: &str,
    message: &str,
    extra_cookies: Option<&str>,
) -> Result<PostSubmitResult, FetchError> {
    let normalized = normalize_5ch_url(thread_url);
    let parsed = Url::parse(&normalized).map_err(|_| FetchError::Parse("invalid 5ch url".into()))?;
    let host = parsed.host_str().unwrap_or("").to_string();
    let segments: Vec<String> = parsed.path_segments()
        .into_iter().flatten().map(|s| s.to_string()).collect();
    // segments: ["test", "read.cgi", "board", "thread_key"]
    if segments.len() < 4 || segments[0] != "test" || segments[1] != "read.cgi" {
        return Err(FetchError::Parse("invalid 5ch thread url format".into()));
    }
    let board = &segments[2];
    let key = &segments[3];
    let post_url = format!("https://{}/test/bbs.cgi", host);
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string();

    let fields: Vec<(&str, &str)> = vec![
        ("bbs", board),
        ("key", key),
        ("time", &time),
        ("FROM", from),
        ("mail", mail),
        ("MESSAGE", message),
        ("submit", "書き込む"),
    ];

    let (status, ct, body) = reqwest_post_5ch(&normalized, &post_url, &fields, extra_cookies).await?;
    let is_ok = body.contains("書きこみが終わりました") || body.contains("書き込みが終わりました") || body.contains("投稿が完了");
    let contains_error = !is_ok && (body.contains("ERROR") || body.contains("エラー") || status >= 400);

    Ok(PostSubmitResult {
        action_url: post_url,
        status,
        content_type: ct,
        contains_error,
        body_preview: body.chars().take(500).collect(),
    })
}

/// Post a reply to JPNKN.
pub async fn post_jpnkn_reply(
    client: &Client,
    thread_url: &str,
    from: &str,
    mail: &str,
    message: &str,
) -> Result<PostSubmitResult, FetchError> {
    let (board, thread_key) = parse_jpnkn_thread(thread_url)?;
    let post_url = "https://bbs.jpnkn.com/test/bbs.cgi";
    let referer = format!("https://bbs.jpnkn.com/test/read.cgi/{}/{}/", board, thread_key);

    let body = format!(
        "bbs={}&key={}&FROM={}&mail={}&MESSAGE={}&time={}&submit={}",
        url_encode_sjis(&board),
        url_encode_sjis(&thread_key),
        url_encode_sjis(from),
        url_encode_sjis(mail),
        url_encode_sjis(message),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        url_encode_sjis("書き込む"),
    );

    let resp = client.post(post_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Referer", &referer)
        .body(body)
        .send()
        .await?;

    let status = resp.status().as_u16();
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let resp_bytes = resp.bytes().await?;
    let (resp_text, _, _) = SHIFT_JIS.decode(&resp_bytes);

    let contains_error = resp_text.contains("ERROR") || resp_text.contains("エラー");

    Ok(PostSubmitResult {
        action_url: post_url.to_string(),
        status,
        content_type: ct,
        contains_error,
        body_preview: resp_text.chars().take(500).collect(),
    })
}

pub fn parse_post_form_tokens(thread_url: &str, html: &str) -> Result<PostFormTokens, FetchError> {
    let action = detect_post_form_action(html).ok_or_else(|| FetchError::Parse("form action".into()))?;
    let post_url = resolve_post_url(thread_url, &action)?;
    let bbs = extract_input_value(html, "bbs").ok_or_else(|| FetchError::Parse("bbs".into()))?;
    let key = extract_input_value(html, "key").ok_or_else(|| FetchError::Parse("key".into()))?;
    let time = extract_input_value(html, "time").ok_or_else(|| FetchError::Parse("time".into()))?;
    let oekaki_thread1 = extract_input_value(html, "oekaki_thread1");
    let has_message_textarea = html.contains("name=\"MESSAGE\"") || html.contains("name='MESSAGE'");

    Ok(PostFormTokens {
        thread_url: thread_url.to_string(),
        post_url,
        bbs,
        key,
        time,
        oekaki_thread1,
        has_message_textarea,
    })
}

pub async fn fetch_post_form_tokens(client: &Client, thread_url: &str) -> Result<PostFormTokens, FetchError> {
    let normalized = normalize_5ch_url(thread_url);
    let response = client.get(&normalized).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(FetchError::HttpStatus(status));
    }
    let html = response.text().await?;
    parse_post_form_tokens(&normalized, &html)
}

fn url_encode_sjis_bytes(bytes: &[u8]) -> String {
    let mut out = String::new();
    for &b in bytes {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push(char::from(b"0123456789ABCDEF"[(b >> 4) as usize]));
                out.push(char::from(b"0123456789ABCDEF"[(b & 0xf) as usize]));
            }
        }
    }
    out
}

// ─── reqwest-based 5ch POST helpers ─────────────────────────────────────────

fn seed_extra_cookies(jar: &Jar, target_url: &str, extra_cookies: Option<&str>) {
    let Some(cookies) = extra_cookies.filter(|s| !s.is_empty()) else { return };
    let Ok(url) = Url::parse(target_url) else { return };
    for pair in cookies.split(';') {
        let pair = pair.trim();
        if !pair.is_empty() {
            jar.add_cookie_str(pair, &url);
        }
    }
}

async fn decode_5ch_response(
    resp: reqwest::Response,
) -> Result<(u16, Option<String>, String, Option<String>), FetchError> {
    let status = resp.status().as_u16();
    let ct = resp.headers().get("content-type")
        .and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let redir = resp.headers().get("location")
        .and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let bytes = resp.bytes().await?;
    let (body, _, _) = SHIFT_JIS.decode(&bytes);
    Ok((status, ct, body.into_owned(), redir))
}

/// reqwest-based 5ch POST flow — replaces curl_post_5ch for the main posting path.
/// Same steps as curl_post_5ch_inner: GET thread → POST → redirect → confirm → uplift.
async fn reqwest_post_5ch(
    thread_url: &str,
    post_url: &str,
    fields: &[(&str, &str)],
    extra_cookies: Option<&str>,
) -> Result<(u16, Option<String>, String), FetchError> {
    let (client, jar) = build_cookie_client("Monazilla/1.00 LiveFake/0.1")?;
    seed_extra_cookies(&jar, post_url, extra_cookies);

    // Step 1: GET thread page to collect session cookies
    let _ = client.get(thread_url).send().await;

    let body = build_sjis_form_body(fields);

    // Step 2: POST to bbs.cgi
    let resp = client.post(post_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Referer", thread_url)
        .body(body.clone())
        .send().await?;
    let (mut status, mut ct, mut resp_body, mut redir) = decode_5ch_response(resp).await?;

    // Step 3: Follow redirects manually (up to 5), normalizing .5ch.net → .5ch.io
    for _ in 0..5 {
        if (status == 301 || status == 302) && redir.is_some() {
            let next_url = normalize_5ch_url(&redir.take().unwrap());
            let r = client.get(&next_url).header("Referer", post_url).send().await?;
            let (s, c, b, rd) = decode_5ch_response(r).await?;
            status = s; ct = c; resp_body = b; redir = rd;
        } else {
            break;
        }
    }

    // Step 4: Confirm form (has hidden name="bbs") — auto-submit in same session
    let has_confirm = resp_body.contains("name=\"bbs\"") || resp_body.contains("name=bbs ");
    if has_confirm && status == 200 {
        if let Ok(form) = parse_confirm_submit_form_internal(&resp_body, post_url) {
            let confirm_body = build_sjis_form_body(
                &form.fields.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>(),
            );
            let r = client.post(&form.action_url)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .header("Referer", post_url)
                .body(confirm_body)
                .send().await?;
            let (s2, c2, b2, mut rd2) = decode_5ch_response(r).await?;
            status = s2; ct = c2; resp_body = b2;
            for _ in 0..5 {
                if (status == 301 || status == 302) && rd2.is_some() {
                    let next_url = normalize_5ch_url(&rd2.take().unwrap());
                    let r = client.get(&next_url).header("Referer", post_url).send().await?;
                    let (s, c, b, rd) = decode_5ch_response(r).await?;
                    status = s; ct = c; resp_body = b; rd2 = rd;
                } else { break; }
            }
        }
    } else if !has_confirm && status == 200 {
        // Step 5: Uplift/consent form — submit consent then retry original POST
        if let Some(consent_form) = find_first_generic_form(&resp_body) {
            let consent_url = if consent_form.action.starts_with("http") {
                normalize_5ch_url(&consent_form.action)
            } else {
                consent_form.action.clone()
            };
            let consent_body = consent_form.fields.iter()
                .map(|(k, v)| {
                    let (sjis, _, _) = SHIFT_JIS.encode(v);
                    format!("{}={}", k, url_encode_sjis_bytes(&sjis))
                })
                .collect::<Vec<_>>().join("&");
            let _ = client.post(&consent_url)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .header("Referer", post_url)
                .body(consent_body)
                .send().await;
        }
        let r = client.post(post_url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Referer", thread_url)
            .body(body)
            .send().await?;
        let (s2, c2, b2, mut rd2) = decode_5ch_response(r).await?;
        status = s2; ct = c2; resp_body = b2;
        for _ in 0..5 {
            if (status == 301 || status == 302) && rd2.is_some() {
                let next_url = normalize_5ch_url(&rd2.take().unwrap());
                let r = client.get(&next_url).header("Referer", post_url).send().await?;
                let (s, c, b, rd) = decode_5ch_response(r).await?;
                status = s; ct = c; resp_body = b; rd2 = rd;
            } else { break; }
        }
    }

    Ok((status, ct, resp_body))
}

// ─── curl-based helpers (kept for probe_post_flow_trace) ─────────────────────

/// Execute a curl request with a shared cookie jar. Returns (status, content_type, redirect_url, body).
fn curl_exec(
    method: &str,
    url: &str,
    referer: Option<&str>,
    form_body: Option<&str>,
    cookie_jar: &std::path::Path,
    extra_cookies: Option<&str>,
) -> Result<(u16, Option<String>, Option<String>, String), FetchError> {
    let separator = "---CURL_5CH_META---";
    let write_fmt = format!(
        "\n{}\n%{{http_code}}\n%{{content_type}}\n%{{redirect_url}}",
        separator
    );
    let jar_str = cookie_jar.to_str().unwrap_or("");

    let mut args: Vec<String> = vec![
        "-s".into(),
        "--max-time".into(), "30".into(),
        "--connect-timeout".into(), "10".into(),
        "-b".into(), jar_str.into(),
        "-c".into(), jar_str.into(),
        "-X".into(), method.into(),
        "-H".into(), "User-Agent: Monazilla/1.00 LiveFake/0.1".into(),
    ];
    if let Some(cookies) = extra_cookies {
        if !cookies.is_empty() {
            args.push("-H".into());
            args.push(format!("Cookie: {}", cookies));
        }
    }
    if let Some(r) = referer {
        args.push("-H".into());
        args.push(format!("Referer: {}", r));
    }
    if let Some(body) = form_body {
        args.push("-H".into());
        args.push("Content-Type: application/x-www-form-urlencoded".into());
        args.push("--data-raw".into());
        args.push(body.into());
    }
    args.push("-w".into());
    args.push(write_fmt);
    args.push(url.into());

    let mut cmd = Command::new("curl");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Prevent transient console windows when called from a GUI app.
        cmd.creation_flags(0x08000000);
    }
    let output = cmd
        .args(&args)
        .output()
        .map_err(|e| FetchError::Parse(format!("curl: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(FetchError::Parse(format!(
            "curl {} exit {}: {}",
            method,
            output.status,
            stderr.chars().take(200).collect::<String>()
        )));
    }

    let raw = &output.stdout;
    let sep_bytes = format!("\n{}\n", separator).into_bytes();
    let (body_bytes, meta_str) = if let Some(pos) = raw
        .windows(sep_bytes.len())
        .rposition(|w| w == sep_bytes.as_slice())
    {
        let meta = String::from_utf8_lossy(&raw[pos + sep_bytes.len()..]);
        (&raw[..pos], meta.into_owned())
    } else {
        (raw.as_slice(), String::new())
    };

    let meta_lines: Vec<&str> = meta_str.lines().collect();
    let status: u16 = meta_lines.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let content_type = meta_lines.get(1).map(|s| s.to_string()).filter(|s| !s.is_empty());
    let redirect_url = meta_lines.get(2).map(|s| s.to_string()).filter(|s| !s.is_empty());

    let (decoded, _, _) = SHIFT_JIS.decode(body_bytes);
    Ok((status, content_type, redirect_url, decoded.into_owned()))
}

fn build_sjis_form_body(fields: &[(&str, &str)]) -> String {
    fields
        .iter()
        .map(|(k, v)| {
            let (sjis, _, _) = SHIFT_JIS.encode(v);
            format!("{}={}", k, url_encode_sjis_bytes(&sjis))
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// POST to 5ch with cookie jar, handling redirects manually (normalizing .5ch.net → .5ch.io).
/// Steps: 1) GET thread page for cookies, 2) POST, 3) follow redirects, 4) retry POST if needed.
pub fn curl_post_5ch(
    thread_url: &str,
    post_url: &str,
    fields: &[(&str, &str)],
    extra_cookies: Option<&str>,
) -> Result<(u16, Option<String>, String), FetchError> {
    let cookie_file = std::env::temp_dir().join(format!(
        "livefake_post_{}_{}.txt",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    // Ensure no stale cookie jar exists
    let _ = std::fs::remove_file(&cookie_file);
    let result = curl_post_5ch_inner(thread_url, post_url, fields, &cookie_file, extra_cookies);
    let _ = std::fs::remove_file(&cookie_file);
    result
}

fn curl_post_5ch_inner(
    thread_url: &str,
    post_url: &str,
    fields: &[(&str, &str)],
    cookie_file: &std::path::Path,
    extra_cookies: Option<&str>,
) -> Result<(u16, Option<String>, String), FetchError> {
    // Step 1: GET thread page to collect cookies
    let _ = curl_exec("GET", thread_url, None, None, cookie_file, None);

    let body = build_sjis_form_body(fields);

    // Step 2: POST to bbs.cgi with cookies
    let (mut status, mut ct, mut redir, mut resp_body) =
        curl_exec("POST", post_url, Some(thread_url), Some(&body), cookie_file, extra_cookies)?;

    // Step 3: Follow redirects manually (up to 5), normalizing URLs
    for _ in 0..5 {
        if (status == 301 || status == 302) && redir.is_some() {
            let next_url = normalize_5ch_url(&redir.unwrap());
            let r = curl_exec("GET", &next_url, Some(post_url), None, cookie_file, None)?;
            status = r.0;
            ct = r.1;
            redir = r.2;
            resp_body = r.3;
        } else {
            break;
        }
    }

    // Step 4: If we got the cookie check/confirm page, auto-submit the confirm form
    // within the same cookie session to avoid double-posting
    let has_confirm = resp_body.contains("name=\"bbs\"") || resp_body.contains("name=bbs ");
    if has_confirm && status == 200 {
        if let Ok(form) = parse_confirm_submit_form_internal(&resp_body, post_url) {
            let confirm_body = build_sjis_form_body(
                &form.fields.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>(),
            );
            let (s2, c2, r2, b2) =
                curl_exec("POST", &form.action_url, Some(post_url), Some(&confirm_body), cookie_file, extra_cookies)?;
            status = s2;
            ct = c2;
            resp_body = b2;
            let mut redir2 = r2;
            for _ in 0..5 {
                if (status == 301 || status == 302) && redir2.is_some() {
                    let next_url = normalize_5ch_url(&redir2.unwrap());
                    let r = curl_exec("GET", &next_url, Some(post_url), None, cookie_file, None)?;
                    status = r.0;
                    ct = r.1;
                    redir2 = r.2;
                    resp_body = r.3;
                } else {
                    break;
                }
            }
        }
    } else if !has_confirm && status == 200 {
        // uplift/consent page — submit consent form and retry original POST
        if let Some(consent_form) = find_first_generic_form(&resp_body) {
            let consent_url = if consent_form.action.starts_with("http") {
                normalize_5ch_url(&consent_form.action)
            } else {
                consent_form.action.clone()
            };
            let consent_body = consent_form
                .fields
                .iter()
                .map(|(k, v)| {
                    let (sjis, _, _) = SHIFT_JIS.encode(v);
                    format!("{}={}", k, url_encode_sjis_bytes(&sjis))
                })
                .collect::<Vec<_>>()
                .join("&");
            let _ = curl_exec("POST", &consent_url, Some(post_url), Some(&consent_body), cookie_file, None);
        }

        let (s2, c2, r2, b2) =
            curl_exec("POST", post_url, Some(thread_url), Some(&body), cookie_file, extra_cookies)?;
        status = s2;
        ct = c2;
        resp_body = b2;
        let mut redir2 = r2;
        for _ in 0..5 {
            if (status == 301 || status == 302) && redir2.is_some() {
                let next_url = normalize_5ch_url(&redir2.unwrap());
                let r = curl_exec("GET", &next_url, Some(post_url), None, cookie_file, None)?;
                status = r.0;
                ct = r.1;
                redir2 = r.2;
                resp_body = r.3;
            } else {
                break;
            }
        }
    }

    Ok((status, ct, resp_body))
}

struct GenericForm {
    action: String,
    fields: Vec<(String, String)>,
}

fn find_first_generic_form(html: &str) -> Option<GenericForm> {
    let form_start = html.find("<form")?;
    let tail = &html[form_start..];
    let form_end = tail.find("</form>")?;
    let form_html = &tail[..form_end + "</form>".len()];

    let action = extract_attr(form_html, "action").unwrap_or_default();
    let fields = parse_input_fields(form_html);
    if fields.is_empty() {
        return None;
    }
    Some(GenericForm { action, fields })
}

pub async fn submit_post_confirm(
    client: &Client,
    tokens: &PostFormTokens,
    from: &str,
    mail: &str,
    message: &str,
    extra_cookies: Option<&str>,
) -> Result<PostConfirmResult, FetchError> {
    let (result, _) = submit_post_confirm_with_html(client, tokens, from, mail, message, extra_cookies).await?;
    Ok(result)
}

pub async fn submit_post_confirm_with_html(
    _client: &Client,
    tokens: &PostFormTokens,
    from: &str,
    mail: &str,
    message: &str,
    extra_cookies: Option<&str>,
) -> Result<(PostConfirmResult, String), FetchError> {
    let mut fields: Vec<(&str, &str)> = vec![
        ("FROM", from),
        ("mail", mail),
        ("MESSAGE", message),
        ("bbs", &tokens.bbs),
        ("time", &tokens.time),
        ("key", &tokens.key),
        ("submit", "\u{66F8}\u{304D}\u{8FBC}\u{3080}"),  // "書き込む"
    ];
    if let Some(v) = &tokens.oekaki_thread1 {
        fields.push(("oekaki_thread1", v));
    }

    let (final_status, final_ct, final_body) =
        reqwest_post_5ch(&tokens.thread_url, &tokens.post_url, &fields, extra_cookies).await?;

    let contains_confirm = final_body.contains("confirm");
    let contains_error = final_body.contains("error");
    let body_preview: String = final_body.chars().take(240).collect();
    let result = PostConfirmResult {
        post_url: tokens.post_url.clone(),
        status: final_status,
        content_type: final_ct,
        contains_confirm,
        contains_error,
        body_preview,
    };

    Ok((result, final_body))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadResult {
    pub status: u16,
    pub content_type: Option<String>,
    pub contains_error: bool,
    pub body_preview: String,
    pub thread_url: Option<String>,
}

/// Create a new thread on a shitaraba board.
/// `board_url` should be like "https://jbbs.shitaraba.net/{category}/{board_id}/"
pub async fn create_shitaraba_thread(
    client: &Client,
    board_url: &str,
    subject: &str,
    from: &str,
    mail: &str,
    message: &str,
) -> Result<CreateThreadResult, FetchError> {
    let (category, board_id) = parse_shitaraba_board(board_url)?;
    let post_url = "https://jbbs.shitaraba.net/bbs/write.cgi";
    let referer = format!("https://jbbs.shitaraba.net/{}/{}/", category, board_id);
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let body = format!(
        "DIR={}&BBS={}&SUBJECT={}&NAME={}&MAIL={}&MESSAGE={}&TIME={}&submit={}",
        url_encode_euc_jp(&category),
        url_encode_euc_jp(&board_id),
        url_encode_euc_jp(subject),
        url_encode_euc_jp(from),
        url_encode_euc_jp(mail),
        url_encode_euc_jp(message),
        time,
        url_encode_euc_jp("新規スレッド作成"),
    );

    let resp = client.post(post_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Referer", &referer)
        .body(body)
        .send()
        .await?;

    let status = resp.status().as_u16();
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let resp_bytes = resp.bytes().await?;
    let resp_text = core_parse::decode_euc_jp(&resp_bytes);

    let contains_error = resp_text.contains("ERROR") || resp_text.contains("エラー");
    let is_success = resp_text.contains("書き込みが完了しました")
        || resp_text.contains("write_done.cgi")
        || (status >= 300 && status < 400);

    // Try to extract the new thread key from a redirect or response body
    // shitaraba response may contain a link like /bbs/read.cgi/{category}/{board_id}/{thread_key}/
    let thread_url = {
        let pattern = format!("/bbs/read.cgi/{}/{}/", category, board_id);
        resp_text.find(&pattern).and_then(|idx| {
            let rest = &resp_text[idx + pattern.len()..];
            let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
            let key = &rest[..end];
            if !key.is_empty() && key.chars().all(|c| c.is_ascii_digit()) {
                Some(format!("https://jbbs.shitaraba.net/bbs/read.cgi/{}/{}/{}/", category, board_id, key))
            } else {
                None
            }
        })
    };

    Ok(CreateThreadResult {
        status,
        content_type: ct,
        contains_error: contains_error && !is_success,
        body_preview: resp_text.chars().take(1000).collect(),
        thread_url,
    })
}

/// Create a new thread on a JPNKN board.
/// `board_url` should be like "https://bbs.jpnkn.com/{board}/"
pub async fn create_jpnkn_thread(
    client: &Client,
    board_url: &str,
    subject: &str,
    from: &str,
    mail: &str,
    message: &str,
) -> Result<CreateThreadResult, FetchError> {
    let board = parse_jpnkn_board(board_url)?;
    let post_url = "https://bbs.jpnkn.com/test/bbs.cgi";
    let referer = format!("https://bbs.jpnkn.com/{}/", board);
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let body = format!(
        "bbs={}&FROM={}&mail={}&MESSAGE={}&time={}&subject={}&submit={}",
        url_encode_sjis(&board),
        url_encode_sjis(from),
        url_encode_sjis(mail),
        url_encode_sjis(message),
        time,
        url_encode_sjis(subject),
        url_encode_sjis("新規スレッド作成"),
    );

    let resp = client.post(post_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Referer", &referer)
        .body(body)
        .send()
        .await?;

    let status = resp.status().as_u16();
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let resp_bytes = resp.bytes().await?;
    let (resp_text, _, _) = SHIFT_JIS.decode(&resp_bytes);

    let contains_error = resp_text.contains("ERROR") || resp_text.contains("エラー");

    // Try to extract new thread key from response body
    let thread_url = {
        let pattern = format!("/test/read.cgi/{}/", board);
        resp_text.find(&pattern).and_then(|idx| {
            let rest = &resp_text[idx + pattern.len()..];
            let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
            let key = &rest[..end];
            if !key.is_empty() && key.chars().all(|c| c.is_ascii_digit()) {
                Some(format!("https://bbs.jpnkn.com/test/read.cgi/{}/{}/", board, key))
            } else {
                None
            }
        })
    };

    Ok(CreateThreadResult {
        status,
        content_type: ct,
        contains_error,
        body_preview: resp_text.chars().take(1000).collect(),
        thread_url,
    })
}

/// Create a new thread on a 5ch board.
/// `board_url` should be like "https://greta.5ch.io/poverty/" or "https://greta.5ch.io/test/read.cgi/poverty/..."
pub async fn create_thread(
    board_url: &str,
    subject: &str,
    from: &str,
    mail: &str,
    message: &str,
    extra_cookies: Option<&str>,
) -> Result<CreateThreadResult, FetchError> {
    let normalized = normalize_5ch_url(board_url);
    let parsed = Url::parse(&normalized)?;
    let host = parsed.host_str().ok_or_else(|| FetchError::Parse("no host".into()))?;

    // Extract board name (BBSID) from URL
    let parts: Vec<&str> = parsed.path_segments()
        .ok_or_else(|| FetchError::Parse("no path".into()))?
        .filter(|s| !s.is_empty())
        .collect();
    let bbs = if parts.len() >= 3 && parts[0] == "test" && parts[1] == "read.cgi" {
        parts[2]  // thread URL like /test/read.cgi/poverty/123/
    } else {
        parts.first().ok_or_else(|| FetchError::Parse("no board in url".into()))?
    };

    let post_url = format!("{}://{}/test/bbs.cgi", parsed.scheme(), host);
    let referer = format!("{}://{}/{}/", parsed.scheme(), host, bbs);
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string();

    // "新規スレッド作成" submit value (書き込む for thread creation)
    let fields: Vec<(&str, &str)> = vec![
        ("FROM", from),
        ("mail", mail),
        ("MESSAGE", message),
        ("bbs", bbs),
        ("time", &time),
        ("subject", subject),
        ("submit", "\u{65B0}\u{898F}\u{30B9}\u{30EC}\u{30C3}\u{30C9}\u{4F5C}\u{6210}"),  // "新規スレッド作成"
    ];

    let (status, ct, body) = reqwest_post_5ch(&referer, &post_url, &fields, extra_cookies).await?;
    let contains_error = body.contains("ＥＲＲＯＲ")
        || body.contains("ERROR!")
        || (body.contains("error") && !body.contains("error.css") && !body.contains("error.js"));
    let body_preview: String = body.chars().take(1000).collect();
    eprintln!(
        "create_thread: bbs={} status={} contains_error={} body_len={} body_preview={}",
        bbs, status, contains_error, body.len(), body_preview.chars().take(300).collect::<String>()
    );

    // Try to extract the new thread URL from the response body
    // 5ch returns links like /test/read.cgi/boardname/1234567890/
    let thread_url = {
        let pattern = format!("/test/read.cgi/{}/", bbs);
        body.find(&pattern).and_then(|idx| {
            let rest = &body[idx..];
            // find the end of the URL (quote, space, angle bracket, etc.)
            let end = rest.find(|c: char| c == '"' || c == '\'' || c == '<' || c == ' ' || c == '\n')
                .unwrap_or(rest.len());
            let path = &rest[..end];
            // Verify it looks like a valid thread path (has a numeric ID)
            let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
            if parts.len() >= 4 && parts[3].chars().all(|c| c.is_ascii_digit()) {
                // Build clean URL without suffixes like l50
                let clean_path = format!("/test/read.cgi/{}/{}/", parts[2], parts[3]);
                Some(format!("{}://{}{}", parsed.scheme(), host, clean_path))
            } else {
                None
            }
        })
    };

    Ok(CreateThreadResult {
        status,
        content_type: ct,
        contains_error,
        body_preview,
        thread_url,
    })
}

fn find_first_confirm_form(html: &str) -> Option<&str> {
    let mut start = 0usize;
    while let Some(open_rel) = html[start..].find("<form") {
        let open = start + open_rel;
        let tail = &html[open..];
        let close_rel = tail.find("</form>")?;
        let close = open + close_rel + "</form>".len();
        let form = &html[open..close];
        let has_bbs = form.contains("name=\"bbs\"") || form.contains("name='bbs'") || form.contains("name=bbs ");
        let has_key = form.contains("name=\"key\"") || form.contains("name='key'") || form.contains("name=key ");
        let has_subject = form.contains("name=\"subject\"") || form.contains("name='subject'") || form.contains("name=subject ");
        let has_time = form.contains("name=\"time\"") || form.contains("name='time'") || form.contains("name=time ");
        if has_bbs && (has_key || has_subject) && has_time {
            return Some(form);
        }
        start = close;
    }
    None
}

fn parse_input_fields(form_html: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while let Some(rel) = form_html[pos..].find("<input") {
        let input_start = pos + rel;
        let end = match form_html[input_start..].find('>') {
            Some(v) => input_start + v + 1,
            None => break,
        };
        let input = &form_html[input_start..end];
        if let Some(name) = extract_attr(input, "name") {
            let value = extract_attr(input, "value").unwrap_or_default();
            out.push((name, value));
        }
        pos = end;
    }
    out
}

pub fn parse_confirm_submit_form(confirm_html: &str, fallback_post_url: &str) -> Result<PostFinalizePreview, FetchError> {
    let form = find_first_confirm_form(confirm_html).ok_or_else(|| FetchError::Parse("confirm form".into()))?;
    let action_raw = extract_attr(form, "action").unwrap_or_else(|| fallback_post_url.to_string());
    let action_url = if action_raw == fallback_post_url {
        action_raw
    } else {
        resolve_post_url(fallback_post_url, &action_raw)?
    };
    let fields = parse_input_fields(form);
    if fields.is_empty() {
        return Err(FetchError::Parse("confirm form fields".into()));
    }
    let mut field_names = fields.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>();
    field_names.sort();
    field_names.dedup();

    Ok(PostFinalizePreview {
        action_url,
        field_count: fields.len(),
        field_names,
    })
}

fn parse_confirm_submit_form_internal(
    confirm_html: &str,
    fallback_post_url: &str,
) -> Result<ConfirmSubmitForm, FetchError> {
    let form = find_first_confirm_form(confirm_html).ok_or_else(|| FetchError::Parse("confirm form".into()))?;
    let action_raw = extract_attr(form, "action").unwrap_or_else(|| fallback_post_url.to_string());
    let action_url = if action_raw == fallback_post_url {
        action_raw
    } else {
        resolve_post_url(fallback_post_url, &action_raw)?
    };
    let fields = parse_input_fields(form);
    if fields.is_empty() {
        return Err(FetchError::Parse("confirm form fields".into()));
    }
    Ok(ConfirmSubmitForm { action_url, fields })
}

pub async fn submit_post_finalize_from_confirm(
    _client: &Client,
    confirm_html: &str,
    fallback_post_url: &str,
    extra_cookies: Option<&str>,
) -> Result<PostSubmitResult, FetchError> {
    let form = parse_confirm_submit_form_internal(confirm_html, fallback_post_url)?;
    let fields: Vec<(&str, &str)> = form
        .fields
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let thread_url = fallback_post_url
        .replace("/test/bbs.cgi", "/test/read.cgi/");
    let (final_status, final_ct, final_body) =
        reqwest_post_5ch(&thread_url, &form.action_url, &fields, extra_cookies).await?;

    let contains_error = final_body.contains("error");
    let body_preview: String = final_body.chars().take(1000).collect();
    Ok(PostSubmitResult {
        action_url: form.action_url,
        status: final_status,
        content_type: final_ct,
        contains_error,
        body_preview,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        content_type_is_html, cookie_names_for_url, decode_html_entities, detect_meta_charset, extract_tweet_id,
        is_public_ip, normalize_5ch_url, parse_confirm_submit_form, parse_ogp, parse_post_form_tokens, parse_tweet,
        probe_post_cookie_scope, resolve_dat_url_from_thread_url, resolve_subject_url_from_thread_url, seed_cookie,
        syndication_token, Value,
    };
    use reqwest::cookie::Jar;
    use std::net::IpAddr;

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("test ip")
    }

    #[test]
    fn is_public_ip_rejects_reserved_ranges() {
        for s in [
            "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.254",
            "127.0.0.1", "127.255.255.255", "169.254.169.254", "172.16.0.1", "172.31.255.255",
            "192.0.0.1", "192.0.2.10", "192.168.1.1", "198.18.0.1", "198.19.255.255",
            "198.51.100.5", "203.0.113.7", "224.0.0.1", "239.255.255.255", "240.0.0.1",
            "255.255.255.255",
            "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1",
            "2001:db8::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:192.168.0.1",
            "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::",
        ] {
            assert!(!is_public_ip(ip(s)), "{s} must be blocked");
        }
    }

    #[test]
    fn is_public_ip_accepts_public_addresses() {
        for s in [
            "27.91.102.168", "219.63.92.180", "59.147.5.178", "8.8.8.8", "1.1.1.1",
            "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.0.1.1",
            "192.169.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.255",
            "2001:4860:4860::8888", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808",
            "2002:808:808::",
        ] {
            assert!(is_public_ip(ip(s)), "{s} must be allowed");
        }
    }

    #[test]
    fn content_type_is_html_filters_streams() {
        assert!(content_type_is_html(None));
        assert!(content_type_is_html(Some("text/html; charset=utf-8")));
        assert!(content_type_is_html(Some("application/xhtml+xml")));
        assert!(!content_type_is_html(Some("video/mp2t")));
        assert!(!content_type_is_html(Some("application/octet-stream")));
        assert!(!content_type_is_html(Some("audio/mpeg")));
        assert!(!content_type_is_html(Some("image/png")));
    }

    #[test]
    fn decode_html_entities_handles_named_and_numeric() {
        assert_eq!(decode_html_entities("A &amp; B &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x3042; &#12354;"), "A & B <c> \"d\" 'e' あ あ");
        assert_eq!(decode_html_entities("no entities"), "no entities");
        assert_eq!(decode_html_entities("&unknown; & lone"), "&unknown; & lone");
    }

    #[test]
    fn detect_meta_charset_handles_quoted_and_bare_labels() {
        assert_eq!(
            detect_meta_charset(br#"<meta charset="shift-jis">"#),
            Some(encoding_rs::SHIFT_JIS)
        );
        assert_eq!(
            detect_meta_charset(br#"<meta charset='Shift_JIS'>"#),
            Some(encoding_rs::SHIFT_JIS)
        );
        assert_eq!(
            detect_meta_charset(
                br#"<meta http-equiv="Content-Type" content="text/html; charset=EUC-JP">"#
            ),
            Some(encoding_rs::EUC_JP)
        );
        assert_eq!(
            detect_meta_charset(br#"<meta charset="utf-8">"#),
            Some(encoding_rs::UTF_8)
        );
        assert_eq!(detect_meta_charset(b"<html><head></head></html>"), None);
    }

    #[test]
    fn parse_ogp_extracts_all_fields() {
        let html = r#"<html><head>
            <meta property="og:title" content="記事タイトル">
            <meta property="og:description" content="記事の説明文">
            <meta property="og:image" content="https://cdn.example.com/thumb.png">
            <meta property="og:site_name" content="Example News">
        </head><body></body></html>"#;
        let card = parse_ogp("https://example.com/article", html);
        assert_eq!(card.title.as_deref(), Some("記事タイトル"));
        assert_eq!(card.description.as_deref(), Some("記事の説明文"));
        assert_eq!(card.image.as_deref(), Some("https://cdn.example.com/thumb.png"));
        assert_eq!(card.site_name.as_deref(), Some("Example News"));
        assert_eq!(card.url, "https://example.com/article");
    }

    #[test]
    fn parse_ogp_tolerates_attribute_order_quotes_and_entities() {
        let html = r#"<HTML><HEAD>
            <META CONTENT='A &amp; B' PROPERTY="og:title"/>
            <meta content=https://cdn.example.com/x.png property=og:image>
            <meta name="description" content="desc &gt; here">
            <meta property="og:title" content="second (ignored)">
            <metadata>ignored</metadata>
        </HEAD></HTML>"#;
        let card = parse_ogp("https://example.com/", html);
        assert_eq!(card.title.as_deref(), Some("A & B"));
        assert_eq!(card.image.as_deref(), Some("https://cdn.example.com/x.png"));
        assert_eq!(card.description.as_deref(), Some("desc > here"));
    }

    #[test]
    fn parse_ogp_falls_back_to_title_and_meta_description() {
        let html = r#"<html><head>
            <title>ページタイトル</title>
            <meta name="description" content="metaの説明">
        </head><body></body></html>"#;
        let card = parse_ogp("https://example.com/", html);
        assert_eq!(card.title.as_deref(), Some("ページタイトル"));
        assert_eq!(card.description.as_deref(), Some("metaの説明"));
        assert!(card.image.is_none());
        assert!(card.site_name.is_none());
    }

    #[test]
    fn parse_ogp_resolves_relative_image_url() {
        let html = r#"<html><head>
            <meta property="og:title" content="T">
            <meta property="og:image" content="/img/ogp.png">
        </head><body></body></html>"#;
        let card = parse_ogp("https://example.com/dir/page", html);
        assert_eq!(card.image.as_deref(), Some("https://example.com/img/ogp.png"));
    }

    #[test]
    fn parse_ogp_no_tags_yields_empty_card() {
        let html = "<html><head></head><body>plain</body></html>";
        let card = parse_ogp("https://example.com/", html);
        assert!(card.title.is_none());
        assert!(card.description.is_none());
        assert!(card.image.is_none());
        assert!(card.site_name.is_none());
    }

    #[test]
    fn strip_shitaraba_title_suffix_works() {
        use super::strip_shitaraba_title_suffix;
        assert_eq!(strip_shitaraba_title_suffix("なんでも実況フリーダム＠避難所 - 1769199461 - したらば掲示板", "1769199461"), "なんでも実況フリーダム＠避難所");
        assert_eq!(strip_shitaraba_title_suffix("スレ名 - したらば掲示板", "1"), "スレ名");
        assert_eq!(strip_shitaraba_title_suffix("そのまま", "1"), "そのまま");
    }

    #[test]
    fn extract_youtube_video_id_handles_common_forms() {
        use super::extract_youtube_video_id;
        for url in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ",
            "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=10s",
            "https://youtu.be/dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ?si=abc",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "https://www.youtube.com/live/dQw4w9WgXcQ?feature=share",
            "https://www.youtube.com/embed/dQw4w9WgXcQ",
        ] {
            assert_eq!(extract_youtube_video_id(url).as_deref(), Some("dQw4w9WgXcQ"), "failed for {url}");
        }
        for url in [
            "https://www.youtube.com/live",
            "https://www.youtube.com/@channel/live",
            "https://www.youtube.com/watch?v=short",
            "https://example.com/watch?v=dQw4w9WgXcQ",
            "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
            "javascript:alert(1)",
        ] {
            assert!(extract_youtube_video_id(url).is_none(), "should reject {url}");
        }
    }

    #[test]
    fn extract_tweet_id_accepts_x_and_twitter_hosts() {
        for url in [
            "https://x.com/votepurchase/status/2079056030047338990",
            "https://twitter.com/votepurchase/status/2079056030047338990",
            "https://www.x.com/votepurchase/status/2079056030047338990?s=20",
            "https://mobile.twitter.com/votepurchase/status/2079056030047338990",
            "https://x.com/votepurchase/status/2079056030047338990/photo/1",
            "https://x.com/i/web/status/2079056030047338990",
        ] {
            assert_eq!(
                extract_tweet_id(url).as_deref(),
                Some("2079056030047338990"),
                "failed for {url}"
            );
        }
    }

    #[test]
    fn extract_tweet_id_rejects_non_status_urls() {
        for url in [
            "https://x.com/votepurchase",
            "https://example.com/status/123",
            "https://x.com/votepurchase/status/abc",
            "https://evil.example/x.com/status/123",
            "javascript:alert(1)",
        ] {
            assert!(extract_tweet_id(url).is_none(), "should reject {url}");
        }
    }

    #[test]
    fn syndication_token_is_non_empty_without_zero_or_dot() {
        let token = syndication_token("2079056030047338990");
        assert!(!token.is_empty());
        assert!(!token.contains('0'));
        assert!(!token.contains('.'));
    }

    #[test]
    fn parse_tweet_extracts_author_text_and_photo() {
        let json: Value = serde_json::from_str(
            r#"{
                "__typename": "Tweet",
                "text": "禁煙600日超えたけど毎日吸いたくて毎日つらくて毎日泣いてる https://t.co/RFjF3njMQL",
                "display_text_range": [0, 30],
                "created_at": "2026-07-20T04:09:19.000Z",
                "favorite_count": 6,
                "conversation_count": 2,
                "user": {
                    "name": "votepurchase@",
                    "screen_name": "votepurchase",
                    "is_blue_verified": false,
                    "profile_image_url_https": "https://pbs.twimg.com/profile_images/1/a_normal.jpg"
                },
                "photos": [
                    { "url": "https://pbs.twimg.com/media/HNpKcKtbYAAKP9X.jpg", "width": 943, "height": 2048 },
                    { "url": "javascript:alert(1)", "width": 1, "height": 1 }
                ],
                "mediaDetails": [{ "type": "photo" }]
            }"#,
        )
        .expect("fixture json");
        let card = parse_tweet("https://x.com/votepurchase/status/20", "20", &json)
            .expect("should parse");
        assert_eq!(card.text, "禁煙600日超えたけど毎日吸いたくて毎日つらくて毎日泣いてる");
        assert_eq!(card.author_name, "votepurchase@");
        assert_eq!(card.author_handle, "votepurchase");
        assert!(!card.is_verified);
        assert_eq!(card.favorite_count, Some(6));
        // 非 http(s) の写真 URL は捨てられる
        assert_eq!(card.photos.len(), 1);
        assert_eq!(card.photos[0].width, 943);
        assert!(!card.has_video);
    }

    #[test]
    fn parse_tweet_expands_tco_links_and_flags_video() {
        let json: Value = serde_json::from_str(
            r#"{
                "__typename": "Tweet",
                "text": "見て https://t.co/abc",
                "user": { "name": "n", "screen_name": "h" },
                "entities": { "urls": [
                    { "url": "https://t.co/abc", "expanded_url": "https://example.com/article" }
                ]},
                "mediaDetails": [{
                    "type": "video",
                    "media_url_https": "https://pbs.twimg.com/thumb.jpg",
                    "video_info": { "variants": [
                        { "content_type": "application/x-mpegURL", "url": "https://video.twimg.com/x.m3u8" },
                        { "content_type": "video/mp4", "bitrate": 832000, "url": "https://video.twimg.com/low.mp4" },
                        { "content_type": "video/mp4", "bitrate": 2176000, "url": "https://video.twimg.com/high.mp4" }
                    ]}
                }]
            }"#,
        )
        .expect("fixture json");
        let card = parse_tweet("https://x.com/h/status/1", "1", &json).expect("should parse");
        assert_eq!(card.text, "見て https://example.com/article");
        assert!(card.has_video);
        assert!(!card.is_gif);
        assert_eq!(card.video_url.as_deref(), Some("https://video.twimg.com/high.mp4"));
        assert_eq!(card.video_poster.as_deref(), Some("https://pbs.twimg.com/thumb.jpg"));
    }

    #[test]
    fn parse_tweet_rejects_tombstone_and_empty_payload() {
        let tombstone: Value =
            serde_json::from_str(r#"{"__typename":"TweetTombstone"}"#).expect("fixture");
        assert!(parse_tweet("https://x.com/a/status/1", "1", &tombstone).is_err());
        let empty: Value = serde_json::from_str("{}").expect("fixture");
        assert!(parse_tweet("https://x.com/a/status/1", "1", &empty).is_err());
    }

    /// 実サーバー接続テスト: `cargo test -p core-fetch -- --ignored fetch_ogp_live`
    #[tokio::test]
    #[ignore]
    async fn fetch_ogp_live_follows_redirects_and_parses() {
        use super::fetch_ogp;
        let card = fetch_ogp("Mozilla/5.0 (compatible; LiveFake/0.1)", "https://example.com/")
            .await
            .expect("example.com should be fetchable");
        assert!(card.title.as_deref().is_some_and(|t| t.to_lowercase().contains("example")));
        // http → https の 301 リダイレクトを自前で追従し、最終ページの OGP を取る
        let gh = fetch_ogp("Mozilla/5.0 (compatible; LiveFake/0.1)", "http://github.com/")
            .await
            .expect("github.com should be fetchable via redirect");
        assert!(gh.title.as_deref().is_some_and(|t| t.to_lowercase().contains("github")), "{gh:?}");
        assert_eq!(gh.url, "http://github.com/");
        // 私有アドレスは接続前に拒否される
        assert!(fetch_ogp("ua", "http://127.0.0.1:1/").await.is_err());
        assert!(fetch_ogp("ua", "http://localhost:1/").await.is_err());
    }

    /// 実サーバー接続テスト: `cargo test -p core-fetch -- --ignored fetch_youtube_card_live`
    #[tokio::test]
    #[ignore]
    async fn fetch_youtube_card_live_uses_oembed() {
        use super::fetch_youtube_card;
        let ua = "Mozilla/5.0 (compatible; LiveFake/0.1)";
        let card = fetch_youtube_card(ua, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
            .await
            .expect("oembed reachable")
            .expect("youtube url recognised");
        assert!(card.title.as_deref().is_some_and(|t| !t.is_empty()), "{card:?}");
        assert!(card.image.as_deref().is_some_and(|i| i.starts_with("https://")));
        assert_eq!(card.site_name.as_deref(), Some("YouTube"));
        assert!(fetch_youtube_card(ua, "https://example.com/").await.expect("not youtube").is_none());
    }

    #[tokio::test]
    async fn validate_ogp_target_blocks_private_and_userinfo() {
        use super::validate_ogp_target;
        use url::Url;
        for u in [
            "http://127.0.0.1/",
            "http://10.0.0.1:8080/x",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/",
            "http://[fe80::1]/",
            "http://localhost/",
            "http://foo.localhost/",
            "http://2130706433/", // 127.0.0.1 の10進表記 (url crate が正規化する)
            "http://0x7f000001/",
            "http://user:pw@example.com/",
            "ftp://example.com/",
            "file:///C:/Windows/win.ini",
        ] {
            let parsed = Url::parse(u).expect("parse");
            assert!(validate_ogp_target(&parsed).await.is_err(), "{u} must be blocked");
        }
        // 公開 IP リテラルは DNS 不要で通る
        let ok = Url::parse("http://27.91.102.168:8030/").expect("parse");
        let (domain, addrs) = validate_ogp_target(&ok).await.expect("public ip allowed");
        assert!(domain.is_none());
        assert_eq!(addrs.len(), 1);
        assert_eq!(addrs[0].port(), 8030);
    }

    #[test]
    fn normalize_domain_from_5ch_net() {
        let url = "https://example.5ch.net/test/read.cgi/news4vip/1234567890/";
        let normalized = normalize_5ch_url(url);
        assert_eq!(
            normalized,
            "https://example.5ch.io/test/read.cgi/news4vip/1234567890/"
        );
    }

    #[test]
    fn normalize_uplift_preserves_subdomain() {
        let url = "https://uplift.5ch.net/some/path";
        let normalized = normalize_5ch_url(url);
        assert_eq!(normalized, "https://uplift.5ch.io/some/path");
    }

    #[test]
    fn normalize_bare_5ch_net() {
        let url = "https://5ch.net/test";
        let normalized = normalize_5ch_url(url);
        assert_eq!(normalized, "https://5ch.io/test");
    }

    #[test]
    fn keep_non_url_string_compatible() {
        let raw = "foo 5ch.net bar";
        let normalized = normalize_5ch_url(raw);
        assert_eq!(normalized, "foo 5ch.io bar");
    }

    #[test]
    fn cookie_scope_matches_observation_for_post_url() {
        let jar = Jar::default();
        seed_cookie(&jar, "https://5ch.io/", "Be3M=be3m-value; Domain=.5ch.io; Path=/").unwrap();
        seed_cookie(&jar, "https://5ch.io/", "Be3D=be3d-value; Domain=.5ch.io; Path=/").unwrap();
        seed_cookie(
            &jar,
            "https://uplift.5ch.io/",
            "sid=sid-value; Domain=.5ch.io; Path=/",
        )
        .unwrap();
        seed_cookie(
            &jar,
            "https://uplift.5ch.io/",
            "eid=eid-value; Domain=.uplift.5ch.io; Path=/",
        )
        .unwrap();

        let names = cookie_names_for_url(&jar, "https://mao.5ch.io/test/bbs.cgi").unwrap();
        assert!(names.iter().any(|n| n == "Be3M"));
        assert!(names.iter().any(|n| n == "Be3D"));
        assert!(names.iter().any(|n| n == "sid"));
        assert!(!names.iter().any(|n| n == "eid"));
    }

    #[test]
    fn post_cookie_report_contains_target_and_names() {
        let jar = Jar::default();
        seed_cookie(&jar, "https://5ch.io/", "Be3M=be3m-value; Domain=.5ch.io; Path=/").unwrap();

        let report = probe_post_cookie_scope(&jar, "https://mao.5ch.io/test/bbs.cgi").unwrap();
        assert_eq!(report.target_url, "https://mao.5ch.io/test/bbs.cgi");
        assert_eq!(report.cookie_names, vec!["Be3M".to_string()]);
    }

    #[test]
    fn parse_post_form_tokens_from_thread_html() {
        let html = r#"
        <form action="//mao.5ch.io/test/bbs.cgi" method="POST">
          <input type="hidden" name="bbs" value="ngt">
          <input type="hidden" name="key" value="9240230711">
          <input type="hidden" name="time" value="1741320000">
          <input type="hidden" name="oekaki_thread1" value="1">
          <textarea name="MESSAGE"></textarea>
        </form>
        "#;
        let tokens =
            parse_post_form_tokens("https://mao.5ch.io/test/read.cgi/ngt/9240230711/", html).unwrap();
        assert_eq!(tokens.post_url, "https://mao.5ch.io/test/bbs.cgi");
        assert_eq!(tokens.bbs, "ngt");
        assert_eq!(tokens.key, "9240230711");
        assert_eq!(tokens.time, "1741320000");
        assert_eq!(tokens.oekaki_thread1, Some("1".to_string()));
        assert!(tokens.has_message_textarea);
    }

    #[test]
    fn parse_confirm_submit_form_from_html() {
        let html = r#"
        <form action="/test/bbs.cgi" method="post">
          <input type="hidden" name="bbs" value="ngt">
          <input type="hidden" name="key" value="9240230711">
          <input type="hidden" name="time" value="1741320000">
          <input type="hidden" name="submit" value="final">
        </form>
        "#;
        let parsed = parse_confirm_submit_form(html, "https://mao.5ch.io/test/bbs.cgi").unwrap();
        assert_eq!(parsed.action_url, "https://mao.5ch.io/test/bbs.cgi");
        assert!(parsed.field_names.iter().any(|n| n == "bbs"));
        assert!(parsed.field_names.iter().any(|n| n == "key"));
        assert!(parsed.field_names.iter().any(|n| n == "time"));
        assert!(parsed.field_names.iter().any(|n| n == "submit"));
        assert_eq!(parsed.field_count, 4);
    }

    #[test]
    fn parse_confirm_submit_form_unquoted_attrs() {
        // Actual 5ch confirm page uses unquoted attributes like name=bbs value=ngt
        let html = r#"
        <form method="POST" action="../test/bbs.cgi?guid=ON" accept-charset="Shift_JIS">
          <input type=hidden name=FROM value="">
          <input type=hidden name=mail value="">
          <input type=hidden name=MESSAGE value="test">
          <input type=hidden name=bbs value="ngt">
          <input type=hidden name=time value="1741320000">
          <input type=hidden name=key value="9240230711">
          <input type=hidden name=oekaki_thread1 value="">
          <input type=hidden name="feature" value="confirmed:abc123">
          <input type=submit value="submit">
        </form>
        "#;
        let parsed = parse_confirm_submit_form(html, "https://mao.5ch.io/test/bbs.cgi").unwrap();
        assert!(parsed.field_names.iter().any(|n| n == "bbs"), "should find bbs");
        assert!(parsed.field_names.iter().any(|n| n == "key"), "should find key");
        assert!(parsed.field_names.iter().any(|n| n == "time"), "should find time");
        assert!(parsed.field_names.iter().any(|n| n == "feature"), "should find feature");
        assert!(parsed.field_names.iter().any(|n| n == "MESSAGE"), "should find MESSAGE");
    }

    #[test]
    fn resolve_subject_url_from_thread_url_works() {
        let u = resolve_subject_url_from_thread_url("https://mao.5ch.net/test/read.cgi/ngt/1234567890/")
            .expect("subject url");
        assert_eq!(u, "https://mao.5ch.io/ngt/subject.txt");
    }

    #[test]
    fn resolve_subject_url_from_board_url_works() {
        let u = resolve_subject_url_from_thread_url("https://mao.5ch.io/ngt/").expect("subject url");
        assert_eq!(u, "https://mao.5ch.io/ngt/subject.txt");
    }

    #[test]
    fn resolve_subject_url_from_subject_url_works() {
        let u = resolve_subject_url_from_thread_url("https://mao.5ch.io/ngt/subject.txt").expect("subject url");
        assert_eq!(u, "https://mao.5ch.io/ngt/subject.txt");
    }

    #[test]
    fn resolve_subject_url_rejects_unsupported_path() {
        let err = resolve_subject_url_from_thread_url("https://mao.5ch.io/test/").expect_err("unsupported path");
        assert!(err.to_string().contains("unsupported url"));
    }

    #[test]
    fn resolve_dat_url_from_thread_url_works() {
        let u = resolve_dat_url_from_thread_url("https://mao.5ch.net/test/read.cgi/ngt/9240230711/")
            .expect("dat url");
        assert_eq!(u, "https://mao.5ch.io/ngt/dat/9240230711.dat");
    }
}

/// Integration tests that hit the real 5ch servers.
/// Run with: cargo test -p core-fetch -- --ignored --nocapture
#[cfg(test)]
mod integration_tests {
    use super::*;

    /// Debug the full curl-based posting flow step by step.
    /// This test prints detailed output at each step so we can see
    /// exactly what's happening with redirects, cookies, and response bodies.
    #[test]
    #[ignore]
    fn debug_curl_post_flow() {
        let thread_url = "https://greta.5ch.io/test/read.cgi/poverty/1742473225/";
        let post_url = "https://greta.5ch.io/test/bbs.cgi";

        let cookie_file = std::env::temp_dir().join("livefake_e2e_post_debug.txt");
        let _ = std::fs::remove_file(&cookie_file);

        // Step 1: GET thread page to collect cookies
        println!("=== STEP 1: GET thread page ===");
        match curl_exec("GET", thread_url, None, None, &cookie_file, None) {
            Ok((status, ct, redir, body)) => {
                println!("  status={}", status);
                println!("  content_type={:?}", ct);
                println!("  redirect={:?}", redir);
                println!("  body_len={}", body.len());
                println!("  body_preview={}", &body.chars().take(200).collect::<String>());
            }
            Err(e) => println!("  ERROR: {:?}", e),
        }

        // Show cookies
        println!("\n=== COOKIES AFTER STEP 1 ===");
        match std::fs::read_to_string(&cookie_file) {
            Ok(c) => println!("{}", c),
            Err(e) => println!("  (no cookie file: {})", e),
        }

        // Step 2: POST to bbs.cgi
        let fields: Vec<(&str, &str)> = vec![
            ("FROM", ""),
            ("mail", "sage"),
            ("MESSAGE", "テスト書き込み from LiveFake E2E"),
            ("bbs", "poverty"),
            ("time", "1742480000"),
            ("key", "1742473225"),
            ("submit", "\u{66F8}\u{304D}\u{8FBC}\u{3080}"),  // "書き込む"
        ];
        let body = build_sjis_form_body(&fields);

        println!("\n=== STEP 2: POST to bbs.cgi ===");
        println!("  url={}", post_url);
        println!("  body={}", &body.chars().take(200).collect::<String>());
        match curl_exec("POST", post_url, Some(thread_url), Some(&body), &cookie_file, None) {
            Ok((status, ct, redir, resp_body)) => {
                println!("  status={}", status);
                println!("  content_type={:?}", ct);
                println!("  redirect={:?}", redir);
                println!("  body_len={}", resp_body.len());
                println!("  body_preview={}", &resp_body.chars().take(500).collect::<String>());

                // Step 3: Follow redirect if any
                if (status == 301 || status == 302) && redir.is_some() {
                    let raw_redir = redir.unwrap();
                    let next_url = normalize_5ch_url(&raw_redir);
                    println!("\n=== STEP 3: Follow redirect ===");
                    println!("  raw_redirect={}", raw_redir);
                    println!("  normalized={}", next_url);

                    match curl_exec("GET", &next_url, Some(post_url), None, &cookie_file, None) {
                        Ok((s3, c3, r3, b3)) => {
                            println!("  status={}", s3);
                            println!("  content_type={:?}", c3);
                            println!("  redirect={:?}", r3);
                            println!("  body_len={}", b3.len());
                            println!("  body_preview={}", &b3.chars().take(500).collect::<String>());

                            // Check for forms
                            let has_confirm = b3.contains("name=\"bbs\"") || b3.contains("name=bbs ");
                            println!("  has_confirm_form={}", has_confirm);

                            if let Some(form) = find_first_generic_form(&b3) {
                                println!("\n=== FOUND FORM ===");
                                println!("  action={}", form.action);
                                for (k, v) in &form.fields {
                                    println!("  field: {}={}", k, &v.chars().take(50).collect::<String>());
                                }

                                // Step 4: Submit found form
                                let consent_url = if form.action.starts_with("http") {
                                    normalize_5ch_url(&form.action)
                                } else {
                                    format!("https://uplift.5ch.io{}", form.action)
                                };
                                let consent_body = form.fields.iter()
                                    .map(|(k, v)| format!("{}={}", k, url_encode_sjis_bytes(&SHIFT_JIS.encode(v).0)))
                                    .collect::<Vec<_>>().join("&");
                                println!("\n=== STEP 4: Submit consent form ===");
                                println!("  url={}", consent_url);
                                println!("  body={}", consent_body);
                                match curl_exec("POST", &consent_url, Some(&next_url), Some(&consent_body), &cookie_file, None) {
                                    Ok((s4, c4, r4, b4)) => {
                                        println!("  status={}", s4);
                                        println!("  content_type={:?}", c4);
                                        println!("  redirect={:?}", r4);
                                        println!("  body_len={}", b4.len());
                                        println!("  body_preview={}", &b4.chars().take(500).collect::<String>());
                                    }
                                    Err(e) => println!("  ERROR: {:?}", e),
                                }

                                // Show cookies after consent
                                println!("\n=== COOKIES AFTER CONSENT ===");
                                match std::fs::read_to_string(&cookie_file) {
                                    Ok(c) => println!("{}", c),
                                    Err(e) => println!("  (no cookie file: {})", e),
                                }

                                // Step 5: Retry original POST
                                println!("\n=== STEP 5: Retry POST to bbs.cgi ===");
                                match curl_exec("POST", post_url, Some(thread_url), Some(&body), &cookie_file, None) {
                                    Ok((s5, c5, r5, b5)) => {
                                        println!("  status={}", s5);
                                        println!("  content_type={:?}", c5);
                                        println!("  redirect={:?}", r5);
                                        println!("  body_len={}", b5.len());
                                        println!("  body_preview={}", &b5.chars().take(500).collect::<String>());
                                        let has_confirm2 = b5.contains("name=\"bbs\"") || b5.contains("name=bbs ");
                                        println!("  has_confirm_form={}", has_confirm2);

                                        // Follow redirect from retry
                                        if (s5 == 301 || s5 == 302) && r5.is_some() {
                                            let retry_redir = normalize_5ch_url(&r5.unwrap());
                                            println!("\n=== STEP 6: Follow retry redirect ===");
                                            println!("  url={}", retry_redir);
                                            match curl_exec("GET", &retry_redir, Some(post_url), None, &cookie_file, None) {
                                                Ok((s6, _c6, _r6, b6)) => {
                                                    println!("  status={}", s6);
                                                    println!("  body_preview={}", &b6.chars().take(500).collect::<String>());
                                                    let has_confirm3 = b6.contains("name=\"bbs\"") || b6.contains("name=bbs ");
                                                    println!("  has_confirm_form={}", has_confirm3);
                                                }
                                                Err(e) => println!("  ERROR: {:?}", e),
                                            }
                                        }
                                    }
                                    Err(e) => println!("  ERROR: {:?}", e),
                                }
                            }
                        }
                        Err(e) => println!("  ERROR: {:?}", e),
                    }
                } else if status == 200 {
                    // No redirect — check body directly
                    let has_confirm = resp_body.contains("name=\"bbs\"") || resp_body.contains("name=bbs ");
                    println!("  has_confirm_form={}", has_confirm);
                }
            }
            Err(e) => println!("  ERROR: {:?}", e),
        }

        let _ = std::fs::remove_file(&cookie_file);
    }
}
