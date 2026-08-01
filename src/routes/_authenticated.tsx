import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Inbox,
  KeyRound,
  LogOut,
  Mail,
  Menu,
  MessageSquare,
  Plus,
  Radio,
  Settings,
  Shield,
  SquarePen,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { BrandLockup, BrandMark } from "@/components/brand-mark";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated")({
  component: AuthedShell,
});

function AuthedShell() {
  return <Guard />;
}

function Guard() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth", search: { next: pathname } });
  }, [loading, session, navigate, pathname]);

  if (loading || !session) {
    return (
      <div className="auth-shell dark flex min-h-screen items-center justify-center">
        <div className="jm-fade-up flex flex-col items-center gap-4 text-sm text-muted-foreground">
          <div className="relative">
            <div className="absolute inset-0 rounded-2xl bg-primary/30 blur-xl" />
            <BrandMark className="relative size-14" />
          </div>
          <div className="flex items-center gap-2">
            <span className="signal-dot size-1.5 rounded-full" />
            Ouverture de votre espace…
          </div>
        </div>
      </div>
    );
  }
  return <Shell />;
}

function Shell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const routeKey = useRouterState({
    select: (state) => state.resolvedLocation?.pathname ?? state.location.pathname,
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  const { data: profile, error: profileError } = useQuery({
    queryKey: ["profile", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_my_profile");
      if (error) throw error;
      return data;
    },
    refetchInterval: 15_000,
  });

  useEffect(() => {
    if ((profileError as { code?: string } | null)?.code !== "42501") return;
    void supabase.auth.signOut({ scope: "local" });
    toast.error("Votre accès à JorgardeMail a été suspendu");
    navigate({ to: "/auth" });
  }, [navigate, profileError]);

  const { data: isAdmin } = useQuery({
    queryKey: ["is-admin", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user!.id)
        .eq("role", "admin")
        .maybeSingle();
      return !!data;
    },
  });

  const { data: mailboxes } = useQuery({
    queryKey: ["mailboxes", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from("mailboxes")
        .select("id, local_part, is_temp, expires_at, domain:domains(name)")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const { data: dmUnread } = useQuery({
    queryKey: ["dm-unread", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("dms")
        .select("id", { count: "exact", head: true })
        .eq("recipient_id", user!.id)
        .is("seen_at", null);
      if (error) throw error;
      return count ?? 0;
    },
    refetchInterval: 10000,
  });

  const { data: unreadByMailbox = {} } = useQuery({
    queryKey: ["mail-unread-by-mailbox", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("mailbox_id")
        .eq("folder", "inbox")
        .eq("seen", false)
        .limit(10_000);
      if (error) throw error;
      return (data ?? []).reduce<Record<string, number>>((counts, message) => {
        counts[message.mailbox_id] = (counts[message.mailbox_id] ?? 0) + 1;
        return counts;
      }, {});
    },
    refetchInterval: 10000,
  });

  const unreadMail = Object.values(unreadByMailbox).reduce((total, count) => total + count, 0);
  useNotificationFavicon(unreadMail + (dmUnread ?? 0));
  const isGuest = profile?.account_kind === "guest";

  const signOut = async () => {
    const cleanupSecret = sessionStorage.getItem("jorgardemail.guest.cleanup");
    if (isGuest && cleanupSecret) {
      await fetch("/api/public/guest-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "end", secret: cleanupSecret }),
      }).catch(() => undefined);
      sessionStorage.removeItem("jorgardemail.guest.cleanup");
    }
    await supabase.auth.signOut({ scope: "local" });
    toast.success("Vous êtes déconnecté");
    navigate({ to: "/auth" });
  };

  useEffect(() => {
    if (!isGuest) return;
    const secret = sessionStorage.getItem("jorgardemail.guest.cleanup");
    if (!secret) return;
    const command = (action: "heartbeat" | "close") => JSON.stringify({ action, secret });
    const heartbeat = () =>
      void fetch("/api/public/guest-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: command("heartbeat"),
        keepalive: true,
      });
    const close = () => {
      navigator.sendBeacon(
        "/api/public/guest-session",
        new Blob([command("close")], { type: "application/json" }),
      );
    };
    heartbeat();
    const heartbeatTimer = window.setInterval(heartbeat, 45_000);
    const expiryDelay = profile?.guest_expires_at
      ? Math.max(0, Date.parse(profile.guest_expires_at) - Date.now())
      : 60 * 60_000;
    const expiryTimer = window.setTimeout(
      () => {
        sessionStorage.removeItem("jorgardemail.guest.cleanup");
        void supabase.auth.signOut({ scope: "local" });
        navigate({ to: "/auth" });
      },
      Math.min(expiryDelay + 1_000, 2_147_000_000),
    );
    window.addEventListener("pagehide", close);
    return () => {
      window.clearInterval(heartbeatTimer);
      window.clearTimeout(expiryTimer);
      window.removeEventListener("pagehide", close);
    };
  }, [isGuest, navigate, profile?.guest_expires_at]);

  return (
    <div className="app-shell dark min-h-screen text-foreground md:grid md:grid-cols-[284px_minmax(0,1fr)]">
      {mobileOpen && (
        <button
          type="button"
          aria-label="Fermer la navigation"
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={`app-sidebar fixed inset-y-0 left-0 z-50 flex w-[284px] flex-col border-r border-sidebar-border p-3 transition-transform duration-200 ease-out md:sticky md:top-0 md:z-auto md:h-screen md:w-auto md:translate-x-0 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="px-2 pb-4 pt-2">
          <div className="flex items-center justify-between gap-3">
            <Link
              to="/all"
              onClick={() => setMobileOpen(false)}
              aria-label="Boîte de réception JorgardeMail"
            >
              <BrandLockup />
            </Link>
            <button
              type="button"
              aria-label="Fermer la navigation"
              className="grid size-10 place-items-center rounded-xl text-muted-foreground hover:bg-sidebar-accent hover:text-foreground md:hidden"
              onClick={() => setMobileOpen(false)}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="mx-1 mb-4 h-px bg-gradient-to-r from-transparent via-sidebar-border to-transparent" />

        {!isGuest && (
          <div className="px-1 pb-5">
            <Link
              to="/compose"
              onClick={() => setMobileOpen(false)}
              className="compose-cta flex min-h-12 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-bold text-white"
            >
              <SquarePen className="size-4" /> Nouveau message
            </Link>
          </div>
        )}

        <nav className="flex-1 space-y-1 overflow-y-auto px-1 text-sm">
          <div className="mb-2 px-3 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-muted-foreground/70">
            Messagerie
          </div>
          <NavItem
            to="/all"
            icon={<Inbox size={16} />}
            badge={unreadMail || undefined}
            onNavigate={() => setMobileOpen(false)}
          >
            Boîte de réception
          </NavItem>
          {!isGuest && (
            <NavItem
              to="/dm"
              icon={<MessageSquare size={16} />}
              badge={dmUnread || undefined}
              onNavigate={() => setMobileOpen(false)}
            >
              Messages directs
            </NavItem>
          )}

          {(profile?.api_access || isAdmin) && !isGuest && (
            <NavItem
              to="/api-access"
              icon={<KeyRound size={16} />}
              onNavigate={() => setMobileOpen(false)}
            >
              API développeur
            </NavItem>
          )}

          <div className="mb-1 mt-6 flex items-center justify-between px-3 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-muted-foreground/70">
            <span>Mes adresses</span>
            {!isGuest && (
              <Link
                to="/mailboxes"
                aria-label="Créer une adresse"
                className="grid size-7 place-items-center rounded-lg text-gold hover:bg-sidebar-accent hover:text-foreground"
              >
                <Plus size={14} />
              </Link>
            )}
          </div>
          {(mailboxes ?? []).slice(0, 20).map((mailbox) => (
            <NavItem
              key={mailbox.id}
              to="/m/$id"
              params={{ id: mailbox.id }}
              icon={<Mail size={14} />}
              badge={unreadByMailbox[mailbox.id] || undefined}
              onNavigate={() => setMobileOpen(false)}
            >
              <span className="truncate">
                {mailbox.local_part}@{mailbox.domain?.name}
              </span>
              {mailbox.is_temp && (
                <span className="ml-auto rounded-full border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-wide text-gold">
                  éphémère
                </span>
              )}
            </NavItem>
          ))}
          {!isGuest && mailboxes && mailboxes.length === 0 && (
            <Link to="/mailboxes" className="nav-item text-muted-foreground">
              + Créer votre première adresse
            </Link>
          )}
        </nav>

        <div className="mt-3 space-y-1 border-t border-sidebar-border px-1 pt-3 text-sm">
          {!isGuest && (
            <NavItem
              to="/mailboxes"
              icon={<Settings size={16} />}
              onNavigate={() => setMobileOpen(false)}
            >
              Gérer les adresses
            </NavItem>
          )}
          <NavItem
            to="/settings"
            icon={<UserRound size={16} />}
            onNavigate={() => setMobileOpen(false)}
          >
            Préférences
          </NavItem>
          {isAdmin && (
            <NavItem
              to="/admin"
              icon={<Shield size={16} />}
              onNavigate={() => setMobileOpen(false)}
            >
              Administration
            </NavItem>
          )}
          <button onClick={signOut} className="nav-item w-full text-left text-muted-foreground">
            <LogOut size={16} /> Se déconnecter
          </button>

          <div className="profile-chip mt-3 flex items-center gap-3 rounded-2xl p-3">
            <div className="relative grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand/80 to-brand-secondary/70 font-display font-bold text-white shadow-lg">
              {(profile?.username ?? "?")[0]?.toUpperCase()}
              <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-sidebar bg-emerald-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">
                {profile?.display_name || profile?.username || "Utilisateur"}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                @{profile?.username ?? "connexion"}
              </div>
            </div>
            <Radio
              className="size-4 shrink-0 text-brand-secondary"
              aria-label="Service disponible"
            />
          </div>
        </div>
      </aside>

      <main className="app-main min-h-screen overflow-x-hidden">
        <div className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/75 px-4 backdrop-blur-xl md:hidden">
          <button
            type="button"
            aria-label="Ouvrir la navigation"
            className="grid size-10 place-items-center rounded-xl border border-border bg-card/50 text-muted-foreground"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={20} />
          </button>
          <BrandLockup compact />
        </div>
        <div className="route-stage">
          <div key={routeKey} className="route-stage-content">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}

type NavItemBaseProps = {
  icon: ReactNode;
  children: ReactNode;
  badge?: number;
  onNavigate?: () => void;
};

type NavItemProps = NavItemBaseProps &
  (
    | { to: "/m/$id"; params: { id: string } }
    | {
        to: "/all" | "/dm" | "/compose" | "/mailboxes" | "/settings" | "/admin" | "/api-access";
        params?: never;
      }
  );

function NavItem(props: NavItemProps) {
  const { icon, children, badge, onNavigate } = props;
  const content = (
    <>
      {icon}
      <span className="flex flex-1 items-center gap-2 truncate">{children}</span>
      {badge ? (
        <span className="ml-auto grid min-w-5 place-items-center rounded-full bg-gradient-to-br from-brand to-brand-secondary px-1.5 py-0.5 text-[0.65rem] font-bold text-white shadow-[0_0_16px_var(--brand-secondary)]">
          {badge}
        </span>
      ) : null}
    </>
  );
  const activeProps = { className: "nav-item nav-item-active" };
  const className = "nav-item";

  if (props.to === "/m/$id") {
    return (
      <Link
        to="/m/$id"
        params={props.params}
        onClick={onNavigate}
        activeProps={activeProps}
        className={className}
      >
        {content}
      </Link>
    );
  }

  return (
    <Link to={props.to} onClick={onNavigate} activeProps={activeProps} className={className}>
      {content}
    </Link>
  );
}

function useNotificationFavicon(count: number) {
  useEffect(() => {
    if (typeof document === "undefined") return;

    const originalTitle = document.title;

    let link = document.querySelector<HTMLLinkElement>("#notification-favicon");
    if (!link) {
      link = document.createElement("link");
      link.id = "notification-favicon";
      link.rel = "icon";
      document.head.appendChild(link);
    }

    if (count <= 0) {
      link.type = "image/svg+xml";
      link.href = "/icon.svg";
      document.title = originalTitle.replace(/^● \(\d+\) /, "");
      return;
    }

    let cancelled = false;
    let notificationIcon = "";
    let highlighted = true;
    const icon = new Image();
    icon.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      const context = canvas.getContext("2d");
      if (!context) return;

      context.drawImage(icon, 0, 0, 128, 128);
      context.beginPath();
      context.arc(96, 32, 27, 0, Math.PI * 2);
      context.fillStyle = "#ff4d74";
      context.fill();
      context.lineWidth = 7;
      context.strokeStyle = "#090d18";
      context.stroke();
      context.fillStyle = "#ffffff";
      context.font = "700 27px system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(count > 9 ? "9+" : String(count), 96, 32);

      notificationIcon = canvas.toDataURL("image/png");
      link!.type = "image/png";
      link!.href = notificationIcon;
    };
    icon.src = "/icon.svg";

    const unreadLabel = `${count} notification${count > 1 ? "s" : ""}`;
    document.title = `● (${count}) ${unreadLabel} — JorgardeMail`;
    const interval = window.setInterval(() => {
      highlighted = !highlighted;
      link!.type = highlighted ? "image/png" : "image/svg+xml";
      link!.href = highlighted && notificationIcon ? notificationIcon : "/icon.svg";
      document.title = highlighted ? `● (${count}) ${unreadLabel} — JorgardeMail` : originalTitle;
    }, 850);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.title = originalTitle;
      link!.type = "image/svg+xml";
      link!.href = "/icon.svg";
    };
  }, [count]);
}
