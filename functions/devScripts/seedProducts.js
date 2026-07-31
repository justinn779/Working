// One-off seed script for the `products` collection — this project has no
// admin dashboard (deliberately, per Stage 1 design), so product rows are
// created by running this script directly rather than through a UI.
//
// Safety guard: refuses to run unless it's clearly targeting the emulator
// (FIRESTORE_EMULATOR_HOST set) or production is explicitly requested via
// FORCE_PROD=1 — this stops an accidental `node seedProducts.js` from
// silently overwriting live product data.
//
// Usage (emulator):  FIRESTORE_EMULATOR_HOST=localhost:8080 node devScripts/seedProducts.js
// Usage (production): FORCE_PROD=1 node devScripts/seedProducts.js
//
// Requires Application Default Credentials to be set up on this machine
// (`gcloud auth application-default login`) when targeting production —
// this dev machine doesn't have that configured yet, which is why the
// products collection was actually seeded via a temporary deployed
// onRequest function instead (see git history / project memory). Fix the
// ADC prerequisite before relying on this script against production.
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!process.env.FIRESTORE_EMULATOR_HOST && process.env.FORCE_PROD !== "1") {
  console.error(
    "Refusing to run: neither FIRESTORE_EMULATOR_HOST nor FORCE_PROD=1 is set. " +
      "This script writes to Firestore's products collection — point it at the emulator " +
      "for testing, or set FORCE_PROD=1 to explicitly target production."
  );
  process.exit(1);
}

initializeApp({
  projectId: process.env.GCLOUD_PROJECT || "workplace-big-small",
  credential: process.env.FIRESTORE_EMULATOR_HOST ? undefined : applicationDefault(),
});
const db = getFirestore();

// "stamina-full"'s paidCoins must match src/config.ts's MAX_STAMINA_UNITS
// (8h / 10-minute units = 48) so using it fully tops up 工時 from empty in
// one go; "stamina-half" is exactly half of that (4h = 24). Names are just
// size labels (大/小) — the concrete hour amount lives in `description`,
// shown as a hover/tap tooltip on the shop page.
const PRODUCTS = [
  {
    id: "stamina-full",
    productCode: "STAMINA_FULL",
    name: { zh: "工時補充劑(大)", en: "Work-Hours Supplement (Large)" },
    description: { zh: "使用後補 8 小時工時", en: "Refills 8 hours of work time when used." },
    price: 59,
    paidCoins: 48,
  },
  {
    id: "stamina-half",
    productCode: "STAMINA_HALF",
    name: { zh: "工時補充劑(小)", en: "Work-Hours Supplement (Small)" },
    description: { zh: "使用後補 4 小時工時", en: "Refills 4 hours of work time when used." },
    price: 30,
    paidCoins: 24,
  },
];

async function main() {
  const now = Date.now();
  for (const { id, ...data } of PRODUCTS) {
    await db
      .collection("products")
      .doc(id)
      .set({ ...data, currency: "TWD", enabled: true, createdAt: now, updatedAt: now });
    console.log(`seeded products/${id}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
