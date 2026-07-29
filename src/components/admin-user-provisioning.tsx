import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createLocalUser, resetLocalUserPassword } from "@/lib/admin-users.functions";
import { copyText } from "@/lib/copy-text";

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%_-";

function generatePassword(length = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]).join("");
}

export function AdminUserProvisioning({ onCreated }: { onCreated: () => void }) {
  const createUser = useServerFn(createLocalUser);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);

  useEffect(() => setPassword(generatePassword()), []);

  const mutation = useMutation({
    mutationFn: () =>
      createUser({
        data: {
          username: username.trim().toLowerCase(),
          displayName: displayName.trim() || undefined,
          password,
        },
      }),
    onSuccess: (result) => {
      setCreated({ username: result.username, password });
      setUsername("");
      setDisplayName("");
      setPassword(generatePassword());
      onCreated();
      toast.success(`Created @${result.username}`);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "User creation failed"),
  });

  return (
    <div className="noir-panel rounded-xl p-5 space-y-4">
      <div>
        <h2 className="font-display text-xl text-gold">Create a local account</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Public signup is disabled. Create your friend's account here and share the one-time
          password securely.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="new-local-username">Username</Label>
          <Input
            id="new-local-username"
            autoCapitalize="none"
            autoCorrect="off"
            value={username}
            onChange={(event) => setUsername(event.target.value.toLowerCase())}
            placeholder="friend"
          />
        </div>
        <div>
          <Label htmlFor="new-local-display-name">Display name</Label>
          <Input
            id="new-local-display-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Optional"
          />
        </div>
      </div>
      <div>
        <Label htmlFor="new-local-password">Initial password</Label>
        <div className="flex gap-2">
          <Input
            id="new-local-password"
            type="text"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button type="button" variant="outline" onClick={() => setPassword(generatePassword())}>
            Regenerate
          </Button>
        </div>
      </div>
      <Button
        type="button"
        className="bg-gold text-background"
        disabled={!username.trim() || password.length < 12 || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? "Creating…" : "Create user"}
      </Button>

      {created && (
        <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 text-sm">
          <div className="font-medium text-amber-300">Copy these credentials now</div>
          <div className="font-mono mt-1 break-all">
            @{created.username} / {created.password}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={async () => {
              try {
                await copyText(`@${created.username}\n${created.password}`);
                toast.success("Credentials copied");
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Copy failed");
              }
            }}
          >
            Copy credentials
          </Button>
        </div>
      )}
    </div>
  );
}

export function ResetUserPassword({ userId, username }: { userId: string; username: string }) {
  const resetPassword = useServerFn(resetLocalUserPassword);
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () => resetPassword({ data: { userId, password } }),
    onSuccess: () => {
      toast.success(`Password reset for @${username}`);
      setPassword("");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Password reset failed"),
  });

  return (
    <details className="w-full text-xs">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        Reset password
      </summary>
      <div className="mt-2 flex gap-2">
        <Input
          type="text"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="New password (12+ characters)"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setPassword(generatePassword())}
        >
          Generate
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={password.length < 12 || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Set
        </Button>
      </div>
    </details>
  );
}
