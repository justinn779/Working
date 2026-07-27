import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  linkWithPopup,
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

/**
 * Links the current anonymous session to a Google account. If that Google
 * account already owns a different (older) Firebase user — e.g. the player
 * signed in before on another device — Firebase refuses the link, so we fall
 * back to signing straight into that pre-existing account instead. Either
 * way the player ends up on the uid their Google account is tied to.
 */
export async function signInWithGoogle(): Promise<User> {
  const provider = new GoogleAuthProvider();
  const current = auth.currentUser;
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

/** Signs out of the Google-linked account and immediately starts a fresh
 * anonymous session, so the app always has *some* authenticated user to call
 * the Cloud Function with. Local progress is untouched — signing out just
 * stops cloud sync going forward, on a new (empty) cloud identity. */
export async function signOutToLocal(): Promise<User> {
  await signOut(auth);
  return ensureSignedIn();
}
