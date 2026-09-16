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
  Subtitles, Volume2, VolumeX, ChevronUp, Search, PanelLeftClose, PanelLeftOpen,
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
type NgEntry = { value: string; mode: "hide" | "hide-images"; scope?: "global" | "board" | "thread"; scopeUrl?: string };
type NgFilters = { words: (string | NgEntry)[]; ids: (string | NgEntry)[]; names: (string | NgEntry)[]; thread_words: string[] };
const ngVal = (e: string | NgEntry): string => typeof e === "string" ? e : e.value;
const ngEntryMode = (e: string | NgEntry): "hide" | "hide-images" => typeof e === "string" ? "hide" : e.mode;
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
const clampMenuPosition = (x: number, y: number, width: number, height: number) => {
  const cx = clamp(x, MENU_EDGE_PADDING, Math.max(MENU_EDGE_PADDING, window.innerWidth - width - MENU_EDGE_PADDING));
  const spaceBelow = window.innerHeight - y - MENU_EDGE_PADDING;
  const cy = spaceBelow >= height ? y : Math.max(MENU_EDGE_PADDING, y - height);
  return { x: cx, y: cy };
};
const isTauriRuntime = () =>
  typeof window !== "undefined" && Boolean((globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
type SiteType = "fiveCh" | "shitaraba" | "jpnkn";
const detectSiteType = (url: string): SiteType => {
  if (/jbbs\.shitaraba\.net/i.test(url) || /jbbs\.livedoor\.jp/i.test(url)) return "shitaraba";
  if (/bbs\.jpnkn\.com/i.test(url)) return "jpnkn";
  return "fiveCh";
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
const decodeHtmlEntities = (s: string) =>
  s
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39|#44);/g, (m) => ENTITY_MAP[m] ?? m)
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const cp = Number.parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : _m;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : _m;
    });
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
  const img = isHttpUrl(card.image)
    ? `<span class="ogp-card-thumb"><img src="${escapeOgpText(card.image)}" loading="lazy" referrerpolicy="no-referrer" alt="" /></span>`
    : "";
  const url = escapeOgpText(card.url);
  const hover = `<span class="ogp-card-hover" aria-hidden="true">`
    + (desc ? `<span class="ogp-card-hover-desc">${desc}</span>` : "")
    + `<span class="ogp-card-hover-url">${url}</span>`
    + `</span>`;
  return `<a class="body-link ogp-card th-cardlist" href="${url}" target="_blank" rel="noopener">`
    + img
    + `<span class="ogp-card-main">`
    + (title ? `<span class="ogp-card-title title">${title}</span>` : "")
    + (desc ? `<span class="ogp-card-desc description">${desc}</span>` : "")
    + (site ? `<span class="ogp-card-site">${site}</span>` : "")
    + `</span>`
    + hover
    + `</a>`;
};

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
  if (!pattern) return html;
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
  const [metadataUrl, setMetadataUrl] = useState("https://raw.githubusercontent.com/kaedekiku/LiveFakeTauri2/main/apps/landing/public/latest.json");
  const [currentVersion, setCurrentVersion] = useState(typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0");
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
  const [postHistory, setPostHistory] = useState<{ time: string; threadUrl: string; body: string; ok: boolean }[]>([]);
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
  const [ngFilters, setNgFilters] = useState<NgFilters>({ words: [], ids: [], names: [], thread_words: [] });
  // customTitles: boardUrl -> threadKey -> customTitle
  const [customTitles, setCustomTitles] = useState<Record<string, Record<string, string>>>({});
  const [ngAddMode, setNgAddMode] = useState<"hide" | "hide-images">("hide");
  const [ngAddScope, setNgAddScope] = useState<"global" | "board" | "thread">("global");
  const [threadNgOpen, setThreadNgOpen] = useState(false);
  const [threadNgInput, setThreadNgInput] = useState("");
  const [ngPanelOpen, setNgPanelOpen] = useState(false);
  const [showBoardButtons, setShowBoardButtons] = useState(false);
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
  const [ngInputType, setNgInputType] = useState<"words" | "ids" | "names" | "regex">("words");
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
  const smoothScrollRef = useRef(true);
  smoothScrollRef.current = smoothScroll;
  const maxOpenTabsRef = useRef(20);
  maxOpenTabsRef.current = maxOpenTabs;
  // Proxy settings state
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyType, setProxyType] = useState<"http" | "socks5" | "socks4">("http");
  const [proxyHost, setProxyHost] = useState("");
  const [proxyPort, setProxyPort] = useState("");
  const [proxyUsername, setProxyUsername] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");
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
  const [activePaneView, setActivePaneView] = useState<"threads" | "responses">("threads");
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
  const [selectedThread, setSelectedThread] = useState<number | null>(1);
  const [selectedResponse, setSelectedResponse] = useState<number>(1);
  const [threadReadMap, setThreadReadMap] = useState<Record<number, boolean>>({ 1: false, 2: true });
  const [threadLastReadCount, setThreadLastReadCount] = useState<Record<number, number>>({});
  const [threadMenu, setThreadMenu] = useState<{ x: number; y: number; threadId: number } | null>(null);
  const [responseMenu, setResponseMenu] = useState<{
    x: number; y: number; responseId: number;
    selection?: string; resId?: string; resName?: string; isOnResNo?: boolean; imageUrl?: string; linkUrl?: string;
  } | null>(null);
  const [hlSubMenu, setHlSubMenu] = useState<{ type: "text" | "id" | "name"; value: string; nearRight?: boolean } | null>(null);
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
  type SettingsCategory = "display" | "posting" | "tts" | "tts-dict" | "proxy" | "ng" | "subtitle" | "highlights" | "presets" | "reset" | "info";
  const SETTINGS_CATEGORIES: SettingsCategory[] = ["display", "posting", "tts", "tts-dict", "subtitle", "proxy", "ng", "highlights", "presets", "reset", "info"];
  const SETTINGS_CATEGORY_LABELS: Record<SettingsCategory, string> = { display: "表示", posting: "書き込み", tts: "読み上げ", "tts-dict": "読み上げ辞書", subtitle: "字幕", proxy: "プロキシ", ng: "NG", highlights: "ハイライト", presets: "プリセット", reset: "リセット", info: "情報" };
  // 設定画面の保存まわりの状態 (詳細は「設定画面の保存 / 復元 / リセット / プリセット」の節)
  const settingsOpenRef = useRef(false);
  settingsOpenRef.current = settingsOpen;
  const [settingsSnapshot, setSettingsSnapshot] = useState<{ layout: Record<string, unknown>; app: Record<string, string> } | null>(null);
  const defaultLayoutPrefsRef = useRef<Record<string, unknown> | null>(null);
  const defaultAppSettingsRef = useRef<Record<string, string> | null>(null);
  type AppConfirm = { title?: string; message: string; buttons: { label: string; onClick: () => void; primary?: boolean; danger?: boolean }[] };
  const [appConfirm, setAppConfirm] = useState<AppConfirm | null>(null);
  // 分類内の節タブ (項目が多い分類だけ)。1 頁を短く保ち、関連する設定を同じ場所にまとめる (REQUIREMENTS 13 章)
  const SETTINGS_SECTIONS: Record<SettingsCategory, { id: string; label: string }[]> = {
    display: [
      { id: "general", label: "全般" }, { id: "response", label: "レス表示" }, { id: "image", label: "画像" },
      { id: "cards", label: "リンクカード" }, { id: "arrival", label: "新着レスペイン" }, { id: "popup", label: "ポップアップ" },
    ],
    posting: [],
    tts: [],
    "tts-dict": [{ id: "dict", label: "辞書" }, { id: "allow", label: "許可リスト" }, { id: "mute", label: "読み上げない辞書" }],
    subtitle: [{ id: "view", label: "表示" }, { id: "cards", label: "カード" }, { id: "scroll", label: "スクロール" }],
    proxy: [],
    ng: [{ id: "words", label: "ワード" }, { id: "ids", label: "ID" }, { id: "names", label: "名前" }],
    highlights: [{ id: "word", label: "ワード" }, { id: "name", label: "名前" }, { id: "id", label: "ID" }],
    presets: [],
    reset: [],
    info: [],
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
        list="input-history-settingsListFilter" placeholder="一覧を絞り込み" style={{ width: 200 }} />
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
  type HeaderVis = { threadTitle: boolean; resNo: boolean; name: boolean; mail: boolean; watchoi: boolean; date: boolean; id: boolean; count: boolean };
  const DEFAULT_HEADER_VIS: HeaderVis = { threadTitle: true, resNo: true, name: true, mail: true, watchoi: true, date: true, id: true, count: true };
  const sanitizeHeaderVis = (v: unknown): HeaderVis => {
    const o = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof HeaderVis, unknown>>;
    const b = (x: unknown) => (typeof x === "boolean" ? x : true);
    return { threadTitle: b(o.threadTitle), resNo: b(o.resNo), name: b(o.name), mail: b(o.mail), watchoi: b(o.watchoi), date: b(o.date), id: b(o.id), count: b(o.count) };
  };
  const [mainHeaderVis, setMainHeaderVis] = useState<HeaderVis>(DEFAULT_HEADER_VIS);
  const [arrivalHeaderVis, setArrivalHeaderVis] = useState<HeaderVis>(DEFAULT_HEADER_VIS);
  const [subtitleHeaderVis, setSubtitleHeaderVis] = useState<HeaderVis>(DEFAULT_HEADER_VIS);
  const subtitleHeaderVisRef = useRef<HeaderVis>(DEFAULT_HEADER_VIS);
  subtitleHeaderVisRef.current = subtitleHeaderVis;
  // レス表示欄のヘッダ項目が全て非表示ならレスの境目が分からないので罫線を引く (no-header)。常に罫線を引く設定もある
  const mainHeaderAllHidden = !mainHeaderVis.resNo && !mainHeaderVis.name && !mainHeaderVis.mail && !mainHeaderVis.watchoi && !mainHeaderVis.date && !mainHeaderVis.id && !mainHeaderVis.count;
  const [responseDividerAlways, setResponseDividerAlways] = useState(false);
  const headerVisRows = (vis: HeaderVis, set: (next: HeaderVis) => void, opts: { threadTitle?: boolean; watchoi?: boolean }) => {
    const items: Array<[keyof HeaderVis, string]> = [
      ...(opts.threadTitle ? ([["threadTitle", "スレ名"]] as Array<[keyof HeaderVis, string]>) : []),
      ["resNo", "レス番号"], ["name", "名前"], ["mail", "メール欄"],
      ...(opts.watchoi ? ([["watchoi", "ワッチョイ"]] as Array<[keyof HeaderVis, string]>) : []),
      ["date", "投稿日時"], ["id", "ID"], ["count", "書き込み回数"],
    ];
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", fontSize: 11 }}>
        {items.map(([key, label]) => (
          <label key={key} style={{ display: "flex", alignItems: "center", gap: 2 }}>
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
    return {
      threadTitle,
      responseNo: r.responseNo,
      name: r.name.replace(/<[^>]+>/g, ""),
      mail: r.mail || "",
      id,
      time: r.dateAndId.replace(/\s+ID:\S+/g, "").replace(/\s+BE[:：]\d+[^\s]*/gi, "").trim(),
      text: arrivalBodyText(r.body),
      threadUrl: threadUrlForItem,
      idSeq: stats.seq,
      idCount: stats.count,
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
        <input type="number" min={0} max={120} step={0.1} value={t.fitSec} onChange={(e) => set(sanitizeScrollTiming({ ...t, fitSec: Number(e.target.value) }))} style={{ width: 70 }} />
      </label>
      <label className="settings-row">
        <span>スクロール開始までの待ち時間 (秒)</span>
        <input type="number" min={0} max={20} step={0.1} value={t.waitSec} onChange={(e) => set(sanitizeScrollTiming({ ...t, waitSec: Number(e.target.value) }))} style={{ width: 70 }} />
      </label>
      <label className="settings-row">
        <span>スクロール速度 (1px あたり ms)</span>
        <input type="number" min={1} max={100} step={1} value={t.msPerPx} onChange={(e) => set(sanitizeScrollTiming({ ...t, msPerPx: Number(e.target.value) }))} style={{ width: 70 }} />
      </label>
      <label className="settings-row">
        <span>スクロール後の表示時間 (秒)</span>
        <input type="number" min={0} max={120} step={0.1} value={t.holdSec} onChange={(e) => set(sanitizeScrollTiming({ ...t, holdSec: Number(e.target.value) }))} style={{ width: 70 }} />
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
  const [subtitleAlwaysOnTop, setSubtitleAlwaysOnTop] = useState(true);
  const [subtitleIdFontSize, setSubtitleIdFontSize] = useState(0); // 0 = メタと同じ
  const [subtitleIdFontFamily, setSubtitleIdFontFamily] = useState("");
  // TTS state
  type TtsMode = "off" | "sapi" | "bouyomi" | "voicevox";
  type TtsDictEntry = { from: string; to: string; fullReplace?: boolean };
  const [ttsMode, setTtsMode] = useState<TtsMode>("off");
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [ttsMaxReadLength, setTtsMaxReadLength] = useState(100);
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
  type ArrivalItem = { threadTitle: string; responseNo: number; name: string; mail: string; id: string; time: string; text: string; threadUrl: string; idSeq: number; idCount: number };
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
      const readMap: Record<number, boolean> = {};
      const lastReadMap: Record<number, number> = {};
      threads.forEach((t, i) => {
        const id = i + 1;
        const lastRead = boardStatus[t.threadKey] ?? 0;
        readMap[id] = lastRead > 0;
        lastReadMap[id] = lastRead;
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
      setNgFilters({ ...data, thread_words: data.thread_words ?? [] });
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

  const addNgEntry = (type: "words" | "ids" | "names" | "thread_words", value: string, mode?: "hide" | "hide-images", scope?: "global" | "board" | "thread") => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (ngFilters[type].some((e) => ngVal(e) === trimmed)) {
      setStatus(`already in NG ${type}: ${trimmed}`);
      return;
    }
    if (type === "thread_words") {
      void persistNgFilters({ ...ngFilters, [type]: [...ngFilters[type], trimmed] });
    } else {
      const s = scope ?? ngAddScope;
      const entry: NgEntry = {
        value: trimmed,
        mode: mode ?? ngAddMode,
        ...(s !== "global" ? { scope: s, scopeUrl: s === "board" ? getBoardUrlFromThreadUrl(threadUrl.trim()) : threadUrl.trim() } : {}),
      };
      void persistNgFilters({ ...ngFilters, [type]: [...ngFilters[type], entry] });
    }
    setStatus(`added NG ${type}: ${trimmed}`);
  };

  const addNgFromInput = () => {
    if (!ngInput.trim()) return;
    if (ngInputType === "regex") {
      const pattern = ngInput.trim();
      const wrapped = pattern.startsWith("/") && pattern.endsWith("/") ? pattern : `/${pattern}/`;
      addNgEntry("words", wrapped);
    } else {
      addNgEntry(ngInputType, ngInput);
    }
    setNgInput("");
  };

  const removeNgEntry = (type: "words" | "ids" | "names" | "thread_words", value: string) => {
    void persistNgFilters({ ...ngFilters, [type]: ngFilters[type].filter((v) => ngVal(v) !== value) });
    setStatus(`removed NG ${type}: ${value}`);
  };

  // 設定 > NG の各節 (ワード / ID / 名前) で共通の追加フォーム
  const ngAddForm = (
    <div className="ng-panel-add">
      <select value={ngInputType} onChange={(e) => setNgInputType(e.target.value as "words" | "ids" | "names" | "regex")}>
        <option value="words">ワード</option>
        <option value="ids">ID</option>
        <option value="names">名前</option>
        <option value="regex">正規表現</option>
      </select>
      <input
        value={ngInput}
        onChange={(e) => setNgInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") addNgFromInput(); }}
        placeholder={ngInputType === "regex" ? "正規表現パターンを入力" : ngInputType === "words" ? "NGワードを入力" : ngInputType === "ids" ? "NG IDを入力" : "NG名前を入力"}
      />
      <select value={ngAddMode} onChange={(e) => setNgAddMode(e.target.value as "hide" | "hide-images")} className="ng-mode-select">
        <option value="hide">非表示</option>
        <option value="hide-images">画像NG</option>
      </select>
      <select value={ngAddScope} onChange={(e) => setNgAddScope(e.target.value as "global" | "board" | "thread")} className="ng-mode-select">
        <option value="global">全体</option>
        <option value="board">この板</option>
        <option value="thread">このスレ</option>
      </select>
      <button onClick={() => addNgFromInput()}>追加</button>
    </div>
  );

  const ngMatch = (pattern: string, target: string): boolean => {
    if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
      if (pattern.length > MAX_USER_REGEX_LEN) return false;
      try {
        return new RegExp(pattern.slice(1, -1), "i").test(target);
      } catch {
        return false;
      }
    }
    return target.toLowerCase().includes(pattern.toLowerCase());
  };

  const getNgResult = (resp: { name: string; time: string; text: string }, threadUrlForScope?: string): null | "hide" | "hide-images" => {
    if (ngFilters.words.length === 0 && ngFilters.ids.length === 0 && ngFilters.names.length === 0) return null;
    const curThread = (threadUrlForScope ?? threadUrl).trim();
    const curBoard = getBoardUrlFromThreadUrl(curThread);
    let result: null | "hide" | "hide-images" = null;
    for (const w of ngFilters.words) {
      if (!ngScopeMatches(w, curBoard, curThread)) continue;
      if (ngMatch(ngVal(w), resp.text)) {
        const m = ngEntryMode(w);
        if (m === "hide") return "hide";
        result = "hide-images";
      }
    }
    for (const n of ngFilters.names) {
      if (!ngScopeMatches(n, curBoard, curThread)) continue;
      if (ngMatch(ngVal(n), resp.name)) {
        const m = ngEntryMode(n);
        if (m === "hide") return "hide";
        result = "hide-images";
      }
    }
    if (ngFilters.ids.length > 0) {
      const idMatch = resp.time.match(/ID:([^\s]+)/);
      if (idMatch) {
        for (const entry of ngFilters.ids) {
          if (!ngScopeMatches(entry, curBoard, curThread)) continue;
          if (idMatch[1] === ngVal(entry)) {
            const m = ngEntryMode(entry);
            if (m === "hide") return "hide";
            result = "hide-images";
          }
        }
      }
    }
    return result;
  };
  const isNgFiltered = (resp: { name: string; time: string; text: string }): boolean => getNgResult(resp) !== null;

  const bookmarkCacheRef = useRef<Record<string, number>>({});
  const saveBookmark = (url: string, responseNo: number) => {
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
          if (Math.abs(elRect.top - cRect.top) > 20) {
            el.scrollIntoView({ block: "start", behavior: "instant" });
          }
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
            correctionTimer = setTimeout(correct, 150);
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
      else scrollToResponseNo(cached.scrollResponseNo ?? 0);
    }
    setThreadUrl(tab.threadUrl);
    setLocationInput(tab.threadUrl);
  };

  const onTabClick = (index: number) => {
    const paneWasUnmounted = activePaneView === "threads";
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
      else scrollToResponseNo(cached.scrollResponseNo ?? 0);
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
        const matchIdx = rows.findIndex((r) => r.threadUrl === activeUrl);
        setSelectedThread(matchIdx >= 0 ? matchIdx + 1 : null);
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
    if (!isTauriRuntime()) return;
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
          .filter((r) => getNgResult({ name: r.name, time: r.dateAndId, text: r.body.replace(/<[^>]*>/g, "") }, tabUrl) !== "hide")
          .map((r) => makeArrival(r, tabTitle, tabUrl, rows));
        if (autoRefreshEnabled && arrivals.length > 0) {
          const queueWasEmpty = arrivalQueueRef.current.length === 0;
          arrivalQueueRef.current.push(...arrivals);
          setArrivalQueueCount(arrivalQueueRef.current.length);
          if (!arrivalPausedRef.current && !arrivalTimerRef.current && (currentArrivalItemRef.current === null || queueWasEmpty)) {
            advanceToNextArrival();
          }
        }
        if (ttsEnabled && ttsMode !== "off") {
          const site = detectSiteType(tabUrl);
          for (const a of arrivals) {
            if (a.responseNo >= 1001) continue;
            const prefix = site === "shitaraba" ? `したらば${a.responseNo}番さん`
              : site === "jpnkn" ? `ジャパンくん${a.responseNo}番さん`
              : `レス${a.responseNo}番さん`;
            ttsSpeak(a.text, prefix, undefined, { name: a.name, id: a.id });
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
    const readMap: Record<number, boolean> = {};
    const lastReadMap: Record<number, number> = {};
    favorites.threads.forEach((ft, i) => {
      const id = i + 1;
      const bUrl = getBoardUrlFromThreadUrl(ft.threadUrl);
      const boardStatus = allReadStatus[bUrl] ?? {};
      // Extract thread key from URL
      const parts = ft.threadUrl.replace(/\/$/, "").split("/");
      const threadKey = parts[parts.length - 1] ?? "";
      const lastRead = boardStatus[threadKey] ?? 0;
      readMap[id] = lastRead > 0;
      lastReadMap[id] = lastRead;
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
      tabCacheRef.current.set(url, { responses: rows, selectedResponse: rows.length > 0 ? rows[0].responseNo : 1 });
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
        const tid = threadListIndex + 1;
        setThreadReadMap((prev) => ({ ...prev, [tid]: true }));
        setThreadLastReadCount((prev) => ({ ...prev, [tid]: rows.length }));
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
          .filter((r) => getNgResult({ name: r.name, time: r.dateAndId, text: r.body.replace(/<[^>]*>/g, "") }, url) !== "hide")
          .map((r) => makeArrival(r, arrivalTitle, url, rows));
        // Add to new arrivals pane when autoReload is ON
        if (autoRefreshEnabled && arrivals.length > 0) {
          const queueWasEmpty = arrivalQueueRef.current.length === 0;
          arrivalQueueRef.current.push(...arrivals);
          setArrivalQueueCount(arrivalQueueRef.current.length);
          if (!arrivalPausedRef.current && !arrivalTimerRef.current && (currentArrivalItemRef.current === null || queueWasEmpty)) {
            advanceToNextArrival();
          }
        }
        // Update subtitle directly only on manual refresh (auto-refresh uses queue via advanceToNextArrival)
        if (arrivals.length > 0 && !autoRefreshEnabled) {
          const latest = arrivals[arrivals.length - 1];
          subtitleUpdate({ threadTitle: latest.threadTitle, responseNo: latest.responseNo, name: latest.name, mail: latest.mail, id: latest.id, date: latest.time, body: latest.text, idSeq: latest.idSeq, idCount: latest.idCount });
        }
        // TTS: read new responses (skip 1001/1002)
        if (ttsEnabled && ttsMode !== "off") {
          const site = detectSiteType(url);
          for (const a of arrivals) {
            if (a.responseNo >= 1001) continue;
            const prefix = site === "shitaraba" ? `したらば${a.responseNo}番さん`
              : site === "jpnkn" ? `ジャパンくん${a.responseNo}番さん`
              : `レス${a.responseNo}番さん`;
            ttsSpeak(a.text, prefix, undefined, { name: a.name, id: a.id });
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

  const probePostFlowTraceFromCompose = async () => {
    if (composeSubmitting) return;
    setComposeSubmitting(true);
    setComposeResult(null);
    // Always post to the currently active tab, not the URL bar state
    const postTargetUrl = threadTabs[activeTabIndex]?.threadUrl ?? threadUrl;
    try {
      const result = await invoke<string>("post_reply_multisite", {
        threadUrl: postTargetUrl,
        from: composeName || null,
        mail: composeMailValue || null,
        message: composeBody || "",
      });
      setComposeResult({ ok: true, message: `Post submitted: ${result}` });
      setPostHistory((prev) => [{ time: new Date().toLocaleTimeString(), threadUrl: postTargetUrl, body: composeBody.slice(0, 100), ok: true }, ...prev].slice(0, 50));
      await postSuccessCleanup(composeBody);
    } catch (error) {
      const msg = String(error);
      setComposeResult({ ok: false, message: `NG: ${msg}` });
      setPostHistory((prev) => [{ time: new Date().toLocaleTimeString(), threadUrl: postTargetUrl, body: composeBody.slice(0, 100), ok: false }, ...prev].slice(0, 50));
    } finally {
      setComposeSubmitting(false);
    }
  };

  // スレッドタイトルバーの「書き込み」から浮遊ウィンドウ (別 OS ウィンドウ) を開く。
  // 下部の書き込みパネルとは独立で、名前・スレ情報などの初期値だけを渡す
  const openComposePopup = () => {
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
          reportResult(false, `スレッド作成失敗: ${r.bodyPreview}`);
          return;
        }
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
      setPostHistory((prev) => [{ time: new Date().toLocaleTimeString(), threadUrl: postTargetUrl, body: body.slice(0, 100), ok: true }, ...prev].slice(0, 50));
      void result;
      await applyPostSuccessBookkeeping(postTargetUrl.trim(), name, body);
      if (isTauriRuntime()) void invoke("compose_popup_hide").catch(() => {});
    } catch (error) {
      const msg = String(error);
      setPostHistory((prev) => [{ time: new Date().toLocaleTimeString(), threadUrl: postTargetUrl, body: body.slice(0, 100), ok: false }, ...prev].slice(0, 50));
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
  const ttsSpeak = (bodyText: string, prefix?: string, responseNo?: number, meta?: { name?: string; id?: string }) => {
    if (!isTauriRuntime() || ttsMode === "off") return;
    // Skip system messages (res 1001/1002)
    if (responseNo != null && responseNo >= 1001) return;
    // 読み上げない辞書 (名前 / ID): 一致したらそのレスは読み上げない (表示・あぼーんには影響しない)
    const mute = ttsMuteRef.current;
    if (meta?.name && ttsMuteMatches(mute.names, meta.name)) return;
    if (meta?.id && ttsMuteMatches(mute.ids, meta.id)) return;
    // Strip HTML tags, then decode HTML entities to get true character count
    let plain = bodyText.replace(/<[^>]*>/g, "");
    plain = plain.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
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
      return out;
    };
    plain = plain
      .split(/((?:https?|ttps?):\/\/[^\s]+)/gi)
      .map((part, i) => (i % 2 === 1 ? ttsUrlReading(part) : applyDict(part)))
      .join("");
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

  // TTS: stop playback and clear queue; returns a promise so callers can await full stop
  const ttsStop = (): Promise<void> => {
    ttsQueueRef.current = [];
    ttsProcessingRef.current = false;
    if (isTauriRuntime()) return invoke("tts_stop").catch(() => {}) as Promise<void>;
    return Promise.resolve();
  };

  // Subtitle: send update to subtitle window
  const subtitleUpdate = (data: { threadTitle?: string; name?: string; mail?: string; id?: string; date?: string; body?: string; responseNo?: number; idSeq?: number; idCount?: number }) => {
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
          return invoke("subtitle_update", { data: { ...data, seq, scroll, show, bodyHtml, idColor } });
        })
        .catch((e) => console.warn("subtitle_update:", e));
      return;
    }
    const bodyHtml = data.body
      ? renderResponseBodyHighlighted(data.body, "", { hideImages: true }, wordHighlights).__html
      : undefined;
    invoke("subtitle_update", { data: { ...data, seq, scroll, show, bodyHtml, idColor } }).catch((e) => console.warn("subtitle_update:", e));
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
      subtitleUpdate({ threadTitle: next.threadTitle, responseNo: next.responseNo, name: next.name, mail: next.mail, id: next.id, date: next.time, body: next.text, idSeq: next.idSeq, idCount: next.idCount });
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
        setNewThreadResult({ ok: false, message: `エラー: ${r.bodyPreview}` });
      } else {
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
      if (r.hasUpdate) {
        setStatus(`新しいバージョンがあります: v${r.latestVersion}`);
      } else {
        setStatus(`最新版です (v${r.currentVersion})`);
      }
    } catch (error) {
      setUpdateProbe(`error: ${String(error)}`);
      setStatus(`更新確認に失敗しました: ${String(error)}`);
    }
  };

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
        const lastRead = threadLastReadCount[id] ?? 0;
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
    fetchedThreads.length > 0
      ? fetchedThreads.map((t, i) => {
          const created = Number(t.threadKey) * 1000;
          const elapsedDays = Math.max((Date.now() - created) / 86400000, 0.01);
          const speed = Number((t.responseCount / elapsedDays).toFixed(1));
          const readCount = threadLastReadCount[i + 1] ?? 0;
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
  const filteredThreadItems = threadItems
    .filter((t) => {
      if (ngFilters.words.some((w) => ngMatch(ngVal(w), t.title))) return false;
      if (ngFilters.thread_words.some((w) => ngMatch(ngVal(w), t.title))) return false;
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
      if (threadSortKey === "fetched") cmp = (threadReadMap[a.id] ? 0 : 1) - (threadReadMap[b.id] ? 0 : 1);
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
  const selectedThreadItem = visibleThreadItems.find((t) => t.id === selectedThread) ?? null;
  const unreadThreadCount = visibleThreadItems.filter((t) => !threadReadMap[t.id]).length;
  const selectedThreadLabel = selectedThreadItem ? `#${selectedThreadItem.id}` : "-";
  const responseItems = [
    ...(fetchedResponses.length > 0
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
  ];
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
  const { idCountMap, idSeqMap } = (() => {
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
  })();

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

  const watchoiCountMap = (() => {
    const map = new Map<string, number>();
    for (const r of responseItems) {
      if (r.watchoi) map.set(r.watchoi, (map.get(r.watchoi) ?? 0) + 1);
    }
    return map;
  })();

  const ngResultMap = new Map<number, "hide" | "hide-images">();
  for (const r of responseItems) {
    const result = getNgResult(r);
    if (result) ngResultMap.set(r.id, result);
  }
  const ngFilteredCount = ngResultMap.size;
  const visibleResponseItems = responseItems.filter((r) => {
    const ngResult = ngResultMap.get(r.id);
    if (ngResult === "hide") return false;
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
  });
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
  const backRefMap = (() => {
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
  })();

  const goFromLocationInput = () => goToLocation(locationInput);
  // URL バーの文字列 (手入力・貼り付け) で移動する。Enter と「貼り付けて移動」は同じ経路
  const goToLocation = (raw: string) => {
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
    const p = clampMenuPosition(e.clientX, e.clientY, 180, 176);
    setThreadMenu({ x: p.x, y: p.y, threadId });
    setResponseMenu(null);
  };

  const onResponseNoClick = (e: ReactMouseEvent, responseId: number) => {
    e.stopPropagation();
    setSelectedResponse(responseId);
    const p = clampMenuPosition(e.clientX, e.clientY, 260, 360);
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
    const p = clampMenuPosition(e.clientX, e.clientY, 260, 400);
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
    setThreadReadMap((prev) => ({ ...prev, [threadId]: value }));
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
    const threadId = threadItems.find((t) => "threadUrl" in t && t.threadUrl === url)?.id;
    if (threadId != null) {
      setThreadReadMap((prev) => { const next = { ...prev }; delete next[threadId]; return next; });
      setThreadLastReadCount((prev) => { const next = { ...prev }; delete next[threadId]; return next; });
    }
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
      if (!url) return;
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
  }, [selectedThread, selectedResponse, visibleThreadItems, responseItems, activeTabIndex, threadTabs, responseReloadMenuOpen]);

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
        if (typeof parsed.subtitleOpacity === "number") setSubtitleOpacity(clamp(parsed.subtitleOpacity, 0.1, 1));
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
      invoke<{ enabled: boolean; proxyType: string; host: string; port: string; username: string; password: string }>("load_proxy_settings").then((s) => {
        setProxyEnabled(s.enabled);
        setProxyType((s.proxyType as "http" | "socks5" | "socks4") || "http");
        setProxyHost(s.host || "");
        setProxyPort(s.port || "");
        setProxyUsername(s.username || "");
        setProxyPassword(s.password || "");
      }).catch(() => {});
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
      if (map["App.logRetentionDays"]) { const n = parseInt(map["App.logRetentionDays"], 10); if (!isNaN(n) && n >= 0) setLogRetentionDays(n); }
      if (map["App.imageSaveFolder"] !== undefined) setImageSaveFolder(map["App.imageSaveFolder"]);
      if (map["App.cssAllowExternalUrls"]) setCssAllowExternalUrls(map["App.cssAllowExternalUrls"] === "true");
      // Speech settings
      if (map["Speech.mode"]) setTtsMode(map["Speech.mode"] as TtsMode);
      if (map["Speech.enabled"]) setTtsEnabled(map["Speech.enabled"] === "true");
      if (map["Speech.maxReadLength"]) { const n = parseInt(map["Speech.maxReadLength"], 10); if (!isNaN(n) && n >= 0) setTtsMaxReadLength(n); }
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
    if (!isTauriRuntime()) { appSettingsLoadedRef.current = true; return; }
    invoke<Record<string, string>>("load_app_settings")
      .then((map) => applyAppSettings(map))
      .catch(() => {})
      .finally(() => { appSettingsLoadedRef.current = true; });
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
  // コンテナ内の .ogp-card-slot を IntersectionObserver で監視し、画面に入ったものだけ取得して埋める
  // (スレ内の全 URL へ一斉に通信しない)。React が innerHTML を差し替えるたびにスロットは白紙で
  // 作り直されるため、MutationObserver で未処理スロットを拾い直す。戻り値は解除関数。
  const setupOgpFill = (container: HTMLElement, ogpFallback: boolean): (() => void) => {
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
          void resolveCardHtml(url, slot.dataset.tweetId, ogpFallback).then((htmlText) => {
            if (!slot.isConnected) return; // 再レンダーでノードが差し替わっている可能性があるので生存確認
            if (htmlText) {
              slot.innerHTML = htmlText;
              slot.dataset.ogpState = "done";
            } else {
              slot.dataset.ogpState = "empty";
            }
          });
        }
      },
      { root: container, rootMargin: "200px" }
    );
    const observeNewSlots = () => {
      container.querySelectorAll<HTMLElement>(".ogp-card-slot:not([data-ogp-state])").forEach((slot) => io.observe(slot));
    };
    observeNewSlots();
    const mo = new MutationObserver(observeNewSlots);
    mo.observe(container, { childList: true, subtree: true });
    return () => { mo.disconnect(); io.disconnect(); };
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
      }
    }).then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch((e) => console.warn("subtitle-control listen failed", e));
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, []);
  // 書き込みの浮遊ウィンドウからの送信要求。実際の投稿は既存の投稿フローで行う
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
  // 【試験】新着レスペイン (arrivalCardsEnabled が ON のときのみ)
  useEffect(() => {
    if (!arrivalCardsEnabled || (!ogpCardsEnabled && !tweetCardsEnabled)) return;
    const container = newArrivalScrollRef.current;
    if (!container) return;
    return setupOgpFill(container, ogpCardsEnabled);
  }, [arrivalCardsEnabled, ogpCardsEnabled, tweetCardsEnabled, newArrivalPaneOpen]);

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
      "App.imageSaveFolder": imageSaveFolder,
      "App.cssAllowExternalUrls": String(cssAllowExternalUrls),
      "Speech.mode": ttsMode,
      "Speech.enabled": String(ttsEnabled),
      "Speech.maxReadLength": String(ttsMaxReadLength),
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
  }, [responsesFontSize, responseGap, autoRefreshInterval, autoRefreshEnabled, autoScrollEnabled, smoothScroll, maxOpenTabs, logRetentionDays, imageSaveFolder, cssAllowExternalUrls,
      ttsMode, ttsEnabled, ttsMaxReadLength, sapiVoiceIndex, sapiRate, sapiVolume,
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
      subtitleAlwaysOnTop,
  });
  useEffect(() => {
    if (!layoutPrefsLoadedRef.current || settingsOpenRef.current) return;
    if (isTauriRuntime()) {
      void invoke("save_layout_prefs", { prefs: JSON.stringify(buildLayoutPrefsPayload()) }).catch(() => {});
    }
  }, [boardPaneVisible, boardPanePx, threadPanePx, responseTopRatio, boardsFontSize, threadsFontSize, responsesFontSize, responsesHeaderFontSize, darkMode, fontFamily, fontBold, threadColWidths, showBoardButtons, keepSortOnRefresh, composeSubmitKey, imageSizeLimit, showImagePreview, hoverPreviewEnabled, ogpCardsEnabled, tweetCardsEnabled, arrivalCardsEnabled, subtitleCardsEnabled, arrivalTiming, subtitleTiming, subtitleSyncEnabled, mainHeaderVis, arrivalHeaderVis, subtitleHeaderVis, responseDividerAlways, settingsSearchHistory, selectedBoard, hoverPreviewDelay, thumbSize, restoreSession, autoRefreshInterval, autoScrollEnabled, newArrivalPaneOpen, newArrivalPaneHeight, newArrivalFontSize, resIdFontSize, resIdFontFamily, newArrivalIdFontSize, newArrivalIdFontFamily, subtitleIdFontSize, subtitleIdFontFamily, popupFontSize, popupMaxWidth, popupMaxHeight, composePanelPx, subtitleBodyFontSize, subtitleMetaFontSize, subtitleOpacity, subtitleAlwaysOnTop]);

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
          thread_words: Array.isArray(ng.thread_words) ? ng.thread_words.filter((x): x is string => typeof x === "string") : [],
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
      void persistNgFilters({ words: [], ids: [], names: [], thread_words: [] });
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
  // 字幕ウィンドウへの反映は state から行う (onChange では送らない)。「保存しない」で値が戻ったときも自動で反映される
  useEffect(() => { if (isTauriRuntime() && subtitleVisibleRef.current) invoke("subtitle_font_size", { size: subtitleBodyFontSize }).catch((e) => console.warn("subtitle_font_size:", e)); }, [subtitleBodyFontSize]);
  useEffect(() => { if (isTauriRuntime() && subtitleVisibleRef.current) invoke("subtitle_meta_font_size", { size: subtitleMetaFontSize }).catch((e) => console.warn("subtitle_meta_font_size:", e)); }, [subtitleMetaFontSize]);
  useEffect(() => { if (isTauriRuntime() && subtitleVisibleRef.current) invoke("subtitle_opacity", { opacity: subtitleOpacity }).catch((e) => console.warn("subtitle_opacity:", e)); }, [subtitleOpacity]);
  useEffect(() => { if (isTauriRuntime() && subtitleVisibleRef.current) invoke("subtitle_topmost", { enabled: subtitleAlwaysOnTop }).catch((e) => console.warn("subtitle_topmost:", e)); }, [subtitleAlwaysOnTop]);
  useEffect(() => { if (isTauriRuntime() && subtitleVisibleRef.current) invoke("subtitle_id_font_size", { size: subtitleIdFontSize }).catch((e) => console.warn("subtitle_id_font_size:", e)); }, [subtitleIdFontSize]);
  useEffect(() => { if (isTauriRuntime() && subtitleVisibleRef.current) invoke("subtitle_id_font_family", { family: subtitleIdFontFamily }).catch((e) => console.warn("subtitle_id_font_family:", e)); }, [subtitleIdFontFamily]);


  useEffect(() => {
    if (isTauriRuntime()) {
      invoke("set_window_theme", { dark: darkMode }).catch(() => {});
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
            { text: "スレ取得", action: () => fetchThreadListFromCurrent() },
            { text: "レス取得", action: () => fetchResponsesFromCurrent() },
            { text: "sep" },
            { text: "書き込み", action: () => { setComposeOpen(true); setComposeBody(""); setComposeResult(null); } },
            { text: "書き込み履歴", action: () => setPostHistoryOpen(true) },
            ...(navigator.userAgent.includes("Windows") ? [
              { text: "sep" },
              { text: "終了", action: () => { if (isTauriRuntime()) { void invoke("quit_app"); } } },
            ] : []),
          ]},
          { label: "編集", items: [
            { text: "スレURLをコピー", action: () => { void navigator.clipboard.writeText(threadUrl); setStatus("copied thread url"); } },
          ]},
          { label: "表示", items: [
            { text: `文字サイズ (${paneLabel(focusedPane)}): ${paneFontSize(focusedPane)[0]}px`, action: () => {} },
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
            { text: "板一覧を取得", action: () => fetchBoardCategories() },
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
            { text: "バージョン情報", action: () => requestAnimationFrame(() => { setAboutOpen(true); void checkForUpdates(); }) },
          ]},
        ].map(({ label, items }) => (
          <div key={label} className="menu-item-wrap" onClick={(e) => e.stopPropagation()}>
            <span
              className={`menu-item ${openMenu === label ? "menu-item-active" : ""}`}
              onClick={() => setOpenMenu(openMenu === label ? null : label)}
              onMouseEnter={() => { if (openMenu) setOpenMenu(label); }}
            >
              {label}
            </span>
            {openMenu === label && (
              <div className="menu-dropdown">
                {items.map((item, i) =>
                  item.text === "sep" ? (
                    <div key={i} className="menu-sep" />
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
          onContextMenu={(e) => { e.preventDefault(); const p = clampMenuPosition(e.clientX, e.clientY, 170, 110); setAddressMenu({ x: p.x, y: p.y }); }}
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
                                const p = clampMenuPosition(e.clientX, e.clientY, 180, 80);
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
                              onContextMenu={(e) => { e.preventDefault(); const p = clampMenuPosition(e.clientX, e.clientY, 180, 60); setBoardContextMenu({ x: p.x, y: p.y, board: b }); }}
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
                                  onContextMenu={(e) => { e.preventDefault(); const p = clampMenuPosition(e.clientX, e.clientY, 180, 60); setBoardContextMenu({ x: p.x, y: p.y, board: b }); }}
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
          {newArrivalPaneOpen && (
            <>
              <div className="new-arrival-pane" style={{ height: newArrivalPaneHeight }}>
                <div className="new-arrival-header">
                  <span className="new-arrival-title">新着レス {arrivalQueueCount > 0 ? `(残 ${arrivalQueueCount})` : ""}{arrivalPaused ? " ⏸停止中" : ""}</span>
                  <button className="title-action-btn" title="次のレスを表示" onClick={() => {
                    arrivalPausedRef.current = false;
                    setArrivalPaused(false);
                    advanceToNextArrival();
                  }}>▶</button>
                  <button
                    className={`title-action-btn${subtitleVisible ? " active" : ""}`}
                    title="字幕"
                    onClick={() => {
                      if (!subtitleVisible) {
                        setSubtitleVisible(true);
                        if (isTauriRuntime()) invoke("subtitle_show").then(() => {
                          setTimeout(() => {
                            invoke("subtitle_opacity", { opacity: subtitleOpacity }).catch(() => {});
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
                  ><Subtitles size={12} /></button>
                  <button className="title-action-btn" onClick={() => {
                    arrivalQueueRef.current = [];
                    setArrivalQueueCount(0);
                    arrivalPausedRef.current = false;
                    setArrivalPaused(false);
                    if (arrivalTimerRef.current) { clearTimeout(arrivalTimerRef.current); arrivalTimerRef.current = null; }
                    currentArrivalItemRef.current = null;
                    setCurrentArrivalItem(null);
                  }} title="クリア"><X size={12} /></button>
                  <button className="title-action-btn" onClick={() => setNewArrivalPaneOpen(false)} title="閉じる"><ChevronDown size={12} /></button>
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
                        {arrivalHeaderVis.name && <span className="new-arrival-name"><span className="response-label">名前：</span>{currentArrivalItem.name}</span>}
                        {arrivalHeaderVis.mail && currentArrivalItem.mail && <span className="new-arrival-mail">[{currentArrivalItem.mail}]</span>}
                        {arrivalHeaderVis.date && <span className="new-arrival-time"><span className="response-label">投稿日：</span>{currentArrivalItem.time}</span>}
                        {arrivalHeaderVis.id && currentArrivalItem.id && <span className="new-arrival-id" style={{ color: idHighlights[currentArrivalItem.id] ?? undefined, ...(newArrivalIdFontSize !== 0 ? { fontSize: `${Math.max(6, newArrivalFontSize + newArrivalIdFontSize)}px` } : {}), ...(newArrivalIdFontFamily ? { fontFamily: `"${newArrivalIdFontFamily}", sans-serif` } : {}) }}>ID:{currentArrivalItem.id}</span>}
                        {arrivalHeaderVis.count && currentArrivalItem.idCount > 0 && <span className="new-arrival-id-count" style={{ color: currentArrivalItem.idCount >= 5 ? "#cc3333" : currentArrivalItem.idCount >= 2 ? "#3366ff" : undefined }}>({currentArrivalItem.idSeq}/{currentArrivalItem.idCount})</span>}
                      </div>
                      {arrivalCardsEnabled && (ogpCardsEnabled || tweetCardsEnabled)
                        ? /* カード付き描画: 本文は renderResponseBody でサニタイズ済み (画像は非表示のまま) */
                          <div className="new-arrival-body" ref={newArrivalBodyRef} style={{ fontSize: `${newArrivalFontSize}px` }} dangerouslySetInnerHTML={renderResponseBody(currentArrivalItem.text, { hideImages: true, ogpCards: ogpCardsEnabled, tweetCards: tweetCardsEnabled, ogpAllow: ogpDomainFilters.allow, ogpBlock: ogpDomainFilters.block })} />
                        : <div className="new-arrival-body" ref={newArrivalBodyRef} style={{ fontSize: `${newArrivalFontSize}px` }}>{currentArrivalItem.text}</div>}
                    </div>
                  )}
                </div>
              </div>
              <div className="splitter-h new-arrival-splitter" onMouseDown={beginNewArrivalResize} />
            </>
          )}
        <div
          ref={responseLayoutRef}
          className="right-pane"
        >
        {/* Board tab bar (upper) */}
        <div className="board-tab-bar-wrap">
          <div className="board-tab-bar board-tabs" ref={boardTabBarRef}>
            {boardTabs.length === 0 && (
              <div className="board-tab placeholder">
                <span className="board-tab-title">板未選択</span>
              </div>
            )}
            {boardTabs.map((tab, i) => (
              <div
                key={tab.boardUrl}
                className={`board-tab tab ${i === activeBoardTabIndex ? "active" : ""} ${boardTabDragIndex !== null && boardTabDragIndex !== i ? "drag-target" : ""}`}
                onClick={() => {
                  if (boardTabDragSuppressClickRef.current) return;
                  setActiveBoardTabIndex(i);
                  setActivePaneView("threads");
                  setSelectedBoard(tab.title);
                  setThreadUrl(tab.boardUrl);
                  setLocationInput(tab.boardUrl);
                  void fetchThreadListFromCurrent(tab.boardUrl);
                }}
                onContextMenu={(e) => { e.preventDefault(); const p = clampMenuPosition(e.clientX, e.clientY, 180, 60); setBoardContextMenu({ x: p.x, y: p.y, board: { boardName: tab.title, url: tab.boardUrl } }); }}
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
                    const els = boardTabBarRef.current?.querySelectorAll<HTMLElement>(".board-tab:not(.placeholder)");
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
                title={tab.boardUrl}
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
                className={`thread-tab tab ${i === activeTabIndex ? "active" : ""} ${tabDragIndex !== null && tabDragIndex !== i ? "drag-target" : ""}`}
                onClick={() => { if (tabDragSuppressClickRef.current) return; onTabClick(i); }}
                onDoubleClick={() => { void fetchResponsesFromCurrent(tab.threadUrl, { keepSelection: true }); }}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(i); } }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const p = clampMenuPosition(e.clientX, e.clientY, 160, 120);
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
        {activePaneView === "threads" ? (
        <section id="boardPane" className="pane threads" onMouseDown={() => setFocusedPane("threads")} style={{ '--fs-delta': `${threadsFontSize - 12}px` } as React.CSSProperties}>
          <div className="threads-toolbar">
            <div className="search-with-history" style={{ flex: 1 }}>
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
                          const p = clampMenuPosition(e.clientX, e.clientY, 120, 30);
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
                      addNgEntry("thread_words", threadNgInput);
                      setThreadNgInput("");
                    }
                  }}
                  placeholder="NGワード (例: BE:12345)"
                  style={{ flex: 1 }}
                />
                <button onClick={() => { addNgEntry("thread_words", threadNgInput); setThreadNgInput(""); }}>追加</button>
              </div>
              {ngFilters.thread_words.length > 0 && (
                <ul className="thread-ng-list">
                  {ngFilters.thread_words.map((w) => (
                    <li key={w}>
                      <span>{w}</span>
                      <button className="ng-remove" onClick={() => removeNgEntry("thread_words", w)}>×</button>
                    </li>
                  ))}
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
                const isUnread = !threadReadMap[t.id];
                const hasUnread = t.got > 0 && t.res - t.got > 0;
                return (
                  <tr
                    key={t.id}
                    className={`bcon${t.id % 2 === 0 ? " odd" : ""} ${selectedThread === t.id ? "selected-row cursor" : ""} ${isUnread ? "unread-row" : ""} ${hasUnread ? "has-unread-row" : ""} ${"datOchi" in t && t.datOchi ? "dat-ochi-row" : ""}`}
                    onClick={() => {
                      setSelectedThread(t.id);
                      setSelectedResponse(1);
                      setThreadReadMap((prev) => ({ ...prev, [t.id]: true }));
                      setThreadLastReadCount((prev) => ({ ...prev, [t.id]: t.res }));
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
                          const ft = fetchedThreads[t.id - 1];
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
                    <td className="thread-fetched-cell">{showFavoritesOnly ? (hasUnread ? "\u25CF" : "") : (hasUnread || threadReadMap[t.id] ? "\u25CF" : "")}</td>
                    <td>{t.id}</td>
                    <td
                      className={`thread-title-cell${customTitles[selectedBoard]?.[t.threadKey] ? " has-custom-title" : ""}`}
                      dangerouslySetInnerHTML={renderHighlightedPlainText(customTitles[selectedBoard]?.[t.threadKey] ?? t.title, threadSearchQuery)}
                    />
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
                  title={`読み上げ ${ttsEnabled ? "ON" : "OFF"}`}
                ><Volume2 size={14} /></button>
                <button
                  className="title-action-btn"
                  onClick={() => void ttsStop()}
                  title="読み上げを今すぐ停止 (待機中の分もまとめて破棄)"
                ><VolumeX size={14} /></button>
                {!newArrivalPaneOpen && (
                  <button className="title-action-btn" onClick={() => setNewArrivalPaneOpen(true)} title="新着ペイン表示"><ChevronUp size={14} /></button>
                )}
                <button className="title-action-btn" onClick={() => {
                  const tab = threadTabs[activeTabIndex];
                  if (tab) toggleFavoriteThread({ threadUrl: tab.threadUrl, title: tab.title });
                }} title="お気に入り">
                  <Star size={14} fill={favorites.threads.some((f) => f.threadUrl === threadTabs[activeTabIndex].threadUrl) ? "currentColor" : "none"} />
                </button>
              </span>
            </div>
          )}
          {responseSearchMode && (
            <div className="response-search-bar">
              <span className="search-mode-label">{responseSearchMode === "extract" ? "レス抽出:" : "スレ内検索:"}</span>
              <div className="search-with-history" style={{ flex: 1 }}>
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
                            const p = clampMenuPosition(e.clientX, e.clientY, 120, 30);
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
                      return;
                    }
                  }
                  if (url && /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(url) && isTauriRuntime()) {
                    void invoke("open_image_popup", { url }).catch(() => window.open(url, "_blank"));
                    return;
                  }
                  if (url && isTauriRuntime()) {
                    void invoke("open_external_url", { url }).catch(() => window.open(url, "_blank"));
                  } else if (url) {
                    window.open(url, "_blank");
                  }
                  return;
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
                  return;
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
                  return;
                }
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
                          <span
                            className="response-name res-name mname"
                            style={(() => {
                              const hl = textHighlights.find((h) => h.type === "name" && h.pattern === r.nameWithoutWatchoi);
                              return hl ? { background: hl.color } : undefined;
                            })()}
                            dangerouslySetInnerHTML={renderHighlightedPlainText(r.nameWithoutWatchoi, responseSearchQuery)}
                          />
                        </>
                      )}
                      {mainHeaderVis.mail && r.mail && (
                        <span className={`response-mail res-mail${r.mail === "sage" ? " response-mail-sage sage" : ""}`}>[{r.mail}]</span>
                      )}
                      {mainHeaderVis.watchoi && r.watchoi && (
                        <span
                          className="response-watchoi"
                          onClick={(e) => {
                            e.stopPropagation();
                            const p = clampMenuPosition(e.clientX, e.clientY, 180, 80);
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
                            <span
                              className="response-date res-date"
                              dangerouslySetInnerHTML={renderHighlightedPlainText(formatResponseDate(r.time), responseSearchQuery)}
                            />
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
                                const p = clampMenuPosition(e.clientX, e.clientY, 160, 56);
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
                              className="response-id-count cnt"
                              style={{ color: count >= 5 ? '#cc3333' : count >= 2 ? '#3366ff' : undefined }}
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
                              const p = clampMenuPosition(e.clientX, e.clientY, 220, 112);
                              setBeMenu({ x: p.x, y: p.y, beNumber: r.beNumber! });
                            }}
                          >
                            BE:{r.beNumber}
                          </button>
                        )}
                      </span>
                    </div>
                    <div className={`response-body rb${isAa ? " aa" : ""}`} dangerouslySetInnerHTML={renderResponseBodyHighlighted(r.text, responseSearchQuery, { hideImages: !showImagePreview || ngResultMap.get(r.id) === "hide-images", imageSizeLimitKb: imageSizeLimit, urlRules: imageUrlRules, ogpCards: ogpCardsEnabled, tweetCards: tweetCardsEnabled, ogpAllow: ogpDomainFilters.allow, ogpBlock: ogpDomainFilters.block }, textHighlights.filter((h) => h.type === "word"))} />
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
        className={`compose-window postform${composeOpen ? " compose-window--open" : ""}`}
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
          {composeOpen && (
            <>
              <button className={`compose-mode-btn ${!composePreview ? "active" : ""}`} onClick={() => setComposePreview(false)}>本文</button>
              <button className={`compose-mode-btn ${composePreview ? "active" : ""}`} onClick={() => setComposePreview(true)}>プレビュー</button>
            </>
          )}
        </header>
        {composeOpen && (
          <>
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
              <button className="postform-write" onClick={probePostFlowTraceFromCompose} disabled={composeSubmitting}>{composeSubmitting ? "送信中..." : `送信 (${composeSubmitKey === "shift" ? "Shift" : "Ctrl"}+Enter)`}</button>
              {diagnosticsEnabled && (
                <button onClick={async () => {
                  setComposeResult({ ok: false, message: "診断中..." });
                  try {
                    const r = await invoke<string>("debug_post_connectivity", { threadUrl });
                    setComposeResult({ ok: true, message: r });
                  } catch (e) {
                    setComposeResult({ ok: false, message: `診断エラー: ${String(e)}` });
                  }
                }} style={{ fontSize: "0.85em" }}>接続診断</button>
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
        {activePaneView !== "threads" && activeTabIndex >= 0 && activeTabIndex < threadTabs.length ? (
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
              {ngFilters.words.length}語 / {ngFilters.ids.length}ID / {ngFilters.names.length}名
            </span>
            <button onClick={() => setNgPanelOpen(false)}>閉じる</button>
          </header>
          <div className="ng-panel-add">
            <select value={ngInputType} onChange={(e) => setNgInputType(e.target.value as "words" | "ids" | "names" | "regex")}>
              <option value="words">ワード</option>
              <option value="ids">ID</option>
              <option value="names">名前</option>
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
              placeholder={ngInputType === "regex" ? "正規表現パターンを入力" : ngInputType === "words" ? "NGワードを入力" : ngInputType === "ids" ? "NG IDを入力" : "NG名前を入力"}
            />
            <select value={ngAddMode} onChange={(e) => setNgAddMode(e.target.value as "hide" | "hide-images")} className="ng-mode-select">
              <option value="hide">非表示</option>
              <option value="hide-images">画像NG</option>
            </select>
            <select value={ngAddScope} onChange={(e) => setNgAddScope(e.target.value as "global" | "board" | "thread")} className="ng-mode-select">
              <option value="global">全体</option>
              <option value="board">この板</option>
              <option value="thread">このスレ</option>
            </select>
            <button onClick={() => addNgFromInput()}>追加</button>
          </div>
          <div className="ng-panel-lists">
            {(["words", "ids", "names"] as const).map((type) => (
              <div key={type} className="ng-list-section">
                <h4>{type === "words" ? "ワード" : type === "ids" ? "ID" : "名前"} ({ngFilters[type].length})</h4>
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
                          <span className={`ng-mode-label ${mode === "hide-images" ? "ng-mode-img" : "ng-mode-hide"}`}>
                            {mode === "hide-images" ? "画像" : "非表示"}
                          </span>
                          {scope !== "global" && <span className="ng-mode-label" style={{ background: scope === "board" ? "#2a7a2a" : "#2a5a9a", color: "#fff" }}>{scope === "board" ? "板" : "スレ"}</span>}
                          {isRegex && <span className="ng-mode-label" style={{ background: "#6b4c9a", color: "#fff" }}>正規表現</span>}
                          <span>{v}</span>
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
        <div className="thread-menu" style={{ left: threadMenu.x, top: threadMenu.y }} onClick={(e) => e.stopPropagation()}>
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
      {responseMenu && (
        <div className="thread-menu response-menu" style={{ left: responseMenu.x, top: responseMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onMouseLeave={() => setHlSubMenu(null)}
        >
          {/* ----- ハイライト項目 ----- */}
          {responseMenu.selection && (
            <div className="menu-item-with-sub"
              onMouseEnter={() => setHlSubMenu({ type: "text", value: responseMenu.selection!, nearRight: responseMenu.x > window.innerWidth / 2 })}
            >
              <span>「{responseMenu.selection.slice(0, 15)}」をハイライト</span>
              <span className="menu-arrow">▶</span>
              {hlSubMenu?.type === "text" && hlSubMenu.value === responseMenu.selection && (
                <div className="hl-color-grid" style={hlSubMenu.nearRight ? { left: "auto", right: "100%" } : undefined} onClick={(e) => e.stopPropagation()}>
                  {HIGHLIGHT_COLORS.map((c) => (
                    <div key={c.color} className="hl-color-cell" style={{ background: c.color }} title={c.name}
                      onClick={() => {
                        const next = [...textHighlights.filter((h) => h.pattern !== responseMenu.selection || h.type !== "word"),
                          { pattern: responseMenu.selection!, color: c.color, type: "word" as const }];
                        persistTextHighlights(next);
                        setResponseMenu(null); setHlSubMenu(null);
                      }} />
                  ))}
                </div>
              )}
            </div>
          )}
          {responseMenu.resId && (
            <div className="menu-item-with-sub"
              onMouseEnter={() => setHlSubMenu({ type: "id", value: responseMenu.resId!, nearRight: responseMenu.x > window.innerWidth / 2 })}
            >
              <span>ID:{responseMenu.resId} をハイライト</span>
              <span className="menu-arrow">▶</span>
              {hlSubMenu?.type === "id" && hlSubMenu.value === responseMenu.resId && (
                <div className="hl-color-grid" style={hlSubMenu.nearRight ? { left: "auto", right: "100%" } : undefined} onClick={(e) => e.stopPropagation()}>
                  {HIGHLIGHT_COLORS.map((c) => (
                    <div key={c.color} className="hl-color-cell" style={{ background: c.color }} title={c.name}
                      onClick={() => {
                        const next = { ...idHighlights, [responseMenu.resId!]: c.color };
                        persistIdHighlights(next);
                        setResponseMenu(null); setHlSubMenu(null);
                      }} />
                  ))}
                </div>
              )}
            </div>
          )}
          {responseMenu.resName && (
            <div className="menu-item-with-sub"
              onMouseEnter={() => setHlSubMenu({ type: "name", value: responseMenu.resName!, nearRight: responseMenu.x > window.innerWidth / 2 })}
            >
              <span>名前「{responseMenu.resName.slice(0, 12)}」をハイライト</span>
              <span className="menu-arrow">▶</span>
              {hlSubMenu?.type === "name" && hlSubMenu.value === responseMenu.resName && (
                <div className="hl-color-grid" style={hlSubMenu.nearRight ? { left: "auto", right: "100%" } : undefined} onClick={(e) => e.stopPropagation()}>
                  {HIGHLIGHT_COLORS.map((c) => (
                    <div key={c.color} className="hl-color-cell" style={{ background: c.color }} title={c.name}
                      onClick={() => {
                        const next = [...textHighlights.filter((h) => h.pattern !== responseMenu.resName || h.type !== "name"),
                          { pattern: responseMenu.resName!, color: c.color, type: "name" as const }];
                        persistTextHighlights(next);
                        setResponseMenu(null); setHlSubMenu(null);
                      }} />
                  ))}
                </div>
              )}
            </div>
          )}
          {/* ハイライト解除 */}
          {(() => {
            const canClearId = responseMenu.resId && idHighlights[responseMenu.resId];
            const canClearText = responseMenu.selection && textHighlights.some((h) => h.pattern === responseMenu.selection && h.type === "word");
            const canClearName = responseMenu.resName && textHighlights.some((h) => h.pattern === responseMenu.resName && h.type === "name");
            if (!canClearId && !canClearText && !canClearName) return null;
            return (
              <button onClick={() => {
                if (canClearId) persistIdHighlights(Object.fromEntries(Object.entries(idHighlights).filter(([k]) => k !== responseMenu.resId)));
                if (canClearText) persistTextHighlights(textHighlights.filter((h) => !(h.pattern === responseMenu.selection && h.type === "word")));
                if (canClearName) persistTextHighlights(textHighlights.filter((h) => !(h.pattern === responseMenu.resName && h.type === "name")));
                setResponseMenu(null); setHlSubMenu(null);
              }}>ハイライト解除</button>
            );
          })()}
          {/* ----- 画像保存 / URLコピー ----- */}
          {responseMenu.imageUrl && isTauriRuntime() && (
            <button onClick={() => { void saveImage(responseMenu.imageUrl!); setResponseMenu(null); }}>画像を保存</button>
          )}
          {responseMenu.linkUrl && (
            <button onClick={() => { void navigator.clipboard.writeText(responseMenu.linkUrl!); setStatus("URLをコピーしました"); setResponseMenu(null); }}>URLをコピー</button>
          )}
          {/* ----- セパレーター ----- */}
          <hr className="menu-sep" />
          {/* ----- 既存項目 ----- */}
          {responseMenu.selection && (
            <button onClick={() => { void navigator.clipboard.writeText(responseMenu.selection!); setResponseMenu(null); setStatus("コピーしました"); }}>選択テキストをコピー</button>
          )}
          <button onClick={() => void runResponseAction("quote")}>ここにレス</button>
          <button onClick={() => void runResponseAction("quote-with-name")}>名前付き引用</button>
          <button onClick={() => void runResponseAction("copy-body")}>本文をコピー</button>
          <button onClick={() => void runResponseAction("copy-url")}>レスURLをコピー</button>
          <button onClick={() => void runResponseAction("copy-id")}>IDをコピー</button>
          <button onClick={() => void copyWholeThread()}>スレ全体をコピー</button>
          {responseMenu.selection && (
            <button onClick={() => { addNgEntry("words", responseMenu.selection!); setResponseMenu(null); }}>「{responseMenu.selection.slice(0, 15)}」をNGワードに追加</button>
          )}
          <button onClick={() => void runResponseAction("add-ng-id")}>NGIDに追加</button>
          <button onClick={() => void runResponseAction("add-ng-name")}>NG名前に追加</button>
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
          {/* ----- セパレーター ----- */}
          <hr className="menu-sep" />
          {/* このレスから読み上げ（レス番号上のみ） */}
          {responseMenu.isOnResNo && responseMenu.responseId > 0 && (ttsMode !== "off" || diagnosticsEnabled) && (
            <button onClick={() => {
              const startNo = responseMenu.responseId;
              const items = visibleResponseItems.filter((r) => r.id >= startNo);
              const curThreadUrl = threadTabs[activeTabIndex]?.threadUrl ?? threadUrl;
              const site = detectSiteType(curThreadUrl);
              setResponseMenu(null);
              setStatus(`レス ${startNo} から読み上げ開始 (${items.length}件)`);
              // テスト機能 (診断モード: debug ビルドまたは LIVEFAKE_DIAG=1 のときのみ):
              // 該当レスを「新着レス」として扱い、自動更新時と同じ経路で新着レスペイン・字幕ウィンドウへ流す。
              // 新着ペイン・字幕でのカード表示などの見え方を、実際の新着を待たずに検証するためのもの。
              if (diagnosticsEnabled) {
                const tabTitle = threadTabs[activeTabIndex]?.title ?? "";
                const arrivals: ArrivalItem[] = items
                  .filter((item) => item.id < 1001)
                  .map((item) => makeArrival({ responseNo: item.id, name: item.name, mail: item.mail, dateAndId: item.time, body: item.text }, tabTitle, curThreadUrl, fetchedResponses));
                if (arrivals.length > 0) {
                  const queueWasEmpty = arrivalQueueRef.current.length === 0;
                  arrivalQueueRef.current.push(...arrivals);
                  setArrivalQueueCount(arrivalQueueRef.current.length);
                  if (!arrivalPausedRef.current && !arrivalTimerRef.current && (currentArrivalItemRef.current === null || queueWasEmpty)) {
                    advanceToNextArrival();
                  }
                }
              }
              if (ttsMode === "off") return;
              void (async () => {
                await ttsStop();
                for (const item of items) {
                  if (item.id >= 1001) continue;
                  const prefix = site === "shitaraba" ? `したらば${item.id}番さん`
                    : site === "jpnkn" ? `ジャパンくん${item.id}番さん`
                    : `レス${item.id}番さん`;
                  const idMatch = item.time.match(/ID:([^\s]+)/);
                  ttsSpeak(item.text, prefix, undefined, { name: item.name, id: idMatch ? idMatch[1] : "" });
                }
              })();
            }}>{diagnosticsEnabled ? "このレスから読み上げ（テスト: 新着として流す）" : "このレスから読み上げ"}</button>
          )}
          {/* ----- セパレーター ----- */}
          <hr className="menu-sep" />
          {/* トグル3種 */}
          <button onClick={() => { setAutoRefreshEnabled(!autoRefreshEnabled); setResponseMenu(null); }}>
            {autoRefreshEnabled ? "✓" : "　"} オートリロード
          </button>
          <button onClick={() => { setAutoScrollEnabled(!autoScrollEnabled); setResponseMenu(null); }}>
            {autoScrollEnabled ? "✓" : "　"} オートスクロール
          </button>
          <button onClick={() => { setTtsEnabled(!ttsEnabled); setResponseMenu(null); }}>
            {ttsEnabled ? "✓" : "　"} 読み上げ
          </button>
          <button onClick={() => { void ttsStop(); setResponseMenu(null); }}>読み上げを今すぐ停止</button>
        </div>
      )}
      {addressMenu && (
        <div className="thread-menu" style={{ left: addressMenu.x, top: addressMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setAddressMenu(null); void pasteAndGo(); }}>貼り付けて移動</button>
          <button onClick={() => { setAddressMenu(null); void pasteToAddress(); }}>貼り付け</button>
          <button onClick={() => { setAddressMenu(null); if (locationInput) { void navigator.clipboard.writeText(locationInput); setStatus("URL をコピーしました"); } }} disabled={!locationInput}>コピー</button>
          <button onClick={() => { setAddressMenu(null); const el = addressInputRef.current; if (el) { el.focus(); el.select(); } }}>すべて選択</button>
        </div>
      )}
      {boardContextMenu && (
        <div className="thread-menu" style={{ left: boardContextMenu.x, top: boardContextMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { toggleFavoriteBoard(boardContextMenu.board); setBoardContextMenu(null); }}>
            {isFavoriteBoard(boardContextMenu.board.url) ? "お気に入りから削除" : "お気に入りに追加"}
          </button>
          <button onClick={() => { void navigator.clipboard.writeText(boardContextMenu.board.url); setStatus("板URLをコピーしました"); setBoardContextMenu(null); }}>板URLをコピー</button>
        </div>
      )}
      {tabMenu && (
        <div className="thread-menu tab-menu" style={{ left: tabMenu.x, top: tabMenu.y }} onClick={(e) => e.stopPropagation()}>
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
        <div className="thread-menu" style={{ left: watchoiMenu.x, top: watchoiMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { addNgEntry("names", watchoiMenu.watchoi); setWatchoiMenu(null); }}>ワッチョイをNG</button>
          <button onClick={() => { void navigator.clipboard.writeText(watchoiMenu.watchoi); setStatus("ワッチョイをコピーしました"); setWatchoiMenu(null); }}>ワッチョイをコピー</button>
          <button onClick={() => { setResponseSearchQuery(watchoiMenu.watchoi); addSearchHistory("response", watchoiMenu.watchoi); setStatus(`ワッチョイでレス抽出: ${watchoiMenu.watchoi}`); setWatchoiMenu(null); }}>このワッチョイでレス抽出</button>
        </div>
      )}
      {idMenu && (
        <div className="thread-menu" style={{ left: idMenu.x, top: idMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { addNgEntry("ids", idMenu.id); setIdMenu(null); }}>NGIDに追加</button>
        </div>
      )}
      {beMenu && (
        <div className="thread-menu" style={{ left: beMenu.x, top: beMenu.y }} onClick={(e) => e.stopPropagation()}>
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
        <div className="thread-menu" style={{ left: searchHistoryMenu.x, top: searchHistoryMenu.y }} onClick={(e) => e.stopPropagation()}>
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
          <div className="settings-panel" onClick={(e) => e.stopPropagation()} style={{ width: 360, textAlign: "center" }}>
            <header className="settings-header">
              <strong>バージョン情報</strong>
              <button onClick={() => setAboutOpen(false)}>閉じる</button>
            </header>
            <div style={{ padding: "24px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
              <img src="/icon.png" alt="LiveFake" style={{ width: 64, height: 64 }} />
              <div style={{ fontSize: "1.3em", fontWeight: "bold" }}>LiveFake</div>
              <div style={{ color: "var(--sub)" }}>v{currentVersion}</div>
              <div style={{ fontSize: "0.85em", color: "var(--sub)", lineHeight: 1.6 }}>
                5ch専用ブラウザ<br />
                Runtime: {runtimeState}
              </div>
              <div style={{ fontSize: "0.85em", color: updateResult?.hasUpdate ? "#cc3300" : "var(--sub)", marginTop: 4 }}>
                {updateProbe === "running..." ? "更新確認中..." : updateResult ? (updateResult.hasUpdate ? `新しいバージョンがあります: v${updateResult.latestVersion}` : `最新版です (v${currentVersion})`) : ""}
              </div>
              {updateResult?.hasUpdate && (
                <button onClick={openDownloadPage} style={{ marginTop: 4 }}>
                  ダウンロードページを開く
                </button>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
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
                <button key={b.label} className={b.primary ? "primary" : b.danger ? "danger" : ""} onClick={() => { setAppConfirm(null); b.onClick(); }}>{b.label}</button>
              ))}
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
                    <button key={sec.id} className={`settings-section-tab${settingsActiveSection === sec.id ? " active" : ""}`} onClick={() => { setSettingsSection(sec.id); setSettingsListFilter(""); if (settingsCategory === "ng" && (sec.id === "words" || sec.id === "ids" || sec.id === "names")) setNgInputType(sec.id); }}>{sec.label}</button>
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
                <label className="settings-row" style={{ alignItems: "flex-start" }}>
                  <span style={{ paddingTop: 4 }}>フォント</span>
                  <div className="font-picker">
                    <div style={{ display: "flex", gap: 4 }}>
                      <input
                        type="text"
                        className="font-picker-input"
                        value={fontPickerInput}
                        onChange={(e) => { setFontPickerInput(e.target.value); setFontPickerOpen(true); }}
                        onFocus={() => setFontPickerOpen(true)}
                        onBlur={() => setTimeout(() => setFontPickerOpen(false), 150)}
                        placeholder="デフォルト (入力またはクリック)"
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      {fontFamily && (
                        <button style={{ flexShrink: 0 }} onClick={() => { setFontFamily(""); setFontPickerInput(""); }}>×</button>
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
                <label className="settings-row">
                  <input type="checkbox" checked={showBoardButtons} onChange={(e) => setShowBoardButtons(e.target.checked)} />
                  <span>板ボタンバー</span>
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={keepSortOnRefresh} onChange={(e) => setKeepSortOnRefresh(e.target.checked)} />
                  <span>スレ一覧の更新時にソートを維持</span>
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={restoreSession} onChange={(e) => setRestoreSession(e.target.checked)} />
                  <span>起動時に前回のタブと板を復元</span>
                </label>
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
                <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                  <span>レスヘッダに表示する項目（非表示の項目は詰めて表示）</span>
                  {headerVisRows(mainHeaderVis, setMainHeaderVis, { watchoi: true })}
                </div>
                <label className="settings-row">
                  <input type="checkbox" checked={responseDividerAlways} onChange={(e) => setResponseDividerAlways(e.target.checked)} />
                  <span>レス間に罫線を常に表示（ヘッダ項目を全て非表示にしたときは自動で表示）</span>
                </label>
                <label className="settings-row">
                  <span>レスID 文字サイズ補正 (0=同じ、±px)</span>
                  <input type="number" value={resIdFontSize} min={-20} max={24} onChange={(e) => setResIdFontSize(Number(e.target.value))} style={{ width: 60 }} />
                </label>
                <label className="settings-row" style={{ alignItems: "flex-start" }}>
                  <span style={{ paddingTop: 4 }}>レスID フォント</span>
                  <div className="font-picker">
                    <div style={{ display: "flex", gap: 4 }}>
                      <input type="text" className="font-picker-input" value={resIdFontPickerInput}
                        onChange={(e) => { setResIdFontPickerInput(e.target.value); setResIdFontPickerOpen(true); }}
                        onFocus={() => setResIdFontPickerOpen(true)}
                        onBlur={() => setTimeout(() => setResIdFontPickerOpen(false), 150)}
                        placeholder="デフォルト (入力またはクリック)" style={{ flex: 1, minWidth: 0 }} />
                      {resIdFontFamily && <button style={{ flexShrink: 0 }} onClick={() => { setResIdFontFamily(""); setResIdFontPickerInput(""); }}>×</button>}
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
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "#888" }}>{imageSaveFolder || "(未設定 — 毎回選択)"}</span>
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
                <div className="settings-row" style={{ gap: 8 }}>
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
                <div style={{ fontSize: "0.8em", color: "var(--sub)", marginTop: 4 }}>
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
                  <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                    <div style={{ fontSize: 11, color: "var(--text-secondary, #888)" }}>
                      カード表示の通信先ドメイン。ブロックは常に除外、許可は空なら全ドメイン・登録があればそのドメインのみ通信します。
                      私有ネットワーク・ローカルアドレスへは設定に関わらず通信しません。
                    </div>
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <input type="text" value={ogpDomainInput} onChange={(e) => setOgpDomainInput(e.target.value)} placeholder="example.com" style={{ width: 180 }} />
                      <button onClick={() => { addOgpDomain("allow", ogpDomainInput); setOgpDomainInput(""); }}>許可に追加</button>
                      <button onClick={() => { addOgpDomain("block", ogpDomainInput); setOgpDomainInput(""); }}>ブロックに追加</button>
                    </div>
                    {ogpDomainFilters.allow.length > 0 && (
                      <div style={{ fontSize: 11 }}>
                        許可: {ogpDomainFilters.allow.map((d) => (
                          <span key={`a-${d}`} style={{ display: "inline-flex", alignItems: "center", gap: 2, marginRight: 6 }}>
                            {d}<button style={{ fontSize: 10, padding: "0 4px" }} onClick={() => removeOgpDomain("allow", d)}>×</button>
                          </span>
                        ))}
                      </div>
                    )}
                    {ogpDomainFilters.block.length > 0 && (
                      <div style={{ fontSize: 11 }}>
                        ブロック: {ogpDomainFilters.block.map((d) => (
                          <span key={`b-${d}`} style={{ display: "inline-flex", alignItems: "center", gap: 2, marginRight: 6 }}>
                            {d}<button style={{ fontSize: 10, padding: "0 4px" }} onClick={() => removeOgpDomain("block", d)}>×</button>
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
                <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                  <div style={{ fontSize: 11, color: "var(--text-secondary, #888)" }}>
                    新着レスペインの自動スクロール: 収まらない長文は「待ち時間」の後、最下行まで「スクロール速度」でゆっくり流し、到達後の表示時間が過ぎたら次のレスへ進みます。
                  </div>
                  {scrollTimingRows(arrivalTiming, setArrivalTiming)}
                </div>
                <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                  <span>新着レスペインのヘッダに表示する項目（非表示の項目は詰めて表示）</span>
                  {headerVisRows(arrivalHeaderVis, setArrivalHeaderVis, { threadTitle: true })}
                </div>
                <label className="settings-row">
                  <span>新着ID 文字サイズ補正 (0=同じ、±px)</span>
                  <input type="number" value={newArrivalIdFontSize} min={-20} max={24} onChange={(e) => setNewArrivalIdFontSize(Number(e.target.value))} style={{ width: 60 }} />
                </label>
                <label className="settings-row" style={{ alignItems: "flex-start" }}>
                  <span style={{ paddingTop: 4 }}>新着ID フォント</span>
                  <div className="font-picker">
                    <div style={{ display: "flex", gap: 4 }}>
                      <input type="text" className="font-picker-input" value={newArrivalIdFontPickerInput}
                        onChange={(e) => { setNewArrivalIdFontPickerInput(e.target.value); setNewArrivalIdFontPickerOpen(true); }}
                        onFocus={() => setNewArrivalIdFontPickerOpen(true)}
                        onBlur={() => setTimeout(() => setNewArrivalIdFontPickerOpen(false), 150)}
                        placeholder="デフォルト (入力またはクリック)" style={{ flex: 1, minWidth: 0 }} />
                      {newArrivalIdFontFamily && <button style={{ flexShrink: 0 }} onClick={() => { setNewArrivalIdFontFamily(""); setNewArrivalIdFontPickerInput(""); }}>×</button>}
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
                  }} style={{ width: 60 }} />
                </div>
                <div className="settings-row">
                  <span>メタフォントサイズ</span>
                  <input type="number" min={8} max={48} value={subtitleMetaFontSize} onChange={(e) => {
                    const v = Number(e.target.value);
                    setSubtitleMetaFontSize(v);
                  }} style={{ width: 60 }} />
                </div>
                <div className="settings-row">
                  <span>背景透明度</span>
                  <input type="range" min={0.1} max={1.0} step={0.05} value={subtitleOpacity} onChange={(e) => {
                    const v = Number(e.target.value);
                    setSubtitleOpacity(v);
                  }} style={{ width: 120 }} />
                  <span>{subtitleOpacity.toFixed(2)}</span>
                </div>
                <div className="settings-row">
                  <span>常に最前面</span>
                  <input type="checkbox" checked={subtitleAlwaysOnTop} onChange={(e) => {
                    setSubtitleAlwaysOnTop(e.target.checked);
                  }} />
                </div>
                <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                  <span>字幕のヘッダに表示する項目（非表示の項目は詰めて表示）</span>
                  {headerVisRows(subtitleHeaderVis, setSubtitleHeaderVis, { threadTitle: true })}
                </div>
                <div className="settings-row">
                  <span>ID 文字サイズ補正 (0=メタと同じ、±px)</span>
                  <input type="number" min={-48} max={48} value={subtitleIdFontSize} onChange={(e) => {
                    const v = Number(e.target.value);
                    setSubtitleIdFontSize(v);
                  }} style={{ width: 60 }} />
                </div>
                <div className="settings-row" style={{ alignItems: "flex-start" }}>
                  <span style={{ paddingTop: 4 }}>ID フォント</span>
                  <div className="font-picker">
                    <div style={{ display: "flex", gap: 4 }}>
                      <input type="text" className="font-picker-input" value={subtitleIdFontPickerInput}
                        onChange={(e) => { setSubtitleIdFontPickerInput(e.target.value); setSubtitleIdFontPickerOpen(true); }}
                        onFocus={() => setSubtitleIdFontPickerOpen(true)}
                        onBlur={() => setTimeout(() => setSubtitleIdFontPickerOpen(false), 150)}
                        placeholder="デフォルト (入力またはクリック)" style={{ flex: 1, minWidth: 0 }} />
                      {subtitleIdFontFamily && <button style={{ flexShrink: 0 }} onClick={() => {
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
                  <span>ウィンドウ位置</span>
                  <button onClick={() => {
                    if (isTauriRuntime()) invoke("subtitle_reset_position").catch((e) => console.warn("subtitle_reset_position:", e));
                  }}>中央に戻す</button>
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
                <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                  <div style={{ fontSize: 11, color: "var(--text-secondary, #888)" }}>
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
                  <input type="number" min={0} max={300} step={1} value={ttsMaxReadLength} onChange={(e) => setTtsMaxReadLength(Number(e.target.value))} style={{ width: 70 }} />
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
                      <input type="number" min={-10} max={10} value={sapiRate} onChange={(e) => setSapiRate(Number(e.target.value))} style={{ width: 60 }} />
                    </div>
                    <div className="settings-row">
                      <span>音量 (0〜100)</span>
                      <input type="number" min={0} max={100} value={sapiVolume} onChange={(e) => setSapiVolume(Number(e.target.value))} style={{ width: 60 }} />
                    </div>
                  </>
                )}
                {ttsMode === "bouyomi" && (
                  <>
                    <div className="settings-row">
                      <span>RemoteTalk.exe パス</span>
                      <input type="text" value={bouyomiPath} onChange={(e) => setBouyomiPath(e.target.value)} style={{ width: 160 }} placeholder="C:\...\RemoteTalk.exe" />
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
                      <input type="text" value={voicevoxEndpoint} onChange={(e) => setVoicevoxEndpoint(e.target.value)} style={{ width: 200 }} />
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
                      <input type="number" min={0.5} max={2.0} step={0.1} value={voicevoxSpeedScale} onChange={(e) => setVoicevoxSpeedScale(Number(e.target.value))} style={{ width: 60 }} />
                    </div>
                    <div className="settings-row">
                      <span>ピッチ (-0.15〜+0.15)</span>
                      <input type="number" min={-0.15} max={0.15} step={0.01} value={voicevoxPitchScale} onChange={(e) => setVoicevoxPitchScale(Number(e.target.value))} style={{ width: 60 }} />
                    </div>
                    <div className="settings-row">
                      <span>抑揚 (0〜2.0)</span>
                      <input type="number" min={0} max={2.0} step={0.1} value={voicevoxIntonationScale} onChange={(e) => setVoicevoxIntonationScale(Number(e.target.value))} style={{ width: 60 }} />
                    </div>
                    <div className="settings-row">
                      <span>音量 (0〜2.0)</span>
                      <input type="number" min={0} max={2.0} step={0.1} value={voicevoxVolumeScale} onChange={(e) => setVoicevoxVolumeScale(Number(e.target.value))} style={{ width: 60 }} />
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
              <section className="settings-section" data-section="dict">
                {settingsSectionHeading("tts-dict", "dict")}
              <fieldset>
                <legend>読み上げ辞書 ({ttsDictEntries.length}件)</legend>
                {settingsListFilterRow()}
                <div style={{ fontSize: 11, color: "var(--text-secondary, #888)", marginBottom: 6 }}>
                  「全文置換」: テキストにキーワードが含まれる場合、レス全体を「読み上げテキスト」で置換します。<br />
                  URL はキーワードに「://」を含む項目なら URL 文字列との部分一致、含まない項目ならホスト名との部分一致 (例: youtube) で照合し、
                  一致した URL 全体を読み上げテキストに置き換えます。どの項目にも一致しない URL は読み上げません。
                </div>
                <table data-search-exclude="1" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 6 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border, #ccc)", textAlign: "left" }}>
                      <th style={{ padding: "2px 6px" }}>キーワード</th>
                      <th style={{ padding: "2px 6px" }}>読み上げテキスト</th>
                      <th style={{ padding: "2px 6px", textAlign: "center" }}>全文置換</th>
                      <th style={{ padding: "2px 6px" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {ttsDictEntries.map((entry, i) => ({ entry, i })).filter(({ entry }) => settingsListMatch(entry.from, entry.to)).map(({ entry, i }) => (
                      <tr key={i} style={{ borderBottom: "1px solid var(--border-light, #eee)" }}>
                        <td style={{ padding: "3px 6px" }}>
                          <input type="text" value={entry.from} onChange={(e) => setTtsDictEntries((prev) => prev.map((x, j) => j === i ? { ...x, from: e.target.value } : x))} style={{ width: 220 }} />
                        </td>
                        <td style={{ padding: "3px 6px" }}>
                          <input type="text" value={entry.to} onChange={(e) => setTtsDictEntries((prev) => prev.map((x, j) => j === i ? { ...x, to: e.target.value } : x))} style={{ width: 220 }} />
                        </td>
                        <td style={{ padding: "3px 6px", textAlign: "center" }}>
                          <input type="checkbox" checked={!!entry.fullReplace} onChange={(e) => setTtsDictEntries((prev) => prev.map((x, j) => j === i ? { ...x, fullReplace: e.target.checked } : x))} />
                        </td>
                        <td style={{ padding: "3px 6px" }}>
                          <button onClick={() => setTtsDictEntries((prev) => prev.filter((_, j) => j !== i))}>削除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 4 }}>
                  <input type="text" value={ttsDictNewFrom} onChange={(e) => setTtsDictNewFrom(e.target.value)} placeholder="キーワード" style={{ width: 220 }} />
                  <span>→</span>
                  <input type="text" value={ttsDictNewTo} onChange={(e) => setTtsDictNewTo(e.target.value)} placeholder="読み上げテキスト" style={{ width: 220 }} />
                  <label style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11 }}>
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
                <div style={{ fontSize: 11, color: "var(--text-secondary, #888)", marginBottom: 6 }}>
                  ホスト部分が生の IP アドレス (例: 192.0.2.1:8030) の URL は、ここに登録されたものだけ「読み上げテキスト」で読み上げ、
                  未登録の IP アドレスは読み上げません。ポートを省略するとその IP の全ポートに一致します。ドメイン名の URL は上の読み上げ辞書で扱います。
                </div>
                <table data-search-exclude="1" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 6 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border, #ccc)", textAlign: "left" }}>
                      <th style={{ padding: "2px 6px" }}>IPアドレス[:ポート]</th>
                      <th style={{ padding: "2px 6px" }}>読み上げテキスト</th>
                      <th style={{ padding: "2px 6px" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {ttsIpAllow.map((entry, i) => ({ entry, i })).filter(({ entry }) => settingsListMatch(entry.host, entry.to)).map(({ entry, i }) => (
                      <tr key={i} style={{ borderBottom: "1px solid var(--border-light, #eee)" }}>
                        <td style={{ padding: "3px 6px" }}>
                          <input type="text" value={entry.host} onChange={(e) => setTtsIpAllow((prev) => prev.map((x, j) => j === i ? { ...x, host: e.target.value } : x))} style={{ width: 220 }} />
                        </td>
                        <td style={{ padding: "3px 6px" }}>
                          <input type="text" value={entry.to} onChange={(e) => setTtsIpAllow((prev) => prev.map((x, j) => j === i ? { ...x, to: e.target.value } : x))} style={{ width: 220 }} />
                        </td>
                        <td style={{ padding: "3px 6px" }}>
                          <button onClick={() => setTtsIpAllow((prev) => prev.filter((_, j) => j !== i))}>削除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 4 }}>
                  <input type="text" value={ttsIpAllowNewHost} onChange={(e) => setTtsIpAllowNewHost(e.target.value)} placeholder="IPアドレス[:ポート]" style={{ width: 220 }} />
                  <span>→</span>
                  <input type="text" value={ttsIpAllowNewTo} onChange={(e) => setTtsIpAllowNewTo(e.target.value)} placeholder="読み上げテキスト" style={{ width: 220 }} />
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
                <div style={{ fontSize: 11, color: "var(--text-secondary, #888)", marginBottom: 6 }}>
                  表示やあぼーんには影響せず、読み上げだけを抑制します。「/.../」で囲むと正規表現、それ以外は大小無視の部分一致です。<br />
                  レス本文ワード: 「レス全体を読まない」が OFF なら一致した語句だけを無音で除去、ON ならそのレス全体を読み上げません。<br />
                  名前・ワッチョイ / ID: 読み上げ文に含まれないため、一致したレス全体を常に読み上げません。
                </div>
                <table data-search-exclude="1" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 6 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border, #ccc)", textAlign: "left" }}>
                      <th style={{ padding: "2px 6px" }}>種類</th>
                      <th style={{ padding: "2px 6px" }}>ワード</th>
                      <th style={{ padding: "2px 6px", textAlign: "center" }}>レス全体を読まない</th>
                      <th style={{ padding: "2px 6px" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(["names", "words", "ids"] as const).flatMap((kind) => ttsMuteDict[kind].map((entry, i) => ({ entry, i })).filter(({ entry }) => settingsListMatch(entry.value)).map(({ entry, i }) => (
                      <tr key={`${kind}-${i}`} style={{ borderBottom: "1px solid var(--border-light, #eee)" }}>
                        <td style={{ padding: "3px 6px", whiteSpace: "nowrap" }}>{kind === "names" ? "名前・ワッチョイ" : kind === "words" ? "レス本文ワード" : "ID"}</td>
                        <td style={{ padding: "3px 6px" }}>
                          <input type="text" value={entry.value} onChange={(e) => setTtsMuteDict((prev) => ({ ...prev, [kind]: prev[kind].map((x, j) => j === i ? { ...x, value: e.target.value } : x) }))} style={{ width: 220 }} />
                        </td>
                        <td style={{ padding: "3px 6px", textAlign: "center" }}>
                          {kind === "words"
                            ? <input type="checkbox" checked={!!entry.skipWhole} onChange={(e) => setTtsMuteDict((prev) => ({ ...prev, [kind]: prev[kind].map((x, j) => j === i ? { ...x, skipWhole: e.target.checked } : x) }))} />
                            : <span style={{ fontSize: 11, color: "var(--text-secondary, #888)" }}>常に</span>}
                        </td>
                        <td style={{ padding: "3px 6px" }}>
                          <button onClick={() => setTtsMuteDict((prev) => ({ ...prev, [kind]: prev[kind].filter((_, j) => j !== i) }))}>削除</button>
                        </td>
                      </tr>
                    )))}
                  </tbody>
                </table>
                <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
                  <select value={ttsMuteNewKind} onChange={(e) => setTtsMuteNewKind(e.target.value as TtsMuteKind)}>
                    <option value="words">レス本文ワード</option>
                    <option value="names">名前・ワッチョイ</option>
                    <option value="ids">ID</option>
                  </select>
                  <input type="text" value={ttsMuteNewValue} onChange={(e) => setTtsMuteNewValue(e.target.value)} placeholder="ワード または /正規表現/" style={{ width: 220 }} />
                  {ttsMuteNewKind === "words" && (
                    <label style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11 }}>
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
              {(settingsSearching || settingsCategory === "proxy") && (
              <div className="settings-cat" data-cat="proxy">
              <section className="settings-section" data-section="main">
                {settingsSectionHeading("proxy", "main")}
              <fieldset>
                <legend>プロキシ</legend>
                <label className="settings-row">
                  <span>有効</span>
                  <input type="checkbox" checked={proxyEnabled} onChange={(e) => setProxyEnabled(e.target.checked)} />
                </label>
                <label className="settings-row">
                  <span>タイプ</span>
                  <select value={proxyType} onChange={(e) => setProxyType(e.target.value as "http" | "socks5" | "socks4")}>
                    <option value="http">HTTP</option>
                    <option value="socks5">SOCKS5</option>
                    <option value="socks4">SOCKS4</option>
                  </select>
                </label>
                <label className="settings-row">
                  <span>ホスト</span>
                  <input type="text" value={proxyHost} onChange={(e) => setProxyHost(e.target.value)} placeholder="127.0.0.1" style={{ width: 160 }} />
                </label>
                <label className="settings-row">
                  <span>ポート</span>
                  <input type="text" value={proxyPort} onChange={(e) => setProxyPort(e.target.value)} placeholder="8080" style={{ width: 80 }} />
                </label>
                <label className="settings-row">
                  <span>ユーザー名</span>
                  <input type="text" value={proxyUsername} onChange={(e) => setProxyUsername(e.target.value)} style={{ width: 140 }} />
                </label>
                <label className="settings-row">
                  <span>パスワード</span>
                  <input type="password" value={proxyPassword} onChange={(e) => setProxyPassword(e.target.value)} style={{ width: 140 }} />
                </label>
                <div className="settings-row">
                  <button onClick={() => {
                    if (!isTauriRuntime()) return;
                    invoke("save_proxy_settings", { settings: { enabled: proxyEnabled, proxyType, host: proxyHost, port: proxyPort, username: proxyUsername, password: proxyPassword } }).catch((e) => console.warn("save_proxy_settings:", e));
                  }}>保存</button>
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
                <div className="settings-row" style={{ gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                  <input
                    type="text"
                    placeholder="ワードを入力..."
                    style={{ flex: 1, minWidth: 100 }}
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
                <div className="settings-row" style={{ gap: 3, flexWrap: "wrap", marginBottom: 8 }}>
                  {HIGHLIGHT_COLORS.map((c) => (
                    <div key={c.color} title={c.name}
                      style={{ width: 18, height: 18, background: c.color, border: hlWordColor === c.color ? "2px solid var(--fg)" : "1px solid #888", borderRadius: 2, cursor: "pointer", flexShrink: 0 }}
                      onClick={() => setHlWordColor(c.color)}
                    />
                  ))}
                </div>
                <div data-search-exclude="1">
                {textHighlights.filter((h) => h.type === "word").length === 0 ? (
                  <div style={{ color: "var(--sub)", fontSize: "0.85em" }}>登録なし</div>
                ) : (
                  <>
                    {textHighlights.filter((h) => h.type === "word" && settingsListMatch(h.pattern)).map((h, i) => (
                      <div key={i} className="settings-row" style={{ gap: 6 }}>
                        <span style={{ width: 16, height: 16, display: "inline-block", background: h.color, border: "1px solid #888", borderRadius: 2, flexShrink: 0 }} />
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={h.pattern}>{h.pattern}</span>
                        <button style={{ padding: "1px 6px" }} onClick={() => persistTextHighlights(textHighlights.filter((x) => x !== h))}>削除</button>
                      </div>
                    ))}
                    <div className="settings-row" style={{ marginTop: 4 }}>
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
                <div className="settings-row" style={{ gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                  <input
                    type="text"
                    placeholder="名前を入力..."
                    style={{ flex: 1, minWidth: 100 }}
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
                <div className="settings-row" style={{ gap: 3, flexWrap: "wrap", marginBottom: 8 }}>
                  {HIGHLIGHT_COLORS.map((c) => (
                    <div key={c.color} title={c.name}
                      style={{ width: 18, height: 18, background: c.color, border: hlNameColor === c.color ? "2px solid var(--fg)" : "1px solid #888", borderRadius: 2, cursor: "pointer", flexShrink: 0 }}
                      onClick={() => setHlNameColor(c.color)}
                    />
                  ))}
                </div>
                <div data-search-exclude="1">
                {textHighlights.filter((h) => h.type === "name").length === 0 ? (
                  <div style={{ color: "var(--sub)", fontSize: "0.85em" }}>登録なし</div>
                ) : (
                  <>
                    {textHighlights.filter((h) => h.type === "name" && settingsListMatch(h.pattern)).map((h, i) => (
                      <div key={i} className="settings-row" style={{ gap: 6 }}>
                        <span style={{ width: 16, height: 16, display: "inline-block", background: h.color, border: "1px solid #888", borderRadius: 2, flexShrink: 0 }} />
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={h.pattern}>{h.pattern}</span>
                        <button style={{ padding: "1px 6px" }} onClick={() => persistTextHighlights(textHighlights.filter((x) => x !== h))}>削除</button>
                      </div>
                    ))}
                    <div className="settings-row" style={{ marginTop: 4 }}>
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
                <div className="settings-row" style={{ gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                  <input
                    type="text"
                    placeholder="IDを入力..."
                    style={{ flex: 1, minWidth: 100, fontFamily: "monospace" }}
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
                <div className="settings-row" style={{ gap: 3, flexWrap: "wrap", marginBottom: 8 }}>
                  {HIGHLIGHT_COLORS.map((c) => (
                    <div key={c.color} title={c.name}
                      style={{ width: 18, height: 18, background: c.color, border: hlIdColor === c.color ? "2px solid var(--fg)" : "1px solid #888", borderRadius: 2, cursor: "pointer", flexShrink: 0 }}
                      onClick={() => setHlIdColor(c.color)}
                    />
                  ))}
                </div>
                <div data-search-exclude="1">
                {Object.keys(idHighlights).length === 0 ? (
                  <div style={{ color: "var(--sub)", fontSize: "0.85em" }}>登録なし</div>
                ) : (
                  <>
                    {Object.entries(idHighlights).filter(([id]) => settingsListMatch(id)).map(([id, color]) => (
                      <div key={id} className="settings-row" style={{ gap: 6 }}>
                        <span style={{ width: 16, height: 16, display: "inline-block", background: color, border: "1px solid #888", borderRadius: 2, flexShrink: 0 }} />
                        <span style={{ flex: 1, fontFamily: "monospace" }}>ID:{id}</span>
                        <button style={{ padding: "1px 6px" }} onClick={() => { const next = { ...idHighlights }; delete next[id]; persistIdHighlights(next); }}>削除</button>
                      </div>
                    ))}
                    <div className="settings-row" style={{ marginTop: 4 }}>
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
              <section className="settings-section" data-section="words">
                {settingsSectionHeading("ng", "words")}
              <fieldset>
                <legend>NG ワード ({ngFilters["words"].length}件)</legend>
                {ngAddForm}
                {settingsListFilterRow()}
                <div data-search-exclude="1">
                {ngFilters["words"].length === 0 ? (
                  <span className="ng-empty">(なし)</span>
                ) : (
                  <ul className="ng-list">
                    {ngFilters["words"].filter((entry) => settingsListMatch(ngVal(entry))).map((entry) => {
                      const v = ngVal(entry); const mode = ngEntryMode(entry); const scope = ngEntryScope(entry);
                      const isRegex = v.startsWith("/") && v.endsWith("/") && v.length > 2;
                      return (
                        <li key={v}>
                          <span className={`ng-mode-label ${mode === "hide-images" ? "ng-mode-img" : "ng-mode-hide"}`}>{mode === "hide-images" ? "画像" : "非表示"}</span>
                          {scope !== "global" && <span className="ng-mode-label" style={{ background: scope === "board" ? "#2a7a2a" : "#2a5a9a", color: "#fff" }}>{scope === "board" ? "板" : "スレ"}</span>}
                          {isRegex && <span className="ng-mode-label" style={{ background: "#6b4c9a", color: "#fff" }}>正規表現</span>}
                          <span>{v}</span>
                          <button className="ng-remove" onClick={() => removeNgEntry("words", v)}>×</button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                </div>
              </fieldset>
              </section>
              <section className="settings-section" data-section="ids">
                {settingsSectionHeading("ng", "ids")}
              <fieldset>
                <legend>NG ID ({ngFilters["ids"].length}件)</legend>
                {ngAddForm}
                {settingsListFilterRow()}
                <div data-search-exclude="1">
                {ngFilters["ids"].length === 0 ? (
                  <span className="ng-empty">(なし)</span>
                ) : (
                  <ul className="ng-list">
                    {ngFilters["ids"].filter((entry) => settingsListMatch(ngVal(entry))).map((entry) => {
                      const v = ngVal(entry); const mode = ngEntryMode(entry); const scope = ngEntryScope(entry);
                      const isRegex = v.startsWith("/") && v.endsWith("/") && v.length > 2;
                      return (
                        <li key={v}>
                          <span className={`ng-mode-label ${mode === "hide-images" ? "ng-mode-img" : "ng-mode-hide"}`}>{mode === "hide-images" ? "画像" : "非表示"}</span>
                          {scope !== "global" && <span className="ng-mode-label" style={{ background: scope === "board" ? "#2a7a2a" : "#2a5a9a", color: "#fff" }}>{scope === "board" ? "板" : "スレ"}</span>}
                          {isRegex && <span className="ng-mode-label" style={{ background: "#6b4c9a", color: "#fff" }}>正規表現</span>}
                          <span>{v}</span>
                          <button className="ng-remove" onClick={() => removeNgEntry("ids", v)}>×</button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                </div>
              </fieldset>
              </section>
              <section className="settings-section" data-section="names">
                {settingsSectionHeading("ng", "names")}
              <fieldset>
                <legend>NG 名前 ({ngFilters["names"].length}件)</legend>
                {ngAddForm}
                {settingsListFilterRow()}
                <div data-search-exclude="1">
                {ngFilters["names"].length === 0 ? (
                  <span className="ng-empty">(なし)</span>
                ) : (
                  <ul className="ng-list">
                    {ngFilters["names"].filter((entry) => settingsListMatch(ngVal(entry))).map((entry) => {
                      const v = ngVal(entry); const mode = ngEntryMode(entry); const scope = ngEntryScope(entry);
                      const isRegex = v.startsWith("/") && v.endsWith("/") && v.length > 2;
                      return (
                        <li key={v}>
                          <span className={`ng-mode-label ${mode === "hide-images" ? "ng-mode-img" : "ng-mode-hide"}`}>{mode === "hide-images" ? "画像" : "非表示"}</span>
                          {scope !== "global" && <span className="ng-mode-label" style={{ background: scope === "board" ? "#2a7a2a" : "#2a5a9a", color: "#fff" }}>{scope === "board" ? "板" : "スレ"}</span>}
                          {isRegex && <span className="ng-mode-label" style={{ background: "#6b4c9a", color: "#fff" }}>正規表現</span>}
                          <span>{v}</span>
                          <button className="ng-remove" onClick={() => removeNgEntry("names", v)}>×</button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                </div>
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
                  <input type="text" value={presetNameInput} onChange={(e) => setPresetNameInput(e.target.value)} list="settings-preset-names" placeholder="プリセット名" style={{ width: 220 }} maxLength={64} />
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
                <div className="settings-row"><span>バージョン</span><span>{currentVersion}</span></div>
                <div className="settings-row">
                  <span>GitHub</span>
                  <button onClick={() => { const url = "https://github.com/kaedekiku/LiveFakeTauri2"; if (isTauriRuntime()) void invoke("open_external_url", { url }).catch(() => window.open(url, "_blank")); else window.open(url, "_blank"); }}>GitHubページを開く</button>
                </div>
              </fieldset>
              </section>
              </div>
              )}
              </div>
            </div>
          </div>
        </div>
      )}
      {showExternalBoardDialog && (
        <div className="lightbox-overlay" onClick={() => setShowExternalBoardDialog(false)}>
          <div className="settings-panel" onClick={(e) => e.stopPropagation()} style={{ width: 360, padding: 16 }}>
            <header className="settings-header">
              <strong>外部板を追加</strong>
              <button onClick={() => setShowExternalBoardDialog(false)}>閉じる</button>
            </header>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              <label>板URL
                <input type="text" value={externalBoardUrl} onChange={(e) => setExternalBoardUrl(e.target.value)} placeholder="https://jbbs.shitaraba.net/internet/12345/" style={{ width: "100%", marginTop: 2 }} />
              </label>
              <label>板名
                <input type="text" value={externalBoardName} onChange={(e) => setExternalBoardName(e.target.value)} placeholder="したらば実況板" style={{ width: "100%", marginTop: 2 }} />
              </label>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
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
            <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: 8, flex: 1, overflow: "hidden" }}>
              <label>
                スレタイ
                <input
                  value={newThreadSubject}
                  onChange={(e) => setNewThreadSubject(e.target.value)}
                  list="input-history-newThreadSubject"
                  placeholder="スレッドタイトル"
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <label style={{ flex: 1 }}>
                  名前
                  <input
                    value={newThreadName}
                    onChange={(e) => setNewThreadName(e.target.value)}
                    list="name-history-list-newthread"
                    style={{ width: "100%", boxSizing: "border-box" }}
                  />
                  <datalist id="name-history-list-newthread">
                    {nameHistory.map((n) => <option key={n} value={n} />)}
                  </datalist>
                </label>
                <label style={{ flex: 1 }}>
                  メール
                  <input
                    value={newThreadMail}
                    onChange={(e) => setNewThreadMail(e.target.value)}
                    list="input-history-newThreadMail"
                    style={{ width: "100%", boxSizing: "border-box" }}
                  />
                  {inputHistoryDatalist("newThreadSubject")}
                  {inputHistoryDatalist("newThreadMail")}
                </label>
              </div>
              <label style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                本文
                <textarea
                  value={newThreadBody}
                  onChange={(e) => setNewThreadBody(e.target.value)}
                  placeholder="本文を入力"
                  style={{ width: "100%", boxSizing: "border-box", flex: 1, minHeight: 100 }}
                />
              </label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={submitNewThread} disabled={newThreadSubmitting}>
                  {newThreadSubmitting ? "送信中..." : "スレ立て"}
                </button>
                <span style={{ fontSize: "0.85em", color: "var(--sub)" }}>
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
                <p style={{ padding: "8px", color: "var(--sub)" }}>まだ書き込みがありません</p>
              ) : (
                postHistory.map((h, i) => (
                  <div key={i} className={`post-history-item ${h.ok ? "post-ok" : "post-ng"}`}>
                    <span className="post-history-time">{h.time}</span>
                    <span className={`post-history-status ${h.ok ? "" : "post-ng-status"}`}>{h.ok ? "OK" : "NG"}</span>
                    <span className="post-history-body">{h.body}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      <div
        ref={hoverPreviewRef}
        className="hover-preview"
        style={{ display: "none" }}
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
          style={{ width: "auto", transformOrigin: "left top", transform: "scale(1)" }}
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
