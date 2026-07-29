import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
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

function usernameToEmail(u: string) {
  return u.trim().toLowerCase() + USERNAME_EMAIL_SUFFIX;
}

function AuthPage() {
  const { next } = useSearch({ from: "/auth" });
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
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
      const email = usernameToEmail(uname);
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new Error("Invalid username or password");
      const safeNext = next?.startsWith("/") && !next.startsWith("//") ? next : "/all";
      navigate({ to: safeNext });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
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

        <form onSubmit={submit} className="mt-5 space-y-3">
          <div>
            <Label>Username</Label>
            <Input
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              minLength={3}
              maxLength={24}
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              placeholder="jane"
            />
          </div>
          <div>
            <Label>Password</Label>
            <Input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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

        <p className="text-[11px] text-muted-foreground text-center mt-5">
          Accounts are created by your server administrator. No third-party sign-in.
        </p>
      </div>
    </div>
  );
}
