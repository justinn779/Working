import { defineConfig } from "vite";
import { resolve } from "path";

// Multi-page build: the player-facing game (index.html) and the admin
// dashboard are separate bundles — admin code/strings never need to ship to
// every player, and vice versa. The admin entry's filename is deliberately
// an unguessable string rather than "admin.html" — real access control is
// still Firebase Auth + the admins/{uid} allowlist (see firestore.rules),
// this is just an extra layer to keep it off casual path-guessing/bots.
export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        admin: resolve(__dirname, "mk9x2qzp7f.html"),
      },
    },
  },
});
