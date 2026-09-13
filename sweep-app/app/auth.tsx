// app/auth.tsx
//
// Sign in, sign up, or continue as a guest.
//
// Note there's no syncUser call here: the root layout syncs on every auth
// state change, which also covers confirming by email and restoring a
// persisted session — paths that never pass through this screen.

import ForgotPasswordSheet from "@/components/ForgotPasswordSheet";
import PasswordInput from "@/components/PasswordInput";
import { Button } from "@/components/ui";
import { type Palette, radius, spacing, type } from "@/constants/theme";
import { storeListPhrase } from "@/lib/format";
import { setGuestMode } from "@/lib/guestMode";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "@/lib/supabase";
import { googleSignInAvailable, signInWithGoogle } from "@/lib/googleAuth";
import { useTheme, useThemedStyles } from "@/lib/theme";
import { useTranslate } from "@/lib/i18n";
import { MIN_PASSWORD_LENGTH, friendlyAuthErrorKey } from "@/lib/authErrors";
import { suggestEmail } from "@/lib/emailTypos";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import {
  AppState,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

/** Supabase refuses rapid resends; this keeps the button honest about it. */
const RESEND_COOLDOWN_MS = 60_000;

/** Which address is part-way through confirmation. Never the password. */
const PENDING_EMAIL_KEY = "sweep.auth.pendingEmail";

export default function Auth() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const t = useTranslate();

  const [email, setEmail] = useState("");
  // Recomputed only when the address changes, not on every keystroke elsewhere
  // on the form.
  const suggestion = useMemo(() => suggestEmail(email), [email]);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(true);
  const [busy, setBusy] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  // Set when an account exists but hasn't been confirmed. Drives a panel
  // rather than another line of message text: the old flow said "check your
  // email" after signup and then said almost the same thing again when Log In
  // was pressed, which reads as the button doing nothing.
  const [awaitingConfirm, setAwaitingConfirm] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  // True when we've come back to a cold start mid-confirmation. Drives one
  // line of explanation, so the form isn't just blank and unexplained.
  const [resuming, setResuming] = useState(false);
  const [checking, setChecking] = useState(false);
  // Epoch ms until which resend is refused. Supabase rate-limits these, and a
  // provider error after an eager double-tap reads as "it's broken".
  const [resendReadyAt, setResendReadyAt] = useState(0);
  // Re-renders once a second so the cooldown label counts down instead of
  // freezing at whatever it said when the button was pressed.
  const [, setTick] = useState(0);
  // Scrolling is only enabled when the content genuinely overflows. A
  // ScrollView claims a touch as a scroll the moment the finger drifts a few
  // pixels, which cancels the press underneath it — so on a screen that fits,
  // buttons feel like they need to be jabbed precisely. Measuring both heights
  // keeps the keyboard fix (reachable buttons on a shrunken viewport) without
  // paying for it on every tap.
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const scrollable = contentHeight > viewportHeight;

  // Confirming happens in a browser, so the moment that matters is the user
  // coming back to the app. Retrying the sign-in then turns "confirm, switch
  // back, type it all again" into "confirm, switch back, you're in" — without
  // deep links, which email clients handle unevenly, or PKCE, which breaks if
  // the link is opened on a different device.
  //
  // The credentials are already in this screen's state; nothing is stored.
  //
  // That works while the app stays alive. It does not survive Android killing
  // Sweep while the person is off in their email app — which is most likely on
  // a fresh install, since a new app has no residency and is evicted first.
  // Coming back then meant a cold start, an empty form and no explanation.
  //
  // So the ADDRESS is remembered, and only the address. Storing the password
  // to enable an automatic retry would be trading someone's credentials for a
  // saved keystroke, which is not a trade worth making.
  const credentials = useRef({ email: "", password: "" });
  credentials.current = { email, password };

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(PENDING_EMAIL_KEY)
      .then((pending) => {
        if (cancelled || !pending) return;
        setEmail((current) => current || pending);
        setResuming(true);
      })
      .catch(() => {
        // A missed restore just means the form starts empty, which is what
        // used to happen every time.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Try to sign in with what's already in the form.
   *
   * Returns whether it worked, so the manual "I've confirmed" button can say
   * something when it hasn't while the automatic retry stays silent.
   */
  const tryConfirmedSignIn = useCallback(async (): Promise<boolean> => {
    const { email: address, password: secret } = credentials.current;
    if (!address || !secret) return false;

    const { data, error } = await supabase.auth.signInWithPassword({
      email: address,
      password: secret,
    });
    if (error || !data.session) return false;

    setAwaitingConfirm(null);
    await AsyncStorage.removeItem(PENDING_EMAIL_KEY).catch(() => {});
    await setGuestMode(false);
    router.replace("/(tabs)");
    return true;
  }, [router]);

  useEffect(() => {
    if (Date.now() >= resendReadyAt) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    // Stops as soon as the cooldown lapses, so nothing ticks on a screen with
    // nothing counting.
    return () => clearInterval(timer);
  }, [resendReadyAt]);

  useEffect(() => {
    if (!awaitingConfirm) return;

    const subscription = AppState.addEventListener("change", (state) => {
      // Still unconfirmed is the expected case on most returns — this stays
      // silent either way rather than nagging someone who switched apps for a
      // second.
      if (state === "active") void tryConfirmedSignIn();
    });

    return () => subscription.remove();
  }, [awaitingConfirm, tryConfirmedSignIn]);

  function fail(text: string) {
    setIsError(true);
    setMessage(text);
  }

  async function continueWithGoogle() {
    setMessage(null);
    setBusy(true);
    try {
      const outcome = await signInWithGoogle();
      // Nothing to do on success: the root layout sees the new session, syncs
      // the account and routes away from this screen, exactly as it does for
      // an email sign-in.
      if (outcome.status === "failed") fail(outcome.reason);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Sign in with whatever is in the form.
   *
   * Split out from the button handler because signing up with an address that
   * already has an account ends here too. `afterDuplicate` only changes the
   * wording of a rejected password: we already know the account exists, so the
   * usual "email or password is incorrect" would be vaguer than what we know.
   */
  async function attemptSignIn(afterDuplicate = false) {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      // Supabase returns the same "Invalid login credentials" whether the email
      // is unknown or the password is wrong — deliberately, so the form can't
      // be used to find out who has an account. Passed through verbatim it
      // reads as "your account is missing", which sends people to sign up
      // again and hit "already registered". Say what it actually means.
      if (/invalid login credentials/i.test(error.message)) {
        return fail(
          afterDuplicate
            ? t("auth.accountExists")
            : t("auth.badCredentials"),
        );
      }
      if (/email not confirmed/i.test(error.message)) {
        setAwaitingConfirm(email.trim());
        return fail(t("auth.confirmBlocked"));
      }
      return fail(t(friendlyAuthErrorKey(error.message)));
    }

    await AsyncStorage.removeItem(PENDING_EMAIL_KEY).catch(() => {});
    await setGuestMode(false);
    router.replace("/(tabs)");
  }

  async function signUp() {
    Keyboard.dismiss();
    if (!validate()) return;

    setBusy(true);
    setMessage(null);

    try {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) return fail(t(friendlyAuthErrorKey(error.message)));

      // Supabase does not error on a duplicate email — it returns a
      // success-shaped response with no session, identical to a genuine new
      // signup, so nobody can probe which addresses have accounts. The one
      // tell is that `identities` comes back empty.
      //
      // At that point we know the account exists and we are holding an email
      // and password the person just typed, so we sign them in rather than
      // asking them to retype nothing and press a different button. If the
      // password is right they are simply in; if not, they get a message that
      // says which half was wrong.
      if (data.user && data.user.identities?.length === 0) {
        return await attemptSignIn(true);
      }

      if (data.session) {
        // Signing up supersedes guest mode, so the flag doesn't linger and
        // grant guest fallbacks to a real account.
        await setGuestMode(false);
        router.replace("/(tabs)");
      } else {
        // No session means the project requires email confirmation.
        setAwaitingConfirm(email.trim());
        void AsyncStorage.setItem(PENDING_EMAIL_KEY, email.trim()).catch(() => {});
        setIsError(false);
        setMessage(null);
      }
    } catch {
      // Without this the screen locks: a throw would skip setBusy(false) and
      // leave every button on the page disabled with no way back.
      fail(t("auth.offline"));
    } finally {
      setBusy(false);
    }
  }

  async function signIn() {
    Keyboard.dismiss();
    if (!validate()) return;

    setBusy(true);
    setMessage(null);

    try {
      await attemptSignIn();
    } catch {
      fail(t("auth.offline"));
    } finally {
      setBusy(false);
    }
  }

  async function resendConfirmation() {
    if (!awaitingConfirm || Date.now() < resendReadyAt) return;
    setResending(true);
    try {
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: awaitingConfirm,
      });
      setIsError(Boolean(error));
      // Supabase rate-limits resends; saying so beats a raw provider error.
      setMessage(error ? t("auth.resendFailed") : t("auth.resent"));
      // Set on failure too. A refusal is usually the rate limit itself, and
      // letting someone tap straight into another one just repeats it.
      setResendReadyAt(Date.now() + RESEND_COOLDOWN_MS);
    } catch {
      fail(t("auth.offline"));
    } finally {
      setResending(false);
    }
  }

  /**
   * "I've confirmed" — the manual version of the automatic retry.
   *
   * Exists because the automatic one is driven by the app returning to the
   * foreground, which never happens if the link is opened somewhere else. A
   * confirmation email read on a laptop leaves the phone sitting on this
   * screen forever with no way forward.
   */
  async function checkConfirmed() {
    setChecking(true);
    setMessage(null);
    try {
      const signedIn = await tryConfirmedSignIn();
      if (!signedIn) fail(t("auth.stillWaiting"));
    } catch {
      fail(t("auth.offline"));
    } finally {
      setChecking(false);
    }
  }

  /** Back to the form, so a wrong address doesn't mean restarting the app. */
  function useDifferentEmail() {
    setAwaitingConfirm(null);
    setMessage(null);
    setPassword("");
    setResendReadyAt(0);
    setResuming(false);
    // Forget the abandoned address too, or a cold start would restore the one
    // they just chose to leave behind — which is the exact wrong half of
    // remembering it at all.
    void AsyncStorage.removeItem(PENDING_EMAIL_KEY).catch(() => {});
  }

  async function continueAsGuest() {
    await setGuestMode(true);
    router.replace("/(tabs)");
  }

  function validate() {
    if (!email.trim() || !password) {
      fail(t("auth.needBoth"));
      return false;
    }
    // Supabase enforces this server-side too; catching it here saves a round
    // trip and gives a clearer message than the API's. Set Supabase's own
    // minimum to match, or it refuses after this passes.
    if (password.length < MIN_PASSWORD_LENGTH) {
      fail(t("auth.tooShort"));
      return false;
    }
    return true;
  }

  // A screen of its own rather than a panel above the form. The panel left
  // "Sign up" and "Log in" sitting underneath it, so the most common next
  // action was pressing Sign up again — which does nothing useful and reads
  // as the app having ignored you. There is exactly one thing to do here.
  if (awaitingConfirm) {
    const waitSeconds = Math.ceil((resendReadyAt - Date.now()) / 1000);
    const canResend = waitSeconds <= 0;

    return (
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.confirmIcon}>
          <Ionicons name="mail-outline" size={30} color={colors.accent} />
        </View>

        <Text style={styles.confirmHeading}>{t("auth.confirmTitle")}</Text>
        <Text style={styles.confirmBody}>
          {t("auth.confirmBody", { email: awaitingConfirm })}
        </Text>
        <Text style={styles.confirmAuto}>{t("auth.confirmAuto")}</Text>

        {message && (
          <Text style={[styles.message, !isError && styles.messageOk]}>
            {message}
          </Text>
        )}

        {/* First, because it's the one that works when the link was opened on
            a different device — where nothing else on this screen will ever
            fire on its own. */}
        <Button
          label={t("auth.checkNow")}
          onPress={checkConfirmed}
          busy={checking}
        />
        <Button
          label={canResend ? t("auth.resend") : t("auth.resendIn", { seconds: waitSeconds })}
          onPress={resendConfirmation}
          busy={resending}
          disabled={!canResend}
          variant="secondary"
        />

        <Text style={styles.confirmSpam}>{t("auth.confirmSpam")}</Text>

        {/* The way out of a typo. Without it a wrong address is a dead end
            that survives restarting the app, because the account already
            exists and signing in is refused until it's confirmed. */}
        <Pressable style={styles.forgotButton} onPress={useDifferentEmail} hitSlop={8}>
          <Text style={styles.forgotText}>{t("auth.differentEmail")}</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    // Scrollable rather than a centred View: with the keyboard up the window
    // shrinks, and a fixed centred column silently pushes its bottom controls
    // underneath the keyboard where taps land on keys instead of buttons.
    // keyboardShouldPersistTaps is what makes a button reachable on the FIRST
    // tap — the default lets the keyboard swallow that tap to dismiss itself.
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      scrollEnabled={scrollable}
      onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
      onContentSizeChange={(_width, height) => setContentHeight(height)}
    >
      <Text style={styles.title}>{t("auth.title")}</Text>
      <Text style={styles.subtitle}>{t("auth.subtitle")}</Text>

      <TextInput
        style={styles.input}
        placeholder={t("auth.email")}
        placeholderTextColor={colors.textTertiary}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="emailAddress"
      />

      {/*
        Shown, never applied automatically. Sweep signs people in without
        confirming their address, so a mistyped domain is never caught and the
        address is the only way back into a forgotten account — but plenty of
        real addresses live on domains this has never heard of, so being wrong
        has to cost one glance rather than a blocked signup.
      */}
      {suggestion && (
        <Pressable
          onPress={() => setEmail(suggestion)}
          style={styles.suggestion}
          hitSlop={6}
        >
          <Text style={styles.suggestionText}>
            {t("auth.didYouMean")}{" "}
            <Text style={styles.suggestionEmail}>{suggestion}</Text>
          </Text>
        </Pressable>
      )}
      <PasswordInput
        fieldStyle={styles.input}
        placeholder={t("auth.password")}
        value={password}
        onChangeText={setPassword}
        textContentType="password"
      />

      {resuming && !message && (
        <Text style={styles.resuming}>{t("auth.resumeConfirm")}</Text>
      )}

      {message && (
        <Text style={[styles.message, !isError && styles.messageOk]}>
          {message}
        </Text>
      )}

      <Button label={t("auth.signUp")} onPress={signUp} busy={busy} />
      <Button
        label={t("auth.logIn")}
        onPress={signIn}
        variant="secondary"
        disabled={busy}
      />

      {/* Only offered when this build has a client id. A button that opens the
          Google sheet and then fails every time is worse than no button. */}
      {googleSignInAvailable() && (
        <>
          <View style={styles.orRow}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>{t("auth.or")}</Text>
            <View style={styles.orLine} />
          </View>
          <Pressable
            onPress={continueWithGoogle}
            disabled={busy}
            style={({ pressed }) => [styles.googleButton, pressed && styles.googlePressed]}
            accessibilityRole="button"
            accessibilityLabel={t("auth.google")}
          >
            <Ionicons name="logo-google" size={18} color={colors.textPrimary} />
            <Text style={styles.googleText}>{t("auth.google")}</Text>
          </Pressable>
        </>
      )}

      {/* Below the buttons, not beside the password field: it's a recovery
          path, not part of signing in, and it should be findable without
          competing with the thing most people are here to do. */}
      <Pressable
        style={styles.forgotButton}
        onPress={() => setForgotOpen(true)}
        disabled={busy}
        hitSlop={8}
      >
        <Text style={styles.forgotText}>{t("auth.forgot")}</Text>
      </Pressable>

      <Pressable
        style={styles.guestButton}
        onPress={continueAsGuest}
        disabled={busy}
      >
        <Text style={styles.guestButtonText}>{t("auth.continueAsGuest")}</Text>
      </Pressable>

      <ForgotPasswordSheet
        visible={forgotOpen}
        initialEmail={email}
        onClose={() => setForgotOpen(false)}
        onDone={(text) => {
          setIsError(false);
          setMessage(text);
          router.replace("/(tabs)");
        }}
      />
      <Text style={styles.guestNote}>
        {t("auth.guestNote", { stores: storeListPhrase() })}
      </Text>
    </ScrollView>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    container: {
      // flexGrow, not flex: the column still centres when it fits, but is free
      // to grow taller than the viewport and scroll once the keyboard is up.
      flexGrow: 1,
      justifyContent: "center",
      padding: spacing.xl,
      gap: spacing.sm,
    },
    title: {
      color: colors.accent,
      fontSize: 44,
      fontWeight: "900",
      textAlign: "center",
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: type.body.fontSize,
      textAlign: "center",
      marginBottom: spacing.lg,
    },
    confirmIcon: {
      alignSelf: "center",
      width: 60,
      height: 60,
      borderRadius: 30,
      backgroundColor: colors.accentMuted,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: spacing.sm,
    },
    confirmAuto: {
      color: colors.textSecondary,
      fontSize: type.caption.fontSize,
      textAlign: "center",
      marginBottom: spacing.sm,
    },
    confirmSpam: {
      color: colors.textTertiary,
      fontSize: type.caption.fontSize,
      textAlign: "center",
      marginTop: spacing.xs,
    },
    resuming: {
      color: colors.textSecondary,
      fontSize: type.label.fontSize,
      lineHeight: 19,
      textAlign: "center",
      marginBottom: spacing.xs,
    },
    suggestion: { paddingHorizontal: spacing.xs, marginTop: -spacing.xs },
    suggestionText: { color: colors.textSecondary, fontSize: type.caption.fontSize },
    suggestionEmail: { color: colors.accent, fontWeight: "700" },
    input: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      borderRadius: radius.md,
      padding: spacing.md,
      color: colors.textPrimary,
      fontSize: 16,
    },
    confirmHeading: {
      color: colors.textPrimary,
      fontSize: type.title.fontSize,
      fontWeight: "800",
      textAlign: "center",
    },
    confirmBody: {
      color: colors.textPrimary,
      fontSize: type.body.fontSize,
      lineHeight: 20,
      textAlign: "center",
      fontWeight: "600",
    },
    message: {
      color: colors.danger,
      fontSize: type.label.fontSize,
      textAlign: "center",
      paddingVertical: spacing.xs,
    },
    messageOk: { color: colors.success },
    orRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      marginVertical: spacing.sm,
    },
    orLine: { flex: 1, height: 1, backgroundColor: colors.surfaceBorder },
    orText: { color: colors.textTertiary, fontSize: type.caption.fontSize },
    // Outlined rather than filled. Google's own guidance is a neutral button,
    // and a second orange button would compete with Sign up for the eye.
    googleButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.sm,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      paddingVertical: 14,
    },
    googlePressed: { opacity: 0.7 },
    googleText: {
      color: colors.textPrimary,
      fontSize: type.body.fontSize,
      fontWeight: "700",
    },
    forgotButton: { paddingVertical: spacing.sm, alignItems: "center" },
    forgotText: {
      color: colors.textSecondary,
      fontSize: type.label.fontSize,
      fontWeight: "600",
    },
    guestButton: { paddingVertical: spacing.sm, alignItems: "center" },
    guestButtonText: {
      color: colors.textSecondary,
      fontSize: type.label.fontSize,
      textDecorationLine: "underline",
    },
    guestNote: {
      color: colors.textTertiary,
      fontSize: type.caption.fontSize,
      textAlign: "center",
      lineHeight: 15,
    },
  });
