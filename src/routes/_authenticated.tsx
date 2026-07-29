import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AuthProvider, useAuth } from "@/lib/auth";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  Inbox,
  Mail,
  Menu,
  MessageSquare,
  Settings,
  Shield,
  LogOut,
  Plus,
  X,
  UserRound,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated")({
  component: AuthedShell,
});

function AuthedShell() {
  return (
    <AuthProvider>
      <Guard />
    </AuthProvider>
  );
}

function Guard() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth", search: { next: pathname } });
  }, [loading, session, navigate, pathname]);

  if (loading || !session) {
    return (
      <div className="dark min-h-screen bg-background flex items-center justify-center text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }
  return <Shell />;
}

function Shell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const { data: profile } = useQuery({
    queryKey: ["profile", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_my_profile");
      if (error) throw error;
      return data;
    },
  });

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
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const { data: dmUnread } = useQuery({
    queryKey: ["dm-unread", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { count } = await supabase
        .from("dms")
        .select("id", { count: "exact", head: true })
        .eq("recipient_id", user!.id)
        .is("seen_at", null);
      return count ?? 0;
    },
    refetchInterval: 15000,
  });

  const signOut = async () => {
    await supabase.auth.signOut();
    toast.success("Signed out");
    navigate({ to: "/auth" });
  };

  return (
    <div className="dark min-h-screen bg-background text-foreground md:grid md:grid-cols-[260px_1fr]">
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-[260px] border-r border-sidebar-border bg-sidebar flex flex-col transition-transform md:static md:z-auto md:w-auto md:translate-x-0 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="p-5 border-b border-sidebar-border">
          <div className="flex items-center justify-between gap-3">
            <div className="font-display text-2xl text-gold">JorgardeMail</div>
            <button
              type="button"
              aria-label="Close navigation"
              className="text-muted-foreground md:hidden"
              onClick={() => setMobileOpen(false)}
            >
              <X size={18} />
            </button>
          </div>
          <div className="text-xs text-muted-foreground truncate">@{profile?.username ?? "…"}</div>
        </div>
        <nav className="flex-1 overflow-y-auto p-3 space-y-1 text-sm">
          <NavItem to="/all" icon={<Inbox size={16} />} onNavigate={() => setMobileOpen(false)}>
            All mail
          </NavItem>
          <NavItem
            to="/dm"
            icon={<MessageSquare size={16} />}
            badge={dmUnread || undefined}
            onNavigate={() => setMobileOpen(false)}
          >
            Direct messages
          </NavItem>

          <div className="mt-4 mb-1 px-3 text-[10px] uppercase tracking-widest text-muted-foreground flex items-center justify-between">
            <span>Mailboxes</span>
            <Link to="/mailboxes" className="text-gold hover:opacity-80">
              <Plus size={12} />
            </Link>
          </div>
          {(mailboxes ?? []).slice(0, 20).map((mb) => (
            <NavItem
              key={mb.id}
              to="/m/$id"
              params={{ id: mb.id }}
              icon={<Mail size={14} />}
              onNavigate={() => setMobileOpen(false)}
            >
              <span className="truncate">
                {mb.local_part}@{mb.domain?.name}
              </span>
              {mb.is_temp && <span className="ml-auto text-[10px] text-gold/70">temp</span>}
            </NavItem>
          ))}
          {mailboxes && mailboxes.length === 0 && (
            <Link
              to="/mailboxes"
              className="block px-3 py-2 rounded-md text-muted-foreground hover:bg-sidebar-accent"
            >
              + Create your first address
            </Link>
          )}
        </nav>
        <div className="p-3 border-t border-sidebar-border space-y-1 text-sm">
          <NavItem
            to="/mailboxes"
            icon={<Settings size={16} />}
            onNavigate={() => setMobileOpen(false)}
          >
            Manage mailboxes
          </NavItem>
          <NavItem
            to="/settings"
            icon={<UserRound size={16} />}
            onNavigate={() => setMobileOpen(false)}
          >
            Account settings
          </NavItem>
          {isAdmin && (
            <NavItem
              to="/admin"
              icon={<Shield size={16} />}
              onNavigate={() => setMobileOpen(false)}
            >
              Admin
            </NavItem>
          )}
          <button
            onClick={signOut}
            className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-md text-muted-foreground hover:bg-sidebar-accent"
          >
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>
      <main className="min-h-screen overflow-x-hidden">
        <div className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur md:hidden">
          <button type="button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>
            <Menu size={20} />
          </button>
          <div className="font-display text-xl text-gold">JorgardeMail</div>
        </div>
        <div className="jm-fade-up">
          <Outlet />
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
    | { to: "/all" | "/dm" | "/mailboxes" | "/settings" | "/admin"; params?: never }
  );

function NavItem(props: NavItemProps) {
  const { icon, children, badge, onNavigate } = props;
  const content = (
    <>
      {icon}
      <span className="flex-1 truncate flex items-center gap-2">{children}</span>
      {badge ? (
        <span className="ml-auto text-[10px] bg-gold text-background rounded-full px-1.5 py-0.5 font-semibold">
          {badge}
        </span>
      ) : null}
    </>
  );
  const activeProps = {
    className:
      "flex items-center gap-2 px-3 py-2 rounded-md bg-sidebar-accent text-sidebar-accent-foreground border-l-2 border-gold",
  };
  const className =
    "flex items-center gap-2 px-3 py-2 rounded-md text-sidebar-foreground hover:bg-sidebar-accent transition-colors";

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
