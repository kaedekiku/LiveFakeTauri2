//! ログイン情報のファイル (twitch-auth.bin / youtube-auth.bin) を消すときの扱い。
//!
//! ログアウトしたのにファイルを消せない (ほかのプログラムが使用中など) と、次に起動したときに読み直して
//! ログインした状態に戻ってしまう。消せなかったときは同じフォルダに「ログアウト済み」の目印を置き、
//! 目印がある間は起動時に読まずに消し直す。目印も置けなかったときは、消せなかったファイルの場所を返す
//! (呼んだ側が利用者に伝える)。目印の中身は空で、ログイン情報は入れない
use std::path::{Path, PathBuf};

/// この PC のログイン情報を消した結果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Removed {
    /// 消えた (もともと無かった場合も)
    Gone,
    /// 消せなかったので、ログアウト済みの目印を置いた (次の起動では読まずに、消し直す)
    Marked,
    /// 消せず、目印も置けなかった (次の起動でログインした状態に戻る)
    Left(PathBuf),
}

/// サービス側 (Twitch / Google) の許可の取り消しの結果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Revoked {
    /// 取り消せた
    Done,
    /// 取り消せたか確かめられなかった (通信できない・エラーの応答)
    Unknown,
    /// 取り消すものが無かった (ログインしていなかった)
    NotNeeded,
}

fn marker_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".loggedout");
    PathBuf::from(name)
}

fn remove_if_exists(path: &Path) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

/// ログイン情報のファイルを消す。消せないときは、ログアウト済みの目印を置く
pub fn remove_or_mark(path: &Path) -> Removed {
    if remove_if_exists(path) {
        let _ = remove_if_exists(&marker_path(path));
        return Removed::Gone;
    }
    match std::fs::write(marker_path(path), b"") {
        Ok(()) => Removed::Marked,
        Err(_) => Removed::Left(path.to_path_buf()),
    }
}

/// 起動時: このログイン情報を読んでよいか。ログアウト済みの目印があれば読まない (ファイルを消し直し、消せたら目印も消す)
pub fn usable_at_start(path: &Path) -> bool {
    let marker = marker_path(path);
    if !marker.exists() {
        return true;
    }
    if remove_if_exists(path) {
        let _ = remove_if_exists(&marker);
    }
    false
}

/// ログインして保存し直したあと: 前のログアウトの目印を消す (残っていると、次の起動で新しいログインまで捨ててしまう)
pub fn clear_mark(path: &Path) -> Result<(), String> {
    if remove_if_exists(&marker_path(path)) {
        Ok(())
    } else {
        Err("前のログアウトの目印を消せなかったため、次回の起動ではログインし直しになります".into())
    }
}

/// ログアウトのあとに画面へ出す文。全部済んだときは空
/// (`service` は "Twitch" / "Google"。済んでいないことだけを、どうすればよいかと合わせて伝える)
pub fn logout_message(service: &str, revoked: Revoked, removed: &Removed) -> String {
    let mut parts: Vec<String> = Vec::new();
    if revoked == Revoked::Unknown {
        parts.push(format!(
            "{service} 側の許可を取り消せたか確かめられませんでした (通信できなかった可能性があります)。許可が残っているか気になるときは、{service} のアカウントの設定から LiveFake の許可を取り消してください。"
        ));
    }
    match removed {
        Removed::Gone => {}
        Removed::Marked => parts.push(
            "この PC に保存したログイン情報のファイルを消せませんでした (使用中の可能性があります)。ログアウト済みの目印を置いたので、次に起動したときは読み込まずに消し直します。".into(),
        ),
        Removed::Left(path) => parts.push(format!(
            "この PC に保存したログイン情報のファイルを消せませんでした。このままだと、次に起動したときにログインした状態に戻ります。LiveFake を閉じてから、次のファイルを消してください: {}",
            path.display()
        )),
    }
    if parts.is_empty() {
        return String::new();
    }
    let done = match (revoked, removed) {
        (Revoked::Unknown, Removed::Gone) => "この PC のログイン情報は消しました。",
        (Revoked::Done, _) => "サービス側の許可は取り消しました。",
        _ => "",
    };
    format!("ログアウトしましたが、済んでいないことがあります。{}{}", parts.join(""), done)
}

/// 保存した設定のファイル (ログイン情報のほか。例: YouTube の OAuth クライアント) を消せなかったときに画面へ出す文。消えたときは None
pub fn left_file_message(what: &str, removed: &Removed) -> Option<String> {
    match removed {
        Removed::Gone => None,
        Removed::Marked => Some(format!(
            "この PC に保存した{what}のファイルを消せませんでした (使用中の可能性があります)。削除済みの目印を置いたので、次に起動したときは読み込まずに消し直します。"
        )),
        Removed::Left(path) => Some(format!(
            "この PC に保存した{what}のファイルを消せませんでした。このままだと、次に起動したときに{what}が戻ります。LiveFake を閉じてから、次のファイルを消してください: {}",
            path.display()
        )),
    }
}

/// 試験用: 決まった応答を返すだけの HTTP の受け口 (127.0.0.1 の空いているポート)。
/// 取り消し・更新の窓口の代わりに使う (配布するビルドには入らない)
#[cfg(test)]
pub mod test_http {
    use std::io::{Read, Write};

    /// `respond(パス) -> (ステータス, 本文)` で応える受け口を立て、その URL の頭 (`http://127.0.0.1:ポート`) を返す
    pub fn serve(respond: fn(&str) -> (u16, &'static str)) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 2048];
                // ヘッダーの終わりまでと、Content-Length の分の本文を読む
                let (mut head_end, mut need) = (None, 0usize);
                loop {
                    let n = stream.read(&mut chunk).unwrap_or(0);
                    if n == 0 { break; }
                    buf.extend_from_slice(&chunk[..n]);
                    if head_end.is_none() {
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            head_end = Some(i + 4);
                            let head = String::from_utf8_lossy(&buf[..i]).to_ascii_lowercase();
                            need = head.lines().find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse().ok())).unwrap_or(0);
                        }
                    }
                    if head_end.is_some_and(|h| buf.len() >= h + need) { break; }
                }
                let text = String::from_utf8_lossy(&buf);
                let path = text.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, body) = respond(&path);
                let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        base
    }

    /// だれも待ち受けていない URL の頭 (つながらない場面)
    pub fn unreachable() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("livefake-authfile-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn removes_file_and_old_marker() {
        let dir = temp_dir("gone");
        let p = dir.join("auth.bin");
        std::fs::write(&p, "x").unwrap();
        std::fs::write(marker_path(&p), "").unwrap();
        assert_eq!(remove_or_mark(&p), Removed::Gone);
        assert!(!p.exists() && !marker_path(&p).exists());
        // もともと無いときも「消えた」
        assert_eq!(remove_or_mark(&p), Removed::Gone);
        assert!(usable_at_start(&p));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 使用中で消せないファイルは、目印を置いて、次の起動で読まずに消し直す
    #[cfg(windows)]
    #[test]
    fn locked_file_is_marked_and_not_read_at_next_start() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = temp_dir("locked");
        let p = dir.join("auth.bin");
        std::fs::write(&p, "dpapi:xxxx").unwrap();
        let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&p).unwrap();
        assert_eq!(remove_or_mark(&p), Removed::Marked);
        assert!(p.exists(), "(前提) 使用中なので消せていない");
        // 使用中のまま起動し直しても、読まない (目印は残す)
        assert!(!usable_at_start(&p));
        assert!(marker_path(&p).exists());
        drop(lock);
        // 使用中でなくなった次の起動: 読まずに消し、目印も片付ける
        assert!(!usable_at_start(&p));
        assert!(!p.exists() && !marker_path(&p).exists());
        // その次の起動は、ふつうに読める状態 (ファイルは無い)
        assert!(usable_at_start(&p));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 目印も置けないときは、消せなかったファイルの場所を返す
    #[cfg(windows)]
    #[test]
    fn when_marker_cannot_be_written_the_path_is_reported() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = temp_dir("left");
        let p = dir.join("auth.bin");
        std::fs::write(&p, "dpapi:xxxx").unwrap();
        std::fs::create_dir_all(marker_path(&p)).unwrap(); // 目印の場所にフォルダがあって書けない
        let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&p).unwrap();
        assert_eq!(remove_or_mark(&p), Removed::Left(p.clone()));
        drop(lock);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_login_clears_the_marker() {
        let dir = temp_dir("clear");
        let p = dir.join("auth.bin");
        std::fs::write(marker_path(&p), "").unwrap();
        std::fs::write(&p, "dpapi:new").unwrap();
        assert!(clear_mark(&p).is_ok());
        assert!(usable_at_start(&p) && p.exists(), "ログインし直したあとの起動では、新しいログイン情報を読める");
        assert!(clear_mark(&p).is_ok(), "目印が無くても成功");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn messages_tell_what_is_not_done() {
        let left = Removed::Left(PathBuf::from(r"C:\x\data\twitch-auth.bin"));
        // 全部済んだら何も出さない
        assert_eq!(logout_message("Twitch", Revoked::Done, &Removed::Gone), "");
        assert_eq!(logout_message("Twitch", Revoked::NotNeeded, &Removed::Gone), "");
        // サービス側だけ失敗
        let m = logout_message("Twitch", Revoked::Unknown, &Removed::Gone);
        assert!(m.contains("Twitch 側の許可") && m.contains("この PC のログイン情報は消しました") && !m.contains("ファイルを消せません"), "{m}");
        // この PC 側だけ失敗 (目印を置けた / 置けなかった)
        let m = logout_message("Google", Revoked::Done, &Removed::Marked);
        assert!(m.contains("目印") && m.contains("サービス側の許可は取り消しました") && !m.contains("確かめられません"), "{m}");
        let m = logout_message("Google", Revoked::Done, &left);
        assert!(m.contains("twitch-auth.bin") && m.contains("ログインした状態に戻ります"), "{m}");
        // 両方失敗
        let m = logout_message("Twitch", Revoked::Unknown, &left);
        assert!(m.contains("Twitch 側の許可") && m.contains("twitch-auth.bin") && !m.contains("消しました") && !m.contains("取り消しました"), "{m}");
        let m = logout_message("Twitch", Revoked::Unknown, &Removed::Marked);
        assert!(m.contains("確かめられません") && m.contains("目印"), "{m}");
        // ログイン情報のほかのファイル (OAuth クライアントなど)
        assert_eq!(left_file_message("クライアントの情報", &Removed::Gone), None);
        assert!(left_file_message("クライアントの情報", &Removed::Marked).unwrap().contains("目印"));
        assert!(left_file_message("クライアントの情報", &left).unwrap().contains("twitch-auth.bin"));
    }
}
