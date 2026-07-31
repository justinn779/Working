import { SEED_OPTIONS } from "./data/options";
import { CATEGORY_LABEL, CATEGORY_ORDER } from "./types";
import type { Category, GameOption, Localized, Selection } from "./types";

const OPTIONS_BY_ID: Record<string, GameOption> = Object.fromEntries(
  SEED_OPTIONS.map((o) => [o.id, o])
);

/** The hand-authored locked catalog that used to back featuredOption before
 * the AI-invention rearchitecture — no longer offered to new players, but
 * events cached in Firestore *before* that change still reference these ids
 * and only ever stored `{category, optionId}` (no `label`, since that field
 * didn't exist yet). Kept here purely so old cached events still resolve a
 * label instead of rendering blank; never used for new unlocks. */
const LEGACY_OPTION_LABELS: Record<string, { category: Category; label: Localized }> = {
  person_intern: { category: "person", label: { zh: "工讀生", en: "Intern" } },
  person_alone: { category: "person", label: { zh: "自己一個人", en: "Alone" } },
  person_cleaner: { category: "person", label: { zh: "神秘清潔阿姨", en: "Mysterious Cleaning Lady" } },
  person_ceo: { category: "person", label: { zh: "總經理", en: "General Manager" } },
  person_ex_colleague: { category: "person", label: { zh: "已離職的前同事", en: "Former Colleague" } },
  person_rival: { category: "person", label: { zh: "競爭對手公司的人", en: "Person from a Rival Company" } },
  matter_overtime: { category: "matter", label: { zh: "加班趕案子", en: "Working Overtime on a Project" } },
  matter_presentation: { category: "matter", label: { zh: "提案簡報", en: "Proposal Presentation" } },
  matter_smalltalk: { category: "matter", label: { zh: "茶水間閒聊", en: "Break Room Chat" } },
  matter_job_interview: { category: "matter", label: { zh: "偷偷去面試", en: "Sneaking Off to a Job Interview" } },
  matter_whistleblow: { category: "matter", label: { zh: "內部檢舉", en: "Internal Whistleblowing" } },
  matter_startup_pitch: { category: "matter", label: { zh: "醞釀創業提案", en: "Brewing a Startup Pitch" } },
  matter_party_show: { category: "matter", label: { zh: "尾牙表演彩排", en: "Year-End Party Rehearsal" } },
  place_elevator: { category: "place", label: { zh: "電梯", en: "Elevator" } },
  place_downstairs: { category: "place", label: { zh: "公司樓下", en: "Downstairs from the Office" } },
  place_rooftop: { category: "place", label: { zh: "頂樓天台", en: "Rooftop" } },
  place_boss_office: { category: "place", label: { zh: "老闆辦公室", en: "Boss's Office" } },
  place_remote_office: { category: "place", label: { zh: "異地辦公室", en: "Remote Office" } },
  place_empty_office_night: { category: "place", label: { zh: "深夜只剩自己的辦公室", en: "Office, Empty at Night" } },
  object_slides: { category: "object", label: { zh: "簡報檔案", en: "Presentation Slides" } },
  object_printer: { category: "object", label: { zh: "印表機", en: "Printer" } },
  object_fortune: { category: "object", label: { zh: "神秘籤詩", en: "Mysterious Fortune Slip" } },
  object_resignation: { category: "object", label: { zh: "辭職信", en: "Resignation Letter" } },
  object_lottery: { category: "object", label: { zh: "樂透彩券", en: "Lottery Ticket" } },
  object_crypto_wallet: { category: "object", label: { zh: "加密貨幣錢包", en: "Crypto Wallet" } },
};

/** AI-invented materials (see functions/src/index.ts) aren't in any fixed
 * catalog, so resolving one by id needs the player's own knownMaterials map
 * (GameState.knownMaterials) as a fallback once the static seed list misses.
 * description/discovererName/discoveredAt/comboKey are all optional because
 * a save recorded before those fields existed will only have category+label. */
export interface MaterialRecord {
  category: Category;
  label: Localized;
  description?: Localized;
  /** Who/when/via-which-combo/how-much-stamina this material was first ever
   * discovered (globally) — mirrors the discovering event's own
   * discovererName/discoveredAt/comboKey/durationUnits, since a material is
   * always invented alongside the one event that first produced it (see
   * functions/src/index.ts). */
  discovererName?: string;
  discoveredAt?: number;
  comboKey?: string;
  durationUnits?: number;
}

export type KnownMaterials = Record<string, MaterialRecord>;

export function getOptionById(id: string, knownMaterials?: KnownMaterials): GameOption | undefined {
  const seed = OPTIONS_BY_ID[id];
  if (seed) return seed;
  // Checked for a truthy `.label` specifically, not just presence in the map:
  // a player who recorded a pre-rearchitecture event before this fallback
  // existed may already have an incomplete `{category}`-only entry cached in
  // their own knownMaterials, which would otherwise permanently shadow the
  // legacy lookup below for that id.
  const known = knownMaterials?.[id];
  if (known?.label?.zh) return { id, category: known.category, label: known.label, description: known.description };
  const legacy = LEGACY_OPTION_LABELS[id];
  return legacy ? { id, category: legacy.category, label: legacy.label } : undefined;
}

/** Strips characters that would corrupt comboKey parsing (`|` separates
 * segments, `:` separates a segment's category from its value) — mirrors
 * functions/src/index.ts's copy exactly. A job title is free text (GPT can
 * invent one, same as a material), so it needs the same guard a material
 * name gets before going into the key. */
function sanitizeForId(label: string): string {
  return label.replace(/[|:]/g, "");
}

/** Deterministic cache key for a combo — category order is fixed so equal
 * selections always produce the same key regardless of pick order. Duration
 * is included as the exact unit count (not a bucket) — every distinct
 * duration choice is its own discoverable event. The player's current job
 * title is also part of the key — the same materials tell a different,
 * separately-cached story depending on what job the acting player currently
 * holds (see functions/src/index.ts's buildPrompt). Must match
 * functions/src/index.ts's copy exactly. */
export function buildComboKey(selection: Selection, durationUnits: number, jobTitleZh: string): string {
  const base = CATEGORY_ORDER.map((cat) => `${cat}:${selection[cat] ?? "none"}`).join("|");
  return `${base}|time:${durationUnits}|job:${sanitizeForId(jobTitleZh)}`;
}

export function isEmptySelection(selection: Selection): boolean {
  return CATEGORY_ORDER.every((cat) => selection[cat] === null);
}

export function hasAnySelection(selection: Selection): boolean {
  return !isEmptySelection(selection);
}

/** Reverses buildComboKey back into human-readable labels per category, for
 * displaying past events. Segments for categories that no longer exist (e.g.
 * an old cached "time:xxx" segment from before that category was removed)
 * are silently ignored rather than crashing. Returns the full bilingual
 * label — callers pick zh/en based on the current UI language. */
export function decodeComboKey(comboKey: string, knownMaterials?: KnownMaterials): Partial<Record<Category, Localized>> {
  const result: Partial<Record<Category, Localized>> = {};
  for (const part of comboKey.split("|")) {
    const [cat, id] = part.split(":");
    if (!id || id === "none") continue;
    if (!(cat in CATEGORY_LABEL)) continue;
    const label = getOptionById(id, knownMaterials)?.label;
    if (label) result[cat as Category] = label;
  }
  return result;
}
