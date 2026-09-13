// lib/googleAuth.ts
//
// Signing in with a Google account.
//
// The Google sheet hands back an ID token, and Supabase exchanges it for a
// session with signInWithIdToken. No browser redirect, no deep link, and the
// account picker is the native one people already recognise.
//
// Everything after that is the same as an email sign-in. The root layout syncs
// the user row on any auth change, so a first Google sign-in creates the
// account without this file knowing that happened.
//
// ---- the setup this depends on, outside the code ----
//
// 1. A WEB OAuth client in Google Cloud. Its client id goes in
//    EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID and its secret goes into Supabase. It is
//    the web one, not the Android one, even though this is an Android app:
//    Supabase verifies the token against the web client.
// 2. An ANDROID OAuth client for com.sweepshopping.app, registered with every
//    certificate the app is ever signed with. That is the debug keystore, the
//    EAS upload key, AND the Play App Signing key. Missing the last one is the
//    classic failure: it works in every build you make and fails for every
//    person who installs from the Play Store.
// 3. Google enabled under Authentication → Providers in Supabase.

import { supabase } from "./supabase";

type GoogleModule = typeof import("@react-native-google-signin/google-signin");

const WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

// ---- loaded lazily, and that is load-bearing ----
//
// This is native code, compiled into the app by a config plugin. A build made
// before the plugin was added does not contain it, and importing the module at
// the top of this file would throw the moment the sign-in or profile screen
// loaded — so updating the JavaScript alone would put a red screen on two of
// the most important screens in every build older than this commit.
//
// Loading on first use, inside a try, means an old build simply never offers
// the button. The feature appears when a build contains the module AND has a
// client id, and not before.
let loaded: GoogleModule | null | undefined;
function google(): GoogleModule | null {
  if (loaded !== undefined) return loaded;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require("@react-native-google-signin/google-signin") as GoogleModule;
  } catch {
    loaded = null;
  }
  return loaded;
}

let configured = false;

/** True only when this build has the native module and a client id. */
export function googleSignInAvailable(): boolean {
  return Boolean(WEB_CLIENT_ID) && google() !== null;
}

function configure(mod: GoogleModule) {
  if (configured || !WEB_CLIENT_ID) return;
  mod.GoogleSignin.configure({ webClientId: WEB_CLIENT_ID });
  configured = true;
}

export type GoogleOutcome =
  | { status: "signed-in" }
  /** The person closed the sheet. Not an error, and not worth a message. */
  | { status: "cancelled" }
  | { status: "failed"; reason: string };

/**
 * Show the Google account picker and sign in with whatever is chosen.
 *
 * Always shows the picker, even when a Google account was used before. That
 * matters for deletion, which calls this to prove the person holding the phone
 * is the account holder: silently reusing the last account would prove nothing.
 */
export async function signInWithGoogle(): Promise<GoogleOutcome> {
  const mod = google();
  if (!WEB_CLIENT_ID || !mod) {
    return { status: "failed", reason: "Google sign-in isn't set up in this build." };
  }
  configure(mod);
  const { GoogleSignin, isErrorWithCode, isSuccessResponse, statusCodes } = mod;

  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    // Signed out of Google first, so the picker appears rather than the last
    // account being reused without asking.
    await GoogleSignin.signOut().catch(() => {});

    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) return { status: "cancelled" };

    const idToken = response.data.idToken;
    if (!idToken) {
      // Happens when the web client id is wrong, or belongs to a different
      // Google Cloud project from the Android client. Worth saying precisely,
      // because from the outside it looks identical to "Google is down".
      return {
        status: "failed",
        reason: "Google didn't return a token. The web client id is probably misconfigured.",
      };
    }

    const { error } = await supabase.auth.signInWithIdToken({
      provider: "google",
      token: idToken,
    });
    if (error) return { status: "failed", reason: error.message };

    return { status: "signed-in" };
  } catch (err) {
    if (isErrorWithCode(err)) {
      if (err.code === statusCodes.SIGN_IN_CANCELLED) return { status: "cancelled" };
      if (err.code === statusCodes.IN_PROGRESS) return { status: "cancelled" };
      if (err.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        return { status: "failed", reason: "Google Play services aren't available on this device." };
      }
    }
    // DEVELOPER_ERROR lands here, and it almost always means a missing SHA-1
    // fingerprint on the Android OAuth client rather than anything in the code.
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : "Google sign-in failed.",
    };
  }
}

/** Forget the Google account on sign-out, so the next person gets the picker. */
export async function signOutOfGoogle(): Promise<void> {
  const mod = google();
  if (!WEB_CLIENT_ID || !mod) return;
  configure(mod);
  await mod.GoogleSignin.signOut().catch(() => {});
}
