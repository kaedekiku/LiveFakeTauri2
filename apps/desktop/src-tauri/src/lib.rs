use core_auth::{login_be_front, login_donguri, login_uplift, LoginOutcome};
use core_fetch::{
    build_cookie_client, fetch_bbsmenu_json, fetch_post_form_tokens, normalize_5ch_url, probe_post_cookie_scope,
    seed_cookie, submit_post_confirm, PostConfirmResult, PostCookieReport, PostFormTokens,
};
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuSummary {
    top_level_keys: usize,
    normalized_sample: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthEnvStatus {
    be_email_set: bool,
    be_password_set: bool,
    uplift_email_set: bool,
    uplift_password_set: bool,
}

#[derive(Debug, Deserialize)]
struct LatestMetadata {
    version: String,
    released_at: Option<String>,
    download_page_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckResult {
    metadata_url: String,
    current_version: String,
    latest_version: String,
    has_update: bool,
    released_at: Option<String>,
    download_page_url: Option<String>,
}

#[tauri::command]
async fn fetch_bbsmenu_summary() -> Result<MenuSummary, String> {
    core_store::init_portable_layout().map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .user_agent("5ch-browser-template/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let menu = fetch_bbsmenu_json(&client).await.map_err(|e| e.to_string())?;

    let top_level_keys = menu.as_object().map(|o| o.len()).unwrap_or(0);
    let normalized_sample = normalize_5ch_url("https://egg.5ch.net/test/read.cgi/software/1/");

    Ok(MenuSummary {
        top_level_keys,
        normalized_sample,
    })
}

fn has_env(name: &str) -> bool {
    std::env::var(name)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

#[tauri::command]
fn check_auth_env_status() -> AuthEnvStatus {
    AuthEnvStatus {
        be_email_set: has_env("BE_EMAIL"),
        be_password_set: has_env("BE_PASSWORD"),
        uplift_email_set: has_env("UPLIFT_EMAIL"),
        uplift_password_set: has_env("UPLIFT_PASSWORD"),
    }
}

#[tauri::command]
async fn probe_auth_logins() -> Result<Vec<LoginOutcome>, String> {
    let be_email = std::env::var("BE_EMAIL").unwrap_or_default();
    let be_password = std::env::var("BE_PASSWORD").unwrap_or_default();
    let uplift_email = std::env::var("UPLIFT_EMAIL").unwrap_or_default();
    let uplift_password = std::env::var("UPLIFT_PASSWORD").unwrap_or_default();

    let mut out = Vec::new();

    if !be_email.is_empty() && !be_password.is_empty() {
        out.push(login_be_front(&be_email, &be_password).await.map_err(|e| e.to_string())?);
    }

    if !uplift_email.is_empty() && !uplift_password.is_empty() {
        out.push(login_uplift(&uplift_email, &uplift_password).await.map_err(|e| e.to_string())?);
        out.push(login_donguri(&uplift_email, &uplift_password).await.map_err(|e| e.to_string())?);
    }

    Ok(out)
}

#[tauri::command]
fn probe_post_cookie_scope_simulation() -> Result<PostCookieReport, String> {
    let (_, jar) = build_cookie_client("5ch-browser-template/0.1").map_err(|e| e.to_string())?;

    seed_cookie(&jar, "https://5ch.io/", "Be3M=dummy-be3m; Domain=.5ch.io; Path=/")
        .map_err(|e| e.to_string())?;
    seed_cookie(&jar, "https://5ch.io/", "Be3D=dummy-be3d; Domain=.5ch.io; Path=/")
        .map_err(|e| e.to_string())?;
    seed_cookie(
        &jar,
        "https://uplift.5ch.io/",
        "sid=dummy-sid; Domain=.5ch.io; Path=/",
    )
    .map_err(|e| e.to_string())?;
    seed_cookie(
        &jar,
        "https://uplift.5ch.io/",
        "eid=dummy-eid; Domain=.uplift.5ch.io; Path=/",
    )
    .map_err(|e| e.to_string())?;

    probe_post_cookie_scope(&jar, "https://mao.5ch.io/test/bbs.cgi").map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_thread_post_form(thread_url: String) -> Result<PostFormTokens, String> {
    let client = reqwest::Client::builder()
        .user_agent("5ch-browser-template/0.1")
        .build()
        .map_err(|e| e.to_string())?;
    fetch_post_form_tokens(&client, &thread_url).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_post_confirm_empty(thread_url: String) -> Result<PostConfirmResult, String> {
    let client = reqwest::Client::builder()
        .user_agent("5ch-browser-template/0.1")
        .build()
        .map_err(|e| e.to_string())?;
    let tokens = fetch_post_form_tokens(&client, &thread_url)
        .await
        .map_err(|e| e.to_string())?;
    submit_post_confirm(&client, &tokens, "", "", "")
        .await
        .map_err(|e| e.to_string())
}

fn parse_version_numbers(version: &str) -> Vec<u64> {
    let head = version.split('-').next().unwrap_or(version);
    head.split('.')
        .map(|s| s.trim().parse::<u64>().unwrap_or(0))
        .collect::<Vec<_>>()
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    let l = parse_version_numbers(latest);
    let c = parse_version_numbers(current);
    let max_len = l.len().max(c.len());
    for i in 0..max_len {
        let lv = *l.get(i).unwrap_or(&0);
        let cv = *c.get(i).unwrap_or(&0);
        if lv > cv {
            return true;
        }
        if lv < cv {
            return false;
        }
    }
    false
}

#[tauri::command]
async fn check_for_updates(
    metadata_url: Option<String>,
    current_version: Option<String>,
) -> Result<UpdateCheckResult, String> {
    let metadata_url = metadata_url
        .or_else(|| std::env::var("UPDATE_METADATA_URL").ok())
        .ok_or_else(|| "metadata_url is required (or set UPDATE_METADATA_URL)".to_string())?;

    let current_version = current_version.unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    let client = reqwest::Client::builder()
        .user_agent("5ch-browser-template/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&metadata_url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("metadata fetch failed: status={}", response.status()));
    }

    let latest = response
        .json::<LatestMetadata>()
        .await
        .map_err(|e| e.to_string())?;

    let has_update = is_newer_version(&latest.version, &current_version);

    Ok(UpdateCheckResult {
        metadata_url,
        current_version,
        latest_version: latest.version,
        has_update,
        released_at: latest.released_at,
        download_page_url: latest.download_page_url,
    })
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("unsupported platform".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            fetch_bbsmenu_summary,
            check_auth_env_status,
            probe_auth_logins,
            probe_post_cookie_scope_simulation,
            probe_thread_post_form,
            probe_post_confirm_empty,
            check_for_updates,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
