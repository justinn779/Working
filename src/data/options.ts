import type { GameOption } from "../types";

// Starting options: exactly 3 per category, always unlocked. Everything
// beyond this is invented on the fly by the AI per event (see
// functions/src/index.ts's buildPrompt) rather than drawn from a fixed
// catalog — new discoveries live in GameState.knownMaterials instead.
export const SEED_OPTIONS: GameOption[] = [
  // 人
  {
    id: "person_boss",
    category: "person",
    label: { zh: "主管", en: "Boss" },
    description: { zh: "決定你工作方向、偶爾讓你頭痛的直屬主管。", en: "Your direct supervisor, who sets your work and occasionally gives you headaches." },
  },
  {
    id: "person_colleague",
    category: "person",
    label: { zh: "同事", en: "Colleague" },
    description: { zh: "跟你一起併肩作戰(或摸魚)的同部門夥伴。", en: "The teammate who works — or slacks off — alongside you." },
  },
  {
    id: "person_client",
    category: "person",
    label: { zh: "客戶", en: "Client" },
    description: { zh: "掏錢買單、意見一堆的外部客戶。", en: "The outside client who pays the bills and has plenty of opinions." },
  },

  // 事
  {
    id: "matter_work",
    category: "matter",
    label: { zh: "工作", en: "Work" },
    description: { zh: "日常份內該完成的正經工作事項。", en: "The regular tasks that are actually part of your job." },
  },
  {
    id: "matter_meeting",
    category: "matter",
    label: { zh: "開會", en: "Meeting" },
    description: { zh: "得放下手邊事、去聽人講話或報告的會議。", en: "A gathering where you drop everything to listen or present." },
  },
  {
    id: "matter_slacking",
    category: "matter",
    label: { zh: "摸魚", en: "Slacking Off" },
    description: { zh: "趁沒人注意偷偷放空耍廢的小空檔。", en: "A stolen moment of doing nothing while no one's watching." },
  },

  // 地
  {
    id: "place_office",
    category: "place",
    label: { zh: "辦公室", en: "Office" },
    description: { zh: "每天報到、坐著上班的辦公室座位區。", en: "The desk area where you clock in every day." },
  },
  {
    id: "place_meeting_room",
    category: "place",
    label: { zh: "會議室", en: "Meeting Room" },
    description: { zh: "開會、簡報、偶爾也拿來偷閒的獨立房間。", en: "A dedicated room for meetings, presentations, and the occasional break." },
  },
  {
    id: "place_pantry",
    category: "place",
    label: { zh: "茶水間", en: "Pantry" },
    description: { zh: "泡咖啡、微波便當、順便聊八卦的茶水間。", en: "Where you make coffee, heat up lunch, and catch some gossip." },
  },

  // 物
  {
    id: "object_laptop",
    category: "object",
    label: { zh: "電腦", en: "Computer" },
    description: { zh: "整天離不開手、裝滿工作檔案的筆電。", en: "The laptop that never leaves your side, full of work files." },
  },
  {
    id: "object_phone",
    category: "object",
    label: { zh: "手機", en: "Phone" },
    description: { zh: "隨時響、隨時把你叫走的手機。", en: "Always ringing, always pulling you away." },
  },
  {
    id: "object_coffee",
    category: "object",
    label: { zh: "咖啡", en: "Coffee" },
    description: { zh: "撐過漫長辦公時光的提神飲料。", en: "The drink that gets you through a long day at the office." },
  },
];
