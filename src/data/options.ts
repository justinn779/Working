import type { GameOption } from "../types";

// Starting options: ~5 per category, all unlocked from the beginning.
// Locked options surface later as event unlock rewards, letting the game
// gradually wander away from the office.
export const SEED_OPTIONS: GameOption[] = [
  // 人
  { id: "person_boss", category: "person", label: "主管", locked: false },
  { id: "person_colleague", category: "person", label: "同事", locked: false },
  { id: "person_client", category: "person", label: "客戶", locked: false },
  { id: "person_intern", category: "person", label: "工讀生", locked: false },
  { id: "person_alone", category: "person", label: "自己一個人", locked: false },
  { id: "person_cleaner", category: "person", label: "神秘清潔阿姨", locked: true },
  { id: "person_ceo", category: "person", label: "總經理", locked: true },
  { id: "person_ex_colleague", category: "person", label: "已離職的前同事", locked: true },
  { id: "person_rival", category: "person", label: "競爭對手公司的人", locked: true },

  // 事
  { id: "matter_meeting", category: "matter", label: "開會", locked: false },
  { id: "matter_overtime", category: "matter", label: "加班趕案子", locked: false },
  { id: "matter_slacking", category: "matter", label: "摸魚", locked: false },
  { id: "matter_presentation", category: "matter", label: "提案簡報", locked: false },
  { id: "matter_smalltalk", category: "matter", label: "茶水間閒聊", locked: false },
  { id: "matter_job_interview", category: "matter", label: "偷偷去面試", locked: true },
  { id: "matter_whistleblow", category: "matter", label: "內部檢舉", locked: true },
  { id: "matter_startup_pitch", category: "matter", label: "醞釀創業提案", locked: true },
  { id: "matter_party_show", category: "matter", label: "尾牙表演彩排", locked: true },

  // 地
  { id: "place_office", category: "place", label: "辦公室", locked: false },
  { id: "place_meeting_room", category: "place", label: "會議室", locked: false },
  { id: "place_pantry", category: "place", label: "茶水間", locked: false },
  { id: "place_elevator", category: "place", label: "電梯", locked: false },
  { id: "place_downstairs", category: "place", label: "公司樓下", locked: false },
  { id: "place_rooftop", category: "place", label: "頂樓天台", locked: true },
  { id: "place_boss_office", category: "place", label: "老闆辦公室", locked: true },
  { id: "place_remote_office", category: "place", label: "異地辦公室", locked: true },
  { id: "place_empty_office_night", category: "place", label: "深夜只剩自己的辦公室", locked: true },

  // 物
  { id: "object_laptop", category: "object", label: "筆電", locked: false },
  { id: "object_coffee", category: "object", label: "咖啡", locked: false },
  { id: "object_phone", category: "object", label: "手機", locked: false },
  { id: "object_slides", category: "object", label: "簡報檔案", locked: false },
  { id: "object_printer", category: "object", label: "印表機", locked: false },
  { id: "object_fortune", category: "object", label: "神秘籤詩", locked: true },
  { id: "object_resignation", category: "object", label: "辭職信", locked: true },
  { id: "object_lottery", category: "object", label: "樂透彩券", locked: true },
  { id: "object_crypto_wallet", category: "object", label: "加密貨幣錢包", locked: true },
];
