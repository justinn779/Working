import { fetchCurrentAnnouncement } from "./announcements";
import { fetchActiveCampaigns } from "./campaigns";
import { deleteRemoteState, notifyPlayerRegistered, pullRemoteState, pushRemoteState } from "./cloudSync";
import { buildComboKey, decodeComboKey, getOptionById, hasAnySelection } from "./combo";
import { MAX_STAMINA_UNITS, REGEN_MINUTES_PER_UNIT, STORAGE_KEY, UNIT_MINUTES } from "./config";
import { SEED_OPTIONS } from "./data/options";
import { resolveAction, type ResolveResult } from "./eventEngine";
import {
  completeGoogleRedirectSignIn,
  ensureSignedIn,
  isGoogleLinked,
  signInWithGoogle,
  signOutToLocal,
} from "./firebase";
import { t as translate } from "./i18n";
import {
  captureTopupOrder,
  createTopupOrder,
  getOrderStatus,
  listTopupProducts,
  usePotion,
  type TopupOrder,
  type TopupProduct,
} from "./paypalTopup";
import { loadPaypalSdk, renderPaypalButtons } from "./paypalSdk";
import {
  hasSavedState,
  isUnlocked,
  loadState,
  saveState,
  settleStamina,
  type GameState,
} from "./state";
import { CATEGORY_LABEL, CATEGORY_ORDER, PLAYER_TOKEN } from "./types";
import type { Announcement, Campaign, Category, Localized, Selection } from "./types";
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

/** Story text never contains a real name (see types.ts's PLAYER_TOKEN) — this
 * swaps the placeholder for the *current viewer's* own name at display time,
 * so a shared/cached event always reads as "you", regardless of who
 * originally discovered it (that's what the separate discovererName field is
 * for). A no-op on text that never had the token in the first place, e.g.
 * the local offline fallback, which already bakes in the real name directly
 * since it's never shared with anyone else. */
function personalize(text: string): string {
  const name = state.playerName || t("youFallback"); // shouldn't happen — name is required before play
  return text.split(PLAYER_TOKEN).join(name);
}

function emptySelection(): Selection {
  return { person: null, matter: null, place: null, object: null };
}

type View = "play" | "history" | "market" | "activities";

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
/** True right after a resolve attempt exhausted all its retries with no
 * local fallback to fall back to — the player's stamina was already
 * refunded (see eventEngine.ts's resolveAction), this just tells them why
 * nothing happened and that trying again is the right move. */
let generationFailedFlash = false;
let isResolving = false;
/** Units at/above which starting an event needs an extra confirmation tap —
 * 3 units = 30 minutes, easy to bump past accidentally while dragging the
 * time slider, and the AI generation can't be cancelled once started. */
const LONG_DURATION_CONFIRM_THRESHOLD_UNITS = 3;
let longDurationConfirmOpen = false;
let pendingResolveDuration: number | null = null;
let currentUser: User | null = null;
let syncNotice: string | null = null;
let view: View = "play";
let accountMenuOpen = false;
/** Collapsed by default — the explanation only shows once the player taps
 * the ❗ next to their job title, not every time they open the dropdown. */
let jobTitleHintOpen = false;
let nameModalOpen = false;
/** false only for the forced first-time prompt (no playerName yet) — once a
 * name exists, reopening the modal to edit it can be cancelled. */
let nameModalCanCancel = true;
let nameInputDraft = "";
/** Index into TUTORIAL_STEPS while the guided tour is active, null otherwise. */
let tutorialStep: number | null = null;

// --- Admin-authored announcement modal (see admin.html) ---
let announcement: Announcement | null = null;
let announcementModalOpen = false;
let announcementDismissForeverChecked = false;

async function loadAnnouncementAndMaybeShow() {
  try {
    announcement = await fetchCurrentAnnouncement();
  } catch (err) {
    console.warn("公告載入失敗", err);
    return;
  }
  if (!announcement?.enabled) return;
  if (announcement.dismissible && state.dismissedAnnouncementId === announcement.id) return;
  announcementModalOpen = true;
  render();
}

function renderAnnouncementModal(): string {
  if (!announcement) return "";
  return `
    <div class="modal-backdrop">
      <div class="modal-card">
        <h2>${escapeHtml(L(announcement.title))}</h2>
        <p class="modal-hint">${escapeHtml(L(announcement.body)).replace(/\n/g, "<br/>")}</p>
        ${
          announcement.dismissible
            ? `<label class="modal-checkbox-row">
                 <input type="checkbox" id="announcement-dismiss-forever" ${announcementDismissForeverChecked ? "checked" : ""} />
                 <span>${t("announcementDismissForeverLabel")}</span>
               </label>`
            : ""
        }
        <div class="modal-actions">
          <button id="announcement-close-btn" class="modal-btn-primary">${t("closeBtn")}</button>
        </div>
      </div>
    </div>
  `;
}

function attachAnnouncementModalHandlers() {
  document.querySelector<HTMLInputElement>("#announcement-dismiss-forever")?.addEventListener("change", (e) => {
    announcementDismissForeverChecked = (e.target as HTMLInputElement).checked;
  });
  document.querySelector<HTMLButtonElement>("#announcement-close-btn")?.addEventListener("click", () => {
    if (announcement?.dismissible && announcementDismissForeverChecked) {
      state.dismissedAnnouncementId = announcement.id;
      persist();
    }
    announcementModalOpen = false;
    render();
  });
}

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
/** Which single category the material list is narrowed to — null means "show
 * every unlocked material from all four categories at once" (the default).
 * Toggled by clicking one of the four slot boxes in the action bar; clicking
 * the already-active one clears it back to null. */
let activeCategory: Category | null = null;
/** "label" sorts alphabetically (locale-aware); "unlockOrder" sorts by the
 * order state.unlockedOptionIds recorded them in (oldest first) — not
 * persisted, resets to alphabetical on reload like the other transient
 * play-page UI state (historySearchQuery, historyFilters, etc). */
type MaterialSortMode = "label" | "unlockOrder";
let materialSortMode: MaterialSortMode = "unlockOrder";

// --- Activities (活動) state ---
let campaigns: Campaign[] | null = null;
let campaignsLoading = false;
let campaignsLoadError: string | null = null;
/** comboKey-style expand/collapse, keyed by campaign id — collapsed by
 * default so the tab reads as a scannable list of titles, same reasoning as
 * the history tab's expandedHistoryKeys. */
const expandedCampaignIds = new Set<string>();

// --- PayPal top-up (商城) state ---
let marketProducts: TopupProduct[] | null = null;
let marketLoading = false;
let marketLoadError: string | null = null;
/** productId currently being consumed via "使用" — disables just that
 * button, not the whole page, while the usePotion call is in flight. */
let potionUseBusyId: string | null = null;
let potionUseError: string | null = null;
/** "confirm" gates a purchase (shown once, before the very first buy);
 * "review" is opened any time via the market page's "查看條款" link and has
 * no side effect on close. */
let consentModalOpen = false;
let consentModalMode: "confirm" | "review" = "confirm";
/** Which product the buyer was trying to purchase when the confirm-gate
 * fired — resumed automatically once they confirm, so agreeing to the
 * terms doesn't lose their in-progress click. */
let pendingPurchaseProduct: TopupProduct | null = null;
const SUPPORT_EMAIL = "working.ata.lee@gmail.com";

type PurchaseFlow =
  | { kind: "idle" }
  /** `paypalOrderId` is null while createTopupOrder is still in flight, then
   * set once we have a real PayPal order to mount Buttons against — see
   * attachMarketHandlers, which only renders the Buttons once it's set. */
  | { kind: "processing"; orderId: string | null; paypalOrderId: string | null }
  | { kind: "success"; order: TopupOrder }
  | { kind: "failed"; message: string }
  | { kind: "cancelled" }
  /** Our own capture call itself failed/timed out (network blip, function
   * cold start, etc.) — independent of whether PayPal's side actually
   * succeeded. Must never be shown as a failure: the webhook or a manual
   * recheck is what resolves this, not telling the player to pay again. */
  | { kind: "pending"; orderId: string };

let purchaseFlow: PurchaseFlow = { kind: "idle" };
/** Indirection so a click-driven mutation of `purchaseFlow` mid-`await` in
 * handleBuy is actually observed — a direct `purchaseFlow.kind === "..."`
 * check right after an `await` gets over-narrowed by TS's control-flow
 * analysis to whatever was last assigned in that function, ignoring that a
 * button handler could have reassigned the module-level variable in the
 * meantime. */
function purchaseFlowKind(): PurchaseFlow["kind"] {
  return purchaseFlow.kind;
}

async function loadCampaigns() {
  campaignsLoading = true;
  campaignsLoadError = null;
  render();
  try {
    campaigns = await fetchActiveCampaigns();
  } catch (err) {
    campaignsLoadError = t("activitiesLoadError");
    console.warn("活動清單載入失敗", err);
  }
  campaignsLoading = false;
  render();
}

async function loadMarketProducts() {
  marketLoading = true;
  marketLoadError = null;
  render();
  try {
    marketProducts = await listTopupProducts();
  } catch (err) {
    marketLoadError = t("marketLoadError");
    console.warn("市集商品載入失敗", err);
  }
  marketLoading = false;
  render();
}

function handleBuy(product: TopupProduct) {
  if (purchaseFlow.kind === "processing") return;
  if (!state.consentAcceptedAt) {
    pendingPurchaseProduct = product;
    consentModalMode = "confirm";
    consentModalOpen = true;
    render();
    return;
  }
  proceedToBuy(product);
}

function handleViewTerms() {
  consentModalMode = "review";
  consentModalOpen = true;
  render();
}

function handleConsentConfirm() {
  state.consentAcceptedAt = Date.now();
  persist();
  consentModalOpen = false;
  const product = pendingPurchaseProduct;
  pendingPurchaseProduct = null;
  render();
  if (product) proceedToBuy(product);
}

function handleConsentClose() {
  consentModalOpen = false;
  pendingPurchaseProduct = null;
  render();
}

async function proceedToBuy(product: TopupProduct) {
  purchaseFlow = { kind: "processing", orderId: null, paypalOrderId: null };
  render();

  let order: TopupOrder;
  try {
    order = await createTopupOrder(product.id);
  } catch (err) {
    purchaseFlow = { kind: "failed", message: (err as Error)?.message ?? String(err) };
    render();
    return;
  }

  // The buyer could have clicked "取消" while createTopupOrder's network
  // call was still in flight — don't stomp that with a stale "processing".
  if (purchaseFlowKind() === "cancelled") return;
  if (!order.paypalOrderId) {
    purchaseFlow = { kind: "failed", message: t("marketFailedTitle") };
    render();
    return;
  }
  // Mounting the actual PayPal Buttons for this paypalOrderId happens in
  // attachMarketHandlers right after this render(), not here — rendering
  // is main.ts's job, the SDK call belongs next to the DOM it targets.
  purchaseFlow = { kind: "processing", orderId: order.orderId, paypalOrderId: order.paypalOrderId };
  render();
}

/** Called once the buyer approves payment in the PayPal popup. This is the
 * ONLY place captureTopupOrder is invoked from the client — the webhook is
 * the other caller, and both funnel into the same backend idempotent
 * captureAndCredit, never a separate path. */
async function handlePaypalApprove(orderId: string) {
  purchaseFlow = { kind: "processing", orderId, paypalOrderId: null }; // hide the buttons while confirming
  render();
  try {
    const captured = await captureTopupOrder(orderId);
    if (captured.status === "CREDITED") {
      purchaseFlow = { kind: "success", order: captured };
      await refreshWalletFromServer();
    } else if (captured.status === "FAILED") {
      purchaseFlow = { kind: "failed", message: captured.failureReason ?? t("marketFailedTitle") };
    } else {
      purchaseFlow = { kind: "pending", orderId };
    }
  } catch (err) {
    console.warn("確認付款失敗(訂單可能仍在處理中)", err);
    purchaseFlow = { kind: "pending", orderId };
  }
  render();
}

async function refreshWalletFromServer() {
  if (!currentUser) return;
  try {
    const remote = await pullRemoteState(currentUser.uid);
    if (remote) {
      state.wallet = remote.wallet;
      saveState(state);
    }
  } catch (err) {
    console.warn("同步錢包餘額失敗", err);
  }
}

async function handleRecheckOrder(orderId: string) {
  try {
    const order = await getOrderStatus(orderId);
    if (order.status === "CREDITED") {
      purchaseFlow = { kind: "success", order };
      await refreshWalletFromServer();
    } else if (order.status === "FAILED") {
      purchaseFlow = { kind: "failed", message: order.failureReason ?? t("marketFailedTitle") };
    } else {
      purchaseFlow = { kind: "pending", orderId };
    }
  } catch (err) {
    console.warn("查詢訂單狀態失敗", err);
  }
  render();
}

/** Drinks one owned potion — buying and using are separate actions, so a
 * player can stockpile potions and use them whenever they actually need the
 * stamina, not just the moment they buy one. */
async function handleUsePotion(productId: string) {
  if (potionUseBusyId) return;
  potionUseBusyId = productId;
  potionUseError = null;
  render();
  try {
    const result = await usePotion(productId);
    state.wallet.potions = result.potions;
    // Purchased stamina is meant to let a paying player exceed the free
    // regen cap — unlike natural regen (settleStamina), this intentionally
    // does not clamp to MAX_STAMINA_UNITS.
    state.staminaUnits += result.units;
    persist();
  } catch (err) {
    potionUseError = t("marketUseFailed");
    console.warn("使用藥水失敗", err);
  }
  potionUseBusyId = null;
  render();
}
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

/** Compact "x時y分z秒" form used for the header stamina readout. `units` can
 * be fractional (see displayStaminaUnits) — floored to whole seconds so it
 * ticks up live, second by second, instead of jumping once a minute. */
function formatHoursMinutesSeconds(units: number): string {
  const totalSeconds = Math.floor(units * UNIT_MINUTES * 60);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return t("compactHoursMinutesSeconds", { h, m, s });
}

/** Fractional stamina for DISPLAY only — smoothly creeps from
 * state.staminaUnits toward +1 over the current regen cycle (REGEN_MINUTES_
 * PER_UNIT real minutes) so the header bar/label visibly fills second by
 * second instead of sitting frozen and then jumping a whole 10-game-minute
 * unit at once. Never used for anything spendable — actual duration
 * selection and spendStamina() only ever look at the real, whole-unit
 * state.staminaUnits, so a player still can't act on a partial unit. */
function displayStaminaUnits(): number {
  if (state.staminaUnits >= MAX_STAMINA_UNITS) return MAX_STAMINA_UNITS;
  const elapsedMs = Date.now() - state.staminaLastSettled;
  const cycleMs = REGEN_MINUTES_PER_UNIT * 60_000;
  const fraction = Math.min(1, Math.max(0, elapsedMs / cycleMs));
  return state.staminaUnits + fraction;
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
  // AI invention has no dedup step (by design — see functions/src/index.ts),
  // so it can occasionally coin a label that already exists under a
  // different id (e.g. inventing "茶水間" again despite the seed option of
  // the same name). Collapse same-looking pills at the display layer, in
  // whichever language is currently shown, rather than making generation
  // itself dedup-aware — keeps the invention prompt simple and this bug
  // fixed regardless of which language surfaced the collision first. First
  // occurrence wins (seed options take priority over dynamic ones).
  const seenLabels = new Set<string>();
  const deduped: { id: string; category: Category; label: Localized }[] = [];
  for (const option of [...seedOptions, ...dynamicOptions]) {
    const displayed = L(option.label);
    if (seenLabels.has(displayed)) continue;
    seenLabels.add(displayed);
    deduped.push(option);
  }
  return deduped;
}

/** Always grouped by category (in CATEGORY_ORDER) — the sort toggle only
 * decides the order *within* each group, never mixes categories together.
 * When `cat` is null (the default "show everything" view) that means four
 * consecutive groups; when the player has narrowed the picker via a slot
 * click, it's just the one group. */
function materialOptionsFor(cat: Category | null): { id: string; category: Category; label: Localized }[] {
  const orderIndex = new Map(state.unlockedOptionIds.map((id, i) => [id, i]));
  const locale = state.language === "en" ? "en" : "zh-Hant";
  const sortGroup = (items: { id: string; category: Category; label: Localized }[]) =>
    items
      .slice()
      .sort((a, b) =>
        materialSortMode === "unlockOrder"
          ? (orderIndex.get(a.id) ?? Infinity) - (orderIndex.get(b.id) ?? Infinity)
          : L(a.label).localeCompare(L(b.label), locale)
      );
  return (cat ? [cat] : CATEGORY_ORDER).flatMap((c) => sortGroup(optionsFor(c)));
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
    view === "history"
      ? renderHistoryContent()
      : view === "market"
        ? renderMarketContent()
        : view === "activities"
          ? renderActivitiesContent()
          : renderPlayContent();

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
    ${nameModalOpen ? renderNameModal() : !nameModalOpen && announcementModalOpen ? renderAnnouncementModal() : ""}
    ${tutorialStep !== null ? renderTutorialOverlay() : ""}
    ${resultModalOpen ? renderResultModal() : ""}
    ${longDurationConfirmOpen ? renderLongDurationConfirmModal() : ""}
  `;

  attachTabNavHandlers();
  attachAccountMenuHandlers();
  if (view === "play") attachPlayHandlers();
  if (view === "history") attachHistoryHandlers();
  if (view === "market") attachMarketHandlers();
  if (view === "activities") attachActivitiesHandlers();
  if (nameModalOpen) attachNameModalHandlers();
  else if (announcementModalOpen) attachAnnouncementModalHandlers();
  if (resultModalOpen) attachResultModalHandlers();
  if (tutorialStep !== null) {
    attachTutorialHandlers();
    positionTutorialOverlay();
  }
}

function renderHeaderStamina(): string {
  const displayUnits = displayStaminaUnits();
  const pct = Math.min(100, (displayUnits / MAX_STAMINA_UNITS) * 100);
  return `
    <div class="stamina-mini">
      <div class="stamina-mini-row">
        <span class="stamina-mini-label">${t("staminaLabel")}</span>
        <span class="stamina-mini-value">${formatHoursMinutesSeconds(displayUnits)}</span>
      </div>
      <div class="stamina-bar"><div class="stamina-fill" style="width:${pct}%"></div></div>
    </div>
  `;
}

function renderAccountMenu(): string {
  const loggedIn = !!currentUser && isGoogleLinked(currentUser);
  const label = state.playerName || "…";
  return `
    <div class="account-menu">
      <button id="account-menu-btn" class="account-badge ${loggedIn ? "account-badge-cloud" : "account-badge-local"}">
        <span class="account-badge-icon">${loggedIn ? "☁️" : "🔒"}</span>
        <span class="account-badge-lines">
          <span class="account-badge-jobtitle">${escapeHtml(L(state.jobTitle))}</span>
          <span class="account-badge-label">${escapeHtml(label)}</span>
        </span>
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
      <div class="account-dropdown-name-row">
        <span class="account-dropdown-name-label">${t("jobTitleLabel")}</span>
        <span class="account-dropdown-name-value">${escapeHtml(L(state.jobTitle))}</span>
        <button id="job-title-hint-btn" class="account-name-edit-btn" title="${t("jobTitleHintTitle")}">${INFO_ICON}</button>
      </div>
      ${jobTitleHintOpen ? `<p class="account-dropdown-info">${t("jobTitleHint")}</p>` : ""}
      <button id="language-toggle-btn" class="account-dropdown-btn">${t("languageToggle")}</button>
      ${
        loggedIn
          ? `<p class="account-dropdown-info">${t("googleSyncedInfo")}</p>
             <button id="signout-btn" class="account-dropdown-btn">${t("signOut")}</button>`
          : `<p class="account-dropdown-info">${t("localOnlyInfo")}</p>
             <button id="google-signin-btn" class="account-dropdown-btn">${t("googleSignIn")}</button>`
      }
      ${syncNotice ? `<p class="account-dropdown-notice">${escapeHtml(syncNotice)}</p>` : ""}
      <hr class="account-dropdown-divider" />
      <button id="delete-account-btn" class="account-dropdown-btn account-dropdown-btn-danger">${t("deleteAccount")}</button>
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

function renderLongDurationConfirmModal(): string {
  const units = pendingResolveDuration ?? durationUnits;
  return `
    <div class="modal-backdrop">
      <div class="modal-card">
        <h2>${t("longDurationConfirmTitle")}</h2>
        <p class="modal-hint">${t("longDurationConfirmBody", { duration: formatDuration(units) })}</p>
        <div class="modal-actions">
          <button id="long-duration-cancel-btn" class="modal-btn-secondary">${t("cancel")}</button>
          <button id="long-duration-confirm-btn" class="modal-btn-primary">${t("confirm")}</button>
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
    { key: "activities", labelKey: "tabActivities" },
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

/** Plain single-colour stroke icons (not emoji) for the sort toggle — using
 * `currentColor` lets them inherit .sort-toggle-btn's text colour, so the
 * active/hover states already defined in CSS just work without a second
 * "active" icon variant. */
const SORT_ALPHA_ICON =
  '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="5" x2="9" y2="5"/><line x1="3" y1="10" x2="12" y2="10"/><line x1="3" y1="15" x2="15" y2="15"/><path d="M17 4v9m0 0l-2.5-2.5M17 13l2.5-2.5"/></svg>';
const SORT_CLOCK_ICON =
  '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><path d="M10 5.5V10l3 2"/></svg>';

/** Plain single-colour exclamation mark (not the red ❗ emoji) for the
 * job-title-hint toggle — inherits the button's text colour via
 * currentColor instead of always rendering red/yellow regardless of theme. */
const INFO_ICON =
  '<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><rect x="8.7" y="3" width="2.6" height="9" rx="1.3"/><rect x="8.7" y="14" width="2.6" height="2.6" rx="1.3"/></svg>';

/** Simple potion-bottle outline for the shop — size is passed in per product
 * so 大瓶/小瓶 reads visually as well as by name (see renderMarketCard). */
function potionIcon(size: number): string {
  return `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3h4M8.5 3v3.2c0 .5-.2 1-.6 1.4L6.5 9c-.7.7-1 1.6-1 2.6V15a2 2 0 002 2h5a2 2 0 002-2v-3.4c0-1-.4-1.9-1-2.6l-1.4-1.4a2 2 0 01-.6-1.4V3"/></svg>`;
}

/** Resolve button's busy state — a plain spinning ring, no text. See
 * .spinner-icon in style.css for the rotation keyframes; stroke-dasharray
 * leaves a gap so the ring reads as spinning rather than a static circle. */
const SPINNER_ICON =
  '<svg class="spinner-icon" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10" cy="10" r="7.5" stroke-dasharray="35 12"/></svg>';

function renderPlayContent(): string {
  const remaining = state.staminaUnits;
  const cappedDuration = Math.min(durationUnits, Math.max(1, maxSelectableUnits()));
  if (cappedDuration !== durationUnits) durationUnits = cappedDuration;
  const hasSelection = hasAnySelection(selection);
  const canAct = remaining > 0 && !isResolving && hasSelection;
  const currentComboKey = hasSelection ? buildComboKey(selection, durationUnits, state.jobTitle.zh) : null;
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
  if (remaining <= 0) resolveLabel = t("staminaInsufficientLabel");
  else if (!hasSelection) resolveLabel = t("pleaseSelectLabel");
  else resolveLabel = t("startLabel");

  return `
    <section class="action-bar">
      <div class="slot-group ${slotGroupModeClass()}">
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
      <button id="resolve-btn" class="resolve-btn-compact" ${!canAct ? "disabled" : ""}>${isResolving ? SPINNER_ICON : resolveLabel}</button>
    </section>

    ${isDuplicate ? `<p class="duplicate-hint">${t("duplicateHint")}</p>` : ""}
    ${insufficientStaminaFlash ? `<p class="warning">${t("insufficientStaminaWarning")}</p>` : ""}
    ${generationFailedFlash ? `<p class="warning">${t("generationFailedWarning")}</p>` : ""}

    <section class="material-area">
      <div class="material-area-header">
        <p class="material-area-hint">${activeCategory ? t("filteredByHint", { category: L(CATEGORY_LABEL[activeCategory]) }) : t("allMaterialsHint")}</p>
        <div class="sort-toggle">
          <button class="sort-toggle-btn ${materialSortMode === "label" ? "active" : ""}" data-sort-mode="label" title="${t("sortByLabelBtn")}" aria-label="${t("sortByLabelBtn")}">${SORT_ALPHA_ICON}</button>
          <button class="sort-toggle-btn ${materialSortMode === "unlockOrder" ? "active" : ""}" data-sort-mode="unlockOrder" title="${t("sortByUnlockOrderBtn")}" aria-label="${t("sortByUnlockOrderBtn")}">${SORT_CLOCK_ICON}</button>
        </div>
      </div>
      <div class="material-options">
        ${renderMaterialOptions(activeCategory)}
      </div>
    </section>
  `;
}

function slotValueLabel(cat: Category): string {
  const selectedId = selection[cat];
  return selectedId ? optionLabel(selectedId) : t("unselected");
}

function renderSlot(cat: Category): string {
  const selectedId = selection[cat];
  const valueLabel = slotValueLabel(cat);
  return `
    <button class="slot slot-border-${cat} ${cat === activeCategory ? "slot-active" : ""} ${selectedId ? "slot-filled" : ""}" data-slot-category="${cat}">
      <span class="slot-cat">${L(CATEGORY_LABEL[cat])}</span>
      <span class="slot-value">${escapeHtml(valueLabel)}</span>
    </button>
  `;
}

/** Picks the 人/事/地/物 grid's column count from the longest currently
 * shown label — a fixed 4-equal-width grid only has room for short names;
 * one long AI-invented material (or a longer UI-language string) drops to
 * 2 columns, and a name near the invention prompt's own 10-character cap
 * (functions/src/index.ts's buildPrompt) drops to 1, rather than letting
 * flex-wrap spill an odd box onto its own line. Thresholds are tuned
 * against real measurements at this component's typical rendered width
 * (~300px): 5 characters is the last one that still fits 4-up, 6-8 fit
 * comfortably 2-up, and 9+ (close to the 10-char generation ceiling) get
 * the full row to themselves for a safety margin. */
function slotGroupModeClass(): string {
  const maxLen = Math.max(...CATEGORY_ORDER.map((cat) => slotValueLabel(cat).length));
  if (maxLen >= 9) return "slot-group-1col";
  if (maxLen >= 6) return "slot-group-2col";
  return "";
}

function renderMaterialOptions(cat: Category | null): string {
  const options = materialOptionsFor(cat);
  if (options.length === 0) return `<p class="material-empty">${t("noUnlockedMaterials")}</p>`;
  return `
    <div class="pill-group">
      ${options
        .map(
          (o) =>
            `<button class="pill pill-cat-${o.category} ${selection[o.category] === o.id ? "active" : ""}" data-value="${o.id}" data-category="${o.category}">${escapeHtml(L(o.label))}</button>`
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
  const { event, isNewDiscovery, isFeaturedOptionNewToMe, jobTitleChanged } = lastResult;
  return `
    <div class="modal-backdrop">
      <div class="modal-card result-modal-card ${isNewDiscovery ? "result-modal-new" : ""}">
        <div class="result-title-row">
          <h2>${escapeHtml(personalize(L(event.title)))}</h2>
          <span class="${isNewDiscovery ? "badge-new" : "badge-repeat"}">${isNewDiscovery ? t("firstDiscovery") : t("repeatEvent")}</span>
        </div>
        <p class="result-desc">${escapeHtml(personalize(L(event.description)))}</p>
        <p class="result-meta">${t("spentLabel", { duration: formatDuration(event.durationUnits) })}</p>
        <p class="result-meta">${t("jobTitleLabel")}:${escapeHtml(L(event.jobTitle))}</p>
        <p class="result-meta">🔎 ${t("discovererLine", { name: event.discovererName, time: formatTimestamp(event.discoveredAt) })}</p>
        ${renderFeaturedTag(event, isFeaturedOptionNewToMe)}
        ${jobTitleChanged ? `<div class="unlock-toast">${t("jobTitleChangedTitle")} — ${t("jobTitleChangedBody", { title: escapeHtml(L(jobTitleChanged)) })}</div>` : ""}
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
          <span class="collection-entry-title">${escapeHtml(personalize(L(ev.title)))}</span>
          <span class="collection-entry-chevron">▾</span>
        </button>
      </li>
    `;
  }

  const labels = decodeComboKey(key, state.knownMaterials);
  const tags = CATEGORY_ORDER.filter((cat) => labels[cat]).map(
    (cat) => `<span class="tag">${L(CATEGORY_LABEL[cat])}:${escapeHtml(L(labels[cat]!))}</span>`
  );
  // Events collected before the job-title system existed have no `.jobTitle`
  // at all (old Firestore docs / old localStorage entries) — skip the tag
  // rather than render "undefined".
  if (ev.jobTitle?.zh) {
    tags.unshift(`<span class="tag tag-jobtitle">${t("jobTitleLabel")}:${escapeHtml(L(ev.jobTitle))}</span>`);
  }

  return `
    <li class="collection-entry collection-entry-expanded">
      <button class="collection-entry-toggle" data-history-key="${key}">
        <span class="collection-entry-title">${escapeHtml(personalize(L(ev.title)))}</span>
        <span class="collection-entry-chevron">▴</span>
      </button>
      <div class="collection-entry-details">
        <div class="collection-entry-header">
          <span class="collection-entry-duration">${formatDuration(ev.durationUnits)}</span>
        </div>
        <div class="tag-row">${tags.length > 0 ? tags.join("") : `<span class="tag tag-empty">${t("noMaterialsTag")}</span>`}</div>
        <p class="collection-desc">${escapeHtml(personalize(L(ev.description)))}</p>
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
  const haystack = [personalize(L(ev.title)), personalize(L(ev.description)), ev.discovererName, ...Object.values(labels).map(L)]
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

function renderActivityEntry(c: Campaign): string {
  const expanded = expandedCampaignIds.has(c.id);

  if (!expanded) {
    return `
      <li class="collection-entry collection-entry-collapsed">
        <button class="collection-entry-toggle" data-toggle-campaign="${escapeHtml(c.id)}">
          <span class="collection-entry-title">${escapeHtml(L(c.title))}</span>
          <span class="collection-entry-chevron">▾</span>
        </button>
      </li>
    `;
  }

  const sections: [Parameters<typeof translate>[0], Localized][] = [
    ["activityContentLabel", c.content],
    ["activityGoalLabel", c.goal],
    ["activityRulesLabel", c.rules],
    ["activityRewardLabel", c.reward],
  ];

  return `
    <li class="collection-entry collection-entry-expanded">
      <button class="collection-entry-toggle" data-toggle-campaign="${escapeHtml(c.id)}">
        <span class="collection-entry-title">${escapeHtml(L(c.title))}</span>
        <span class="collection-entry-chevron">▴</span>
      </button>
      <div class="collection-entry-details">
        ${sections
          .map(
            ([labelKey, value]) => `
          <div class="activity-section">
            <div class="activity-section-label">${t(labelKey)}</div>
            <p class="activity-section-body">${escapeHtml(L(value))}</p>
          </div>
        `
          )
          .join("")}
      </div>
    </li>
  `;
}

function renderActivitiesContent(): string {
  if (campaignsLoading && campaigns === null) {
    return `<section class="market-card-main"><p class="market-sub">${t("resolvingLabel")}</p></section>`;
  }
  if (campaignsLoadError) {
    return `<section class="market-card-main"><p class="market-error">${escapeHtml(campaignsLoadError)}</p></section>`;
  }
  const list = campaigns ?? [];
  if (list.length === 0) {
    return `<section class="market-card-main"><p class="market-sub">${t("activitiesEmpty")}</p></section>`;
  }
  return `
    <ol class="collection-list collection-list-full">
      ${list.map((c) => renderActivityEntry(c)).join("")}
    </ol>
  `;
}

function renderMarketContent(): string {
  const googleLinked = !!currentUser && isGoogleLinked(currentUser);
  const modal = consentModalOpen ? renderConsentModal() : "";
  if (!googleLinked) return renderMarketGoogleGate() + modal;
  if (purchaseFlow.kind !== "idle") return renderPurchaseFlow() + modal;

  return `
    ${renderMarketCard()}
    ${renderMarketFooter()}
    ${modal}
  `;
}

function renderConsentModal(): string {
  const reviewOnly = consentModalMode === "review";
  return `
    <div class="modal-backdrop">
      <div class="modal-card">
        <h2>${t("consentModalTitle")}</h2>
        <p class="modal-hint">${t("consentModalBody")}</p>
        <div class="modal-actions">
          ${reviewOnly ? "" : `<button id="consent-cancel-btn" class="modal-btn-secondary">${t("cancel")}</button>`}
          <button id="consent-confirm-btn" class="modal-btn-primary">
            ${reviewOnly ? t("closeBtn") : t("consentAgreeBtn")}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderMarketGoogleGate(): string {
  return `
    <section class="market-google-gate">
      <h2>${t("marketGoogleGateTitle")}</h2>
      <p>${t("marketGoogleGateBody")}</p>
      <button id="market-google-signin-btn" class="market-buy-btn market-buy-btn-enabled">${t("googleSignIn")}</button>
    </section>
  `;
}

/** Single unified card: buy and use, per potion product. The overtime-pay
 * balance/exchange step is intentionally not shown here — it's an internal
 * bookkeeping figure for now (see topupService.ts's creditOrder), not
 * something the player needs to see or act on until it comes back as a
 * general rechargeable currency. */
function renderMarketCard(): string {
  if (marketLoading && !marketProducts) {
    return `<section class="market-card-main"><p class="market-sub">${t("resolvingLabel")}</p></section>`;
  }
  if (marketLoadError) {
    return `<section class="market-card-main"><p class="market-error">${escapeHtml(marketLoadError)}</p></section>`;
  }
  const products = marketProducts ?? [];
  const { potions } = state.wallet;
  // Icon scales with how much stamina the potion is worth (relative to the
  // biggest one in the current catalog) so "大瓶/小瓶" reads visually, not
  // just from the name text — generic over however many products exist.
  const maxUnits = Math.max(1, ...products.map((pr) => pr.paidCoins));

  return `
    <section class="market-card-main">
      ${potionUseError ? `<p class="market-error">${escapeHtml(potionUseError)}</p>` : ""}
      ${products
        .map((p) => {
          const owned = potions[p.id] ?? 0;
          const busy = potionUseBusyId === p.id;
          const iconSize = 12 + Math.round((p.paidCoins / maxUnits) * 8);
          return `
        <div class="market-product-row">
          <span class="market-product-name" title="${escapeHtml(L(p.description))}">
            ${potionIcon(iconSize)}
            <span class="market-units">${escapeHtml(L(p.name))}</span>
          </span>
          <span class="market-product-right">
            <button
              class="market-buy-btn market-use-btn ${owned > 0 ? "market-buy-btn-enabled" : ""}"
              data-use-product-id="${escapeHtml(p.id)}"
              ${owned <= 0 || busy ? "disabled" : ""}
            >${busy ? t("marketProcessing") : t("marketUseBtn")}</button>
            <span class="market-owned">${t("marketOwnedLabel", { n: owned })}</span>
            <button class="market-buy-btn market-buy-btn-enabled" data-product-id="${escapeHtml(p.id)}">${t("marketBuyBtn")}</button>
            <span class="market-price">NT$ ${p.price}</span>
          </span>
        </div>
      `;
        })
        .join("")}
    </section>
  `;
}

function renderMarketFooter(): string {
  return `
    <div class="market-footer">
      <button id="view-terms-btn" class="view-terms-link">${t("viewTermsLink")}</button>
      <span class="market-footer-sep">·</span>
      <a class="support-email-link" href="mailto:${SUPPORT_EMAIL}" title="${escapeHtml(t("supportContactBody"))}">${t("supportContactTitle")}</a>
    </div>
  `;
}

function renderPurchaseFlow(): string {
  if (purchaseFlow.kind === "idle") return ""; // caller only invokes this when kind !== "idle"
  if (purchaseFlow.kind === "processing") {
    return `
      <section class="market-flow-card">
        <p>${t("marketProcessing")}</p>
        ${purchaseFlow.paypalOrderId ? `<div id="paypal-button-container" class="paypal-button-container"></div>` : ""}
        <button id="market-cancel-btn" class="market-buy-btn market-buy-btn-enabled">${t("marketCancelBtn")}</button>
      </section>
    `;
  }
  if (purchaseFlow.kind === "success") {
    const { paidCoins } = purchaseFlow.order;
    return `
      <section class="market-flow-card">
        <h2>${t("marketSuccessTitle")}</h2>
        <p>${t("marketSuccessBody", { duration: formatDuration(paidCoins) })}</p>
        <button id="market-back-btn" class="market-buy-btn market-buy-btn-enabled">${t("marketBackBtn")}</button>
      </section>
    `;
  }
  if (purchaseFlow.kind === "failed") {
    return `
      <section class="market-flow-card">
        <h2>${t("marketFailedTitle")}</h2>
        <p>${escapeHtml(purchaseFlow.message)}</p>
        <button id="market-back-btn" class="market-buy-btn market-buy-btn-enabled">${t("marketRetryBtn")}</button>
      </section>
    `;
  }
  if (purchaseFlow.kind === "cancelled") {
    return `
      <section class="market-flow-card">
        <h2>${t("marketCancelledTitle")}</h2>
        <button id="market-back-btn" class="market-buy-btn market-buy-btn-enabled">${t("marketBackBtn")}</button>
      </section>
    `;
  }
  // pending
  return `
    <section class="market-flow-card">
      <h2>${t("marketPendingTitle")}</h2>
      <p>${t("marketPendingBody")}</p>
      <p class="market-sub">${t("marketPendingOrderLabel", { orderId: purchaseFlow.orderId })}</p>
      <button id="market-recheck-btn" class="market-buy-btn market-buy-btn-enabled">${t("marketRecheckBtn")}</button>
    </section>
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
      if (view === "market" && marketProducts === null && !marketLoading) {
        loadMarketProducts();
      }
      if (view === "activities" && campaigns === null && !campaignsLoading) {
        loadCampaigns();
      }
    });
  });
}

function attachActivitiesHandlers() {
  app.querySelectorAll<HTMLButtonElement>("[data-toggle-campaign]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.toggleCampaign!;
      if (expandedCampaignIds.has(id)) expandedCampaignIds.delete(id);
      else expandedCampaignIds.add(id);
      render();
    });
  });
}

function attachMarketHandlers() {
  document
    .querySelector<HTMLButtonElement>("#market-google-signin-btn")
    ?.addEventListener("click", handleGoogleSignInClick);

  document.querySelector<HTMLButtonElement>("#view-terms-btn")?.addEventListener("click", handleViewTerms);
  document.querySelector<HTMLButtonElement>("#consent-confirm-btn")?.addEventListener("click", () => {
    if (consentModalMode === "review") {
      consentModalOpen = false;
      render();
    } else {
      handleConsentConfirm();
    }
  });
  document.querySelector<HTMLButtonElement>("#consent-cancel-btn")?.addEventListener("click", handleConsentClose);

  app.querySelectorAll<HTMLButtonElement>("[data-product-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const product = marketProducts?.find((p) => p.id === btn.dataset.productId);
      if (product) handleBuy(product);
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-use-product-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const productId = btn.dataset.useProductId;
      if (productId) handleUsePotion(productId);
    });
  });

  document.querySelector<HTMLButtonElement>("#market-cancel-btn")?.addEventListener("click", () => {
    purchaseFlow = { kind: "cancelled" };
    render();
  });

  document.querySelector<HTMLButtonElement>("#market-back-btn")?.addEventListener("click", () => {
    purchaseFlow = { kind: "idle" };
    render();
  });

  document.querySelector<HTMLButtonElement>("#market-recheck-btn")?.addEventListener("click", () => {
    if (purchaseFlow.kind === "pending") handleRecheckOrder(purchaseFlow.orderId);
  });

  // Mounting the actual PayPal Buttons: only once we have a real
  // paypalOrderId from createTopupOrder, and the container div this render()
  // just put in the DOM. A fresh render() always gives us a fresh container
  // (the old one, with whatever the SDK mounted into it, was just discarded
  // along with the rest of the previous innerHTML), so there's no stale
  // double-mount to worry about here.
  if (purchaseFlow.kind === "processing" && purchaseFlow.paypalOrderId) {
    const orderId = purchaseFlow.orderId!;
    const paypalOrderId = purchaseFlow.paypalOrderId;
    loadPaypalSdk()
      .then(() => {
        // The flow could have moved on (cancelled, or approved+captured
        // already) by the time the SDK script finishes loading.
        if (purchaseFlowKind() !== "processing") return;
        renderPaypalButtons("paypal-button-container", {
          paypalOrderId,
          onApprove: () => handlePaypalApprove(orderId),
          onCancel: () => {
            purchaseFlow = { kind: "cancelled" };
            render();
          },
          onError: (err) => {
            console.warn("PayPal Buttons 錯誤", err);
            purchaseFlow = { kind: "failed", message: t("marketFailedTitle") };
            render();
          },
        });
      })
      .catch((err) => {
        console.warn("PayPal SDK 載入失敗", err);
        purchaseFlow = { kind: "failed", message: t("marketFailedTitle") };
        render();
      });
  }
}

/** Shared post-sign-in bookkeeping — runs whether the Google credential came
 * back through the popup flow (resolves inline) or the redirect flow
 * (resolves on the next page load, see completeGoogleRedirectSignIn). Never
 * duplicate this logic at either call site. */
async function finishGoogleSignIn(user: User) {
  currentUser = user;
  const localPlayerName = state.playerName;
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
    notifyPlayerRegistered(state.playerName);
  }
}

/** Shared by both the account dropdown's and the market page's Google
 * sign-in buttons — they must never have their own independent copies of
 * this logic (or, worse, share a DOM id and silently leave one of them
 * without a listener attached at all). */
async function handleGoogleSignInClick() {
  if (currentUser && isGoogleLinked(currentUser)) return;
  try {
    syncNotice = t("noticeOpeningGoogle");
    render();
    const user = await signInWithGoogle();
    // null means signInWithGoogle redirected instead of popping up (mobile/
    // embedded browsers) — the page is navigating away right now, so there's
    // nothing further to do; completeGoogleRedirectSignIn picks up the
    // result on the next load.
    if (user) await finishGoogleSignIn(user);
  } catch (err) {
    console.warn("Google 登入失敗", err);
    syncNotice = t("noticeGoogleSignInFailed");
  }
  render();
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

  document.querySelector<HTMLButtonElement>("#job-title-hint-btn")?.addEventListener("click", () => {
    jobTitleHintOpen = !jobTitleHintOpen;
    render();
  });

  document.querySelector<HTMLButtonElement>("#delete-account-btn")?.addEventListener("click", async () => {
    const googleLinked = !!currentUser && isGoogleLinked(currentUser);
    const ok = window.confirm(googleLinked ? t("confirmDeleteAccountCloud") : t("confirmDeleteAccountLocal"));
    if (!ok) return;

    if (googleLinked && currentUser) {
      // Actually delete the cloud doc (not just overwrite it with an empty
      // profile via persist()) and sign out — "刪除帳號" implies the account
      // is gone, not just reset while still logged in.
      try {
        await deleteRemoteState(currentUser.uid);
      } catch (err) {
        console.warn("刪除雲端帳號資料失敗", err);
      }
      try {
        currentUser = await signOutToLocal();
      } catch (err) {
        console.warn("登出失敗", err);
      }
    }

    localStorage.removeItem(STORAGE_KEY);
    state = settleStamina(loadState());
    selection = emptySelection();
    durationUnits = 1;
    lastResult = null;
    resultStale = false;
    resultModalOpen = false;
    accountMenuOpen = false;
    persist();
    render();
  });

  document.querySelector<HTMLButtonElement>("#google-signin-btn")?.addEventListener("click", handleGoogleSignInClick);

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

async function performResolve(effectiveDuration: number) {
  isResolving = true;
  render();
  const outcome = await resolveAction(state, selection, effectiveDuration);
  isResolving = false;
  if (!outcome.ok) {
    if (outcome.reason === "insufficient-stamina") insufficientStaminaFlash = true;
    else generationFailedFlash = true;
    render();
    return;
  }
  lastResult = outcome.result;
  resultModalOpen = true;
  // 素材選擇每次事件後自動回歸預設,時間長度則保留給下一次沿用。
  selection = emptySelection();
  resultStale = false;
  persist();
  render();
}

function attachPlayHandlers() {
  app.querySelectorAll<HTMLButtonElement>(".pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.category as Category;
      const value = btn.dataset.value || "";
      // No explicit "不選" pill anymore — clicking the already-selected
      // option toggles it back off instead.
      selection[cat] = selection[cat] === value ? null : value;
      resultStale = true;
      render();
    });
  });

  // Clicking a slot narrows the (by-default all-mixed) material list down to
  // just that category; clicking the already-active one clears the filter
  // back to "show everything".
  app.querySelectorAll<HTMLButtonElement>("[data-slot-category]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.slotCategory as Category;
      activeCategory = activeCategory === cat ? null : cat;
      render();
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-sort-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      materialSortMode = btn.dataset.sortMode as MaterialSortMode;
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
    generationFailedFlash = false;
    if (!hasAnySelection(selection) || isResolving) return;
    const effectiveDuration = Math.min(durationUnits, maxSelectableUnits());
    if (effectiveDuration <= 0) return;
    if (effectiveDuration >= LONG_DURATION_CONFIRM_THRESHOLD_UNITS) {
      pendingResolveDuration = effectiveDuration;
      longDurationConfirmOpen = true;
      render();
      return;
    }
    await performResolve(effectiveDuration);
  });

  document.querySelector<HTMLButtonElement>("#long-duration-confirm-btn")?.addEventListener("click", async () => {
    longDurationConfirmOpen = false;
    const duration = pendingResolveDuration;
    pendingResolveDuration = null;
    render();
    if (duration) await performResolve(duration);
  });
  document.querySelector<HTMLButtonElement>("#long-duration-cancel-btn")?.addEventListener("click", () => {
    longDurationConfirmOpen = false;
    pendingResolveDuration = null;
    render();
  });
}

render();
loadAnnouncementAndMaybeShow();

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

async function startNormalSignIn() {
  try {
    const user = await ensureSignedIn();
    currentUser = user;
    if (isGoogleLinked(user)) {
      const remote = await pullRemoteState(user.uid);
      if (remote) state = remote;
    }
  } catch (err) {
    console.warn("登入失敗,將只使用本機模式", err);
  }
  render();
}

// On mobile/embedded browsers, signInWithGoogle() redirects instead of
// popping up (see firebase.ts) — check for that result FIRST, before the
// normal ensureSignedIn flow, since a completed redirect already carries
// everything finishGoogleSignIn needs (and running both would just double
// -fetch the remote profile for no benefit).
completeGoogleRedirectSignIn()
  .then(async (redirectUser) => {
    if (redirectUser) {
      await finishGoogleSignIn(redirectUser);
      render();
      return;
    }
    await startNormalSignIn();
  })
  .catch(async (err) => {
    console.warn("Google 登入(重新導向)失敗", err);
    syncNotice = t("noticeGoogleSignInFailed");
    await startNormalSignIn();
  });

// Ticks every second so the header stamina bar/label count up live (see
// displayStaminaUnits). A full render() every second would rebuild the
// whole page mid-drag if the player happens to be dragging the duration
// slider at that moment (same class of issue as the slider's own
// input/change split above) — so the common case just patches these two
// elements' text/style directly. A full render() (plus persist()) only
// happens on the rarer occasion a whole stamina unit actually regenerates,
// since that's also the only time the resolve button / max-selectable-
// duration actually changes — the live-ticking display never grants
// anything spendable on its own.
setInterval(() => {
  const before = state.staminaUnits;
  settleStamina(state);
  if (state.staminaUnits !== before) {
    persist();
    render();
    return;
  }
  const displayUnits = displayStaminaUnits();
  const fill = document.querySelector<HTMLElement>(".stamina-fill");
  if (fill) fill.style.width = `${Math.min(100, (displayUnits / MAX_STAMINA_UNITS) * 100)}%`;
  const valueLabel = document.querySelector<HTMLElement>(".stamina-mini-value");
  if (valueLabel) valueLabel.textContent = formatHoursMinutesSeconds(displayUnits);
}, 1_000);
