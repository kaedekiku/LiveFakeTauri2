import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type MenuInfo = {
  topLevelKeys: number;
  normalizedSample: string;
};

type AuthEnvStatus = {
  beEmailSet: boolean;
  bePasswordSet: boolean;
  upliftEmailSet: boolean;
  upliftPasswordSet: boolean;
};

type LoginOutcome = {
  provider: "Be" | "Uplift" | "Donguri";
  success: boolean;
  status: number;
  location: string | null;
  cookieNames: string[];
  note: string;
};

type PostCookieReport = {
  targetUrl: string;
  cookieNames: string[];
};

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

type PostFinalizePreview = {
  actionUrl: string;
  fieldNames: string[];
  fieldCount: number;
};

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
    | {
        key: string;
        sha256: string;
        size: number;
        filename: string;
      }
    | null;
};

export default function App() {
  const [status, setStatus] = useState("not fetched");
  const [authStatus, setAuthStatus] = useState("not checked");
  const [loginProbe, setLoginProbe] = useState("not run");
  const [postCookieProbe, setPostCookieProbe] = useState("not run");
  const [threadUrl, setThreadUrl] = useState("https://mao.5ch.io/test/read.cgi/ngt/9240230711/");
  const [postFormProbe, setPostFormProbe] = useState("not run");
  const [postConfirmProbe, setPostConfirmProbe] = useState("not run");
  const [postFinalizePreviewProbe, setPostFinalizePreviewProbe] = useState("not run");
  const [postFinalizeSubmitProbe, setPostFinalizeSubmitProbe] = useState("not run");
  const [allowRealSubmit, setAllowRealSubmit] = useState(false);
  const [metadataUrl, setMetadataUrl] = useState("");
  const [currentVersion, setCurrentVersion] = useState("0.1.0");
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [updateProbe, setUpdateProbe] = useState("not run");

  const fetchMenu = async () => {
    setStatus("loading...");
    try {
      const info = await invoke<MenuInfo>("fetch_bbsmenu_summary");
      setStatus(`ok keys=${info.topLevelKeys} sample=${info.normalizedSample}`);
    } catch (error) {
      setStatus(`error: ${String(error)}`);
    }
  };

  const checkAuthEnv = async () => {
    try {
      const s = await invoke<AuthEnvStatus>("check_auth_env_status");
      setAuthStatus(
        `BE(email:${s.beEmailSet}, pass:${s.bePasswordSet}) UPLIFT(email:${s.upliftEmailSet}, pass:${s.upliftPasswordSet})`
      );
    } catch (error) {
      setAuthStatus(`error: ${String(error)}`);
    }
  };

  const probeAuth = async () => {
    setLoginProbe("running...");
    try {
      const result = await invoke<LoginOutcome[]>("probe_auth_logins");
      const lines = result.map(
        (r) =>
          `${r.provider}: success=${r.success} status=${r.status} location=${r.location ?? "-"} cookies=${
            r.cookieNames.join(",") || "(none)"
          }`
      );
      setLoginProbe(lines.join("\n"));
    } catch (error) {
      setLoginProbe(`error: ${String(error)}`);
    }
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

  const probePostConfirmEmpty = async () => {
    setPostConfirmProbe("running...");
    try {
      const r = await invoke<PostConfirmResult>("probe_post_confirm_empty", { threadUrl });
      setPostConfirmProbe(
        `status=${r.status} type=${r.contentType ?? "-"} confirm=${r.containsConfirm} error=${
          r.containsError
        } preview=${r.bodyPreview}`
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
        `current=${r.currentVersion} latest=${r.latestVersion} hasUpdate=${r.hasUpdate} releasedAt=${
          r.releasedAt ?? "-"
        } platform=${r.currentPlatformKey} asset=${r.currentPlatformAsset?.filename ?? "(none)"}`
      );
    } catch (error) {
      setUpdateProbe(`error: ${String(error)}`);
    }
  };

  const openDownloadPage = async () => {
    if (!updateResult?.downloadPageUrl) {
      return;
    }
    await invoke("open_external_url", { url: updateResult.downloadPageUrl });
  };

  return (
    <main className="app-root">
      <h1>5ch Browser (Phase 1 auth/fetch/update)</h1>
      <p>Auth probes, post token extraction, and update check are wired.</p>
      <button onClick={fetchMenu}>Fetch bbsmenu.json</button>
      <pre>{status}</pre>
      <button onClick={checkAuthEnv}>Check auth env</button>
      <pre>{authStatus}</pre>
      <button onClick={probeAuth}>Probe BE/UPLIFT/Donguri logins</button>
      <pre>{loginProbe}</pre>
      <button onClick={probePostCookieScope}>Probe cookie scope to bbs.cgi</button>
      <pre>{postCookieProbe}</pre>
      <label>
        Thread URL
        <input style={{ width: "100%" }} value={threadUrl} onChange={(e) => setThreadUrl(e.target.value)} />
      </label>
      <button onClick={probeThreadPostForm}>Probe dynamic bbs/key/time</button>
      <pre>{postFormProbe}</pre>
      <button onClick={probePostConfirmEmpty}>Probe confirm with empty message</button>
      <pre>{postConfirmProbe}</pre>
      <button onClick={probePostFinalizePreview}>Probe finalize form from confirm</button>
      <pre>{postFinalizePreviewProbe}</pre>
      <label style={{ display: "block" }}>
        <input type="checkbox" checked={allowRealSubmit} onChange={(e) => setAllowRealSubmit(e.target.checked)} />{" "}
        allow real final submit (danger)
      </label>
      <button onClick={probePostFinalizeSubmitEmpty}>Probe final submit (empty)</button>
      <pre>{postFinalizeSubmitProbe}</pre>
      <label>
        latest.json URL
        <input style={{ width: "100%" }} value={metadataUrl} onChange={(e) => setMetadataUrl(e.target.value)} />
      </label>
      <label>
        Current Version
        <input style={{ width: "100%" }} value={currentVersion} onChange={(e) => setCurrentVersion(e.target.value)} />
      </label>
      <button onClick={checkForUpdates}>Check for updates</button>
      <pre>{updateProbe}</pre>
      <button onClick={openDownloadPage} disabled={!updateResult?.hasUpdate || !updateResult.downloadPageUrl}>
        Open download page
      </button>
    </main>
  );
}
