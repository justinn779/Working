import type { GameOption } from "../types";

// Starting options: exactly 3 per category, always unlocked. Everything
// beyond this is invented on the fly by the AI per event (see
// functions/src/index.ts's buildPrompt) rather than drawn from a fixed
// catalog — new discoveries live in GameState.knownMaterials instead.
export const SEED_OPTIONS: GameOption[] = [
  // 人
  { id: "person_boss", category: "person", label: { zh: "主管", en: "Boss" } },
  { id: "person_colleague", category: "person", label: { zh: "同事", en: "Colleague" } },
  { id: "person_client", category: "person", label: { zh: "客戶", en: "Client" } },

  // 事
  { id: "matter_work", category: "matter", label: { zh: "工作", en: "Work" } },
  { id: "matter_meeting", category: "matter", label: { zh: "開會", en: "Meeting" } },
  { id: "matter_slacking", category: "matter", label: { zh: "摸魚", en: "Slacking Off" } },

  // 地
  { id: "place_office", category: "place", label: { zh: "辦公室", en: "Office" } },
  { id: "place_meeting_room", category: "place", label: { zh: "會議室", en: "Meeting Room" } },
  { id: "place_pantry", category: "place", label: { zh: "茶水間", en: "Pantry" } },

  // 物
  { id: "object_laptop", category: "object", label: { zh: "電腦", en: "Computer" } },
  { id: "object_phone", category: "object", label: { zh: "手機", en: "Phone" } },
  { id: "object_coffee", category: "object", label: { zh: "咖啡", en: "Coffee" } },
];
