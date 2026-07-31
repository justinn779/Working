import { defineSecret } from "firebase-functions/params";

export const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
export const TELEGRAM_CHAT_ID = defineSecret("TELEGRAM_CHAT_ID");

/** Every function that calls notifyTelegram must declare these in its own
 * `secrets: [...]` array (Cloud Functions v2 requires a secret be declared
 * on whichever function actually reads `.value()` at runtime) — this array
 * exists just so call sites can spread one constant instead of repeating
 * both names everywhere. */
export const TELEGRAM_SECRETS = [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID];

/** Best-effort operator notification — a Telegram delivery failure (bad
 * token, Telegram API hiccup, secrets not configured yet) must never break
 * the business logic it's attached to. Payment/order/event processing
 * always succeeds or fails purely on its own terms; this only ever logs a
 * warning and swallows the error, never throws. */
export async function notifyTelegram(message: string): Promise<void> {
  let token: string;
  let chatId: string;
  try {
    // .trim() guards against a trailing newline sneaking into the secret's
    // stored value depending on how it was piped into `secrets:set` (e.g.
    // PowerShell's `"x" | ...` appends one, unlike bash's `echo -n`) — an
    // un-trimmed token breaks the URL path below and Telegram returns a
    // plain 404 with no indication it was a whitespace problem.
    token = TELEGRAM_BOT_TOKEN.value().trim();
    chatId = TELEGRAM_CHAT_ID.value().trim();
  } catch {
    return; // secret not bound to this function yet — treat as "not configured"
  }
  if (!token || !chatId) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
    if (!res.ok) {
      console.warn("Telegram 通知發送失敗", res.status, await res.text().catch(() => ""));
    }
  } catch (err) {
    console.warn("Telegram 通知發送失敗", err);
  }
}
