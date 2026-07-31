export type LanguageCode = "zh" | "en";

/** Every static UI string in the app, in both supported languages. Content
 * generated per-event (titles/descriptions/material names) is NOT here —
 * that's the Localized type on GameEvent/GameOption, produced by a single
 * bilingual AI generation (see functions/src/index.ts) so a material's zh/en
 * names are always a matched pair, never independently translated. */
const UI_STRINGS: Record<string, Record<LanguageCode, string>> = {
  appTitle: { zh: "工作大小事", en: "Working Big & Small" },
  staminaLabel: { zh: "工時", en: "Work Hours" },
  currencyLabel: { zh: "加班費", en: "OT Pay" },
  jobTitleLabel: { zh: "職稱", en: "Job Title" },
  jobTitleHintTitle: { zh: "職稱是怎麼決定的?", en: "How does job title work?" },
  jobTitleHint: {
    zh: "職稱不是靠花更多時間或次數就能改變,而是當這次事件的內容本身像是升遷面談、決定離職創業、拿到新工作機會、或被開除這類轉折時,才有機會變動。可以從「主管」搭配「開會」或「辦公室」這類組合開始嘗試,看看故事怎麼發展。",
    en: "Job title doesn't shift just from spending more time or grinding more events — it changes when an event's content itself reads like a turning point: a promotion talk, quitting to start your own thing, a new job offer, or getting let go. Try starting with combinations like Boss + Meeting or Boss + Office and see how the story unfolds.",
  },
  jobTitleChangedTitle: { zh: "🎉 職稱異動", en: "🎉 Job Title Changed" },
  jobTitleChangedBody: { zh: "你現在是「{title}」了。", en: "You are now a {title}." },

  notSet: { zh: "未設定", en: "Not set" },
  editNameTitle: { zh: "編輯入職名稱", en: "Edit Display Name" },
  setNameTitle: { zh: "設定入職名稱", en: "Set Display Name" },
  nameFieldLabel: { zh: "入職名稱", en: "Display Name" },
  googleSyncedInfo: { zh: "已用 Google 帳號同步,跨裝置共用進度", en: "Synced with Google — progress shared across devices" },
  signOut: { zh: "登出", en: "Sign Out" },
  localOnlyInfo: { zh: "目前資料只存在這個裝置", en: "Your data only exists on this device" },
  googleSignIn: { zh: "登入 Google 帳號以同步進度", en: "Sign in with Google to sync progress" },
  deleteAccount: { zh: "刪除帳號", en: "Delete Account" },
  languageToggle: { zh: "EN", en: "中" },

  nameModalHint: {
    zh: "這是你在遊戲中的顯示名稱,其他玩家發現你創造的事件時會看到它。",
    en: "This is your display name in the game — other players will see it when they discover events you created.",
  },
  nameInputPlaceholder: { zh: "輸入入職名稱", en: "Enter your display name" },
  cancel: { zh: "取消", en: "Cancel" },
  confirm: { zh: "確認", en: "Confirm" },

  tutorialStepLabel: { zh: "步驟 {current} / {total}", en: "Step {current} / {total}" },
  tutorialSkip: { zh: "跳過教學", en: "Skip Tutorial" },
  tutorialFinish: { zh: "開始遊玩", en: "Start Playing" },
  tutorialNext: { zh: "下一步", en: "Next" },
  tutorialStep1: {
    zh: "先從「人、事、地、物」挑至少一項要素,點一下對應的格子就能選(可以只選一項)。",
    en: "Start by picking at least one material from Person / Matter / Place / Object — tap a slot to choose (one is enough).",
  },
  tutorialStep2: {
    zh: "拖動時間軸,決定要花多久處理這件事。",
    en: "Drag the time bar to decide how long to spend on it.",
  },
  tutorialStep3: {
    zh: "按下「開始」,系統會生成一段職場事件,還會順便幫你解鎖一個新要素。",
    en: "Press Start — the system generates a workplace event and unlocks a new material along the way.",
  },
  tutorialStep4: {
    zh: "工時代表你還能花的時間,用完後會隨時間慢慢恢復,這裡會即時顯示目前累積的工時。",
    en: "Work hours represent how much time you can still spend. They slowly regenerate over time — this shows the current total live.",
  },
  tutorialStep5: {
    zh: "「歷史」頁收藏你發現過的所有事件,去收集更多獨特組合吧!",
    en: "The History tab collects every event you've discovered — go find more unique combinations!",
  },

  tabPlay: { zh: "事件", en: "Events" },
  tabHistory: { zh: "歷史", en: "History" },
  tabActivities: { zh: "活動", en: "Events" },
  tabMarket: { zh: "商城", en: "Shop" },

  activitiesLoadError: { zh: "活動清單載入失敗,請稍後再試", en: "Failed to load events — please try again later" },
  activitiesEmpty: { zh: "目前沒有進行中的活動", en: "No events running right now" },
  activityContentLabel: { zh: "活動內容", en: "What's Happening" },
  activityGoalLabel: { zh: "活動目標", en: "Goal" },
  activityRulesLabel: { zh: "活動說明", en: "Rules" },
  activityRewardLabel: { zh: "活動獎勵", en: "Reward" },

  resolvingLabel: { zh: "工作中…", en: "Working…" },
  staminaInsufficientLabel: { zh: "工時不足", en: "Not Enough Work Hours" },
  pleaseSelectLabel: { zh: "請選擇", en: "Please Select" },
  startLabel: { zh: "開始", en: "Start" },
  duplicateHint: {
    zh: "🔁 這個組合你已經試過了,結果會一樣。",
    en: "🔁 You've already tried this combination — the result will be the same.",
  },
  insufficientStaminaWarning: {
    zh: "工時不夠支撐這段時間,已自動調整。",
    en: "Not enough work hours for that long — automatically adjusted.",
  },
  longDurationConfirmTitle: { zh: "確認花費時間", en: "Confirm Time Spent" },
  longDurationConfirmBody: {
    zh: "這次要花費 {duration},確定要開始嗎?",
    en: "This will take {duration} — are you sure you want to start?",
  },
  generationFailedWarning: {
    zh: "生成失敗,已重試多次仍無法連上,工時已退回,請稍後再試一次。",
    en: "Generation failed even after retrying — your work hours have been refunded. Please try again later.",
  },
  unselected: { zh: "未選", en: "Unselected" },
  youFallback: { zh: "你", en: "You" },

  allMaterialsHint: { zh: "顯示全部要素,點上方任一格可篩選單一類別", en: "Showing all materials — tap a slot above to filter by one category" },
  filteredByHint: { zh: "只顯示「{category}」,再點一次取消篩選", en: "Showing only \"{category}\" — tap again to clear" },
  sortByLabelBtn: { zh: "文字排序", en: "By Name" },
  sortByUnlockOrderBtn: { zh: "獲得順序", en: "By Unlock Order" },
  noUnlockedMaterials: { zh: "目前沒有可選的要素", en: "No materials unlocked yet" },

  firstDiscovery: { zh: "首次發現", en: "First Discovery" },
  repeatEvent: { zh: "重複事件", en: "Repeat Event" },
  spentLabel: { zh: "花費 {duration}", en: "Spent {duration}" },
  discovererLine: { zh: "發現人:{name} · {time}", en: "Discovered by: {name} · {time}" },
  closeBtn: { zh: "關閉", en: "Close" },
  newUnlockPrefix: { zh: "🎉 解鎖新選項", en: "🎉 New Unlock" },
  featuredPrefix: { zh: "🏷 這次的關鍵要素", en: "🏷 Featured This Time" },

  noMaterialsTag: { zh: "沒有指定人事地物", en: "No materials specified" },
  emptyHistory: { zh: "還沒有收集到任何事件,回去試試看吧!", en: "No events collected yet — go find some!" },
  noMatchingHistory: { zh: "沒有符合條件的事件。", en: "No events match your filters." },
  historySearchPlaceholder: {
    zh: "搜尋標題、內容、要素、發現人…",
    en: "Search title, content, materials, discoverer…",
  },
  clearSearchTitle: { zh: "清除搜尋", en: "Clear search" },
  filterAllOption: { zh: "{category}:全部", en: "{category}: All" },

  historySubTabEvents: { zh: "事件", en: "Events" },
  historySubTabMaterials: { zh: "要素", en: "Materials" },
  materialSeedTag: { zh: "🎒 起始要素,一開始就擁有", en: "🎒 Starting material — you begin with this" },
  materialNoDescription: { zh: "(尚無說明)", en: "(No description yet)" },
  materialDiscovererLine: {
    zh: "發現人:{name} · {time} · 花費 {duration}",
    en: "Discovered by: {name} · {time} · spent {duration}",
  },

  unitsSuffix: { zh: "{n} 單位", en: "{n} Units" },
  notAvailable: { zh: "尚未開放", en: "Not Available Yet" },

  marketGoogleGateTitle: { zh: "儲值前請先連結 Google 帳號", en: "Link a Google account before topping up" },
  marketGoogleGateBody: {
    zh: "純本機帳號一旦清除瀏覽器資料就會遺失,已付費的加班費也會跟著不見。連結 Google 帳號後,加班費才能安全地跨裝置保存。",
    en: "A local-only account is lost the moment browser data is cleared — including any overtime pay you've paid for. Link a Google account first so your balance is safely kept across devices.",
  },

  marketWalletPaid: { zh: "加班費餘額", en: "Overtime Pay Balance" },
  marketExchangeAllBtn: { zh: "全部兌換成工時", en: "Exchange All for Work Hours" },
  marketExchangeNote: { zh: "1 加班費 = 1 單位工時。", en: "1 overtime pay = 1 work-hour unit." },
  marketExchangeNone: { zh: "目前沒有加班費可以兌換", en: "No overtime pay to exchange yet" },
  marketExchangeFailed: { zh: "兌換失敗,請稍後再試", en: "Exchange failed — please try again later" },

  marketBuyBtn: { zh: "購買", en: "Buy" },
  marketOwnedLabel: { zh: "擁有 {n} 瓶", en: "{n} owned" },
  marketUseBtn: { zh: "使用", en: "Use" },
  marketUseFailed: { zh: "使用失敗,請稍後再試", en: "Failed to use — please try again later" },
  viewTermsLink: { zh: "查看服務條款與儲值規則", en: "View Terms & Top-up Rules" },
  consentModalTitle: { zh: "儲值前請詳閱", en: "Please Review Before Topping Up" },
  consentModalBody: {
    zh: "同意服務條款與儲值/退款規則,並瞭解加班費僅能在遊戲內使用、不可轉讓或兌換為現金。首次購買前需按下方按鈕確認,之後不用再重複確認,但你隨時可以透過商店頁的連結重新查看這份說明。",
    en: "By agreeing you accept the Terms of Service and the top-up/refund rules, and understand overtime pay is usable only in-game and cannot be transferred or cashed out. This confirmation is only needed once, before your first purchase — you can reopen this notice anytime from a link on the shop page.",
  },
  consentAgreeBtn: { zh: "我同意並繼續", en: "I Agree, Continue" },
  marketProcessing: { zh: "處理中,請稍候…", en: "Processing, please wait…" },
  marketCancelBtn: { zh: "取消", en: "Cancel" },
  marketSuccessTitle: { zh: "🎉 購買成功", en: "🎉 Purchase Successful" },
  marketSuccessBody: { zh: "已為你補充 {duration} 工時!", en: "Added {duration} of work hours!" },
  marketFailedTitle: { zh: "付款失敗", en: "Payment Failed" },
  marketRetryBtn: { zh: "重新購買", en: "Try Again" },
  marketCancelledTitle: { zh: "已取消", en: "Cancelled" },
  marketBackBtn: { zh: "返回商店", en: "Back to Shop" },
  marketPendingTitle: { zh: "確認中", en: "Confirming" },
  marketPendingBody: {
    zh: "付款已收到,加班費正在確認中,請勿重複付款。",
    en: "Payment received, your overtime pay is being confirmed. Please do not pay again.",
  },
  marketPendingOrderLabel: { zh: "訂單編號:{orderId}", en: "Order ID: {orderId}" },
  marketRecheckBtn: { zh: "重新查詢狀態", en: "Check Status Again" },

  supportContactTitle: { zh: "需要協助?", en: "Need Help?" },
  supportContactBody: {
    zh: "付款或加班費相關問題,請透過以下信箱聯絡客服,並附上訂單相關資訊。",
    en: "For payment or overtime pay issues, please contact customer service at the email below with your order details.",
  },
  marketLoadError: { zh: "商品清單載入失敗,請稍後再試", en: "Failed to load products — please try again later" },

  announcementDismissForeverLabel: { zh: "不再顯示這則公告", en: "Don't show this again" },

  confirmDeleteAccountLocal: {
    zh: "確定要刪除帳號嗎?這會清除這個裝置上已收集的事件與解鎖的選項,且無法復原。",
    en: "Are you sure you want to delete your account? This will erase your collected events and unlocked options on this device, and cannot be undone.",
  },
  confirmDeleteAccountCloud: {
    zh: "確定要刪除帳號嗎?這會永久刪除雲端的進度資料、清除這個裝置上的本機資料,並將你登出,且無法復原。",
    en: "Are you sure you want to delete your account? This will permanently delete your cloud progress, clear local data on this device, and sign you out — this cannot be undone.",
  },
  confirmSignOut: {
    zh: "登出後這個裝置會改回本機模式,之後的進度不會再同步到雲端(這台裝置上的本機資料會保留)。確定要登出嗎?",
    en: "After signing out, this device switches to local-only mode and future progress won't sync to the cloud (local data on this device is kept). Are you sure you want to sign out?",
  },
  noticeOpeningGoogle: { zh: "正在開啟 Google 登入視窗…", en: "Opening Google sign-in window…" },
  noticeRestoredFromCloud: { zh: "已從雲端還原你的進度。", en: "Your progress has been restored from the cloud." },
  noticeGoogleLinked: { zh: "已連結 Google 帳號,目前進度已開始同步。", en: "Google account linked — your progress is now syncing." },
  noticeGoogleSignInFailed: { zh: "Google 登入失敗,請稍後再試。", en: "Google sign-in failed — please try again later." },
  noticeSignedOut: { zh: "已登出,目前是本機模式。", en: "Signed out — now in local-only mode." },
  noticeSignOutFailed: { zh: "登出失敗,請稍後再試。", en: "Sign-out failed — please try again later." },

  durationHoursMinutes: { zh: "{h} 小時 {m} 分鐘", en: "{h}h {m}m" },
  durationMinutesOnly: { zh: "{m} 分鐘", en: "{m}m" },
  durationHoursOnly: { zh: "{h} 小時", en: "{h}h" },
  compactHoursMinutesSeconds: { zh: "{h}時{m}分{s}秒", en: "{h}h{m}m{s}s" },
};

/** Simple `{placeholder}` substitution — enough for this app's short strings,
 * no plural/gender rules needed. */
export function t(key: keyof typeof UI_STRINGS, lang: LanguageCode, vars?: Record<string, string | number>): string {
  const template = UI_STRINGS[key]?.[lang] ?? key;
  if (!vars) return template;
  return Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), template);
}
