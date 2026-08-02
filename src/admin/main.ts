import { onAuthStateChanged, signInWithPopup, signOut, GoogleAuthProvider } from "firebase/auth";
import type { User } from "firebase/auth";
import type { QueryDocumentSnapshot } from "firebase/firestore";
import { auth } from "../firebase";
import * as api from "./adminApi";
import type { Campaign } from "../types";

const app = document.querySelector<HTMLDivElement>("#admin-app")!;

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function fmtTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Every list tab shares the same date-range widget: two `<input type=date>`
 * fields (ids `${prefix}-date-from` / `${prefix}-date-to`) read at click
 * time — no separate draft state needed since nothing re-renders between
 * typing and clicking "套用". Empty fields mean "no bound" (see adminApi's
 * DateRange — no dates set = plain "最近 100 筆"). */
function renderDateRangeRow(prefix: string, fromVal: string, toVal: string, applyId: string): string {
  return `
    <div class="admin-row">
      <label class="admin-hint">從 <input id="${prefix}-date-from" type="date" class="admin-input" value="${escapeHtml(fromVal)}" /></label>
      <label class="admin-hint">到 <input id="${prefix}-date-to" type="date" class="admin-input" value="${escapeHtml(toVal)}" /></label>
      <button id="${applyId}" class="admin-btn admin-btn-secondary">套用日期篩選</button>
    </div>
  `;
}

function parseDateRange(prefix: string): { startMs?: number; endMs?: number } {
  const fromVal = document.querySelector<HTMLInputElement>(`#${prefix}-date-from`)?.value ?? "";
  const toVal = document.querySelector<HTMLInputElement>(`#${prefix}-date-to`)?.value ?? "";
  return {
    startMs: fromVal ? new Date(`${fromVal}T00:00:00`).getTime() : undefined,
    endMs: toVal ? new Date(`${toVal}T23:59:59.999`).getTime() : undefined,
  };
}

let currentUser: User | null = null;
let isAdmin: boolean | null = null;
let authChecking = true;
let signInError: string | null = null;

type AdminTab =
  | "orders"
  | "players"
  | "products"
  | "announcement"
  | "campaigns"
  | "disputes"
  | "webhooks"
  | "reconcile"
  | "audit";
const TABS: { id: AdminTab; label: string }[] = [
  { id: "orders", label: "訂單" },
  { id: "players", label: "玩家" },
  { id: "products", label: "商品" },
  { id: "announcement", label: "公告" },
  { id: "campaigns", label: "活動" },
  { id: "disputes", label: "爭議" },
  { id: "webhooks", label: "Webhook 紀錄" },
  { id: "reconcile", label: "對帳" },
  { id: "audit", label: "稽核紀錄" },
];
let activeTab: AdminTab = "orders";

// --- Orders tab ---
let orderIdInput = "";
let userIdForOrdersInput = "";
let orderNameSearchInput = "";
let orderNameMatchNote: string | null = null;
let orderDateFrom = "";
let orderDateTo = "";
let orderResults: api.AdminOrder[] = [];
let orderSearchError: string | null = null;
let ordersLoaded = false;
let refundOpenForOrderId: string | null = null;
let refundReasonDraft = "";
let refundPartialDraft = "";
let refundBusy = false;
let refundMessage: string | null = null;

// --- All Players tab (paginated browse — see api.fetchPlayersPage) ---
let allPlayersRows: api.PlayerSearchResult[] = [];
let allPlayersLoading = false;
let allPlayersLoaded = false;
let allPlayersError: string | null = null;
let allPlayersHasMore = false;
/** Cursor to fetch the CURRENT page (undefined = first page). Previous
 * pages are cursors[0..N-2]; popping this stack is how "上一頁" works
 * without a reverse query. */
let allPlayersCursor: QueryDocumentSnapshot | undefined;
let allPlayersCursorStack: (QueryDocumentSnapshot | undefined)[] = [];

// --- Players tab ---
let playerUidInput = "";
let playerNameSearchInput = "";
let playerNameSearchResults: api.PlayerSearchResult[] = [];
let playerNameSearchError: string | null = null;
let playerWallet: api.PlayerWallet | null = null;
let playerLedger: api.LedgerEntry[] = [];
let playerLookupError: string | null = null;
let ledgerDateFrom = "";
let ledgerDateTo = "";
let playerJobTitleHistory: api.JobTitleHistoryEntry[] = [];
let jobHistoryDateFrom = "";
let jobHistoryDateTo = "";
let playerActions: api.PlayerActionEntry[] = [];
let actionsDateFrom = "";
let actionsDateTo = "";
let adjustDeltaDraft = "";
let adjustReasonDraft = "";
let reviewReasonDraft = "";
let playerActionBusy = false;
let playerActionMessage: string | null = null;

// --- Products tab ---
let products: (api.AdminProduct)[] = [];
let productsLoaded = false;
let newProductDraft = { id: "", nameZh: "", nameEn: "", price: "", paidCoins: "" };
let productMessage: string | null = null;
let productBusyId: string | null = null;

// --- Announcement tab ---
let announcementDraft = { titleZh: "", titleEn: "", bodyZh: "", bodyEn: "", enabled: false, dismissible: true };
let announcementLoaded = false;
let announcementCurrentMeta: { id: string; updatedAt: number } | null = null;
let announcementMessage: string | null = null;
let announcementBusy = false;

// --- Campaigns tab ---
let campaigns: Campaign[] = [];
let campaignsLoaded = false;
let campaignMessage: string | null = null;
/** id of the campaign currently being saved/deleted, or "new" while
 * creating — disables just that row/button, not the whole tab. */
let campaignBusyId: string | null = null;
/** null = list view; "new" = create form; an existing campaign's id = edit
 * form for that campaign. */
let editingCampaignId: string | null = null;
let campaignDraft = {
  titleZh: "",
  titleEn: "",
  contentZh: "",
  contentEn: "",
  goalZh: "",
  goalEn: "",
  rulesZh: "",
  rulesEn: "",
  rewardZh: "",
  rewardEn: "",
  enabled: true,
};

// --- Disputes / webhooks / audit tabs ---
let disputes: api.Dispute[] = [];
let disputesLoaded = false;
let disputeDateFrom = "";
let disputeDateTo = "";
let webhookLogs: api.WebhookLog[] = [];
let webhookLogsLoaded = false;
let webhookDateFrom = "";
let webhookDateTo = "";
let adminActions: api.AdminActionLog[] = [];
let adminActionsLoaded = false;
let auditDateFrom = "";
let auditDateTo = "";

// --- Reconcile tab ---
let reconcileReport: Record<string, unknown[]> | null = null;
let reconcileBusy = false;
let reconcileError: string | null = null;

onAuthStateChanged(auth, async (user) => {
  currentUser = user && !user.isAnonymous ? user : null;
  if (currentUser) {
    try {
      isAdmin = await api.isCurrentUserAdmin(currentUser.uid);
    } catch {
      isAdmin = false;
    }
  } else {
    isAdmin = null;
  }
  authChecking = false;
  render();
});

async function handleSignIn() {
  signInError = null;
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    signInError = (err as Error).message;
    render();
  }
}

function render() {
  if (authChecking) {
    app.innerHTML = `<div class="admin-wrap"><p>載入中…</p></div>`;
    return;
  }
  if (!currentUser) {
    app.innerHTML = `
      <div class="admin-wrap admin-gate">
        <h1>工作大小事 · 管理後台</h1>
        <p class="admin-hint">請用管理員的 Google 帳號登入。</p>
        ${signInError ? `<p class="admin-error">${escapeHtml(signInError)}</p>` : ""}
        <button id="admin-signin-btn" class="admin-btn">登入 Google 帳號</button>
      </div>
    `;
    document.querySelector<HTMLButtonElement>("#admin-signin-btn")?.addEventListener("click", handleSignIn);
    return;
  }
  if (isAdmin === false) {
    app.innerHTML = `
      <div class="admin-wrap admin-gate">
        <h1>沒有權限</h1>
        <p>帳號 ${escapeHtml(currentUser.email ?? currentUser.uid)} 沒有管理權限。</p>
        <button id="admin-signout-btn" class="admin-btn admin-btn-secondary">登出</button>
      </div>
    `;
    document.querySelector<HTMLButtonElement>("#admin-signout-btn")?.addEventListener("click", () => signOut(auth));
    return;
  }
  if (isAdmin === null) {
    app.innerHTML = `<div class="admin-wrap"><p>確認權限中…</p></div>`;
    return;
  }

  app.innerHTML = `
    <div class="admin-wrap">
      <div class="admin-header">
        <h1>工作大小事 · 管理後台</h1>
        <div>
          <span class="admin-hint">${escapeHtml(currentUser.email ?? currentUser.uid)}</span>
          <button id="admin-signout-btn" class="admin-btn admin-btn-secondary">登出</button>
        </div>
      </div>
      <div class="admin-tabs">
        ${TABS.map(
          (tab) =>
            `<button class="admin-tab-btn ${activeTab === tab.id ? "active" : ""}" data-tab="${tab.id}">${tab.label}</button>`
        ).join("")}
      </div>
      <div id="admin-tab-content">${renderActiveTab()}</div>
    </div>
  `;

  document.querySelector<HTMLButtonElement>("#admin-signout-btn")?.addEventListener("click", () => signOut(auth));
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab as AdminTab;
      render();
    });
  });

  attachTabHandlers();
  loadDataForActiveTab();
}

function renderActiveTab(): string {
  switch (activeTab) {
    case "orders":
      return renderOrdersTab();
    case "players":
      return renderPlayersTab();
    case "products":
      return renderProductsTab();
    case "announcement":
      return renderAnnouncementTab();
    case "campaigns":
      return renderCampaignsTab();
    case "disputes":
      return renderDisputesTab();
    case "webhooks":
      return renderWebhooksTab();
    case "reconcile":
      return renderReconcileTab();
    case "audit":
      return renderAuditTab();
  }
}

function loadDataForActiveTab() {
  if (activeTab === "orders" && !ordersLoaded) loadRecentOrders();
  if (activeTab === "players" && !allPlayersLoaded) loadAllPlayersPage();
  if (activeTab === "products" && !productsLoaded) loadProducts();
  if (activeTab === "announcement" && !announcementLoaded) loadAnnouncement();
  if (activeTab === "campaigns" && !campaignsLoaded) loadCampaigns();
  if (activeTab === "disputes" && !disputesLoaded) loadDisputes();
  if (activeTab === "webhooks" && !webhookLogsLoaded) loadWebhookLogs();
  if (activeTab === "audit" && !adminActionsLoaded) loadAdminActions();
}

// ==================== Orders ====================

async function loadRecentOrders() {
  orderSearchError = null;
  try {
    orderResults = await api.queryOrders({});
  } catch (err) {
    orderSearchError = (err as Error).message;
  }
  ordersLoaded = true;
  render();
}

function renderOrdersTab(): string {
  return `
    <div class="admin-section">
      <h2>查詢訂單</h2>
      <p class="admin-hint">預設顯示最近 100 筆訂單;可用日期篩選,或用下方欄位一鍵查特定訂單/玩家(含入職名稱)。</p>
      ${renderDateRangeRow("order", orderDateFrom, orderDateTo, "order-date-apply-btn")}
      <div class="admin-row">
        <input id="order-name-input" class="admin-input" placeholder="入職名稱" value="${escapeHtml(orderNameSearchInput)}" />
        <button id="order-name-search-btn" class="admin-btn">查詢該玩家所有訂單(套用日期篩選)</button>
      </div>
      ${orderNameMatchNote ? `<p class="admin-hint">${escapeHtml(orderNameMatchNote)}</p>` : ""}
      <div class="admin-row">
        <input id="order-id-input" class="admin-input" placeholder="訂單編號 (orderId)" value="${escapeHtml(orderIdInput)}" />
        <button id="order-id-search-btn" class="admin-btn">查詢單筆</button>
      </div>
      <div class="admin-row">
        <input id="order-userid-input" class="admin-input" placeholder="玩家 UID" value="${escapeHtml(userIdForOrdersInput)}" />
        <button id="order-userid-search-btn" class="admin-btn">查詢該玩家所有訂單(套用日期篩選)</button>
      </div>
      ${orderSearchError ? `<p class="admin-error">${escapeHtml(orderSearchError)}</p>` : ""}
      ${refundMessage ? `<p class="admin-notice">${escapeHtml(refundMessage)}</p>` : ""}
      ${renderOrdersTable()}
    </div>
  `;
}

function renderOrdersTable(): string {
  if (orderResults.length === 0) return `<p class="admin-hint">尚無查詢結果</p>`;
  return `
    <table class="admin-table">
      <thead>
        <tr><th>訂單</th><th>狀態</th><th>金額</th><th>加班費</th><th>玩家</th><th>建立時間</th><th>操作</th></tr>
      </thead>
      <tbody>
        ${orderResults
          .map((o) => {
            const canRefund = o.status === "CREDITED" || o.status === "PARTIALLY_REFUNDED";
            return `
              <tr>
                <td>${escapeHtml(o.orderId)}${o.failureReason ? `<br/><span class="admin-hint">${escapeHtml(o.failureReason)}</span>` : ""}</td>
                <td>${escapeHtml(o.status)}</td>
                <td>${o.currency} ${o.amount}</td>
                <td>${o.paidCoins}</td>
                <td>${escapeHtml(o.userId)}</td>
                <td>${fmtTime(o.createdAt)}</td>
                <td>${
                  canRefund
                    ? `<button class="admin-btn admin-btn-secondary" data-refund-open="${escapeHtml(o.orderId)}">退款</button>`
                    : ""
                }</td>
              </tr>
              ${refundOpenForOrderId === o.orderId ? renderRefundForm(o) : ""}
            `;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

function renderRefundForm(order: api.AdminOrder): string {
  return `
    <tr>
      <td colspan="7">
        <div class="admin-row">
          <input id="refund-reason-input" class="admin-input" placeholder="退款原因(必填)" value="${escapeHtml(refundReasonDraft)}" />
          <input id="refund-partial-input" class="admin-input" placeholder="部分退款金額(留空 = 全額退款 ${order.amount})" value="${escapeHtml(refundPartialDraft)}" />
          <button id="refund-submit-btn" class="admin-btn admin-btn-danger" ${refundBusy ? "disabled" : ""}>${refundBusy ? "處理中…" : "確認退款"}</button>
          <button id="refund-cancel-btn" class="admin-btn admin-btn-secondary">取消</button>
        </div>
      </td>
    </tr>
  `;
}

async function loadOrdersForUser(uid: string) {
  userIdForOrdersInput = uid;
  orderIdInput = "";
  orderNameMatchNote = null;
  orderSearchError = null;
  const { startMs, endMs } = parseDateRange("order");
  orderDateFrom = document.querySelector<HTMLInputElement>("#order-date-from")?.value ?? orderDateFrom;
  orderDateTo = document.querySelector<HTMLInputElement>("#order-date-to")?.value ?? orderDateTo;
  try {
    orderResults = await api.queryOrders({ userId: uid, startMs, endMs });
  } catch (err) {
    orderSearchError = (err as Error).message;
    orderResults = [];
  }
  render();
}

/** Firestore has no cross-collection joins — orders store `userId`, not
 * `playerName` — so "search orders by name" is necessarily two reads under
 * the hood (name -> matching uids, then orders for those uids). This
 * collapses it into a single click/request from the admin's point of view:
 * no intermediate "pick a player" step, matching orders just appear. */
async function searchOrdersByPlayerName(namePrefix: string) {
  orderIdInput = "";
  userIdForOrdersInput = "";
  orderSearchError = null;
  orderNameMatchNote = null;
  const { startMs, endMs } = parseDateRange("order");
  orderDateFrom = document.querySelector<HTMLInputElement>("#order-date-from")?.value ?? orderDateFrom;
  orderDateTo = document.querySelector<HTMLInputElement>("#order-date-to")?.value ?? orderDateTo;
  try {
    const matches = await api.searchPlayersByName(namePrefix);
    if (matches.length === 0) {
      orderSearchError = "查無符合的入職名稱";
      orderResults = [];
      render();
      return;
    }
    const perPlayer = await Promise.all(matches.map((m) => api.queryOrders({ userId: m.uid, startMs, endMs })));
    orderResults = perPlayer
      .flat()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100);
    orderNameMatchNote =
      matches.length > 1
        ? `符合「${namePrefix}」的入職名稱共 ${matches.length} 位玩家(${matches.map((m) => m.playerName).join("、")}),已合併顯示訂單`
        : `符合玩家:${matches[0].playerName}(${matches[0].uid})`;
  } catch (err) {
    orderSearchError = (err as Error).message;
    orderResults = [];
  }
  render();
}

function attachOrdersTabHandlers() {
  document.querySelector<HTMLButtonElement>("#order-name-search-btn")?.addEventListener("click", async () => {
    const input = document.querySelector<HTMLInputElement>("#order-name-input");
    orderNameSearchInput = input?.value.trim() ?? "";
    if (!orderNameSearchInput) return;
    await searchOrdersByPlayerName(orderNameSearchInput);
  });

  document.querySelector<HTMLButtonElement>("#order-id-search-btn")?.addEventListener("click", async () => {
    const input = document.querySelector<HTMLInputElement>("#order-id-input");
    orderIdInput = input?.value.trim() ?? "";
    if (!orderIdInput) return;
    orderSearchError = null;
    orderNameMatchNote = null;
    try {
      orderResults = await api.queryOrders({ orderId: orderIdInput });
      if (orderResults.length === 0) orderSearchError = "查無此訂單";
    } catch (err) {
      orderSearchError = (err as Error).message;
      orderResults = [];
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#order-userid-search-btn")?.addEventListener("click", async () => {
    const input = document.querySelector<HTMLInputElement>("#order-userid-input");
    const uid = input?.value.trim() ?? "";
    if (!uid) return;
    await loadOrdersForUser(uid);
  });

  document.querySelector<HTMLButtonElement>("#order-date-apply-btn")?.addEventListener("click", async () => {
    orderSearchError = null;
    orderNameMatchNote = null;
    orderIdInput = "";
    userIdForOrdersInput = "";
    const { startMs, endMs } = parseDateRange("order");
    orderDateFrom = document.querySelector<HTMLInputElement>("#order-date-from")?.value ?? "";
    orderDateTo = document.querySelector<HTMLInputElement>("#order-date-to")?.value ?? "";
    try {
      orderResults = await api.queryOrders({ startMs, endMs });
    } catch (err) {
      orderSearchError = (err as Error).message;
      orderResults = [];
    }
    render();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-refund-open]").forEach((btn) => {
    btn.addEventListener("click", () => {
      refundOpenForOrderId = btn.dataset.refundOpen ?? null;
      refundReasonDraft = "";
      refundPartialDraft = "";
      refundMessage = null;
      render();
    });
  });

  document.querySelector<HTMLButtonElement>("#refund-cancel-btn")?.addEventListener("click", () => {
    refundOpenForOrderId = null;
    render();
  });

  document.querySelector<HTMLButtonElement>("#refund-submit-btn")?.addEventListener("click", async () => {
    const reasonInput = document.querySelector<HTMLInputElement>("#refund-reason-input");
    const partialInput = document.querySelector<HTMLInputElement>("#refund-partial-input");
    refundReasonDraft = reasonInput?.value.trim() ?? "";
    refundPartialDraft = partialInput?.value.trim() ?? "";
    if (!refundReasonDraft || !refundOpenForOrderId) return;
    refundBusy = true;
    render();
    try {
      const partialAmount = refundPartialDraft ? Number(refundPartialDraft) : undefined;
      const result = await api.adminRefundOrder(refundOpenForOrderId, refundReasonDraft, partialAmount);
      refundMessage = `退款完成:扣回 ${result.clawedBackPaid} 點加班費${result.shortfall > 0 ? `(有 ${result.shortfall} 點無法扣回,已標記複查)` : ""}`;
      orderResults = orderResults.map((o) => (o.orderId === result.order.orderId ? result.order : o));
      refundOpenForOrderId = null;
    } catch (err) {
      refundMessage = `退款失敗:${(err as Error).message}`;
    }
    refundBusy = false;
    render();
  });
}

// ==================== Players ====================

function renderPlayersTab(): string {
  const review = playerWallet?.paymentReview;
  return `
    <div class="admin-section">
      <h2>查詢玩家</h2>
      <p class="admin-hint">不知道 UID 的話,可以先用入職名稱搜尋(前綴比對,不分大小寫)。</p>
      <div class="admin-row">
        <input id="player-name-input" class="admin-input" placeholder="入職名稱" value="${escapeHtml(playerNameSearchInput)}" />
        <button id="player-name-search-btn" class="admin-btn">依名稱搜尋</button>
      </div>
      ${playerNameSearchError ? `<p class="admin-error">${escapeHtml(playerNameSearchError)}</p>` : ""}
      ${
        playerNameSearchResults.length > 0
          ? `
        <table class="admin-table">
          <thead><tr><th>入職名稱</th><th>UID</th><th>加班費餘額</th><th></th></tr></thead>
          <tbody>
            ${playerNameSearchResults
              .map(
                (p) => `
              <tr>
                <td>${escapeHtml(p.playerName)}</td>
                <td>${escapeHtml(p.uid)}</td>
                <td>${p.paidCoinBalance}</td>
                <td><button class="admin-btn admin-btn-secondary" data-select-player="${escapeHtml(p.uid)}">查看</button></td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      `
          : ""
      }
      <div class="admin-row">
        <input id="player-uid-input" class="admin-input" placeholder="玩家 UID" value="${escapeHtml(playerUidInput)}" />
        <button id="player-uid-search-btn" class="admin-btn">查詢</button>
      </div>
      ${playerLookupError ? `<p class="admin-error">${escapeHtml(playerLookupError)}</p>` : ""}
      ${playerActionMessage ? `<p class="admin-notice">${escapeHtml(playerActionMessage)}</p>` : ""}
      ${
        playerWallet
          ? `
        <div class="admin-row"><strong>入職名稱:</strong> ${escapeHtml(playerWallet.playerName ?? "—")}</div>
        <div class="admin-row"><strong>加班費餘額:</strong> ${playerWallet.paidCoinBalance ?? 0}</div>
        <div class="admin-row"><strong>複查狀態:</strong> ${
          review?.underReview
            ? `<span class="admin-error">複查中 — ${escapeHtml(review.reason ?? "")}(${fmtTime(review.setAt)})</span>`
            : `<span class="admin-notice">正常</span>`
        }</div>

        <div class="admin-row">
          <input id="adjust-delta-input" class="admin-input" placeholder="調整數量(正數增加/負數扣除)" value="${escapeHtml(adjustDeltaDraft)}" />
          <input id="adjust-reason-input" class="admin-input" placeholder="調整原因(必填)" value="${escapeHtml(adjustReasonDraft)}" />
          <button id="adjust-submit-btn" class="admin-btn" ${playerActionBusy ? "disabled" : ""}>${playerActionBusy ? "處理中…" : "調整加班費"}</button>
        </div>

        <div class="admin-row">
          <input id="review-reason-input" class="admin-input" placeholder="設定複查原因" value="${escapeHtml(reviewReasonDraft)}" />
          <button id="review-set-btn" class="admin-btn admin-btn-danger" ${playerActionBusy ? "disabled" : ""}>設定為複查中</button>
          <button id="review-clear-btn" class="admin-btn admin-btn-secondary" ${playerActionBusy ? "disabled" : ""}>解除複查</button>
        </div>

        <h2>加班費帳本</h2>
        <p class="admin-hint">預設最近 100 筆,可用日期篩選。</p>
        ${renderDateRangeRow("ledger", ledgerDateFrom, ledgerDateTo, "ledger-date-apply-btn")}
        <table class="admin-table">
          <thead><tr><th>時間</th><th>類型</th><th>變動</th><th>餘額</th><th>說明</th></tr></thead>
          <tbody>
            ${playerLedger
              .map(
                (l) => `
              <tr>
                <td>${fmtTime(l.createdAt)}</td>
                <td>${escapeHtml(l.transactionType)}</td>
                <td>${l.paidCoinDelta > 0 ? "+" : ""}${l.paidCoinDelta}</td>
                <td>${l.paidBalanceAfter}</td>
                <td>${escapeHtml(l.description)}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>

        <h2>職稱歷程</h2>
        <p class="admin-hint">預設最近 100 筆,可用日期篩選。</p>
        ${renderDateRangeRow("job-history", jobHistoryDateFrom, jobHistoryDateTo, "job-history-date-apply-btn")}
        <table class="admin-table">
          <thead><tr><th>時間</th><th>從</th><th>到</th><th>觸發事件</th></tr></thead>
          <tbody>
            ${playerJobTitleHistory
              .map(
                (h) => `
              <tr>
                <td>${fmtTime(h.at)}</td>
                <td>${escapeHtml(h.fromTitle.zh)}</td>
                <td>${escapeHtml(h.toTitle.zh)}</td>
                <td>${escapeHtml(h.viaEventTitle.zh)}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>

        <h2>行為紀錄</h2>
        <p class="admin-hint">每一次嘗試都會記錄一筆,包含重複玩到同一組合的情況。預設最近 100 筆,可用日期篩選。</p>
        ${renderDateRangeRow("actions", actionsDateFrom, actionsDateTo, "actions-date-apply-btn")}
        <table class="admin-table">
          <thead><tr><th>時間</th><th>當時職稱</th><th>事件標題</th><th>來源</th><th>是否觸發異動</th></tr></thead>
          <tbody>
            ${playerActions
              .map(
                (a) => `
              <tr>
                <td>${fmtTime(a.at)}</td>
                <td>${escapeHtml(a.jobTitleAtTime.zh)}</td>
                <td>${escapeHtml(a.eventTitle.zh)}</td>
                <td>${a.source === "cached" ? "快取" : "新生成"}</td>
                <td>${a.newJobTitle ? `✅ → ${escapeHtml(a.newJobTitle.zh)}` : "—"}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      `
          : ""
      }
    </div>

    ${renderAllPlayersSection()}
  `;
}

function ledgerRangeFromState(): { startMs?: number; endMs?: number } {
  return {
    startMs: ledgerDateFrom ? new Date(`${ledgerDateFrom}T00:00:00`).getTime() : undefined,
    endMs: ledgerDateTo ? new Date(`${ledgerDateTo}T23:59:59.999`).getTime() : undefined,
  };
}

async function loadPlayer(uid: string) {
  playerUidInput = uid;
  playerLookupError = null;
  playerActionMessage = null;
  ledgerDateFrom = "";
  ledgerDateTo = "";
  jobHistoryDateFrom = "";
  jobHistoryDateTo = "";
  actionsDateFrom = "";
  actionsDateTo = "";
  try {
    playerWallet = await api.fetchPlayerWallet(uid);
    playerLedger = await api.fetchPlayerLedger(uid);
    playerJobTitleHistory = await api.fetchPlayerJobTitleHistory(uid);
    playerActions = await api.fetchPlayerActions(uid);
    if (!playerWallet) playerLookupError = "找不到這個玩家";
  } catch (err) {
    playerLookupError = (err as Error).message;
  }
  render();
}

function attachPlayersTabHandlers() {
  document.querySelector<HTMLButtonElement>("#player-name-search-btn")?.addEventListener("click", async () => {
    const input = document.querySelector<HTMLInputElement>("#player-name-input");
    playerNameSearchInput = input?.value.trim() ?? "";
    if (!playerNameSearchInput) return;
    playerNameSearchError = null;
    try {
      playerNameSearchResults = await api.searchPlayersByName(playerNameSearchInput);
      if (playerNameSearchResults.length === 0) playerNameSearchError = "查無符合的入職名稱";
    } catch (err) {
      playerNameSearchError = (err as Error).message;
      playerNameSearchResults = [];
    }
    render();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-select-player]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = btn.dataset.selectPlayer;
      if (uid) loadPlayer(uid);
    });
  });

  document.querySelector<HTMLButtonElement>("#player-uid-search-btn")?.addEventListener("click", async () => {
    const input = document.querySelector<HTMLInputElement>("#player-uid-input");
    const uid = input?.value.trim() ?? "";
    if (!uid) return;
    await loadPlayer(uid);
  });

  document.querySelector<HTMLButtonElement>("#ledger-date-apply-btn")?.addEventListener("click", async () => {
    if (!playerUidInput) return;
    const { startMs, endMs } = parseDateRange("ledger");
    ledgerDateFrom = document.querySelector<HTMLInputElement>("#ledger-date-from")?.value ?? "";
    ledgerDateTo = document.querySelector<HTMLInputElement>("#ledger-date-to")?.value ?? "";
    try {
      playerLedger = await api.fetchPlayerLedger(playerUidInput, { startMs, endMs });
    } catch (err) {
      playerLookupError = (err as Error).message;
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#job-history-date-apply-btn")?.addEventListener("click", async () => {
    if (!playerUidInput) return;
    const { startMs, endMs } = parseDateRange("job-history");
    jobHistoryDateFrom = document.querySelector<HTMLInputElement>("#job-history-date-from")?.value ?? "";
    jobHistoryDateTo = document.querySelector<HTMLInputElement>("#job-history-date-to")?.value ?? "";
    try {
      playerJobTitleHistory = await api.fetchPlayerJobTitleHistory(playerUidInput, { startMs, endMs });
    } catch (err) {
      playerLookupError = (err as Error).message;
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#actions-date-apply-btn")?.addEventListener("click", async () => {
    if (!playerUidInput) return;
    const { startMs, endMs } = parseDateRange("actions");
    actionsDateFrom = document.querySelector<HTMLInputElement>("#actions-date-from")?.value ?? "";
    actionsDateTo = document.querySelector<HTMLInputElement>("#actions-date-to")?.value ?? "";
    try {
      playerActions = await api.fetchPlayerActions(playerUidInput, { startMs, endMs });
    } catch (err) {
      playerLookupError = (err as Error).message;
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#adjust-submit-btn")?.addEventListener("click", async () => {
    const deltaInput = document.querySelector<HTMLInputElement>("#adjust-delta-input");
    const reasonInput = document.querySelector<HTMLInputElement>("#adjust-reason-input");
    adjustDeltaDraft = deltaInput?.value.trim() ?? "";
    adjustReasonDraft = reasonInput?.value.trim() ?? "";
    const delta = Number(adjustDeltaDraft);
    if (!Number.isInteger(delta) || !adjustReasonDraft || !playerUidInput) return;
    playerActionBusy = true;
    render();
    try {
      const result = await api.adminAdjustCoins(playerUidInput, delta, adjustReasonDraft);
      playerActionMessage = `調整完成,目前餘額 ${result.paidCoinBalance}`;
      playerWallet = await api.fetchPlayerWallet(playerUidInput);
      playerLedger = await api.fetchPlayerLedger(playerUidInput, ledgerRangeFromState());
      adjustDeltaDraft = "";
      adjustReasonDraft = "";
    } catch (err) {
      playerActionMessage = `調整失敗:${(err as Error).message}`;
    }
    playerActionBusy = false;
    render();
  });

  document.querySelector<HTMLButtonElement>("#review-set-btn")?.addEventListener("click", async () => {
    const reasonInput = document.querySelector<HTMLInputElement>("#review-reason-input");
    reviewReasonDraft = reasonInput?.value.trim() ?? "";
    if (!reviewReasonDraft || !playerUidInput) return;
    playerActionBusy = true;
    render();
    try {
      await api.adminSetPaymentReview(playerUidInput, true, reviewReasonDraft);
      playerActionMessage = "已設定為複查中";
      playerWallet = await api.fetchPlayerWallet(playerUidInput);
      reviewReasonDraft = "";
    } catch (err) {
      playerActionMessage = `設定失敗:${(err as Error).message}`;
    }
    playerActionBusy = false;
    render();
  });

  document.querySelector<HTMLButtonElement>("#review-clear-btn")?.addEventListener("click", async () => {
    if (!playerUidInput) return;
    playerActionBusy = true;
    render();
    try {
      await api.adminSetPaymentReview(playerUidInput, false, "管理員手動解除");
      playerActionMessage = "已解除複查";
      playerWallet = await api.fetchPlayerWallet(playerUidInput);
    } catch (err) {
      playerActionMessage = `解除失敗:${(err as Error).message}`;
    }
    playerActionBusy = false;
    render();
  });
}

// ==================== All Players (paginated) ====================

/** `cursor: undefined` = first page; a defined cursor fetches whatever page
 * follows it. Always call this rather than assigning allPlayersRows
 * directly, so loading/error state and the cursor stack stay consistent. */
async function loadAllPlayersPage(cursor?: QueryDocumentSnapshot) {
  // No render() here before the await — render() unconditionally calls
  // loadDataForActiveTab() at its end, which would call straight back into
  // this same function (allPlayersLoaded is still false) before the first
  // await ever yields, recursing synchronously until the stack overflows.
  // Every other tab's loader in this file follows the same rule.
  allPlayersLoading = true;
  allPlayersError = null;
  try {
    const page = await api.fetchPlayersPage(cursor);
    allPlayersRows = page.players;
    allPlayersHasMore = page.hasMore;
    allPlayersCursor = page.lastDoc ?? undefined;
  } catch (err) {
    allPlayersError = (err as Error).message;
  }
  allPlayersLoading = false;
  allPlayersLoaded = true;
  render();
}

function renderAllPlayersSection(): string {
  return `
    <div class="admin-section">
      <h2>所有玩家(第 ${allPlayersCursorStack.length + 1} 頁,每頁 50 筆)</h2>
      <p class="admin-hint">依 UID 排序分頁瀏覽,不會一次載入全部玩家。要找特定人,用上面的名稱/UID 搜尋更快。</p>
      ${allPlayersError ? `<p class="admin-error">${escapeHtml(allPlayersError)}</p>` : ""}
      ${allPlayersLoading ? `<p>載入中…</p>` : ""}
      <table class="admin-table">
        <thead><tr><th>UID</th><th>入職名稱</th><th>加班費餘額</th><th></th></tr></thead>
        <tbody>
          ${
            allPlayersRows.length === 0 && !allPlayersLoading
              ? `<tr><td colspan="4">沒有玩家資料</td></tr>`
              : allPlayersRows
                  .map(
                    (p) => `
            <tr>
              <td>${escapeHtml(p.uid)}</td>
              <td>${escapeHtml(p.playerName || "(未設定)")}</td>
              <td>${p.paidCoinBalance}</td>
              <td><button class="admin-btn admin-btn-secondary" data-select-all-player="${escapeHtml(p.uid)}">查看</button></td>
            </tr>
          `
                  )
                  .join("")
          }
        </tbody>
      </table>
      <div class="admin-row">
        <button id="all-players-prev-btn" class="admin-btn admin-btn-secondary" ${allPlayersCursorStack.length === 0 || allPlayersLoading ? "disabled" : ""}>上一頁</button>
        <button id="all-players-next-btn" class="admin-btn admin-btn-secondary" ${!allPlayersHasMore || allPlayersLoading ? "disabled" : ""}>下一頁</button>
      </div>
    </div>
  `;
}

function attachAllPlayersTabHandlers() {
  document.querySelectorAll<HTMLButtonElement>("[data-select-all-player]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = btn.dataset.selectAllPlayer;
      if (!uid) return;
      activeTab = "players";
      render();
      loadPlayer(uid);
    });
  });

  document.querySelector<HTMLButtonElement>("#all-players-next-btn")?.addEventListener("click", () => {
    if (!allPlayersHasMore || !allPlayersCursor) return;
    allPlayersCursorStack.push(allPlayersCursor);
    loadAllPlayersPage(allPlayersCursor);
  });

  document.querySelector<HTMLButtonElement>("#all-players-prev-btn")?.addEventListener("click", () => {
    if (allPlayersCursorStack.length === 0) return;
    // Pop the cursor that got us to the CURRENT page, then use whatever's
    // now on top (or none, for page 1) to re-fetch the page before it.
    allPlayersCursorStack.pop();
    const prevCursor = allPlayersCursorStack[allPlayersCursorStack.length - 1];
    loadAllPlayersPage(prevCursor);
  });
}

// ==================== Products ====================

async function loadProducts() {
  products = await api.fetchAllProducts();
  productsLoaded = true;
  render();
}

function renderProductsTab(): string {
  if (!productsLoaded) return `<div class="admin-section"><p>載入中…</p></div>`;
  return `
    <div class="admin-section">
      <h2>商品清單</h2>
      ${productMessage ? `<p class="admin-notice">${escapeHtml(productMessage)}</p>` : ""}
      <table class="admin-table">
        <thead><tr><th>ID</th><th>名稱(中)</th><th>名稱(英)</th><th>價格 NT$</th><th>加班費</th><th>啟用</th><th></th></tr></thead>
        <tbody>
          ${products
            .map(
              (p) => `
            <tr data-product-row="${escapeHtml(p.id)}">
              <td>${escapeHtml(p.id)}</td>
              <td><input class="admin-input" data-field="nameZh" value="${escapeHtml(p.name.zh)}" /></td>
              <td><input class="admin-input" data-field="nameEn" value="${escapeHtml(p.name.en)}" /></td>
              <td><input class="admin-input" data-field="price" type="number" value="${p.price}" style="width:80px" /></td>
              <td><input class="admin-input" data-field="paidCoins" type="number" value="${p.paidCoins}" style="width:80px" /></td>
              <td><input type="checkbox" data-field="enabled" ${p.enabled ? "checked" : ""} /></td>
              <td><button class="admin-btn admin-btn-secondary" data-save-product="${escapeHtml(p.id)}" ${productBusyId === p.id ? "disabled" : ""}>儲存</button></td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>

      <h2>新增商品</h2>
      <div class="admin-row">
        <input id="new-product-id" class="admin-input" placeholder="商品 ID(英數,唯一)" value="${escapeHtml(newProductDraft.id)}" />
        <input id="new-product-name-zh" class="admin-input" placeholder="名稱(中)" value="${escapeHtml(newProductDraft.nameZh)}" />
        <input id="new-product-name-en" class="admin-input" placeholder="名稱(英)" value="${escapeHtml(newProductDraft.nameEn)}" />
        <input id="new-product-price" class="admin-input" placeholder="價格 NT$" type="number" value="${escapeHtml(newProductDraft.price)}" />
        <input id="new-product-coins" class="admin-input" placeholder="加班費數量" type="number" value="${escapeHtml(newProductDraft.paidCoins)}" />
        <button id="new-product-submit-btn" class="admin-btn">新增</button>
      </div>
    </div>
  `;
}

function attachProductsTabHandlers() {
  document.querySelectorAll<HTMLButtonElement>("[data-save-product]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.saveProduct!;
      const row = document.querySelector<HTMLTableRowElement>(`[data-product-row="${CSS.escape(id)}"]`);
      if (!row) return;
      const nameZh = row.querySelector<HTMLInputElement>('[data-field="nameZh"]')!.value;
      const nameEn = row.querySelector<HTMLInputElement>('[data-field="nameEn"]')!.value;
      const price = Number(row.querySelector<HTMLInputElement>('[data-field="price"]')!.value);
      const paidCoins = Number(row.querySelector<HTMLInputElement>('[data-field="paidCoins"]')!.value);
      const enabled = row.querySelector<HTMLInputElement>('[data-field="enabled"]')!.checked;
      const existing = products.find((p) => p.id === id)!;
      productBusyId = id;
      render();
      try {
        await api.saveProduct(id, {
          productCode: existing.productCode,
          name: { zh: nameZh, en: nameEn },
          currency: existing.currency,
          price,
          paidCoins,
          enabled,
          createdAt: existing.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        });
        productMessage = `${id} 已儲存`;
        products = await api.fetchAllProducts();
      } catch (err) {
        productMessage = `儲存失敗:${(err as Error).message}`;
      }
      productBusyId = null;
      render();
    });
  });

  document.querySelector<HTMLButtonElement>("#new-product-submit-btn")?.addEventListener("click", async () => {
    newProductDraft = {
      id: document.querySelector<HTMLInputElement>("#new-product-id")?.value.trim() ?? "",
      nameZh: document.querySelector<HTMLInputElement>("#new-product-name-zh")?.value.trim() ?? "",
      nameEn: document.querySelector<HTMLInputElement>("#new-product-name-en")?.value.trim() ?? "",
      price: document.querySelector<HTMLInputElement>("#new-product-price")?.value.trim() ?? "",
      paidCoins: document.querySelector<HTMLInputElement>("#new-product-coins")?.value.trim() ?? "",
    };
    if (!newProductDraft.id || !newProductDraft.nameZh || !newProductDraft.nameEn) return;
    try {
      await api.saveProduct(newProductDraft.id, {
        productCode: newProductDraft.id.toUpperCase(),
        name: { zh: newProductDraft.nameZh, en: newProductDraft.nameEn },
        currency: "TWD",
        price: Number(newProductDraft.price) || 0,
        paidCoins: Number(newProductDraft.paidCoins) || 0,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      productMessage = `${newProductDraft.id} 已新增`;
      newProductDraft = { id: "", nameZh: "", nameEn: "", price: "", paidCoins: "" };
      products = await api.fetchAllProducts();
    } catch (err) {
      productMessage = `新增失敗:${(err as Error).message}`;
    }
    render();
  });
}

// ==================== Announcement ====================

async function loadAnnouncement() {
  const current = await api.fetchAnnouncement();
  if (current) {
    announcementDraft = {
      titleZh: current.title.zh,
      titleEn: current.title.en,
      bodyZh: current.body.zh,
      bodyEn: current.body.en,
      enabled: current.enabled,
      dismissible: current.dismissible,
    };
    announcementCurrentMeta = { id: current.id, updatedAt: current.updatedAt };
  }
  announcementLoaded = true;
  render();
}

function renderAnnouncementTab(): string {
  if (!announcementLoaded) return `<div class="admin-section"><p>載入中…</p></div>`;
  return `
    <div class="admin-section">
      <h2>進場公告</h2>
      ${
        announcementCurrentMeta
          ? `<p class="admin-hint">目前版本 id: ${escapeHtml(announcementCurrentMeta.id)},上次更新:${fmtTime(announcementCurrentMeta.updatedAt)}</p>`
          : `<p class="admin-hint">尚未建立過公告</p>`
      }
      ${announcementMessage ? `<p class="admin-notice">${escapeHtml(announcementMessage)}</p>` : ""}
      <div class="admin-row">
        <input id="announce-title-zh" class="admin-input" placeholder="標題(中)" value="${escapeHtml(announcementDraft.titleZh)}" />
        <input id="announce-title-en" class="admin-input" placeholder="標題(英)" value="${escapeHtml(announcementDraft.titleEn)}" />
      </div>
      <div class="admin-row">
        <textarea id="announce-body-zh" class="admin-input" placeholder="內容(中)">${escapeHtml(announcementDraft.bodyZh)}</textarea>
        <textarea id="announce-body-en" class="admin-input" placeholder="內容(英)">${escapeHtml(announcementDraft.bodyEn)}</textarea>
      </div>
      <div class="admin-row">
        <label class="admin-checkbox-row"><input type="checkbox" id="announce-enabled" ${announcementDraft.enabled ? "checked" : ""} /> 啟用公告</label>
        <label class="admin-checkbox-row"><input type="checkbox" id="announce-dismissible" ${announcementDraft.dismissible ? "checked" : ""} /> 允許玩家「不再顯示」</label>
      </div>
      <p class="admin-hint">不勾選「允許不再顯示」時,公告每次進入遊戲都會顯示;儲存後會產生新版本,先前已關閉過的玩家也會再看到一次。</p>
      <button id="announce-save-btn" class="admin-btn" ${announcementBusy ? "disabled" : ""}>${announcementBusy ? "儲存中…" : "發布公告"}</button>
    </div>
  `;
}

function attachAnnouncementTabHandlers() {
  document.querySelector<HTMLButtonElement>("#announce-save-btn")?.addEventListener("click", async () => {
    announcementDraft = {
      titleZh: document.querySelector<HTMLInputElement>("#announce-title-zh")?.value ?? "",
      titleEn: document.querySelector<HTMLInputElement>("#announce-title-en")?.value ?? "",
      bodyZh: document.querySelector<HTMLTextAreaElement>("#announce-body-zh")?.value ?? "",
      bodyEn: document.querySelector<HTMLTextAreaElement>("#announce-body-en")?.value ?? "",
      enabled: document.querySelector<HTMLInputElement>("#announce-enabled")?.checked ?? false,
      dismissible: document.querySelector<HTMLInputElement>("#announce-dismissible")?.checked ?? true,
    };
    announcementBusy = true;
    render();
    try {
      await api.saveAnnouncement({
        title: { zh: announcementDraft.titleZh, en: announcementDraft.titleEn },
        body: { zh: announcementDraft.bodyZh, en: announcementDraft.bodyEn },
        enabled: announcementDraft.enabled,
        dismissible: announcementDraft.dismissible,
      });
      announcementMessage = "公告已發布";
      await loadAnnouncement();
    } catch (err) {
      announcementMessage = `發布失敗:${(err as Error).message}`;
    }
    announcementBusy = false;
    render();
  });
}

// ==================== Campaigns ====================

async function loadCampaigns() {
  campaigns = await api.fetchAllCampaigns();
  campaignsLoaded = true;
  render();
}

function resetCampaignDraft() {
  campaignDraft = {
    titleZh: "",
    titleEn: "",
    contentZh: "",
    contentEn: "",
    goalZh: "",
    goalEn: "",
    rulesZh: "",
    rulesEn: "",
    rewardZh: "",
    rewardEn: "",
    enabled: true,
  };
}

function renderCampaignsTab(): string {
  if (!campaignsLoaded) return `<div class="admin-section"><p>載入中…</p></div>`;
  return `
    <div class="admin-section">
      <h2>活動清單</h2>
      <p class="admin-hint">每個活動都是自由文字(標題/內容/目標/說明/獎勵),遊戲不會自動判斷或發放獎勵——誰達成目標、獎勵怎麼給,都由你自己視每次活動的狀況判斷後手動處理(例如用「玩家」分頁調整加班費、或私訊聯絡)。</p>
      ${campaignMessage ? `<p class="admin-notice">${escapeHtml(campaignMessage)}</p>` : ""}
      <table class="admin-table">
        <thead><tr><th>標題</th><th>啟用</th><th>上次更新</th><th></th></tr></thead>
        <tbody>
          ${
            campaigns.length === 0
              ? `<tr><td colspan="4">尚未建立任何活動</td></tr>`
              : campaigns
                  .map(
                    (c) => `
            <tr>
              <td>${escapeHtml(c.title.zh)}</td>
              <td>${c.enabled ? "是" : "否"}</td>
              <td>${fmtTime(c.updatedAt)}</td>
              <td>
                <button class="admin-btn admin-btn-secondary" data-edit-campaign="${escapeHtml(c.id)}">編輯</button>
                <button class="admin-btn admin-btn-secondary" data-delete-campaign="${escapeHtml(c.id)}" ${campaignBusyId === c.id ? "disabled" : ""}>刪除</button>
              </td>
            </tr>
          `
                  )
                  .join("")
          }
        </tbody>
      </table>

      ${
        editingCampaignId !== null
          ? renderCampaignForm()
          : `<button id="new-campaign-btn" class="admin-btn">新增活動</button>`
      }
    </div>
  `;
}

function renderCampaignForm(): string {
  const isNew = editingCampaignId === "new";
  const busy = campaignBusyId === (isNew ? "new" : editingCampaignId);
  return `
    <h2>${isNew ? "新增活動" : "編輯活動"}</h2>
    <div class="admin-row">
      <input id="campaign-title-zh" class="admin-input" placeholder="活動標題(中)" value="${escapeHtml(campaignDraft.titleZh)}" />
      <input id="campaign-title-en" class="admin-input" placeholder="活動標題(英)" value="${escapeHtml(campaignDraft.titleEn)}" />
    </div>
    <div class="admin-row">
      <textarea id="campaign-content-zh" class="admin-input" placeholder="活動內容(中)">${escapeHtml(campaignDraft.contentZh)}</textarea>
      <textarea id="campaign-content-en" class="admin-input" placeholder="活動內容(英)">${escapeHtml(campaignDraft.contentEn)}</textarea>
    </div>
    <div class="admin-row">
      <textarea id="campaign-goal-zh" class="admin-input" placeholder="活動目標(中)">${escapeHtml(campaignDraft.goalZh)}</textarea>
      <textarea id="campaign-goal-en" class="admin-input" placeholder="活動目標(英)">${escapeHtml(campaignDraft.goalEn)}</textarea>
    </div>
    <div class="admin-row">
      <textarea id="campaign-rules-zh" class="admin-input" placeholder="活動說明(中)">${escapeHtml(campaignDraft.rulesZh)}</textarea>
      <textarea id="campaign-rules-en" class="admin-input" placeholder="活動說明(英)">${escapeHtml(campaignDraft.rulesEn)}</textarea>
    </div>
    <div class="admin-row">
      <textarea id="campaign-reward-zh" class="admin-input" placeholder="活動獎勵(中)">${escapeHtml(campaignDraft.rewardZh)}</textarea>
      <textarea id="campaign-reward-en" class="admin-input" placeholder="活動獎勵(英)">${escapeHtml(campaignDraft.rewardEn)}</textarea>
    </div>
    <div class="admin-row">
      <label class="admin-checkbox-row"><input type="checkbox" id="campaign-enabled" ${campaignDraft.enabled ? "checked" : ""} /> 啟用(玩家在「活動」分頁可見)</label>
    </div>
    <button id="campaign-save-btn" class="admin-btn" ${busy ? "disabled" : ""}>${busy ? "儲存中…" : "儲存"}</button>
    <button id="campaign-cancel-btn" class="admin-btn admin-btn-secondary">取消</button>
  `;
}

function readCampaignDraftFromForm() {
  campaignDraft = {
    titleZh: document.querySelector<HTMLInputElement>("#campaign-title-zh")?.value ?? "",
    titleEn: document.querySelector<HTMLInputElement>("#campaign-title-en")?.value ?? "",
    contentZh: document.querySelector<HTMLTextAreaElement>("#campaign-content-zh")?.value ?? "",
    contentEn: document.querySelector<HTMLTextAreaElement>("#campaign-content-en")?.value ?? "",
    goalZh: document.querySelector<HTMLTextAreaElement>("#campaign-goal-zh")?.value ?? "",
    goalEn: document.querySelector<HTMLTextAreaElement>("#campaign-goal-en")?.value ?? "",
    rulesZh: document.querySelector<HTMLTextAreaElement>("#campaign-rules-zh")?.value ?? "",
    rulesEn: document.querySelector<HTMLTextAreaElement>("#campaign-rules-en")?.value ?? "",
    rewardZh: document.querySelector<HTMLTextAreaElement>("#campaign-reward-zh")?.value ?? "",
    rewardEn: document.querySelector<HTMLTextAreaElement>("#campaign-reward-en")?.value ?? "",
    enabled: document.querySelector<HTMLInputElement>("#campaign-enabled")?.checked ?? true,
  };
}

function attachCampaignsTabHandlers() {
  document.querySelector<HTMLButtonElement>("#new-campaign-btn")?.addEventListener("click", () => {
    resetCampaignDraft();
    editingCampaignId = "new";
    render();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-edit-campaign]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.editCampaign!;
      const c = campaigns.find((x) => x.id === id);
      if (!c) return;
      campaignDraft = {
        titleZh: c.title.zh,
        titleEn: c.title.en,
        contentZh: c.content.zh,
        contentEn: c.content.en,
        goalZh: c.goal.zh,
        goalEn: c.goal.en,
        rulesZh: c.rules.zh,
        rulesEn: c.rules.en,
        rewardZh: c.reward.zh,
        rewardEn: c.reward.en,
        enabled: c.enabled,
      };
      editingCampaignId = id;
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-delete-campaign]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deleteCampaign!;
      if (!window.confirm("確定要刪除這個活動嗎?")) return;
      campaignBusyId = id;
      render();
      try {
        await api.deleteCampaign(id);
        campaignMessage = "活動已刪除";
        campaigns = await api.fetchAllCampaigns();
      } catch (err) {
        campaignMessage = `刪除失敗:${(err as Error).message}`;
      }
      campaignBusyId = null;
      render();
    });
  });

  document.querySelector<HTMLButtonElement>("#campaign-save-btn")?.addEventListener("click", async () => {
    readCampaignDraftFromForm();
    if (!campaignDraft.titleZh.trim()) return;
    const isNew = editingCampaignId === "new";
    const targetId = isNew ? null : editingCampaignId;
    campaignBusyId = isNew ? "new" : editingCampaignId;
    render();
    try {
      const existing = targetId ? campaigns.find((c) => c.id === targetId) : null;
      await api.saveCampaign(targetId, {
        title: { zh: campaignDraft.titleZh, en: campaignDraft.titleEn },
        content: { zh: campaignDraft.contentZh, en: campaignDraft.contentEn },
        goal: { zh: campaignDraft.goalZh, en: campaignDraft.goalEn },
        rules: { zh: campaignDraft.rulesZh, en: campaignDraft.rulesEn },
        reward: { zh: campaignDraft.rewardZh, en: campaignDraft.rewardEn },
        enabled: campaignDraft.enabled,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      });
      campaignMessage = isNew ? "活動已新增" : "活動已儲存";
      editingCampaignId = null;
      campaigns = await api.fetchAllCampaigns();
    } catch (err) {
      campaignMessage = `儲存失敗:${(err as Error).message}`;
    }
    campaignBusyId = null;
    render();
  });

  document.querySelector<HTMLButtonElement>("#campaign-cancel-btn")?.addEventListener("click", () => {
    editingCampaignId = null;
    render();
  });
}

// ==================== Disputes (read-only) ====================

async function loadDisputes(range?: api.DateRange) {
  disputes = await api.fetchDisputes(range);
  disputesLoaded = true;
  render();
}

function attachDisputesTabHandlers() {
  document.querySelector<HTMLButtonElement>("#dispute-date-apply-btn")?.addEventListener("click", async () => {
    const { startMs, endMs } = parseDateRange("dispute");
    disputeDateFrom = document.querySelector<HTMLInputElement>("#dispute-date-from")?.value ?? "";
    disputeDateTo = document.querySelector<HTMLInputElement>("#dispute-date-to")?.value ?? "";
    await loadDisputes({ startMs, endMs });
  });
}

function renderDisputesTab(): string {
  if (!disputesLoaded) return `<div class="admin-section"><p>載入中…</p></div>`;
  return `
    <div class="admin-section">
      <h2>爭議紀錄</h2>
      <p class="admin-hint">預設最近 100 筆,可用日期篩選。</p>
      ${renderDateRangeRow("dispute", disputeDateFrom, disputeDateTo, "dispute-date-apply-btn")}
      ${disputes.length === 0 ? `<p class="admin-hint">目前沒有爭議紀錄</p>` : renderDisputesTable()}
    </div>
  `;
}

function renderDisputesTable(): string {
  return `
      <table class="admin-table">
        <thead><tr><th>爭議 ID</th><th>訂單</th><th>玩家</th><th>原因</th><th>狀態</th><th>建立時間</th></tr></thead>
        <tbody>
          ${disputes
            .map(
              (d) => `
            <tr>
              <td>${escapeHtml(d.paypalDisputeId)}</td>
              <td>${escapeHtml(d.orderId)}</td>
              <td>${escapeHtml(d.userId)}</td>
              <td>${escapeHtml(d.reason)}</td>
              <td>${escapeHtml(d.status)}</td>
              <td>${fmtTime(d.createdAt)}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
  `;
}

// ==================== Webhook logs (read-only) ====================

async function loadWebhookLogs(range?: api.DateRange) {
  webhookLogs = await api.fetchWebhookLogs(range);
  webhookLogsLoaded = true;
  render();
}

function attachWebhooksTabHandlers() {
  document.querySelector<HTMLButtonElement>("#webhook-date-apply-btn")?.addEventListener("click", async () => {
    const { startMs, endMs } = parseDateRange("webhook");
    webhookDateFrom = document.querySelector<HTMLInputElement>("#webhook-date-from")?.value ?? "";
    webhookDateTo = document.querySelector<HTMLInputElement>("#webhook-date-to")?.value ?? "";
    await loadWebhookLogs({ startMs, endMs });
  });
}

function renderWebhooksTab(): string {
  if (!webhookLogsLoaded) return `<div class="admin-section"><p>載入中…</p></div>`;
  return `
    <div class="admin-section">
      <h2>Webhook 紀錄</h2>
      <p class="admin-hint">預設最近 100 筆,可用日期篩選。</p>
      ${renderDateRangeRow("webhook", webhookDateFrom, webhookDateTo, "webhook-date-apply-btn")}
      <table class="admin-table">
        <thead><tr><th>事件類型</th><th>驗簽</th><th>處理狀態</th><th>錯誤訊息</th><th>收到時間</th></tr></thead>
        <tbody>
          ${webhookLogs
            .map(
              (w) => `
            <tr>
              <td>${escapeHtml(w.eventType ?? "—")}</td>
              <td>${escapeHtml(w.verificationStatus)}</td>
              <td>${escapeHtml(w.processingStatus)}</td>
              <td>${escapeHtml(w.errorMessage ?? "")}</td>
              <td>${fmtTime(w.receivedAt)}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ==================== Reconcile ====================

function renderReconcileTab(): string {
  return `
    <div class="admin-section">
      <h2>手動對帳</h2>
      <p class="admin-hint">只偵測異常,不會自動修正——發現問題後請個別處理(退款/調整點數/人工複查)。</p>
      <button id="reconcile-run-btn" class="admin-btn" ${reconcileBusy ? "disabled" : ""}>${reconcileBusy ? "執行中…" : "執行對帳"}</button>
      ${reconcileError ? `<p class="admin-error">${escapeHtml(reconcileError)}</p>` : ""}
      ${reconcileReport ? `<div class="admin-json">${escapeHtml(JSON.stringify(reconcileReport, null, 2))}</div>` : ""}
    </div>
  `;
}

function attachReconcileTabHandlers() {
  document.querySelector<HTMLButtonElement>("#reconcile-run-btn")?.addEventListener("click", async () => {
    reconcileBusy = true;
    reconcileError = null;
    render();
    try {
      reconcileReport = await api.adminReconcile();
    } catch (err) {
      reconcileError = (err as Error).message;
    }
    reconcileBusy = false;
    render();
  });
}

// ==================== Audit log (read-only) ====================

async function loadAdminActions(range?: api.DateRange) {
  adminActions = await api.fetchAdminActions(range);
  adminActionsLoaded = true;
  render();
}

function attachAuditTabHandlers() {
  document.querySelector<HTMLButtonElement>("#audit-date-apply-btn")?.addEventListener("click", async () => {
    const { startMs, endMs } = parseDateRange("audit");
    auditDateFrom = document.querySelector<HTMLInputElement>("#audit-date-from")?.value ?? "";
    auditDateTo = document.querySelector<HTMLInputElement>("#audit-date-to")?.value ?? "";
    await loadAdminActions({ startMs, endMs });
  });
}

function renderAuditTab(): string {
  if (!adminActionsLoaded) return `<div class="admin-section"><p>載入中…</p></div>`;
  return `
    <div class="admin-section">
      <h2>管理員操作紀錄</h2>
      <p class="admin-hint">預設最近 100 筆,可用日期篩選。</p>
      ${renderDateRangeRow("audit", auditDateFrom, auditDateTo, "audit-date-apply-btn")}
      <table class="admin-table">
        <thead><tr><th>時間</th><th>操作人</th><th>動作</th><th>對象</th><th>原因</th></tr></thead>
        <tbody>
          ${adminActions
            .map(
              (a) => `
            <tr>
              <td>${fmtTime(a.createdAt)}</td>
              <td>${escapeHtml(a.operatorUid)}</td>
              <td>${escapeHtml(a.action)}</td>
              <td>${escapeHtml(a.targetOrderId ?? a.targetUserId ?? "—")}</td>
              <td>${escapeHtml(a.reason)}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ==================== dispatch ====================

function attachTabHandlers() {
  if (activeTab === "orders") attachOrdersTabHandlers();
  if (activeTab === "players") {
    attachPlayersTabHandlers();
    attachAllPlayersTabHandlers();
  }
  if (activeTab === "products") attachProductsTabHandlers();
  if (activeTab === "announcement") attachAnnouncementTabHandlers();
  if (activeTab === "campaigns") attachCampaignsTabHandlers();
  if (activeTab === "disputes") attachDisputesTabHandlers();
  if (activeTab === "webhooks") attachWebhooksTabHandlers();
  if (activeTab === "reconcile") attachReconcileTabHandlers();
  if (activeTab === "audit") attachAuditTabHandlers();
}

render();
