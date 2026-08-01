import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

type Ctx = {
  session: Session | null;
  user: User | null;
  loading: boolean;
  acceptSession: (session: Session) => void;
};
const AuthCtx = createContext<Ctx>({
  session: null,
  user: null,
  loading: true,
  acceptSession: () => undefined,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const previousUserId = useRef<string | null>(null);

  const applySession = useCallback(
    (nextSession: Session | null) => {
      const nextUserId = nextSession?.user.id ?? null;
      if (previousUserId.current && previousUserId.current !== nextUserId) {
        // Never retain personal query results after logout or an account switch.
        queryClient.clear();
      }
      previousUserId.current = nextUserId;
      setSession(nextSession);
      setLoading(false);
    },
    [queryClient],
  );

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      applySession(s);
    });
    supabase.auth.getSession().then(({ data }) => {
      applySession(data.session);
    });
    return () => sub.subscription.unsubscribe();
  }, [applySession]);

  return (
    <AuthCtx.Provider
      value={{
        session,
        user: session?.user ?? null,
        loading,
        acceptSession: (nextSession) => {
          applySession(nextSession);
        },
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
