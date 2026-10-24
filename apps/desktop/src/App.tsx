import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type UIEventHandler,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ClipboardList, RefreshCw, Pencil, FilePenLine, Save,
  Star, X, ChevronLeft, ChevronRight, ChevronDown, Ban,
  Image, Film, ExternalLink,
  Subtitles, Volume2, VolumeX, Ear, EarOff, ChevronUp, Search, PanelLeftClose, PanelLeftOpen, Smile,
  Tv, LayoutGrid, Globe,
} from "lucide-react";

type MenuInfo = { topLevelKeys: number; normalizedSample: string };
type ThemeCssFile = { name: string; content: string; strippedHosts: string[]; oversized: boolean };
type UpdateCheckResult = {
  metadataUrl: string;
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releasedAt: string | null;
  downloadPageUrl: string | null;
  currentPlatformKey: string;
  currentPlatformAsset:
    | { key: string; sha256: string; size: number; filename: string }
    | null;
  // latest.json のお知らせのうち、この版に当てはまるもの (文は文字としてだけ出す)
  notice?: { id: string; text: string } | null;
};
// コマンド (設定 > コマンド): 右クリックメニューの「コマンド ▶」に出す、利用者が登録したプログラム・URL。
// 実行は Rust (user_commands.rs) が保存した登録から行う (プログラムの場所は画面から渡さない)
type UserCommand = { id: string; name: string; kind: "program" | "url"; program: string; args: string; url: string; enabled: boolean; confirm: boolean };
// その置き換え文字を使っているか ($TEXT は $TEXTU・$TEXTE と区別する)
const commandUses = (c: UserCommand, name: string) => new RegExp(`\\$${name}(?![A-Z])`).test(c.kind === "program" ? c.args : c.url);
// "1.2.3" 形式のバージョンを比べる (a が新しければ正)
const compareVersions = (a: string, b: string) => {
  const pa = a.replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};
type ThreadListItem = {
  threadKey: string;
  title: string;
  responseCount: number;
  threadUrl: string;
};
type ThreadResponseItem = {
  responseNo: number;
  name: string;
  mail: string;
  dateAndId: string;
  body: string;
};
type BoardEntry = { boardName: string; url: string };
type BoardCategory = { categoryName: string; boards: BoardEntry[] };
type FavoriteBoard = { boardName: string; url: string };
type FavoriteThread = { threadUrl: string; title: string; boardUrl: string };
type FavoritesData = { boards: FavoriteBoard[]; threads: FavoriteThread[] };
type NgMode = "hide" | "hide-images" | "abone";
type NgEntry = { value: string; mode: NgMode; scope?: "global" | "board" | "thread"; scopeUrl?: string };
type NgFilters = { words: (string | NgEntry)[]; ids: (string | NgEntry)[]; names: (string | NgEntry)[]; mails: (string | NgEntry)[]; thread_words: (string | NgEntry)[]; image_words: (string | NgEntry)[]; invisible?: NgInvisibleMode };
// NG「見えない文字を含むレス」の設定 (範囲は全体のみ)
type NgInvisibleMode = "off" | "abone" | "hide";
type NgCategory = "words" | "ids" | "names" | "mails" | "thread_words" | "image_words";
const ngVal = (e: string | NgEntry): string => typeof e === "string" ? e : e.value;
const ngEntryMode = (e: string | NgEntry): NgMode => typeof e === "string" ? "hide" : e.mode;
const ngEntryScope = (e: string | NgEntry): "global" | "board" | "thread" => typeof e === "string" ? "global" : (e.scope ?? "global");
const ngEntryScopeUrl = (e: string | NgEntry): string | undefined => typeof e === "string" ? undefined : e.scopeUrl;
const ngScopeMatches = (entry: string | NgEntry, boardUrl: string, threadUrl: string): boolean => {
  const scope = ngEntryScope(entry);
  if (scope === "global") return true;
  const url = ngEntryScopeUrl(entry);
  if (!url) return true;
  if (scope === "board") return boardUrl === url;
  if (scope === "thread") return threadUrl === url;
  return true;
};
type ThreadTab = {
  threadUrl: string;
  title: string;
  /** このタブ (スレ・Twitch チャンネル) の新着を読み上げない */
  ttsOff?: boolean;
  /** ビュワーの「選んだスレを流す」の対象にする (掲示板のスレだけ)。既定 (未設定) はオン、false でオフ */
  viewerOn?: boolean;
};

const stripHtmlForMatch = (html: string): string =>
  html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

const MIN_BOARD_PANE_PX = 160;
const MIN_THREAD_PANE_PX = 280;
const MIN_RESPONSE_PANE_PX = 360;
const MIN_RESPONSE_BODY_PX = 180;
const SPLITTER_PX = 6;
const DEFAULT_BOARD_PANE_PX = 220;
const DEFAULT_THREAD_PANE_PX = 420;
const DEFAULT_RESPONSE_TOP_RATIO = 42;
const MIN_NEW_ARRIVAL_PX = 80;
const MAX_NEW_ARRIVAL_PX = 420;
const DEFAULT_NEW_ARRIVAL_PX = 150;
const MIN_COMPOSE_PANEL_PX = 120;
const MAX_COMPOSE_PANEL_PX = 800;
const DEFAULT_COMPOSE_PANEL_PX = 260;
const MIN_COL_WIDTH = 16;
const DEFAULT_COL_WIDTHS: Record<string, number> = {
  fetched: 18,
  id: 36,
  res: 42,
  read: 36,
  unread: 36,
  lastFetch: 120,
  speed: 54,
};
const COL_RESIZE_HANDLE_PX = 5;
const LANDING_PAGE_URL = "";
const GITHUB_RELEASE_URL = "https://github.com/kaedekiku/LiveFakeTauri2";
const MAX_SEARCH_HISTORY = 20;
const MENU_EDGE_PADDING = 8;

// --- File-based persistence helpers (Portable JSON via save_generic_json IPC) ---
const saveToFile = (filename: string, data: unknown) => {
  if (isTauriRuntime()) {
    invoke("save_generic_json", { filename, data }).catch(() => {});
  }
};
const loadFromFile = async <T,>(filename: string): Promise<T | null> => {
  if (!isTauriRuntime()) return null;
  try {
    const v = await invoke<T | null>("load_generic_json", { filename });
    return v;
  } catch { return null; }
};

type ResizeDragState =
  | { mode: "board-thread"; startX: number; startBoardPx: number; startThreadPx: number }
  | { mode: "thread-response"; startX: number; startBoardPx: number; startThreadPx: number }
  | { mode: "response-rows"; startY: number; startThreadPx: number; responseLayoutHeight: number }
  | { mode: "col-resize"; colKey: string; startX: number; startWidth: number; reverse: boolean }
  | { mode: "new-arrival-resize"; startY: number; startHeight: number }
  | { mode: "compose-resize"; startY: number; startHeight: number };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
// 右クリックメニューをカーソルの隣に置く。表示してから本当の大きさを測り、下に入ればカーソルの右下、
// 入らなければカーソルの上 (メニューの下の端をカーソルに)、右に入らなければカーソルの左に置く。
// どちらにも入らないほど大きいときだけ画面の中へ寄せる。メニューの ref から呼ぶ (x・y は右クリックした所)
const placeMenuNearCursor = (el: HTMLElement | null, x: number, y: number) => {
  if (!el) return;
  // 画面の端の近くに置いたままだと、右の余白が足りずに幅が縮んだ大きさを測ってしまうので、左上に置いてから測る
  el.style.left = "0px";
  el.style.top = "0px";
  const r = el.getBoundingClientRect();
  const pad = MENU_EDGE_PADDING;
  const fit = (pos: number, size: number, limit: number) => {
    if (pos + size <= limit - pad) return pos;
    if (pos - size >= pad) return pos - size;
    return clamp(limit - size - pad, pad, Math.max(pad, limit - size - pad));
  };
  el.style.left = `${fit(x, r.width, window.innerWidth)}px`;
  el.style.top = `${fit(y, r.height, window.innerHeight)}px`;
};
const isTauriRuntime = () =>
  typeof window !== "undefined" && Boolean((globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
type SiteType = "fiveCh" | "shitaraba" | "jpnkn" | "twitch" | "youtube";
const DEFAULT_BBSMENU_URL = "https://menu.5ch.io/bbsmenu.json";
const DEFAULT_SHITARABA_HOST = "jbbs.shitaraba.net";
const DEFAULT_JPNKN_HOST = "bbs.jpnkn.com";
const urlHostname = (url: string): string | null => {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
};
// ホスト名の完全一致/末尾一致で判定する (部分一致だと bbs.jpnkn.com.evil.example のような
// 偽装ドメインも誤って本家と判定してしまうため)
const detectSiteType = (url: string): SiteType => {
  const host = urlHostname(url);
  if (host === "jbbs.shitaraba.net" || host === "jbbs.livedoor.jp") return "shitaraba";
  if (host === "bbs.jpnkn.com") return "jpnkn";
  if (host && TWITCH_HOSTS.has(host)) return "twitch";
  if (isYoutubeUrl(url)) return "youtube";
  return "fiveCh";
};
// ----- Twitch チャット (匿名・読み取り専用) -----
// Twitch のチャンネルは、タブ URL を https://www.twitch.tv/<チャンネル名> に揃えて「スレ」と同じように開く。
// チャンネル名は Twitch の規則 (英小文字・数字・_、1〜25文字) に合うものだけを受け付ける (Rust 側でも同じ検査をする)
const TWITCH_HOSTS = new Set(["twitch.tv", "www.twitch.tv", "m.twitch.tv"]);
const twitchChannelFromUrl = (url: string): string | null => {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  if (!TWITCH_HOSTS.has(u.hostname.toLowerCase())) return null;
  const name = (u.pathname.split("/")[1] ?? "").toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(name) ? name : null;
};
// アドレスバーの入力 ("twitch.tv/name" のように https:// が無い形も受け付ける)
const twitchChannelFromInput = (raw: string): string | null => {
  const v = raw.trim();
  return twitchChannelFromUrl(/^https?:\/\//i.test(v) ? v : `https://${v}`);
};
const isTwitchUrl = (url: string) => twitchChannelFromUrl(url) !== null;
const twitchTabUrl = (channel: string) => `https://www.twitch.tv/${channel}`;
// ----- YouTube ライブ配信のチャット (読み取り専用) -----
// 配信は、タブ URL を https://www.youtube.com/watch?v=<動画ID> に揃えて「スレ」と同じように開く。
// 開けるのはライブ配信の URL (watch?v= / live/ / youtu.be/) だけ。動画 ID は Rust 側でも確かめる
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const YT_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const youtubeVideoFromUrl = (url: string): string | null => {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;
  const segs = u.pathname.split("/").filter(Boolean);
  const id = host === "youtu.be" ? segs[0] : segs[0] === "watch" ? u.searchParams.get("v") : segs[0] === "live" ? segs[1] : null;
  return id && YT_VIDEO_ID_RE.test(id) ? id : null;
};
// アドレスバーの入力 ("youtube.com/live/ID" のように https:// が無い形も受け付ける)
const youtubeVideoFromInput = (raw: string): string | null => {
  const v = raw.trim();
  return youtubeVideoFromUrl(/^https?:\/\//i.test(v) ? v : `https://${v}`);
};
// YouTube の URL だが、ライブ配信の URL ではないもの (チャンネルのページなど)
const isYoutubeNonVideoInput = (raw: string): boolean => {
  const v = raw.trim();
  const host = urlHostname(/^https?:\/\//i.test(v) ? v : `https://${v}`);
  return !!host && YOUTUBE_HOSTS.has(host) && youtubeVideoFromInput(v) === null;
};
const isYoutubeUrl = (url: string) => youtubeVideoFromUrl(url) !== null;
const youtubeTabUrl = (video: string) => `https://www.youtube.com/watch?v=${video}`;
// Twitch・YouTube のチャットのタブ (流れていくだけなので、取得・巡回・栞・書き込みはしない)
const isChatUrl = (url: string) => isTwitchUrl(url) || isYoutubeUrl(url);
// YouTube の絵文字の画像 (YouTube の画像配信サーバーのものだけ使う。Rust 側でも確かめている)
const YT_EMOJI_URL_RE = /^https:\/\/yt[34]\.ggpht\.com\/[A-Za-z0-9_\-=/.~]{1,500}$/;
// YouTube の投稿者の立場の色 (名前の色に使う。配信者=黄・モデレーター=青・メンバー=緑。それ以外は色を付けない)
const youtubeRoleColor = (m: { owner?: unknown; moderator?: unknown; member?: unknown }) =>
  m.owner === true ? "#c99a00" : m.moderator === true ? "#5e84f1" : m.member === true ? "#2ba640" : "";
// 発言 ID (英数字と一部の記号)。OBS 表示から消すときの目印に使う
const YT_MESSAGE_ID_RE = /^[A-Za-z0-9_\-.=%:+/]{1,256}$/;
const YT_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
// 1つの Twitch タブに残すチャットの件数 (古いものから捨てる)
const TWITCH_MAX_ROWS = 1000;
// 受信したチャットをまとめて画面に反映する間隔 (1件ずつ反映すると流れが速いときに重くなる)
const TWITCH_FLUSH_MS = 250;
// 新着ペイン・字幕の待ち行列に残す Twitch のチャットの上限 (既定値。設定 > Twitch で変更可)。
// 1件ずつ数秒かけて表示するので、多く残すと流れの速いチャンネルでは表示が分単位で遅れていく。
// 新しいものを優先して古いものから捨てる
const TWITCH_MAX_QUEUED_ARRIVALS_DEFAULT = 10;
// 読み上げが溜まっているとき、これ以上は Twitch のチャットを読み上げに積まない (既定値。設定 > Twitch で変更可)
const TWITCH_MAX_TTS_BACKLOG_DEFAULT = 10;
const TWITCH_LIMIT_MIN = 1;
const TWITCH_LIMIT_MAX = 50;
const clampTwitchLimit = (v: number) => Math.max(TWITCH_LIMIT_MIN, Math.min(TWITCH_LIMIT_MAX, Math.round(v) || TWITCH_LIMIT_MIN));
// 5ch はレス1000で埋まり、1001番はサーバーが付ける「このスレッドは1000を超えました」の定型文。
// 新着ペイン・字幕にはスレが埋まったことが分かるよう1001番まで流し、読み上げは1000番まで。
// したらば・JPNKN は板によって1000を超えて書き込めるため、番号では除外しない
const showsArrivalResNo = (url: string, no: number) => detectSiteType(url) !== "fiveCh" || no <= 1001;
const speaksResNo = (url: string, no: number) => detectSiteType(url) !== "fiveCh" || no <= 1000;
// レス本文中のリンクが自サイト(5ch/したらば/JPNKN)の板・スレURLかどうかを、
// ホスト名の完全一致/末尾一致で厳密に判定する。クリック時に「内部の板として開く」か
// 「外部ブラウザで開く」かを振り分けるのに使う
const isSameSiteBoardUrl = (url: string): boolean => {
  const host = urlHostname(url);
  if (!host) return false;
  return (
    host === "5ch.io" || host.endsWith(".5ch.io") ||
    host === "5ch.net" || host.endsWith(".5ch.net") ||
    host === "2ch.net" || host.endsWith(".2ch.net") ||
    host === "jbbs.shitaraba.net" || host === "jbbs.livedoor.jp" ||
    host === "bbs.jpnkn.com"
  );
};
// タブの左端の色の線に使うクラス (site-5ch / site-shitaraba / site-jpnkn …)
const siteClassOf = (url: string) => {
  const site = detectSiteType(url);
  return site === "fiveCh" ? "site-5ch" : `site-${site}`;
};
const isTypingTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return target.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
};

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#44;": ",",
  "&nbsp;": "\u00A0",
};
// Unicode の範囲外 (0x10FFFF 超) を String.fromCodePoint に渡すと例外になり、描画中だと
// 画面全体が落ちるため、範囲外の文字参照は変換せず元の文字列のまま残す
const isValidCodePoint = (cp: number) => Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff;
const decodeHtmlEntities = (s: string) =>
  s
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39|#44);/g, (m) => ENTITY_MAP[m] ?? m)
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const cp = Number.parseInt(dec, 10);
      return isValidCodePoint(cp) ? String.fromCodePoint(cp) : _m;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return isValidCodePoint(cp) ? String.fromCodePoint(cp) : _m;
    });
// NG「見えない文字を含むレス」の対象。幅ゼロの空白・単語結合子・BOM、
// 文字の向きを変える制御文字 (LRM/RLM・埋め込み/上書き・分離)、空白に見えるハングルの埋め文字。
// U+200D (合成絵文字の接合子) と U+FE00〜FE0F (異体字セレクタ) は絵文字に普通に使われるので対象にしない
const INVISIBLE_CHAR_RE = /[\u200B\u200C\u2060\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069\u115F\u1160\u3164\uFFA0]/;
// 判定用: 数字の文字参照 (&#8203; / &#x200B;) だけを文字に戻す。dat は Shift_JIS / EUC-JP のため、
// これらの文字は必ず文字参照の形で届く。&amp; は戻さない (「&#8203;」という書き方を説明しているだけの
// 文章 = &amp;#8203; を見えない文字と誤判定しないため)。範囲外の値は戻さず元のまま残す
const decodeNumericCharRefs = (s: string) =>
  s.indexOf("&#") < 0
    ? s
    : s.replace(/&#x([0-9a-fA-F]{1,6});|&#(\d{1,7});/g, (m: string, hex: string | undefined, dec: string | undefined) => {
        const cp = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec ?? "", 10);
        return isValidCodePoint(cp) ? String.fromCodePoint(cp) : m;
      });
const hasInvisibleChar = (s: string) => INVISIBLE_CHAR_RE.test(decodeNumericCharRefs(s));
// 空文字や不明な値 (古い設定ファイル・手で書き換えたファイル) は "off" として扱う
const normalizeInvisibleMode = (v: unknown): NgInvisibleMode => (v === "abone" || v === "hide" ? v : "off");
// 読み上げの前置き: 掲示板は「レスN番さん」「したらばN番さん」「ジャパンくんN番さん」、
// Twitch・YouTube は「名前さん」(名前が無ければ前置きなし)
const speakPrefix = (site: SiteType, no: number, name: string): string => {
  if (site === "twitch" || site === "youtube") {
    const n = decodeHtmlEntities(name.replace(/<[^>]*>/g, "")).trim();
    return n ? `${n}さん` : "";
  }
  return site === "shitaraba" ? `したらば${no}番さん`
    : site === "jpnkn" ? `ジャパンくん${no}番さん`
    : `レス${no}番さん`;
};
// ----- OBS 表示 (ブラウザソース) の見た目 -----
// 既定値は TchViewer と同じ。値の形式は表示側 (overlay.html) でも厳しく確かめる
type OverlayBoardStyle = { fontSize: number; textColor: string; nameColor: string; idColor: string; bgColor: string; bgOpacity: number; showSite: boolean; showNo: boolean; showName: boolean; showId: boolean };
type OverlayTwitchStyle = { fontSize: number; textColor: string; nameColor: string; bgColor: string; bgOpacity: number; showSite: boolean; showName: boolean; showBadges: boolean; useUserColor: boolean; fixNameContrast: boolean; emoteSize: number; giantEmoteSize: number; badgeSize: number };
type OverlayAppearance = { maxItems: number; fadeSeconds: number; newestOnTop: boolean; gap: number; outlineWidth: number; outlineColor: string; board: OverlayBoardStyle; twitch: OverlayTwitchStyle };
const DEFAULT_OVERLAY_APPEARANCE: OverlayAppearance = {
  maxItems: 15, fadeSeconds: 0, newestOnTop: false, gap: 6, outlineWidth: 0, outlineColor: "#000000",
  board: { fontSize: 22, textColor: "#ffffff", nameColor: "#ffffff", idColor: "#d0d0d0", bgColor: "#000000", bgOpacity: 0.55, showSite: true, showNo: true, showName: true, showId: true },
  twitch: { fontSize: 22, textColor: "#ffffff", nameColor: "#bf94ff", bgColor: "#000000", bgOpacity: 0.55, showSite: true, showName: true, showBadges: true, useUserColor: true, fixNameContrast: true, emoteSize: 32, giantEmoteSize: 112, badgeSize: 18 },
};
const OVERLAY_PORT_DEFAULT = 11290;
// OBS 表示のレイアウト (TchViewer と同じ考え方)。名前ごとに見た目と追加 CSS を持ち、OBS 側は ?layout=名前 で使い分ける
const OVERLAY_DEFAULT_LAYOUT = "標準";
type OverlayLayoutData = { appearance: OverlayAppearance; css: string };
const OVERLAY_CSS_MAX_CHARS = 200000;
// レイアウト名として使えるか (Rust 側と同じ規則。URL の ?layout= に入るので紛らわしい文字は不可)
const overlayLayoutNameError = (name: string, existing: string[]): string | null => {
  const n = Array.from(name).length;
  if (n === 0 || n > 40) return "レイアウト名は1〜40文字にしてください";
  if (name.trim() !== name || name.startsWith(".") || name.endsWith(".")) return "レイアウト名の前後に空白やピリオドは使えません";
  if (/[\u0000-\u001f\u007f\\/:*?"<>|%#&]/.test(name)) return "レイアウト名に \\ / : * ? \" < > | % # & は使えません";
  if (existing.includes(name)) return "同じ名前のレイアウトがあります";
  return null;
};
const sanitizeOverlayAppearance = (v: unknown): OverlayAppearance => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const num = (x: unknown, d: number, lo: number, hi: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
  const col = (x: unknown, d: string) => (typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x) ? x : d);
  const bool = (x: unknown, d: boolean) => (typeof x === "boolean" ? x : d);
  const b = (o.board && typeof o.board === "object" ? o.board : {}) as Record<string, unknown>;
  const t = (o.twitch && typeof o.twitch === "object" ? o.twitch : {}) as Record<string, unknown>;
  const D = DEFAULT_OVERLAY_APPEARANCE;
  return {
    maxItems: num(o.maxItems, D.maxItems, 1, 200), fadeSeconds: num(o.fadeSeconds, D.fadeSeconds, 0, 3600),
    newestOnTop: bool(o.newestOnTop, D.newestOnTop), gap: num(o.gap, D.gap, 0, 60),
    outlineWidth: num(o.outlineWidth, D.outlineWidth, 0, 8), outlineColor: col(o.outlineColor, D.outlineColor),
    board: {
      fontSize: num(b.fontSize, D.board.fontSize, 8, 120), textColor: col(b.textColor, D.board.textColor), nameColor: col(b.nameColor, D.board.nameColor),
      idColor: col(b.idColor, D.board.idColor), bgColor: col(b.bgColor, D.board.bgColor), bgOpacity: num(b.bgOpacity, D.board.bgOpacity, 0, 1),
      showSite: bool(b.showSite, true), showNo: bool(b.showNo, true), showName: bool(b.showName, true), showId: bool(b.showId, true),
    },
    twitch: {
      fontSize: num(t.fontSize, D.twitch.fontSize, 8, 120), textColor: col(t.textColor, D.twitch.textColor), nameColor: col(t.nameColor, D.twitch.nameColor),
      bgColor: col(t.bgColor, D.twitch.bgColor), bgOpacity: num(t.bgOpacity, D.twitch.bgOpacity, 0, 1),
      showSite: bool(t.showSite, true), showName: bool(t.showName, true), showBadges: bool(t.showBadges, true), useUserColor: bool(t.useUserColor, true), fixNameContrast: bool(t.fixNameContrast, true),
      emoteSize: num(t.emoteSize, D.twitch.emoteSize, 8, 200), giantEmoteSize: num(t.giantEmoteSize, D.twitch.giantEmoteSize, 16, 600), badgeSize: num(t.badgeSize, D.twitch.badgeSize, 8, 120),
    },
  };
};
// ----- Twitch のイベント (TchViewer と同じ。ログインなしで分かるものだけ) -----
// 種類, 表示名, 既定の読み上げる文 ({name} {months} {count} {bits} {viewers} {recipient} {reward} {message})
const TWITCH_EVENT_KINDS: { kind: string; label: string; template: string }[] = [
  { kind: "sub", label: "サブスク", template: "{name}さんがサブスクしました {message}" },
  { kind: "resub", label: "継続サブスク", template: "{name}さんがサブスクしました（{months}か月目） {message}" },
  { kind: "subgift", label: "サブスクギフト", template: "{name}さんが{recipient}さんにサブスクをギフト" },
  { kind: "submysterygift", label: "まとめてギフト", template: "{name}さんがサブスクを{count}個ギフト" },
  { kind: "giftpaidupgrade", label: "ギフトの継続", template: "{name}さんがギフトのサブスクを継続" },
  { kind: "bits", label: "ビッツ", template: "{name}さんが{bits}ビッツ {message}" },
  { kind: "raid", label: "レイド", template: "{name}さんが{viewers}人でレイド" },
  { kind: "watchstreak", label: "連続視聴", template: "{name}さんが{count}回連続視聴 {message}" },
  { kind: "points", label: "チャンネルポイント", template: "{name}さんが「{reward}」を引き換え {message}" },
  { kind: "follow", label: "フォロー", template: "{name}さんがフォロー" },
  { kind: "announcement", label: "アナウンス", template: "{message}" },
];
// 既定で読み上げない種類 (TchViewer と同じ。フォローは数が多くなりやすいため)
const TWITCH_EVENT_SPEAK_OFF_BY_DEFAULT = new Set(["follow"]);
type TwitchEventSetting = { show: boolean; speak: boolean; template: string };
type TwitchEventData = { kind: string; months: number; count: number; bits: number; viewers: number; recipient: string; reward: string };
const TWITCH_EVENT_TEMPLATE_MAX = 200;
const defaultTwitchEventSettings = (): Record<string, TwitchEventSetting> =>
  Object.fromEntries(TWITCH_EVENT_KINDS.map((k) => [k.kind, { show: true, speak: !TWITCH_EVENT_SPEAK_OFF_BY_DEFAULT.has(k.kind), template: k.template }]));
const sanitizeTwitchEventSettings = (v: unknown): Record<string, TwitchEventSetting> => {
  const out = defaultTwitchEventSettings();
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  for (const k of TWITCH_EVENT_KINDS) {
    const e = (o[k.kind] && typeof o[k.kind] === "object" ? o[k.kind] : {}) as Partial<Record<keyof TwitchEventSetting, unknown>>;
    out[k.kind] = {
      show: typeof e.show === "boolean" ? e.show : true,
      speak: typeof e.speak === "boolean" ? e.speak : !TWITCH_EVENT_SPEAK_OFF_BY_DEFAULT.has(k.kind),
      template: typeof e.template === "string" && e.template.trim() ? e.template.slice(0, TWITCH_EVENT_TEMPLATE_MAX) : k.template,
    };
  }
  return out;
};
// 読み上げる文・要約を作る (テンプレートに差し込み、空白を詰める)
const renderTwitchEvent = (ev: TwitchEventData, template: string, name: string, message: string) =>
  template
    .split("{name}").join(name)
    .split("{months}").join(String(ev.months))
    .split("{count}").join(String(ev.count))
    .split("{bits}").join(String(ev.bits))
    .split("{viewers}").join(String(ev.viewers))
    .split("{recipient}").join(ev.recipient || "誰か")
    .split("{reward}").join(ev.reward || "チャンネルポイント報酬")
    .split("{message}").join(message)
    .split(/\s+/).filter(Boolean).join(" ");
// 公式 API (YouTube Data API) の呼ぶ間隔 (秒)。1回 5 クォータ・1日 10,000 クォータが既定の上限
const YOUTUBE_API_INTERVAL_DEFAULT = 10;
const YOUTUBE_API_INTERVAL_MIN = 5;
const YOUTUBE_API_INTERVAL_MAX = 120;
const YOUTUBE_API_DAILY_QUOTA = 10000;
const YOUTUBE_DAILY_QUOTA_MAX = 10000000;
const YOUTUBE_TARGET_HOURS_DEFAULT = 6;
const YOUTUBE_TARGET_HOURS_MAX = 48;
const YOUTUBE_WRITE_RESERVE_DEFAULT = 20;
const TAB_WIDTH_BOARD_DEFAULT = 140;
const TAB_WIDTH_THREAD_DEFAULT = 180;
const TAB_WIDTH_MIN = 60;
const TAB_WIDTH_MAX = 800;
const YOUTUBE_WRITE_RESERVE_MAX = 200;
const YOUTUBE_INSERT_COST = 20;
/** "youtube-quota" の中身を確かめて読む */
const parseYoutubeQuota = (v: unknown) => {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const num = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k] as number) ? Math.max(0, o[k] as number) : 0);
  return {
    day: typeof o.day === "string" ? o.day.slice(0, 10) : "",
    used: num("used"), limit: num("limit"), reserve: num("reserve"), active: num("active"), targetHours: num("targetHours"),
    targetEnd: typeof o.targetEnd === "number" && Number.isFinite(o.targetEnd) ? o.targetEnd : null,
    intervalSecs: num("intervalSecs"), reachable: o.reachable !== false, lastsSecs: num("lastsSecs"), untilResetSecs: num("untilResetSecs"),
  };
};
/** 秒 → 「約N時間M分」 */
const formatAboutDuration = (secs: number): string => {
  const m = Math.max(0, Math.floor(secs / 60));
  if (m < 60) return `約${m}分`;
  return `約${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}`;
};
// 同時に受信できる配信の数 (Rust 側と同じ)
const YOUTUBE_MAX_VIDEOS = 10;
// ----- チャットの書き込み欄の絵文字の一覧 (Unicode。Windows の絵文字パネル Win+. も使える) -----
const CHAT_EMOJI_GROUPS: { label: string; list: string[] }[] = [
  { label: "顔", list: ["😀", "😁", "😂", "🤣", "😊", "😇", "🙂", "😉", "😍", "🥰", "😘", "😋", "😛", "😜", "🤪", "🤔", "🤨", "😐", "😑", "😶", "🙄", "😏", "😮", "😲", "😳", "🥺", "😢", "😭", "😤", "😡", "🤯", "😱", "😨", "😰", "😴", "🤤", "😵", "🥳", "😎", "🤓", "😈", "💀", "🤡", "👻", "👀"] },
  { label: "手", list: ["👍", "👎", "👏", "🙌", "🙏", "👋", "🤝", "✌️", "🤞", "👌", "🤌", "👉", "👈", "☝️", "💪", "🫶"] },
  { label: "記号", list: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💕", "💖", "💔", "✨", "⭐", "🌟", "🔥", "💯", "💢", "💤", "💦", "‼️", "⁉️", "❓", "❗", "⭕", "❌", "✅", "🎉", "🎊", "🎵", "🎶"] },
  { label: "その他", list: ["🍣", "🍜", "🍺", "🍻", "☕", "🍰", "🍙", "🎮", "🏆", "⚽", "⚾", "🐱", "🐶", "🐸", "🦀", "🌸", "🌈", "☀️", "🌙", "⚡", "💩", "🍀", "🎂", "📢"] },
];
// ----- YouTube のイベント (スーパーチャット・メンバー加入など。表示と読み上げだけで、お金のやり取りはしない) -----
const YOUTUBE_EVENT_KINDS: { kind: string; label: string; template: string }[] = [
  { kind: "superchat", label: "スーパーチャット", template: "{name}さんがスーパーチャット（{amount}） {message}" },
  { kind: "supersticker", label: "スーパーステッカー", template: "{name}さんがスーパーステッカー（{amount}）" },
  { kind: "member", label: "メンバー加入", template: "{name}さんがメンバーになりました" },
  { kind: "milestone", label: "メンバー継続", template: "{name}さんがメンバー{months}か月 {message}" },
  { kind: "gift", label: "メンバーシップのギフト", template: "{name}さんがメンバーシップを{count}個ギフト" },
  { kind: "giftreceived", label: "ギフトの受け取り", template: "{name}さんがメンバーシップを受け取りました" },
  { kind: "jewels", label: "ジュエルのギフト", template: "{name}さんが「{item}」を贈りました" },
];
// 既定で読み上げない種類 (ギフトの受け取りは、まとめてギフトされると数が多くなるため)
const YOUTUBE_EVENT_SPEAK_OFF_BY_DEFAULT = new Set(["giftreceived"]);
type YoutubeEventData = { kind: string; amount: string; months: number; count: number; level: string; item: string };
const defaultYoutubeEventSettings = (): Record<string, TwitchEventSetting> =>
  Object.fromEntries(YOUTUBE_EVENT_KINDS.map((k) => [k.kind, { show: true, speak: !YOUTUBE_EVENT_SPEAK_OFF_BY_DEFAULT.has(k.kind), template: k.template }]));
const sanitizeYoutubeEventSettings = (v: unknown): Record<string, TwitchEventSetting> => {
  const out = defaultYoutubeEventSettings();
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  for (const k of YOUTUBE_EVENT_KINDS) {
    const e = (o[k.kind] && typeof o[k.kind] === "object" ? o[k.kind] : {}) as Partial<Record<keyof TwitchEventSetting, unknown>>;
    out[k.kind] = {
      show: typeof e.show === "boolean" ? e.show : true,
      speak: typeof e.speak === "boolean" ? e.speak : !YOUTUBE_EVENT_SPEAK_OFF_BY_DEFAULT.has(k.kind),
      template: typeof e.template === "string" && e.template.trim() ? e.template.slice(0, TWITCH_EVENT_TEMPLATE_MAX) : k.template,
    };
  }
  return out;
};
const renderYoutubeEvent = (ev: YoutubeEventData, template: string, name: string, message: string) =>
  template
    .split("{name}").join(name)
    .split("{amount}").join(ev.amount || "")
    .split("{months}").join(String(ev.months || 0))
    .split("{count}").join(String(ev.count || 0))
    .split("{level}").join(ev.level || "")
    .split("{item}").join(ev.item || "")
    .split("{message}").join(message)
    .split(/\s+/).filter(Boolean).join(" ");
// YouTube の読み上げ用: 絵文字の名前 (:_kusa: など) は読まない
const youtubeSpeechText = (text: string) => text.replace(/:[A-Za-z0-9_\-]{1,64}:/g, " ").replace(/\s{2,}/g, " ").trim();
// ビッツの応援文から「Cheer100」のような応援スタンプの文字を除く (読み上げ用)
const stripCheermotes = (text: string) =>
  text.split(/\s+/).filter((w) => !/^[A-Za-z]+\d+$/.test(w)).join(" ");
// Twitch のバッジ (画像アドレスは Twitch の画像配信サーバーのものだけ使う。Rust 側でも確かめている)
type TwitchBadge = { title: string; url: string };
const TWITCH_BADGE_URL_RE = /^https:\/\/static-cdn\.jtvnw\.net\/badges\/v1\/[0-9a-f-]{1,64}$/i;
const sanitizeTwitchBadges = (v: unknown): TwitchBadge[] =>
  Array.isArray(v)
    ? v.filter((b): b is TwitchBadge => !!b && typeof b === "object" && typeof (b as TwitchBadge).url === "string" && TWITCH_BADGE_URL_RE.test((b as TwitchBadge).url))
      .slice(0, 10).map((b) => ({ title: typeof b.title === "string" ? b.title.slice(0, 100) : "", url: b.url }))
    : [];
// Twitch のスタンプ (位置は本文のコードポイント単位。ID は英数字と _ - だけ通す)
// giant: このスタンプだけ巨大表示する (掲示板などで「BIG」+スタンプ名と書かれたもの)
// url: YouTube のチャンネル独自の絵文字の画像 (YouTube も同じ形で扱う。Twitch は ID から画像アドレスを作るので無し)
type TwitchEmote = { id: string; start: number; end: number; giant?: boolean; url?: string };
const TWITCH_EMOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const sanitizeTwitchEmotes = (v: unknown, text: string): TwitchEmote[] => {
  if (!Array.isArray(v)) return [];
  const n = Array.from(text).length;
  const out: TwitchEmote[] = [];
  let last = -1;
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const { id, start, end } = e as Record<string, unknown>;
    if (typeof id !== "string" || !TWITCH_EMOTE_ID_RE.test(id) || typeof start !== "number" || typeof end !== "number") continue;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start <= last || start > end || end >= n) continue;
    out.push({ id, start, end });
    last = end;
    if (out.length >= 200) break;
  }
  return out;
};
// YouTube の絵文字: 位置は本文のコードポイント単位。画像は YouTube の画像配信サーバーのものだけ。
// ID は名前から作る (同じ絵文字を読む個数を数えるのに使う)
const sanitizeYoutubeEmojis = (v: unknown, text: string): TwitchEmote[] => {
  if (!Array.isArray(v)) return [];
  const n = Array.from(text).length;
  const out: TwitchEmote[] = [];
  let last = -1;
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const { start, end, name, url } = e as Record<string, unknown>;
    if (typeof url !== "string" || !YT_EMOJI_URL_RE.test(url) || typeof start !== "number" || typeof end !== "number") continue;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start <= last || start > end || end >= n) continue;
    const id = `yt_${(typeof name === "string" ? name : "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}` || "yt";
    out.push({ id, start, end, url });
    last = end;
    if (out.length >= 200) break;
  }
  return out;
};
const twitchEmoteUrl = (id: string, giant: boolean, dark: boolean) =>
  `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/${dark ? "dark" : "light"}/${giant ? "3.0" : "2.0"}`;
// 同じスタンプを読む個数の上限 (設定できるのは 1〜この値)
const TWITCH_EMOTE_MAX_LIMIT = 10;
// 読み上げ用: スタンプは名前のまま読む (棒読みちゃんの教育などで読み替えられる)。同じスタンプは max 個まで、mode が none なら全部除く
const twitchSpeechText = (text: string, emotes: TwitchEmote[], mode: "name" | "none", max: number) => {
  if (emotes.length === 0) return text;
  const limit = mode === "none" ? 0 : Math.max(1, Math.min(TWITCH_EMOTE_MAX_LIMIT, max));
  const seen = new Map<string, number>();
  const drop = emotes.filter((e) => {
    const n = (seen.get(e.id) ?? 0) + 1;
    seen.set(e.id, n);
    return n > limit;
  });
  const cps = Array.from(text);
  for (const e of [...drop].reverse()) cps.splice(e.start, e.end - e.start + 1);
  return cps.join("").replace(/\s{2,}/g, " ").trim();
};
// Twitch タブのレス表示: 描画済み (エスケープ済み) の HTML の中のスタンプ名を画像に置き換える。
// リンクの中とタグの中は触らない。巨大化したスタンプは最後のスタンプ
const injectTwitchEmotes = (html: string, emotes: { id: string; name: string; giant?: boolean; url?: string }[], giant: boolean, dark: boolean): string => {
  if (emotes.length === 0) return html;
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const byName = new Map(emotes.map((e) => [esc(e.name), { id: e.id, giant: e.giant === true, url: e.url }]));
  return injectEmoteTokens(html, (tok) => byName.get(tok), giant, dark);
};
// スタンプ名 (エスケープ済みの語) → ID を引く関数で、HTML のテキスト部分の語を画像に置き換える
const injectEmoteTokens = (html: string, lookup: (tok: string) => { id: string; giant?: boolean; url?: string } | undefined, giant: boolean, dark: boolean): string => {
  const parts = html.split(/(<[^>]+>)/);
  let inLink = false;
  let lastIdx = -1;
  const out: string[] = [];
  for (const part of parts) {
    if (part.startsWith("<")) {
      if (/^<a[\s>]/i.test(part)) inLink = true;
      else if (/^<\/a>/i.test(part)) inLink = false;
      out.push(part);
      continue;
    }
    if (inLink) { out.push(part); continue; }
    for (const tok of part.split(/(\s+)/)) {
      const hit = tok ? lookup(tok) : undefined;
      if (hit && TWITCH_EMOTE_ID_RE.test(hit.id)) {
        lastIdx = out.length;
        const url = hit.url && YT_EMOJI_URL_RE.test(hit.url) ? hit.url : "";
        out.push(`\u0000${hit.id}\u0001${hit.giant ? "1" : "0"}\u0001${url}\u0001${tok}`);
      } else out.push(tok.replace(/\u0000/g, ""));
    }
  }
  return out.map((v, i) => {
    if (!v.startsWith("\u0000")) return v;
    const [id, own, url, ...rest] = v.slice(1).split("\u0001");
    const name = rest.join("");
    const g = !url && (own === "1" || (giant && i === lastIdx));
    return `<img class="twitch-emote${g ? " giant" : ""}${url ? " youtube-emoji" : ""}" src="${url || twitchEmoteUrl(id, g, dark)}" alt="${name}" title="${name}" loading="lazy" referrerpolicy="no-referrer">`;
  }).join("");
};
// 掲示板などに書かれたスタンプ名: 英数字と _ の語で、知っているスタンプ名と大文字小文字まで一致したものだけ
const BOARD_EMOTE_NAME_RE = /^[A-Za-z0-9_]{2,64}$/;
// 語 → スタンプ。そのままの名前が優先で、無ければ頭の「BIG」(大文字小文字は問わない) を外した名前を巨大スタンプとして探す
const BIG_PREFIX_RE = /^big/i;
const lookupNamedEmote = (tok: string, names: Map<string, string>): { id: string; giant: boolean } | undefined => {
  if (!BOARD_EMOTE_NAME_RE.test(tok)) return undefined;
  const id = names.get(tok);
  if (id && TWITCH_EMOTE_ID_RE.test(id)) return { id, giant: false };
  if (BIG_PREFIX_RE.test(tok)) {
    const rest = tok.slice(3);
    const gid = BOARD_EMOTE_NAME_RE.test(rest) ? names.get(rest) : undefined;
    if (gid && TWITCH_EMOTE_ID_RE.test(gid)) return { id: gid, giant: true };
  }
  return undefined;
};
const findNamedEmotes = (text: string, names: Map<string, string>): TwitchEmote[] => {
  if (names.size === 0) return [];
  const cps = Array.from(text);
  const out: TwitchEmote[] = [];
  let i = 0;
  while (i < cps.length && out.length < 200) {
    if (/\s/.test(cps[i])) { i++; continue; }
    let j = i;
    while (j < cps.length && !/\s/.test(cps[j])) j++;
    const tok = cps.slice(i, j).join("");
    const hit = lookupNamedEmote(tok, names);
    if (hit) out.push({ id: hit.id, start: i, end: j - 1, ...(hit.giant ? { giant: true } : {}) });
    i = j;
  }
  return out;
};
// ----- Twitch の教育・忘却コマンド (棒読みちゃんの書式: 教育(単語=読み) / 忘却(単語)。全角の括弧・＝も受け付ける) -----
const TEACH_CMD_RE = /(教育|忘却)[(（]([^()（）\r\n]{1,120})[)）]/g;
type TwitchTeachEntry = { word: string; reading: string; by: string; at: number };
const TWITCH_TEACH_MAX = 500;
const TWITCH_TEACH_INTERVAL_MS = 5000;
const parseTeachCommands = (text: string): ({ type: "teach"; word: string; reading: string } | { type: "forget"; word: string })[] => {
  const out: ({ type: "teach"; word: string; reading: string } | { type: "forget"; word: string })[] = [];
  for (const m of text.matchAll(TEACH_CMD_RE)) {
    if (m[1] === "教育") {
      const k = m[2].search(/[=＝]/);
      if (k <= 0) continue;
      out.push({ type: "teach", word: m[2].slice(0, k).trim(), reading: m[2].slice(k + 1).trim() });
    } else out.push({ type: "forget", word: m[2].trim() });
    if (out.length >= 5) break;
  }
  return out;
};
// 棒読みちゃんに渡すときは半角の書式にそろえる
const normalizeTeachCommands = (text: string) =>
  text.replace(TEACH_CMD_RE, (_m, cmd: string, body: string) => `${cmd}(${body.replace(/＝/g, "=")})`);
const teachWordOk = (v: string, max: number) => {
  const n = Array.from(v).length;
  return n >= 1 && n <= max && !/[\u0000-\u001f\u007f]/.test(v) && !/(https?:|ttps?:|:\/\/|www\.)/i.test(v);
};
const sanitizeTeachEntries = (v: unknown): TwitchTeachEntry[] =>
  Array.isArray(v)
    ? v.filter((e): e is TwitchTeachEntry => !!e && typeof e === "object" && typeof (e as TwitchTeachEntry).word === "string" && typeof (e as TwitchTeachEntry).reading === "string"
      && teachWordOk((e as TwitchTeachEntry).word, 30) && teachWordOk((e as TwitchTeachEntry).reading, 50))
      .slice(-TWITCH_TEACH_MAX)
      .map((e) => ({ word: e.word, reading: e.reading, by: typeof e.by === "string" ? e.by.slice(0, 25) : "", at: typeof e.at === "number" ? e.at : 0 }))
    : [];
const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// ReDoS mitigation: user-supplied regex patterns (NG filters, URL replace rules)
// are rejected beyond this length
const MAX_USER_REGEX_LEN = 512;
// NG判定の正規表現をパターンごとに1回だけ生成して使い回す (書式エラーは null = 一致しない)。
// "i" フラグのみで g を付けないため、使い回しても lastIndex の状態は持ち越されない
const NG_REGEX_CACHE_MAX = 1000;
const ngRegexCache = new Map<string, RegExp | null>();
const getNgRegex = (source: string): RegExp | null => {
  const hit = ngRegexCache.get(source);
  if (hit !== undefined) return hit;
  let re: RegExp | null;
  try { re = new RegExp(source, "i"); } catch { re = null; }
  if (ngRegexCache.size >= NG_REGEX_CACHE_MAX) ngRegexCache.clear();
  ngRegexCache.set(source, re);
  return re;
};
// ハイライト色は本文HTMLの style 属性に文字列で埋め込むため、#RGB〜#RRGGBBAA の16進表記以外は使わない
const isSafeHexColor = (c: string): boolean => /^#[0-9a-fA-F]{3,8}$/.test(c);
const highlightHtmlPreservingTags = (html: string, query: string) => {
  const q = query.trim();
  if (!q) return html;
  const re = new RegExp(escapeRegExp(q), "gi");
  return html
    .split(/(<[^>]+>)/g)
    .map((part) => (part.startsWith("<") ? part : part.replace(re, (m) => `<mark class="search-hit">${m}</mark>`)))
    .join("");
};
const renderHighlightedPlainText = (text: string, query: string): { __html: string } =>
  ({ __html: highlightHtmlPreservingTags(escapeHtml(decodeHtmlEntities(text)), query) });
const rewrite5chNet = (url: string): string => url.replace(/\.5ch\.net\b/gi, ".5ch.io");

const getAnchorIds = (el: HTMLElement): number[] => {
  const anchors = el.dataset.anchors;
  if (anchors) return anchors.split(",").map(Number).filter((n) => n > 0);
  const start = Number(el.dataset.anchor);
  const end = Number(el.dataset.anchorEnd);
  if (end > start) {
    const ids: number[] = [];
    for (let i = start; i <= end && i - start < 1000; i++) ids.push(i);
    return ids;
  }
  return start > 0 ? [start] : [];
};
const normalizeExternalUrl = (raw: string): string | null => {
  const v = raw.replace(/&amp;/g, "&");
  let result: string | null = null;
  if (/^https?:\/\//i.test(v)) result = v;
  else if (/^ttps:\/\//i.test(v)) result = `h${v}`;
  else if (/^ttp:\/\//i.test(v)) result = `h${v}`;
  else if (/^ps:\/\//i.test(v)) result = `htt${v}`;
  else if (/^s:\/\//i.test(v)) result = `http${v}`;
  else if (/^:\/\//i.test(v)) result = `https${v}`;
  // Bare domain with path (https:// 抜き)
  else if (/^[a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z0-9][-a-zA-Z0-9]*)*\.[a-zA-Z]{2,}[/]/.test(v)) result = `https://${v}`;
  return result ? rewrite5chNet(result) : null;
};

const HIGHLIGHT_COLORS = [
  { name: "赤",     color: "#FF0000" },
  { name: "橙",     color: "#FF8000" },
  { name: "金",     color: "#FFD700" },
  { name: "黄緑",   color: "#00FF00" },
  { name: "緑",     color: "#00CC00" },
  { name: "水色",   color: "#00FFFF" },
  { name: "空色",   color: "#0080FF" },
  { name: "青",     color: "#0000FF" },
  { name: "紫",     color: "#8000FF" },
  { name: "ピンク", color: "#FF00FF" },
  { name: "桃",     color: "#FF69B4" },
  { name: "茶",     color: "#A0522D" },
  { name: "灰",     color: "#808080" },
  { name: "黒",     color: "#000000" },
  { name: "白",     color: "#FFFFFF" },
] as const;

type TextHighlight = { pattern: string; color: string; type: "word" | "name" };
type IdHighlightMap = Record<string, string>; // id -> color
type IdHighlightFile = { date: string; highlights: IdHighlightMap };

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};


/** Detect whether a post body is likely ASCII Art */
const isAsciiArt = (html: string): boolean => {
  const plain = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  const lines = plain.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 3) return false;
  // Count lines with AA-characteristic patterns:
  // - 2+ consecutive fullwidth spaces (used for AA alignment)
  // - box-drawing / structural chars common in AA
  const aaChars = /[─━│┃┌┐└┘├┤┬┴┼╋▓░▒█▀▄■□◆◇○●△▽☆★♪♂♀┏┓┗┛┠┨┯┷┿╂┣┫┳┻╀╂]/;
  const fullwidthSpaces = /\u3000{2,}/;
  // Consecutive halfwidth katakana / special symbols often in AA
  const structuralPattern = /[|/\\＿＼／｜()（）{}＜＞]{3,}/;
  let aaLineCount = 0;
  for (const line of lines) {
    if (fullwidthSpaces.test(line) || aaChars.test(line) || structuralPattern.test(line)) {
      aaLineCount++;
    }
  }
  return aaLineCount / lines.length >= 0.4;
};

type UrlReplaceRuleOpts = { pattern: string; replacement: string; referer?: string };

const applyUrlRules = (url: string, rules: UrlReplaceRuleOpts[]): string => {
  for (const rule of rules) {
    if (rule.pattern.length > MAX_USER_REGEX_LEN) continue;
    try {
      const re = new RegExp(rule.pattern);
      if (re.test(url)) return url.replace(re, rule.replacement);
    } catch { /* ignore bad regex */ }
  }
  return url;
};

// ---------------------------------------------------------------------------
// OGP リンクカード / X ポストカード
// ---------------------------------------------------------------------------

// OGP ドメイン許可/ブロック判定。ホスト名のサフィックス一致・大小無視。
const ogpHostOfUrl = (url: string): string => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
};
const ogpHostMatchesList = (host: string, list: string[]): boolean => {
  if (!host) return false;
  return list.some((d) => {
    const dom = d.trim().toLowerCase().replace(/^www\./, "");
    if (!dom) return false;
    return host === dom || host.endsWith("." + dom);
  });
};
// block は常に除外、allow は空なら全許可・登録ありならそのドメインのみ許可。
const ogpDomainAllowed = (url: string, allow: string[], block: string[]): boolean => {
  const host = ogpHostOfUrl(url);
  if (!host) return false;
  if (ogpHostMatchesList(host, block)) return false;
  if (allow.length > 0 && !ogpHostMatchesList(host, allow)) return false;
  return true;
};
// X のポスト URL から status ID を取り出す (Rust 側 extract_tweet_id と同じ判定)。
const extractTweetId = (url: string): string | null => {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/^mobile\./, "");
  if (host !== "x.com" && host !== "twitter.com") return null;
  const segs = parsed.pathname.split("/").filter((s) => s.length > 0);
  const idx = segs.findIndex((s) => s === "status" || s === "statuses");
  if (idx < 0) return null;
  const id = segs[idx + 1];
  if (!id || !/^\d+$/.test(id)) return null;
  return id;
};

// OGP カード (fetch_ogp_card コマンドの返却型)
type OgpCardData = {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  siteName?: string | null;
};
// OGP ドメイン許可/ブロックリスト (ogp_domain_filters.json)
type OgpDomainFilters = { allow: string[]; block: string[] };
const escapeOgpText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const isHttpUrl = (s: string | null | undefined): s is string => typeof s === "string" && /^https?:\/\//i.test(s);
// 家庭内・自分の PC を指すアドレスか (画像を画面に直接読み込ませると、ルーターなどへのアクセスに使われうるため、
// サムネイル・カードの画像にしない)。名前を引いた先までは調べられないので、IP アドレスの直書きと localhost 系の名前だけを見る
const isPrivateHostUrl = (raw: string): boolean => {
  let host = "";
  try { host = new URL(raw).hostname.toLowerCase(); } catch { return true; }
  host = host.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "") return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true; // fc00::/7・fe80::/10
    const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateHostUrl(`http://${mapped[1]}/`);
    // URL の解析で ::ffff:c0a8:101 のような16進の形に直されたもの
    const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isPrivateHostUrl(`http://${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}/`);
    }
  }
  return false;
};
// OGP カードを描画すべきか (タイトルか画像が無ければ素っ気ないカードになるので出さない)
const ogpCardHasContent = (card: OgpCardData): boolean =>
  Boolean((card.title && card.title.trim()) || isHttpUrl(card.image));
// カードの innerHTML を生成。全ての動的値は escapeOgpText を通し、画像 URL は http(s) のみ許可する。
// クリックは既存の a.body-link 委譲で外部ブラウザに開く。
const buildOgpCardHtml = (card: OgpCardData): string => {
  if (!isHttpUrl(card.url)) return "";
  const title = card.title ? escapeOgpText(card.title.trim()) : "";
  const desc = card.description ? escapeOgpText(card.description.trim()) : "";
  let host = "";
  try { host = new URL(card.url).hostname.replace(/^www\./, ""); } catch { host = ""; }
  const site = card.siteName ? escapeOgpText(card.siteName.trim()) : escapeOgpText(host);
  const img = isHttpUrl(card.image) && !isPrivateHostUrl(card.image)
    ? `<span class="ogp-card-thumb"><img src="${escapeOgpText(card.image)}" loading="lazy" referrerpolicy="no-referrer" alt="" /></span>`
    : "";
  const url = escapeOgpText(card.url);
  const hover = `<span class="ogp-card-hover" aria-hidden="true">`
    + (desc ? `<span class="ogp-card-hover-desc">${desc}</span>` : "")
    + `<span class="ogp-card-hover-url">${url}</span>`
    + `</span>`;
  return `<a class="body-link ogp-card th-cardlist" href="${url}" target="_blank" rel="noopener">`
    + img
    // タイトル・説明・サイト名の欄は空でも出す (どのカードも同じ高さにして、表示されたときにずれないように)
    + `<span class="ogp-card-main">`
    + `<span class="ogp-card-title title">${title}</span>`
    + `<span class="ogp-card-desc description">${desc}</span>`
    + `<span class="ogp-card-site">${site}</span>`
    + `</span>`
    + hover
    + `</a>`;
};

// 読み込み中に出す仮のカード (本物のカードと同じ高さ。表示されても高さが変わらない)
const OGP_SKELETON_HTML = `<span class="ogp-card ogp-card-skeleton" aria-hidden="true"><span class="ogp-card-thumb"><span class="ogp-card-skel-img"></span></span>`
  + `<span class="ogp-card-main"><span class="ogp-card-title"></span><span class="ogp-card-desc"></span><span class="ogp-card-site"></span></span></span>`;

// X ポストカード (fetch_tweet_card コマンドの返却型)
type TweetPhotoData = { url: string; width: number; height: number };
type TweetCardData = {
  url: string;
  id: string;
  text: string;
  authorName: string;
  authorHandle: string;
  authorAvatar?: string | null;
  isVerified: boolean;
  createdAt?: string | null;
  favoriteCount?: number | null;
  replyCount?: number | null;
  photos: TweetPhotoData[];
  hasVideo: boolean;
  videoUrl?: string | null;
  videoPoster?: string | null;
  isGif?: boolean;
  quotedAuthor?: string | null;
  quotedText?: string | null;
};
const formatTweetCount = (n: number): string => {
  if (n >= 100000000) return `${(n / 100000000).toFixed(1).replace(/\.0$/, "")}億`;
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, "")}万`;
  return String(n);
};
const formatTweetDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};
// 本文中の URL / @メンション / #ハッシュタグ をリンク風に装飾する (span のみ、a はネストしない)。
const decorateTweetText = (text: string): string =>
  escapeOgpText(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<span class="tweet-card-link">$1</span>')
    .replace(/(^|[\s(])@([A-Za-z0-9_]{1,15})/g, '$1<span class="tweet-card-link">@$2</span>')
    .replace(/(^|[\s(])(#[^\s<#]+)/g, '$1<span class="tweet-card-link">$2</span>')
    .replace(/\n/g, "<br />");
// twimg の動画 URL のみインライン再生を許可する (CSP media-src と一致させる)
const isTwimgVideoUrl = (s: string | null | undefined): s is string =>
  typeof s === "string" && /^https:\/\/video\.twimg\.com\//i.test(s);
// ポストカードの innerHTML を生成。<video> は a.body-link の外側 (兄弟) に置く。
const buildTweetCardHtml = (card: TweetCardData): string => {
  if (!isHttpUrl(card.url)) return "";
  const url = escapeOgpText(card.url);
  const avatar = isHttpUrl(card.authorAvatar)
    ? `<img class="tweet-card-avatar" src="${escapeOgpText(card.authorAvatar)}" loading="lazy" referrerpolicy="no-referrer" alt="" />`
    : `<span class="tweet-card-avatar tweet-card-avatar-blank" aria-hidden="true"></span>`;
  const badge = card.isVerified ? `<span class="tweet-card-badge" title="認証済み">✓</span>` : "";
  const head = `<span class="tweet-card-head">`
    + avatar
    + `<span class="tweet-card-names">`
    + `<span class="tweet-card-name">${escapeOgpText(card.authorName ?? "")}${badge}</span>`
    + `<span class="tweet-card-handle">@${escapeOgpText(card.authorHandle ?? "")}</span>`
    + `</span>`
    + `<span class="tweet-card-logo" aria-hidden="true">𝕏</span>`
    + `</span>`;
  const body = card.text ? `<span class="tweet-card-text">${decorateTweetText(card.text)}</span>` : "";
  const quote = card.quotedText
    ? `<span class="tweet-card-quote">`
      + (card.quotedAuthor ? `<span class="tweet-card-quote-author">${escapeOgpText(card.quotedAuthor)}</span>` : "")
      + `<span class="tweet-card-quote-text">${escapeOgpText(card.quotedText)}</span>`
      + `</span>`
    : "";
  const photoList = (card.photos ?? []).filter((p) => isHttpUrl(p.url)).slice(0, 4);
  const photos = photoList.length > 0
    ? `<span class="tweet-card-photos tweet-card-photos-${photoList.length}">`
      + photoList.map((p) => {
        const w = Number.isFinite(p.width) ? Math.max(0, Math.floor(p.width)) : 0;
        const h = Number.isFinite(p.height) ? Math.max(0, Math.floor(p.height)) : 0;
        const ratio = w > 0 && h > 0 ? ` style="aspect-ratio:${w}/${h}"` : "";
        const dim = w > 0 && h > 0 ? ` width="${w}" height="${h}"` : "";
        return `<img class="tweet-card-photo" src="${escapeOgpText(p.url)}"${dim}${ratio} loading="lazy" referrerpolicy="no-referrer" alt="" />`;
      }).join("")
      + `</span>`
    : "";
  const videoSrc = card.hasVideo && isTwimgVideoUrl(card.videoUrl) ? card.videoUrl : null;
  const playable = videoSrc !== null;
  const videoLabel = card.hasVideo && !playable
    ? `<span class="tweet-card-video">▶ 動画つきポスト（クリックで X を開く）</span>`
    : "";
  const metaParts: string[] = [];
  if (typeof card.replyCount === "number" && card.replyCount > 0) metaParts.push(`💬 ${formatTweetCount(card.replyCount)}`);
  if (typeof card.favoriteCount === "number" && card.favoriteCount > 0) metaParts.push(`♡ ${formatTweetCount(card.favoriteCount)}`);
  if (card.createdAt) {
    const d = formatTweetDate(card.createdAt);
    if (d) metaParts.push(d);
  }
  const meta = metaParts.length > 0
    ? `<span class="tweet-card-meta">${metaParts.map(escapeOgpText).join("<span class=\"tweet-card-dot\">·</span>")}</span>`
    : "";
  let videoEl = "";
  if (videoSrc !== null) {
    const src = escapeOgpText(videoSrc);
    const poster = isHttpUrl(card.videoPoster) ? ` poster="${escapeOgpText(card.videoPoster)}"` : "";
    videoEl = card.isGif
      ? `<video class="tweet-card-video-el" src="${src}"${poster} autoplay loop muted playsinline preload="metadata"></video>`
      : `<video class="tweet-card-video-el" src="${src}"${poster} controls playsinline preload="none"></video>`;
  }
  const main = `<a class="body-link tweet-card-main" href="${url}" target="_blank" rel="noopener">`
    + head + body + quote + photos + videoLabel + meta
    + `</a>`;
  return `<span class="tweet-card th-cardlist">${main}${videoEl}</span>`;
};

type RenderBodyOpts = {
  hideImages?: boolean;
  imageSizeLimitKb?: number;
  urlRules?: UrlReplaceRuleOpts[];
  ogpCards?: boolean;
  tweetCards?: boolean;
  ogpAllow?: string[];
  ogpBlock?: string[];
};

const renderResponseBody = (html: string, opts?: RenderBodyOpts): { __html: string } => {
  let safe = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a\s[^>]*>(.*?)<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "");
  safe = decodeHtmlEntities(safe);
  safe = safe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  if (opts?.hideImages) {
    // Remove image URL lines entirely
    safe = safe.split("\n").filter((line) => !/(?:https?:\/\/|ttps?:\/\/|ps:\/\/|s:\/\/|(?<![a-zA-Z]):\/\/|(?<!\S)(?:[a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z]{2,}\/)[^\s]+\.(?:jpg|jpeg|png|gif|webp)/i.test(line)).join("\n");
  }
  safe = safe.replace(/\n/g, "<br>");
  const collectedThumbs: string[] = [];
  const sizeGated = opts?.imageSizeLimitKb && opts.imageSizeLimitKb > 0;
  if (!opts?.hideImages) {
    safe = safe.replace(
      /((?:https?:\/\/|ttps?:\/\/|ps:\/\/|s:\/\/|(?<![a-zA-Z]):\/\/)[^\s<>&"]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s<>&"]*(?:&amp;[^\s<>&"]*)*)?|(?<!\S)(?:[a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z]{2,}\/[^\s<>&"]*\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s<>&"]*(?:&amp;[^\s<>&"]*)*)?)/gi,
      (match) => {
        const rawHref = normalizeExternalUrl(match);
        if (!rawHref) return match;
        const href = opts?.urlRules?.length ? applyUrlRules(rawHref, opts.urlRules) : rawHref;
        // 家庭内・自分の PC のアドレスの画像はサムネイルにしない (リンクとしては残す)
        if (isPrivateHostUrl(href)) return `<a class="body-link" href="${href}" target="_blank" rel="noopener">${match}</a>`;
        if (sizeGated) {
          collectedThumbs.push(`<span class="thumb-link thumb-size-gate" data-lightbox-src="${href}" data-gate-src="${href}" data-size-limit="${opts.imageSizeLimitKb}"><span class="thumb-gate-loading">画像を確認中…</span></span>`);
        } else {
          collectedThumbs.push(`<span class="thumb-link" data-lightbox-src="${href}"><img class="response-thumb" src="${href}" loading="eager" referrerpolicy="no-referrer" alt="" /></span>`);
        }
        return `<a class="body-link" href="${href}" target="_blank" rel="noopener">${match}</a>`;
      }
    );
  }
  // twimg の動画直リンク (video.twimg.com/....mp4) は X ポストカードが ON のときインライン再生する。
  // URL 自体はリンクとして残し、プレイヤーはサムネ行に追加する (CSP media-src は video.twimg.com のみ許可)。
  if (!opts?.hideImages && opts?.tweetCards) {
    safe = safe.replace(
      /(?:(?:https?:\/\/|ttps?:\/\/|ps:\/\/|s:\/\/|(?<![a-zA-Z]):\/\/)video\.twimg\.com|(?<!\S)video\.twimg\.com)\/[^\s<>&"]+\.mp4(?:\?[^\s<>&"]*(?:&amp;[^\s<>&"]*)*)?/gi,
      (match) => {
        const href = normalizeExternalUrl(match);
        if (!href || !/^https:\/\/video\.twimg\.com\//i.test(href)) return match;
        collectedThumbs.push(`<video class="inline-video" src="${href}#t=0.1" controls preload="metadata" playsinline></video>`);
        return `<a class="body-link" href="${href}" target="_blank" rel="noopener">${match}</a>`;
      }
    );
  }
  // Linkify non-image URLs (must run after image thumb replacement)
  safe = safe.replace(
    /((?:https?:\/\/|ttps?:\/\/|ps:\/\/|s:\/\/|(?<![a-zA-Z]):\/\/)[^\s<>&"]+(?:&amp;[^\s<>&"]*)*|(?<!\S)(?:[a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z]{2,}\/[^\s<>&"]+(?:&amp;[^\s<>&"]*)*)/gi,
    (match) => {
      // Skip if already inside a thumb-link or img tag
      if (match.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i)) return match;
      // Skip twimg 動画: 上で <video src="..."> に変換済みなので二重リンク化しない
      if (!opts?.hideImages && opts?.tweetCards && /video\.twimg\.com\/[^\s"'<>]+\.mp4/i.test(match)) return match;
      const href = normalizeExternalUrl(match);
      if (!href) return match;
      return `<a class="body-link" href="${href}" target="_blank" rel="noopener">${match}</a>`;
    }
  );
  // >> range (>>2-10)
  safe = safe.replace(
    /&gt;&gt;(\d+)-(\d+)/g,
    (_m, s: string, e: string) => `<span class="anchor-ref" data-anchor="${s}" data-anchor-end="${e}" role="link" tabindex="0">&gt;&gt;${s}-${e}</span>`
  );
  // >> comma (>>2,3) — keep original display
  safe = safe.replace(
    /&gt;&gt;(\d+(?:[,、]\d+)+)/g,
    (_m, nums: string) => {
      const first = nums.split(/[,、]/)[0];
      return `<span class="anchor-ref" data-anchor="${first}" data-anchors="${nums.replace(/、/g, ",")}" role="link" tabindex="0">&gt;&gt;${nums}</span>`;
    }
  );
  // >> single (>>2)
  safe = safe.replace(
    /&gt;&gt;(\d+)/g,
    '<span class="anchor-ref" data-anchor="$1" role="link" tabindex="0">&gt;&gt;$1</span>'
  );
  // > range (>2-10)
  safe = safe.replace(
    /&gt;(\d+)-(\d+)/g,
    (_m, s: string, e: string) => `<span class="anchor-ref" data-anchor="${s}" data-anchor-end="${e}" role="link" tabindex="0">&gt;${s}-${e}</span>`
  );
  // > comma (>2,3) — keep original display
  safe = safe.replace(
    /&gt;(\d+(?:[,、]\d+)+)/g,
    (_m, nums: string) => {
      const first = nums.split(/[,、]/)[0];
      return `<span class="anchor-ref" data-anchor="${first}" data-anchors="${nums.replace(/、/g, ",")}" role="link" tabindex="0">&gt;${nums}</span>`;
    }
  );
  // > single (>2)
  safe = safe.replace(
    /&gt;(\d+)/g,
    '<span class="anchor-ref" data-anchor="$1" role="link" tabindex="0">&gt;$1</span>'
  );
  // Convert sssp:// BE icons to https:// img preview
  safe = safe.replace(
    /sssp:\/\/(img\.5ch\.net\/[^\s<>&]+|img\.5ch\.io\/[^\s<>&]+)/gi,
    (_match, path) => `<img class="be-icon" src="https://${(path as string).replace("img.5ch.net", "img.5ch.io")}" loading="eager" alt="BE" />`
  );
  if (collectedThumbs.length > 0) {
    safe += `<div class="response-thumbs-row">${collectedThumbs.join("")}</div>`;
  }
  // OGP / X ポストカード用プレースホルダ。実データは非同期取得後に IntersectionObserver で
  // 埋め込む (App 内の ogp fill エフェクト)。5ch 内部リンク・画像リンクは対象外。
  if (opts?.ogpCards || opts?.tweetCards) {
    const ogpSlots: string[] = [];
    const seenUrls = new Set<string>();
    const linkRe = /<a class="body-link" href="([^"]+)"/g;
    let om: RegExpExecArray | null;
    while ((om = linkRe.exec(safe)) !== null) {
      const href = om[1];
      if (seenUrls.has(href)) continue;
      if (!/^https?:\/\//i.test(href)) continue;
      if (/^https?:\/\/[^/]*\.5ch\.(net|io)\//i.test(href)) continue;
      if (/\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(href)) continue;
      if (!ogpDomainAllowed(href, opts.ogpAllow ?? [], opts.ogpBlock ?? [])) continue;
      // X のポストは syndication API から取れるので専用のポストカードにする。
      // ポストカードが OFF のときは通常の OGP カードのスロットとして扱う (フォールバック)。
      const tweetId = opts.tweetCards ? extractTweetId(href) : null;
      if (tweetId) {
        seenUrls.add(href);
        ogpSlots.push(`<div class="ogp-card-slot tweet-card-slot" data-ogp-url="${href}" data-tweet-id="${tweetId}"></div>`);
      } else {
        if (!opts.ogpCards) continue;
        seenUrls.add(href);
        ogpSlots.push(`<div class="ogp-card-slot" data-ogp-url="${href}"></div>`);
      }
      if (ogpSlots.length >= 4) break;
    }
    if (ogpSlots.length > 0) {
      safe += `<div class="ogp-cards">${ogpSlots.join("")}</div>`;
    }
  }
  return { __html: safe };
};
const applyWordHighlight = (html: string, pattern: string, color: string): string => {
  if (!pattern || !isSafeHexColor(color)) return html;
  const re = new RegExp(escapeRegExp(pattern), "gi");
  return html
    .split(/(<[^>]+>)/g)
    .map((part) => (part.startsWith("<") ? part : part.replace(re, (m) => `<span style="background:${color}">${m}</span>`)))
    .join("");
};
const renderResponseBodyHighlighted = (html: string, query: string, opts?: RenderBodyOpts, wordHighlights?: Array<{ pattern: string; color: string }>): { __html: string } => {
  const rendered = renderResponseBody(html, opts).__html;
  let result = highlightHtmlPreservingTags(rendered, query);
  if (wordHighlights) {
    for (const wh of wordHighlights) {
      result = applyWordHighlight(result, wh.pattern, wh.color);
    }
  }
  return { __html: result };
};

const extractWatchoi = (name: string): string | null => {
  const m = name.match(/[(（]([^)）]+)[)）]\s*$/);
  if (!m) return null;
  const inner = m[1].trim();
  // Name suffix in parens with provider + space + code (e.g. "ﾜｯﾁｮｲW 0b6b-v/9N", "JP 0H7f-p4YP")
  if (/\S+\s+\S+/.test(inner)) return inner;
  return null;
};

// 名前ハイライトで比べる名前 (末尾のワッチョイを除く。レス表示欄の nameWithoutWatchoi と同じ)
const nameForHighlight = (name: string): string => (extractWatchoi(name) ? name.replace(/\s*[(（][^)）]+[)）]\s*$/, "") : name);

const extractBeNumber = (...sources: string[]): string | null => {
  const patterns = [
    /BE[:：]\s*(\d+)/i,
    /javascript\s*:\s*be\((\d+)\)/i,
    /\bbe\((\d+)\)/i,
    /[?&]i=(\d+)/i,
    /\/user\/(\d+)\b/i,
  ];
  for (const source of sources) {
    if (!source) continue;
    for (const pattern of patterns) {
      const m = source.match(pattern);
      if (m?.[1]) return m[1];
    }
  }
  return null;
};

export default function App() {
  const [status, setStatus] = useState("not fetched");
  const [threadUrl, setThreadUrl] = useState("https://mao.5ch.io/test/read.cgi/ngt/9240230711/");
  const [locationInput, setLocationInput] = useState("https://mao.5ch.io/test/read.cgi/ngt/9240230711/");
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(false);
  const [cssAllowExternalUrls, setCssAllowExternalUrls] = useState(false);
  // 登録項目のマスク: NG・読み上げない辞書・読み上げ許可リストなど、画面共有時に見せたくない
  // 登録内容を隠す。既定でON(安全側)。値そのものは変更せず表示だけを隠す
  const [streamMaskEnabled, setStreamMaskEnabled] = useState(true);
  const maskInputType: "password" | "text" = streamMaskEnabled ? "password" : "text";
  const maskDisplay = (v: string) => streamMaskEnabled ? "••••••••" : v;
  const [metadataUrl, setMetadataUrl] = useState("https://raw.githubusercontent.com/kaedekiku/LiveFakeTauri2/main/apps/landing/public/latest.json");
  const [currentVersion, setCurrentVersion] = useState(typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0");
  // 起動時の更新確認: オンなら1日1回だけ latest.json (数百バイト) を取りに行く。前回確認した日と、
  // そのとき見つけた新しい版の番号を settings.ini に残し、同じ日は通信せずにその結果で告知する
  const [autoUpdateCheck, setAutoUpdateCheck] = useState(true);
  const [lastUpdateCheck, setLastUpdateCheck] = useState("");
  const [knownLatestVersion, setKnownLatestVersion] = useState("");
  // ダイアログで知らせたお知らせの id (同じお知らせは1回だけダイアログを出す)
  const [updateNoticeSeen, setUpdateNoticeSeen] = useState("");
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [updateProbe, setUpdateProbe] = useState("not run");
  const [composeOpen, setComposeOpen] = useState(false);
  // スレッドタイトルバーの「書き込み」から開く別ウィンドウ (浮遊ウィンドウ) が現在開いているか。
  // 開いている間はレスの引用 (ダブルクリック) をそちらへ転送する
  const composePopupOpenRef = useRef(false);
  // 浮遊ウィンドウを開いたときのスレを固定しておく。浮遊ウィンドウは別ウィンドウなので開いたまま
  // メイン側でタブを切り替えられてしまい、それを送信時に読み直すと投稿先が意図と変わってしまうため
  const composePopupTargetRef = useRef<{ url: string; title: string } | null>(null);
  const [composePanelPx, setComposePanelPx] = useState(DEFAULT_COMPOSE_PANEL_PX);
  const [composeName, setComposeName] = useState("");
  const [nameHistory, setNameHistory] = useState<string[]>([]);
  const [composeMail, setComposeMail] = useState("");
  const [composeSage, setComposeSage] = useState(false);
  const [composeBody, setComposeBody] = useState("");
  const [composePreview, setComposePreview] = useState(false);
  const [composeResult, setComposeResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [composeSubmitting, setComposeSubmitting] = useState(false);
  const [showNewThreadDialog, setShowNewThreadDialog] = useState(false);
  const [newThreadSubject, setNewThreadSubject] = useState("");
  const [newThreadName, setNewThreadName] = useState("");
  const [newThreadMail, setNewThreadMail] = useState("");
  const [newThreadBody, setNewThreadBody] = useState("");
  const [newThreadResult, setNewThreadResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [newThreadSubmitting, setNewThreadSubmitting] = useState(false);
  const [newThreadDialogSize, setNewThreadDialogSize] = useState<{ w: number; h: number }>({ w: 520, h: 420 });
  const newThreadPanelRef = useRef<HTMLDivElement>(null);
  // 書き込み履歴 (新しい順に最大50件)。data/post-history.json に保存し、再起動しても残す。返信とスレ立ての両方を記録する
  type PostHistoryEntry = { time: string; threadUrl: string; title: string; kind: "reply" | "thread"; body: string; ok: boolean };
  const [postHistory, setPostHistory] = useState<PostHistoryEntry[]>([]);
  const postHistoryLoadedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void loadFromFile<unknown>("post-history.json").then((d) => {
      if (cancelled) return;
      if (Array.isArray(d)) {
        const rows = d.filter((x): x is PostHistoryEntry => !!x && typeof x === "object"
          && typeof (x as PostHistoryEntry).time === "string" && typeof (x as PostHistoryEntry).body === "string").slice(0, 50)
          .map((x) => ({ ...x, title: typeof x.title === "string" ? x.title : "", kind: x.kind === "thread" ? "thread" as const : "reply" as const, threadUrl: typeof x.threadUrl === "string" ? x.threadUrl : "", ok: !!x.ok }));
        setPostHistory((prev) => [...prev, ...rows].slice(0, 50));
      }
      postHistoryLoadedRef.current = true;
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (postHistoryLoadedRef.current) saveToFile("post-history.json", postHistory);
  }, [postHistory]);
  const recordPostHistory = (threadUrl: string, title: string, kind: "reply" | "thread", body: string, ok: boolean) => {
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const time = `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    setPostHistory((prev) => [{ time, threadUrl, title, kind, body: body.slice(0, 100), ok }, ...prev].slice(0, 50));
  };
  const [postHistoryOpen, setPostHistoryOpen] = useState(false);
  const [myPosts, setMyPosts] = useState<Record<string, number[]>>({});
  const pendingMyPostRef = useRef<{ threadUrl: string; body: string; prevCount: number } | null>(null);
  const [threadListProbe, setThreadListProbe] = useState("not run");
  const [responseListProbe, setResponseListProbe] = useState("not run");
  const [fetchedThreads, setFetchedThreads] = useState<ThreadListItem[]>([]);
  const [fetchedResponses, setFetchedResponses] = useState<ThreadResponseItem[]>([]);
  const fetchedResponsesLenRef = useRef(0);
  fetchedResponsesLenRef.current = fetchedResponses.length;
  const [boardCategories, setBoardCategories] = useState<BoardCategory[]>([]);
  const [externalBoards, setExternalBoards] = useState<BoardEntry[]>([]);
  const [showExternalBoardDialog, setShowExternalBoardDialog] = useState(false);
  const [externalBoardUrl, setExternalBoardUrl] = useState("");
  const [externalBoardName, setExternalBoardName] = useState("");
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [favorites, setFavorites] = useState<FavoritesData>({ boards: [], threads: [] });
  const [ngFilters, setNgFilters] = useState<NgFilters>({ words: [], ids: [], names: [], mails: [], thread_words: [], image_words: [], invisible: "off" });
  // customTitles: boardUrl -> threadKey -> customTitle
  const [customTitles, setCustomTitles] = useState<Record<string, Record<string, string>>>({});
  const [ngAddMode, setNgAddMode] = useState<NgMode>("hide");
  const [ngAddScope, setNgAddScope] = useState<"global" | "board" | "thread">("global");
  // 通常あぼ～んのレスを読み上げる際、「あぼーん」と読むか、前置き含め完全にスキップするか
  const [ngAboneSpeakEnabled, setNgAboneSpeakEnabled] = useState(true);
  // 設定 > Twitch: 読み上げで「名前さん」を前に付けるか (TchViewer の既定と同じくオン)、
  // 新着ペイン・字幕に溜める Twitch のチャットの上限、読み上げの溜まりの上限
  const [twitchSpeakName, setTwitchSpeakName] = useState(true);
  // Twitch のスタンプ: アプリ (Twitch タブ・ビュワー) での大きさ (px) と、読み上げ方
  const [twitchEmoteSize, setTwitchEmoteSize] = useState(28);
  const [twitchGiantEmoteSize, setTwitchGiantEmoteSize] = useState(112);
  const [twitchEmoteSpeak, setTwitchEmoteSpeak] = useState<"name" | "none">("name");
  const [twitchEmoteMax, setTwitchEmoteMax] = useState(3);
  useEffect(() => {
    document.documentElement.style.setProperty("--tw-emote", `${twitchEmoteSize}px`);
    document.documentElement.style.setProperty("--tw-giant", `${twitchGiantEmoteSize}px`);
  }, [twitchEmoteSize, twitchGiantEmoteSize]);
  // 字幕ウィンドウでのスタンプの大きさ (px)
  const [subtitleEmoteSize, setSubtitleEmoteSize] = useState(40);
  const [subtitleGiantEmoteSize, setSubtitleGiantEmoteSize] = useState(160);
  const subtitleEmoteSizesRef = useRef({ normal: 40, giant: 160 });
  subtitleEmoteSizesRef.current = { normal: subtitleEmoteSize, giant: subtitleGiantEmoteSize };
  // 掲示板などに書かれたスタンプ名を画像にする。対応表 (名前 → ID) は、Twitch のチャットで見たスタンプと、
  // ログイン中に公式 API から取得した一覧から作る (data/twitch-emotes.json)
  const [boardEmotesEnabled, setBoardEmotesEnabled] = useState(true);
  const boardEmotesEnabledRef = useRef(true);
  boardEmotesEnabledRef.current = boardEmotesEnabled;
  const emoteNameMapRef = useRef<Map<string, string>>(new Map());
  // 名前ごとの最後に見た (取得した) 時刻。Twitch の開発者向け規約 (保存は24時間のキャッシュまで) に合わせ、24時間を過ぎたら捨てる
  const emoteNameSeenRef = useRef<Map<string, number>>(new Map());
  const EMOTE_NAMES_KEEP_MS = 24 * 3600 * 1000;
  const pruneEmoteNames = () => {
    const limit = Date.now() - EMOTE_NAMES_KEEP_MS;
    let changed = false;
    for (const [name, at] of emoteNameSeenRef.current) {
      if (at >= limit) continue;
      emoteNameSeenRef.current.delete(name);
      emoteNameMapRef.current.delete(name);
      changed = true;
    }
    if (changed) emoteNamesDirtyRef.current = true;
    return changed;
  };
  const [emoteNameVersion, setEmoteNameVersion] = useState(0);
  const emoteNamesDirtyRef = useRef(false);
  const emoteNamesLoadedRef = useRef(false);
  const EMOTE_NAMES_MAX = 10000;
  const learnEmoteNames = (pairs: { name: string; id: string; at?: number }[]) => {
    const map = emoteNameMapRef.current;
    const seen = emoteNameSeenRef.current;
    const now = Date.now();
    let changed = false;
    for (const { name, id, at } of pairs) {
      if (!BOARD_EMOTE_NAME_RE.test(name) || !TWITCH_EMOTE_ID_RE.test(id)) continue;
      const t = typeof at === "number" ? at : now;
      if (map.get(name) === id) {
        // 同じものを見直したら時刻だけ新しくする (保存は20秒ごとのまとめ書きに任せる)
        if ((seen.get(name) ?? 0) < t) { seen.set(name, t); emoteNamesDirtyRef.current = true; }
        continue;
      }
      map.delete(name);
      map.set(name, id);
      seen.set(name, t);
      changed = true;
    }
    while (map.size > EMOTE_NAMES_MAX) { const first = map.keys().next().value; if (first === undefined) break; map.delete(first); seen.delete(first); }
    if (changed) emoteNamesDirtyRef.current = true;
    return changed;
  };
  useEffect(() => {
    let cancelled = false;
    void loadFromFile<unknown>("twitch-emotes.json").then((d) => {
      if (cancelled) return;
      // 形式 2: { name: [id, 覚えた時刻] }。時刻の無い古い形式は捨てる (24時間の決まりを守れないため)
      const o = d && typeof d === "object" && (d as { version?: unknown }).version === 2 ? (d as { emotes?: unknown }).emotes : undefined;
      if (o && typeof o === "object") {
        learnEmoteNames(Object.entries(o as Record<string, unknown>)
          .filter((e): e is [string, [string, number]] => Array.isArray(e[1]) && typeof e[1][0] === "string" && typeof e[1][1] === "number")
          .map(([name, [id, at]]) => ({ name, id, at })));
      }
      const pruned = pruneEmoteNames();
      emoteNamesDirtyRef.current = pruned || (!!d && (d as { version?: unknown }).version !== 2);
      emoteNamesLoadedRef.current = true;
      setEmoteNameVersion((v) => v + 1);
    });
    // 覚えた分は 20 秒ごとにまとめて保存し、表示にも反映する (受信のたびに全体を描き直さないように)
    let ticks = 0;
    const timer = window.setInterval(() => {
      if (!emoteNamesLoadedRef.current) return;
      // 期限切れの掃除は10分ごと
      if (++ticks % 30 === 0) pruneEmoteNames();
      if (!emoteNamesDirtyRef.current) return;
      emoteNamesDirtyRef.current = false;
      saveToFile("twitch-emotes.json", { version: 2, emotes: Object.fromEntries([...emoteNameMapRef.current].map(([name, id]) => [name, [id, emoteNameSeenRef.current.get(name) ?? Date.now()]])) });
      setEmoteNameVersion((v) => v + 1);
    }, 20000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  const boardEmoteLookup = (tok: string) => lookupNamedEmote(tok, emoteNameMapRef.current);
  // Twitch の教育・忘却 (Twitch のチャットからだけ。既定オフ)。VOICEVOX・SAPI では LiveFake の「Twitch 教育辞書」で処理し、
  // 棒読みちゃんでは棒読みちゃん自身に任せる (二重に教育しないように)。掲示板のコマンドはどのエンジンでも受け付けない
  const [twitchTeachEnabled, setTwitchTeachEnabled] = useState(false);
  const [twitchTeachAnnounce, setTwitchTeachAnnounce] = useState(true);
  const [twitchTeachDict, setTwitchTeachDict] = useState<TwitchTeachEntry[]>([]);
  const [twitchTeachNewWord, setTwitchTeachNewWord] = useState("");
  const [twitchTeachNewReading, setTwitchTeachNewReading] = useState("");
  const [twitchTeachMsg, setTwitchTeachMsg] = useState("");
  const twitchTeachDictRef = useRef<TwitchTeachEntry[]>([]);
  const twitchTeachEnabledRef = useRef(false);
  twitchTeachEnabledRef.current = twitchTeachEnabled;
  const twitchTeachLoadedRef = useRef(false);
  const twitchTeachLastRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void loadFromFile<unknown>("twitch-teach.json").then((d) => {
      if (cancelled) return;
      const entries = sanitizeTeachEntries(d && typeof d === "object" ? (d as { entries?: unknown }).entries : undefined);
      twitchTeachDictRef.current = entries;
      setTwitchTeachDict(entries);
      twitchTeachLoadedRef.current = true;
    });
    return () => { cancelled = true; };
  }, []);
  const updateTwitchTeachDict = (next: TwitchTeachEntry[]) => {
    twitchTeachDictRef.current = next;
    setTwitchTeachDict(next);
    if (twitchTeachLoadedRef.current) saveToFile("twitch-teach.json", { version: 1, entries: next });
  };
  // Twitch タブのスタンプ (タブの URL → レス番号 → スタンプ名と ID)。表示のときに画像へ置き換える
  const twitchEmoteMapRef = useRef<Map<string, Map<number, { emotes: { id: string; name: string; giant?: boolean; url?: string }[]; giant: boolean }>>>(new Map());
  // Twitch ログイン (任意。EventSub で入力の無い報酬・自動報酬・フォローを受け取る)。トークンは Rust 側だけが持つ
  type TwitchAuthStatus = { loggedIn: boolean; login: string; state: string; message: string; userCode: string; verificationUri: string; canChat?: boolean };
  const [twitchAuth, setTwitchAuth] = useState<TwitchAuthStatus>({ loggedIn: false, login: "", state: "none", message: "", userCode: "", verificationUri: "", canChat: false });
  const [twitchAuthBusy, setTwitchAuthBusy] = useState(false);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void invoke<TwitchAuthStatus>("twitch_auth_status").then((st) => { if (!disposed) setTwitchAuth(st); }).catch((e) => console.warn("twitch_auth_status failed", e));
    void listen<TwitchAuthStatus>("twitch-auth", (ev) => { if (ev.payload) setTwitchAuth(ev.payload); })
      .then((u) => { if (disposed) u(); else unlisten = u; })
      .catch((e) => console.warn("twitch-auth listen failed", e));
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const openTwitchActivatePage = (uri: string) => {
    // 開くのは Twitch の確認ページだけ (Rust 側でも確かめている)
    if (!uri.startsWith("https://www.twitch.tv/activate")) return;
    void invoke("open_external_url", { url: uri }).catch((e) => console.warn("open_external_url failed", e));
  };
  const startTwitchLogin = async () => {
    setTwitchAuthBusy(true);
    try {
      const st = await invoke<TwitchAuthStatus>("twitch_login_start");
      setTwitchAuth(st);
      openTwitchActivatePage(st.verificationUri);
    } catch (e) {
      setTwitchAuth((prev) => ({ ...prev, state: "error", message: String(e) }));
    } finally { setTwitchAuthBusy(false); }
  };
  const logoutTwitch = () => {
    setAppConfirm({
      title: "Twitch からログアウト",
      message: "Twitch からログアウトしますか?\nTwitch 側の許可も取り消し、保存したログイン情報を削除します。",
      buttons: [
        { label: "ログアウト", danger: true, onClick: () => { setTwitchAuthBusy(true); void invoke("twitch_logout").catch((e) => console.warn("twitch_logout failed", e)).finally(() => setTwitchAuthBusy(false)); } },
        { label: "キャンセル", onClick: () => {} },
      ],
    });
  };
  // Twitch のバッジ画像・チャンネルポイント報酬名を取得する (Twitch のサイトの非公式の取得口。TchViewer と同じ)
  const [twitchBadgesEnabled, setTwitchBadgesEnabled] = useState(true);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    void invoke("twitch_set_badges", { enabled: twitchBadgesEnabled }).catch((e) => console.warn("twitch_set_badges failed", e));
  }, [twitchBadgesEnabled]);
  const [twitchMaxQueuedArrivals, setTwitchMaxQueuedArrivals] = useState(TWITCH_MAX_QUEUED_ARRIVALS_DEFAULT);
  const [twitchMaxTtsBacklog, setTwitchMaxTtsBacklog] = useState(TWITCH_MAX_TTS_BACKLOG_DEFAULT);
  // 設定 > Twitch > イベント: 種類ごとに「流す」「読み上げる」「読み上げる文」(data/twitch-events.json。登録した時点で保存)
  const [twitchEventSettings, setTwitchEventSettings] = useState<Record<string, TwitchEventSetting>>(defaultTwitchEventSettings);
  const twitchEventSettingsLoadedRef = useRef(false);
  const [twitchEventTestMsg, setTwitchEventTestMsg] = useState("");
  useEffect(() => {
    let cancelled = false;
    void loadFromFile<unknown>("twitch-events.json").then((d) => {
      if (cancelled) return;
      if (d && typeof d === "object") setTwitchEventSettings(sanitizeTwitchEventSettings((d as { events?: unknown }).events));
      twitchEventSettingsLoadedRef.current = true;
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (twitchEventSettingsLoadedRef.current) saveToFile("twitch-events.json", { version: 1, events: twitchEventSettings });
  }, [twitchEventSettings]);
  const updateTwitchEvent = (kind: string, patch: Partial<TwitchEventSetting>) =>
    setTwitchEventSettings((prev) => ({ ...prev, [kind]: { ...(prev[kind] ?? defaultTwitchEventSettings()[kind]), ...patch } }));
  // ===== YouTube ライブ配信のチャット: 設定 =====
  // 取得方法 (この exe で使えるものを Rust から受け取る)・公式 API の呼ぶ間隔・API キー (Rust 側だけが持つ。画面には設定済みかだけ)
  type YoutubeMethod = { id: string; label: string; description: string; needsKey: boolean };
  const [youtubeMethods, setYoutubeMethods] = useState<YoutubeMethod[]>([]);
  const [youtubeMethod, setYoutubeMethod] = useState("api");
  const [youtubeApiInterval, setYoutubeApiInterval] = useState(YOUTUBE_API_INTERVAL_DEFAULT);
  const [youtubeKeySet, setYoutubeKeySet] = useState(false);
  const [youtubeKeyInput, setYoutubeKeyInput] = useState("");
  const [youtubeKeyMsg, setYoutubeKeyMsg] = useState<{ text: string; error: boolean } | null>(null);
  // つなぎ直しの合図 (API キーを変えた・「つなぎ直す」を押した)
  const [youtubeSyncVersion, setYoutubeSyncVersion] = useState(0);
  const [youtubeSpeakName, setYoutubeSpeakName] = useState(true);
  // 公式 API の使用量 (クォータ): 何時間もたせるか (オフなら設定した間隔のまま)・1日の上限。使用量の目安は Rust 側が数えて "youtube-quota" で知らせる
  const [youtubeTargetOn, setYoutubeTargetOn] = useState(false);
  const [youtubeTargetHours, setYoutubeTargetHours] = useState(YOUTUBE_TARGET_HOURS_DEFAULT);
  const [youtubeDailyQuota, setYoutubeDailyQuota] = useState(YOUTUBE_API_DAILY_QUOTA);
  type YoutubeQuota = { day: string; used: number; limit: number; reserve: number; active: number; targetHours: number; targetEnd: number | null; intervalSecs: number; reachable: boolean; lastsSecs: number; untilResetSecs: number };
  const [youtubeQuota, setYoutubeQuota] = useState<YoutubeQuota | null>(null);
  const [youtubeQuotaUsedInput, setYoutubeQuotaUsedInput] = useState("");
  // 書き込み (Google アカウントでログイン。トークン・シークレットは Rust 側だけが持つ)
  type YoutubeAuthStatus = { clientSet: boolean; loggedIn: boolean; channelTitle: string; state: string; message: string; userCode: string; verificationUri: string };
  const [youtubeAuth, setYoutubeAuth] = useState<YoutubeAuthStatus>({ clientSet: false, loggedIn: false, channelTitle: "", state: "none", message: "", userCode: "", verificationUri: "" });
  const [youtubeAuthBusy, setYoutubeAuthBusy] = useState(false);
  const [youtubeClientIdInput, setYoutubeClientIdInput] = useState("");
  const [youtubeClientSecretInput, setYoutubeClientSecretInput] = useState("");
  const [youtubeClientMsg, setYoutubeClientMsg] = useState<{ text: string; error: boolean } | null>(null);
  // 書き込み用に残す回数 (この回数 × 20 を、取得の間隔の計算で使わずに残す。ログインしているときだけ)
  const [youtubeWriteReserve, setYoutubeWriteReserve] = useState(YOUTUBE_WRITE_RESERVE_DEFAULT);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void invoke<YoutubeAuthStatus>("youtube_auth_status").then((st) => { if (!disposed && st) setYoutubeAuth(st); }).catch((e) => console.warn("youtube_auth_status failed", e));
    void listen<YoutubeAuthStatus>("youtube-auth", (ev) => { if (ev.payload) setYoutubeAuth(ev.payload); })
      .then((u) => { if (disposed) u(); else unlisten = u; })
      .catch((e) => console.warn("youtube-auth listen failed", e));
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const openGoogleDevicePage = (uri: string) => {
    // 開くのは Google の確認ページだけ (Rust 側でも確かめている)
    if (uri !== "https://www.google.com/device" && !uri.startsWith("https://www.google.com/device?")) return;
    void invoke("open_external_url", { url: uri }).catch((e) => console.warn("open_external_url failed", e));
  };
  const saveYoutubeClient = () => {
    const id = youtubeClientIdInput.trim();
    const secret = youtubeClientSecretInput.trim();
    if (!id || !secret) { setYoutubeClientMsg({ text: "クライアント ID とクライアント シークレットの両方を入れてください", error: true }); return; }
    setYoutubeAuthBusy(true);
    void invoke<YoutubeAuthStatus>("youtube_auth_set_client", { clientId: id, clientSecret: secret })
      .then((st) => { setYoutubeAuth(st); setYoutubeClientIdInput(""); setYoutubeClientSecretInput(""); setYoutubeClientMsg({ text: "保存しました (暗号化して保存しています)", error: false }); })
      .catch((e) => setYoutubeClientMsg({ text: String(e), error: true }))
      .finally(() => setYoutubeAuthBusy(false));
  };
  const clearYoutubeClient = () => {
    setAppConfirm({
      title: "YouTube の OAuth クライアント",
      message: "保存したクライアント ID とシークレットを削除しますか?\nログアウトもします (Google 側の許可も取り消します)。",
      buttons: [
        { label: "削除", danger: true, onClick: () => { setYoutubeAuthBusy(true); void invoke<YoutubeAuthStatus>("youtube_auth_clear_client").then((st) => { setYoutubeAuth(st); setYoutubeClientMsg({ text: "削除しました", error: false }); }).catch((e) => setYoutubeClientMsg({ text: String(e), error: true })).finally(() => setYoutubeAuthBusy(false)); } },
        { label: "キャンセル", onClick: () => {} },
      ],
    });
  };
  const startYoutubeLogin = async () => {
    setYoutubeAuthBusy(true);
    try {
      const st = await invoke<YoutubeAuthStatus>("youtube_auth_login");
      setYoutubeAuth(st);
      openGoogleDevicePage(st.verificationUri);
    } catch (e) {
      setYoutubeAuth((prev) => ({ ...prev, state: "error", message: String(e) }));
    } finally { setYoutubeAuthBusy(false); }
  };
  const logoutYoutube = () => {
    setAppConfirm({
      title: "YouTube (Google) からログアウト",
      message: "ログアウトしますか?\nGoogle 側の許可も取り消し、保存したログイン情報を削除します。",
      buttons: [
        { label: "ログアウト", danger: true, onClick: () => { setYoutubeAuthBusy(true); void invoke<YoutubeAuthStatus>("youtube_auth_logout").then((st) => setYoutubeAuth(st)).catch((e) => console.warn("youtube_auth_logout failed", e)).finally(() => setYoutubeAuthBusy(false)); } },
        { label: "キャンセル", onClick: () => {} },
      ],
    });
  };
  // 使用量が 80% / 95% を超えたことを知らせたか (日ごと)
  const youtubeQuotaWarnRef = useRef<{ day: string; level: number }>({ day: "", level: 0 });
  // 設定 > YouTube > イベント (data/youtube-events.json。登録した時点で保存)
  const [youtubeEventSettings, setYoutubeEventSettings] = useState<Record<string, TwitchEventSetting>>(defaultYoutubeEventSettings);
  const youtubeEventSettingsLoadedRef = useRef(false);
  const [youtubeEventTestMsg, setYoutubeEventTestMsg] = useState("");
  useEffect(() => {
    let cancelled = false;
    void loadFromFile<unknown>("youtube-events.json").then((d) => {
      if (cancelled) return;
      if (d && typeof d === "object") setYoutubeEventSettings(sanitizeYoutubeEventSettings((d as { events?: unknown }).events));
      youtubeEventSettingsLoadedRef.current = true;
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (youtubeEventSettingsLoadedRef.current) saveToFile("youtube-events.json", { version: 1, events: youtubeEventSettings });
  }, [youtubeEventSettings]);
  const updateYoutubeEvent = (kind: string, patch: Partial<TwitchEventSetting>) =>
    setYoutubeEventSettings((prev) => ({ ...prev, [kind]: { ...(prev[kind] ?? defaultYoutubeEventSettings()[kind]), ...patch } }));
  useEffect(() => {
    if (!isTauriRuntime()) return;
    void invoke<YoutubeMethod[]>("youtube_methods").then((list) => setYoutubeMethods(Array.isArray(list) ? list : [])).catch((e) => console.warn("youtube_methods failed", e));
    void invoke<boolean>("youtube_key_status").then((v) => setYoutubeKeySet(v === true)).catch((e) => console.warn("youtube_key_status failed", e));
  }, []);
  const saveYoutubeKey = () => {
    const key = youtubeKeyInput.trim();
    if (!key) { setYoutubeKeyMsg({ text: "API キーを入力してください", error: true }); return; }
    void invoke("youtube_set_key", { key })
      .then(() => { setYoutubeKeySet(true); setYoutubeKeyInput(""); setYoutubeKeyMsg({ text: "API キーを保存しました (暗号化して保存しています)", error: false }); setYoutubeSyncVersion((v) => v + 1); })
      .catch((e) => setYoutubeKeyMsg({ text: String(e), error: true }));
  };
  const clearYoutubeKey = () => {
    setAppConfirm({
      title: "YouTube の API キー",
      message: "保存した API キーを削除しますか?\nYouTube のチャットの受信は止まります。",
      buttons: [
        { label: "削除", danger: true, onClick: () => { void invoke("youtube_clear_key").then(() => { setYoutubeKeySet(false); setYoutubeKeyMsg({ text: "API キーを削除しました", error: false }); setYoutubeSyncVersion((v) => v + 1); }).catch((e) => setYoutubeKeyMsg({ text: String(e), error: true })); } },
        { label: "キャンセル", onClick: () => {} },
      ],
    });
  };
  const [threadNgOpen, setThreadNgOpen] = useState(false);
  const [threadNgInput, setThreadNgInput] = useState("");
  const [ngPanelOpen, setNgPanelOpen] = useState(false);
  const [showBoardButtons, setShowBoardButtons] = useState(false);
  // 板タブ・スレタブの左端に、サイトごとの色の線を付ける (色は TchViewer と同じ)
  const [tabSiteColors, setTabSiteColors] = useState(true);
  // タブの幅をそろえる (見た目を整えるため。既定はオン)。板タブ (ビュワー・板未選択を含む) とスレタブで別の幅
  const [tabWidthFixed, setTabWidthFixed] = useState(true);
  const [boardTabWidth, setBoardTabWidth] = useState(TAB_WIDTH_BOARD_DEFAULT);
  const [threadTabWidth, setThreadTabWidth] = useState(TAB_WIDTH_THREAD_DEFAULT);
  const [keepSortOnRefresh, setKeepSortOnRefresh] = useState(false);
  const keepSortOnRefreshRef = useRef(keepSortOnRefresh);
  keepSortOnRefreshRef.current = keepSortOnRefresh;
  const [composeSubmitKey, setComposeSubmitKey] = useState<"shift" | "ctrl">("shift");
  const [imageSizeLimit, setImageSizeLimit] = useState(0); // KB, 0 = unlimited
  const [showImagePreview, setShowImagePreview] = useState(true);
  const [hoverPreviewEnabled, setHoverPreviewEnabled] = useState(false);
  const [hoverPreviewDelay, setHoverPreviewDelay] = useState(0);
  const hoverPreviewDelayRef = useRef(0);
  hoverPreviewDelayRef.current = hoverPreviewDelay;
  const hoverPreviewShowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [thumbSize, setThumbSize] = useState(200);
  const [restoreSession, setRestoreSession] = useState(true);
  const restoreSessionRef = useRef(true);
  // メインウィンドウを常に最背面に表示する(「常に最前面」の逆)。浮遊ウィンドウ・OBS連携ウィンドウ・字幕には適用しない
  const [mainAlwaysOnBottom, setMainAlwaysOnBottom] = useState(false);
  const hoverPreviewEnabledRef = useRef(hoverPreviewEnabled);
  hoverPreviewEnabledRef.current = hoverPreviewEnabled;
  const [boardPaneTab, setBoardPaneTab] = useState<"boards" | "fav-threads">("boards");
  const [showCachedOnly, setShowCachedOnly] = useState(false);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [favNewCounts, setFavNewCounts] = useState<Map<string, number>>(new Map());
  const [favNewCountsFetched, setFavNewCountsFetched] = useState(false);
  const [favSearchQuery, setFavSearchQuery] = useState("");
  const [cachedThreadList, setCachedThreadList] = useState<{ threadUrl: string; title: string; resCount: number }[]>([]);
  const [boardSearchQuery, setBoardSearchQuery] = useState("");
  const [responsesLoading, setResponsesLoading] = useState(false);
  const [ngInput, setNgInput] = useState("");
  const [ngInputType, setNgInputType] = useState<"words" | "ids" | "names" | "mails" | "thread_words" | "image_words" | "regex">("words");
  const [ngWordRegexInput, setNgWordRegexInput] = useState(false);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [autoRefreshInterval, setAutoRefreshInterval] = useState(15);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const autoScrollEnabledRef = useRef(true);
  autoScrollEnabledRef.current = autoScrollEnabled;
  // タブ切替直後、画像・カードの読み込みで高さが変わるあいだレス表示欄を隠す (高さが安定したら表示)
  const [responsePaneSettling, setResponsePaneSettling] = useState(false);
  const responsePaneSettleRunRef = useRef(0);
  // 最下行に追従中の scrollToBottom を止める関数 (ユーザー操作か、別の位置合わせが始まるまで追従する)
  const followBottomCleanupRef = useRef<(() => void) | null>(null);
  const [responseGap, setResponseGap] = useState(10);
  const [smoothScroll, setSmoothScroll] = useState(true);
  const [maxOpenTabs, setMaxOpenTabs] = useState(20);
  const [logRetentionDays, setLogRetentionDays] = useState(7);
  // ブラウザ (WebView2) のディスクキャッシュ上限 (MB)。起動時に Rust 側が settings.ini から読むため再起動後に反映
  const [webviewCacheMb, setWebviewCacheMb] = useState(100);
  const smoothScrollRef = useRef(true);
  smoothScrollRef.current = smoothScroll;
  const maxOpenTabsRef = useRef(20);
  maxOpenTabsRef.current = maxOpenTabs;
  // Proxy settings state
  // 設定 > プロキシ: 受信用 (掲示板の読み込み) と送信用 (書き込み・スレ立て)。「保存」を押した時点で保存して次の通信から使う
  type ProxyEndpoint = { host: string; port: string; username: string; password: string };
  const emptyProxyEndpoint: ProxyEndpoint = { host: "", port: "", username: "", password: "" };
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyType, setProxyType] = useState<"http" | "socks5" | "socks4">("http");
  const [proxyNoCache, setProxyNoCache] = useState(false);
  const [proxyHttpMode, setProxyHttpMode] = useState(false);
  const [proxyReceive, setProxyReceive] = useState<ProxyEndpoint>(emptyProxyEndpoint);
  const [proxySend, setProxySend] = useState<ProxyEndpoint>(emptyProxyEndpoint);
  const [proxyMsg, setProxyMsg] = useState<{ text: string; error: boolean } | null>(null);
  // この PC を指すホスト (2chAPIProxy などのローカルのプロキシ)。http で渡すのはこのときだけ (Rust 側でも同じ検査)
  const isLocalProxyHost = (h: string) => /^(localhost|::1|\[::1\]|127(\.\d{1,3}){3})$/i.test(h.trim());
  const saveProxySettings = () => {
    if (!isTauriRuntime()) return;
    const badPort = [proxyReceive, proxySend].some((e) => e.host.trim() && e.port.trim() && !/^\d{1,5}$/.test(e.port.trim()));
    if (badPort) { setProxyMsg({ text: "ポートは数字で入力してください", error: true }); return; }
    invoke("save_proxy_settings", { settings: { enabled: proxyEnabled, proxyType, noCache: proxyNoCache, httpMode: proxyHttpMode, receive: proxyReceive, send: proxySend } })
      .then(() => setProxyMsg({ text: "保存しました (次の通信から使います)", error: false }))
      .catch((e) => { console.warn("save_proxy_settings:", e); setProxyMsg({ text: `保存できませんでした: ${String(e)}`, error: true }); });
  };
  // ImageViewURLReplace rules
  type UrlReplaceRule = UrlReplaceRuleOpts;
  const [imageUrlRules, setImageUrlRules] = useState<UrlReplaceRule[]>([]);
  // Highlight state
  const [idHighlights, setIdHighlights] = useState<IdHighlightMap>({});
  const [textHighlights, setTextHighlights] = useState<TextHighlight[]>([]);
  // 字幕更新はタイマー経由 (古いレンダーのクロージャ) から呼ばれるため、最新値は ref で参照する
  const idHighlightsRef = useRef<IdHighlightMap>({});
  idHighlightsRef.current = idHighlights;
  const textHighlightsRef = useRef<TextHighlight[]>([]);
  textHighlightsRef.current = textHighlights;
  const [threadSortKey, setThreadSortKey] = useState<"fetched" | "id" | "title" | "res" | "got" | "new" | "lastFetch" | "speed" | "since">("id");
  const [threadSortAsc, setThreadSortAsc] = useState(true);
  const cachedSortOrderRef = useRef<string[]>([]);
  const prevSortSnapshotRef = useRef({ key: "", asc: true, urls: "", favFetched: false });
  const [threadTabs, setThreadTabs] = useState<ThreadTab[]>([]);
  const [activeTabIndex, setActiveTabIndex] = useState(-1);
  const [boardTabs, setBoardTabs] = useState<{boardUrl: string, title: string}[]>([]);
  const [activeBoardTabIndex, setActiveBoardTabIndex] = useState(-1);
  const [activePaneView, setActivePaneView] = useState<"threads" | "responses" | "viewer">("threads");
  const tabCacheRef = useRef<Map<string, { responses: ThreadResponseItem[]; selectedResponse: number; scrollResponseNo?: number; scrollAtBottom?: boolean; newResponseStart?: number | null }>>(new Map());
  const closedTabsRef = useRef<{ threadUrl: string; title: string }[]>([]);
  const [tabRestoreReady, setTabRestoreReady] = useState(false);
  const threadTabsRef = useRef<ThreadTab[]>([]);
  threadTabsRef.current = threadTabs;
  const activeTabIndexRef = useRef(-1);
  activeTabIndexRef.current = activeTabIndex;
  const boardTabsRef = useRef<{boardUrl: string, title: string}[]>([]);
  boardTabsRef.current = boardTabs;
  const activeBoardTabIndexRef = useRef(-1);
  activeBoardTabIndexRef.current = activeBoardTabIndex;
  const lastBoardUrlRef = useRef("");
  const activeBoardUrlRef = useRef("");
  const pendingLastBoardRef = useRef<{ boardName: string; url: string } | null>(null);
  const currentThreadUrlRef = useRef("");
  const [selectedBoard, setSelectedBoard] = useState("Favorite");
  // 選択中スレ・既読管理は threadUrl(不変)をキーにする — 一覧の連番(id)は自動更新のたびに
  // 板の並び替えで別のスレを指すようになり得るため、識別子として使ってはいけない
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [selectedResponse, setSelectedResponse] = useState<number>(1);
  const [threadReadMap, setThreadReadMap] = useState<Record<string, boolean>>({});
  const [threadLastReadCount, setThreadLastReadCount] = useState<Record<string, number>>({});
  const [threadMenu, setThreadMenu] = useState<{ x: number; y: number; threadId: number } | null>(null);
  const [responseMenu, setResponseMenu] = useState<{
    x: number; y: number; responseId: number;
    selection?: string; resId?: string; resName?: string; isOnResNo?: boolean; imageUrl?: string; linkUrl?: string;
  } | null>(null);
  const responseMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setRespSubMenu(null); }, [responseMenu?.responseId, responseMenu?.x, responseMenu?.y]);
  const [hlSubMenu, setHlSubMenu] = useState<{ type: "text" | "id" | "name"; value: string; nearRight?: boolean } | null>(null);
  // レス表示欄の外 (ビュワー・最新レス欄・新着レスペイン・ポップアップなど) のリンクの右クリックメニュー: URLをコピー・コマンド ▶
  const [linkMenu, setLinkMenu] = useState<{ x: number; y: number; url: string; selection?: string } | null>(null);
  // ビュワーの発言・最新レス欄の右クリックメニュー。文字を選べるように、クリックではタブへ移動せず、移動はこのメニューから行う
  const [viewerMenu, setViewerMenu] = useState<{
    x: number; y: number; threadUrl: string; no: number; chat: boolean; title: string; text: string;
    uid?: string; name?: string; selection?: string; linkUrl?: string;
  } | null>(null);
  useEffect(() => { setRespSubMenu(null); setHlSubMenu(null); }, [viewerMenu?.x, viewerMenu?.y]);
  const openViewerMenu = (e: React.MouseEvent<HTMLElement>, it: { source: ViewerSource; threadUrl: string; no: number; title: string; text: string; uid: string; name?: string }) => {
    e.preventDefault();
    const t = e.target as HTMLElement;
    const thumb = t.closest<HTMLElement>("[data-lightbox-src]");
    const a = t.closest<HTMLAnchorElement>("a.body-link");
    const link = thumb?.dataset.lightboxSrc ?? a?.getAttribute("href") ?? "";
    const chat = isChatSource(it.source);
    setViewerMenu({
      x: e.clientX, y: e.clientY, threadUrl: it.threadUrl, no: it.no, chat, title: it.title, text: it.text,
      uid: it.uid || undefined,
      name: it.name ? nameForHighlight(it.name) : undefined,
      selection: window.getSelection()?.toString().trim() || undefined,
      linkUrl: /^https?:\/\//i.test(link) ? link : undefined,
    });
  };
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.(".viewer-item, .viewer-latest-item")) setViewerMenu(null);
      // レス表示欄など、自分の右クリックメニューを出したところは何もしない
      if (e.defaultPrevented) { setLinkMenu(null); return; }
      const thumb = t?.closest?.<HTMLElement>("[data-lightbox-src]");
      const a = t?.closest?.<HTMLAnchorElement>("a.body-link");
      const url = thumb?.dataset.lightboxSrc ?? a?.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(url)) { setLinkMenu(null); return; }
      e.preventDefault();
      setLinkMenu({ x: e.clientX, y: e.clientY, url, selection: window.getSelection()?.toString().trim() || undefined });
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, []);
  // コマンド (設定 > コマンド)。一覧への登録・削除・並べ替えはその場で保存する
  const [userCommands, setUserCommands] = useState<UserCommand[]>([]);
  const [commandMsg, setCommandMsg] = useState("");
  const emptyCommandDraft = { kind: "program" as UserCommand["kind"], name: "", program: "", args: "\"$LINK\"", url: "", confirm: true };
  const [commandDraft, setCommandDraft] = useState(emptyCommandDraft);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    invoke<UserCommand[]>("load_commands").then((list) => setUserCommands(Array.isArray(list) ? list : [])).catch((e) => console.warn("load_commands failed", e));
  }, []);
  const saveUserCommands = (next: UserCommand[]) =>
    invoke("save_commands", { commands: next })
      .then(() => { setUserCommands(next); setCommandMsg(""); return true; })
      .catch((e) => { setCommandMsg(String(e)); return false; });
  const runUserCommand = (c: UserCommand, values: { link?: string; text?: string; url?: string; title?: string; boardName?: string; number?: string }) => {
    const exec = () => {
      invoke("run_command", { id: c.id, values })
        .then(() => setStatus(`コマンド「${c.name}」を実行しました`))
        .catch((e) => setStatus(`コマンド「${c.name}」: ${String(e)}`));
    };
    if (!c.confirm) { exec(); return; }
    // 実行する前に、何をどれで開くかを見せる (見た目の似た別のドメインなどに気づけるように)
    const used: string[] = [];
    if (commandUses(c, "LINK")) used.push(`リンク: ${values.link ?? "(なし)"}`);
    if (commandUses(c, "TEXT") || commandUses(c, "TEXTU") || commandUses(c, "TEXTE")) used.push(`選んだ文字: ${values.text ?? "(なし)"}`);
    if (commandUses(c, "URL")) used.push(`スレの URL: ${values.url ?? "(なし)"}`);
    if (commandUses(c, "TITLE")) used.push(`スレのタイトル: ${values.title ?? "(なし)"}`);
    if (commandUses(c, "BOARDNAME")) used.push(`板の名前: ${values.boardName ?? "(なし)"}`);
    if (commandUses(c, "NUMBER")) used.push(`レス番号: ${values.number ?? "(なし)"}`);
    setAppConfirm({
      title: `コマンド「${c.name}」`,
      message: [c.kind === "program" ? `プログラム: ${c.program}` : `開く URL: ${c.url}`, ...used].join("\n")
        + "\n\n実行しますか? (確認は 設定 > コマンド でコマンドごとにオフにできます)",
      buttons: [
        { label: "実行", primary: true, onClick: exec },
        { label: "キャンセル", onClick: () => {} },
      ],
    });
  };
  // レスの右クリックメニューで開いている「▶」のまとめ (コピー・ハイライト・NG・切り替え・コマンド)
  const [respSubMenu, setRespSubMenu] = useState<string | null>(null);
  // 開いたまとめが画面の下にはみ出すときは上へずらす
  const fitSubMenu = (el: HTMLDivElement | null) => {
    if (!el) return;
    const over = el.getBoundingClientRect().bottom - (window.innerHeight - 4);
    if (over > 0) el.style.top = `${-over}px`;
  };
  const [boardContextMenu, setBoardContextMenu] = useState<{ x: number; y: number; board: BoardEntry } | null>(null);
  // URL バーの右クリックメニュー (貼り付けて移動 / 貼り付け / コピー / すべて選択)
  const [addressMenu, setAddressMenu] = useState<{ x: number; y: number } | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  // 入力欄の共通履歴 (欄ごとのキー → 新しい順・最大 20 件)。input-history.json に保存し datalist の候補として出す
  type InputHistoryKey = "boardSearch" | "favSearch" | "settingsListFilter" | "newThreadSubject" | "newThreadMail";
  const [inputHistory, setInputHistory] = useState<Partial<Record<InputHistoryKey, string[]>>>({});
  const inputHistoryRef = useRef<Partial<Record<InputHistoryKey, string[]>>>({});
  inputHistoryRef.current = inputHistory;
  // 空や 1 文字は記録しない。同じ値は先頭へ移す
  const recordInputHistory = (key: InputHistoryKey, value: string) => {
    const v = value.trim();
    if (v.length < 2) return;
    const prev = inputHistoryRef.current[key] ?? [];
    if (prev[0] === v) return;
    const next = { ...inputHistoryRef.current, [key]: [v, ...prev.filter((x) => x !== v)].slice(0, 20) };
    inputHistoryRef.current = next;
    setInputHistory(next);
    saveToFile("input-history.json", next);
  };
  const inputHistoryDatalist = (key: InputHistoryKey) => (
    <datalist id={`input-history-${key}`}>
      {(inputHistory[key] ?? []).map((v) => <option key={v} value={v} />)}
    </datalist>
  );
  const [aaOverrides, setAaOverrides] = useState<Map<number, boolean>>(new Map());
  const [anchorPopup, setAnchorPopup] = useState<{ x: number; y: number; anchorTop: number; responseIds: number[] } | null>(null);
  const [nestedPopups, setNestedPopups] = useState<{ x: number; y: number; anchorTop: number; responseIds: number[] }[]>([]);
  const [imageSaveFolder, setImageSaveFolder] = useState<string>("");
  const [bbsmenuUrl, setBbsmenuUrl] = useState<string>(DEFAULT_BBSMENU_URL);
  const [shitarabaHost, setShitarabaHost] = useState<string>(DEFAULT_SHITARABA_HOST);
  const [jpnknHost, setJpnknHost] = useState<string>(DEFAULT_JPNKN_HOST);

  // ===== 配信ホワイトリスト (ビュワー・OBS 表示に流す掲示板の ID。当日限り) =====
  const [broadcastWhitelist, setBroadcastWhitelist] = useState<Record<string, true>>({});
  // 配信ホワイトリストは data/viewer-whitelist.json に { date: 日本時間の日付, ids } で保存し、
  // 起動時は日付が今日のときだけ読み込む (5ch の ID は日本時間の0時に変わるため)。
  // 読み込みが終わる前に空の一覧で上書きしないよう、読み込み後にだけ保存する
  const viewerWhitelistLoadedRef = useRef(false);
  const todayJst = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // 自動で追加した ID と、そのきっかけの単語 (今日の分)。今日手で外した ID は自動では入れ直さない
  const [whitelistAuto, setWhitelistAuto] = useState<Record<string, string>>({});
  const [whitelistRemoved, setWhitelistRemoved] = useState<string[]>([]);
  const isValidWhitelistId = (id: string) => id.length > 0 && id.length <= 64 && !/\s/.test(id);
  useEffect(() => {
    let cancelled = false;
    void loadFromFile<{ date?: unknown; ids?: unknown; auto?: unknown; removed?: unknown }>("viewer-whitelist.json").then((d) => {
      if (cancelled) return;
      if (d && d.date === todayJst() && Array.isArray(d.ids)) {
        const map: Record<string, true> = {};
        for (const id of d.ids) if (typeof id === "string" && isValidWhitelistId(id)) map[id] = true;
        setBroadcastWhitelist((prev) => ({ ...map, ...prev }));
        if (d.auto && typeof d.auto === "object") {
          const auto: Record<string, string> = {};
          for (const [id, w] of Object.entries(d.auto as Record<string, unknown>)) if (map[id] && typeof w === "string") auto[id] = w.slice(0, 100);
          setWhitelistAuto(auto);
        }
        if (Array.isArray(d.removed)) setWhitelistRemoved(d.removed.filter((x): x is string => typeof x === "string" && isValidWhitelistId(x)).slice(0, 1000));
      }
      viewerWhitelistLoadedRef.current = true;
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!viewerWhitelistLoadedRef.current) return;
    const ids = Object.keys(broadcastWhitelist);
    const auto: Record<string, string> = {};
    for (const id of ids) if (whitelistAuto[id]) auto[id] = whitelistAuto[id];
    saveToFile("viewer-whitelist.json", { date: todayJst(), ids, auto, removed: whitelistRemoved });
  }, [broadcastWhitelist, whitelistAuto, whitelistRemoved]);
  const addToWhitelist = (ids: string[]) => {
    const valid = ids.map((x) => x.trim().replace(/^ID:/i, "")).filter(isValidWhitelistId);
    if (valid.length === 0) return 0;
    setBroadcastWhitelist((prev) => { const next = { ...prev }; for (const id of valid) next[id] = true; return next; });
    setWhitelistAuto((prev) => { const next = { ...prev }; for (const id of valid) delete next[id]; return next; });
    setWhitelistRemoved((prev) => prev.filter((x) => !valid.includes(x)));
    return valid.length;
  };
  const removeFromWhitelist = (id: string) => {
    setBroadcastWhitelist((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setWhitelistAuto((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setWhitelistRemoved((prev) => (prev.includes(id) ? prev : [...prev, id]));
  };
  // 自動追加: 登録した単語を本文に含むレスが届いたら、その ID を今日のホワイトリストに入れる (掲示板のみ)
  type WhitelistAutoConfig = { enabled: boolean; words: string; limit: number };
  const [whitelistAutoConfig, setWhitelistAutoConfig] = useState<WhitelistAutoConfig>({ enabled: false, words: "", limit: 20 });
  const whitelistAutoLoadedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void loadFromFile<Partial<WhitelistAutoConfig>>("viewer-autoadd.json").then((d) => {
      if (cancelled) return;
      if (d && typeof d === "object") {
        setWhitelistAutoConfig({
          enabled: d.enabled === true,
          words: typeof d.words === "string" ? d.words.slice(0, 20000) : "",
          limit: typeof d.limit === "number" && Number.isFinite(d.limit) ? Math.max(1, Math.min(100, Math.round(d.limit))) : 20,
        });
      }
      whitelistAutoLoadedRef.current = true;
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (whitelistAutoLoadedRef.current) saveToFile("viewer-autoadd.json", whitelistAutoConfig);
  }, [whitelistAutoConfig]);
  const broadcastWhitelistRef = useRef<Record<string, true>>({});
  broadcastWhitelistRef.current = broadcastWhitelist;
  const hoverPreviewRef = useRef<HTMLDivElement | null>(null);
  const hoverPreviewImgRef = useRef<HTMLImageElement | null>(null);
  const hoverPreviewSrcRef = useRef<string | null>(null);
  const hoverPreviewZoomRef = useRef(100);
  const hoverPreviewHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [boardBtnDragIndex, setBoardBtnDragIndex] = useState<number | null>(null);
  const boardBtnDragRef = useRef<{ srcIndex: number; startX: number } | null>(null);
  const boardBtnDragOverRef = useRef<number | null>(null);
  const boardBtnBarRef = useRef<HTMLDivElement>(null);
  const favDragRef = useRef<{ type: "board" | "thread"; srcIndex: number; startY: number } | null>(null);
  const [favDragState, setFavDragState] = useState<{ type: "board" | "thread"; srcIndex: number; overIndex: number | null } | null>(null);
  const [tabDragIndex, setTabDragIndex] = useState<number | null>(null);
  const tabDragSuppressClickRef = useRef(false);
  const [boardTabDragIndex, setBoardTabDragIndex] = useState<number | null>(null);
  const boardTabDragSuppressClickRef = useRef(false);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabIndex: number } | null>(null);
  const [responseReloadMenuOpen, setResponseReloadMenuOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  type SettingsCategory = "display" | "posting" | "tts" | "tts-dict" | "proxy" | "ng" | "subtitle" | "highlights" | "presets" | "reset" | "info" | "twitch" | "youtube" | "viewer" | "connect" | "commands";
  const SETTINGS_CATEGORIES: SettingsCategory[] = ["display", "posting", "tts", "tts-dict", "ng", "highlights", "subtitle", "connect", "twitch", "youtube", "viewer", "commands", "proxy", "presets", "reset", "info"];
  const SETTINGS_CATEGORY_LABELS: Record<SettingsCategory, string> = { display: "表示", posting: "書き込み", tts: "読み上げ", "tts-dict": "読み上げ辞書", subtitle: "字幕", proxy: "プロキシ", ng: "NG", highlights: "ハイライト", presets: "プリセット", reset: "リセット", info: "情報", twitch: "Twitch", youtube: "YouTube", viewer: "ビュワー", connect: "接続", commands: "コマンド" };
  // 設定画面の保存まわりの状態 (詳細は「設定画面の保存 / 復元 / リセット / プリセット」の節)
  const settingsOpenRef = useRef(false);
  settingsOpenRef.current = settingsOpen;
  const [settingsSnapshot, setSettingsSnapshot] = useState<{ layout: Record<string, unknown>; app: Record<string, string> } | null>(null);
  const defaultLayoutPrefsRef = useRef<Record<string, unknown> | null>(null);
  const defaultAppSettingsRef = useRef<Record<string, string> | null>(null);
  type AppConfirm = { title?: string; message: string; buttons: { label: string; onClick: () => void; primary?: boolean; danger?: boolean }[] };
  const [appConfirm, setAppConfirm] = useState<AppConfirm | null>(null);
  // 確認ダイアログのキー操作: Enter で決定 (取り消しのきかないボタン (danger) だけのときは決定しない)・Esc でキャンセル。
  // ダイアログを出したキーの押しっぱなし (Ctrl+Enter の長押しなど) では決定しない
  useEffect(() => {
    if (!appConfirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setAppConfirm(null);
        return;
      }
      if (e.key === "Enter" && !e.repeat && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        const primary = appConfirm.buttons.find((b) => b.primary && !b.danger);
        if (!primary) return;
        setAppConfirm(null);
        primary.onClick();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [appConfirm]);
  // 「情報」タブのサードパーティライセンス表示。本文 (public/THIRD_PARTY_LICENSES.txt、約600KB) は初回に開いたときだけ読み込む
  const [licensesOpen, setLicensesOpen] = useState(false);
  const [licensesText, setLicensesText] = useState<string | null>(null);
  const openThirdPartyLicenses = () => {
    setLicensesOpen(true);
    if (licensesText !== null) return;
    fetch("/THIRD_PARTY_LICENSES.txt")
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((text) => setLicensesText(text))
      .catch((e) => { console.warn("third-party licenses load failed", e); setLicensesText("ライセンス一覧を読み込めませんでした。配布ZIPに同梱の THIRD_PARTY_LICENSES.txt を参照してください。"); });
  };
  // 分類内の節タブ (項目が多い分類だけ)。1 頁を短く保ち、関連する設定を同じ場所にまとめる (REQUIREMENTS 13 章)
  const SETTINGS_SECTIONS: Record<SettingsCategory, { id: string; label: string }[]> = {
    display: [
      { id: "general", label: "全般" }, { id: "response", label: "レス表示" }, { id: "image", label: "画像" },
      { id: "cards", label: "リンクカード" }, { id: "arrival", label: "新着レスペイン" }, { id: "popup", label: "ポップアップ" },
    ],
    posting: [],
    tts: [],
    "tts-dict": [{ id: "dict", label: "辞書" }, { id: "allow", label: "許可リスト" }, { id: "mute", label: "読み上げない辞書" }],
    subtitle: [{ id: "view", label: "表示" }, { id: "frame", label: "枠・大きさ" }, { id: "cards", label: "カード" }, { id: "scroll", label: "スクロール" }],
    proxy: [],
    ng: [{ id: "words", label: "ワード" }, { id: "ids", label: "ID" }, { id: "names", label: "名前" }, { id: "mails", label: "メール" }, { id: "thread_words", label: "スレタイ" }, { id: "image_words", label: "画像NG" }, { id: "invisible", label: "見えない文字" }],
    highlights: [{ id: "word", label: "ワード" }, { id: "name", label: "名前" }, { id: "id", label: "ID" }],
    presets: [],
    reset: [],
    info: [],
    twitch: [{ id: "main", label: "受信・読み上げ" }, { id: "emotes", label: "スタンプ・バッジ" }, { id: "events", label: "イベント" }, { id: "teach", label: "教育・忘却" }, { id: "login", label: "ログイン" }],
    youtube: [{ id: "main", label: "受信" }, { id: "quota", label: "使用量・間隔" }, { id: "write", label: "書き込み" }, { id: "tts", label: "読み上げ" }, { id: "events", label: "イベント" }],
    connect: [],
    commands: [],
    viewer: [{ id: "display", label: "表示" }, { id: "whitelist", label: "ホワイトリスト" }, { id: "obs", label: "OBS 表示" }],
  };
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("display");
  const [settingsSection, setSettingsSection] = useState("");
  const [settingsQuery, setSettingsQuery] = useState("");
  // 検索語の履歴 (新しい順・最大 20 件)。Enter か検索結果の見出しクリックで確定したものだけ残す
  const [settingsSearchHistory, setSettingsSearchHistory] = useState<string[]>([]);
  const pushSettingsSearchHistory = (q: string) => {
    const v = q.trim();
    if (!v) return;
    setSettingsSearchHistory((prev) => [v, ...prev.filter((x) => x !== v)].slice(0, 20));
  };
  const [settingsListFilter, setSettingsListFilter] = useState("");
  const settingsContentRef = useRef<HTMLDivElement | null>(null);
  const settingsSearching = settingsQuery.trim().length > 0;
  const settingsSectionsFor = (cat: SettingsCategory) => SETTINGS_SECTIONS[cat];
  const settingsActiveSection = (() => {
    const secs = SETTINGS_SECTIONS[settingsCategory];
    if (secs.length === 0) return "main";
    return secs.some((x) => x.id === settingsSection) ? settingsSection : secs[0].id;
  })();
  // 検索結果表示のときだけ出る見出し「分類 › 節」。クリックでその場所へ移動
  const settingsSectionHeading = (cat: SettingsCategory, sid: string) => {
    const sec = SETTINGS_SECTIONS[cat].find((x) => x.id === sid);
    const label = sec ? `${SETTINGS_CATEGORY_LABELS[cat]} › ${sec.label}` : SETTINGS_CATEGORY_LABELS[cat];
    return (
      <div className="settings-section-heading" hidden={!settingsSearching} onClick={() => { pushSettingsSearchHistory(settingsQuery); setSettingsQuery(""); setSettingsCategory(cat); setSettingsSection(sid); setSettingsListFilter(""); }} title="この場所へ移動">
        {label}
      </div>
    );
  };
  // 一覧 (辞書・NG・ハイライト) の絞り込み。設定検索とは別で、登録内容だけを対象にする
  const settingsListMatch = (...values: string[]) => {
    const q = settingsListFilter.trim().toLowerCase();
    if (!q) return true;
    return values.some((v) => (v ?? "").toLowerCase().includes(q));
  };
  const settingsListFilterRow = () => (
    <div className="settings-row settings-list-filter" data-search-exclude="1">
      <input type="search" value={settingsListFilter} onChange={(e) => setSettingsListFilter(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") recordInputHistory("settingsListFilter", settingsListFilter); }}
        onBlur={() => recordInputHistory("settingsListFilter", settingsListFilter)}
        list="input-history-settingsListFilter" placeholder="一覧を絞り込み" className="lf-w200" />
      {inputHistoryDatalist("settingsListFilter")}
      {settingsListFilter && <button onClick={() => setSettingsListFilter("")}>クリア</button>}
    </div>
  );
  // OGP リンクカード / X ポストカード (既定 OFF: 本文中の URL 先へ通信するため明示的に有効化してもらう)
  const [ogpCardsEnabled, setOgpCardsEnabled] = useState(false);
  const [tweetCardsEnabled, setTweetCardsEnabled] = useState(false);
  const [ogpDomainFilters, setOgpDomainFilters] = useState<OgpDomainFilters>({ allow: [], block: [] });
  const ogpCardsEnabledRef = useRef(false);
  ogpCardsEnabledRef.current = ogpCardsEnabled;
  const tweetCardsEnabledRef = useRef(false);
  tweetCardsEnabledRef.current = tweetCardsEnabled;
  const ogpDomainFiltersRef = useRef<OgpDomainFilters>({ allow: [], block: [] });
  ogpDomainFiltersRef.current = ogpDomainFilters;
  const [ogpDomainInput, setOgpDomainInput] = useState("");
  const ogpCacheRef = useRef<Map<string, OgpCardData | null>>(new Map());
  const ogpInflightRef = useRef<Map<string, Promise<OgpCardData | null>>>(new Map());
  const tweetCacheRef = useRef<Map<string, TweetCardData | null>>(new Map());
  const tweetInflightRef = useRef<Map<string, Promise<TweetCardData | null>>>(new Map());
  // 【試験・採否未定】新着レスペインと字幕ウィンドウにもカードを出す (診断モードの設定からのみ ON にできる)。
  // OFF なら従来どおりの表示 (本文プレーンテキスト / 字幕は画像なし)。不採用なら arrivalCardsEnabled 関連を丸ごと削除すればよい。
  const [arrivalCardsEnabled, setArrivalCardsEnabled] = useState(false);
  const arrivalCardsEnabledRef = useRef(false);
  arrivalCardsEnabledRef.current = arrivalCardsEnabled;
  // 新着アイテム用の本文 (タグ除去)。従来は 200 文字で切るが、カード試験中は URL が途中で切れないよう長めに取る
  // 字幕ウィンドウにもカードを表示 (新着ペインとは独立に選択できる)
  const [subtitleCardsEnabled, setSubtitleCardsEnabled] = useState(false);
  const subtitleCardsEnabledRef = useRef(false);
  subtitleCardsEnabledRef.current = subtitleCardsEnabled;
  // ヘッダ項目の表示/非表示 (レス表示欄 / 新着レスペイン / 字幕)。非表示の項目は詰めて左寄せ
  type HeaderVis = { threadTitle: boolean; resNo: boolean; name: boolean; mail: boolean; watchoi: boolean; date: boolean; id: boolean; count: boolean; badges: boolean };
  const DEFAULT_HEADER_VIS: HeaderVis = { threadTitle: true, resNo: true, name: true, mail: true, watchoi: true, date: true, id: true, count: true, badges: true };
  const sanitizeHeaderVis = (v: unknown): HeaderVis => {
    const o = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof HeaderVis, unknown>>;
    const b = (x: unknown) => (typeof x === "boolean" ? x : true);
    return { threadTitle: b(o.threadTitle), resNo: b(o.resNo), name: b(o.name), mail: b(o.mail), watchoi: b(o.watchoi), date: b(o.date), id: b(o.id), count: b(o.count), badges: b(o.badges) };
  };
  const [mainHeaderVis, setMainHeaderVis] = useState<HeaderVis>(DEFAULT_HEADER_VIS);
  const [arrivalHeaderVis, setArrivalHeaderVis] = useState<HeaderVis>(DEFAULT_HEADER_VIS);
  const [subtitleHeaderVis, setSubtitleHeaderVis] = useState<HeaderVis>(DEFAULT_HEADER_VIS);
  const subtitleHeaderVisRef = useRef<HeaderVis>(DEFAULT_HEADER_VIS);
  subtitleHeaderVisRef.current = subtitleHeaderVis;
  // レス表示欄のヘッダ項目が全て非表示ならレスの境目が分からないので罫線を引く (no-header)。常に罫線を引く設定もある
  const mainHeaderAllHidden = !mainHeaderVis.resNo && !mainHeaderVis.name && !mainHeaderVis.mail && !mainHeaderVis.watchoi && !mainHeaderVis.date && !mainHeaderVis.id && !mainHeaderVis.count;
  const [responseDividerAlways, setResponseDividerAlways] = useState(false);
  const headerVisRows = (vis: HeaderVis, set: (next: HeaderVis) => void, opts: { threadTitle?: boolean; watchoi?: boolean; badges?: boolean }) => {
    const items: Array<[keyof HeaderVis, string]> = [
      ...(opts.threadTitle ? ([["threadTitle", "スレ名"]] as Array<[keyof HeaderVis, string]>) : []),
      ["resNo", "レス番号"], ["name", "名前"], ["mail", "メール欄"],
      ...(opts.watchoi ? ([["watchoi", "ワッチョイ"]] as Array<[keyof HeaderVis, string]>) : []),
      ["date", "投稿日時"], ["id", "ID"], ["count", "書き込み回数"],
      ...(opts.badges ? ([["badges", "Twitch のバッジ"]] as Array<[keyof HeaderVis, string]>) : []),
    ];
    return (
      <div className="lf-d-flex-fwrap-wrap-gap2-10-fs11">
        {items.map(([key, label]) => (
          <label key={key} className="lf-d-flex-ai-center-gap2">
            <input type="checkbox" checked={vis[key]} onChange={(e) => set({ ...vis, [key]: e.target.checked })} />
            {label}
          </label>
        ))}
      </div>
    );
  };
  // 新着送りの一時停止 (字幕の手動スクロールで停止、▶ で再開)
  const [arrivalPaused, setArrivalPaused] = useState(false);
  const arrivalPausedRef = useRef(false);
  const advanceToNextArrivalRef = useRef<() => void>(() => {});
  // スレ内でのその ID の書き込み順と総数 (レス表示欄の (n/回数) と同じ数え方)。
  // 呼び出し元が持っている最新のレス一覧 (rows) から数える。無ければ取得済みレスのキャッシュから数える
  const idStatsFor = (threadUrlForStats: string, responseNo: number, id: string, rowsIn?: { responseNo: number; dateAndId: string }[]): { seq: number; count: number } => {
    if (!id) return { seq: 0, count: 0 };
    const rows = rowsIn ?? tabCacheRef.current.get(threadUrlForStats)?.responses ?? [];
    let seq = 0;
    let count = 0;
    for (const r of rows) {
      const m = r.dateAndId.match(/ID:(\S+)/);
      if (m && m[1] === id) {
        count++;
        if (r.responseNo <= responseNo) seq++;
      }
    }
    return { seq: Math.max(1, seq), count: Math.max(1, count) };
  };
  // したらばの古いキャッシュ (ID 無し) を全件取り直したスレ (スレごとに 1 回だけ)
  const idRefetchDoneRef = useRef<Set<string>>(new Set());
  // したらばの古いキャッシュ (ID 無し) 判定。read.cgi 経由で取り直せば ID が付く
  const cacheLacksIds = (url: string, rows: { dateAndId: string }[]): boolean =>
    rows.length > 0 && detectSiteType(url) === "shitaraba" && !rows.some((r) => /ID:\S/.test(r.dateAndId));
  // 新着レスペイン / 字幕に流す 1 件を作る (ヘッダはレス表示欄と同じ情報を持つ)
  const makeArrival = (r: { responseNo: number; name: string; mail: string; dateAndId: string; body: string }, threadTitle: string, threadUrlForItem: string, rows?: { responseNo: number; dateAndId: string }[]): ArrivalItem => {
    const idMatch = r.dateAndId.match(/ID:(\S+)/);
    const id = idMatch ? idMatch[1] : "";
    const stats = idStatsFor(threadUrlForItem, r.responseNo, id, rows);
    const ngHit = getNgResult({ name: r.name, mail: r.mail, time: r.dateAndId, text: r.body.replace(/<[^>]*>/g, "") }, threadUrlForItem);
    const isAbone = ngHit?.mode === "abone";
    return {
      threadTitle,
      responseNo: r.responseNo,
      name: isAbone ? "あぼ～ん" : r.name.replace(/<[^>]+>/g, ""),
      mail: isAbone ? "あぼ～ん" : (r.mail || ""),
      id,
      time: isAbone ? "あぼ～ん" : r.dateAndId.replace(/\s+ID:\S+/g, "").replace(/\s+BE[:：]\d+[^\s]*/gi, "").trim(),
      text: isAbone ? "あぼ～ん" : arrivalBodyText(r.body),
      plain: isAbone ? "あぼ～ん" : decodeHtmlEntities(r.body.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")).trim().slice(0, 5000),
      threadUrl: threadUrlForItem,
      idSeq: stats.seq,
      idCount: stats.count,
      isAbone,
    };
  };
  const arrivalBodyText = (body: string): string => body.replace(/<[^>]*>/g, "").slice(0, (arrivalCardsEnabledRef.current || subtitleCardsEnabledRef.current) ? 2000 : 200);
  // 新着ペイン / 字幕の自動スクロール設定 (既定は従来の固定値: 収まる=5秒, 待ち=2秒, 8ms/px, 到達後=5秒)
  type ScrollTiming = { fitSec: number; waitSec: number; msPerPx: number; holdSec: number };
  const DEFAULT_SCROLL_TIMING: ScrollTiming = { fitSec: 5, waitSec: 2, msPerPx: 8, holdSec: 5 };
  const sanitizeScrollTiming = (v: unknown): ScrollTiming => {
    const o = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof ScrollTiming, unknown>>;
    const num = (x: unknown, def: number, min: number, max: number) =>
      typeof x === "number" && Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def;
    return { fitSec: num(o.fitSec, 5, 0, 120), waitSec: num(o.waitSec, 2, 0, 20), msPerPx: num(o.msPerPx, 8, 1, 100), holdSec: num(o.holdSec, 5, 0, 120) };
  };
  const [arrivalTiming, setArrivalTiming] = useState<ScrollTiming>(DEFAULT_SCROLL_TIMING);
  const arrivalTimingRef = useRef<ScrollTiming>(DEFAULT_SCROLL_TIMING);
  arrivalTimingRef.current = arrivalTiming;
  const [subtitleTiming, setSubtitleTiming] = useState<ScrollTiming>(DEFAULT_SCROLL_TIMING);
  const subtitleTimingRef = useRef<ScrollTiming>(DEFAULT_SCROLL_TIMING);
  subtitleTimingRef.current = subtitleTiming;

  // ===== ビュワー (Twitch のチャットと、配信ホワイトリストの ID のレスをまとめて流す) =====
  // 板タブの左端に固定で置く。新着の経路 (掲示板の自動更新・裏のタブの巡回・Twitch の受信) はすべてここを通る
  type ViewerSource = "twitch" | "youtube" | "5ch" | "shitaraba" | "jpnkn";
  // Twitch・YouTube のチャット (掲示板のレスと違い、すべてビュワー・OBS 表示に流す。番号・ID は出さない)
  const isChatSource = (src: ViewerSource) => src === "twitch" || src === "youtube";
  // board: 板の名前 / where: スレタイ (Twitch・YouTube はチャンネル) / mail・idSeq・idCount: 掲示板のレスの見出し用
  type ViewerItem = { seq: number; source: ViewerSource; site: string; board?: string; where: string; threadUrl: string; no: number; name: string; mail?: string; uid: string; time: string; text: string; color: string; idSeq?: number; idCount?: number;
    event?: { kind: string; label: string; summary: string };
    badges?: TwitchBadge[];
    // Twitch のスタンプ・YouTube の絵文字 (text の中の位置)
    emotes?: TwitchEmote[];
    giant?: boolean;
    // 後で消すときの目印 (YouTube で削除された発言)
    key?: string };
  // Twitch の視聴者の名前の色 (ログイン名 → #RRGGBB)。受信のたびに更新し、ビュワー・OBS 表示で使う
  const twitchColorRef = useRef<Map<string, string>>(new Map());
  const VIEWER_MAX_ITEMS = 500;
  const VIEWER_SITE_LABEL: Record<ViewerSource, string> = { twitch: "Twitch", youtube: "YouTube", "5ch": "5ch", shitaraba: "したらば", jpnkn: "JPNKN" };
  const [viewerItems, setViewerItems] = useState<ViewerItem[]>([]);
  const viewerSeqRef = useRef(0);
  const [viewerFilter, setViewerFilter] = useState<Record<ViewerSource, boolean>>({ twitch: true, youtube: true, "5ch": true, shitaraba: true, jpnkn: true });
  const [viewerAutoScroll, setViewerAutoScroll] = useState(true);
  // 開いているスレのレスをすべてビュワーに流す (オフのときは配信ホワイトリストの ID のレスだけ)。
  // OBS 表示へは今までどおりチャットとホワイトリストの ID のレスだけを送る。オンのあいだは「スレの最新レス」の欄に追加しない
  const [viewerAllResponses, setViewerAllResponses] = useState(false);
  const viewerAllResponsesRef = useRef(false);
  viewerAllResponsesRef.current = viewerAllResponses;
  // ビュワー (と最新レス欄) の文字。フォントは空ならアプリ全体のフォント、大きさは 0 ならレスの文字サイズに連動
  const [viewerFontFamily, setViewerFontFamily] = useState("");
  const [viewerFontPickerInput, setViewerFontPickerInput] = useState("");
  const [viewerFontPickerOpen, setViewerFontPickerOpen] = useState(false);
  const [viewerFontSize, setViewerFontSize] = useState(0);
  const [viewerFontBold, setViewerFontBold] = useState(false);
  // ビュワーのリンクカード・画像サムネイル (OBS 表示には出さない)。Twitch のチャットはクリックで読み込むようにもできる
  const [viewerCards, setViewerCards] = useState(true);
  const [viewerThumbs, setViewerThumbs] = useState(true);
  const [viewerTwitchClickToLoad, setViewerTwitchClickToLoad] = useState(false);
  const [viewerRevealed, setViewerRevealed] = useState<Set<number>>(() => new Set());
  const URL_IN_TEXT_RE = /(?:https?|ttps?):\/\//i;
  // ビュワー (と最新レス欄) の見出しに出す項目
  // ビュワーの見出しに出す項目 (掲示板のレス: プラットフォーム・板・スレタイ・レス番・名前・メール欄・日時・ID・書き込み回数の順。
  // Twitch・YouTube のチャットは今までどおり プラットフォーム・チャンネル・バッジ・名前・ID・日時)
  type ViewerShow = { site: boolean; board: boolean; where: boolean; no: boolean; name: boolean; mail: boolean; time: boolean; id: boolean; count: boolean; badges: boolean };
  const VIEWER_SHOW_LABELS: [keyof ViewerShow, string][] = [
    ["site", "プラットフォーム (Twitch / YouTube / 5ch / したらば / JPNKN)"], ["board", "板"], ["where", "スレタイ (Twitch・YouTube ではチャンネル)"], ["no", "レス番"],
    ["name", "名前"], ["mail", "メール欄"], ["time", "日時"], ["id", "ID"], ["count", "書き込み回数"], ["badges", "Twitch のバッジ"],
  ];
  const [viewerShow, setViewerShow] = useState<ViewerShow>({ site: true, board: true, where: true, no: true, name: true, mail: true, time: true, id: true, count: true, badges: true });
  // ビュワーの下の「スレの最新レス」欄に出す項目 (板・スレタイ・レス番・本文・日時・ID・書き込み回数の順。1行に収まらないときは本文を省く)
  type LatestShow = { board: boolean; title: boolean; no: boolean; text: boolean; time: boolean; id: boolean; count: boolean };
  const LATEST_SHOW_LABELS: [keyof LatestShow, string][] = [["board", "板"], ["title", "スレタイ"], ["no", "レス番"], ["text", "本文"], ["time", "日時"], ["id", "ID"], ["count", "書き込み回数"]];
  const [latestShow, setLatestShow] = useState<LatestShow>({ board: true, title: true, no: true, text: true, time: true, id: true, count: true });
  // 書き込み回数の色 (スレのタブと同じ: 2回以上で青系・5回以上で赤系)
  const idCountClass = (n: number) => (n >= 5 ? " id-count-many" : n >= 2 ? " id-count-some" : "");
  // ビュワーの下の「スレの最新レス」欄: 開いているスレの新着のうち、配信ホワイトリストに無い ID のもの (OBS には出さない)
  type LatestItem = { seq: number; source: ViewerSource; site: string; board: string; title: string; threadUrl: string; no: number; uid: string; time: string; text: string; idSeq: number; idCount: number;
    // 本文の全文 (text は1行に縮めた表示用。右クリックの「本文をコピー」で使う)
    body: string };
  const LATEST_MAX_ITEMS = 300;
  const [latestItems, setLatestItems] = useState<LatestItem[]>([]);
  const [latestPanelOpen, setLatestPanelOpen] = useState(true);
  // 最新レス欄の高さ (px)。欄の上端をドラッグして変える
  const [latestPanelHeight, setLatestPanelHeight] = useState(180);
  const beginLatestResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = latestPanelHeight;
    const body = (e.currentTarget as HTMLElement).closest(".right-body") as HTMLElement | null;
    const maxH = Math.max(100, (body?.clientHeight ?? 600) - 150);
    const onMove = (mv: MouseEvent) => setLatestPanelHeight(Math.round(Math.max(60, Math.min(maxH, startH + (mv.clientY - startY)))));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  const [whitelistInput, setWhitelistInput] = useState("");
  const submitWhitelistInput = () => {
    const parts = whitelistInput.split(/[\s,、]+/).filter(Boolean);
    const n = addToWhitelist(parts);
    setStatus(n > 0 ? `配信ホワイトリストに ${n} 件追加しました` : "ID の形式が正しくありません (空白を含まない64文字以内)");
    if (n > 0) setWhitelistInput("");
  };
  const latestListRef = useRef<HTMLDivElement | null>(null);
  const viewerListRef = useRef<HTMLDivElement | null>(null);
  // OBS 表示 (ブラウザソース): 既定はオフ。オンの間だけ 127.0.0.1:ポート で待ち受ける
  const [overlayEnabled, setOverlayEnabled] = useState(false);
  const overlayEnabledRef = useRef(false);
  overlayEnabledRef.current = overlayEnabled;
  const [overlayPort, setOverlayPort] = useState(OVERLAY_PORT_DEFAULT);
  const [overlayStatus, setOverlayStatus] = useState("");
  const [overlayLayouts, setOverlayLayouts] = useState<Record<string, OverlayLayoutData>>({ [OVERLAY_DEFAULT_LAYOUT]: { appearance: DEFAULT_OVERLAY_APPEARANCE, css: "" } });
  const [overlayEditingLayout, setOverlayEditingLayout] = useState(OVERLAY_DEFAULT_LAYOUT);
  const [overlayLayoutNameInput, setOverlayLayoutNameInput] = useState("");
  // レイアウト操作のメッセージ (設定画面の中に出す。ステータスバーは設定画面に隠れて見えないため)
  const [overlayLayoutMsg, setOverlayLayoutMsg] = useState<{ text: string; error: boolean } | null>(null);
  const overlayAppearanceLoadedRef = useRef(false);
  const editingLayout = overlayLayouts[overlayEditingLayout] ?? overlayLayouts[OVERLAY_DEFAULT_LAYOUT] ?? { appearance: DEFAULT_OVERLAY_APPEARANCE, css: "" };
  // 見た目の各項目は、プルダウンで選んでいるレイアウトを編集する
  const overlayAppearance = editingLayout.appearance;
  const setOverlayAppearance = (fn: (p: OverlayAppearance) => OverlayAppearance) => {
    setOverlayLayouts((prev) => {
      const cur = prev[overlayEditingLayout] ?? { appearance: DEFAULT_OVERLAY_APPEARANCE, css: "" };
      return { ...prev, [overlayEditingLayout]: { ...cur, appearance: fn(cur.appearance) } };
    });
  };
  const setOverlayLayoutCss = (css: string) => {
    setOverlayLayouts((prev) => {
      const cur = prev[overlayEditingLayout] ?? { appearance: DEFAULT_OVERLAY_APPEARANCE, css: "" };
      return { ...prev, [overlayEditingLayout]: { ...cur, css: css.slice(0, OVERLAY_CSS_MAX_CHARS) } };
    });
  };
  const overlayUrl = `http://127.0.0.1:${overlayPort}/overlay.html${overlayEditingLayout === OVERLAY_DEFAULT_LAYOUT ? "" : `?layout=${encodeURIComponent(overlayEditingLayout)}`}`;
  // 名前を入れずに「新規」「複製」を押したときの名前 (「レイアウト 1」「配信B のコピー」「配信B のコピー 2」…)
  const autoOverlayLayoutName = (copyFrom: string | null) => {
    const names = Object.keys(overlayLayouts);
    const base = copyFrom ? `${Array.from(copyFrom).slice(0, 30).join("")} のコピー` : "レイアウト";
    if (copyFrom && !names.includes(base)) return base;
    for (let i = copyFrom ? 2 : 1; i < 1000; i++) {
      const n = `${base} ${i}`;
      if (!names.includes(n)) return n;
    }
    return base;
  };
  const addOverlayLayout = (copyFrom: string | null) => {
    const name = overlayLayoutNameInput.trim() || autoOverlayLayoutName(copyFrom);
    const err = overlayLayoutNameError(name, Object.keys(overlayLayouts));
    if (err) { setOverlayLayoutMsg({ text: err, error: true }); return; }
    if (Object.keys(overlayLayouts).length >= 50) { setOverlayLayoutMsg({ text: "レイアウトは50個までです", error: true }); return; }
    setOverlayLayoutMsg({ text: copyFrom ? `「${copyFrom}」を「${name}」として複製しました` : `レイアウト「${name}」を作りました`, error: false });
    const base = copyFrom ? overlayLayouts[copyFrom] : undefined;
    setOverlayLayouts((prev) => ({ ...prev, [name]: base ? { appearance: base.appearance, css: base.css } : { appearance: DEFAULT_OVERLAY_APPEARANCE, css: "" } }));
    setOverlayEditingLayout(name);
    setOverlayLayoutNameInput("");
  };
  const renameOverlayLayout = () => {
    if (overlayEditingLayout === OVERLAY_DEFAULT_LAYOUT) { setOverlayLayoutMsg({ text: "「標準」の名前は変えられません", error: true }); return; }
    const name = overlayLayoutNameInput.trim();
    if (!name) { setOverlayLayoutMsg({ text: "新しい名前を入力してから「名前を変更」を押してください", error: true }); return; }
    const err = overlayLayoutNameError(name, Object.keys(overlayLayouts));
    if (err) { setOverlayLayoutMsg({ text: err, error: true }); return; }
    setOverlayLayoutMsg({ text: `「${overlayEditingLayout}」を「${name}」に変更しました`, error: false });
    setOverlayLayouts((prev) => {
      const next: Record<string, OverlayLayoutData> = {};
      for (const [k, v] of Object.entries(prev)) next[k === overlayEditingLayout ? name : k] = v;
      return next;
    });
    setOverlayEditingLayout(name);
    setOverlayLayoutNameInput("");
  };
  const deleteOverlayLayout = () => {
    if (overlayEditingLayout === OVERLAY_DEFAULT_LAYOUT) { setOverlayLayoutMsg({ text: "「標準」は削除できません", error: true }); return; }
    const target = overlayEditingLayout;
    setAppConfirm({
      title: "レイアウトの削除",
      message: `レイアウト「${target}」を削除しますか?\nOBS でこのレイアウトを使っているソースは「標準」の見た目になります。`,
      buttons: [
        { label: "削除", danger: true, onClick: () => { setOverlayLayouts((prev) => { const next = { ...prev }; delete next[target]; return next; }); setOverlayEditingLayout(OVERLAY_DEFAULT_LAYOUT); setOverlayLayoutMsg({ text: `レイアウト「${target}」を削除しました`, error: false }); } },
        { label: "キャンセル", onClick: () => {} },
      ],
    });
  };
  // 板・スレの URL → 板を見分ける印 (5ch は板の英字の名前、したらばは カテゴリ/番号、JPNKN は板の英字の名前)
  const boardKeyOfUrl = (url: string): string | null => {
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    const host = u.hostname.toLowerCase();
    const seg = u.pathname.split("/").filter(Boolean);
    if (host === "jbbs.shitaraba.net" || host === "jbbs.livedoor.jp") {
      const rest = seg[0] === "bbs" ? seg.slice(2) : seg;
      return rest.length >= 2 ? `s:${rest[0]}/${rest[1]}` : null;
    }
    const dir = seg[0] === "test" ? seg[2] : seg[0];
    if (!dir) return null;
    return host === "bbs.jpnkn.com" ? `j:${dir}` : `5:${dir}`;
  };
  // 板の名前 (板一覧・外部板・お気に入りの板・板タブから引く。見つからなければ板の英字の名前)
  const boardNameMap = useMemo(() => {
    const m = new Map<string, string>();
    const add = (url: string, name: string) => { const k = boardKeyOfUrl(url); if (k && name && !m.has(k)) m.set(k, name); };
    for (const c of boardCategories) for (const b of c.boards) add(b.url, b.boardName);
    for (const b of externalBoards) add(b.url, b.boardName);
    for (const b of favorites.boards) add(b.url, b.boardName);
    for (const t of boardTabs) add(t.boardUrl, t.title);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardCategories, externalBoards, favorites.boards, boardTabs]);
  const boardNameMapRef = useRef(boardNameMap);
  boardNameMapRef.current = boardNameMap;
  const boardNameOfUrl = (url: string): string => {
    const k = boardKeyOfUrl(url);
    if (!k) return "";
    return boardNameMapRef.current.get(k) ?? k.slice(2);
  };
  const viewerSourceOf = (url: string): ViewerSource => {
    const site = detectSiteType(url);
    return site === "fiveCh" ? "5ch" : site;
  };
  // ビュワーの本文: レス表示欄と同じ無害化・リンク化を通し、サムネイルとリンクカードの置き場所を作ってから、スタンプを画像にする。
  // OBS 表示へは別に文字だけを送るので、ここで作る画像・カードは OBS には出ない
  // 一度作った HTML は、表示設定が変わるまで使い回す (新しい発言が届くたびに全件を作り直さない)
  const viewerBodyCacheRef = useRef<Map<number, { sig: string; html: string }>>(new Map());
  const viewerWordHighlightSig = textHighlights.filter((h) => h.type === "word").map((h) => `${h.pattern}:${h.color}`).join("|");
  // 名前ハイライト (レス表示欄と同じく、名前が一致したら背景に色)
  const viewerNameHighlight = (name: string): React.CSSProperties | undefined => {
    const key = nameForHighlight(name);
    const hl = textHighlights.find((h) => h.type === "name" && h.pattern === key);
    return hl ? { background: hl.color } : undefined;
  };
  const viewerBodyHtml = (it: ViewerItem): string => {
    const deferred = isChatSource(it.source) && viewerTwitchClickToLoad && !viewerRevealed.has(it.seq);
    const sig = [deferred, viewerCards, viewerThumbs, imageSizeLimit, darkMode, imageUrlRules.length, ogpDomainFilters.allow.join(","), ogpDomainFilters.block.join(","), viewerWordHighlightSig, it.text].join("\u0001");
    const cached = viewerBodyCacheRef.current.get(it.seq);
    if (cached && cached.sig === sig) return cached.html;
    const html = makeViewerBodyHtml(it, deferred);
    const cache = viewerBodyCacheRef.current;
    cache.set(it.seq, { sig, html });
    if (cache.size > VIEWER_MAX_ITEMS * 2) {
      const keep = new Set(viewerItems.map((x) => x.seq));
      for (const k of cache.keys()) if (!keep.has(k)) cache.delete(k);
    }
    return html;
  };
  const makeViewerBodyHtml = (it: ViewerItem, deferred: boolean): string => {
    const cards = viewerCards && !deferred;
    let html = renderResponseBody(escapeHtml(it.text), {
      // 画像NG に当たるものは URL ごと隠す。サムネイルを出さないとき (オフ・クリック待ち) は、URL はリンクとして残してサムネイルの行だけ外す
      hideImages: matchesImageWords(it.text),
      imageSizeLimitKb: imageSizeLimit,
      urlRules: imageUrlRules,
      ogpCards: cards,
      tweetCards: cards,
      ogpAllow: ogpDomainFilters.allow,
      ogpBlock: ogpDomainFilters.block,
    }).__html;
    if (!viewerThumbs || deferred) html = html.replace(/<div class="response-thumbs-row">[\s\S]*?<\/div>/g, "");
    // ワードハイライト (レス表示欄と同じ処理。ビュワーの表示だけで、OBS 表示には付けない)
    for (const h of textHighlights) if (h.type === "word") html = applyWordHighlight(html, h.pattern, h.color);
    if (it.emotes && it.emotes.length > 0) {
      const cps = Array.from(it.text);
      html = injectTwitchEmotes(html, it.emotes.map((e) => ({ id: e.id, name: cps.slice(e.start, e.end + 1).join(""), giant: e.giant === true, url: e.url })), !!it.giant, darkMode);
    }
    return html;
  };
  const pushLatestArrivals = (arrivals: ArrivalItem[]) => {
    const add: LatestItem[] = [];
    for (const a of arrivals) {
      if (a.isAbone) continue;
      const source = viewerSourceOf(a.threadUrl);
      if (isChatSource(source) || broadcastWhitelistRef.current[a.id]) continue;
      // 「選んだスレを流す」でビュワーに流したスレのレスは、同じものになるので追加しない
      if (viewerAllResponsesRef.current && isTabViewerOn(a.threadUrl)) continue;
      add.push({ seq: ++viewerSeqRef.current, source, site: VIEWER_SITE_LABEL[source], board: boardNameOfUrl(a.threadUrl), title: decodeHtmlEntities(a.threadTitle), idSeq: a.idSeq, idCount: a.idCount, threadUrl: a.threadUrl, no: a.responseNo, uid: a.id, time: a.time, text: a.plain.replace(/\s+/g, " ").slice(0, 300), body: a.plain });
    }
    if (add.length === 0) return;
    setLatestItems((prev) => {
      const next = prev.concat(add);
      return next.length > LATEST_MAX_ITEMS ? next.slice(-LATEST_MAX_ITEMS) : next;
    });
  };
  // Twitch・YouTube のチャットはすべて、掲示板のレスは配信ホワイトリストの ID だけを流す。
  // 透明あぼ～んは呼び出し元で除いてある。通常あぼ～んに当たったものも配信向けには流さない
  const pushViewerArrivals = (arrivals: ArrivalItem[]) => {
    const add: ViewerItem[] = [];
    for (const a of arrivals) {
      if (a.isAbone) continue;
      const source = viewerSourceOf(a.threadUrl);
      if (!isChatSource(source) && !broadcastWhitelistRef.current[a.id] && !(viewerAllResponsesRef.current && isTabViewerOn(a.threadUrl))) continue;
      add.push({
        seq: ++viewerSeqRef.current,
        source,
        site: VIEWER_SITE_LABEL[source],
        where: decodeHtmlEntities(a.threadTitle),
        ...(!isChatSource(source) ? { board: boardNameOfUrl(a.threadUrl), mail: decodeHtmlEntities(a.mail), idSeq: a.idSeq, idCount: a.idCount } : {}),
        threadUrl: a.threadUrl,
        no: a.responseNo,
        name: decodeHtmlEntities(a.name),
        uid: a.id,
        time: a.time,
        // イベントは見出し (要約) を別に持ち、本文は添えられたメッセージだけにする
        text: a.twitchEvent ? a.twitchEvent.message : a.plain,
        // 掲示板のレスに書かれたスタンプ名 (Twitch のチャットは下で受信したスタンプ情報に置き換える)
        ...(!isChatSource(source) && boardEmotesEnabledRef.current ? { emotes: findNamedEmotes(a.plain, emoteNameMapRef.current) } : {}),
        color: isChatSource(source) ? (twitchColorRef.current.get(a.id) ?? "") : "",
        ...(a.chatKey ? { key: a.chatKey } : {}),
        ...(a.twitchBadges ? { badges: a.twitchBadges } : {}),
        // スタンプは受信したままの本文の位置なので、本文もそれに合わせる
        ...(a.twitchRaw && a.twitchRaw.emotes.length > 0 ? { text: a.twitchRaw.text, emotes: a.twitchRaw.emotes, giant: a.twitchRaw.giant } : {}),
        ...(a.twitchEvent ? { event: { kind: a.twitchEvent.kind, label: a.twitchEvent.label, summary: a.twitchEvent.summary } } : {}),
      });
    }
    if (add.length === 0) return;
    // OBS 表示へも送る (Twitch・YouTube は ID を出さない・番号は無い)。掲示板のレスは配信ホワイトリストの ID のものだけ
    // (「開いているスレのレスをすべて流す」がオンでも、OBS には全部は出さない)
    const forOverlay = add.filter((it) => isChatSource(it.source) || broadcastWhitelistRef.current[it.uid]);
    if (isTauriRuntime() && overlayEnabledRef.current && forOverlay.length > 0) {
      const items = forOverlay.map((it) => ({
        source: it.source, site: it.site, no: isChatSource(it.source) ? null : it.no,
        name: it.name, uid: isChatSource(it.source) ? "" : it.uid, text: it.text, color: it.color,
        event: it.event ?? null,
        badgeList: it.badges ?? [],
        emotes: (it.emotes ?? []).map((e) => ({ id: e.id, start: e.start, end: e.end, giant: e.giant === true, ...(e.url ? { url: e.url } : {}) })),
        giant: it.giant === true,
        key: it.key ?? "",
      }));
      void invoke("overlay_publish", { items }).catch((e) => console.warn("overlay_publish failed", e));
    }
    setViewerItems((prev) => {
      const next = prev.concat(add);
      return next.length > VIEWER_MAX_ITEMS ? next.slice(-VIEWER_MAX_ITEMS) : next;
    });
  };
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    if (!overlayEnabled) {
      void invoke("overlay_stop").catch((e) => console.warn("overlay_stop failed", e));
      setOverlayStatus("");
      return;
    }
    invoke<number>("overlay_start", { port: overlayPort })
      .then((p) => { if (!cancelled) setOverlayStatus(`動作中 (127.0.0.1:${p})`); })
      .catch((e) => { if (!cancelled) setOverlayStatus(`開始できませんでした: ${String(e)}`); });
    return () => { cancelled = true; };
  }, [overlayEnabled, overlayPort]);
  // 「OBS 表示を使う」は「設定を保存」を待たず、切り替えた時点で settings.ini に保存する
  // (設定画面を「保存しないで閉じる」で閉じても戻らないよう、開いたときの値の控えも合わせる)
  const changeOverlayEnabled = (v: boolean) => {
    setOverlayEnabled(v);
    if (isTauriRuntime() && appSettingsLoadedRef.current) {
      void invoke("save_app_settings", { settings: { "App.overlayEnabled": String(v) } }).catch((e) => console.warn("save overlayEnabled failed", e));
    }
    setSettingsSnapshot((prev) => (prev ? { ...prev, app: { ...prev.app, "App.overlayEnabled": String(v) } } : prev));
  };
  // レイアウトの読み込み (data/overlay-layouts.json)。無ければ以前の overlay-appearance.json を「標準」として引き継ぐ
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const d = await loadFromFile<unknown>("overlay-layouts.json");
      const result: Record<string, OverlayLayoutData> = {};
      const raw = d && typeof d === "object" ? (d as { layouts?: unknown }).layouts : undefined;
      if (raw && typeof raw === "object") {
        for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
          if (overlayLayoutNameError(name, []) !== null || Object.keys(result).length >= 50) continue;
          const o = (v && typeof v === "object" ? v : {}) as { appearance?: unknown; css?: unknown };
          result[name] = { appearance: sanitizeOverlayAppearance(o.appearance), css: typeof o.css === "string" ? o.css.slice(0, OVERLAY_CSS_MAX_CHARS) : "" };
        }
      } else {
        const old = await loadFromFile<unknown>("overlay-appearance.json");
        if (old) result[OVERLAY_DEFAULT_LAYOUT] = { appearance: sanitizeOverlayAppearance(old), css: "" };
      }
      if (!result[OVERLAY_DEFAULT_LAYOUT]) result[OVERLAY_DEFAULT_LAYOUT] = { appearance: DEFAULT_OVERLAY_APPEARANCE, css: "" };
      if (cancelled) return;
      setOverlayLayouts(result);
      overlayAppearanceLoadedRef.current = true;
    })();
    return () => { cancelled = true; };
  }, []);
  // 変更は少し待ってからまとめて OBS 表示へ送り、保存する (追加 CSS の入力中に1文字ごとに送らないように)
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const timer = window.setTimeout(() => {
      void invoke("overlay_set_layouts", { layouts: overlayLayouts }).catch((e) => { console.warn("overlay_set_layouts failed", e); setStatus(`OBS 表示のレイアウトを反映できませんでした: ${String(e)}`); });
      if (overlayAppearanceLoadedRef.current) saveToFile("overlay-layouts.json", { layouts: overlayLayouts });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [overlayLayouts]);
  useEffect(() => {
    if (!viewerAutoScroll || activePaneView !== "viewer") return;
    const el = viewerListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [viewerItems, viewerAutoScroll, activePaneView]);
  useEffect(() => {
    if (!latestPanelOpen || activePaneView !== "viewer") return;
    const el = latestListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [latestItems, latestPanelOpen, activePaneView]);
  const applyWhitelistAutoAdd = (arrivals: ArrivalItem[]) => {
    const cfg = whitelistAutoConfig;
    if (!cfg.enabled) return;
    const words = cfg.words.split(/\r?\n/).map((w) => w.trim()).filter(Boolean);
    if (words.length === 0) return;
    let count = Object.keys(whitelistAuto).length;
    const added: Record<string, string> = {};
    for (const a of arrivals) {
      if (count >= cfg.limit) break;
      if (a.isAbone || !a.id || isChatSource(viewerSourceOf(a.threadUrl))) continue;
      if (broadcastWhitelistRef.current[a.id] || added[a.id] || whitelistRemoved.includes(a.id)) continue;
      const hit = words.find((w) => ngMatch(w, a.plain));
      if (!hit) continue;
      added[a.id] = hit;
      count++;
    }
    const ids = Object.keys(added);
    if (ids.length === 0) return;
    // この後のビュワーへの振り分けで通るよう、ref にもすぐ反映する
    broadcastWhitelistRef.current = { ...broadcastWhitelistRef.current, ...Object.fromEntries(ids.map((id) => [id, true as const])) };
    setBroadcastWhitelist((prev) => { const next = { ...prev }; for (const id of ids) next[id] = true; return next; });
    setWhitelistAuto((prev) => ({ ...prev, ...added }));
    setStatus(`配信ホワイトリストに自動で追加しました: ${ids.map((id) => `ID:${id}`).join(" ")}`);
  };
  const pushBroadcastArrivals = (arrivals: ArrivalItem[]) => {
    applyWhitelistAutoAdd(arrivals);
    pushLatestArrivals(arrivals);
    pushViewerArrivals(arrivals);
  };
  // 字幕の表示が終わるまで次のレスを待つ (同期)。字幕ウィンドウが閉じている・報告が無いときは新着ペインの時間だけで進む
  const [subtitleSyncEnabled, setSubtitleSyncEnabled] = useState(true);
  const subtitleSyncEnabledRef = useRef(true);
  subtitleSyncEnabledRef.current = subtitleSyncEnabled;
  // 字幕へ送ったレスの通し番号と、字幕から報告された表示終了予定時刻 (performance.now() 基準)
  const subtitleSeqRef = useRef(0);
  // 字幕からの報告: 最下行到達予定時刻 (bottomAt) と、到達後の表示時間 (holdMs)。同期 ON のとき新着ペイン側と合成する
  const subtitleEndAtRef = useRef<{ seq: number; bottomAt: number; holdMs: number } | null>(null);
  // 新着ペイン側の同じ情報 (最下行に達した時刻と、その後の表示時間)。scheduleArrivalAdvance で確定する
  const arrivalPlanRef = useRef<{ bottomAt: number; holdMs: number } | null>(null);
  // 新着ペインの「次へ進む」最終タイマーの予定時刻と発火処理 (字幕の報告で延長するため保持)
  const arrivalFinalDeadlineRef = useRef<number | null>(null);
  const arrivalFinalFireRef = useRef<(() => void) | null>(null);
  // 現在表示中の新着アイテムの実行トークン (古いスクロールループを止める)
  const arrivalRunIdRef = useRef(0);
  const scrollTimingRows = (t: ScrollTiming, set: (next: ScrollTiming) => void) => (
    <>
      <label className="settings-row">
        <span>短いレスの表示時間 (秒・スクロール不要時)</span>
        <input type="number" min={0} max={120} step={0.1} value={t.fitSec} onChange={(e) => set(sanitizeScrollTiming({ ...t, fitSec: Number(e.target.value) }))} className="lf-w70" />
      </label>
      <label className="settings-row">
        <span>スクロール開始までの待ち時間 (秒)</span>
        <input type="number" min={0} max={20} step={0.1} value={t.waitSec} onChange={(e) => set(sanitizeScrollTiming({ ...t, waitSec: Number(e.target.value) }))} className="lf-w70" />
      </label>
      <label className="settings-row">
        <span>スクロール速度 (1px あたり ms)</span>
        <input type="number" min={1} max={100} step={1} value={t.msPerPx} onChange={(e) => set(sanitizeScrollTiming({ ...t, msPerPx: Number(e.target.value) }))} className="lf-w70" />
      </label>
      <label className="settings-row">
        <span>スクロール後の表示時間 (秒)</span>
        <input type="number" min={0} max={120} step={0.1} value={t.holdSec} onChange={(e) => set(sanitizeScrollTiming({ ...t, holdSec: Number(e.target.value) }))} className="lf-w70" />
      </label>
    </>
  );
  const [hlWordInput, setHlWordInput] = useState("");
  const [hlWordColor, setHlWordColor] = useState<string>(HIGHLIGHT_COLORS[0].color);
  const [hlNameInput, setHlNameInput] = useState("");
  const [hlNameColor, setHlNameColor] = useState<string>(HIGHLIGHT_COLORS[0].color);
  const [hlIdInput, setHlIdInput] = useState("");
  const [hlIdColor, setHlIdColor] = useState<string>(HIGHLIGHT_COLORS[0].color);
  // Subtitle state
  const [subtitleVisible, setSubtitleVisible] = useState(false);
  const subtitleVisibleRef = useRef(false);
  subtitleVisibleRef.current = subtitleVisible;
  const [subtitleBodyFontSize, setSubtitleBodyFontSize] = useState(28);
  const [subtitleMetaFontSize, setSubtitleMetaFontSize] = useState(12);
  const [subtitleOpacity, setSubtitleOpacity] = useState(0.85);
  // 字幕の文字の影 (ドロップシャドウ)。既定はオン (明るい背景でも読めるように)
  const [subtitleTextShadow, setSubtitleTextShadow] = useState(true);
  // 字幕の枠: 通常 (Windows の線と影あり) / 四隅だけ / 枠なし
  type SubtitleFrameMode = "normal" | "corners" | "none";
  const [subtitleFrameMode, setSubtitleFrameMode] = useState<SubtitleFrameMode>("normal");
  // 字幕ウィンドウの大きさ (設定画面の表示用。字幕を手で大きさ変更したときも "subtitle-size" で合わせる)
  const [subtitleWinSize, setSubtitleWinSize] = useState<{ width: number; height: number }>({ width: 800, height: 200 });
  const [subtitleSizeInput, setSubtitleSizeInput] = useState<{ width: string; height: string }>({ width: "", height: "" });
  const [subtitleSizeMsg, setSubtitleSizeMsg] = useState("");
  const [subtitleAlwaysOnTop, setSubtitleAlwaysOnTop] = useState(true);
  const [subtitleIdFontSize, setSubtitleIdFontSize] = useState(0); // 0 = メタと同じ
  const [subtitleIdFontFamily, setSubtitleIdFontFamily] = useState("");
  // TTS state
  type TtsMode = "off" | "sapi" | "bouyomi" | "voicevox";
  type TtsDictEntry = { from: string; to: string; fullReplace?: boolean };
  const [ttsMode, setTtsMode] = useState<TtsMode>("off");
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [ttsMaxReadLength, setTtsMaxReadLength] = useState(100);
  // 辞書・許可リストに一致せず読まないURLを、黙って飛ばす代わりに「URL省略」と読むか
  const [ttsUrlOmitEnabled, setTtsUrlOmitEnabled] = useState(true);
  // 掲示板の新着の読み上げ方: "full" = 全文 (従来) / "whitelist" = TCV方式
  // (配信ホワイトリストの ID は本文まで読み、それ以外は「レスN番さん」と番号だけ読む)。Twitch のチャットには関係しない
  const [ttsBoardMode, setTtsBoardMode] = useState<"full" | "whitelist">("full");
  const ttsUrlOmitEnabledRef = useRef(true);
  ttsUrlOmitEnabledRef.current = ttsUrlOmitEnabled;
  const [sapiVoices, setSapiVoices] = useState<{ index: number; name: string }[]>([]);
  const [sapiVoiceIndex, setSapiVoiceIndex] = useState(0);
  const [sapiRate, setSapiRate] = useState(0);
  const [sapiVolume, setSapiVolume] = useState(100);
  const [bouyomiPath, setBouyomiPath] = useState("");
  const [bouyomiSpeed, setBouyomiSpeed] = useState(-1);
  const [bouyomiTone, setBouyomiTone] = useState(-1);
  const [bouyomiVolume, setBouyomiVolume] = useState(-1);
  const [bouyomiVoice, setBouyomiVoice] = useState(0);
  const [voicevoxEndpoint, setVoicevoxEndpoint] = useState("http://127.0.0.1:50021");
  const [voicevoxSpeakerId, setVoicevoxSpeakerId] = useState(0);
  const [voicevoxSpeedScale, setVoicevoxSpeedScale] = useState(1.0);
  const [voicevoxPitchScale, setVoicevoxPitchScale] = useState(0.0);
  const [voicevoxIntonationScale, setVoicevoxIntonationScale] = useState(1.0);
  const [voicevoxVolumeScale, setVoicevoxVolumeScale] = useState(1.0);
  const [voicevoxSpeakers, setVoicevoxSpeakers] = useState<{ name: string; styles: { name: string; id: number }[] }[]>([]);
  // デフォルト辞書。Rust 側 default_tts_dict() (lib.rs) と同じ内容にすること。
  // URL 系キーワードは読み上げ時に URL 単位で照合される (ttsSpeak 参照)。
  const DEFAULT_TTS_DICT: TtsDictEntry[] = [
    { from: "WebABC", to: "このレスは番組表です", fullReplace: true },
    { from: "http://jbbs.shitaraba", to: "したらば掲示板" },
    { from: "youtube", to: "ゆーちゅーぶ" },
    { from: "youtu.be", to: "ゆーちゅーぶ" },
  ];
  const [ttsDictEntries, setTtsDictEntries] = useState<TtsDictEntry[]>(DEFAULT_TTS_DICT);
  const ttsDictRef = useRef<TtsDictEntry[]>(DEFAULT_TTS_DICT);
  ttsDictRef.current = ttsDictEntries;
  // 読み込み完了前に (初期値で) 保存してユーザー辞書を潰さないためのガード
  const ttsDictLoadedRef = useRef(false);
  const [ttsDictNewFrom, setTtsDictNewFrom] = useState("");
  const [ttsDictNewTo, setTtsDictNewTo] = useState("");
  const [ttsDictNewFullReplace, setTtsDictNewFullReplace] = useState(false);
  // 読み上げ許可リスト (IP アドレス配信 URL 専用): 登録された IP[:ポート] だけ `to` で読み、未登録 IP は読まない
  type TtsIpAllowEntry = { host: string; to: string };
  const DEFAULT_TTS_IP_ALLOW: TtsIpAllowEntry[] = [];
  const [ttsIpAllow, setTtsIpAllow] = useState<TtsIpAllowEntry[]>(DEFAULT_TTS_IP_ALLOW);
  const ttsIpAllowRef = useRef<TtsIpAllowEntry[]>(DEFAULT_TTS_IP_ALLOW);
  ttsIpAllowRef.current = ttsIpAllow;
  const ttsIpAllowLoadedRef = useRef(false);
  const [ttsIpAllowNewHost, setTtsIpAllowNewHost] = useState("");
  const [ttsIpAllowNewTo, setTtsIpAllowNewTo] = useState("");
  // 読み上げない辞書: 表示・あぼーんには影響せず読み上げだけ抑制する
  type TtsMuteEntry = { value: string; skipWhole: boolean };
  type TtsMuteDict = { names: TtsMuteEntry[]; words: TtsMuteEntry[]; ids: TtsMuteEntry[] };
  type TtsMuteKind = keyof TtsMuteDict;
  const EMPTY_TTS_MUTE: TtsMuteDict = { names: [], words: [], ids: [] };
  const [ttsMuteDict, setTtsMuteDict] = useState<TtsMuteDict>(EMPTY_TTS_MUTE);
  const ttsMuteRef = useRef<TtsMuteDict>(EMPTY_TTS_MUTE);
  ttsMuteRef.current = ttsMuteDict;
  const ttsMuteLoadedRef = useRef(false);
  const [ttsMuteNewKind, setTtsMuteNewKind] = useState<TtsMuteKind>("words");
  const [ttsMuteNewValue, setTtsMuteNewValue] = useState("");
  const [ttsMuteNewSkipWhole, setTtsMuteNewSkipWhole] = useState(false);
  const ttsIsSpeaking = useRef(false);
  const ttsQueueRef = useRef<string[]>([]);
  const ttsProcessingRef = useRef(false);
  // Refs for TTS settings (avoid stale closures in async queue processor)
  const ttsModeRef = useRef<TtsMode>("off");
  ttsModeRef.current = ttsMode;
  const ttsMaxReadLengthRef = useRef(0);
  ttsMaxReadLengthRef.current = ttsMaxReadLength;
  const sapiVoiceIndexRef = useRef(0);
  sapiVoiceIndexRef.current = sapiVoiceIndex;
  const sapiRateRef = useRef(0);
  sapiRateRef.current = sapiRate;
  const sapiVolumeRef = useRef(100);
  sapiVolumeRef.current = sapiVolume;
  const bouyomiPathRef = useRef("");
  bouyomiPathRef.current = bouyomiPath;
  const bouyomiSpeedRef = useRef(-1);
  bouyomiSpeedRef.current = bouyomiSpeed;
  const bouyomiToneRef = useRef(-1);
  bouyomiToneRef.current = bouyomiTone;
  const bouyomiVolumeRef = useRef(-1);
  bouyomiVolumeRef.current = bouyomiVolume;
  const bouyomiVoiceRef = useRef(0);
  bouyomiVoiceRef.current = bouyomiVoice;
  const voicevoxEndpointRef = useRef("http://127.0.0.1:50021");
  voicevoxEndpointRef.current = voicevoxEndpoint;
  const voicevoxSpeakerIdRef = useRef(0);
  voicevoxSpeakerIdRef.current = voicevoxSpeakerId;
  const voicevoxSpeedScaleRef = useRef(1.0);
  voicevoxSpeedScaleRef.current = voicevoxSpeedScale;
  const voicevoxPitchScaleRef = useRef(0.0);
  voicevoxPitchScaleRef.current = voicevoxPitchScale;
  const voicevoxIntonationScaleRef = useRef(1.0);
  voicevoxIntonationScaleRef.current = voicevoxIntonationScale;
  const voicevoxVolumeScaleRef = useRef(1.0);
  voicevoxVolumeScaleRef.current = voicevoxVolumeScale;
  const [boardsFontSize, setBoardsFontSize] = useState(12);
  const [threadsFontSize, setThreadsFontSize] = useState(12);
  const [responsesFontSize, setResponsesFontSize] = useState(12);
  const [responsesHeaderFontSize, setResponsesHeaderFontSize] = useState(11);
  const [popupFontSize, setPopupFontSize] = useState(12);
  const [popupMaxWidth, setPopupMaxWidth] = useState(520);
  const [popupMaxHeight, setPopupMaxHeight] = useState(360);
  type PaneName = "boards" | "threads" | "responses";
  const [focusedPane, setFocusedPane] = useState<PaneName>("responses");
  const [fontFamily, setFontFamily] = useState("");
  const [fontBold, setFontBold] = useState(false);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [fontPickerInput, setFontPickerInput] = useState("");
  const [fontPickerOpen, setFontPickerOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const darkModeRef = useRef(false);
  darkModeRef.current = darkMode;
  const [composeFontSize, setComposeFontSize] = useState(13);
  const [resIdFontSize, setResIdFontSize] = useState(0); // 0 = same as parent, ±px delta
  const [resIdFontFamily, setResIdFontFamily] = useState("");
  const [resIdFontPickerInput, setResIdFontPickerInput] = useState("");
  const [resIdFontPickerOpen, setResIdFontPickerOpen] = useState(false);
  const [newArrivalIdFontSize, setNewArrivalIdFontSize] = useState(0); // 0 = same as parent, ±px delta
  const [newArrivalIdFontFamily, setNewArrivalIdFontFamily] = useState("");
  const [newArrivalIdFontPickerInput, setNewArrivalIdFontPickerInput] = useState("");
  const [newArrivalIdFontPickerOpen, setNewArrivalIdFontPickerOpen] = useState(false);
  const [subtitleIdFontPickerInput, setSubtitleIdFontPickerInput] = useState("");
  const [subtitleIdFontPickerOpen, setSubtitleIdFontPickerOpen] = useState(false);
  const [idPopup, setIdPopup] = useState<{ anchorLeft: number; anchorRight: number; anchorY: number; id: string } | null>(null);
  const idPopupCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [idMenu, setIdMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [beMenu, setBeMenu] = useState<{ x: number; y: number; beNumber: string } | null>(null);
  const anchorPopupCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [backRefPopup, setBackRefPopup] = useState<{ x: number; y: number; anchorTop: number; responseIds: number[] } | null>(null);
  const [watchoiMenu, setWatchoiMenu] = useState<{ x: number; y: number; watchoi: string } | null>(null);

  const [boardPaneVisible, setBoardPaneVisible] = useState(true);
  const [boardPanePx, setBoardPanePx] = useState(DEFAULT_BOARD_PANE_PX);
  const [threadPanePx, setThreadPanePx] = useState(DEFAULT_THREAD_PANE_PX);
  const [responseTopRatio, setResponseTopRatio] = useState(DEFAULT_RESPONSE_TOP_RATIO);
  const resizeDragRef = useRef<ResizeDragState | null>(null);
  const [threadColWidths, setThreadColWidths] = useState<Record<string, number>>({ ...DEFAULT_COL_WIDTHS });
  const layoutPrefsLoadedRef = useRef(false);
  // settings.ini の読み込み完了フラグ。これが立つ前に保存 (initial mount 時など) すると、
  // まだ既定値のままの state で settings.ini を上書きし、直前まで保存されていた値
  // (棒読みちゃんの実行ファイルパス等) を消してしまう
  const appSettingsLoadedRef = useRef(false);
  // settings.ini を読み終えた (読み込み前の既定値で動き出してほしくない処理が待つ)
  const [appSettingsReady, setAppSettingsReady] = useState(false);
  const threadScrollPositions = useRef<Record<string, number>>({});
  const boardTreeRef = useRef<HTMLDivElement | null>(null);
  const boardTreeScrollRestoreRef = useRef<number | null>(null);
  const responseLayoutRef = useRef<HTMLDivElement | null>(null);
  const threadTbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const responseScrollRef = useRef<HTMLDivElement | null>(null);

  const tabBarRef = useRef<HTMLDivElement | null>(null);
  const boardTabBarRef = useRef<HTMLDivElement | null>(null);
  const threadListScrollRef = useRef<HTMLDivElement | null>(null);
  const suppressThreadScrollRef = useRef(false);
  // Set before setSelectedResponse on tab-switch/restore paths so the
  // selection-scroll effect doesn't fight scrollToBottom/scrollToResponseNo.
  const suppressResponseSelScrollRef = useRef(false);
  const [lastFetchTime, setLastFetchTime] = useState<string | null>(null);
  const [newResponseStart, setNewResponseStart] = useState<number | null>(null);
  const [newArrivalPaneOpen, setNewArrivalPaneOpen] = useState(true);
  const [newArrivalPaneHeight, setNewArrivalPaneHeight] = useState(DEFAULT_NEW_ARRIVAL_PX);
  const [newArrivalFontSize, setNewArrivalFontSize] = useState(13);
  const newArrivalScrollRef = useRef<HTMLDivElement | null>(null);
  // text は新着ペイン・字幕用 (タグを除いて短く切ったもの、文字参照はそのまま)。plain はビュワー・OBS 表示用の全文の平文
  type ArrivalItem = { threadTitle: string; responseNo: number; name: string; mail: string; id: string; time: string; text: string; plain: string; threadUrl: string; idSeq: number; idCount: number; isAbone?: boolean;
    // Twitch のイベント (サブスク・ビッツなど)。speech は読み上げる文、message は視聴者が添えたメッセージ
    twitchEvent?: { kind: string; label: string; summary: string; message: string; speech: string; speak: boolean };
    // Twitch のバッジ (ビュワー・OBS 表示用)
    twitchBadges?: TwitchBadge[];
    // Twitch のスタンプ (text は受信したままの本文。emotes の位置はこの本文のコードポイント単位)
    twitchRaw?: { text: string; emotes: TwitchEmote[]; giant: boolean };
    // YouTube の発言の目印 (yt:動画ID:発言ID)。削除されたら、まだ流していない新着・ビュワー・OBS 表示から消す。
    // YouTube のイベント・絵文字も twitchEvent / twitchRaw と同じ形で持つ
    chatKey?: string };
  const arrivalQueueRef = useRef<ArrivalItem[]>([]);
  const [currentArrivalItem, setCurrentArrivalItem] = useState<ArrivalItem | null>(null);
  const currentArrivalItemRef = useRef<ArrivalItem | null>(null);
  const arrivalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newArrivalBodyRef = useRef<HTMLDivElement | null>(null);
  const [arrivalQueueCount, setArrivalQueueCount] = useState(0);
  const threadFetchTimesRef = useRef<Record<string, string>>({});
  const pendingAutoScrollRef = useRef(false);
  const [responseSearchQuery, setResponseSearchQuery] = useState("");
  const [responseSearchMode, setResponseSearchMode] = useState<"extract" | "in-thread" | null>(null);
  const [searchModeMenuOpen, setSearchModeMenuOpen] = useState(false);
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [responseLinkFilter, setResponseLinkFilter] = useState<"" | "image" | "video" | "link">("");
  const threadSearchRef = useRef<HTMLInputElement | null>(null);
  const responseSearchRef = useRef<HTMLInputElement | null>(null);
  const [threadSearchHistory, setThreadSearchHistory] = useState<string[]>([]);
  const [responseSearchHistory, setResponseSearchHistory] = useState<string[]>([]);
  const [searchHistoryDropdown, setSearchHistoryDropdown] = useState<{ type: "thread" | "response" } | null>(null);
  const [searchHistoryMenu, setSearchHistoryMenu] = useState<{ x: number; y: number; type: "thread" | "response"; word: string } | null>(null);

  // Detect own post after re-fetch
  useEffect(() => {
    const pending = pendingMyPostRef.current;
    if (!pending) return;
    if (fetchedResponses.length <= pending.prevCount) return;
    pendingMyPostRef.current = null;
    const normalizedBody = pending.body.replace(/\s+/g, " ").trim();
    const newResponses = fetchedResponses.slice(pending.prevCount);
    const matched = newResponses.find((r) => {
      const stripped = stripHtmlForMatch(r.body || "");
      return stripped === normalizedBody || stripped.includes(normalizedBody) || normalizedBody.includes(stripped);
    });
    if (matched) {
      setMyPosts((prev) => {
        const list = prev[pending.threadUrl] ?? [];
        if (list.includes(matched.responseNo)) return prev;
        const next = { ...prev, [pending.threadUrl]: [...list, matched.responseNo] };
        saveToFile("my-posts.json", next);
        return next;
      });
    }
  }, [fetchedResponses]);

  useEffect(() => {
    if (!pendingAutoScrollRef.current) return;
    pendingAutoScrollRef.current = false;
    if (responseScrollRef.current) {
      responseScrollRef.current.scrollTop = responseScrollRef.current.scrollHeight;
    }
  }, [fetchedResponses]);

  // Process size-gated image thumbnails after render
  const imageSizeCacheRef = useRef(new Map<string, Promise<number | null>>());
  useEffect(() => {
    if (imageSizeLimit <= 0) return;
    const processGates = () => {
      const gates = document.querySelectorAll<HTMLElement>(".thumb-size-gate[data-gate-src]");
      if (gates.length === 0) return;
      const limitBytes = imageSizeLimit * 1024;
      const cache = imageSizeCacheRef.current;
      gates.forEach((gate) => {
        const src = gate.dataset.gateSrc;
        if (!src) return;
        let sizePromise = cache.get(src);
        if (!sizePromise) {
          sizePromise = fetch(src, { method: "HEAD" }).then((res) => {
            const cl = res.headers.get("content-length");
            return cl ? parseInt(cl, 10) : null;
          }).catch(() => null);
          cache.set(src, sizePromise);
        }
        sizePromise.then((size) => {
          if (!gate.dataset.gateSrc) return;
          delete gate.dataset.gateSrc;
          delete gate.dataset.sizeLimit;
          if (size !== null && size > limitBytes) {
            const sizeStr = size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)}MB` : `${Math.round(size / 1024)}KB`;
            gate.innerHTML = `<span class="thumb-gate-blocked" data-reveal-src="${src}">サイズ制限 (${sizeStr}) により非表示 — クリックで表示</span>`;
          } else {
            gate.innerHTML = `<img class="response-thumb" src="${src}" loading="eager" alt="" />`;
          }
        }).catch(() => {
          if (!gate.dataset.gateSrc) return;
          delete gate.dataset.gateSrc;
          gate.innerHTML = `<img class="response-thumb" src="${src}" loading="eager" alt="" />`;
        });
      });
    };
    // Use rAF to ensure DOM is updated after React render
    const raf = requestAnimationFrame(processGates);
    return () => cancelAnimationFrame(raf);
  });

  const fetchMenu = async () => {
    setStatus("loading...");
    try {
      const info = await invoke<MenuInfo>("fetch_bbsmenu_summary");
      setStatus(`ok keys=${info.topLevelKeys} sample=${info.normalizedSample}`);
    } catch (error) {
      setStatus(`error: ${String(error)}`);
    }
  };

  const fetchBoardCategories = async () => {
    if (!isTauriRuntime()) {
      setStatus("board fetch requires tauri runtime");
      return;
    }
    setStatus("loading boards...");
    try {
      const cats = await invoke<BoardCategory[]>("fetch_board_categories");
      setBoardCategories(cats);
      saveToFile("board-categories.json", cats);
      setStatus(`boards loaded: ${cats.length} categories, ${cats.reduce((s, c) => s + c.boards.length, 0)} boards`);
    } catch (error) {
      setStatus(`board load error: ${String(error)}`);
    }
  };

  const persistReadStatus = async (boardUrl: string, threadKey: string, lastReadNo: number) => {
    if (!isTauriRuntime()) return;
    try {
      const current = await invoke<Record<string, Record<string, number>>>("load_read_status");
      if (!current[boardUrl]) current[boardUrl] = {};
      current[boardUrl][threadKey] = lastReadNo;
      await invoke("save_read_status", { status: current });
    } catch {
      // ignore persistence errors
    }
    // Also persist to thread-history.json with visitedAt
    try {
      const history = await invoke<Record<string, Record<string, { lastReadNo: number; visitedAt: number; customTitle?: string }>>>("load_thread_history");
      if (!history[boardUrl]) history[boardUrl] = {};
      const prev = history[boardUrl][threadKey] ?? {};
      history[boardUrl][threadKey] = {
        ...prev,
        lastReadNo,
        visitedAt: Math.floor(Date.now() / 1000),
      };
      await invoke("save_thread_history", { history });
    } catch {
      // ignore persistence errors
    }
  };

  const loadReadStatusForBoard = async (boardUrl: string, threads: ThreadListItem[]) => {
    if (!isTauriRuntime()) return;
    try {
      const all = await invoke<Record<string, Record<string, number>>>("load_read_status");
      const boardStatus = all[boardUrl] ?? {};
      const readMap: Record<string, boolean> = {};
      const lastReadMap: Record<string, number> = {};
      threads.forEach((t) => {
        const lastRead = boardStatus[t.threadKey] ?? 0;
        readMap[t.threadUrl] = lastRead > 0;
        lastReadMap[t.threadUrl] = lastRead;
      });
      setThreadReadMap(readMap);
      setThreadLastReadCount(lastReadMap);
    } catch {
      // ignore
    }
  };

  const loadFavorites = async () => {
    if (!isTauriRuntime()) return;
    try {
      const data = await invoke<FavoritesData>("load_favorites");
      setFavorites(data);
    } catch {
      // no saved favorites yet
    }
  };

  const loadExternalBoards = async () => {
    if (!isTauriRuntime()) return;
    try {
      const data = await invoke<BoardEntry[]>("load_external_boards");
      setExternalBoards(data);
    } catch { /* no saved external boards */ }
  };

  const addExternalBoard = (url: string, name: string) => {
    const trimmedUrl = url.trim().replace(/\/$/, "") + "/";
    const trimmedName = name.trim();
    if (!trimmedUrl || !trimmedName) return;
    if (externalBoards.some((b) => b.url === trimmedUrl)) {
      setStatus("この板は既に登録されています");
      return;
    }
    const next = [...externalBoards, { boardName: trimmedName, url: trimmedUrl }];
    setExternalBoards(next);
    if (isTauriRuntime()) invoke("save_external_boards", { boards: next }).catch(() => {});
    setExpandedCategories((prev) => new Set([...prev, "__external__"]));
    setShowExternalBoardDialog(false);
    setExternalBoardUrl("");
    setExternalBoardName("");
    setStatus(`外部板「${trimmedName}」を追加しました`);
  };

  const removeExternalBoard = (url: string) => {
    const next = externalBoards.filter((b) => b.url !== url);
    setExternalBoards(next);
    if (isTauriRuntime()) invoke("save_external_boards", { boards: next }).catch(() => {});
  };

  const persistIdHighlights = (next: IdHighlightMap) => {
    setIdHighlights(next);
    if (isTauriRuntime()) {
      invoke("save_id_highlights", { data: { date: todayStr(), highlights: next } }).catch(() => {});
    }
  };

  const persistTextHighlights = (next: TextHighlight[]) => {
    setTextHighlights(next);
    if (isTauriRuntime()) {
      invoke("save_text_highlights", { data: next }).catch(() => {});
    }
  };

  const persistFavorites = async (next: FavoritesData) => {
    setFavorites(next);
    if (!isTauriRuntime()) return;
    try {
      await invoke("save_favorites", { favorites: next });
    } catch (error) {
      setStatus(`favorite save error: ${String(error)}`);
    }
  };

  const toggleFavoriteBoard = (board: BoardEntry) => {
    const exists = favorites.boards.some((b) => b.url === board.url);
    const nextBoards = exists
      ? favorites.boards.filter((b) => b.url !== board.url)
      : [...favorites.boards, { boardName: board.boardName, url: board.url }];
    void persistFavorites({ ...favorites, boards: nextBoards });
    setStatus(exists ? `unfavorited board: ${board.boardName}` : `favorited board: ${board.boardName}`);
  };

  const toggleFavoriteThread = (thread: { threadUrl: string; title: string }) => {
    const exists = favorites.threads.some((t) => t.threadUrl === thread.threadUrl);
    const nextThreads = exists
      ? favorites.threads.filter((t) => t.threadUrl !== thread.threadUrl)
      : [...favorites.threads, { threadUrl: thread.threadUrl, title: thread.title, boardUrl: threadUrl }];
    void persistFavorites({ ...favorites, threads: nextThreads });
    setStatus(exists ? `unfavorited thread` : `favorited thread`);
  };

  const favDragOverIndexRef = useRef<number | null>(null);
  const onFavItemMouseDown = (e: React.MouseEvent, type: "board" | "thread", index: number, containerSelector: string) => {
    if (e.button !== 0) return;
    favDragRef.current = { type, srcIndex: index, startY: e.clientY };
    favDragOverIndexRef.current = null;
    const onMove = (ev: MouseEvent) => {
      if (!favDragRef.current) return;
      if (Math.abs(ev.clientY - favDragRef.current.startY) < 5) return;
      ev.preventDefault();
      window.getSelection()?.removeAllRanges();
      setFavDragState((prev) => prev ?? { type: favDragRef.current!.type, srcIndex: favDragRef.current!.srcIndex, overIndex: null });
      const container = document.querySelector(containerSelector);
      if (!container) return;
      const items = container.querySelectorAll<HTMLElement>(":scope > li");
      let found = false;
      for (let j = 0; j < items.length; j++) {
        const rect = items[j].getBoundingClientRect();
        if (ev.clientY >= rect.top && ev.clientY < rect.bottom && j !== favDragRef.current.srcIndex) {
          favDragOverIndexRef.current = j;
          setFavDragState((prev) => prev ? { ...prev, overIndex: j } : null);
          found = true;
          break;
        }
      }
      if (!found) {
        favDragOverIndexRef.current = null;
        setFavDragState((prev) => prev ? { ...prev, overIndex: null } : null);
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const drag = favDragRef.current;
      const dst = favDragOverIndexRef.current;
      favDragRef.current = null;
      favDragOverIndexRef.current = null;
      setFavDragState(null);
      if (!drag || dst === null || dst === drag.srcIndex) return;
      if (drag.type === "board") {
        const arr = [...favorites.boards];
        const [moved] = arr.splice(drag.srcIndex, 1);
        arr.splice(dst, 0, moved);
        void persistFavorites({ ...favorites, boards: arr });
      } else {
        const arr = [...favorites.threads];
        const [moved] = arr.splice(drag.srcIndex, 1);
        arr.splice(dst, 0, moved);
        void persistFavorites({ ...favorites, threads: arr });
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const isFavoriteBoard = (url: string) => favorites.boards.some((b) => b.url === url);

  const loadNgFilters = async () => {
    if (!isTauriRuntime()) return;
    try {
      const data = await invoke<NgFilters>("load_ng_filters");
      setNgFilters({ ...data, mails: data.mails ?? [], thread_words: data.thread_words ?? [], invisible: normalizeInvisibleMode(data.invisible) });
    } catch {
      // no saved NG filters yet
    }
  };

  const persistNgFilters = async (next: NgFilters) => {
    setNgFilters(next);
    if (!isTauriRuntime()) return;
    try {
      await invoke("save_ng_filters", { filters: next });
    } catch (error) {
      setStatus(`ng save error: ${String(error)}`);
    }
  };

  const addNgEntry = (type: NgCategory, value: string, mode?: NgMode, scope?: "global" | "board" | "thread") => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (ngFilters[type].some((e) => ngVal(e) === trimmed)) {
      setStatus(`already in NG ${type}: ${trimmed}`);
      return;
    }
    const s = scope ?? ngAddScope;
    const entry: NgEntry = {
      value: trimmed,
      mode: mode ?? (type === "image_words" ? "hide-images" : ngAddMode),
      ...(s !== "global" ? { scope: s, scopeUrl: s === "board" ? getBoardUrlFromThreadUrl(threadUrl.trim()) : threadUrl.trim() } : {}),
    };
    void persistNgFilters({ ...ngFilters, [type]: [...ngFilters[type], entry] });
    setStatus(`added NG ${type}: ${trimmed}`);
  };

  // type を渡した場合はその種類に固定して追加 (設定タブの節ごとのフォーム用)。
  // 渡さない場合は共通の ngInputType (ツールバーの簡易NGパネル用、正規表現込み) を使う
  const addNgFromInput = (type?: NgCategory) => {
    if (!ngInput.trim()) return;
    const asRegex = type ? (type === "words" && ngWordRegexInput) : ngInputType === "regex";
    const effectiveType: NgCategory = type ?? (ngInputType === "regex" ? "words" : ngInputType);
    if (asRegex) {
      const pattern = ngInput.trim();
      const wrapped = pattern.startsWith("/") && pattern.endsWith("/") ? pattern : `/${pattern}/`;
      addNgEntry(effectiveType, wrapped);
    } else {
      addNgEntry(effectiveType, ngInput);
    }
    setNgInput("");
  };

  const removeNgEntry = (type: NgCategory, value: string) => {
    void persistNgFilters({ ...ngFilters, [type]: ngFilters[type].filter((v) => ngVal(v) !== value) });
    setStatus(`removed NG ${type}: ${value}`);
  };

  // 登録済みのNGエントリのモード(透明あぼ～ん/通常あぼ～ん)を後から変更する (画像NGは対象外、常に画像のみ非表示)
  const updateNgEntryMode = (type: NgCategory, value: string, mode: NgMode) => {
    void persistNgFilters({
      ...ngFilters,
      [type]: ngFilters[type].map((e) => {
        if (ngVal(e) !== value) return e;
        return typeof e === "string" ? { value: e, mode } : { ...e, mode };
      }),
    });
  };

  // 設定 > NG の節の中のすべてを、通常あぼ～ん / 透明あぼ～んに切り替える (押したときは確認する)
  const setAllNgModes = (type: NgCategory, mode: NgMode) => {
    const n = ngFilters[type].length;
    if (n === 0) return;
    const label = mode === "abone" ? "通常あぼ～ん" : "透明あぼ～ん";
    setAppConfirm({
      title: "NG の一括切り替え",
      message: `NG ${NG_TYPE_LABELS[type]} の ${n} 件を、すべて${label}にしますか？`,
      buttons: [
        { label: `すべて${label}にする`, primary: true, onClick: () => {
          void persistNgFilters({ ...ngFilters, [type]: ngFilters[type].map((e) => (typeof e === "string" ? { value: e, mode } : { ...e, mode })) });
          setStatus(`NG ${NG_TYPE_LABELS[type]} の ${n} 件を${label}にしました`);
        } },
        { label: "キャンセル", onClick: () => {} },
      ],
    });
  };

  // NG「見えない文字を含むレス」の選択欄 (NGフィルタのダイアログと 設定 > NG の両方で使う)
  const NG_INVISIBLE_HINT = "幅ゼロの空白・文字の向きを変える制御文字・空白に見えるハングルの埋め文字など、画面に見えない文字を名前か本文に含むレスをNGにします。絵文字に使われる文字は対象にしません。範囲は全体のみです。";
  const ngInvisibleSelect = () => (
    <select
      className="ng-mode-select"
      value={normalizeInvisibleMode(ngFilters.invisible)}
      onChange={(e) => void persistNgFilters({ ...ngFilters, invisible: normalizeInvisibleMode(e.target.value) })}
    >
      <option value="off">NGにしない</option>
      <option value="abone">通常あぼ～ん</option>
      <option value="hide">透明あぼ～ん</option>
    </select>
  );
  const NG_TYPE_LABELS: Record<NgCategory, string> = {
    words: "ワード", ids: "ID", names: "名前", mails: "メール", thread_words: "スレタイ", image_words: "画像NG",
  };

  // 設定 > NG の各節 (ワード / ID / 名前 / メール / スレタイ / 画像NG) で使う追加フォーム。
  // 節タブごとに種類が決まっているため、種類を選ぶプルダウンは持たず type に固定する
  // (ワード節のみ、通常入力/正規表現を切り替える入力形式プルダウンを別途持つ)
  const ngAddFormFor = (type: NgCategory) => (
    <div className="ng-panel-add">
      {type === "words" && (
        <select value={ngWordRegexInput ? "regex" : "plain"} onChange={(e) => setNgWordRegexInput(e.target.value === "regex")}>
          <option value="plain">通常</option>
          <option value="regex">正規表現</option>
        </select>
      )}
      <input
        value={ngInput}
        onChange={(e) => setNgInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") addNgFromInput(type); }}
        placeholder={type === "words" && ngWordRegexInput ? "正規表現パターンを入力" : `NG${NG_TYPE_LABELS[type]}を入力`}
      />
      {type !== "image_words" && (
        <select value={ngAddMode} onChange={(e) => setNgAddMode(e.target.value as NgMode)} className="ng-mode-select">
          <option value="hide">透明あぼ～ん</option>
          <option value="abone">通常あぼ～ん</option>
        </select>
      )}
      <select value={ngAddScope} onChange={(e) => setNgAddScope(e.target.value as "global" | "board" | "thread")} className="ng-mode-select">
        <option value="global">全体</option>
        <option value="board">この板</option>
        {type !== "thread_words" && <option value="thread">このスレ</option>}
      </select>
      <button onClick={() => addNgFromInput(type)}>追加</button>
    </div>
  );

  const ngMatch = (pattern: string, target: string): boolean => {
    if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
      if (pattern.length > MAX_USER_REGEX_LEN) return false;
      const re = getNgRegex(pattern.slice(1, -1));
      return re ? re.test(target) : false;
    }
    return target.toLowerCase().includes(pattern.toLowerCase());
  };

  // 一致した際の詳細 (通常あぼ～んのマウスオーバー理由に使う)
  type NgHit = { mode: NgMode; reason: string };
  const NG_MODE_RANK: Record<NgMode, number> = { "hide-images": 0, abone: 1, hide: 2 };
  const getNgResult = (resp: { name: string; mail?: string; time: string; text: string }, threadUrlForScope?: string): NgHit | null => {
    const invisibleMode = normalizeInvisibleMode(ngFilters.invisible);
    if (ngFilters.words.length === 0 && ngFilters.ids.length === 0 && ngFilters.names.length === 0 && ngFilters.mails.length === 0 && invisibleMode === "off") return null;
    const curThread = (threadUrlForScope ?? threadUrl).trim();
    const curBoard = getBoardUrlFromThreadUrl(curThread);
    let best: NgHit | null = null;
    // 透明あぼ～んに一致した時点で即確定 (他の一致より常に優先)。それ以外は優先度の高いモードを残す
    const consider = (mode: NgMode, reason: string): NgHit | null => {
      if (mode === "hide") { best = { mode, reason }; return best; }
      if (!best || NG_MODE_RANK[mode] > NG_MODE_RANK[best.mode]) best = { mode, reason };
      return null;
    };
    for (const w of ngFilters.words) {
      if (!ngScopeMatches(w, curBoard, curThread)) continue;
      if (ngMatch(ngVal(w), resp.text)) {
        const hit = consider(ngEntryMode(w), `NGワード: ${ngVal(w)}`);
        if (hit) return hit;
      }
    }
    // 見えない文字を含むレス (範囲は全体のみ。名前と本文を見る)。文字参照を戻した文字列はこの判定にだけ使う
    if (invisibleMode !== "off" && (hasInvisibleChar(resp.text) || hasInvisibleChar(resp.name))) {
      const hit = consider(invisibleMode, "NG: 見えない文字");
      if (hit) return hit;
    }
    for (const n of ngFilters.names) {
      if (!ngScopeMatches(n, curBoard, curThread)) continue;
      if (ngMatch(ngVal(n), resp.name)) {
        const hit = consider(ngEntryMode(n), `NG名前: ${ngVal(n)}`);
        if (hit) return hit;
      }
    }
    if (ngFilters.mails.length > 0 && resp.mail) {
      for (const m of ngFilters.mails) {
        if (!ngScopeMatches(m, curBoard, curThread)) continue;
        if (ngMatch(ngVal(m), resp.mail)) {
          const hit = consider(ngEntryMode(m), `NGメール: ${ngVal(m)}`);
          if (hit) return hit;
        }
      }
    }
    if (ngFilters.ids.length > 0) {
      const idMatch = resp.time.match(/ID:([^\s]+)/);
      if (idMatch) {
        for (const entry of ngFilters.ids) {
          if (!ngScopeMatches(entry, curBoard, curThread)) continue;
          if (idMatch[1] === ngVal(entry)) {
            const hit = consider(ngEntryMode(entry), `NG ID: ${ngVal(entry)}`);
            if (hit) return hit;
          }
        }
      }
    }
    return best;
  };
  const isNgFiltered = (resp: { name: string; mail?: string; time: string; text: string }): boolean => getNgResult(resp) !== null;

  // 画像NG (image_words): 本文中の単語に一致したレスの画像だけを非表示にする。
  // 透明/通常あぼ～んの判定とは独立して評価する (あぼ～ん済みのレスに重ねてかけても実害はない)
  const matchesImageWords = (text: string, threadUrlForScope?: string): boolean => {
    if (ngFilters.image_words.length === 0) return false;
    const curThread = (threadUrlForScope ?? threadUrl).trim();
    const curBoard = getBoardUrlFromThreadUrl(curThread);
    return ngFilters.image_words.some((w) => ngScopeMatches(w, curBoard, curThread) && ngMatch(ngVal(w), text));
  };

  const bookmarkCacheRef = useRef<Record<string, number>>({});
  const saveBookmark = (url: string, responseNo: number) => {
    if (isChatUrl(url)) return; // Twitch・YouTube のチャットは流れていくだけなので栞は残さない
    bookmarkCacheRef.current[url] = responseNo;
    const data = bookmarkCacheRef.current;
    saveToFile("bookmarks.json", data);
  };

  const loadBookmark = (url: string): number | null => {
    return bookmarkCacheRef.current[url] ?? null;
  };

  const getVisibleResponseNo = (): number => {
    const container = responseScrollRef.current;
    if (!container) return 0;
    const els = container.querySelectorAll<HTMLElement>("[data-response-no]");
    const containerTop = container.getBoundingClientRect().top;
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > containerTop) {
        return Number(el.dataset.responseNo) || 0;
      }
    }
    return 0;
  };
  const saveScrollPos = (url: string, responseNo?: number) => {
    if (isChatUrl(url)) return;
    const no = responseNo ?? getVisibleResponseNo();
    if (no <= 1) return;
    threadScrollPositions.current[url] = no;
    saveToFile("scroll-positions.json", threadScrollPositions.current);
  };
  const loadScrollPos = (url: string): number => {
    return threadScrollPositions.current[url] ?? 0;
  };
  const isScrollAtBottom = () => {
    const c = responseScrollRef.current;
    if (!c) return false;
    return c.scrollHeight - c.scrollTop - c.clientHeight < 50;
  };

  // Capture the active tab's live scroll state into tabCacheRef.
  // The DOM reads are skipped when the responses pane is unmounted
  // (thread-list view) — reading then would overwrite the last good
  // capture with false/0.
  const saveActiveTabScrollState = () => {
    if (activeTabIndex < 0 || activeTabIndex >= threadTabs.length) return;
    const curUrl = threadTabs[activeTabIndex].threadUrl;
    const cached = tabCacheRef.current.get(curUrl);
    if (!cached) return;
    cached.selectedResponse = selectedResponse;
    if (responseScrollRef.current) {
      cached.scrollAtBottom = isScrollAtBottom();
      cached.scrollResponseNo = getVisibleResponseNo();
      saveScrollPos(curUrl);
    }
  };
  // スレの表示欄から離れる (ビュワー・スレ一覧へ切り替える) 直前に、今の位置を覚えておく。
  // 表示欄は離れると DOM から外れ、戻ったときは作り直される (覚えていないと古い位置か一番上に戻ってしまう)
  const rememberBeforeLeavingResponses = () => {
    if (activePaneView === "responses") saveActiveTabScrollState();
  };

  // タブ切替直後のちらつき対策: レス表示欄を visibility: hidden にしておき、scrollHeight が 2 フレーム続けて同じに
  // なったら (最長 0.4 秒) 表示する。隠している間も scrollToBottom / scrollToResponseNo は動くので、
  // 表示された時点で位置が合っている (画像やカードの読み込みで数レス分ずれて見える問題の対策)
  const settleResponsePane = () => {
    const run = ++responsePaneSettleRunRef.current;
    setResponsePaneSettling(true);
    const startedAt = performance.now();
    let lastH = -1;
    let stable = 0;
    const tick = () => {
      if (responsePaneSettleRunRef.current !== run) return;
      const el = responseScrollRef.current;
      const h = el ? el.scrollHeight : -1;
      if (el && h === lastH) stable++; else stable = 0;
      lastH = h;
      if ((el && stable >= 2) || performance.now() - startedAt > 400) { setResponsePaneSettling(false); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const scrollToBottom = () => {
    // 前の追従を止める (二重に動かさない)
    if (followBottomCleanupRef.current) { followBottomCleanupRef.current(); followBottomCleanupRef.current = null; }
    // Phase 0: the responses pane may not be mounted yet (e.g. switching from
    // the thread-list view unmounts it) — wait for the container to appear.
    let mountAttempts = 0;
    const start = () => {
      const c = responseScrollRef.current;
      if (!c) {
        if (mountAttempts < 10) {
          mountAttempts++;
          requestAnimationFrame(start);
        }
        return;
      }

      let active = true;
      let prevScrollHeight = c.scrollHeight;
      const lenAtStart = fetchedResponsesLenRef.current;

      const tryScroll = (attempts: number) => {
        if (!active) return;
        const el = responseScrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        if (el.scrollHeight - el.scrollTop - el.clientHeight > 8 && attempts < 10) {
          requestAnimationFrame(() => tryScroll(attempts + 1));
        }
      };

      // Cancel only on real user input. Programmatic scrolls and the browser
      // clamping scrollTop when tab content is swapped never fire these events,
      // so content swaps can't be mistaken for a user scroll.
      const onUserInput = () => cleanup();

      // Poll for scrollHeight changes from images loading after the initial scroll.
      // rAF retries finish in ~160ms but network images expand scrollHeight over seconds.
      // 画像・カードの読み込みで高さが伸びるたびに最下行へ合わせ直す。時間制限は設けず、
      // ユーザーがスクロールするか、別の位置合わせが始まるまで追従する。
      // 自動スクロール OFF で新着が増えたときは追従を止める (ユーザーの位置を勝手に動かさない)
      const pollInterval = setInterval(() => {
        if (!active) { clearInterval(pollInterval); return; }
        if (!c.isConnected) { cleanup(); return; } // スレ一覧表示などで要素が外れたら追従を終える
        if (!autoScrollEnabledRef.current && fetchedResponsesLenRef.current !== lenAtStart) { cleanup(); return; }
        if (c.scrollHeight !== prevScrollHeight) {
          prevScrollHeight = c.scrollHeight;
          c.scrollTop = c.scrollHeight;
        }
      }, 150);
      const onNavKey = (e: KeyboardEvent) => {
        if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") cleanup();
      };

      const cleanup = () => {
        active = false;
        clearInterval(pollInterval);
        c.removeEventListener("wheel", onUserInput);
        c.removeEventListener("mousedown", onUserInput);
        c.removeEventListener("touchstart", onUserInput);
        window.removeEventListener("keydown", onNavKey);
        if (followBottomCleanupRef.current === cleanup) followBottomCleanupRef.current = null;
      };

      c.addEventListener("wheel", onUserInput, { passive: true });
      c.addEventListener("mousedown", onUserInput, { passive: true });
      c.addEventListener("touchstart", onUserInput, { passive: true });
      window.addEventListener("keydown", onNavKey);
      followBottomCleanupRef.current = cleanup;
      requestAnimationFrame(() => tryScroll(0));
    };
    start();
  };

  const scrollToResponseNo = (no: number) => {
    if (followBottomCleanupRef.current) { followBottomCleanupRef.current(); followBottomCleanupRef.current = null; }
    if (no <= 1) return;
    // Phase 1: wait for the element to appear in DOM (rAF retry)
    let attempts = 0;
    const tryScroll = () => {
      const container = responseScrollRef.current;
      const el = container?.querySelector<HTMLElement>(`[data-response-no="${no}"]`);
      if (el && container) {
        el.scrollIntoView({ block: "start", behavior: "instant" });

        // Phase 2: correct scroll as images load and expand scrollHeight
        // ResizeObserver watches clientHeight (layout box) — doesn't fire when scrollHeight grows.
        // Poll scrollHeight instead, which reliably detects image-load-driven content expansion.
        let active = true;
        let prevScrollHeight = container.scrollHeight;
        let correctionTimer: ReturnType<typeof setTimeout> | null = null;

        const correct = () => {
          if (!active) return;
          const elRect = el.getBoundingClientRect();
          const cRect = container.getBoundingClientRect();
          const delta = elRect.top - cRect.top;
          if (Math.abs(delta) > 2) container.scrollTop += delta;
        };

        // Cancel only on real user input — programmatic scrolls and scrollTop
        // clamping from content swaps never fire these events.
        const onUserInput = () => cleanup();
        container.addEventListener("wheel", onUserInput, { passive: true });
        container.addEventListener("mousedown", onUserInput, { passive: true });
        container.addEventListener("touchstart", onUserInput, { passive: true });

        const pollInterval = setInterval(() => {
          if (!active) { clearInterval(pollInterval); return; }
          if (container.scrollHeight !== prevScrollHeight) {
            prevScrollHeight = container.scrollHeight;
            if (correctionTimer) clearTimeout(correctionTimer);
            correctionTimer = setTimeout(correct, 0);
          }
        }, 100);

        const cleanup = () => {
          active = false;
          clearInterval(pollInterval);
          if (correctionTimer) clearTimeout(correctionTimer);
          container.removeEventListener("wheel", onUserInput);
          container.removeEventListener("mousedown", onUserInput);
          container.removeEventListener("touchstart", onUserInput);
        };
        setTimeout(cleanup, 4000);
      } else if (attempts < 10) {
        attempts++;
        requestAnimationFrame(tryScroll);
      }
    };
    requestAnimationFrame(tryScroll);
  };

  const toggleCategory = (name: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      saveToFile("expanded-categories.json", [...next]);
      return next;
    });
  };

  const openThreadInTab = (url: string, title: string) => {
    setActivePaneView("responses");
    setResponseSearchQuery("");
    setResponseSearchMode(null);
    setSearchMatchIndex(0);
    const existingIndex = threadTabs.findIndex((t) => t.threadUrl === url);
    if (existingIndex >= 0) {
      if (existingIndex === activeTabIndex) {
        setThreadUrl(url);
        setLocationInput(url);
        void fetchResponsesFromCurrent(url, { keepSelection: true });
        return;
      }
      if (activeTabIndex >= 0 && activeTabIndex < threadTabs.length) {
        const curUrl = threadTabs[activeTabIndex].threadUrl;
        const cached = tabCacheRef.current.get(curUrl);
        if (cached) cached.newResponseStart = newResponseStart;
        saveActiveTabScrollState();
        saveBookmark(curUrl, selectedResponse);
      }
      setActiveTabIndex(existingIndex);
      const cached = tabCacheRef.current.get(url);
      if (cached && cached.responses.length > 0) {
        setFetchedResponses(cached.responses);
        const bm = loadBookmark(url);
        const nextSel = bm ?? cached.selectedResponse;
        if (nextSel !== selectedResponse) suppressResponseSelScrollRef.current = true;
        setSelectedResponse(nextSel);
        setNewResponseStart(cached.newResponseStart ?? null);
        settleResponsePane();
        if (cached.scrollAtBottom) scrollToBottom();
        else scrollToResponseNo(cached.scrollResponseNo ?? loadScrollPos(url));
      } else if (isTauriRuntime()) {
        invoke<string | null>("load_thread_cache", { threadUrl: url }).then((json) => {
          if (json) {
            try {
              const rows = JSON.parse(json) as ThreadResponseItem[];
              if (rows.length > 0) {
                const bm = loadBookmark(url);
                const savedNo = loadScrollPos(url);
                const restoreNo = bm ?? (savedNo > 1 ? savedNo : 1);
                setFetchedResponses(rows);
                setSelectedResponse((prev) => {
                  if (restoreNo > 1 && restoreNo !== prev) suppressResponseSelScrollRef.current = true;
                  return restoreNo;
                });
                tabCacheRef.current.set(url, { responses: rows, selectedResponse: restoreNo });
                if (restoreNo > 1) scrollToResponseNo(restoreNo);
              }
            } catch { /* ignore */ }
          }
        }).catch(() => {});
      }
      setThreadUrl(url);
      setLocationInput(url);
      return;
    }
    if (activeTabIndex >= 0 && activeTabIndex < threadTabs.length) {
      const curUrl = threadTabs[activeTabIndex].threadUrl;
      const cached = tabCacheRef.current.get(curUrl);
      if (cached) cached.newResponseStart = newResponseStart;
      saveActiveTabScrollState();
      saveBookmark(curUrl, selectedResponse);
    }
    if (threadTabs.length >= maxOpenTabsRef.current) {
      setStatus(`タブ上限 (${maxOpenTabsRef.current}) に達しました`);
      return;
    }
    setNewResponseStart(null);
    const newTabs = [...threadTabs, { threadUrl: url, title }];
    setThreadTabs(newTabs);
    setActiveTabIndex(newTabs.length - 1);
    setFetchedResponses([]);
    const bm = loadBookmark(url);
    setSelectedResponse(bm ?? 1);
    setThreadUrl(url);
    setLocationInput(url);
    // Try loading from SQLite cache first, then fetch from network
    if (isTauriRuntime()) {
      invoke<string | null>("load_thread_cache", { threadUrl: url }).then((json) => {
        if (json) {
          try {
            const cached = JSON.parse(json) as ThreadResponseItem[];
            if (cached.length > 0) {
              setFetchedResponses(cached);
              tabCacheRef.current.set(url, { responses: cached, selectedResponse: bm ?? 1 });
              // Don't set newResponseStart from cache — first open should have no "new" marker
              const savedNo = loadScrollPos(url);
              if (savedNo > 1) scrollToResponseNo(savedNo);
            }
          } catch { /* ignore */ }
        }
        void fetchResponsesFromCurrent(url);
      }).catch(() => {
        void fetchResponsesFromCurrent(url);
      });
    } else {
      void fetchResponsesFromCurrent(url);
    }
  };

  const closeTab = (index: number) => {
    if (index < 0 || index >= threadTabs.length) return;
    const closing = threadTabs[index];
    closedTabsRef.current.push({ threadUrl: closing.threadUrl, title: closing.title });
    if (closedTabsRef.current.length > 20) closedTabsRef.current.shift();
    if (index === activeTabIndex) {
      saveBookmark(closing.threadUrl, selectedResponse);
      saveScrollPos(closing.threadUrl);
    }
    tabCacheRef.current.delete(closing.threadUrl);
    const nextTabs = threadTabs.filter((_, i) => i !== index);
    setThreadTabs(nextTabs);
    if (nextTabs.length === 0) {
      setActiveTabIndex(-1);
      setFetchedResponses([]);
      setSelectedResponse(1);
      return;
    }
    let nextIndex: number;
    if (index === activeTabIndex) {
      nextIndex = index >= nextTabs.length ? nextTabs.length - 1 : index;
    } else if (index < activeTabIndex) {
      nextIndex = activeTabIndex - 1;
    } else {
      nextIndex = activeTabIndex;
    }
    setActiveTabIndex(nextIndex);
    const tab = nextTabs[nextIndex];
    const cached = tabCacheRef.current.get(tab.threadUrl);
    if (cached) {
      setFetchedResponses(cached.responses);
      if (cached.selectedResponse !== selectedResponse) suppressResponseSelScrollRef.current = true;
      setSelectedResponse(cached.selectedResponse);
      settleResponsePane();
      if (cached.scrollAtBottom) scrollToBottom();
      else scrollToResponseNo(cached.scrollResponseNo ?? loadScrollPos(tab.threadUrl));
    }
    setThreadUrl(tab.threadUrl);
    setLocationInput(tab.threadUrl);
  };

  const onTabClick = (index: number) => {
    const paneWasUnmounted = activePaneView !== "responses";
    setActivePaneView("responses");
    if (index === activeTabIndex) {
      // Same tab, but coming back from the thread-list view: the responses
      // pane is remounting at scrollTop=0 and no tab switch will restore it.
      if (paneWasUnmounted && index >= 0 && index < threadTabs.length) {
        const tab = threadTabs[index];
        const cached = tabCacheRef.current.get(tab.threadUrl);
        if (cached) {
          settleResponsePane();
          if (cached.scrollAtBottom) scrollToBottom();
          else scrollToResponseNo(cached.scrollResponseNo ?? loadScrollPos(tab.threadUrl));
        } else {
          const savedNo = loadScrollPos(tab.threadUrl);
          if (savedNo > 1) scrollToResponseNo(savedNo);
        }
      }
      return;
    }
    saveActiveTabScrollState();
    setActiveTabIndex(index);
    const tab = threadTabs[index];
    setLastFetchTime(threadFetchTimesRef.current[tab.threadUrl] ?? null);
    const cached = tabCacheRef.current.get(tab.threadUrl);
    if (cached) {
      setFetchedResponses(cached.responses);
      if (cached.selectedResponse !== selectedResponse) suppressResponseSelScrollRef.current = true;
      setSelectedResponse(cached.selectedResponse);
      settleResponsePane();
      if (cached.scrollAtBottom) scrollToBottom();
      else scrollToResponseNo(cached.scrollResponseNo ?? loadScrollPos(tab.threadUrl));
    } else {
      setFetchedResponses([]);
      setSelectedResponse(1);
      void fetchResponsesFromCurrent(tab.threadUrl);
    }
    setThreadUrl(tab.threadUrl);
    setLocationInput(tab.threadUrl);
  };

  const closeOtherTabs = (keepIndex: number) => {
    const kept = threadTabs[keepIndex];
    if (!kept) return;
    for (const tab of threadTabs) {
      if (tab.threadUrl !== kept.threadUrl) tabCacheRef.current.delete(tab.threadUrl);
    }
    setThreadTabs([kept]);
    setActiveTabIndex(0);
    const cached = tabCacheRef.current.get(kept.threadUrl);
    if (cached) {
      setFetchedResponses(cached.responses);
      setSelectedResponse(cached.selectedResponse);
    }
    setThreadUrl(kept.threadUrl);
    setLocationInput(kept.threadUrl);
  };

  const closeAllTabs = () => {
    tabCacheRef.current.clear();
    setThreadTabs([]);
    setActiveTabIndex(-1);
    setFetchedResponses([]);
    setSelectedResponse(1);
  };

  const toggleThreadSort = (key: "fetched" | "id" | "title" | "res" | "got" | "new" | "lastFetch" | "speed" | "since") => {
    if (threadSortKey === key) {
      setThreadSortAsc((prev) => !prev);
    } else {
      setThreadSortKey(key);
      setThreadSortAsc(key === "id" || key === "title" || key === "fetched");
    }
  };

  const selectBoard = (board: BoardEntry) => {
    setSelectedBoard(board.boardName);
    lastBoardUrlRef.current = board.url;
    setLocationInput(board.url);
    setThreadUrl(board.url);
    // Open or activate board tab
    setBoardTabs((prev) => {
      const existing = prev.findIndex((t) => t.boardUrl === board.url);
      if (existing >= 0) {
        setActiveBoardTabIndex(existing);
        return prev;
      }
      setActiveBoardTabIndex(prev.length);
      return [...prev, { boardUrl: board.url, title: board.boardName }];
    });
    rememberBeforeLeavingResponses();
    setActivePaneView("threads");
    void fetchThreadListFromCurrent(board.url);
  };


  const paneFontSize = (pane: PaneName): [number, React.Dispatch<React.SetStateAction<number>>] => {
    switch (pane) {
      case "boards": return [boardsFontSize, setBoardsFontSize];
      case "threads": return [threadsFontSize, setThreadsFontSize];
      case "responses": return [responsesFontSize, setResponsesFontSize];
    }
  };
  const paneLabel = (pane: PaneName) => pane === "boards" ? "板" : pane === "threads" ? "スレ" : "レス";

  const applyLocationToThread = () => {
    const next = locationInput.trim();
    if (!next) return;
    setThreadUrl(next);
    setStatus(`thread target updated: ${next}`);
  };

  const fetchThreadListFromCurrent = async (targetThreadUrl?: string) => {
    // Switching to the thread-list view unmounts the responses pane —
    // capture the active tab's scroll state before it's destroyed.
    saveActiveTabScrollState();
    setShowFavoritesOnly(false);
    const url = (targetThreadUrl ?? threadUrl).trim();
    if (!url) return;
    // Clear stale thread list when switching to a different board
    if (activeBoardUrlRef.current !== url) {
      setFetchedThreads([]);
    }
    activeBoardUrlRef.current = url;
    // Switch to thread list view whenever a board is being fetched
    rememberBeforeLeavingResponses();
    setActivePaneView("threads");
    if (!isTauriRuntime()) {
      setThreadListProbe("web preview mode: thread fetch requires tauri runtime");
      setStatus("thread fetch unavailable in web preview");
      return;
    }
    setThreadListProbe("running...");
    setShowCachedOnly(false);
    setStatus(`loading threads from: ${url}`);
    setLocationInput(url);
    try {
      const rows = await invoke<ThreadListItem[]>("fetch_thread_list", {
        threadUrl: url,
        limit: null,
      });
      // Discard if board switched while this fetch was in flight
      if (activeBoardUrlRef.current !== url) return;
      await loadReadStatusForBoard(url, rows);
      setFetchedThreads(rows);
      if (!keepSortOnRefreshRef.current) {
        setThreadSortKey("id");
        setThreadSortAsc(true);
      }
      setThreadSearchQuery("");
      // Keep selection on the currently open tab's thread, or clear
      suppressThreadScrollRef.current = true;
      if (activeTabIndex >= 0 && activeTabIndex < threadTabs.length) {
        const activeUrl = threadTabs[activeTabIndex].threadUrl;
        setSelectedThread(rows.some((r) => r.threadUrl === activeUrl) ? activeUrl : null);
      } else {
        setSelectedThread(null);
      }
      if (threadListScrollRef.current) threadListScrollRef.current.scrollTop = 0;
      setThreadListProbe(`ok rows=${rows.length}`);
      setStatus(`threads loaded: ${rows.length}`);
    } catch (error) {
      if (activeBoardUrlRef.current !== url) return;
      const msg = String(error);
      setThreadListProbe(`error: ${msg}`);
      setStatus(`thread load error: ${msg}`);
      setFetchedThreads([]);
    }
  };

  // Fetch responses for a background tab (updates cache + new arrivals, no UI update)
  const fetchBackgroundTabResponses = async (tabUrl: string, tabTitle: string) => {
    // Twitch・YouTube のタブはチャットを受信して積むので、巡回はしない
    if (!isTauriRuntime() || isChatUrl(tabUrl)) return;
    try {
      const cached = tabCacheRef.current.get(tabUrl);
      const prevResponses = cached?.responses ?? [];
      const prevCount = prevResponses.length;
      // Differential fetch: pass last known response_no so backend returns only new responses.
      // ID が付いていない古いしたらばキャッシュ (rawmode 時代) は書き込み回数を数えられないので、一度だけ全件取り直して
      // キャッシュを置き換える (新着として扱うのは既知の最終レス番号より後のものだけ)。ID 非表示の板で毎回全件取らないよう 1 回限り
      const lastKnownNo = prevCount > 0 ? prevResponses[prevCount - 1].responseNo : undefined;
      const fullRefetch = prevCount > 0 && cacheLacksIds(tabUrl, prevResponses) && !idRefetchDoneRef.current.has(tabUrl);
      const lastResNo = fullRefetch ? undefined : lastKnownNo;
      const result = await invoke<{ responses: ThreadResponseItem[]; title: string | null }>(
        "fetch_thread_responses_command",
        { threadUrl: tabUrl, limit: null, sinceResNo: lastResNo ?? null }
      );
      const fetched = result.responses;
      if (fullRefetch) idRefetchDoneRef.current.add(tabUrl);
      const newRows = fullRefetch ? fetched.filter((r) => r.responseNo > (lastKnownNo ?? 0)) : fetched;
      // Merge: full list = previous cached + new rows (全件取り直しのときは取得結果で置き換え)
      const rows = fullRefetch ? fetched : lastResNo != null ? [...prevResponses, ...fetched] : fetched;
      if (rows.length === 0) return;
      tabCacheRef.current.set(tabUrl, { responses: rows, selectedResponse: cached?.selectedResponse ?? 1, scrollResponseNo: cached?.scrollResponseNo, newResponseStart: cached?.newResponseStart });
      if (newRows.length === 0 && prevCount > 0) return; // no new responses
      if (prevCount > 0 && newRows.length > 0) {
        const now = new Date();
        const timeStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
        threadFetchTimesRef.current[tabUrl] = timeStr;
        const arrivals = newRows
          .filter((r) => showsArrivalResNo(tabUrl, r.responseNo))
          .filter((r) => getNgResult({ name: r.name, mail: r.mail, time: r.dateAndId, text: r.body.replace(/<[^>]*>/g, "") }, tabUrl)?.mode !== "hide")
          .map((r) => makeArrival(r, tabTitle, tabUrl, rows));
        if (autoRefreshEnabled && arrivals.length > 0) {
          const queueWasEmpty = arrivalQueueRef.current.length === 0;
          arrivalQueueRef.current.push(...arrivals);
          setArrivalQueueCount(arrivalQueueRef.current.length);
          pushBroadcastArrivals(arrivals);
          if (!arrivalPausedRef.current && !arrivalTimerRef.current && (currentArrivalItemRef.current === null || queueWasEmpty)) {
            advanceToNextArrival();
          }
        }
        if (ttsEnabled && ttsMode !== "off") {
          const site = detectSiteType(tabUrl);
          for (const a of arrivals) {
            if (!speaksResNo(tabUrl, a.responseNo)) continue;
            const prefix = speakPrefixFor(site, a.responseNo, a.name);
            ttsSpeakBoardArrival(a, prefix);
          }
        }
      }
    } catch {
      // silent — background fetch failures are non-critical
    }
  };

  const refreshThreadListSilently = async () => {
    const url = (activeBoardUrlRef.current || threadUrl).trim();
    if (!url || !isTauriRuntime()) return;
    try {
      const rows = await invoke<ThreadListItem[]>("fetch_thread_list", {
        threadUrl: url,
        limit: null,
      });
      if (activeBoardUrlRef.current !== url) return;
      setFetchedThreads(rows);
      void loadReadStatusForBoard(url, rows);
    } catch {
      // silent refresh — ignore errors
    }
  };

  const fetchFavNewCounts = async () => {
    if (!isTauriRuntime()) return;
    setFavNewCountsFetched(false);
    // Group favorite threads by board URL (always derive from threadUrl)
    const boardMap = new Map<string, FavoriteThread[]>();
    for (const ft of favorites.threads) {
      const bUrl = getBoardUrlFromThreadUrl(ft.threadUrl);
      const arr = boardMap.get(bUrl) ?? [];
      arr.push(ft);
      boardMap.set(bUrl, arr);
    }
    const counts = new Map<string, number>();
    setStatus("お気に入りスレの新着を確認中...");
    // Load read status for all boards
    let allReadStatus: Record<string, Record<string, number>> = {};
    try {
      allReadStatus = await invoke<Record<string, Record<string, number>>>("load_read_status");
    } catch {
      console.warn("load_read_status failed for fav new counts");
    }
    await Promise.all(
      Array.from(boardMap.entries()).map(async ([boardUrl, threads]) => {
        try {
          const rows = await invoke<ThreadListItem[]>("fetch_thread_list", {
            threadUrl: boardUrl,
            limit: null,
          });
          for (const ft of threads) {
            const matched = rows.find((r) => r.threadUrl === ft.threadUrl);
            if (matched) {
              counts.set(ft.threadUrl, matched.responseCount);
            }
          }
        } catch {
          console.warn(`fav new count fetch failed for board: ${boardUrl}`);
        }
      })
    );
    // Build readMap and lastReadMap for favorites
    const readMap: Record<string, boolean> = {};
    const lastReadMap: Record<string, number> = {};
    favorites.threads.forEach((ft) => {
      const bUrl = getBoardUrlFromThreadUrl(ft.threadUrl);
      const boardStatus = allReadStatus[bUrl] ?? {};
      // Extract thread key from URL
      const parts = ft.threadUrl.replace(/\/$/, "").split("/");
      const threadKey = parts[parts.length - 1] ?? "";
      const lastRead = boardStatus[threadKey] ?? 0;
      readMap[ft.threadUrl] = lastRead > 0;
      lastReadMap[ft.threadUrl] = lastRead;
    });
    setThreadReadMap(readMap);
    setThreadLastReadCount(lastReadMap);
    setFavNewCounts(counts);
    setFavNewCountsFetched(true);
    setStatus(`お気に入り新着確認完了 (${counts.size}/${favorites.threads.length}スレ)`);
  };

  const fetchResponsesFromCurrent = async (targetThreadUrl?: string, opts?: { keepSelection?: boolean; resetScroll?: boolean }) => {
    const url = (targetThreadUrl ?? threadUrl).trim();
    if (!url) return;
    // Twitch・YouTube のタブはチャットを受信して積むだけなので、取得はせず手元にある分を表示する
    if (isChatUrl(url)) {
      const rows = tabCacheRef.current.get(url)?.responses ?? [];
      setFetchedResponses(rows);
      const tw = isTwitchUrl(url);
      setResponseListProbe(`${tw ? "twitch" : "youtube"} rows=${rows.length}`);
      if (!opts?.keepSelection) setStatus(`${tw ? `Twitch #${twitchChannelFromUrl(url)}` : "YouTube"}: ${rows.length > 0 ? `${rows.length}件` : "チャットの受信を待っています"}`);
      return;
    }
    if (!/\/(test|bbs)\/read\.cgi\/[^/]+\/[^/]+/.test(new URL(url, "https://dummy").pathname)) {
      setResponseListProbe("スレッドを選択してください");
      return;
    }
    if (!isTauriRuntime()) {
      setResponseListProbe("web preview mode: response fetch requires tauri runtime");
      return;
    }
    setResponseListProbe("running...");
    if (!opts?.keepSelection) setResponsesLoading(true);
    try {
      const result = await invoke<{ responses: ThreadResponseItem[]; title: string | null }>("fetch_thread_responses_command", {
        threadUrl: url,
        limit: null,
      });
      const rows = result.responses;
      const fetchedTitle = result.title ? decodeHtmlEntities(result.title) : null;
      // Update tab title if server returned a real title (e.g. from read.cgi HTML)
      if (fetchedTitle) {
        setThreadTabs((prev) => prev.map((t) => t.threadUrl === url ? { ...t, title: fetchedTitle } : t));
      }
      const cachedEntry = tabCacheRef.current.get(url);
      const prevCount = cachedEntry ? cachedEntry.responses.length : 0;
      // If server returned empty but we have cached data, keep cache
      if (rows.length === 0 && prevCount > 0) {
        setResponseListProbe(`ok rows=0 (kept cached ${prevCount})`);
        setStatus(`レス取得: 0件 (キャッシュ ${prevCount}件を維持)`);
        return;
      }

      if (opts?.keepSelection) {
        // Auto-refresh: skip re-render if no new responses
        if (rows.length <= prevCount) {
          setResponseListProbe(`ok rows=${rows.length} (no change)`);
          return;
        }
        // New responses arrived — update DOM and scroll
        if (autoScrollEnabled) pendingAutoScrollRef.current = true;
        setFetchedResponses(rows);
      } else if (opts?.resetScroll) {
        setResponsesLoading(false);
        setFetchedResponses(rows);
        setSelectedResponse(rows.length > 0 ? rows[0].responseNo : 1);
        setTimeout(() => {
          if (responseScrollRef.current) responseScrollRef.current.scrollTop = 0;
        }, 50);
      } else {
        setResponsesLoading(false);
        setFetchedResponses(rows);
        const savedNo = loadScrollPos(url);
        const bm = loadBookmark(url);
        const nextSel = bm ?? (rows.length > 0 ? rows[0].responseNo : 1);
        setSelectedResponse((prev) => {
          if (savedNo > 1 && nextSel !== prev) suppressResponseSelScrollRef.current = true;
          return nextSel;
        });
        if (savedNo > 1) {
          scrollToResponseNo(savedNo);
        }
      }
      // 覚えていた位置は残す (ビュワーなどにいる間の自動更新で消えると、戻ったときに一番上や古い位置になってしまう)。
      // 位置を戻さない読み込み (resetScroll) のときだけ捨てる
      const keep = opts?.resetScroll ? undefined : cachedEntry;
      tabCacheRef.current.set(url, {
        responses: rows,
        selectedResponse: opts?.keepSelection && cachedEntry ? cachedEntry.selectedResponse : (rows.length > 0 ? rows[0].responseNo : 1),
        scrollResponseNo: keep?.scrollResponseNo,
        scrollAtBottom: keep?.scrollAtBottom,
        newResponseStart: opts?.keepSelection ? cachedEntry?.newResponseStart : undefined,
      });
      // persist to SQLite
      const tabTitle = fetchedTitle
        ?? threadTabs.find((t) => t.threadUrl === url)?.title
        ?? fetchedThreads.find((t) => t.threadUrl === url)?.title
        ?? "";
      invoke("save_thread_cache", { threadUrl: url, title: tabTitle, responsesJson: JSON.stringify(rows) }).catch(() => {});
      const now = new Date();
      const timeStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      setLastFetchTime(timeStr);
      threadFetchTimesRef.current[url] = timeStr;
      saveToFile("thread-fetch-times.json", threadFetchTimesRef.current);
      // Update thread list read counts and response count
      const threadListIndex = fetchedThreads.findIndex((ft) => ft.threadUrl === url);
      if (threadListIndex >= 0) {
        setThreadReadMap((prev) => ({ ...prev, [url]: true }));
        setThreadLastReadCount((prev) => ({ ...prev, [url]: rows.length }));
        if (rows.length > fetchedThreads[threadListIndex].responseCount) {
          setFetchedThreads((prev) => prev.map((ft, i) => i === threadListIndex ? { ...ft, responseCount: rows.length } : ft));
        }
        const ft = fetchedThreads[threadListIndex];
        const boardUrl = getBoardUrlFromThreadUrl(url);
        void persistReadStatus(boardUrl, ft.threadKey, rows.length);
      }
      if (prevCount > 0 && rows.length > prevCount) {
        setNewResponseStart(prevCount + 1);
        setStatus(`新着 ${rows.length - prevCount} レス (${rows.length})`);
        // Update new arrival pane
        const arrivalTitle = fetchedTitle
          ?? threadTabs.find((t) => t.threadUrl === url)?.title
          ?? fetchedThreads.find((t) => t.threadUrl === url)?.title
          ?? url;
        const newRows = rows.slice(prevCount);
        const arrivals = newRows
          .filter((r) => showsArrivalResNo(url, r.responseNo))
          .filter((r) => getNgResult({ name: r.name, mail: r.mail, time: r.dateAndId, text: r.body.replace(/<[^>]*>/g, "") }, url)?.mode !== "hide")
          .map((r) => makeArrival(r, arrivalTitle, url, rows));
        // Add to new arrivals pane when autoReload is ON
        if (autoRefreshEnabled && arrivals.length > 0) {
          const queueWasEmpty = arrivalQueueRef.current.length === 0;
          arrivalQueueRef.current.push(...arrivals);
          setArrivalQueueCount(arrivalQueueRef.current.length);
          pushBroadcastArrivals(arrivals);
          if (!arrivalPausedRef.current && !arrivalTimerRef.current && (currentArrivalItemRef.current === null || queueWasEmpty)) {
            advanceToNextArrival();
          }
        }
        // Update subtitle directly only on manual refresh (auto-refresh uses queue via advanceToNextArrival)
        if (arrivals.length > 0 && !autoRefreshEnabled) {
          const latest = arrivals[arrivals.length - 1];
          subtitleUpdate({ threadTitle: latest.threadTitle, responseNo: latest.responseNo, name: latest.name, mail: latest.mail, id: latest.id, date: latest.time, body: latest.text, idSeq: latest.idSeq, idCount: latest.idCount }, latest);
        }
        // TTS: 5ch の1001番 (定型文) は読まない。したらば・JPNKN は番号で除外しない
        if (ttsEnabled && ttsMode !== "off") {
          const site = detectSiteType(url);
          for (const a of arrivals) {
            if (!speaksResNo(url, a.responseNo)) continue;
            const prefix = speakPrefixFor(site, a.responseNo, a.name);
            ttsSpeakBoardArrival(a, prefix);
          }
        }
      } else {
        setNewResponseStart(null);
        setStatus(`responses loaded: ${rows.length}`);
      }
      setResponseListProbe(`ok rows=${rows.length}`);
    } catch (error) {
      const msg = String(error);
      // Keep existing responses on error instead of clearing
      setResponseListProbe(`error: ${msg}`);
      const isDatOchi = msg.includes("404") || msg.includes("Not Found") || msg.includes("HttpStatus");
      setStatus(isDatOchi ? `dat落ちまたは存在しないスレです` : `response load error: ${msg}`);
    } finally {
      if (!opts?.keepSelection) setResponsesLoading(false);
    }
  };

  // ===== Twitch チャット (匿名・読み取り専用) =====
  // Rust 側 (twitch_sync) が受信したチャットを "twitch-message" イベントで受け取り、Twitch タブのレスとして積む。
  // 1件 = 1レスとし、ID 欄にログイン名を入れる (ID の NG・ハイライト・書き込み回数・配信ホワイトリストがそのまま効く)。
  // 本文と名前は HTML として解釈されないようエスケープしてから積む (表示時に文字参照が戻されて文字として出る)
  type TwitchChatPayload = { channel: string; id?: unknown; login: string; name: string; color: string; text: string; receivedAt: number; event?: TwitchEventData | null; badges?: unknown; emotes?: unknown; giant?: unknown };
  // Twitch タブのレス番号 → 発言 ID (返信に使う。タブに残っている分だけ)
  const twitchMsgIdRef = useRef<Map<string, Map<number, string>>>(new Map());
  const twitchPendingRef = useRef<TwitchChatPayload[]>([]);
  const twitchFlushTimerRef = useRef<number | null>(null);
  const formatChatTime = (ms: number) => {
    const d = new Date(ms);
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };
  // 読み上げの前置き。Twitch で「名前を読み上げる」がオフなら前置きなし
  const speakPrefixFor = (site: SiteType, no: number, name: string) =>
    speakPrefix(site, no, (site === "twitch" && !twitchSpeakName) || (site === "youtube" && !youtubeSpeakName) ? "" : name);
  // 設定 > 接続: Twitch チャンネル・スレを複数まとめて開く (開いているタブがそのまま受信・巡回の対象)
  const [twitchStatusMap, setTwitchStatusMap] = useState<Record<string, string>>({});
  const [connectTwitchInput, setConnectTwitchInput] = useState("");
  const [connectThreadInput, setConnectThreadInput] = useState("");
  const addConnectTabs = (entries: { url: string; title: string }[]) => {
    const existing = new Set(threadTabs.map((t) => t.threadUrl));
    const fresh = entries.filter((e, i) => !existing.has(e.url) && entries.findIndex((x) => x.url === e.url) === i);
    const room = Math.max(0, maxOpenTabsRef.current - threadTabs.length);
    const adding = fresh.slice(0, room);
    if (adding.length > 0) setThreadTabs((prev) => [...prev, ...adding.map((e) => ({ threadUrl: e.url, title: e.title }))]);
    const skipped = fresh.length - adding.length;
    setStatus(`${adding.length}件追加しました${skipped > 0 ? ` (タブ上限のため ${skipped}件は追加していません)` : ""}${entries.length - fresh.length > 0 ? ` / 開いているもの ${entries.length - fresh.length}件` : ""}`);
  };
  const submitConnectTwitch = () => {
    const chans = connectTwitchInput.split(/[\s,、]+/).map((v) => twitchChannelFromInput(v.startsWith("#") ? `twitch.tv/${v.slice(1)}` : v.includes(".") ? v : `twitch.tv/${v}`)).filter((c): c is string => c !== null);
    if (chans.length === 0) { setStatus("チャンネル名の形式が正しくありません (英数字と _ の1〜25文字)"); return; }
    addConnectTabs(chans.map((c) => ({ url: twitchTabUrl(c), title: `Twitch #${c}` })));
    setConnectTwitchInput("");
  };
  const submitConnectThreads = () => {
    const urls = connectThreadInput.split(/\s+/).map((v) => rewrite5chNet(v.trim())).filter((v) => {
      try { return /\/(test|bbs)\/read\.cgi\/[^/]+\/[^/]+/.test(new URL(v).pathname); } catch { return false; }
    });
    if (urls.length === 0) { setStatus("スレッドの URL (…/read.cgi/板/番号/) を入力してください"); return; }
    addConnectTabs(urls.map((u) => {
      const parts = u.replace(/\/+$/, "").split("/");
      return { url: u, title: `${parts[parts.length - 2] ?? ""}/${parts[parts.length - 1] ?? ""}` };
    }));
    setConnectThreadInput("");
  };
  const flushTwitchMessages = () => {
    twitchFlushTimerRef.current = null;
    const pending = twitchPendingRef.current;
    if (pending.length === 0) return;
    twitchPendingRef.current = [];
    const byChannel = new Map<string, TwitchChatPayload[]>();
    for (const m of pending) {
      if (m.color && /^#[0-9a-f]{6}$/i.test(m.color)) {
        twitchColorRef.current.set(m.login, m.color);
        if (twitchColorRef.current.size > 5000) twitchColorRef.current.clear();
      }
      const list = byChannel.get(m.channel);
      if (list) list.push(m); else byChannel.set(m.channel, [m]);
    }
    const activeUrl = threadTabsRef.current[activeTabIndexRef.current]?.threadUrl;
    const arrivals: ArrivalItem[] = [];
    for (const [channel, msgs] of byChannel) {
      const url = twitchTabUrl(channel);
      const tab = threadTabsRef.current.find((t) => t.threadUrl === url);
      if (!tab) continue; // タブを閉じた直後に届いた分は捨てる
      const cached = tabCacheRef.current.get(url);
      const prev = cached?.responses ?? [];
      let no = prev.length > 0 ? prev[prev.length - 1].responseNo : 0;
      // イベントは「【種類】要約」+ 添えられたメッセージの1レスにする。「流す」がオフの種類は、
      // メッセージがあれば普通の発言として、無ければ表示しない
      const events: (ArrivalItem["twitchEvent"] | undefined)[] = [];
      const badgeLists: TwitchBadge[][] = [];
      const raws: { text: string; emotes: TwitchEmote[]; giant: boolean }[] = [];
      const emoteMap = twitchEmoteMapRef.current.get(url) ?? new Map<number, { emotes: { id: string; name: string; giant?: boolean }[]; giant: boolean }>();
      const idMap = twitchMsgIdRef.current.get(url) ?? new Map<number, string>();
      const added: ThreadResponseItem[] = [];
      for (const m of msgs) {
        const kindInfo = m.event ? TWITCH_EVENT_KINDS.find((k) => k.kind === m.event!.kind) : undefined;
        const setting = kindInfo ? (twitchEventSettings[kindInfo.kind] ?? defaultTwitchEventSettings()[kindInfo.kind]) : undefined;
        let ev: ArrivalItem["twitchEvent"] | undefined;
        if (m.event && kindInfo && setting) {
          if (!setting.show) {
            if (!m.text.trim()) continue;
          } else {
            const summary = renderTwitchEvent(m.event, setting.template, m.name, "");
            const spoken = twitchSpeechText(m.text, sanitizeTwitchEmotes(m.emotes, m.text), twitchEmoteSpeak, twitchEmoteMax);
            const speechMessage = m.event.kind === "bits" ? stripCheermotes(spoken) : spoken;
            ev = { kind: kindInfo.kind, label: kindInfo.label, summary, message: m.text, speech: renderTwitchEvent(m.event, setting.template, m.name, speechMessage), speak: setting.speak };
          }
        }
        events.push(ev);
        badgeLists.push(sanitizeTwitchBadges(m.badges));
        const emotes = sanitizeTwitchEmotes(m.emotes, m.text);
        const giant = m.giant === true && emotes.some((e) => !e.giant);
        raws.push({ text: m.text, emotes, giant });
        if (emotes.length > 0) {
          const cps = Array.from(m.text);
          learnEmoteNames(emotes.filter((e) => !e.giant).map((e) => ({ name: cps.slice(e.start, e.end + 1).join(""), id: e.id })));
          emoteMap.set(no + 1, { emotes: emotes.map((e) => ({ id: e.id, name: cps.slice(e.start, e.end + 1).join(""), ...(e.giant ? { giant: true } : {}) })), giant });
        }
        added.push({
          responseNo: ++no,
          name: escapeHtml(m.name),
          mail: "",
          dateAndId: `${formatChatTime(m.receivedAt)} ID:${m.login}`,
          body: ev ? `【${escapeHtml(ev.label)}】${escapeHtml(ev.summary)}${m.text ? ` <br> ${escapeHtml(m.text)}` : ""}` : escapeHtml(m.text),
        });
        if (typeof m.id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(m.id)) idMap.set(no, m.id);
      }
      if (added.length === 0) continue;
      const rows = [...prev, ...added].slice(-TWITCH_MAX_ROWS);
      for (const k of idMap.keys()) if (k < (rows[0]?.responseNo ?? 0)) idMap.delete(k);
      twitchMsgIdRef.current.set(url, idMap);
      // 画面から消えたレスのスタンプ情報は捨てる
      const oldest = rows[0]?.responseNo ?? 0;
      for (const k of emoteMap.keys()) if (k < oldest) emoteMap.delete(k);
      if (emoteMap.size > 0) twitchEmoteMapRef.current.set(url, emoteMap);
      else twitchEmoteMapRef.current.delete(url);
      tabCacheRef.current.set(url, { ...(cached ?? { selectedResponse: rows[0]?.responseNo ?? 1 }), responses: rows });
      if (url === activeUrl) {
        if (autoScrollEnabledRef.current) pendingAutoScrollRef.current = true;
        setFetchedResponses(rows);
        setLastFetchTime(formatChatTime(Date.now()));
      }
      added.forEach((r, i) => {
        if (getNgResult({ name: r.name, mail: r.mail, time: r.dateAndId, text: r.body }, url)?.mode === "hide") return;
        const a = makeArrival(r, tab.title, url, rows);
        if (events[i]) a.twitchEvent = events[i];
        if (badgeLists[i]?.length) a.twitchBadges = badgeLists[i];
        if (raws[i]) a.twitchRaw = raws[i];
        arrivals.push(a);
      });
    }
    if (arrivals.length === 0) return;
    // 新着ペイン・字幕・OBS連携 (掲示板の新着と同じ経路)
    const queueWasEmpty = arrivalQueueRef.current.length === 0;
    arrivalQueueRef.current.push(...arrivals);
    const twitchQueued = arrivalQueueRef.current.filter((a) => isTwitchUrl(a.threadUrl)).length;
    if (twitchQueued > twitchMaxQueuedArrivals) {
      let drop = twitchQueued - twitchMaxQueuedArrivals;
      arrivalQueueRef.current = arrivalQueueRef.current.filter((a) => {
        if (drop > 0 && isTwitchUrl(a.threadUrl)) { drop--; return false; }
        return true;
      });
    }
    setArrivalQueueCount(arrivalQueueRef.current.length);
    pushBroadcastArrivals(arrivals);
    if (!arrivalPausedRef.current && !arrivalTimerRef.current && (currentArrivalItemRef.current === null || queueWasEmpty)) {
      advanceToNextArrival();
    }
    // 読み上げ (「名前さん」+ 本文)。読み上げが溜まっているときは新しく積まない。
    // イベントは種類ごとの「読み上げる文」を読む (数が少なく大事なので、溜まっていても読む)
    if (ttsEnabled && ttsMode !== "off") {
      for (const a of arrivals) {
        if (a.twitchEvent) {
          if (a.twitchEvent.speak && !a.isAbone && !isTabTtsOff(a.threadUrl)) ttsSpeak(a.twitchEvent.speech, "", undefined, { name: a.name, id: a.id });
          continue;
        }
        if (ttsQueueRef.current.length >= twitchMaxTtsBacklog) continue;
        if (a.isAbone || isTabTtsOff(a.threadUrl)) { ttsSpeakArrival(a, speakPrefixFor("twitch", a.responseNo, a.name)); continue; }
        const raw = a.twitchRaw ? twitchSpeechText(a.twitchRaw.text, a.twitchRaw.emotes, twitchEmoteSpeak, twitchEmoteMax) : decodeHtmlEntities(a.text);
        // 教育・忘却は、実際に読み上げに回る発言だけで処理する
        const teach = handleTwitchTeach(a.id, raw);
        if (teach.text.trim() === "" && a.twitchRaw?.emotes.length) continue; // スタンプだけで、読むものが無い
        ttsSpeakArrival({ ...a, text: escapeHtml(teach.text) }, speakPrefixFor("twitch", a.responseNo, a.name), { keepTeachCommands: teach.keep });
        for (const msg of teach.announces) ttsSpeak(msg, "");
      }
    }
  };
  // 設定 > Twitch > イベントの「テスト」: 開いている Twitch タブに、試しのイベントを1件流す (表示・読み上げ・OBS の確認用)
  const testTwitchEvent = (kind: string) => {
    const ch = threadTabs.map((t) => twitchChannelFromUrl(t.threadUrl)).find((c): c is string => !!c);
    if (!ch) { setTwitchEventTestMsg("Twitch のタブを開いてから押してください (テストはそのタブに流れます)"); return; }
    const withMessage = ["sub", "resub", "bits", "watchstreak", "points", "announcement"].includes(kind);
    twitchPendingRef.current.push({
      channel: ch, login: "test_user", name: "テスト", color: "#1e90ff", receivedAt: Date.now(),
      text: withMessage ? (kind === "bits" ? "Cheer100 テストのメッセージです" : "テストのメッセージです") : "",
      event: { kind, months: 12, count: 5, bits: 100, viewers: 30, recipient: "受け取った人", reward: "テストの報酬" },
    });
    flushTwitchMessages();
    setTwitchEventTestMsg(`Twitch #${ch} にテストの「${TWITCH_EVENT_KINDS.find((k) => k.kind === kind)?.label ?? kind}」を流しました`);
  };
  // イベントの受け口は最初の描画時に1回だけ登録するので、最新の状態を参照する処理はこの ref 経由で呼ぶ
  const twitchFlushRef = useRef(flushTwitchMessages);
  twitchFlushRef.current = flushTwitchMessages;

  // ===== YouTube ライブ配信のチャット (読み取り専用) =====
  // Rust 側 (youtube_sync) が受信したチャットを "youtube-message" で受け取り、YouTube タブのレスとして積む。
  // 1件 = 1レスとし、ID 欄に投稿者のチャンネル ID を入れる (ID の NG・ハイライト・配信ホワイトリストがそのまま効く)。
  // 本文と名前は HTML として解釈されないようエスケープしてから積む。
  // 削除された発言は、タブでは本文を「(削除されました)」にし、まだ流していない新着・ビュワー・OBS 表示からは消す
  type YoutubeMessagePayload = { id: string; channelId: string; name: string; text: string; emojis?: unknown; owner?: unknown; moderator?: unknown; member?: unknown; verified?: unknown; event?: YoutubeEventData | null };
  type YoutubeBatch = { video: string; receivedAt: number; messages: YoutubeMessagePayload[]; deleted: string[]; deletedAuthors: string[] };
  const youtubePendingRef = useRef<YoutubeBatch[]>([]);
  const youtubeFlushTimerRef = useRef<number | null>(null);
  // タブごとの 発言 ID → レス番号・投稿者 (削除の知らせと照らし合わせる。タブに残っている分だけ)
  const youtubeMsgIndexRef = useRef<Map<string, Map<string, { no: number; channelId: string }>>>(new Map());
  const [youtubeStatusMap, setYoutubeStatusMap] = useState<Record<string, { state: string; message: string }>>({});
  const [connectYoutubeInput, setConnectYoutubeInput] = useState("");
  const submitConnectYoutube = () => {
    const videos = connectYoutubeInput.split(/[\s,、]+/).map((v) => youtubeVideoFromInput(v)).filter((v): v is string => v !== null);
    if (videos.length === 0) { setStatus("ライブ配信の URL (youtube.com/watch?v=… / youtube.com/live/… / youtu.be/…) を入力してください"); return; }
    addConnectTabs(videos.map((v) => ({ url: youtubeTabUrl(v), title: `YouTube ${v}` })));
    setConnectYoutubeInput("");
  };
  // 削除された発言を、まだ流していない新着・ビュワー・OBS 表示から消す
  const removeChatKeys = (keys: string[]) => {
    if (keys.length === 0) return;
    const set = new Set(keys);
    const before = arrivalQueueRef.current.length;
    arrivalQueueRef.current = arrivalQueueRef.current.filter((a) => !a.chatKey || !set.has(a.chatKey));
    if (arrivalQueueRef.current.length !== before) setArrivalQueueCount(arrivalQueueRef.current.length);
    setViewerItems((prev) => (prev.some((it) => it.key && set.has(it.key)) ? prev.filter((it) => !it.key || !set.has(it.key)) : prev));
    if (isTauriRuntime()) void invoke("overlay_retract", { keys }).catch((e) => console.warn("overlay_retract failed", e));
  };
  const flushYoutubeMessages = () => {
    youtubeFlushTimerRef.current = null;
    const pending = youtubePendingRef.current;
    if (pending.length === 0) return;
    youtubePendingRef.current = [];
    const byVideo = new Map<string, YoutubeBatch[]>();
    for (const b of pending) {
      const list = byVideo.get(b.video);
      if (list) list.push(b); else byVideo.set(b.video, [b]);
    }
    const activeUrl = threadTabsRef.current[activeTabIndexRef.current]?.threadUrl;
    const arrivals: ArrivalItem[] = [];
    const removedKeys: string[] = [];
    for (const [video, batches] of byVideo) {
      const url = youtubeTabUrl(video);
      const tab = threadTabsRef.current.find((t) => t.threadUrl === url);
      if (!tab) continue; // タブを閉じた直後に届いた分は捨てる
      const cached = tabCacheRef.current.get(url);
      const prev = cached?.responses ?? [];
      let no = prev.length > 0 ? prev[prev.length - 1].responseNo : 0;
      const index = youtubeMsgIndexRef.current.get(url) ?? new Map<string, { no: number; channelId: string }>();
      const emoteMap = twitchEmoteMapRef.current.get(url) ?? new Map<number, { emotes: { id: string; name: string; giant?: boolean; url?: string }[]; giant: boolean }>();
      const added: ThreadResponseItem[] = [];
      const extras: { ev?: ArrivalItem["twitchEvent"]; raw?: ArrivalItem["twitchRaw"]; key: string }[] = [];
      const deletedNos = new Set<number>();
      for (const b of batches) {
        for (const m of b.messages) {
          if (!m || typeof m.id !== "string" || typeof m.name !== "string" || typeof m.text !== "string") continue;
          // 同じ発言 ID がもう出ていれば除く (自分の書き込みは送ったときにすぐ出すので、受信で届いた分は重ねない)
          if (m.id && index.has(m.id)) continue;
          const channelId = typeof m.channelId === "string" && YT_CHANNEL_ID_RE.test(m.channelId) ? m.channelId : "";
          const color = youtubeRoleColor(m);
          if (channelId) {
            if (color) twitchColorRef.current.set(channelId, color); else twitchColorRef.current.delete(channelId);
            if (twitchColorRef.current.size > 5000) twitchColorRef.current.clear();
          }
          // イベントは「【種類】要約」+ 添えられたメッセージの1レスにする。「流す」がオフの種類は、
          // メッセージがあれば普通の発言として、無ければ表示しない
          const kindInfo = m.event ? YOUTUBE_EVENT_KINDS.find((k) => k.kind === m.event!.kind) : undefined;
          const setting = kindInfo ? (youtubeEventSettings[kindInfo.kind] ?? defaultYoutubeEventSettings()[kindInfo.kind]) : undefined;
          let ev: ArrivalItem["twitchEvent"] | undefined;
          const name = m.name.trim() || "(名前なし)";
          if (m.event && kindInfo && setting) {
            if (!setting.show) {
              if (!m.text.trim()) continue;
            } else {
              const e = { kind: kindInfo.kind, amount: String(m.event.amount ?? ""), months: Number(m.event.months) || 0, count: Number(m.event.count) || 0, level: String(m.event.level ?? ""), item: String(m.event.item ?? "") };
              const summary = renderYoutubeEvent(e, setting.template, name, "");
              ev = { kind: kindInfo.kind, label: kindInfo.label, summary, message: m.text, speech: renderYoutubeEvent(e, setting.template, name, youtubeSpeechText(m.text)), speak: setting.speak };
            }
          } else if (m.event) {
            continue; // 知らない種類のイベントは出さない
          }
          const emojis = sanitizeYoutubeEmojis(m.emojis, m.text);
          if (emojis.length > 0) {
            const cps = Array.from(m.text);
            emoteMap.set(no + 1, { emotes: emojis.map((e) => ({ id: e.id, name: cps.slice(e.start, e.end + 1).join(""), url: e.url })), giant: false });
          }
          added.push({
            responseNo: ++no,
            name: escapeHtml(name),
            mail: "",
            dateAndId: `${formatChatTime(Number(b.receivedAt) || Date.now())} ID:${channelId || "unknown"}`,
            body: ev ? `【${escapeHtml(ev.label)}】${escapeHtml(ev.summary)}${m.text ? ` <br> ${escapeHtml(m.text)}` : ""}` : escapeHtml(m.text),
          });
          const msgId = YT_MESSAGE_ID_RE.test(m.id) ? m.id : "";
          if (msgId) index.set(msgId, { no, channelId });
          extras.push({ ev, raw: emojis.length > 0 ? { text: m.text, emotes: emojis, giant: false } : undefined, key: msgId ? `yt:${video}:${msgId}` : "" });
        }
        for (const id of Array.isArray(b.deleted) ? b.deleted : []) {
          if (typeof id !== "string" || !YT_MESSAGE_ID_RE.test(id)) continue;
          const hit = index.get(id);
          if (hit) deletedNos.add(hit.no);
          removedKeys.push(`yt:${video}:${id}`);
        }
        for (const author of Array.isArray(b.deletedAuthors) ? b.deletedAuthors : []) {
          if (typeof author !== "string" || !YT_CHANNEL_ID_RE.test(author)) continue;
          for (const [id, v] of index) {
            if (v.channelId !== author) continue;
            deletedNos.add(v.no);
            removedKeys.push(`yt:${video}:${id}`);
          }
        }
      }
      if (added.length === 0 && deletedNos.size === 0) continue;
      let rows = [...prev, ...added].slice(-TWITCH_MAX_ROWS);
      if (deletedNos.size > 0) {
        rows = rows.map((r) => (deletedNos.has(r.responseNo) ? { ...r, body: "（削除されました）" } : r));
        for (const n of deletedNos) emoteMap.delete(n);
      }
      // 画面から消えたレスの絵文字・発言 ID は捨てる
      const oldest = rows[0]?.responseNo ?? 0;
      for (const k of emoteMap.keys()) if (k < oldest) emoteMap.delete(k);
      for (const [id, v] of index) if (v.no < oldest) index.delete(id);
      if (emoteMap.size > 0) twitchEmoteMapRef.current.set(url, emoteMap); else twitchEmoteMapRef.current.delete(url);
      youtubeMsgIndexRef.current.set(url, index);
      tabCacheRef.current.set(url, { ...(cached ?? { selectedResponse: rows[0]?.responseNo ?? 1 }), responses: rows });
      if (url === activeUrl) {
        if (autoScrollEnabledRef.current && added.length > 0) pendingAutoScrollRef.current = true;
        setFetchedResponses(rows);
        setLastFetchTime(formatChatTime(Date.now()));
      }
      added.forEach((r, i) => {
        if (deletedNos.has(r.responseNo)) return;
        if (getNgResult({ name: r.name, mail: r.mail, time: r.dateAndId, text: r.body }, url)?.mode === "hide") return;
        const a = makeArrival(r, tab.title, url, rows);
        const x = extras[i];
        if (x?.ev) a.twitchEvent = x.ev;
        if (x?.raw) a.twitchRaw = x.raw;
        if (x?.key) a.chatKey = x.key;
        arrivals.push(a);
      });
    }
    if (removedKeys.length > 0) removeChatKeys(removedKeys);
    if (arrivals.length === 0) return;
    // 新着ペイン・字幕・OBS連携 (掲示板の新着と同じ経路)。溜めておく上限は Twitch と同じ設定を使う
    const queueWasEmpty = arrivalQueueRef.current.length === 0;
    arrivalQueueRef.current.push(...arrivals);
    const queued = arrivalQueueRef.current.filter((a) => isYoutubeUrl(a.threadUrl)).length;
    if (queued > twitchMaxQueuedArrivals) {
      let drop = queued - twitchMaxQueuedArrivals;
      arrivalQueueRef.current = arrivalQueueRef.current.filter((a) => {
        if (drop > 0 && isYoutubeUrl(a.threadUrl)) { drop--; return false; }
        return true;
      });
    }
    setArrivalQueueCount(arrivalQueueRef.current.length);
    pushBroadcastArrivals(arrivals);
    if (!arrivalPausedRef.current && !arrivalTimerRef.current && (currentArrivalItemRef.current === null || queueWasEmpty)) {
      advanceToNextArrival();
    }
    // 読み上げ (「名前さん」+ 本文)。読み上げが溜まっているときは新しく積まない。
    // イベントは種類ごとの「読み上げる文」を読む (数が少なく大事なので、溜まっていても読む)
    if (ttsEnabled && ttsMode !== "off") {
      for (const a of arrivals) {
        if (a.twitchEvent) {
          if (a.twitchEvent.speak && !a.isAbone && !isTabTtsOff(a.threadUrl)) ttsSpeak(a.twitchEvent.speech, "", undefined, { name: a.name, id: a.id });
          continue;
        }
        if (ttsQueueRef.current.length >= twitchMaxTtsBacklog) continue;
        if (a.isAbone || isTabTtsOff(a.threadUrl)) { ttsSpeakArrival(a, speakPrefixFor("youtube", a.responseNo, a.name)); continue; }
        const text = youtubeSpeechText(a.twitchRaw ? a.twitchRaw.text : decodeHtmlEntities(a.text));
        if (!text) continue; // 絵文字だけで、読むものが無い
        ttsSpeakArrival({ ...a, text: escapeHtml(text) }, speakPrefixFor("youtube", a.responseNo, a.name));
      }
    }
  };
  // 設定 > YouTube > イベントの「テスト」: 開いている YouTube タブに、試しのイベントを1件流す (表示・読み上げ・OBS の確認用)
  const testYoutubeEvent = (kind: string) => {
    const video = threadTabs.map((t) => youtubeVideoFromUrl(t.threadUrl)).find((v): v is string => !!v);
    if (!video) { setYoutubeEventTestMsg("YouTube のタブを開いてから押してください (テストはそのタブに流れます)"); return; }
    const withMessage = ["superchat", "milestone"].includes(kind);
    youtubePendingRef.current.push({
      video, receivedAt: Date.now(), deleted: [], deletedAuthors: [],
      messages: [{
        id: `test.${Date.now()}`, channelId: "UCtesttesttesttesttest00", name: "テスト", member: true,
        text: withMessage ? "テストのメッセージです" : "",
        event: { kind, amount: "¥1,000", months: 12, count: 5, level: "メンバー", item: kind === "jewels" ? "ラーメン" : "テストのステッカー" },
      }],
    });
    flushYoutubeMessages();
    setYoutubeEventTestMsg(`YouTube のタブにテストの「${YOUTUBE_EVENT_KINDS.find((k) => k.kind === kind)?.label ?? kind}」を流しました`);
  };
  const youtubeFlushRef = useRef(flushYoutubeMessages);
  youtubeFlushRef.current = flushYoutubeMessages;

  // 投稿成功後の共通処理 (名前履歴・自分の投稿判定・再取得・スクロール)。
  // 下部の書き込みパネルと、スレッドタイトルバーから開く浮遊ウィンドウの両方から呼ばれる
  const applyPostSuccessBookkeeping = async (targetThreadUrl: string, name: string, postedBody: string) => {
    if (name.trim()) {
      setNameHistory((prev) => {
        const next = [name.trim(), ...prev.filter((n) => n !== name.trim())].slice(0, 20);
        saveToFile("name-history.json", next);
        return next;
      });
    }
    const prevCount = tabCacheRef.current.get(targetThreadUrl)?.responses.length ?? 0;
    pendingMyPostRef.current = { threadUrl: targetThreadUrl, body: postedBody, prevCount };
    await fetchResponsesFromCurrent(targetThreadUrl);
    void refreshThreadListSilently();
    setTimeout(() => {
      const items = tabCacheRef.current.get(targetThreadUrl)?.responses;
      if (items && items.length > 0) {
        setSelectedResponse(items[items.length - 1].responseNo);
      }
      if (responseScrollRef.current) {
        responseScrollRef.current.scrollTop = responseScrollRef.current.scrollHeight;
      }
    }, 100);
  };

  const postSuccessCleanup = async (postedBody: string) => {
    setComposeBody("");
    await applyPostSuccessBookkeeping(threadUrl.trim(), composeName, postedBody);
  };

  // ===== Twitch・YouTube のチャットへの書き込み =====
  // 書き込み先を間違えないための仕組み:
  //  ① 書き込み欄の中身はタブごとに分ける (タブを切り替えると入れ替わる。別のタブで書いた文がほかのタブの欄に出ない)
  //  ② 書き込み欄の中身がどのタブのものかを覚え、送るときに表示中のタブと違えば送らない
  //  ③ 送り先を大きく・色で示す (Twitch=紫・YouTube=赤)。送信ボタンにも送り先を書く
  //  ④ 送る前に毎回確認する (設定 > 書き込み でオフにできる)
  //  ⑤ Enter では送らない (Ctrl+Enter か送信ボタンだけ)
  //  ⑥ Rust 側でも、送り先が受信中の (開いている) タブかを確かめる
  //  ⑦ 送信は書き込み欄のボタン・Ctrl+Enter からだけ呼ぶ (読み上げ・新着などの処理からは呼ばない)
  const composeDraftsRef = useRef<Map<string, string>>(new Map());
  const composeDraftUrlRef = useRef<string>("");
  const composeTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [chatSendConfirm, setChatSendConfirm] = useState(true);
  const [composeReply, setComposeReply] = useState<{ url: string; id: string; name: string; text: string } | null>(null);
  // 書き込み欄の送信先: スレの表示では表示しているタブ。ビュワーでは、書き込み欄の「送信先」で選んだタブ
  // (スレのタブの列で選んでいるタブとは関係ない)。選んだタブが閉じられていたら送信先なし (送れない)
  const [viewerComposeTarget, setViewerComposeTarget] = useState("");
  const viewerTargetOpen = !!viewerComposeTarget && threadTabs.some((t) => t.threadUrl === viewerComposeTarget);
  const activeComposeUrl = activePaneView === "viewer"
    ? (viewerTargetOpen ? viewerComposeTarget : "")
    : (threadTabs[activeTabIndex]?.threadUrl ?? "");
  const activeComposeTitle = threadTabs.find((t) => t.threadUrl === activeComposeUrl)?.title ?? "";
  const composeTargetUrlRef = useRef("");
  composeTargetUrlRef.current = activeComposeUrl;
  // 選んでいた送信先のタブが閉じられたら「未選択」に戻す (タブが 0 個の起動直後は、復元を待つので触らない)
  useEffect(() => {
    if (viewerComposeTarget && threadTabs.length > 0 && !threadTabs.some((t) => t.threadUrl === viewerComposeTarget)) setViewerComposeTarget("");
  }, [threadTabs, viewerComposeTarget]);
  // 送信先の選択欄に出す名前
  const composeTargetLabelOf = (url: string, title: string) => {
    const ch = twitchChannelFromUrl(url);
    if (ch) return `Twitch #${ch}`;
    if (youtubeVideoFromUrl(url)) return `YouTube ${title.replace(/^YouTube\s*/, "")}`;
    const site = detectSiteType(url);
    const siteName = site === "shitaraba" ? "したらば" : site === "jpnkn" ? "JPNKN" : "5ch";
    return `[${siteName}] ${title || url}`;
  };
  useEffect(() => {
    // タブが変わったら、いまの中身を前のタブの下書きにしまい、新しいタブの下書きを出す
    const prevUrl = composeDraftUrlRef.current;
    if (prevUrl === activeComposeUrl) return;
    composeDraftsRef.current.set(prevUrl, composeBody);
    if (composeDraftsRef.current.size > 200) composeDraftsRef.current.delete(composeDraftsRef.current.keys().next().value ?? "");
    composeDraftUrlRef.current = activeComposeUrl;
    setComposeBody(composeDraftsRef.current.get(activeComposeUrl) ?? "");
    setComposeResult(null);
    setChatPicker(false);
    chatCompleteRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeComposeUrl]);
  // チャットの送り先 (表示中のタブが Twitch・YouTube のとき)
  type ChatTarget = { platform: "twitch"; channel: string; url: string } | { platform: "youtube"; video: string; url: string; title: string };
  const chatTarget: ChatTarget | null = (() => {
    const ch = twitchChannelFromUrl(activeComposeUrl);
    if (ch) return { platform: "twitch", channel: ch, url: activeComposeUrl };
    const v = youtubeVideoFromUrl(activeComposeUrl);
    if (v) return { platform: "youtube", video: v, url: activeComposeUrl, title: activeComposeTitle };
    return null;
  })();
  const chatTargetLabel = (t: ChatTarget) => (t.platform === "twitch" ? `Twitch #${t.channel}` : `YouTube ${t.title.replace(/^YouTube\s*/, "") || t.video}`);
  const CHAT_MAX_CHARS_TWITCH = 500;
  const CHAT_MAX_CHARS_YOUTUBE = 200;
  const chatMaxChars = (t: ChatTarget) => (t.platform === "twitch" ? CHAT_MAX_CHARS_TWITCH : CHAT_MAX_CHARS_YOUTUBE);
  // 使えるスタンプ (ログインしている人が使えるもの。チャンネルごとに10分覚える)
  type UserEmote = { id: string; name: string; owner: string; ownerLogin?: string; emoteType: string; animated: boolean };
  const [userEmotes, setUserEmotes] = useState<{ channel: string; list: UserEmote[]; at: number; error: string }>({ channel: "", list: [], at: 0, error: "" });
  const [chatPicker, setChatPicker] = useState(false);
  // 一覧の位置と大きさ (書き込み欄の上に重ねる。開いたとき・ウィンドウや書き込み欄の大きさが変わったときに計算し直す)
  const [chatPickerPos, setChatPickerPos] = useState<{ right: number; bottom: number; width: number; maxHeight: number; narrow: boolean } | null>(null);
  const [chatPickerHover, setChatPickerHover] = useState("");
  // 一覧の下の切り替え (最近使ったもの・このチャンネル・すべて・グローバル・絵文字)。開いたときは「すべて」
  type ChatPickerTab = "recent" | "channel" | "all" | "global" | "emoji";
  const [chatPickerTab, setChatPickerTab] = useState<ChatPickerTab>("all");
  const composeSectionRef = useRef<HTMLElement | null>(null);
  const chatStampBtnRef = useRef<HTMLButtonElement | null>(null);
  const chatPickerRef = useRef<HTMLDivElement | null>(null);
  const chatPickerScrollRef = useRef<HTMLDivElement | null>(null);
  const [chatPickerQuery, setChatPickerQuery] = useState("");
  const [recentChatEmotes, setRecentChatEmotes] = useState<string[]>([]);
  const chatCompleteRef = useRef<{ start: number; end: number; list: string[]; index: number } | null>(null);
  useEffect(() => {
    if (!isTauriRuntime() || !composeOpen || chatTarget?.platform !== "twitch" || !twitchAuth.canChat) return;
    const ch = chatTarget.channel;
    if (userEmotes.channel === ch && Date.now() - userEmotes.at < 10 * 60 * 1000) return;
    let cancelled = false;
    void invoke<UserEmote[]>("twitch_user_emotes", { channel: ch })
      .then((list) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const uniq = (Array.isArray(list) ? list : []).filter((e) => TWITCH_EMOTE_ID_RE.test(e.id) && !seen.has(e.id) && (seen.add(e.id), true));
        setUserEmotes({ channel: ch, list: uniq, at: Date.now(), error: "" });
      })
      .catch((e) => { if (!cancelled) setUserEmotes({ channel: ch, list: [], at: Date.now(), error: String(e) }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composeOpen, chatTarget?.platform === "twitch" ? chatTarget.channel : "", twitchAuth.canChat]);
  // 一覧の位置: 右端は LiveFake のウィンドウの右端にぴったり付け、書き込み欄の上端のすぐ上に開く。
  // 幅は約 300px (ウィンドウがそれより狭いときは幅いっぱい)。高さは書き込み欄の上の空きに収める (最大 360px。100px より小さくはしない)
  const updateChatPickerPos = () => {
    const sec = composeSectionRef.current;
    if (!sec) return;
    const sr = sec.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(300, vw);
    setChatPickerPos({ right: 0, bottom: Math.max(0, vh - sr.top + 2), width, maxHeight: Math.min(360, Math.max(100, sr.top - 4)), narrow: width < 240 });
  };
  useEffect(() => {
    if (!chatPicker) { setChatPickerPos(null); return; }
    updateChatPickerPos();
    const onResize = () => updateChatPickerPos();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      // 一覧・スタンプボタン・書き込み領域を押したときは閉じない (書き込み領域でカーソルを動かしながら続けて選べるように)
      if (!t || chatPickerRef.current?.contains(t) || chatStampBtnRef.current?.contains(t) || composeTextareaRef.current?.contains(t)) return;
      setChatPicker(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setChatPicker(false); composeTextareaRef.current?.focus(); } };
    window.addEventListener("resize", onResize);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatPicker, composePanelPx, composeOpen]);
  // 一覧の1マスの大きさ (設定 > Twitch の「スタンプの大きさ」に合わせる)。画像は画面の細かさに合わせて 1倍・2倍・3倍を選ぶ
  const chatCell = Math.max(24, Math.min(64, twitchEmoteSize + 4));
  const chatEmoteImg = (id: string) => {
    const need = chatCell * (window.devicePixelRatio || 1);
    const scale = need <= 30 ? "1.0" : need <= 60 ? "2.0" : "3.0";
    return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/${darkMode ? "dark" : "light"}/${scale}`;
  };
  // 書き込み欄の、カーソルの位置に文字を入れる (前後に空白を足して、スタンプの名前が前後の文字とつながらないようにする)
  const insertIntoCompose = (text: string) => {
    const ta = composeTextareaRef.current;
    const cur = composeBody;
    const start = ta ? ta.selectionStart : cur.length;
    const end = ta ? ta.selectionEnd : cur.length;
    const before = cur.slice(0, start);
    const after = cur.slice(end);
    const pre = before && !/\s$/.test(before) ? " " : "";
    const post = after && !/^\s/.test(after) ? " " : " ";
    const next = before + pre + text + post + after;
    setComposeBody(next);
    const pos = (before + pre + text + post).length;
    window.setTimeout(() => { const t = composeTextareaRef.current; if (t) { t.focus(); t.setSelectionRange(pos, pos); } }, 0);
  };
  const pickChatEmote = (name: string) => {
    insertIntoCompose(name);
    setRecentChatEmotes((prev) => [name, ...prev.filter((n) => n !== name)].slice(0, 24));
  };
  // Tab で補完: @ で始まる語はこのタブで最近書き込んだ人の名前、それ以外は使えるスタンプの名前。続けて Tab を押すと次の候補
  const completeInCompose = (ta: HTMLTextAreaElement) => {
    const st = chatCompleteRef.current;
    if (st && st.list.length > 0 && ta.selectionStart === st.end) {
      const index = (st.index + 1) % st.list.length;
      const word = st.list[index];
      const next = composeBody.slice(0, st.start) + word + composeBody.slice(st.end);
      chatCompleteRef.current = { ...st, end: st.start + word.length, index };
      setComposeBody(next);
      window.setTimeout(() => ta.setSelectionRange(st.start + word.length, st.start + word.length), 0);
      return;
    }
    const pos = ta.selectionStart;
    const before = composeBody.slice(0, pos);
    const m = before.match(/(\S+)$/);
    if (!m) return;
    const word = m[1];
    const start = pos - word.length;
    let list: string[] = [];
    if (word.startsWith("@")) {
      const q = word.slice(1).toLowerCase();
      const names = [...fetchedResponses].reverse().map((r) => decodeHtmlEntities(r.name.replace(/<[^>]*>/g, "")).trim()).filter(Boolean);
      list = [...new Set(names)].filter((n) => n.toLowerCase().startsWith(q)).slice(0, 30).map((n) => `@${n}`);
    } else {
      const q = word.toLowerCase();
      const recent = recentChatEmotes.filter((n) => n.toLowerCase().startsWith(q));
      const all = userEmotes.list.map((e) => e.name).filter((n) => n.toLowerCase().startsWith(q)).sort((a, b) => a.length - b.length || a.localeCompare(b));
      list = [...new Set([...recent, ...all])].slice(0, 50);
    }
    if (list.length === 0) return;
    const next = composeBody.slice(0, start) + list[0] + composeBody.slice(pos);
    chatCompleteRef.current = { start, end: start + list[0].length, list, index: 0 };
    setComposeBody(next);
    window.setTimeout(() => ta.setSelectionRange(start + list[0].length, start + list[0].length), 0);
  };
  // 送信前の見た目: 自分が使えるスタンプの名前を画像にする
  const chatComposePreviewHtml = (): string => {
    const text = composeBody.replace(/\s*\n\s*/g, " ");
    const html = escapeHtml(text);
    if (chatTarget?.platform !== "twitch" || userEmotes.list.length === 0) return html;
    const names = new Set(text.split(/\s+/));
    const used = userEmotes.list.filter((e) => names.has(e.name)).map((e) => ({ id: e.id, name: e.name }));
    return used.length > 0 ? injectTwitchEmotes(html, used, false, darkMode) : html;
  };
  const sendChatFromCompose = () => {
    if (composeSubmitting || !chatTarget) return;
    const target = chatTarget;
    // ② 書き込み欄の中身が、表示中のタブのものか
    if (composeDraftUrlRef.current !== target.url) {
      setComposeResult({ ok: false, message: "送り先のタブと書き込み欄が食い違ったため、送りませんでした。もう一度確かめてください" });
      return;
    }
    const text = composeBody.replace(/\s*\n\s*/g, " ").trim();
    if (!text) { setComposeResult({ ok: false, message: "本文が空です" }); return; }
    const max = chatMaxChars(target);
    if (Array.from(text).length > max) { setComposeResult({ ok: false, message: `長すぎます (${max} 文字まで)` }); return; }
    if (target.platform === "twitch" && (!twitchAuth.loggedIn || !twitchAuth.canChat)) {
      setComposeResult({ ok: false, message: "Twitch に書き込むには、設定 > Twitch > ログイン でログイン (またはログインし直し) してください" });
      return;
    }
    if (target.platform === "youtube" && !youtubeAuth.loggedIn) {
      setComposeResult({ ok: false, message: "YouTube に書き込むには、設定 > YouTube > 書き込み でログインしてください" });
      return;
    }
    const reply = target.platform === "twitch" && composeReply && composeReply.url === target.url ? composeReply : null;
    const loginName = target.platform === "twitch" ? twitchAuth.login : youtubeAuth.channelTitle;
    const doSend = async () => {
      // 確認の間に送信先が変わっていないか、もう一度確かめる
      if (composeTargetUrlRef.current !== target.url || composeDraftUrlRef.current !== target.url) {
        setComposeResult({ ok: false, message: "送信先が変わったため、送りませんでした" });
        return;
      }
      setComposeSubmitting(true);
      try {
        if (target.platform === "twitch") await invoke<string>("twitch_send_chat", { channel: target.channel, message: text, replyTo: reply?.id ?? null });
        else await invoke<string>("youtube_send_chat", { video: target.video, message: text });
        setComposeBody("");
        composeDraftsRef.current.delete(target.url);
        setComposeReply(null);
        setChatPicker(false);
        setComposeResult({ ok: true, message: `送信しました: ${chatTargetLabel(target)}` });
        const usedNames = new Set(text.split(/\s+/));
        const used = userEmotes.list.filter((e) => usedNames.has(e.name)).map((e) => e.name);
        if (used.length > 0) setRecentChatEmotes((prev) => [...new Set([...used, ...prev])].slice(0, 24));
      } catch (e) {
        setComposeResult({ ok: false, message: String(e) });
      } finally {
        setComposeSubmitting(false);
      }
    };
    if (!chatSendConfirm) { void doSend(); return; }
    setAppConfirm({
      title: "チャットへの送信の確認",
      message: `送信先: ${chatTargetLabel(target)}\nログイン: ${loginName}${target.platform === "youtube" ? `\n(YouTube の API を ${YOUTUBE_INSERT_COST} 使います)` : ""}${reply ? `\n返信先: ${reply.name}「${Array.from(reply.text).slice(0, 40).join("")}」` : ""}\n\n${text}`,
      buttons: [
        { label: `${chatTargetLabel(target)} に送信`, primary: true, onClick: () => { void doSend(); } },
        { label: "キャンセル", onClick: () => {} },
      ],
    });
  };

  const probePostFlowTraceFromCompose = async () => {
    if (composeSubmitting) return;
    if (!activeComposeUrl) {
      setComposeResult({ ok: false, message: activePaneView === "viewer" && threadTabs.length > 0 ? "書き込み欄の「送信先」を選んでください" : "スレのタブを開くと書き込めます" });
      return;
    }
    if (isChatUrl(activeComposeUrl)) {
      const where = isTwitchUrl(activeComposeUrl) ? "Twitch" : "YouTube";
      setAppConfirm({
        title: `${where} には書き込めません`,
        message: `このブラウザからは ${where} のチャットに書き込めません (受信のみ)。`,
        buttons: [{ label: "OK", primary: true, onClick: () => {} }],
      });
      return;
    }
    setComposeSubmitting(true);
    setComposeResult(null);
    // 書き込み欄の送信先 (スレの表示では表示しているタブ、ビュワーでは選んだタブ)。アドレス欄の URL には送らない
    const postTargetUrl = activeComposeUrl;
    try {
      const result = await invoke<string>("post_reply_multisite", {
        threadUrl: postTargetUrl,
        from: composeName || null,
        mail: composeMailValue || null,
        message: composeBody || "",
      });
      setComposeResult({ ok: true, message: `Post submitted: ${result}` });
      recordPostHistory(postTargetUrl, threadTabs.find((t) => t.threadUrl === postTargetUrl)?.title ?? "", "reply", composeBody, true);
      await postSuccessCleanup(composeBody);
    } catch (error) {
      const msg = String(error);
      setComposeResult({ ok: false, message: `NG: ${msg}` });
      recordPostHistory(postTargetUrl, threadTabs.find((t) => t.threadUrl === postTargetUrl)?.title ?? "", "reply", composeBody, false);
    } finally {
      setComposeSubmitting(false);
    }
  };

  // スレッドタイトルバーの「書き込み」から浮遊ウィンドウ (別 OS ウィンドウ) を開く。
  // 下部の書き込みパネルとは独立で、名前・スレ情報などの初期値だけを渡す
  const openComposePopup = () => {
    if (isChatUrl(threadTabs[activeTabIndex]?.threadUrl ?? threadUrl)) {
      // チャットへは、送り先を取り違えないよう下の書き込み欄からだけ送る
      setComposeOpen(true);
      setStatus("チャットへは下の書き込み欄から送ります");
      return;
    }
    if (!isTauriRuntime()) { setComposeOpen(true); setComposeBody(""); setComposeResult(null); return; }
    const tab = threadTabs[activeTabIndex];
    // 開いた時点のスレに固定する (別ウィンドウなので、開いたままメイン側でタブを切り替えられても
    // 投稿先が変わらないようにする)
    composePopupTargetRef.current = { url: tab?.threadUrl ?? threadUrl, title: tab?.title ?? threadUrl };
    void invoke("compose_popup_show").then(() => {
      composePopupOpenRef.current = true;
      setTimeout(() => {
        void invoke("compose_popup_update", {
          data: {
            threadTitle: tab?.title ?? threadUrl,
            defaultName: composeName || (nameHistory[0] ?? ""),
            defaultMail: composeSage ? "" : composeMail,
            darkMode,
          },
        }).catch(() => {});
      }, 250);
    }).catch((e) => console.warn("compose_popup_show:", e));
  };

  // 浮遊ウィンドウからの送信要求を処理する。実際の投稿は既存の投稿フローをそのまま使い、
  // NGフィルタ・Cookie・自分の投稿判定などは下部パネルの書き込みと完全に同じ経路を通る
  const handleComposePopupSubmit = async (data: { mode?: unknown; name?: unknown; mail?: unknown; body?: unknown; subject?: unknown }) => {
    const mode = data.mode === "new_thread" ? "new_thread" : "reply";
    const name = typeof data.name === "string" ? data.name : "";
    const mail = typeof data.mail === "string" ? data.mail : "";
    const body = typeof data.body === "string" ? data.body : "";
    const subject = typeof data.subject === "string" ? data.subject : "";
    // 開いたときに固定したスレ (composePopupTargetRef) を使う。無ければ現在のタブにフォールバック
    const postTargetUrl = composePopupTargetRef.current?.url ?? (threadTabs[activeTabIndex]?.threadUrl ?? threadUrl);
    const reportResult = (ok: boolean, message: string) => {
      if (isTauriRuntime()) void invoke("compose_popup_result", { ok, message }).catch(() => {});
    };
    if (mode === "new_thread") {
      const boardUrl = getBoardUrlFromThreadUrl(postTargetUrl.trim()) || postTargetUrl.trim();
      try {
        const r = await invoke<{ status: number; containsError: boolean; bodyPreview: string; threadUrl: string | null }>("create_thread_command", {
          boardUrl,
          subject,
          from: name || null,
          mail: mail || null,
          message: body,
        });
        if (r.containsError || !r.threadUrl) {
          recordPostHistory(boardUrl, subject, "thread", body, false);
          reportResult(false, `スレッド作成失敗: ${r.bodyPreview}`);
          return;
        }
        recordPostHistory(r.threadUrl, subject, "thread", body, true);
        if (name.trim()) {
          setNameHistory((prev) => {
            const next = [name.trim(), ...prev.filter((n) => n !== name.trim())].slice(0, 20);
            saveToFile("name-history.json", next);
            return next;
          });
        }
        openThreadInTab(r.threadUrl, subject);
        void fetchResponsesFromCurrent(r.threadUrl);
        void refreshThreadListSilently();
        if (isTauriRuntime()) void invoke("compose_popup_hide").catch(() => {});
      } catch (error) {
        reportResult(false, `Error: ${String(error)}`);
      }
      return;
    }
    try {
      const result = await invoke<string>("post_reply_multisite", { threadUrl: postTargetUrl, from: name || null, mail: mail || null, message: body });
      recordPostHistory(postTargetUrl, threadTabs.find((t) => t.threadUrl === postTargetUrl)?.title ?? "", "reply", body, true);
      void result;
      await applyPostSuccessBookkeeping(postTargetUrl.trim(), name, body);
      if (isTauriRuntime()) void invoke("compose_popup_hide").catch(() => {});
    } catch (error) {
      const msg = String(error);
      recordPostHistory(postTargetUrl, threadTabs.find((t) => t.threadUrl === postTargetUrl)?.title ?? "", "reply", body, false);
      reportResult(false, `NG: ${msg}`);
    }
  };

  // 浮遊ウィンドウが開いていればそちらへ引用を転送し、無ければ従来どおり下部パネルへ追記する
  const forwardQuoteToComposePopup = (line: string): boolean => {
    if (!composePopupOpenRef.current || !isTauriRuntime()) return false;
    void invoke("compose_popup_update", { data: { appendQuote: line } }).catch(() => {});
    return true;
  };

  // TTS: process queue sequentially (one item at a time)
  const processTtsQueue = async () => {
    if (ttsProcessingRef.current) return;
    ttsProcessingRef.current = true;
    while (ttsQueueRef.current.length > 0) {
      const mode = ttsModeRef.current;
      if (!isTauriRuntime() || mode === "off") {
        ttsQueueRef.current = [];
        break;
      }
      const truncated = ttsQueueRef.current.shift()!;
      try {
        if (mode === "sapi") {
          await invoke("sapi_speak_text", { text: truncated, voiceIndex: sapiVoiceIndexRef.current, rate: sapiRateRef.current, volume: sapiVolumeRef.current });
        } else if (mode === "bouyomi") {
          await invoke("bouyomi_speak_text", { remoteTalkPath: bouyomiPathRef.current, text: truncated, speed: bouyomiSpeedRef.current, tone: bouyomiToneRef.current, volume: bouyomiVolumeRef.current, voice: bouyomiVoiceRef.current });
        } else if (mode === "voicevox") {
          await invoke("voicevox_speak_text", { endpoint: voicevoxEndpointRef.current, text: truncated, speakerId: voicevoxSpeakerIdRef.current, speedScale: voicevoxSpeedScaleRef.current, pitchScale: voicevoxPitchScaleRef.current, intonationScale: voicevoxIntonationScaleRef.current, volumeScale: voicevoxVolumeScaleRef.current });
        }
      } catch (e) {
        console.warn("TTS speak error:", e);
      }
    }
    ttsProcessingRef.current = false;
  };

  // 読み上げない辞書の照合 (NG フィルタと同じ規則: /.../ は正規表現、それ以外は大小無視の部分一致)
  const ttsMuteMatches = (entries: TtsMuteEntry[], target: string): TtsMuteEntry | undefined =>
    entries.find((e) => e.value.trim() !== "" && ngMatch(e.value.trim(), target));
  // 一致した語句だけを本文から無音で除去する
  const ttsRemoveMuteWord = (text: string, pattern: string): string => {
    const p = pattern.trim();
    if (p.startsWith("/") && p.endsWith("/") && p.length > 2) {
      if (p.length > MAX_USER_REGEX_LEN) return text;
      try { return text.replace(new RegExp(p.slice(1, -1), "gi"), ""); } catch { return text; }
    }
    return text.replace(new RegExp(escapeRegExp(p), "gi"), "");
  };
  // URL 1 個 (トークン) の読み方を決める。
  //  1. 通常の読み上げ辞書: キーワードに "://" を含む項目は URL 文字列との部分一致 (先頭・途中・末尾いずれも可)、
  //     含まない項目はホスト名との部分一致 (例: "youtube" → www.youtube.com) で照合し、一致したら URL 全体を読みに置き換える
  //  2. ホストが生の IP アドレスなら読み上げ許可リストで照合し、登録があればその読み、無ければ読まない (無音)
  //  3. どれにも当たらなければ URL は読まない
  const ttsUrlReading = (token: string): string => {
    const normalized = token.replace(/^ttp/i, "http");
    let host = "";
    let hostPort = "";
    try {
      const u = new URL(normalized);
      host = u.hostname.toLowerCase();
      hostPort = u.port ? `${host}:${u.port}` : host;
    } catch { /* URL として解釈できない場合はホスト照合をスキップ */ }
    const stripKey = (s: string) => s.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/+$/, "");
    const tokenKey = stripKey(normalized);
    for (const e of ttsDictRef.current) {
      if (e.fullReplace || !e.from) continue;
      const from = e.from.trim().toLowerCase();
      if (!from) continue;
      if (from.includes("://")) {
        const key = stripKey(from);
        if (key && tokenKey.includes(key)) return e.to;
      } else if (host && (from.length >= 4 || from.includes(".")) && host.includes(from)) {
        // 短すぎる語 (com / www 等) が全 URL のホスト名に一致してしまうのを避ける
        return e.to;
      }
    }
    const isIpHost = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
    if (isIpHost) {
      const entry = ttsIpAllowRef.current.find((a) => {
        const key = a.host.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
        if (!key) return false;
        return key === hostPort || key === host;
      });
      return entry ? entry.to : "";
    }
    return "";
  };

  // TTS: enqueue text for sequential playback
  // maxReadLength applies to plain text body only (HTML tags + entities decoded); prefix is always read in full
  // URL (http/https/ttp) は URL 単位で辞書・許可リストと照合して読みに置き換え、該当しなければ読まない
  const ttsSpeak = (bodyText: string, prefix?: string, responseNo?: number, meta?: { name?: string; id?: string }, opts?: { keepTeachCommands?: boolean }) => {
    if (!isTauriRuntime() || ttsMode === "off") return;
    // Skip system messages (res 1001/1002)
    if (responseNo != null && responseNo >= 1001) return;
    // 読み上げない辞書 (名前 / ID): 一致したらそのレスは読み上げない (表示・あぼーんには影響しない)
    const mute = ttsMuteRef.current;
    if (meta?.name && ttsMuteMatches(mute.names, meta.name)) return;
    if (meta?.id && ttsMuteMatches(mute.ids, meta.id)) return;
    // Strip HTML tags, then decode HTML entities to get true character count
    let plain = bodyText.replace(/<[^>]*>/g, "");
    plain = decodeHtmlEntities(plain).replace(/\u00A0/g, " ");
    // 教育・忘却のコマンドは読まない (棒読みちゃんにも渡さない)。Twitch のチャットで許可されたものだけ、棒読みちゃんへそのまま渡す
    if (!opts?.keepTeachCommands) plain = plain.replace(TEACH_CMD_RE, " ");
    // 読み上げない辞書 (本文ワード): レス全体スキップ指定なら読まない、そうでなければ語句だけ除去
    for (const e of mute.words) {
      const v = e.value.trim();
      if (!v || !ngMatch(v, plain)) continue;
      if (e.skipWhole) return;
      plain = ttsRemoveMuteWord(plain, v);
    }
    // Apply TTS dictionary: fullReplace (全文置換) entries first (if matched, skip all remaining preprocessing)
    const dict = ttsDictRef.current;
    const fullReplaceEntry = dict.find((e) => e.fullReplace && e.from && plain.includes(e.from));
    if (fullReplaceEntry) {
      ttsQueueRef.current.push(prefix ? `${prefix} ${fullReplaceEntry.to}` : fullReplaceEntry.to);
      void processTtsQueue();
      return;
    }
    // URL はトークン単位で読みに置換し、URL 以外の部分にだけ通常の辞書置換をかける
    // (辞書の語がホスト名を壊して URL 判定をすり抜けるのを防ぐ)
    const applyDict = (text: string) => {
      let out = text;
      for (const entry of dict) {
        if (!entry.fullReplace && entry.from) out = out.split(entry.from).join(entry.to);
      }
      // Twitch 教育辞書 (あなたの読み上げ辞書の後にかける。棒読みちゃんでは棒読みちゃん自身が覚えているのでかけない)
      if (twitchTeachEnabledRef.current && ttsMode !== "bouyomi") {
        for (const e of twitchTeachDictRef.current) if (e.word && e.reading) out = out.split(e.word).join(e.reading);
      }
      return out;
    };
    // 辞書・許可リストに一致しない URL は、設定が ON ならその位置で「URL省略」と読む
    // (URL 自体は読まない)。続けて並んだ URL は1回にまとめる。目印に使う制御文字が本文に
    // 元から含まれていても誤動作しないよう、先に取り除いておく
    const URL_OMIT_MARK = "\u0001";
    const urlOmit = ttsUrlOmitEnabledRef.current;
    plain = plain
      .replace(/\u0001/g, "")
      .split(/((?:https?|ttps?):\/\/[^\s]+)/gi)
      .map((part, i) => {
        if (i % 2 === 0) return applyDict(part);
        const reading = ttsUrlReading(part);
        if (reading) return reading;
        return urlOmit ? URL_OMIT_MARK : "";
      })
      .join("");
    if (urlOmit) plain = plain.replace(/\u0001(?:\s*\u0001)*/g, " URL省略 ");
    plain = plain.replace(/[ \t]{2,}/g, " ").trim();
    if (!plain) return;
    const maxLen = ttsMaxReadLengthRef.current;
    const truncatedBody = maxLen > 0 && plain.length > maxLen
      ? plain.slice(0, maxLen) + "、長文のため以下省略"
      : plain;
    const full = prefix ? `${prefix} ${truncatedBody}` : truncatedBody;
    ttsQueueRef.current.push(full);
    void processTtsQueue();
  };

  // 新着レス (通常あぼ～ん考慮) の読み上げ。あぼ～ん該当時は設定次第で
  // 「あぼーん」とだけ読むか、前置き含め完全にスキップする
  // 前置き (「レスN番さん」など) だけを読む。読み上げない辞書 (名前・ID) はここでも効かせる
  const ttsSpeakNumberOnly = (prefix: string, meta: { name?: string; id?: string }) => {
    if (!isTauriRuntime() || ttsMode === "off" || !prefix) return;
    const mute = ttsMuteRef.current;
    if (meta.name && ttsMuteMatches(mute.names, meta.name)) return;
    if (meta.id && ttsMuteMatches(mute.ids, meta.id)) return;
    ttsQueueRef.current.push(prefix);
    void processTtsQueue();
  };
  // タブごとの読み上げのオンオフ (スレ・Twitch チャンネル単位)。「このレスから読み上げ」は自分で選んだ操作なので対象外
  const isTabTtsOff = (url: string) => threadTabsRef.current.some((t) => t.threadUrl === url && t.ttsOff);
  // ビュワーの「選んだスレを流す」の対象か (設定 > 接続 の「ビュワー」のチェック・タブの右クリックで切り替える)
  const isTabViewerOn = (url: string) => threadTabsRef.current.some((t) => t.threadUrl === url && t.viewerOn !== false);
  const toggleTabViewer = (url: string) => {
    setThreadTabs((prev) => prev.map((t) => (t.threadUrl === url ? { ...t, viewerOn: t.viewerOn === false } : t)));
  };
  const toggleTabTts = (url: string) => {
    setThreadTabs((prev) => prev.map((t) => (t.threadUrl === url ? { ...t, ttsOff: !t.ttsOff } : t)));
  };
  // 掲示板の新着の読み上げ。「ホワイトリスト以外はレス番のみ」では、配信ホワイトリストに無い ID のレスは番号だけ読む
  const ttsSpeakBoardArrival = (a: ArrivalItem, prefix: string) => {
    if (isTabTtsOff(a.threadUrl)) return;
    if (ttsBoardMode === "whitelist" && !broadcastWhitelistRef.current[a.id]) {
      ttsSpeakNumberOnly(prefix, { name: a.name, id: a.id });
      return;
    }
    ttsSpeakArrival(a, prefix);
  };
  // Twitch のチャットの教育・忘却。視聴者ごとに5秒に1回まで。戻り値: 読み上げに渡すときにコマンドを残すか・知らせる文
  const handleTwitchTeach = (login: string, text: string): { keep: boolean; text: string; announces: string[] } => {
    const cmds = parseTeachCommands(text);
    if (cmds.length === 0 || !twitchTeachEnabledRef.current) return { keep: false, text, announces: [] };
    const now = Date.now();
    const last = twitchTeachLastRef.current.get(login) ?? 0;
    if (now - last < TWITCH_TEACH_INTERVAL_MS) return { keep: false, text, announces: [] };
    twitchTeachLastRef.current.set(login, now);
    if (twitchTeachLastRef.current.size > 5000) twitchTeachLastRef.current.clear();
    // 棒読みちゃん: 棒読みちゃん自身が教育・忘却する (LiveFake は覚えない)
    if (ttsMode === "bouyomi") return { keep: true, text: normalizeTeachCommands(text), announces: [] };
    let dict = [...twitchTeachDictRef.current];
    const announces: string[] = [];
    for (const c of cmds) {
      if (c.type === "teach") {
        if (!teachWordOk(c.word, 30) || !teachWordOk(c.reading, 50)) continue;
        // あなたの読み上げ辞書にある語は上書きさせない
        if (ttsDictRef.current.some((e) => e.from === c.word)) continue;
        dict = dict.filter((e) => e.word !== c.word);
        dict.push({ word: c.word, reading: c.reading, by: login, at: now });
        if (dict.length > TWITCH_TEACH_MAX) dict = dict.slice(-TWITCH_TEACH_MAX);
        announces.push(`${c.word}を覚えました`);
      } else {
        if (!dict.some((e) => e.word === c.word)) continue;
        dict = dict.filter((e) => e.word !== c.word);
        announces.push(`${c.word}を忘れました`);
      }
    }
    if (announces.length > 0) updateTwitchTeachDict(dict);
    return { keep: false, text, announces: twitchTeachAnnounce ? announces : [] };
  };
  const ttsSpeakArrival = (a: ArrivalItem, prefix: string, opts?: { keepTeachCommands?: boolean }) => {
    if (isTabTtsOff(a.threadUrl)) return;
    if (a.isAbone) {
      if (!ngAboneSpeakEnabled) return;
      ttsSpeak("あぼーん", prefix, undefined, { name: a.name, id: a.id });
      return;
    }
    ttsSpeak(a.text, prefix, undefined, { name: a.name, id: a.id }, opts);
  };

  // TTS: stop playback and clear queue; returns a promise so callers can await full stop
  const ttsStop = (): Promise<void> => {
    ttsQueueRef.current = [];
    ttsProcessingRef.current = false;
    if (isTauriRuntime()) return invoke("tts_stop").catch(() => {}) as Promise<void>;
    return Promise.resolve();
  };

  // Subtitle: send update to subtitle window
  // 新着レスペイン・字幕: Twitch のチャットは受信したスタンプ、掲示板は書かれたスタンプ名を画像にする
  const arrivalTwitchEmoteNames = (a: ArrivalItem) => {
    if (!a.twitchRaw || a.twitchRaw.emotes.length === 0) return null;
    const cps = Array.from(a.twitchRaw.text);
    return a.twitchRaw.emotes.map((e) => ({ id: e.id, name: cps.slice(e.start, e.end + 1).join(""), giant: e.giant === true, url: e.url }));
  };
  const arrivalHasEmotes = (a: ArrivalItem) =>
    !!arrivalTwitchEmoteNames(a) || (!isChatUrl(a.threadUrl) && boardEmotesEnabledRef.current && findNamedEmotes(decodeHtmlEntities(a.text), emoteNameMapRef.current).length > 0);
  const arrivalEmoteHtml = (a: ArrivalItem, html: string) => {
    const names = arrivalTwitchEmoteNames(a);
    if (names) return injectTwitchEmotes(html, names, !!a.twitchRaw?.giant, darkModeRef.current);
    if (!isChatUrl(a.threadUrl) && boardEmotesEnabledRef.current && emoteNameMapRef.current.size > 0) return injectEmoteTokens(html, boardEmoteLookup, false, darkModeRef.current);
    return html;
  };
  // 字幕へ渡す Twitch のバッジとスタンプの大きさ (字幕側でも画像アドレスを確かめる)
  const subtitleTwitchExtras = (item?: ArrivalItem) => ({
    badges: item?.twitchBadges ?? [],
    emoteSize: subtitleEmoteSizesRef.current.normal,
    giantEmoteSize: subtitleEmoteSizesRef.current.giant,
  });
  const subtitleUpdate = (data: { threadTitle?: string; name?: string; mail?: string; id?: string; date?: string; body?: string; responseNo?: number; idSeq?: number; idCount?: number }, item?: ArrivalItem) => {
    // タイマー経由で呼ばれるため、設定・ハイライトは ref で最新値を読む (古いレンダーの値を使わない)
    if (!isTauriRuntime() || !subtitleVisibleRef.current) return;
    // 通し番号: 字幕からの表示終了報告を現在のレスと突き合わせるために使う
    const seq = ++subtitleSeqRef.current;
    subtitleEndAtRef.current = null;
    const scroll = subtitleTimingRef.current;
    const show = subtitleHeaderVisRef.current;
    const idColor = data.id ? (idHighlightsRef.current[data.id] ?? undefined) : undefined;
    const wordHighlights = textHighlightsRef.current.filter((h) => h.type === "word");
    const ogpOn = ogpCardsEnabledRef.current;
    const tweetOn = tweetCardsEnabledRef.current;
    const filters = ogpDomainFiltersRef.current;
    // 字幕にもカードを出す: 字幕ウィンドウは別 WebView で IPC を持たないため、
    // メイン側でカードを解決してから HTML に埋め込んで送る (最長 2.5 秒待ち、取れなければカード無しで送る)
    if (subtitleCardsEnabledRef.current && (ogpOn || tweetOn) && data.body) {
      const raw = renderResponseBodyHighlighted(data.body, "", { hideImages: true, ogpCards: ogpOn, tweetCards: tweetOn, ogpAllow: filters.allow, ogpBlock: filters.block }, wordHighlights).__html;
      const slotRe = /<div class="ogp-card-slot(?: tweet-card-slot)?" data-ogp-url="([^"]+)"(?: data-tweet-id="(\d+)")?><\/div>/g;
      const slots: { full: string; url: string; tweetId?: string }[] = [];
      let sm: RegExpExecArray | null;
      while ((sm = slotRe.exec(raw)) !== null) slots.push({ full: sm[0], url: sm[1], tweetId: sm[2] });
      const withTimeout = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
        Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), 2500))]);
      void Promise.all(slots.map((s) => withTimeout(resolveCardHtml(s.url, s.tweetId, ogpOn), "")))
        .then((htmls) => {
          let bodyHtml = raw;
          // 置換文字列に $ が含まれても特殊解釈されないよう関数形式で置換する
          slots.forEach((s, i) => { bodyHtml = bodyHtml.replace(s.full, () => htmls[i] ?? ""); });
          if (item) bodyHtml = arrivalEmoteHtml(item, bodyHtml);
          return invoke("subtitle_update", { data: { ...data, seq, scroll, show, bodyHtml, idColor, ...subtitleTwitchExtras(item) } });
        })
        .catch((e) => console.warn("subtitle_update:", e));
      return;
    }
    let bodyHtml = data.body
      ? renderResponseBodyHighlighted(data.body, "", { hideImages: true }, wordHighlights).__html
      : undefined;
    if (bodyHtml && item) bodyHtml = arrivalEmoteHtml(item, bodyHtml);
    invoke("subtitle_update", { data: { ...data, seq, scroll, show, bodyHtml, idColor, ...subtitleTwitchExtras(item) } }).catch((e) => console.warn("subtitle_update:", e));
  };

  const advanceToNextArrival = () => {
    arrivalRunIdRef.current++;
    arrivalFinalDeadlineRef.current = null;
    arrivalFinalFireRef.current = null;
    if (arrivalTimerRef.current) {
      clearTimeout(arrivalTimerRef.current);
      arrivalTimerRef.current = null;
    }
    // 次がなければ現アイテムを表示したまま維持
    if (arrivalQueueRef.current.length === 0) return;
    // Brief blank phase between items
    currentArrivalItemRef.current = null;
    setCurrentArrivalItem(null);
    arrivalTimerRef.current = setTimeout(() => {
      arrivalTimerRef.current = null;
      const next = arrivalQueueRef.current.shift() ?? null;
      setArrivalQueueCount(arrivalQueueRef.current.length);
      currentArrivalItemRef.current = next;
      setCurrentArrivalItem(next);
      if (next === null) return;
      subtitleUpdate({ threadTitle: next.threadTitle, responseNo: next.responseNo, name: next.name, mail: next.mail, id: next.id, date: next.time, body: next.text, idSeq: next.idSeq, idCount: next.idCount }, next);
      _startArrivalTimer();
    }, 200);
  };

  advanceToNextArrivalRef.current = advanceToNextArrival;

  // 同期 ON のときの「次へ進む」時刻: 新着ペインと字幕の両方が最下行まで表示し終えた時刻 (遅い方) に、
  // 両方の「スクロール後の表示時間」の長い方を足す。収まるレスは最下行到達 = 表示開始、表示時間 = 「短いレスの表示時間」。
  // 字幕ウィンドウが閉じている・報告が無い・同期 OFF のときは新着ペインの値だけで決める。
  const syncedEndAt = (plan: { bottomAt: number; holdMs: number }): number => {
    let bottomAt = plan.bottomAt;
    let holdMs = plan.holdMs;
    const sub = subtitleEndAtRef.current;
    if (subtitleSyncEnabledRef.current && sub && sub.seq === subtitleSeqRef.current) {
      bottomAt = Math.max(bottomAt, sub.bottomAt);
      holdMs = Math.max(holdMs, sub.holdMs);
    }
    return bottomAt + holdMs;
  };
  // 新着ペインが最下行まで表示し終えた (今) ので「次へ進む」を予約する。holdMs はその後の表示時間。
  // onBeforeAdvance が true を返したら別処理 (遅延読み込みで溢れた場合のスクロール) に切り替えたとみなし進まない。
  const scheduleArrivalAdvance = (holdMs: number, onBeforeAdvance?: () => boolean) => {
    const now = performance.now();
    const plan = { bottomAt: now, holdMs };
    arrivalPlanRef.current = plan;
    const endAt = syncedEndAt(plan);
    const fire = () => {
      arrivalTimerRef.current = null;
      arrivalFinalDeadlineRef.current = null;
      arrivalFinalFireRef.current = null;
      if (onBeforeAdvance && onBeforeAdvance()) return;
      advanceToNextArrivalRef.current();
    };
    arrivalFinalDeadlineRef.current = endAt;
    arrivalFinalFireRef.current = fire;
    arrivalTimerRef.current = setTimeout(fire, Math.max(0, endAt - now));
  };

  const _startArrivalTimer = () => {
    const runId = ++arrivalRunIdRef.current;
    arrivalFinalDeadlineRef.current = null;
    arrivalFinalFireRef.current = null;
    arrivalPlanRef.current = null;
    const t = arrivalTimingRef.current;
    // After display settles, check for overflow and schedule advance
    arrivalTimerRef.current = setTimeout(() => {
      arrivalTimerRef.current = null;
      const bodyEl = newArrivalBodyRef.current;
      if (bodyEl) bodyEl.scrollTop = 0;
      const isOverflow = bodyEl ? bodyEl.scrollHeight > bodyEl.clientHeight + 2 : false;
      const startScroll = () => {
        // 待ち時間の後、設定速度で最下行までゆっくりスクロールし、到達後の表示時間が過ぎたら次へ
        arrivalTimerRef.current = setTimeout(() => {
          arrivalTimerRef.current = null;
          const el = newArrivalBodyRef.current;
          if (!el) { scheduleArrivalAdvance(t.holdSec * 1000); return; }
          const dist = Math.max(0, el.scrollHeight - el.clientHeight);
          const duration = Math.max(1000, dist * t.msPerPx);
          const start = performance.now();
          const startScrollTop = el.scrollTop;
          const step = (now: number) => {
            if (arrivalRunIdRef.current !== runId) return; // 別のアイテムに切り替わった
            const progress = Math.min((now - start) / duration, 1);
            el.scrollTop = startScrollTop + dist * progress;
            if (progress < 1) requestAnimationFrame(step);
            else scheduleArrivalAdvance(t.holdSec * 1000);
          };
          requestAnimationFrame(step);
        }, t.waitSec * 1000);
      };
      if (isOverflow) {
        startScroll();
      } else {
        // 収まる場合: 表示時間の後に次へ。カード等の遅延読み込みで溢れていたらスクロールに切り替える
        scheduleArrivalAdvance(t.fitSec * 1000, () => {
          const el = newArrivalBodyRef.current;
          if (el && el.scrollHeight > el.clientHeight + 2) { startScroll(); return true; }
          return false;
        });
      }
    }, 100);
  };

  const getBoardUrlFromThreadUrl = (url: string): string => {
    try {
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 3 && parts[0] === "test" && parts[1] === "read.cgi") {
        return `${u.origin}/${parts[2]}/`;
      }
      return `${u.origin}/${parts[0] || ""}/`;
    } catch {
      return url;
    }
  };

  const submitNewThread = async () => {
    if (!newThreadSubject.trim() || !newThreadBody.trim()) {
      setNewThreadResult({ ok: false, message: "スレタイと本文は必須です" });
      return;
    }
    setNewThreadSubmitting(true);
    setNewThreadResult(null);
    const boardUrl = getBoardUrlFromThreadUrl(threadUrl);
    try {
      const r = await invoke<{ status: number; containsError: boolean; bodyPreview: string; threadUrl: string | null }>("create_thread_command", {
        boardUrl,
        subject: newThreadSubject,
        from: newThreadName || null,
        mail: newThreadMail || null,
        message: newThreadBody,
      });
      if (r.containsError) {
        recordPostHistory(boardUrl, newThreadSubject, "thread", newThreadBody, false);
        setNewThreadResult({ ok: false, message: `エラー: ${r.bodyPreview}` });
      } else {
        recordPostHistory(r.threadUrl ?? boardUrl, newThreadSubject, "thread", newThreadBody, true);
        setNewThreadResult({ ok: true, message: `スレ立て成功 (status=${r.status})` });
        recordInputHistory("newThreadSubject", newThreadSubject);
        recordInputHistory("newThreadMail", newThreadMail);
        if (newThreadName.trim()) {
          setNameHistory((prev) => {
            const next = [newThreadName.trim(), ...prev.filter((n) => n !== newThreadName.trim())].slice(0, 20);
            saveToFile("name-history.json", next);
            return next;
          });
        }
        const newUrl = r.threadUrl;
        setNewThreadSubject("");
        setNewThreadBody("");
        setTimeout(() => {
          setShowNewThreadDialog(false);
          setNewThreadResult(null);
          if (newUrl) {
            openThreadInTab(newUrl, newThreadSubject);
            void fetchThreadListFromCurrent(boardUrl);
          } else {
            void fetchThreadListFromCurrent(boardUrl);
          }
        }, 1500);
      }
    } catch (error) {
      setNewThreadResult({ ok: false, message: `Error: ${String(error)}` });
    } finally {
      setNewThreadSubmitting(false);
    }
  };

  const checkForUpdates = async () => {
    setUpdateProbe("running...");
    setUpdateResult(null);
    try {
      const r = await invoke<UpdateCheckResult>("check_for_updates", {
        metadataUrl: metadataUrl.trim() || null,
        currentVersion: currentVersion.trim() || null,
      });
      setUpdateResult(r);
      setUpdateProbe(
        `current=${r.currentVersion} latest=${r.latestVersion} hasUpdate=${r.hasUpdate} platform=${r.currentPlatformKey} asset=${r.currentPlatformAsset?.filename ?? "(none)"}`
      );
      setKnownLatestVersion(r.latestVersion);
      if (r.notice) {
        setStatus(`${r.notice.text} (新しいバージョン: v${r.latestVersion})`);
      } else if (r.hasUpdate) {
        setStatus(`新しいバージョンがあります: v${r.latestVersion}`);
      } else {
        setStatus(`最新版です (v${r.currentVersion})`);
      }
    } catch (error) {
      setUpdateProbe(`error: ${String(error)}`);
      setStatus(`更新確認に失敗しました: ${String(error)}`);
    }
  };

  const runStartupUpdateCheck = (map: Record<string, string>) => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const known = map["App.knownLatestVersion"] ?? "";
    if (known && compareVersions(known, currentVersion) > 0) {
      setStatus(`新しいバージョンがあります: v${known} (ヘルプ > バージョン情報)`);
    }
    if (map["App.autoUpdateCheck"] === "false" || map["App.lastUpdateCheck"] === today) return;
    setLastUpdateCheck(today);
    invoke<UpdateCheckResult>("check_for_updates", { metadataUrl: metadataUrl.trim() || null, currentVersion: currentVersion.trim() || null })
      .then((r) => {
        setUpdateResult(r);
        setKnownLatestVersion(r.latestVersion);
        if (r.notice) {
          setStatus(`${r.notice.text} (ヘルプ > バージョン情報)`);
          // 同じお知らせは1回だけダイアログで知らせる
          if (map["App.updateNoticeSeen"] !== r.notice.id) {
            setUpdateNoticeSeen(r.notice.id);
            const page = r.downloadPageUrl;
            setAppConfirm({
              title: "LiveFake からのお知らせ",
              message: `${r.notice.text}\n\n新しいバージョン: v${r.latestVersion} (今のバージョン: v${r.currentVersion})`,
              buttons: [
                ...(page ? [{ label: "ダウンロードページを開く", primary: true, onClick: () => { void invoke("open_external_url", { url: page }).catch((e) => console.warn("open_external_url failed", e)); } }] : []),
                { label: "閉じる", onClick: () => {} },
              ],
            });
          }
        } else if (r.hasUpdate) setStatus(`新しいバージョンがあります: v${r.latestVersion} (ヘルプ > バージョン情報)`);
      })
      .catch((e) => console.warn("startup update check failed", e));
  };
  const updateAvailable = !!updateResult?.hasUpdate || (!!knownLatestVersion && compareVersions(knownLatestVersion, currentVersion) > 0);

  const openDownloadPage = async () => {
    if (!updateResult?.downloadPageUrl) return;
    await invoke("open_external_url", { url: updateResult.downloadPageUrl });
  };

  const runtimeState = isTauriRuntime() ? "TAURI" : "WEB";
  const updateState = updateResult
    ? updateResult.hasUpdate
      ? `UPDATE ${updateResult.latestVersion}`
      : "UP-TO-DATE"
    : "UPDATE N/A";

  const onComposeBodyKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (chatTarget) {
      if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        completeInCompose(e.currentTarget);
        return;
      }
      chatCompleteRef.current = null;
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) sendChatFromCompose();
      }
      return;
    }
    if (e.key === "Enter" && ((composeSubmitKey === "shift" && e.shiftKey) || (composeSubmitKey === "ctrl" && (e.ctrlKey || e.metaKey)))) {
      e.preventDefault();
      void probePostFlowTraceFromCompose();
    }
  };

  const composeMailValue = composeSage ? "sage" : composeMail;
  // 「プレビュー」タブ: 実際に投稿された後の見た目 (dat形式のプレーンテキスト) を表示する。
  // レス番号は NG で隠れている分も含めた本当の最終レス番号+1。ID は投稿するまで分からないため "???"
  const composePreviewLine = (): string => {
    const dow = ["日", "月", "火", "水", "木", "金", "土"][new Date().getDay()];
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}(${dow}) ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const nextNo = fetchedResponses.length + 1;
    const name = composeName.trim() || "名無しさん";
    const mailPart = composeMailValue ? `[${composeMailValue}]` : "";
    return `${nextNo} ：${name}${mailPart} ：${dateStr} ID:???\n${composeBody}`;
  };
  const boardItems: string[] = [];
  const fallbackThreadItems = [
    { id: 1, title: "プローブスレッド", res: 999, got: 24, speed: 2.5, lastLoad: "14:42", lastPost: "14:44", threadUrl: "https://mao.5ch.io/test/read.cgi/ngt/1/", threadKey: "1" },
    { id: 2, title: "認証テスト", res: 120, got: 8, speed: 0.8, lastLoad: "13:08", lastPost: "13:09", threadUrl: "https://mao.5ch.io/test/read.cgi/ngt/2/", threadKey: "2" },
  ];
  const favThreadUrls = useMemo(() => new Set(favorites.threads.map((t) => t.threadUrl)), [favorites.threads]);
  const extractThreadKey = (url: string): string => {
    const segs = url.replace(/\/$/, "").split("/").filter(Boolean);
    return segs[segs.length - 1] ?? "";
  };
  const threadItems = showCachedOnly
    ? cachedThreadList.map((ct, i) => ({
        id: i + 1,
        title: ct.title || "(タイトルなし)",
        res: ct.resCount,
        got: ct.resCount,
        speed: 0,
        lastLoad: "-",
        lastPost: "-",
        threadUrl: ct.threadUrl,
        threadKey: extractThreadKey(ct.threadUrl),
      }))
    : showFavoritesOnly
    ? favorites.threads.map((ft, i) => {
        const id = i + 1;
        const serverCount = favNewCounts.get(ft.threadUrl);
        const fetched = fetchedThreads.find((t) => t.threadUrl === ft.threadUrl);
        const cached = tabCacheRef.current.get(ft.threadUrl);
        const cachedCount = cached ? cached.responses.length : 0;
        const res = serverCount ?? (fetched ? fetched.responseCount : (cachedCount > 0 ? cachedCount : -1));
        const lastRead = threadLastReadCount[ft.threadUrl] ?? 0;
        const got = lastRead > 0 ? lastRead : (cachedCount > 0 ? cachedCount : 0);
        const datOchi = favNewCountsFetched && serverCount === undefined;
        return {
          id,
          title: ft.title || "(タイトルなし)",
          res,
          got,
          speed: 0,
          lastLoad: "-",
          lastPost: "-",
          threadUrl: ft.threadUrl,
          threadKey: extractThreadKey(ft.threadUrl),
          datOchi,
        };
      })
    : (
    fetchedThreads.length > 0 || isTauriRuntime()
      ? fetchedThreads.map((t, i) => {
          const created = Number(t.threadKey) * 1000;
          const elapsedDays = Math.max((Date.now() - created) / 86400000, 0.01);
          const speed = Number((t.responseCount / elapsedDays).toFixed(1));
          const readCount = threadLastReadCount[t.threadUrl] ?? 0;
          const sinceDate = created > 0 ? new Date(created) : null;
          const sinceStr = sinceDate ? `${sinceDate.getFullYear()}/${String(sinceDate.getMonth() + 1).padStart(2, "0")}/${String(sinceDate.getDate()).padStart(2, "0")}` : "-";
          return {
            id: i + 1,
            title: decodeHtmlEntities(t.title),
            res: t.responseCount,
            got: readCount > 0 ? readCount : 0,
            speed,
            since: sinceStr,
            lastLoad: lastFetchTime ?? "-",
            lastPost: "-",
            threadUrl: t.threadUrl,
            threadKey: t.threadKey,
          };
        })
      : fallbackThreadItems
  );
  // スレタイNGの一致状況 (透明あぼ～ん該当のスレは一覧からも除外、通常あぼ～んは一覧に残しつつタイトルを置き換える)
  const threadNgResultMap = new Map<string, NgHit>();
  if (ngFilters.thread_words.length > 0) {
    const curBoardForThreadNg = activeBoardUrlRef.current;
    for (const t of threadItems) {
      let hit: NgHit | null = null;
      for (const w of ngFilters.thread_words) {
        // スレ一覧の画面には「今見ているスレ」が無いため、thisスレ限定スコープは常に不一致扱いにする
        const scope = ngEntryScope(w);
        if (scope === "thread") continue;
        if (scope === "board" && ngEntryScopeUrl(w) !== curBoardForThreadNg) continue;
        if (!ngMatch(ngVal(w), t.title)) continue;
        const mode = ngEntryMode(w);
        const reason = `NGスレタイ: ${ngVal(w)}`;
        if (mode === "hide") { hit = { mode, reason }; break; }
        if (!hit) hit = { mode, reason };
      }
      if (hit) threadNgResultMap.set(t.threadUrl, hit);
    }
  }
  const filteredThreadItems = threadItems
    .filter((t) => {
      if (ngFilters.words.some((w) => ngMatch(ngVal(w), t.title))) return false;
      if (threadNgResultMap.get(t.threadUrl)?.mode === "hide") return false;
      if (threadSearchQuery.trim()) {
        return t.title.toLowerCase().includes(threadSearchQuery.trim().toLowerCase());
      }
      return true;
    });
  const currentFilteredUrls = filteredThreadItems.map((t) => t.threadUrl).join("\n");
  const sortSnapshot = prevSortSnapshotRef.current;
  const needsResort =
    sortSnapshot.key !== threadSortKey ||
    sortSnapshot.asc !== threadSortAsc ||
    sortSnapshot.urls !== currentFilteredUrls ||
    sortSnapshot.favFetched !== favNewCountsFetched;
  let visibleThreadItems: typeof filteredThreadItems;
  if (needsResort || cachedSortOrderRef.current.length === 0) {
    visibleThreadItems = [...filteredThreadItems].sort((a, b) => {
      let cmp = 0;
      if (threadSortKey === "fetched") cmp = (threadReadMap[a.threadUrl] ? 0 : 1) - (threadReadMap[b.threadUrl] ? 0 : 1);
      else if (threadSortKey === "id") cmp = a.id - b.id;
      else if (threadSortKey === "title") cmp = a.title.localeCompare(b.title);
      else if (threadSortKey === "res") cmp = a.res - b.res;
      else if (threadSortKey === "got") cmp = a.got - b.got;
      else if (threadSortKey === "new") cmp = (a.got > 0 && a.res > 0 ? a.res - a.got : -1) - (b.got > 0 && b.res > 0 ? b.res - b.got : -1);
      else if (threadSortKey === "lastFetch") {
        const la = threadFetchTimesRef.current[a.threadUrl] ?? "";
        const lb = threadFetchTimesRef.current[b.threadUrl] ?? "";
        cmp = la.localeCompare(lb);
      }
      else if (threadSortKey === "speed") cmp = a.speed - b.speed;
      else if (threadSortKey === "since") { const sa = ("since" in a ? a.since : "-") as string; const sb = ("since" in b ? b.since : "-") as string; cmp = sa.localeCompare(sb); }
      return threadSortAsc ? cmp : -cmp;
    });
    cachedSortOrderRef.current = visibleThreadItems.map((t) => t.threadUrl);
    prevSortSnapshotRef.current = { key: threadSortKey, asc: threadSortAsc, urls: currentFilteredUrls, favFetched: favNewCountsFetched };
  } else {
    const orderMap = new Map<string, number>();
    cachedSortOrderRef.current.forEach((url, i) => orderMap.set(url, i));
    visibleThreadItems = [...filteredThreadItems].sort((a, b) => {
      return (orderMap.get(a.threadUrl) ?? 999999) - (orderMap.get(b.threadUrl) ?? 999999);
    });
  }
  const selectedThreadItem = visibleThreadItems.find((t) => t.threadUrl === selectedThread) ?? null;
  const unreadThreadCount = visibleThreadItems.filter((t) => !threadReadMap[t.threadUrl]).length;
  const selectedThreadLabel = selectedThreadItem ? `#${selectedThreadItem.id}` : "-";
  // 以下のレス一覧まわりの集計は、描画のたびに作り直すと大きなスレで重くなるため useMemo で
  // 元データが変わったときだけ計算し直す。依存配列に漏れがあると NG やハイライトの変更が
  // 画面に反映されなくなるので、計算中に参照する state はすべて列挙すること
  const responseItems = useMemo(() => [
    ...(fetchedResponses.length > 0 || isTauriRuntime()
      ? fetchedResponses.map((r) => {
          const rawName = r.name || "Anonymous";
          // Real dat examples include BE:123456789-2BP(...) and javascript:be(123456789)
          const beNum = extractBeNumber(r.dateAndId || "", rawName, r.body || "");
          const plainName = rawName.replace(/<[^>]+>/g, "");
          const watchoi = extractWatchoi(plainName);
          return {
            id: r.responseNo,
            name: plainName,
            mail: r.mail || "",
            nameWithoutWatchoi: watchoi ? plainName.replace(/\s*[(（][^)）]+[)）]\s*$/, "") : plainName,
            time: r.dateAndId || "-",
            text: r.body || "",
            beNumber: beNum,
            watchoi,
          };
        })
      : [
          { id: 1, name: "名無しさん", mail: "", nameWithoutWatchoi: "名無しさん", time: "2026/03/07 10:00", text: ">>1 投稿フロートレース準備完了", beNumber: null, watchoi: null },
          { id: 2, name: "名無しさん", mail: "", nameWithoutWatchoi: "名無しさん", time: "2026/03/07 10:02", text: "ブラウザモードで表示中", beNumber: null, watchoi: null },
          { id: 3, name: "名無しさん", mail: "", nameWithoutWatchoi: "名無しさん", time: "2026/03/07 10:04", text: "次: subject/dat取得連携", beNumber: null, watchoi: null },
          { id: 4, name: "名無しさん", mail: "", nameWithoutWatchoi: "名無しさん", time: "2026/03/07 10:06", text: "参考 https://example.com/page を参照", beNumber: null, watchoi: null },
          { id: 5, name: "名無しさん", mail: "", nameWithoutWatchoi: "名無しさん", time: "2026/03/07 10:08", text: "テスト完了", beNumber: null, watchoi: null },
        ]),
  ], [fetchedResponses]);
  const extractId = (time: string) => {
    const m = time.match(/ID:(\S+)/);
    return m ? m[1] : "";
  };
  const formatResponseDate = (time: string) =>
    time
      .replace(/\s+ID:\S+/g, "")
      .replace(/\s+BE[:：]\d+[^\s]*/gi, "")
      .trim();

  // Build ID count map for highlighting frequent posters
  const { idCountMap, idSeqMap } = useMemo(() => {
    const countMap = new Map<string, number>();
    const seqMap = new Map<number, number>();
    const running = new Map<string, number>();
    for (const r of responseItems) {
      const id = extractId(r.time);
      if (id) {
        countMap.set(id, (countMap.get(id) ?? 0) + 1);
        const seq = (running.get(id) ?? 0) + 1;
        running.set(id, seq);
        seqMap.set(r.id, seq);
      }
    }
    return { idCountMap: countMap, idSeqMap: seqMap };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [responseItems, viewerItems, viewerThumbs, activePaneView]);

  const activeThreadUrl = activeTabIndex >= 0 && activeTabIndex < threadTabs.length ? threadTabs[activeTabIndex].threadUrl : threadUrl.trim();
  const myPostNos = useMemo(() => new Set(myPosts[activeThreadUrl] ?? []), [myPosts, activeThreadUrl]);
  // SIKI互換のサイト別セレクタ用クラス (例: sv__jbbs_shitaraba_net)。
  // ホスト名は英数以外を _ に正規化してから付与する
  const svClass = useMemo(() => {
    try {
      const host = new URL(activeThreadUrl).host.toLowerCase();
      const norm = host.replace(/[^a-z0-9]/g, "_").replace(/^_+|_+$/g, "");
      return norm ? `sv__${norm}` : "";
    } catch {
      return "";
    }
  }, [activeThreadUrl]);
  const replyToMeNos = useMemo(() => {
    if (myPostNos.size === 0) return new Set<number>();
    const set = new Set<number>();
    for (const r of responseItems) {
      const refs = r.text.matchAll(/>>(\d+)/g);
      for (const m of refs) {
        if (myPostNos.has(Number(m[1]))) { set.add(r.id); break; }
      }
    }
    return set;
  }, [responseItems, myPostNos]);

  const watchoiCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of responseItems) {
      if (r.watchoi) map.set(r.watchoi, (map.get(r.watchoi) ?? 0) + 1);
    }
    return map;
  }, [responseItems]);

  // getNgResult は ngFilters と threadUrl (この板のみ/このスレのみのスコープ判定) を参照する。
  // 新着受信時に全レスを判定し直さないよう、レスごとの結果を保存し、判定材料 (本文・名前・
  // メール・日時ID) が同じレスは再利用する。NG設定か開いているスレが変わったら全部捨てる
  const ngCacheRef = useRef<{ filters: NgFilters | null; thread: string; byId: Map<number, { text: string; name: string; mail: string; time: string; hit: NgHit | null }> }>({ filters: null, thread: "", byId: new Map() });
  const ngResultMap = useMemo(() => {
    const cache = ngCacheRef.current;
    const reusable = cache.filters === ngFilters && cache.thread === threadUrl;
    const nextById = new Map<number, { text: string; name: string; mail: string; time: string; hit: NgHit | null }>();
    const map = new Map<number, NgHit>();
    for (const r of responseItems) {
      const prev = reusable ? cache.byId.get(r.id) : undefined;
      const hit = prev && prev.text === r.text && prev.name === r.name && prev.mail === r.mail && prev.time === r.time
        ? prev.hit
        : getNgResult(r);
      nextById.set(r.id, { text: r.text, name: r.name, mail: r.mail, time: r.time, hit });
      if (hit) map.set(r.id, hit);
    }
    ngCacheRef.current = { filters: ngFilters, thread: threadUrl, byId: nextById };
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [responseItems, ngFilters, threadUrl]);
  const ngFilteredCount = ngResultMap.size;
  const visibleResponseItems = useMemo(() => responseItems.filter((r) => {
    const ngResult = ngResultMap.get(r.id);
    if (ngResult?.mode === "hide") return false;
    if (responseSearchMode === "extract" && responseSearchQuery) {
      const q = responseSearchQuery.toLowerCase();
      const plainText = r.text.replace(/<[^>]+>/g, "").toLowerCase();
      const nameText = r.name.toLowerCase();
      if (!(plainText.includes(q) || nameText.includes(q) || r.time.toLowerCase().includes(q))) return false;
    }
    if (responseLinkFilter) {
      const plain = r.text.replace(/<[^>]+>/g, "");
      const urlRe = /(?:https?:\/\/|ttps?:\/\/|ps:\/\/|s:\/\/|(?<![a-zA-Z]):\/\/)[^\s<>&"]+|(?<!\S)(?:[a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z]{2,}\/[^\s<>&"]+/gi;
      const imageRe = /\.(?:jpg|jpeg|png|gif|webp)(?:\?|$)/i;
      const videoRe = /\.(?:mp4|webm|mov)(?:\?|$)|youtu\.?be|nicovideo|nico\.ms/i;
      const urls = plain.match(urlRe) || [];
      if (responseLinkFilter === "image") {
        if (!urls.some((u) => imageRe.test(u))) return false;
      } else if (responseLinkFilter === "video") {
        if (!urls.some((u) => videoRe.test(u))) return false;
      } else if (responseLinkFilter === "link") {
        if (!urls.some((u) => !imageRe.test(u) && !videoRe.test(u))) return false;
      }
    }
    return true;
  }), [responseItems, ngResultMap, responseSearchMode, responseSearchQuery, responseLinkFilter]);
  const activeResponse = visibleResponseItems.find((r) => r.id === selectedResponse) ?? visibleResponseItems[0];
  const selectedResponseLabel = activeResponse ? `#${activeResponse.id}` : "-";

  // In-thread search: list of response ids matching the query (for ↑↓ navigation)
  const searchMatchIds = useMemo(() => {
    if (responseSearchMode !== "in-thread" || !responseSearchQuery.trim()) return [] as number[];
    const q = responseSearchQuery.toLowerCase();
    return visibleResponseItems
      .filter((r) => {
        const plain = r.text.replace(/<[^>]+>/g, "").toLowerCase();
        return plain.includes(q) || r.name.toLowerCase().includes(q);
      })
      .map((r) => r.id);
  }, [responseSearchMode, responseSearchQuery, visibleResponseItems]);

  const jumpToMatch = (index: number) => {
    if (searchMatchIds.length === 0) return;
    const safeIdx = ((index % searchMatchIds.length) + searchMatchIds.length) % searchMatchIds.length;
    setSearchMatchIndex(safeIdx);
    setSelectedResponse(searchMatchIds[safeIdx]);
    scrollToResponseNo(searchMatchIds[safeIdx]);
  };

  useEffect(() => {
    if (responseSearchMode === "in-thread" && searchMatchIds.length > 0) {
      setSearchMatchIndex(0);
      setSelectedResponse(searchMatchIds[0]);
      scrollToResponseNo(searchMatchIds[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [responseSearchMode, responseSearchQuery]);

  // Build back-reference map: responseNo → list of responseNos that reference it
  const backRefMap = useMemo(() => {
    const map = new Map<number, number[]>();
    const addRef = (target: number, from: number) => {
      if (!map.has(target)) map.set(target, []);
      const arr = map.get(target)!;
      if (!arr.includes(from)) arr.push(from);
    };
    for (const r of responseItems) {
      // single >>N or >N
      for (const m of r.text.matchAll(/>>(\d+)/g)) {
        addRef(Number(m[1]), r.id);
      }
      // range >>N-M or >N-M
      for (const m of r.text.matchAll(/>>(\d+)-(\d+)/g)) {
        const s = Number(m[1]), e = Number(m[2]);
        for (let i = s; i <= e && i - s < 1000; i++) addRef(i, r.id);
      }
    }
    return map;
  }, [responseItems]);

  // 各レスの本文HTML (安全化・リンク化・ハイライト済み)。通常あぼ～んのレスは本文の代わりに
  // プレースホルダを出すので作らない。matchesImageWords は ngFilters と threadUrl を参照する。
  // 新着受信時に全レスを変換し直さないよう、レスごとの結果を保存し、本文と画像非表示の有無が
  // 同じレスは再利用する。表示に関わる設定 (下の bodySig) が1つでも変わったら全部捨てる
  const bodyCacheRef = useRef<{ sig: unknown[]; byId: Map<number, { text: string; hideImages: boolean; html: { __html: string } }> }>({ sig: [], byId: new Map() });
  const responseBodyHtmlMap = useMemo(() => {
    const bodySig: unknown[] = [responseSearchQuery, showImagePreview, ngFilters, threadUrl, imageSizeLimit, imageUrlRules, ogpCardsEnabled, tweetCardsEnabled, ogpDomainFilters, textHighlights];
    const cache = bodyCacheRef.current;
    const reusable = cache.sig.length === bodySig.length && cache.sig.every((v, i) => Object.is(v, bodySig[i]));
    const wordHighlights = textHighlights.filter((h) => h.type === "word");
    const nextById = new Map<number, { text: string; hideImages: boolean; html: { __html: string } }>();
    const map = new Map<number, { __html: string }>();
    for (const r of visibleResponseItems) {
      const ngHit = ngResultMap.get(r.id);
      if (ngHit?.mode === "abone") continue;
      const hideImages = !showImagePreview || ngHit?.mode === "hide-images" || matchesImageWords(r.text);
      const prev = reusable ? cache.byId.get(r.id) : undefined;
      const html = prev && prev.text === r.text && prev.hideImages === hideImages
        ? prev.html
        : renderResponseBodyHighlighted(r.text, responseSearchQuery, {
          hideImages,
          imageSizeLimitKb: imageSizeLimit,
          urlRules: imageUrlRules,
          ogpCards: ogpCardsEnabled,
          tweetCards: tweetCardsEnabled,
          ogpAllow: ogpDomainFilters.allow,
          ogpBlock: ogpDomainFilters.block,
        }, wordHighlights);
      nextById.set(r.id, { text: r.text, hideImages, html });
      // Twitch・YouTube のタブ: スタンプ・絵文字の名前を画像に置き換える
      const emoteEntry = isChatUrl(threadUrl) ? twitchEmoteMapRef.current.get(threadUrl)?.get(r.id) : undefined;
      map.set(r.id, emoteEntry ? { __html: injectTwitchEmotes(html.__html, emoteEntry.emotes, emoteEntry.giant, darkMode) }
        : boardEmotesEnabled && !isChatUrl(threadUrl) && emoteNameMapRef.current.size > 0 ? { __html: injectEmoteTokens(html.__html, boardEmoteLookup, false, darkMode) }
        : html);
    }
    bodyCacheRef.current = { sig: bodySig, byId: nextById };
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleResponseItems, ngResultMap, responseSearchQuery, showImagePreview, ngFilters, threadUrl, imageSizeLimit, imageUrlRules, ogpCardsEnabled, tweetCardsEnabled, ogpDomainFilters, textHighlights, darkMode, boardEmotesEnabled, emoteNameVersion]);

  const goFromLocationInput = () => goToLocation(locationInput);
  // URL バーの文字列 (手入力・貼り付け) で移動する。Enter と「貼り付けて移動」は同じ経路
  const goToLocation = (raw: string) => {
    // Twitch のチャンネル (twitch.tv/名前) は Twitch タブとして開く
    const twitchChannel = twitchChannelFromInput(raw);
    if (twitchChannel) {
      const url = twitchTabUrl(twitchChannel);
      setLocationInput(url);
      openThreadInTab(url, `Twitch #${twitchChannel}`);
      return;
    }
    // YouTube のライブ配信 (watch?v= / live/ / youtu.be/) は YouTube タブとして開く
    const ytVideo = youtubeVideoFromInput(raw);
    if (ytVideo) {
      const url = youtubeTabUrl(ytVideo);
      setLocationInput(url);
      openThreadInTab(url, `YouTube ${ytVideo}`);
      return;
    }
    if (isYoutubeNonVideoInput(raw)) {
      setAppConfirm({
        title: "YouTube のライブ配信の URL ではありません",
        message: "YouTube のトップページ・チャンネルのページなどは開けません。\nライブ配信の URL を入れてください:\n・youtube.com/watch?v=…\n・youtube.com/live/…\n・youtu.be/…",
        buttons: [{ label: "OK", primary: true, onClick: () => {} }],
      });
      return;
    }
    const next = rewrite5chNet(raw.trim());
    if (!next) return;
    if (next !== locationInput.trim()) setLocationInput(next);
    // Detect thread URL (5ch, shitaraba, jpnkn) and open in tab
    let pathname = "";
    try { pathname = new URL(next, "https://dummy").pathname; } catch { /* ignore */ }
    if (/\/(test|bbs)\/read\.cgi\/[^/]+\/[^/]+/.test(pathname)) {
      const parts = next.replace(/\/+$/, "").split("/");
      const board = parts[parts.length - 2] || "";
      const key = parts[parts.length - 1] || "";
      const title = board && key ? `${board}/${key}` : next;
      openThreadInTab(next, title);
      return;
    }
    applyLocationToThread();
    void fetchThreadListFromCurrent(next);
  };

  const refreshByLocationInput = () => {
    const raw = locationInput.trim();
    if (twitchChannelFromInput(raw) || youtubeVideoFromInput(raw) || isYoutubeNonVideoInput(raw)) {
      goToLocation(raw);
      return;
    }
    const next = rewrite5chNet(raw);
    if (!next) return;
    if (next !== raw) setLocationInput(next);

    let pathname = "";
    try {
      pathname = new URL(next, "https://dummy").pathname;
    } catch {
      return;
    }
    const isThreadUrl = /\/test\/read\.cgi\/[^/]+\/[^/]+/.test(pathname);
    if (isThreadUrl) {
      setThreadUrl(next);
      const parts = next.replace(/\/+$/, "").split("/");
      const board = parts[parts.length - 2] || "";
      const key = parts[parts.length - 1] || "";
      const title = board && key ? `${board}/${key}` : next;
      openThreadInTab(next, title);
      void fetchResponsesFromCurrent(next, { keepSelection: true });
      return;
    }
    setThreadUrl(next);
    void fetchThreadListFromCurrent(next);
  };

  // クリップボードは信頼できない入力として扱う: 先頭行だけ・2048 文字まで・URL らしい形式のみ。
  // 読み取りはメニューを選んだときだけ行い、内容はログや設定に残さない
  const readClipboardForAddress = async (): Promise<string | null> => {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      console.warn("clipboard read failed", e);
      setStatus("クリップボードを読み取れませんでした");
      return null;
    }
    const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 2048);
    if (!line) { setStatus("クリップボードにテキストがありません"); return null; }
    return line;
  };
  const looksLikeUrl = (v: string): boolean => /^(https?:\/\/[^\s]+|(?:[a-z0-9][-a-z0-9]*\.)+[a-z]{2,}(?:\/[^\s]*)?)$/i.test(v);
  const pasteAndGo = async () => {
    const line = await readClipboardForAddress();
    if (line === null) return;
    if (!looksLikeUrl(line)) { setStatus("クリップボードの内容が URL ではありません"); return; }
    setLocationInput(line);
    goToLocation(line);
  };
  const pasteToAddress = async () => {
    const line = await readClipboardForAddress();
    if (line === null) return;
    setLocationInput(line);
    addressInputRef.current?.focus();
  };
  const onLocationInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    goFromLocationInput();
  };

  const searchHistoryRef = useRef({ thread: threadSearchHistory, response: responseSearchHistory });
  searchHistoryRef.current = { thread: threadSearchHistory, response: responseSearchHistory };
  const persistSearchHistory = (thread: string[], response: string[]) => {
    saveToFile("search-history.json", { thread, response });
  };
  const addSearchHistory = (type: "thread" | "response", word: string) => {
    const trimmed = word.trim();
    if (!trimmed) return;
    if (type === "thread") {
      setThreadSearchHistory((prev) => {
        const next = [trimmed, ...prev.filter((w) => w !== trimmed)].slice(0, MAX_SEARCH_HISTORY);
        persistSearchHistory(next, searchHistoryRef.current.response);
        return next;
      });
    } else {
      setResponseSearchHistory((prev) => {
        const next = [trimmed, ...prev.filter((w) => w !== trimmed)].slice(0, MAX_SEARCH_HISTORY);
        persistSearchHistory(searchHistoryRef.current.thread, next);
        return next;
      });
    }
  };
  const removeSearchHistory = (type: "thread" | "response", word: string) => {
    if (type === "thread") {
      setThreadSearchHistory((prev) => {
        const next = prev.filter((w) => w !== word);
        persistSearchHistory(next, searchHistoryRef.current.response);
        return next;
      });
    } else {
      setResponseSearchHistory((prev) => {
        const next = prev.filter((w) => w !== word);
        persistSearchHistory(searchHistoryRef.current.thread, next);
        return next;
      });
    }
  };

  const onThreadContextMenu = (e: ReactMouseEvent, threadId: number) => {
    e.preventDefault();
    const p = { x: e.clientX, y: e.clientY };
    setThreadMenu({ x: p.x, y: p.y, threadId });
    setResponseMenu(null);
  };

  const onResponseNoClick = (e: ReactMouseEvent, responseId: number) => {
    e.stopPropagation();
    setSelectedResponse(responseId);
    const p = { x: e.clientX, y: e.clientY };
    setResponseMenu({ x: p.x, y: p.y, responseId, isOnResNo: true });
    setHlSubMenu(null);
    setThreadMenu(null);
  };

  const onResponseAreaContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    // Detect image URL from thumbnail or image link
    let imageUrl: string | undefined;
    let linkUrl: string | undefined;
    const thumbEl = target.closest<HTMLElement>("[data-lightbox-src]");
    if (thumbEl?.dataset.lightboxSrc) {
      imageUrl = thumbEl.dataset.lightboxSrc;
    } else {
      const imgLink = target.closest<HTMLAnchorElement>("a.body-link");
      if (imgLink) {
        const href = imgLink.getAttribute("href") ?? "";
        if (/\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(href)) imageUrl = href;
      }
    }
    const bodyLink = target.closest<HTMLAnchorElement>("a.body-link");
    if (bodyLink) {
      const href = bodyLink.getAttribute("href") ?? "";
      if (/^https?:\/\//i.test(href)) linkUrl = href;
    }
    // Gather context
    const selection = window.getSelection()?.toString().trim() ?? "";
    const resBlock = target.closest<HTMLElement>("[data-response-no]");
    const responseNo = resBlock ? Number(resBlock.getAttribute("data-response-no") ?? 0) : 0;
    const idCell = target.closest<HTMLElement>(".response-id-cell");
    const resId = idCell ? (idCell.textContent ?? "").replace(/^ID:/, "").split("(")[0].trim() : "";
    const nameEl = target.closest<HTMLElement>(".response-name");
    const resName = nameEl ? (nameEl.textContent ?? "").trim() : "";
    const isOnResNo = !!target.closest(".response-no");

    // Close existing menu
    setThreadMenu(null);
    setHlSubMenu(null);
    const p = { x: e.clientX, y: e.clientY };
    setResponseMenu({
      x: p.x, y: p.y,
      responseId: responseNo,
      selection: selection || undefined,
      resId: resId || undefined,
      resName: resName || undefined,
      isOnResNo: isOnResNo || undefined,
      imageUrl,
      linkUrl,
    });
  };

  const markThreadRead = (threadId: number, value: boolean) => {
    const target = threadItems.find((t) => t.id === threadId);
    if (target) setThreadReadMap((prev) => ({ ...prev, [target.threadUrl]: value }));
    setThreadMenu(null);
  };

  const copyThreadUrl = async (threadId: number) => {
    const target = threadItems.find((t) => t.id === threadId);
    if (!target || !("threadUrl" in target) || typeof target.threadUrl !== "string") {
      setStatus(`thread url not found: #${threadId}`);
      setThreadMenu(null);
      return;
    }
    try {
      await navigator.clipboard.writeText(target.threadUrl);
      setStatus(`thread url copied: #${threadId}`);
    } catch {
      setStatus(`thread url: ${target.threadUrl}`);
    } finally {
      setThreadMenu(null);
    }
  };

  const purgeThreadCache = (url: string) => {
    invoke("delete_thread_cache", { threadUrl: url }).catch(() => {});
    // close tab
    const tabIdx = threadTabs.findIndex((t) => t.threadUrl === url);
    if (tabIdx >= 0) closeTab(tabIdx);
    // clear memory cache
    tabCacheRef.current.delete(url);
    // clear fetch timestamp
    delete threadFetchTimesRef.current[url];
    saveToFile("thread-fetch-times.json", threadFetchTimesRef.current);
    // clear read status for this thread in the thread list
    setThreadReadMap((prev) => { const next = { ...prev }; delete next[url]; return next; });
    setThreadLastReadCount((prev) => { const next = { ...prev }; delete next[url]; return next; });
    // clear persisted read status
    const bUrl = getBoardUrlFromThreadUrl(url);
    try {
      const parts = new URL(url).pathname.split("/").filter(Boolean);
      const tKey = parts.length >= 4 ? parts[3] : "";
      if (tKey) {
        invoke<Record<string, Record<string, number>>>("load_read_status").then((current) => {
          if (current[bUrl] && current[bUrl][tKey] != null) {
            delete current[bUrl][tKey];
            invoke("save_read_status", { status: current }).catch((e) => console.warn("save_read_status error", e));
          }
        }).catch((e) => console.warn("load_read_status error", e));
      }
    } catch { /* invalid url — skip */ }
    setStatus("キャッシュから削除しました");
  };

  const clearThreadCacheOnly = (url: string) => {
    invoke("delete_thread_cache", { threadUrl: url }).catch(() => {});
    tabCacheRef.current.delete(url);
    delete threadFetchTimesRef.current[url];
    saveToFile("thread-fetch-times.json", threadFetchTimesRef.current);
  };

  const runOnActiveThread = (action: (url: string) => void) => {
    const url = threadTabs[activeTabIndex]?.threadUrl;
    if (!url) return;
    setThreadUrl(url);
    setLocationInput(url);
    action(url);
  };

  const fetchNewResponses = () => {
    runOnActiveThread((url) => {
      void fetchResponsesFromCurrent(url, { keepSelection: true });
    });
  };

  const reloadResponses = () => {
    runOnActiveThread((url) => {
      void fetchResponsesFromCurrent(url, { resetScroll: true });
    });
  };

  const reloadResponsesAfterCachePurge = () => {
    runOnActiveThread((url) => {
      clearThreadCacheOnly(url);
      void fetchResponsesFromCurrent(url, { resetScroll: true });
    });
  };

  const buildResponseUrl = (responseId: number) => `${threadUrl.endsWith("/") ? threadUrl : `${threadUrl}/`}${responseId}`;

  const appendComposeQuote = (line: string) => {
    if (forwardQuoteToComposePopup(line)) return;
    setComposeOpen(true);
    setComposeBody((prev) => (prev.trim().length === 0 ? `${line}\n` : `${prev}\n${line}\n`));
  };

  const runResponseAction = async (
    action: "quote" | "quote-with-name" | "copy-url" | "add-ng-id" | "copy-id" | "copy-body" | "add-ng-name" | "toggle-aa" | "settings"
  ) => {
    if (!responseMenu) return;
    const id = responseMenu.responseId;
    const resp = responseItems.find((r) => r.id === id);
    if (!resp) {
      setResponseMenu(null);
      return;
    }

    if (action === "quote") {
      appendComposeQuote(`>>${id}`);
      setStatus(`quoted response #${id}`);
      setResponseMenu(null);
      return;
    }
    if (action === "quote-with-name") {
      appendComposeQuote(`>>${id} ${resp.name}`);
      setStatus(`quoted response #${id} with name`);
      setResponseMenu(null);
      return;
    }
    if (action === "copy-url") {
      const url = buildResponseUrl(id);
      try {
        await navigator.clipboard.writeText(url);
        setStatus(`response url copied: #${id}`);
      } catch {
        setStatus(`response url: ${url}`);
      }
      setResponseMenu(null);
      return;
    }
    if (action === "copy-id") {
      const posterId = extractId(resp.time);
      if (!posterId) {
        setStatus(`no ID found in response #${id}`);
        setResponseMenu(null);
        return;
      }
      try {
        await navigator.clipboard.writeText(posterId);
        setStatus(`ID copied: ${posterId}`);
      } catch {
        setStatus(`ID: ${posterId}`);
      }
      setResponseMenu(null);
      return;
    }
    if (action === "copy-body") {
      const plainText = resp.text
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      try {
        await navigator.clipboard.writeText(plainText);
        setStatus(`response body copied: #${id}`);
      } catch {
        setStatus(`copy failed for #${id}`);
      }
      setResponseMenu(null);
      return;
    }
    if (action === "add-ng-id") {
      const posterId = extractId(resp.time);
      if (posterId) {
        addNgEntry("ids", posterId);
      } else {
        setStatus(`no ID found in response #${id}`);
      }
      setResponseMenu(null);
      return;
    }
    if (action === "add-ng-name") {
      if (resp.name.trim()) {
        addNgEntry("names", resp.name.trim());
      }
      setResponseMenu(null);
      return;
    }
    if (action === "toggle-aa") {
      setAaOverrides((prev) => {
        const next = new Map(prev);
        const current = next.get(id);
        const autoDetected = isAsciiArt(resp.text);
        if (current === undefined) {
          // First toggle: flip from auto-detected state
          next.set(id, !autoDetected);
        } else {
          // Already overridden: flip the override
          next.set(id, !current);
        }
        return next;
      });
      setResponseMenu(null);
      return;
    }
    setStatus(`response settings opened for #${id} (mock)`);
    setResponseMenu(null);
  };

  const copyWholeThread = async () => {
    if (responseItems.length === 0) {
      setStatus("コピーするレスがありません");
      setResponseMenu(null);
      setTabMenu(null);
      return;
    }
    const tab = activeTabIndex >= 0 && activeTabIndex < threadTabs.length ? threadTabs[activeTabIndex] : null;
    const header = tab ? `${tab.title}\n${tab.threadUrl}\n\n` : "";
    const body = responseItems.map((r) => {
      const plain = decodeHtmlEntities(
        r.text.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
      );
      return `${r.id} ${r.name} ${r.time}\n${plain}`;
    }).join("\n\n");
    try {
      await navigator.clipboard.writeText(header + body);
      setStatus(`スレ全体をコピーしました (${responseItems.length}レス)`);
    } catch (e) {
      console.warn("copyWholeThread: clipboard write failed", e);
      setStatus("コピーに失敗しました");
    }
    setResponseMenu(null);
    setTabMenu(null);
  };

  const resetLayout = () => {
    setBoardPanePx(DEFAULT_BOARD_PANE_PX);
    setThreadPanePx(DEFAULT_THREAD_PANE_PX);
    setResponseTopRatio(DEFAULT_RESPONSE_TOP_RATIO);
    setThreadColWidths({ ...DEFAULT_COL_WIDTHS });
    setBoardsFontSize(12);
    setThreadsFontSize(12);
    setResponsesFontSize(12);
    setPopupFontSize(12);
    setPopupMaxWidth(520);
    setPopupMaxHeight(360);
    setStatus("layout reset");
  };

  const beginHorizontalResize = (mode: "board-thread" | "thread-response", event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeDragRef.current = {
      mode,
      startX: event.clientX,
      startBoardPx: boardPanePx,
      startThreadPx: threadPanePx,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };
  const onBoardTreeScroll: UIEventHandler<HTMLDivElement> = (event) => {
    const top = event.currentTarget.scrollTop;
    saveToFile("board-tree-scroll.json", top);
  };
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onResponseScroll: UIEventHandler<HTMLDivElement> = () => {
    if (!responseScrollRef.current) return;
    if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
    scrollSaveTimerRef.current = setTimeout(() => {
      const url = threadUrl.trim();
      if (!url || isChatUrl(url)) return; // Twitch・YouTube のチャットは位置を残さない
      const container = responseScrollRef.current;
      if (!container) return;
      const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 5;
      if (atBottom && fetchedResponses.length > 0) {
        // At bottom: save last response no so restore scrolls to bottom
        const lastNo = fetchedResponses[fetchedResponses.length - 1].responseNo;
        threadScrollPositions.current[url] = lastNo;
        saveToFile("scroll-positions.json", threadScrollPositions.current);
        saveBookmark(url, lastNo);
      } else {
        saveScrollPos(url);
        const visibleNo = getVisibleResponseNo();
        if (visibleNo > 0) saveBookmark(url, visibleNo);
      }
    }, 300);
  };

  const beginResponseRowResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const layoutHeight = responseLayoutRef.current?.clientHeight ?? 360;
    resizeDragRef.current = {
      mode: "response-rows",
      startY: event.clientY,
      startThreadPx: threadPanePx,
      responseLayoutHeight: layoutHeight,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
  };

  const beginNewArrivalResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeDragRef.current = {
      mode: "new-arrival-resize",
      startY: event.clientY,
      startHeight: newArrivalPaneHeight,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
  };

  const colResizeCursor = (side: "left" | "right", event: React.MouseEvent<HTMLTableCellElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const inHandle = side === "right"
      ? event.clientX >= rect.right - COL_RESIZE_HANDLE_PX
      : event.clientX <= rect.left + COL_RESIZE_HANDLE_PX;
    event.currentTarget.style.cursor = inHandle ? "col-resize" : "";
  };

  const beginColResize = (colKey: string, side: "left" | "right", event: React.MouseEvent<HTMLTableCellElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (side === "right" && event.clientX < rect.right - COL_RESIZE_HANDLE_PX) return;
    if (side === "left" && event.clientX > rect.left + COL_RESIZE_HANDLE_PX) return;
    event.preventDefault();
    event.stopPropagation();
    resizeDragRef.current = {
      mode: "col-resize",
      colKey,
      startX: event.clientX,
      startWidth: threadColWidths[colKey] ?? DEFAULT_COL_WIDTHS[colKey] ?? 40,
      reverse: side === "left",
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

  const resetColWidth = (colKey: string, side: "left" | "right", event: React.MouseEvent<HTMLTableCellElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (side === "right" && event.clientX < rect.right - COL_RESIZE_HANDLE_PX) return;
    if (side === "left" && event.clientX > rect.left + COL_RESIZE_HANDLE_PX) return;
    event.preventDefault();
    event.stopPropagation();
    setThreadColWidths((prev) => ({ ...prev, [colKey]: DEFAULT_COL_WIDTHS[colKey] ?? 40 }));
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Suppress browser's native Ctrl+F find bar
      if (e.key === "f" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); return; }
      if (e.key === "Escape") {
        if (hoverPreviewSrcRef.current) {
          hoverPreviewSrcRef.current = null;
          if (hoverPreviewShowTimerRef.current) {
            clearTimeout(hoverPreviewShowTimerRef.current);
            hoverPreviewShowTimerRef.current = null;
          }
          if (hoverPreviewHideTimerRef.current) {
            clearTimeout(hoverPreviewHideTimerRef.current);
            hoverPreviewHideTimerRef.current = null;
          }
          if (hoverPreviewRef.current) hoverPreviewRef.current.style.display = "none";
          return;
        }
        if (responseMenu) { setResponseMenu(null); setHlSubMenu(null); return; }
        if (aboutOpen) { setAboutOpen(false); return; }
        if (responseReloadMenuOpen) { setResponseReloadMenuOpen(false); return; }
        if (searchModeMenuOpen) { setSearchModeMenuOpen(false); return; }
        if (openMenu) { setOpenMenu(null); return; }
      }
      if (isTypingTarget(e.target)) return;
      // Arrow keys / PageUp / PageDown / Home / End scroll the response area (no modifier)
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && responseScrollRef.current) {
        const el = responseScrollRef.current;
        const pageH = el.clientHeight;
        switch (e.key) {
          case "ArrowUp":
            e.preventDefault();
            el.scrollBy({ top: -60, behavior: smoothScrollRef.current ? "smooth" : "instant" });
            return;
          case "ArrowDown":
            e.preventDefault();
            el.scrollBy({ top: 60, behavior: smoothScrollRef.current ? "smooth" : "instant" });
            return;
          case "PageUp":
            e.preventDefault();
            el.scrollBy({ top: -pageH, behavior: smoothScrollRef.current ? "smooth" : "instant" });
            return;
          case "PageDown":
            e.preventDefault();
            el.scrollBy({ top: pageH, behavior: smoothScrollRef.current ? "smooth" : "instant" });
            return;
          case "Home":
            e.preventDefault();
            el.scrollTop = 0;
            return;
          case "End":
            e.preventDefault();
            el.scrollTop = el.scrollHeight;
            return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedThread, selectedResponse, visibleThreadItems, responseItems, activeTabIndex, threadTabs, responseReloadMenuOpen, responseMenu, aboutOpen, searchModeMenuOpen, openMenu]);

  // 保存済み設定 (layout_prefs.json の JSON 文字列) を state に反映する。起動時の読み込みのほか、
  // 設定画面の「保存しない」「リセット」「プリセット読み込み」からも使う
  const applyLayoutPrefs = (raw: string | null) => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as {
          boardPaneVisible?: boolean;
          boardPanePx?: number;
          threadPanePx?: number;
          responseTopRatio?: number;
          fontSize?: number;
          boardsFontSize?: number;
          threadsFontSize?: number;
          responsesFontSize?: number;
          responsesHeaderFontSize?: number;
          darkMode?: boolean;
          fontFamily?: string;
          fontBold?: boolean;
          threadColWidths?: Record<string, number>;
          showBoardButtons?: boolean;
          keepSortOnRefresh?: boolean;
          composeSubmitKey?: "shift" | "ctrl";
          imageSizeLimit?: number;
          hoverPreviewEnabled?: boolean;
          ogpCardsEnabled?: boolean;
          tweetCardsEnabled?: boolean;
          arrivalCardsEnabled?: boolean;
          subtitleCardsEnabled?: boolean;
          arrivalTiming?: unknown;
          subtitleTiming?: unknown;
          subtitleSyncEnabled?: boolean;
          mainHeaderVis?: unknown;
          arrivalHeaderVis?: unknown;
          subtitleHeaderVis?: unknown;
          responseDividerAlways?: boolean;
          settingsSearchHistory?: unknown;
          lastBoard?: { boardName: string; url: string };
          hoverPreviewDelay?: number;
          thumbSize?: number;
          restoreSession?: boolean;
          autoRefreshInterval?: number;
          autoScrollEnabled?: boolean;
          newArrivalPaneOpen?: boolean;
          newArrivalPaneHeight?: number;
          newArrivalFontSize?: number;
          showImagePreview?: boolean;
          resIdFontSize?: number;
          resIdFontFamily?: string;
          newArrivalIdFontSize?: number;
          newArrivalIdFontFamily?: string;
          subtitleIdFontSize?: number;
          subtitleIdFontFamily?: string;
          popupFontSize?: number;
          popupMaxWidth?: number;
          popupMaxHeight?: number;
          composePanelPx?: number;
          subtitleBodyFontSize?: number;
          subtitleMetaFontSize?: number;
          subtitleOpacity?: number;
          subtitleTextShadow?: boolean;
          subtitleFrameMode?: string;
          subtitleAlwaysOnTop?: boolean;
        };
        if (typeof parsed.boardPaneVisible === "boolean") setBoardPaneVisible(parsed.boardPaneVisible);
        if (typeof parsed.boardPanePx === "number") setBoardPanePx(parsed.boardPanePx);
        if (typeof parsed.threadPanePx === "number") {
          setThreadPanePx(parsed.threadPanePx);
        } else if (typeof parsed.responseTopRatio === "number") {
          const layoutHeight = responseLayoutRef.current?.clientHeight ?? Math.max(520, window.innerHeight - 180);
          const nextThread = (layoutHeight * parsed.responseTopRatio) / 100;
          setThreadPanePx(nextThread);
          setResponseTopRatio(parsed.responseTopRatio);
        }
        const fallbackFs = typeof parsed.fontSize === "number" ? parsed.fontSize : 12;
        setBoardsFontSize(typeof parsed.boardsFontSize === "number" ? parsed.boardsFontSize : fallbackFs);
        setThreadsFontSize(typeof parsed.threadsFontSize === "number" ? parsed.threadsFontSize : fallbackFs);
        setResponsesFontSize(typeof parsed.responsesFontSize === "number" ? parsed.responsesFontSize : fallbackFs);
        if (typeof parsed.responsesHeaderFontSize === "number") setResponsesHeaderFontSize(parsed.responsesHeaderFontSize);
        if (typeof parsed.darkMode === "boolean") setDarkMode(parsed.darkMode);
        if (typeof parsed.fontFamily === "string") {
          // Normalize legacy CSS values like "'Meiryo', sans-serif" → "Meiryo"
          const raw = parsed.fontFamily;
          let normalized: string;
          if (raw.includes(",") || raw.includes("'") || raw.includes('"')) {
            const first = raw.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
            const generics = ["sans-serif", "serif", "monospace", "cursive", "fantasy"];
            normalized = generics.includes(first) ? "" : first;
          } else {
            normalized = raw;
          }
          setFontFamily(normalized);
          setFontPickerInput(normalized);
        }
        if (typeof parsed.fontBold === "boolean") setFontBold(parsed.fontBold);
        if (parsed.threadColWidths && typeof parsed.threadColWidths === "object") {
          setThreadColWidths((prev) => ({ ...prev, ...parsed.threadColWidths }));
        }
        if (typeof parsed.showBoardButtons === "boolean") setShowBoardButtons(parsed.showBoardButtons);
        if (typeof parsed.keepSortOnRefresh === "boolean") setKeepSortOnRefresh(parsed.keepSortOnRefresh);
        if (parsed.composeSubmitKey === "shift" || parsed.composeSubmitKey === "ctrl") setComposeSubmitKey(parsed.composeSubmitKey);
        if (typeof parsed.imageSizeLimit === "number") setImageSizeLimit(parsed.imageSizeLimit);
        if (typeof parsed.showImagePreview === "boolean") setShowImagePreview(parsed.showImagePreview);
        if (typeof parsed.hoverPreviewEnabled === "boolean") setHoverPreviewEnabled(parsed.hoverPreviewEnabled);
        if (typeof parsed.ogpCardsEnabled === "boolean") setOgpCardsEnabled(parsed.ogpCardsEnabled);
        if (typeof parsed.tweetCardsEnabled === "boolean") setTweetCardsEnabled(parsed.tweetCardsEnabled);
        if (typeof parsed.arrivalCardsEnabled === "boolean") setArrivalCardsEnabled(parsed.arrivalCardsEnabled);
        if (typeof parsed.subtitleCardsEnabled === "boolean") setSubtitleCardsEnabled(parsed.subtitleCardsEnabled);
        if (parsed.arrivalTiming !== undefined) setArrivalTiming(sanitizeScrollTiming(parsed.arrivalTiming));
        if (parsed.subtitleTiming !== undefined) setSubtitleTiming(sanitizeScrollTiming(parsed.subtitleTiming));
        if (typeof parsed.subtitleSyncEnabled === "boolean") setSubtitleSyncEnabled(parsed.subtitleSyncEnabled);
        if (parsed.mainHeaderVis !== undefined) setMainHeaderVis(sanitizeHeaderVis(parsed.mainHeaderVis));
        if (parsed.arrivalHeaderVis !== undefined) setArrivalHeaderVis(sanitizeHeaderVis(parsed.arrivalHeaderVis));
        if (parsed.subtitleHeaderVis !== undefined) setSubtitleHeaderVis(sanitizeHeaderVis(parsed.subtitleHeaderVis));
        if (typeof parsed.responseDividerAlways === "boolean") setResponseDividerAlways(parsed.responseDividerAlways);
        if (Array.isArray(parsed.settingsSearchHistory)) setSettingsSearchHistory(parsed.settingsSearchHistory.filter((x): x is string => typeof x === "string").slice(0, 20));
        if (parsed.lastBoard && typeof parsed.lastBoard.boardName === "string" && typeof parsed.lastBoard.url === "string") {
          pendingLastBoardRef.current = parsed.lastBoard;
        }
        if (typeof parsed.hoverPreviewDelay === "number") setHoverPreviewDelay(parsed.hoverPreviewDelay);
        if (typeof parsed.thumbSize === "number") setThumbSize(parsed.thumbSize);
        if (typeof parsed.restoreSession === "boolean") { setRestoreSession(parsed.restoreSession); restoreSessionRef.current = parsed.restoreSession; }
        if (typeof parsed.autoRefreshInterval === "number") setAutoRefreshInterval(parsed.autoRefreshInterval);
        if (typeof parsed.autoScrollEnabled === "boolean") setAutoScrollEnabled(parsed.autoScrollEnabled);
        if (typeof parsed.newArrivalPaneOpen === "boolean") setNewArrivalPaneOpen(parsed.newArrivalPaneOpen);
        if (typeof parsed.newArrivalPaneHeight === "number") setNewArrivalPaneHeight(parsed.newArrivalPaneHeight);
        if (typeof parsed.newArrivalFontSize === "number") setNewArrivalFontSize(parsed.newArrivalFontSize);
        if (typeof parsed.resIdFontSize === "number") setResIdFontSize(parsed.resIdFontSize);
        if (typeof parsed.resIdFontFamily === "string") { setResIdFontFamily(parsed.resIdFontFamily); setResIdFontPickerInput(parsed.resIdFontFamily); }
        if (typeof parsed.newArrivalIdFontSize === "number") setNewArrivalIdFontSize(parsed.newArrivalIdFontSize);
        if (typeof parsed.newArrivalIdFontFamily === "string") { setNewArrivalIdFontFamily(parsed.newArrivalIdFontFamily); setNewArrivalIdFontPickerInput(parsed.newArrivalIdFontFamily); }
        if (typeof parsed.subtitleIdFontSize === "number") setSubtitleIdFontSize(parsed.subtitleIdFontSize);
        if (typeof parsed.subtitleIdFontFamily === "string") { setSubtitleIdFontFamily(parsed.subtitleIdFontFamily); setSubtitleIdFontPickerInput(parsed.subtitleIdFontFamily); }
        if (typeof parsed.popupFontSize === "number") setPopupFontSize(parsed.popupFontSize);
        if (typeof parsed.popupMaxWidth === "number") setPopupMaxWidth(clamp(parsed.popupMaxWidth, 300, 2400));
        if (typeof parsed.popupMaxHeight === "number") setPopupMaxHeight(clamp(parsed.popupMaxHeight, 200, 1800));
        if (typeof parsed.composePanelPx === "number") setComposePanelPx(clamp(parsed.composePanelPx, MIN_COMPOSE_PANEL_PX, MAX_COMPOSE_PANEL_PX));
        if (typeof parsed.subtitleBodyFontSize === "number") setSubtitleBodyFontSize(clamp(parsed.subtitleBodyFontSize, 10, 96));
        if (typeof parsed.subtitleMetaFontSize === "number") setSubtitleMetaFontSize(clamp(parsed.subtitleMetaFontSize, 8, 48));
        if (typeof parsed.subtitleOpacity === "number") setSubtitleOpacity(clamp(parsed.subtitleOpacity, 0, 1));
        if (typeof parsed.subtitleTextShadow === "boolean") setSubtitleTextShadow(parsed.subtitleTextShadow);
        if (parsed.subtitleFrameMode === "corners" || parsed.subtitleFrameMode === "none" || parsed.subtitleFrameMode === "normal") setSubtitleFrameMode(parsed.subtitleFrameMode);
        if (typeof parsed.subtitleAlwaysOnTop === "boolean") setSubtitleAlwaysOnTop(parsed.subtitleAlwaysOnTop);
      } catch { /* ignore */ }
  };
  useEffect(() => {
    // 初期値のスナップショット (ファイル読み込み前の state = useState の初期値)。「リセット」で戻す先に使う
    if (!defaultLayoutPrefsRef.current) {
      defaultLayoutPrefsRef.current = buildLayoutPrefsPayload();
      defaultAppSettingsRef.current = buildAppSettingsMap();
    }
    // Layout prefs from file (settings.json via IPC)
    if (isTauriRuntime()) {
      invoke<string>("load_layout_prefs").then((raw) => {
        if (raw) applyLayoutPrefs(raw);
        layoutPrefsLoadedRef.current = true;
      }).catch(() => { layoutPrefsLoadedRef.current = true; });
    } else {
      layoutPrefsLoadedRef.current = true;
    }
    // Restore last selected board
    if (restoreSessionRef.current && pendingLastBoardRef.current) {
      const lb = pendingLastBoardRef.current;
      setSelectedBoard(lb.boardName);
      setLocationInput(lb.url);
      setThreadUrl(lb.url);
      lastBoardUrlRef.current = lb.url;
      void fetchThreadListFromCurrent(lb.url);
      pendingLastBoardRef.current = null;
    }
    // Restore thread tabs
    const applyRestoredTabs = (tabsRaw: string | null): boolean => {
      if (!tabsRaw) return false;
      try {
        const parsed = JSON.parse(tabsRaw) as { tabs: ThreadTab[]; activeIndex: number };
        if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
          setThreadTabs(parsed.tabs);
          const idx = typeof parsed.activeIndex === "number" ? parsed.activeIndex : 0;
          const safeIdx = Math.min(idx, parsed.tabs.length - 1);
          setActiveTabIndex(safeIdx);
          const activeTab = parsed.tabs[safeIdx];
          if (activeTab) {
            setThreadUrl(activeTab.threadUrl);
            setLocationInput(activeTab.threadUrl);
            if (isTauriRuntime()) {
              invoke<string | null>("load_thread_cache", { threadUrl: activeTab.threadUrl })
                .then((json) => {
                  if (json) {
                    const responses = JSON.parse(json) as ThreadResponseItem[];
                    const bm = loadBookmark(activeTab.threadUrl);
                    const savedNo = loadScrollPos(activeTab.threadUrl);
                    // Restore to: bookmark > saved scroll pos > last response (bottom)
                    const lastNo = responses.length > 0 ? responses[responses.length - 1].responseNo : 1;
                    const restoreNo = bm ?? (savedNo > 1 ? savedNo : lastNo);
                    tabCacheRef.current.set(activeTab.threadUrl, {
                      responses,
                      selectedResponse: restoreNo,
                    });
                    setActivePaneView("responses");
                    setFetchedResponses(responses);
                    setSelectedResponse(restoreNo);
                    if (restoreNo >= lastNo) {
                      setTimeout(() => { if (responseScrollRef.current) responseScrollRef.current.scrollTop = responseScrollRef.current.scrollHeight; }, 200);
                    } else if (restoreNo > 1) {
                      scrollToResponseNo(restoreNo);
                    }
                  }
                })
                .catch((e) => console.warn("load_thread_cache:", e));
            }
          }
          return true;
        }
      } catch { /* ignore */ }
      return false;
    };
    const finishRestore = () => setTabRestoreReady(true);
    if (restoreSessionRef.current) {
      const applyBoardTabs = (raw: string | null) => {
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as { tabs: {boardUrl: string, title: string}[]; activeIndex: number };
          if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
            setBoardTabs(parsed.tabs);
            const idx = typeof parsed.activeIndex === "number" ? Math.min(parsed.activeIndex, parsed.tabs.length - 1) : 0;
            setActiveBoardTabIndex(idx);
          }
        } catch { /* ignore */ }
      };

      const restorePromises: Promise<void>[] = [];
      if (isTauriRuntime()) {
        restorePromises.push(
          invoke<string>("load_session_board_tabs")
            .then((raw) => { if (raw) applyBoardTabs(raw); })
            .catch(() => {})
        );
        restorePromises.push(
          invoke<string>("load_session_tabs")
            .then((raw) => { if (raw) applyRestoredTabs(raw); })
            .catch(() => {})
        );
      }
      if (restorePromises.length > 0) {
        Promise.all(restorePromises).then(finishRestore);
      } else {
        finishRestore();
      }
    } else {
      finishRestore();
    }
    // Silently refresh board list from server
    void fetchBoardCategories();
    void loadFavorites();
    void loadExternalBoards();
    void loadNgFilters();
    // Restore from file-based persistence (Portable mode)
    if (isTauriRuntime()) {
      loadFromFile<Record<string, number>>("bookmarks.json").then((d) => {
        if (d && typeof d === "object") Object.assign(bookmarkCacheRef.current, d);
      });
      loadFromFile<Record<string, number>>("scroll-positions.json").then((d) => {
        if (d && typeof d === "object") Object.assign(threadScrollPositions.current, d);
      });
      loadFromFile<string[]>("name-history.json").then((d) => {
        if (Array.isArray(d) && d.length > 0) setNameHistory(d);
      });
      loadFromFile<Record<string, unknown>>("input-history.json").then((d) => {
        if (!d || typeof d !== "object") return;
        const next: Partial<Record<InputHistoryKey, string[]>> = {};
        for (const key of ["boardSearch", "favSearch", "settingsListFilter", "newThreadSubject", "newThreadMail"] as InputHistoryKey[]) {
          const arr = d[key];
          if (Array.isArray(arr)) next[key] = arr.filter((x): x is string => typeof x === "string").slice(0, 20);
        }
        inputHistoryRef.current = next;
        setInputHistory(next);
      });
      loadFromFile<Record<string, number[]>>("my-posts.json").then((d) => {
        if (d && typeof d === "object" && Object.keys(d).length > 0) setMyPosts(d as Record<string, number[]>);
      });
      loadFromFile<{ thread?: string[]; response?: string[] }>("search-history.json").then((d) => {
        if (d && typeof d === "object") {
          if (Array.isArray(d.thread) && d.thread.length > 0) setThreadSearchHistory(d.thread);
          if (Array.isArray(d.response) && d.response.length > 0) setResponseSearchHistory(d.response);
        }
      });
      loadFromFile<Record<string, number>>("thread-fetch-times.json").then((d) => {
        if (d && typeof d === "object") Object.assign(threadFetchTimesRef.current, d);
      });
      loadFromFile<string[]>("expanded-categories.json").then((d) => {
        if (Array.isArray(d) && d.length > 0) setExpandedCategories(new Set(d));
      });
      loadFromFile<BoardCategory[]>("board-categories.json").then((d) => {
        if (Array.isArray(d) && d.length > 0) setBoardCategories(d);
      });
      loadFromFile<number>("board-tree-scroll.json").then((d) => {
        if (typeof d === "number" && Number.isFinite(d) && d >= 0) boardTreeScrollRestoreRef.current = d;
      });
      loadFromFile<{ w: number; h: number }>("new-thread-dialog-size.json").then((d) => {
        if (d && typeof d.w === "number" && typeof d.h === "number") setNewThreadDialogSize(d);
      });
    }
    // Load highlights
    if (isTauriRuntime()) {
      invoke<{ date: string; highlights: IdHighlightMap }>("load_id_highlights")
        .then((data) => {
          if (data.date === todayStr()) {
            setIdHighlights(data.highlights ?? {});
          } else {
            // Date mismatch: daily reset — start fresh and save empty
            setIdHighlights({});
            invoke("save_id_highlights", { data: { date: todayStr(), highlights: {} } }).catch(() => {});
          }
        })
        .catch(() => {});
      invoke<TextHighlight[]>("load_text_highlights")
        .then((data) => setTextHighlights(Array.isArray(data) ? data : []))
        .catch(() => {});
      // Load custom thread titles from thread-history.json
      invoke<Record<string, Record<string, { lastReadNo: number; visitedAt: number; customTitle?: string }>>>("load_thread_history")
        .then((history) => {
          const titles: Record<string, Record<string, string>> = {};
          for (const [boardUrl, threads] of Object.entries(history)) {
            for (const [key, entry] of Object.entries(threads)) {
              if (entry.customTitle) {
                if (!titles[boardUrl]) titles[boardUrl] = {};
                titles[boardUrl][key] = entry.customTitle;
              }
            }
          }
          setCustomTitles(titles);
        })
        .catch(() => {});
    }
    if (isTauriRuntime()) {
      // Load proxy settings
      invoke<{ enabled: boolean; proxyType: string; noCache: boolean; httpMode: boolean; receive: ProxyEndpoint; send: ProxyEndpoint }>("load_proxy_settings").then((s) => {
        setProxyEnabled(s.enabled);
        setProxyType(s.proxyType === "socks5" || s.proxyType === "socks4" ? s.proxyType : "http");
        setProxyNoCache(s.noCache === true);
        setProxyHttpMode(s.httpMode === true);
        const ep = (e: Partial<ProxyEndpoint> | undefined): ProxyEndpoint => ({ host: e?.host ?? "", port: e?.port ?? "", username: e?.username ?? "", password: e?.password ?? "" });
        setProxyReceive(ep(s.receive));
        setProxySend(ep(s.send));
      }).catch((e) => console.warn("load_proxy_settings:", e));
      // Load ImageViewURLReplace rules
      invoke<UrlReplaceRule[]>("load_image_url_replace").then((rules) => {
        setImageUrlRules(rules);
      }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!tabRestoreReady) return;
    const data = JSON.stringify({ tabs: threadTabs, activeIndex: activeTabIndex });
    if (isTauriRuntime()) {
      invoke("save_session_tabs", { data }).catch(() => {});
    }
  }, [tabRestoreReady, threadTabs, activeTabIndex]);

  // Save board tabs when they change
  useEffect(() => {
    if (!tabRestoreReady) return;
    const data = JSON.stringify({ tabs: boardTabs, activeIndex: activeBoardTabIndex });
    if (isTauriRuntime()) { invoke("save_session_board_tabs", { data }).catch(() => {}); }
  }, [tabRestoreReady, boardTabs, activeBoardTabIndex]);

  useEffect(() => {
    if (boardPaneTab !== "boards") return;
    if (!boardTreeRef.current) return;
    const saved = boardTreeScrollRestoreRef.current;
    if (saved == null) return;
    boardTreeRef.current.scrollTop = saved;
  }, [boardPaneTab, boardCategories]);

  const handlePopupImageClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const bodyLink = target.closest<HTMLAnchorElement>("a.body-link");
    if (bodyLink) {
      e.preventDefault();
      const url = bodyLink.getAttribute("href");
      if (url && /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(url) && isTauriRuntime()) {
        void invoke("open_image_popup", { url }).catch(() => window.open(url, "_blank"));
      } else if (url && isTauriRuntime()) {
        void invoke("open_external_url", { url }).catch(() => window.open(url, "_blank"));
      } else if (url) {
        window.open(url, "_blank");
      }
      return;
    }
    if (target.classList.contains("response-thumb") || target.closest<HTMLElement>("[data-lightbox-src]")) {
      e.preventDefault();
      const thumbLink = target.closest<HTMLElement>("[data-lightbox-src]");
      const url = thumbLink?.dataset.lightboxSrc ?? "";
      if (url && isTauriRuntime()) {
        void invoke("open_image_popup", { url }).catch(() => window.open(url, "_blank"));
      } else if (url) {
        window.open(url, "_blank");
      }
      return;
    }
  };

  const saveImage = async (url: string) => {
    if (!isTauriRuntime()) return;
    let folder = imageSaveFolder;
    if (!folder) {
      const picked = await invoke<string | null>("open_folder_dialog").catch(() => null);
      if (!picked) return;
      folder = picked;
      setImageSaveFolder(folder);
    }
    try {
      const savedPath = await invoke<string>("save_image_to_folder", { url, folder });
      setStatus(`保存: ${savedPath}`);
    } catch (e) {
      setStatus(`保存失敗: ${String(e)}`);
    }
  };

  const showHoverPreview = (src: string) => {
    if (hoverPreviewHideTimerRef.current) {
      clearTimeout(hoverPreviewHideTimerRef.current);
      hoverPreviewHideTimerRef.current = null;
    }
    const show = () => {
      if (src !== hoverPreviewSrcRef.current) {
        hoverPreviewSrcRef.current = src;
        hoverPreviewZoomRef.current = 100;
        if (hoverPreviewImgRef.current) {
          hoverPreviewImgRef.current.src = src;
          hoverPreviewImgRef.current.style.width = "auto";
          hoverPreviewImgRef.current.style.transform = "scale(1)";
        }
      }
      if (hoverPreviewRef.current) {
        hoverPreviewRef.current.style.display = "block";
        hoverPreviewRef.current.scrollTop = 0;
        hoverPreviewRef.current.scrollLeft = 0;
      }
    };
    if (hoverPreviewShowTimerRef.current) {
      clearTimeout(hoverPreviewShowTimerRef.current);
      hoverPreviewShowTimerRef.current = null;
    }
    const delay = hoverPreviewDelayRef.current;
    if (delay > 0 && src !== hoverPreviewSrcRef.current) {
      hoverPreviewShowTimerRef.current = setTimeout(show, delay);
    } else {
      show();
    }
  };

  const handlePopupImageHover = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const thumb = target.closest<HTMLImageElement>("img.response-thumb");
    if ((!e.ctrlKey && !hoverPreviewEnabled) || !thumb) return;
    const src = thumb.getAttribute("src");
    if (!src) return;
    showHoverPreview(src);
  };

  useEffect(() => {
    return () => {
      if (anchorPopupCloseTimer.current) {
        clearTimeout(anchorPopupCloseTimer.current);
        anchorPopupCloseTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const ensurePaneBounds = () => {
      const maxBoard = Math.max(
        MIN_BOARD_PANE_PX,
        window.innerWidth - MIN_RESPONSE_PANE_PX - SPLITTER_PX
      );
      const nextBoard = clamp(boardPanePx, MIN_BOARD_PANE_PX, maxBoard);
      if (nextBoard !== boardPanePx) setBoardPanePx(nextBoard);

      const layoutHeight = responseLayoutRef.current?.clientHeight ?? Math.max(520, window.innerHeight - 180);
      const maxThread = Math.max(MIN_THREAD_PANE_PX, layoutHeight - MIN_RESPONSE_BODY_PX - SPLITTER_PX);
      const nextThread = clamp(threadPanePx, MIN_THREAD_PANE_PX, maxThread);
      if (nextThread !== threadPanePx) {
        setThreadPanePx(nextThread);
        setResponseTopRatio((nextThread / Math.max(layoutHeight, 1)) * 100);
      }
    };

    ensurePaneBounds();
    window.addEventListener("resize", ensurePaneBounds);
    return () => window.removeEventListener("resize", ensurePaneBounds);
  }, [boardPanePx, threadPanePx]);

  // Keep ref in sync with threadUrl state
  useEffect(() => { currentThreadUrlRef.current = threadUrl; }, [threadUrl]);

  // Save scroll position on app close (beforeunload)
  useEffect(() => {
    const onUnload = () => {
      const url = currentThreadUrlRef.current;
      if (url) saveScrollPos(url);
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const closeHoverPreview = () => {
      hoverPreviewSrcRef.current = null;
      if (hoverPreviewShowTimerRef.current) {
        clearTimeout(hoverPreviewShowTimerRef.current);
        hoverPreviewShowTimerRef.current = null;
      }
      if (hoverPreviewHideTimerRef.current) {
        clearTimeout(hoverPreviewHideTimerRef.current);
        hoverPreviewHideTimerRef.current = null;
      }
      if (hoverPreviewRef.current) hoverPreviewRef.current.style.display = "none";
    };
    const onMouseMove = (event: MouseEvent) => {
      const drag = resizeDragRef.current;
      if (!drag) return;

      if (drag.mode === "col-resize") {
        const delta = event.clientX - drag.startX;
        const newWidth = Math.max(MIN_COL_WIDTH, drag.reverse ? drag.startWidth - delta : drag.startWidth + delta);
        setThreadColWidths((prev) => ({ ...prev, [drag.colKey]: newWidth }));
        return;
      }

      if (drag.mode === "response-rows") {
        const deltaY = event.clientY - drag.startY;
        const maxThread = Math.max(
          MIN_THREAD_PANE_PX,
          drag.responseLayoutHeight - MIN_RESPONSE_BODY_PX - SPLITTER_PX
        );
        const nextThread = clamp(drag.startThreadPx + deltaY, MIN_THREAD_PANE_PX, maxThread);
        setThreadPanePx(nextThread);
        setResponseTopRatio((nextThread / Math.max(drag.responseLayoutHeight, 1)) * 100);
        return;
      }
      if (drag.mode === "new-arrival-resize") {
        const deltaY = event.clientY - drag.startY;
        const next = clamp(drag.startHeight + deltaY, MIN_NEW_ARRIVAL_PX, MAX_NEW_ARRIVAL_PX);
        setNewArrivalPaneHeight(next);
        return;
      }
      if (drag.mode === "compose-resize") {
        // Handle is at the top edge — dragging up grows the panel
        const deltaY = event.clientY - drag.startY;
        const next = clamp(drag.startHeight - deltaY, MIN_COMPOSE_PANEL_PX, MAX_COMPOSE_PANEL_PX);
        setComposePanelPx(next);
        return;
      }
      const deltaX = event.clientX - drag.startX;
      if (drag.mode === "board-thread") {
        const maxBoard = Math.max(
          MIN_BOARD_PANE_PX,
          window.innerWidth - MIN_RESPONSE_PANE_PX - SPLITTER_PX
        );
        const nextBoard = clamp(drag.startBoardPx + deltaX, MIN_BOARD_PANE_PX, maxBoard);
        setBoardPanePx(nextBoard);
      }
    };

    const onMouseUp = () => {
      if (!resizeDragRef.current) return;
      resizeDragRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    const onWheel = (event: WheelEvent) => {
      if (!hoverPreviewSrcRef.current || !event.ctrlKey) return;
      event.preventDefault();
      const next = Math.max(10, Math.min(500, hoverPreviewZoomRef.current + (event.deltaY < 0 ? 20 : -20)));
      hoverPreviewZoomRef.current = next;
      if (hoverPreviewImgRef.current) hoverPreviewImgRef.current.style.transform = `scale(${next / 100})`;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("wheel", onWheel, { passive: false });

    // Save window size/position on resize (debounced)
    let resizeTimer: ReturnType<typeof setTimeout>;
    const saveWindowState = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (isTauriRuntime()) {
        void invoke("save_window_size", { width, height }).catch((e: unknown) => console.warn("save_window_size failed", e));
      }
    };
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(saveWindowState, 300);
    };
    window.addEventListener("resize", onResize);
    // Also save on unload so position is captured at close time
    const onBeforeUnload = () => saveWindowState();
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      closeHoverPreview();
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("wheel", onWheel as EventListener);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("beforeunload", onBeforeUnload);
      clearTimeout(resizeTimer);
    };
  }, []);

  // Load user custom CSS (custom.css + SIKI互換の data/theme/ 一式) and inject it
  // after built-in styles so user rules win at equal specificity.
  // Rust側でサニタイズ済み (外部url()除去は設定に従う)。注入は必ず textContent 経由。
  const themeModeCssRef = useRef<{ light: string; dark: string }>({ light: "", dark: "" });
  const setStyleEl = (id: string, css: string) => {
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = css;
  };
  const applyUserCss = async (allowExternalOverride?: boolean): Promise<boolean> => {
    if (!isTauriRuntime()) return false;
    try {
      const files = await invoke<ThemeCssFile[]>("load_theme_css", { allowExternal: allowExternalOverride ?? null });
      const get = (n: string) => files.find((f) => f.name === n)?.content ?? "";
      // 適用順 = 挿入順: custom → main → mode → postform → setting (後勝ち)
      setStyleEl("user-custom-css", get("custom.css"));
      setStyleEl("theme-main-css", get("main.css"));
      themeModeCssRef.current = { light: get("light.css"), dark: get("dark.css") };
      setStyleEl("theme-mode-css", darkMode ? themeModeCssRef.current.dark : themeModeCssRef.current.light);
      setStyleEl("theme-postform-css", get("postform.css") ? `@scope (.compose-window) {\n${get("postform.css")}\n}` : "");
      setStyleEl("theme-setting-css", get("setting.css") ? `@scope (.settings-panel) {\n${get("setting.css")}\n}` : "");
      const blockedHosts = [...new Set(files.flatMap((f) => f.strippedHosts))];
      const oversized = files.filter((f) => f.oversized).map((f) => f.name);
      if (blockedHosts.length > 0) {
        setStatus(`カスタムCSS: 外部URL参照をブロックしました (${blockedHosts.join(", ")}) — 許可する場合は設定を変更してください`);
      }
      if (oversized.length > 0) {
        setStatus(`カスタムCSS: サイズ上限(512KB)超過のため読み込みをスキップ: ${oversized.join(", ")}`);
      }
      return true;
    } catch (e) {
      console.warn("user css load error:", e);
      return false;
    }
  };

  useEffect(() => {
    void applyUserCss();
  }, []);

  // ライト/ダーク切替時に light.css / dark.css を差し替える
  useEffect(() => {
    setStyleEl("theme-mode-css", darkMode ? themeModeCssRef.current.dark : themeModeCssRef.current.light);
  }, [darkMode]);

  // settings.ini の内容 (キー → 文字列) を state に反映する。起動時の読み込みと、設定画面の復元・リセットで使う
  const applyAppSettings = (map: Record<string, string>) => {
      if (map["App.fontSize"]) { const n = parseInt(map["App.fontSize"], 10); if (!isNaN(n)) { setResponsesFontSize(n); setBoardsFontSize(n); setThreadsFontSize(n); } }
      if (map["App.responseGap"]) { const n = parseInt(map["App.responseGap"], 10); if (!isNaN(n)) setResponseGap(n); }
      if (map["App.autoReloadIntervalSec"]) { const n = parseInt(map["App.autoReloadIntervalSec"], 10); if (!isNaN(n)) setAutoRefreshInterval(n); }
      if (map["App.autoReload"]) setAutoRefreshEnabled(map["App.autoReload"] === "true");
      if (map["App.autoScroll"]) setAutoScrollEnabled(map["App.autoScroll"] === "true");
      if (map["App.smoothScroll"]) setSmoothScroll(map["App.smoothScroll"] === "true");
      if (map["App.maxOpenTabs"]) { const n = parseInt(map["App.maxOpenTabs"], 10); if (!isNaN(n) && n >= 1) setMaxOpenTabs(n); }
      if (map["App.twitchSpeakName"]) setTwitchSpeakName(map["App.twitchSpeakName"] !== "false");
      if (map["App.twitchBadges"]) setTwitchBadgesEnabled(map["App.twitchBadges"] !== "false");
      { const n = parseInt(map["App.twitchEmoteSize"] ?? "", 10); if (!isNaN(n) && n >= 8 && n <= 200) setTwitchEmoteSize(n); }
      { const n = parseInt(map["App.twitchGiantEmoteSize"] ?? "", 10); if (!isNaN(n) && n >= 16 && n <= 600) setTwitchGiantEmoteSize(n); }
      if (map["App.twitchEmoteSpeak"]) setTwitchEmoteSpeak(map["App.twitchEmoteSpeak"] === "none" ? "none" : "name");
      { const n = parseInt(map["App.subtitleEmoteSize"] ?? "", 10); if (!isNaN(n) && n >= 8 && n <= 400) setSubtitleEmoteSize(n); }
      { const n = parseInt(map["App.subtitleGiantEmoteSize"] ?? "", 10); if (!isNaN(n) && n >= 16 && n <= 800) setSubtitleGiantEmoteSize(n); }
      if (map["App.boardEmotes"]) setBoardEmotesEnabled(map["App.boardEmotes"] !== "false");
      if (map["App.twitchTeach"]) setTwitchTeachEnabled(map["App.twitchTeach"] === "true");
      if (map["App.twitchTeachAnnounce"]) setTwitchTeachAnnounce(map["App.twitchTeachAnnounce"] !== "false");
      { const n = parseInt(map["App.twitchEmoteMax"] ?? "", 10); if (!isNaN(n) && n >= 1) setTwitchEmoteMax(Math.min(TWITCH_EMOTE_MAX_LIMIT, n)); }
      if (map["App.overlayEnabled"]) setOverlayEnabled(map["App.overlayEnabled"] === "true");
      if (map["App.viewerLatestHeight"]) { const n = parseInt(map["App.viewerLatestHeight"], 10); if (!isNaN(n) && n >= 80 && n <= 2000) setLatestPanelHeight(n); }
      if (map["App.viewerLatestPanel"]) setLatestPanelOpen(map["App.viewerLatestPanel"] !== "false");
      if (map["App.viewerFontFamily"] !== undefined) { const f = map["App.viewerFontFamily"].replace(/["\\;{}<>]/g, "").slice(0, 100); setViewerFontFamily(f); setViewerFontPickerInput(f); }
      if (map["App.viewerFontBold"] !== undefined) setViewerFontBold(map["App.viewerFontBold"] === "true");
      if (map["App.viewerCards"] !== undefined) setViewerCards(map["App.viewerCards"] !== "false");
      if (map["App.viewerAllResponses"] !== undefined) setViewerAllResponses(map["App.viewerAllResponses"] === "true");
      if (map["App.viewerThumbs"] !== undefined) setViewerThumbs(map["App.viewerThumbs"] !== "false");
      if (map["App.viewerTwitchClickToLoad"] !== undefined) setViewerTwitchClickToLoad(map["App.viewerTwitchClickToLoad"] === "true");
      setViewerShow((prev) => {
        const next = { ...prev };
        for (const [k] of VIEWER_SHOW_LABELS) {
          const v = map[`App.viewerShow${k[0].toUpperCase()}${k.slice(1)}`];
          if (v !== undefined) next[k] = v !== "false";
        }
        return next;
      });
      setLatestShow((prev) => {
        const next = { ...prev };
        for (const [k] of LATEST_SHOW_LABELS) {
          const v = map[`App.latestShow${k[0].toUpperCase()}${k.slice(1)}`];
          if (v !== undefined) next[k] = v !== "false";
        }
        return next;
      });
      if (map["App.viewerFontSize"] !== undefined) { const n = parseInt(map["App.viewerFontSize"], 10); setViewerFontSize(!isNaN(n) && n >= 8 && n <= 48 ? n : 0); }
      if (map["App.overlayPort"]) { const n = parseInt(map["App.overlayPort"], 10); if (!isNaN(n) && n >= 1024 && n <= 65535) setOverlayPort(n); }
      if (map["App.twitchMaxQueuedArrivals"]) { const n = parseInt(map["App.twitchMaxQueuedArrivals"], 10); if (!isNaN(n)) setTwitchMaxQueuedArrivals(clampTwitchLimit(n)); }
      if (map["App.twitchMaxTtsBacklog"]) { const n = parseInt(map["App.twitchMaxTtsBacklog"], 10); if (!isNaN(n)) setTwitchMaxTtsBacklog(clampTwitchLimit(n)); }
      if (map["App.youtubeMethod"] && /^[a-z]{1,20}$/.test(map["App.youtubeMethod"])) setYoutubeMethod(map["App.youtubeMethod"]);
      { const n = parseInt(map["App.youtubeApiInterval"] ?? "", 10); if (!isNaN(n)) setYoutubeApiInterval(Math.max(YOUTUBE_API_INTERVAL_MIN, Math.min(YOUTUBE_API_INTERVAL_MAX, n))); }
      if (map["App.youtubeSpeakName"]) setYoutubeSpeakName(map["App.youtubeSpeakName"] !== "false");
      if (map["App.youtubeTargetOn"] !== undefined) setYoutubeTargetOn(map["App.youtubeTargetOn"] === "true");
      { const n = parseInt(map["App.youtubeTargetHours"] ?? "", 10); if (!isNaN(n)) setYoutubeTargetHours(Math.max(1, Math.min(YOUTUBE_TARGET_HOURS_MAX, n))); }
      { const n = parseInt(map["App.youtubeDailyQuota"] ?? "", 10); if (!isNaN(n)) setYoutubeDailyQuota(Math.max(1, Math.min(YOUTUBE_DAILY_QUOTA_MAX, n))); }
      { const n = parseInt(map["App.youtubeWriteReserve"] ?? "", 10); if (!isNaN(n)) setYoutubeWriteReserve(Math.max(0, Math.min(YOUTUBE_WRITE_RESERVE_MAX, n))); }
      if (map["App.chatSendConfirm"] !== undefined) setChatSendConfirm(map["App.chatSendConfirm"] !== "false");
      if (map["App.tabSiteColors"]) setTabSiteColors(map["App.tabSiteColors"] !== "false");
      if (map["App.tabWidthFixed"] !== undefined) setTabWidthFixed(map["App.tabWidthFixed"] !== "false");
      { const n = parseInt(map["App.boardTabWidth"] ?? "", 10); if (!isNaN(n)) setBoardTabWidth(Math.max(TAB_WIDTH_MIN, Math.min(TAB_WIDTH_MAX, n))); }
      { const n = parseInt(map["App.threadTabWidth"] ?? "", 10); if (!isNaN(n)) setThreadTabWidth(Math.max(TAB_WIDTH_MIN, Math.min(TAB_WIDTH_MAX, n))); }
      if (map["App.autoUpdateCheck"]) setAutoUpdateCheck(map["App.autoUpdateCheck"] !== "false");
      if (map["App.lastUpdateCheck"] !== undefined) setLastUpdateCheck(map["App.lastUpdateCheck"]);
      if (map["App.knownLatestVersion"] !== undefined) setKnownLatestVersion(map["App.knownLatestVersion"]);
      if (map["App.updateNoticeSeen"] !== undefined) setUpdateNoticeSeen(map["App.updateNoticeSeen"]);
      if (map["App.viewerComposeTarget"] !== undefined) setViewerComposeTarget(map["App.viewerComposeTarget"]);
      if (map["App.logRetentionDays"]) { const n = parseInt(map["App.logRetentionDays"], 10); if (!isNaN(n) && n >= 0) setLogRetentionDays(n); }
      if (map["App.webviewCacheMb"]) { const n = parseInt(map["App.webviewCacheMb"], 10); if (!isNaN(n)) setWebviewCacheMb(Math.max(10, Math.min(1000, n))); }
      if (map["App.imageSaveFolder"] !== undefined) setImageSaveFolder(map["App.imageSaveFolder"]);
      if (map["App.bbsmenuUrl"] !== undefined && map["App.bbsmenuUrl"].trim()) setBbsmenuUrl(map["App.bbsmenuUrl"]);
      if (map["App.shitarabaHost"] !== undefined && map["App.shitarabaHost"].trim()) setShitarabaHost(map["App.shitarabaHost"]);
      if (map["App.jpnknHost"] !== undefined && map["App.jpnknHost"].trim()) setJpnknHost(map["App.jpnknHost"]);
      if (map["App.mainAlwaysOnBottom"]) setMainAlwaysOnBottom(map["App.mainAlwaysOnBottom"] === "true");
      if (map["App.cssAllowExternalUrls"]) setCssAllowExternalUrls(map["App.cssAllowExternalUrls"] === "true");
      if (map["App.streamMaskEnabled"] !== undefined) setStreamMaskEnabled(map["App.streamMaskEnabled"] === "true");
      if (map["App.ngAboneSpeakEnabled"] !== undefined) setNgAboneSpeakEnabled(map["App.ngAboneSpeakEnabled"] === "true");
      // Speech settings
      if (map["Speech.mode"]) setTtsMode(map["Speech.mode"] as TtsMode);
      if (map["Speech.enabled"]) setTtsEnabled(map["Speech.enabled"] === "true");
      if (map["Speech.maxReadLength"]) { const n = parseInt(map["Speech.maxReadLength"], 10); if (!isNaN(n) && n >= 0) setTtsMaxReadLength(n); }
      if (map["Speech.urlOmit"] !== undefined) setTtsUrlOmitEnabled(map["Speech.urlOmit"] !== "false");
      if (map["Speech.boardMode"] !== undefined) setTtsBoardMode(map["Speech.boardMode"] === "whitelist" ? "whitelist" : "full");
      if (map["Speech.sapiVoiceIndex"]) { const n = parseInt(map["Speech.sapiVoiceIndex"], 10); if (!isNaN(n)) setSapiVoiceIndex(n); }
      if (map["Speech.sapiRate"]) { const n = parseInt(map["Speech.sapiRate"], 10); if (!isNaN(n)) setSapiRate(n); }
      if (map["Speech.sapiVolume"]) { const n = parseInt(map["Speech.sapiVolume"], 10); if (!isNaN(n)) setSapiVolume(n); }
      if (map["Speech.bouyomiPath"] !== undefined) setBouyomiPath(map["Speech.bouyomiPath"]);
      if (map["Speech.voicevoxEndpoint"]) setVoicevoxEndpoint(map["Speech.voicevoxEndpoint"]);
      if (map["Speech.voicevoxSpeakerId"]) { const n = parseInt(map["Speech.voicevoxSpeakerId"], 10); if (!isNaN(n)) setVoicevoxSpeakerId(n); }
      if (map["Speech.voicevoxSpeedScale"]) { const n = parseFloat(map["Speech.voicevoxSpeedScale"]); if (!isNaN(n)) setVoicevoxSpeedScale(n); }
      if (map["Speech.voicevoxPitchScale"]) { const n = parseFloat(map["Speech.voicevoxPitchScale"]); if (!isNaN(n)) setVoicevoxPitchScale(n); }
      if (map["Speech.voicevoxIntonationScale"]) { const n = parseFloat(map["Speech.voicevoxIntonationScale"]); if (!isNaN(n)) setVoicevoxIntonationScale(n); }
      if (map["Speech.voicevoxVolumeScale"]) { const n = parseFloat(map["Speech.voicevoxVolumeScale"]); if (!isNaN(n)) setVoicevoxVolumeScale(n); }
      // Posting settings
      if (map["Posting.name"] !== undefined) setComposeName(map["Posting.name"]);
      if (map["Posting.mail"] !== undefined) setComposeMail(map["Posting.mail"]);
      if (map["Posting.sage"]) setComposeSage(map["Posting.sage"] === "true");
      if (map["Posting.fontSize"]) { const n = parseInt(map["Posting.fontSize"], 10); if (!isNaN(n) && n >= 10 && n <= 24) setComposeFontSize(n); }
      if (map["Posting.composeOpen"]) setComposeOpen(map["Posting.composeOpen"] === "true");
  };
  // Load app settings from settings.ini on startup
  useEffect(() => {
    if (!isTauriRuntime()) { appSettingsLoadedRef.current = true; setAppSettingsReady(true); return; }
    invoke<Record<string, string>>("load_app_settings")
      .then((map) => { applyAppSettings(map); runStartupUpdateCheck(map); })
      .catch(() => {})
      .finally(() => { appSettingsLoadedRef.current = true; setAppSettingsReady(true); });
  }, []);

  // Load TTS dictionary on startup
  useEffect(() => {
    if (!isTauriRuntime()) return;
    invoke<TtsDictEntry[]>("load_tts_dict").then((entries) => {
      setTtsDictEntries(entries);
      ttsDictLoadedRef.current = true;
    }).catch((e) => { console.warn("load_tts_dict failed", e); });
    invoke<TtsIpAllowEntry[]>("load_tts_ip_allow").then((entries) => {
      setTtsIpAllow(entries);
      ttsIpAllowLoadedRef.current = true;
    }).catch((e) => { console.warn("load_tts_ip_allow failed", e); });
    invoke<Partial<TtsMuteDict>>("load_tts_mute_dict").then((d) => {
      setTtsMuteDict({ names: d.names ?? [], words: d.words ?? [], ids: d.ids ?? [] });
      ttsMuteLoadedRef.current = true;
    }).catch((e) => { console.warn("load_tts_mute_dict failed", e); });
  }, []);

  // Load OGP domain filters on startup
  useEffect(() => {
    if (!isTauriRuntime()) return;
    invoke<Partial<OgpDomainFilters>>("load_ogp_domain_filters").then((data) => {
      setOgpDomainFilters({ allow: data.allow ?? [], block: data.block ?? [] });
    }).catch((e) => { console.warn("load_ogp_domain_filters failed", e); });
  }, []);

  const persistOgpDomainFilters = (next: OgpDomainFilters) => {
    setOgpDomainFilters(next);
    if (!isTauriRuntime()) return;
    void invoke("save_ogp_domain_filters", { filters: next }).catch((e) => { console.warn("save_ogp_domain_filters failed", e); });
  };
  const addOgpDomain = (kind: "allow" | "block", value: string) => {
    const dom = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    if (!dom || ogpDomainFilters[kind].includes(dom)) return;
    persistOgpDomainFilters({ ...ogpDomainFilters, [kind]: [...ogpDomainFilters[kind], dom] });
  };
  const removeOgpDomain = (kind: "allow" | "block", value: string) => {
    persistOgpDomainFilters({ ...ogpDomainFilters, [kind]: ogpDomainFilters[kind].filter((d) => d !== value) });
  };

  // Probe/diagnostic UI is only shown in dev builds (or LIVEFAKE_DIAG=1)
  useEffect(() => {
    if (!isTauriRuntime()) return;
    invoke<boolean>("diagnostics_enabled").then(setDiagnosticsEnabled).catch((e) => {
      console.warn("diagnostics_enabled failed", e);
    });
  }, []);

  // Save TTS dictionary when entries change (読み込み完了後のみ: 初期値で上書きしない)
  useEffect(() => {
    if (!isTauriRuntime() || !ttsDictLoadedRef.current) return;
    void invoke("save_tts_dict", { entries: ttsDictEntries }).catch((e) => { console.warn("save_tts_dict failed", e); });
  }, [ttsDictEntries]);
  useEffect(() => {
    if (!isTauriRuntime() || !ttsIpAllowLoadedRef.current) return;
    void invoke("save_tts_ip_allow", { entries: ttsIpAllow }).catch((e) => { console.warn("save_tts_ip_allow failed", e); });
  }, [ttsIpAllow]);
  useEffect(() => {
    if (!isTauriRuntime() || !ttsMuteLoadedRef.current) return;
    void invoke("save_tts_mute_dict", { dict: ttsMuteDict }).catch((e) => { console.warn("save_tts_mute_dict failed", e); });
  }, [ttsMuteDict]);

  // --- OGP / X ポストカードの取得 (キャッシュ・同時要求の共有つき) ---
  const fetchTweetCardCached = (url: string): Promise<TweetCardData | null> => {
    const cache = tweetCacheRef.current;
    if (cache.has(url)) return Promise.resolve(cache.get(url) ?? null);
    const inflight = tweetInflightRef.current;
    const existing = inflight.get(url);
    if (existing) return existing;
    if (!isTauriRuntime()) return Promise.resolve(null);
    const p = invoke<TweetCardData>("fetch_tweet_card", { url })
      .then((card) => { cache.set(url, card); return card; })
      .catch((err) => {
        // 削除済み・非公開ポストはここに来る (素リンク表示のままにする)
        console.warn("fetch_tweet_card failed", url, err);
        cache.set(url, null);
        return null;
      })
      .finally(() => { inflight.delete(url); });
    inflight.set(url, p);
    return p;
  };
  const fetchOgpCardCached = (url: string): Promise<OgpCardData | null> => {
    const cache = ogpCacheRef.current;
    if (cache.has(url)) return Promise.resolve(cache.get(url) ?? null);
    const inflight = ogpInflightRef.current;
    const existing = inflight.get(url);
    if (existing) return existing;
    if (!isTauriRuntime()) return Promise.resolve(null);
    const p = invoke<OgpCardData>("fetch_ogp_card", { url })
      .then((card) => { cache.set(url, card); return card; })
      .catch((err) => {
        console.warn("fetch_ogp_card failed", url, err);
        cache.set(url, null);
        return null;
      })
      .finally(() => { inflight.delete(url); });
    inflight.set(url, p);
    return p;
  };
  // スロット 1 個分のカード HTML を解決する (取れなければ空文字)。
  // X ポストは削除済み・非公開・取得失敗時に通常の OGP カードへフォールバックする (OGP カード ON のときのみ)。
  const resolveCardHtml = async (url: string, tweetId: string | undefined, ogpFallback: boolean): Promise<string> => {
    if (!/^https?:\/\//i.test(url)) return "";
    if (tweetId) {
      const tweet = await fetchTweetCardCached(url);
      const htmlText = tweet ? buildTweetCardHtml(tweet) : "";
      if (htmlText) return htmlText;
      if (!ogpFallback) return "";
    }
    const card = await fetchOgpCardCached(url);
    return card && ogpCardHasContent(card) ? buildOgpCardHtml(card) : "";
  };
  // 本文の中のクリック (リンク・サムネイル・サイズ上限の画像)。処理したら true (レス表示欄とビュワーで共通)
  const handleBodyContentClick = (e: React.MouseEvent<HTMLElement>): boolean => {
    const target = e.target as HTMLElement;
    // body-link: open 5ch thread URLs in tab, others in external browser
    const bodyLink = target.closest<HTMLAnchorElement>("a.body-link");
    if (bodyLink) {
      e.preventDefault();
      const url = bodyLink.getAttribute("href");
      if (url) {
        let _p = "";
        try { _p = new URL(url, "https://dummy").pathname; } catch { /* ignore */ }
        if (/\/(test|bbs)\/read\.cgi\/[^/]+\/[^/]+/.test(_p)) {
          const title = url.split("/").pop() || url;
          openThreadInTab(url, title);
          return true;
        }
        // 板トップURL(スレ一覧ページ)は上のスレURL判定には一致しないため、
        // 自サイト(5ch/したらば/JPNKN)のURLであれば内部で板として開く。
        // これに一致しない他サイトのURLは従来どおり外部ブラウザで開く
        if (isSameSiteBoardUrl(url)) {
          const slug = _p.replace(/\/+$/, "").split("/").filter(Boolean).pop() || url;
          selectBoard({ boardName: slug, url });
          return true;
        }
      }
      if (url && /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(url) && isTauriRuntime()) {
        void invoke("open_image_popup", { url }).catch(() => window.open(url, "_blank"));
        return true;
      }
      if (url && isTauriRuntime()) {
        void invoke("open_external_url", { url }).catch(() => window.open(url, "_blank"));
      } else if (url) {
        window.open(url, "_blank");
      }
      return true;
    }
    // thumb image click: open in popup window
    if (target.classList.contains("response-thumb") || target.closest<HTMLElement>("[data-lightbox-src]")) {
      e.preventDefault();
      const thumbLink = target.closest<HTMLElement>("[data-lightbox-src]");
      const url = thumbLink?.dataset.lightboxSrc ?? "";
      if (url && isTauriRuntime()) {
        void invoke("open_image_popup", { url }).catch(() => window.open(url, "_blank"));
      } else if (url) {
        window.open(url, "_blank");
      }
      return true;
    }
    // Size-gated image click: reveal the image
    const gateBlocked = target.closest<HTMLElement>(".thumb-gate-blocked");
    if (gateBlocked) {
      e.preventDefault();
      const src = gateBlocked.dataset.revealSrc;
      if (src) {
        const parent = gateBlocked.closest<HTMLElement>(".thumb-size-gate");
        if (parent) {
          parent.innerHTML = `<img class="response-thumb" src="${src}" loading="lazy" alt="" />`;
        }
      }
      return true;
    }
    return false;
  };
  // リンクカードの画像が読み込めなかったら (相手のサーバーが断る・消えた など)、画像の枠ごと隠す
  useEffect(() => {
    const onError = (ev: Event) => {
      const img = ev.target;
      if (img instanceof HTMLImageElement && img.parentElement?.classList.contains("ogp-card-thumb")) img.parentElement.classList.add("ogp-card-thumb-failed");
    };
    document.addEventListener("error", onError, true);
    return () => document.removeEventListener("error", onError, true);
  }, []);
  // コンテナ内の .ogp-card-slot を IntersectionObserver で監視し、画面に入ったものだけ取得して埋める
  // (スレ内の全 URL へ一斉に通信しない)。React が innerHTML を差し替えるたびにスロットは白紙で
  // 作り直されるため、MutationObserver で未処理スロットを拾い直す。戻り値は解除関数。
  // 取ったカードの HTML と高さを覚えておく (同じカードは次からすぐに・同じ高さで描く。上限を超えたら古いものから忘れる)
  const cardHtmlCacheRef = useRef<Map<string, string>>(new Map());
  const cardHeightCacheRef = useRef<Map<string, number>>(new Map());
  // コンテナ内の .ogp-card-slot を監視し、画面の1つ分手前まで来たものから取得して埋める。
  // 見ている位置がずれないように:
  //  ① カードの高さが変わったとき (読み込み・取れなかった・中の画像の読み込み)、画面の上端より上から始まるカードなら、その差だけスクロール位置を足し引きする
  //     (一番下にいるときは一番下に付いたままにする)。ブラウザのずれの補正 (overflow-anchor) が効いている場所 (ビュワーなど) では、
  //     二重に動かないよう何もしない (補正を切ってあるレス表示欄で働く)
  //  ② 一度取ったカードは、画面に入るのを待たずにすぐ描く
  //  ③ 取ったカードの高さを覚え、次からは読み込み中の枠をその高さで空ける
  //  ④ 画面の1つ分手前から取りに行く
  const setupOgpFill = (container: HTMLElement, ogpFallback: boolean): (() => void) => {
    const keyOf = (slot: HTMLElement) => `${ogpFallback ? 1 : 0}|${slot.dataset.tweetId ?? ""}|${slot.dataset.ogpUrl ?? ""}`;
    const remember = <T,>(map: Map<string, T>, key: string, value: T, max: number) => {
      map.delete(key);
      map.set(key, value);
      if (map.size > max) map.delete(map.keys().next().value ?? "");
    };
    const heights = new WeakMap<Element, number>();
    const browserAnchors = getComputedStyle(container).overflowAnchor !== "none";
    const ro = new ResizeObserver((entries) => {
      if (browserAnchors) return;
      const rootTop = container.getBoundingClientRect().top;
      let adjust = 0;
      let stick = false;
      for (const en of entries) {
        const el = en.target as HTMLElement;
        const r = el.getBoundingClientRect();
        const prev = heights.get(el) ?? r.height;
        heights.set(el, r.height);
        const delta = r.height - prev;
        if (Math.abs(delta) < 0.5) continue;
        if (el.dataset.ogpState === "done" && r.height > 0) remember(cardHeightCacheRef.current, keyOf(el), r.height, 3000);
        if (delta > 0 && container.scrollTop + container.clientHeight >= container.scrollHeight - delta - 4) { stick = true; continue; }
        // 見ている位置 (画面の上端) より上から始まるカード (全体が隠れているもの・上端にまたがるもの)。
        // その下の、見えているレスが動かないように差を足し引きする
        if (r.top < rootTop) adjust += delta;
      }
      if (stick) container.scrollTop = container.scrollHeight;
      else if (adjust) container.scrollTop += adjust;
    });
    const watch = (slot: HTMLElement) => {
      heights.set(slot, slot.getBoundingClientRect().height);
      ro.observe(slot);
    };
    const fill = (slot: HTMLElement, htmlText: string) => {
      watch(slot); // 埋める前の高さを覚えてから埋める (差は ResizeObserver で足し引きする)
      slot.style.minHeight = "";
      if (htmlText) {
        slot.innerHTML = htmlText;
        slot.dataset.ogpState = "done";
        window.requestAnimationFrame(() => {
          const h = slot.getBoundingClientRect().height;
          if (h > 0 && slot.isConnected) remember(cardHeightCacheRef.current, keyOf(slot), h, 3000);
        });
      } else {
        slot.innerHTML = "";
        slot.dataset.ogpState = "empty";
      }
    };
    const io = new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const slot = entry.target as HTMLElement;
          obs.unobserve(slot);
          if (slot.dataset.ogpState) continue;
          const url = slot.dataset.ogpUrl;
          if (!url) { slot.dataset.ogpState = "empty"; continue; }
          slot.dataset.ogpState = "loading";
          const key = keyOf(slot);
          void resolveCardHtml(url, slot.dataset.tweetId, ogpFallback).then((htmlText) => {
            remember(cardHtmlCacheRef.current, key, htmlText, 500);
            if (!slot.isConnected) return; // 再レンダーでノードが差し替わっている可能性があるので生存確認
            fill(slot, htmlText);
          });
        }
      },
      { root: container, rootMargin: "100% 0px 100% 0px" }
    );
    const observeNewSlots = () => {
      container.querySelectorAll<HTMLElement>(".ogp-card-slot:not([data-ogp-state])").forEach((slot) => {
        const key = keyOf(slot);
        const cached = cardHtmlCacheRef.current.get(key);
        if (cached !== undefined) {
          // ② 取ったことのあるカードはすぐ描く (読み込み中の枠を出さないので、ずれない)
          if (cached) { slot.innerHTML = cached; slot.dataset.ogpState = "done"; } else { slot.dataset.ogpState = "empty"; }
          watch(slot);
          return;
        }
        // ③ 覚えている高さで枠を空ける。リンクカードは本物と同じ形の仮のカードを出す (高さが同じなので表示されてもずれない)
        const h = cardHeightCacheRef.current.get(key);
        if (h) slot.style.minHeight = `${Math.round(h)}px`;
        if (!slot.dataset.tweetId && !slot.firstChild) slot.innerHTML = OGP_SKELETON_HTML;
        io.observe(slot);
      });
    };
    observeNewSlots();
    const mo = new MutationObserver(observeNewSlots);
    mo.observe(container, { childList: true, subtree: true });
    return () => { mo.disconnect(); io.disconnect(); ro.disconnect(); };
  };
  // 字幕ウィンドウからの「表示終了までの残り時間」報告を受け取り、同期 ON なら新着ペインの「次へ進む」を延長する
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<{ seq?: unknown; totalMs?: unknown; bottomInMs?: unknown; holdMs?: unknown }>("subtitle-timing", (ev) => {
      const payload = ev.payload ?? {};
      const seq = typeof payload.seq === "number" ? payload.seq : -1;
      const ms = (v: unknown, def: number) => typeof v === "number" && Number.isFinite(v) ? Math.min(600000, Math.max(0, v)) : def;
      const totalMs = ms(payload.totalMs, 0);
      // 旧形式 (totalMs のみ) は「到達までが totalMs、到達後 0」とみなす
      const bottomInMs = ms(payload.bottomInMs, totalMs);
      const holdMs = ms(payload.holdMs, 0);
      if (seq !== subtitleSeqRef.current) return; // 古いレスの報告は無視
      subtitleEndAtRef.current = { seq, bottomAt: performance.now() + bottomInMs, holdMs };
      if (!subtitleSyncEnabledRef.current) return;
      // 新着ペイン側が既に「次へ」を予約済みなら、字幕の分だけ延長する (短くはしない)
      const deadline = arrivalFinalDeadlineRef.current;
      const fire = arrivalFinalFireRef.current;
      const plan = arrivalPlanRef.current;
      if (!plan) return;
      const endAt = syncedEndAt(plan);
      if (deadline !== null && fire && endAt > deadline && arrivalTimerRef.current) {
        clearTimeout(arrivalTimerRef.current);
        arrivalFinalDeadlineRef.current = endAt;
        arrivalTimerRef.current = setTimeout(fire, Math.max(0, endAt - performance.now()));
      }
    }).then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch((e) => console.warn("subtitle-timing listen failed", e));
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, []);
  // 設定画面: 節タブによる表示切り替えと、検索語による設定項目の絞り込み (DOM の文言で照合)。
  // 登録内容 (NG ワード・辞書・ハイライト) は data-search-exclude で検索対象から外す。
  useLayoutEffect(() => {
    const root = settingsContentRef.current;
    if (!settingsOpen || !root) return;
    const q = settingsQuery.trim().toLowerCase();
    const cats = Array.from(root.querySelectorAll<HTMLElement>(".settings-cat"));
    const matchedCats = new Set<string>();
    for (const cat of cats) {
      let catVisible = false;
      for (const sec of Array.from(cat.querySelectorAll<HTMLElement>(".settings-section"))) {
        if (!q) {
          // 通常表示: 選択中の節だけ表示し、検索用の hidden を全て解除
          sec.hidden = sec.dataset.section !== settingsActiveSection;
          for (const el of Array.from(sec.querySelectorAll<HTMLElement>("[data-sf]"))) { el.hidden = false; el.classList.remove("settings-match"); delete el.dataset.sf; }
          continue;
        }
        let secVisible = false;
        for (const fs of Array.from(sec.querySelectorAll<HTMLElement>("fieldset"))) {
          const legend = fs.querySelector("legend");
          const legendMatch = !!legend && (legend.textContent ?? "").toLowerCase().includes(q);
          let anyRow = false;
          for (const row of Array.from(fs.querySelectorAll<HTMLElement>(".settings-row"))) {
            if (row.closest("[data-search-exclude]")) continue;
            const hit = legendMatch || (row.textContent ?? "").toLowerCase().includes(q);
            row.hidden = !hit; row.dataset.sf = "1";
            row.classList.toggle("settings-match", hit && !legendMatch);
            if (hit) anyRow = true;
          }
          for (const ex of Array.from(fs.querySelectorAll<HTMLElement>("[data-search-exclude]"))) { ex.hidden = !legendMatch; ex.dataset.sf = "1"; }
          const fsVisible = legendMatch || anyRow;
          fs.hidden = !fsVisible; fs.dataset.sf = "1";
          if (fsVisible) secVisible = true;
        }
        sec.hidden = !secVisible;
        if (secVisible) catVisible = true;
      }
      if (catVisible) matchedCats.add(cat.dataset.cat ?? "");
    }
    // 左の分類: 検索中は一致の無い分類を薄く表示
    for (const btn of Array.from(document.querySelectorAll<HTMLElement>(".settings-nav-item[data-cat]"))) {
      btn.classList.toggle("no-match", !!q && !matchedCats.has(btn.dataset.cat ?? ""));
    }
  });

  // 字幕ウィンドウからの操作: 手動スクロール → 一時停止 / ▶ → 次のレスへ (以降は通常のタイマー制御)
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<{ action?: unknown }>("subtitle-control", (ev) => {
      const action = ev.payload?.action;
      if (action === "pause") {
        arrivalPausedRef.current = true;
        setArrivalPaused(true);
        arrivalRunIdRef.current++; // 進行中のスクロールを止める
        if (arrivalTimerRef.current) { clearTimeout(arrivalTimerRef.current); arrivalTimerRef.current = null; }
        arrivalFinalDeadlineRef.current = null;
        arrivalFinalFireRef.current = null;
      } else if (action === "next") {
        arrivalPausedRef.current = false;
        setArrivalPaused(false);
        advanceToNextArrivalRef.current();
      } else if (action === "open-settings") {
        openSubtitleFrameSettingsRef.current();
      }
    }).then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch((e) => console.warn("subtitle-control listen failed", e));
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, []);
  // 書き込みの浮遊ウィンドウからの送信要求。実際の投稿は既存の投稿フローで行う

  // Twitch: 受信したチャットと接続状態を受け取る
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    const unlistens: (() => void)[] = [];
    const keep = (p: Promise<() => void>, label: string) => {
      p.then((fn) => { if (disposed) fn(); else unlistens.push(fn); }).catch((e) => console.warn(label, e));
    };
    keep(listen<TwitchChatPayload>("twitch-message", (ev) => {
      const m = ev.payload;
      if (!m || typeof m.channel !== "string" || typeof m.text !== "string" || typeof m.login !== "string") return;
      const pending = twitchPendingRef.current;
      pending.push(m);
      // 画面の反映が追いつかないほど溜まったら古いものから捨てる
      if (pending.length > 2000) pending.splice(0, pending.length - 2000);
      if (twitchFlushTimerRef.current === null) {
        twitchFlushTimerRef.current = window.setTimeout(() => twitchFlushRef.current(), TWITCH_FLUSH_MS);
      }
    }), "twitch-message listen failed");
    keep(listen<{ channel?: unknown; state?: unknown; message?: unknown }>("twitch-status", (ev) => {
      const { channel, state, message } = ev.payload ?? {};
      if (typeof channel !== "string" || typeof state !== "string") return;
      const label = state === "connected" ? "チャットの受信を開始しました"
        : state === "connecting" ? "接続しています…"
        : `切断されました ${typeof message === "string" ? message : ""}`;
      setStatus(`Twitch #${channel}: ${label}`);
      setTwitchStatusMap((prev) => ({ ...prev, [channel]: state }));
    }), "twitch-status listen failed");
    keep(listen<YoutubeBatch>("youtube-message", (ev) => {
      const b = ev.payload;
      if (!b || typeof b.video !== "string" || !YT_VIDEO_ID_RE.test(b.video) || !Array.isArray(b.messages)) return;
      const pending = youtubePendingRef.current;
      pending.push(b);
      // 画面の反映が追いつかないほど溜まったら古いものから捨てる
      if (pending.length > 500) pending.splice(0, pending.length - 500);
      if (youtubeFlushTimerRef.current === null) {
        youtubeFlushTimerRef.current = window.setTimeout(() => youtubeFlushRef.current(), TWITCH_FLUSH_MS);
      }
    }), "youtube-message listen failed");
    keep(listen<{ video?: unknown; state?: unknown; message?: unknown; title?: unknown }>("youtube-status", (ev) => {
      const { video, state, message, title } = ev.payload ?? {};
      if (typeof video !== "string" || !YT_VIDEO_ID_RE.test(video) || typeof state !== "string") return;
      const msg = typeof message === "string" ? message.slice(0, 300) : "";
      const label = state === "live" ? "チャットの受信を開始しました"
        : state === "connecting" ? "接続しています…"
        : state === "ended" ? "配信が終わりました"
        : msg;
      setStatus(`YouTube: ${label}`);
      setYoutubeStatusMap((prev) => ({ ...prev, [video]: { state, message: msg } }));
      // 配信のタイトルが分かったら、タブの名前にする
      if (state === "live" && typeof title === "string" && title.trim()) {
        const url = youtubeTabUrl(video);
        const name = `YouTube ${Array.from(title.trim()).slice(0, 60).join("")}`;
        setThreadTabs((prev) => (prev.some((t) => t.threadUrl === url && t.title !== name) ? prev.map((t) => (t.threadUrl === url ? { ...t, title: name } : t)) : prev));
      }
    }), "youtube-status listen failed");
    keep(listen<Record<string, unknown>>("youtube-quota", (ev) => {
      const q = parseYoutubeQuota(ev.payload);
      if (!q) return;
      setYoutubeQuota(q);
      const ratio = q.limit > 0 ? q.used / q.limit : 0;
      const level = ratio >= 0.95 ? 2 : ratio >= 0.8 ? 1 : 0;
      const w = youtubeQuotaWarnRef.current;
      if (w.day !== q.day) { w.day = q.day; w.level = 0; }
      if (level > w.level) {
        w.level = level;
        setStatus(`YouTube: 今日の API の使用量が上限の ${level === 2 ? 95 : 80}% を超えました (${q.used.toLocaleString()} / ${q.limit.toLocaleString()})。上限が戻るまで${formatAboutDuration(q.untilResetSecs)}`);
      }
    }), "youtube-quota listen failed");
    return () => {
      disposed = true;
      for (const fn of unlistens) fn();
      if (twitchFlushTimerRef.current !== null) {
        window.clearTimeout(twitchFlushTimerRef.current);
        twitchFlushTimerRef.current = null;
      }
      if (youtubeFlushTimerRef.current !== null) {
        window.clearTimeout(youtubeFlushTimerRef.current);
        youtubeFlushTimerRef.current = null;
      }
    };
  }, []);
  // Twitch: 開いている Twitch タブのチャンネルだけを受信する (タブの開閉・セッション復元・並べ替えのすべてをここで反映)
  const twitchChannelsKey = threadTabs
    .map((t) => twitchChannelFromUrl(t.threadUrl))
    .filter((c): c is string => c !== null)
    .sort()
    .join(",");
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const channels = twitchChannelsKey ? twitchChannelsKey.split(",") : [];
    void invoke<string[]>("twitch_sync", { channels }).catch((e) => console.warn("twitch_sync failed", e));
  }, [twitchChannelsKey]);
  // YouTube: 開いている YouTube タブの配信だけを受信する。取得方法・間隔を変えたら、Rust 側でつなぎ直す。
  // 設定 (settings.ini) と使える取得方法を読み終えてから始める (読み込み前の既定値で一度つないでしまわないように)
  const youtubeVideosKey = threadTabs
    .map((t) => youtubeVideoFromUrl(t.threadUrl))
    .filter((v): v is string => v !== null)
    .sort()
    .join(",");
  const youtubeEffectiveMethod = youtubeMethods.some((m) => m.id === youtubeMethod) ? youtubeMethod : "api";
  useEffect(() => {
    if (!isTauriRuntime() || !appSettingsReady || youtubeMethods.length === 0) return;
    const videos = youtubeVideosKey ? youtubeVideosKey.split(",") : [];
    void invoke<string[]>("youtube_sync", { videos, method: youtubeEffectiveMethod, minInterval: youtubeApiInterval }).catch((e) => console.warn("youtube_sync failed", e));
  }, [youtubeVideosKey, youtubeEffectiveMethod, youtubeApiInterval, youtubeSyncVersion, appSettingsReady, youtubeMethods.length]);
  // 何時間もたせるか・1日の上限を Rust へ (つなぎ直さない。受信中のタスクが次に呼ぶときから効く)
  useEffect(() => {
    if (!isTauriRuntime() || !appSettingsReady) return;
    void invoke("youtube_quota_config", { targetHours: youtubeTargetOn ? youtubeTargetHours : 0, dailyLimit: youtubeDailyQuota, reserve: youtubeAuth.loggedIn ? youtubeWriteReserve * YOUTUBE_INSERT_COST : 0 })
      .then(() => invoke<unknown>("youtube_quota_status", { minInterval: youtubeApiInterval }))
      .then((v) => { const q = parseYoutubeQuota(v); if (q) setYoutubeQuota(q); })
      .catch((e) => console.warn("youtube_quota_config failed", e));
  }, [youtubeTargetOn, youtubeTargetHours, youtubeDailyQuota, youtubeApiInterval, youtubeAuth.loggedIn, youtubeWriteReserve, appSettingsReady]);
  const setYoutubeQuotaUsed = () => {
    const n = Number(youtubeQuotaUsedInput.trim().replace(/[,，\s]/g, ""));
    if (!Number.isInteger(n) || n < 0 || n > YOUTUBE_DAILY_QUOTA_MAX) { setStatus("使用量は 0 以上の整数で入力してください"); return; }
    void invoke("youtube_quota_set_used", { used: n }).then(() => setYoutubeQuotaUsedInput("")).catch((e) => console.warn("youtube_quota_set_used failed", e));
  };
  const restartYoutubeTarget = () => {
    if (isTauriRuntime()) void invoke("youtube_quota_restart_target").catch((e) => console.warn("youtube_quota_restart_target failed", e));
  };
  // 1つの配信について、使えない理由のダイアログは1回だけ出す (受信できたら、また出せるようにする)
  const youtubeUnusablePromptedRef = useRef<Set<string>>(new Set());
  const YOUTUBE_UNUSABLE_RE = /ライブ配信ではありません|配信は終わっています|チャットがありません|チャットがオフ|動画が見つかりません|チャットが見つかりません/;
  useEffect(() => {
    for (const [video, st] of Object.entries(youtubeStatusMap)) {
      if (st.state === "live") { youtubeUnusablePromptedRef.current.delete(video); continue; }
      if (st.state !== "stopped" || !YOUTUBE_UNUSABLE_RE.test(st.message) || youtubeUnusablePromptedRef.current.has(video)) continue;
      const url = youtubeTabUrl(video);
      const tab = threadTabsRef.current.find((t) => t.threadUrl === url);
      if (!tab) continue;
      youtubeUnusablePromptedRef.current.add(video);
      setAppConfirm({
        title: "この YouTube のチャットは受信できません",
        message: `${tab.title}\n\n理由: ${st.message}\n\nタブを閉じますか?`,
        buttons: [
          { label: "タブを閉じる", primary: true, onClick: () => { const idx = threadTabsRef.current.findIndex((t) => t.threadUrl === url); if (idx >= 0) closeTab(idx); } },
          { label: "開いたままにする", onClick: () => {} },
        ],
      });
      break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [youtubeStatusMap]);
  // 使用量の目安の小さな表示 (YouTube タブの上部・ビュワーの上の段)。押すと 設定 > YouTube > 使用量・間隔 を開く
  const youtubeQuotaChip = () => {
    if (youtubeEffectiveMethod !== "api" || !youtubeQuota) return null;
    const q = youtubeQuota;
    const ratio = q.limit > 0 ? q.used / q.limit : 0;
    const pct = Math.min(100, Math.floor(ratio * 1000) / 10);
    const warn = ratio >= 0.95 ? " danger" : ratio >= 0.8 || (q.targetHours > 0 && q.active > 0 && !q.reachable) ? " warn" : "";
    const tip = [
      `今日の YouTube API の使用量の目安: ${q.used.toLocaleString()} / ${q.limit.toLocaleString()} (${pct}%。LiveFake が呼んだ分)`,
      q.active > 0 ? `${q.intervalSecs}秒ごとにコメントを読み込み中 (受信中の配信 ${q.active} つ)。このままなら残りは${formatAboutDuration(q.lastsSecs)}もちます` : "",
      q.targetEnd ? `目標: ${new Date(q.targetEnd).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} まで${q.reachable ? "" : " (もたない見込み)"}` : "",
      `上限が戻るまで${formatAboutDuration(q.untilResetSecs)}`,
      "押すと 設定 > YouTube > 使用量・間隔 を開きます",
    ].filter(Boolean).join("\n");
    return (
      <button
        className={`youtube-quota-chip${warn}`}
        title={tip}
        onClick={(e) => { e.stopPropagation(); setSettingsOpen(true); switchSettingsCategory("youtube"); setSettingsSection("quota"); }}
      >
        <span className="yt-mark" aria-hidden="true">▶</span>YouTube API {q.used.toLocaleString()} / {q.limit.toLocaleString()} ({pct}%)
      </button>
    );
  };
  const reconnectYoutube = (video: string) => {
    if (!isTauriRuntime()) return;
    void invoke("youtube_reconnect", { video }).then(() => setYoutubeSyncVersion((v) => v + 1)).catch((e) => console.warn("youtube_reconnect failed", e));
  };
  // ログイン中は、公式 API からスタンプの一覧を取って対応表に足す (チャンネルが変わったときと1時間ごと。設定の「今すぐ取得」でも)
  const [emoteFetchMsg, setEmoteFetchMsg] = useState("");
  const fetchTwitchEmotesNow = (manual: boolean) => {
    if (!isTauriRuntime()) return;
    if (manual) setEmoteFetchMsg("取得しています…");
    void invoke<{ name: string; id: string }[]>("twitch_fetch_emotes", { channels: twitchChannelsKey ? twitchChannelsKey.split(",") : [] })
      .then((list) => {
        if (learnEmoteNames(list)) setEmoteNameVersion((v) => v + 1);
        if (manual) setEmoteFetchMsg(`${list.length} 件を取得しました`);
      })
      .catch((e) => { console.warn("twitch_fetch_emotes failed", e); if (manual) setEmoteFetchMsg(`取得できませんでした: ${String(e)}`); });
  };
  useEffect(() => {
    if (!isTauriRuntime() || twitchAuth.state !== "connected") return;
    const run = () => fetchTwitchEmotesNow(false);
    run();
    const timer = window.setInterval(run, 3600 * 1000);
    return () => window.clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [twitchAuth.state, twitchChannelsKey]);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<{ mode?: unknown; name?: unknown; mail?: unknown; body?: unknown; subject?: unknown }>("compose-popup-submit", (ev) => {
      void handleComposePopupSubmit(ev.payload ?? {});
    }).then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch((e) => console.warn("compose-popup-submit listen failed", e));
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, []);
  // 書き込みの浮遊ウィンドウが閉じられたら (成功時の自動クローズ・手動クローズいずれも)、
  // 以後の引用は下部パネルへ戻す
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen("compose-popup-closed", () => { composePopupOpenRef.current = false; composePopupTargetRef.current = null; })
      .then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch((e) => console.warn("compose-popup-closed listen failed", e));
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, []);
  // 字幕ヘッダに一時停止状態と残りキュー数を表示
  useEffect(() => {
    if (!isTauriRuntime() || !subtitleVisible) return;
    void invoke("subtitle_status", { paused: arrivalPaused, remaining: arrivalQueueCount }).catch((e) => console.warn("subtitle_status:", e));
  }, [arrivalPaused, arrivalQueueCount, subtitleVisible]);
  // メインのスレ表示。レス表示欄はスレ一覧表示 (activePaneView === "threads") のあいだ DOM から外れ、
  // スレを開くと別の要素として作り直されるため、表示切り替えのたびに監視を付け直す。
  useEffect(() => {
    if (!ogpCardsEnabled && !tweetCardsEnabled) return;
    if (activePaneView !== "responses") return;
    const container = responseScrollRef.current;
    if (!container) return;
    return setupOgpFill(container, ogpCardsEnabled);
  }, [ogpCardsEnabled, tweetCardsEnabled, activePaneView]);
  // ビュワー (表示中のときだけ)
  useEffect(() => {
    if (!viewerCards || activePaneView !== "viewer") return;
    const container = viewerListRef.current;
    if (!container) return;
    return setupOgpFill(container, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerCards, activePaneView]);
  // 【試験】新着レスペイン (arrivalCardsEnabled が ON のときのみ)
  useEffect(() => {
    if (!arrivalCardsEnabled || (!ogpCardsEnabled && !tweetCardsEnabled)) return;
    const container = newArrivalScrollRef.current;
    if (!container) return;
    return setupOgpFill(container, ogpCardsEnabled);
    // 新着レスペインはビュワーでは出さないので、タブの種類が変わったら付け直す
  }, [arrivalCardsEnabled, ogpCardsEnabled, tweetCardsEnabled, newArrivalPaneOpen, activePaneView]);

  // settings.ini に保存する内容 (キー → 文字列)
  const buildAppSettingsMap = (): Record<string, string> => ({
      "App.fontSize": String(responsesFontSize),
      "App.responseGap": String(responseGap),
      "App.autoReloadIntervalSec": String(autoRefreshInterval),
      "App.autoReload": String(autoRefreshEnabled),
      "App.autoScroll": String(autoScrollEnabled),
      "App.smoothScroll": String(smoothScroll),
      "App.maxOpenTabs": String(maxOpenTabs),
      "App.logRetentionDays": String(logRetentionDays),
      "App.twitchSpeakName": String(twitchSpeakName),
      "App.twitchBadges": String(twitchBadgesEnabled),
      "App.twitchEmoteSize": String(twitchEmoteSize),
      "App.twitchGiantEmoteSize": String(twitchGiantEmoteSize),
      "App.twitchEmoteSpeak": twitchEmoteSpeak,
      "App.twitchEmoteMax": String(twitchEmoteMax),
      "App.subtitleEmoteSize": String(subtitleEmoteSize),
      "App.subtitleGiantEmoteSize": String(subtitleGiantEmoteSize),
      "App.boardEmotes": String(boardEmotesEnabled),
      "App.twitchTeach": String(twitchTeachEnabled),
      "App.twitchTeachAnnounce": String(twitchTeachAnnounce),
      "App.overlayEnabled": String(overlayEnabled),
      "App.viewerLatestHeight": String(latestPanelHeight),
      "App.viewerLatestPanel": String(latestPanelOpen),
      "App.viewerFontFamily": viewerFontFamily,
      "App.viewerFontSize": String(viewerFontSize),
      "App.viewerFontBold": String(viewerFontBold),
      "App.viewerCards": String(viewerCards),
      "App.viewerAllResponses": String(viewerAllResponses),
      "App.viewerThumbs": String(viewerThumbs),
      "App.viewerTwitchClickToLoad": String(viewerTwitchClickToLoad),
      ...Object.fromEntries(VIEWER_SHOW_LABELS.map(([k]) => [`App.viewerShow${k[0].toUpperCase()}${k.slice(1)}`, String(viewerShow[k])])),
      ...Object.fromEntries(LATEST_SHOW_LABELS.map(([k]) => [`App.latestShow${k[0].toUpperCase()}${k.slice(1)}`, String(latestShow[k])])),
      "App.overlayPort": String(overlayPort),
      "App.twitchMaxQueuedArrivals": String(twitchMaxQueuedArrivals),
      "App.twitchMaxTtsBacklog": String(twitchMaxTtsBacklog),
      "App.youtubeMethod": youtubeMethod,
      "App.youtubeApiInterval": String(youtubeApiInterval),
      "App.youtubeSpeakName": String(youtubeSpeakName),
      "App.youtubeTargetOn": String(youtubeTargetOn),
      "App.youtubeTargetHours": String(youtubeTargetHours),
      "App.youtubeDailyQuota": String(youtubeDailyQuota),
      "App.youtubeWriteReserve": String(youtubeWriteReserve),
      "App.chatSendConfirm": String(chatSendConfirm),
      "App.tabSiteColors": String(tabSiteColors),
      "App.tabWidthFixed": String(tabWidthFixed),
      "App.boardTabWidth": String(boardTabWidth),
      "App.threadTabWidth": String(threadTabWidth),
      "App.autoUpdateCheck": String(autoUpdateCheck),
      "App.lastUpdateCheck": lastUpdateCheck,
      "App.knownLatestVersion": knownLatestVersion,
      "App.updateNoticeSeen": updateNoticeSeen,
      "App.viewerComposeTarget": viewerComposeTarget,
      "App.webviewCacheMb": String(webviewCacheMb),
      "App.imageSaveFolder": imageSaveFolder,
      "App.bbsmenuUrl": bbsmenuUrl,
      "App.shitarabaHost": shitarabaHost,
      "App.jpnknHost": jpnknHost,
      "App.mainAlwaysOnBottom": String(mainAlwaysOnBottom),
      "App.cssAllowExternalUrls": String(cssAllowExternalUrls),
      "App.streamMaskEnabled": String(streamMaskEnabled),
      "App.ngAboneSpeakEnabled": String(ngAboneSpeakEnabled),
      "Speech.mode": ttsMode,
      "Speech.enabled": String(ttsEnabled),
      "Speech.maxReadLength": String(ttsMaxReadLength),
      "Speech.urlOmit": String(ttsUrlOmitEnabled),
      "Speech.boardMode": ttsBoardMode,
      "Speech.sapiVoiceIndex": String(sapiVoiceIndex),
      "Speech.sapiRate": String(sapiRate),
      "Speech.sapiVolume": String(sapiVolume),
      "Speech.bouyomiPath": bouyomiPath,
      "Speech.voicevoxEndpoint": voicevoxEndpoint,
      "Speech.voicevoxSpeakerId": String(voicevoxSpeakerId),
      "Speech.voicevoxSpeedScale": String(voicevoxSpeedScale),
      "Speech.voicevoxPitchScale": String(voicevoxPitchScale),
      "Speech.voicevoxIntonationScale": String(voicevoxIntonationScale),
      "Speech.voicevoxVolumeScale": String(voicevoxVolumeScale),
      "Posting.name": composeName,
      "Posting.mail": composeMail,
      "Posting.sage": String(composeSage),
      "Posting.fontSize": String(composeFontSize),
      "Posting.composeOpen": String(composeOpen),
  });
  // Save app settings to settings.ini when relevant values change.
  // 設定画面を開いている間は保存しない (「設定を保存」で明示的に保存し、保存せずに閉じたら開いたときの値に戻す)。
  // load_app_settings が終わる前 (起動直後の一瞬) は、まだ既定値のままの state で
  // ファイルを上書きしてしまわないよう appSettingsLoadedRef で待つ
  useEffect(() => {
    if (!isTauriRuntime() || !appSettingsLoadedRef.current || settingsOpenRef.current) return;
    void invoke("save_app_settings", { settings: buildAppSettingsMap() }).catch(() => {});
  }, [responsesFontSize, responseGap, autoRefreshInterval, autoRefreshEnabled, autoScrollEnabled, smoothScroll, maxOpenTabs, logRetentionDays, tabSiteColors, tabWidthFixed, boardTabWidth, threadTabWidth, autoUpdateCheck, lastUpdateCheck, knownLatestVersion, updateNoticeSeen, viewerComposeTarget, webviewCacheMb, overlayEnabled, overlayPort, latestPanelHeight, latestPanelOpen, viewerFontFamily, viewerFontSize, viewerFontBold, viewerShow, latestShow, viewerCards, viewerAllResponses, viewerThumbs, viewerTwitchClickToLoad, twitchSpeakName, twitchBadgesEnabled, twitchEmoteSize, twitchGiantEmoteSize, twitchEmoteSpeak, twitchEmoteMax, subtitleEmoteSize, subtitleGiantEmoteSize, boardEmotesEnabled, twitchTeachEnabled, twitchTeachAnnounce, twitchMaxQueuedArrivals, twitchMaxTtsBacklog, youtubeMethod, youtubeApiInterval, youtubeSpeakName, youtubeTargetOn, youtubeTargetHours, youtubeDailyQuota, youtubeWriteReserve, chatSendConfirm, imageSaveFolder, bbsmenuUrl, shitarabaHost, jpnknHost,
      mainAlwaysOnBottom, cssAllowExternalUrls, streamMaskEnabled, ngAboneSpeakEnabled,
      ttsMode, ttsEnabled, ttsMaxReadLength, ttsUrlOmitEnabled, ttsBoardMode, sapiVoiceIndex, sapiRate, sapiVolume,
      voicevoxEndpoint, voicevoxSpeakerId, voicevoxSpeedScale, voicevoxPitchScale, voicevoxIntonationScale, voicevoxVolumeScale,
      composeName, composeMail, composeSage, composeFontSize, composeOpen]);

  // 棒読みちゃんの実行ファイルパスは、設定画面を開いたまま他のエンジンに切り替えても消えないよう、
  // 「設定を保存」を待たず入力した時点で即座に保存する (NG・辞書・ハイライトの登録と同じ扱い)
  useEffect(() => {
    if (!isTauriRuntime() || !appSettingsLoadedRef.current) return;
    void invoke("save_app_settings", { settings: buildAppSettingsMap() }).catch(() => {});
  }, [bouyomiPath]);

  // layout_prefs.json に保存する内容
  const buildLayoutPrefsPayload = (): Record<string, unknown> => ({
      boardPaneVisible,
      boardPanePx,
      threadPanePx,
      responseTopRatio,
      boardsFontSize,
      threadsFontSize,
      responsesFontSize,
      responsesHeaderFontSize,
      darkMode,
      fontFamily,
      fontBold,
      threadColWidths,
      showBoardButtons,
      keepSortOnRefresh,
      composeSubmitKey,
      imageSizeLimit,
      showImagePreview,
      hoverPreviewEnabled,
      ogpCardsEnabled,
      tweetCardsEnabled,
      arrivalCardsEnabled,
      subtitleCardsEnabled,
      arrivalTiming,
      subtitleTiming,
      subtitleSyncEnabled,
      mainHeaderVis,
      arrivalHeaderVis,
      subtitleHeaderVis,
      responseDividerAlways,
      settingsSearchHistory,
      lastBoard: lastBoardUrlRef.current ? { boardName: selectedBoard, url: lastBoardUrlRef.current } : undefined,
      hoverPreviewDelay,
      thumbSize,
      restoreSession,
      autoRefreshInterval,
      autoScrollEnabled,
      newArrivalPaneOpen,
      newArrivalPaneHeight,
      newArrivalFontSize,
      resIdFontSize,
      resIdFontFamily,
      newArrivalIdFontSize,
      newArrivalIdFontFamily,
      subtitleIdFontSize,
      subtitleIdFontFamily,
      popupFontSize,
      popupMaxWidth,
      popupMaxHeight,
      composePanelPx,
      subtitleBodyFontSize,
      subtitleMetaFontSize,
      subtitleOpacity,
      subtitleTextShadow,
      subtitleFrameMode,
      subtitleAlwaysOnTop,
  });
  useEffect(() => {
    if (!layoutPrefsLoadedRef.current || settingsOpenRef.current) return;
    if (isTauriRuntime()) {
      void invoke("save_layout_prefs", { prefs: JSON.stringify(buildLayoutPrefsPayload()) }).catch(() => {});
    }
  }, [boardPaneVisible, boardPanePx, threadPanePx, responseTopRatio, boardsFontSize, threadsFontSize, responsesFontSize, responsesHeaderFontSize, darkMode, fontFamily, fontBold, threadColWidths, showBoardButtons, keepSortOnRefresh, composeSubmitKey, imageSizeLimit, showImagePreview, hoverPreviewEnabled, ogpCardsEnabled, tweetCardsEnabled, arrivalCardsEnabled, subtitleCardsEnabled, arrivalTiming, subtitleTiming, subtitleSyncEnabled, mainHeaderVis, arrivalHeaderVis, subtitleHeaderVis, responseDividerAlways, settingsSearchHistory, selectedBoard, hoverPreviewDelay, thumbSize, restoreSession, autoRefreshInterval, autoScrollEnabled, newArrivalPaneOpen, newArrivalPaneHeight, newArrivalFontSize, resIdFontSize, resIdFontFamily, newArrivalIdFontSize, newArrivalIdFontFamily, subtitleIdFontSize, subtitleIdFontFamily, popupFontSize, popupMaxWidth, popupMaxHeight, composePanelPx, subtitleBodyFontSize, subtitleMetaFontSize, subtitleOpacity, subtitleTextShadow, subtitleFrameMode, subtitleAlwaysOnTop]);

  // ===== 設定画面の保存 / 復元 / リセット / プリセット =====
  // 値の設定は変更した時点で画面に反映される (プレビュー) が、ファイルへの保存は「設定を保存」を押したときだけ行う。
  // 開いたときの値をスナップショットとして持ち、「保存しない」で閉じるときはそれに戻す。
  // NG・辞書・ハイライト・許可リストなどの登録内容はこれまでどおり登録した時点で保存される。
  const stripVolatilePrefs = (o: Record<string, unknown>): Record<string, unknown> => {
    const copy = { ...o };
    delete copy.settingsSearchHistory; // 検索履歴と最後に開いた板は「設定の変更」とみなさない
    delete copy.lastBoard;
    return copy;
  };
  // 棒読みちゃんの実行ファイルパスは入力した時点で即座に保存されるため (上の useEffect)、
  // 「未保存の変更」の判定にも「保存しないで閉じる」の復元対象にも含めない
  const stripVolatileAppSettings = (o: Record<string, string>): Record<string, string> => {
    const copy = { ...o };
    delete copy["Speech.bouyomiPath"];
    return copy;
  };
  const settingsDirty = settingsOpen && settingsSnapshot !== null && (
    JSON.stringify(stripVolatilePrefs(buildLayoutPrefsPayload())) !== JSON.stringify(stripVolatilePrefs(settingsSnapshot.layout))
    || JSON.stringify(stripVolatileAppSettings(buildAppSettingsMap())) !== JSON.stringify(stripVolatileAppSettings(settingsSnapshot.app))
  );
  useEffect(() => {
    if (settingsOpen) setSettingsSnapshot({ layout: buildLayoutPrefsPayload(), app: buildAppSettingsMap() });
    else setSettingsSnapshot(null);
  }, [settingsOpen]);
  const persistSettingsNow = (layoutObj?: Record<string, unknown>, appMap?: Record<string, string>) => {
    const layout = layoutObj ?? buildLayoutPrefsPayload();
    const app = appMap ?? buildAppSettingsMap();
    if (isTauriRuntime()) {
      void invoke("save_layout_prefs", { prefs: JSON.stringify(layout) }).catch((e) => console.warn("save_layout_prefs failed", e));
      void invoke("save_app_settings", { settings: app }).catch((e) => console.warn("save_app_settings failed", e));
    }
    setSettingsSnapshot({ layout, app });
  };
  const settingsBackupName = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };
  const formatBackupName = (name: string) => {
    const m = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
    return m ? `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}:${m[6]}` : name;
  };
  const formatUnixTime = (sec: number) => {
    if (!sec) return "";
    const d = new Date(sec * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  // プリセット / バックアップのファイル内容。lists (登録内容) はバックアップにだけ含める
  const buildSettingsBundle = (layout: Record<string, unknown>, app: Record<string, string>, includeLists: boolean) => ({
    version: 1,
    savedAt: new Date().toISOString(),
    layout: stripVolatilePrefs(layout),
    app,
    ...(includeLists ? { lists: { ngFilters, idHighlights, textHighlights, ttsDictEntries, ttsIpAllow, ttsMuteDict, ogpDomainFilters } } : {}),
  });
  const [settingsPresets, setSettingsPresets] = useState<{ name: string; savedAt: number }[]>([]);
  const [settingsBackups, setSettingsBackups] = useState<{ name: string; savedAt: number }[]>([]);
  const [presetNameInput, setPresetNameInput] = useState("");
  const [resetIncludeLists, setResetIncludeLists] = useState(false);
  const refreshSettingsFiles = async () => {
    if (!isTauriRuntime()) return;
    try {
      const [p, b] = await Promise.all([
        invoke<{ name: string; savedAt: number }[]>("list_settings_presets"),
        invoke<{ name: string; savedAt: number }[]>("list_settings_backups"),
      ]);
      setSettingsPresets(p);
      setSettingsBackups(b);
    } catch (e) { console.warn("list settings files failed", e); }
  };
  useEffect(() => {
    if (settingsOpen && (settingsCategory === "presets" || settingsCategory === "reset")) void refreshSettingsFiles();
  }, [settingsOpen, settingsCategory]);
  // 「設定を保存」の前とリセットの前の自動バックアップ (登録内容も含む。Rust 側で最新 20 件に整理)
  const createSettingsBackup = async (layout: Record<string, unknown>, app: Record<string, string>) => {
    if (!isTauriRuntime()) return;
    try {
      await invoke("save_settings_backup", { name: settingsBackupName(), json: JSON.stringify(buildSettingsBundle(layout, app, true)) });
    } catch (e) { console.warn("save_settings_backup failed", e); }
  };
  const saveSettingsNow = async () => {
    const prev = settingsSnapshot;
    if (prev) await createSettingsBackup(prev.layout, prev.app);
    persistSettingsNow();
    setStatus("設定を保存しました");
    if (settingsCategory === "presets" || settingsCategory === "reset") void refreshSettingsFiles();
  };
  const discardSettingsChanges = () => {
    const snap = settingsSnapshot;
    if (!snap) return;
    // 棒読みちゃんパスは即時保存済みなので、スナップショットの値で巻き戻さない (現在値を維持)
    applyAppSettings({ ...snap.app, "Speech.bouyomiPath": bouyomiPath });
    applyLayoutPrefs(JSON.stringify({ ...snap.layout, settingsSearchHistory }));
  };
  const requestCloseSettings = () => {
    if (!settingsDirty) {
      // 検索履歴など「変更」扱いしない項目を書き出しておく
      persistSettingsNow();
      setSettingsOpen(false);
      return;
    }
    setAppConfirm({
      title: "設定が保存されていません",
      message: "変更した設定を保存しますか？\n「保存しない」を選ぶと、開いたときの値に戻ります。",
      buttons: [
        { label: "保存して閉じる", primary: true, onClick: () => { void saveSettingsNow(); setSettingsOpen(false); } },
        { label: "保存しないで閉じる", danger: true, onClick: () => { discardSettingsChanges(); setSettingsOpen(false); } },
        { label: "キャンセル", onClick: () => {} },
      ],
    });
  };
  const switchSettingsCategory = (cat: SettingsCategory) => {
    setSettingsCategory(cat); setSettingsSection(""); setSettingsListFilter(""); setSettingsQuery("");
  };
  const requestSwitchSettingsCategory = (cat: SettingsCategory) => {
    if (cat === settingsCategory) return;
    if (!settingsDirty) { switchSettingsCategory(cat); return; }
    setAppConfirm({
      title: "設定が保存されていません",
      message: "変更した設定を保存してから移動しますか？\n「保存しない」を選ぶと、開いたときの値に戻ります。",
      buttons: [
        { label: "保存して移動", primary: true, onClick: () => { void saveSettingsNow(); switchSettingsCategory(cat); } },
        { label: "保存しないで移動", danger: true, onClick: () => { discardSettingsChanges(); switchSettingsCategory(cat); } },
        { label: "キャンセル", onClick: () => {} },
      ],
    });
  };
  const isStringMap = (v: unknown): v is Record<string, string> =>
    !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === "string");
  // プリセット / バックアップの内容を反映してそのまま保存する (登録内容は withLists のときだけ)
  const applySettingsBundle = (raw: string, withLists: boolean): boolean => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return false; }
    if (!parsed || typeof parsed !== "object") return false;
    const b = parsed as { layout?: unknown; app?: unknown; lists?: unknown };
    const layoutIn = b.layout && typeof b.layout === "object" && !Array.isArray(b.layout) ? (b.layout as Record<string, unknown>) : {};
    const appIn = isStringMap(b.app) ? b.app : {};
    const layout = { ...buildLayoutPrefsPayload(), ...stripVolatilePrefs(layoutIn), settingsSearchHistory };
    const app = { ...buildAppSettingsMap(), ...appIn };
    applyAppSettings(app);
    applyLayoutPrefs(JSON.stringify(layout));
    persistSettingsNow(layout, app);
    if (withLists && b.lists && typeof b.lists === "object") {
      const l = b.lists as Record<string, unknown>;
      const ng = l.ngFilters as Partial<NgFilters> | undefined;
      if (ng && typeof ng === "object") {
        void persistNgFilters({
          words: Array.isArray(ng.words) ? ng.words : [],
          ids: Array.isArray(ng.ids) ? ng.ids : [],
          names: Array.isArray(ng.names) ? ng.names : [],
          mails: Array.isArray(ng.mails) ? ng.mails : [],
          thread_words: Array.isArray(ng.thread_words) ? ng.thread_words : [],
          image_words: Array.isArray(ng.image_words) ? ng.image_words : [],
          invisible: normalizeInvisibleMode(ng.invisible),
        });
      }
      if (isStringMap(l.idHighlights)) persistIdHighlights(l.idHighlights);
      if (Array.isArray(l.textHighlights)) {
        persistTextHighlights(l.textHighlights.filter((h): h is TextHighlight =>
          !!h && typeof h === "object" && typeof (h as TextHighlight).pattern === "string" && typeof (h as TextHighlight).color === "string"
          && ((h as TextHighlight).type === "word" || (h as TextHighlight).type === "name")));
      }
      if (Array.isArray(l.ttsDictEntries)) {
        setTtsDictEntries(l.ttsDictEntries.filter((e): e is TtsDictEntry => !!e && typeof e === "object" && typeof (e as TtsDictEntry).from === "string" && typeof (e as TtsDictEntry).to === "string"));
      }
      if (Array.isArray(l.ttsIpAllow)) {
        setTtsIpAllow(l.ttsIpAllow.filter((e): e is TtsIpAllowEntry => !!e && typeof e === "object" && typeof (e as TtsIpAllowEntry).host === "string" && typeof (e as TtsIpAllowEntry).to === "string"));
      }
      const mute = l.ttsMuteDict as Partial<TtsMuteDict> | undefined;
      if (mute && typeof mute === "object") {
        setTtsMuteDict({ names: Array.isArray(mute.names) ? mute.names : [], words: Array.isArray(mute.words) ? mute.words : [], ids: Array.isArray(mute.ids) ? mute.ids : [] });
      }
      const f = l.ogpDomainFilters as Partial<OgpDomainFilters> | undefined;
      if (f && typeof f === "object") {
        persistOgpDomainFilters({
          allow: Array.isArray(f.allow) ? f.allow.filter((x): x is string => typeof x === "string") : [],
          block: Array.isArray(f.block) ? f.block.filter((x): x is string => typeof x === "string") : [],
        });
      }
    }
    return true;
  };
  const resetSettingsToDefaults = async () => {
    const defaults = defaultLayoutPrefsRef.current;
    const defaultsApp = defaultAppSettingsRef.current;
    if (!defaults || !defaultsApp) return;
    const snap = settingsSnapshot;
    await createSettingsBackup(snap?.layout ?? buildLayoutPrefsPayload(), snap?.app ?? buildAppSettingsMap());
    const layout = { ...buildLayoutPrefsPayload(), ...stripVolatilePrefs(defaults), settingsSearchHistory: [] as string[] };
    applyAppSettings(defaultsApp);
    applyLayoutPrefs(JSON.stringify(layout));
    persistSettingsNow(layout, defaultsApp);
    if (resetIncludeLists) {
      void persistNgFilters({ words: [], ids: [], names: [], mails: [], thread_words: [], image_words: [], invisible: "off" });
      persistIdHighlights({});
      persistTextHighlights([]);
      setTtsDictEntries(DEFAULT_TTS_DICT);
      setTtsIpAllow(DEFAULT_TTS_IP_ALLOW);
      setTtsMuteDict({ names: [], words: [], ids: [] });
      persistOgpDomainFilters({ allow: [], block: [] });
    }
    setStatus("設定を初期値に戻しました (直前の設定は自動バックアップに保存)");
    void refreshSettingsFiles();
  };
  useEffect(() => { if (isTauriRuntime()) invoke("main_set_always_on_bottom", { enabled: mainAlwaysOnBottom }).catch((e) => console.warn("main_set_always_on_bottom:", e)); }, [mainAlwaysOnBottom]);
  // 字幕ウィンドウへの反映は state から行う (onChange では送らない)。「保存しない」で値が戻ったときも自動で反映される
  useEffect(() => { if (isTauriRuntime() && subtitleVisibleRef.current) invoke("subtitle_font_size", { size: subtitleBodyFontSize }).catch((e) => console.warn("subtitle_font_size:", e)); }, [subtitleBodyFontSize]);
  useEffect(() => { if (isTauriRuntime() && subtitleVisibleRef.current) invoke("subtitle_meta_font_size", { size: subtitleMetaFontSize }).catch((e) => console.warn("subtitle_meta_font_size:", e)); }, [subtitleMetaFontSize]);
  useEffect(() => { if (isTauriRuntime() && subtitleVisibleRef.current) invoke("subtitle_opacity", { opacity: subtitleOpacity }).catch((e) => console.warn("subtitle_opacity:", e)); }, [subtitleOpacity]);
  useEffect(() => { if (isTauriRuntime() && subtitleVisibleRef.current) invoke("subtitle_text_shadow", { enabled: subtitleTextShadow }).catch((e) => console.warn("subtitle_text_shadow:", e)); }, [subtitleTextShadow]);
  useEffect(() => { if (isTauriRuntime() && subtitleVisibleRef.current) invoke("subtitle_frame", { mode: subtitleFrameMode }).catch((e) => console.warn("subtitle_frame:", e)); }, [subtitleFrameMode]);
  const openSubtitleFrameSettingsRef = useRef<() => void>(() => {});
  openSubtitleFrameSettingsRef.current = () => { setSettingsOpen(true); switchSettingsCategory("subtitle"); setSettingsSection("frame"); };
  // 字幕ウィンドウの大きさ: 起動時に覚えている値を読み、手で変えたときは知らせを受けて合わせる
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void invoke<[number, number]>("subtitle_get_size").then((v) => { if (!disposed && Array.isArray(v)) setSubtitleWinSize({ width: Math.round(v[0]), height: Math.round(v[1]) }); }).catch((e) => console.warn("subtitle_get_size:", e));
    void listen<{ width?: unknown; height?: unknown }>("subtitle-size", (ev) => {
      const w = Number(ev.payload?.width), hgt = Number(ev.payload?.height);
      if (Number.isFinite(w) && Number.isFinite(hgt)) setSubtitleWinSize({ width: Math.round(w), height: Math.round(hgt) });
    }).then((u) => { if (disposed) u(); else unlisten = u; }).catch((e) => console.warn("subtitle-size listen failed", e));
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const applySubtitleSize = () => {
    const w = Math.round(Number(subtitleSizeInput.width || subtitleWinSize.width));
    const hgt = Math.round(Number(subtitleSizeInput.height || subtitleWinSize.height));
    if (!Number.isFinite(w) || !Number.isFinite(hgt) || w < 120 || w > 10000 || hgt < 40 || hgt > 10000) { setSubtitleSizeMsg("幅は 120〜10000、高さは 40〜10000 の数で入れてください"); return; }
    setSubtitleSizeMsg("");
    void invoke("subtitle_set_size", { width: w, height: hgt })
      .then(() => { setSubtitleWinSize({ width: w, height: hgt }); setSubtitleSizeInput({ width: "", height: "" }); })
      .catch((e) => setSubtitleSizeMsg(String(e)));
  };
  useEffect(() => { if (isTauriRuntime() && subtitleVisibleRef.current) invoke("subtitle_topmost", { enabled: subtitleAlwaysOnTop }).catch((e) => console.warn("subtitle_topmost:", e)); }, [subtitleAlwaysOnTop]);
  useEffect(() => { if (isTauriRuntime() && subtitleVisibleRef.current) invoke("subtitle_id_font_size", { size: subtitleIdFontSize }).catch((e) => console.warn("subtitle_id_font_size:", e)); }, [subtitleIdFontSize]);
  useEffect(() => { if (isTauriRuntime() && subtitleVisibleRef.current) invoke("subtitle_id_font_family", { family: subtitleIdFontFamily }).catch((e) => console.warn("subtitle_id_font_family:", e)); }, [subtitleIdFontFamily]);


  useEffect(() => {
    if (isTauriRuntime()) {
      invoke("set_window_theme", { dark: darkMode }).catch(() => {});
    }
    // 書き込みの浮遊ウィンドウが開いている間にライト/ダークを切り替えた場合も、
    // その場で基本配色を追従させる
    if (isTauriRuntime() && composePopupOpenRef.current) {
      invoke("compose_popup_update", { data: { darkMode } }).catch(() => {});
    }
  }, [darkMode]);

  useEffect(() => {
    if (suppressThreadScrollRef.current) {
      suppressThreadScrollRef.current = false;
      return;
    }
    if (selectedThread == null || !threadTbodyRef.current) return;
    const row = threadTbodyRef.current.querySelector<HTMLTableRowElement>(".selected-row");
    row?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [selectedThread]);

  useEffect(() => {
    if (suppressResponseSelScrollRef.current) {
      suppressResponseSelScrollRef.current = false;
      return;
    }
    if (!responseScrollRef.current) return;
    const block = responseScrollRef.current.querySelector<HTMLDivElement>(".response-block.selected");
    block?.scrollIntoView({ block: "nearest", behavior: smoothScrollRef.current ? "smooth" : "instant" });
  }, [selectedResponse]);

  useEffect(() => {
    if (activeTabIndex < 0 || !tabBarRef.current) return;
    const tab = tabBarRef.current.children[activeTabIndex] as HTMLElement | undefined;
    tab?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }, [activeTabIndex]);

  useEffect(() => {
    if (!autoRefreshEnabled || !isTauriRuntime()) return;
    const id = setInterval(() => {
      // Fetch active tab responses (with UI update)
      void fetchResponsesFromCurrent(undefined, { keepSelection: true });
      // Fetch all background tabs silently
      const activeUrl = threadTabs[activeTabIndex]?.threadUrl;
      for (const tab of threadTabs) {
        if (tab.threadUrl !== activeUrl) {
          void fetchBackgroundTabResponses(tab.threadUrl, tab.title);
        }
      }
      void refreshThreadListSilently();
    }, autoRefreshInterval * 1000);
    return () => clearInterval(id);
  }, [autoRefreshEnabled, autoRefreshInterval, threadUrl, threadTabs, activeTabIndex]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    invoke<string[]>("list_system_fonts").then(setSystemFonts).catch(() => {});
  }, []);

  return (
    <div
      className={`shell${darkMode ? " dark" : ""}`}
      style={{ fontFamily: fontFamily ? `"${fontFamily}", "Emoji", sans-serif` : undefined, fontWeight: fontBold ? "bold" : undefined, gridTemplateRows: showBoardButtons && favorites.boards.length > 0 ? "26px 32px auto 1fr 22px" : undefined, "--thumb-size": `${thumbSize}px` } as React.CSSProperties}
      onClick={() => {
        setThreadMenu(null);
        setResponseMenu(null);
        setLinkMenu(null);
        setViewerMenu(null);
        setHlSubMenu(null);
        setTabMenu(null);
        setOpenMenu(null);
        setIdPopup(null);
        setBackRefPopup(null);
        setNestedPopups([]);
        setWatchoiMenu(null);
        setIdMenu(null);
        setBeMenu(null);
        setBoardContextMenu(null);
        setAddressMenu(null);
        setSearchHistoryDropdown(null);
        setSearchHistoryMenu(null);
        setResponseReloadMenuOpen(false);
        setSearchModeMenuOpen(false);
      }}
    >
      <header className="menu-bar">
        {[
          { label: "ファイル", items: [
            { text: "書き込み", action: () => { setComposeOpen(true); setComposeBody(""); setComposeResult(null); } },
            { text: "書き込み履歴", action: () => setPostHistoryOpen(true) },
            ...(navigator.userAgent.includes("Windows") ? [
              { text: "sep" },
              { text: "終了", action: () => { if (isTauriRuntime()) { void invoke("quit_app"); } } },
            ] : []),
          ]},
          { label: "編集", items: [
            { text: "スレURLをコピー", action: () => {
              const url = threadTabs[activeTabIndex]?.threadUrl;
              if (!url) { setStatus("スレのタブが開かれていません"); return; }
              void navigator.clipboard.writeText(url);
              setStatus("スレURLをコピーしました");
            } },
          ]},
          { label: "表示", items: [
            { text: `文字サイズ (${paneLabel(focusedPane)}): ${paneFontSize(focusedPane)[0]}px`, label: true },
            { text: "文字サイズ拡大", action: () => paneFontSize(focusedPane)[1]((v) => Math.min(v + 1, 20)) },
            { text: "文字サイズ縮小", action: () => paneFontSize(focusedPane)[1]((v) => Math.max(v - 1, 8)) },
            { text: "文字サイズリセット", action: () => paneFontSize(focusedPane)[1](12) },
            { text: "全ペインリセット", action: () => { setBoardsFontSize(12); setThreadsFontSize(12); setResponsesFontSize(12); } },
            { text: "sep" },
            { text: "レイアウトリセット", action: () => resetLayout() },
            { text: "sep" },
            { text: darkMode ? "ライトテーマ" : "ダークテーマ", action: () => setDarkMode((v) => !v) },
            { text: "sep" },
            { text: boardPaneVisible ? "板一覧を非表示" : "板一覧を表示", action: () => setBoardPaneVisible((v) => !v) },
            { text: showBoardButtons ? "板ボタンを非表示" : "板ボタンを表示", action: () => setShowBoardButtons((v) => !v) },
          ]},
          { label: "板", items: [
            { text: "板一覧を取得", action: () => { void fetchMenu(); void fetchBoardCategories(); } },
            { text: "sep" },
            { text: "板一覧タブ", action: () => setBoardPaneTab("boards") },
            { text: "お気に入りタブ", action: () => setBoardPaneTab("fav-threads") },
          ]},
          { label: "スレッド", items: [
            { text: "すべてのタブを閉じる", action: closeAllTabs },
          ]},
          { label: "設定", items: [
            { text: "設定を開く", action: () => setSettingsOpen(true) },
            { text: "ユーザーCSSを再読み込み", action: () => {
              void applyUserCss().then((ok) => {
                if (ok) setStatus("ユーザーCSS (custom.css / theme) を再読み込みしました");
                else setStatus("ユーザーCSSの読み込みに失敗しました");
              });
              void invoke("refresh_window_css").catch((e) => console.warn("refresh_window_css failed", e));
            } },
          ]},
          { label: "ヘルプ", items: [
            { text: updateAvailable ? "バージョン情報 (新しいバージョンがあります)" : "バージョン情報", action: () => requestAnimationFrame(() => { setAboutOpen(true); void checkForUpdates(); }) },
          ]},
        ].map(({ label, items }) => (
          <div key={label} className="menu-item-wrap" onClick={(e) => e.stopPropagation()}>
            <span
              className={`menu-item ${openMenu === label ? "menu-item-active" : ""}`}
              onClick={() => setOpenMenu(openMenu === label ? null : label)}
              onMouseEnter={() => { if (openMenu) setOpenMenu(label); }}
            >
              {label}
              {label === "ヘルプ" && updateAvailable && <span className="menu-badge" title="新しいバージョンがあります">●</span>}
            </span>
            {openMenu === label && (
              <div className="menu-dropdown">
                {items.map((item: { text: string; action?: () => void; label?: boolean }, i) =>
                  item.text === "sep" ? (
                    <div key={i} className="menu-sep" />
                  ) : item.label ? (
                    <div key={item.text} className="menu-label">{item.text}</div>
                  ) : (
                    <button
                      key={item.text}
                      onClick={() => { item.action?.(); setOpenMenu(null); }}
                    >
                      {item.text}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </header>
      <div className="tool-bar">
        <button onClick={() => setBoardPaneVisible((v) => !v)} title={boardPaneVisible ? "板一覧を非表示" : "板一覧を表示"}>
          {boardPaneVisible ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
        </button>
        <button onClick={() => { void fetchMenu(); void fetchBoardCategories(); }} title="板更新"><ClipboardList size={14} /></button>
        <span className="tool-sep" />
        <input
          ref={addressInputRef}
          className="address-input"
          value={locationInput}
          onChange={(e) => setLocationInput(e.target.value)}
          onKeyDown={onLocationInputKeyDown}
          onFocus={(e) => e.target.select()}
          onContextMenu={(e) => { e.preventDefault(); const p = { x: e.clientX, y: e.clientY }; setAddressMenu({ x: p.x, y: p.y }); }}
        />
        <button onClick={goFromLocationInput}>移動</button>
        <span className="tool-sep" />
        <label className="auto-refresh-toggle">
          <input
            type="checkbox"
            checked={autoRefreshEnabled}
            onChange={(e) => setAutoRefreshEnabled(e.target.checked)}
          />
          自動更新
        </label>
        <button onClick={() => setNgPanelOpen((v) => !v)}>NG</button>
        <span className="tool-sep" />
        {/* 掲示板の新着の読み上げ方 (どのタブでも切り替えられる。設定 > 読み上げ と同じもの) */}
        <label className="tts-board-mode" title="掲示板の新着レスの読み上げ方 (設定 > 読み上げ と同じもの)。「レス番のみ」では、配信ホワイトリストの ID のレスは本文まで、それ以外は「レスN番さん」「したらばN番さん」「ジャパンくんN番さん」と番号だけを読みます。Twitch・YouTube のチャットには関係しません">
          読み上げ:
          <select value={ttsBoardMode} onChange={(e) => setTtsBoardMode(e.target.value === "whitelist" ? "whitelist" : "full")}>
            <option value="full">全文</option>
            <option value="whitelist">レス番のみ</option>
          </select>
        </label>
        <span className="tool-sep" />
        {/* 新着レスの操作 (新着レスペインの開閉はここだけ。ビュワーでは新着レスペインを出さない) */}
        <span className="arrival-tools">
          <button title="次の新着レスを表示" onClick={() => {
            arrivalPausedRef.current = false;
            setArrivalPaused(false);
            advanceToNextArrival();
          }}>▶</button>
          <button
            className={subtitleVisible ? "active" : ""}
            title={subtitleVisible ? "字幕ウィンドウを閉じる" : "字幕ウィンドウを開く"}
            onClick={() => {
              if (!subtitleVisible) {
                setSubtitleVisible(true);
                if (isTauriRuntime()) invoke("subtitle_show").then(() => {
                  setTimeout(() => {
                    invoke("subtitle_opacity", { opacity: subtitleOpacity }).catch(() => {});
                    invoke("subtitle_text_shadow", { enabled: subtitleTextShadow }).catch((e) => console.warn("subtitle_text_shadow:", e));
                    invoke("subtitle_frame", { mode: subtitleFrameMode }).catch((e) => console.warn("subtitle_frame:", e));
                    invoke("subtitle_font_size", { size: subtitleBodyFontSize }).catch(() => {});
                    invoke("subtitle_meta_font_size", { size: subtitleMetaFontSize }).catch(() => {});
                    invoke("subtitle_topmost", { enabled: subtitleAlwaysOnTop }).catch(() => {});
                    invoke("subtitle_id_font_size", { size: subtitleIdFontSize }).catch(() => {});
                    if (subtitleIdFontFamily) invoke("subtitle_id_font_family", { family: subtitleIdFontFamily }).catch(() => {});
                  }, 400);
                }).catch((e) => console.warn("subtitle_show:", e));
              } else {
                setSubtitleVisible(false);
                if (isTauriRuntime()) invoke("subtitle_hide").catch((e) => console.warn("subtitle_hide:", e));
              }
            }}
          ><Subtitles size={14} /></button>
          <button onClick={() => {
            arrivalQueueRef.current = [];
            setArrivalQueueCount(0);
            arrivalPausedRef.current = false;
            setArrivalPaused(false);
            if (arrivalTimerRef.current) { clearTimeout(arrivalTimerRef.current); arrivalTimerRef.current = null; }
            currentArrivalItemRef.current = null;
            setCurrentArrivalItem(null);
          }} title="新着レスの待ち行列と表示中のレスを消す"><X size={13} />クリア</button>
          <button
            className={`arrival-pane-toggle${(activePaneView === "viewer" ? latestPanelOpen : newArrivalPaneOpen) ? " active" : ""}`}
            onClick={() => { if (activePaneView === "viewer") setLatestPanelOpen((v) => !v); else setNewArrivalPaneOpen((v) => !v); }}
            title={activePaneView === "viewer"
              ? (latestPanelOpen ? "スレの最新レスの欄を閉じる" : "スレの最新レスの欄を開く (ビュワーでは、新着レスペインの場所に出します)")
              : (newArrivalPaneOpen ? "新着レスペインを閉じる" : "新着レスペインを開く")}
          >{(activePaneView === "viewer" ? latestPanelOpen : newArrivalPaneOpen) ? <ChevronDown size={13} /> : <ChevronUp size={13} />}新着レス</button>
        </span>
      </div>
      {showBoardButtons && favorites.boards.length > 0 && (
        <div className="board-button-bar" ref={boardBtnBarRef}>
          {favorites.boards.map((b, i) => (
            <button
              key={b.url}
              className={`board-btn${selectedBoard === b.boardName ? " selected" : ""}${boardBtnDragIndex !== null && boardBtnDragIndex !== i ? " board-btn-drop-target" : ""}`}
              onClick={() => { if (boardBtnDragRef.current) return; selectBoard(b); }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                boardBtnDragRef.current = { srcIndex: i, startX: e.clientX };
                boardBtnDragOverRef.current = null;
                const onMove = (ev: MouseEvent) => {
                  if (!boardBtnDragRef.current) return;
                  if (Math.abs(ev.clientX - boardBtnDragRef.current.startX) < 5) return;
                  ev.preventDefault();
                  window.getSelection()?.removeAllRanges();
                  setBoardBtnDragIndex(boardBtnDragRef.current.srcIndex);
                  const els = boardBtnBarRef.current?.querySelectorAll<HTMLElement>(".board-btn");
                  if (!els) return;
                  els.forEach((el) => el.classList.remove("board-btn-drag-over"));
                  for (let j = 0; j < els.length; j++) {
                    const rect = els[j].getBoundingClientRect();
                    if (ev.clientX >= rect.left && ev.clientX < rect.right) {
                      if (j !== boardBtnDragRef.current.srcIndex) {
                        els[j].classList.add("board-btn-drag-over");
                        boardBtnDragOverRef.current = j;
                      }
                      break;
                    }
                  }
                };
                const onUp = () => {
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                  const src = boardBtnDragRef.current?.srcIndex ?? null;
                  const dst = boardBtnDragOverRef.current;
                  boardBtnDragRef.current = null;
                  boardBtnDragOverRef.current = null;
                  setBoardBtnDragIndex(null);
                  boardBtnBarRef.current?.querySelectorAll<HTMLElement>(".board-btn-drag-over").forEach((el) => el.classList.remove("board-btn-drag-over"));
                  if (src === null || dst === null || src === dst) return;
                  setFavorites((prev) => {
                    const next = [...prev.boards];
                    const [moved] = next.splice(src, 1);
                    next.splice(dst, 0, moved);
                    const updated = { ...prev, boards: next };
                    void persistFavorites(updated);
                    return updated;
                  });
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
              title={b.boardName}
            >
              {b.boardName.length > 8 ? b.boardName.slice(0, 8) + "…" : b.boardName}
            </button>
          ))}
        </div>
      )}
      <main className="layout">
        {boardPaneVisible && <section className="pane boards" onMouseDown={() => setFocusedPane("boards")} style={{ '--fs-delta': `${boardsFontSize - 12}px`, width: boardPanePx, maxWidth: `calc(100% - ${MIN_RESPONSE_PANE_PX + SPLITTER_PX}px)`, flexShrink: 0 } as React.CSSProperties}>
          <div className="boards-header">
            <div className="board-tabs">
              <button
                className={`board-tab ${boardPaneTab === "boards" ? "active" : ""}`}
                onClick={() => setBoardPaneTab("boards")}
              >
                板一覧
              </button>
              <button
                className={`board-tab ${boardPaneTab === "fav-threads" ? "active" : ""}`}
                onClick={() => setBoardPaneTab("fav-threads")}
              >
                お気に入り ({favorites.threads.length})
              </button>
            </div>
            {boardPaneTab === "boards" && (
              <button className="boards-fetch" onClick={fetchBoardCategories}>取得</button>
            )}
          </div>
          {boardPaneTab === "boards" && (
            <>
            <input
              className="board-search"
              value={boardSearchQuery}
              onChange={(e) => setBoardSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") recordInputHistory("boardSearch", boardSearchQuery); }}
              onBlur={() => recordInputHistory("boardSearch", boardSearchQuery)}
              list="input-history-boardSearch"
              placeholder="板を検索..."
            />
            {inputHistoryDatalist("boardSearch")}
            <button className="external-board-add-btn" onClick={() => setShowExternalBoardDialog(true)} title="外部板を追加">+ 外部板</button>
            </>
          )}
          {boardPaneTab === "boards" ? (
            boardCategories.length > 0 || externalBoards.length > 0 ? (
              <div className="board-tree" ref={boardTreeRef} onScroll={onBoardTreeScroll}>
                {externalBoards.length > 0 && !boardSearchQuery.trim() && (
                  <div className="board-category">
                    <button
                      className="category-toggle external-category"
                      onClick={() => toggleCategory("__external__")}
                    >
                      <span className="category-arrow">{expandedCategories.has("__external__") ? "\u25BC" : "\u25B6"}</span>
                      外部板 ({externalBoards.length})
                    </button>
                    {expandedCategories.has("__external__") && (
                      <ul className="category-boards">
                        {externalBoards.map((b) => (
                          <li key={b.url}>
                            <button
                              className={`board-item ${selectedBoard === b.boardName ? "selected" : ""}`}
                              onClick={() => selectBoard(b)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                const p = { x: e.clientX, y: e.clientY };
                                setBoardContextMenu({ x: p.x, y: p.y, board: b });
                              }}
                              title={b.url}
                            >
                              <span
                                className={`fav-star ${isFavoriteBoard(b.url) ? "active" : ""}`}
                                onClick={(ev) => { ev.stopPropagation(); toggleFavoriteBoard(b); }}
                              >
                                <Star size={12} fill={isFavoriteBoard(b.url) ? "currentColor" : "none"} />
                              </span>
                              {b.boardName}
                              <span className="external-board-remove" title="削除" onClick={(ev) => { ev.stopPropagation(); removeExternalBoard(b.url); }}>&times;</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {favorites.boards.length > 0 && !boardSearchQuery.trim() && (
                  <div className="board-category">
                    <button
                      className="category-toggle fav-category"
                      onClick={() => toggleCategory("__favorites__")}
                    >
                      <span className="category-arrow">{expandedCategories.has("__favorites__") ? "\u25BC" : "\u25B6"}</span>
                      お気に入り ({favorites.boards.length})
                    </button>
                    {expandedCategories.has("__favorites__") && (
                      <ul className="category-boards fav-board-list">
                        {favorites.boards.map((b, i) => (
                          <li key={b.url} className={favDragState?.type === "board" && favDragState.overIndex === i ? "fav-drag-over" : ""}>
                            <button
                              className={`board-item ${selectedBoard === b.boardName ? "selected" : ""}`}
                              onClick={() => { if (favDragRef.current) return; selectBoard(b); }}
                              onMouseDown={(e) => onFavItemMouseDown(e, "board", i, ".fav-board-list")}
                              onContextMenu={(e) => { e.preventDefault(); const p = { x: e.clientX, y: e.clientY }; setBoardContextMenu({ x: p.x, y: p.y, board: b }); }}
                              title={b.url}
                            >
                              <span className="fav-star active" onClick={(e) => { e.stopPropagation(); toggleFavoriteBoard(b); }}><Star size={12} /></span>
                              {b.boardName}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {boardCategories
                  .map((cat) => {
                    const q = boardSearchQuery.trim().toLowerCase();
                    const filteredBoards = q ? cat.boards.filter((b) => b.boardName.toLowerCase().includes(q)) : cat.boards;
                    if (q && filteredBoards.length === 0) return null;
                    const isExpanded = q ? true : expandedCategories.has(cat.categoryName);
                    return (
                      <div key={cat.categoryName} className="board-category">
                        <button
                          className="category-toggle"
                          onClick={() => toggleCategory(cat.categoryName)}
                        >
                          <span className="category-arrow">{isExpanded ? "\u25BC" : "\u25B6"}</span>
                          {cat.categoryName} ({filteredBoards.length})
                        </button>
                        {isExpanded && (
                          <ul className="category-boards">
                            {filteredBoards.map((b) => (
                              <li key={b.url}>
                                <button
                                  className={`board-item ${selectedBoard === b.boardName ? "selected" : ""}`}
                                  onClick={() => selectBoard(b)}
                                  onContextMenu={(e) => { e.preventDefault(); const p = { x: e.clientX, y: e.clientY }; setBoardContextMenu({ x: p.x, y: p.y, board: b }); }}
                                  title={b.url}
                                >
                                  <span
                                    className={`fav-star ${isFavoriteBoard(b.url) ? "active" : ""}`}
                                    onClick={(e) => { e.stopPropagation(); toggleFavoriteBoard(b); }}
                                  >
                                    <Star size={12} fill={isFavoriteBoard(b.url) ? "currentColor" : "none"} />
                                  </span>
                                  {b.boardName}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })
                  .filter(Boolean)}
              </div>
            ) : (
              <ul>
                {boardItems.map((name) => (
                  <li key={name}>
                    <button className={`board-item ${selectedBoard === name ? "selected" : ""}`} onClick={() => setSelectedBoard(name)}>
                      {name}
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <div className="fav-threads-list">
              <input
                className="fav-search"
                value={favSearchQuery}
                onChange={(e) => setFavSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") recordInputHistory("favSearch", favSearchQuery); }}
                onBlur={() => recordInputHistory("favSearch", favSearchQuery)}
                list="input-history-favSearch"
                placeholder="お気に入り検索"
              />
              {inputHistoryDatalist("favSearch")}
              {favorites.threads.length === 0 ? (
                <span className="ng-empty">(お気に入りスレッドなし)</span>
              ) : (
                <ul className="category-boards fav-thread-list">
                  {favorites.threads.filter((ft) => !favSearchQuery.trim() || ft.title.toLowerCase().includes(favSearchQuery.trim().toLowerCase())).map((ft, i) => (
                    <li key={ft.threadUrl} className={favDragState?.type === "thread" && favDragState.overIndex === i ? "fav-drag-over" : ""}>
                      <button
                        className="board-item"
                        onClick={() => {
                          if (favDragRef.current) return;
                          openThreadInTab(ft.threadUrl, ft.title);
                          setStatus(`loading fav thread: ${ft.title}`);
                        }}
                        onMouseDown={(e) => onFavItemMouseDown(e, "thread", i, ".fav-thread-list")}
                        title={ft.threadUrl}
                      >
                        <span className="fav-star active" onClick={(e) => { e.stopPropagation(); toggleFavoriteThread(ft); }}><Star size={12} /></span>
                        {ft.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>}
        {boardPaneVisible && <div
          className="pane-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize boards pane"
          onMouseDown={(e) => beginHorizontalResize("board-thread", e)}
          onClick={(e) => e.stopPropagation()}
        />}
        <div className="right-body">
          {/* New arrivals pane — inside right-body, above tab bar */}
          {newArrivalPaneOpen && activePaneView !== "viewer" && (
            <>
              <div className="new-arrival-pane" style={{ height: newArrivalPaneHeight }}>
                <div className="new-arrival-header">
                  <span className="new-arrival-title">新着レス {arrivalQueueCount > 0 ? `(残 ${arrivalQueueCount})` : ""}{arrivalPaused ? " ⏸停止中" : ""}</span>
                </div>
                <div className="new-arrival-scroll" ref={newArrivalScrollRef}>
                  {currentArrivalItem === null && <div className="new-arrival-empty">新着レスはありません</div>}
                  {currentArrivalItem !== null && (
                    <div
                      className="new-arrival-item"
                      onClick={(e) => {
                        // カード内リンクのクリックは外部ブラウザで開き、レスへのジャンプはしない
                        const cardLink = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.body-link");
                        if (cardLink) {
                          e.preventDefault();
                          const url = cardLink.getAttribute("href");
                          if (url && /^https?:\/\//i.test(url)) {
                            if (isTauriRuntime()) void invoke("open_external_url", { url }).catch((err) => console.warn("open_external_url failed", err));
                            else window.open(url, "_blank");
                          }
                          return;
                        }
                        const tab = threadTabs.find((t) => t.threadUrl === currentArrivalItem.threadUrl);
                        if (tab) {
                          onTabClick(threadTabs.indexOf(tab));
                          setSelectedResponse(currentArrivalItem.responseNo);
                        }
                      }}
                    >
                      <div className="new-arrival-meta">
                        {arrivalHeaderVis.threadTitle && <span className="new-arrival-thread-title">{currentArrivalItem.threadTitle}</span>}
                        {arrivalHeaderVis.resNo && <span className="new-arrival-res-no">{currentArrivalItem.responseNo}</span>}
                        {arrivalHeaderVis.name && <span className="new-arrival-name"><span className="response-label">名前：</span>{arrivalHeaderVis.badges && currentArrivalItem.twitchBadges && currentArrivalItem.twitchBadges.length > 0 && (
                          <span className="viewer-badges arrival-badges">{currentArrivalItem.twitchBadges.map((b, i) => <img key={i} src={`${b.url}/1`} srcSet={`${b.url}/1 1x, ${b.url}/2 2x`} alt={b.title} title={b.title} referrerPolicy="no-referrer" />)}</span>
                        )}{currentArrivalItem.name}</span>}
                        {arrivalHeaderVis.mail && currentArrivalItem.mail && <span className="new-arrival-mail">[{currentArrivalItem.mail}]</span>}
                        {arrivalHeaderVis.date && <span className="new-arrival-time"><span className="response-label">投稿日：</span>{currentArrivalItem.time}</span>}
                        {arrivalHeaderVis.id && currentArrivalItem.id && <span className="new-arrival-id" style={{ color: idHighlights[currentArrivalItem.id] ?? undefined, ...(newArrivalIdFontSize !== 0 ? { fontSize: `${Math.max(6, newArrivalFontSize + newArrivalIdFontSize)}px` } : {}), ...(newArrivalIdFontFamily ? { fontFamily: `"${newArrivalIdFontFamily}", sans-serif` } : {}) }}>ID:{currentArrivalItem.id}</span>}
                        {arrivalHeaderVis.count && currentArrivalItem.idCount > 0 && <span className={`new-arrival-id-count${currentArrivalItem.idCount >= 5 ? " id-count-many" : currentArrivalItem.idCount >= 2 ? " id-count-some" : ""}`}>({currentArrivalItem.idSeq}/{currentArrivalItem.idCount})</span>}
                      </div>
                      {arrivalCardsEnabled && (ogpCardsEnabled || tweetCardsEnabled)
                        ? /* カード付き描画: 本文は renderResponseBody でサニタイズ済み (画像は非表示のまま) */
                          <div className="new-arrival-body" ref={newArrivalBodyRef} style={{ fontSize: `${newArrivalFontSize}px` }} dangerouslySetInnerHTML={{ __html: arrivalEmoteHtml(currentArrivalItem, renderResponseBody(currentArrivalItem.text, { hideImages: true, ogpCards: ogpCardsEnabled, tweetCards: tweetCardsEnabled, ogpAllow: ogpDomainFilters.allow, ogpBlock: ogpDomainFilters.block }).__html) }} />
                        : arrivalHasEmotes(currentArrivalItem)
                          ? /* スタンプがあるときだけ HTML で描く (本文は renderResponseBody でサニタイズ済み) */
                            <div className="new-arrival-body" ref={newArrivalBodyRef} style={{ fontSize: `${newArrivalFontSize}px` }} dangerouslySetInnerHTML={{ __html: arrivalEmoteHtml(currentArrivalItem, renderResponseBody(currentArrivalItem.text, { hideImages: true }).__html) }} />
                          : <div className="new-arrival-body" ref={newArrivalBodyRef} style={{ fontSize: `${newArrivalFontSize}px` }}>{decodeHtmlEntities(currentArrivalItem.text)}</div>}
                    </div>
                  )}
                </div>
              </div>
              <div className="splitter-h new-arrival-splitter" onMouseDown={beginNewArrivalResize} />
            </>
          )}
          {/* ビュワーのときは、新着レスペインの場所に「スレの最新レス」の欄を出す (高さは別に覚える。新しい行は下に足す) */}
          {latestPanelOpen && activePaneView === "viewer" && (
            <>
              <div className="viewer-latest viewer-latest-top" style={{
                height: latestPanelHeight,
                '--fs-delta': `${responsesFontSize - 12}px`,
                ...(viewerFontSize > 0 ? { '--viewer-latest-fs': `${Math.max(8, viewerFontSize - 1)}px` } : {}),
                ...(viewerFontBold ? { '--viewer-weight': "bold" } : {}),
                ...(viewerFontFamily ? { '--viewer-font': `"${viewerFontFamily.replace(/["\\;{}<>]/g, "")}", "Emoji", sans-serif` } : {}),
              } as React.CSSProperties}>
              <div className="viewer-latest-head">
                <span>スレの最新レス</span>
                <span className="viewer-latest-hint">開いているスレの新着のうち、ホワイトリストに無い ID のもの (OBS には出ません)</span>
                <span className="viewer-grow" />
                <button onClick={() => setLatestItems([])}>クリア</button>
              </div>
              <div className="viewer-latest-list" ref={latestListRef}>
                {viewerAllResponses && threadTabs.some((t) => t.viewerOn !== false && !isChatUrl(t.threadUrl)) && <div className="viewer-latest-note">選んだスレのレスはビュワーに流しています</div>}
                {latestItems.length === 0 ? (
                  <div className="viewer-empty">まだありません</div>
                ) : latestItems.map((it) => (
                  <div
                    key={it.seq}
                    className={`viewer-latest-item src-${it.source}`}
                    onContextMenu={(e) => openViewerMenu(e, { source: it.source, threadUrl: it.threadUrl, no: it.no, title: it.title, text: it.body, uid: it.uid })}
                    title={it.text}
                  >
                    {viewerShow.site && <span className="viewer-site">{it.site}</span>}
                    {latestShow.board && it.board && <span className="viewer-board">{it.board}</span>}
                    {latestShow.title && it.title && <span className="viewer-latest-title" title={it.title}>{it.title}</span>}
                    {latestShow.no && <span className="viewer-no">{it.no}</span>}
                    {latestShow.text ? <span className="viewer-latest-text">{it.text}</span> : <span className="viewer-grow" />}
                    {latestShow.time && <span className="viewer-time">{it.time.replace(/^\S+\s+/, "")}</span>}
                    {latestShow.id && it.uid && <span className="viewer-uid" style={{ color: idHighlights[it.uid] ?? undefined }}>ID:{it.uid}</span>}
                    {latestShow.count && it.idCount > 0 && <span className={`viewer-id-count${idCountClass(it.idCount)}`}>({it.idSeq}/{it.idCount})</span>}
                    {it.uid && !broadcastWhitelist[it.uid] && (
                      <button
                        className="viewer-latest-wl"
                        onClick={(e) => { e.stopPropagation(); addToWhitelist([it.uid]); }}
                        title="この ID を配信ホワイトリストに入れる"
                      >WLに入れる</button>
                    )}
                  </div>
                ))}
              </div>
              </div>
              <div className="splitter-h new-arrival-splitter" onMouseDown={beginLatestResize} title="ドラッグで高さを変えます" />
            </>
          )}
        <div
          ref={responseLayoutRef}
          className={`right-pane${tabSiteColors ? " tab-site-colors" : ""}${tabWidthFixed ? " tab-width-fixed" : ""}`}
          style={tabWidthFixed ? ({ "--board-tab-w": `${boardTabWidth}px`, "--thread-tab-w": `${threadTabWidth}px` } as React.CSSProperties) : undefined}
        >
        {/* Board tab bar (upper) */}
        <div className="board-tab-bar-wrap">
          <div className="board-tab-bar board-tabs" ref={boardTabBarRef}>
            <div
              className={`board-tab tab viewer-tab ${activePaneView === "viewer" ? "active" : ""}`}
              onClick={() => { rememberBeforeLeavingResponses(); setActivePaneView("viewer"); }}
              title="Twitch・YouTube のチャットと、配信ホワイトリストに入れた ID のレスをまとめて表示します"
            >
              <span className="board-tab-title">ビュワー</span>
            </div>
            {boardTabs.length === 0 && (
              <div className="board-tab placeholder">
                <span className="board-tab-title">板未選択</span>
              </div>
            )}
            {boardTabs.map((tab, i) => (
              <div
                key={tab.boardUrl}
                className={`board-tab tab ${siteClassOf(tab.boardUrl)} ${i === activeBoardTabIndex && activePaneView !== "viewer" ? "active" : ""} ${boardTabDragIndex !== null && boardTabDragIndex !== i ? "drag-target" : ""}`}
                onClick={() => {
                  if (boardTabDragSuppressClickRef.current) return;
                  setActiveBoardTabIndex(i);
                  rememberBeforeLeavingResponses();
                  setActivePaneView("threads");
                  setSelectedBoard(tab.title);
                  setThreadUrl(tab.boardUrl);
                  setLocationInput(tab.boardUrl);
                  void fetchThreadListFromCurrent(tab.boardUrl);
                }}
                onContextMenu={(e) => { e.preventDefault(); const p = { x: e.clientX, y: e.clientY }; setBoardContextMenu({ x: p.x, y: p.y, board: { boardName: tab.title, url: tab.boardUrl } }); }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  const startX = e.clientX;
                  let dragging = false;
                  let dst = i;
                  const onMove = (mv: MouseEvent) => {
                    const dx = mv.clientX - startX;
                    if (!dragging && Math.abs(dx) <= 6) return;
                    if (!dragging) {
                      dragging = true;
                      setBoardTabDragIndex(i);
                    }
                    const els = boardTabBarRef.current?.querySelectorAll<HTMLElement>(".board-tab:not(.placeholder):not(.viewer-tab)");
                    if (!els) return;
                    els.forEach((el) => el.classList.remove("drag-over"));
                    for (let j = 0; j < els.length; j++) {
                      const r = els[j].getBoundingClientRect();
                      if (mv.clientX >= r.left && mv.clientX <= r.right) {
                        dst = j;
                        if (j !== i) els[j].classList.add("drag-over");
                        break;
                      }
                    }
                  };
                  const onUp = () => {
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                    setBoardTabDragIndex(null);
                    boardTabBarRef.current?.querySelectorAll<HTMLElement>(".drag-over").forEach((el) => el.classList.remove("drag-over"));
                    if (dragging) {
                      boardTabDragSuppressClickRef.current = true;
                      setTimeout(() => { boardTabDragSuppressClickRef.current = false; }, 0);
                    }
                    if (!dragging || dst === i) return;
                    setBoardTabs((prev) => {
                      const next = [...prev];
                      const [moved] = next.splice(i, 1);
                      next.splice(dst, 0, moved);
                      return next;
                    });
                    setActiveBoardTabIndex((prev) => {
                      if (prev === i) return dst;
                      if (i < prev && dst >= prev) return prev - 1;
                      if (i > prev && dst <= prev) return prev + 1;
                      return prev;
                    });
                  };
                  document.addEventListener("mousemove", onMove);
                  document.addEventListener("mouseup", onUp);
                }}
                title={`${tab.title}\n${tab.boardUrl}`}
              >
                <span className="board-tab-title">{tab.title}</span>
                <button
                  className="tab-close-btn"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setBoardTabs((prev) => {
                      const next = prev.filter((_, j) => j !== i);
                      setActiveBoardTabIndex((prev2) => {
                        if (prev2 === i) return next.length > 0 ? Math.min(i, next.length - 1) : -1;
                        if (prev2 > i) return prev2 - 1;
                        return prev2;
                      });
                      return next;
                    });
                  }}
                  title="閉じる"
                >×</button>
              </div>
            ))}
          </div>
        </div>
        {/* Thread tab bar (lower) */}
        <div className="thread-tab-bar-wrap">
          <div className="thread-tab-bar thread-tabs" ref={tabBarRef}>
            {threadTabs.length === 0 && (
              <div className="thread-tab placeholder active">
                <span className="thread-tab-title title">未取得</span>
              </div>
            )}
            {threadTabs.map((tab, i) => (
              <div
                key={tab.threadUrl}
                title={tab.title}
                className={`thread-tab tab ${siteClassOf(tab.threadUrl)} ${i === activeTabIndex ? "active" : ""} ${tabDragIndex !== null && tabDragIndex !== i ? "drag-target" : ""}`}
                onClick={() => { if (tabDragSuppressClickRef.current) return; onTabClick(i); }}
                onDoubleClick={() => { void fetchResponsesFromCurrent(tab.threadUrl, { keepSelection: true }); }}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(i); } }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const p = { x: e.clientX, y: e.clientY };
                  setTabMenu({ x: p.x, y: p.y, tabIndex: i });
                }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  const startX = e.clientX;
                  let dragging = false;
                  let dst = i;
                  const onMove = (mv: MouseEvent) => {
                    const dx = mv.clientX - startX;
                    if (!dragging && Math.abs(dx) <= 6) return;
                    if (!dragging) {
                      dragging = true;
                      setTabDragIndex(i);
                    }
                    const els = tabBarRef.current?.querySelectorAll<HTMLElement>(".thread-tab:not(.placeholder)");
                    if (!els) return;
                    els.forEach((el) => el.classList.remove("drag-over"));
                    for (let j = 0; j < els.length; j++) {
                      const r = els[j].getBoundingClientRect();
                      if (mv.clientX >= r.left && mv.clientX <= r.right) {
                        dst = j;
                        if (j !== i) els[j].classList.add("drag-over");
                        break;
                      }
                    }
                  };
                  const onUp = () => {
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                    setTabDragIndex(null);
                    tabBarRef.current?.querySelectorAll<HTMLElement>(".drag-over").forEach((el) => el.classList.remove("drag-over"));
                    if (dragging) {
                      tabDragSuppressClickRef.current = true;
                      setTimeout(() => { tabDragSuppressClickRef.current = false; }, 0);
                    }
                    if (!dragging || dst === i) return;
                    setThreadTabs((prev) => {
                      const next = [...prev];
                      const [moved] = next.splice(i, 1);
                      next.splice(dst, 0, moved);
                      return next;
                    });
                    setActiveTabIndex((prev) => {
                      if (prev === i) return dst;
                      if (i < prev && dst >= prev) return prev - 1;
                      if (i > prev && dst <= prev) return prev + 1;
                      return prev;
                    });
                  };
                  document.addEventListener("mousemove", onMove);
                  document.addEventListener("mouseup", onUp);
                }}
              >
                {tab.ttsOff && <EarOff size={11} className="tab-tts-off" aria-label="読み上げオフ" />}
                <span className="thread-tab-title title">{tab.title}</span>
                {tabCacheRef.current.has(tab.threadUrl) && (
                  <span className="tab-res-count">({tabCacheRef.current.get(tab.threadUrl)!.responses.length})</span>
                )}
                <button
                  className="thread-tab-close"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); closeTab(i); }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
        {activePaneView === "viewer" ? (
        <section id="viewerPane" className="pane viewer" style={{
          '--fs-delta': `${responsesFontSize - 12}px`,
          ...(viewerFontSize > 0 ? { '--viewer-fs': `${viewerFontSize}px`, '--viewer-latest-fs': `${Math.max(8, viewerFontSize - 1)}px` } : {}),
          ...(viewerFontBold ? { '--viewer-weight': "bold" } : {}),
          ...(viewerFontFamily ? { '--viewer-font': `"${viewerFontFamily.replace(/["\\;{}<>]/g, "")}", "Emoji", sans-serif` } : {}),
        } as React.CSSProperties}>
          <div className="viewer-toolbar">
            {(Object.keys(VIEWER_SITE_LABEL) as ViewerSource[]).map((src) => (
              <label key={src} className={`viewer-chip src-${src}`} title="表示する出どころ">
                <input type="checkbox" checked={viewerFilter[src]} onChange={(e) => setViewerFilter((prev) => ({ ...prev, [src]: e.target.checked }))} />
                {VIEWER_SITE_LABEL[src]}
              </label>
            ))}
            <label className={`viewer-chip viewer-all-toggle${viewerAllResponses ? " on" : ""}`} title={`オン: 設定 > 接続 で「ビュワー」にチェックを入れたスレ (またはタブの右クリック →「ビュワーに流す」) のレスを、ホワイトリストに関係なく流します。オフ: 配信ホワイトリストの ID のレスだけを流します (チャットはいつも全部)。OBS 表示には、オンでもチャットとホワイトリストの ID のレスだけを送ります。選んだスレのレスは「スレの最新レス」の欄に追加しません。\n選んでいるスレ: ${threadTabs.filter((t) => t.viewerOn !== false && !isChatUrl(t.threadUrl)).length} 件`}>
              <input type="checkbox" checked={viewerAllResponses} onChange={(e) => setViewerAllResponses(e.target.checked)} />
              選んだスレを流す
            </label>
            <span className="viewer-grow" />
            <label className="viewer-toggle" title="新しいものが届いたら一番下へ移動する">
              <input type="checkbox" checked={viewerAutoScroll} onChange={(e) => setViewerAutoScroll(e.target.checked)} />
              自動スクロール
            </label>
            <button onClick={() => setViewerItems([])} title="ビュワーの表示を消します">クリア</button>
            {threadTabs.some((t) => isYoutubeUrl(t.threadUrl)) && youtubeQuotaChip()}
          </div>
          <div className="viewer-list" ref={viewerListRef}>
            {viewerItems.filter((it) => viewerFilter[it.source]).length === 0 ? (
              <div className="viewer-empty">
                まだ表示するものはありません。Twitch のチャット (アドレスバーに twitch.tv/チャンネル名)、YouTube のライブ配信のチャット (ライブ配信の URL) と、
                配信ホワイトリストに入れた ID のレス (レスを右クリック →「配信ホワイトリストに追加」) がここに流れます。
                配信ホワイトリスト: {Object.keys(broadcastWhitelist).length}件
              </div>
            ) : viewerItems.filter((it) => viewerFilter[it.source]).map((it) => (
              <div
                key={it.seq}
                className={`viewer-item src-${it.source}${it.event ? ` viewer-event ev-${it.event.kind}` : ""}`}
                onClick={(e) => { handleBodyContentClick(e); }}
                onContextMenu={(e) => openViewerMenu(e, { source: it.source, threadUrl: it.threadUrl, no: it.no, title: it.where, text: it.text || it.event?.summary || "", uid: it.uid, name: it.event ? undefined : it.name })}
                title="右クリック: そのタブへ移動・コピー・コマンド"
              >
                <div className="viewer-meta">
                  {it.event ? <span className="viewer-site">{it.event.label}</span> : viewerShow.site && <span className="viewer-site">{it.site}</span>}
                  {!isChatSource(it.source) ? (
                    <>
                      {/* 掲示板のレス: 板・スレタイ・レス番・名前・メール欄・日時・ID・書き込み回数 */}
                      {viewerShow.board && it.board && <span className="viewer-board">{it.board}</span>}
                      {viewerShow.where && <span className="viewer-where">{it.where}</span>}
                      {viewerShow.no && <span className="viewer-no">{it.no}</span>}
                      {viewerShow.name && <span className="viewer-name" style={viewerNameHighlight(it.name)}>{it.name}</span>}
                      {viewerShow.mail && it.mail && <span className="viewer-mail">[{it.mail}]</span>}
                      {viewerShow.time && <span className="viewer-time">{it.time}</span>}
                      {viewerShow.id && it.uid && <span className="viewer-uid" style={{ color: idHighlights[it.uid] ?? undefined }}>ID:{it.uid}</span>}
                      {viewerShow.count && (it.idCount ?? 0) > 0 && <span className={`viewer-id-count${idCountClass(it.idCount ?? 0)}`}>({it.idSeq}/{it.idCount})</span>}
                    </>
                  ) : (
                  <>
                  {viewerShow.where && <span className="viewer-where">{it.where}</span>}
                  {viewerShow.badges && it.badges && it.badges.length > 0 && (
                    <span className="viewer-badges">
                      {it.badges.map((b, i) => <img key={i} src={`${b.url}/1`} srcSet={`${b.url}/1 1x, ${b.url}/2 2x`} alt={b.title} title={b.title} referrerPolicy="no-referrer" />)}
                    </span>
                  )}
                  <span className="viewer-name" style={{ ...(it.color ? { color: it.color } : {}), ...viewerNameHighlight(it.name) }}>{it.name}</span>
                  {viewerShow.id && it.uid && <span className="viewer-uid" style={{ color: idHighlights[it.uid] ?? undefined }}>ID:{it.uid}</span>}
                  {viewerShow.time && <span className="viewer-time">{it.time}</span>}
                  </>
                  )}
                </div>
                {it.event && <div className="viewer-event-summary">{it.event.summary}</div>}
                {(!it.event || it.text) && <div className="viewer-text" dangerouslySetInnerHTML={{ __html: viewerBodyHtml(it) }} />}
                {isChatSource(it.source) && viewerTwitchClickToLoad && !viewerRevealed.has(it.seq) && (viewerThumbs || viewerCards) && URL_IN_TEXT_RE.test(it.text) && (
                  <button className="viewer-media-reveal" onClick={(e) => { e.stopPropagation(); setViewerRevealed((prev) => new Set(prev).add(it.seq)); }} title="この発言のリンクの画像・カードを読み込みます">画像・カードを表示</button>
                )}
              </div>
            ))}
          </div>
        </section>
        ) : activePaneView === "threads" ? (
        <section id="boardPane" className="pane threads" onMouseDown={() => setFocusedPane("threads")} style={{ '--fs-delta': `${threadsFontSize - 12}px` } as React.CSSProperties}>
          <div className="threads-toolbar">
            <div className="search-with-history lf-flex1">
              <input
                ref={threadSearchRef}
                className="thread-search"
                value={threadSearchQuery}
                onChange={(e) => setThreadSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter") { addSearchHistory("thread", threadSearchQuery); setSearchHistoryDropdown(null); }
                  if (e.key === "Escape") setSearchHistoryDropdown(null);
                }}
                placeholder="検索 (Enter:保存 / 右クリック:削除)"
              />
              <button
                className="search-history-btn"
                onClick={(e) => { e.stopPropagation(); setSearchHistoryDropdown((prev) => prev?.type === "thread" ? null : { type: "thread" }); }}
                title="検索履歴"
              ><ChevronDown size={10} /></button>
              {searchHistoryDropdown?.type === "thread" && threadSearchHistory.length > 0 && (
                <div className="search-history-dropdown" onMouseDown={(e) => e.preventDefault()}>
                  {threadSearchHistory
                    .filter((w) => !threadSearchQuery.trim() || w.toLowerCase().includes(threadSearchQuery.trim().toLowerCase()))
                    .map((w) => (
                      <div
                        key={w}
                        className="search-history-item"
                        onClick={() => { setThreadSearchQuery(w); setSearchHistoryDropdown(null); }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const p = { x: e.clientX, y: e.clientY };
                          setSearchHistoryMenu({ x: p.x, y: p.y, type: "thread", word: w });
                        }}
                      >{w}</div>
                    ))}
                </div>
              )}
            </div>
            {threadSearchQuery && <button className="title-action-btn" onClick={() => setThreadSearchQuery("")} title="検索クリア"><X size={14} /></button>}
            <button className="title-action-btn" onClick={() => fetchThreadListFromCurrent()} title="スレ一覧を更新"><RefreshCw size={14} /></button>
            <button className="title-action-btn" onClick={() => setShowNewThreadDialog(true)} title="スレ立て"><FilePenLine size={14} /></button>
            <button
              className={`title-action-btn ${showCachedOnly ? "active-toggle" : ""}`}
              onClick={() => {
                if (showCachedOnly) {
                  setShowCachedOnly(false);
                  setCachedThreadList([]);
                  return;
                } else {
                  if (isTauriRuntime()) {
                    invoke<[string, string, number][]>("load_all_cached_threads").then((list) => {
                      // Only show threads from the current board that are not in the active thread list (dat落ち)
                      // Compare by board name only (ignore hostname differences like greta vs mao)
                      const extractBoardName = (url: string): string => {
                        try {
                          const parts = new URL(url).pathname.split("/").filter(Boolean);
                          if (parts.length >= 3 && parts[0] === "test" && parts[1] === "read.cgi") return parts[2];
                          return parts[0] || "";
                        } catch { return ""; }
                      };
                      const currentBoard = extractBoardName(threadUrl);
                      const activeUrls = new Set(fetchedThreads.map((t) => t.threadUrl));
                      const datOchiList = list
                        .filter(([url]) => extractBoardName(url) === currentBoard)
                        .filter(([url]) => !activeUrls.has(url));
                      setCachedThreadList(datOchiList.map(([threadUrl, title, count]) => {
                        const displayTitle = title && title.trim() !== "" ? title : (() => {
                          try {
                            const parts = new URL(threadUrl).pathname.split("/").filter(Boolean);
                            return parts[parts.length - 1] || threadUrl;
                          } catch { return threadUrl; }
                        })();
                        return { threadUrl, title: displayTitle, resCount: count };
                      }));
                      setShowCachedOnly(true);
                      setShowFavoritesOnly(false);
                    }).catch(() => {});
                  }
                }
              }}
              title="dat落ちキャッシュ表示"
            ><Save size={14} /></button>
            <button
              className={`title-action-btn ${showFavoritesOnly ? "active-toggle" : ""}`}
              onClick={() => {
                const willEnable = !showFavoritesOnly;
                setShowFavoritesOnly((v) => !v);
                if (willEnable) {
                  setShowCachedOnly(false);
                  void fetchFavNewCounts();
                } else {
                  // Restore read status for normal thread list
                  const url = threadUrl.trim();
                  if (url && fetchedThreads.length > 0) {
                    void loadReadStatusForBoard(url, fetchedThreads);
                  }
                }
              }}
              title="お気に入りスレのみ表示"
            ><Star size={14} /></button>
            <button
              className={`title-action-btn ${threadNgOpen ? "active-toggle" : ""}`}
              onClick={() => setThreadNgOpen(!threadNgOpen)}
              title="スレ一覧NGワード"
            ><Ban size={14} />{ngFilters.thread_words.length > 0 ? ngFilters.thread_words.length : ""}</button>
          </div>
          {threadNgOpen && (
            <div className="thread-ng-popup">
              <div className="thread-ng-add">
                <input
                  value={threadNgInput}
                  onChange={(e) => setThreadNgInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && threadNgInput.trim()) {
                      addNgEntry("thread_words", threadNgInput, "hide");
                      setThreadNgInput("");
                    }
                  }}
                  placeholder="NGワード (例: BE:12345)"
                  className="lf-flex1"
                />
                <button onClick={() => { addNgEntry("thread_words", threadNgInput, "hide"); setThreadNgInput(""); }}>追加</button>
              </div>
              {ngFilters.thread_words.length > 0 && (
                <ul className="thread-ng-list">
                  {ngFilters.thread_words.map((w) => {
                    const v = ngVal(w);
                    return (
                      <li key={v}>
                        <span>{maskDisplay(v)}</span>
                        <button className="ng-remove" onClick={() => removeNgEntry("thread_words", v)}>×</button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
          <div className="threads-table-wrap" ref={threadListScrollRef}>
          <table>
            <thead>
              <tr>
                <th className="sortable-th col-resizable" style={{ width: threadColWidths.fetched + "px" }} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX >= r.right - COL_RESIZE_HANDLE_PX) return; toggleThreadSort("fetched"); }} onMouseDown={(e) => beginColResize("fetched", "right", e)} onDoubleClick={(e) => resetColWidth("fetched", "right", e)} onMouseMove={(e) => colResizeCursor("right", e)} title="取得済みスレを上にソート">
                  !{threadSortKey === "fetched" ? (threadSortAsc ? "\u25B2" : "\u25BC") : ""}
                </th>
                <th className="sortable-th col-resizable" style={{ width: threadColWidths.id + "px" }} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX >= r.right - COL_RESIZE_HANDLE_PX) return; toggleThreadSort("id"); }} onMouseDown={(e) => beginColResize("id", "right", e)} onDoubleClick={(e) => resetColWidth("id", "right", e)} onMouseMove={(e) => colResizeCursor("right", e)}>
                  番号{threadSortKey === "id" ? (threadSortAsc ? " \u25B2" : " \u25BC") : ""}
                </th>
                <th className="sortable-th" onClick={() => toggleThreadSort("title")}>
                  タイトル{threadSortKey === "title" ? (threadSortAsc ? " \u25B2" : " \u25BC") : ""}
                </th>
                <th className="sortable-th col-resizable-left" style={{ width: threadColWidths.res + "px" }} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX <= r.left + COL_RESIZE_HANDLE_PX) return; toggleThreadSort("res"); }} onMouseDown={(e) => beginColResize("res", "left", e)} onDoubleClick={(e) => resetColWidth("res", "left", e)} onMouseMove={(e) => colResizeCursor("left", e)}>
                  レス{threadSortKey === "res" ? (threadSortAsc ? " \u25B2" : " \u25BC") : ""}
                </th>
                <th className="sortable-th col-resizable-left" style={{ width: threadColWidths.read + "px" }} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX <= r.left + COL_RESIZE_HANDLE_PX) return; toggleThreadSort("got"); }} onMouseDown={(e) => beginColResize("read", "left", e)} onDoubleClick={(e) => resetColWidth("read", "left", e)} onMouseMove={(e) => colResizeCursor("left", e)}>
                  既読{threadSortKey === "got" ? (threadSortAsc ? " \u25B2" : " \u25BC") : ""}
                </th>
                <th className="sortable-th col-resizable-left" style={{ width: threadColWidths.unread + "px" }} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX <= r.left + COL_RESIZE_HANDLE_PX) return; toggleThreadSort("new"); }} onMouseDown={(e) => beginColResize("unread", "left", e)} onDoubleClick={(e) => resetColWidth("unread", "left", e)} onMouseMove={(e) => colResizeCursor("left", e)}>
                  新着{threadSortKey === "new" ? (threadSortAsc ? " \u25B2" : " \u25BC") : ""}
                </th>
                <th className="sortable-th col-resizable-left" style={{ width: threadColWidths.lastFetch + "px" }} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX <= r.left + COL_RESIZE_HANDLE_PX) return; toggleThreadSort("lastFetch"); }} onMouseDown={(e) => beginColResize("lastFetch", "left", e)} onDoubleClick={(e) => resetColWidth("lastFetch", "left", e)} onMouseMove={(e) => colResizeCursor("left", e)}>
                  最終取得{threadSortKey === "lastFetch" ? (threadSortAsc ? " ▲" : " ▼") : ""}
                </th>
                <th className="sortable-th col-resizable-left" style={{ width: 90 + "px" }} onClick={() => toggleThreadSort("since")} title="スレ作成日">
                  Since{threadSortKey === "since" ? (threadSortAsc ? " \u25B2" : " \u25BC") : ""}
                </th>
                <th className="sortable-th col-resizable-left" style={{ width: threadColWidths.speed + "px" }} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX <= r.left + COL_RESIZE_HANDLE_PX) return; toggleThreadSort("speed"); }} onMouseDown={(e) => beginColResize("speed", "left", e)} onDoubleClick={(e) => resetColWidth("speed", "left", e)} onMouseMove={(e) => colResizeCursor("left", e)}>
                  勢い{threadSortKey === "speed" ? (threadSortAsc ? " \u25B2" : " \u25BC") : ""}
                </th>
              </tr>
            </thead>
            <tbody ref={threadTbodyRef}>
              {visibleThreadItems.map((t) => {
                const isUnread = !threadReadMap[t.threadUrl];
                const hasUnread = t.got > 0 && t.res - t.got > 0;
                const threadNgHit = threadNgResultMap.get(t.threadUrl);
                const isThreadAbone = threadNgHit?.mode === "abone";
                return (
                  <tr
                    key={t.threadUrl}
                    className={`bcon${t.id % 2 === 0 ? " odd" : ""} ${selectedThread === t.threadUrl ? "selected-row cursor" : ""} ${isUnread ? "unread-row" : ""} ${hasUnread ? "has-unread-row" : ""} ${"datOchi" in t && t.datOchi ? "dat-ochi-row" : ""}`}
                    onClick={() => {
                      setSelectedThread(t.threadUrl);
                      setSelectedResponse(1);
                      setThreadReadMap((prev) => ({ ...prev, [t.threadUrl]: true }));
                      setThreadLastReadCount((prev) => ({ ...prev, [t.threadUrl]: t.res }));
                      if ("threadUrl" in t && typeof t.threadUrl === "string") {
                        const alreadyOpen = threadTabs.some((tab) => tab.threadUrl === t.threadUrl);
                        openThreadInTab(t.threadUrl, t.title);
                        if (alreadyOpen) {
                          void fetchResponsesFromCurrent(t.threadUrl, { keepSelection: true });
                        }
                        // persist read status
                        if (showFavoritesOnly) {
                          const boardUrl = getBoardUrlFromThreadUrl(t.threadUrl);
                          const parts = t.threadUrl.replace(/\/$/, "").split("/");
                          const threadKey = parts[parts.length - 1] ?? "";
                          if (threadKey && t.res > 0) {
                            void persistReadStatus(boardUrl, threadKey, t.res);
                          }
                        } else {
                          const ft = fetchedThreads.find((f) => f.threadUrl === t.threadUrl);
                          if (ft) {
                            const boardUrl = getBoardUrlFromThreadUrl(t.threadUrl);
                            void persistReadStatus(boardUrl, ft.threadKey, ft.responseCount);
                          }
                        }
                      }
                    }}
                    onDoubleClick={() => {
                      if ("threadUrl" in t && typeof t.threadUrl === "string") {
                        const bm = loadBookmark(t.threadUrl);
                        if (bm) {
                          setSelectedResponse(bm);
                          setStatus(`栞: >>${bm}`);
                        }
                      }
                    }}
                    onContextMenu={(e) => onThreadContextMenu(e, t.id)}
                  >
                    <td className="thread-fetched-cell">{showFavoritesOnly ? (hasUnread ? "\u25CF" : "") : (hasUnread || threadReadMap[t.threadUrl] ? "\u25CF" : "")}</td>
                    <td>{t.id}</td>
                    {isThreadAbone ? (
                      <td className="thread-title-cell">
                        <span className="ng-abone-text" title={threadNgHit?.reason ?? "あぼ～ん"}>あぼ～ん</span>
                      </td>
                    ) : (
                      <td
                        className={`thread-title-cell${customTitles[selectedBoard]?.[t.threadKey] ? " has-custom-title" : ""}`}
                        dangerouslySetInnerHTML={renderHighlightedPlainText(customTitles[selectedBoard]?.[t.threadKey] ?? t.title, threadSearchQuery)}
                      />
                    )}
                    <td>{t.res >= 0 ? t.res : "-"}</td>
                    <td>{t.got > 0 ? t.got : "-"}</td>
                    <td className={`new-count ${t.got > 0 && t.res > 0 && t.res - t.got > 0 ? "has-new" : ""}`}>
                      {t.got > 0 && t.res > 0 ? Math.max(0, t.res - t.got) : "-"}
                    </td>
                    <td className="last-fetch-cell">{threadFetchTimesRef.current[t.threadUrl] ?? "-"}</td>
                    <td className="since-cell">{"since" in t ? (t.since as string) : "-"}</td>
                    <td className="speed-cell">
                      <span className="speed-bar" style={{
                        width: `${Math.min(100, t.speed * 2)}%`,
                        background: t.speed >= 20 ? "rgba(200,40,40,0.25)" : t.speed >= 5 ? "rgba(200,120,40,0.2)" : "rgba(200,80,40,0.15)",
                      }} />
                      <span className="speed-val">{t.speed.toFixed(1)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </section>
        ) : (
        <section id="threadPane" className={`pane responses${svClass ? ` ${svClass}` : ""}`} onMouseDown={() => setFocusedPane("responses")} style={{ '--fs-delta': `${responsesFontSize - 12}px`, '--fs-header-delta': `${responsesHeaderFontSize - 11}px` } as React.CSSProperties}>
          {activeTabIndex >= 0 && activeTabIndex < threadTabs.length && (
            <div className="thread-title-bar">
              <span className="thread-title-text" title={threadTabs[activeTabIndex].title}>
                {threadTabs[activeTabIndex].title}
                {" "}[{fetchedResponses.length}]
              </span>
              <span className="thread-title-fetch-time">{lastFetchTime ?? ""}</span>
              {isYoutubeUrl(threadTabs[activeTabIndex].threadUrl) && youtubeQuotaChip()}
              <span className="thread-title-actions">
                <div className="title-split-wrap" onClick={(e) => e.stopPropagation()}>
                  <button className="title-action-btn title-split-main" onClick={fetchNewResponses} title="新着取得">
                    <RefreshCw size={14} />
                  </button>
                  <button
                    className="title-action-btn title-split-toggle"
                    onClick={() => setResponseReloadMenuOpen((v) => !v)}
                    title="更新メニュー"
                    aria-label="更新メニュー"
                    aria-expanded={responseReloadMenuOpen}
                  >
                    <ChevronDown size={12} />
                  </button>
                  {responseReloadMenuOpen && (
                    <div className="title-split-menu">
                      <button onClick={() => { setResponseReloadMenuOpen(false); reloadResponses(); }}>
                        再読み込み
                      </button>
                      <button onClick={() => { setResponseReloadMenuOpen(false); reloadResponsesAfterCachePurge(); }}>
                        キャッシュから削除して再読み込み
                      </button>
                    </div>
                  )}
                </div>
                <button className="title-action-btn" onClick={openComposePopup} title="書き込み（別ウィンドウ）"><Pencil size={14} /></button>
                <div className="title-split-wrap" onClick={(e) => e.stopPropagation()}>
                  <button
                    className={`title-action-btn ${responseSearchMode ? "active" : ""}`}
                    onClick={() => {
                      if (responseSearchMode) {
                        setResponseSearchMode(null);
                        setResponseSearchQuery("");
                        setSearchMatchIndex(0);
                        setSearchModeMenuOpen(false);
                      } else {
                        setSearchModeMenuOpen((v) => !v);
                      }
                    }}
                    title="検索"
                  ><Search size={14} /></button>
                  {searchModeMenuOpen && (
                    <div className="title-split-menu">
                      <button onClick={() => { setSearchModeMenuOpen(false); setResponseSearchQuery(""); setSearchMatchIndex(0); setResponseSearchMode("extract"); setTimeout(() => responseSearchRef.current?.focus(), 0); }}>レス抽出</button>
                      <button onClick={() => { setSearchModeMenuOpen(false); setResponseSearchQuery(""); setSearchMatchIndex(0); setResponseSearchMode("in-thread"); setTimeout(() => responseSearchRef.current?.focus(), 0); }}>スレ内検索</button>
                    </div>
                  )}
                </div>
                <button
                  className={`title-action-btn ${subtitleVisible ? "active" : ""}`}
                  onClick={() => {
                    if (!subtitleVisible) {
                      setSubtitleVisible(true);
                      if (isTauriRuntime()) invoke("subtitle_show").then(() => {
                        setTimeout(() => {
                          invoke("subtitle_opacity", { opacity: subtitleOpacity }).catch(() => {});
                          invoke("subtitle_text_shadow", { enabled: subtitleTextShadow }).catch((e) => console.warn("subtitle_text_shadow:", e));
                          invoke("subtitle_frame", { mode: subtitleFrameMode }).catch((e) => console.warn("subtitle_frame:", e));
                          invoke("subtitle_font_size", { size: subtitleBodyFontSize }).catch(() => {});
                          invoke("subtitle_meta_font_size", { size: subtitleMetaFontSize }).catch(() => {});
                          invoke("subtitle_topmost", { enabled: subtitleAlwaysOnTop }).catch(() => {});
                        }, 400);
                      }).catch((e) => console.warn("subtitle_show:", e));
                    } else {
                      setSubtitleVisible(false);
                      if (isTauriRuntime()) invoke("subtitle_hide").catch((e) => console.warn("subtitle_hide:", e));
                    }
                  }}
                  title="字幕"
                ><Subtitles size={14} /></button>
                <button
                  className={`title-action-btn ${ttsEnabled ? "active" : ""}`}
                  onClick={() => setTtsEnabled(!ttsEnabled)}
                  title={`すべてのスレ・チャンネルの読み上げ ${ttsEnabled ? "ON" : "OFF"}`}
                ><Volume2 size={14} /></button>
                <button
                  className={`title-action-btn ${threadTabs[activeTabIndex].ttsOff ? "" : "active"}`}
                  onClick={() => toggleTabTts(threadTabs[activeTabIndex].threadUrl)}
                  title={`このタブ (スレ・チャンネル) の読み上げ ${threadTabs[activeTabIndex].ttsOff ? "OFF" : "ON"}`}
                >{threadTabs[activeTabIndex].ttsOff ? <EarOff size={14} /> : <Ear size={14} />}</button>
                <button
                  className="title-action-btn"
                  onClick={() => void ttsStop()}
                  title="読み上げを今すぐ停止 (待機中の分もまとめて破棄)"
                ><VolumeX size={14} /></button>
                <button className="title-action-btn" onClick={() => {
                  const tab = threadTabs[activeTabIndex];
                  if (tab) toggleFavoriteThread({ threadUrl: tab.threadUrl, title: tab.title });
                }} title="お気に入り">
                  <Star size={14} fill={favorites.threads.some((f) => f.threadUrl === threadTabs[activeTabIndex].threadUrl) ? "currentColor" : "none"} />
                </button>
              </span>
            </div>
          )}
          {(() => {
            const yt = activeTabIndex >= 0 && activeTabIndex < threadTabs.length ? youtubeVideoFromUrl(threadTabs[activeTabIndex].threadUrl) : null;
            const st = yt ? youtubeStatusMap[yt] : undefined;
            if (!yt || !st || (st.state !== "stopped" && st.state !== "ended" && st.state !== "retrying")) return null;
            const label = st.state === "ended" ? "配信が終わりました" : st.state === "retrying" ? "つなぎ直しています" : "受信していません";
            return (
              <div className={`yt-status-banner yt-status-${st.state}`} role="status">
                <span><b>{label}</b>{st.message ? `: ${st.message}` : ""}</span>
                {st.state !== "retrying" && <button onClick={() => reconnectYoutube(yt)}>つなぎ直す</button>}
                {st.state !== "retrying" && <button onClick={() => closeTab(activeTabIndex)}>タブを閉じる</button>}
              </div>
            );
          })()}
          {responseSearchMode && (
            <div className="response-search-bar">
              <span className="search-mode-label">{responseSearchMode === "extract" ? "レス抽出:" : "スレ内検索:"}</span>
              <div className="search-with-history lf-flex1">
                <input
                  ref={responseSearchRef}
                  className="thread-search"
                  value={responseSearchQuery}
                  onChange={(e) => setResponseSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Enter") {
                      addSearchHistory("response", responseSearchQuery);
                      setSearchHistoryDropdown(null);
                      if (responseSearchMode === "in-thread" && searchMatchIds.length > 0) {
                        jumpToMatch(searchMatchIndex + 1);
                      }
                    }
                    if (e.key === "Escape") { setResponseSearchMode(null); setResponseSearchQuery(""); setSearchMatchIndex(0); setSearchHistoryDropdown(null); }
                  }}
                  placeholder={responseSearchMode === "extract" ? "抽出ワード (Enter:履歴保存)" : "検索ワード (Enter/↓:次へ)"}
                />
                <button
                  className="search-history-btn"
                  onClick={(e) => { e.stopPropagation(); setSearchHistoryDropdown((prev) => prev?.type === "response" ? null : { type: "response" }); }}
                  title="検索履歴"
                ><ChevronDown size={10} /></button>
                {searchHistoryDropdown?.type === "response" && responseSearchHistory.length > 0 && (
                  <div className="search-history-dropdown" onMouseDown={(e) => e.preventDefault()}>
                    {responseSearchHistory
                      .filter((w) => !responseSearchQuery.trim() || w.toLowerCase().includes(responseSearchQuery.trim().toLowerCase()))
                      .map((w) => (
                        <div
                          key={w}
                          className="search-history-item"
                          onClick={() => { setResponseSearchQuery(w); setSearchHistoryDropdown(null); }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const p = { x: e.clientX, y: e.clientY };
                            setSearchHistoryMenu({ x: p.x, y: p.y, type: "response", word: w });
                          }}
                        >{w}</div>
                      ))}
                  </div>
                )}
              </div>
              {responseSearchMode === "in-thread" && (
                <>
                  <span className="match-counter">{searchMatchIds.length === 0 ? "0/0" : `${searchMatchIndex + 1}/${searchMatchIds.length}`}</span>
                  <button className="title-action-btn" onClick={() => jumpToMatch(searchMatchIndex - 1)} disabled={searchMatchIds.length === 0} title="前のヒット"><ChevronUp size={14} /></button>
                  <button className="title-action-btn" onClick={() => jumpToMatch(searchMatchIndex + 1)} disabled={searchMatchIds.length === 0} title="次のヒット"><ChevronDown size={14} /></button>
                </>
              )}
              {responseSearchQuery && <button className="title-action-btn" onClick={() => setResponseSearchQuery("")} title="クリア"><X size={14} /></button>}
              <button className="title-action-btn" onClick={() => { setResponseSearchMode(null); setResponseSearchQuery(""); setSearchMatchIndex(0); }} title="閉じる"><X size={14} /></button>
            </div>
          )}
          <div
            className="response-layout"
          >
            <div
              className={`response-scroll th-container${responseDividerAlways ? " always-divider" : ""}${responsePaneSettling ? " settling" : ""}`}
              ref={responseScrollRef}
              style={{ '--response-gap': `${responseGap}px` } as React.CSSProperties}
              onScroll={onResponseScroll}
              onContextMenu={onResponseAreaContextMenu}
              onClick={(e) => {
                if (handleBodyContentClick(e)) return;
                const target = e.target as HTMLElement;
                const anchor = target.closest<HTMLElement>(".anchor-ref");
                if (!anchor) return;
                const ids = getAnchorIds(anchor);
                const first = ids.find((id) => responseItems.some((r) => r.id === id));
                if (first) {
                  setSelectedResponse(first);
                  setAnchorPopup(null);
                  setStatus(`jumped to >>${first}`);
                }
              }}
              onMouseMove={(e) => {
                const target = e.target as HTMLElement;
                const thumb = target.closest<HTMLImageElement>("img.response-thumb");
                if ((!e.ctrlKey && !hoverPreviewEnabled) || !thumb) return;
                const src = thumb.getAttribute("src");
                if (!src) return;
                showHoverPreview(src);
              }}
              onMouseOver={(e) => {
                const target = e.target as HTMLElement;
                const anchor = target.closest<HTMLElement>(".anchor-ref");
                if (!anchor) { return; }
                const ids = getAnchorIds(anchor).filter((id) => responseItems.some((r) => r.id === id));
                if (ids.length > 0) {
                  if (anchorPopupCloseTimer.current) {
                    clearTimeout(anchorPopupCloseTimer.current);
                    anchorPopupCloseTimer.current = null;
                  }
                  const rect = anchor.getBoundingClientRect();
                  const popupWidth = Math.min(620, window.innerWidth - 24);
                  const x = Math.max(8, Math.min(rect.left, window.innerWidth - popupWidth - 8));
                  setAnchorPopup({ x, y: rect.bottom + 1, anchorTop: rect.top, responseIds: ids });
                }
              }}
              onMouseOut={(e) => {
                const target = e.target as HTMLElement;
                // Hide hover preview when mouse leaves thumb (hover mode)
                if (hoverPreviewEnabled && target.closest("img.response-thumb")) {
                  const next = e.relatedTarget as HTMLElement | null;
                  if (!next?.closest(".hover-preview")) {
                    if (hoverPreviewShowTimerRef.current) { clearTimeout(hoverPreviewShowTimerRef.current); hoverPreviewShowTimerRef.current = null; }
                    if (hoverPreviewHideTimerRef.current) clearTimeout(hoverPreviewHideTimerRef.current);
                    hoverPreviewHideTimerRef.current = setTimeout(() => {
                      hoverPreviewSrcRef.current = null;
                      hoverPreviewHideTimerRef.current = null;
                      if (hoverPreviewRef.current) hoverPreviewRef.current.style.display = "none";
                    }, 300);
                  }
                }
                if (!target.closest(".anchor-ref")) return;
                const next = e.relatedTarget as HTMLElement | null;
                if (next?.closest(".anchor-popup")) return;
                if (anchorPopupCloseTimer.current) clearTimeout(anchorPopupCloseTimer.current);
                anchorPopupCloseTimer.current = setTimeout(() => {
                  setAnchorPopup(null);
                  setNestedPopups([]);
                  anchorPopupCloseTimer.current = null;
                }, 150);
              }}
            >
              {responsesLoading && (
                <div className="response-loading">読み込み中...</div>
              )}
              {visibleResponseItems.map((r) => {
                const id = extractId(r.time);
                const count = id ? (idCountMap.get(id) ?? 0) : 0;
                const isNew = newResponseStart !== null && r.id >= newResponseStart;
                const isFirstNew = isNew && r.id === newResponseStart;
                const isAa = aaOverrides.has(r.id) ? aaOverrides.get(r.id) : isAsciiArt(r.text);
                const ngHit = ngResultMap.get(r.id);
                const isAbone = ngHit?.mode === "abone";
                return (
                  <Fragment key={r.id}>
                  {isFirstNew && (
                    <div className="new-response-separator">
                      <span>ここから新着</span>
                    </div>
                  )}
                  <div
                    data-response-no={r.id}
                    className={`response-block rcon ${selectedResponse === r.id ? "selected" : ""}${myPostNos.has(r.id) ? " my-post mark-myself" : ""}${replyToMeNos.has(r.id) ? " reply-to-me mark-anchor" : ""}${isNew ? " newly" : ""}${isAa ? " aa" : ""}${mainHeaderAllHidden ? " no-header" : ""}`}
                    onClick={() => setSelectedResponse(r.id)}
                    onDoubleClick={() => appendComposeQuote(`>>${r.id}`)}
                  >
                    <div className="response-header rh">
                      {mainHeaderVis.resNo && (
                        <span className="response-no res-num" onClick={(e) => onResponseNoClick(e, r.id)}>
                          {r.id}
                        </span>
                      )}
                      {myPostNos.has(r.id) && <span className="my-post-label">[自分]</span>}
                      {replyToMeNos.has(r.id) && <span className="reply-to-me-label">[自分宛]</span>}
                      {mainHeaderVis.name && (
                        <>
                          <span className="response-label">名前：</span>
                          {isAbone ? (
                            <span className="response-name res-name mname">あぼ～ん</span>
                          ) : (
                            <span
                              className="response-name res-name mname"
                              style={(() => {
                                const hl = textHighlights.find((h) => h.type === "name" && h.pattern === r.nameWithoutWatchoi);
                                return hl ? { background: hl.color } : undefined;
                              })()}
                              dangerouslySetInnerHTML={renderHighlightedPlainText(r.nameWithoutWatchoi, responseSearchQuery)}
                            />
                          )}
                        </>
                      )}
                      {mainHeaderVis.mail && (isAbone || r.mail) && (
                        <span className={`response-mail res-mail${r.mail === "sage" ? " response-mail-sage sage" : ""}`}>[{isAbone ? "あぼ～ん" : r.mail}]</span>
                      )}
                      {mainHeaderVis.watchoi && r.watchoi && (
                        <span
                          className="response-watchoi"
                          onClick={(e) => {
                            e.stopPropagation();
                            const p = { x: e.clientX, y: e.clientY };
                            setWatchoiMenu({ x: p.x, y: p.y, watchoi: r.watchoi! });
                          }}
                        >
                          ({r.watchoi})
                        </span>
                      )}
                      {backRefMap.has(r.id) && (
                        <span
                          className="back-ref-trigger res-replies"
                          onMouseEnter={(e) => {
                            const rect = (e.target as HTMLElement).getBoundingClientRect();
                            setBackRefPopup({ x: rect.left, y: rect.top - 4, anchorTop: rect.top, responseIds: backRefMap.get(r.id)! });
                          }}
                        >
                          ▼{backRefMap.get(r.id)!.length}
                        </span>
                      )}
                      <span className="response-header-right">
                        {isNew && <span className="response-new-marker">New!</span>}
                        {mainHeaderVis.date && (
                          <>
                            <span className="response-label">投稿日：</span>
                            {isAbone ? (
                              <span className="response-date res-date">あぼ～ん</span>
                            ) : (
                              <span
                                className="response-date res-date"
                                dangerouslySetInnerHTML={renderHighlightedPlainText(formatResponseDate(r.time), responseSearchQuery)}
                              />
                            )}
                          </>
                        )}
                        {id && (mainHeaderVis.id || mainHeaderVis.count) && (
                          <span className="res-col" data-type="id">
                            {mainHeaderVis.id && (
                            <span
                              className="response-id-cell rc-id"
                              style={{ color: idHighlights[id] ?? undefined, ...(resIdFontSize !== 0 ? { fontSize: `${Math.max(6, responsesFontSize + resIdFontSize)}px` } : {}), ...(resIdFontFamily ? { fontFamily: `"${resIdFontFamily}", sans-serif` } : {}) }}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (idPopupCloseTimer.current) { clearTimeout(idPopupCloseTimer.current); idPopupCloseTimer.current = null; }
                                const p = { x: e.clientX, y: e.clientY };
                                setIdMenu({ x: p.x, y: p.y, id });
                              }}
                              onMouseEnter={(e) => {
                                if (idPopupCloseTimer.current) { clearTimeout(idPopupCloseTimer.current); idPopupCloseTimer.current = null; }
                                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                setIdPopup({ anchorLeft: rect.left, anchorRight: rect.right, anchorY: rect.top, id });
                              }}
                              onMouseLeave={() => {
                                idPopupCloseTimer.current = setTimeout(() => setIdPopup(null), 150);
                              }}
                            >
                              ID:{id}
                            </span>
                            )}
                            {mainHeaderVis.count && (
                            <span
                              className={`response-id-count cnt${count >= 5 ? " id-count-many" : count >= 2 ? " id-count-some" : ""}`}
                            >
                              ({idSeqMap.get(r.id) ?? 1}/{count})
                            </span>
                            )}
                          </span>
                        )}
                        {r.beNumber && (
                          <button
                            type="button"
                            className="response-be-link"
                            onClick={(e) => {
                              e.stopPropagation();
                              const p = { x: e.clientX, y: e.clientY };
                              setBeMenu({ x: p.x, y: p.y, beNumber: r.beNumber! });
                            }}
                          >
                            BE:{r.beNumber}
                          </button>
                        )}
                      </span>
                    </div>
                    {isAbone ? (
                      <div className="response-body rb">
                        <span className="ng-abone-text" title={ngHit?.reason ?? "あぼ～ん"}>あぼ～ん</span>
                      </div>
                    ) : (
                      <div className={`response-body rb${isAa ? " aa" : ""}`} dangerouslySetInnerHTML={responseBodyHtmlMap.get(r.id) ?? { __html: "" }} />
                    )}
                  </div>
                  </Fragment>
                );
              })}
            </div>
          </div>
        </section>
        )}
        </div>
        </div>{/* /right-body */}
      </main>
      <section
        ref={composeSectionRef}
        className={`compose-window postform${composeOpen ? " compose-window--open" : ""}${chatTarget ? ` compose-chat compose-chat--${chatTarget.platform}` : ""}`}
        aria-label="書き込み"
        style={composeOpen ? { height: composePanelPx } : undefined}
      >
        {composeOpen && (
          <div
            className="compose-resize-handle"
            onMouseDown={(e) => {
              e.preventDefault();
              resizeDragRef.current = { mode: "compose-resize", startY: e.clientY, startHeight: composePanelPx };
              document.body.style.userSelect = "none";
              document.body.style.cursor = "row-resize";
            }}
          />
        )}
        <header
          className="compose-header"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("button")) return;
            setComposeOpen((v) => !v);
          }}
        >
          {composeOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          {composeOpen && !chatTarget && (
            <>
              <button className={`compose-mode-btn ${!composePreview ? "active" : ""}`} onClick={() => setComposePreview(false)}>本文</button>
              <button className={`compose-mode-btn ${composePreview ? "active" : ""}`} onClick={() => setComposePreview(true)}>プレビュー</button>
            </>
          )}
          {chatTarget && !composeOpen && <span className="compose-chat-target compose-chat-target-closed">送信先: <b>{chatTargetLabel(chatTarget)}</b></span>}
          {!chatTarget && !composeOpen && <span className="compose-chat-target compose-chat-target-closed">送信先: <b>{activeComposeUrl ? composeTargetLabelOf(activeComposeUrl, activeComposeTitle) : "なし"}</b></span>}
        </header>
        {composeOpen && activePaneView === "viewer" && (
          <div className="compose-row compose-target-select">
            <span className="compose-label">送信先</span>
            <select value={viewerTargetOpen ? viewerComposeTarget : ""} onChange={(e) => setViewerComposeTarget(e.target.value)} aria-label="書き込みの送信先">
              <option value="">(選んでください)</option>
              {threadTabs.map((t) => <option key={t.threadUrl} value={t.threadUrl}>{composeTargetLabelOf(t.threadUrl, t.title)}</option>)}
            </select>
            <span className="compose-target-hint">ビュワーでは、ここで選んだ所に書き込みます (スレのタブの選択とは別)</span>
          </div>
        )}
        {composeOpen && chatTarget && (
          <div className="compose-chat-body">
            {(() => {
              const targetEl = (
                <span className="compose-chat-target" title={chatTarget.url}>
                  送信先: <b>{chatTargetLabel(chatTarget)}</b>
                  {chatTarget.platform === "twitch" && twitchAuth.loggedIn && <span className="compose-chat-login">（ログイン: {twitchAuth.login}）</span>}
                  {chatTarget.platform === "youtube" && youtubeAuth.loggedIn && <span className="compose-chat-login">（ログイン: {youtubeAuth.channelTitle}）</span>}
                </span>
              );
              const canWrite = chatTarget.platform === "twitch" ? twitchAuth.loggedIn && !!twitchAuth.canChat : youtubeAuth.loggedIn;
              const max = chatMaxChars(chatTarget);
              return canWrite ? (
                <div className="compose-row compose-chat-row">
                  {targetEl}
                  <span className="compose-meta-inline">
                    <span className={Array.from(composeBody.trim()).length > max ? "compose-chat-over" : ""}>{Array.from(composeBody.trim()).length}/{max}文字</span>
                  </span>
                  <span className="compose-chat-spacer" />
                  <span className="compose-chat-actions">
                    <button
                      ref={chatStampBtnRef}
                      className={`compose-chat-stamp-btn${chatPicker ? " active" : ""}`}
                      onClick={() => { setChatPicker((v) => !v); setChatPickerTab(chatTarget.platform === "twitch" ? "all" : "emoji"); }}
                      title={chatTarget.platform === "twitch" ? "スタンプ・絵文字の一覧を開く" : "絵文字の一覧を開く"}
                      aria-expanded={chatPicker}
                    ><Smile size={15} aria-hidden="true" />{chatTarget.platform === "twitch" ? "スタンプ" : "絵文字"}</button>
                    <button className="postform-write compose-chat-send" onClick={sendChatFromCompose} disabled={composeSubmitting} title={`${chatTargetLabel(chatTarget)} に送信 (Ctrl+Enter)`}>{composeSubmitting ? "送信中..." : `${chatTargetLabel(chatTarget)} に送信 (Ctrl+Enter)`}</button>
                  </span>
                </div>
              ) : <div className="compose-row compose-chat-row">{targetEl}</div>;
            })()}
            {chatTarget.platform === "youtube" && !youtubeAuth.loggedIn ? (
              <div className="compose-chat-note">
                YouTube に書き込むには、Google アカウントでログインしてください (自分で作った OAuth クライアントが要ります)。
                <button onClick={() => { setSettingsOpen(true); switchSettingsCategory("youtube"); setSettingsSection("write"); }}>設定 &gt; YouTube &gt; 書き込み を開く</button>
              </div>
            ) : chatTarget.platform === "twitch" && (!twitchAuth.loggedIn || !twitchAuth.canChat) ? (
              <div className="compose-chat-note">
                {twitchAuth.loggedIn ? "書き込むには、Twitch にログインし直してください (書き込みの許可を追加しました)。" : "Twitch に書き込むには、Twitch にログインしてください。"}
                <button onClick={() => { setSettingsOpen(true); switchSettingsCategory("twitch"); setSettingsSection("login"); }}>設定 &gt; Twitch &gt; ログイン を開く</button>
              </div>
            ) : (
              <>
                {composeReply && composeReply.url === chatTarget.url && (
                  <div className="compose-chat-reply">
                    返信先: <b>{composeReply.name}</b>「{Array.from(composeReply.text).slice(0, 60).join("")}」
                    <button onClick={() => setComposeReply(null)} title="返信をやめる">×</button>
                  </div>
                )}
                <textarea
                  ref={composeTextareaRef}
                  className="compose-body compose-chat-input"
                  value={composeBody}
                  onChange={(e) => { setComposeBody(e.target.value); chatCompleteRef.current = null; }}
                  onKeyDown={onComposeBodyKeyDown}
                  placeholder={chatTarget.platform === "twitch"
                    ? `${chatTargetLabel(chatTarget)} へのメッセージ (Ctrl+Enter で送信・Enter では送りません・Tab でスタンプ名と @名前 を補完)`
                    : `${chatTargetLabel(chatTarget)} へのメッセージ (${CHAT_MAX_CHARS_YOUTUBE} 文字まで。Ctrl+Enter で送信・Enter では送りません・Tab で @名前 を補完。1回の送信で API を ${YOUTUBE_INSERT_COST} 使います)`}
                  autoFocus
                  style={{ fontSize: `${composeFontSize}px` }}
                />
                {(() => {
                  const html = composeBody.trim() ? chatComposePreviewHtml() : "";
                  return html.includes("<img") ? <div className="compose-chat-meta">見た目: <span className="compose-chat-preview" dangerouslySetInnerHTML={{ __html: html }} /></div> : null;
                })()}
                {chatPicker && chatPickerPos && (() => {
                  const q = chatPickerQuery.trim().toLowerCase();
                  // YouTube には自分のスタンプの一覧が無いので、絵文字だけにする
                  const isTwitch = chatTarget.platform === "twitch";
                  const pickerChannel = chatTarget.platform === "twitch" ? chatTarget.channel : "";
                  const match = (e: UserEmote) => !q || e.name.toLowerCase().includes(q);
                  const byName = new Map(userEmotes.list.map((e) => [e.name, e]));
                  type Group = { key: string; label: string; emotes?: UserEmote[]; emoji?: { label: string; list: string[] }[] };
                  // チャンネルごと (開いているチャンネルを先頭に。持ち主のチャンネル名で比べる)
                  const owners = new Map<string, UserEmote[]>();
                  for (const e of userEmotes.list) {
                    if (!match(e)) continue;
                    const k = e.owner || "";
                    if (!owners.has(k)) owners.set(k, []);
                    owners.get(k)!.push(e);
                  }
                  const isHere = (k: string) => ((owners.get(k)?.[0]?.ownerLogin ?? k.toLowerCase()) === pickerChannel ? 0 : 1);
                  const ownerKeys = [...owners.keys()].filter((k) => k).sort((x, y) => isHere(x) - isHere(y) || x.localeCompare(y));
                  const channelGroups: Group[] = ownerKeys.map((k) => ({ key: `o:${k}`, label: k, emotes: owners.get(k)! }));
                  const globalGroup: Group[] = owners.get("")?.length ? [{ key: "global", label: "グローバル・その他", emotes: owners.get("")! }] : [];
                  const recent = recentChatEmotes.map((n) => byName.get(n)).filter((e): e is UserEmote => !!e && match(e));
                  const groups: Group[] =
                    !isTwitch ? [{ key: "emoji", label: "絵文字", emoji: CHAT_EMOJI_GROUPS }]
                    : chatPickerTab === "recent" ? (recent.length ? [{ key: "recent", label: "最近使ったもの", emotes: recent }] : [])
                    : chatPickerTab === "channel" ? channelGroups.filter((g) => isHere(g.label) === 0)
                    : chatPickerTab === "global" ? globalGroup
                    : chatPickerTab === "emoji" ? [{ key: "emoji", label: "絵文字", emoji: CHAT_EMOJI_GROUPS }]
                    : [...channelGroups, ...globalGroup];
                  const emptyText = chatPickerTab === "recent" ? "まだ使ったスタンプはありません"
                    : chatPickerTab === "channel" ? `#${pickerChannel} のスタンプで使えるものはありません`
                    : q ? "見つかりません" : "";
                  const TABS: { id: ChatPickerTab; label: string; icon: React.ReactNode }[] = !isTwitch ? [{ id: "emoji", label: "絵文字", icon: <Smile size={16} /> }] : [
                    { id: "recent", label: "最近使ったもの", icon: <Star size={16} /> },
                    { id: "channel", label: `このチャンネル (#${pickerChannel})`, icon: <Tv size={16} /> },
                    { id: "all", label: "すべて", icon: <LayoutGrid size={16} /> },
                    { id: "global", label: "グローバル", icon: <Globe size={16} /> },
                    { id: "emoji", label: "絵文字", icon: <Smile size={16} /> },
                  ];
                  return (
                    <div
                      ref={chatPickerRef}
                      className="chat-picker"
                      style={{ right: chatPickerPos.right, bottom: chatPickerPos.bottom, width: chatPickerPos.width, maxHeight: chatPickerPos.maxHeight, "--chat-cell": `${chatCell}px` } as React.CSSProperties}
                      role="dialog"
                      aria-label="スタンプ・絵文字"
                    >
                      <div className="chat-picker-scroll" ref={chatPickerScrollRef}>
                        {isTwitch && userEmotes.error && chatPickerTab !== "emoji" && <div className="compose-chat-note">{userEmotes.error}</div>}
                        {isTwitch && !userEmotes.error && userEmotes.at === 0 && chatPickerTab !== "emoji" && <div className="compose-chat-note">スタンプの一覧を読み込んでいます…</div>}
                        {groups.length === 0 && emptyText && userEmotes.at > 0 && <div className="compose-chat-note">{emptyText}</div>}
                        {groups.map((g) => (
                          <div key={g.key} className="chat-picker-group">
                            <div className="chat-picker-group-head">
                              {g.emotes?.[0] ? <img src={chatEmoteImg(g.emotes[0].id)} alt="" referrerPolicy="no-referrer" /> : <span className="chat-picker-group-icon">{g.key === "emoji" ? "😀" : "★"}</span>}
                              <span className="chat-picker-group-name">{g.label}</span>
                              {g.emotes && g.key !== "recent" && <span className="chat-picker-platform">Twitch</span>}
                            </div>
                            {g.emotes && (
                              <div className="chat-picker-grid">
                                {g.emotes.slice(0, 600).map((e) => (
                                  <button key={e.id} className="chat-picker-item" title={e.name} onClick={() => pickChatEmote(e.name)} onMouseEnter={() => setChatPickerHover(e.name)}>
                                    <img src={chatEmoteImg(e.id)} alt={e.name} loading="lazy" referrerPolicy="no-referrer" />
                                  </button>
                                ))}
                              </div>
                            )}
                            {g.emoji?.map((eg) => (
                              <div key={eg.label}>
                                <div className="chat-picker-subtitle">{eg.label}</div>
                                <div className="chat-picker-grid">
                                  {eg.list.map((em) => <button key={em} className="chat-picker-item chat-picker-emoji" onClick={() => insertIntoCompose(em)} onMouseEnter={() => setChatPickerHover(em)}>{em}</button>)}
                                </div>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                      <div className="chat-picker-foot">{chatPickerHover || "押すと入力欄に入ります (続けて選べます。Esc で閉じる)"}</div>
                      <input type="text" className="chat-picker-search" value={chatPickerQuery} onChange={(e) => setChatPickerQuery(e.target.value)} placeholder="スタンプを検索" disabled={chatPickerTab === "emoji"} />
                      <div className="chat-picker-tabs" role="tablist">
                        {TABS.map((t) => (
                          <button key={t.id} role="tab" aria-selected={chatPickerTab === t.id} className={`chat-picker-tab${chatPickerTab === t.id ? " active" : ""}`} title={t.label} onClick={() => { setChatPickerTab(t.id); chatPickerScrollRef.current?.scrollTo({ top: 0 }); }}>{t.icon}</button>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
            {composeResult && (
              <div className={`compose-result ${composeResult.ok ? "compose-result-ok" : "compose-result-err"}`}>
                {composeResult.ok ? "OK" : "NG"}: {composeResult.message}
              </div>
            )}
          </div>
        )}
        {composeOpen && !chatTarget && (
          <>
            <div className="compose-row compose-board-target">
              {activeComposeUrl
                ? <span className="compose-chat-target" title={activeComposeUrl}>送信先: <b>{composeTargetLabelOf(activeComposeUrl, activeComposeTitle)}</b></span>
                : <span className="compose-no-target">{activePaneView === "viewer" && threadTabs.length > 0 ? "上の「送信先」を選ぶと書き込めます" : "スレのタブを開くと書き込めます"}</span>}
            </div>
            <div className="compose-row postform-foot">
              <span className="compose-label">名前</span>
              <input className="compose-input compose-input-name" value={composeName} onChange={(e) => setComposeName(e.target.value)} list="name-history-list" />
              <datalist id="name-history-list">
                {nameHistory.map((n) => <option key={n} value={n} />)}
              </datalist>
              <span className="compose-label">メール</span>
              <input className="compose-input compose-input-mail" value={composeMailValue} onChange={(e) => setComposeMail(e.target.value)} disabled={composeSage} />
              <label className="compose-check">
                <input type="checkbox" checked={composeSage} onChange={(e) => setComposeSage(e.target.checked)} />
                sage
              </label>
              <span className="compose-meta-inline">
                <span>{composeBody.length}文字</span>
                <span>{composeBody.split("\n").length}行</span>
              </span>
              <button className="postform-write" onClick={probePostFlowTraceFromCompose} disabled={composeSubmitting || !activeComposeUrl}>{composeSubmitting ? "送信中..." : `送信 (${composeSubmitKey === "shift" ? "Shift" : "Ctrl"}+Enter)`}</button>
              {diagnosticsEnabled && (
                <button onClick={async () => {
                  setComposeResult({ ok: false, message: "診断中..." });
                  try {
                    const r = await invoke<string>("debug_post_connectivity", { threadUrl });
                    setComposeResult({ ok: true, message: r });
                  } catch (e) {
                    setComposeResult({ ok: false, message: `診断エラー: ${String(e)}` });
                  }
                }} className="lf-fs0_85em">接続診断</button>
              )}
            </div>
            {!composePreview ? (
              <textarea
                className="compose-body"
                value={composeBody}
                onChange={(e) => setComposeBody(e.target.value)}
                onKeyDown={onComposeBodyKeyDown}
                placeholder="本文を入力"
                autoFocus
                style={{ fontSize: `${composeFontSize}px` }}
              />
            ) : (
              <div className="compose-body compose-preview-plain" style={{ fontSize: `${composeFontSize}px` }}>{composePreviewLine()}</div>
            )}
            {composeResult && (
              <div className={`compose-result ${composeResult.ok ? "compose-result-ok" : "compose-result-err"}`}>
                {composeResult.ok ? "OK" : "NG"}: {composeResult.message}
              </div>
            )}
          </>
        )}
      </section>
      <footer className="status-bar">
        {activePaneView === "responses" && activeTabIndex >= 0 && activeTabIndex < threadTabs.length ? (
          <div className="status-nav-bar" style={{ '--fs-delta': `${responsesFontSize - 12}px` } as React.CSSProperties}>
            <span className="nav-info">
              着:{visibleResponseItems.length}{ngFilteredCount > 0 ? `(NG${ngFilteredCount})` : ""}
              {" "}サイズ:{Math.round(visibleResponseItems.reduce((s, r) => s + r.text.length, 0) / 1024)}KB
            </span>
            <span className="link-filter-buttons">
              <button className={`link-filter-btn ${responseLinkFilter === "image" ? "active" : ""}`} onClick={() => setResponseLinkFilter((p) => p === "image" ? "" : "image")} title="画像リンク"><Image size={13} /></button>
              <button className={`link-filter-btn ${responseLinkFilter === "video" ? "active" : ""}`} onClick={() => setResponseLinkFilter((p) => p === "video" ? "" : "video")} title="動画リンク"><Film size={13} /></button>
              <button className={`link-filter-btn ${responseLinkFilter === "link" ? "active" : ""}`} onClick={() => setResponseLinkFilter((p) => p === "link" ? "" : "link")} title="外部リンク"><ExternalLink size={13} /></button>
            </span>
            <span className="nav-buttons">
              <button onClick={() => { if (visibleResponseItems.length > 0) setSelectedResponse(visibleResponseItems[0].id); }}>Top</button>
              {newResponseStart !== null && (
                <button
                  className="nav-new-btn"
                  onClick={() => {
                    const first = visibleResponseItems.find((r) => r.id >= newResponseStart);
                    if (first) setSelectedResponse(first.id);
                  }}
                >
                  New
                </button>
              )}
              <button onClick={() => { if (visibleResponseItems.length > 0) setSelectedResponse(visibleResponseItems[visibleResponseItems.length - 1].id); }}>End</button>
              <input
                className="nav-jump-input"
                placeholder=">>"
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const val = (e.target as HTMLInputElement).value.replace(/^>>?/, "").trim();
                  const no = Number(val);
                  if (no > 0 && visibleResponseItems.some((r) => r.id === no)) {
                    setSelectedResponse(no);
                    (e.target as HTMLInputElement).value = "";
                    setStatus(`>>${no}`);
                  }
                }}
              />
            </span>
          </div>
        ) : (
          <>
            <span className="status-main">{status}</span>
            <span className="status-sep">|</span>
            <span>TS～{visibleThreadItems.length}</span>
            <span className="status-sep">|</span>
            <span>US～{unreadThreadCount}</span>
            <span className="status-sep">|</span>
            <span>Runtime:{runtimeState}</span>
          </>
        )}
      </footer>
      {ngPanelOpen && (
        <section className="ng-panel" role="dialog" aria-label="NGフィルタ">
          <header className="ng-panel-header">
            <strong>NGフィルタ</strong>
            <span className="ng-panel-count">
              {ngFilters.words.length}語 / {ngFilters.ids.length}ID / {ngFilters.names.length}名 / {ngFilters.mails.length}メール / {ngFilters.thread_words.length}スレタイ / {ngFilters.image_words.length}画像
            </span>
            <button onClick={() => setNgPanelOpen(false)}>閉じる</button>
          </header>
          <div className="ng-panel-add">
            <select value={ngInputType} onChange={(e) => setNgInputType(e.target.value as "words" | "ids" | "names" | "mails" | "thread_words" | "image_words" | "regex")}>
              <option value="words">ワード</option>
              <option value="ids">ID</option>
              <option value="names">名前</option>
              <option value="mails">メール</option>
              <option value="thread_words">スレタイ</option>
              <option value="image_words">画像NG</option>
              <option value="regex">正規表現</option>
            </select>
            <input
              value={ngInput}
              onChange={(e) => setNgInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  addNgFromInput();
                }
              }}
              placeholder={ngInputType === "regex" ? "正規表現パターンを入力" : `NG${NG_TYPE_LABELS[ngInputType]}を入力`}
            />
            {ngInputType !== "image_words" && (
              <select value={ngAddMode} onChange={(e) => setNgAddMode(e.target.value as NgMode)} className="ng-mode-select">
                <option value="hide">透明あぼ～ん</option>
                <option value="abone">通常あぼ～ん</option>
              </select>
            )}
            <select value={ngAddScope} onChange={(e) => setNgAddScope(e.target.value as "global" | "board" | "thread")} className="ng-mode-select">
              <option value="global">全体</option>
              <option value="board">この板</option>
              {ngInputType !== "thread_words" && <option value="thread">このスレ</option>}
            </select>
            <button onClick={() => addNgFromInput()}>追加</button>
          </div>
          <div className="ng-panel-lists">
            <div className="ng-list-section">
              <h4>見えない文字を含むレス {ngInvisibleSelect()}</h4>
              <p className="ng-hint">{NG_INVISIBLE_HINT}</p>
            </div>
            {(["words", "ids", "names", "mails", "thread_words", "image_words"] as const).map((type) => (
              <div key={type} className="ng-list-section">
                <h4>{NG_TYPE_LABELS[type]} ({ngFilters[type].length})</h4>
                {type === "image_words" && <p className="ng-hint">本文に指定した単語を含むレスの画像だけを非表示にします。レス自体や本文は表示されたままです。</p>}
                {ngFilters[type].length === 0 ? (
                  <span className="ng-empty">(なし)</span>
                ) : (
                  <ul className="ng-list">
                    {ngFilters[type].map((entry) => {
                      const v = ngVal(entry);
                      const mode = ngEntryMode(entry);
                      const scope = ngEntryScope(entry);
                      const isRegex = v.startsWith("/") && v.endsWith("/") && v.length > 2;
                      return (
                        <li key={v}>
                          {type !== "image_words" && (
                            <select
                              className="ng-mode-select"
                              value={mode}
                              onChange={(e) => updateNgEntryMode(type, v, e.target.value as NgMode)}
                            >
                              <option value="hide">透明あぼ～ん</option>
                              <option value="abone">通常あぼ～ん</option>
                            </select>
                          )}
                          {scope !== "global" && <span className="ng-mode-label" style={{ background: scope === "board" ? "#2a7a2a" : "#2a5a9a", color: "#fff" }}>{scope === "board" ? "板" : "スレ"}</span>}
                          {isRegex && <span className="ng-mode-label lf-bg6b4c9a-c-fff">正規表現</span>}
                          <span>{maskDisplay(v)}</span>
                          <button className="ng-remove" onClick={() => removeNgEntry(type, v)}>×</button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      {threadMenu && (
        <div className="thread-menu" ref={(el) => placeMenuNearCursor(el, threadMenu.x, threadMenu.y)} style={{ left: threadMenu.x, top: threadMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => markThreadRead(threadMenu.threadId, true)}>既読にする</button>
          <button onClick={() => markThreadRead(threadMenu.threadId, false)}>未読にする</button>
          <button onClick={() => void copyThreadUrl(threadMenu.threadId)}>スレURLをコピー</button>
          <button onClick={() => {
            const t = threadItems.find((item) => item.id === threadMenu.threadId);
            if (t) { void navigator.clipboard.writeText(t.title); setStatus("スレタイをコピーしました"); }
            setThreadMenu(null);
          }}>スレタイをコピー</button>
          <button onClick={() => {
            const t = threadItems.find((item) => item.id === threadMenu.threadId);
            if (!t) { setThreadMenu(null); return; }
            const current = customTitles[selectedBoard]?.[t.threadKey] ?? "";
            const input = window.prompt("カスタムタイトルを入力（空欄でリセット）:", current);
            if (input === null) { setThreadMenu(null); return; }
            const newTitle = input.trim() || undefined;
            setCustomTitles((prev) => {
              const next = { ...prev };
              if (!next[selectedBoard]) next[selectedBoard] = {};
              if (newTitle) {
                next[selectedBoard] = { ...next[selectedBoard], [t.threadKey]: newTitle };
              } else {
                const board = { ...next[selectedBoard] };
                delete board[t.threadKey];
                next[selectedBoard] = board;
              }
              return next;
            });
            if (isTauriRuntime()) {
              invoke("set_thread_custom_title", { boardUrl: selectedBoard, threadKey: t.threadKey, title: newTitle ?? null })
                .catch((e) => console.warn("set_thread_custom_title:", e));
            }
            setThreadMenu(null);
          }}>タイトルを変更</button>
          <button onClick={() => {
            const t = threadItems.find((item) => item.id === threadMenu.threadId);
            if (t && "threadUrl" in t && typeof t.threadUrl === "string") {
              void navigator.clipboard.writeText(`${t.title}\n${t.threadUrl}`); setStatus("スレタイとURLをコピーしました");
            }
            setThreadMenu(null);
          }}>スレタイとURLをコピー</button>
          <button onClick={() => {
            const t = threadItems.find((item) => item.id === threadMenu.threadId);
            if (t && "threadUrl" in t && typeof t.threadUrl === "string") {
              window.open(t.threadUrl, "_blank");
            }
            setThreadMenu(null);
          }}>ブラウザで開く</button>
          <button onClick={() => {
            const t = threadItems.find((item) => item.id === threadMenu.threadId);
            if (t) {
              addNgEntry("words", t.title);
            }
            setThreadMenu(null);
          }}>スレタイNGに追加</button>
          <button onClick={() => {
            const t = threadItems.find((item) => item.id === threadMenu.threadId);
            if (t && "threadUrl" in t && typeof t.threadUrl === "string") {
              toggleFavoriteThread({ threadUrl: t.threadUrl, title: t.title });
            }
            setThreadMenu(null);
          }}>
            {(() => {
              const t = threadItems.find((item) => item.id === threadMenu.threadId);
              const isFav = t && "threadUrl" in t && favorites.threads.some((f) => f.threadUrl === t.threadUrl);
              return isFav ? "お気に入り解除" : "お気に入りに追加";
            })()}
          </button>
          <button onClick={() => {
            const t = threadItems.find((item) => item.id === threadMenu.threadId);
            if (t && "threadUrl" in t && typeof t.threadUrl === "string") purgeThreadCache(t.threadUrl);
            setThreadMenu(null);
          }}>キャッシュから削除</button>
        </div>
      )}
      {responseMenu && (() => {
        // レスの右クリックメニュー: 右クリックした物 (リンク・画像・選んだ文字) の項目を一番上に、
        // 残りは種類ごとに「▶」の下へまとめる (マウスを乗せるかクリックで横に開く)
        const nearRight = responseMenu.x > window.innerWidth / 2;
        const subStyle = nearRight ? { left: "auto", right: "100%" } : undefined;
        const subMenu = (key: string, label: React.ReactNode, children: React.ReactNode) => (
          <div className="menu-item-with-sub" data-sub={key}
            onMouseEnter={() => { if (respSubMenu !== key) { setRespSubMenu(key); setHlSubMenu(null); } }}
            onClick={() => setRespSubMenu(key)}
          >
            <span>{label}</span>
            <span className="menu-arrow">{"▶︎"}</span>
            {respSubMenu === key && (
              <div className="thread-menu menu-sub" style={subStyle} ref={fitSubMenu} onClick={(e) => e.stopPropagation()}>
                {children}
              </div>
            )}
          </div>
        );
        const hlTarget = (type: "text" | "id" | "name", value: string, label: React.ReactNode, apply: (color: string) => void) => (
          <div className="menu-item-with-sub"
            onMouseEnter={() => setHlSubMenu({ type, value, nearRight })}
          >
            <span>{label}</span>
            <span className="menu-arrow">{"▶︎"}</span>
            {hlSubMenu?.type === type && hlSubMenu.value === value && (
              <div className="hl-color-grid" style={hlSubMenu.nearRight ? { left: "auto", right: "100%" } : undefined} onClick={(e) => e.stopPropagation()}>
                {HIGHLIGHT_COLORS.map((c) => (
                  <div key={c.color} className="hl-color-cell" style={{ background: c.color }} title={c.name}
                    onClick={() => { apply(c.color); setResponseMenu(null); setHlSubMenu(null); }} />
                ))}
              </div>
            )}
          </div>
        );
        const curUrl = threadTabs[activeTabIndex]?.threadUrl ?? threadUrl;
        // ID 欄を右クリックしたときはその ID、本文などを右クリックしたときはそのレスの ID
        // (レス表示欄で ID を非表示にしていても配信ホワイトリストに登録できるようにするため)
        const wlId = responseMenu.resId ?? extractId(responseItems.find((r) => r.id === responseMenu.responseId)?.time ?? "");
        const twitchMsgId = isTwitchUrl(curUrl) ? twitchMsgIdRef.current.get(curUrl)?.get(responseMenu.responseId) : undefined;
        const canClearId = !!(responseMenu.resId && idHighlights[responseMenu.resId]);
        const canClearText = !!(responseMenu.selection && textHighlights.some((h) => h.pattern === responseMenu.selection && h.type === "word"));
        const canClearName = !!(responseMenu.resName && textHighlights.some((h) => h.pattern === responseMenu.resName && h.type === "name"));
        // コマンド: 使う置き換え文字の値がそろうものだけ出す ($LINK はリンク・画像の上、$TEXT 系は文字を選んでいるとき)
        const cmdLink = responseMenu.linkUrl ?? responseMenu.imageUrl;
        const cmdItems = userCommands.filter((c) => c.enabled
          && (!commandUses(c, "LINK") || !!cmdLink)
          && (!(commandUses(c, "TEXT") || commandUses(c, "TEXTU") || commandUses(c, "TEXTE")) || !!responseMenu.selection));
        const cmdValues = {
          link: cmdLink,
          text: responseMenu.selection,
          url: curUrl || undefined,
          title: threadTabs[activeTabIndex]?.title,
          boardName: boardNameOfUrl(curUrl) || undefined,
          number: responseMenu.responseId > 0 ? String(responseMenu.responseId) : undefined,
        };
        const hasContext = (!!responseMenu.imageUrl && isTauriRuntime()) || !!responseMenu.linkUrl || !!responseMenu.selection || cmdItems.length > 0;
        const hasHighlight = !!(responseMenu.selection || responseMenu.resId || responseMenu.resName);
        const onResNo = !!responseMenu.isOnResNo && responseMenu.responseId > 0;
        return (
        <div ref={(el) => { responseMenuRef.current = el; placeMenuNearCursor(el, responseMenu.x, responseMenu.y); }} className="thread-menu response-menu" style={{ left: responseMenu.x, top: responseMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onMouseLeave={() => { setHlSubMenu(null); setRespSubMenu(null); }}
          onMouseOver={(e) => { if (!(e.target as HTMLElement).closest("[data-sub]")) { if (respSubMenu) setRespSubMenu(null); if (hlSubMenu) setHlSubMenu(null); } }}
        >
          {/* ----- 右クリックした物の項目 ----- */}
          {responseMenu.imageUrl && isTauriRuntime() && (
            <button onClick={() => { void saveImage(responseMenu.imageUrl!); setResponseMenu(null); }}>画像を保存</button>
          )}
          {responseMenu.linkUrl && (
            <button onClick={() => { void navigator.clipboard.writeText(responseMenu.linkUrl!); setStatus("URLをコピーしました"); setResponseMenu(null); }}>URLをコピー</button>
          )}
          {responseMenu.selection && (
            <button onClick={() => { void navigator.clipboard.writeText(responseMenu.selection!); setResponseMenu(null); setStatus("コピーしました"); }}>選択テキストをコピー</button>
          )}
          {responseMenu.selection && (
            <button onClick={() => { addNgEntry("words", responseMenu.selection!); setResponseMenu(null); }}>「{responseMenu.selection.slice(0, 15)}」をNGワードに追加</button>
          )}
          {cmdItems.length > 0 && subMenu("commands", "コマンド", <>
            {cmdItems.map((c) => (
              <button key={c.id} onClick={() => { runUserCommand(c, cmdValues); setResponseMenu(null); }}>{c.name}</button>
            ))}
          </>)}
          {hasContext && <hr className="menu-sep" />}
          {/* ----- 返信・配信ホワイトリスト ----- */}
          {!isChatUrl(curUrl) && <button onClick={() => void runResponseAction("quote")}>ここにレス</button>}
          {twitchMsgId && (
            <button onClick={() => {
              const r = fetchedResponses.find((x) => x.responseNo === responseMenu.responseId);
              setComposeReply({ url: curUrl, id: twitchMsgId, name: r ? decodeHtmlEntities(r.name.replace(/<[^>]*>/g, "")) : "", text: r ? decodeHtmlEntities(r.body.replace(/<[^>]*>/g, " ")) : "" });
              setComposeOpen(true);
              setResponseMenu(null);
              window.setTimeout(() => composeTextareaRef.current?.focus(), 0);
            }}>このコメントに返信</button>
          )}
          <button onClick={() => void runResponseAction("quote-with-name")}>名前付き引用</button>
          {wlId && (
            <button onClick={() => {
              if (broadcastWhitelist[wlId]) removeFromWhitelist(wlId); else addToWhitelist([wlId]);
              setResponseMenu(null);
            }}>{broadcastWhitelist[wlId] ? `ID:${wlId} を配信ホワイトリストから解除` : `ID:${wlId} を配信ホワイトリストに追加`}</button>
          )}
          <hr className="menu-sep" />
          {/* ----- 種類ごとのまとめ ----- */}
          {subMenu("copy", "コピー", <>
            <button onClick={() => void runResponseAction("copy-body")}>本文をコピー</button>
            <button onClick={() => void runResponseAction("copy-url")}>レスURLをコピー</button>
            <button onClick={() => void runResponseAction("copy-id")}>IDをコピー</button>
            <button onClick={() => void copyWholeThread()}>スレ全体をコピー</button>
          </>)}
          {hasHighlight && subMenu("highlight", "ハイライト", <>
            {responseMenu.selection && hlTarget("text", responseMenu.selection, <>「{responseMenu.selection.slice(0, 15)}」</>, (color) => {
              persistTextHighlights([...textHighlights.filter((h) => h.pattern !== responseMenu.selection || h.type !== "word"),
                { pattern: responseMenu.selection!, color, type: "word" as const }]);
            })}
            {responseMenu.resId && hlTarget("id", responseMenu.resId, <>ID:{responseMenu.resId}</>, (color) => {
              persistIdHighlights({ ...idHighlights, [responseMenu.resId!]: color });
            })}
            {responseMenu.resName && hlTarget("name", responseMenu.resName, <>名前「{responseMenu.resName.slice(0, 12)}」</>, (color) => {
              persistTextHighlights([...textHighlights.filter((h) => h.pattern !== responseMenu.resName || h.type !== "name"),
                { pattern: responseMenu.resName!, color, type: "name" as const }]);
            })}
            {(canClearId || canClearText || canClearName) && (
              <button onMouseEnter={() => setHlSubMenu(null)} onClick={() => {
                if (canClearId) persistIdHighlights(Object.fromEntries(Object.entries(idHighlights).filter(([k]) => k !== responseMenu.resId)));
                if (canClearText) persistTextHighlights(textHighlights.filter((h) => !(h.pattern === responseMenu.selection && h.type === "word")));
                if (canClearName) persistTextHighlights(textHighlights.filter((h) => !(h.pattern === responseMenu.resName && h.type === "name")));
                setResponseMenu(null); setHlSubMenu(null);
              }}>ハイライト解除</button>
            )}
          </>)}
          {subMenu("ng", "NG", <>
            <button onClick={() => void runResponseAction("add-ng-id")}>NGIDに追加</button>
            <button onClick={() => void runResponseAction("add-ng-name")}>NG名前に追加</button>
          </>)}
          <hr className="menu-sep" />
          {/* ----- このレスから (レス番号上のみ)・AA ----- */}
          {onResNo && ttsMode !== "off" && (
            <button onClick={() => {
              const startNo = responseMenu.responseId;
              const items = visibleResponseItems.filter((r) => r.id >= startNo);
              const curThreadUrl = threadTabs[activeTabIndex]?.threadUrl ?? threadUrl;
              const site = detectSiteType(curThreadUrl);
              setResponseMenu(null);
              setStatus(`レス ${startNo} から読み上げ開始 (${items.length}件)`);
              void (async () => {
                await ttsStop();
                for (const item of items) {
                  if (!speaksResNo(curThreadUrl, item.id)) continue;
                  const prefix = speakPrefixFor(site, item.id, item.name);
                  const idMatch = item.time.match(/ID:([^\s]+)/);
                  if (ngResultMap.get(item.id)?.mode === "abone") {
                    if (ngAboneSpeakEnabled) ttsSpeak("あぼーん", prefix, undefined, { name: item.name, id: idMatch ? idMatch[1] : "" });
                    continue;
                  }
                  ttsSpeak(item.text, prefix, undefined, { name: item.name, id: idMatch ? idMatch[1] : "" });
                }
              })();
            }}>このレスから読み上げ</button>
          )}
          {/* このレスから新着として流す（レス番号上のみ）: 自動更新で届いた新着と同じ経路で、新着レスペイン・字幕へ流す。
              配信ホワイトリストの ID のレスはビュワー・OBS 表示にも流れる (本物の新着と同じ扱い)。読み上げはしない */}
          {onResNo && (
            <button onClick={() => {
              const startNo = responseMenu.responseId;
              const items = visibleResponseItems.filter((r) => r.id >= startNo);
              const curThreadUrl = threadTabs[activeTabIndex]?.threadUrl ?? threadUrl;
              const tabTitle = threadTabs[activeTabIndex]?.title ?? "";
              setResponseMenu(null);
              const arrivals: ArrivalItem[] = items
                .filter((item) => showsArrivalResNo(curThreadUrl, item.id))
                .map((item) => makeArrival({ responseNo: item.id, name: item.name, mail: item.mail, dateAndId: item.time, body: item.text }, tabTitle, curThreadUrl, fetchedResponses));
              setStatus(`レス ${startNo} から新着として流します (${arrivals.length}件)`);
              if (arrivals.length === 0) return;
              const queueWasEmpty = arrivalQueueRef.current.length === 0;
              arrivalQueueRef.current.push(...arrivals);
              setArrivalQueueCount(arrivalQueueRef.current.length);
              pushBroadcastArrivals(arrivals);
              if (!arrivalPausedRef.current && !arrivalTimerRef.current && (currentArrivalItemRef.current === null || queueWasEmpty)) {
                advanceToNextArrival();
              }
            }} title="このレスから後を、新着レスとして新着レスペイン・字幕に流します (配信ホワイトリストの ID のレスはビュワー・OBS 表示にも流れます)">このレスから新着として流す</button>
          )}
          <button onClick={() => void runResponseAction("toggle-aa")}>
            {(() => {
              const rid = responseMenu.responseId;
              const override = aaOverrides.get(rid);
              const resp = responseItems.find((r) => r.id === rid);
              const auto = resp ? isAsciiArt(resp.text) : false;
              const active = override !== undefined ? override : auto;
              return active ? "AA表示: ON → OFF" : "AA表示: OFF → ON";
            })()}
          </button>
          <hr className="menu-sep" />
          {/* ----- 読み上げの停止 (急ぐときのため上の段)・切り替え ----- */}
          <button onClick={() => { void ttsStop(); setResponseMenu(null); }}>読み上げを今すぐ停止</button>
          {subMenu("toggle", "切り替え", <>
            <button onClick={() => { setAutoRefreshEnabled(!autoRefreshEnabled); setResponseMenu(null); }}>
              {autoRefreshEnabled ? "✓" : "　"} オートリロード
            </button>
            <button onClick={() => { setAutoScrollEnabled(!autoScrollEnabled); setResponseMenu(null); }}>
              {autoScrollEnabled ? "✓" : "　"} オートスクロール
            </button>
            <button onClick={() => { setTtsEnabled(!ttsEnabled); setResponseMenu(null); }}>
              {ttsEnabled ? "✓" : "　"} 読み上げ
            </button>
          </>)}
        </div>
        );
      })()}
      {linkMenu && (() => {
        // リンクの値だけで使えるコマンド ($LINK と、文字を選んでいれば $TEXT 系。スレの情報を使うものはここでは出さない)
        const items = userCommands.filter((c) => c.enabled
          && !["URL", "TITLE", "BOARDNAME", "NUMBER"].some((n) => commandUses(c, n))
          && (!(commandUses(c, "TEXT") || commandUses(c, "TEXTU") || commandUses(c, "TEXTE")) || !!linkMenu.selection));
        const nearRight = linkMenu.x > window.innerWidth / 2;
        return (
        <div className="thread-menu link-menu" ref={(el) => placeMenuNearCursor(el, linkMenu.x, linkMenu.y)} style={{ left: linkMenu.x, top: linkMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onMouseLeave={() => setRespSubMenu(null)}
          onMouseOver={(e) => { if (!(e.target as HTMLElement).closest("[data-sub]") && respSubMenu) setRespSubMenu(null); }}
        >
          <button onClick={() => { void navigator.clipboard.writeText(linkMenu.url); setStatus("URLをコピーしました"); setLinkMenu(null); }}>URLをコピー</button>
          {items.length > 0 && (
            <div className="menu-item-with-sub" data-sub="linkcmd" onMouseEnter={() => setRespSubMenu("linkcmd")} onClick={() => setRespSubMenu("linkcmd")}>
              <span>コマンド</span>
              <span className="menu-arrow">{"\u25B6\uFE0E"}</span>
              {respSubMenu === "linkcmd" && (
                <div className="thread-menu menu-sub" style={nearRight ? { left: "auto", right: "100%" } : undefined} ref={fitSubMenu} onClick={(e) => e.stopPropagation()}>
                  {items.map((c) => (
                    <button key={c.id} onClick={() => { runUserCommand(c, { link: linkMenu.url, text: linkMenu.selection }); setLinkMenu(null); }}>{c.name}</button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        );
      })()}
      {viewerMenu && (() => {
        const m = viewerMenu;
        const tabIdx = threadTabs.findIndex((t) => t.threadUrl === m.threadUrl);
        // コマンド: レス表示欄と同じく、使う置き換え文字の値がそろうものだけ出す
        const items = userCommands.filter((c) => c.enabled
          && (!commandUses(c, "LINK") || !!m.linkUrl)
          && (!(commandUses(c, "TEXT") || commandUses(c, "TEXTU") || commandUses(c, "TEXTE")) || !!m.selection));
        const values = {
          link: m.linkUrl,
          text: m.selection,
          url: m.threadUrl || undefined,
          title: m.title || undefined,
          boardName: boardNameOfUrl(m.threadUrl) || undefined,
          number: m.no > 0 ? String(m.no) : undefined,
        };
        const nearRight = m.x > window.innerWidth / 2;
        const copy = (text: string, msg: string) => { void navigator.clipboard.writeText(text); setStatus(msg); setViewerMenu(null); };
        // ハイライト: レス表示欄の「ハイライト ▶」と同じ (色は決まった15色から)
        const hlTarget = (type: "text" | "id" | "name", value: string, label: React.ReactNode, apply: (color: string) => void) => (
          <div className="menu-item-with-sub" onMouseEnter={() => setHlSubMenu({ type, value, nearRight })}>
            <span>{label}</span>
            <span className="menu-arrow">{"\u25B6\uFE0E"}</span>
            {hlSubMenu?.type === type && hlSubMenu.value === value && (
              <div className="hl-color-grid" style={hlSubMenu.nearRight ? { left: "auto", right: "100%" } : undefined} onClick={(e) => e.stopPropagation()}>
                {HIGHLIGHT_COLORS.map((c) => (
                  <div key={c.color} className="hl-color-cell" style={{ background: c.color }} title={c.name}
                    onClick={() => { apply(c.color); setViewerMenu(null); setHlSubMenu(null); }} />
                ))}
              </div>
            )}
          </div>
        );
        const canClearId = !!(m.uid && idHighlights[m.uid]);
        const canClearText = !!(m.selection && textHighlights.some((h) => h.pattern === m.selection && h.type === "word"));
        const canClearName = !!(m.name && textHighlights.some((h) => h.pattern === m.name && h.type === "name"));
        return (
        <div className="thread-menu viewer-menu" ref={(el) => placeMenuNearCursor(el, m.x, m.y)} style={{ left: m.x, top: m.y }}
          onClick={(e) => e.stopPropagation()}
          onMouseLeave={() => { setRespSubMenu(null); setHlSubMenu(null); }}
          onMouseOver={(e) => { if (!(e.target as HTMLElement).closest("[data-sub]")) { if (respSubMenu) setRespSubMenu(null); if (hlSubMenu) setHlSubMenu(null); } }}
        >
          <button disabled={tabIdx < 0} onClick={() => {
            setViewerMenu(null);
            onTabClick(tabIdx);
            setSelectedResponse(m.no);
          }}>{tabIdx < 0 ? "(タブを閉じています)" : m.chat ? "このタブへ移動" : "このレスへ移動"}</button>
          <hr className="menu-sep" />
          {m.linkUrl && <button onClick={() => copy(m.linkUrl!, "URLをコピーしました")}>URLをコピー</button>}
          {m.selection && <button onClick={() => copy(m.selection!, "コピーしました")}>選択テキストをコピー</button>}
          {m.text && <button onClick={() => copy(m.text, "本文をコピーしました")}>本文をコピー</button>}
          {items.length > 0 && (
            <div className="menu-item-with-sub" data-sub="viewercmd" onMouseEnter={() => { setRespSubMenu("viewercmd"); setHlSubMenu(null); }} onClick={() => setRespSubMenu("viewercmd")}>
              <span>コマンド</span>
              <span className="menu-arrow">{"▶︎"}</span>
              {respSubMenu === "viewercmd" && (
                <div className="thread-menu menu-sub" style={nearRight ? { left: "auto", right: "100%" } : undefined} ref={fitSubMenu} onClick={(e) => e.stopPropagation()}>
                  {items.map((c) => (
                    <button key={c.id} onClick={() => { runUserCommand(c, values); setViewerMenu(null); }}>{c.name}</button>
                  ))}
                </div>
              )}
            </div>
          )}
          {(m.selection || m.uid || m.name) && (
            <div className="menu-item-with-sub" data-sub="viewerhl"
              onMouseEnter={() => { if (respSubMenu !== "viewerhl") { setRespSubMenu("viewerhl"); setHlSubMenu(null); } }}
              onClick={() => setRespSubMenu("viewerhl")}
            >
              <span>ハイライト</span>
              <span className="menu-arrow">{"\u25B6\uFE0E"}</span>
              {respSubMenu === "viewerhl" && (
                <div className="thread-menu menu-sub" style={nearRight ? { left: "auto", right: "100%" } : undefined} ref={fitSubMenu} onClick={(e) => e.stopPropagation()}>
                  {m.selection && hlTarget("text", m.selection, <>「{m.selection.slice(0, 15)}」</>, (color) => {
                    persistTextHighlights([...textHighlights.filter((h) => h.pattern !== m.selection || h.type !== "word"),
                      { pattern: m.selection!, color, type: "word" as const }]);
                  })}
                  {m.uid && hlTarget("id", m.uid, <>ID:{m.uid}</>, (color) => {
                    persistIdHighlights({ ...idHighlights, [m.uid!]: color });
                  })}
                  {m.name && hlTarget("name", m.name, <>名前「{m.name.slice(0, 12)}」</>, (color) => {
                    persistTextHighlights([...textHighlights.filter((h) => h.pattern !== m.name || h.type !== "name"),
                      { pattern: m.name!, color, type: "name" as const }]);
                  })}
                  {(canClearId || canClearText || canClearName) && (
                    <button onMouseEnter={() => setHlSubMenu(null)} onClick={() => {
                      if (canClearId) persistIdHighlights(Object.fromEntries(Object.entries(idHighlights).filter(([k]) => k !== m.uid)));
                      if (canClearText) persistTextHighlights(textHighlights.filter((h) => !(h.pattern === m.selection && h.type === "word")));
                      if (canClearName) persistTextHighlights(textHighlights.filter((h) => !(h.pattern === m.name && h.type === "name")));
                      setViewerMenu(null); setHlSubMenu(null);
                    }}>ハイライト解除</button>
                  )}
                </div>
              )}
            </div>
          )}
          {m.uid && !m.chat && (
            <>
              <hr className="menu-sep" />
              <button onClick={() => {
                if (broadcastWhitelist[m.uid!]) removeFromWhitelist(m.uid!); else addToWhitelist([m.uid!]);
                setViewerMenu(null);
              }}>{broadcastWhitelist[m.uid] ? `ID:${m.uid} を配信ホワイトリストから解除` : `ID:${m.uid} を配信ホワイトリストに追加`}</button>
            </>
          )}
        </div>
        );
      })()}
      {addressMenu && (
        <div className="thread-menu" ref={(el) => placeMenuNearCursor(el, addressMenu.x, addressMenu.y)} style={{ left: addressMenu.x, top: addressMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setAddressMenu(null); void pasteAndGo(); }}>貼り付けて移動</button>
          <button onClick={() => { setAddressMenu(null); void pasteToAddress(); }}>貼り付け</button>
          <button onClick={() => { setAddressMenu(null); if (locationInput) { void navigator.clipboard.writeText(locationInput); setStatus("URL をコピーしました"); } }} disabled={!locationInput}>コピー</button>
          <button onClick={() => { setAddressMenu(null); const el = addressInputRef.current; if (el) { el.focus(); el.select(); } }}>すべて選択</button>
        </div>
      )}
      {boardContextMenu && (
        <div className="thread-menu" ref={(el) => placeMenuNearCursor(el, boardContextMenu.x, boardContextMenu.y)} style={{ left: boardContextMenu.x, top: boardContextMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { toggleFavoriteBoard(boardContextMenu.board); setBoardContextMenu(null); }}>
            {isFavoriteBoard(boardContextMenu.board.url) ? "お気に入りから削除" : "お気に入りに追加"}
          </button>
          <button onClick={() => { void navigator.clipboard.writeText(boardContextMenu.board.url); setStatus("板URLをコピーしました"); setBoardContextMenu(null); }}>板URLをコピー</button>
        </div>
      )}
      {tabMenu && (
        <div className="thread-menu tab-menu" ref={(el) => placeMenuNearCursor(el, tabMenu.x, tabMenu.y)} style={{ left: tabMenu.x, top: tabMenu.y }} onClick={(e) => e.stopPropagation()}>
          {threadTabs[tabMenu.tabIndex] && (
            <button onClick={() => { toggleTabTts(threadTabs[tabMenu.tabIndex].threadUrl); setTabMenu(null); }}>
              {threadTabs[tabMenu.tabIndex].ttsOff ? "このタブの読み上げをオンにする" : "このタブの読み上げをオフにする"}
            </button>
          )}
          {threadTabs[tabMenu.tabIndex] && !isChatUrl(threadTabs[tabMenu.tabIndex].threadUrl) && (
            <button onClick={() => { toggleTabViewer(threadTabs[tabMenu.tabIndex].threadUrl); setTabMenu(null); }} title="ビュワーの「選んだスレを流す」の対象にする・やめる">
              {threadTabs[tabMenu.tabIndex].viewerOn !== false ? "ビュワーに流さない" : "ビュワーに流す"}
            </button>
          )}
          <button onClick={() => { closeTab(tabMenu.tabIndex); setTabMenu(null); }}>タブを閉じる</button>
          <button onClick={() => { closeOtherTabs(tabMenu.tabIndex); setTabMenu(null); }} disabled={threadTabs.length <= 1}>
            他のタブを閉じる
          </button>
          <button onClick={() => { closeAllTabs(); setTabMenu(null); }}>すべてのタブを閉じる</button>
          <button onClick={() => {
            const tab = threadTabs[tabMenu.tabIndex];
            if (tab) { void navigator.clipboard.writeText(tab.title); setStatus("スレタイをコピーしました"); }
            setTabMenu(null);
          }}>スレタイをコピー</button>
          <button onClick={() => {
            const tab = threadTabs[tabMenu.tabIndex];
            if (tab) { void navigator.clipboard.writeText(tab.threadUrl); setStatus("スレURLをコピーしました"); }
            setTabMenu(null);
          }}>スレURLをコピー</button>
          <button onClick={() => {
            const tab = threadTabs[tabMenu.tabIndex];
            if (tab) { void navigator.clipboard.writeText(`${tab.title}\n${tab.threadUrl}`); setStatus("スレタイとURLをコピーしました"); }
            setTabMenu(null);
          }}>スレタイとURLをコピー</button>
          <button
            onClick={() => void copyWholeThread()}
            disabled={tabMenu.tabIndex !== activeTabIndex}
            title={tabMenu.tabIndex !== activeTabIndex ? "アクティブなタブのみコピー可能" : ""}
          >スレ全体をコピー</button>
          <button onClick={() => {
            const tab = threadTabs[tabMenu.tabIndex];
            if (tab) purgeThreadCache(tab.threadUrl);
            setTabMenu(null);
          }}>キャッシュから削除</button>
        </div>
      )}
      {watchoiMenu && (
        <div className="thread-menu" ref={(el) => placeMenuNearCursor(el, watchoiMenu.x, watchoiMenu.y)} style={{ left: watchoiMenu.x, top: watchoiMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { addNgEntry("names", watchoiMenu.watchoi); setWatchoiMenu(null); }}>ワッチョイをNG</button>
          <button onClick={() => { void navigator.clipboard.writeText(watchoiMenu.watchoi); setStatus("ワッチョイをコピーしました"); setWatchoiMenu(null); }}>ワッチョイをコピー</button>
          <button onClick={() => { setResponseSearchQuery(watchoiMenu.watchoi); addSearchHistory("response", watchoiMenu.watchoi); setStatus(`ワッチョイでレス抽出: ${watchoiMenu.watchoi}`); setWatchoiMenu(null); }}>このワッチョイでレス抽出</button>
        </div>
      )}
      {idMenu && (
        <div className="thread-menu" ref={(el) => placeMenuNearCursor(el, idMenu.x, idMenu.y)} style={{ left: idMenu.x, top: idMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { addNgEntry("ids", idMenu.id); setIdMenu(null); }}>NGIDに追加</button>
        </div>
      )}
      {beMenu && (
        <div className="thread-menu" ref={(el) => placeMenuNearCursor(el, beMenu.x, beMenu.y)} style={{ left: beMenu.x, top: beMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => {
            const url = `https://be.5ch.io/user/${beMenu.beNumber}`;
            if (isTauriRuntime()) {
              void invoke("open_external_url", { url }).catch(() => window.open(url, "_blank"));
            } else {
              window.open(url, "_blank");
            }
            setBeMenu(null);
          }}>ブラウザで開く</button>
          <button onClick={() => {
            const query = beMenu.beNumber;
            setThreadSearchQuery(query);
            addSearchHistory("thread", query);
            setStatus(`BEでスレ一覧抽出: ${query}`);
            setBeMenu(null);
          }}>このBEでスレ抽出</button>
          <button onClick={() => {
            addNgEntry("thread_words", beMenu.beNumber);
            setBeMenu(null);
          }}>このBEをスレタイNGに追加</button>
          <button onClick={() => {
            const url = `https://ame.hacca.jp/sasss/log-be2.cgi?i=${beMenu.beNumber}`;
            if (isTauriRuntime()) {
              void invoke("open_external_url", { url }).catch(() => window.open(url, "_blank"));
            } else {
              window.open(url, "_blank");
            }
            setBeMenu(null);
          }}>スレ立て履歴を表示</button>
        </div>
      )}
      {searchHistoryMenu && (
        <div className="thread-menu" ref={(el) => placeMenuNearCursor(el, searchHistoryMenu.x, searchHistoryMenu.y)} style={{ left: searchHistoryMenu.x, top: searchHistoryMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { removeSearchHistory(searchHistoryMenu.type, searchHistoryMenu.word); setSearchHistoryMenu(null); }}>削除</button>
        </div>
      )}
      {anchorPopup && (() => {
        const popupResps = anchorPopup.responseIds.map((id) => responseItems.find((r) => r.id === id)).filter(Boolean) as typeof responseItems;
        if (popupResps.length === 0) return null;
        const maxH = 300;
        const spaceBelow = window.innerHeight - anchorPopup.y;
        const flipUp = spaceBelow < maxH && anchorPopup.anchorTop > spaceBelow;
        const posStyle = flipUp
          ? { left: anchorPopup.x, bottom: window.innerHeight - anchorPopup.anchorTop + 1 }
          : { left: anchorPopup.x, top: anchorPopup.y };
        return (
          <div
            className="anchor-popup popupfield"
            style={{ ...posStyle, '--fs-delta': `${popupFontSize - 12}px`, '--popup-max-height': `${popupMaxHeight}px` } as unknown as React.CSSProperties}
            onMouseEnter={() => {
              if (anchorPopupCloseTimer.current) {
                clearTimeout(anchorPopupCloseTimer.current);
                anchorPopupCloseTimer.current = null;
              }
            }}
            onMouseLeave={(ev) => {
              const next = ev.relatedTarget as HTMLElement | null;
              if (next?.closest(".anchor-popup") || next?.closest(".id-popup")) return;
              if (anchorPopupCloseTimer.current) clearTimeout(anchorPopupCloseTimer.current);
              anchorPopupCloseTimer.current = setTimeout(() => {
                setAnchorPopup(null);
                setNestedPopups([]);
                anchorPopupCloseTimer.current = null;
              }, 150);
            }}
            onMouseOver={(ev) => {
              const t = ev.target as HTMLElement;
              const a = t.closest<HTMLElement>(".anchor-ref");
              if (!a) return;
              const ids = getAnchorIds(a).filter((id) => responseItems.some((r) => r.id === id));
              if (ids.length > 0) {
                const rect = a.getBoundingClientRect();
                setNestedPopups([{ x: rect.left, y: rect.bottom + 1, anchorTop: rect.top, responseIds: ids }]);
              }
            }}
            onMouseOut={(ev) => {
              const t = ev.target as HTMLElement;
              if (!t.closest(".anchor-ref")) return;
              const next = ev.relatedTarget as HTMLElement | null;
              if (next?.closest(".anchor-popup")) return;
              setNestedPopups([]);
            }}
            onClick={handlePopupImageClick}
            onMouseMove={handlePopupImageHover}
          >
            {popupResps.map((popupResp) => (
              <div key={popupResp.id}>
                <div className="anchor-popup-header">
                  <span className="response-viewer-no">{popupResp.id}</span> {popupResp.name}
                  <time>{popupResp.time}</time>
                </div>
                <div className="anchor-popup-body popup-main rb" dangerouslySetInnerHTML={renderResponseBody(popupResp.text)} />
              </div>
            ))}
          </div>
        );
      })()}
      {backRefPopup && (() => {
        const refs = backRefPopup.responseIds;
        return (
          <div
            className="anchor-popup back-ref-popup popupfield"
            style={{ left: backRefPopup.x, bottom: window.innerHeight - backRefPopup.y, '--fs-delta': `${popupFontSize - 12}px`, '--popup-max-height': `${popupMaxHeight}px` } as React.CSSProperties}
            onMouseLeave={(ev) => {
              const next = ev.relatedTarget as HTMLElement | null;
              if (next?.closest(".anchor-popup")) return;
              setBackRefPopup(null);
            }}
            onMouseOver={(ev) => {
              const t = ev.target as HTMLElement;
              const a = t.closest<HTMLElement>(".anchor-ref");
              if (!a) return;
              const ids = getAnchorIds(a).filter((id) => responseItems.some((r) => r.id === id));
              if (ids.length > 0) {
                const rect = a.getBoundingClientRect();
                setNestedPopups([{ x: rect.left, y: rect.bottom + 1, anchorTop: rect.top, responseIds: ids }]);
              }
            }}
            onMouseOut={(ev) => {
              const t = ev.target as HTMLElement;
              if (!t.closest(".anchor-ref")) return;
              const next = ev.relatedTarget as HTMLElement | null;
              if (next?.closest(".anchor-popup")) return;
              setNestedPopups([]);
            }}
            onClick={handlePopupImageClick}
            onMouseMove={handlePopupImageHover}
          >
            {refs.map((refNo) => {
              const refResp = responseItems.find((r) => r.id === refNo);
              if (!refResp) return null;
              return (
                <div key={refNo} className="back-ref-popup-item">
                  <div className="anchor-popup-header">
                    <span className="response-viewer-no">{refResp.id}</span> {refResp.name}
                    <time>{refResp.time}</time>
                  </div>
                  <div className="anchor-popup-body popup-main rb" dangerouslySetInnerHTML={renderResponseBody(refResp.text)} />
                </div>
              );
            })}
          </div>
        );
      })()}
      {nestedPopups.map((np, i) => {
        const nestedResps = np.responseIds.map((id) => responseItems.find((r) => r.id === id)).filter(Boolean) as typeof responseItems;
        if (nestedResps.length === 0) return null;
        const nMaxH = 300;
        const nSpaceBelow = window.innerHeight - np.y;
        const nFlipUp = nSpaceBelow < nMaxH && np.anchorTop > nSpaceBelow;
        const nPosStyle = nFlipUp
          ? { left: np.x + i * 8, bottom: window.innerHeight - np.anchorTop + 1 + i * 8 }
          : { left: np.x + i * 8, top: np.y + i * 8 };
        return (
          <div
            key={`${np.responseIds[0]}-${i}`}
            className="anchor-popup nested-popup popupfield"
            style={{ ...nPosStyle, '--fs-delta': `${popupFontSize - 12}px`, '--popup-max-height': `${popupMaxHeight}px` } as unknown as React.CSSProperties}
            onMouseEnter={() => {
              if (anchorPopupCloseTimer.current) {
                clearTimeout(anchorPopupCloseTimer.current);
                anchorPopupCloseTimer.current = null;
              }
            }}
            onMouseLeave={(ev) => {
              const next = ev.relatedTarget as HTMLElement | null;
              if (next?.closest(".anchor-popup") || next?.closest(".id-popup")) return;
              if (anchorPopupCloseTimer.current) clearTimeout(anchorPopupCloseTimer.current);
              anchorPopupCloseTimer.current = setTimeout(() => {
                setAnchorPopup(null);
                setBackRefPopup(null);
                setNestedPopups([]);
                anchorPopupCloseTimer.current = null;
              }, 150);
            }}
            onMouseOver={(ev) => {
              const t = ev.target as HTMLElement;
              const a = t.closest<HTMLElement>(".anchor-ref");
              if (!a) return;
              const ids = getAnchorIds(a).filter((id) => responseItems.some((r) => r.id === id));
              if (ids.length === 0) return;
              const rect = a.getBoundingClientRect();
              setNestedPopups((prev) => {
                const head = prev.slice(0, i + 1);
                const last = head[head.length - 1];
                if (last && last.responseIds.length === ids.length && last.responseIds.every((v, j) => v === ids[j])) return head;
                return [...head, { x: rect.left, y: rect.bottom + 1, anchorTop: rect.top, responseIds: ids }];
              });
            }}
            onMouseOut={(ev) => {
              const t = ev.target as HTMLElement;
              if (!t.closest(".anchor-ref")) return;
              const next = ev.relatedTarget as HTMLElement | null;
              if (next?.closest(".anchor-popup")) return;
              setNestedPopups((prev) => prev.slice(0, i + 1));
            }}
            onClick={handlePopupImageClick}
            onMouseMove={handlePopupImageHover}
          >
            {nestedResps.map((nestedResp) => (
              <div key={nestedResp.id}>
                <div className="anchor-popup-header">
                  <span className="response-viewer-no">{nestedResp.id}</span> {nestedResp.name}
                  <time>{nestedResp.time}</time>
                </div>
                <div className="anchor-popup-body popup-main rb" dangerouslySetInnerHTML={renderResponseBody(nestedResp.text)} />
              </div>
            ))}
          </div>
        );
      })}
      {idPopup && (() => {
        const idResponses = responseItems.filter((r) => extractId(r.time) === idPopup.id);
        const GAP = 6;
        const spaceRight = window.innerWidth - idPopup.anchorRight - GAP;
        const hDir = spaceRight >= 200 ? "right" : "left";
        const hStyle = hDir === "right"
          ? { left: idPopup.anchorRight + GAP }
          : { right: window.innerWidth - idPopup.anchorLeft + GAP };
        // 推定高さで初期位置を決め、マウント後に実測高さで補正する
        // （推定のみだと短いレスで過大評価され、小さいポップアップが最上部に飛ぶ）
        const estimatedItemH = Math.round(popupFontSize * 2.5 + 16);
        const estimatedH = Math.min(32 + idResponses.length * estimatedItemH, popupMaxHeight);
        const useLargeAnchor = estimatedH > window.innerHeight * 0.5;
        const nearTop = useLargeAnchor
          ? 0
          : clamp(idPopup.anchorY - 4, 4, Math.max(4, window.innerHeight - estimatedH - 4));
        const idPosStyle = { ...hStyle, top: nearTop };
        const positionByMeasuredHeight = (el: HTMLDivElement | null) => {
          if (!el) return;
          const h = el.offsetHeight;
          el.style.top = h > window.innerHeight * 0.5
            ? "0px"
            : `${clamp(idPopup.anchorY - 4, 4, Math.max(4, window.innerHeight - h - 4))}px`;
        };
        return (
          <div
            className="id-popup popupfield"
            ref={positionByMeasuredHeight}
            style={{ ...idPosStyle, '--fs-delta': `${popupFontSize - 12}px`, '--popup-max-width': `${popupMaxWidth}px`, '--popup-max-height': `${popupMaxHeight}px` } as unknown as React.CSSProperties}
            onMouseEnter={() => { if (idPopupCloseTimer.current) { clearTimeout(idPopupCloseTimer.current); idPopupCloseTimer.current = null; } }}
            onMouseLeave={(ev) => {
              const next = ev.relatedTarget as HTMLElement | null;
              if (next?.closest(".anchor-popup")) return;
              idPopupCloseTimer.current = setTimeout(() => setIdPopup(null), 150);
            }}
            onMouseOver={(ev) => {
              const t = ev.target as HTMLElement;
              const a = t.closest<HTMLElement>(".anchor-ref");
              if (!a) return;
              const ids = getAnchorIds(a).filter((id) => responseItems.some((r) => r.id === id));
              if (ids.length > 0) {
                if (anchorPopupCloseTimer.current) { clearTimeout(anchorPopupCloseTimer.current); anchorPopupCloseTimer.current = null; }
                const rect = a.getBoundingClientRect();
                const popupWidth = Math.min(620, window.innerWidth - 24);
                const x = Math.max(8, Math.min(rect.left, window.innerWidth - popupWidth - 8));
                setAnchorPopup({ x, y: rect.bottom + 1, anchorTop: rect.top, responseIds: ids });
              }
            }}
            onMouseOut={(ev) => {
              const t = ev.target as HTMLElement;
              if (!t.closest(".anchor-ref")) return;
              const next = ev.relatedTarget as HTMLElement | null;
              if (next?.closest(".anchor-popup") || next?.closest(".id-popup")) return;
              if (anchorPopupCloseTimer.current) clearTimeout(anchorPopupCloseTimer.current);
              anchorPopupCloseTimer.current = setTimeout(() => {
                setAnchorPopup(null);
                setNestedPopups([]);
                anchorPopupCloseTimer.current = null;
              }, 150);
            }}
            onClick={handlePopupImageClick}
            onMouseMove={handlePopupImageHover}
          >
            <div className="id-popup-header">
              ID:{idPopup.id} ({idResponses.length}件)
            </div>
            <div className="id-popup-list popup-main">
              {idResponses.map((r) => (
                <div
                  key={r.id}
                  className="id-popup-item"
                  onClick={() => { setSelectedResponse(r.id); setIdPopup(null); }}
                >
                  <span className="response-viewer-no">{r.id}</span>
                  <span className="id-popup-text" dangerouslySetInnerHTML={renderResponseBody(r.text)} />
                </div>
              ))}
            </div>
          </div>
        );
      })()}
      {aboutOpen && (
        <div className="lightbox-overlay" onClick={() => setAboutOpen(false)}>
          <div className="settings-panel lf-w360-ta-center" onClick={(e) => e.stopPropagation()}>
            <header className="settings-header">
              <strong>バージョン情報</strong>
              <button onClick={() => setAboutOpen(false)}>閉じる</button>
            </header>
            <div className="lf-p24-16-d-flex-fd-column-ai-center-gap12">
              <img src="/icon.png" alt="LiveFake" className="lf-w64-h64" />
              <div className="lf-fs1_3em-fw-bold">LiveFake</div>
              <div className="lf-c-sub">v{currentVersion}</div>
              <div className="lf-fs0_85em-c-sub-lh1_6">
                実況向け掲示板ブラウザ＋Twitchビュワー<br />
                Runtime: {runtimeState}
              </div>
              <div style={{ fontSize: "0.85em", color: updateResult?.hasUpdate ? "#cc3300" : "var(--sub)", marginTop: 4 }}>
                {updateProbe === "running..." ? "更新確認中..." : updateResult ? (updateResult.hasUpdate ? `新しいバージョンがあります: v${updateResult.latestVersion}` : `最新版です (v${currentVersion})`) : ""}
              </div>
              {updateResult?.notice && <div className="update-notice">{updateResult.notice.text}</div>}
              {updateResult?.hasUpdate && (
                <button onClick={openDownloadPage} className="lf-mt4">
                  ダウンロードページを開く
                </button>
              )}
              <div className="lf-d-flex-gap8-mt4">
                <button
                  onClick={() => {
                    const url = GITHUB_RELEASE_URL;
                    if (isTauriRuntime()) {
                      void invoke("open_external_url", { url }).catch(() => window.open(url, "_blank"));
                    } else {
                      window.open(url, "_blank");
                    }
                  }}
                >
                  配布先 (GitHub)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {appConfirm && (
        <div className="app-confirm-overlay" onClick={() => setAppConfirm(null)}>
          <div className="app-confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            {appConfirm.title && <div className="app-confirm-title">{appConfirm.title}</div>}
            <div className="app-confirm-message">{appConfirm.message}</div>
            <div className="app-confirm-buttons">
              {appConfirm.buttons.map((b) => (
                <button key={b.label} className={b.primary ? "primary" : b.danger ? "danger" : ""} onClick={() => { setAppConfirm(null); b.onClick(); }}>
                  {b.label}
                  {b.primary && !b.danger && <span className="app-confirm-key">Enter</span>}
                  {b.label === "キャンセル" && <span className="app-confirm-key">Esc</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {licensesOpen && (
        <div className="app-confirm-overlay" onClick={() => setLicensesOpen(false)}>
          <div className="app-confirm app-licenses" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="app-confirm-title">サードパーティライセンス</div>
            <pre className="app-licenses-text">{licensesText ?? "読み込み中…"}</pre>
            <div className="app-confirm-buttons">
              <button className="primary" onClick={() => setLicensesOpen(false)}>閉じる</button>
            </div>
          </div>
        </div>
      )}
      {settingsOpen && (
        <div className="lightbox-overlay" onClick={requestCloseSettings}>
          <div className="settings-panel settings-panel-wide" onClick={(e) => e.stopPropagation()}>
            <header className="settings-header">
              <strong>設定</strong>
              <input
                type="search"
                className="settings-search"
                placeholder="設定項目を検索（項目名・説明文）"
                value={settingsQuery}
                list="settings-search-history"
                onChange={(e) => setSettingsQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { e.preventDefault(); setSettingsQuery(""); }
                  else if (e.key === "Enter") { e.preventDefault(); pushSettingsSearchHistory(settingsQuery); }
                }}
              />
              <datalist id="settings-search-history">
                {settingsSearchHistory.map((h) => <option key={h} value={h} />)}
              </datalist>
              {settingsQuery && <button onClick={() => setSettingsQuery("")}>検索をクリア</button>}
              {settingsSearchHistory.length > 0 && <button onClick={() => setSettingsSearchHistory([])} title="検索語の履歴 (候補) を消去">履歴を消去</button>}
              <span className="settings-header-actions">
                {settingsDirty && <span className="settings-dirty-note">未保存の変更があります</span>}
                <button className="primary" disabled={!settingsDirty} onClick={() => void saveSettingsNow()} title="値の設定をファイルに保存します (NG・辞書などの登録内容は登録した時点で保存済み)">設定を保存</button>
                <button onClick={requestCloseSettings}>閉じる</button>
              </span>
            </header>
            <div className="settings-2col">
              <nav className="settings-nav">
                {SETTINGS_CATEGORIES.map((cat) => (
                  <button key={cat} data-cat={cat} className={`settings-nav-item${settingsCategory === cat ? " active" : ""}`} onClick={() => requestSwitchSettingsCategory(cat)}>{SETTINGS_CATEGORY_LABELS[cat]}</button>
                ))}
              </nav>
              <div className="settings-content" ref={settingsContentRef}>
              {!settingsSearching && settingsSectionsFor(settingsCategory).length > 1 && (
                <div className="settings-section-tabs">
                  {settingsSectionsFor(settingsCategory).map((sec) => (
                    <button key={sec.id} className={`settings-section-tab${settingsActiveSection === sec.id ? " active" : ""}`} onClick={() => { setSettingsSection(sec.id); setSettingsListFilter(""); if (settingsCategory === "ng" && (sec.id === "words" || sec.id === "ids" || sec.id === "names" || sec.id === "mails" || sec.id === "thread_words")) setNgInputType(sec.id); }}>{sec.label}</button>
                  ))}
                </div>
              )}
              {settingsSearching && (
                <div className="settings-search-note">「{settingsQuery}」に一致する設定項目 — 見出しをクリックするとその場所へ移動します</div>
              )}
              {(settingsSearching || settingsCategory === "display") && (
              <div className="settings-cat" data-cat="display">
              <section className="settings-section" data-section="general">
                {settingsSectionHeading("display", "general")}
              <fieldset>
                <legend>全般</legend>
                <div className="settings-row">
                  <span>検索・入力欄の履歴（板・お気に入り・スレ一覧・レス内の検索、設定の検索と絞り込み、スレ立てのタイトルとメール欄の候補）</span>
                  <button onClick={() => {
                    inputHistoryRef.current = {};
                    setInputHistory({});
                    saveToFile("input-history.json", {});
                    setThreadSearchHistory([]);
                    setResponseSearchHistory([]);
                    persistSearchHistory([], []);
                    setSettingsSearchHistory([]);
                    setStatus("入力履歴を消去しました");
                  }}>履歴を消去</button>
                </div>
                <label className="settings-row">
                  <span>テーマ</span>
                  <select value={darkMode ? "dark" : "light"} onChange={(e) => setDarkMode(e.target.value === "dark")}>
                    <option value="light">ライト</option>
                    <option value="dark">ダーク</option>
                  </select>
                </label>
                <label className="settings-row lf-ai-flex-start">
                  <span className="lf-pt4">フォント</span>
                  <div className="font-picker">
                    <div className="lf-d-flex-gap4">
                      <input
                        type="text"
                        className="font-picker-input lf-grow"
                        value={fontPickerInput}
                        onChange={(e) => { setFontPickerInput(e.target.value); setFontPickerOpen(true); }}
                        onFocus={() => setFontPickerOpen(true)}
                        onBlur={() => setTimeout(() => setFontPickerOpen(false), 150)}
                        placeholder="デフォルト (入力またはクリック)"
                      />
                      {fontFamily && (
                        <button className="lf-shrink0" onClick={() => { setFontFamily(""); setFontPickerInput(""); }}>×</button>
                      )}
                    </div>
                    {fontPickerOpen && (() => {
                      const q = fontPickerInput.toLowerCase();
                      const filtered = q ? systemFonts.filter((f) => f.toLowerCase().includes(q)) : systemFonts;
                      return filtered.length > 0 ? (
                        <div className="font-picker-dropdown">
                          {filtered.slice(0, 120).map((f) => (
                            <div
                              key={f}
                              className={`font-picker-option${f === fontFamily ? " selected" : ""}`}
                              style={{ fontFamily: `"${f}", sans-serif` }}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                setFontFamily(f);
                                setFontPickerInput(f);
                                setFontPickerOpen(false);
                              }}
                            >
                              {f}
                            </div>
                          ))}
                        </div>
                      ) : null;
                    })()}
                  </div>
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={fontBold} onChange={(e) => setFontBold(e.target.checked)} />
                  <span>太字</span>
                </label>
                <label className="settings-row">
                  <span>文字サイズ (板)</span>
                  <input type="number" value={boardsFontSize} min={8} max={20} onChange={(e) => setBoardsFontSize(Number(e.target.value))} />
                </label>
                <label className="settings-row">
                  <span>文字サイズ (スレ)</span>
                  <input type="number" value={threadsFontSize} min={8} max={20} onChange={(e) => setThreadsFontSize(Number(e.target.value))} />
                </label>
                <label className="settings-row" title="カスタムCSS内の url(http…) による外部サーバーへの画像参照を許可します。信頼できないCSSを貼り付ける場合はオフのままを推奨">
                  <span>カスタムCSSの外部URL参照を許可 (非推奨)</span>
                  <input
                    type="checkbox"
                    checked={cssAllowExternalUrls}
                    onChange={(e) => {
                      const allow = e.target.checked;
                      setCssAllowExternalUrls(allow);
                      void applyUserCss(allow);
                      void invoke("refresh_window_css", { allowExternal: allow }).catch((err) => console.warn("refresh_window_css failed", err));
                    }}
                  />
                </label>
                <label className="settings-row" title="NG・読み上げない辞書・読み上げ許可リストなどの登録内容の表示を隠します。値は変更されず、表示だけを隠します">
                  <input type="checkbox" checked={streamMaskEnabled} onChange={(e) => setStreamMaskEnabled(e.target.checked)} />
                  <span>登録項目のマスク</span>
                </label>
                <label className="settings-row">
                  <span>自動更新間隔 (秒)</span>
                  <input type="number" value={autoRefreshInterval} min={10} max={300} step={1} onChange={(e) => {
                    const v = Math.max(10, Math.min(300, Number(e.target.value)));
                    setAutoRefreshInterval(v);
                  }} />
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={smoothScroll} onChange={(e) => setSmoothScroll(e.target.checked)} />
                  <span>スムーススクロール (再起動後に反映)</span>
                </label>
                <label className="settings-row">
                  <span>最大タブ数</span>
                  <input type="number" value={maxOpenTabs} min={1} max={50} step={1} onChange={(e) => setMaxOpenTabs(Math.max(1, Math.min(50, Number(e.target.value))))} />
                </label>
                <label className="settings-row">
                  <span>ログ保持日数</span>
                  <input type="number" value={logRetentionDays} min={0} max={365} step={1} onChange={(e) => setLogRetentionDays(Math.max(0, Math.min(365, Number(e.target.value))))} />
                  <span className="settings-hint">0 = 無制限</span>
                </label>
                <label className="settings-row" title="画像・リンクカードなどを表示したときにブラウザ部分が保存するキャッシュの上限です。data\webview フォルダに保存されます">
                  <span>ブラウザのキャッシュ上限 (MB)</span>
                  <input type="number" value={webviewCacheMb} min={10} max={1000} step={1} onChange={(e) => setWebviewCacheMb(Math.max(10, Math.min(1000, Math.round(Number(e.target.value)) || 10)))} />
                  <span className="settings-hint">10〜1000 (再起動後に反映)</span>
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={showBoardButtons} onChange={(e) => setShowBoardButtons(e.target.checked)} />
                  <span>板ボタンバー</span>
                </label>
                <label className="settings-row" title="板タブ (ビュワー・板未選択を含む)・スレタブを、それぞれ決まった幅にそろえます。長い名前は「…」で切り、マウスを乗せると全体を出します">
                  <input type="checkbox" checked={tabWidthFixed} onChange={(e) => setTabWidthFixed(e.target.checked)} />
                  <span>タブの幅をそろえる</span>
                </label>
                {tabWidthFixed && (
                  <div className="settings-row tab-width-inputs">
                    <span>板タブ</span>
                    <input type="number" min={TAB_WIDTH_MIN} max={TAB_WIDTH_MAX} step={10} value={boardTabWidth} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= TAB_WIDTH_MIN && n <= TAB_WIDTH_MAX) setBoardTabWidth(n); }} className="lf-w70" />
                    <span>px ・スレタブ</span>
                    <input type="number" min={TAB_WIDTH_MIN} max={TAB_WIDTH_MAX} step={10} value={threadTabWidth} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= TAB_WIDTH_MIN && n <= TAB_WIDTH_MAX) setThreadTabWidth(n); }} className="lf-w70" />
                    <span>px ({TAB_WIDTH_MIN}〜{TAB_WIDTH_MAX}。既定 {TAB_WIDTH_BOARD_DEFAULT} / {TAB_WIDTH_THREAD_DEFAULT})</span>
                  </div>
                )}
                <label className="settings-row" title="板タブ・スレタブの左端に、サイトごとの色の線を付けます (5ch=橙 / したらば=緑 / JPNKN=青 / Twitch=紫)">
                  <input type="checkbox" checked={tabSiteColors} onChange={(e) => setTabSiteColors(e.target.checked)} />
                  <span>タブの左端にサイトごとの色の線を付ける</span>
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={keepSortOnRefresh} onChange={(e) => setKeepSortOnRefresh(e.target.checked)} />
                  <span>スレ一覧の更新時にソートを維持</span>
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={restoreSession} onChange={(e) => setRestoreSession(e.target.checked)} />
                  <span>起動時に前回のタブと板を復元</span>
                </label>
                <label className="settings-row" title="このブラウザ本体のウィンドウを常に他の全ウィンドウの下に表示します(常に最前面の逆)。書き込みの浮遊ウィンドウ・OBS連携ウィンドウ・字幕ウィンドウには適用されません">
                  <input type="checkbox" checked={mainAlwaysOnBottom} onChange={(e) => setMainAlwaysOnBottom(e.target.checked)} />
                  <span>常に最背面に表示</span>
                </label>
              </fieldset>
              <fieldset>
                <legend>板一覧 (bbsmenu) の取得元</legend>
                <div className="settings-row">
                  <span>取得元URL</span>
                  <input
                    type="text"
                    className="lf-flex1"
                    value={bbsmenuUrl}
                    onChange={(e) => setBbsmenuUrl(e.target.value)}
                    placeholder={DEFAULT_BBSMENU_URL}
                  />
                  {bbsmenuUrl !== DEFAULT_BBSMENU_URL && (
                    <button onClick={() => setBbsmenuUrl(DEFAULT_BBSMENU_URL)}>デフォルトに戻す</button>
                  )}
                </div>
                <p className="settings-hint">
                  板一覧(bbsmenu)の取得先です。5ch側でbbsmenu.jsonの置き場所が変わった場合などに、ここを書き換えることで対応できます。
                  変更後にここへ載っている板へアクセスできるよう、通信先の許可リストにもこの取得元の内容が自動的に反映されます。
                </p>
              </fieldset>
              <fieldset>
                <legend>したらば・JPNKNの現在のドメイン</legend>
                <div className="settings-row">
                  <span>したらば</span>
                  <input
                    type="text"
                    className="lf-flex1"
                    value={shitarabaHost}
                    onChange={(e) => setShitarabaHost(e.target.value)}
                    onBlur={() => {
                      const v = shitarabaHost.trim();
                      if (v && v !== DEFAULT_SHITARABA_HOST) {
                        const ok = window.confirm(
                          `"${v}" への投稿・Cookie送信が許可されるようになります。したらば公式の新しいドメインであることを確認してから変更してください。続けますか？`
                        );
                        if (!ok) setShitarabaHost(DEFAULT_SHITARABA_HOST);
                      } else if (!v) {
                        setShitarabaHost(DEFAULT_SHITARABA_HOST);
                      }
                    }}
                    placeholder={DEFAULT_SHITARABA_HOST}
                  />
                  {shitarabaHost !== DEFAULT_SHITARABA_HOST && (
                    <button onClick={() => setShitarabaHost(DEFAULT_SHITARABA_HOST)}>デフォルトに戻す</button>
                  )}
                </div>
                <div className="settings-row">
                  <span>JPNKN</span>
                  <input
                    type="text"
                    className="lf-flex1"
                    value={jpnknHost}
                    onChange={(e) => setJpnknHost(e.target.value)}
                    onBlur={() => {
                      const v = jpnknHost.trim();
                      if (v && v !== DEFAULT_JPNKN_HOST) {
                        const ok = window.confirm(
                          `"${v}" への投稿・Cookie送信が許可されるようになります。JPNKN公式の新しいドメインであることを確認してから変更してください。続けますか？`
                        );
                        if (!ok) setJpnknHost(DEFAULT_JPNKN_HOST);
                      } else if (!v) {
                        setJpnknHost(DEFAULT_JPNKN_HOST);
                      }
                    }}
                    placeholder={DEFAULT_JPNKN_HOST}
                  />
                  {jpnknHost !== DEFAULT_JPNKN_HOST && (
                    <button onClick={() => setJpnknHost(DEFAULT_JPNKN_HOST)}>デフォルトに戻す</button>
                  )}
                </div>
                <p className="settings-hint">
                  したらば・JPNKNが将来ドメインを変更した場合に、ここを書き換えることで対応できます。通常は変更する必要はありません。
                </p>
              </fieldset>
              </section>
              <section className="settings-section" data-section="response">
                {settingsSectionHeading("display", "response")}
              <fieldset>
                <legend>レス表示</legend>
                <label className="settings-row">
                  <span>文字サイズ (レス)</span>
                  <input type="number" value={responsesFontSize} min={8} max={20} onChange={(e) => setResponsesFontSize(Number(e.target.value))} />
                </label>
                <label className="settings-row">
                  <span>文字サイズ (レスヘッダ)</span>
                  <input type="number" value={responsesHeaderFontSize} min={8} max={20} onChange={(e) => setResponsesHeaderFontSize(Number(e.target.value))} />
                </label>
                <div className="settings-row settings-row-stack">
                  <span>レスヘッダに表示する項目（非表示の項目は詰めて表示）</span>
                  {headerVisRows(mainHeaderVis, setMainHeaderVis, { watchoi: true })}
                </div>
                <label className="settings-row">
                  <input type="checkbox" checked={responseDividerAlways} onChange={(e) => setResponseDividerAlways(e.target.checked)} />
                  <span>レス間に罫線を常に表示（ヘッダ項目を全て非表示にしたときは自動で表示）</span>
                </label>
                <label className="settings-row">
                  <span>レスID 文字サイズ補正 (0=同じ、±px)</span>
                  <input type="number" value={resIdFontSize} min={-20} max={24} onChange={(e) => setResIdFontSize(Number(e.target.value))} className="lf-w60" />
                </label>
                <label className="settings-row lf-ai-flex-start">
                  <span className="lf-pt4">レスID フォント</span>
                  <div className="font-picker">
                    <div className="lf-d-flex-gap4">
                      <input type="text" className="font-picker-input lf-grow" value={resIdFontPickerInput}
                        onChange={(e) => { setResIdFontPickerInput(e.target.value); setResIdFontPickerOpen(true); }}
                        onFocus={() => setResIdFontPickerOpen(true)}
                        onBlur={() => setTimeout(() => setResIdFontPickerOpen(false), 150)}
                        placeholder="デフォルト (入力またはクリック)" />
                      {resIdFontFamily && <button className="lf-shrink0" onClick={() => { setResIdFontFamily(""); setResIdFontPickerInput(""); }}>×</button>}
                    </div>
                    {resIdFontPickerOpen && (() => {
                      const q = resIdFontPickerInput.toLowerCase();
                      const filtered = q ? systemFonts.filter((f) => f.toLowerCase().includes(q)) : systemFonts;
                      return filtered.length > 0 ? (
                        <div className="font-picker-dropdown">
                          {filtered.slice(0, 120).map((f) => (
                            <div key={f} className={`font-picker-option${f === resIdFontFamily ? " selected" : ""}`} style={{ fontFamily: `"${f}", sans-serif` }}
                              onMouseDown={(e) => { e.preventDefault(); setResIdFontFamily(f); setResIdFontPickerInput(f); setResIdFontPickerOpen(false); }}>{f}</div>
                          ))}
                        </div>
                      ) : null;
                    })()}
                  </div>
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={autoScrollEnabled} onChange={(e) => setAutoScrollEnabled(e.target.checked)} />
                  <span>新着レス取得時に自動スクロール</span>
                </label>
                <label className="settings-row">
                  <span>レス間隔 (px)</span>
                  <input type="number" value={responseGap} min={0} max={40} step={1} onChange={(e) => setResponseGap(Math.max(0, Math.min(40, Number(e.target.value))))} />
                </label>
              </fieldset>
              </section>
              <section className="settings-section" data-section="image">
                {settingsSectionHeading("display", "image")}
              <fieldset>
                <legend>画像</legend>
                <label className="settings-row">
                  <input type="checkbox" checked={showImagePreview} onChange={(e) => setShowImagePreview(e.target.checked)} />
                  <span>画像をプレビュー表示</span>
                </label>
                <label className="settings-row">
                  <span>画像サイズ制限 (KB)</span>
                  <input type="number" value={imageSizeLimit} min={0} max={99999} onChange={(e) => setImageSizeLimit(Number(e.target.value))} />
                  <span className="settings-hint">0 = 無制限</span>
                </label>
                <label className="settings-row">
                  <span>サムネイルサイズ (px)</span>
                  <input type="number" value={thumbSize} min={50} max={600} step={10} onChange={(e) => setThumbSize(Number(e.target.value))} />
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={hoverPreviewEnabled} onChange={(e) => setHoverPreviewEnabled(e.target.checked)} />
                  <span>画像ホバープレビュー</span>
                </label>
                <label className="settings-row">
                  <span>ホバープレビュー遅延 (ms)</span>
                  <input type="number" value={hoverPreviewDelay} min={0} max={2000} step={50} onChange={(e) => setHoverPreviewDelay(Number(e.target.value))} />
                  <span className="settings-hint">0 = 即時</span>
                </label>
                <div className="settings-row">
                  <span>画像保存先フォルダ</span>
                  <span className="lf-flex1-ov-hidden-to-ellipsis-ws-nowrap-fs11-c-text-secondary">{imageSaveFolder || "(未設定 — 毎回選択)"}</span>
                  <button onClick={() => {
                    if (!isTauriRuntime()) return;
                    invoke<string | null>("open_folder_dialog").then((p) => { if (p) setImageSaveFolder(p); }).catch((e) => console.warn("open_folder_dialog:", e));
                  }}>選択</button>
                  {imageSaveFolder && <button onClick={() => setImageSaveFolder("")}>クリア</button>}
                </div>
              </fieldset>
              <fieldset>
                <legend>画像 URL 変換ルール (ImageViewURLReplace)</legend>
                <div className="settings-row">
                  <span>有効なルール数</span>
                  <span>{imageUrlRules.length} 件</span>
                </div>
                <div className="settings-row lf-gap8">
                  <button onClick={() => {
                    if (!isTauriRuntime()) return;
                    invoke<UrlReplaceRule[]>("reset_image_url_replace")
                      .then((rules) => { setImageUrlRules(rules); setStatus("URLルールをデフォルトにリセットしました"); })
                      .catch((e) => console.warn("reset_image_url_replace:", e));
                  }}>デフォルトに戻す</button>
                  <button onClick={() => {
                    if (!isTauriRuntime()) return;
                    invoke<string>("get_data_dir").then((dir) => {
                      invoke("open_external_url", { url: dir }).catch(() => {});
                    }).catch(() => {});
                  }}>データフォルダを開く</button>
                </div>
                <div className="lf-fs0_8em-c-sub-mt4">
                  データフォルダ内の ImageViewURLReplace.txt を編集してアプリを再起動すると反映されます
                </div>
              </fieldset>
              </section>
              <section className="settings-section" data-section="cards">
                {settingsSectionHeading("display", "cards")}
              <fieldset>
                <legend>リンクカード（OGP / X）</legend>
                <label className="settings-row">
                  <input type="checkbox" checked={ogpCardsEnabled} onChange={(e) => setOgpCardsEnabled(e.target.checked)} />
                  <span>リンクをOGPカード表示（本文中のURL先サイトへ通信します）</span>
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={tweetCardsEnabled} onChange={(e) => setTweetCardsEnabled(e.target.checked)} />
                  <span>X（Twitter）のポストをカード表示・動画をその場で再生（x.com / twimg.com へ通信します）</span>
                </label>
                {(ogpCardsEnabled || tweetCardsEnabled) && (
                  <div className="settings-row settings-row-stack">
                    <div className="settings-note">
                      カード表示の通信先ドメイン。ブロックは常に除外、許可は空なら全ドメイン・登録があればそのドメインのみ通信します。
                      私有ネットワーク・ローカルアドレスへは設定に関わらず通信しません。
                    </div>
                    <div className="lf-d-flex-gap4-ai-center">
                      <input type="text" value={ogpDomainInput} onChange={(e) => setOgpDomainInput(e.target.value)} placeholder="example.com" className="lf-w180" />
                      <button onClick={() => { addOgpDomain("allow", ogpDomainInput); setOgpDomainInput(""); }}>許可に追加</button>
                      <button onClick={() => { addOgpDomain("block", ogpDomainInput); setOgpDomainInput(""); }}>ブロックに追加</button>
                    </div>
                    {ogpDomainFilters.allow.length > 0 && (
                      <div className="lf-fs11">
                        許可: {ogpDomainFilters.allow.map((d) => (
                          <span key={`a-${d}`} className="lf-d-inline-flex-ai-center-gap2-mr6">
                            {d}<button className="lf-fs10-p0-4" onClick={() => removeOgpDomain("allow", d)}>×</button>
                          </span>
                        ))}
                      </div>
                    )}
                    {ogpDomainFilters.block.length > 0 && (
                      <div className="lf-fs11">
                        ブロック: {ogpDomainFilters.block.map((d) => (
                          <span key={`b-${d}`} className="lf-d-inline-flex-ai-center-gap2-mr6">
                            {d}<button className="lf-fs10-p0-4" onClick={() => removeOgpDomain("block", d)}>×</button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </fieldset>
              </section>
              <section className="settings-section" data-section="arrival">
                {settingsSectionHeading("display", "arrival")}
              <fieldset>
                <legend>新着レスペイン</legend>
                <label className="settings-row">
                  <span>文字サイズ (新着レス)</span>
                  <input type="number" value={newArrivalFontSize} min={8} max={24} onChange={(e) => setNewArrivalFontSize(Number(e.target.value))} />
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={arrivalCardsEnabled} onChange={(e) => setArrivalCardsEnabled(e.target.checked)} />
                  <span>新着レスペインにもカードを表示（OGP / X カードが ON のとき有効）</span>
                </label>
                <div className="settings-row settings-row-stack">
                  <div className="settings-note">
                    新着レスペインの自動スクロール: 収まらない長文は「待ち時間」の後、最下行まで「スクロール速度」でゆっくり流し、到達後の表示時間が過ぎたら次のレスへ進みます。
                  </div>
                  {scrollTimingRows(arrivalTiming, setArrivalTiming)}
                </div>
                <div className="settings-row settings-row-stack">
                  <span>新着レスペインのヘッダに表示する項目（非表示の項目は詰めて表示）</span>
                  {headerVisRows(arrivalHeaderVis, setArrivalHeaderVis, { threadTitle: true, badges: true })}
                </div>
                <label className="settings-row">
                  <span>新着ID 文字サイズ補正 (0=同じ、±px)</span>
                  <input type="number" value={newArrivalIdFontSize} min={-20} max={24} onChange={(e) => setNewArrivalIdFontSize(Number(e.target.value))} className="lf-w60" />
                </label>
                <label className="settings-row lf-ai-flex-start">
                  <span className="lf-pt4">新着ID フォント</span>
                  <div className="font-picker">
                    <div className="lf-d-flex-gap4">
                      <input type="text" className="font-picker-input lf-grow" value={newArrivalIdFontPickerInput}
                        onChange={(e) => { setNewArrivalIdFontPickerInput(e.target.value); setNewArrivalIdFontPickerOpen(true); }}
                        onFocus={() => setNewArrivalIdFontPickerOpen(true)}
                        onBlur={() => setTimeout(() => setNewArrivalIdFontPickerOpen(false), 150)}
                        placeholder="デフォルト (入力またはクリック)" />
                      {newArrivalIdFontFamily && <button className="lf-shrink0" onClick={() => { setNewArrivalIdFontFamily(""); setNewArrivalIdFontPickerInput(""); }}>×</button>}
                    </div>
                    {newArrivalIdFontPickerOpen && (() => {
                      const q = newArrivalIdFontPickerInput.toLowerCase();
                      const filtered = q ? systemFonts.filter((f) => f.toLowerCase().includes(q)) : systemFonts;
                      return filtered.length > 0 ? (
                        <div className="font-picker-dropdown">
                          {filtered.slice(0, 120).map((f) => (
                            <div key={f} className={`font-picker-option${f === newArrivalIdFontFamily ? " selected" : ""}`} style={{ fontFamily: `"${f}", sans-serif` }}
                              onMouseDown={(e) => { e.preventDefault(); setNewArrivalIdFontFamily(f); setNewArrivalIdFontPickerInput(f); setNewArrivalIdFontPickerOpen(false); }}>{f}</div>
                          ))}
                        </div>
                      ) : null;
                    })()}
                  </div>
                </label>
              </fieldset>
              </section>
              <section className="settings-section" data-section="popup">
                {settingsSectionHeading("display", "popup")}
              <fieldset>
                <legend>ポップアップ</legend>
                <label className="settings-row">
                  <span>文字サイズ (ポップアップ)</span>
                  <input type="number" value={popupFontSize} min={8} max={40} onChange={(e) => setPopupFontSize(Number(e.target.value))} />
                </label>
                <label className="settings-row">
                  <span>最大幅 (ポップアップ) px</span>
                  <input type="number" value={popupMaxWidth} min={300} max={2400} step={20} onChange={(e) => setPopupMaxWidth(Number(e.target.value))} />
                </label>
                <label className="settings-row">
                  <span>最大高さ (ポップアップ) px</span>
                  <input type="number" value={popupMaxHeight} min={200} max={1800} step={20} onChange={(e) => setPopupMaxHeight(Number(e.target.value))} />
                </label>
              </fieldset>
              </section>
              </div>
              )}
              {(settingsSearching || settingsCategory === "posting") && (
              <div className="settings-cat" data-cat="posting">
              <section className="settings-section" data-section="main">
                {settingsSectionHeading("posting", "main")}
              <fieldset>
                <legend>書き込み</legend>
                <label className="settings-row">
                  <span>送信ショートカット</span>
                  <select value={composeSubmitKey} onChange={(e) => setComposeSubmitKey(e.target.value as "shift" | "ctrl")}>
                    <option value="shift">Shift+Enter</option>
                    <option value="ctrl">Ctrl+Enter</option>
                  </select>
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={composeSage} onChange={(e) => setComposeSage(e.target.checked)} />
                  <span>sage</span>
                </label>
                <label className="settings-row">
                  <span>書き込み文字サイズ</span>
                  <input type="number" value={composeFontSize} min={10} max={24} onChange={(e) => setComposeFontSize(Number(e.target.value))} />
                </label>
              </fieldset>
              <fieldset>
                <legend>Twitch・YouTube のチャットへの書き込み</legend>
                <label className="settings-row">
                  <input type="checkbox" checked={chatSendConfirm} onChange={(e) => setChatSendConfirm(e.target.checked)} />
                  <span>送る前に毎回、送信先と本文を確認する</span>
                </label>
                <p className="settings-hint">
                  チャットのタブを開いているときは、下の書き込み欄からそのチャットに送ります (Ctrl+Enter か送信ボタン。Enter では送りません)。
                  書き込み欄の中身はタブごとに別々で、送信先は欄の上に表示します。オフにすると確認なしで送ります。
                </p>
              </fieldset>
              </section>
              </div>
              )}
              {(settingsSearching || settingsCategory === "subtitle") && (
              <div className="settings-cat" data-cat="subtitle">
              <section className="settings-section" data-section="view">
                {settingsSectionHeading("subtitle", "view")}
              <fieldset>
                <legend>字幕の表示</legend>
                <div className="settings-row">
                  <span>本文フォントサイズ</span>
                  <input type="number" min={10} max={96} value={subtitleBodyFontSize} onChange={(e) => {
                    const v = Number(e.target.value);
                    setSubtitleBodyFontSize(v);
                  }} className="lf-w60" />
                </div>
                <div className="settings-row">
                  <span>メタフォントサイズ</span>
                  <input type="number" min={8} max={48} value={subtitleMetaFontSize} onChange={(e) => {
                    const v = Number(e.target.value);
                    setSubtitleMetaFontSize(v);
                  }} className="lf-w60" />
                </div>
                <div className="settings-row">
                  <span>背景透明度</span>
                  <input type="range" min={0} max={1.0} step={0.05} value={subtitleOpacity} onChange={(e) => {
                    const v = Number(e.target.value);
                    setSubtitleOpacity(v);
                  }} className="lf-w120" />
                  <span>{subtitleOpacity.toFixed(2)}</span>
                </div>
                <label className="settings-row" title="字幕の文字に黒い影を付けます。明るい背景に重ねても読みやすくなります">
                  <input type="checkbox" checked={subtitleTextShadow} onChange={(e) => setSubtitleTextShadow(e.target.checked)} />
                  <span>文字の影 (ドロップシャドウ) を付ける</span>
                </label>
                <div className="settings-row">
                  <span>常に最前面</span>
                  <input type="checkbox" checked={subtitleAlwaysOnTop} onChange={(e) => {
                    setSubtitleAlwaysOnTop(e.target.checked);
                  }} />
                </div>
                <div className="settings-row settings-row-stack">
                  <span>字幕のヘッダに表示する項目（非表示の項目は詰めて表示）</span>
                  {headerVisRows(subtitleHeaderVis, setSubtitleHeaderVis, { threadTitle: true, badges: true })}
                </div>
                <div className="settings-row">
                  <span>ID 文字サイズ補正 (0=メタと同じ、±px)</span>
                  <input type="number" min={-48} max={48} value={subtitleIdFontSize} onChange={(e) => {
                    const v = Number(e.target.value);
                    setSubtitleIdFontSize(v);
                  }} className="lf-w60" />
                </div>
                <div className="settings-row lf-ai-flex-start">
                  <span className="lf-pt4">ID フォント</span>
                  <div className="font-picker">
                    <div className="lf-d-flex-gap4">
                      <input type="text" className="font-picker-input lf-grow" value={subtitleIdFontPickerInput}
                        onChange={(e) => { setSubtitleIdFontPickerInput(e.target.value); setSubtitleIdFontPickerOpen(true); }}
                        onFocus={() => setSubtitleIdFontPickerOpen(true)}
                        onBlur={() => setTimeout(() => setSubtitleIdFontPickerOpen(false), 150)}
                        placeholder="デフォルト (入力またはクリック)" />
                      {subtitleIdFontFamily && <button className="lf-shrink0" onClick={() => {
                        setSubtitleIdFontFamily(""); setSubtitleIdFontPickerInput("");
                      }}>×</button>}
                    </div>
                    {subtitleIdFontPickerOpen && (() => {
                      const q = subtitleIdFontPickerInput.toLowerCase();
                      const filtered = q ? systemFonts.filter((f) => f.toLowerCase().includes(q)) : systemFonts;
                      return filtered.length > 0 ? (
                        <div className="font-picker-dropdown">
                          {filtered.slice(0, 120).map((f) => (
                            <div key={f} className={`font-picker-option${f === subtitleIdFontFamily ? " selected" : ""}`} style={{ fontFamily: `"${f}", sans-serif` }}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                setSubtitleIdFontFamily(f); setSubtitleIdFontPickerInput(f); setSubtitleIdFontPickerOpen(false);
                              }}>{f}</div>
                          ))}
                        </div>
                      ) : null;
                    })()}
                  </div>
                </div>
                <div className="settings-row">
                  <span>Twitch のスタンプの大きさ</span>
                  <input type="number" min={8} max={400} step={1} value={subtitleEmoteSize} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 8 && n <= 400) setSubtitleEmoteSize(n); }} className="lf-w70" />
                  <span>px / 巨大化</span>
                  <input type="number" min={16} max={800} step={1} value={subtitleGiantEmoteSize} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 16 && n <= 800) setSubtitleGiantEmoteSize(n); }} className="lf-w70" />
                  <span>px</span>
                </div>
                <div className="settings-row">
                  <span>ウィンドウ位置</span>
                  <button onClick={() => {
                    if (isTauriRuntime()) invoke("subtitle_reset_position").catch((e) => console.warn("subtitle_reset_position:", e));
                  }}>中央に戻す</button>
                </div>
              </fieldset>
              </section>
              <section className="settings-section" data-section="frame">
                {settingsSectionHeading("subtitle", "frame")}
              <fieldset>
                <legend>字幕の枠</legend>
                {([
                  ["normal", "通常", "Windows が付ける線と影があります。端をつかんで大きさを変えられます"],
                  ["corners", "四隅だけ", "線と影を消し、四隅に印だけを出します。印をつかんで大きさを変えられます"],
                  ["none", "枠なし", "文字とボタンだけを出します。大きさは下の数値か、字幕を右クリック →「枠・大きさの設定を開く」から変えます"],
                ] as [SubtitleFrameMode, string, string][]).map(([id, label, hint]) => (
                  <label key={id} className="settings-row" title={hint}>
                    <input type="radio" name="subtitle-frame" checked={subtitleFrameMode === id} onChange={() => setSubtitleFrameMode(id)} />
                    <span><b>{label}</b> <span className="settings-hint">({hint})</span></span>
                  </label>
                ))}
                <p className="settings-hint">字幕の上で右クリックすると、この設定を開く・位置をリセットするメニューが出ます。</p>
              </fieldset>
              <fieldset>
                <legend>大きさ・位置</legend>
                <div className="settings-row">
                  <span>幅</span>
                  <input type="number" min={120} max={10000} step={10} value={subtitleSizeInput.width} placeholder={String(subtitleWinSize.width)} onChange={(e) => setSubtitleSizeInput((v) => ({ ...v, width: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") applySubtitleSize(); }} className="lf-w70" />
                  <span>× 高さ</span>
                  <input type="number" min={40} max={10000} step={10} value={subtitleSizeInput.height} placeholder={String(subtitleWinSize.height)} onChange={(e) => setSubtitleSizeInput((v) => ({ ...v, height: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") applySubtitleSize(); }} className="lf-w70" />
                  <span>px</span>
                  <button onClick={applySubtitleSize}>この大きさにする</button>
                </div>
                <p className="settings-hint">今の大きさ: {subtitleWinSize.width} × {subtitleWinSize.height} px (字幕を手で大きさ変更すると、ここも変わります)</p>
                {subtitleSizeMsg && <p className="settings-hint overlay-layout-msg error">{subtitleSizeMsg}</p>}
                <div className="settings-row">
                  <span>位置</span>
                  <button onClick={() => { if (isTauriRuntime()) invoke("subtitle_reset_position").catch((e) => console.warn("subtitle_reset_position:", e)); }}>画面の中央に戻す</button>
                </div>
              </fieldset>
              </section>
              <section className="settings-section" data-section="cards">
                {settingsSectionHeading("subtitle", "cards")}
              <fieldset>
                <legend>カード表示</legend>
                <label className="settings-row">
                  <input type="checkbox" checked={subtitleCardsEnabled} onChange={(e) => setSubtitleCardsEnabled(e.target.checked)} />
                  <span>字幕ウィンドウにもカードを表示（表示 › リンクカードで OGP / X カードが ON のとき有効）</span>
                </label>
              </fieldset>
              </section>
              <section className="settings-section" data-section="scroll">
                {settingsSectionHeading("subtitle", "scroll")}
              <fieldset>
                <legend>自動スクロール</legend>
                <label className="settings-row">
                  <input type="checkbox" checked={subtitleSyncEnabled} onChange={(e) => setSubtitleSyncEnabled(e.target.checked)} />
                  <span>新着レスペインと字幕の次レス表示を同期する（両方が最下行まで表示し終えてから、長い方の「スクロール後の表示時間」を待って次へ。字幕を閉じているときは新着ペインの時間で進む）</span>
                </label>
                <div className="settings-row settings-row-stack">
                  <div className="settings-note">
                    字幕の自動スクロール（新着ペインとは別に設定。字幕は文字が大きい分、同じ速度でも時間がかかります）
                  </div>
                  {scrollTimingRows(subtitleTiming, setSubtitleTiming)}
                </div>
              </fieldset>
              </section>
              </div>
              )}
              {(settingsSearching || settingsCategory === "tts") && (
              <div className="settings-cat" data-cat="tts">
              <section className="settings-section" data-section="main">
                {settingsSectionHeading("tts", "main")}
              <fieldset>
                <legend>音声読み上げ</legend>
                <div className="settings-row">
                  <span>モード</span>
                  <select value={ttsMode} onChange={(e) => setTtsMode(e.target.value as TtsMode)}>
                    <option value="off">OFF</option>
                    <option value="sapi">SAPI (Windows標準)</option>
                    <option value="bouyomi">棒読みちゃん</option>
                    <option value="voicevox">VOICEVOX</option>
                  </select>
                </div>
                <div className="settings-row">
                  <span>自動読み上げ</span>
                  <input type="checkbox" checked={ttsEnabled} onChange={(e) => setTtsEnabled(e.target.checked)} />
                </div>
                <div className="settings-row">
                  <span>最大文字数 (0=無制限)</span>
                  <input type="number" min={0} max={300} step={1} value={ttsMaxReadLength} onChange={(e) => setTtsMaxReadLength(Number(e.target.value))} className="lf-w70" />
                </div>
                <label className="settings-row" title="読み上げ辞書・読み上げ許可リストに一致しないURLを、黙って飛ばす代わりに「URL省略」と読みます。URLが続けて並んでいる場合は1回だけ読みます">
                  <input type="checkbox" checked={ttsUrlOmitEnabled} onChange={(e) => setTtsUrlOmitEnabled(e.target.checked)} />
                  <span>読まないURLを「URL省略」と読む</span>
                </label>
                <div className="settings-row" title="掲示板の新着レスの読み上げ方です (Twitch のチャットには関係しません)。「ホワイトリスト以外はレス番のみ」では、配信ホワイトリストに入れた ID のレスは本文まで読み、それ以外のレスは「レスN番さん」(したらばは「したらばN番さん」、JPNKN は「ジャパンくんN番さん」) のように番号だけを読みます">
                  <span>掲示板の新着の読み上げ方</span>
                  <select value={ttsBoardMode} onChange={(e) => setTtsBoardMode(e.target.value === "whitelist" ? "whitelist" : "full")}>
                    <option value="full">全文を読む (従来)</option>
                    <option value="whitelist">ホワイトリスト以外はレス番のみ</option>
                  </select>
                </div>
                {ttsMode === "sapi" && (
                  <>
                    <div className="settings-row">
                      <span>ボイス</span>
                      <select value={sapiVoiceIndex} onChange={(e) => setSapiVoiceIndex(Number(e.target.value))}>
                        {sapiVoices.map((v) => <option key={v.index} value={v.index}>{v.name}</option>)}
                      </select>
                      <button onClick={() => {
                        if (isTauriRuntime()) invoke<{ index: number; name: string }[]>("sapi_list_voices").then(setSapiVoices).catch((e) => console.warn("sapi_list_voices:", e));
                      }}>取得</button>
                    </div>
                    <div className="settings-row">
                      <span>速度 (-10〜+10)</span>
                      <input type="number" min={-10} max={10} value={sapiRate} onChange={(e) => setSapiRate(Number(e.target.value))} className="lf-w60" />
                    </div>
                    <div className="settings-row">
                      <span>音量 (0〜100)</span>
                      <input type="number" min={0} max={100} value={sapiVolume} onChange={(e) => setSapiVolume(Number(e.target.value))} className="lf-w60" />
                    </div>
                  </>
                )}
                {ttsMode === "bouyomi" && (
                  <>
                    <div className="settings-row">
                      <span>RemoteTalk.exe パス</span>
                      <input type="text" value={bouyomiPath} onChange={(e) => setBouyomiPath(e.target.value)} className="lf-w160" placeholder="C:\...\RemoteTalk.exe" />
                      <button onClick={() => {
                        if (!isTauriRuntime()) return;
                        invoke<string | null>("open_file_dialog", { filterName: "EXE ファイル", filterExt: "*.exe" })
                          .then((p) => { if (p) setBouyomiPath(p); })
                          .catch(() => {});
                      }}>参照...</button>
                    </div>
                  </>
                )}
                {ttsMode === "voicevox" && (
                  <>
                    <div className="settings-row">
                      <span>エンドポイント</span>
                      <input type="text" value={voicevoxEndpoint} onChange={(e) => setVoicevoxEndpoint(e.target.value)} className="lf-w200" />
                    </div>
                    <div className="settings-row">
                      <span>スピーカー</span>
                      <select value={voicevoxSpeakerId} onChange={(e) => setVoicevoxSpeakerId(Number(e.target.value))}>
                        {voicevoxSpeakers.length === 0 && <option value={0}>未取得</option>}
                        {voicevoxSpeakers.flatMap((s) => s.styles.map((st) => (
                          <option key={st.id} value={st.id}>{s.name} - {st.name}</option>
                        )))}
                      </select>
                      <button onClick={() => {
                        if (isTauriRuntime()) invoke<{ name: string; styles: { name: string; id: number }[] }[]>("voicevox_get_speakers", { endpoint: voicevoxEndpoint }).then(setVoicevoxSpeakers).catch((e) => console.warn("voicevox_get_speakers:", e));
                      }}>取得</button>
                    </div>
                    <div className="settings-row">
                      <span>速度 (0.5〜2.0)</span>
                      <input type="number" min={0.5} max={2.0} step={0.1} value={voicevoxSpeedScale} onChange={(e) => setVoicevoxSpeedScale(Number(e.target.value))} className="lf-w60" />
                    </div>
                    <div className="settings-row">
                      <span>ピッチ (-0.15〜+0.15)</span>
                      <input type="number" min={-0.15} max={0.15} step={0.01} value={voicevoxPitchScale} onChange={(e) => setVoicevoxPitchScale(Number(e.target.value))} className="lf-w60" />
                    </div>
                    <div className="settings-row">
                      <span>抑揚 (0〜2.0)</span>
                      <input type="number" min={0} max={2.0} step={0.1} value={voicevoxIntonationScale} onChange={(e) => setVoicevoxIntonationScale(Number(e.target.value))} className="lf-w60" />
                    </div>
                    <div className="settings-row">
                      <span>音量 (0〜2.0)</span>
                      <input type="number" min={0} max={2.0} step={0.1} value={voicevoxVolumeScale} onChange={(e) => setVoicevoxVolumeScale(Number(e.target.value))} className="lf-w60" />
                    </div>
                  </>
                )}
                <div className="settings-row">
                  <button onClick={() => ttsSpeak("テスト読み上げです")}>テスト</button>
                  <button onClick={() => ttsStop()}>停止</button>
                </div>
              </fieldset>
              </section>
              </div>
              )}
              {(settingsSearching || settingsCategory === "tts-dict") && (
              <div className="settings-cat" data-cat="tts-dict">
              <div className="settings-row settings-hint mask-note">
                <span>登録項目のマスク: {streamMaskEnabled ? "オン (登録内容を伏せて表示中)" : "オフ"}</span>
                <button onClick={() => requestSwitchSettingsCategory("display")}>設定 &gt; 表示 で切り替え</button>
              </div>
              <section className="settings-section" data-section="dict">
                {settingsSectionHeading("tts-dict", "dict")}
              <fieldset>
                <legend>読み上げ辞書 ({ttsDictEntries.length}件)</legend>
                {settingsListFilterRow()}
                <div className="settings-note settings-note-block">
                  「全文置換」: テキストにキーワードが含まれる場合、レス全体を「読み上げテキスト」で置換します。<br />
                  URL はキーワードに「://」を含む項目なら URL 文字列との部分一致、含まない項目ならホスト名との部分一致 (例: youtube) で照合し、
                  一致した URL 全体を読み上げテキストに置き換えます。どの項目にも一致しない URL は読み上げません。
                </div>
                <table data-search-exclude="1" className="settings-table">
                  <thead>
                    <tr className="settings-table-head">
                      <th className="lf-p2-6">キーワード</th>
                      <th className="lf-p2-6">読み上げテキスト</th>
                      <th className="lf-p2-6-ta-center">全文置換</th>
                      <th className="lf-p2-6"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {ttsDictEntries.map((entry, i) => ({ entry, i })).filter(({ entry }) => settingsListMatch(entry.from, entry.to)).map(({ entry, i }) => (
                      <tr key={i} className="settings-table-row">
                        <td className="lf-p3-6">
                          <input type="text" value={entry.from} onChange={(e) => setTtsDictEntries((prev) => prev.map((x, j) => j === i ? { ...x, from: e.target.value } : x))} className="lf-w220" />
                        </td>
                        <td className="lf-p3-6">
                          <input type="text" value={entry.to} onChange={(e) => setTtsDictEntries((prev) => prev.map((x, j) => j === i ? { ...x, to: e.target.value } : x))} className="lf-w220" />
                        </td>
                        <td className="lf-p3-6-ta-center">
                          <input type="checkbox" checked={!!entry.fullReplace} onChange={(e) => setTtsDictEntries((prev) => prev.map((x, j) => j === i ? { ...x, fullReplace: e.target.checked } : x))} />
                        </td>
                        <td className="lf-p3-6">
                          <button onClick={() => setTtsDictEntries((prev) => prev.filter((_, j) => j !== i))}>削除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="lf-d-flex-gap4-ai-center-mt4">
                  <input type="text" value={ttsDictNewFrom} onChange={(e) => setTtsDictNewFrom(e.target.value)} placeholder="キーワード" className="lf-w220" />
                  <span>→</span>
                  <input type="text" value={ttsDictNewTo} onChange={(e) => setTtsDictNewTo(e.target.value)} placeholder="読み上げテキスト" className="lf-w220" />
                  <label className="lf-d-flex-ai-center-gap2-fs11">
                    <input type="checkbox" checked={ttsDictNewFullReplace} onChange={(e) => setTtsDictNewFullReplace(e.target.checked)} />
                    全文置換
                  </label>
                  <button onClick={() => {
                    if (!ttsDictNewFrom) return;
                    setTtsDictEntries((prev) => [...prev, { from: ttsDictNewFrom, to: ttsDictNewTo, fullReplace: ttsDictNewFullReplace }]);
                    setTtsDictNewFrom(""); setTtsDictNewTo(""); setTtsDictNewFullReplace(false);
                  }}>追加</button>
                </div>
              </fieldset>
              </section>
              <section className="settings-section" data-section="allow">
                {settingsSectionHeading("tts-dict", "allow")}
              <fieldset>
                <legend>読み上げ許可リスト（IPアドレス配信URL） ({ttsIpAllow.length}件)</legend>
                {settingsListFilterRow()}
                <div className="settings-note settings-note-block">
                  ホスト部分が生の IP アドレス (例: 192.0.2.1:8030) の URL は、ここに登録されたものだけ「読み上げテキスト」で読み上げ、
                  未登録の IP アドレスは読み上げません。ポートを省略するとその IP の全ポートに一致します。ドメイン名の URL は上の読み上げ辞書で扱います。
                </div>
                <table data-search-exclude="1" className="settings-table">
                  <thead>
                    <tr className="settings-table-head">
                      <th className="lf-p2-6">IPアドレス[:ポート]</th>
                      <th className="lf-p2-6">読み上げテキスト</th>
                      <th className="lf-p2-6"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {ttsIpAllow.map((entry, i) => ({ entry, i })).filter(({ entry }) => settingsListMatch(entry.host, entry.to)).map(({ entry, i }) => (
                      <tr key={i} className="settings-table-row">
                        <td className="lf-p3-6">
                          <input type={maskInputType} value={entry.host} onChange={(e) => setTtsIpAllow((prev) => prev.map((x, j) => j === i ? { ...x, host: e.target.value } : x))} className="lf-w220" />
                        </td>
                        <td className="lf-p3-6">
                          <input type={maskInputType} value={entry.to} onChange={(e) => setTtsIpAllow((prev) => prev.map((x, j) => j === i ? { ...x, to: e.target.value } : x))} className="lf-w220" />
                        </td>
                        <td className="lf-p3-6">
                          <button onClick={() => setTtsIpAllow((prev) => prev.filter((_, j) => j !== i))}>削除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="lf-d-flex-gap4-ai-center-mt4">
                  <input type="text" value={ttsIpAllowNewHost} onChange={(e) => setTtsIpAllowNewHost(e.target.value)} placeholder="IPアドレス[:ポート]" className="lf-w220" />
                  <span>→</span>
                  <input type="text" value={ttsIpAllowNewTo} onChange={(e) => setTtsIpAllowNewTo(e.target.value)} placeholder="読み上げテキスト" className="lf-w220" />
                  <button onClick={() => {
                    const host = ttsIpAllowNewHost.trim();
                    if (!host) return;
                    setTtsIpAllow((prev) => [...prev, { host, to: ttsIpAllowNewTo }]);
                    setTtsIpAllowNewHost(""); setTtsIpAllowNewTo("");
                  }}>追加</button>
                </div>
              </fieldset>
              </section>
              <section className="settings-section" data-section="mute">
                {settingsSectionHeading("tts-dict", "mute")}
              <fieldset>
                <legend>読み上げない辞書 ({ttsMuteDict.names.length + ttsMuteDict.words.length + ttsMuteDict.ids.length}件)</legend>
                {settingsListFilterRow()}
                <div className="settings-note settings-note-block">
                  表示やあぼーんには影響せず、読み上げだけを抑制します。「/.../」で囲むと正規表現、それ以外は大小無視の部分一致です。<br />
                  レス本文ワード: 「レス全体を読まない」が OFF なら一致した語句だけを無音で除去、ON ならそのレス全体を読み上げません。<br />
                  名前・ワッチョイ / ID: 読み上げ文に含まれないため、一致したレス全体を常に読み上げません。
                </div>
                <table data-search-exclude="1" className="settings-table">
                  <thead>
                    <tr className="settings-table-head">
                      <th className="lf-p2-6">種類</th>
                      <th className="lf-p2-6">ワード</th>
                      <th className="lf-p2-6-ta-center">レス全体を読まない</th>
                      <th className="lf-p2-6"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(["names", "words", "ids"] as const).flatMap((kind) => ttsMuteDict[kind].map((entry, i) => ({ entry, i })).filter(({ entry }) => settingsListMatch(entry.value)).map(({ entry, i }) => (
                      <tr key={`${kind}-${i}`} className="settings-table-row">
                        <td className="lf-p3-6-ws-nowrap">{kind === "names" ? "名前・ワッチョイ" : kind === "words" ? "レス本文ワード" : "ID"}</td>
                        <td className="lf-p3-6">
                          <input type={maskInputType} value={entry.value} onChange={(e) => setTtsMuteDict((prev) => ({ ...prev, [kind]: prev[kind].map((x, j) => j === i ? { ...x, value: e.target.value } : x) }))} className="lf-w220" />
                        </td>
                        <td className="lf-p3-6-ta-center">
                          {kind === "words"
                            ? <input type="checkbox" checked={!!entry.skipWhole} onChange={(e) => setTtsMuteDict((prev) => ({ ...prev, [kind]: prev[kind].map((x, j) => j === i ? { ...x, skipWhole: e.target.checked } : x) }))} />
                            : <span className="settings-note">常に</span>}
                        </td>
                        <td className="lf-p3-6">
                          <button onClick={() => setTtsMuteDict((prev) => ({ ...prev, [kind]: prev[kind].filter((_, j) => j !== i) }))}>削除</button>
                        </td>
                      </tr>
                    )))}
                  </tbody>
                </table>
                <div className="lf-d-flex-gap4-ai-center-mt4-fwrap-wrap">
                  <select value={ttsMuteNewKind} onChange={(e) => setTtsMuteNewKind(e.target.value as TtsMuteKind)}>
                    <option value="words">レス本文ワード</option>
                    <option value="names">名前・ワッチョイ</option>
                    <option value="ids">ID</option>
                  </select>
                  <input type="text" value={ttsMuteNewValue} onChange={(e) => setTtsMuteNewValue(e.target.value)} placeholder="ワード または /正規表現/" className="lf-w220" />
                  {ttsMuteNewKind === "words" && (
                    <label className="lf-d-flex-ai-center-gap2-fs11">
                      <input type="checkbox" checked={ttsMuteNewSkipWhole} onChange={(e) => setTtsMuteNewSkipWhole(e.target.checked)} />
                      レス全体を読まない
                    </label>
                  )}
                  <button onClick={() => {
                    const v = ttsMuteNewValue.trim();
                    if (!v) return;
                    const skipWhole = ttsMuteNewKind === "words" ? ttsMuteNewSkipWhole : true;
                    setTtsMuteDict((prev) => ({ ...prev, [ttsMuteNewKind]: [...prev[ttsMuteNewKind], { value: v, skipWhole }] }));
                    setTtsMuteNewValue(""); setTtsMuteNewSkipWhole(false);
                  }}>追加</button>
                </div>
              </fieldset>
              </section>
              </div>
              )}
              {(settingsSearching || settingsCategory === "commands") && (
              <div className="settings-cat" data-cat="commands">
              <section className="settings-section" data-section="main">
                {settingsSectionHeading("commands", "main")}
              <fieldset>
                <legend>コマンド</legend>
                <p className="settings-hint">
                  右クリックメニューの「コマンド ▶︎」から、登録したプログラムや URL でリンク・選んだ文字などを開きます (Jane Style のコマンドと同じ置き換え文字が使えます)。
                  $LINK を使うものはリンク・画像の上で、$TEXT・$TEXTU・$TEXTE を使うものは文字を選んでいるときに出ます。
                </p>
                <p className="settings-hint">
                  置き換え文字: $LINK (リンク) / $TEXT (選んだ文字) / $TEXTU・$TEXTE (選んだ文字を URL 用に変換) / $URL (スレの URL) / $TITLE (スレのタイトル) / $BOARDNAME (板の名前) / $NUMBER (レス番号)。
                  プログラムは「参照」で選んだ .exe だけ登録できます。信頼できるプログラムだけを登録してください。
                </p>
                {userCommands.length > 0 && (
                  <table data-search-exclude="1" className="settings-table command-table">
                    <thead>
                      <tr className="settings-table-head">
                        <th className="lf-p2-6-ta-center">有効</th>
                        <th className="lf-p2-6-ta-center" title="実行する前に確認する">確認</th>
                        <th className="lf-p2-6">名前</th>
                        <th className="lf-p2-6">内容</th>
                        <th className="lf-p2-6"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {userCommands.map((c, i) => (
                        <tr key={c.id} className="settings-table-row">
                          <td className="lf-p3-6-ta-center">
                            <input type="checkbox" checked={c.enabled} onChange={(e) => void saveUserCommands(userCommands.map((x, j) => j === i ? { ...x, enabled: e.target.checked } : x))} />
                          </td>
                          <td className="lf-p3-6-ta-center">
                            <input type="checkbox" checked={c.confirm} title="実行する前に確認する" onChange={(e) => void saveUserCommands(userCommands.map((x, j) => j === i ? { ...x, confirm: e.target.checked } : x))} />
                          </td>
                          <td className="lf-p3-6">{c.name}</td>
                          <td className="lf-p3-6 command-detail">{c.kind === "program" ? `${c.program} ${c.args}` : c.url}</td>
                          <td className="lf-p3-6 command-ops">
                            <button disabled={i === 0} title="上へ" onClick={() => { const next = [...userCommands]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; void saveUserCommands(next); }}>↑</button>
                            <button disabled={i === userCommands.length - 1} title="下へ" onClick={() => { const next = [...userCommands]; [next[i + 1], next[i]] = [next[i], next[i + 1]]; void saveUserCommands(next); }}>↓</button>
                            <button onClick={() => void saveUserCommands(userCommands.filter((_, j) => j !== i))}>削除</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="settings-row">
                  <span>種類</span>
                  <select value={commandDraft.kind} onChange={(e) => setCommandDraft((d) => ({ ...d, kind: e.target.value === "url" ? "url" : "program" }))}>
                    <option value="program">プログラムで開く</option>
                    <option value="url">URL を開く</option>
                  </select>
                  <span>名前</span>
                  <input type="text" value={commandDraft.name} maxLength={60} placeholder="メニューに出る名前" onChange={(e) => setCommandDraft((d) => ({ ...d, name: e.target.value }))} className="lf-w160" />
                </div>
                {commandDraft.kind === "program" ? (
                  <>
                    <div className="settings-row">
                      <button onClick={() => {
                        invoke<string | null>("pick_command_program")
                          .then((path) => { if (path) setCommandDraft((d) => ({ ...d, program: path })); })
                          .catch((e) => setCommandMsg(String(e)));
                      }}>参照…</button>
                      <span className="command-program">{commandDraft.program || "(プログラムを選んでください)"}</span>
                    </div>
                    <div className="settings-row">
                      <span>引数</span>
                      <input type="text" value={commandDraft.args} placeholder={'"$LINK"'} onChange={(e) => setCommandDraft((d) => ({ ...d, args: e.target.value }))} className="command-input" />
                    </div>
                  </>
                ) : (
                  <div className="settings-row">
                    <span>URL</span>
                    <input type="text" value={commandDraft.url} placeholder="https://www.google.com/search?q=$TEXTU" onChange={(e) => setCommandDraft((d) => ({ ...d, url: e.target.value }))} className="command-input" />
                  </div>
                )}
                <label className="settings-row">
                  <input type="checkbox" checked={commandDraft.confirm} onChange={(e) => setCommandDraft((d) => ({ ...d, confirm: e.target.checked }))} />
                  <span>実行する前に確認する (開くプログラム・URL と渡す値を見せてから実行)</span>
                </label>
                <div className="settings-row">
                  <button
                    disabled={!commandDraft.name.trim() || (commandDraft.kind === "program" ? !commandDraft.program : !commandDraft.url.trim())}
                    onClick={() => {
                      const c: UserCommand = {
                        id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                        name: commandDraft.name.trim(),
                        kind: commandDraft.kind,
                        program: commandDraft.kind === "program" ? commandDraft.program : "",
                        args: commandDraft.kind === "program" ? commandDraft.args : "",
                        url: commandDraft.kind === "url" ? commandDraft.url.trim() : "",
                        enabled: true,
                        confirm: commandDraft.confirm,
                      };
                      void saveUserCommands([...userCommands, c]).then((ok) => { if (ok) setCommandDraft(emptyCommandDraft); });
                    }}
                  >追加</button>
                  <span>ひな形:</span>
                  <button onClick={() => {
                    setCommandDraft({ kind: "program", name: "VLC で開く", program: "", args: "\"$LINK\"", url: "", confirm: true });
                    setCommandMsg("「参照…」で vlc.exe を選んでから「追加」を押してください (通常は C:\\Program Files\\VideoLAN\\VLC\\vlc.exe)");
                  }}>VLC で開く</button>
                  <button onClick={() => {
                    setCommandDraft({ kind: "url", name: "Google で検索", program: "", args: "", url: "https://www.google.com/search?q=$TEXTU", confirm: true });
                    setCommandMsg("「追加」を押すと登録されます。文字を選んで右クリックすると「コマンド ▶」に出ます");
                  }}>Google で検索</button>
                </div>
                {commandMsg && <p className="settings-hint command-msg">{commandMsg}</p>}
              </fieldset>
              </section>
              </div>
              )}
              {(settingsSearching || settingsCategory === "proxy") && (
              <div className="settings-cat" data-cat="proxy">
              <section className="settings-section" data-section="main">
                {settingsSectionHeading("proxy", "main")}
              <fieldset className="proxy-box">
                <legend>プロキシ</legend>
                <div className="proxy-top">
                  <label><input type="checkbox" checked={proxyEnabled} onChange={(e) => setProxyEnabled(e.target.checked)} />Proxy を使う</label>
                  <label title="プロキシに古い控え (キャッシュ) を返さないよう頼みます"><input type="checkbox" checked={proxyNoCache} onChange={(e) => setProxyNoCache(e.target.checked)} disabled={!proxyEnabled} />Proxy 使用時にキャッシュを使用しない</label>
                </div>
                <div className={`proxy-grid${proxyEnabled ? "" : " proxy-off"}`}>
                  <span className="proxy-label">種類</span>
                  <select value={proxyType} onChange={(e) => setProxyType(e.target.value === "socks5" || e.target.value === "socks4" ? e.target.value : "http")} className="proxy-type" aria-label="プロキシの種類">
                    <option value="http">HTTP</option>
                    <option value="socks5">SOCKS5</option>
                    <option value="socks4">SOCKS4</option>
                  </select>
                  <span className="proxy-head proxy-head-host">ホスト</span>
                  <span className="proxy-head proxy-head-port">ポート</span>
                  <span className="proxy-label">受信用</span>
                  <input type="text" value={proxyReceive.host} onChange={(e) => setProxyReceive((p) => ({ ...p, host: e.target.value }))} placeholder="localhost" className="proxy-host" aria-label="受信用のホスト" spellCheck={false} />
                  <input type="text" value={proxyReceive.port} onChange={(e) => setProxyReceive((p) => ({ ...p, port: e.target.value }))} placeholder="8080" className="proxy-port" aria-label="受信用のポート" inputMode="numeric" />
                  <span />
                  <input type="text" value={proxyReceive.username} onChange={(e) => setProxyReceive((p) => ({ ...p, username: e.target.value }))} placeholder="ユーザー名" className="proxy-user" aria-label="受信用のユーザー名" autoComplete="off" spellCheck={false} />
                  <input type="password" value={proxyReceive.password} onChange={(e) => setProxyReceive((p) => ({ ...p, password: e.target.value }))} placeholder="パスワード" className="proxy-pass" aria-label="受信用のパスワード" autoComplete="off" />
                  <span className="proxy-label">送信用</span>
                  <input type="text" value={proxySend.host} onChange={(e) => setProxySend((p) => ({ ...p, host: e.target.value }))} placeholder="localhost" className="proxy-host" aria-label="送信用のホスト" spellCheck={false} />
                  <input type="text" value={proxySend.port} onChange={(e) => setProxySend((p) => ({ ...p, port: e.target.value }))} placeholder="8080" className="proxy-port" aria-label="送信用のポート" inputMode="numeric" />
                  <span />
                  <input type="text" value={proxySend.username} onChange={(e) => setProxySend((p) => ({ ...p, username: e.target.value }))} placeholder="ユーザー名" className="proxy-user" aria-label="送信用のユーザー名" autoComplete="off" spellCheck={false} />
                  <input type="password" value={proxySend.password} onChange={(e) => setProxySend((p) => ({ ...p, password: e.target.value }))} placeholder="パスワード" className="proxy-pass" aria-label="送信用のパスワード" autoComplete="off" />
                </div>
                <p className="settings-hint">
                  受信用は掲示板 (5ch・したらば・JPNKN) の板一覧・スレ一覧・レスの読み込み、送信用は書き込み・スレ立てに使います。
                  ホストが空欄の欄はプロキシを通しません。画像・リンクカード・Twitch・YouTube・更新の確認はプロキシを通しません。
                  ホストに http:// は付けず、ポートは数字だけを入れます。SOCKS は名前の問い合わせ (DNS) もプロキシに任せます。
                </p>
                <label className="settings-row">
                  <input type="checkbox" checked={proxyHttpMode} onChange={(e) => setProxyHttpMode(e.target.checked)} disabled={!proxyEnabled} />
                  <span>5ch の通信を http でプロキシに渡す (2chAPIProxy などのローカルプロキシ用)</span>
                </label>
                <p className="settings-hint">
                  2chAPIProxy は https の通信を素通しするため、5ch の読み込み・書き込みを処理させるにはこれをオンにします (5ch のアドレスを http の 5ch.net の形で渡します)。
                  種類が HTTP で、ホストが localhost / 127.0.0.1 の欄だけに効きます。2chAPIProxy の「2chへのアクセスにhttps(TLS)を利用する」を必ずオンにしてください
                  (オフだと、書き込みの内容や Cookie が暗号化されずにネットに出ます)。5ch.io への移転に対応した版 (2026.03.07 以降) の 2chAPIProxy が必要です。
                </p>
                {proxyEnabled && proxyHttpMode && (proxyType !== "http" || ![proxyReceive, proxySend].some((e) => isLocalProxyHost(e.host))) && (
                  <p className="settings-hint overlay-layout-msg error">種類が HTTP で、ホストが localhost / 127.0.0.1 の欄が無いため、http では渡しません。</p>
                )}
                <div className="settings-row">
                  <button onClick={saveProxySettings}>保存</button>
                  {proxyMsg && <span className={`overlay-layout-msg${proxyMsg.error ? " error" : ""}`}>{proxyMsg.text}</span>}
                </div>
              </fieldset>
              </section>
              </div>
              )}
              {(settingsSearching || settingsCategory === "highlights") && (
              <div className="settings-cat" data-cat="highlights">
              <section className="settings-section" data-section="word">
                {settingsSectionHeading("highlights", "word")}
              <fieldset>
                <legend>ワードハイライト ({textHighlights.filter((h) => h.type === "word").length}件)</legend>
                {settingsListFilterRow()}
                <div className="settings-row lf-gap4-fwrap-wrap-mb6">
                  <input
                    type="text"
                    placeholder="ワードを入力..."
                    className="lf-flex1-minw100"
                    value={hlWordInput}
                    onChange={(e) => setHlWordInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && hlWordInput.trim()) {
                        const next = [...textHighlights.filter((h) => h.pattern !== hlWordInput.trim() || h.type !== "word"), { pattern: hlWordInput.trim(), color: hlWordColor, type: "word" as const }];
                        persistTextHighlights(next);
                        setHlWordInput("");
                      }
                    }}
                  />
                  <button onClick={() => {
                    if (!hlWordInput.trim()) return;
                    const next = [...textHighlights.filter((h) => h.pattern !== hlWordInput.trim() || h.type !== "word"), { pattern: hlWordInput.trim(), color: hlWordColor, type: "word" as const }];
                    persistTextHighlights(next);
                    setHlWordInput("");
                  }}>追加</button>
                </div>
                <div className="settings-row lf-gap3-fwrap-wrap-mb8">
                  {HIGHLIGHT_COLORS.map((c) => (
                    <div key={c.color} title={c.name}
                      style={{ width: 18, height: 18, background: c.color, border: hlWordColor === c.color ? "2px solid var(--fg)" : "1px solid #888", borderRadius: 2, cursor: "pointer", flexShrink: 0 }}
                      onClick={() => setHlWordColor(c.color)}
                    />
                  ))}
                </div>
                <div data-search-exclude="1">
                {textHighlights.filter((h) => h.type === "word").length === 0 ? (
                  <div className="lf-c-sub-fs0_85em">登録なし</div>
                ) : (
                  <>
                    {textHighlights.filter((h) => h.type === "word" && settingsListMatch(h.pattern)).map((h, i) => (
                      <div key={i} className="settings-row lf-gap6">
                        <span style={{ width: 16, height: 16, display: "inline-block", background: h.color, border: "1px solid #888", borderRadius: 2, flexShrink: 0 }} />
                        <span className="lf-flex1-ov-hidden-to-ellipsis-ws-nowrap" title={h.pattern}>{h.pattern}</span>
                        <button className="lf-p1-6" onClick={() => persistTextHighlights(textHighlights.filter((x) => x !== h))}>削除</button>
                      </div>
                    ))}
                    <div className="settings-row lf-mt4">
                      <button onClick={() => persistTextHighlights(textHighlights.filter((h) => h.type !== "word"))}>全削除</button>
                    </div>
                  </>
                )}
                </div>
              </fieldset>
              </section>
              <section className="settings-section" data-section="name">
                {settingsSectionHeading("highlights", "name")}
              <fieldset>
                <legend>名前ハイライト ({textHighlights.filter((h) => h.type === "name").length}件)</legend>
                {settingsListFilterRow()}
                <div className="settings-row lf-gap4-fwrap-wrap-mb6">
                  <input
                    type="text"
                    placeholder="名前を入力..."
                    className="lf-flex1-minw100"
                    value={hlNameInput}
                    onChange={(e) => setHlNameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && hlNameInput.trim()) {
                        const next = [...textHighlights.filter((h) => h.pattern !== hlNameInput.trim() || h.type !== "name"), { pattern: hlNameInput.trim(), color: hlNameColor, type: "name" as const }];
                        persistTextHighlights(next);
                        setHlNameInput("");
                      }
                    }}
                  />
                  <button onClick={() => {
                    if (!hlNameInput.trim()) return;
                    const next = [...textHighlights.filter((h) => h.pattern !== hlNameInput.trim() || h.type !== "name"), { pattern: hlNameInput.trim(), color: hlNameColor, type: "name" as const }];
                    persistTextHighlights(next);
                    setHlNameInput("");
                  }}>追加</button>
                </div>
                <div className="settings-row lf-gap3-fwrap-wrap-mb8">
                  {HIGHLIGHT_COLORS.map((c) => (
                    <div key={c.color} title={c.name}
                      style={{ width: 18, height: 18, background: c.color, border: hlNameColor === c.color ? "2px solid var(--fg)" : "1px solid #888", borderRadius: 2, cursor: "pointer", flexShrink: 0 }}
                      onClick={() => setHlNameColor(c.color)}
                    />
                  ))}
                </div>
                <div data-search-exclude="1">
                {textHighlights.filter((h) => h.type === "name").length === 0 ? (
                  <div className="lf-c-sub-fs0_85em">登録なし</div>
                ) : (
                  <>
                    {textHighlights.filter((h) => h.type === "name" && settingsListMatch(h.pattern)).map((h, i) => (
                      <div key={i} className="settings-row lf-gap6">
                        <span style={{ width: 16, height: 16, display: "inline-block", background: h.color, border: "1px solid #888", borderRadius: 2, flexShrink: 0 }} />
                        <span className="lf-flex1-ov-hidden-to-ellipsis-ws-nowrap" title={h.pattern}>{h.pattern}</span>
                        <button className="lf-p1-6" onClick={() => persistTextHighlights(textHighlights.filter((x) => x !== h))}>削除</button>
                      </div>
                    ))}
                    <div className="settings-row lf-mt4">
                      <button onClick={() => persistTextHighlights(textHighlights.filter((h) => h.type !== "name"))}>全削除</button>
                    </div>
                  </>
                )}
                </div>
              </fieldset>
              </section>
              <section className="settings-section" data-section="id">
                {settingsSectionHeading("highlights", "id")}
              <fieldset>
                <legend>ID ハイライト（今日分） ({Object.keys(idHighlights).length}件)</legend>
                {settingsListFilterRow()}
                <div className="settings-row lf-gap4-fwrap-wrap-mb6">
                  <input
                    type="text"
                    placeholder="IDを入力..."
                    className="lf-flex1-minw100-font-family-monospace"
                    value={hlIdInput}
                    onChange={(e) => setHlIdInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && hlIdInput.trim()) {
                        persistIdHighlights({ ...idHighlights, [hlIdInput.trim()]: hlIdColor });
                        setHlIdInput("");
                      }
                    }}
                  />
                  <button onClick={() => {
                    if (!hlIdInput.trim()) return;
                    persistIdHighlights({ ...idHighlights, [hlIdInput.trim()]: hlIdColor });
                    setHlIdInput("");
                  }}>追加</button>
                </div>
                <div className="settings-row lf-gap3-fwrap-wrap-mb8">
                  {HIGHLIGHT_COLORS.map((c) => (
                    <div key={c.color} title={c.name}
                      style={{ width: 18, height: 18, background: c.color, border: hlIdColor === c.color ? "2px solid var(--fg)" : "1px solid #888", borderRadius: 2, cursor: "pointer", flexShrink: 0 }}
                      onClick={() => setHlIdColor(c.color)}
                    />
                  ))}
                </div>
                <div data-search-exclude="1">
                {Object.keys(idHighlights).length === 0 ? (
                  <div className="lf-c-sub-fs0_85em">登録なし</div>
                ) : (
                  <>
                    {Object.entries(idHighlights).filter(([id]) => settingsListMatch(id)).map(([id, color]) => (
                      <div key={id} className="settings-row lf-gap6">
                        <span style={{ width: 16, height: 16, display: "inline-block", background: color, border: "1px solid #888", borderRadius: 2, flexShrink: 0 }} />
                        <span className="lf-flex1-font-family-monospace">ID:{id}</span>
                        <button className="lf-p1-6" onClick={() => { const next = { ...idHighlights }; delete next[id]; persistIdHighlights(next); }}>削除</button>
                      </div>
                    ))}
                    <div className="settings-row lf-mt4">
                      <button onClick={() => persistIdHighlights({})}>全削除</button>
                    </div>
                  </>
                )}
                </div>
              </fieldset>
              </section>
              </div>
              )}
              {(settingsSearching || settingsCategory === "ng") && (
              <div className="settings-cat" data-cat="ng">
              <div className="settings-row settings-hint mask-note">
                <span>登録項目のマスク: {streamMaskEnabled ? "オン (登録内容を伏せて表示中)" : "オフ"}</span>
                <button onClick={() => requestSwitchSettingsCategory("display")}>設定 &gt; 表示 で切り替え</button>
              </div>
              <label className="settings-row lf-mb8" title="OFFにすると、通常あぼ～んのレスは前置き含め完全に読み上げをスキップします(透明あぼ～んと同じ扱い)">
                <input type="checkbox" checked={ngAboneSpeakEnabled} onChange={(e) => setNgAboneSpeakEnabled(e.target.checked)} />
                <span>通常あぼ～んを「あぼーん」と読み上げる</span>
              </label>
              {(["words", "ids", "names", "mails", "thread_words", "image_words"] as const).map((type) => (
                <section key={type} className="settings-section" data-section={type}>
                  {settingsSectionHeading("ng", type)}
                  <fieldset>
                    <legend>NG {NG_TYPE_LABELS[type]} ({ngFilters[type].length}件)</legend>
                    {type === "image_words" && <p className="settings-hint">本文に指定した単語を含むレスの画像だけを非表示にします。レス自体や本文は通常どおり表示されます。レス全体を隠したい場合はワードNGなどで「透明あぼ～ん」「通常あぼ～ん」を選んでください。</p>}
                    {ngAddFormFor(type)}
                    {type !== "image_words" && ngFilters[type].length > 0 && (
                      <div className="settings-row ng-bulk-row">
                        <span>この節のすべてを</span>
                        <button onClick={() => setAllNgModes(type, "abone")}>通常あぼ～んにする</button>
                        <button onClick={() => setAllNgModes(type, "hide")}>透明あぼ～んにする</button>
                      </div>
                    )}
                    {settingsListFilterRow()}
                    <div data-search-exclude="1">
                    {ngFilters[type].length === 0 ? (
                      <span className="ng-empty">(なし)</span>
                    ) : (
                      <ul className="ng-list">
                        {ngFilters[type].filter((entry) => settingsListMatch(ngVal(entry))).map((entry) => {
                          const v = ngVal(entry); const mode = ngEntryMode(entry); const scope = ngEntryScope(entry);
                          const isRegex = v.startsWith("/") && v.endsWith("/") && v.length > 2;
                          return (
                            <li key={v}>
                              {type !== "image_words" && (
                                <select
                                  className="ng-mode-select"
                                  value={mode}
                                  onChange={(e) => updateNgEntryMode(type, v, e.target.value as NgMode)}
                                >
                                  <option value="hide">透明あぼ～ん</option>
                                  <option value="abone">通常あぼ～ん</option>
                                </select>
                              )}
                              {scope !== "global" && <span className="ng-mode-label" style={{ background: scope === "board" ? "#2a7a2a" : "#2a5a9a", color: "#fff" }}>{scope === "board" ? "板" : "スレ"}</span>}
                              {isRegex && <span className="ng-mode-label lf-bg6b4c9a-c-fff">正規表現</span>}
                              <span>{maskDisplay(v)}</span>
                              <button className="ng-remove" onClick={() => removeNgEntry(type, v)}>×</button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    </div>
                  </fieldset>
                </section>
              ))}
              <section className="settings-section" data-section="invisible">
                {settingsSectionHeading("ng", "invisible")}
                <fieldset>
                  <legend>見えない文字を含むレス</legend>
                  <div className="settings-row">
                    <span>見えない文字を含むレス</span>
                    {ngInvisibleSelect()}
                  </div>
                  <p className="settings-hint">{NG_INVISIBLE_HINT}</p>
                </fieldset>
              </section>
              </div>
              )}
              {(settingsSearching || settingsCategory === "presets") && (
              <div className="settings-cat" data-cat="presets">
              <section className="settings-section" data-section="main">
                {settingsSectionHeading("presets", "main")}
              <fieldset>
                <legend>プリセット</legend>
                <div className="settings-row">
                  <span>現在の値の設定に名前を付けて保存し、あとから読み込めます（NG・辞書・ハイライトなどの登録内容は含みません）</span>
                </div>
                <div className="settings-row" data-search-exclude="1">
                  <input type="text" value={presetNameInput} onChange={(e) => setPresetNameInput(e.target.value)} list="settings-preset-names" placeholder="プリセット名" className="lf-w220" maxLength={64} />
                  <datalist id="settings-preset-names">
                    {settingsPresets.map((p) => <option key={p.name} value={p.name} />)}
                  </datalist>
                  <button disabled={!presetNameInput.trim()} onClick={() => {
                    const name = presetNameInput.trim();
                    const doSave = async () => {
                      try {
                        await invoke("save_settings_preset", { name, json: JSON.stringify(buildSettingsBundle(buildLayoutPrefsPayload(), buildAppSettingsMap(), false)) });
                        setPresetNameInput("");
                        setStatus(`プリセット「${name}」を保存しました`);
                        await refreshSettingsFiles();
                      } catch (e) { setStatus(`プリセットの保存に失敗: ${String(e)}`); }
                    };
                    if (settingsPresets.some((p) => p.name === name)) {
                      setAppConfirm({ title: "プリセットの上書き", message: `「${name}」は既にあります。上書きしますか？`, buttons: [
                        { label: "上書き", primary: true, onClick: () => { void doSave(); } },
                        { label: "キャンセル", onClick: () => {} },
                      ] });
                    } else {
                      void doSave();
                    }
                  }}>保存</button>
                </div>
                <div className="settings-file-list" data-search-exclude="1">
                  {settingsPresets.length === 0 && <div className="settings-file-empty">保存されたプリセットはありません</div>}
                  {settingsPresets.map((p) => (
                    <div key={p.name} className="settings-file-row">
                      <span className="settings-file-name">{p.name}</span>
                      <span className="settings-file-date">{formatUnixTime(p.savedAt)}</span>
                      <button onClick={() => setAppConfirm({ title: "プリセットの読み込み", message: `「${p.name}」を読み込んで現在の値の設定を置き換えます。よろしいですか？\n（現在の設定は自動バックアップに保存されます）`, buttons: [
                        { label: "読み込む", primary: true, onClick: () => { void (async () => {
                          try {
                            const raw = await invoke<string>("load_settings_preset", { name: p.name });
                            await createSettingsBackup(buildLayoutPrefsPayload(), buildAppSettingsMap());
                            setStatus(applySettingsBundle(raw, false) ? `プリセット「${p.name}」を読み込みました` : "プリセットの内容が不正です");
                            void refreshSettingsFiles();
                          } catch (e) { setStatus(`プリセットの読み込みに失敗: ${String(e)}`); }
                        })(); } },
                        { label: "キャンセル", onClick: () => {} },
                      ] })}>読み込む</button>
                      <button onClick={() => setAppConfirm({ title: "プリセットの削除", message: `「${p.name}」を削除します。よろしいですか？`, buttons: [
                        { label: "削除", danger: true, onClick: () => { void (async () => {
                          try { await invoke("delete_settings_preset", { name: p.name }); await refreshSettingsFiles(); }
                          catch (e) { setStatus(`削除に失敗: ${String(e)}`); }
                        })(); } },
                        { label: "キャンセル", onClick: () => {} },
                      ] })}>削除</button>
                    </div>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>自動バックアップ</legend>
                <div className="settings-row">
                  <span>「設定を保存」とリセットの前に、直前の設定（登録内容を含む）を自動で保存します（最新 20 件）。復元すると登録内容も戻ります</span>
                </div>
                <div className="settings-file-list" data-search-exclude="1">
                  {settingsBackups.length === 0 && <div className="settings-file-empty">バックアップはまだありません</div>}
                  {settingsBackups.map((b) => (
                    <div key={b.name} className="settings-file-row">
                      <span className="settings-file-name">{formatBackupName(b.name)}</span>
                      <button onClick={() => setAppConfirm({ title: "バックアップの復元", message: `${formatBackupName(b.name)} の設定に戻します（登録内容も含む）。よろしいですか？\n（現在の設定は自動バックアップに保存されます）`, buttons: [
                        { label: "復元", primary: true, onClick: () => { void (async () => {
                          try {
                            const raw = await invoke<string>("load_settings_backup", { name: b.name });
                            await createSettingsBackup(buildLayoutPrefsPayload(), buildAppSettingsMap());
                            setStatus(applySettingsBundle(raw, true) ? "バックアップから設定を復元しました" : "バックアップの内容が不正です");
                            void refreshSettingsFiles();
                          } catch (e) { setStatus(`復元に失敗: ${String(e)}`); }
                        })(); } },
                        { label: "キャンセル", onClick: () => {} },
                      ] })}>復元</button>
                    </div>
                  ))}
                </div>
              </fieldset>
              </section>
              </div>
              )}
              {(settingsSearching || settingsCategory === "reset") && (
              <div className="settings-cat" data-cat="reset">
              <section className="settings-section" data-section="main">
                {settingsSectionHeading("reset", "main")}
              <fieldset>
                <legend>リセット</legend>
                <div className="settings-row">
                  <span>すべての値の設定（表示・書き込み・読み上げ・字幕など）を初期値に戻します。実行前に現在の設定を自動バックアップに保存するので、「プリセット」タブの自動バックアップから戻せます</span>
                </div>
                <label className="settings-row">
                  <input type="checkbox" checked={resetIncludeLists} onChange={(e) => setResetIncludeLists(e.target.checked)} />
                  <span>NG・ハイライト・読み上げ辞書・許可リスト・読み上げない辞書・カードのドメイン設定などの登録内容も初期化する</span>
                </label>
                <div className="settings-row">
                  <button className="danger" onClick={() => setAppConfirm({ title: "設定のリセット", message: resetIncludeLists ? "値の設定と登録内容をすべて初期値に戻します。よろしいですか？" : "値の設定を初期値に戻します（登録内容はそのまま）。よろしいですか？", buttons: [
                    { label: "初期値に戻す", danger: true, onClick: () => { void resetSettingsToDefaults(); } },
                    { label: "キャンセル", onClick: () => {} },
                  ] })}>設定を初期値に戻す…</button>
                </div>
              </fieldset>
              </section>
              </div>
              )}
              {(settingsSearching || settingsCategory === "info") && (
              <div className="settings-cat" data-cat="info">
              <section className="settings-section" data-section="main">
                {settingsSectionHeading("info", "main")}
              <fieldset>
                <legend>情報</legend>
                <div className="settings-row"><span>バージョン</span><span>{currentVersion}</span>{updateAvailable && <span className="settings-hint lf-c-cc3300">新しいバージョンがあります{knownLatestVersion ? ` (v${knownLatestVersion})` : ""}</span>}</div>
                <label className="settings-row" title="オンにすると、起動時に1日1回だけ、公開している最新版の情報 (数百バイト) を確認します。オフにすると、ヘルプ > バージョン情報 を開いたときだけ確認します">
                  <input type="checkbox" checked={autoUpdateCheck} onChange={(e) => setAutoUpdateCheck(e.target.checked)} />
                  <span>起動時に新しいバージョンを確認する (1日1回)</span>
                </label>
                <div className="settings-row">
                  <span>GitHub</span>
                  <button onClick={() => { const url = "https://github.com/kaedekiku/LiveFakeTauri2"; if (isTauriRuntime()) void invoke("open_external_url", { url }).catch(() => window.open(url, "_blank")); else window.open(url, "_blank"); }}>GitHubページを開く</button>
                </div>
                <div className="settings-row">
                  <span>ライセンス</span>
                  <span>MIT License</span>
                </div>
                <div className="settings-row" title="LiveFakeに組み込まれている第三者製ライブラリのライセンス本文と著作権表示を表示します">
                  <span>サードパーティライセンス</span>
                  <button onClick={openThirdPartyLicenses}>表示する</button>
                </div>
              </fieldset>
              </section>
              </div>
              )}
              {(settingsSearching || settingsCategory === "connect") && (
              <div className="settings-cat" data-cat="connect">
              <section className="settings-section" data-section="main">
                {settingsSectionHeading("connect", "main")}
              <p className="settings-hint">開いているスレのタブと Twitch・YouTube のタブが、巡回・受信の対象です。ここからまとめて追加したり、読み上げをタブごとに切り替えたりできます。</p>
              <fieldset>
                <legend>Twitch チャンネル</legend>
                <div className="settings-row">
                  <input type="text" value={connectTwitchInput} onChange={(e) => setConnectTwitchInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitConnectTwitch(); }} placeholder="チャンネル名 (空白・カンマ区切りで複数)" className="lf-grow" />
                  <button onClick={submitConnectTwitch}>追加</button>
                </div>
              </fieldset>
              <fieldset>
                <legend>YouTube ライブ配信</legend>
                <div className="settings-row">
                  <input type="text" value={connectYoutubeInput} onChange={(e) => setConnectYoutubeInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitConnectYoutube(); }} placeholder={`ライブ配信の URL (空白・カンマ区切りで複数。同時に ${YOUTUBE_MAX_VIDEOS} 個まで)`} className="lf-grow" />
                  <button onClick={submitConnectYoutube}>追加</button>
                </div>
              </fieldset>
              <fieldset>
                <legend>スレッド</legend>
                <div className="settings-row">
                  <textarea value={connectThreadInput} onChange={(e) => setConnectThreadInput(e.target.value)} rows={2} placeholder="スレッドの URL (改行・空白区切りで複数)" className="lf-grow" />
                  <button onClick={submitConnectThreads}>追加</button>
                </div>
              </fieldset>
              <fieldset>
                <legend>開いているタブ（{threadTabs.length}件）</legend>
                {threadTabs.length === 0 ? (
                  <span className="ng-empty">(なし)</span>
                ) : (
                  <ul className="ng-list connect-list">
                    {threadTabs.map((t, i) => {
                      const ch = twitchChannelFromUrl(t.threadUrl);
                      const st = ch ? twitchStatusMap[ch] : undefined;
                      const yt = youtubeVideoFromUrl(t.threadUrl);
                      const ys = yt ? youtubeStatusMap[yt] : undefined;
                      const count = tabCacheRef.current.get(t.threadUrl)?.responses.length ?? 0;
                      const lamp = yt ? (ys?.state === "live" ? "ok" : ys?.state === "stopped" || ys?.state === "ended" ? "ng" : "wait")
                        : ch ? (st === "connected" ? "ok" : st === "disconnected" ? "ng" : "wait") : (count > 0 ? "ok" : "wait");
                      const stateLabel = yt ? (ys?.state === "live" ? "受信中" : ys?.state === "connecting" ? "接続中" : ys?.state === "retrying" ? "やり直し中" : ys?.state === "ended" ? "配信終了" : ys?.state === "stopped" ? "停止" : "待機中")
                        : ch ? (st === "connected" ? "受信中" : st === "disconnected" ? "切断" : st === "connecting" ? "接続中" : "待機中") : (count > 0 ? "取得済み" : "未取得");
                      return (
                        <li key={t.threadUrl} className={siteClassOf(t.threadUrl)}>
                          <span className={`connect-lamp ${lamp}`} />
                          <span className="connect-title" title={t.threadUrl}>{t.title}</span>
                          <span className="connect-state" title={ys?.message || undefined}>{stateLabel}</span>
                          {yt && (ys?.state === "stopped" || ys?.state === "ended" || ys?.state === "retrying") && (
                            <button onClick={() => reconnectYoutube(yt)} title={ys?.message || "つなぎ直します"}>つなぎ直す</button>
                          )}
                          {/* スレの埋まり具合 (TchViewer と同じ。Twitch・YouTube には埋まりが無いので出さない) */}
                          {!ch && !yt && count > 0 && (
                            <>
                              <progress className="connect-fill" max={1000} value={Math.min(count, 1000)} title={`${count}/1000`} />
                              <span className="connect-count">{count}/1000</span>
                            </>
                          )}
                          <label title="このタブの新着を読み上げる">
                            <input type="checkbox" checked={!t.ttsOff} onChange={() => toggleTabTts(t.threadUrl)} />読み上げ
                          </label>
                          {!ch && !yt && (
                            <label title="ビュワーの「選んだスレを流す」がオンのとき、このスレのレスをビュワーに流す">
                              <input type="checkbox" checked={t.viewerOn !== false} onChange={() => toggleTabViewer(t.threadUrl)} />ビュワー
                            </label>
                          )}
                          <button onClick={() => { setSettingsOpen(false); onTabClick(i); }}>開く</button>
                          <button className="ng-remove" onClick={() => closeTab(i)} title="タブを閉じる">×</button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </fieldset>
              </section>
              </div>
              )}
              {(settingsSearching || settingsCategory === "viewer") && (
              <div className="settings-cat" data-cat="viewer">
              <section className="settings-section" data-section="display">
                {settingsSectionHeading("viewer", "display")}
              <p className="settings-hint">
                板タブの左端の「ビュワー」に、Twitch・YouTube のチャットと、配信ホワイトリストの ID のレスをまとめて表示します。掲示板の新着の読み上げ方は 設定 &gt; 読み上げ (またはビュワー上部) で選びます。
              </p>
              <fieldset>
                <legend>ビュワーの文字</legend>
                <p className="settings-hint">ビュワーと下の「スレの最新レス」欄の文字です (OBS 表示の文字は「OBS 表示」のレイアウトで変えます)。</p>
                <label className="settings-row">
                  <span>文字サイズ (0=レスの文字サイズに合わせる)</span>
                  <input type="number" value={viewerFontSize} min={0} max={48} step={1} onChange={(e) => { const n = Math.round(Number(e.target.value)); setViewerFontSize(n >= 8 && n <= 48 ? n : 0); }} className="lf-w60" />
                  <span>px</span>
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={viewerFontBold} onChange={(e) => setViewerFontBold(e.target.checked)} />
                  <span>太字にする</span>
                </label>
              </fieldset>
              <fieldset>
                <legend>リンクカード・画像</legend>
                <label className="settings-row">
                  <input type="checkbox" checked={viewerCards} onChange={(e) => setViewerCards(e.target.checked)} />
                  <span>リンクカードを表示する</span>
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={viewerThumbs} onChange={(e) => setViewerThumbs(e.target.checked)} />
                  <span>画像のサムネイルを表示する</span>
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={viewerTwitchClickToLoad} onChange={(e) => setViewerTwitchClickToLoad(e.target.checked)} />
                  <span>Twitch・YouTube のチャットの画像・カードはクリックしてから読み込む</span>
                </label>
                <p className="settings-hint">
                  OBS 表示には出しません。画像・カードを読み込むと、リンク先のサーバーにこの PC の IP アドレスが伝わります。
                  LiveFake の画面ごと配信に映している場合は、画像も映るので注意してください。画像NG・サイズ上限 (設定 &gt; 表示 &gt; 画像) も効きます。
                </p>
              </fieldset>
              <fieldset>
                <legend>表示する項目</legend>
                <p className="settings-hint">ビュワーの見出しに出す項目です (この順に並びます。Twitch・YouTube のチャットは プラットフォーム・チャンネル・バッジ・名前・ID・日時)。OBS 表示の項目は「OBS 表示」のレイアウトで変えます。</p>
                {VIEWER_SHOW_LABELS.map(([k, label]) => (
                  <label key={k} className="settings-row">
                    <input type="checkbox" checked={viewerShow[k]} onChange={(e) => setViewerShow((prev) => ({ ...prev, [k]: e.target.checked }))} />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>「スレの最新レス」欄に出す項目</legend>
                <p className="settings-hint">この順に1行で並べます。1行に収まらないときは本文を省きます (プラットフォームは上の設定に従います)。</p>
                {LATEST_SHOW_LABELS.map(([k, label]) => (
                  <label key={k} className="settings-row">
                    <input type="checkbox" checked={latestShow[k]} onChange={(e) => setLatestShow((prev) => ({ ...prev, [k]: e.target.checked }))} />
                    <span>{label}</span>
                  </label>
                ))}
                <label className="settings-row lf-ai-flex-start">
                  <span className="lf-pt4">フォント</span>
                  <div className="font-picker">
                    <div className="lf-d-flex-gap4">
                      <input type="text" className="font-picker-input lf-grow" value={viewerFontPickerInput}
                        onChange={(e) => { setViewerFontPickerInput(e.target.value); setViewerFontPickerOpen(true); }}
                        onFocus={() => setViewerFontPickerOpen(true)}
                        onBlur={() => setTimeout(() => setViewerFontPickerOpen(false), 150)}
                        placeholder="アプリ全体と同じ (入力またはクリック)" />
                      {viewerFontFamily && <button className="lf-shrink0" onClick={() => { setViewerFontFamily(""); setViewerFontPickerInput(""); }}>×</button>}
                    </div>
                    {viewerFontPickerOpen && (() => {
                      const q = viewerFontPickerInput.toLowerCase();
                      const filtered = q ? systemFonts.filter((f) => f.toLowerCase().includes(q)) : systemFonts;
                      return filtered.length > 0 ? (
                        <div className="font-picker-dropdown">
                          {filtered.slice(0, 120).map((f) => (
                            <div key={f} className={`font-picker-option${f === viewerFontFamily ? " selected" : ""}`} style={{ fontFamily: `"${f}", sans-serif` }}
                              onMouseDown={(e) => { e.preventDefault(); setViewerFontFamily(f); setViewerFontPickerInput(f); setViewerFontPickerOpen(false); }}>{f}</div>
                          ))}
                        </div>
                      ) : null;
                    })()}
                  </div>
                </label>
              </fieldset>
              </section>
              <section className="settings-section" data-section="whitelist">
                {settingsSectionHeading("viewer", "whitelist")}
              <div className="settings-row settings-hint mask-note">
                <span>登録項目のマスク: {streamMaskEnabled ? "オン (登録内容を伏せて表示中)" : "オフ"}</span>
                <button onClick={() => requestSwitchSettingsCategory("display")}>設定 &gt; 表示 で切り替え</button>
              </div>
              <fieldset>
                <legend>ID を入れる</legend>
                <p className="settings-hint">ID を入力するか貼り付けて「追加」を押します。空白・改行・カンマで区切れば複数をまとめて入れられます (先頭の「ID:」は省いてかまいません)。</p>
                <div className="settings-row">
                  <input type={maskInputType} value={whitelistInput} onChange={(e) => setWhitelistInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitWhitelistInput(); }} placeholder="例: AbCdEfGh0 IjKlMnOp0" className="lf-grow" />
                  <button onClick={submitWhitelistInput}>追加</button>
                </div>
              </fieldset>
              <fieldset>
                <legend>自動追加</legend>
                <label className="settings-row">
                  <input type="checkbox" checked={whitelistAutoConfig.enabled} onChange={(e) => setWhitelistAutoConfig((c) => ({ ...c, enabled: e.target.checked }))} />
                  <span>登録した単語を本文に含むレスの ID を自動でホワイトリストに入れる</span>
                </label>
                <p className="settings-hint">開いているスレの新着が対象です (Twitch・NG に当たるレスは対象外)。1行に1つ。部分一致で、/…/ で囲むと正規表現として扱います。今日手で外した ID は自動では入れ直しません。</p>
                <textarea className={[streamMaskEnabled ? "masked-text" : undefined, "lf-full-width"].filter(Boolean).join(" ")} value={whitelistAutoConfig.words} onChange={(e) => setWhitelistAutoConfig((c) => ({ ...c, words: e.target.value }))} rows={4} placeholder={"例:\n配信者さんへ\n/質問[:：]/"} />
                <div className="settings-row">
                  <span>1日に自動で入れる上限</span>
                  <input type="number" min={1} max={100} step={1} value={whitelistAutoConfig.limit} onChange={(e) => setWhitelistAutoConfig((c) => ({ ...c, limit: Math.max(1, Math.min(100, Math.round(Number(e.target.value)) || 1)) }))} className="lf-w70" />
                  <span>件 (今日 {Object.keys(whitelistAuto).length} 件)</span>
                </div>
              </fieldset>
              <fieldset>
                <legend>配信ホワイトリスト（本日分・{Object.keys(broadcastWhitelist).length}件）</legend>
                <p className="settings-hint">レスを右クリックして「配信ホワイトリストに追加」でも登録できます。日本時間の今日の分は保存され、LiveFake を再起動しても残ります (日付が変わると空に戻ります)。</p>
                {Object.keys(broadcastWhitelist).length === 0 ? (
                  <span className="ng-empty">(なし)</span>
                ) : (
                  <ul className="ng-list">
                    {Object.keys(broadcastWhitelist).map((id) => (
                      <li key={id}>
                        <span>ID:{maskDisplay(id)}</span>
                        {whitelistAuto[id] && <span className="settings-hint">自動: {maskDisplay(whitelistAuto[id])}</span>}
                        <button className="ng-remove" onClick={() => removeFromWhitelist(id)} title="削除">×</button>
                      </li>
                    ))}
                  </ul>
                )}
              </fieldset>
              {whitelistRemoved.length > 0 && (
                <fieldset>
                  <legend>今日外した ID（{whitelistRemoved.length}件）</legend>
                  <p className="settings-hint">自動追加では入れ直しません。必要なら「入れ直す」を押してください。</p>
                  <ul className="ng-list">
                    {whitelistRemoved.map((id) => (
                      <li key={id}>
                        <span>ID:{maskDisplay(id)}</span>
                        <button onClick={() => addToWhitelist([id])}>入れ直す</button>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              )}
              </section>
              <section className="settings-section" data-section="obs">
                {settingsSectionHeading("viewer", "obs")}
              <fieldset>
                <legend>OBS 表示 (ブラウザソース)</legend>
                <p className="settings-hint">ビュワーと同じ内容を OBS に表示します。OBS の「ソース」→「ブラウザ」の URL に下のアドレスを入れてください。このPCの中からだけ見られます (ポート開放は不要です)。</p>
                <div className="settings-row">
                  <span>OBS 表示を使う</span>
                  <label className="switch">
                    <input type="checkbox" checked={overlayEnabled} onChange={(e) => changeOverlayEnabled(e.target.checked)} />
                    <span className="track"><span className="knob"></span></span>
                  </label>
                  {overlayStatus && <span className="settings-hint">{overlayStatus}</span>}
                  <span className="settings-hint">(切り替えるとすぐ保存されます)</span>
                </div>
                <div className="settings-row">
                  <span>ポート</span>
                  <input type="number" min={1024} max={65535} step={1} value={overlayPort} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1024 && n <= 65535) setOverlayPort(n); }} className="lf-w90" />
                  <span className="settings-hint">既定 {OVERLAY_PORT_DEFAULT}</span>
                </div>
                <div className="settings-row">
                  <input type="text" readOnly value={overlayUrl} className="lf-grow" onFocus={(e) => e.currentTarget.select()} />
                  <button onClick={() => { void navigator.clipboard.writeText(overlayUrl); setStatus("OBS 表示の URL をコピーしました"); }}>コピー</button>
                  <button disabled={!overlayEnabled} onClick={() => { if (isTauriRuntime()) void invoke("overlay_publish", { items: [{ source: "5ch", site: "5ch", no: 1, name: "テスト", uid: "TEST0000", text: "OBS 表示のテストです", color: "" }, { source: "twitch", site: "Twitch", no: null, name: "テスト", uid: "", text: "Twitch のテストです", color: "#1e90ff" }] }).catch((e) => console.warn("overlay_publish failed", e)); }}>テスト表示</button>
                </div>
              </fieldset>
              <fieldset>
                <legend>レイアウト</legend>
                <p className="settings-hint">見た目に名前を付けて複数保存できます。選んだレイアウトを下で編集します。OBS では上の URL (レイアウトを選ぶと ?layout=名前 が付きます) をソースごとに使い分けられます。</p>
                <div className="settings-row">
                  <span>編集するレイアウト</span>
                  <select value={overlayEditingLayout} onChange={(e) => { setOverlayEditingLayout(e.target.value); setOverlayLayoutMsg(null); }}>
                    {Object.keys(overlayLayouts).sort((a, b) => (a === OVERLAY_DEFAULT_LAYOUT ? -1 : b === OVERLAY_DEFAULT_LAYOUT ? 1 : a.localeCompare(b, "ja"))).map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                  <button className="danger" disabled={overlayEditingLayout === OVERLAY_DEFAULT_LAYOUT} onClick={deleteOverlayLayout}>削除</button>
                </div>
                <div className="settings-row">
                  <input type="text" value={overlayLayoutNameInput} onChange={(e) => setOverlayLayoutNameInput(e.target.value)} placeholder="レイアウト名 (空なら自動で付けます)" maxLength={40} className="lf-grow" />
                  <button onClick={() => addOverlayLayout(null)} title="既定の見た目で新しいレイアウトを作ります">新規</button>
                  <button onClick={() => addOverlayLayout(overlayEditingLayout)} title="選んでいるレイアウトを複製します">複製</button>
                  <button disabled={overlayEditingLayout === OVERLAY_DEFAULT_LAYOUT} onClick={renameOverlayLayout}>名前を変更</button>
                </div>
                {overlayLayoutMsg && <p className={`settings-hint overlay-layout-msg${overlayLayoutMsg.error ? " error" : ""}`} role="status">{overlayLayoutMsg.text}</p>}
              </fieldset>
              <fieldset>
                <legend>OBS 表示の見た目 (共通)</legend>
                <div className="settings-row"><span>表示件数</span><input type="number" min={1} max={200} step={1} value={overlayAppearance.maxItems} onChange={(e) => setOverlayAppearance((p) => ({ ...p, maxItems: Math.min(200, Math.max(1, Number(e.target.value) || 0)) }))} className="lf-w70" /><span>件</span></div>
                <div className="settings-row"><span>消えるまで (0=消さない)</span><input type="number" min={0} max={3600} step={1} value={overlayAppearance.fadeSeconds} onChange={(e) => setOverlayAppearance((p) => ({ ...p, fadeSeconds: Math.min(3600, Math.max(0, Number(e.target.value) || 0)) }))} className="lf-w70" /><span>秒</span></div>
                <label className="settings-row"><input type="checkbox" checked={overlayAppearance.newestOnTop} onChange={(e) => setOverlayAppearance((p) => ({ ...p, newestOnTop: e.target.checked }))} /><span>新しいものを上に積む</span></label>
                <div className="settings-row"><span>間隔</span><input type="number" min={0} max={60} step={1} value={overlayAppearance.gap} onChange={(e) => setOverlayAppearance((p) => ({ ...p, gap: Math.min(60, Math.max(0, Number(e.target.value) || 0)) }))} className="lf-w70" /><span>px</span></div>
                <div className="settings-row"><span>縁取りの太さ (0=なし)</span><input type="number" min={0} max={8} step={0.5} value={overlayAppearance.outlineWidth} onChange={(e) => setOverlayAppearance((p) => ({ ...p, outlineWidth: Math.min(8, Math.max(0, Number(e.target.value) || 0)) }))} className="lf-w70" /><span>px</span></div>
                <div className="settings-row"><span>縁取りの色</span><input type="color" className="color-swatch" value={overlayAppearance.outlineColor} onChange={(e) => setOverlayAppearance((p) => ({ ...p, outlineColor: e.target.value }))} /></div>
                <div className="settings-row"><button onClick={() => setOverlayAppearance(() => DEFAULT_OVERLAY_APPEARANCE)}>見た目を既定に戻す</button></div>
              </fieldset>
              <fieldset>
                <legend>OBS 表示の見た目 (掲示板)</legend>
                <div className="settings-row"><span>文字サイズ</span><input type="number" min={8} max={120} step={1} value={overlayAppearance.board.fontSize} onChange={(e) => setOverlayAppearance((p) => ({ ...p, board: { ...p.board, fontSize: Math.min(120, Math.max(8, Number(e.target.value) || 0)) } }))} className="lf-w70" /><span>px</span></div>
                <div className="settings-row"><span>本文の色</span><input type="color" className="color-swatch" value={overlayAppearance.board.textColor} onChange={(e) => setOverlayAppearance((p) => ({ ...p, board: { ...p.board, textColor: e.target.value } }))} /></div>
                <div className="settings-row"><span>名前の色</span><input type="color" className="color-swatch" value={overlayAppearance.board.nameColor} onChange={(e) => setOverlayAppearance((p) => ({ ...p, board: { ...p.board, nameColor: e.target.value } }))} /></div>
                <div className="settings-row"><span>ID の色</span><input type="color" className="color-swatch" value={overlayAppearance.board.idColor} onChange={(e) => setOverlayAppearance((p) => ({ ...p, board: { ...p.board, idColor: e.target.value } }))} /></div>
                <div className="settings-row"><span>背景色</span><input type="color" className="color-swatch" value={overlayAppearance.board.bgColor} onChange={(e) => setOverlayAppearance((p) => ({ ...p, board: { ...p.board, bgColor: e.target.value } }))} /></div>
                <div className="settings-row"><span>背景の濃さ (0〜1)</span><input type="number" min={0} max={1} step={0.05} value={overlayAppearance.board.bgOpacity} onChange={(e) => setOverlayAppearance((p) => ({ ...p, board: { ...p.board, bgOpacity: Math.min(1, Math.max(0, Number(e.target.value) || 0)) } }))} className="lf-w70" /></div>
                <label className="settings-row"><input type="checkbox" checked={overlayAppearance.board.showSite} onChange={(e) => setOverlayAppearance((p) => ({ ...p, board: { ...p.board, showSite: e.target.checked } }))} /><span>出どころ (5ch など) を表示</span></label>
                <label className="settings-row"><input type="checkbox" checked={overlayAppearance.board.showNo} onChange={(e) => setOverlayAppearance((p) => ({ ...p, board: { ...p.board, showNo: e.target.checked } }))} /><span>レス番号を表示</span></label>
                <label className="settings-row"><input type="checkbox" checked={overlayAppearance.board.showName} onChange={(e) => setOverlayAppearance((p) => ({ ...p, board: { ...p.board, showName: e.target.checked } }))} /><span>名前を表示</span></label>
                <label className="settings-row"><input type="checkbox" checked={overlayAppearance.board.showId} onChange={(e) => setOverlayAppearance((p) => ({ ...p, board: { ...p.board, showId: e.target.checked } }))} /><span>ID を表示</span></label>
              </fieldset>
              <fieldset>
                <legend>OBS 表示の見た目 (Twitch・YouTube)</legend>
                <p className="settings-hint">YouTube のチャットも、この見た目で表示します (出どころの色は赤)。</p>
                <div className="settings-row"><span>文字サイズ</span><input type="number" min={8} max={120} step={1} value={overlayAppearance.twitch.fontSize} onChange={(e) => setOverlayAppearance((p) => ({ ...p, twitch: { ...p.twitch, fontSize: Math.min(120, Math.max(8, Number(e.target.value) || 0)) } }))} className="lf-w70" /><span>px</span></div>
                <div className="settings-row"><span>本文の色</span><input type="color" className="color-swatch" value={overlayAppearance.twitch.textColor} onChange={(e) => setOverlayAppearance((p) => ({ ...p, twitch: { ...p.twitch, textColor: e.target.value } }))} /></div>
                <div className="settings-row"><span>名前の色</span><input type="color" className="color-swatch" value={overlayAppearance.twitch.nameColor} onChange={(e) => setOverlayAppearance((p) => ({ ...p, twitch: { ...p.twitch, nameColor: e.target.value } }))} /></div>
                <div className="settings-row"><span>背景色</span><input type="color" className="color-swatch" value={overlayAppearance.twitch.bgColor} onChange={(e) => setOverlayAppearance((p) => ({ ...p, twitch: { ...p.twitch, bgColor: e.target.value } }))} /></div>
                <div className="settings-row"><span>背景の濃さ (0〜1)</span><input type="number" min={0} max={1} step={0.05} value={overlayAppearance.twitch.bgOpacity} onChange={(e) => setOverlayAppearance((p) => ({ ...p, twitch: { ...p.twitch, bgOpacity: Math.min(1, Math.max(0, Number(e.target.value) || 0)) } }))} className="lf-w70" /></div>
                <label className="settings-row"><input type="checkbox" checked={overlayAppearance.twitch.showSite} onChange={(e) => setOverlayAppearance((p) => ({ ...p, twitch: { ...p.twitch, showSite: e.target.checked } }))} /><span>出どころ (Twitch) を表示</span></label>
                <label className="settings-row"><input type="checkbox" checked={overlayAppearance.twitch.showName} onChange={(e) => setOverlayAppearance((p) => ({ ...p, twitch: { ...p.twitch, showName: e.target.checked } }))} /><span>名前を表示</span></label>
                <label className="settings-row"><input type="checkbox" checked={overlayAppearance.twitch.showBadges} onChange={(e) => setOverlayAppearance((p) => ({ ...p, twitch: { ...p.twitch, showBadges: e.target.checked } }))} /><span>バッジを表示</span></label>
                <div className="settings-row"><span>バッジの大きさ</span><input type="number" min={8} max={120} step={1} value={overlayAppearance.twitch.badgeSize} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 8 && n <= 120) setOverlayAppearance((p) => ({ ...p, twitch: { ...p.twitch, badgeSize: n } })); }} className="lf-w70" /><span>px</span></div>
                <div className="settings-row"><span>スタンプの大きさ</span><input type="number" min={8} max={200} step={1} value={overlayAppearance.twitch.emoteSize} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 8 && n <= 200) setOverlayAppearance((p) => ({ ...p, twitch: { ...p.twitch, emoteSize: n } })); }} className="lf-w70" /><span>px</span></div>
                <div className="settings-row"><span>巨大化したスタンプ (ビッツのパワーアップ) の大きさ</span><input type="number" min={16} max={600} step={1} value={overlayAppearance.twitch.giantEmoteSize} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 16 && n <= 600) setOverlayAppearance((p) => ({ ...p, twitch: { ...p.twitch, giantEmoteSize: n } })); }} className="lf-w70" /><span>px</span></div>
                <label className="settings-row"><input type="checkbox" checked={overlayAppearance.twitch.useUserColor} onChange={(e) => setOverlayAppearance((p) => ({ ...p, twitch: { ...p.twitch, useUserColor: e.target.checked } }))} /><span>視聴者が設定した名前の色を使う</span></label>
                <label className="settings-row"><input type="checkbox" checked={overlayAppearance.twitch.fixNameContrast} onChange={(e) => setOverlayAppearance((p) => ({ ...p, twitch: { ...p.twitch, fixNameContrast: e.target.checked } }))} /><span>名前の色が背景に溶けるときは読みやすく調整する</span></label>
              </fieldset>
              <fieldset>
                <legend>追加 CSS (このレイアウトだけに効きます)</legend>
                <p className="settings-hint">
                  このレイアウトの OBS 表示に読み込む CSS です。主なクラス: .msg .board .twitch .badge .name .text (詳しくはマニュアル 11.7)。
                </p>
                <textarea className="overlay-css-input" value={editingLayout.css} onChange={(e) => setOverlayLayoutCss(e.target.value)} rows={8} spellCheck={false} placeholder={"/* 例 */\n.msg { border-left-width: 8px; }"} />
              </fieldset>
              </section>
              </div>
              )}
              {(settingsSearching || settingsCategory === "twitch") && (
              <div className="settings-cat" data-cat="twitch">
              <section className="settings-section" data-section="main">
                {settingsSectionHeading("twitch", "main")}
              <p className="settings-hint">
                アドレスバーに twitch.tv/チャンネル名 を入れて移動すると、そのチャンネルのチャットを Twitch タブに表示します (ログイン不要・受信のみ)。
              </p>
              <fieldset>
                <legend>読み上げ</legend>
                <label className="settings-row" title="オフにすると、名前を付けずに本文だけを読み上げます">
                  <input type="checkbox" checked={twitchSpeakName} onChange={(e) => setTwitchSpeakName(e.target.checked)} />
                  <span>名前を読み上げる (「名前さん」+本文)</span>
                </label>
                <div className="settings-row">
                  <span>読み上げが溜まっているときの上限</span>
                  <input type="number" min={TWITCH_LIMIT_MIN} max={TWITCH_LIMIT_MAX} step={1} value={twitchMaxTtsBacklog} onChange={(e) => setTwitchMaxTtsBacklog(clampTwitchLimit(Number(e.target.value)))} className="lf-w70" />
                  <span>件</span>
                </div>
                <p className="settings-hint">読み上げ待ちがこの件数以上あるときは、新しく届いたチャットを読み上げに加えません (流れが速いときに読み上げが遅れ続けないように)。</p>
              </fieldset>
              <fieldset>
                <legend>新着レスペイン・字幕</legend>
                <div className="settings-row">
                  <span>溜めておく Twitch のチャットの上限</span>
                  <input type="number" min={TWITCH_LIMIT_MIN} max={TWITCH_LIMIT_MAX} step={1} value={twitchMaxQueuedArrivals} onChange={(e) => setTwitchMaxQueuedArrivals(clampTwitchLimit(Number(e.target.value)))} className="lf-w70" />
                  <span>件</span>
                </div>
                <p className="settings-hint">
                  表示待ちの Twitch のチャットがこの件数を超えたら、古いものから飛ばします (新着レスペインの「残 N」で確認できます)。
                </p>
              </fieldset>
              </section>
              <section className="settings-section" data-section="emotes">
                {settingsSectionHeading("twitch", "emotes")}
              <fieldset>
                <legend>スタンプ</legend>
                <p className="settings-hint">
                  チャットのスタンプを画像で表示します (Twitch タブ・新着レスペイン・ビュワー)。字幕の大きさは 設定 &gt; 字幕、OBS 表示はレイアウトで変えます。
                </p>
                <div className="settings-row">
                  <span>スタンプの大きさ</span>
                  <input type="number" min={8} max={200} step={1} value={twitchEmoteSize} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 8 && n <= 200) setTwitchEmoteSize(n); }} className="lf-w70" />
                  <span>px</span>
                </div>
                <div className="settings-row">
                  <span>巨大化したスタンプ (ビッツのパワーアップ) の大きさ</span>
                  <input type="number" min={16} max={600} step={1} value={twitchGiantEmoteSize} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 16 && n <= 600) setTwitchGiantEmoteSize(n); }} className="lf-w70" />
                  <span>px</span>
                </div>
                <div className="settings-row">
                  <span>スタンプの読み上げ</span>
                  <select value={twitchEmoteSpeak} onChange={(e) => setTwitchEmoteSpeak(e.target.value === "none" ? "none" : "name")}>
                    <option value="name">名前を読む</option>
                    <option value="none">読まない</option>
                  </select>
                  {twitchEmoteSpeak === "name" && (
                    <>
                      <span>同じスタンプは</span>
                      <input type="number" min={1} max={TWITCH_EMOTE_MAX_LIMIT} step={1} value={twitchEmoteMax} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= TWITCH_EMOTE_MAX_LIMIT) setTwitchEmoteMax(n); }} className="lf-w60" />
                      <span>個まで (1〜{TWITCH_EMOTE_MAX_LIMIT})</span>
                    </>
                  )}
                </div>
                <label className="settings-row">
                  <input type="checkbox" checked={boardEmotesEnabled} onChange={(e) => setBoardEmotesEnabled(e.target.checked)} />
                  <span>掲示板に書かれたスタンプ名も画像にする (スレのタブ・新着レスペイン・字幕・ビュワー・OBS 表示。頭に BIG を付けると巨大表示)</span>
                </label>
                <p className="settings-hint">
                  スタンプ名と大文字小文字まで一致した語を画像にします。
                  覚えているスタンプ: {emoteNameMapRef.current.size} 件 (24時間見かけないと消えます){emoteNameVersion >= 0 ? "" : ""}
                  <button className="lf-ml8" onClick={() => { emoteNameMapRef.current.clear(); emoteNameSeenRef.current.clear(); emoteNamesDirtyRef.current = false; saveToFile("twitch-emotes.json", { version: 2, emotes: {} }); setEmoteNameVersion((v) => v + 1); setEmoteFetchMsg(""); }}>覚えたスタンプを消す</button>
                  <button className="lf-ml4" disabled={twitchAuth.state !== "connected"} title={twitchAuth.state === "connected" ? "公式の窓口から一覧を取り直します" : "Twitch にログインすると使えます"} onClick={() => fetchTwitchEmotesNow(true)}>今すぐ取得</button>
                  {emoteFetchMsg && <span className="lf-ml6">{emoteFetchMsg}</span>}
                </p>
                <p className="settings-hint">
                  消しても、チャットに流れれば覚え直します。ログイン中は「今すぐ取得」でまとめて取り直せます。
                </p>
                <p className="settings-hint">スタンプは名前 (Kappa など) のまま読み上げに送ります。棒読みちゃんの教育や読み上げ辞書で読み方を変えられます。巨大化したスタンプも同じように読みます。</p>
              </fieldset>
              <fieldset>
                <legend>バッジ</legend>
                <label className="settings-row">
                  <input type="checkbox" checked={twitchBadgesEnabled} onChange={(e) => setTwitchBadgesEnabled(e.target.checked)} />
                  <span>バッジの画像とチャンネルポイントの報酬名を取得する</span>
                </label>
                <p className="settings-hint">
                  Twitch のサイトの非公式の取得口 (gql.twitch.tv) から、バッジ画像と報酬名を取得します (送るのはチャンネル名だけ)。仕様変更で使えなくなることがあります。
                </p>
              </fieldset>
              </section>
              <section className="settings-section" data-section="events">
                {settingsSectionHeading("twitch", "events")}
              <fieldset>
                <legend>イベント (サブスク・ビッツ・レイドなど)</legend>
                <p className="settings-hint">
                  お知らせを「【種類】要約」の1件で表示します。入力の無い報酬・自動報酬・フォローは、ログインした配信者本人のチャンネルだけです。
                  読み上げる文には {"{name}"} {"{months}"} {"{count}"} {"{bits}"} {"{viewers}"} {"{recipient}"} {"{reward}"} {"{message}"} を使えます。
                </p>
                <table className="twitch-event-table">
                  <thead><tr><th>種類</th><th>流す</th><th>読む</th><th>読み上げる文</th><th></th></tr></thead>
                  <tbody>
                    {TWITCH_EVENT_KINDS.map((k) => {
                      const e = twitchEventSettings[k.kind] ?? defaultTwitchEventSettings()[k.kind];
                      return (
                        <tr key={k.kind}>
                          <td>{k.label}</td>
                          <td><input type="checkbox" checked={e.show} onChange={(ev) => updateTwitchEvent(k.kind, { show: ev.target.checked })} title="ビュワー・OBS・新着レスペインに流す" /></td>
                          <td><input type="checkbox" checked={e.speak} disabled={!e.show} onChange={(ev) => updateTwitchEvent(k.kind, { speak: ev.target.checked })} title="読み上げる" /></td>
                          <td><input type="text" value={e.template} maxLength={TWITCH_EVENT_TEMPLATE_MAX} onChange={(ev) => updateTwitchEvent(k.kind, { template: ev.target.value })} onBlur={(ev) => { if (!ev.target.value.trim()) updateTwitchEvent(k.kind, { template: k.template }); }} className="lf-full-width" /></td>
                          <td><button onClick={() => testTwitchEvent(k.kind)} title="開いている Twitch タブに試しのイベントを流します">テスト</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="settings-row">
                  <button onClick={() => { setTwitchEventSettings(defaultTwitchEventSettings()); setTwitchEventTestMsg("イベントの設定を既定に戻しました"); }}>既定に戻す</button>
                  {twitchEventTestMsg && <span className="settings-hint">{twitchEventTestMsg}</span>}
                </div>
              </fieldset>
              </section>
              <section className="settings-section" data-section="teach">
                {settingsSectionHeading("twitch", "teach")}
              <fieldset>
                <legend>教育・忘却コマンド</legend>
                <label className="settings-row">
                  <input type="checkbox" checked={twitchTeachEnabled} onChange={(e) => setTwitchTeachEnabled(e.target.checked)} />
                  <span>Twitch のチャットの「教育(単語=読み)」「忘却(単語)」を受け付ける</span>
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={twitchTeachAnnounce} onChange={(e) => setTwitchTeachAnnounce(e.target.checked)} disabled={!twitchTeachEnabled} />
                  <span>「〇〇を覚えました」「〇〇を忘れました」と読み上げる</span>
                </label>
                <p className="settings-hint">
                  Twitch の視聴者が使えます (1人5秒に1回・掲示板からは不可)。VOICEVOX・SAPI は下の辞書に登録し、棒読みちゃんにはコマンドをそのまま渡します (棒読みちゃん側で管理)。
                </p>
              </fieldset>
              <fieldset>
                <legend>Twitch 教育辞書 ({twitchTeachDict.length}件)</legend>
                {settingsListFilterRow()}
                <div className="settings-note settings-note-block">
                  視聴者が教えた単語です。直す・手で追加・削除ができます (単語30字・読み50字・{TWITCH_TEACH_MAX}件まで。あなたの読み上げ辞書の単語は不可)。
                </div>
                <table data-search-exclude="1" className="settings-table">
                  <thead>
                    <tr className="settings-table-head">
                      <th className="lf-p2-6">単語</th>
                      <th className="lf-p2-6">読み</th>
                      <th className="lf-p2-6">教えた人</th>
                      <th className="lf-p2-6">日時</th>
                      <th className="lf-p2-6"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {twitchTeachDict.map((entry, i) => ({ entry, i })).reverse().filter(({ entry }) => settingsListMatch(entry.word, entry.reading)).map(({ entry, i }) => (
                      <tr key={`${i}-${entry.at}`} className="settings-table-row">
                        <td className="lf-p3-6">
                          <input type="text" value={entry.word} maxLength={30} onChange={(e) => updateTwitchTeachDict(twitchTeachDict.map((x, j) => (j === i ? { ...x, word: e.target.value } : x)))} className="lf-w120" />
                        </td>
                        <td className="lf-p3-6">
                          <input type="text" value={entry.reading} maxLength={50} onChange={(e) => updateTwitchTeachDict(twitchTeachDict.map((x, j) => (j === i ? { ...x, reading: e.target.value } : x)))} className="lf-w150" />
                        </td>
                        <td className="lf-p3-6-maxw110-ov-hidden-to-ellipsis-ws-nowrap" title={entry.by}>{maskDisplay(entry.by || "(手で追加)")}</td>
                        <td className="lf-p3-6-ws-nowrap">{entry.at ? (() => { const d = new Date(entry.at); const p2 = (n: number) => String(n).padStart(2, "0"); return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; })() : ""}</td>
                        <td className="lf-p3-6">
                          <button onClick={() => updateTwitchTeachDict(twitchTeachDict.filter((_, j) => j !== i))}>削除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="lf-d-flex-gap4-ai-center-mt4-fwrap-wrap">
                  <input type="text" value={twitchTeachNewWord} maxLength={30} onChange={(e) => setTwitchTeachNewWord(e.target.value)} placeholder="単語" className="lf-w120" />
                  <span>→</span>
                  <input type="text" value={twitchTeachNewReading} maxLength={50} onChange={(e) => setTwitchTeachNewReading(e.target.value)} placeholder="読み" className="lf-w150" />
                  <button onClick={() => {
                    const word = twitchTeachNewWord.trim();
                    const reading = twitchTeachNewReading.trim();
                    if (!teachWordOk(word, 30) || !teachWordOk(reading, 50)) { setTwitchTeachMsg("単語は1〜30文字、読みは1〜50文字で、URL は使えません"); return; }
                    if (ttsDictEntries.some((e) => e.from === word)) { setTwitchTeachMsg("あなたの読み上げ辞書にある単語です"); return; }
                    updateTwitchTeachDict([...twitchTeachDict.filter((e) => e.word !== word), { word, reading, by: "", at: Date.now() }].slice(-TWITCH_TEACH_MAX));
                    setTwitchTeachNewWord(""); setTwitchTeachNewReading(""); setTwitchTeachMsg("");
                  }}>追加</button>
                  <button className="danger" disabled={twitchTeachDict.length === 0} onClick={() => setAppConfirm({ title: "Twitch 教育辞書", message: "Twitch 教育辞書をすべて消しますか?", buttons: [{ label: "すべて消す", danger: true, onClick: () => updateTwitchTeachDict([]) }, { label: "キャンセル", onClick: () => {} }] })}>すべて消す</button>
                  {twitchTeachMsg && <span className="overlay-layout-msg error">{twitchTeachMsg}</span>}
                </div>
              </fieldset>
              </section>
              <section className="settings-section" data-section="login">
                {settingsSectionHeading("twitch", "login")}
              <fieldset>
                <legend>Twitch にログイン (任意)</legend>
                <p className="settings-hint">
                  チャットに書き込む・自分が使えるスタンプを一覧から選ぶにはログインします (視聴者のアカウントでも構いません)。
                  配信者本人のアカウントでログインすると、入力の無い報酬・自動報酬・フォローも表示できます。
                  求める許可は、報酬の引き換えとフォロワーの読み取り・チャットへの書き込み・使えるスタンプの一覧の読み取りです (ログイン情報は暗号化して保存)。
                  {twitchAuth.loggedIn && !twitchAuth.canChat && <><br /><b>書き込みの許可を追加しました。書き込むには「ログインし直す」を押してください。</b></>}
                </p>
                <div className="settings-row">
                  <span>状態</span>
                  <span>{twitchAuth.state === "connected" ? `ログイン中: ${twitchAuth.login} (受信中)`
                    : twitchAuth.state === "connecting" ? `ログイン中: ${twitchAuth.login} (接続しています)`
                    : twitchAuth.state === "waiting" ? "許可を待っています"
                    : twitchAuth.state === "error" ? (twitchAuth.loggedIn ? `ログイン中: ${twitchAuth.login} (エラー)` : "ログインしていません")
                    : "ログインしていません"}</span>
                </div>
                {twitchAuth.state === "waiting" && twitchAuth.userCode && (
                  <div className="twitch-login-code">
                    <div className="settings-hint">ブラウザで開いた Twitch のページに、次のコードを入力して「許可」を押してください。</div>
                    <div className="twitch-login-code-value">{twitchAuth.userCode}</div>
                    <button onClick={() => openTwitchActivatePage(twitchAuth.verificationUri)}>ページをもう一度開く</button>
                  </div>
                )}
                {twitchAuth.message && <p className={`settings-hint${twitchAuth.state === "error" ? " overlay-layout-msg error" : ""}`}>{twitchAuth.message}</p>}
                <div className="settings-row">
                  <button disabled={twitchAuthBusy || twitchAuth.state === "waiting"} onClick={() => void startTwitchLogin()}>{twitchAuth.loggedIn ? "ログインし直す" : "Twitch にログイン"}</button>
                  <button disabled={twitchAuthBusy || (!twitchAuth.loggedIn && twitchAuth.state !== "waiting")} onClick={logoutTwitch}>ログアウト</button>
                </div>
              </fieldset>
              </section>
              </div>
              )}
              {(settingsSearching || settingsCategory === "youtube") && (
              <div className="settings-cat" data-cat="youtube">
              <section className="settings-section" data-section="main">
                {settingsSectionHeading("youtube", "main")}
              <p className="settings-hint">
                アドレスバーに YouTube のライブ配信の URL (youtube.com/watch?v=… / youtube.com/live/… / youtu.be/…) を入れて移動すると、
                その配信のチャットを YouTube タブに表示します (受信のみ)。チャンネルの URL・アーカイブ・普通の動画には対応していません。
              </p>
              <fieldset>
                <legend>取得方法</legend>
                {youtubeMethods.length <= 1 ? (
                  <p className="settings-hint">{youtubeMethods[0] ? `${youtubeMethods[0].label}: ${youtubeMethods[0].description}` : "(読み込み中)"}</p>
                ) : youtubeMethods.map((m) => (
                  <label key={m.id} className="settings-row youtube-method" title={m.description}>
                    <input type="radio" name="youtube-method" checked={youtubeEffectiveMethod === m.id} onChange={() => setYoutubeMethod(m.id)} />
                    <span><b>{m.label}</b><br /><span className="settings-hint">{m.description}</span></span>
                  </label>
                ))}
              </fieldset>
              {youtubeEffectiveMethod === "api" && (
              <fieldset>
                <legend>API キー (YouTube Data API)</legend>
                <p className="settings-hint">
                  Google Cloud のコンソールでプロジェクトを作り、「YouTube Data API v3」を有効にして API キーを作ってください。
                  キーは「API の制限」で YouTube Data API v3 だけに絞っておくと安全です。キーはこの PC に暗号化して保存し、YouTube の API にだけ送ります。
                </p>
                <div className="settings-row">
                  <span>状態: {youtubeKeySet ? "設定済み" : "未設定"}</span>
                </div>
                <div className="settings-row">
                  <input type="password" value={youtubeKeyInput} onChange={(e) => setYoutubeKeyInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") saveYoutubeKey(); }} placeholder={youtubeKeySet ? "新しいキーで置き換える" : "API キー"} autoComplete="off" spellCheck={false} className="lf-grow" />
                  <button onClick={saveYoutubeKey}>保存</button>
                  <button disabled={!youtubeKeySet} onClick={clearYoutubeKey}>削除</button>
                </div>
                {youtubeKeyMsg && <p className={`settings-hint overlay-layout-msg${youtubeKeyMsg.error ? " error" : ""}`}>{youtubeKeyMsg.text}</p>}
              </fieldset>
              )}
              <fieldset>
                <legend>YouTube の規約</legend>
                <p className="settings-hint">
                  チャットは YouTube から取得しています。LiveFake はチャットを保存しません (タブを閉じる・終了すると消えます)。
                </p>
                <div className="settings-row">
                  <button onClick={() => { if (isTauriRuntime()) void invoke("open_external_url", { url: "https://www.youtube.com/t/terms" }).catch((e) => console.warn("open_external_url failed", e)); }}>YouTube 利用規約</button>
                  <button onClick={() => { if (isTauriRuntime()) void invoke("open_external_url", { url: "https://policies.google.com/privacy" }).catch((e) => console.warn("open_external_url failed", e)); }}>Google プライバシー ポリシー</button>
                </div>
              </fieldset>
              </section>
              <section className="settings-section" data-section="quota">
                {settingsSectionHeading("youtube", "quota")}
              {youtubeEffectiveMethod !== "api" ? (
                <p className="settings-hint">この節の設定は、取得方法が「YouTube Data API (公式)」のときに使います。</p>
              ) : (
              <>
              <fieldset>
                <legend>今日の使用量 (クォータ)</legend>
                <div className="settings-row youtube-quota-now">
                  <span>
                    使用量の目安: <b>{(youtubeQuota?.used ?? 0).toLocaleString()}</b> / {(youtubeQuota?.limit ?? youtubeDailyQuota).toLocaleString()}
                    {youtubeQuota && youtubeQuota.limit > 0 ? ` (${Math.min(100, Math.floor((youtubeQuota.used / youtubeQuota.limit) * 1000) / 10)}%)` : ""}
                    {youtubeQuota ? ` ・上限が戻るまで${formatAboutDuration(youtubeQuota.untilResetSecs)}` : ""}
                  </span>
                </div>
                <p className="settings-hint">
                  コメントを1回読み込むごとに 5 使います。LiveFake が呼んだ分だけを数えています (同じ API キーをほかのアプリで使った分は入りません。API キーを変えると 0 から数え直します)。
                  Google Cloud のコンソールの「割り当てとシステムの上限」に出ている値に合わせることもできます。上限は太平洋時間の0時 (日本時間の16〜17時) に戻ります。
                </p>
                <div className="settings-row">
                  <input type="text" inputMode="numeric" value={youtubeQuotaUsedInput} onChange={(e) => setYoutubeQuotaUsedInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") setYoutubeQuotaUsed(); }} placeholder="コンソールの値" className="lf-w120" />
                  <button disabled={!youtubeQuotaUsedInput.trim()} onClick={setYoutubeQuotaUsed}>この値に合わせる</button>
                </div>
                <div className="settings-row">
                  <span>1日の上限</span>
                  <input type="number" min={1} max={YOUTUBE_DAILY_QUOTA_MAX} step={1} value={youtubeDailyQuota} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= YOUTUBE_DAILY_QUOTA_MAX) setYoutubeDailyQuota(n); }} className="lf-w120" />
                  <span>(既定 10,000。Google に上限を増やしてもらったときだけ変えてください)</span>
                </div>
              </fieldset>
              <fieldset>
                <legend>コメントを読み込む間隔</legend>
                <p className="settings-hint">YouTube に新しいコメントを問い合わせる間隔です。短いほど早く表示されますが、使用量が増えます。</p>
                <label className="settings-row">
                  <input type="radio" name="youtube-quota-mode" checked={!youtubeTargetOn} onChange={() => setYoutubeTargetOn(false)} />
                  <span>決まった間隔で読み込む</span>
                </label>
                <label className="settings-row">
                  <input type="radio" name="youtube-quota-mode" checked={youtubeTargetOn} onChange={() => setYoutubeTargetOn(true)} />
                  <span>決めた時間もつように、間隔を自動で決める</span>
                </label>
                <div className="settings-row youtube-interval-input">
                  <span>{youtubeTargetOn ? "最短の間隔" : "間隔"}</span>
                  <input type="number" min={YOUTUBE_API_INTERVAL_MIN} max={YOUTUBE_API_INTERVAL_MAX} step={1} value={youtubeApiInterval} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= YOUTUBE_API_INTERVAL_MIN && n <= YOUTUBE_API_INTERVAL_MAX) setYoutubeApiInterval(n); }} className="lf-w70" />
                  <span>秒 ({YOUTUBE_API_INTERVAL_MIN}〜{YOUTUBE_API_INTERVAL_MAX})</span>
                </div>
                {youtubeTargetOn && (
                  <div className="settings-row youtube-interval-input">
                    <span className="yt-linked-label">もたせる時間</span>
                    <input type="number" min={1} max={YOUTUBE_TARGET_HOURS_MAX} step={1} value={youtubeTargetHours} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= YOUTUBE_TARGET_HOURS_MAX) setYoutubeTargetHours(n); }} className="lf-w70 yt-linked-input" />
                    <span>時間 (受信を始めた時刻から。<span className="yt-linked yt-linked-sample">色の付いた値</span>が、この値に合わせて変わります)</span>
                  </div>
                )}
                {youtubeQuota && (() => {
                  const q = youtubeQuota;
                  const n = Math.max(1, q.active);
                  const atMin = q.intervalSecs <= youtubeApiInterval;
                  // 目標の時刻より先に上限が戻るとき: 戻るまでは今の残りで、戻った後は 1 日分 (残す量を除く) で決め直す
                  const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
                  const endMs = q.targetEnd ?? Date.now() + youtubeTargetHours * 3600e3;
                  const resetMs = Date.now() + q.untilResetSecs * 1000;
                  const crossesReset = youtubeTargetOn && endMs > resetMs;
                  const after = (() => {
                    if (!crossesReset) return 0;
                    const rounds = Math.floor(Math.max(0, q.limit - q.reserve) / (5 * n));
                    return rounds > 0 ? Math.min(YOUTUBE_API_INTERVAL_MAX, Math.max(youtubeApiInterval, Math.ceil((endMs - resetMs) / 1000 / rounds))) : YOUTUBE_API_INTERVAL_MAX;
                  })();
                  return (
                    <div className="youtube-interval-result">
                      <div>→ 実際に読み込む間隔: <b className={youtubeTargetOn ? "yt-linked" : undefined} key={`iv${q.intervalSecs}`}>{q.intervalSecs} 秒ごと</b> (配信 {n} つ{q.active > 0 ? "を受信中" : "の場合"}){crossesReset ? ` ・上限が戻る ${hhmm(resetMs)} まで` : ""}</div>
                      {crossesReset && <div>→ 上限が戻った後 ({hhmm(resetMs)}〜目標の <span className="yt-linked" key={`ed${hhmm(endMs)}`}>{hhmm(endMs)}</span>): <b className="yt-linked" key={`af${after}`}>約 {after} 秒ごと</b> (戻った後の 1 日分で決め直します)</div>}
                      {youtubeTargetOn && (
                        <div>
                          {q.reachable
                            ? atMin
                              ? crossesReset
                                ? `目標の時刻より先に上限が戻ります。戻るまでは今の残り (${(Math.max(0, q.limit - q.used - q.reserve)).toLocaleString()}) で足りるので、最短の間隔のままです。もたせる時間を変えると、上限が戻った後の間隔が変わります。`
                                : `今の残り (${(Math.max(0, q.limit - q.used - q.reserve)).toLocaleString()}) なら最短の間隔でも目標までもつので、最短の間隔のままです。`
                              : `目標までもつように、最短の間隔 (${youtubeApiInterval} 秒) より延ばしています。もたせる時間を短くすると間隔が縮み、長くすると延びます。`
                            : `残りの量では目標までもちません (いちばん長い ${YOUTUBE_API_INTERVAL_MAX} 秒ごとにしても${formatAboutDuration(q.lastsSecs)})。開いている配信を減らすか、もたせる時間を短くしてください。`}
                        </div>
                      )}
                      {q.reserve > 0 && <div>書き込み用に {Math.floor(q.reserve / YOUTUBE_INSERT_COST)} 回分 ({q.reserve.toLocaleString()}) を除いて計算しています (設定 &gt; YouTube &gt; 書き込み)。</div>}
                      <div>このままなら、残りで<span className={youtubeTargetOn ? "yt-linked" : undefined} key={`ls${q.lastsSecs}`}>{formatAboutDuration(q.lastsSecs)}</span>受信できます{q.lastsSecs >= q.untilResetSecs ? " (その前に上限が戻ります)" : ""}。配信を2つ開くと間隔は倍になります。</div>
                      {youtubeTargetOn && (
                        <div className="settings-row">
                          <span>{q.targetEnd ? <>目標: <span className="yt-linked" key={`te${q.targetEnd}`}>{new Date(q.targetEnd).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</span> まで</> : "目標: 次に受信を始めた時刻から数えます"}</span>
                          <button onClick={restartYoutubeTarget} title="もたせる時間を今から数え直します">今から数え直す</button>
                        </div>
                      )}
                    </div>
                  );
                })()}
                <p className="settings-hint">
                  YouTube から指示された間隔のほうが長いときは、そちらに合わせます。
                  {youtubeTargetOn && " もたせる時間は受信を始めた時刻から数えます (つなぎ直し・タブの開き直し・LiveFake の再起動では数え直しません。30分以上どの配信も受信しなかったときは、次に受信を始めた時刻から数え直します)。目標の時刻より先に上限が戻るときは、戻る時刻までもつように決めます。"}
                </p>
              </fieldset>
              </>
              )}
              </section>
              <section className="settings-section" data-section="write">
                {settingsSectionHeading("youtube", "write")}
              <fieldset>
                <legend>準備: 自分の OAuth クライアント</legend>
                <div className="settings-row">
                  <span>状態: {youtubeAuth.clientSet ? "設定済み" : "未設定"}</span>
                </div>
                <div className="settings-row">
                  <input type="text" value={youtubeClientIdInput} onChange={(e) => setYoutubeClientIdInput(e.target.value)} placeholder={youtubeAuth.clientSet ? "新しいクライアント ID で置き換える" : "クライアント ID (…apps.googleusercontent.com)"} autoComplete="off" spellCheck={false} className="lf-grow" />
                </div>
                <div className="settings-row">
                  <input type="password" value={youtubeClientSecretInput} onChange={(e) => setYoutubeClientSecretInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") saveYoutubeClient(); }} placeholder="クライアント シークレット" autoComplete="off" spellCheck={false} className="lf-grow" />
                  <button disabled={youtubeAuthBusy} onClick={saveYoutubeClient}>保存</button>
                  <button disabled={youtubeAuthBusy || !youtubeAuth.clientSet} onClick={clearYoutubeClient}>削除</button>
                </div>
                {youtubeClientMsg && <p className={`settings-hint overlay-layout-msg${youtubeClientMsg.error ? " error" : ""}`}>{youtubeClientMsg.text}</p>}
                <p className="settings-hint">
                  <b>準備 (Google Cloud のコンソールで。画面の名前は変わることがあります)</b><br />
                  1. API キーを作ったのと同じプロジェクトを開く (同じプロジェクトにすると、使用量の目安が合います)<br />
                  2. 「OAuth 同意画面」(Google Auth Platform) を、ユーザーの種類「外部」で作る (アプリ名・メールは自分のもの)<br />
                  3. 「対象」の「テストユーザー」に、書き込みに使う自分の Google アカウントを追加する<br />
                  4. 「クライアント」→「クライアントを作成」で、種類を<b>「テレビと入力が限られたデバイス」</b>にして作る<br />
                  5. 表示されたクライアント ID とクライアント シークレットを上に入れて「保存」し、下の「Google にログイン」を押す
                </p>
              </fieldset>
              <fieldset>
                <legend>Google アカウントでログイン (任意)</legend>
                <p className="settings-hint">
                  YouTube のチャットに書き込むには、Google アカウントでログインします。ログインには、上で設定した<b>自分の OAuth クライアント</b>が要ります。
                  1回の書き込みで API を {YOUTUBE_INSERT_COST} 使います (コメントの読み込み 4 回分)。
                </p>
                <p className="settings-hint overlay-layout-msg error">
                  求める許可 (YouTube アカウントの管理) は、チャットへの書き込みだけでなく、動画の削除などチャンネルの操作全体に及びます。
                  LiveFake はチャンネル名の確認・チャットの ID の確認・チャットへの書き込みにしか使いません。ログイン情報は暗号化してこの PC に保存し、Google にだけ送ります。
                  心配なときは、書き込み用のサブのチャンネル (ブランド アカウント) でログインしてください。
                </p>
                <div className="settings-row">
                  <span>状態</span>
                  <span>{youtubeAuth.loggedIn ? `ログイン中: ${youtubeAuth.channelTitle}`
                    : youtubeAuth.state === "waiting" ? "許可を待っています"
                    : !youtubeAuth.clientSet ? "OAuth クライアントが未設定です"
                    : "ログインしていません"}</span>
                </div>
                {youtubeAuth.state === "waiting" && youtubeAuth.userCode && (
                  <div className="twitch-login-code">
                    <div className="settings-hint">ブラウザで開いた Google のページに次のコードを入力し、アカウントを選んで「許可」を押してください (「確認されていないアプリ」と出たら、自分で作ったものなので続行します)。</div>
                    <div className="twitch-login-code-value">{youtubeAuth.userCode}</div>
                    <button onClick={() => openGoogleDevicePage(youtubeAuth.verificationUri)}>ページをもう一度開く</button>
                  </div>
                )}
                {youtubeAuth.message && <p className={`settings-hint${youtubeAuth.state === "error" ? " overlay-layout-msg error" : ""}`}>{youtubeAuth.message}</p>}
                <div className="settings-row">
                  <button disabled={youtubeAuthBusy || !youtubeAuth.clientSet || youtubeAuth.state === "waiting"} onClick={() => void startYoutubeLogin()}>{youtubeAuth.loggedIn ? "ログインし直す" : "Google にログイン"}</button>
                  <button disabled={youtubeAuthBusy || (!youtubeAuth.loggedIn && youtubeAuth.state !== "waiting")} onClick={logoutYoutube}>ログアウト</button>
                </div>
                <p className="settings-hint">同意画面が「テスト」のままだと、7 日でログインが切れます (もう一度ログインすれば使えます)。</p>
              </fieldset>
              <fieldset>
                <legend>書き込み用に残す量</legend>
                <div className="settings-row">
                  <span>書き込み</span>
                  <input type="number" min={0} max={YOUTUBE_WRITE_RESERVE_MAX} step={1} value={youtubeWriteReserve} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 0 && n <= YOUTUBE_WRITE_RESERVE_MAX) setYoutubeWriteReserve(n); }} className="lf-w70" />
                  <span>回分 (= {(youtubeWriteReserve * YOUTUBE_INSERT_COST).toLocaleString()}) を、コメントの読み込みに使わずに残す</span>
                </div>
                <p className="settings-hint">
                  ログインしているときだけ効きます。「使用量・間隔」で「決めた時間もつように」を選んでいると、この分を除いた残りで取得の間隔を決めます
                  (残す量を増やすと、取得の間隔は延びます)。
                </p>
              </fieldset>
              </section>
              <section className="settings-section" data-section="tts">
                {settingsSectionHeading("youtube", "tts")}
              <fieldset>
                <legend>読み上げ</legend>
                <label className="settings-row" title="オフにすると、名前を付けずに本文だけを読み上げます">
                  <input type="checkbox" checked={youtubeSpeakName} onChange={(e) => setYoutubeSpeakName(e.target.checked)} />
                  <span>名前を読み上げる (「名前さん」+本文)</span>
                </label>
                <p className="settings-hint">
                  絵文字 (:_名前: の形) は読み上げません。読み上げが溜まっているときの上限と、新着レスペイン・字幕に溜めておく上限は 設定 &gt; Twitch と同じ値を使います。
                </p>
              </fieldset>
              </section>
              <section className="settings-section" data-section="events">
                {settingsSectionHeading("youtube", "events")}
              <fieldset>
                <legend>イベント (スーパーチャット・メンバー加入など)</legend>
                <p className="settings-hint">
                  お知らせを「【種類】要約」の1件で表示します。金額は表示するだけです。
                  読み上げる文には {"{name}"} {"{amount}"} {"{months}"} {"{count}"} {"{level}"} {"{item}"} {"{message}"} を使えます。
                </p>
                <table className="twitch-event-table">
                  <thead><tr><th>種類</th><th>流す</th><th>読む</th><th>読み上げる文</th><th></th></tr></thead>
                  <tbody>
                    {YOUTUBE_EVENT_KINDS.map((k) => {
                      const e = youtubeEventSettings[k.kind] ?? defaultYoutubeEventSettings()[k.kind];
                      return (
                        <tr key={k.kind}>
                          <td>{k.label}</td>
                          <td><input type="checkbox" checked={e.show} onChange={(ev) => updateYoutubeEvent(k.kind, { show: ev.target.checked })} title="ビュワー・OBS・新着レスペインに流す" /></td>
                          <td><input type="checkbox" checked={e.speak} disabled={!e.show} onChange={(ev) => updateYoutubeEvent(k.kind, { speak: ev.target.checked })} title="読み上げる" /></td>
                          <td><input type="text" value={e.template} maxLength={TWITCH_EVENT_TEMPLATE_MAX} onChange={(ev) => updateYoutubeEvent(k.kind, { template: ev.target.value })} onBlur={(ev) => { if (!ev.target.value.trim()) updateYoutubeEvent(k.kind, { template: k.template }); }} className="lf-full-width" /></td>
                          <td><button onClick={() => testYoutubeEvent(k.kind)} title="開いている YouTube タブに試しのイベントを流します">テスト</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="settings-row">
                  <button onClick={() => { setYoutubeEventSettings(defaultYoutubeEventSettings()); setYoutubeEventTestMsg("イベントの設定を既定に戻しました"); }}>既定に戻す</button>
                  {youtubeEventTestMsg && <span className="settings-hint">{youtubeEventTestMsg}</span>}
                </div>
              </fieldset>
              </section>
              </div>
              )}
              </div>
            </div>
            <div className="settings-footer-note" title="NG・辞書・ハイライト・ホワイトリスト・教育辞書・OBS のレイアウト・コマンドなどの一覧への登録・削除はその場で保存されます。それ以外の設定は「設定を保存」を押すと保存されます。">
              ※ NG・辞書・ハイライト・ホワイトリスト・教育辞書・OBS のレイアウト・コマンドの登録はその場で保存。ほかは「設定を保存」で保存
            </div>
          </div>
        </div>
      )}
      {showExternalBoardDialog && (
        <div className="lightbox-overlay" onClick={() => setShowExternalBoardDialog(false)}>
          <div className="settings-panel lf-w360-p16" onClick={(e) => e.stopPropagation()}>
            <header className="settings-header">
              <strong>外部板を追加</strong>
              <button onClick={() => setShowExternalBoardDialog(false)}>閉じる</button>
            </header>
            <div className="lf-d-flex-fd-column-gap8-mt8">
              <label>板URL
                <input type="text" value={externalBoardUrl} onChange={(e) => setExternalBoardUrl(e.target.value)} placeholder="https://jbbs.shitaraba.net/internet/12345/" className="lf-w100pc-mt2" />
              </label>
              <label>板名
                <input type="text" value={externalBoardName} onChange={(e) => setExternalBoardName(e.target.value)} placeholder="したらば実況板" className="lf-w100pc-mt2" />
              </label>
              <div className="lf-d-flex-gap8-jc-flex-end-mt4">
                <button onClick={() => setShowExternalBoardDialog(false)}>キャンセル</button>
                <button onClick={() => addExternalBoard(externalBoardUrl, externalBoardName)} disabled={!externalBoardUrl.trim() || !externalBoardName.trim()}>追加</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {showNewThreadDialog && (
        <div className="lightbox-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowNewThreadDialog(false); }}>
          <div ref={newThreadPanelRef} className="settings-panel" style={{ width: newThreadDialogSize.w, height: newThreadDialogSize.h, minWidth: 320, minHeight: 300, resize: "both", overflow: "auto", display: "flex", flexDirection: "column" }} onMouseUp={() => {
            const el = newThreadPanelRef.current;
            if (!el) return;
            const w = el.offsetWidth, h = el.offsetHeight;
            if (w !== newThreadDialogSize.w || h !== newThreadDialogSize.h) {
              setNewThreadDialogSize({ w, h });
              saveToFile("new-thread-dialog-size.json", { w, h });
            }
          }}>
            <header className="settings-header">
              <strong>スレ立て</strong>
              <button onClick={() => { setShowNewThreadDialog(false); setNewThreadResult(null); }}>閉じる</button>
            </header>
            <div className="lf-p12-d-flex-fd-column-gap8-flex1-ov-hidden">
              <label>
                スレタイ
                <input
                  value={newThreadSubject}
                  onChange={(e) => setNewThreadSubject(e.target.value)}
                  list="input-history-newThreadSubject"
                  placeholder="スレッドタイトル"
                  className="lf-full-width"
                />
              </label>
              <div className="lf-d-flex-gap8">
                <label className="lf-flex1">
                  名前
                  <input
                    value={newThreadName}
                    onChange={(e) => setNewThreadName(e.target.value)}
                    list="name-history-list-newthread"
                    className="lf-full-width"
                  />
                  <datalist id="name-history-list-newthread">
                    {nameHistory.map((n) => <option key={n} value={n} />)}
                  </datalist>
                </label>
                <label className="lf-flex1">
                  メール
                  <input
                    value={newThreadMail}
                    onChange={(e) => setNewThreadMail(e.target.value)}
                    list="input-history-newThreadMail"
                    className="lf-full-width"
                  />
                  {inputHistoryDatalist("newThreadSubject")}
                  {inputHistoryDatalist("newThreadMail")}
                </label>
              </div>
              <label className="lf-flex1-d-flex-fd-column">
                本文
                <textarea
                  value={newThreadBody}
                  onChange={(e) => setNewThreadBody(e.target.value)}
                  placeholder="本文を入力"
                  className="lf-w100pc-bs-border-box-flex1-minh100"
                />
              </label>
              <div className="lf-d-flex-gap8-ai-center">
                <button onClick={submitNewThread} disabled={newThreadSubmitting}>
                  {newThreadSubmitting ? "送信中..." : "スレ立て"}
                </button>
                <span className="lf-fs0_85em-c-sub">
                  板: {getBoardUrlFromThreadUrl(threadUrl)}
                </span>
              </div>
              {newThreadResult && (
                <div style={{ padding: 8, background: newThreadResult.ok ? "var(--ok-bg, #e6ffe6)" : "var(--err-bg, #ffe6e6)", borderRadius: 4, fontSize: "0.9em", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                  {newThreadResult.message}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {postHistoryOpen && (
        <div className="lightbox-overlay" onClick={() => setPostHistoryOpen(false)}>
          <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
            <header className="settings-header">
              <strong>書き込み履歴 ({postHistory.length}件)</strong>
              <button onClick={() => setPostHistoryOpen(false)}>閉じる</button>
            </header>
            <div className="post-history-body">
              {postHistory.length === 0 ? (
                <p className="lf-p8-c-sub">まだ書き込みがありません</p>
              ) : (
                postHistory.map((h, i) => (
                  <div key={i} className={`post-history-item ${h.ok ? "post-ok" : "post-ng"}`} title={h.threadUrl}>
                    <span className="post-history-time">{h.time}</span>
                    <span className={`post-history-status ${h.ok ? "" : "post-ng-status"}`}>{h.ok ? "OK" : "NG"}</span>
                    <span className="post-history-kind">{h.kind === "thread" ? "スレ立て" : "返信"}</span>
                    {h.title && <span className="post-history-title">{h.title}</span>}
                    <span className="post-history-text">{h.body}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      <div
        ref={hoverPreviewRef}
        className="hover-preview lf-d-none"
        onClick={() => {
          hoverPreviewSrcRef.current = null;
          if (hoverPreviewHideTimerRef.current) {
            clearTimeout(hoverPreviewHideTimerRef.current);
            hoverPreviewHideTimerRef.current = null;
          }
          if (hoverPreviewRef.current) hoverPreviewRef.current.style.display = "none";
        }}
        onWheel={(e) => {
          if (e.ctrlKey) {
            e.preventDefault();
            const next = Math.max(10, Math.min(500, hoverPreviewZoomRef.current + (e.deltaY < 0 ? 20 : -20)));
            hoverPreviewZoomRef.current = next;
            if (hoverPreviewImgRef.current) hoverPreviewImgRef.current.style.transform = `scale(${next / 100})`;
          }
        }}
      >
        <img
          ref={hoverPreviewImgRef}
          alt=""
          onMouseLeave={() => {
            hoverPreviewSrcRef.current = null;
            if (hoverPreviewHideTimerRef.current) {
              clearTimeout(hoverPreviewHideTimerRef.current);
              hoverPreviewHideTimerRef.current = null;
            }
            if (hoverPreviewRef.current) hoverPreviewRef.current.style.display = "none";
          }}
          className="lf-w-auto-transform-origin-left-top-transform-scale-1"
        />
        {isTauriRuntime() && (
          <button
            className="hover-preview-save"
            onClick={(e) => {
              e.stopPropagation();
              const src = hoverPreviewSrcRef.current;
              if (src) void saveImage(src);
            }}
          >保存</button>
        )}
      </div>
    </div>
  );
}
