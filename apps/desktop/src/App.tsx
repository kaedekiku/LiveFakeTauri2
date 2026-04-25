import {
  Fragment,
  useEffect,

  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type UIEventHandler,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ClipboardList, RefreshCw, Pencil, FilePenLine, Save,
  Star, X, ChevronLeft, ChevronRight, ChevronDown, Ban,
  Image, Film, ExternalLink, Upload, History, Copy, Trash2,
  Subtitles, Volume2, ChevronUp, Search,
} from "lucide-react";

type MenuInfo = { topLevelKeys: number; normalizedSample: string };
type PostCookieReport = { targetUrl: string; cookieNames: string[] };
type PostFormTokens = {
  threadUrl: string;
  postUrl: string;
  bbs: string;
  key: string;
  time: string;
  oekakiThread1: string | null;
  hasMessageTextarea: boolean;
};
type PostConfirmResult = {
  postUrl: string;
  status: number;
  contentType: string | null;
  containsConfirm: boolean;
  containsError: boolean;
  bodyPreview: string;
};
type PostFinalizePreview = { actionUrl: string; fieldNames: string[]; fieldCount: number };
type PostSubmitResult = {
  actionUrl: string;
  status: number;
  contentType: string | null;
  containsError: boolean;
  bodyPreview: string;
};
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
type PostFlowTrace = {
  threadUrl: string;
  allowRealSubmit: boolean;
  tokenSummary: string | null;
  confirmSummary: string | null;
  finalizeSummary: string | null;
  submitSummary: string | null;
  blocked: boolean;
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
const BOARD_CACHE_KEY = "desktop.boardCategories.v1";
const LANDING_PAGE_URL = "";
const GITHUB_RELEASE_URL = "https://github.com/kaedekiku/LiveFakeTauri2";
const BOARD_TREE_SCROLL_KEY = "desktop.boardTreeScrollTop.v1";
const NEW_THREAD_SIZE_KEY = "desktop.newThreadDialogSize.v1";
const MAX_SEARCH_HISTORY = 20;
const MENU_EDGE_PADDING = 8;

// --- File-based persistence helpers (localStorage fallback) ---
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
  | { mode: "new-arrival-resize"; startY: number; startHeight: number };

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

const isTextLikeInput = (el: HTMLInputElement | HTMLTextAreaElement): boolean => {
  if (el instanceof HTMLTextAreaElement) return true;
  const t = (el.type || "text").toLowerCase();
  return t === "text" || t === "search" || t === "url" || t === "email" || t === "tel" || t === "password";
};

const getCaretClientPoint = (el: HTMLInputElement | HTMLTextAreaElement): { x: number; y: number } | null => {
  if (!isTextLikeInput(el)) return null;
  const selectionStart = el.selectionStart;
  if (selectionStart == null) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const style = window.getComputedStyle(el);
  const mirror = document.createElement("div");
  mirror.style.position = "fixed";
  mirror.style.left = `${rect.left}px`;
  mirror.style.top = `${rect.top}px`;
  mirror.style.width = `${rect.width}px`;
  mirror.style.height = `${rect.height}px`;
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.whiteSpace = el instanceof HTMLTextAreaElement ? "pre-wrap" : "pre";
  mirror.style.overflow = "hidden";
  mirror.style.boxSizing = style.boxSizing;
  mirror.style.fontFamily = style.fontFamily;
  mirror.style.fontSize = style.fontSize;
  mirror.style.fontWeight = style.fontWeight;
  mirror.style.fontStyle = style.fontStyle;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.textTransform = style.textTransform;
  mirror.style.textAlign = style.textAlign as "left" | "right" | "center" | "justify";
  mirror.style.textIndent = style.textIndent;
  mirror.style.padding = style.padding;
  mirror.style.border = style.border;
  mirror.style.tabSize = style.tabSize;

  const before = el.value.slice(0, selectionStart);
  mirror.textContent = before;
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  mirror.scrollTop = el.scrollTop;
  mirror.scrollLeft = el.scrollLeft;
  const markerRect = marker.getBoundingClientRect();
  mirror.remove();
  return {
    x: clamp(markerRect.left, rect.left + 4, rect.right - 4),
    y: clamp(markerRect.top, rect.top + 4, rect.bottom - 4),
  };
};

const emitTypingConfetti = (x: number, y: number, count = 3) => {
  for (let i = 0; i < count; i += 1) {
    const piece = document.createElement("span");
    piece.className = "typing-confetti-piece";
    const tx = (Math.random() - 0.5) * 42;
    const ty = -(18 + Math.random() * 30);
    const rot = `${Math.round((Math.random() - 0.5) * 240)}deg`;
    const hue = String(Math.floor(360 * Math.random()));
    const dur = `${420 + Math.floor(Math.random() * 220)}ms`;
    piece.style.setProperty("--x", `${x}px`);
    piece.style.setProperty("--y", `${y}px`);
    piece.style.setProperty("--tx", `${tx.toFixed(1)}px`);
    piece.style.setProperty("--ty", `${ty.toFixed(1)}px`);
    piece.style.setProperty("--rot", rot);
    piece.style.setProperty("--h", hue);
    piece.style.setProperty("--dur", dur);
    document.body.appendChild(piece);
    piece.addEventListener("animationend", () => piece.remove(), { once: true });
  }
};

const emitDeleteExplosion = (x: number, y: number, count = 4) => {
  for (let i = 0; i < count; i += 1) {
    const piece = document.createElement("span");
    piece.className = "delete-explosion-piece";
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6;
    const dist = 18 + Math.random() * 28;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist;
    const dur = `${300 + Math.floor(Math.random() * 200)}ms`;
    piece.style.setProperty("--x", `${x}px`);
    piece.style.setProperty("--y", `${y}px`);
    piece.style.setProperty("--tx", `${tx.toFixed(1)}px`);
    piece.style.setProperty("--ty", `${ty.toFixed(1)}px`);
    piece.style.setProperty("--dur", dur);
    document.body.appendChild(piece);
    piece.addEventListener("animationend", () => piece.remove(), { once: true });
  }
};

// ===== Highlight System =====
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
    try {
      const re = new RegExp(rule.pattern);
      if (re.test(url)) return url.replace(re, rule.replacement);
    } catch { /* ignore bad regex */ }
  }
  return url;
};

const renderResponseBody = (html: string, opts?: { hideImages?: boolean; imageSizeLimitKb?: number; urlRules?: UrlReplaceRuleOpts[] }): { __html: string } => {
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
          collectedThumbs.push(`<span class="thumb-link" data-lightbox-src="${href}"><img class="response-thumb" src="${href}" loading="lazy" alt="" /></span>`);
        }
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
    (_match, path) => `<img class="be-icon" src="https://${(path as string).replace("img.5ch.net", "img.5ch.io")}" loading="lazy" alt="BE" />`
  );
  if (collectedThumbs.length > 0) {
    safe += `<div class="response-thumbs-row">${collectedThumbs.join("")}</div>`;
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
const renderResponseBodyHighlighted = (html: string, query: string, opts?: { hideImages?: boolean; imageSizeLimitKb?: number; urlRules?: UrlReplaceRuleOpts[] }, wordHighlights?: Array<{ pattern: string; color: string }>): { __html: string } => {
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
  const [postCookieProbe, setPostCookieProbe] = useState("not run");
  const [threadUrl, setThreadUrl] = useState("https://mao.5ch.io/test/read.cgi/ngt/9240230711/");
  const [locationInput, setLocationInput] = useState("https://mao.5ch.io/test/read.cgi/ngt/9240230711/");
  const [postFormProbe, setPostFormProbe] = useState("not run");
  const [postConfirmProbe, setPostConfirmProbe] = useState("not run");
  const [postFinalizePreviewProbe, setPostFinalizePreviewProbe] = useState("not run");
  const [postFinalizeSubmitProbe, setPostFinalizeSubmitProbe] = useState("not run");
  const [allowRealSubmit, setAllowRealSubmit] = useState(false);
  const [metadataUrl, setMetadataUrl] = useState("https://raw.githubusercontent.com/kaedekiku/LiveFakeTauri2/main/apps/landing/public/latest.json");
  const [currentVersion, setCurrentVersion] = useState(typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0");
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [updateProbe, setUpdateProbe] = useState("not run");
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeNewThread, setComposeNewThread] = useState(false);
  const [composeSubject, setComposeSubject] = useState("");
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
  const [newThreadDialogSize, setNewThreadDialogSize] = useState<{ w: number; h: number }>(() => {
    try { const v = localStorage.getItem(NEW_THREAD_SIZE_KEY); if (v) return JSON.parse(v); } catch { /* ignore */ }
    return { w: 520, h: 420 };
  });
  const newThreadPanelRef = useRef<HTMLDivElement>(null);
  const [postHistory, setPostHistory] = useState<{ time: string; threadUrl: string; body: string; ok: boolean }[]>([]);
  const [postHistoryOpen, setPostHistoryOpen] = useState(false);
  const [myPosts, setMyPosts] = useState<Record<string, number[]>>({});
  const pendingMyPostRef = useRef<{ threadUrl: string; body: string; prevCount: number } | null>(null);
  const [postFlowTraceProbe, setPostFlowTraceProbe] = useState("not run");
  const [threadListProbe, setThreadListProbe] = useState("not run");
  const [responseListProbe, setResponseListProbe] = useState("not run");
  const [fetchedThreads, setFetchedThreads] = useState<ThreadListItem[]>([]);
  const [fetchedResponses, setFetchedResponses] = useState<ThreadResponseItem[]>([]);
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
  const [typingConfettiEnabled, setTypingConfettiEnabled] = useState(false);
  const [imageSizeLimit, setImageSizeLimit] = useState(0); // KB, 0 = unlimited
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
    selection?: string; resId?: string; resName?: string; isOnResNo?: boolean; imageUrl?: string;
  } | null>(null);
  const [hlSubMenu, setHlSubMenu] = useState<{ type: "text" | "id" | "name"; value: string; nearRight?: boolean } | null>(null);
  const [boardContextMenu, setBoardContextMenu] = useState<{ x: number; y: number; board: BoardEntry } | null>(null);
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
  const [settingsCategory, setSettingsCategory] = useState<"display" | "posting" | "tts" | "proxy" | "ng" | "subtitle" | "highlights" | "info">("display");
  const [hlWordInput, setHlWordInput] = useState("");
  const [hlWordColor, setHlWordColor] = useState<string>(HIGHLIGHT_COLORS[0].color);
  const [hlNameInput, setHlNameInput] = useState("");
  const [hlNameColor, setHlNameColor] = useState<string>(HIGHLIGHT_COLORS[0].color);
  const [hlIdInput, setHlIdInput] = useState("");
  const [hlIdColor, setHlIdColor] = useState<string>(HIGHLIGHT_COLORS[0].color);
  // Subtitle state
  const [subtitleVisible, setSubtitleVisible] = useState(false);
  const [subtitleBodyFontSize, setSubtitleBodyFontSize] = useState(28);
  const [subtitleMetaFontSize, setSubtitleMetaFontSize] = useState(12);
  const [subtitleOpacity, setSubtitleOpacity] = useState(0.85);
  const [subtitleAlwaysOnTop, setSubtitleAlwaysOnTop] = useState(true);
  // TTS state
  type TtsMode = "off" | "sapi" | "bouyomi" | "voicevox";
  const [ttsMode, setTtsMode] = useState<TtsMode>("off");
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [ttsMaxReadLength, setTtsMaxReadLength] = useState(0);
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
  type PaneName = "boards" | "threads" | "responses";
  const [focusedPane, setFocusedPane] = useState<PaneName>("responses");
  const [fontFamily, setFontFamily] = useState("");
  const [darkMode, setDarkMode] = useState(false);
  const [composeFontSize, setComposeFontSize] = useState(13);
  const [idPopup, setIdPopup] = useState<{ right: number; y: number; anchorTop: number; id: string } | null>(null);
  const idPopupCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [idMenu, setIdMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [beMenu, setBeMenu] = useState<{ x: number; y: number; beNumber: string } | null>(null);
  const anchorPopupCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [backRefPopup, setBackRefPopup] = useState<{ x: number; y: number; anchorTop: number; responseIds: number[] } | null>(null);
  const [watchoiMenu, setWatchoiMenu] = useState<{ x: number; y: number; watchoi: string } | null>(null);
  const [composePos, setComposePos] = useState<{ x: number; y: number } | null>(null);
  const composeDragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const [boardPanePx, setBoardPanePx] = useState(DEFAULT_BOARD_PANE_PX);
  const [threadPanePx, setThreadPanePx] = useState(DEFAULT_THREAD_PANE_PX);
  const [responseTopRatio, setResponseTopRatio] = useState(DEFAULT_RESPONSE_TOP_RATIO);
  const resizeDragRef = useRef<ResizeDragState | null>(null);
  const [threadColWidths, setThreadColWidths] = useState<Record<string, number>>({ ...DEFAULT_COL_WIDTHS });
  const layoutPrefsLoadedRef = useRef(false);
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
  const [lastFetchTime, setLastFetchTime] = useState<string | null>(null);
  const [newResponseStart, setNewResponseStart] = useState<number | null>(null);
  const [newArrivalPaneOpen, setNewArrivalPaneOpen] = useState(true);
  const [newArrivalPaneHeight, setNewArrivalPaneHeight] = useState(DEFAULT_NEW_ARRIVAL_PX);
  const [newArrivalFontSize, setNewArrivalFontSize] = useState(13);
  const newArrivalScrollRef = useRef<HTMLDivElement | null>(null);
  type ArrivalItem = { threadTitle: string; responseNo: number; name: string; id: string; time: string; text: string; threadUrl: string };
  const arrivalQueueRef = useRef<ArrivalItem[]>([]);
  const [currentArrivalItem, setCurrentArrivalItem] = useState<ArrivalItem | null>(null);
  const currentArrivalItemRef = useRef<ArrivalItem | null>(null);
  const arrivalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newArrivalBodyRef = useRef<HTMLDivElement | null>(null);
  const [arrivalQueueCount, setArrivalQueueCount] = useState(0);
  const threadFetchTimesRef = useRef<Record<string, string>>({});
  const pendingAutoScrollRef = useRef(false);
  const [responseSearchQuery, setResponseSearchQuery] = useState("");
  const [responseSearchBarVisible, setResponseSearchBarVisible] = useState(false);
  const [responseLinkFilter, setResponseLinkFilter] = useState<"" | "image" | "video" | "link">("");
  const threadSearchRef = useRef<HTMLInputElement | null>(null);
  const responseSearchRef = useRef<HTMLInputElement | null>(null);
  const [threadSearchHistory, setThreadSearchHistory] = useState<string[]>([]);
  const [responseSearchHistory, setResponseSearchHistory] = useState<string[]>([]);
  const lastTypingConfettiTsRef = useRef(0);
  const [searchHistoryDropdown, setSearchHistoryDropdown] = useState<{ type: "thread" | "response" } | null>(null);
  const [searchHistoryMenu, setSearchHistoryMenu] = useState<{ x: number; y: number; type: "thread" | "response"; word: string } | null>(null);
  // Image upload state
  const [uploadPanelOpen, setUploadPanelOpen] = useState(false);
  const [uploadPanelTab, setUploadPanelTab] = useState<"upload" | "history">("upload");
  const [uploadingFiles, setUploadingFiles] = useState<string[]>([]);
  const [uploadResults, setUploadResults] = useState<{ fileName: string; sourceUrl?: string; thumbnail?: string; error?: string }[]>([]);
  const [uploadHistory, setUploadHistory] = useState<{ sourceUrl: string; thumbnail: string; pageUrl: string; fileName: string; uploadedAt: string }[]>([]);
  const uploadFileRef = useRef<HTMLInputElement | null>(null);

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
            gate.innerHTML = `<img class="response-thumb" src="${src}" loading="lazy" alt="" />`;
          }
        }).catch(() => {
          if (!gate.dataset.gateSrc) return;
          delete gate.dataset.gateSrc;
          gate.innerHTML = `<img class="response-thumb" src="${src}" loading="lazy" alt="" />`;
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
      try { localStorage.setItem(BOARD_CACHE_KEY, JSON.stringify(cats)); } catch { /* ignore */ }
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

  const ngMatch = (pattern: string, target: string): boolean => {
    if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
      try {
        return new RegExp(pattern.slice(1, -1), "i").test(target);
      } catch {
        return false;
      }
    }
    return target.toLowerCase().includes(pattern.toLowerCase());
  };

  const getNgResult = (resp: { name: string; time: string; text: string }): null | "hide" | "hide-images" => {
    if (ngFilters.words.length === 0 && ngFilters.ids.length === 0 && ngFilters.names.length === 0) return null;
    const curThread = threadUrl.trim();
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

  const scrollToBottom = () => {
    const tryScroll = (attempts: number) => {
      const c = responseScrollRef.current;
      if (!c) return;
      c.scrollTop = c.scrollHeight;
      if (c.scrollHeight - c.scrollTop - c.clientHeight > 8 && attempts < 10) {
        requestAnimationFrame(() => tryScroll(attempts + 1));
      }
    };
    requestAnimationFrame(() => tryScroll(0));
  };

  const scrollToResponseNo = (no: number) => {
    if (no <= 1) return;
    let attempts = 0;
    const tryScroll = () => {
      const el = responseScrollRef.current?.querySelector(`[data-response-no="${no}"]`);
      if (el) {
        el.scrollIntoView({ block: "start", behavior: smoothScrollRef.current ? "smooth" : "instant" });
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
        if (cached) {
          cached.selectedResponse = selectedResponse;
          cached.scrollAtBottom = isScrollAtBottom();
          cached.scrollResponseNo = getVisibleResponseNo();
          cached.newResponseStart = newResponseStart;
          saveScrollPos(curUrl);
        }
        saveBookmark(curUrl, selectedResponse);
      }
      setActiveTabIndex(existingIndex);
      const cached = tabCacheRef.current.get(url);
      if (cached && cached.responses.length > 0) {
        setFetchedResponses(cached.responses);
        const bm = loadBookmark(url);
        setSelectedResponse(bm ?? cached.selectedResponse);
        setNewResponseStart(cached.newResponseStart ?? null);
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
                setSelectedResponse(restoreNo);
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
      if (cached) {
        cached.selectedResponse = selectedResponse;
        cached.scrollAtBottom = isScrollAtBottom();
        cached.scrollResponseNo = getVisibleResponseNo();
        cached.newResponseStart = newResponseStart;
        saveScrollPos(curUrl);
      }
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
      setSelectedResponse(cached.selectedResponse);
      if (cached.scrollAtBottom) scrollToBottom();
      else scrollToResponseNo(cached.scrollResponseNo ?? 0);
    }
    setThreadUrl(tab.threadUrl);
    setLocationInput(tab.threadUrl);
  };

  const onTabClick = (index: number) => {
    setActivePaneView("responses");
    if (index === activeTabIndex) return;
    if (activeTabIndex >= 0 && activeTabIndex < threadTabs.length) {
      const curUrl = threadTabs[activeTabIndex].threadUrl;
      const cached = tabCacheRef.current.get(curUrl);
      if (cached) {
        cached.selectedResponse = selectedResponse;
        cached.scrollAtBottom = isScrollAtBottom();
        cached.scrollResponseNo = getVisibleResponseNo();
        saveScrollPos(curUrl);
      }
    }
    setActiveTabIndex(index);
    const tab = threadTabs[index];
    setLastFetchTime(threadFetchTimesRef.current[tab.threadUrl] ?? null);
    const cached = tabCacheRef.current.get(tab.threadUrl);
    if (cached) {
      setFetchedResponses(cached.responses);
      setSelectedResponse(cached.selectedResponse);
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


  const probePostCookieScope = async () => {
    setPostCookieProbe("running...");
    try {
      const r = await invoke<PostCookieReport>("probe_post_cookie_scope_simulation");
      setPostCookieProbe(`${r.targetUrl} -> ${r.cookieNames.join(",") || "(none)"}`);
    } catch (error) {
      setPostCookieProbe(`error: ${String(error)}`);
    }
  };

  const probeThreadPostForm = async () => {
    setPostFormProbe("running...");
    try {
      const r = await invoke<PostFormTokens>("probe_thread_post_form", { threadUrl });
      setPostFormProbe(
        `postUrl=${r.postUrl} bbs=${r.bbs} key=${r.key} time=${r.time} oekaki=${r.oekakiThread1 ?? "-"} MESSAGE=${
          r.hasMessageTextarea
        }`
      );
    } catch (error) {
      setPostFormProbe(`error: ${String(error)}`);
    }
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
      // Differential fetch: pass last known response_no so backend returns only new responses
      const lastResNo = prevCount > 0 ? prevResponses[prevCount - 1].responseNo : undefined;
      const result = await invoke<{ responses: ThreadResponseItem[]; title: string | null }>(
        "fetch_thread_responses_command",
        { threadUrl: tabUrl, limit: null, sinceResNo: lastResNo ?? null }
      );
      const newRows = result.responses;
      if (newRows.length === 0 && prevCount > 0) return; // no new responses
      // Merge: full list = previous cached + new rows
      const rows = lastResNo != null ? [...prevResponses, ...newRows] : newRows;
      if (rows.length === 0) return;
      tabCacheRef.current.set(tabUrl, { responses: rows, selectedResponse: cached?.selectedResponse ?? 1, scrollResponseNo: cached?.scrollResponseNo, newResponseStart: cached?.newResponseStart });
      if (prevCount > 0 && newRows.length > 0) {
        const now = new Date();
        const timeStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
        threadFetchTimesRef.current[tabUrl] = timeStr;
        const arrivals = newRows.map((r) => {
          const idMatch = r.dateAndId.match(/ID:([^\s]+)/);
          const timeMatch = r.dateAndId.match(/^[\d/]+\s+[\d:]+/);
          return {
            threadTitle: tabTitle,
            responseNo: r.responseNo,
            name: r.name,
            id: idMatch ? idMatch[1] : "",
            time: timeMatch ? timeMatch[0] : r.dateAndId.slice(0, 20),
            text: r.body.replace(/<[^>]*>/g, "").slice(0, 200),
            threadUrl: tabUrl,
          };
        });
        if (autoRefreshEnabled) {
          const queueWasEmpty = arrivalQueueRef.current.length === 0;
          arrivalQueueRef.current.push(...arrivals);
          setArrivalQueueCount(arrivalQueueRef.current.length);
          if (!arrivalTimerRef.current && (currentArrivalItemRef.current === null || queueWasEmpty)) {
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
            ttsSpeak(a.text, prefix);
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
        setSelectedResponse(bm ?? (rows.length > 0 ? rows[0].responseNo : 1));
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
        const arrivals = newRows.map((r) => {
          const idMatch = r.dateAndId.match(/ID:([^\s]+)/);
          const timeMatch = r.dateAndId.match(/^[\d/]+\s+[\d:]+/);
          return {
            threadTitle: arrivalTitle,
            responseNo: r.responseNo,
            name: r.name,
            id: idMatch ? idMatch[1] : "",
            time: timeMatch ? timeMatch[0] : r.dateAndId.slice(0, 20),
            text: r.body.replace(/<[^>]*>/g, "").slice(0, 200),
            threadUrl: url,
          };
        });
        // Add to new arrivals pane when autoReload is ON
        if (autoRefreshEnabled) {
          const queueWasEmpty = arrivalQueueRef.current.length === 0;
          arrivalQueueRef.current.push(...arrivals);
          setArrivalQueueCount(arrivalQueueRef.current.length);
          if (!arrivalTimerRef.current && (currentArrivalItemRef.current === null || queueWasEmpty)) {
            advanceToNextArrival();
          }
        }
        // Update subtitle with latest new response
        if (arrivals.length > 0) {
          const latest = arrivals[arrivals.length - 1];
          subtitleUpdate({ threadTitle: latest.threadTitle, responseNo: latest.responseNo, name: latest.name, id: latest.id, date: latest.time, body: latest.text });
        }
        // TTS: read new responses (skip 1001/1002)
        if (ttsEnabled && ttsMode !== "off") {
          const site = detectSiteType(url);
          for (const a of arrivals) {
            if (a.responseNo >= 1001) continue;
            const prefix = site === "shitaraba" ? `したらば${a.responseNo}番さん`
              : site === "jpnkn" ? `ジャパンくん${a.responseNo}番さん`
              : `レス${a.responseNo}番さん`;
            ttsSpeak(a.text, prefix);
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

  const probePostConfirmEmpty = async () => {
    setPostConfirmProbe("running...");
    try {
      const r = await invoke<PostConfirmResult>("probe_post_confirm_empty", { threadUrl });
      setPostConfirmProbe(
        `status=${r.status} type=${r.contentType ?? "-"} confirm=${r.containsConfirm} error=${r.containsError} preview=${r.bodyPreview}`
      );
    } catch (error) {
      setPostConfirmProbe(`error: ${String(error)}`);
    }
  };

  const probePostConfirmFromCompose = async () => {
    setPostConfirmProbe("running...");
    try {
      const r = await invoke<PostConfirmResult>("probe_post_confirm", {
        threadUrl,
        from: composeName || null,
        mail: composeMailValue || null,
        message: composeBody || null,
      });
      setPostConfirmProbe(
        `status=${r.status} type=${r.contentType ?? "-"} confirm=${r.containsConfirm} error=${r.containsError} preview=${r.bodyPreview}`
      );
    } catch (error) {
      setPostConfirmProbe(`error: ${String(error)}`);
    }
  };

  const probePostFinalizePreview = async () => {
    setPostFinalizePreviewProbe("running...");
    try {
      const r = await invoke<PostFinalizePreview>("probe_post_finalize_preview", { threadUrl });
      setPostFinalizePreviewProbe(`action=${r.actionUrl} fields=${r.fieldCount} names=${r.fieldNames.join(",")}`);
    } catch (error) {
      setPostFinalizePreviewProbe(`error: ${String(error)}`);
    }
  };

  const probePostFinalizePreviewFromCompose = async () => {
    setPostFinalizePreviewProbe("running...");
    try {
      const r = await invoke<PostFinalizePreview>("probe_post_finalize_preview_from_input", {
        threadUrl,
        from: composeName || null,
        mail: composeMailValue || null,
        message: composeBody || null,
      });
      setPostFinalizePreviewProbe(`action=${r.actionUrl} fields=${r.fieldCount} names=${r.fieldNames.join(",")}`);
    } catch (error) {
      setPostFinalizePreviewProbe(`error: ${String(error)}`);
    }
  };

  const probePostFinalizeSubmitEmpty = async () => {
    setPostFinalizeSubmitProbe("running...");
    try {
      const r = await invoke<PostSubmitResult>("probe_post_finalize_submit_empty", {
        threadUrl,
        allowRealSubmit,
      });
      setPostFinalizeSubmitProbe(
        `status=${r.status} type=${r.contentType ?? "-"} error=${r.containsError} preview=${r.bodyPreview}`
      );
    } catch (error) {
      setPostFinalizeSubmitProbe(`error: ${String(error)}`);
    }
  };

  const handleCreateThread = async () => {
    if (!composeSubject.trim()) { setComposeResult({ ok: false, message: "スレッドタイトルを入力してください" }); return; }
    if (!composeBody.trim()) { setComposeResult({ ok: false, message: "本文を入力してください" }); return; }
    const boardUrl = getBoardUrlFromThreadUrl(threadUrl.trim()) || threadUrl.trim();
    if (!boardUrl) { setComposeResult({ ok: false, message: "板URLが特定できません" }); return; }
    setComposeResult(null);
    try {
      const r = await invoke<{ status: number; containsError: boolean; bodyPreview: string; threadUrl: string | null }>("create_thread_command", {
        boardUrl,
        subject: composeSubject,
        from: composeName || null,
        mail: composeMailValue || null,
        message: composeBody,
      });
      const ok = !r.containsError;
      setComposeResult({ ok, message: ok ? `スレッド作成成功 (${r.threadUrl ?? ""})` : `スレッド作成失敗: ${r.bodyPreview}` });
      if (ok && r.threadUrl) {
        openThreadInTab(r.threadUrl, composeSubject);
        void fetchResponsesFromCurrent(r.threadUrl);
        void refreshThreadListSilently();
        setComposeNewThread(false);
        setComposeSubject("");
        setComposeBody("");
      }
    } catch (error) {
      setComposeResult({ ok: false, message: `Error: ${String(error)}` });
    }
  };

  const probePostFinalizeSubmitFromCompose = async () => {
    setPostFinalizeSubmitProbe("running...");
    setComposeResult(null);
    try {
      const r = await invoke<PostSubmitResult>("probe_post_finalize_submit_from_input", {
        threadUrl,
        from: composeName || null,
        mail: composeMailValue || null,
        message: composeBody || null,
        allowRealSubmit,
      });
      setPostFinalizeSubmitProbe(
        `status=${r.status} type=${r.contentType ?? "-"} error=${r.containsError} preview=${r.bodyPreview}`
      );
      const ok = !r.containsError;
      const msg = ok ? `Post submitted (status ${r.status})` : `Post failed: ${r.bodyPreview}`;
      setComposeResult({ ok, message: msg });
      setPostHistory((prev) => [{ time: new Date().toLocaleTimeString(), threadUrl, body: composeBody.slice(0, 100), ok }, ...prev].slice(0, 50));
      if (ok) {
        const prevCount = tabCacheRef.current.get(threadUrl.trim())?.responses.length ?? 0;
        pendingMyPostRef.current = { threadUrl: threadUrl.trim(), body: composeBody, prevCount };
        void fetchResponsesFromCurrent();
        void refreshThreadListSilently();
      }
    } catch (error) {
      setPostFinalizeSubmitProbe(`error: ${String(error)}`);
      setComposeResult({ ok: false, message: `Error: ${String(error)}` });
      setPostHistory((prev) => [{ time: new Date().toLocaleTimeString(), threadUrl, body: composeBody.slice(0, 100), ok: false }, ...prev].slice(0, 50));
    }
  };

  const handleUploadFiles = async (files: FileList) => {
    if (!isTauriRuntime()) return;
    const fileArray = Array.from(files).slice(0, 4);
    if (fileArray.length === 0) return;
    setUploadResults([]);
    setUploadingFiles(fileArray.map((f) => f.name));
    const results: { fileName: string; sourceUrl?: string; thumbnail?: string; error?: string }[] = [];
    const newHistoryEntries: typeof uploadHistory = [];
    for (const file of fileArray) {
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const fileData = btoa(binary);
        const r = await invoke<{ success: boolean; sourceUrl: string; thumbnail: string; pageUrl: string }>("upload_image", { fileData, fileName: file.name });
        results.push({ fileName: file.name, sourceUrl: r.sourceUrl, thumbnail: r.thumbnail });
        newHistoryEntries.push({
          sourceUrl: r.sourceUrl,
          thumbnail: r.thumbnail,
          pageUrl: r.pageUrl,
          fileName: file.name,
          uploadedAt: new Date().toISOString(),
        });
      } catch (e) {
        results.push({ fileName: file.name, error: String(e) });
      }
    }
    setUploadResults(results);
    setUploadingFiles([]);
    if (newHistoryEntries.length > 0) {
      const updated = [...newHistoryEntries, ...uploadHistory].slice(0, 100);
      setUploadHistory(updated);
      invoke("save_upload_history", { history: { entries: updated } }).catch((e) => console.warn("save upload history:", e));
    }
  };

  const insertUploadUrl = (url: string) => {
    setComposeBody((prev) => prev ? prev + "\n" + url : url);
  };

  const deleteHistoryEntry = (index: number) => {
    const updated = uploadHistory.filter((_, i) => i !== index);
    setUploadHistory(updated);
    if (isTauriRuntime()) {
      invoke("save_upload_history", { history: { entries: updated } }).catch((e) => console.warn("save upload history:", e));
    }
  };

  const postSuccessCleanup = async (postedBody: string) => {
    setComposeBody("");
    if (composeName.trim()) {
      setNameHistory((prev) => {
        const next = [composeName.trim(), ...prev.filter((n) => n !== composeName.trim())].slice(0, 20);
        saveToFile("name-history.json", next);
        return next;
      });
    }
    setComposeOpen(false);
    setUploadPanelOpen(false);
    setUploadResults([]);
    const prevCount = tabCacheRef.current.get(threadUrl.trim())?.responses.length ?? 0;
    pendingMyPostRef.current = { threadUrl: threadUrl.trim(), body: postedBody, prevCount };
    await fetchResponsesFromCurrent(threadUrl.trim());
    void refreshThreadListSilently();
    setTimeout(() => {
      const items = tabCacheRef.current.get(threadUrl.trim())?.responses;
      if (items && items.length > 0) {
        setSelectedResponse(items[items.length - 1].responseNo);
      }
      if (responseScrollRef.current) {
        responseScrollRef.current.scrollTop = responseScrollRef.current.scrollHeight;
      }
    }, 100);
  };

  const probePostFlowTraceFromCompose = async () => {
    if (composeSubmitting) return;
    setComposeSubmitting(true);
    setPostFlowTraceProbe("running...");
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
      setPostFlowTraceProbe(result);
      setComposeResult({ ok: true, message: `Post submitted: ${result}` });
      setPostHistory((prev) => [{ time: new Date().toLocaleTimeString(), threadUrl: postTargetUrl, body: composeBody.slice(0, 100), ok: true }, ...prev].slice(0, 50));
      await postSuccessCleanup(composeBody);
    } catch (error) {
      const msg = String(error);
      setPostFlowTraceProbe(`error: ${msg}`);
      setComposeResult({ ok: false, message: `NG: ${msg}` });
      setPostHistory((prev) => [{ time: new Date().toLocaleTimeString(), threadUrl: postTargetUrl, body: composeBody.slice(0, 100), ok: false }, ...prev].slice(0, 50));
    } finally {
      setComposeSubmitting(false);
    }
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

  // TTS: enqueue text for sequential playback
  // maxReadLength applies to plain text body only (HTML tags + entities decoded); prefix is always read in full
  // URLs (http/https/ttp) are removed, except YouTube URLs which are replaced with "ユーチューブ"
  const ttsSpeak = (bodyText: string, prefix?: string, responseNo?: number) => {
    if (!isTauriRuntime() || ttsMode === "off") return;
    // Skip system messages (res 1001/1002)
    if (responseNo != null && responseNo >= 1001) return;
    // Strip HTML tags, then decode HTML entities to get true character count
    let plain = bodyText.replace(/<[^>]*>/g, "");
    plain = plain.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
    // Replace YouTube URLs with "ユーチューブ", then remove remaining URLs
    plain = plain.replace(/(?:https?|ttp):\/\/[^\s]*youtube[^\s]*/gi, "ユーチューブ");
    plain = plain.replace(/(?:https?|ttp):\/\/[^\s]+/g, "");
    plain = plain.trim();
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
  const subtitleUpdate = (data: { threadTitle?: string; name?: string; id?: string; date?: string; body?: string; responseNo?: number }) => {
    if (!isTauriRuntime() || !subtitleVisible) return;
    const bodyHtml = data.body
      ? renderResponseBodyHighlighted(data.body, "", { hideImages: true }, textHighlights.filter((h) => h.type === "word")).__html
      : undefined;
    const idColor = data.id ? (idHighlights[data.id] ?? undefined) : undefined;
    invoke("subtitle_update", { data: { ...data, bodyHtml, idColor } }).catch((e) => console.warn("subtitle_update:", e));
  };

  const advanceToNextArrival = () => {
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
      _startArrivalTimer();
    }, 200);
  };

  const _startArrivalTimer = () => {
    // After display settles, check for overflow and schedule advance
    arrivalTimerRef.current = setTimeout(() => {
      const bodyEl = newArrivalBodyRef.current;
      if (bodyEl) bodyEl.scrollTop = 0;
      const isOverflow = bodyEl ? bodyEl.scrollHeight > bodyEl.clientHeight + 2 : false;
      if (isOverflow) {
        // 2sec then slow scroll to bottom
        arrivalTimerRef.current = setTimeout(() => {
          const el = newArrivalBodyRef.current;
          if (el) {
            const dist = el.scrollHeight - el.clientHeight;
            const duration = Math.max(1000, dist * 8); // ~8ms per px
            const start = performance.now();
            const startScrollTop = el.scrollTop;
            const step = (now: number) => {
              const progress = Math.min((now - start) / duration, 1);
              el.scrollTop = startScrollTop + dist * progress;
              if (progress < 1) {
                requestAnimationFrame(step);
              } else {
                // 5sec after reaching bottom
                arrivalTimerRef.current = setTimeout(() => advanceToNextArrival(), 5000);
              }
            };
            requestAnimationFrame(step);
          } else {
            arrivalTimerRef.current = setTimeout(() => advanceToNextArrival(), 5000);
          }
        }, 2000);
      } else {
        // No overflow: 5sec total display time
        arrivalTimerRef.current = setTimeout(() => advanceToNextArrival(), 5000);
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
          { id: 2, name: "名無しさん", mail: "", nameWithoutWatchoi: "名無しさん", time: "2026/03/07 10:02", text: "BE/UPLIFT/どんぐりログイン確認済み", beNumber: null, watchoi: null },
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
    if (responseSearchQuery) {
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

  const goFromLocationInput = () => {
    const next = rewrite5chNet(locationInput.trim());
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
    try { localStorage.setItem(BOARD_TREE_SCROLL_KEY, String(top)); } catch { /* ignore */ }
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

  useEffect(() => {
    const applyPrefs = (raw: string | null) => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as {
          boardPanePx?: number;
          threadPanePx?: number;
          responseTopRatio?: number;
          fontSize?: number;
          boardsFontSize?: number;
          threadsFontSize?: number;
          responsesFontSize?: number;
          darkMode?: boolean;
          fontFamily?: string;
          threadColWidths?: Record<string, number>;
          showBoardButtons?: boolean;
          keepSortOnRefresh?: boolean;
          composeSubmitKey?: "shift" | "ctrl";
          typingConfettiEnabled?: boolean;
          imageSizeLimit?: number;
          hoverPreviewEnabled?: boolean;
          lastBoard?: { boardName: string; url: string };
          hoverPreviewDelay?: number;
          thumbSize?: number;
          restoreSession?: boolean;
          autoRefreshInterval?: number;
          autoScrollEnabled?: boolean;
          newArrivalPaneOpen?: boolean;
          newArrivalPaneHeight?: number;
          newArrivalFontSize?: number;
        };
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
        if (typeof parsed.darkMode === "boolean") setDarkMode(parsed.darkMode);
        if (typeof parsed.fontFamily === "string") setFontFamily(parsed.fontFamily);
        if (parsed.threadColWidths && typeof parsed.threadColWidths === "object") {
          setThreadColWidths((prev) => ({ ...prev, ...parsed.threadColWidths }));
        }
        if (typeof parsed.showBoardButtons === "boolean") setShowBoardButtons(parsed.showBoardButtons);
        if (typeof parsed.keepSortOnRefresh === "boolean") setKeepSortOnRefresh(parsed.keepSortOnRefresh);
        if (parsed.composeSubmitKey === "shift" || parsed.composeSubmitKey === "ctrl") setComposeSubmitKey(parsed.composeSubmitKey);
        if (typeof parsed.typingConfettiEnabled === "boolean") setTypingConfettiEnabled(parsed.typingConfettiEnabled);
        if (typeof parsed.imageSizeLimit === "number") setImageSizeLimit(parsed.imageSizeLimit);
        if (typeof parsed.hoverPreviewEnabled === "boolean") setHoverPreviewEnabled(parsed.hoverPreviewEnabled);
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
      } catch { /* ignore */ }
    };
    // Layout prefs from file (settings.json via IPC)
    if (isTauriRuntime()) {
      invoke<string>("load_layout_prefs").then((raw) => {
        if (raw) applyPrefs(raw);
        layoutPrefsLoadedRef.current = true;
      }).catch(() => { layoutPrefsLoadedRef.current = true; });
    } else {
      layoutPrefsLoadedRef.current = true;
    }
    // Restore board categories cache
    try {
      const boardRaw = localStorage.getItem(BOARD_CACHE_KEY);
      if (boardRaw) {
        const cached = JSON.parse(boardRaw) as BoardCategory[];
        if (Array.isArray(cached) && cached.length > 0) setBoardCategories(cached);
      }
    } catch { /* ignore */ }
    try {
      const saved = localStorage.getItem(BOARD_TREE_SCROLL_KEY);
      if (saved != null) {
        const n = Number(saved);
        if (Number.isFinite(n) && n >= 0) boardTreeScrollRestoreRef.current = n;
      }
    } catch { /* ignore */ }
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
    // Migrate localStorage data from file-based storage (Portable mode)
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
      // Load upload history
      invoke<{ entries: { sourceUrl: string; thumbnail: string; pageUrl: string; fileName: string; uploadedAt: string }[] }>("load_upload_history").then((data) => {
        setUploadHistory(data.entries);
      }).catch((e) => console.warn("upload history load failed:", e));
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
      const cdrag = composeDragRef.current;
      if (cdrag) {
        setComposePos({
          x: cdrag.startPosX + (event.clientX - cdrag.startX),
          y: cdrag.startPosY + (event.clientY - cdrag.startY),
        });
        return;
      }
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
      if (composeDragRef.current) {
        composeDragRef.current = null;
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        return;
      }
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

  // Load app settings from settings.ini on startup
  useEffect(() => {
    if (!isTauriRuntime()) return;
    invoke<Record<string, string>>("load_app_settings").then((map) => {
      if (map["App.fontSize"]) { const n = parseInt(map["App.fontSize"], 10); if (!isNaN(n)) { setResponsesFontSize(n); setBoardsFontSize(n); setThreadsFontSize(n); } }
      if (map["App.responseGap"]) { const n = parseInt(map["App.responseGap"], 10); if (!isNaN(n)) setResponseGap(n); }
      if (map["App.autoReloadIntervalSec"]) { const n = parseInt(map["App.autoReloadIntervalSec"], 10); if (!isNaN(n)) setAutoRefreshInterval(n); }
      if (map["App.autoReload"]) setAutoRefreshEnabled(map["App.autoReload"] === "true");
      if (map["App.autoScroll"]) setAutoScrollEnabled(map["App.autoScroll"] === "true");
      if (map["App.smoothScroll"]) setSmoothScroll(map["App.smoothScroll"] === "true");
      if (map["App.maxOpenTabs"]) { const n = parseInt(map["App.maxOpenTabs"], 10); if (!isNaN(n) && n >= 1) setMaxOpenTabs(n); }
      if (map["App.logRetentionDays"]) { const n = parseInt(map["App.logRetentionDays"], 10); if (!isNaN(n) && n >= 0) setLogRetentionDays(n); }
      if (map["App.imageSaveFolder"]) setImageSaveFolder(map["App.imageSaveFolder"]);
      // Speech settings
      if (map["Speech.mode"]) setTtsMode(map["Speech.mode"] as TtsMode);
      if (map["Speech.enabled"]) setTtsEnabled(map["Speech.enabled"] === "true");
      if (map["Speech.maxReadLength"]) { const n = parseInt(map["Speech.maxReadLength"], 10); if (!isNaN(n) && n >= 0) setTtsMaxReadLength(n); }
      if (map["Speech.sapiVoiceIndex"]) { const n = parseInt(map["Speech.sapiVoiceIndex"], 10); if (!isNaN(n)) setSapiVoiceIndex(n); }
      if (map["Speech.sapiRate"]) { const n = parseInt(map["Speech.sapiRate"], 10); if (!isNaN(n)) setSapiRate(n); }
      if (map["Speech.sapiVolume"]) { const n = parseInt(map["Speech.sapiVolume"], 10); if (!isNaN(n)) setSapiVolume(n); }
      if (map["Speech.bouyomiPath"]) setBouyomiPath(map["Speech.bouyomiPath"]);
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
    }).catch(() => {});
  }, []);

  // Save app settings to settings.ini when relevant values change
  useEffect(() => {
    if (!isTauriRuntime()) return;
    void invoke("save_app_settings", { settings: {
      "App.fontSize": String(responsesFontSize),
      "App.responseGap": String(responseGap),
      "App.autoReloadIntervalSec": String(autoRefreshInterval),
      "App.autoReload": String(autoRefreshEnabled),
      "App.autoScroll": String(autoScrollEnabled),
      "App.smoothScroll": String(smoothScroll),
      "App.maxOpenTabs": String(maxOpenTabs),
      "App.logRetentionDays": String(logRetentionDays),
      "App.imageSaveFolder": imageSaveFolder,
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
    } }).catch(() => {});
  }, [responsesFontSize, responseGap, autoRefreshInterval, autoRefreshEnabled, autoScrollEnabled, smoothScroll, maxOpenTabs, logRetentionDays, imageSaveFolder,
      ttsMode, ttsEnabled, ttsMaxReadLength, sapiVoiceIndex, sapiRate, sapiVolume, bouyomiPath,
      voicevoxEndpoint, voicevoxSpeakerId, voicevoxSpeedScale, voicevoxPitchScale, voicevoxIntonationScale, voicevoxVolumeScale,
      composeName, composeMail, composeSage, composeFontSize]);

  useEffect(() => {
    if (!layoutPrefsLoadedRef.current) return;
    const payload = JSON.stringify({
      boardPanePx,
      threadPanePx,
      responseTopRatio,
      boardsFontSize,
      threadsFontSize,
      responsesFontSize,
      darkMode,
      fontFamily,
      threadColWidths,
      showBoardButtons,
      keepSortOnRefresh,
      composeSubmitKey,
      typingConfettiEnabled,
      imageSizeLimit,
      hoverPreviewEnabled,
      lastBoard: lastBoardUrlRef.current ? { boardName: selectedBoard, url: lastBoardUrlRef.current } : undefined,
      hoverPreviewDelay,
      thumbSize,
      restoreSession,
      autoRefreshInterval,
      autoScrollEnabled,
      newArrivalPaneOpen,
      newArrivalPaneHeight,
      newArrivalFontSize,
    });
    if (isTauriRuntime()) {
      void invoke("save_layout_prefs", { prefs: payload }).catch(() => {});
    }
  }, [boardPanePx, threadPanePx, responseTopRatio, boardsFontSize, threadsFontSize, responsesFontSize, darkMode, fontFamily, threadColWidths, showBoardButtons, keepSortOnRefresh, composeSubmitKey, typingConfettiEnabled, imageSizeLimit, hoverPreviewEnabled, selectedBoard, hoverPreviewDelay, thumbSize, restoreSession, autoRefreshInterval, autoScrollEnabled, newArrivalPaneOpen, newArrivalPaneHeight, newArrivalFontSize]);



  useEffect(() => {
    if (!typingConfettiEnabled) return;
    const onInput = (ev: Event) => {
      const target = ev.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      if (target.readOnly || target.disabled) return;
      if (!isTextLikeInput(target)) return;
      const inputEv = ev as InputEvent;
      const isDelete = inputEv.inputType && (inputEv.inputType.startsWith("delete") || inputEv.inputType === "historyUndo");
      const isInsert = inputEv.inputType && inputEv.inputType.startsWith("insert");
      if (!isDelete && !isInsert) return;
      const now = performance.now();
      if (now - lastTypingConfettiTsRef.current < 50) return;
      const point = getCaretClientPoint(target);
      if (!point) return;
      lastTypingConfettiTsRef.current = now;
      if (isDelete) {
        emitDeleteExplosion(point.x, point.y);
      } else {
        emitTypingConfetti(point.x, point.y);
      }
    };
    window.addEventListener("input", onInput, true);
    return () => window.removeEventListener("input", onInput, true);
  }, [typingConfettiEnabled]);

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

  return (
    <div
      className={`shell${darkMode ? " dark" : ""}`}
      style={{ fontFamily: fontFamily || undefined, gridTemplateRows: showBoardButtons && favorites.boards.length > 0 ? "26px 32px auto 1fr 22px" : undefined, "--thumb-size": `${thumbSize}px` } as React.CSSProperties}
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
        setSearchHistoryDropdown(null);
        setSearchHistoryMenu(null);
        setResponseReloadMenuOpen(false);
      }}
    >
      <header className="menu-bar">
        {[
          { label: "ファイル", items: [
            { text: "スレ取得", action: () => fetchThreadListFromCurrent() },
            { text: "レス取得", action: () => fetchResponsesFromCurrent() },
            { text: "sep" },
            { text: "書き込み", action: () => { setComposeOpen(true); setComposePos(null); setComposeBody(""); setComposeResult(null); } },
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
        <button onClick={() => { void fetchMenu(); void fetchBoardCategories(); }} title="板更新"><ClipboardList size={14} /></button>
        <span className="tool-sep" />
        <input className="address-input" value={locationInput} onChange={(e) => setLocationInput(e.target.value)} onKeyDown={onLocationInputKeyDown} onFocus={(e) => e.target.select()} />
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
        <section className="pane boards" onMouseDown={() => setFocusedPane("boards")} style={{ '--fs-delta': `${boardsFontSize - 12}px`, width: boardPanePx, maxWidth: `calc(100% - ${MIN_RESPONSE_PANE_PX + SPLITTER_PX}px)`, flexShrink: 0 } as React.CSSProperties}>
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
              placeholder="板を検索..."
            />
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
                placeholder="お気に入り検索"
              />
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
        </section>
        <div
          className="pane-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize boards pane"
          onMouseDown={(e) => beginHorizontalResize("board-thread", e)}
          onClick={(e) => e.stopPropagation()}
        />
        <div className="right-body">
          {/* New arrivals pane — inside right-body, above tab bar */}
          {newArrivalPaneOpen && (
            <>
              <div className="new-arrival-pane" style={{ height: newArrivalPaneHeight }}>
                <div className="new-arrival-header">
                  <span className="new-arrival-title">新着レス {arrivalQueueCount > 0 ? `(残 ${arrivalQueueCount})` : ""}</span>
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
                      onClick={() => {
                        const tab = threadTabs.find((t) => t.threadUrl === currentArrivalItem.threadUrl);
                        if (tab) {
                          onTabClick(threadTabs.indexOf(tab));
                          setSelectedResponse(currentArrivalItem.responseNo);
                        }
                      }}
                    >
                      <div className="new-arrival-meta">
                        <span className="new-arrival-thread-title">{currentArrivalItem.threadTitle}</span>
                        <span className="new-arrival-res-no">{currentArrivalItem.responseNo}</span>
                        <span className="new-arrival-name">{currentArrivalItem.name}</span>
                        {currentArrivalItem.id && <span className="new-arrival-id">ID:{currentArrivalItem.id}</span>}
                        <span className="new-arrival-time">{currentArrivalItem.time}</span>
                      </div>
                      <div className="new-arrival-body" ref={newArrivalBodyRef} style={{ fontSize: `${newArrivalFontSize}px` }}>{currentArrivalItem.text}</div>
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
          <div className="board-tab-bar" ref={boardTabBarRef}>
            {boardTabs.length === 0 && (
              <div className="board-tab placeholder">
                <span className="board-tab-title">板未選択</span>
              </div>
            )}
            {boardTabs.map((tab, i) => (
              <div
                key={tab.boardUrl}
                className={`board-tab ${i === activeBoardTabIndex ? "active" : ""} ${boardTabDragIndex !== null && boardTabDragIndex !== i ? "drag-target" : ""}`}
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
          <div className="thread-tab-bar" ref={tabBarRef}>
            {threadTabs.length === 0 && (
              <div className="thread-tab placeholder active">
                <span className="thread-tab-title">未取得</span>
              </div>
            )}
            {threadTabs.map((tab, i) => (
              <div
                key={tab.threadUrl}
                className={`thread-tab ${i === activeTabIndex ? "active" : ""} ${tabDragIndex !== null && tabDragIndex !== i ? "drag-target" : ""}`}
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
                <span className="thread-tab-title">{tab.title}</span>
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
        <section className="pane threads" onMouseDown={() => setFocusedPane("threads")} style={{ '--fs-delta': `${threadsFontSize - 12}px` } as React.CSSProperties}>
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
                    className={`${selectedThread === t.id ? "selected-row" : ""} ${isUnread ? "unread-row" : ""} ${hasUnread ? "has-unread-row" : ""} ${"datOchi" in t && t.datOchi ? "dat-ochi-row" : ""}`}
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
        <section className="pane responses" onMouseDown={() => setFocusedPane("responses")} style={{ '--fs-delta': `${responsesFontSize - 12}px` } as React.CSSProperties}>
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
                <button className="title-action-btn" onClick={() => { setComposeOpen(true); setComposePos(null); setComposeBody(""); setComposeResult(null); }} title="書き込み"><Pencil size={14} /></button>
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
          <div
            className="response-layout"
          >
            <div
              className="response-scroll"
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
                return (
                  <Fragment key={r.id}>
                  {isFirstNew && (
                    <div className="new-response-separator">
                      <span>ここから新着</span>
                    </div>
                  )}
                  <div
                    data-response-no={r.id}
                    className={`response-block ${selectedResponse === r.id ? "selected" : ""}${myPostNos.has(r.id) ? " my-post" : ""}${replyToMeNos.has(r.id) ? " reply-to-me" : ""}`}
                    onClick={() => setSelectedResponse(r.id)}
                    onDoubleClick={() => appendComposeQuote(`>>${r.id}`)}
                  >
                    <div className="response-header">
                      <span className="response-no" onClick={(e) => onResponseNoClick(e, r.id)}>
                        {r.id}
                      </span>
                      {myPostNos.has(r.id) && <span className="my-post-label">[自分]</span>}
                      {replyToMeNos.has(r.id) && <span className="reply-to-me-label">[自分宛]</span>}
                      <span
                        className="response-name"
                        style={(() => {
                          const hl = textHighlights.find((h) => h.type === "name" && h.pattern === r.nameWithoutWatchoi);
                          return hl ? { background: hl.color } : undefined;
                        })()}
                        dangerouslySetInnerHTML={renderHighlightedPlainText(r.nameWithoutWatchoi, responseSearchQuery)}
                      />
                      {r.mail && (
                        <span className={`response-mail${r.mail === "sage" ? " response-mail-sage" : ""}`}>[{r.mail}]</span>
                      )}
                      {r.watchoi && (
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
                          className="back-ref-trigger"
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
                        <span
                          className="response-date"
                          dangerouslySetInnerHTML={renderHighlightedPlainText(formatResponseDate(r.time), responseSearchQuery)}
                        />
                        {id && (
                          <>
                            <span
                              className="response-id-cell"
                              style={{ color: idHighlights[id] ?? undefined }}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (idPopupCloseTimer.current) { clearTimeout(idPopupCloseTimer.current); idPopupCloseTimer.current = null; }
                                const p = clampMenuPosition(e.clientX, e.clientY, 160, 56);
                                setIdMenu({ x: p.x, y: p.y, id });
                              }}
                              onMouseEnter={(e) => {
                                if (idPopupCloseTimer.current) { clearTimeout(idPopupCloseTimer.current); idPopupCloseTimer.current = null; }
                                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                const right = Math.max(8, window.innerWidth - rect.right);
                                setIdPopup({ right, y: rect.bottom + 2, anchorTop: rect.top, id });
                              }}
                              onMouseLeave={() => {
                                idPopupCloseTimer.current = setTimeout(() => setIdPopup(null), 150);
                              }}
                            >
                              ID:{id}
                            </span>
                            <span
                              className="response-id-count"
                              style={{ color: count >= 5 ? '#cc3333' : count >= 2 ? '#3366ff' : undefined }}
                            >
                              ({idSeqMap.get(r.id) ?? 1}/{count})
                            </span>
                          </>
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
                    <div className={`response-body${(aaOverrides.has(r.id) ? aaOverrides.get(r.id) : isAsciiArt(r.text)) ? " aa" : ""}`} dangerouslySetInnerHTML={renderResponseBodyHighlighted(r.text, responseSearchQuery, { hideImages: ngResultMap.get(r.id) === "hide-images", imageSizeLimitKb: imageSizeLimit, urlRules: imageUrlRules }, textHighlights.filter((h) => h.type === "word"))} />
                  </div>
                  </Fragment>
                );
              })}
            </div>
            <div className="response-nav-bar">
              <span className="nav-info">
                着:{visibleResponseItems.length}{ngFilteredCount > 0 ? `(NG${ngFilteredCount})` : ""}
                {" "}サイズ:{Math.round(visibleResponseItems.reduce((s, r) => s + r.text.length, 0) / 1024)}KB
              </span>
              <button className="title-action-btn" onClick={() => { setResponseSearchBarVisible((v) => !v); if (responseSearchBarVisible) setResponseSearchQuery(""); }} title="レス検索"><Search size={14} /></button>
              {responseSearchBarVisible && (
                <>
                  <div className="search-with-history" style={{ flex: 1 }}>
                    <input
                      ref={responseSearchRef}
                      className="thread-search"
                      value={responseSearchQuery}
                      onChange={(e) => setResponseSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === "Enter") { addSearchHistory("response", responseSearchQuery); setSearchHistoryDropdown(null); }
                        if (e.key === "Escape") { setResponseSearchBarVisible(false); setResponseSearchQuery(""); setSearchHistoryDropdown(null); }
                      }}
                      placeholder="レス検索 (Enter:保存 / 右クリック:削除)"
                    />
                    <button
                      className="search-history-btn"
                      onClick={(e) => { e.stopPropagation(); setSearchHistoryDropdown((prev) => prev?.type === "response" ? null : { type: "response" }); }}
                      title="検索履歴"
                    ><ChevronDown size={10} /></button>
                    {searchHistoryDropdown?.type === "response" && responseSearchHistory.length > 0 && (
                      <div className="search-history-dropdown dropdown-up" onMouseDown={(e) => e.preventDefault()}>
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
                  {responseSearchQuery && <button className="title-action-btn" onClick={() => setResponseSearchQuery("")} title="検索クリア"><X size={14} /></button>}
                </>
              )}
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
          </div>
        </section>
        )}
        </div>
        </div>{/* /right-body */}
      </main>
      <footer className="status-bar">
        <span className="status-main">{status}</span>
        <span className="status-sep">|</span>
        <span>TS～{visibleThreadItems.length}</span>
        <span className="status-sep">|</span>
        <span>US～{unreadThreadCount}</span>
        <span className="status-sep">|</span>
        <span>Runtime:{runtimeState}</span>
      </footer>
      {composeOpen && (
        <section
          className="compose-window"
          role="dialog"
          aria-label="書き込み"
          style={composePos ? { right: "auto", bottom: "auto", left: composePos.x, top: composePos.y } : undefined}
        >
          <header
            className="compose-header"
            onMouseDown={(e) => {
              if ((e.target as HTMLElement).tagName === "BUTTON") return;
              e.preventDefault();
              const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
              composeDragRef.current = {
                startX: e.clientX,
                startY: e.clientY,
                startPosX: rect.left,
                startPosY: rect.top,
              };
              if (!composePos) setComposePos({ x: rect.left, y: rect.top });
              document.body.style.userSelect = "none";
              document.body.style.cursor = "move";
            }}
          >
            <strong>{composeNewThread ? "新スレ作成" : "書き込み"}</strong>
            <button className={`compose-mode-btn ${!composeNewThread ? "active" : ""}`} onClick={() => setComposeNewThread(false)}>レス</button>
            <button className={`compose-mode-btn ${composeNewThread ? "active" : ""}`} onClick={() => setComposeNewThread(true)}>新スレ</button>
            <span className="compose-target" title={threadTabs[activeTabIndex]?.threadUrl ?? threadUrl}>
              {threadTabs[activeTabIndex]?.title ?? threadUrl}
            </span>
            <button onClick={() => { setComposeOpen(false); setComposeResult(null); setUploadPanelOpen(false); setUploadResults([]); }}>閉じる</button>
          </header>
          <div className="compose-grid">
            {composeNewThread && (
              <label style={{ gridColumn: "1 / -1" }}>
                スレッドタイトル
                <input value={composeSubject} onChange={(e) => setComposeSubject(e.target.value)} placeholder="スレッドタイトルを入力" autoFocus />
              </label>
            )}
            <label>
              名前
              <input value={composeName} onChange={(e) => setComposeName(e.target.value)} list="name-history-list" />
              <datalist id="name-history-list">
                {nameHistory.map((n) => <option key={n} value={n} />)}
              </datalist>
            </label>
            <label>
              メール
              <input value={composeMailValue} onChange={(e) => setComposeMail(e.target.value)} disabled={composeSage} />
            </label>
            <label className="check">
              <input type="checkbox" checked={composeSage} onChange={(e) => setComposeSage(e.target.checked)} />
              sage
            </label>
          </div>
          <textarea
            className="compose-body"
            value={composeBody}
            onChange={(e) => setComposeBody(e.target.value)}
            onKeyDown={onComposeBodyKeyDown}
            placeholder="本文を入力"
            autoFocus
            style={{ fontSize: `${composeFontSize}px` }}
          />
          <div className="compose-meta">
            <span>{composeBody.length}文字</span>
            <span>{composeBody.split("\n").length}行</span>
          </div>
          {composePreview && (
            <div className="compose-preview" dangerouslySetInnerHTML={renderResponseBody(composeBody || "(空)")} />
          )}
          <div className="compose-actions">
            <button onClick={composeNewThread ? handleCreateThread : probePostFlowTraceFromCompose} disabled={composeSubmitting}>{composeSubmitting ? "送信中..." : composeNewThread ? "スレッド作成" : `送信 (${composeSubmitKey === "shift" ? "Shift" : "Ctrl"}+Enter)`}</button>
            <button onClick={() => setUploadPanelOpen((v) => { if (v) setUploadResults([]); return !v; })} title="画像アップロード" style={{ marginLeft: 4 }}><Upload size={14} /></button>
            <button onClick={async () => {
              setComposeResult({ ok: false, message: "診断中..." });
              try {
                const r = await invoke<string>("debug_post_connectivity", { threadUrl });
                setComposeResult({ ok: true, message: r });
              } catch (e) {
                setComposeResult({ ok: false, message: `診断エラー: ${String(e)}` });
              }
            }} style={{ marginLeft: "auto", fontSize: "0.85em" }}>接続診断</button>
          </div>
          {uploadPanelOpen && (
            <div className="upload-panel">
              <div className="upload-panel-tabs">
                <button className={uploadPanelTab === "upload" ? "active" : ""} onClick={() => setUploadPanelTab("upload")}><Upload size={12} /> アップロード</button>
                <button className={uploadPanelTab === "history" ? "active" : ""} onClick={() => setUploadPanelTab("history")}><History size={12} /> 履歴 ({uploadHistory.length})</button>
              </div>
              {uploadPanelTab === "upload" && (
                <div className="upload-tab-content">
                  <input ref={uploadFileRef} type="file" multiple accept="image/*,video/mp4,video/webm" style={{ display: "none" }} onChange={(e) => { if (e.target.files) handleUploadFiles(e.target.files); e.target.value = ""; }} />
                  <button className="upload-select-btn" onClick={() => uploadFileRef.current?.click()} disabled={uploadingFiles.length > 0}>
                    {uploadingFiles.length > 0 ? `アップロード中... (${uploadingFiles.length}件)` : "ファイルを選択 (最大4枚)"}
                  </button>
                  {uploadingFiles.length > 0 && (
                    <div className="upload-progress">
                      {uploadingFiles.map((f, i) => <div key={i} className="upload-progress-item">⏳ {f}</div>)}
                    </div>
                  )}
                  {uploadResults.length > 0 && (
                    <div className="upload-results">
                      {uploadResults.map((r, i) => (
                        <div key={i} className={`upload-result-item ${r.error ? "upload-err" : "upload-ok"}`}>
                          {r.thumbnail && <img src={r.thumbnail} alt="" className="upload-result-thumb" />}
                          <span className="upload-result-name">{r.fileName}</span>
                          {r.sourceUrl ? (
                            <span className="upload-result-actions">
                              <button onClick={() => insertUploadUrl(r.sourceUrl!)} title="本文に挿入"><Copy size={12} /> 挿入</button>
                              <span className="upload-result-link" onClick={() => { void invoke("open_external_url", { url: r.sourceUrl }).catch(() => window.open(r.sourceUrl, "_blank")); }} title="ブラウザで開く">{r.sourceUrl}</span>
                            </span>
                          ) : (
                            <span className="upload-result-error">{r.error}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {uploadPanelTab === "history" && (
                <div className="upload-tab-content upload-history-list">
                  {uploadHistory.length === 0 && <div className="upload-empty">アップロード履歴はありません</div>}
                  {uploadHistory.map((entry, i) => (
                    <div key={i} className="upload-history-item">
                      {entry.thumbnail && <img src={entry.thumbnail} alt="" className="upload-history-thumb" loading="lazy" />}
                      <div className="upload-history-info">
                        <span className="upload-history-name">{entry.fileName}</span>
                        <span className="upload-history-date">{new Date(entry.uploadedAt).toLocaleString()}</span>
                      </div>
                      <div className="upload-history-actions">
                        <button onClick={() => insertUploadUrl(entry.sourceUrl)} title="本文に挿入"><Copy size={12} /></button>
                        <button onClick={() => deleteHistoryEntry(i)} title="削除"><Trash2 size={12} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {composeResult && (
            <div className={`compose-result ${composeResult.ok ? "compose-result-ok" : "compose-result-err"}`}>
              {composeResult.ok ? "OK" : "NG"}: {composeResult.message}
            </div>
          )}
        </section>
      )}
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
          {/* ----- 画像保存 ----- */}
          {responseMenu.imageUrl && isTauriRuntime() && (
            <button onClick={() => { void saveImage(responseMenu.imageUrl!); setResponseMenu(null); }}>画像を保存</button>
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
          {responseMenu.isOnResNo && responseMenu.responseId > 0 && ttsMode !== "off" && (
            <button onClick={() => {
              const startNo = responseMenu.responseId;
              const items = visibleResponseItems.filter((r) => r.id >= startNo);
              const site = detectSiteType(threadTabs[activeTabIndex]?.threadUrl ?? threadUrl);
              setResponseMenu(null);
              setStatus(`レス ${startNo} から読み上げ開始 (${items.length}件)`);
              void (async () => {
                await ttsStop();
                for (const item of items) {
                  if (item.id >= 1001) continue;
                  const prefix = site === "shitaraba" ? `したらば${item.id}番さん`
                    : site === "jpnkn" ? `ジャパンくん${item.id}番さん`
                    : `レス${item.id}番さん`;
                  ttsSpeak(item.text, prefix);
                }
              })();
            }}>このレスから読み上げ</button>
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
            className="anchor-popup"
            style={posStyle}
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
                <div className="anchor-popup-body" dangerouslySetInnerHTML={renderResponseBody(popupResp.text)} />
              </div>
            ))}
          </div>
        );
      })()}
      {backRefPopup && (() => {
        const refs = backRefPopup.responseIds;
        return (
          <div
            className="anchor-popup back-ref-popup"
            style={{ left: backRefPopup.x, bottom: window.innerHeight - backRefPopup.y }}
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
                  <div className="anchor-popup-body" dangerouslySetInnerHTML={renderResponseBody(refResp.text)} />
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
            className="anchor-popup nested-popup"
            style={nPosStyle}
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
                <div className="anchor-popup-body" dangerouslySetInnerHTML={renderResponseBody(nestedResp.text)} />
              </div>
            ))}
          </div>
        );
      })}
      {idPopup && (() => {
        const idResponses = responseItems.filter((r) => extractId(r.time) === idPopup.id);
        const idMaxH = 360;
        const idSpaceBelow = window.innerHeight - idPopup.y;
        const idFlipUp = idSpaceBelow < idMaxH && idPopup.anchorTop > idSpaceBelow;
        const idPosStyle = idFlipUp
          ? { right: idPopup.right, bottom: window.innerHeight - idPopup.anchorTop + 2 }
          : { right: idPopup.right, top: idPopup.y };
        return (
          <div
            className="id-popup"
            style={idPosStyle}
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
            <div className="id-popup-list">
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
      {settingsOpen && (
        <div className="lightbox-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="settings-panel settings-panel-wide" onClick={(e) => e.stopPropagation()}>
            <header className="settings-header">
              <strong>設定</strong>
              <button onClick={() => setSettingsOpen(false)}>閉じる</button>
            </header>
            <div className="settings-2col">
              <nav className="settings-nav">
                {(["display","posting","tts","subtitle","proxy","ng","highlights","info"] as const).map((cat) => {
                  const labels: Record<string, string> = { display:"表示", posting:"書き込み", tts:"読み上げ", subtitle:"字幕", proxy:"プロキシ", ng:"NG", highlights:"ハイライト", info:"情報" };
                  return (
                    <button key={cat} className={`settings-nav-item${settingsCategory === cat ? " active" : ""}`} onClick={() => setSettingsCategory(cat)}>{labels[cat]}</button>
                  );
                })}
              </nav>
              <div className="settings-content">
              {settingsCategory === "display" && (<>
              <fieldset>
                <legend>表示</legend>
                <label className="settings-row">
                  <span>テーマ</span>
                  <select value={darkMode ? "dark" : "light"} onChange={(e) => setDarkMode(e.target.value === "dark")}>
                    <option value="light">ライト</option>
                    <option value="dark">ダーク</option>
                  </select>
                </label>
                <label className="settings-row">
                  <span>フォント</span>
                  <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}>
                    <option value="">デフォルト</option>
                    <option value="'MS Gothic', monospace">MS ゴシック</option>
                    <option value="'MS PGothic', sans-serif">MS Pゴシック</option>
                    <option value="'Meiryo', sans-serif">メイリオ</option>
                    <option value="'Yu Gothic UI', sans-serif">Yu Gothic UI</option>
                    <option value="'BIZ UDGothic', sans-serif">BIZ UDゴシック</option>
                    <option value="'Noto Sans JP', sans-serif">Noto Sans JP</option>
                    <option value="monospace">等幅</option>
                  </select>
                </label>
                <label className="settings-row">
                  <span>文字サイズ (板)</span>
                  <input type="number" value={boardsFontSize} min={8} max={20} onChange={(e) => setBoardsFontSize(Number(e.target.value))} />
                </label>
                <label className="settings-row">
                  <span>文字サイズ (スレ)</span>
                  <input type="number" value={threadsFontSize} min={8} max={20} onChange={(e) => setThreadsFontSize(Number(e.target.value))} />
                </label>
                <label className="settings-row">
                  <span>文字サイズ (レス)</span>
                  <input type="number" value={responsesFontSize} min={8} max={20} onChange={(e) => setResponsesFontSize(Number(e.target.value))} />
                </label>
                <label className="settings-row">
                  <span>文字サイズ (新着レス)</span>
                  <input type="number" value={newArrivalFontSize} min={8} max={24} onChange={(e) => setNewArrivalFontSize(Number(e.target.value))} />
                </label>
                <label className="settings-row">
                  <span>自動更新間隔 (秒)</span>
                  <input type="number" value={autoRefreshInterval} min={15} max={300} step={15} onChange={(e) => {
                    const v = Math.max(15, Math.min(300, Number(e.target.value)));
                    setAutoRefreshInterval(v);
                  }} />
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={autoScrollEnabled} onChange={(e) => setAutoScrollEnabled(e.target.checked)} />
                  <span>新着レス取得時に自動スクロール</span>
                </label>
                <label className="settings-row">
                  <input type="checkbox" checked={smoothScroll} onChange={(e) => setSmoothScroll(e.target.checked)} />
                  <span>スムーススクロール (再起動後に反映)</span>
                </label>
                <label className="settings-row">
                  <span>レス間隔 (px)</span>
                  <input type="number" value={responseGap} min={0} max={40} step={1} onChange={(e) => setResponseGap(Math.max(0, Math.min(40, Number(e.target.value))))} />
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
              </>)}
              {settingsCategory === "posting" && (<>
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
                <label className="settings-row">
                  <input type="checkbox" checked={typingConfettiEnabled} onChange={(e) => setTypingConfettiEnabled(e.target.checked)} />
                  <span>入力時コンフェティ</span>
                </label>
              </fieldset>
              </>)}
              {settingsCategory === "subtitle" && (<>
              <fieldset>
                <legend>字幕</legend>
                <div className="settings-row">
                  <span>本文フォントサイズ</span>
                  <input type="number" min={10} max={96} value={subtitleBodyFontSize} onChange={(e) => {
                    const v = Number(e.target.value);
                    setSubtitleBodyFontSize(v);
                    if (isTauriRuntime()) invoke("subtitle_font_size", { size: v }).catch(() => {});
                  }} style={{ width: 60 }} />
                </div>
                <div className="settings-row">
                  <span>メタフォントサイズ</span>
                  <input type="number" min={8} max={48} value={subtitleMetaFontSize} onChange={(e) => {
                    const v = Number(e.target.value);
                    setSubtitleMetaFontSize(v);
                    if (isTauriRuntime()) invoke("subtitle_meta_font_size", { size: v }).catch(() => {});
                  }} style={{ width: 60 }} />
                </div>
                <div className="settings-row">
                  <span>背景透明度</span>
                  <input type="range" min={0.1} max={1.0} step={0.05} value={subtitleOpacity} onChange={(e) => {
                    const v = Number(e.target.value);
                    setSubtitleOpacity(v);
                    if (isTauriRuntime()) invoke("subtitle_opacity", { opacity: v }).catch(() => {});
                  }} style={{ width: 120 }} />
                  <span>{subtitleOpacity.toFixed(2)}</span>
                </div>
                <div className="settings-row">
                  <span>常に最前面</span>
                  <input type="checkbox" checked={subtitleAlwaysOnTop} onChange={(e) => {
                    setSubtitleAlwaysOnTop(e.target.checked);
                    if (isTauriRuntime()) invoke("subtitle_topmost", { enabled: e.target.checked }).catch(() => {});
                  }} />
                </div>
                <div className="settings-row">
                  <span>ウィンドウ位置</span>
                  <button onClick={() => {
                    if (isTauriRuntime()) invoke("subtitle_reset_position").catch((e) => console.warn("subtitle_reset_position:", e));
                  }}>中央に戻す</button>
                </div>
              </fieldset>
              </>)}
              {settingsCategory === "tts" && (<>
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
              </>)}
              {settingsCategory === "proxy" && (<>
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
              </>)}
              {settingsCategory === "highlights" && (<>
              <fieldset>
                <legend>ワードハイライト</legend>
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
                {textHighlights.filter((h) => h.type === "word").length === 0 ? (
                  <div style={{ color: "var(--sub)", fontSize: "0.85em" }}>登録なし</div>
                ) : (
                  <>
                    {textHighlights.filter((h) => h.type === "word").map((h, i) => (
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
              </fieldset>
              <fieldset>
                <legend>名前ハイライト</legend>
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
                {textHighlights.filter((h) => h.type === "name").length === 0 ? (
                  <div style={{ color: "var(--sub)", fontSize: "0.85em" }}>登録なし</div>
                ) : (
                  <>
                    {textHighlights.filter((h) => h.type === "name").map((h, i) => (
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
              </fieldset>
              <fieldset>
                <legend>ID ハイライト（今日分）</legend>
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
                {Object.keys(idHighlights).length === 0 ? (
                  <div style={{ color: "var(--sub)", fontSize: "0.85em" }}>登録なし</div>
                ) : (
                  <>
                    {Object.entries(idHighlights).map(([id, color]) => (
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
              </fieldset>
              </>)}
              {settingsCategory === "ng" && (
                <div className="settings-ng-inline">
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
                  <div className="ng-panel-lists">
                    {(["words", "ids", "names"] as const).map((type) => (
                      <div key={type} className="ng-list-section">
                        <h4>{type === "words" ? "ワード" : type === "ids" ? "ID" : "名前"} ({ngFilters[type].length})</h4>
                        {ngFilters[type].length === 0 ? (
                          <span className="ng-empty">(なし)</span>
                        ) : (
                          <ul className="ng-list">
                            {ngFilters[type].map((entry) => {
                              const v = ngVal(entry); const mode = ngEntryMode(entry); const scope = ngEntryScope(entry);
                              const isRegex = v.startsWith("/") && v.endsWith("/") && v.length > 2;
                              return (
                                <li key={v}>
                                  <span className={`ng-mode-label ${mode === "hide-images" ? "ng-mode-img" : "ng-mode-hide"}`}>{mode === "hide-images" ? "画像" : "非表示"}</span>
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
                </div>
              )}
              {settingsCategory === "info" && (<>
              <fieldset>
                <legend>情報</legend>
                <div className="settings-row"><span>バージョン</span><span>{currentVersion}</span></div>
                <div className="settings-row">
                  <span>GitHub</span>
                  <button onClick={() => { const url = "https://github.com/kaedekiku/LiveFakeTauri2"; if (isTauriRuntime()) void invoke("open_external_url", { url }).catch(() => window.open(url, "_blank")); else window.open(url, "_blank"); }}>GitHubページを開く</button>
                </div>
              </fieldset>
              </>)}
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
              try { localStorage.setItem(NEW_THREAD_SIZE_KEY, JSON.stringify({ w, h })); } catch { /* ignore */ }
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
                    style={{ width: "100%", boxSizing: "border-box" }}
                  />
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
