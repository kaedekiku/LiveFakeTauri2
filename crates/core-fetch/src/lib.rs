use reqwest::cookie::{CookieStore, Jar};
use reqwest::{redirect::Policy, Client};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use thiserror::Error;
use url::Url;

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

pub fn build_cookie_client(user_agent: &str) -> Result<(Client, Arc<Jar>), FetchError> {
    let jar = Arc::new(Jar::default());
    let client = Client::builder()
        .user_agent(user_agent)
        .cookie_provider(jar.clone())
        .redirect(Policy::none())
        .build()?;
    Ok((client, jar))
}

pub fn normalize_5ch_url(input: &str) -> String {
    if let Ok(mut parsed) = Url::parse(input) {
        if parsed.host_str().is_some_and(|host| host.ends_with("5ch.net")) {
            let _ = parsed.set_host(Some("5ch.io"));
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

fn extract_attr(snippet: &str, attr: &str) -> Option<String> {
    let p1 = format!("{attr}=\"");
    if let Some(i) = snippet.find(&p1) {
        let v = &snippet[i + p1.len()..];
        let end = v.find('"')?;
        return Some(v[..end].to_string());
    }
    let p2 = format!("{attr}='");
    if let Some(i) = snippet.find(&p2) {
        let v = &snippet[i + p2.len()..];
        let end = v.find('\'')?;
        return Some(v[..end].to_string());
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

pub async fn submit_post_confirm(
    client: &Client,
    tokens: &PostFormTokens,
    from: &str,
    mail: &str,
    message: &str,
) -> Result<PostConfirmResult, FetchError> {
    let mut fields: Vec<(&str, String)> = vec![
        ("FROM", from.to_string()),
        ("mail", mail.to_string()),
        ("bbs", tokens.bbs.clone()),
        ("key", tokens.key.clone()),
        ("time", tokens.time.clone()),
        ("submit", "write".to_string()),
        ("MESSAGE", message.to_string()),
    ];
    if let Some(v) = &tokens.oekaki_thread1 {
        fields.push(("oekaki_thread1", v.clone()));
    }

    let response = client.post(&tokens.post_url).form(&fields).send().await?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let body = response.text().await?;
    let contains_confirm = body.contains("confirm");
    let contains_error = body.contains("error");
    let body_preview: String = body.chars().take(240).collect();

    Ok(PostConfirmResult {
        post_url: tokens.post_url.clone(),
        status,
        content_type,
        contains_confirm,
        contains_error,
        body_preview,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        cookie_names_for_url, normalize_5ch_url, parse_post_form_tokens, probe_post_cookie_scope, seed_cookie,
    };
    use reqwest::cookie::Jar;

    #[test]
    fn normalize_domain_from_5ch_net() {
        let url = "https://example.5ch.net/test/read.cgi/news4vip/1234567890/";
        let normalized = normalize_5ch_url(url);
        assert_eq!(
            normalized,
            "https://5ch.io/test/read.cgi/news4vip/1234567890/"
        );
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
}
