# Setting up Google sign-in

The code is done and ships safely without any of this: the button hides itself
until a build has both the native module and a client id. These are the steps
that make it actually appear and work. About twenty minutes, most of it clicking.

---

## 1. Google Cloud — the consent screen

console.cloud.google.com → pick or create a project → **APIs & Services → OAuth
consent screen**.

- User type: **External**
- App name: `Sweep`
- Support email and developer contact: your support address
- Scopes: `email`, `profile`, `openid` — nothing else
- Leave it in **Testing** while you try it, and add your own Google account as a
  test user. Publish it before release, or only listed test users can sign in.

## 2. Google Cloud — the WEB client

**Credentials → Create credentials → OAuth client ID → Web application.**

No redirect URIs needed. Copy both:

- **Client ID** → goes in the app, as `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`
- **Client secret** → goes in Supabase only. Never in the app.

Yes, the _web_ client, even though Sweep is an Android app. Supabase verifies the
token against it. This is the most common mix-up.

## 3. Google Cloud — the ANDROID clients

**Create credentials → OAuth client ID → Android**, package name
`com.sweepshopping.app`, once per signing certificate. You need all three:

| Certificate                      | Where to find its SHA-1                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| Debug (local `expo run:android`) | `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`                             |
| EAS upload key                   | `npx eas-cli credentials` → Android → production → keystore                               |
| **Play App Signing**             | `79:D7:49:79:42:24:0F:19:04:15:84:FE:D1:E8:F9:2D:C5:D6:67:88` (read off a Play install)   |

**Do not skip the Play App Signing one.** Google re-signs the app before
delivering it, so the build people download from the store is signed with a key
you never touched. Without that fingerprint registered, Google sign-in works in
every build you make and fails with `DEVELOPER_ERROR` for every person who
installs from Play. It is the single most common way this breaks.

**The App integrity page shows two certificates, and they look alike.** Only
"App signing key certificate" is what Play installs carry. "Upload key
certificate" (`A2:8B:7C:…` here) signs what you upload and nobody downloads.
Registering the upload key is exactly what went wrong the first time: internal
testing failed with `DEVELOPER_ERROR` until the real one went in, then worked
instantly.

The certain way to know is to read it off an installed copy. With the phone on
USB and the Play build installed:

    adb pull "$(adb shell pm path com.sweepshopping.app | head -1 | sed 's/package://' | tr -d '\r')" app.apk

then read the v2 signer certificate's SHA-1. Current `apksigner` builds choke on
Play's v3.2 post-quantum signer block ("ML-DSA KeyFactory not available") and
`keytool -printcert -jarfile` prints nothing for a v2-only APK, so parse the
APK Signing Block directly if those fail.

## 4. Supabase

Dashboard → **Authentication → Providers → Google** → enable.

- Client ID: the **web** client ID from step 2
- Client secret: the **web** client secret from step 2

If signing in fails with _"Passed nonce and nonce in id_token should either both
exist or not"_, turn on **Skip nonce checks** on that same page. The free version
of the sign-in library does not send a nonce.

## 5. The client id, in two places

Locally, in `sweep-app/.env`:

    EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com

For Play builds, in `sweep-app/eas.json` under `build.production.env`, alongside
the other `EXPO_PUBLIC_` values.

A client id is not a secret — it ships inside every copy of the app — so it is
fine in `eas.json`. The client _secret_ never goes near the app.

## 6. A new build

This is native code, so JavaScript updates alone will not add it. Either:

    npx expo run:android                              # dev build on the phone
    npx eas-cli build -p android --profile production # a Play build

---

## Checking it worked

- The sign-in screen shows **or** and a **Continue with Google** button
- Choosing an account signs you in and lands on Home
- A brand new Google account gets a Sweep account created automatically
- Profile → Delete my account shows **Confirm with Google** instead of a password
  field, and asks you to pick the account again before deleting

## When it doesn't

| Symptom                        | Almost always                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| No button at all               | Old build without the native module, or no client id in that build                         |
| `DEVELOPER_ERROR`              | A SHA-1 isn't registered — usually the Play App Signing one, or the upload key registered in its place |
| "Google didn't return a token" | Wrong web client id, or the web and Android clients are in different Google Cloud projects |
| Nonce error                    | Step 4, skip nonce checks                                                                  |
| Only you can sign in           | Consent screen still in Testing                                                            |
