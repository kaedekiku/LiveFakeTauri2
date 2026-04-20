use core_proxy::{
    protect_password, unprotect_password, update_proxy_settings,
    CookiesFile, ProxySettings, ProxyType, UrlReplaceRule,
    parse_url_replace_rules,
};
use core_fetch::{
    build_cookie_client, create_thread, create_shitaraba_thread, create_jpnkn_thread,
    detect_site_type, is_allowed_url, fetch_bbsmenu_json, fetch_post_form_tokens,
    fetch_subject_threads, fetch_thread_responses,
    fetch_shitaraba_thread_list, fetch_shitaraba_responses, post_shitaraba_reply,
    fetch_jpnkn_thread_list, fetch_jpnkn_responses, post_jpnkn_reply, post_5ch_reply,
    normalize_5ch_url, parse_confirm_submit_form, probe_post_cookie_scope, seed_cookie,
    submit_post_confirm, submit_post_confirm_with_html, submit_post_finalize_from_confirm,
    CreateThreadResult, PostConfirmResult, PostCookieReport, PostFinalizePreview, PostFormTokens,
    PostSubmitResult, SiteType,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager};
use tauri::webview::WebviewWindowBuilder;
use std::sync::Mutex;

/// Multi-tab image data for the popup window.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PopupImageEntry {
    id: String,
    data_url: String,
    source_url: String,
    label: String,
}
struct ImagePopupState(Mutex<Vec<PopupImageEntry>>);

/// (cookie_name, cookie_value, provider)
static LOGIN_COOKIES: Mutex<Vec<(String, String, String)>> = Mutex::new(Vec::new());

fn get_login_cookie_header() -> Option<String> {
    get_login_cookie_header_filtered2(true, true)
}

fn get_login_cookie_header_filtered2(include_be: bool, include_uplift: bool) -> Option<String> {
    let cookies = LOGIN_COOKIES.lock().ok()?;
    if cookies.is_empty() {
        return None;
    }
    let header = cookies
        .iter()
        .filter(|(_, _, provider)| {
            match provider.as_str() {
                "be" => include_be,
                "uplift" | "donguri" => include_uplift,
                _ => true,
            }
        })
        .map(|(k, v, _)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("; ");
    if header.is_empty() { None } else { Some(header) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuSummary {
    top_level_keys: usize,
    normalized_sample: String,
}

#[derive(Debug, Deserialize)]
struct LatestMetadata {
    version: String,
    released_at: Option<String>,
    download_page_url: Option<String>,
    platforms: Option<std::collections::HashMap<String, LatestPlatformAsset>>,
}

#[derive(Debug, Deserialize)]
struct LatestPlatformAsset {
    sha256: String,
    size: u64,
    filename: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePlatformAsset {
    key: String,
    sha256: String,
    size: u64,
    filename: String,
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
    current_platform_key: String,
    current_platform_asset: Option<UpdatePlatformAsset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoardCategory {
    category_name: String,
    boards: Vec<BoardEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoardEntry {
    board_name: String,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PostFlowTrace {
    thread_url: String,
    allow_real_submit: bool,
    token_summary: Option<String>,
    confirm_summary: Option<String>,
    finalize_summary: Option<String>,
    submit_summary: Option<String>,
    blocked: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadListItem {
    thread_key: String,
    title: String,
    response_count: u32,
    thread_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadResponseItem {
    response_no: u32,
    name: String,
    mail: String,
    date_and_id: String,
    body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchResponsesResult {
    responses: Vec<ThreadResponseItem>,
    title: Option<String>,
}

/// Fetch BBS menu JSON, save to `bbs-menu.json`, fall back to cache on error.
async fn fetch_bbsmenu_cached() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    match fetch_bbsmenu_json(&client).await {
        Ok(menu) => {
            let _ = core_store::save_json("bbs-menu.json", &menu);
            Ok(menu)
        }
        Err(e) => {
            // Fall back to cached version if available
            core_store::load_json::<serde_json::Value>("bbs-menu.json")
                .map_err(|_| format!("ネットワークエラー + キャッシュなし: {:?}", e))
        }
    }
}

#[tauri::command]
async fn fetch_bbsmenu_summary() -> Result<MenuSummary, String> {
    core_store::init_portable_layout().map_err(|e| e.to_string())?;

    let menu = fetch_bbsmenu_cached().await?;

    let top_level_keys = menu.as_object().map(|o| o.len()).unwrap_or(0);
    let normalized_sample = normalize_5ch_url("https://egg.5ch.net/test/read.cgi/software/1/");

    Ok(MenuSummary {
        top_level_keys,
        normalized_sample,
    })
}

#[tauri::command]
fn probe_post_cookie_scope_simulation() -> Result<PostCookieReport, String> {
    let (_, jar) = build_cookie_client("LiveFake/0.1").map_err(|e| e.to_string())?;

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
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    fetch_post_form_tokens(&client, &thread_url).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_thread_list(thread_url: String, limit: Option<usize>) -> Result<Vec<ThreadListItem>, String> {
    if !is_allowed_url(&thread_url) {
        return Err(format!("URL not allowed: {}", thread_url));
    }
    let _ = core_store::append_log(&format!("fetch_thread_list: {}", thread_url));
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(usize::MAX);
    let site = detect_site_type(&thread_url);
    let rows = match site {
        Some(SiteType::Shitaraba) => {
            fetch_shitaraba_thread_list(&client, &thread_url, limit).await
        }
        Some(SiteType::Jpnkn) => {
            fetch_jpnkn_thread_list(&client, &thread_url, limit).await
        }
        _ => {
            fetch_subject_threads(&client, &thread_url, limit).await
        }
    }.map_err(|e| {
        let _ = core_store::append_log(&format!("fetch_thread_list error: {}", e));
        e.to_string()
    })?;
    let _ = core_store::append_log(&format!("fetch_thread_list ok: {} threads", rows.len()));
    Ok(rows
        .into_iter()
        .map(|r| ThreadListItem {
            thread_key: r.thread_key,
            title: r.title,
            response_count: r.response_count,
            thread_url: r.thread_url,
        })
        .collect())
}

#[tauri::command]
async fn fetch_thread_responses_command(
    thread_url: String,
    limit: Option<usize>,
    since_res_no: Option<u32>,
) -> Result<FetchResponsesResult, String> {
    if !is_allowed_url(&thread_url) {
        return Err(format!("URL not allowed: {}", thread_url));
    }
    let _ = core_store::append_log(&format!("fetch_responses: {}", thread_url));
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(usize::MAX);
    let site = detect_site_type(&thread_url);
    let (rows, title) = match site {
        Some(SiteType::Shitaraba) => {
            fetch_shitaraba_responses(&client, &thread_url, limit).await
        }
        Some(SiteType::Jpnkn) => {
            fetch_jpnkn_responses(&client, &thread_url, limit).await
        }
        _ => {
            fetch_thread_responses(&client, &thread_url, limit).await
        }
    }.map_err(|e| {
        let _ = core_store::append_log(&format!("fetch_responses error: {}", e));
        e.to_string()
    })?;
    let _ = core_store::append_log(&format!("fetch_responses ok: {} rows", rows.len()));
    let since = since_res_no.unwrap_or(0);
    Ok(FetchResponsesResult {
        responses: rows
            .into_iter()
            .filter(|r| r.response_no > since)
            .map(|r| ThreadResponseItem {
                response_no: r.response_no,
                name: r.name,
                mail: r.mail,
                date_and_id: r.date_and_id,
                body: r.body,
            })
            .collect(),
        title,
    })
}

#[tauri::command]
async fn debug_post_connectivity(thread_url: String) -> Result<String, String> {
    let mut report = String::new();

    let c = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("{:?}", e))?;
    let tokens = fetch_post_form_tokens(&c, &thread_url)
        .await
        .map_err(|e| format!("tokens: {:?}", e))?;
    report.push_str(&format!("post_url={}\n", tokens.post_url));

    // Test 1: curl.exe to bbs.cgi (uses Windows Schannel/WinHTTP)
    {
        let output = Command::new("curl")
            .args(["-s", "-o", "/dev/null", "-w", "%{http_code} %{ssl_verify_result}", "-X", "POST", &tokens.post_url])
            .output();
        match output {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                let stderr = String::from_utf8_lossy(&o.stderr);
                report.push_str(&format!("curl POST bbs.cgi: out={} err={}\n", stdout.trim(), stderr.chars().take(120).collect::<String>()));
            }
            Err(e) => report.push_str(&format!("curl failed to run: {}\n", e)),
        }
    }

    // Test 2: curl.exe GET to bbs.cgi
    {
        let output = Command::new("curl")
            .args(["-s", "-o", "/dev/null", "-w", "%{http_code} %{ssl_verify_result}", &tokens.post_url])
            .output();
        match output {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                report.push_str(&format!("curl GET bbs.cgi: {}\n", stdout.trim()));
            }
            Err(e) => report.push_str(&format!("curl GET failed: {}\n", e)),
        }
    }

    // Test 3: reqwest GET to bbs.cgi (same client that fetched tokens)
    match c.get(&tokens.post_url).send().await {
        Ok(r) => report.push_str(&format!("reqwest GET bbs.cgi (reuse): status={}\n", r.status())),
        Err(e) => report.push_str(&format!("reqwest GET bbs.cgi (reuse) FAILED: {:?}\n", e)),
    }

    // Test 4: reqwest with danger_accept_invalid_certs
    {
        let c2 = reqwest::Client::builder()
            .user_agent("Monazilla/1.00 LiveFake/0.1")
            .danger_accept_invalid_certs(true)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("{:?}", e))?;
        match c2.get(&tokens.post_url).send().await {
            Ok(r) => report.push_str(&format!("reqwest GET accept_invalid_certs: status={}\n", r.status())),
            Err(e) => report.push_str(&format!("reqwest GET accept_invalid_certs FAILED: {:?}\n", e)),
        }
    }

    // Test 5: reqwest with TLS 1.2 only
    {
        let c3 = reqwest::Client::builder()
            .user_agent("Monazilla/1.00 LiveFake/0.1")
            .min_tls_version(reqwest::tls::Version::TLS_1_2)
            .max_tls_version(reqwest::tls::Version::TLS_1_2)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("{:?}", e))?;
        match c3.get(&tokens.post_url).send().await {
            Ok(r) => report.push_str(&format!("reqwest GET TLS1.2 only: status={}\n", r.status())),
            Err(e) => report.push_str(&format!("reqwest GET TLS1.2 only FAILED: {:?}\n", e)),
        }
    }

    Ok(report)
}

#[tauri::command]
async fn probe_post_confirm_empty(thread_url: String) -> Result<PostConfirmResult, String> {
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let tokens = fetch_post_form_tokens(&client, &thread_url)
        .await
        .map_err(|e| e.to_string())?;
    let ch = get_login_cookie_header();
    submit_post_confirm(&client, &tokens, "", "", "", ch.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_post_confirm(
    thread_url: String,
    from: Option<String>,
    mail: Option<String>,
    message: Option<String>,
) -> Result<PostConfirmResult, String> {
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let tokens = fetch_post_form_tokens(&client, &thread_url)
        .await
        .map_err(|e| e.to_string())?;
    let ch = get_login_cookie_header();
    submit_post_confirm(
        &client,
        &tokens,
        from.as_deref().unwrap_or(""),
        mail.as_deref().unwrap_or(""),
        message.as_deref().unwrap_or(""),
        ch.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_post_finalize_preview(thread_url: String) -> Result<PostFinalizePreview, String> {
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let tokens = fetch_post_form_tokens(&client, &thread_url)
        .await
        .map_err(|e| e.to_string())?;
    let ch = get_login_cookie_header();
    let (_, confirm_html) = submit_post_confirm_with_html(&client, &tokens, "", "", "", ch.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    parse_confirm_submit_form(&confirm_html, &tokens.post_url).map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_post_finalize_preview_from_input(
    thread_url: String,
    from: Option<String>,
    mail: Option<String>,
    message: Option<String>,
) -> Result<PostFinalizePreview, String> {
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let tokens = fetch_post_form_tokens(&client, &thread_url)
        .await
        .map_err(|e| e.to_string())?;
    let ch = get_login_cookie_header();
    let (_, confirm_html) = submit_post_confirm_with_html(
        &client,
        &tokens,
        from.as_deref().unwrap_or(""),
        mail.as_deref().unwrap_or(""),
        message.as_deref().unwrap_or(""),
        ch.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;
    parse_confirm_submit_form(&confirm_html, &tokens.post_url).map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_post_finalize_submit_empty(
    thread_url: String,
    allow_real_submit: bool,
) -> Result<PostSubmitResult, String> {
    if !allow_real_submit {
        return Err("blocked: set allow_real_submit=true to execute final submit".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let tokens = fetch_post_form_tokens(&client, &thread_url)
        .await
        .map_err(|e| e.to_string())?;
    let ch = get_login_cookie_header();
    let (_, confirm_html) = submit_post_confirm_with_html(&client, &tokens, "", "", "", ch.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    submit_post_finalize_from_confirm(&client, &confirm_html, &tokens.post_url, ch.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_post_finalize_submit_from_input(
    thread_url: String,
    from: Option<String>,
    mail: Option<String>,
    message: Option<String>,
    allow_real_submit: bool,
) -> Result<PostSubmitResult, String> {
    if !allow_real_submit {
        return Err("blocked: set allow_real_submit=true to execute final submit".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let tokens = fetch_post_form_tokens(&client, &thread_url)
        .await
        .map_err(|e| e.to_string())?;
    let ch = get_login_cookie_header();
    let (_, confirm_html) = submit_post_confirm_with_html(
        &client,
        &tokens,
        from.as_deref().unwrap_or(""),
        mail.as_deref().unwrap_or(""),
        message.as_deref().unwrap_or(""),
        ch.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;
    submit_post_finalize_from_confirm(&client, &confirm_html, &tokens.post_url, ch.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn post_reply_multisite(
    thread_url: String,
    from: Option<String>,
    mail: Option<String>,
    message: String,
) -> Result<String, String> {
    if !is_allowed_url(&thread_url) {
        return Err(format!("URL not allowed: {}", thread_url));
    }
    let site = detect_site_type(&thread_url);
    match site {
        Some(SiteType::Shitaraba) => {
            let client = reqwest::Client::builder()
                .user_agent("Monazilla/1.00 LiveFake/0.1")
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())?;
            let result = post_shitaraba_reply(
                &client,
                &thread_url,
                from.as_deref().unwrap_or(""),
                mail.as_deref().unwrap_or(""),
                &message,
            )
            .await
            .map_err(|e| format!("{:?}", e))?;
            Ok(format!("status={}", result.status))
        }
        Some(SiteType::Jpnkn) => {
            let client = reqwest::Client::builder()
                .user_agent("Monazilla/1.00 LiveFake/0.1")
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())?;
            let result = post_jpnkn_reply(
                &client,
                &thread_url,
                from.as_deref().unwrap_or(""),
                mail.as_deref().unwrap_or(""),
                &message,
            )
            .await
            .map_err(|e| format!("{:?}", e))?;
            Ok(format!("status={}", result.status))
        }
        _ => {
            // 5ch: direct curl-based post (avoids reqwest/curl session mismatch)
            let ch = get_login_cookie_header();
            let result = post_5ch_reply(
                &thread_url,
                from.as_deref().unwrap_or(""),
                mail.as_deref().unwrap_or(""),
                &message,
                ch.as_deref(),
            )
            .map_err(|e| format!("{:?}", e))?;
            if result.contains_error {
                Err(format!("Post failed: status={} body={}", result.status, &result.body_preview[..result.body_preview.len().min(300)]))
            } else {
                Ok(format!("status={}", result.status))
            }
        }
    }
}

#[tauri::command]
async fn create_thread_command(
    board_url: String,
    subject: String,
    from: Option<String>,
    mail: Option<String>,
    message: String,
) -> Result<CreateThreadResult, String> {
    if !is_allowed_url(&board_url) {
        return Err(format!("URL not allowed: {}", board_url));
    }
    let from_str = from.unwrap_or_default();
    let mail_str = mail.unwrap_or_default();

    match detect_site_type(&board_url) {
        Some(SiteType::Shitaraba) => {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())?;
            create_shitaraba_thread(&client, &board_url, &subject, &from_str, &mail_str, &message)
                .await
                .map_err(|e| format!("{:?}", e))
        }
        Some(SiteType::Jpnkn) => {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())?;
            create_jpnkn_thread(&client, &board_url, &subject, &from_str, &mail_str, &message)
                .await
                .map_err(|e| format!("{:?}", e))
        }
        _ => {
            let cookie_header = get_login_cookie_header();
            tauri::async_runtime::spawn_blocking(move || {
                create_thread(
                    &board_url,
                    &subject,
                    &from_str,
                    &mail_str,
                    &message,
                    cookie_header.as_deref(),
                )
                .map_err(|e| format!("{:?}", e))
            })
            .await
            .map_err(|e| format!("task join: {}", e))?
        }
    }
}

#[tauri::command]
async fn probe_post_flow_trace(
    thread_url: String,
    from: Option<String>,
    mail: Option<String>,
    message: Option<String>,
    allow_real_submit: bool,
    include_be: Option<bool>,
    include_uplift: Option<bool>,
) -> Result<PostFlowTrace, String> {
    let client = reqwest::Client::builder()
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let _ = core_store::append_log(&format!("post_flow: start thread_url={}", thread_url));

    let tokens = fetch_post_form_tokens(&client, &thread_url)
        .await
        .map_err(|e| e.to_string())?;
    let token_summary = Some(format!(
        "post_url={} bbs={} key={} time={}",
        tokens.post_url, tokens.bbs, tokens.key, tokens.time
    ));
    let _ = core_store::append_log(&format!(
        "post_flow: tokens post_url={} bbs={} key={} time={}",
        tokens.post_url, tokens.bbs, tokens.key, tokens.time
    ));

    let cookie_header = get_login_cookie_header_filtered2(include_be.unwrap_or(true), include_uplift.unwrap_or(true));
    let _ = core_store::append_log(&format!("post_flow: include_be={} include_uplift={} cookie_header={}", include_be.unwrap_or(true), include_uplift.unwrap_or(true), cookie_header.as_deref().unwrap_or("(none)")));
    let (confirm, confirm_html) = submit_post_confirm_with_html(
        &client,
        &tokens,
        from.as_deref().unwrap_or(""),
        mail.as_deref().unwrap_or(""),
        message.as_deref().unwrap_or(""),
        cookie_header.as_deref(),
    )
    .await
    .map_err(|e| format!("{:?}", e))?;

    // curl_post_5ch already handles confirm form auto-submit and consent pages internally.
    // Check if the final response indicates success.
    let is_ok = |html: &str| -> bool {
        html.contains("書きこみが終わりました")
            || html.contains("書き込みが終わりました")
            || html.contains("投稿が完了")
    };
    let mut contains_ok = is_ok(&confirm_html);

    let confirm_summary = Some(format!(
        "status={} ok={} type={} body={}",
        confirm.status,
        contains_ok,
        confirm.content_type.unwrap_or_else(|| "-".to_string()),
        confirm.body_preview.chars().take(300).collect::<String>()
    ));
    let _ = core_store::append_log(&format!(
        "post_flow: confirm status={} ok={} body_len={} body_preview={}",
        confirm.status, contains_ok, confirm_html.len(),
        confirm_html.chars().take(500).collect::<String>()
    ));

    // If not successful, retry once — the first attempt may have been a cookie/consent
    // page that curl_post_5ch handled internally, setting cookies for the next attempt.
    let mut retry_summary: Option<String> = None;
    if !contains_ok {
        let _ = core_store::append_log("post_flow: first attempt failed, retrying...");
        let (retry_confirm, retry_html) = submit_post_confirm_with_html(
            &client,
            &tokens,
            from.as_deref().unwrap_or(""),
            mail.as_deref().unwrap_or(""),
            message.as_deref().unwrap_or(""),
            cookie_header.as_deref(),
        )
        .await
        .map_err(|e| format!("{:?}", e))?;

        contains_ok = is_ok(&retry_html);
        retry_summary = Some(format!(
            "retry: status={} ok={} body={}",
            retry_confirm.status,
            contains_ok,
            retry_confirm.body_preview.chars().take(300).collect::<String>()
        ));
        let _ = core_store::append_log(&format!(
            "post_flow: retry status={} ok={} body_len={} body_preview={}",
            retry_confirm.status, contains_ok, retry_html.len(),
            retry_html.chars().take(500).collect::<String>()
        ));
    }

    let error_flag = !contains_ok;
    let submit_summary = Some(format!(
        "status={} error={} retried={}",
        confirm.status, error_flag, retry_summary.is_some()
    ));
    let _ = core_store::append_log(&format!(
        "post_flow: done error={} retried={}", error_flag, retry_summary.is_some()
    ));

    Ok(PostFlowTrace {
        thread_url,
        allow_real_submit,
        token_summary,
        confirm_summary,
        finalize_summary: retry_summary,
        submit_summary,
        blocked: false,
    })
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

fn current_platform_key() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows-x64"
    }
    #[cfg(target_os = "macos")]
    {
        "macos-arm64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-aarch64"
    }
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
        .user_agent("Monazilla/1.00 LiveFake/0.1")
        .timeout(std::time::Duration::from_secs(30))
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
    let platform_key = current_platform_key().to_string();
    let current_platform_asset = latest
        .platforms
        .as_ref()
        .and_then(|m| m.get(&platform_key))
        .map(|a| UpdatePlatformAsset {
            key: platform_key.clone(),
            sha256: a.sha256.clone(),
            size: a.size,
            filename: a.filename.clone(),
        });

    Ok(UpdateCheckResult {
        metadata_url,
        current_version,
        latest_version: latest.version,
        has_update,
        released_at: latest.released_at,
        download_page_url: latest.download_page_url,
        current_platform_key: platform_key,
        current_platform_asset,
    })
}

/// Open a native file-open dialog and return the selected path, or None if cancelled.
/// `filter_name` e.g. "EXE files", `filter_ext` e.g. "*.exe"
#[tauri::command]
fn open_file_dialog(filter_name: String, filter_ext: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStringExt;
        #[repr(C)]
        #[allow(non_snake_case)]
        struct OPENFILENAMEW {
            lStructSize: u32,
            hwndOwner: usize,
            hInstance: usize,
            lpstrFilter: *const u16,
            lpstrCustomFilter: *mut u16,
            nMaxCustFilter: u32,
            nFilterIndex: u32,
            lpstrFile: *mut u16,
            nMaxFile: u32,
            lpstrFileTitle: *mut u16,
            nMaxFileTitle: u32,
            lpstrInitialDir: *const u16,
            lpstrTitle: *const u16,
            Flags: u32,
            nFileOffset: u16,
            nFileExtension: u16,
            lpstrDefExt: *const u16,
            lCustData: usize,
            lpfnHook: usize,
            lpTemplateName: *const u16,
            pvReserved: usize,
            dwReserved: u32,
            FlagsEx: u32,
        }
        extern "system" {
            fn GetOpenFileNameW(lpofn: *mut OPENFILENAMEW) -> i32;
        }
        let to_wide = |s: &str| -> Vec<u16> {
            s.encode_utf16().chain(std::iter::once(0)).collect()
        };
        // Build filter: "FilterName\0*.ext\0\0"
        let filter_str = format!("{}\0{}\0", filter_name, filter_ext);
        let filter_wide: Vec<u16> = filter_str.encode_utf16().chain(std::iter::once(0)).collect();
        let title_wide = to_wide("ファイルを選択");
        let mut file_buf: Vec<u16> = vec![0u16; 512];
        let mut ofn: OPENFILENAMEW = unsafe { std::mem::zeroed() };
        ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
        ofn.lpstrFilter = filter_wide.as_ptr();
        ofn.lpstrFile = file_buf.as_mut_ptr();
        ofn.nMaxFile = file_buf.len() as u32;
        ofn.lpstrTitle = title_wide.as_ptr();
        ofn.Flags = 0x00000800 | 0x00001000; // OFN_PATHMUSTEXIST | OFN_FILEMUSTEXIST
        let result = unsafe { GetOpenFileNameW(&mut ofn) };
        if result == 0 {
            return Ok(None);
        }
        let len = file_buf.iter().position(|&c| c == 0).unwrap_or(file_buf.len());
        let path = std::ffi::OsString::from_wide(&file_buf[..len])
            .to_string_lossy()
            .to_string();
        if path.is_empty() { return Ok(None); }
        return Ok(Some(path));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (filter_name, filter_ext);
        Ok(None)
    }
}

/// Open a native folder-select dialog and return the selected path, or None if cancelled.
#[tauri::command]
fn open_folder_dialog() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStringExt;
        #[repr(C)]
        #[allow(non_snake_case)]
        struct BROWSEINFOW {
            hwndOwner: usize,
            pidlRoot: usize,
            pszDisplayName: *mut u16,
            lpszTitle: *const u16,
            ulFlags: u32,
            lpfn: usize,
            lParam: usize,
            iImage: i32,
        }
        extern "system" {
            fn SHBrowseForFolderW(lpbi: *mut BROWSEINFOW) -> usize;
            fn SHGetPathFromIDListW(pidl: usize, pszPath: *mut u16) -> i32;
            fn CoTaskMemFree(pv: usize);
        }
        let title_wide: Vec<u16> = "保存先フォルダを選択".encode_utf16().chain(std::iter::once(0)).collect();
        let mut display_name: Vec<u16> = vec![0u16; 260];
        let mut bi: BROWSEINFOW = unsafe { std::mem::zeroed() };
        bi.pszDisplayName = display_name.as_mut_ptr();
        bi.lpszTitle = title_wide.as_ptr();
        bi.ulFlags = 0x00000040 | 0x00000010; // BIF_NEWDIALOGSTYLE | BIF_EDITBOX
        let pidl = unsafe { SHBrowseForFolderW(&mut bi) };
        if pidl == 0 {
            return Ok(None);
        }
        let mut path_buf: Vec<u16> = vec![0u16; 520];
        let ok = unsafe { SHGetPathFromIDListW(pidl, path_buf.as_mut_ptr()) };
        unsafe { CoTaskMemFree(pidl); }
        if ok == 0 {
            return Ok(None);
        }
        let len = path_buf.iter().position(|&c| c == 0).unwrap_or(path_buf.len());
        let path = std::ffi::OsString::from_wide(&path_buf[..len])
            .to_string_lossy()
            .to_string();
        if path.is_empty() { return Ok(None); }
        return Ok(Some(path));
    }
    #[cfg(not(target_os = "windows"))]
    Ok(None)
}

/// Download an image from `url` and save it into `folder`.
/// Returns the full path of the saved file.
#[tauri::command]
async fn save_image_to_folder(url: String, folder: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    // Determine extension from URL or Content-Type
    let ext = {
        let from_url = url.split('?').next().unwrap_or(&url)
            .rsplit('.').next().unwrap_or("").to_lowercase();
        if matches!(from_url.as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp") {
            from_url
        } else {
            let ct = resp.headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if ct.contains("png") { "png".to_string() }
            else if ct.contains("gif") { "gif".to_string() }
            else if ct.contains("webp") { "webp".to_string() }
            else { "jpg".to_string() }
        }
    };
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    // Derive filename from URL path, fallback to timestamp
    let filename_base = url.split('?').next().unwrap_or(&url)
        .rsplit('/').next().unwrap_or("")
        .split('.').next().unwrap_or("");
    let filename = if filename_base.is_empty() {
        let ts = chrono::Local::now().format("image_%Y%m%d_%H%M%S").to_string();
        format!("{}.{}", ts, ext)
    } else {
        format!("{}.{}", filename_base, ext)
    };
    let dest = std::path::PathBuf::from(&folder).join(&filename);
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
fn get_data_dir() -> Result<String, String> {
    core_store::portable_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
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

#[tauri::command]
async fn fetch_board_categories() -> Result<Vec<BoardCategory>, String> {
    let menu = fetch_bbsmenu_cached().await?;

    // bbsmenu.json structure: { "menu_list": [ { "category_name": "...", "category_content": [...] } ] }
    let menu_list = menu
        .get("menu_list")
        .and_then(|v| v.as_array())
        .ok_or("bbsmenu missing menu_list array")?;

    let mut categories: Vec<BoardCategory> = Vec::new();

    for cat_obj in menu_list {
        let category_name = cat_obj
            .get("category_name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        let content = match cat_obj.get("category_content").and_then(|v| v.as_array()) {
            Some(arr) => arr,
            None => continue,
        };

        let mut boards: Vec<BoardEntry> = Vec::new();
        for item in content {
            let board_name = item
                .get("board_name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let url = item
                .get("url")
                .and_then(|v| v.as_str())
                .map(|u| normalize_5ch_url(u))
                .unwrap_or_default();
            if !board_name.is_empty() && !url.is_empty() {
                boards.push(BoardEntry { board_name, url });
            }
        }

        if !boards.is_empty() {
            categories.push(BoardCategory {
                category_name,
                boards,
            });
        }
    }

    Ok(categories)
}

// --- Favorites persistence ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FavoriteBoard {
    board_name: String,
    url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FavoriteThread {
    thread_url: String,
    title: String,
    board_url: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct FavoritesData {
    boards: Vec<FavoriteBoard>,
    threads: Vec<FavoriteThread>,
}

#[tauri::command]
fn load_favorites() -> Result<FavoritesData, String> {
    // Try new name first, fall back to old name and migrate
    if let Ok(data) = core_store::load_json::<FavoritesData>("board-catalog.json") {
        return Ok(data);
    }
    if let Ok(data) = core_store::load_json::<FavoritesData>("favorites.json") {
        // Migrate: save under new name, keep old file for safety
        let _ = core_store::save_json("board-catalog.json", &data);
        return Ok(data);
    }
    Ok(FavoritesData::default())
}

#[tauri::command]
fn save_favorites(favorites: FavoritesData) -> Result<(), String> {
    core_store::save_json("board-catalog.json", &favorites).map_err(|e| e.to_string())
}

// --- External boards persistence ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalBoard {
    board_name: String,
    url: String,
}

#[tauri::command]
fn load_external_boards() -> Result<Vec<ExternalBoard>, String> {
    match core_store::load_json::<Vec<ExternalBoard>>("external-boards.json") {
        Ok(data) => Ok(data),
        Err(_) => Ok(vec![]),
    }
}

#[tauri::command]
fn save_external_boards(boards: Vec<ExternalBoard>) -> Result<(), String> {
    core_store::save_json("external-boards.json", &boards).map_err(|e| e.to_string())
}

// --- Generic JSON persistence (for localStorage migration) ---

/// Save arbitrary JSON data to a named file in the data directory.
/// Allowed filenames are restricted to prevent path traversal.
#[tauri::command]
fn save_generic_json(filename: String, data: serde_json::Value) -> Result<(), String> {
    const ALLOWED: &[&str] = &[
        "bookmarks.json",
        "scroll-positions.json",
        "name-history.json",
        "my-posts.json",
        "search-history.json",
        "thread-fetch-times.json",
        "expanded-categories.json",
        "ui-state.json",
    ];
    if !ALLOWED.contains(&filename.as_str()) {
        return Err(format!("Filename not allowed: {}", filename));
    }
    core_store::save_json(&filename, &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_generic_json(filename: String) -> Result<serde_json::Value, String> {
    const ALLOWED: &[&str] = &[
        "bookmarks.json",
        "scroll-positions.json",
        "name-history.json",
        "my-posts.json",
        "search-history.json",
        "thread-fetch-times.json",
        "expanded-categories.json",
        "ui-state.json",
    ];
    if !ALLOWED.contains(&filename.as_str()) {
        return Err(format!("Filename not allowed: {}", filename));
    }
    match core_store::load_json::<serde_json::Value>(&filename) {
        Ok(data) => Ok(data),
        Err(_) => Ok(serde_json::Value::Null),
    }
}

// --- NG filter persistence ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum NgEntry {
    Simple(String),
    WithMode { value: String, mode: String },
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct NgFilters {
    #[serde(default)]
    words: Vec<NgEntry>,
    #[serde(default)]
    ids: Vec<NgEntry>,
    #[serde(default)]
    names: Vec<NgEntry>,
    #[serde(default)]
    thread_words: Vec<String>,
}

#[tauri::command]
fn load_ng_filters() -> Result<NgFilters, String> {
    // Try new name first, fall back to old name and migrate
    if let Ok(data) = core_store::load_json::<NgFilters>("ng-settings.json") {
        return Ok(data);
    }
    if let Ok(data) = core_store::load_json::<NgFilters>("ng_filters.json") {
        // Migrate: save under new name, keep old file for safety
        let _ = core_store::save_json("ng-settings.json", &data);
        return Ok(data);
    }
    Ok(NgFilters::default())
}

#[tauri::command]
fn save_ng_filters(filters: NgFilters) -> Result<(), String> {
    core_store::save_json("ng-settings.json", &filters).map_err(|e| e.to_string())
}

// --- Read status persistence ---

/// Map of board_url -> { thread_key -> last_read_response_no }
type ReadStatusMap = HashMap<String, HashMap<String, u32>>;

#[tauri::command]
fn load_read_status() -> Result<ReadStatusMap, String> {
    match core_store::load_json::<ReadStatusMap>("read_status.json") {
        Ok(data) => Ok(data),
        Err(_) => Ok(HashMap::new()),
    }
}

#[tauri::command]
fn save_read_status(status: ReadStatusMap) -> Result<(), String> {
    core_store::save_json("read_status.json", &status).map_err(|e| e.to_string())
}

// --- Thread history (thread-history.json) ---

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadHistoryEntry {
    last_read_no: u32,
    visited_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom_title: Option<String>,
}

/// Map of board_url -> { thread_key -> ThreadHistoryEntry }
type ThreadHistoryMap = HashMap<String, HashMap<String, ThreadHistoryEntry>>;

#[tauri::command]
fn load_thread_history() -> Result<ThreadHistoryMap, String> {
    match core_store::load_json::<ThreadHistoryMap>("thread-history.json") {
        Ok(data) => Ok(data),
        Err(_) => {
            // Migrate from read_status.json if thread-history.json doesn't exist
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let old = core_store::load_json::<ReadStatusMap>("read_status.json")
                .unwrap_or_default();
            let migrated: ThreadHistoryMap = old
                .into_iter()
                .map(|(board, threads)| {
                    let entries = threads
                        .into_iter()
                        .map(|(key, no)| {
                            (key, ThreadHistoryEntry { last_read_no: no, visited_at: now, custom_title: None })
                        })
                        .collect();
                    (board, entries)
                })
                .collect();
            Ok(migrated)
        }
    }
}

#[tauri::command]
fn save_thread_history(history: ThreadHistoryMap) -> Result<(), String> {
    core_store::save_json("thread-history.json", &history).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_thread_custom_title(board_url: String, thread_key: String, title: Option<String>) -> Result<(), String> {
    let mut history = load_thread_history()?;
    let entry = history
        .entry(board_url)
        .or_default()
        .entry(thread_key)
        .or_default();
    entry.custom_title = title;
    core_store::save_json("thread-history.json", &history).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_app_settings() -> Result<HashMap<String, String>, String> {
    core_store::load_settings_ini().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_app_settings(settings: HashMap<String, String>) -> Result<(), String> {
    core_store::save_settings_ini(&settings).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_event_log(level: String, message: String) -> Result<(), String> {
    let lvl = match level.to_uppercase().as_str() {
        "WARN" => "WARN",
        "ERROR" => "ERROR",
        _ => "INFO",
    };
    core_store::append_log_level(lvl, &message).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_layout_prefs(prefs: String) -> Result<(), String> {
    core_store::save_json("layout_prefs.json", &prefs).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_session_tabs(data: String) -> Result<(), String> {
    core_store::save_json("session_tabs.json", &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_session_tabs() -> Result<String, String> {
    match core_store::load_json::<String>("session_tabs.json") {
        Ok(data) => Ok(data),
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
fn save_session_board_tabs(data: String) -> Result<(), String> {
    core_store::save_json("session_board_tabs.json", &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_session_board_tabs() -> Result<String, String> {
    match core_store::load_json::<String>("session_board_tabs.json") {
        Ok(data) => Ok(data),
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
fn load_layout_prefs() -> Result<String, String> {
    match core_store::load_json::<String>("layout_prefs.json") {
        Ok(data) => Ok(data),
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
fn save_thread_cache(thread_url: String, title: String, responses_json: String) -> Result<(), String> {
    core_store::save_thread_cache(&thread_url, &title, &responses_json)
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
fn load_thread_cache(thread_url: String) -> Result<Option<String>, String> {
    core_store::load_thread_cache(&thread_url)
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
fn load_all_cached_threads() -> Result<Vec<(String, String, i64)>, String> {
    core_store::load_all_cached_threads()
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
fn delete_thread_cache(thread_url: String) -> Result<(), String> {
    core_store::delete_thread_cache(&thread_url)
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
fn quit_app() {
    std::process::exit(0);
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    width: f64,
    height: f64,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
    #[serde(default)]
    maximized: Option<bool>,
}

#[tauri::command]
fn save_window_size(window: tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let maximized = window.is_maximized().ok();
    let pos = window.outer_position().ok();
    let state = WindowState {
        width,
        height,
        x: pos.as_ref().map(|p| p.x),
        y: pos.as_ref().map(|p| p.y),
        maximized,
    };
    core_store::save_json("window_size.json", &state).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_window_size() -> Result<Option<WindowState>, String> {
    match core_store::load_json::<WindowState>("window_size.json") {
        Ok(data) => Ok(Some(data)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn set_window_theme(window: tauri::WebviewWindow, dark: bool) -> Result<(), String> {
    use tauri::Theme;
    window.set_theme(if dark { Some(Theme::Dark) } else { Some(Theme::Light) })
        .map_err(|e| format!("{}", e))
}

// --- Image upload (tadaup.jp) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageUploadResult {
    success: bool,
    source_url: String,
    thumbnail: String,
    page_url: String,
}

#[tauri::command]
async fn upload_image(file_data: String, file_name: String) -> Result<ImageUploadResult, String> {
    use reqwest::multipart;
    use base64::Engine;

    let file_bytes = base64::engine::general_purpose::STANDARD
        .decode(&file_data)
        .map_err(|e| format!("Base64デコードエラー: {}", e))?;
    let mime = if file_name.ends_with(".png") { "image/png" }
        else if file_name.ends_with(".gif") { "image/gif" }
        else if file_name.ends_with(".webp") { "image/webp" }
        else if file_name.ends_with(".mp4") { "video/mp4" }
        else if file_name.ends_with(".webm") { "video/webm" }
        else { "image/jpeg" };
    let part = multipart::Part::bytes(file_bytes)
        .file_name(file_name)
        .mime_str(mime)
        .map_err(|e| format!("MIME設定エラー: {}", e))?;
    let form = multipart::Form::new()
        .text("title", "うｐろだ")
        .text("comment", "")
        .text("r18", "no")
        .part("file[]", part);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTPクライアント作成エラー: {}", e))?;
    let resp = client
        .post("https://tadaup.jp/wp-json/custom/v1/upload")
        .basic_auth("API", Some("AoLU ets7 2zh3 gvqc cTEe BHfp"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("アップロードエラー: {}", e))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("レスポンス読み取りエラー: {}", e))?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }
    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("JSONパースエラー: {}", e))?;
    let success = json.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
    if !success {
        let msg = json.get("message").and_then(|v| v.as_str()).unwrap_or("unknown error");
        return Err(format!("アップロード失敗: {}", msg));
    }
    Ok(ImageUploadResult {
        success: true,
        source_url: json.get("source_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        thumbnail: json.get("thumbnail").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        page_url: json.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadHistoryEntry {
    source_url: String,
    thumbnail: String,
    page_url: String,
    file_name: String,
    uploaded_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct UploadHistory {
    entries: Vec<UploadHistoryEntry>,
}

#[tauri::command]
fn load_upload_history() -> Result<UploadHistory, String> {
    match core_store::load_json::<UploadHistory>("upload_history.json") {
        Ok(data) => Ok(data),
        Err(_) => Ok(UploadHistory::default()),
    }
}

#[tauri::command]
fn save_upload_history(history: UploadHistory) -> Result<(), String> {
    core_store::save_json("upload_history.json", &history).map_err(|e| e.to_string())
}

// ===== Highlight Commands =====

#[tauri::command]
fn load_id_highlights() -> Result<serde_json::Value, String> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let data = core_store::load_json::<serde_json::Value>("id-highlights.json")
        .unwrap_or_else(|_| serde_json::json!({ "date": "", "highlights": {} }));
    // Purge highlights if date has changed
    let stored_date = data.get("date").and_then(|v| v.as_str()).unwrap_or("");
    if stored_date != today {
        let fresh = serde_json::json!({ "date": today, "highlights": {} });
        let _ = core_store::save_json("id-highlights.json", &fresh);
        return Ok(fresh);
    }
    Ok(data)
}

#[tauri::command]
fn save_id_highlights(data: serde_json::Value) -> Result<(), String> {
    core_store::save_json("id-highlights.json", &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_text_highlights() -> Result<serde_json::Value, String> {
    core_store::load_json::<serde_json::Value>("text-highlights.json")
        .map_err(|e| e.to_string())
        .or_else(|_| Ok(serde_json::json!([])))
}

#[tauri::command]
fn save_text_highlights(data: serde_json::Value) -> Result<(), String> {
    core_store::save_json("text-highlights.json", &data).map_err(|e| e.to_string())
}

// ===== Proxy Commands =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxySettingsPayload {
    enabled: bool,
    proxy_type: String,
    host: String,
    port: String,
    username: String,
    password: String,
}

#[tauri::command]
fn load_proxy_settings() -> Result<ProxySettingsPayload, String> {
    let map = core_store::load_settings_ini().unwrap_or_default();
    let enabled = map.get("Proxy.ProxyEnabled").map(|v| v == "true").unwrap_or(false);
    let proxy_type = map.get("Proxy.ProxyType").cloned().unwrap_or_else(|| "http".into());
    let host = map.get("Proxy.ProxyHost").cloned().unwrap_or_default();
    let port = map.get("Proxy.ProxyPort").cloned().unwrap_or_default();
    let username = map.get("Proxy.ProxyUsername").cloned().unwrap_or_default();
    let stored_pw = map.get("Proxy.ProxyPassword").cloned().unwrap_or_default();
    let password = unprotect_password(&stored_pw);
    Ok(ProxySettingsPayload { enabled, proxy_type, host, port, username, password })
}

#[tauri::command]
fn save_proxy_settings(settings: ProxySettingsPayload) -> Result<(), String> {
    let encrypted_pw = protect_password(&settings.password);
    let mut updates = HashMap::new();
    updates.insert("Proxy.ProxyEnabled".to_string(), settings.enabled.to_string());
    updates.insert("Proxy.ProxyType".to_string(), settings.proxy_type.clone());
    updates.insert("Proxy.ProxyHost".to_string(), settings.host.clone());
    updates.insert("Proxy.ProxyPort".to_string(), settings.port.clone());
    updates.insert("Proxy.ProxyUsername".to_string(), settings.username.clone());
    updates.insert("Proxy.ProxyPassword".to_string(), encrypted_pw);
    core_store::save_settings_ini(&updates).map_err(|e| e.to_string())?;

    // Push new settings into global proxy state so next build_client picks it up
    update_proxy_settings(ProxySettings {
        enabled: settings.enabled,
        proxy_type: ProxyType::from_str(&settings.proxy_type),
        host: settings.host,
        port: settings.port,
        username: settings.username,
        password: settings.password,
    });
    Ok(())
}

// ===== ImageViewURLReplace Commands =====

const DEFAULT_IMAGE_URL_RULES: &str = "\
# Twitter/X 画像URL正規化
^https?://pbs\\.twimg\\.com/media/([^?]+)\\?format=(\\w+)&name=.*\thttps://pbs.twimg.com/media/$1?format=$2&name=orig
^https?://pbs\\.twimg\\.com/media/([^?:]+)(?::(\\w+))?$\thttps://pbs.twimg.com/media/$1?format=jpg&name=orig

# ニコニコ動画サムネイル
^https?://(?:www\\.)?nicovideo\\.jp/watch/sm(\\d+)\thttps://nicovideo.cdn.nimg.jp/thumbnails/$1/$1
";

#[tauri::command]
fn load_image_url_replace() -> Result<Vec<UrlReplaceRule>, String> {
    let path = core_store::portable_data_dir()
        .map_err(|e| e.to_string())?
        .join("ImageViewURLReplace.txt");
    let content = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        std::fs::write(&path, DEFAULT_IMAGE_URL_RULES).map_err(|e| e.to_string())?;
        DEFAULT_IMAGE_URL_RULES.to_string()
    };
    Ok(parse_url_replace_rules(&content))
}

#[tauri::command]
fn reset_image_url_replace() -> Result<Vec<UrlReplaceRule>, String> {
    let path = core_store::portable_data_dir()
        .map_err(|e| e.to_string())?
        .join("ImageViewURLReplace.txt");
    std::fs::write(&path, DEFAULT_IMAGE_URL_RULES).map_err(|e| e.to_string())?;
    Ok(parse_url_replace_rules(DEFAULT_IMAGE_URL_RULES))
}

// ===== Cookie Persistence Commands =====

#[tauri::command]
fn load_cookies() -> Result<CookiesFile, String> {
    match core_store::load_json::<CookiesFile>("cookies.json") {
        Ok(data) => Ok(data),
        Err(_) => Ok(CookiesFile { version: 1, cookies: Vec::new() }),
    }
}

#[tauri::command]
fn save_cookies(data: CookiesFile) -> Result<(), String> {
    core_store::save_json("cookies.json", &data).map_err(|e| e.to_string())
}

// ===== TTS Commands =====

#[tauri::command]
fn sapi_list_voices() -> Result<Vec<core_tts::VoiceInfo>, String> {
    std::thread::spawn(|| {
        core_tts::sapi_list_voices().map_err(|e| e.to_string())
    })
    .join()
    .map_err(|_| "SAPI thread panicked".to_string())?
}

#[tauri::command]
fn sapi_speak_text(text: String, voice_index: u32, rate: i32, volume: u32) -> Result<(), String> {
    std::thread::spawn(move || {
        core_tts::sapi_speak(&text, voice_index, rate, volume).map_err(|e| e.to_string())
    })
    .join()
    .map_err(|_| "SAPI thread panicked".to_string())?
}

#[tauri::command]
fn sapi_stop_speech() -> Result<(), String> {
    std::thread::spawn(|| {
        core_tts::sapi_stop().map_err(|e| e.to_string())
    })
    .join()
    .map_err(|_| "SAPI thread panicked".to_string())?
}

#[tauri::command]
fn bouyomi_speak_text(
    remote_talk_path: String,
    text: String,
    speed: i32,
    tone: i32,
    volume: i32,
    voice: i32,
) -> Result<(), String> {
    core_tts::bouyomi_speak(&remote_talk_path, &text, speed, tone, volume, voice)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn voicevox_get_speakers(endpoint: String) -> Result<Vec<core_tts::VoicevoxSpeaker>, String> {
    core_tts::voicevox_get_speakers(&endpoint)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn voicevox_speak_text(
    endpoint: String,
    text: String,
    speaker_id: i32,
    speed_scale: f64,
    pitch_scale: f64,
    intonation_scale: f64,
    volume_scale: f64,
) -> Result<(), String> {
    let wav = core_tts::voicevox_speak(
        &endpoint,
        &text,
        speaker_id,
        speed_scale,
        pitch_scale,
        intonation_scale,
        volume_scale,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Play via Win32 PlaySoundW (async, temp file)
    core_tts::play_wav_from_bytes(&wav).map_err(|e| e.to_string())
}

#[tauri::command]
async fn tts_stop() -> Result<(), String> {
    // Stop current speech and clear queue
    let mut queue = core_tts::tts_queue().lock().await;
    queue.clear();
    // Also stop SAPI if it's running
    let _ = std::thread::spawn(|| {
        let _ = core_tts::sapi_stop();
    })
    .join();
    Ok(())
}

// ===== Image Popup Commands =====

/// Fetch an image URL and return a base64 data URL.
#[tauri::command]
async fn fetch_image(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .split(';')
        .next()
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    Ok(format!("data:{};base64,{}", ct, b64))
}

/// Store the data URL and open a popup window.
/// `width` / `height` are the image's natural pixel dimensions (used for window sizing).
#[tauri::command]
async fn open_image_popup(
    app: AppHandle,
    url: String,
) -> Result<(), String> {
    // Download image as data URL
    let data_url = fetch_image(url.clone()).await?;

    // Derive label from URL filename
    let label = url.rsplit('/').next()
        .and_then(|s| s.split('?').next())
        .unwrap_or("image")
        .to_string();
    let label = if label.len() > 30 { format!("{}…", &label[..27]) } else { label };

    let entry = PopupImageEntry {
        id: format!("{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()),
        data_url,
        source_url: url,
        label,
    };

    // Add to state
    {
        let state = app.state::<ImagePopupState>();
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.push(entry.clone());
    }

    // If popup already exists and is visible, emit event to add tab and focus
    if let Some(win) = app.get_webview_window("image_popup") {
        if win.is_visible().unwrap_or(false) {
            let _ = app.emit_to("image_popup", "image-popup-add-tab", &entry);
            let _ = win.set_focus();
            return Ok(());
        }
        // Window exists but not visible (closing) — destroy and recreate
        let _ = win.destroy();
    }

    // Create new popup window
    WebviewWindowBuilder::new(
        &app,
        "image_popup",
        tauri::WebviewUrl::App("image_popup.html".into()),
    )
    .title("LiveFake - 画像")
    .inner_size(900.0, 700.0)
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Get all image entries for the popup (used on initial load).
#[tauri::command]
fn get_image_popup_data(app: AppHandle) -> Result<Vec<PopupImageEntry>, String> {
    let state = app.state::<ImagePopupState>();
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    Ok(guard.clone())
}

/// Remove a single image tab from the popup state.
#[tauri::command]
fn remove_popup_image(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<ImagePopupState>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    guard.retain(|e| e.id != id);
    Ok(())
}

/// Clear all popup image state (called when popup window closes).
#[tauri::command]
fn clear_popup_images(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ImagePopupState>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    guard.clear();
    Ok(())
}

// ===== Subtitle Window Commands =====

#[tauri::command]
fn subtitle_show(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("subtitle") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "subtitle", tauri::WebviewUrl::App("subtitle.html".into()))
        .title("LiveFake - 字幕")
        .inner_size(800.0, 200.0)
        .decorations(false)
        .always_on_top(true)
        .resizable(true)
        .skip_taskbar(true)
        .background_color(tauri::window::Color(26, 26, 46, 255))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn subtitle_hide(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("subtitle") {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn subtitle_update(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    app.emit_to("subtitle", "subtitle-update", data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn subtitle_opacity(app: AppHandle, opacity: f64) -> Result<(), String> {
    app.emit_to("subtitle", "subtitle-opacity", serde_json::json!({ "opacity": opacity }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn subtitle_topmost(app: AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("subtitle") {
        win.set_always_on_top(enabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn subtitle_font_size(app: AppHandle, size: u32) -> Result<(), String> {
    app.emit_to("subtitle", "subtitle-font-size", serde_json::json!({ "size": size }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn subtitle_meta_font_size(app: AppHandle, size: u32) -> Result<(), String> {
    app.emit_to("subtitle", "subtitle-meta-font-size", serde_json::json!({ "size": size }))
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Disable WebKit2GTK's DMA-BUF renderer and GPU compositing on Wayland
    // to prevent white screen / EGL errors on some GPU/driver combinations
    // See: https://github.com/tauri-apps/tauri/issues/11988
    //      https://github.com/tauri-apps/tauri/issues/10749
    #[cfg(target_os = "linux")]
    {
        let is_wayland = std::env::var("WAYLAND_DISPLAY").is_ok()
            || std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false);
        if is_wayland {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }

    let _ = core_store::init_portable_layout();
    let _ = core_store::append_log("app started");

    // Disable Chromium smooth scrolling if settings.ini App.smoothScroll=false
    // Must be set BEFORE WebView2 controller creation (i.e. before Tauri Builder)
    #[cfg(target_os = "windows")]
    {
        let smooth = core_store::load_settings_ini()
            .ok()
            .and_then(|m| m.get("App.smoothScroll").cloned())
            .unwrap_or_else(|| "true".to_string());
        if smooth == "false" {
            let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
            let args = if existing.is_empty() {
                "--disable-smooth-scrolling".to_string()
            } else {
                format!("{existing} --disable-smooth-scrolling")
            };
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
        }
    }

    tauri::Builder::default()
        .manage(ImagePopupState(Mutex::new(Vec::new())))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the existing window when a second instance is launched
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .setup(|app| {
            // Purge old event logs based on retention setting (default 7 days)
            let retention: u32 = core_store::load_settings_ini()
                .ok()
                .and_then(|m| m.get("App.logRetentionDays").and_then(|v| v.parse().ok()))
                .unwrap_or(7);
            let _ = core_store::purge_old_logs(retention);
            let _ = core_store::append_log("App started");
            if let Ok(state) = core_store::load_json::<WindowState>("window_size.json") {
                if let Some(win) = app.get_webview_window("main") {
                    if state.maximized == Some(true) {
                        let _ = win.maximize();
                    } else {
                        let _ = win.set_size(tauri::LogicalSize::new(state.width, state.height));
                        if let (Some(x), Some(y)) = (state.x, state.y) {
                            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
                        }
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fetch_bbsmenu_summary,
            fetch_board_categories,
            probe_post_cookie_scope_simulation,
            probe_thread_post_form,
            fetch_thread_list,
            fetch_thread_responses_command,
            debug_post_connectivity,
            probe_post_confirm_empty,
            probe_post_confirm,
            probe_post_finalize_preview,
            probe_post_finalize_preview_from_input,
            probe_post_finalize_submit_empty,
            probe_post_finalize_submit_from_input,
            probe_post_flow_trace,
            check_for_updates,
            get_data_dir,
            open_file_dialog,
            open_folder_dialog,
            save_image_to_folder,
            open_external_url,
            load_favorites,
            save_favorites,
            load_ng_filters,
            save_ng_filters,
            load_read_status,
            load_thread_history,
            save_thread_history,
            set_thread_custom_title,
            save_read_status,
            load_app_settings,
            save_app_settings,
            write_event_log,
            save_layout_prefs,
            load_layout_prefs,
            save_session_tabs,
            load_session_tabs,
            save_session_board_tabs,
            load_session_board_tabs,
            post_reply_multisite,
            create_thread_command,
            save_thread_cache,
            load_thread_cache,
            load_all_cached_threads,
            delete_thread_cache,
            set_window_theme,
            save_window_size,
            load_window_size,
            quit_app,
            upload_image,
            load_upload_history,
            save_upload_history,
            load_id_highlights,
            save_id_highlights,
            load_text_highlights,
            save_text_highlights,
            load_external_boards,
            save_external_boards,
            save_generic_json,
            load_generic_json,
            load_proxy_settings,
            save_proxy_settings,
            load_image_url_replace,
            reset_image_url_replace,
            load_cookies,
            save_cookies,
            sapi_list_voices,
            sapi_speak_text,
            sapi_stop_speech,
            bouyomi_speak_text,
            voicevox_get_speakers,
            voicevox_speak_text,
            tts_stop,
            fetch_image,
            open_image_popup,
            get_image_popup_data,
            remove_popup_image,
            clear_popup_images,
            subtitle_show,
            subtitle_hide,
            subtitle_update,
            subtitle_opacity,
            subtitle_topmost,
            subtitle_font_size,
            subtitle_meta_font_size
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
