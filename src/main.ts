import { pullRemoteState, pushRemoteState } from "./cloudSync";
import { buildComboKey, decodeComboKey, getOptionById, hasAnySelection } from "./combo";
import { MAX_STAMINA_UNITS, MAX_UNITS_PER_ACTION, STORAGE_KEY, UNIT_MINUTES } from "./config";
import { SEED_OPTIONS } from "./data/options";
import { resolveAction, type ResolveResult } from "./eventEngine";
import { ensureSignedIn, isGoogleLinked, signInWithGoogle, signOutToLocal } from "./firebase";
import {
  isUnlocked,
  loadState,
  minutesUntilNextUnit,
  saveState,
  settleStamina,
  type GameState,
} from "./state";
import { CATEGORY_LABEL, CATEGORY_ORDER } from "./types";
import type { Category, Selection } from "./types";
import type { User } from "firebase/auth";

const app = document.querySelector<HTMLDivElement>("#app")!;

let state: GameState = settleStamina(loadState());
saveState(state);

function emptySelection(): Selection {
  return { person: null, matter: null, place: null, object: null };
}

type View = "play" | "history" | "market";

let selection: Selection = emptySelection();
let durationUnits = 1;
let lastResult: ResolveResult | null = null;
let insufficientStaminaFlash = false;
let isResolving = false;
let currentUser: User | null = null;
let syncNotice: string | null = null;
let view: View = "play";
let accountMenuOpen = false;
/** Which category's materials are currently shown in the right-hand picker. */
let activeCategory: Category = CATEGORY_ORDER[0];

function persist() {
  saveState(state);
  // Anonymous sessions (the silent default every player gets) stay local-only
  // — only an explicit Google login opts a player into cloud sync.
  if (currentUser && isGoogleLinked(currentUser)) {
    pushRemoteState(currentUser.uid, state);
  }
}

function formatDuration(units: number): string {
  const totalMinutes = units * UNIT_MINUTES;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} 分鐘`;
  if (m === 0) return `${h} 小時`;
  return `${h} 小時 ${m} 分鐘`;
}

function optionsFor(category: Category) {
  return SEED_OPTIONS.filter((o) => o.category === category && isUnlocked(state, o.id));
}

function maxSelectableUnits(): number {
  return Math.max(0, Math.min(MAX_UNITS_PER_ACTION, state.staminaUnits));
}

function render() {
  const content =
    view === "history" ? renderHistoryContent() : view === "market" ? renderMarketContent() : renderPlayContent();

  app.innerHTML = `
    <div class="wrap">
      <header class="app-header">
        <h1>職場大小事</h1>
        <div class="header-right">
          ${renderHeaderStamina()}
          ${renderAccountMenu()}
        </div>
      </header>

      ${renderTabNav()}

      ${content}

      <footer>
        <button id="reset-btn" class="reset-btn">重置遊戲進度</button>
      </footer>
    </div>
  `;

  attachTabNavHandlers();
  attachFooterHandlers();
  attachAccountMenuHandlers();
  if (view === "play") attachPlayHandlers();
}

function renderHeaderStamina(): string {
  const remaining = state.staminaUnits;
  const pct = Math.round((remaining / MAX_STAMINA_UNITS) * 100);
  return `
    <div class="stamina-mini">
      <div class="stamina-mini-row">
        <span class="stamina-mini-label">體力</span>
        <span class="stamina-mini-value">${remaining} / ${MAX_STAMINA_UNITS}</span>
      </div>
      <div class="stamina-bar"><div class="stamina-fill" style="width:${pct}%"></div></div>
      ${
        remaining < MAX_STAMINA_UNITS
          ? `<p class="stamina-mini-hint">約 ${Math.ceil(minutesUntilNextUnit(state))} 分鐘後 +1</p>`
          : `<p class="stamina-mini-hint">體力全滿</p>`
      }
    </div>
  `;
}

function renderAccountMenu(): string {
  const loggedIn = !!currentUser && isGoogleLinked(currentUser);
  const label = loggedIn ? currentUser!.displayName || currentUser!.email || "已登入" : "未登入";
  return `
    <div class="account-menu">
      <button id="account-menu-btn" class="account-badge ${loggedIn ? "account-badge-cloud" : "account-badge-local"}">
        ${loggedIn ? "☁️" : "🔒"} <span class="account-badge-label">${escapeHtml(label)}</span>
      </button>
      ${accountMenuOpen ? renderAccountDropdown(loggedIn) : ""}
    </div>
  `;
}

function renderAccountDropdown(loggedIn: boolean): string {
  return `
    <div class="account-dropdown">
      ${
        loggedIn
          ? `<p class="account-dropdown-info">已用 Google 帳號同步,跨裝置共用進度</p>
             <button id="signout-btn" class="account-dropdown-btn">登出(改回本機模式)</button>`
          : `<p class="account-dropdown-info">目前資料只存在這個裝置</p>
             <button id="google-signin-btn" class="account-dropdown-btn">登入 Google 帳號以同步進度</button>`
      }
      ${syncNotice ? `<p class="account-dropdown-notice">${escapeHtml(syncNotice)}</p>` : ""}
    </div>
  `;
}

function renderTabNav(): string {
  const tabs: { key: View; label: string }[] = [
    { key: "play", label: "事件" },
    { key: "history", label: "歷史" },
    { key: "market", label: "市集" },
  ];
  return `
    <nav class="tab-nav">
      ${tabs
        .map(
          (t) =>
            `<button class="tab-nav-btn ${view === t.key ? "active" : ""}" data-view="${t.key}">${t.label}</button>`
        )
        .join("")}
    </nav>
  `;
}

function renderPlayContent(): string {
  const remaining = state.staminaUnits;
  const cappedDuration = Math.min(durationUnits, Math.max(1, maxSelectableUnits()));
  if (cappedDuration !== durationUnits) durationUnits = cappedDuration;
  const hasSelection = hasAnySelection(selection);
  const canAct = remaining > 0 && !isResolving && hasSelection;
  const currentComboKey = hasSelection ? buildComboKey(selection) : null;
  // Suppress the hint when the result card already showing IS for this exact
  // combo — it already communicates new-vs-repeat, so the hint would just be
  // a confusing echo (e.g. right after generating a brand-new event).
  const isDuplicate =
    currentComboKey !== null &&
    currentComboKey in state.eventsByCombo &&
    lastResult?.event.comboKey !== currentComboKey;

  let resolveLabel: string;
  if (isResolving) resolveLabel = "生成中…";
  else if (remaining <= 0) resolveLabel = "體力不足";
  else if (!hasSelection) resolveLabel = "請選擇";
  else resolveLabel = "開始";

  return `
    <section class="action-bar">
      <div class="slot-group">
        ${CATEGORY_ORDER.map((cat) => renderSlot(cat)).join("")}
      </div>
      <div class="time-bar">
        <button class="step-btn" id="dur-minus" ${durationUnits <= 1 ? "disabled" : ""}>−</button>
        <div class="time-bar-track">
          <input type="range" id="dur-range" min="1" max="${Math.max(1, maxSelectableUnits())}" value="${durationUnits}" ${remaining <= 0 ? "disabled" : ""} />
          <span class="time-bar-label">${formatDuration(durationUnits)}</span>
        </div>
        <button class="step-btn" id="dur-plus" ${durationUnits >= maxSelectableUnits() ? "disabled" : ""}>＋</button>
      </div>
      <button id="resolve-btn" class="resolve-btn-compact" ${!canAct ? "disabled" : ""}>${resolveLabel}</button>
    </section>

    ${isDuplicate ? `<p class="duplicate-hint">🔁 這個組合你已經試過了,結果會一樣。</p>` : ""}
    ${insufficientStaminaFlash ? `<p class="warning">體力不夠支撐這段時間,已自動調整。</p>` : ""}

    <section class="material-area">
      <div class="material-tabs">
        ${CATEGORY_ORDER.map(
          (cat) =>
            `<button class="material-tab ${cat === activeCategory ? "active" : ""}" data-tab-category="${cat}">${CATEGORY_LABEL[cat]}</button>`
        ).join("")}
      </div>
      <div class="material-options">
        ${renderMaterialOptions(activeCategory)}
      </div>
    </section>

    ${renderResult()}

    <p class="collection-count">已收集 ${state.collectedComboKeys.length} 個獨特事件</p>
  `;
}

function renderSlot(cat: Category): string {
  const selectedId = selection[cat];
  const valueLabel = selectedId ? getOptionById(selectedId)?.label ?? "" : "未選";
  return `
    <button class="slot ${cat === activeCategory ? "slot-active" : ""} ${selectedId ? "slot-filled" : ""}" data-slot-category="${cat}">
      <span class="slot-cat">${CATEGORY_LABEL[cat]}</span>
      <span class="slot-value">${escapeHtml(valueLabel)}</span>
    </button>
  `;
}

function renderMaterialOptions(cat: Category): string {
  const options = optionsFor(cat);
  const selectedId = selection[cat];
  return `
    <div class="pill-group" data-category="${cat}">
      <button class="pill ${selectedId === null ? "active" : ""}" data-value="">不選</button>
      ${options
        .map(
          (o) =>
            `<button class="pill ${selectedId === o.id ? "active" : ""}" data-value="${o.id}">${escapeHtml(o.label)}</button>`
        )
        .join("")}
    </div>
  `;
}

function renderResult(): string {
  if (!lastResult) return "";
  const { event, isNewDiscovery, newlyUnlocked, source } = lastResult;
  const sourceLabel =
    source === "remote" ? "ChatGPT 生成" : source === "cached" ? "已收錄事件" : "本機生成";
  return `
    <section class="result-card">
      <div class="result-title-row">
        <h2>${escapeHtml(event.title)}</h2>
        <span class="${isNewDiscovery ? "badge-new" : "badge-repeat"}">${isNewDiscovery ? "首次發現" : "重複事件"}</span>
      </div>
      <p class="result-desc">${escapeHtml(event.description)}</p>
      <p class="result-meta">花費 ${formatDuration(event.durationUnits)} · ${sourceLabel}</p>
      ${
        newlyUnlocked.length > 0
          ? `<div class="unlock-toast">${newlyUnlocked
              .map((u) => {
                const opt = getOptionById(u.optionId);
                return `🎉 解鎖新選項 — ${CATEGORY_LABEL[u.category]}:${escapeHtml(opt?.label ?? u.optionId)}`;
              })
              .join("<br/>")}</div>`
          : ""
      }
    </section>
  `;
}

function renderHistoryContent(): string {
  const entries = state.collectedComboKeys
    .slice()
    .reverse()
    .map((key) => {
      const ev = state.eventsByCombo[key];
      const labels = decodeComboKey(key);
      const tags = CATEGORY_ORDER.filter((cat) => labels[cat]).map(
        (cat) => `<span class="tag">${CATEGORY_LABEL[cat]}:${escapeHtml(labels[cat]!)}</span>`
      );
      return `
        <li class="collection-entry">
          <div class="collection-entry-header">
            <strong>${escapeHtml(ev.title)}</strong>
            <span class="collection-entry-duration">${formatDuration(ev.durationUnits)}</span>
          </div>
          <div class="tag-row">${tags.length > 0 ? tags.join("") : `<span class="tag tag-empty">沒有指定人事地物</span>`}</div>
          <p class="collection-desc">${escapeHtml(ev.description)}</p>
        </li>
      `;
    })
    .join("");

  return `
    <p class="subtitle" style="margin-bottom:16px;">已收集 ${state.collectedComboKeys.length} 個獨特事件</p>
    <ol class="collection-list collection-list-full">
      ${entries || `<li class="collection-empty">還沒有收集到任何事件,回去試試看吧!</li>`}
    </ol>
  `;
}

interface StaminaPackage {
  units: number;
  priceNTD: number;
}

const STAMINA_PACKAGES: StaminaPackage[] = [
  { units: 10, priceNTD: 30 },
  { units: 30, priceNTD: 79 },
  { units: 60, priceNTD: 149 },
  { units: 144, priceNTD: 299 },
];

function renderMarketContent(): string {
  return `
    <section class="market-notice">
      <p>儲值功能還在準備中,金流串接完成後就能在這裡直接購買體力。</p>
    </section>
    <div class="market-grid">
      ${STAMINA_PACKAGES.map(
        (p) => `
          <div class="market-card">
            <div class="market-units">${p.units} 單位</div>
            <div class="market-sub">${formatDuration(p.units)}</div>
            <div class="market-price">NT$ ${p.priceNTD}</div>
            <button class="market-buy-btn" disabled>尚未開放</button>
          </div>
        `
      ).join("")}
    </div>
  `;
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function attachTabNavHandlers() {
  app.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      view = btn.dataset.view as View;
      render();
    });
  });
}

function attachFooterHandlers() {
  document.querySelector<HTMLButtonElement>("#reset-btn")?.addEventListener("click", () => {
    const ok = window.confirm("確定要重置所有遊戲進度嗎?這會清除已收集的事件與解鎖的選項,且無法復原。");
    if (!ok) return;
    localStorage.removeItem(STORAGE_KEY);
    state = settleStamina(loadState());
    selection = emptySelection();
    durationUnits = 1;
    lastResult = null;
    persist();
    render();
  });

  document.querySelector<HTMLButtonElement>("#google-signin-btn")?.addEventListener("click", async () => {
    if (currentUser && isGoogleLinked(currentUser)) return;
    try {
      syncNotice = "正在開啟 Google 登入視窗…";
      render();
      const user = await signInWithGoogle();
      currentUser = user;
      const remote = await pullRemoteState(user.uid);
      if (remote) {
        state = remote;
        syncNotice = "已從雲端還原你的進度。";
      } else {
        syncNotice = "已連結 Google 帳號,目前進度已開始同步。";
        persist();
      }
    } catch (err) {
      console.warn("Google 登入失敗", err);
      syncNotice = "Google 登入失敗,請稍後再試。";
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#signout-btn")?.addEventListener("click", async () => {
    const ok = window.confirm(
      "登出後這個裝置會改回本機模式,之後的進度不會再同步到雲端(這台裝置上的本機資料會保留)。確定要登出嗎?"
    );
    if (!ok) return;
    try {
      currentUser = await signOutToLocal();
      syncNotice = "已登出,目前是本機模式。";
    } catch (err) {
      console.warn("登出失敗", err);
      syncNotice = "登出失敗,請稍後再試。";
    }
    render();
  });
}

function attachAccountMenuHandlers() {
  document.querySelector<HTMLButtonElement>("#account-menu-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    accountMenuOpen = !accountMenuOpen;
    render();
  });
}

function attachPlayHandlers() {
  app.querySelectorAll<HTMLElement>(".pill-group").forEach((group) => {
    const cat = group.dataset.category as Category;
    group.querySelectorAll<HTMLButtonElement>(".pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.dataset.value || "";
        selection[cat] = value === "" ? null : value;
        render();
      });
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-slot-category]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeCategory = btn.dataset.slotCategory as Category;
      render();
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-tab-category]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeCategory = btn.dataset.tabCategory as Category;
      render();
    });
  });

  const minusBtn = document.querySelector<HTMLButtonElement>("#dur-minus");
  const plusBtn = document.querySelector<HTMLButtonElement>("#dur-plus");
  const range = document.querySelector<HTMLInputElement>("#dur-range");
  minusBtn?.addEventListener("click", () => {
    durationUnits = Math.max(1, durationUnits - 1);
    render();
  });
  plusBtn?.addEventListener("click", () => {
    durationUnits = Math.min(maxSelectableUnits(), durationUnits + 1);
    render();
  });
  range?.addEventListener("input", () => {
    durationUnits = Number(range.value);
    render();
  });

  document.querySelector<HTMLButtonElement>("#resolve-btn")?.addEventListener("click", async () => {
    insufficientStaminaFlash = false;
    if (!hasAnySelection(selection) || isResolving) return;
    const effectiveDuration = Math.min(durationUnits, maxSelectableUnits());
    if (effectiveDuration <= 0) return;
    isResolving = true;
    render();
    const result = await resolveAction(state, selection, effectiveDuration);
    isResolving = false;
    if (!result) {
      insufficientStaminaFlash = true;
      render();
      return;
    }
    lastResult = result;
    persist();
    render();
  });
}

render();

// Attached once to `document` (not re-attached per render, unlike the other
// handlers) so it survives every innerHTML rebuild and can close the account
// dropdown when a click lands outside it.
document.addEventListener("click", (e) => {
  if (!accountMenuOpen) return;
  const target = e.target as HTMLElement;
  if (!target.closest(".account-menu")) {
    accountMenuOpen = false;
    render();
  }
});

ensureSignedIn()
  .then(async (user) => {
    currentUser = user;
    if (isGoogleLinked(user)) {
      const remote = await pullRemoteState(user.uid);
      if (remote) state = remote;
    }
    render();
  })
  .catch((err) => {
    console.warn("登入失敗,將只使用本機模式", err);
  });

// Periodically re-settle stamina so the regen bar/timer stays live even if the
// player leaves the tab open without interacting.
setInterval(() => {
  settleStamina(state);
  persist();
  render();
}, 15_000);
