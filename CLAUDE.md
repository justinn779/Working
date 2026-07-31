# Working Big & Small (工作大小事)

Firebase project: `workplace-big-small`. Vite + TS frontend (`src/`), Cloud Functions v2 backend (`functions/`), Firestore.

## Deploy workflow (user-approved standing instruction)

After making a code change in this project:
1. Run the build check for whatever was touched (`npm run build` at repo root for frontend, `npm run build` in `functions/` for backend). Never commit/push/deploy on a failing build.
2. `git add` + `git commit` with a message describing the change, then `git push origin main`. Do this automatically without asking each time.
3. Run `firebase deploy` to publish to production. Do this automatically without asking each time.
4. Report what changed and the deploy result — auto-executing the mechanics doesn't mean skipping the summary, and anything risky/unfinished (e.g. missing secrets, WIP features) should still be flagged even though the push/deploy itself isn't gated on asking first.

## Environment gotchas (this machine)

- **`firebase deploy` must be run via the PowerShell tool, not Bash/Git-Bash.** In Git Bash, the functions discovery step (`Cannot determine backend specification. Timeout after 10000`) reliably times out because Git Bash's nested spawn of `cmd.exe` (used internally by `firebase-tools` for its `npm show` SDK-version check) is extremely slow/hangs in that shell — confirmed by reproducing the exact same `spawnSync cmd.exe ETIMEDOUT` outside of any Firebase code. Running the identical `firebase deploy` via PowerShell avoids this entirely and completes normally.
- `functions/.env` (gitignored, see `.env.example` for the template) must contain `PAYPAL_ENV=sandbox` — without it, a non-interactive `firebase deploy` fails with "In non-interactive mode but have no value for the following environment variables: PAYPAL_ENV" since Firebase can't prompt for a value with no TTY attached.
- Firebase CLI login is shared across all shells on this machine (stored in the OS user profile, not per-terminal) — once logged in once anywhere, `firebase login:list` succeeds everywhere, including from an agent's sandboxed shell.
- This machine's default Node (via nvm-windows) was 18.16.0; this project's tooling (`firebase-tools`, `functions/package.json` engines) needs Node 20+. Node 22 is installed via `nvm install 22` / `nvm use 22`, plus a global `firebase-tools` install (`npm install -g firebase-tools`) so `firebase` works without `npx`. `nvm` itself must be run from a real PowerShell/CMD window (not Git Bash), or it refuses with a GUI dialog.

## Payment system (PayPal) status

`functions/src/paypalClient.ts`, `topupHandlers.ts`, `paypalWebhook.ts`, `refundService.ts`, `adminHandlers.ts`, `src/paypalTopup.ts`, `src/paypalSdk.ts`, `src/admin/*` implement a full PayPal top-up + admin dashboard (Stage 1-4 design, see comments in those files). `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET`/`PAYPAL_WEBHOOK_ID` secrets are already set in Firebase Secret Manager (sandbox mode) and all related Cloud Functions are deployed and ACTIVE — this is not just unreachable WIP code, it's live (in PayPal Sandbox, not real-money Live mode).

Admin dashboard is served from `mk9x2qzp7f.html` (deliberately unguessable filename, not `admin.html`) — real access control is Firebase Auth + the `admins/{uid}` Firestore allowlist (see `firestore.rules`), the odd filename is just an extra layer against casual path-guessing.
