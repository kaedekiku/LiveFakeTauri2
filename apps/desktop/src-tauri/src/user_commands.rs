//! コマンド (Jane Style の「コマンド」と同じ考え方): 利用者が登録したプログラムや URL で、リンク・選んだ文字などを開く。
//!
//! - 登録は data/commands.json。プログラムは「参照」(ファイルを選ぶ画面) で選んだ .exe だけを登録できる
//!   (画面のスクリプトだけでは新しいプログラムを登録できないようにするため)
//! - 実行するときは、呼んだ側からはコマンドの id と置き換える値だけを受け取り、プログラムの場所は保存した登録から読む
//! - プログラムはシェルを通さずに直接起動する。引数は登録した時点の区切りのまま置き換えるので、値に何が入っていても引数は増えない
//! - レスやスレから来た文字 ($TEXT・$TITLE・$BOARDNAME) が引数の頭に来て「-」「/」で始まるときは、オプションとして読まれないよう実行しない
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

const FILE: &str = "commands.json";
const MAX_COMMANDS: usize = 100;
/// 置き換える値の長さの上限 (文字数)
const MAX_VALUE_CHARS: usize = 2000;
/// 置き換え文字 (長いものから順に照らす。$TEXTU を $TEXT と読み違えないように)
const PLACEHOLDERS: &[&str] = &["BOARDNAME", "NUMBER", "TEXTU", "TEXTE", "TITLE", "TEXT", "LINK", "URL"];

fn enabled_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserCommand {
    pub id: String,
    pub name: String,
    /// "program" (プログラムで開く) か "url" (URL を開く)
    pub kind: String,
    #[serde(default)]
    pub program: String,
    #[serde(default)]
    pub args: String,
    #[serde(default)]
    pub url: String,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
    /// 実行する前に、画面で確認する (既定オン)
    #[serde(default = "enabled_default")]
    pub confirm: bool,
}

/// 置き換える値 (右クリックした所から画面が集める)
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandValues {
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub board_name: Option<String>,
    #[serde(default)]
    pub number: Option<String>,
}

/// この起動中に「参照」で選んだプログラム (登録してよいもの)
static PICKED_PROGRAMS: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn remember_picked_program(path: &str) {
    if let Ok(mut list) = PICKED_PROGRAMS.lock() {
        if !list.iter().any(|p| p.eq_ignore_ascii_case(path)) {
            list.push(path.to_string());
        }
    }
}

fn is_exe_path(path: &str) -> bool {
    let p = std::path::Path::new(path);
    p.is_absolute() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"))
}

fn load() -> Vec<UserCommand> {
    core_store::load_json::<Vec<UserCommand>>(FILE).unwrap_or_default()
}

#[tauri::command]
pub fn load_commands() -> Vec<UserCommand> {
    load()
}

/// 登録を確かめて保存する。プログラムは、すでに登録してあるものか、この起動中に「参照」で選んだ .exe だけ
#[tauri::command]
pub fn save_commands(commands: Vec<UserCommand>) -> Result<(), String> {
    if commands.len() > MAX_COMMANDS {
        return Err(format!("コマンドは {MAX_COMMANDS} 個までです"));
    }
    let saved = load();
    let picked = PICKED_PROGRAMS.lock().map(|l| l.clone()).unwrap_or_default();
    for c in &commands {
        validate_command(c, &saved, &picked)?;
    }
    core_store::save_json(FILE, &commands).map_err(|e| e.to_string())
}

fn validate_command(c: &UserCommand, saved: &[UserCommand], picked: &[String]) -> Result<(), String> {
    if c.id.is_empty() || c.id.len() > 64 || !c.id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_') {
        return Err("コマンドの id が正しくありません".into());
    }
    let name = c.name.trim();
    if name.is_empty() || name.chars().count() > 60 || name.chars().any(|ch| ch.is_control()) {
        return Err("コマンド名は 1〜60 文字で入れてください".into());
    }
    match c.kind.as_str() {
        "program" => {
            if !is_exe_path(&c.program) {
                return Err(format!("「{name}」: プログラムは .exe を「参照」から選んでください"));
            }
            let known = saved.iter().any(|s| s.kind == "program" && s.program.eq_ignore_ascii_case(&c.program))
                || picked.iter().any(|p| p.eq_ignore_ascii_case(&c.program));
            if !known {
                return Err(format!("「{name}」: プログラムは「参照」から選んでください"));
            }
            if c.args.chars().count() > 1000 || c.args.chars().any(|ch| ch.is_control()) {
                return Err(format!("「{name}」: 引数が長すぎるか、使えない文字が入っています"));
            }
        }
        "url" => {
            let u = c.url.trim();
            if !(u.starts_with("http://") || u.starts_with("https://") || u.starts_with('$')) || u.chars().count() > 2000 || u.chars().any(|ch| ch.is_control()) {
                return Err(format!("「{name}」: URL は http:// か https:// で始めてください (置き換え文字だけでも可)"));
            }
        }
        _ => return Err(format!("「{name}」: 種類が正しくありません")),
    }
    Ok(())
}

/// 引数のひな形を区切る (空白で区切り、"…" はひとまとまり。" は取り除く)
fn split_args(template: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    let mut has_token = false;
    for ch in template.chars() {
        match ch {
            '"' => {
                in_quote = !in_quote;
                has_token = true;
            }
            c if c.is_whitespace() && !in_quote => {
                if has_token {
                    out.push(std::mem::take(&mut cur));
                    has_token = false;
                }
            }
            c => {
                cur.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        out.push(cur);
    }
    out
}

/// UTF-8 で URL 用に変換する (英数字と - _ . ~ 以外は %XX)
fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 値から制御文字を除き、長さを切る
fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(MAX_VALUE_CHARS).collect::<String>().trim().to_string()
}

/// 家庭内・自分の PC を指すリンクか (IP アドレスで書かれたものと localhost・.local。名前は引かない)。
/// 判定は画像の取得と同じ決まり (core_fetch::is_public_ip)
fn is_local_link(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else { return true };
    let Some(host) = u.host_str() else { return true };
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => !core_fetch::is_public_ip(ip),
        Err(_) => host.is_empty() || host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local"),
    }
}

fn http_url(s: &str) -> Option<String> {
    let u = reqwest::Url::parse(s.trim()).ok()?;
    matches!(u.scheme(), "http" | "https").then(|| u.to_string())
}

/// 置き換え文字の値。足りないときは理由を返す
fn value_of(name: &str, v: &CommandValues) -> Result<String, String> {
    let need = |o: &Option<String>, what: &str| -> Result<String, String> {
        o.as_deref().map(clean).filter(|s| !s.is_empty()).ok_or_else(|| format!("{what}が無いので実行できません"))
    };
    match name {
        "LINK" => {
            let raw = need(&v.link, "リンク")?;
            let url = http_url(&raw).ok_or_else(|| "リンクが http / https ではないので実行できません".to_string())?;
            // レスに書かれたリンクで、家の中の機器 (ルーターなど) や自分の PC を読ませないように
            if is_local_link(&url) {
                return Err("リンクが家庭内・自分の PC のアドレスを指しているので実行しません".into());
            }
            Ok(url)
        }
        "URL" => {
            let raw = need(&v.url, "スレの URL ")?;
            http_url(&raw).ok_or_else(|| "スレの URL が http / https ではないので実行できません".to_string())
        }
        "TEXT" => need(&v.text, "選んだ文字"),
        "TEXTU" | "TEXTE" => need(&v.text, "選んだ文字").map(|t| percent_encode(&t)),
        "TITLE" => need(&v.title, "スレのタイトル"),
        "BOARDNAME" => need(&v.board_name, "板の名前"),
        "NUMBER" => {
            let n = need(&v.number, "レス番号")?;
            if n.chars().all(|c| c.is_ascii_digit()) { Ok(n) } else { Err("レス番号が正しくありません".into()) }
        }
        _ => Err(format!("知らない置き換え文字です: ${name}")),
    }
}

/// レスやスレから来る (書き込んだ人が決められる) 文字か
fn is_untrusted(name: &str) -> bool {
    matches!(name, "TEXT" | "TITLE" | "BOARDNAME")
}

/// ひな形の置き換え文字を値に置き換える。置き換えた値の中の「$」はもう一度置き換えない。
/// 戻り値の 2 つ目は、頭に来た置き換え文字 (あれば)
fn substitute(template: &str, v: &CommandValues) -> Result<(String, Option<&'static str>), String> {
    let mut out = String::new();
    let mut lead: Option<&'static str> = None;
    let mut rest = template;
    let mut at_start = true;
    while let Some(pos) = rest.find('$') {
        out.push_str(&rest[..pos]);
        if pos > 0 {
            at_start = false;
        }
        let after = &rest[pos + 1..];
        if let Some(name) = PLACEHOLDERS.iter().find(|n| after.starts_with(**n)) {
            if at_start && out.is_empty() {
                lead = Some(name);
            }
            out.push_str(&value_of(name, v)?);
            rest = &after[name.len()..];
        } else {
            out.push('$');
            rest = after;
        }
        at_start = false;
    }
    out.push_str(rest);
    Ok((out, lead))
}

/// 記録に残す文字 (長すぎるものは切る)
fn for_log(s: &str) -> String {
    let t: String = s.chars().filter(|c| !c.is_control()).take(1000).collect();
    if s.chars().count() > 1000 { format!("{t}…") } else { t }
}

/// コマンドを実行する (右クリックで選んだときだけ呼ばれる)。プログラムの場所は保存した登録から読む。
/// 実行したもの・断ったものは、日別ログ (data/eventlog) に残す
#[tauri::command]
pub fn run_command(id: String, values: CommandValues) -> Result<(), String> {
    let cmd = load().into_iter().find(|c| c.id == id && c.enabled).ok_or_else(|| "コマンドが見つかりません".to_string())?;
    let result = run_found_command(&cmd, &values);
    // 渡したリンクは先頭に書く (引数が長くて行の終わりが切れても、何を開いたかが分かるように)
    let link = values.link.as_deref().map(|l| format!(" リンク: {}", for_log(l))).unwrap_or_default();
    let _ = match &result {
        Ok(what) => core_store::append_log(&format!("command: 「{}」{link} / {}", for_log(&cmd.name), for_log(what))),
        Err(e) => core_store::append_log_level("WARN", &format!("command: 「{}」{link} / 実行しませんでした: {}", for_log(&cmd.name), for_log(e))),
    };
    result.map(|_| ())
}

/// 実行して、記録用の説明 (何をどう開いたか) を返す
fn run_found_command(cmd: &UserCommand, values: &CommandValues) -> Result<String, String> {
    match cmd.kind.as_str() {
        "url" => {
            let (u, _) = substitute(cmd.url.trim(), values)?;
            let url = http_url(&u).ok_or_else(|| "置き換えたあとの URL が http / https ではないので開きません".to_string())?;
            crate::open_external_url(url.clone())?;
            Ok(format!("URL を開きました: {url}"))
        }
        "program" => {
            if !is_exe_path(&cmd.program) || !std::path::Path::new(&cmd.program).is_file() {
                return Err(format!("プログラムが見つかりません: {}", cmd.program));
            }
            let args = build_program_args(&cmd.args, values)?;
            crate::restore_original_temp(&mut std::process::Command::new(&cmd.program))
                .args(&args)
                .spawn()
                .map_err(|e| format!("起動できませんでした: {e}"))?;
            Ok(format!("{} を起動しました: {:?}", cmd.program, args))
        }
        _ => Err("種類が正しくありません".into()),
    }
}

fn build_program_args(template: &str, values: &CommandValues) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for t in split_args(template) {
        let (arg, lead) = substitute(&t, values)?;
        // レスやスレから来た文字が引数の頭に来て「-」「/」で始まると、プログラムがオプションとして読むことがある
        if lead.is_some_and(is_untrusted) && (arg.starts_with('-') || arg.starts_with('/')) {
            return Err("選んだ文字やタイトルが「-」か「/」で始まるので、安全のため実行しません".into());
        }
        out.push(arg);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vals() -> CommandValues {
        CommandValues {
            link: Some("https://example.com/a b?x=1&y=2".into()),
            text: Some("ねこ & dog".into()),
            url: Some("https://egg.5ch.io/test/read.cgi/x/123/".into()),
            title: Some("スレタイ".into()),
            board_name: Some("ニュース".into()),
            number: Some("12".into()),
        }
    }

    #[test]
    fn split_keeps_quoted_groups() {
        assert_eq!(split_args(r#""$LINK""#), vec!["$LINK"]);
        assert_eq!(split_args(r#"--fullscreen "$LINK"  --x"#), vec!["--fullscreen", "$LINK", "--x"]);
        assert_eq!(split_args(r#"a "b c" """#), vec!["a", "b c", ""]);
        assert!(split_args("   ").is_empty());
    }

    #[test]
    fn placeholders_are_replaced_once() {
        let (s, lead) = substitute("$LINK", &vals()).unwrap();
        assert_eq!(s, "https://example.com/a%20b?x=1&y=2");
        assert_eq!(lead, Some("LINK"));
        let (s, _) = substitute("https://www.google.com/search?q=$TEXTU", &vals()).unwrap();
        assert_eq!(s, "https://www.google.com/search?q=%E3%81%AD%E3%81%93%20%26%20dog");
        let (s, _) = substitute("$BOARDNAME/$TITLE/$NUMBER/$URL", &vals()).unwrap();
        assert_eq!(s, "ニュース/スレタイ/12/https://egg.5ch.io/test/read.cgi/x/123/");
        // 値の中の $ は置き換えない
        let mut v = vals();
        v.text = Some("$URL".into());
        assert_eq!(substitute("$TEXT", &v).unwrap().0, "$URL");
        // 知らない $ はそのまま
        assert_eq!(substitute("a$b", &v).unwrap().0, "a$b");
    }

    #[test]
    fn missing_or_bad_values_are_refused() {
        let mut v = vals();
        v.link = None;
        assert!(substitute("$LINK", &v).is_err());
        v.link = Some("file:///C:/Windows/system32/calc.exe".into());
        assert!(substitute("$LINK", &v).is_err());
        v.link = Some("javascript:alert(1)".into());
        assert!(substitute("$LINK", &v).is_err());
        v.number = Some("1; calc".into());
        assert!(substitute("$NUMBER", &v).is_err());
    }

    #[test]
    fn local_links_are_not_passed() {
        let mut v = vals();
        for ok in ["http://219.63.92.180:25565/", "http://59.147.5.178:8888/", "http://mudai.duckdns.org:8400", "https://example.com/x"] {
            v.link = Some(ok.into());
            assert!(substitute("$LINK", &v).is_ok(), "{ok} は渡す");
        }
        for ng in ["http://127.0.0.1:8080/", "http://192.168.1.1/", "http://10.0.0.5:8000/", "http://172.20.0.1/", "http://169.254.1.1/",
                   "http://100.64.0.1/", "http://localhost:8080/", "http://nas.local/", "http://[::1]/", "http://[fd00::1]/", "http://0.0.0.0/"] {
            v.link = Some(ng.into());
            assert!(substitute("$LINK", &v).is_err(), "{ng} は渡さない");
        }
    }

    #[test]
    fn untrusted_text_cannot_become_an_option() {
        let mut v = vals();
        v.text = Some("--extraintf=lua".into());
        assert!(build_program_args("$TEXT", &v).is_err());
        v.text = Some("/c calc".into());
        assert!(build_program_args(r#""$TEXT""#, &v).is_err());
        // 頭に置かなければよい (前に固定の文字がある)
        assert_eq!(build_program_args("q=$TEXT", &v).unwrap(), vec!["q=/c calc"]);
        // 利用者が自分で書いたオプションはそのまま
        assert_eq!(build_program_args(r#"--fullscreen "$LINK""#, &vals()).unwrap(), vec!["--fullscreen", "https://example.com/a%20b?x=1&y=2"]);
        // 値に空白や " があっても引数は増えない
        v.text = Some("a\" b \"c".into());
        assert_eq!(build_program_args(r#""$TEXT""#, &v).unwrap(), vec!["a\" b \"c"]);
    }

    #[test]
    fn programs_must_be_picked_exe() {
        let c = |program: &str| UserCommand { id: "c1".into(), name: "VLC で開く".into(), kind: "program".into(), program: program.into(), args: "\"$LINK\"".into(), url: String::new(), enabled: true, confirm: true };
        let picked = vec![r"C:\Program Files\VideoLAN\VLC\vlc.exe".to_string()];
        assert!(validate_command(&c(r"C:\Program Files\VideoLAN\VLC\vlc.exe"), &[], &picked).is_ok());
        assert!(validate_command(&c(r"c:\program files\videolan\vlc\VLC.EXE"), &[], &picked).is_ok());
        assert!(validate_command(&c(r"C:\Windows\System32\cmd.exe"), &[], &picked).is_err());
        assert!(validate_command(&c(r"C:\x\run.bat"), &[], &[r"C:\x\run.bat".into()]).is_err());
        assert!(validate_command(&c("vlc.exe"), &[], &["vlc.exe".into()]).is_err());
        // すでに登録してあるものは、選び直さなくても保存できる (並べ替え・名前の変更など)
        let saved = vec![c(r"D:\tools\mpv.exe")];
        assert!(validate_command(&c(r"D:\tools\mpv.exe"), &saved, &[]).is_ok());
    }

    #[test]
    fn url_commands_must_be_http() {
        let c = |url: &str| UserCommand { id: "u1".into(), name: "検索".into(), kind: "url".into(), program: String::new(), args: String::new(), url: url.into(), enabled: true, confirm: true };
        assert!(validate_command(&c("https://www.google.com/search?q=$TEXTU"), &[], &[]).is_ok());
        assert!(validate_command(&c("$LINK"), &[], &[]).is_ok());
        assert!(validate_command(&c("file:///C:/x"), &[], &[]).is_err());
        assert!(validate_command(&c("javascript:alert(1)"), &[], &[]).is_err());
    }
}
