export type LanguageCode = "zh" | "en";

/** Every static UI string in the app, in both supported languages. Content
 * generated per-event (titles/descriptions/material names) is NOT here —
 * that's the Localized type on GameEvent/GameOption, produced by a single
 * bilingual AI generation (see functions/src/index.ts) so a material's zh/en
 * names are always a matched pair, never independently translated. */
const UI_STRINGS: Record<string, Record<LanguageCode, string>> = {
  appTitle: { zh: "職場大小事", en: "Workplace Big & Small" },
  staminaLabel: { zh: "體力", en: "Stamina" },
  staminaFull: { zh: "體力全滿", en: "Stamina full" },
  regenCountdown: { zh: "{time} 後 +1", en: "+1 in {time}" },

  notSet: { zh: "未設定", en: "Not set" },
  editNameTitle: { zh: "編輯入職名稱", en: "Edit Display Name" },
  setNameTitle: { zh: "設定入職名稱", en: "Set Display Name" },
  nameFieldLabel: { zh: "入職名稱", en: "Display Name" },
  googleSyncedInfo: { zh: "已用 Google 帳號同步,跨裝置共用進度", en: "Synced with Google — progress shared across devices" },
  signOut: { zh: "登出", en: "Sign Out" },
  localOnlyInfo: { zh: "目前資料只存在這個裝置", en: "Your data only exists on this device" },
  googleSignIn: { zh: "登入 Google 帳號以同步進度", en: "Sign in with Google to sync progress" },
  resetProgress: { zh: "重置遊戲進度", en: "Reset Game Progress" },
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
    zh: "先從「人、事、地、物」挑至少一項素材,點一下對應的格子就能選(可以只選一項)。",
    en: "Start by picking at least one material from Person / Matter / Place / Object — tap a slot to choose (one is enough).",
  },
  tutorialStep2: {
    zh: "拖動時間軸,決定要花多久處理這件事。",
    en: "Drag the time bar to decide how long to spend on it.",
  },
  tutorialStep3: {
    zh: "按下「開始」,系統會生成一段職場事件,還會順便幫你解鎖一個新素材。",
    en: "Press Start — the system generates a workplace event and unlocks a new material along the way.",
  },
  tutorialStep4: {
    zh: "體力代表你還能花的時間,用完後會隨時間慢慢恢復,倒數顯示在這裡。",
    en: "Stamina is how much time you can still spend. It slowly regenerates over time — the countdown shows here.",
  },
  tutorialStep5: {
    zh: "「歷史」頁收藏你發現過的所有事件,去收集更多獨特組合吧!",
    en: "The History tab collects every event you've discovered — go find more unique combinations!",
  },

  tabPlay: { zh: "事件", en: "Events" },
  tabHistory: { zh: "歷史", en: "History" },
  tabMarket: { zh: "市集", en: "Market" },

  resolvingLabel: { zh: "生成中…", en: "Generating…" },
  staminaInsufficientLabel: { zh: "體力不足", en: "Not Enough Stamina" },
  pleaseSelectLabel: { zh: "請選擇", en: "Please Select" },
  startLabel: { zh: "開始", en: "Start" },
  duplicateHint: {
    zh: "🔁 這個組合你已經試過了,結果會一樣。",
    en: "🔁 You've already tried this combination — the result will be the same.",
  },
  insufficientStaminaWarning: {
    zh: "體力不夠支撐這段時間,已自動調整。",
    en: "Not enough stamina for that long — automatically adjusted.",
  },
  unselected: { zh: "未選", en: "Unselected" },

  firstDiscovery: { zh: "首次發現", en: "First Discovery" },
  repeatEvent: { zh: "重複事件", en: "Repeat Event" },
  spentLabel: { zh: "花費 {duration}", en: "Spent {duration}" },
  discovererLine: { zh: "發現人:{name} · {time}", en: "Discovered by: {name} · {time}" },
  closeBtn: { zh: "關閉", en: "Close" },
  newUnlockPrefix: { zh: "🎉 解鎖新選項", en: "🎉 New Unlock" },
  featuredPrefix: { zh: "🏷 這次的關鍵素材", en: "🏷 Featured This Time" },

  noMaterialsTag: { zh: "沒有指定人事地物", en: "No materials specified" },
  emptyHistory: { zh: "還沒有收集到任何事件,回去試試看吧!", en: "No events collected yet — go find some!" },
  noMatchingHistory: { zh: "沒有符合條件的事件。", en: "No events match your filters." },
  historySearchPlaceholder: {
    zh: "搜尋標題、內容、素材、發現人…",
    en: "Search title, content, materials, discoverer…",
  },
  clearSearchTitle: { zh: "清除搜尋", en: "Clear search" },
  filterAllOption: { zh: "{category}:全部", en: "{category}: All" },

  marketNotice: {
    zh: "儲值功能還在準備中,金流串接完成後就能在這裡直接購買體力。",
    en: "Top-ups are still being set up — once payment is connected, you'll be able to buy stamina here.",
  },
  unitsSuffix: { zh: "{n} 單位", en: "{n} Units" },
  notAvailable: { zh: "尚未開放", en: "Not Available Yet" },

  confirmResetProgress: {
    zh: "確定要重置所有遊戲進度嗎?這會清除已收集的事件與解鎖的選項,且無法復原。",
    en: "Are you sure you want to reset all game progress? This will erase your collected events and unlocked options, and cannot be undone.",
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
  compactHoursMinutes: { zh: "{h}時{m}分", en: "{h}h{m}m" },
};

/** Simple `{placeholder}` substitution — enough for this app's short strings,
 * no plural/gender rules needed. */
export function t(key: keyof typeof UI_STRINGS, lang: LanguageCode, vars?: Record<string, string | number>): string {
  const template = UI_STRINGS[key]?.[lang] ?? key;
  if (!vars) return template;
  return Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), template);
}
