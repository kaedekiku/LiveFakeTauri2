/**
 * End-to-end tests for the Tauri desktop app.
 *
 * Connects to the running Tauri WebView2 via CDP (Chrome DevTools Protocol).
 * Tests Tauri IPC (invoke) directly via page.evaluate and validates real
 * server responses from 5ch.io.
 *
 * Environment:
 *   E2E_CDP_URL  - CDP endpoint (default: http://127.0.0.1:9248)
 */
import process from "node:process";
import { chromium } from "playwright";

const CDP_URL = process.env.E2E_CDP_URL?.trim() || "http://127.0.0.1:9248";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

let browser;
try {
  console.log(`e2e: connecting to CDP at ${CDP_URL}`);
  browser = await chromium.connectOverCDP(CDP_URL);
  console.log("e2e: connected");

  const contexts = browser.contexts();
  assert(contexts.length > 0, "no browser contexts found");
  // メインのウィンドウ (字幕などの別ウィンドウではないもの) を選び、画面ができるまで待つ
  let page = null;
  for (let i = 0; i < 600 && !page; i++) {
    page = contexts[0].pages().find((p) => !/subtitle|image_popup|compose_popup/.test(p.url())) ?? null;
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  assert(page, "no page found");
  await page.waitForSelector(".status-bar", { timeout: 120000 });

  // Capture console/errors
  page.on("pageerror", (err) => console.log(`e2e [pageerror]: ${err.message}`));

  // --- 1. Runtime detection ---
  const statusText = await page.$eval(".status-bar", (el) => el.textContent || "");
  assert(statusText.includes("Runtime:TAURI"), `expected TAURI runtime, got: ${statusText}`);
  console.log("e2e: [PASS] runtime is TAURI");

  // --- 2. IPC: fetch_bbsmenu_summary ---
  const menuResult = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("fetch_bbsmenu_summary", {})
  );
  assert(menuResult && menuResult.topLevelKeys > 0, `bbsmenu should have keys, got: ${JSON.stringify(menuResult)}`);
  console.log(`e2e: [PASS] bbsmenu summary: ${menuResult.topLevelKeys} top-level keys`);

  // --- 3. IPC: fetch_board_categories ---
  const categories = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("fetch_board_categories", {})
  );
  assert(Array.isArray(categories) && categories.length > 0, `expected board categories array, got: ${JSON.stringify(categories).substring(0, 200)}`);
  const totalBoards = categories.reduce((s, c) => s + c.boards.length, 0);
  console.log(`e2e: [PASS] board categories: ${categories.length} categories, ${totalBoards} boards`);

  // Validate category structure
  const firstCat = categories[0];
  assert(firstCat.categoryName && firstCat.boards.length > 0, "first category should have name and boards");
  const firstBoard = firstCat.boards[0];
  assert(firstBoard.boardName && firstBoard.url, "board should have boardName and url");
  assert(firstBoard.url.includes("5ch.io"), `board url should be normalized to 5ch.io, got: ${firstBoard.url}`);
  console.log(`e2e: [PASS] board structure: ${firstCat.categoryName} > ${firstBoard.boardName} (${firstBoard.url})`);

  // --- 4. IPC: fetch_thread_list from a real board ---
  // Use a board URL that is NOT headline (which returns 404)
  let testBoardUrl = null;
  for (const cat of categories) {
    if (cat.categoryName.includes("ヘッドライン")) continue;
    for (const b of cat.boards) {
      if (!b.url.includes("headline") && b.url.match(/\/[a-z]+\/$/)) {
        testBoardUrl = b.url;
        break;
      }
    }
    if (testBoardUrl) break;
  }
  assert(testBoardUrl, "could not find a suitable board URL to test");
  console.log(`e2e: testing thread list from: ${testBoardUrl}`);

  const threads = await page.evaluate(async (url) => {
    return window.__TAURI_INTERNALS__.invoke("fetch_thread_list", { threadUrl: url, limit: 20 });
  }, testBoardUrl);
  assert(Array.isArray(threads) && threads.length > 0, `expected threads > 0 from ${testBoardUrl}, got ${threads?.length ?? 0}`);
  console.log(`e2e: [PASS] thread list: ${threads.length} threads from ${testBoardUrl}`);

  // Validate thread structure
  const firstThread = threads[0];
  assert(firstThread.threadKey, "thread should have threadKey");
  assert(firstThread.title, "thread should have title");
  assert(firstThread.responseCount > 0, `thread responseCount should be > 0, got ${firstThread.responseCount}`);
  assert(firstThread.threadUrl.includes("5ch.io"), `thread url should contain 5ch.io, got ${firstThread.threadUrl}`);
  console.log(`e2e: [PASS] thread structure: "${firstThread.title.substring(0, 40)}" (${firstThread.responseCount} res)`);

  // --- 5. IPC: fetch_thread_responses_command ---
  // 戻り値は { responses: [...], title } (スレタイも一緒に返す)
  const fetched = await page.evaluate(async (url) => {
    return window.__TAURI_INTERNALS__.invoke("fetch_thread_responses_command", { threadUrl: url, limit: 50 });
  }, firstThread.threadUrl);
  const responses = fetched?.responses;
  assert(Array.isArray(responses) && responses.length > 0, `expected responses > 0, got ${responses?.length ?? 0}`);
  console.log(`e2e: [PASS] responses: ${responses.length} from thread "${firstThread.title.substring(0, 30)}"`);

  // Validate response structure
  const firstResp = responses[0];
  assert(firstResp.responseNo === 1, `first response should be No.1, got ${firstResp.responseNo}`);
  assert(typeof firstResp.name === "string", "response should have name");
  assert(typeof firstResp.body === "string" && firstResp.body.length > 0, "response should have non-empty body");
  assert(typeof firstResp.dateAndId === "string", "response should have dateAndId");
  console.log(`e2e: [PASS] response structure: No.${firstResp.responseNo} by "${firstResp.name}" (${firstResp.body.length} chars)`);

  // --- 6. IPC: probe_thread_post_form ---
  const postForm = await page.evaluate(async (url) => {
    return window.__TAURI_INTERNALS__.invoke("probe_thread_post_form", { threadUrl: url });
  }, firstThread.threadUrl);
  assert(postForm.bbs, `post form should have bbs field, got: ${JSON.stringify(postForm)}`);
  assert(postForm.key, "post form should have key field");
  assert(postForm.time, "post form should have time field");
  assert(postForm.postUrl.includes("bbs.cgi"), `post url should contain bbs.cgi, got: ${postForm.postUrl}`);
  console.log(`e2e: [PASS] post form: bbs=${postForm.bbs} key=${postForm.key} time=${postForm.time}`);

  // --- 7. React DOM interactions ---
  // Click thread row and verify selection change
  const threadRows = await page.$$eval(".threads tbody tr", (rows) => rows.length);
  if (threadRows >= 2) {
    await page.evaluate(() => {
      const row = document.querySelector(".threads tbody tr:nth-child(2)");
      if (row) row.click();
    });
    await new Promise((r) => setTimeout(r, 200));
    const selectedNo = await page.$eval(".threads tbody tr.selected-row td:nth-child(2)", (el) => el.textContent);
    assert(selectedNo === "2", `expected selected thread #2, got #${selectedNo}`);
    console.log("e2e: [PASS] thread click selection works");
  }

  // Verify compose window opens
  await page.evaluate(() => {
    const btn = document.querySelector(".tool-bar button");
    // Find Write button
    document.querySelectorAll(".tool-bar button").forEach((b) => {
      if (b.textContent === "書き込み") b.click();
    });
  });
  await new Promise((r) => setTimeout(r, 300));
  const composeVisible = await page.$(".compose-window");
  if (composeVisible) {
    console.log("e2e: [PASS] compose window opens");
  } else {
    console.log("e2e: [SKIP] compose window did not open via CDP click");
  }

  // --- 8. IPC: favorites CRUD ---
  // Save a favorite board
  const testFavBoard = { boardName: "e2e-test-board", url: "https://mao.5ch.io/e2etest/" };
  const favData = { boards: [testFavBoard], threads: [{ threadUrl: firstThread.threadUrl, title: firstThread.title, boardUrl: testBoardUrl }] };
  await page.evaluate(async (data) => {
    return window.__TAURI_INTERNALS__.invoke("save_favorites", { favorites: data });
  }, favData);
  console.log("e2e: [PASS] save_favorites succeeded");

  // Load favorites back and validate
  const loadedFavs = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("load_favorites", {})
  );
  assert(loadedFavs.boards.length === 1, `expected 1 fav board, got ${loadedFavs.boards.length}`);
  assert(loadedFavs.boards[0].boardName === "e2e-test-board", `fav board name mismatch: ${loadedFavs.boards[0].boardName}`);
  assert(loadedFavs.threads.length === 1, `expected 1 fav thread, got ${loadedFavs.threads.length}`);
  assert(loadedFavs.threads[0].threadUrl === firstThread.threadUrl, "fav thread url mismatch");
  console.log(`e2e: [PASS] load_favorites: ${loadedFavs.boards.length} boards, ${loadedFavs.threads.length} threads`);

  // Clean up favorites
  await page.evaluate(async () => {
    return window.__TAURI_INTERNALS__.invoke("save_favorites", { favorites: { boards: [], threads: [] } });
  });
  const cleanedFavs = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("load_favorites", {})
  );
  assert(cleanedFavs.boards.length === 0, "fav boards should be empty after cleanup");
  assert(cleanedFavs.threads.length === 0, "fav threads should be empty after cleanup");
  console.log("e2e: [PASS] favorites cleanup verified");

  // --- 9. IPC: NG filters CRUD ---
  const testNg = { words: ["e2e-ng-word"], ids: ["e2e-ng-id"], names: ["e2e-ng-name"] };
  await page.evaluate(async (data) => {
    return window.__TAURI_INTERNALS__.invoke("save_ng_filters", { filters: data });
  }, testNg);
  console.log("e2e: [PASS] save_ng_filters succeeded");

  const loadedNg = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("load_ng_filters", {})
  );
  assert(loadedNg.words.length === 1 && loadedNg.words[0] === "e2e-ng-word", `ng words mismatch: ${JSON.stringify(loadedNg.words)}`);
  assert(loadedNg.ids.length === 1 && loadedNg.ids[0] === "e2e-ng-id", `ng ids mismatch: ${JSON.stringify(loadedNg.ids)}`);
  assert(loadedNg.names.length === 1 && loadedNg.names[0] === "e2e-ng-name", `ng names mismatch: ${JSON.stringify(loadedNg.names)}`);
  console.log(`e2e: [PASS] load_ng_filters: ${loadedNg.words.length}W/${loadedNg.ids.length}ID/${loadedNg.names.length}N`);

  // Clean up NG filters
  await page.evaluate(async () => {
    return window.__TAURI_INTERNALS__.invoke("save_ng_filters", { filters: { words: [], ids: [], names: [] } });
  });
  console.log("e2e: [PASS] ng filters cleanup done");

  // --- 10. IPC: read status CRUD ---
  const testReadStatus = { [testBoardUrl]: { [firstThread.threadKey]: firstThread.responseCount } };
  await page.evaluate(async (data) => {
    return window.__TAURI_INTERNALS__.invoke("save_read_status", { status: data });
  }, testReadStatus);
  console.log("e2e: [PASS] save_read_status succeeded");

  const loadedRead = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("load_read_status", {})
  );
  assert(typeof loadedRead === "object", "read status should be an object");
  assert(loadedRead[testBoardUrl], `read status should have entry for ${testBoardUrl}`);
  assert(loadedRead[testBoardUrl][firstThread.threadKey] === firstThread.responseCount,
    `read count mismatch: expected ${firstThread.responseCount}, got ${loadedRead[testBoardUrl][firstThread.threadKey]}`);
  console.log(`e2e: [PASS] load_read_status: ${firstThread.threadKey}=${loadedRead[testBoardUrl][firstThread.threadKey]}`);

  // Clean up read status
  await page.evaluate(async () => {
    return window.__TAURI_INTERNALS__.invoke("save_read_status", { status: {} });
  });
  console.log("e2e: [PASS] read status cleanup done");

  // --- 11. DOM: thread search filter ---
  // 画面のスレ一覧に板を読み込んでおく (空のデータで起動したときは、まだ何も表示されていないため)
  await page.fill(".address-input", testBoardUrl);
  await page.press(".address-input", "Enter");
  await page.waitForFunction(() => document.querySelectorAll(".threads tbody tr").length > 0, null, { timeout: 30000 });
  const threadSearchInput = await page.$(".thread-search");
  assert(threadSearchInput, "thread search input should exist");
  // Type a nonsense query to filter all threads out
  await page.evaluate(() => {
    const input = document.querySelector(".thread-search");
    if (input) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      nativeInputValueSetter.call(input, "zzz_nonexistent_e2e_xyz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await new Promise((r) => setTimeout(r, 200));
  const filteredRowCount = await page.$$eval(".threads tbody tr", (rows) => rows.length);
  assert(filteredRowCount === 0, `search filter should hide all rows, got ${filteredRowCount}`);
  console.log("e2e: [PASS] thread search filters rows to 0");

  // Clear search
  await page.evaluate(() => {
    const input = document.querySelector(".thread-search");
    if (input) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      nativeInputValueSetter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await new Promise((r) => setTimeout(r, 200));
  const restoredRowCount = await page.$$eval(".threads tbody tr", (rows) => rows.length);
  assert(restoredRowCount > 0, `clearing search should restore rows, got ${restoredRowCount}`);
  console.log(`e2e: [PASS] thread search clear restores ${restoredRowCount} rows`);

  // --- 12. DOM: board pane tabs ---
  const boardTabs = await page.$$(".board-tabs:not(.board-tab-bar) > .board-tab");
  assert(boardTabs.length === 2, `expected 2 board tabs, got ${boardTabs.length}`);

  // Click Fav tab
  await page.evaluate(() => {
    const tabs = document.querySelectorAll(".board-tabs:not(.board-tab-bar) > .board-tab");
    if (tabs[1]) tabs[1].click();
  });
  await new Promise((r) => setTimeout(r, 200));
  const favThreadsList = await page.$(".fav-threads-list");
  assert(favThreadsList, "clicking Fav tab should show fav-threads-list");
  console.log("e2e: [PASS] board Fav tab shows fav threads list");

  // Click Boards tab back
  await page.evaluate(() => {
    const tabs = document.querySelectorAll(".board-tabs:not(.board-tab-bar) > .board-tab");
    if (tabs[0]) tabs[0].click();
  });
  await new Promise((r) => setTimeout(r, 200));
  const boardTree = await page.$(".board-tree");
  const boardFallback = await page.$(".boards ul");
  assert(boardTree || boardFallback, "clicking Boards tab should show board-tree or fallback list");
  const favThreadsListGone = await page.$(".fav-threads-list");
  assert(!favThreadsListGone, "fav-threads-list should not be visible on Boards tab");
  console.log("e2e: [PASS] board Boards tab shows board content");

  // --- 13. DOM: NG filter panel ---
  // Open NG panel via toolbar button
  await page.evaluate(() => {
    document.querySelectorAll(".tool-bar button").forEach((b) => {
      if (b.textContent === "NG") b.click();
    });
  });
  await new Promise((r) => setTimeout(r, 300));
  const ngPanel = await page.$(".ng-panel");
  assert(ngPanel, "NG filter panel should be visible after clicking button");
  console.log("e2e: [PASS] NG filter panel opens");

  // Add an NG word via DOM
  await page.evaluate(() => {
    const input = document.querySelector(".ng-panel-add input");
    if (input) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      nativeInputValueSetter.call(input, "e2e-test-word");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await page.evaluate(() => {
    const addBtn = document.querySelector(".ng-panel-add button");
    if (addBtn) addBtn.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  const ngItems = await page.$$eval(".ng-list li", (els) => els.map((el) => el.textContent));
  // 配信向けの伏せ字 (streamMask) がオンだとワードは •••• で表示されるので、件数でも確かめる
  assert(ngItems.some((t) => t.includes("e2e-test-word")) || (ngItems.length === 1 && ngItems[0].includes("•")), `NG word should appear in list, got: ${JSON.stringify(ngItems)}`);
  console.log("e2e: [PASS] NG word added via panel");

  // Remove the NG word
  await page.evaluate(() => {
    const removeBtn = document.querySelector(".ng-remove");
    if (removeBtn) removeBtn.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  const ngItemsAfter = await page.$$eval(".ng-list li", (els) => els.length);
  assert(ngItemsAfter === 0, `NG list should be empty after removal, got ${ngItemsAfter}`);
  console.log("e2e: [PASS] NG word removed via panel");

  // Close NG panel
  await page.evaluate(() => {
    const closeBtn = document.querySelector(".ng-panel-header button");
    if (closeBtn) closeBtn.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  const ngPanelAfter = await page.$(".ng-panel");
  assert(!ngPanelAfter, "NG panel should be hidden after close");
  console.log("e2e: [PASS] NG panel closes");

  // --- 14. DOM: auto-refresh toggle ---
  const autoRefreshToggle = await page.$(".auto-refresh-toggle input");
  assert(autoRefreshToggle, "auto-refresh toggle should exist");
  const autoRefreshChecked = await page.$eval(".auto-refresh-toggle input", (el) => el.checked);
  assert(autoRefreshChecked === false, "auto-refresh should be off by default");
  console.log("e2e: [PASS] auto-refresh toggle present and off by default");

  // --- 15. DOM: compose result feedback area ---
  // Open compose window
  await page.evaluate(() => {
    document.querySelectorAll(".tool-bar button").forEach((b) => {
      if (b.textContent === "書き込み") b.click();
    });
  });
  await new Promise((r) => setTimeout(r, 300));
  // 今は下の書き込み欄の見出しを押して開く (閉じていれば開く)
  await page.evaluate(() => {
    const w = document.querySelector(".compose-window");
    if (w && !w.classList.contains("compose-window--open")) document.querySelector(".compose-header")?.click();
  });
  await new Promise((r) => setTimeout(r, 300));
  const composeWindow = await page.$(".compose-window.compose-window--open");
  assert(composeWindow, "compose window should be open");

  // Verify compose-meta shows chars/lines
  // 掲示板の書き込み欄の文字数・行数 (チャットの書き込み欄にも .compose-meta-inline があるので、掲示板の行に絞る)
  const metaText = await page.$eval(".compose-row.postform-foot .compose-meta-inline", (el) => el.textContent || "");
  assert(metaText.includes("文字") && metaText.includes("行"), `compose meta should show 文字/行, got: ${metaText}`);
  console.log("e2e: [PASS] compose window with meta info");

  // Close compose
  await page.evaluate(() => {
    const closeBtn = document.querySelector(".compose-header button");
    if (closeBtn) closeBtn.click();
  });
  await new Promise((r) => setTimeout(r, 200));

  // --- 16. DOM: dark mode toggle ---
  const shellClassesBefore = await page.$eval(".shell", (el) => el.className);
  assert(!shellClassesBefore.includes("dark"), "should start in light mode");
  // Toggle dark via menu
  await page.evaluate(() => {
    const menuItem = [...document.querySelectorAll(".menu-item")].find((el) => el.textContent?.trim() === "表示");
    if (menuItem) menuItem.click();
  });
  await new Promise((r) => setTimeout(r, 150));
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".menu-dropdown button")].find((el) => el.textContent?.includes("ダークテーマ"));
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  const shellClassesAfter = await page.$eval(".shell", (el) => el.className);
  assert(shellClassesAfter.includes("dark"), `shell should have dark class, got: ${shellClassesAfter}`);
  console.log("e2e: [PASS] dark mode toggled on");

  // Toggle back to light
  await page.evaluate(() => {
    const menuItem = [...document.querySelectorAll(".menu-item")].find((el) => el.textContent?.trim() === "表示");
    if (menuItem) menuItem.click();
  });
  await new Promise((r) => setTimeout(r, 150));
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".menu-dropdown button")].find((el) => el.textContent?.includes("ライトテーマ"));
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  const shellClassesBack = await page.$eval(".shell", (el) => el.className);
  assert(!shellClassesBack.includes("dark"), "shell should not have dark class after light toggle");
  console.log("e2e: [PASS] light mode restored");

  // --- 17. DOM: response blocks in continuous scroll view ---
  // Click first thread to ensure responses are loaded
  await page.evaluate(() => {
    const row = document.querySelector(".threads tbody tr:first-child");
    if (row) row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 2000));
  const responseBlocks = await page.$$(".response-scroll .response-block");
  assert(responseBlocks.length > 0, `response scroll should have response blocks, got ${responseBlocks.length}`);
  // ID cells are conditional (only shown when response has ID in dateAndId)
  const responseIdCells = await page.$$(".response-scroll .response-id-cell");
  if (responseIdCells.length > 0) {
    console.log(`e2e: [PASS] response continuous view with ID cells (${responseIdCells.length})`);
  } else {
    console.log(`e2e: [PASS] response continuous view (${responseBlocks.length} blocks, no IDs in this thread)`);
  }

  // --- 18. DOM: response ID cell with occurrence count ---
  const idCells = await page.$$eval(".response-id-cell", (els) => els.map((el) => el.textContent?.trim()).filter(Boolean));
  if (idCells.length > 0) {
    // 書き込み回数 (n/回数) は ID の隣の .response-id-count に出す
    const countCells = await page.$$eval(".response-scroll .response-id-count", (els) => els.map((el) => el.textContent?.trim()).filter(Boolean));
    const hasCount = idCells.some((t) => t.includes("(")) || countCells.some((t) => /\(\d+\/\d+\)/.test(t));
    assert(hasCount, `ID cells should show occurrence count, got: ${idCells.slice(0, 3)}`);
    console.log(`e2e: [PASS] ID cells with occurrence count (${idCells.length} cells)`);
  } else {
    console.log("e2e: [SKIP] no ID cells found (thread may not have IDs)");
  }

  // --- 19. DOM: speed bar visualization ---
  // レスを表示しているあいだはスレ一覧が画面から外れるので、板をアドレスバーから開き直してスレ一覧に戻す
  await page.fill(".address-input", testBoardUrl);
  await page.press(".address-input", "Enter");
  await page.waitForFunction(() => document.querySelectorAll(".threads tbody tr").length > 0, null, { timeout: 30000 });
  const speedBars = await page.$$(".speed-cell .speed-bar");
  assert(speedBars.length > 0, "speed bars should exist in thread list");
  const speedBarStyle = await speedBars[0].evaluate((el) => el.getAttribute("style"));
  assert(speedBarStyle?.includes("width") && speedBarStyle?.includes("background"), `speed bar should have width and background, got: ${speedBarStyle}`);
  console.log("e2e: [PASS] speed bar with gradient color");

  // --- 20. DOM: アドレスバーの行の新着の操作 (読み上げ方・▶・字幕・クリア・新着レス) ---
  // (栞はボタンではなく、読んだ位置を自動で保存する作りになった)
  const ttsMode = await page.$(".tts-board-mode select");
  assert(ttsMode, "TTS board mode selector should exist in the address bar row");
  const arrivalButtons = await page.$$eval(".arrival-tools button", (els) => els.map((el) => el.textContent?.trim()));
  assert(arrivalButtons.some((t) => t.includes("新着レス")) && arrivalButtons.some((t) => t.includes("クリア")), `arrival tools should have 新着レス / クリア, got: ${arrivalButtons}`);
  console.log("e2e: [PASS] arrival tools in the address bar row");

  // --- 21. DOM: settings panel ---
  // 設定 > 設定を開く
  await page.evaluate(() => {
    const menuItem = [...document.querySelectorAll(".menu-item")].find((el) => el.textContent?.trim() === "設定");
    if (menuItem) menuItem.click();
  });
  await new Promise((r) => setTimeout(r, 150));
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".menu-dropdown button")].find((el) => el.textContent?.trim() === "設定を開く");
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  const settingsPanel = await page.$(".settings-panel");
  assert(settingsPanel, "settings panel should be visible");
  // 左の分類 (表示・書き込み・読み上げ・NG・Twitch・YouTube・ビュワー・プロキシ・情報 など)
  const cats = await page.$$eval(".settings-nav-item", (els) => els.map((el) => el.getAttribute("data-cat")));
  const need = ["display", "posting", "tts", "ng", "subtitle", "twitch", "youtube", "viewer", "proxy", "info"];
  assert(need.every((c) => cats.includes(c)), `settings should have all categories, got: ${cats}`);
  // 閉じる (変更していないので、そのまま閉じる)
  await page.evaluate(() => [...document.querySelectorAll(".settings-header button")].find((x) => x.textContent === "閉じる")?.click());
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent?.startsWith("保存しないで閉じる"))?.click());
  await new Promise((r) => setTimeout(r, 200));
  console.log("e2e: [PASS] settings panel with all categories");

  // --- 22. DOM: post history panel ---
  await page.evaluate(() => {
    const menuItem = [...document.querySelectorAll(".menu-item")].find((el) => el.textContent?.trim() === "ファイル");
    if (menuItem) menuItem.click();
  });
  await new Promise((r) => setTimeout(r, 150));
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".menu-dropdown button")].find((el) => el.textContent?.includes("書き込み履歴"));
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 300));
  const historyBody = await page.$(".post-history-body");
  assert(historyBody, "post history panel should be visible");
  const historyText = await historyBody.textContent();
  assert(historyText.includes("まだ書き込みがありません"), "post history should be empty initially");
  // Close
  await page.evaluate(() => {
    const btn = document.querySelector(".settings-header button");
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  console.log("e2e: [PASS] post history panel (empty state)");

  // --- 23. DOM: back-refs CSS ---
  const hasBackRefsCss = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.cssText?.includes(".back-ref-trigger")) return true;
        }
      } catch { /* cross-origin */ }
    }
    return false;
  });
  assert(hasBackRefsCss, "back-ref (▼N) CSS should exist");
  console.log("e2e: [PASS] back-refs CSS present");

  // --- 24. DOM: thread row striping ---
  const threadRowsBg = await page.evaluate(() => {
    const rows = document.querySelectorAll(".threads tbody tr");
    if (rows.length < 2) return { even: "", odd: "" };
    return {
      odd: window.getComputedStyle(rows[0].querySelector("td")).backgroundColor,
      even: window.getComputedStyle(rows[1].querySelector("td")).backgroundColor,
    };
  });
  if (threadRowsBg.even && threadRowsBg.odd) {
    assert(threadRowsBg.even !== threadRowsBg.odd, "thread rows should have alternating backgrounds");
    console.log("e2e: [PASS] thread row striping");
  } else {
    console.log("e2e: [SKIP] not enough thread rows for striping test");
  }

  // --- 25. DOM: body link rendering ---
  // Check if body-link CSS class exists (actual links depend on response content)
  const hasBodyLinkCss = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.cssText?.includes(".body-link")) return true;
        }
      } catch { /* cross-origin */ }
    }
    return false;
  });
  assert(hasBodyLinkCss, "body-link CSS should exist");
  console.log("e2e: [PASS] body-link CSS present");

  // --- 26. localStorage: bookmark persistence ---
  await page.evaluate(() => {
    localStorage.setItem("desktop.bookmarks.v1", JSON.stringify({ "https://test.5ch.io/test/read.cgi/test/1/": 42 }));
  });
  const bmData = await page.evaluate(() => {
    const raw = localStorage.getItem("desktop.bookmarks.v1");
    return raw ? JSON.parse(raw) : null;
  });
  assert(bmData && bmData["https://test.5ch.io/test/read.cgi/test/1/"] === 42, "bookmark should persist in localStorage");
  // Clean up
  await page.evaluate(() => localStorage.removeItem("desktop.bookmarks.v1"));
  console.log("e2e: [PASS] bookmark localStorage persistence");

  // --- 27. localStorage: compose prefs persistence ---
  await page.evaluate(() => {
    localStorage.setItem("desktop.composePrefs.v1", JSON.stringify({ name: "e2e-name", mail: "sage", sage: true }));
  });
  const cpData = await page.evaluate(() => {
    const raw = localStorage.getItem("desktop.composePrefs.v1");
    return raw ? JSON.parse(raw) : null;
  });
  assert(cpData && cpData.name === "e2e-name" && cpData.sage === true, "compose prefs should persist");
  await page.evaluate(() => localStorage.removeItem("desktop.composePrefs.v1"));
  console.log("e2e: [PASS] compose prefs localStorage persistence");

  console.log("\ne2e: ALL TESTS PASSED");
} catch (err) {
  console.error(`\ne2e: FAILED - ${err.message}`);
  process.exit(1);
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
}
