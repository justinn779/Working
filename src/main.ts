import { pullRemoteState, pushRemoteState } from "./cloudSync";
import { buildComboKey, decodeComboKey, getOptionById, hasAnySelection } from "./combo";
import { MAX_STAMINA_UNITS, STORAGE_KEY, UNIT_MINUTES } from "./config";
import { SEED_OPTIONS } from "./data/options";
import { resolveAction, type ResolveResult } from "./eventEngine";
import { ensureSignedIn, isGoogleLinked, signInWithGoogle, signOutToLocal } from "./firebase";
import { t as translate } from "./i18n";
import {
  hasSavedState,
  isUnlocked,
  loadState,
  saveState,
  secondsUntilNextUnit,
  settleStamina,
  type GameState,
} from "./state";
import { CATEGORY_LABEL, CATEGORY_ORDER } from "./types";
import type { Category, Localized, Selection } from "./types";
import type { User } from "firebase/auth";

const app = document.querySelector<HTMLDivElement>("#app")!;

// A save is only absent on a player's very first-ever visit — that's the one
// moment navigator.language gets to pick the starting UI language. Every
// later load (including a corrupted save that falls back to freshState())
// keeps whatever language was already chosen.
const isFirstVisit = !hasSavedState();
let state: GameState = settleStamina(loadState());
if (isFirstVisit) {
  state.language = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}
saveState(state);

/** Thin wrapper so call sites don't have to pass state.language everywhere. */
function t(key: Parameters<typeof translate>[0], vars?: Record<string, string | number>): string {
  return translate(key, state.language, vars);
}

/** Picks the current-language string out of a bilingual value. */
function L(value: Localized): string {
  return value[state.language];
}

/** Resolves an option id straight to its current-language label, falling
 * back to an empty string for an id that can't be resolved at all (should
 * only happen for corrupted data). */
function optionLabel(id: string): string {
  return L(getOptionById(id, state.knownMaterials)?.label ?? { zh: "", en: "" });
}

function emptySelection(): Selection {
  return { person: null, matter: null, place: null, object: null };
}

type View = "play" | "history" | "market";

let selection: Selection = emptySelection();
let durationUnits = 1;
let lastResult: ResolveResult | null = null;
/** True once the player has touched selection/duration since lastResult was
 * set — governs whether the result card (and the duplicate-hint suppression
 * tied to it) still applies. Not driven by comboKey equality: after a resolve
 * the material picker auto-resets (see the resolve handler), so the "current
 * selection" no longer matches lastResult even though it's still the result
 * that should be showing. */
let resultStale = false;
/** Controls the result popup's visibility only — separate from resultStale,
 * which still tracks "has the player touched selection/duration since the
 * last resolve" for the duplicate-hint suppression regardless of whether
 * this modal is currently open or already dismissed. */
let resultModalOpen = false;
let insufficientStaminaFlash = false;
let isResolving = false;
let currentUser: User | null = null;
let syncNotice: string | null = null;
let view: View = "play";
let accountMenuOpen = false;
let nameModalOpen = false;
/** false only for the forced first-time prompt (no playerName yet) — once a
 * name exists, reopening the modal to edit it can be cancelled. */
let nameModalCanCancel = true;
let nameInputDraft = "";
/** Index into TUTORIAL_STEPS while the guided tour is active, null otherwise. */
let tutorialStep: number | null = null;

interface TutorialStepDef {
  /** CSS selector for the button/control this step points an arrow at. */
  selector: string;
  /** i18n key for this step's text. */
  textKey: string;
}

const TUTORIAL_STEPS: TutorialStepDef[] = [
  { selector: ".slot-group", textKey: "tutorialStep1" },
  { selector: ".time-bar", textKey: "tutorialStep2" },
  { selector: "#resolve-btn", textKey: "tutorialStep3" },
  { selector: ".stamina-mini", textKey: "tutorialStep4" },
  { selector: '[data-view="history"]', textKey: "tutorialStep5" },
];
/** Which category's materials are currently shown in the right-hand picker. */
let activeCategory: Category = CATEGORY_ORDER[0];
/** History entries are collapsed to just a title by default; expanding one
 * adds its comboKey here. Multiple can be open at once. */
const expandedHistoryKeys = new Set<string>();
let historySearchQuery = "";
/** Selected optionId per category to filter history by, null = 全部.
 * Combined with AND across categories (and with the search query). */
const historyFilters: Record<Category, string | null> = {
  person: null,
  matter: null,
  place: null,
  object: null,
};

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
  if (h === 0) return t("durationMinutesOnly", { m });
  if (m === 0) return t("durationHoursOnly", { h });
  return t("durationHoursMinutes", { h, m });
}

/** Compact "x時y分" form used for the header stamina readout. */
function formatHoursMinutes(units: number): string {
  const totalMinutes = units * UNIT_MINUTES;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return t("compactHoursMinutes", { h, m });
}

/** mm:ss countdown display for the live stamina-regen ticker. */
function formatCountdown(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(state.language === "en" ? "en-US" : "zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function optionsFor(category: Category) {
  const seedOptions = SEED_OPTIONS.filter((o) => o.category === category && isUnlocked(state, o.id));
  const dynamicOptions = Object.entries(state.knownMaterials)
    .filter(([id, m]) => m.category === category && isUnlocked(state, id))
    .map(([id, m]) => ({ id, category: m.category, label: m.label }));
  return [...seedOptions, ...dynamicOptions];
}

function maxSelectableUnits(): number {
  return Math.max(0, state.staminaUnits);
}

function render() {
  if (!state.playerName && !nameModalOpen) {
    nameModalOpen = true;
    nameModalCanCancel = false;
    nameInputDraft = "";
  }

  const content =
    view === "history" ? renderHistoryContent() : view === "market" ? renderMarketContent() : renderPlayContent();

  app.innerHTML = `
    <div class="wrap">
      <header class="app-header">
        <h1>${t("appTitle")}</h1>
        <div class="header-right">
          ${renderHeaderStamina()}
          ${renderAccountMenu()}
        </div>
      </header>

      ${renderTabNav()}

      ${content}
    </div>
    ${nameModalOpen ? renderNameModal() : ""}
    ${tutorialStep !== null ? renderTutorialOverlay() : ""}
    ${resultModalOpen ? renderResultModal() : ""}
  `;

  attachTabNavHandlers();
  attachAccountMenuHandlers();
  if (view === "play") attachPlayHandlers();
  if (view === "history") attachHistoryHandlers();
  if (nameModalOpen) attachNameModalHandlers();
  if (resultModalOpen) attachResultModalHandlers();
  if (tutorialStep !== null) {
    attachTutorialHandlers();
    positionTutorialOverlay();
  }
}

function renderHeaderStamina(): string {
  const remaining = state.staminaUnits;
  const pct = Math.round((remaining / MAX_STAMINA_UNITS) * 100);
  return `
    <div class="stamina-mini">
      <div class="stamina-mini-row">
        <span class="stamina-mini-label">${t("staminaLabel")}</span>
        <span class="stamina-mini-value">${formatHoursMinutes(remaining)}</span>
      </div>
      <div class="stamina-bar"><div class="stamina-fill" style="width:${pct}%"></div></div>
      ${
        remaining < MAX_STAMINA_UNITS
          ? `<p class="stamina-mini-hint">${t("regenCountdown", { time: formatCountdown(secondsUntilNextUnit(state)) })}</p>`
          : `<p class="stamina-mini-hint">${t("staminaFull")}</p>`
      }
    </div>
  `;
}

function renderAccountMenu(): string {
  const loggedIn = !!currentUser && isGoogleLinked(currentUser);
  const label = state.playerName || "…";
  return `
    <button id="language-toggle-btn" class="language-toggle-btn" title="${t("languageToggle")}">${t("languageToggle")}</button>
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
      <div class="account-dropdown-name-row">
        <span class="account-dropdown-name-label">${t("nameFieldLabel")}</span>
        <span class="account-dropdown-name-value">${escapeHtml(state.playerName || t("notSet"))}</span>
        <button id="edit-name-btn" class="account-name-edit-btn" title="${t("editNameTitle")}">✏️</button>
      </div>
      ${
        loggedIn
          ? `<p class="account-dropdown-info">${t("googleSyncedInfo")}</p>
             <button id="signout-btn" class="account-dropdown-btn">${t("signOut")}</button>`
          : `<p class="account-dropdown-info">${t("localOnlyInfo")}</p>
             <button id="google-signin-btn" class="account-dropdown-btn">${t("googleSignIn")}</button>`
      }
      ${syncNotice ? `<p class="account-dropdown-notice">${escapeHtml(syncNotice)}</p>` : ""}
      <hr class="account-dropdown-divider" />
      <button id="reset-btn" class="account-dropdown-btn account-dropdown-btn-danger">${t("resetProgress")}</button>
    </div>
  `;
}

function renderNameModal(): string {
  return `
    <div class="modal-backdrop">
      <div class="modal-card">
        <h2>${nameModalCanCancel ? t("editNameTitle") : t("setNameTitle")}</h2>
        <p class="modal-hint">${t("nameModalHint")}</p>
        <input id="name-input" class="modal-input" type="text" maxlength="12" value="${escapeHtml(nameInputDraft)}" placeholder="${t("nameInputPlaceholder")}" />
        <div class="modal-actions">
          ${nameModalCanCancel ? `<button id="name-cancel-btn" class="modal-btn-secondary">${t("cancel")}</button>` : ""}
          <button id="name-confirm-btn" class="modal-btn-primary">${t("confirm")}</button>
        </div>
      </div>
    </div>
  `;
}

function renderTutorialOverlay(): string {
  const stepIndex = tutorialStep as number;
  const step = TUTORIAL_STEPS[stepIndex];
  const isLast = stepIndex === TUTORIAL_STEPS.length - 1;
  return `
    <div class="tutorial-overlay">
      <div class="tutorial-highlight"></div>
      <div class="tutorial-tooltip">
        <div class="tutorial-arrow"></div>
        <p class="tutorial-tooltip-step">${t("tutorialStepLabel", { current: stepIndex + 1, total: TUTORIAL_STEPS.length })}</p>
        <p class="tutorial-tooltip-text">${escapeHtml(t(step.textKey as Parameters<typeof translate>[0]))}</p>
        <div class="tutorial-tooltip-actions">
          <button id="tutorial-skip-btn" class="tutorial-skip-btn">${t("tutorialSkip")}</button>
          <button id="tutorial-next-btn" class="modal-btn-primary">${isLast ? t("tutorialFinish") : t("tutorialNext")}</button>
        </div>
      </div>
    </div>
  `;
}

/** Measures TUTORIAL_STEPS[tutorialStep]'s target element and positions the
 * highlight ring + tooltip (with its arrow) around it. Runs after every
 * render() while the tour is active, since a full render() rebuilds the
 * overlay's DOM (and the target's own position can shift between steps —
 * e.g. tab nav vs action bar). */
function positionTutorialOverlay() {
  if (tutorialStep === null) return;
  const step = TUTORIAL_STEPS[tutorialStep];
  const target = document.querySelector<HTMLElement>(step.selector);
  const highlight = document.querySelector<HTMLElement>(".tutorial-highlight");
  const tooltip = document.querySelector<HTMLElement>(".tutorial-tooltip");
  const arrow = document.querySelector<HTMLElement>(".tutorial-arrow");
  if (!target || !highlight || !tooltip || !arrow) return;

  const rect = target.getBoundingClientRect();
  const pad = 6;
  highlight.style.top = `${rect.top - pad}px`;
  highlight.style.left = `${rect.left - pad}px`;
  highlight.style.width = `${rect.width + pad * 2}px`;
  highlight.style.height = `${rect.height + pad * 2}px`;

  const tooltipWidth = tooltip.offsetWidth;
  const tooltipHeight = tooltip.offsetHeight;
  const gap = 16;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  // Prefer placing below the target; flip above it only if there's more
  // clearly room there (target sits in the bottom half with no room below).
  const placeBelow = rect.bottom + gap + tooltipHeight <= viewportH || rect.top < viewportH / 2;
  const top = placeBelow ? rect.bottom + gap : rect.top - gap - tooltipHeight;
  const clampedTop = Math.max(8, Math.min(top, viewportH - tooltipHeight - 8));

  const centerX = rect.left + rect.width / 2;
  const left = Math.max(8, Math.min(centerX - tooltipWidth / 2, viewportW - tooltipWidth - 8));

  tooltip.style.top = `${clampedTop}px`;
  tooltip.style.left = `${left}px`;

  arrow.className = `tutorial-arrow ${placeBelow ? "tutorial-arrow-up" : "tutorial-arrow-down"}`;
  const arrowLeft = Math.max(12, Math.min(centerX - left, tooltipWidth - 12));
  arrow.style.left = `${arrowLeft}px`;
}

function renderTabNav(): string {
  const tabs: { key: View; labelKey: Parameters<typeof translate>[0] }[] = [
    { key: "play", labelKey: "tabPlay" },
    { key: "history", labelKey: "tabHistory" },
    { key: "market", labelKey: "tabMarket" },
  ];
  return `
    <nav class="tab-nav">
      ${tabs
        .map(
          (tab) =>
            `<button class="tab-nav-btn ${view === tab.key ? "active" : ""}" data-view="${tab.key}">${t(tab.labelKey)}${
              tab.key === "history" ? `<span class="tab-nav-badge">${state.collectedComboKeys.length}</span>` : ""
            }</button>`
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
  const currentComboKey = hasSelection ? buildComboKey(selection, durationUnits) : null;
  const showingResult = lastResult !== null && !resultStale;
  // Suppress the hint while the result card is showing that exact combo — it
  // already communicates new-vs-repeat, so the hint would just be a confusing
  // echo. Gated on `showingResult`/`resultStale` rather than a plain comboKey
  // comparison against lastResult: the material picker auto-resets after
  // every resolve, so relying on comboKey equality alone would either hide
  // an on-screen result that's still accurate, or silently miss a genuine
  // repeat if the player happens to rebuild the exact same combo afterward.
  const isDuplicate =
    currentComboKey !== null &&
    currentComboKey in state.eventsByCombo &&
    !(showingResult && lastResult!.event.comboKey === currentComboKey);

  let resolveLabel: string;
  if (isResolving) resolveLabel = t("resolvingLabel");
  else if (remaining <= 0) resolveLabel = t("staminaInsufficientLabel");
  else if (!hasSelection) resolveLabel = t("pleaseSelectLabel");
  else resolveLabel = t("startLabel");

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

    ${isDuplicate ? `<p class="duplicate-hint">${t("duplicateHint")}</p>` : ""}
    ${insufficientStaminaFlash ? `<p class="warning">${t("insufficientStaminaWarning")}</p>` : ""}

    <section class="material-area">
      <div class="material-tabs">
        ${CATEGORY_ORDER.map(
          (cat) =>
            `<button class="material-tab ${cat === activeCategory ? "active" : ""}" data-tab-category="${cat}">${L(CATEGORY_LABEL[cat])}</button>`
        ).join("")}
      </div>
      <div class="material-options">
        ${renderMaterialOptions(activeCategory)}
      </div>
    </section>
  `;
}

function renderSlot(cat: Category): string {
  const selectedId = selection[cat];
  const valueLabel = selectedId ? optionLabel(selectedId) : t("unselected");
  return `
    <button class="slot ${cat === activeCategory ? "slot-active" : ""} ${selectedId ? "slot-filled" : ""}" data-slot-category="${cat}">
      <span class="slot-cat">${L(CATEGORY_LABEL[cat])}</span>
      <span class="slot-value">${escapeHtml(valueLabel)}</span>
    </button>
  `;
}

function renderMaterialOptions(cat: Category): string {
  const options = optionsFor(cat);
  const selectedId = selection[cat];
  return `
    <div class="pill-group" data-category="${cat}">
      ${options
        .map(
          (o) =>
            `<button class="pill ${selectedId === o.id ? "active" : ""}" data-value="${o.id}">${escapeHtml(L(o.label))}</button>`
        )
        .join("")}
    </div>
  `;
}

function renderFeaturedTag(
  event: { featuredOption: { category: Category; optionId: string; label: Localized } | null },
  isNewToMe: boolean
): string {
  if (!event.featuredOption) return "";
  // `.label` is missing on events cached before the AI-invention rearchitecture
  // (they only ever stored {category, optionId}) — fall back to a lookup so
  // those old entries still show a name instead of rendering blank.
  const label = event.featuredOption.label?.zh
    ? L(event.featuredOption.label)
    : optionLabel(event.featuredOption.optionId);
  if (!label) return "";
  const prefix = isNewToMe ? t("newUnlockPrefix") : t("featuredPrefix");
  return `<div class="unlock-toast">${prefix} — ${L(CATEGORY_LABEL[event.featuredOption.category])}:${escapeHtml(label)}</div>`;
}

/** Pops up right after a successful resolve — closed explicitly by the
 * player rather than being replaced by the next result, so they always get
 * a clear look at what just happened instead of it blending into the page. */
function renderResultModal(): string {
  if (!lastResult || !resultModalOpen) return "";
  const { event, isNewDiscovery, isFeaturedOptionNewToMe } = lastResult;
  return `
    <div class="modal-backdrop">
      <div class="modal-card result-modal-card ${isNewDiscovery ? "result-modal-new" : ""}">
        <div class="result-title-row">
          <h2>${escapeHtml(L(event.title))}</h2>
          <span class="${isNewDiscovery ? "badge-new" : "badge-repeat"}">${isNewDiscovery ? t("firstDiscovery") : t("repeatEvent")}</span>
        </div>
        <p class="result-desc">${escapeHtml(L(event.description))}</p>
        <p class="result-meta">${t("spentLabel", { duration: formatDuration(event.durationUnits) })}</p>
        <p class="result-meta">🔎 ${t("discovererLine", { name: event.discovererName, time: formatTimestamp(event.discoveredAt) })}</p>
        ${renderFeaturedTag(event, isFeaturedOptionNewToMe)}
        <div class="modal-actions">
          <button id="result-modal-close-btn" class="modal-btn-primary">${t("closeBtn")}</button>
        </div>
      </div>
    </div>
  `;
}

function renderHistoryEntry(key: string): string {
  const ev = state.eventsByCombo[key];
  const isExpanded = expandedHistoryKeys.has(key);

  if (!isExpanded) {
    return `
      <li class="collection-entry collection-entry-collapsed">
        <button class="collection-entry-toggle" data-history-key="${key}">
          <span class="collection-entry-title">${escapeHtml(L(ev.title))}</span>
          <span class="collection-entry-chevron">▾</span>
        </button>
      </li>
    `;
  }

  const labels = decodeComboKey(key, state.knownMaterials);
  const tags = CATEGORY_ORDER.filter((cat) => labels[cat]).map(
    (cat) => `<span class="tag">${L(CATEGORY_LABEL[cat])}:${escapeHtml(L(labels[cat]!))}</span>`
  );

  return `
    <li class="collection-entry collection-entry-expanded">
      <button class="collection-entry-toggle" data-history-key="${key}">
        <span class="collection-entry-title">${escapeHtml(L(ev.title))}</span>
        <span class="collection-entry-chevron">▴</span>
      </button>
      <div class="collection-entry-details">
        <div class="collection-entry-header">
          <span class="collection-entry-duration">${formatDuration(ev.durationUnits)}</span>
        </div>
        <div class="tag-row">${tags.length > 0 ? tags.join("") : `<span class="tag tag-empty">${t("noMaterialsTag")}</span>`}</div>
        <p class="collection-desc">${escapeHtml(L(ev.description))}</p>
        ${(() => {
          if (!ev.featuredOption) return "";
          // See renderFeaturedTag's comment — old cached events predate the
          // inline `.label` field on featuredOption.
          const label = ev.featuredOption.label?.zh ? L(ev.featuredOption.label) : optionLabel(ev.featuredOption.optionId);
          return label
            ? `<p class="collection-featured">🏷 ${L(CATEGORY_LABEL[ev.featuredOption.category])}:${escapeHtml(label)}</p>`
            : "";
        })()}
        <p class="collection-discoverer">${t("discovererLine", { name: ev.discovererName, time: formatTimestamp(ev.discoveredAt) })}</p>
      </div>
    </li>
  `;
}

/** Same segments buildComboKey/decodeComboKey work with, but returns the raw
 * ids rather than labels — needed for exact-match filtering (two different
 * ids could in principle share a label, however unlikely in practice). */
function decodeComboKeyIds(comboKey: string): Partial<Record<Category, string>> {
  const result: Partial<Record<Category, string>> = {};
  for (const part of comboKey.split("|")) {
    const [cat, id] = part.split(":");
    if (!id || id === "none") continue;
    if (!(cat in CATEGORY_LABEL)) continue;
    result[cat as Category] = id;
  }
  return result;
}

/** Every distinct material this player has personally selected into a combo
 * (across all their collected events), grouped by category — the option
 * lists for the four filter dropdowns. Featured/unlocked-but-never-selected
 * materials aren't included, matching what the collapsed tag row already
 * shows for each entry. */
function historyMaterialOptions(): Record<Category, { id: string; label: Localized }[]> {
  const seen: Record<Category, Map<string, Localized>> = {
    person: new Map(),
    matter: new Map(),
    place: new Map(),
    object: new Map(),
  };
  for (const key of state.collectedComboKeys) {
    const ids = decodeComboKeyIds(key);
    for (const cat of CATEGORY_ORDER) {
      const id = ids[cat];
      if (!id || seen[cat].has(id)) continue;
      const label = getOptionById(id, state.knownMaterials)?.label;
      if (label) seen[cat].set(id, label);
    }
  }
  const result = {} as Record<Category, { id: string; label: Localized }[]>;
  const locale = state.language === "en" ? "en" : "zh-Hant";
  for (const cat of CATEGORY_ORDER) {
    result[cat] = Array.from(seen[cat], ([id, label]) => ({ id, label })).sort((a, b) =>
      L(a.label).localeCompare(L(b.label), locale)
    );
  }
  return result;
}

/** Per-category exact-material filter + free-text search (title/description/
 * 發現人/tag labels), all combined with AND. */
function historyMatchesFilters(key: string): boolean {
  const ev = state.eventsByCombo[key];
  if (!ev) return false;

  const ids = decodeComboKeyIds(key);
  for (const cat of CATEGORY_ORDER) {
    const wanted = historyFilters[cat];
    if (wanted && ids[cat] !== wanted) return false;
  }

  const query = historySearchQuery.trim().toLowerCase();
  if (!query) return true;
  const labels = decodeComboKey(key, state.knownMaterials);
  const haystack = [L(ev.title), L(ev.description), ev.discovererName, ...Object.values(labels).map(L)]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function renderHistoryListItems(): string {
  const keys = state.collectedComboKeys.slice().reverse().filter(historyMatchesFilters);
  if (keys.length > 0) return keys.map((key) => renderHistoryEntry(key)).join("");
  return state.collectedComboKeys.length === 0
    ? `<li class="collection-empty">${t("emptyHistory")}</li>`
    : `<li class="collection-empty">${t("noMatchingHistory")}</li>`;
}

function renderHistoryContent(): string {
  const materialOptions = historyMaterialOptions();
  return `
    <div class="history-controls">
      <div class="history-search">
        <input
          id="history-search-input"
          class="history-search-input"
          type="text"
          placeholder="${t("historySearchPlaceholder")}"
          value="${escapeHtml(historySearchQuery)}"
        />
        <button
          id="history-search-clear-btn"
          class="history-search-clear"
          title="${t("clearSearchTitle")}"
          style="visibility:${historySearchQuery ? "visible" : "hidden"}"
        >✕</button>
      </div>
      <div class="history-filter-row">
        ${CATEGORY_ORDER.map(
          (cat) => `
            <select class="history-filter-select" data-history-filter-category="${cat}">
              <option value="">${t("filterAllOption", { category: L(CATEGORY_LABEL[cat]) })}</option>
              ${materialOptions[cat]
                .map(
                  (o) =>
                    `<option value="${o.id}" ${historyFilters[cat] === o.id ? "selected" : ""}>${escapeHtml(L(o.label))}</option>`
                )
                .join("")}
            </select>
          `
        ).join("")}
      </div>
    </div>
    <ol class="collection-list collection-list-full" id="collection-list">
      ${renderHistoryListItems()}
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
      <p>${t("marketNotice")}</p>
    </section>
    <div class="market-grid">
      ${STAMINA_PACKAGES.map(
        (p) => `
          <div class="market-card">
            <div class="market-units">${t("unitsSuffix", { n: p.units })}</div>
            <div class="market-sub">${formatDuration(p.units)}</div>
            <div class="market-price">NT$ ${p.priceNTD}</div>
            <button class="market-buy-btn" disabled>${t("notAvailable")}</button>
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

function attachAccountMenuHandlers() {
  document.querySelector<HTMLButtonElement>("#language-toggle-btn")?.addEventListener("click", () => {
    state.language = state.language === "zh" ? "en" : "zh";
    persist();
    render();
  });

  document.querySelector<HTMLButtonElement>("#account-menu-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    accountMenuOpen = !accountMenuOpen;
    render();
  });

  document.querySelector<HTMLButtonElement>("#edit-name-btn")?.addEventListener("click", () => {
    nameInputDraft = state.playerName;
    nameModalCanCancel = true;
    nameModalOpen = true;
    render();
  });

  document.querySelector<HTMLButtonElement>("#reset-btn")?.addEventListener("click", () => {
    const ok = window.confirm(t("confirmResetProgress"));
    if (!ok) return;
    localStorage.removeItem(STORAGE_KEY);
    state = settleStamina(loadState());
    selection = emptySelection();
    durationUnits = 1;
    lastResult = null;
    resultStale = false;
    resultModalOpen = false;
    persist();
    render();
  });

  document.querySelector<HTMLButtonElement>("#google-signin-btn")?.addEventListener("click", async () => {
    if (currentUser && isGoogleLinked(currentUser)) return;
    const localPlayerName = state.playerName;
    try {
      syncNotice = t("noticeOpeningGoogle");
      render();
      const user = await signInWithGoogle();
      currentUser = user;
      const remote = await pullRemoteState(user.uid);
      if (remote) {
        state = remote;
        // Don't let adopting a nameless remote profile erase a name the
        // player had already set locally on this device.
        if (!state.playerName && localPlayerName) state.playerName = localPlayerName;
        syncNotice = t("noticeRestoredFromCloud");
      } else {
        syncNotice = t("noticeGoogleLinked");
        persist();
      }
    } catch (err) {
      console.warn("Google 登入失敗", err);
      syncNotice = t("noticeGoogleSignInFailed");
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#signout-btn")?.addEventListener("click", async () => {
    const ok = window.confirm(t("confirmSignOut"));
    if (!ok) return;
    try {
      currentUser = await signOutToLocal();
      syncNotice = t("noticeSignedOut");
    } catch (err) {
      console.warn("登出失敗", err);
      syncNotice = t("noticeSignOutFailed");
    }
    render();
  });
}

function attachNameModalHandlers() {
  const input = document.querySelector<HTMLInputElement>("#name-input");
  input?.focus();
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      document.querySelector<HTMLButtonElement>("#name-confirm-btn")?.click();
    }
  });

  document.querySelector<HTMLButtonElement>("#name-confirm-btn")?.addEventListener("click", () => {
    const value = input?.value.trim() ?? "";
    if (!value) return;
    state.playerName = value.slice(0, 12);
    nameModalOpen = false;
    if (!nameModalCanCancel && !state.hasSeenTutorial) {
      state.hasSeenTutorial = true;
      tutorialStep = 0;
    }
    persist();
    render();
  });

  document.querySelector<HTMLButtonElement>("#name-cancel-btn")?.addEventListener("click", () => {
    nameModalOpen = false;
    render();
  });
}

function attachTutorialHandlers() {
  document.querySelector<HTMLButtonElement>("#tutorial-next-btn")?.addEventListener("click", () => {
    if (tutorialStep === null) return;
    tutorialStep = tutorialStep >= TUTORIAL_STEPS.length - 1 ? null : tutorialStep + 1;
    render();
  });

  document.querySelector<HTMLButtonElement>("#tutorial-skip-btn")?.addEventListener("click", () => {
    tutorialStep = null;
    render();
  });
}

function attachResultModalHandlers() {
  document.querySelector<HTMLButtonElement>("#result-modal-close-btn")?.addEventListener("click", () => {
    resultModalOpen = false;
    render();
  });
}

/** Shared by the initial render and by patchHistoryList's targeted DOM patch
 * (search typing) — both need the collapse/expand toggle wired up. */
function attachHistoryEntryToggles(root: ParentNode) {
  root.querySelectorAll<HTMLButtonElement>(".collection-entry-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.historyKey!;
      if (expandedHistoryKeys.has(key)) expandedHistoryKeys.delete(key);
      else expandedHistoryKeys.add(key);
      render();
    });
  });
}

/** Re-renders just the entry list in place, leaving the search `<input>`
 * untouched — a full render() on every keystroke would destroy and recreate
 * that element, dropping focus/cursor position and breaking IME composition
 * for Chinese input (same class of issue the duration slider already works
 * around with its own input/change split). */
function patchHistoryList() {
  const list = document.querySelector<HTMLOListElement>("#collection-list");
  if (!list) return;
  list.innerHTML = renderHistoryListItems();
  attachHistoryEntryToggles(list);
}

function attachHistoryHandlers() {
  attachHistoryEntryToggles(app);

  const searchInput = document.querySelector<HTMLInputElement>("#history-search-input");
  searchInput?.addEventListener("input", () => {
    historySearchQuery = searchInput.value;
    const clearBtn = document.querySelector<HTMLElement>("#history-search-clear-btn");
    if (clearBtn) clearBtn.style.visibility = historySearchQuery ? "visible" : "hidden";
    patchHistoryList();
  });

  document.querySelector<HTMLButtonElement>("#history-search-clear-btn")?.addEventListener("click", () => {
    historySearchQuery = "";
    render();
  });

  app.querySelectorAll<HTMLSelectElement>(".history-filter-select").forEach((select) => {
    select.addEventListener("change", () => {
      const cat = select.dataset.historyFilterCategory as Category;
      historyFilters[cat] = select.value || null;
      render();
    });
  });
}

function attachPlayHandlers() {
  app.querySelectorAll<HTMLElement>(".pill-group").forEach((group) => {
    const cat = group.dataset.category as Category;
    group.querySelectorAll<HTMLButtonElement>(".pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.dataset.value || "";
        // No explicit "不選" pill anymore — clicking the already-selected
        // option toggles it back off instead.
        selection[cat] = selection[cat] === value ? null : value;
        resultStale = true;
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
    resultStale = true;
    render();
  });
  plusBtn?.addEventListener("click", () => {
    durationUnits = Math.min(maxSelectableUnits(), durationUnits + 1);
    resultStale = true;
    render();
  });
  range?.addEventListener("input", () => {
    durationUnits = Number(range.value);
    resultStale = true;
    // A full render() here would rebuild the DOM mid-drag and replace the
    // very <input> the user is actively dragging, killing the native drag
    // gesture after a pixel of movement. Patch just the live-value bits
    // directly instead; a full render() still happens once on "change"
    // (drag release) to reconcile everything else.
    const label = document.querySelector<HTMLElement>(".time-bar-label");
    if (label) label.textContent = formatDuration(durationUnits);
    if (minusBtn) minusBtn.disabled = durationUnits <= 1;
    if (plusBtn) plusBtn.disabled = durationUnits >= maxSelectableUnits();
  });
  range?.addEventListener("change", () => {
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
    resultModalOpen = true;
    // 素材選擇每次事件後自動回歸預設,時間長度則保留給下一次沿用。
    selection = emptySelection();
    resultStale = false;
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

// Re-measure the tutorial's target element on resize/rotate — a full
// render() isn't needed, positionTutorialOverlay() just re-reads layout.
window.addEventListener("resize", () => {
  if (tutorialStep !== null) positionTutorialOverlay();
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

// Ticks every second so the "MM:SS 後 +1" countdown actually counts down live.
// A full render() every second would rebuild the whole page mid-drag if the
// player happens to be dragging the duration slider at that moment (same
// class of issue as the slider's own input/change split above) — so the
// common case just patches the countdown text directly. A full render() (plus
// persist()) only happens on the rarer occasion a stamina unit actually
// regenerates, since that changes the bar/percentage/resolve-button state too.
setInterval(() => {
  const before = state.staminaUnits;
  settleStamina(state);
  if (state.staminaUnits !== before) {
    persist();
    render();
    return;
  }
  const hint = document.querySelector<HTMLElement>(".stamina-mini-hint");
  if (hint && state.staminaUnits < MAX_STAMINA_UNITS) {
    hint.textContent = t("regenCountdown", { time: formatCountdown(secondsUntilNextUnit(state)) });
  }
}, 1_000);
