import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  linkWithPopup,
  signInWithRedirect,
  linkWithRedirect,
  getRedirectResult,
  signOut,
  GoogleAuthProvider,
  type User,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";

// Firebase's web config identifies the project — it is not a secret (unlike
// the OpenAI API key, which never appears in frontend code). Security is
// enforced by Firestore rules and by requiring auth on the Cloud Function.
const firebaseConfig = {
  apiKey: "AIzaSyBSl2hQJvlY0C7g5C8PjwsL9pmUPQ1wU9w",
  authDomain: "workplace-big-small.firebaseapp.com",
  projectId: "workplace-big-small",
  storageBucket: "workplace-big-small.firebasestorage.app",
  messagingSenderId: "368834246968",
  appId: "1:368834246968:web:03c771eaca7d288baa29cd",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, "asia-east1");

/** Resolves once a user (anonymous at minimum) is signed in. */
export function ensureSignedIn(): Promise<User> {
  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        unsubscribe();
        if (user) {
          resolve(user);
          return;
        }
        signInAnonymously(auth)
          .then((cred) => resolve(cred.user))
          .catch(reject);
      },
      reject
    );
  });
}

export function isGoogleLinked(user: User): boolean {
  return user.providerData.some((p) => p.providerId === "google.com");
}

/** Popups are unreliable on mobile/embedded browsers (Instagram/Facebook/LINE
 * in-app browsers, and plain mobile Safari/Chrome) — they get silently
 * blocked, or the OAuth flow escapes into a system browser tab that never
 * hands control back to the popup's window.opener, leaving the original
 * page's promise hanging forever. Redirect-based auth navigates the whole
 * page instead, which always works but means the result only shows up after
 * the round trip (see completeGoogleRedirectSignIn). */
function isMobileOrEmbeddedBrowser(): boolean {
  return /Android|iPhone|iPad|iPod|Instagram|FBAN|FBAV|Line\//i.test(navigator.userAgent);
}

/**
 * Links the current anonymous session to a Google account. If that Google
 * account already owns a different (older) Firebase user — e.g. the player
 * signed in before on another device — Firebase refuses the link, so we fall
 * back to signing straight into that pre-existing account instead. Either
 * way the player ends up on the uid their Google account is tied to.
 *
 * Returns `null` on mobile/embedded browsers, where this triggers a redirect
 * instead of a popup — the page navigates away immediately, so there's no
 * user object to hand back here; call completeGoogleRedirectSignIn() on the
 * next page load to pick up the actual result.
 */
export async function signInWithGoogle(): Promise<User | null> {
  const provider = new GoogleAuthProvider();
  const current = auth.currentUser;

  if (isMobileOrEmbeddedBrowser()) {
    if (current?.isAnonymous) {
      await linkWithRedirect(current, provider);
    } else {
      await signInWithRedirect(auth, provider);
    }
    return null;
  }

  if (current?.isAnonymous) {
    try {
      const cred = await linkWithPopup(current, provider);
      return cred.user;
    } catch (err) {
      if ((err as { code?: string }).code === "auth/credential-already-in-use") {
        const cred = await signInWithPopup(auth, provider);
        return cred.user;
      }
      throw err;
    }
  }
  const cred = await signInWithPopup(auth, provider);
  return cred.user;
}

/** Completes a Google sign-in that was started via redirect (see
 * signInWithGoogle) — must be called once on every app load; resolves to
 * `null` (fast, no-op) if there's no pending redirect result. Mirrors
 * signInWithGoogle's own "already linked elsewhere" fallback, since that
 * error can only surface here for the redirect flow (there's no synchronous
 * call site to catch it at before the page navigates away). */
export async function completeGoogleRedirectSignIn(): Promise<User | null> {
  try {
    const result = await getRedirectResult(auth);
    return result?.user ?? null;
  } catch (err) {
    if ((err as { code?: string }).code === "auth/credential-already-in-use") {
      await signInWithRedirect(auth, new GoogleAuthProvider());
      return null; // navigating away again — no user to report yet
    }
    throw err;
  }
}

/** Signs out of the Google-linked account and immediately starts a fresh
 * anonymous session, so the app always has *some* authenticated user to call
 * the Cloud Function with. Local progress is untouched — signing out just
 * stops cloud sync going forward, on a new (empty) cloud identity. */
export async function signOutToLocal(): Promise<User> {
  await signOut(auth);
  return ensureSignedIn();
}
