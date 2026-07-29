import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

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
    <div className="dark min-h-screen bg-background flex items-center justify-center px-4 relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(60% 40% at 50% 0%, oklch(0.78 0.13 78 / 0.12), transparent 70%), radial-gradient(50% 50% at 100% 100%, oklch(0.78 0.13 78 / 0.06), transparent 70%)",
        }}
      />
      <div className="w-full max-w-md noir-panel rounded-2xl p-8 jm-fade-up relative glow-gold">
        <h1 className="font-display text-5xl text-gold text-center tracking-tight">JorgardeMail</h1>

        <div className="mt-5 grid grid-cols-2 rounded-lg bg-muted p-1" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "signin"}
            className={`rounded-md px-3 py-2 text-sm transition-colors ${
              mode === "signin" ? "bg-background text-gold" : "text-muted-foreground"
            }`}
            onClick={() => setMode("signin")}
            disabled={busy}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            className={`rounded-md px-3 py-2 text-sm transition-colors ${
              mode === "register" ? "bg-background text-gold" : "text-muted-foreground"
            }`}
            onClick={() => setMode("register")}
            disabled={busy}
          >
            Register
          </button>
        </div>

        {mode === "signin" ? (
          <form onSubmit={submit} className="mt-4 space-y-3">
            <div>
              <Label>Username</Label>
              <Input
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
                placeholder="jane"
              />
            </div>
            <div>
              <Label>Password</Label>
              <Input
                type="password"
                autoComplete="current-password"
                required
                minLength={6}
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <Button
              type="submit"
              disabled={busy}
              className="w-full bg-gold text-background hover:opacity-90 transition-all"
            >
              {busy ? "…" : "Sign in"}
            </Button>
          </form>
        ) : (
          <form onSubmit={register} className="mt-4 space-y-3">
            <div>
              <Label>Jellyfin username</Label>
              <Input
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
                placeholder="Exact Jellyfin name"
              />
            </div>
            <div>
              <Label>Jellyfin password</Label>
              <Input
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
                value={jellyfinPassword}
                onChange={(event) => setJellyfinPassword(event.target.value)}
              />
            </div>
            <div>
              <Label>New JorgardeMail password</Label>
              <Input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={mailPassword}
                onChange={(event) => setMailPassword(event.target.value)}
              />
            </div>
            <div>
              <Label>Confirm JorgardeMail password</Label>
              <Input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </div>
            <Button
              type="submit"
              disabled={busy}
              className="w-full bg-gold text-background hover:opacity-90 transition-all"
            >
              {busy ? "…" : "Verify Jellyfin & register"}
            </Button>
          </form>
        )}

        <p className="text-[11px] text-muted-foreground text-center mt-5">
          {mode === "register"
            ? "Your Jellyfin password is verified once and never stored. The API key and user list never leave the server; choose a separate mail password."
            : "Sign in with your JorgardeMail username and password."}
        </p>
      </div>
    </div>
  );
}
