import { createFileRoute, useSearch } from "@tanstack/react-router";
import { ArrowRight, KeyRound, MessageCircleMore, Radio, ShieldCheck } from "lucide-react";
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
      { title: "Sign in — JorgardeMail" },
      {
        name: "description",
        content: "Sign in to JorgardeMail with just a username and password.",
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
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [jellyfinUsername, setJellyfinUsername] = useState("");
  const [jellyfinPassword, setJellyfinPassword] = useState("");
  const [mailPassword, setMailPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const safeNext = next?.startsWith("/") && !next.startsWith("//") ? next : "/all";

  const completeSignIn = async (uname: string, submittedPassword: string) => {
    const email = usernameToEmail(uname);
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password: submittedPassword,
    });
    if (error || !data.session) throw new Error("Invalid username or password");

    // The auth provider lives inside the protected route tree. A client-side
    // transition can therefore mount a fresh provider before it observes the
    // session written by signInWithPassword, leaving the user on this page
    // until a second submit. Reloading the protected route initializes auth
    // from the now-persisted session and makes the first submit deterministic.
    window.location.replace(safeNext);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const uname = username.trim().toLowerCase();
    if (!USERNAME_RE.test(uname)) {
      toast.error("Username must be 3–24 chars: letters, digits, _ or -");
      return;
    }
    if (password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }

    setBusy(true);
    try {
      await completeSignIn(uname, password);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const register = async (event: React.FormEvent) => {
    event.preventDefault();
    const exactJellyfinName = jellyfinUsername.trim();
    const uname = exactJellyfinName.toLowerCase();
    if (!USERNAME_RE.test(uname)) {
      toast.error("Jellyfin username must be 3–24 chars: letters, digits, _ or -");
      return;
    }
    if (!jellyfinPassword || jellyfinPassword.length > 128) {
      toast.error("Enter your Jellyfin password");
      return;
    }
    if (mailPassword.length < 12 || mailPassword.length > 128) {
      toast.error("JorgardeMail password must be 12–128 characters");
      return;
    }
    if (mailPassword !== confirmPassword) {
      toast.error("JorgardeMail passwords do not match");
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
      if (!response.ok) {
        throw new Error(
          response.status === 429
            ? "Too many registration attempts. Wait 15 minutes and try again."
            : "Registration could not be completed. Check your Jellyfin name and password.",
        );
      }

      // Clear both credentials from React state before the new, separate mail
      // credential is used once to establish the initial session.
      const newMailPassword = mailPassword;
      setJellyfinPassword("");
      setMailPassword("");
      setConfirmPassword("");
      try {
        await completeSignIn(uname, newMailPassword);
      } catch {
        setMode("signin");
        setUsername(uname);
        setPassword("");
        toast.success("Account created. Sign in with your new JorgardeMail password.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Registration could not be completed");
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

        <div className="relative z-10 max-w-2xl py-16">
          <div className="premium-badge">
            <Radio className="size-3.5" /> Local-first communications
          </div>
          <h1 className="mt-7 max-w-xl font-display text-[clamp(3.4rem,6vw,6.4rem)] leading-[0.88] tracking-[-0.075em] text-white">
            Your private inbox, <span className="text-gold">reimagined.</span>
          </h1>
          <p className="mt-7 max-w-lg text-base leading-7 text-muted-foreground xl:text-lg xl:leading-8">
            Internet mail at the edge. Direct conversations on your own node. Nothing important
            needs to leave your infrastructure.
          </p>

          <div className="mt-10 grid max-w-xl gap-3 sm:grid-cols-3">
            {[
              {
                icon: ShieldCheck,
                title: "Self-hosted",
                detail: "Your server, your data",
              },
              {
                icon: MessageCircleMore,
                title: "Private DMs",
                detail: "Local conversations",
              },
              {
                icon: KeyRound,
                title: "Jellyfin gated",
                detail: "Verified membership",
              },
            ].map(({ icon: Icon, title, detail }) => (
              <div key={title} className="auth-feature rounded-2xl p-4">
                <Icon className="size-5 text-brand-secondary" />
                <div className="mt-4 text-sm font-semibold text-foreground">{title}</div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="signal-dot size-1.5 rounded-full" />
          Private node online · encrypted transport through WireGuard
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
                  {mode === "signin" ? "Secure access" : "Verified registration"}
                </div>
                <h2 className="font-display text-3xl text-foreground sm:text-4xl">
                  {mode === "signin" ? "Welcome back" : "Join the node"}
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {mode === "signin"
                    ? "Enter your local JorgardeMail credentials."
                    : "Confirm your Jellyfin identity, then create a separate mail password."}
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
                  Sign in
                </TabsTrigger>
                <TabsTrigger value="register" disabled={busy}>
                  Register
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {mode === "signin" ? (
              <form onSubmit={submit} className="mt-6 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="signin-username">Username</Label>
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
                    placeholder="yourname"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signin-password">Password</Label>
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
                      Signing in
                    </>
                  ) : (
                    <>
                      Enter workspace <ArrowRight />
                    </>
                  )}
                </Button>
              </form>
            ) : (
              <form onSubmit={register} className="mt-6 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="register-jellyfin-name">Jellyfin username</Label>
                    <Input
                      id="register-jellyfin-name"
                      autoFocus
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      autoComplete="username"
                      required
                      minLength={3}
                      maxLength={24}
                      value={jellyfinUsername}
                      onChange={(event) => setJellyfinUsername(event.target.value)}
                      placeholder="Exact account name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="register-jellyfin-password">Jellyfin password</Label>
                    <Input
                      id="register-jellyfin-password"
                      type="password"
                      autoComplete="current-password"
                      required
                      maxLength={128}
                      value={jellyfinPassword}
                      onChange={(event) => setJellyfinPassword(event.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="register-mail-password">New JorgardeMail password</Label>
                  <Input
                    id="register-mail-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                    value={mailPassword}
                    onChange={(event) => setMailPassword(event.target.value)}
                    placeholder="12 characters minimum"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="register-confirm-password">Confirm mail password</Label>
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
                      Verifying identity
                    </>
                  ) : (
                    <>
                      Verify & create account <ArrowRight />
                    </>
                  )}
                </Button>
              </form>
            )}

            <div className="mt-6 flex gap-3 rounded-2xl border border-border bg-black/15 p-3.5 text-xs leading-5 text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand-secondary" />
              <p>
                {mode === "register"
                  ? "Your Jellyfin password is checked once and never stored. The API key and private user list stay on this server."
                  : "Authentication happens against your private JorgardeMail server. No social login or tracking scripts."}
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
