import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowRight, KeyRound, Mail, MessageCircleMore, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { toast } from "sonner";

import { BrandLockup, BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";

const search = z.object({ next: z.string().optional() });

export const Route = createFileRoute("/auth")({
  validateSearch: search,
  head: () => ({
    meta: [
      { title: "Connexion — JorgardeMail" },
      {
        name: "description",
        content: "Accédez à votre espace JorgardeMail.",
      },
    ],
  }),
  component: AuthPage,
});

// Deterministic synthetic email so Supabase Auth (which requires an email)
// can key off the username without ever asking the user for one.
const USERNAME_EMAIL_SUFFIX = "@users.jorgardemail.local";
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/;

function usernameToEmail(username: string) {
  return username.trim().toLowerCase() + USERNAME_EMAIL_SUFFIX;
}

function AuthPage() {
  const { next } = useSearch({ from: "/auth" });
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [jellyfinUsername, setJellyfinUsername] = useState("");
  const [jellyfinPassword, setJellyfinPassword] = useState("");
  const [mailPassword, setMailPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const guestSignIn = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/public/guest", { method: "POST" });
      const result = (await response.json().catch(() => null)) as {
        username?: unknown;
        password?: unknown;
        cleanup_secret?: unknown;
      } | null;
      if (
        !response.ok ||
        typeof result?.username !== "string" ||
        typeof result.password !== "string" ||
        typeof result.cleanup_secret !== "string"
      ) {
        throw new Error(
          response.status === 429
            ? "Trop de comptes invités créés. Réessayez plus tard."
            : "Le mode invité est indisponible pour le moment.",
        );
      }
      sessionStorage.setItem("jorgardemail.guest.cleanup", result.cleanup_secret);
      await completeSignIn(result.username, result.password);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Connexion invitée impossible");
    } finally {
      setBusy(false);
    }
  };

  const unsafeNextCharacter = next
    ? [...next].some((character) => {
        const code = character.charCodeAt(0);
        return character === "\\" || code < 32 || code === 127;
      })
    : true;
  const safeNext =
    next?.startsWith("/") && !next.startsWith("//") && !unsafeNextCharacter ? next : "/all";

  const completeSignIn = async (uname: string, submittedPassword: string) => {
    const email = usernameToEmail(uname);
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password: submittedPassword,
    });
    if (error || !data.session) throw new Error("Identifiant ou mot de passe incorrect");

    // AuthProvider lives above both the auth and protected route trees, so it
    // receives SIGNED_IN before this transition and the guard cannot redirect
    // the successful first attempt back to this form.
    await navigate({ to: safeNext, replace: true });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const uname = username.trim().toLowerCase();
    if (!USERNAME_RE.test(uname)) {
      toast.error("L’identifiant doit contenir 3 à 24 caractères : lettres, chiffres, _ ou -");
      return;
    }
    if (password.length < 6) {
      toast.error("Le mot de passe doit contenir au moins 6 caractères");
      return;
    }

    setBusy(true);
    try {
      await completeSignIn(uname, password);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Une erreur est survenue");
    } finally {
      setBusy(false);
    }
  };

  const register = async (event: React.FormEvent) => {
    event.preventDefault();
    const exactJellyfinName = jellyfinUsername.trim();
    if (!exactJellyfinName || exactJellyfinName.length > 128) {
      toast.error("Saisissez votre identifiant Jellyfin (128 caractères maximum)");
      return;
    }
    if (jellyfinPassword.length > 128) {
      toast.error("Le mot de passe Jellyfin ne peut pas dépasser 128 caractères");
      return;
    }
    if (mailPassword.length < 12 || mailPassword.length > 128) {
      toast.error("Le mot de passe JorgardeMail doit contenir 12 à 128 caractères");
      return;
    }
    if (mailPassword !== confirmPassword) {
      toast.error("Les mots de passe JorgardeMail ne correspondent pas");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/public/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jellyfinUsername: exactJellyfinName,
          jellyfinPassword,
          mailPassword,
        }),
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: unknown;
        username?: unknown;
      } | null;
      if (!response.ok) {
        throw new Error(
          response.status === 429
            ? "Trop de tentatives. Patientez 15 minutes avant de réessayer."
            : "Inscription impossible. Vérifiez votre identifiant et votre mot de passe Jellyfin.",
        );
      }
      const internalUsername =
        typeof result?.username === "string" ? result.username.toLowerCase() : "";
      if (!USERNAME_RE.test(internalUsername)) {
        throw new Error("Le compte a été créé, mais son identifiant interne est invalide");
      }

      // Clear both credentials from React state before the new, separate mail
      // credential is used once to establish the initial session.
      const newMailPassword = mailPassword;
      setJellyfinPassword("");
      setMailPassword("");
      setConfirmPassword("");
      try {
        await completeSignIn(internalUsername, newMailPassword);
      } catch {
        setMode("signin");
        setUsername(internalUsername);
        setPassword("");
        toast.success(`Compte créé. Votre identifiant JorgardeMail est @${internalUsername}.`);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "L’inscription n’a pas pu être finalisée",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell dark grid min-h-screen lg:grid-cols-[minmax(0,1.08fr)_minmax(30rem,0.92fr)]">
      <div
        aria-hidden
        className="auth-orb -left-32 top-[15%] size-[28rem] border border-primary/15 bg-primary/5"
      />
      <div
        aria-hidden
        className="auth-orb -bottom-40 right-[18%] size-[32rem] border border-brand-secondary/10 bg-brand-secondary/5 [animation-delay:-7s]"
      />

      <section className="relative hidden min-h-screen flex-col justify-between overflow-hidden p-12 lg:flex xl:p-16">
        <BrandLockup />

        <div className="relative z-10 max-w-[44rem] py-12">
          <div className="premium-badge">
            <Sparkles className="size-3.5" /> Une nouvelle façon de communiquer
          </div>
          <h1 className="mt-7 max-w-2xl font-display text-[clamp(3.6rem,6.4vw,6.8rem)] leading-[0.86] tracking-[-0.078em] text-white">
            Votre messagerie. <span className="text-gold">Sans compromis.</span>
          </h1>
          <p className="mt-7 max-w-xl text-base leading-7 text-muted-foreground xl:text-lg xl:leading-8">
            E-mails et conversations réunis dans une expérience rapide, élégante et pensée pour
            rester agréable chaque jour.
          </p>

          <div className="auth-showcase mt-10 max-w-2xl rounded-[1.65rem] p-3">
            <div className="flex items-center justify-between px-3 pb-3 pt-1">
              <div>
                <div className="text-[0.66rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  Aperçu
                </div>
                <div className="mt-1 font-display text-lg text-white">Boîte de réception</div>
              </div>
              <div className="flex items-center gap-2 rounded-full border border-emerald-300/15 bg-emerald-300/8 px-2.5 py-1 text-[0.65rem] font-semibold text-emerald-200">
                <span className="size-1.5 rounded-full bg-emerald-300 shadow-[0_0_12px_#6ee7b7]" />À
                jour
              </div>
            </div>
            <div className="space-y-1.5">
              {[
                ["A", "Alexandre", "Les nouveaux visuels sont prêts", "Maintenant"],
                ["M", "Mélanie", "On se retrouve à 19 h ?", "12 min"],
                ["J", "Jorgarde", "Votre récapitulatif de la semaine", "Hier"],
              ].map(([initial, sender, subject, time], index) => (
                <div
                  key={sender}
                  className={`auth-showcase-row flex items-center gap-3 rounded-2xl px-3.5 py-3 ${index === 0 ? "is-highlighted" : ""}`}
                >
                  <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.06] text-xs font-bold text-white ring-1 ring-white/8">
                    {initial}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-semibold text-white">{sender}</span>
                      {index === 0 && <span className="size-1.5 rounded-full bg-brand-secondary" />}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">{subject}</div>
                  </div>
                  <span className="text-[0.65rem] text-muted-foreground">{time}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {[
              { icon: Mail, label: "E-mails" },
              { icon: MessageCircleMore, label: "Messages directs" },
              { icon: KeyRound, label: "Accès Jellyfin" },
            ].map(({ icon: Icon, label }) => (
              <div key={label} className="auth-capability">
                <Icon className="size-3.5 text-brand-secondary" /> {label}
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="signal-dot size-1.5 rounded-full" />
          Service disponible · accès protégé par WireGuard
        </div>
      </section>

      <section className="relative flex min-h-screen items-center justify-center overflow-y-auto px-4 py-8 sm:px-8 lg:border-l lg:border-border lg:bg-black/10">
        <div className="w-full max-w-[31rem]">
          <div className="mb-7 flex justify-center lg:hidden">
            <BrandLockup />
          </div>

          <div className="auth-card jm-fade-up rounded-[1.75rem] p-6 sm:p-9">
            <div className="flex items-start justify-between gap-5">
              <div>
                <div className="page-eyebrow before:hidden">
                  {mode === "signin" ? "Accès sécurisé" : "Inscription vérifiée"}
                </div>
                <h2 className="font-display text-3xl text-foreground sm:text-4xl">
                  {mode === "signin" ? "Heureux de vous revoir" : "Créer votre accès"}
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {mode === "signin"
                    ? "Retrouvez votre messagerie et vos conversations."
                    : "Confirmez votre compte Jellyfin puis choisissez un mot de passe dédié."}
                </p>
              </div>
              <BrandMark className="hidden size-12 sm:block" />
            </div>

            <Tabs
              value={mode}
              onValueChange={(value) => setMode(value as "signin" | "register")}
              className="mt-7"
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="signin" disabled={busy}>
                  Connexion
                </TabsTrigger>
                <TabsTrigger value="register" disabled={busy}>
                  Inscription
                </TabsTrigger>
              </TabsList>
            </Tabs>

            <Button
              type="button"
              variant="outline"
              disabled={busy}
              className="mt-3 w-full border-brand-secondary/20 bg-brand-secondary/[0.05]"
              onClick={() => void guestSignIn()}
            >
              Essayer en invité · 3 adresses pendant 1 heure
            </Button>

            {mode === "signin" ? (
              <form onSubmit={submit} className="mt-6 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="signin-username">Identifiant</Label>
                  <Input
                    id="signin-username"
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    autoComplete="username"
                    required
                    minLength={3}
                    maxLength={24}
                    value={username}
                    onChange={(event) => setUsername(event.target.value.toLowerCase())}
                    placeholder="votre identifiant"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signin-password">Mot de passe</Label>
                  <Input
                    id="signin-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    minLength={6}
                    maxLength={128}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </div>
                <Button type="submit" disabled={busy} className="bg-gold mt-2 w-full text-white">
                  {busy ? (
                    <>
                      <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white motion-reduce:animate-none" />
                      Connexion…
                    </>
                  ) : (
                    <>
                      Accéder à JorgardeMail <ArrowRight />
                    </>
                  )}
                </Button>
              </form>
            ) : (
              <form onSubmit={register} className="mt-6 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="register-jellyfin-name">Identifiant Jellyfin</Label>
                    <Input
                      id="register-jellyfin-name"
                      autoFocus
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      autoComplete="username"
                      required
                      maxLength={128}
                      value={jellyfinUsername}
                      onChange={(event) => setJellyfinUsername(event.target.value)}
                      placeholder="Nom exact du compte"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="register-jellyfin-password">Mot de passe Jellyfin</Label>
                    <Input
                      id="register-jellyfin-password"
                      type="password"
                      autoComplete="current-password"
                      maxLength={128}
                      value={jellyfinPassword}
                      onChange={(event) => setJellyfinPassword(event.target.value)}
                      placeholder="Peut être vide"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="register-mail-password">Nouveau mot de passe JorgardeMail</Label>
                  <Input
                    id="register-mail-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                    value={mailPassword}
                    onChange={(event) => setMailPassword(event.target.value)}
                    placeholder="12 caractères minimum"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="register-confirm-password">Confirmer le mot de passe</Label>
                  <Input
                    id="register-confirm-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                  />
                </div>
                <Button type="submit" disabled={busy} className="bg-gold mt-2 w-full text-white">
                  {busy ? (
                    <>
                      <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white motion-reduce:animate-none" />
                      Vérification…
                    </>
                  ) : (
                    <>
                      Vérifier et créer le compte <ArrowRight />
                    </>
                  )}
                </Button>
              </form>
            )}

            <div className="mt-6 flex gap-3 rounded-2xl border border-border bg-black/15 p-3.5 text-xs leading-5 text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand-secondary" />
              <p>
                {mode === "register"
                  ? "Votre mot de passe Jellyfin est vérifié une seule fois et n’est jamais conservé."
                  : "Votre session reste réservée aux membres autorisés de votre espace JorgardeMail."}
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
