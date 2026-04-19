use encoding_rs::{EUC_JP, SHIFT_JIS, UTF_8};

/// Detect the most likely encoding of raw bytes.
/// Returns one of "utf-8", "shift_jis", "euc-jp".
pub fn detect_encoding(bytes: &[u8]) -> &'static str {
    let candidates: &[(&'static str, &encoding_rs::Encoding)] = &[
        ("utf-8", UTF_8),
        ("shift_jis", SHIFT_JIS),
        ("euc-jp", EUC_JP),
    ];
    let mut best_name = "utf-8";
    let mut best_score = i64::MIN;

    for &(name, encoding) in candidates {
        let (decoded, _, had_errors) = encoding.decode(bytes);
        let mut score: i64 = 0;
        if had_errors {
            // Count replacement characters
            let replacements = decoded.chars().filter(|&c| c == '\u{FFFD}').count();
            score -= replacements as i64 * 10;
        }
        // Japanese character bonus
        let has_japanese = decoded.chars().any(|c| {
            matches!(c,
                '\u{3040}'..='\u{309F}' | // Hiragana
                '\u{30A0}'..='\u{30FF}' | // Katakana
                '\u{4E00}'..='\u{9FFF}'   // CJK Unified
            )
        });
        if has_japanese {
            score += 20;
        }
        // HTML tag bonus
        if decoded.contains('<') && decoded.contains('>') {
            score += 5;
        }
        if score > best_score {
            best_score = score;
            best_name = name;
        }
    }
    best_name
}

/// Decode raw bytes using auto-detected encoding.
pub fn decode_auto(bytes: &[u8]) -> String {
    let enc_name = detect_encoding(bytes);
    let encoding = match enc_name {
        "shift_jis" => SHIFT_JIS,
        "euc-jp" => EUC_JP,
        _ => UTF_8,
    };
    let (decoded, _, _) = encoding.decode(bytes);
    decoded.into_owned()
}

/// Decode bytes as EUC-JP.
pub fn decode_euc_jp(bytes: &[u8]) -> String {
    let (decoded, _, _) = EUC_JP.decode(bytes);
    decoded.into_owned()
}

/// Decode bytes as Shift_JIS.
pub fn decode_shift_jis(bytes: &[u8]) -> String {
    let (decoded, _, _) = SHIFT_JIS.decode(bytes);
    decoded.into_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubjectEntry {
    pub thread_key: String,
    pub title: String,
    pub response_count: u32,
}

#[derive(Debug, Clone)]
pub struct ReadCgiResult {
    pub title: Option<String>,
    pub entries: Vec<DatEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatEntry {
    pub name: String,
    pub mail: String,
    pub date_and_id: String,
    pub body: String,
}

pub fn parse_subject_line(line: &str) -> Option<SubjectEntry> {
    let (key, rest) = line.split_once(".dat<>")?;
    let (title, count_raw) = rest.rsplit_once(" (")?;
    let count = count_raw.strip_suffix(')')?.parse().ok()?;

    Some(SubjectEntry {
        thread_key: key.to_string(),
        title: title.to_string(),
        response_count: count,
    })
}

fn sanitize_dat_body(raw: &str) -> String {
    raw.replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

/// Parse read.cgi HTML into DatEntry list.
/// Supports 5ch modern layout: `<div class="clear post">` with
/// `postusername`, `date`, `uid`, `post-content` spans/divs.
/// Also supports legacy `<dl><dt>/<dd>` layout.
pub fn parse_read_cgi_html(html: &str) -> ReadCgiResult {
    let title = extract_between(html, "<title>", "</title>")
        .map(|t| strip_html_tags(&t).trim().to_string())
        .filter(|t| !t.is_empty());
    let mut out = Vec::new();

    // Modern 5ch layout: class="clear post"
    // Structure: <div ... class="clear post">
    //   <span class="postusername"><b>NAME</b>...</span>
    //   <span class="date">DATE</span>
    //   <span class="uid">ID:xxx</span>
    //   <div class="post-content">BODY</div>
    // </div>
    if html.contains("class=\"clear post\"") || html.contains("class=\"post\"") {
        let split_tag = if html.contains("class=\"clear post\"") {
            "class=\"clear post\""
        } else {
            "class=\"post\""
        };
        for chunk in html.split(split_tag).skip(1) {
            let name = extract_between(chunk, "class=\"postusername\">", "</span>")
                .or_else(|| extract_between(chunk, "class=\"name\">", "</span>"))
                .unwrap_or_default();
            let date = extract_between(chunk, "class=\"date\">", "</span>")
                .unwrap_or_default();
            let uid = extract_between(chunk, "class=\"uid\">", "</span>")
                .unwrap_or_default();
            let date_id = if uid.is_empty() {
                strip_html_tags(&date)
            } else {
                format!("{} {}", strip_html_tags(&date), strip_html_tags(&uid))
            };
            let body = extract_between(chunk, "class=\"post-content\">", "</div>")
                .or_else(|| extract_between(chunk, "class=\"message\">", "</div>"))
                .or_else(|| extract_between(chunk, "class=\"msg\">", "</div>"))
                .unwrap_or_default();
            if !body.is_empty() || !name.is_empty() {
                out.push(DatEntry {
                    name: strip_html_tags(&name),
                    mail: String::new(),
                    date_and_id: date_id,
                    body: sanitize_dat_body(&body),
                });
            }
        }
    }

    // Fallback: <dt>N ：<a ...><b>NAME</b></a>：DATE ID:xxx<dd>BODY
    if out.is_empty() {
        let parts: Vec<&str> = html.split("<dt>").collect();
        for part in parts.iter().skip(1) {
            let (dt_part, dd_rest) = match part.split_once("<dd>") {
                Some(p) => p,
                None => continue,
            };
            let body_raw = dd_rest
                .split("<dt>").next()
                .and_then(|s| s.split("<br><br>").next())
                .unwrap_or(dd_rest);
            let name = extract_between(dt_part, "<b>", "</b>").unwrap_or_default();
            let date_id = dt_part
                .rsplit_once("：")
                .or_else(|| dt_part.rsplit_once(":"))
                .map(|(_, d)| d.trim().to_string())
                .unwrap_or_default();
            out.push(DatEntry {
                name: strip_html_tags(&name),
                mail: String::new(),
                date_and_id: strip_html_tags(&date_id),
                body: sanitize_dat_body(body_raw),
            });
        }
    }

    ReadCgiResult { title, entries: out }
}

fn extract_between(s: &str, start: &str, end: &str) -> Option<String> {
    let start_idx = s.find(start)? + start.len();
    let rest = &s[start_idx..];
    let end_idx = rest.find(end)?;
    Some(rest[..end_idx].to_string())
}

fn strip_html_tags(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        if ch == '<' { in_tag = true; continue; }
        if ch == '>' { in_tag = false; continue; }
        if !in_tag { result.push(ch); }
    }
    result.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

pub fn parse_dat_line(line: &str) -> Option<DatEntry> {
    let mut it = line.split("<>");
    let name = it.next()?.to_string();
    let mail = it.next()?.to_string();
    let date_and_id = it.next()?.to_string();
    let body_raw = it.next()?.to_string();
    let body = sanitize_dat_body(&body_raw);

    Some(DatEntry {
        name,
        mail,
        date_and_id,
        body,
    })
}

// ---------------------------------------------------------------------------
// したらば (jbbs.shitaraba.net) parsers
// ---------------------------------------------------------------------------

/// Parse したらば subject.txt (EUC-JP encoded).
/// Format: `{thread_key}.cgi,{title}({count})`
pub fn parse_shitaraba_subject_line(line: &str) -> Option<SubjectEntry> {
    let (key_part, rest) = line.split_once(".cgi,")?;
    let (title, count_paren) = rest.rsplit_once('(')?;
    let count_str = count_paren.strip_suffix(')')?;
    let count = count_str.parse().ok()?;
    Some(SubjectEntry {
        thread_key: key_part.to_string(),
        title: title.to_string(),
        response_count: count,
    })
}

/// Parse したらば thread list from raw bytes (EUC-JP).
pub fn parse_shitaraba_thread_list(body: &[u8]) -> Vec<SubjectEntry> {
    let text = decode_euc_jp(body);
    text.lines().filter_map(parse_shitaraba_subject_line).collect()
}

/// Parse したらば rawmode.cgi response (EUC-JP).
/// Format per line: `{no}<>{name}<>{mail}<>{date_id}<>{body}<>{title}<>`
/// Title is only on line 1.
pub fn parse_shitaraba_rawmode_line(line: &str) -> Option<(DatEntry, Option<String>)> {
    let parts: Vec<&str> = line.split("<>").collect();
    if parts.len() < 6 {
        return None;
    }
    let title = if !parts[5].is_empty() {
        Some(parts[5].to_string())
    } else {
        None
    };
    Some((
        DatEntry {
            name: strip_html_tags(parts[1]),
            mail: parts[2].to_string(),
            date_and_id: parts[3].to_string(),
            body: sanitize_dat_body(parts[4]),
        },
        title,
    ))
}

/// Parse したらば responses from rawmode.cgi bytes (EUC-JP).
/// Returns (entries_with_response_no, optional_title).
pub fn parse_shitaraba_responses(body: &[u8]) -> (Vec<(u32, DatEntry)>, Option<String>) {
    let text = decode_euc_jp(body);
    let mut entries = Vec::new();
    let mut title = None;
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        // First field is the response number
        if let Some((no_str, rest)) = line.split_once("<>") {
            let no: u32 = match no_str.parse() {
                Ok(n) => n,
                Err(_) => continue,
            };
            // Reconstruct line without the leading number for rawmode parser
            let reconstructed = format!("{}<>{}", no_str, rest);
            if let Some((entry, t)) = parse_shitaraba_rawmode_line(&reconstructed) {
                if title.is_none() {
                    title = t;
                }
                entries.push((no, entry));
            }
        }
    }
    (entries, title)
}

// ---------------------------------------------------------------------------
// したらば DT/DD HTML parser (for bbs/read.cgi fallback)
// ---------------------------------------------------------------------------

/// Parse したらば HTML responses (DT/DD format).
/// Actual format: `<dt id="comment_N"><a href="...">N</a>：<b>名前</b>：日時 ID:xxx</dt>`
///                `<dd>本文<br></dd>`
pub fn parse_shitaraba_html_responses(body: &[u8]) -> (Vec<(u32, DatEntry)>, Option<String>) {
    let text = decode_euc_jp(body);
    let lower = text.to_lowercase();

    // Extract page title
    let title = lower.find("<title>").and_then(|i| {
        let rest = &text[i + 7..];
        lower[i + 7..].find("</title>").map(|j| {
            strip_html_tags(&rest[..j]).trim().to_string()
        })
    }).filter(|t| !t.is_empty());

    let mut entries = Vec::new();
    let mut search_from = 0usize;

    loop {
        // Find next <dt (with or without attributes, e.g. <dt id="comment_1">)
        let dt_start = match lower[search_from..].find("<dt") {
            Some(p) => search_from + p,
            None => break,
        };
        // Verify the char after "<dt" is ">", space, or newline (not e.g. "<dtd>")
        let after_kw = dt_start + 3;
        match lower.as_bytes().get(after_kw) {
            Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') => {}
            _ => { search_from = after_kw; continue; }
        }
        // Find the closing > of the opening <dt ...> tag
        let gt = match lower[after_kw..].find('>') {
            Some(p) => after_kw + p + 1,
            None => break,
        };
        let dt_content_start = gt;

        // Find </dt> to delimit dt content
        let dt_end = match lower[dt_content_start..].find("</dt>") {
            Some(p) => dt_content_start + p,
            None => break,
        };
        let dt_part = &text[dt_content_start..dt_end];

        // Find <dd> after </dt>
        let after_dt_close = dt_end + 5;
        let dd_open = match lower[after_dt_close..].find("<dd") {
            Some(p) => after_dt_close + p,
            None => break,
        };
        let dd_gt = match lower[dd_open + 3..].find('>') {
            Some(p) => dd_open + 3 + p + 1,
            None => break,
        };
        let dd_content_start = dd_gt;

        // End of <dd>: prefer </dd>, else next <dt, else </dl>
        let dd_end = lower[dd_content_start..]
            .find("</dd>")
            .map(|p| dd_content_start + p)
            .or_else(|| lower[dd_content_start..].find("<dt").map(|p| dd_content_start + p))
            .or_else(|| lower[dd_content_start..].find("</dl>").map(|p| dd_content_start + p))
            .unwrap_or(text.len());

        let body_raw = &text[dd_content_start..dd_end];

        // Strip trailing <br> sequences and normalize body
        let body_trimmed = {
            let trimmed = body_raw.trim_end();
            let mut end = trimmed.len();
            let lt = trimmed.to_lowercase();
            while end >= 4 && lt[..end].ends_with("<br>") {
                end -= 4;
            }
            trimmed[..end].trim_end()
        };
        // Remove HTML-source newlines after <br> tags (artifact of HTML indentation)
        // and trim leading whitespace. Without this, "<br>\n" becomes "\n\n" after sanitize.
        let body_normalized = body_trimmed.trim_start()
            .replace("<br>\r\n", "<br>")
            .replace("<br>\n", "<br>")
            .replace("<BR>\r\n", "<BR>")
            .replace("<BR>\n", "<BR>");

        // Response number: strip all HTML/comments first, then parse leading digits
        let stripped_dt = strip_html_tags(dt_part);
        let no_str = stripped_dt.trim()
            .split(|c: char| !c.is_ascii_digit())
            .next()
            .unwrap_or("0");
        let no: u32 = no_str.parse().unwrap_or(0);

        if no > 0 {
            // Name from <b>...</b>
            let name = {
                let ldt = dt_part.to_lowercase();
                ldt.find("<b>").and_then(|i| {
                    let rest = &dt_part[i + 3..];
                    ldt[i + 3..].find("</b>").map(|j| strip_html_tags(&rest[..j]))
                }).unwrap_or_default()
            };

            // date_and_id: last "：" segment in stripped dt
            let date_id = stripped_dt.rsplit_once('：')
                .or_else(|| stripped_dt.rsplit_once(':'))
                .map(|(_, d)| d.trim().to_string())
                .unwrap_or_default();

            // Mail from <a href="mailto:...">
            let mail = {
                let ldt = dt_part.to_lowercase();
                ldt.find("mailto:").and_then(|i| {
                    let rest = &dt_part[i + 7..];
                    rest.find('"').map(|j| rest[..j].to_string())
                }).unwrap_or_default()
            };

            entries.push((no, DatEntry {
                name,
                mail,
                date_and_id: date_id,
                body: sanitize_dat_body(&body_normalized),
            }));
        }

        search_from = dt_start + 3;
    }

    (entries, title)
}

// ---------------------------------------------------------------------------
// JPNKN (bbs.jpnkn.com) — uses standard dat format, same as 5ch
// ---------------------------------------------------------------------------

/// Parse JPNKN subject.txt (Shift_JIS encoded).
/// Same format as 5ch: `{key}.dat<>{title} ({count})`
pub fn parse_jpnkn_thread_list(body: &[u8]) -> Vec<SubjectEntry> {
    let text = decode_shift_jis(body);
    text.lines().filter_map(parse_subject_line).collect()
}

/// Parse JPNKN dat responses (Shift_JIS encoded).
/// Same dat format as 5ch.
pub fn parse_jpnkn_responses(body: &[u8]) -> (Vec<(u32, DatEntry)>, Option<String>) {
    let text = decode_shift_jis(body);
    let mut entries = Vec::new();
    let mut title = None;
    for (idx, line) in text.lines().enumerate() {
        if idx == 0 {
            // Title is the 5th field of the first line
            let parts: Vec<&str> = line.split("<>").collect();
            if parts.len() >= 5 && !parts[4].is_empty() {
                title = Some(parts[4].to_string());
            }
        }
        if let Some(entry) = parse_dat_line(line) {
            entries.push(((idx + 1) as u32, entry));
        }
    }
    (entries, title)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_subject_line_works() {
        let line = "1234567890.dat<>thread title (345)";
        let got = parse_subject_line(line).expect("subject");
        assert_eq!(got.thread_key, "1234567890");
        assert_eq!(got.title, "thread title");
        assert_eq!(got.response_count, 345);
    }

    #[test]
    fn parse_dat_line_works() {
        let line = "name<>mail<>2026/03/19(木) 12:34:56.78 ID:abc<>hello<br>world<>";
        let got = parse_dat_line(line).expect("dat");
        assert_eq!(got.name, "name");
        assert_eq!(got.mail, "mail");
        assert_eq!(got.date_and_id, "2026/03/19(木) 12:34:56.78 ID:abc");
        assert_eq!(got.body, "hello\nworld");
    }

    #[test]
    fn parse_shitaraba_subject_line_works() {
        let line = "1234567890.cgi,テストスレッド(42)";
        let got = parse_shitaraba_subject_line(line).expect("shitaraba subject");
        assert_eq!(got.thread_key, "1234567890");
        assert_eq!(got.title, "テストスレッド");
        assert_eq!(got.response_count, 42);
    }

    #[test]
    fn parse_shitaraba_rawmode_line_works() {
        let line = "1<>名無し<>sage<>2026/04/01(火) 12:00:00 ID:abc<>本文テスト<>スレタイトル<>";
        let (entry, title) = parse_shitaraba_rawmode_line(line).expect("rawmode");
        assert_eq!(entry.name, "名無し");
        assert_eq!(entry.mail, "sage");
        assert!(entry.date_and_id.contains("2026/04/01"));
        assert_eq!(entry.body, "本文テスト");
        assert_eq!(title, Some("スレタイトル".to_string()));
    }

    #[test]
    fn detect_encoding_utf8() {
        let text = "こんにちは世界";
        assert_eq!(detect_encoding(text.as_bytes()), "utf-8");
    }

    #[test]
    fn detect_encoding_shift_jis() {
        let (bytes, _, _) = SHIFT_JIS.encode("テスト<>データ");
        assert_eq!(detect_encoding(&bytes), "shift_jis");
    }

    #[test]
    fn detect_encoding_euc_jp() {
        let (bytes, _, _) = EUC_JP.encode("テスト<>データ");
        assert_eq!(detect_encoding(&bytes), "euc-jp");
    }
}
