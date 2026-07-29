import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import { BrandMark } from "@/components/brand-mark";
import { Toaster } from "@/components/ui/sonner";
import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

function NotFoundComponent() {
  return (
    <div className="auth-shell dark flex min-h-screen items-center justify-center px-4">
      <div className="auth-card jm-fade-up w-full max-w-md rounded-3xl p-8 text-center sm:p-10">
        <BrandMark className="mx-auto size-14" />
        <div className="page-eyebrow mt-6 justify-center before:hidden">Page introuvable</div>
        <h1 className="font-display text-7xl tracking-[-0.08em] text-foreground">404</h1>
        <h2 className="mt-3 text-xl font-semibold">Cette page n’existe pas</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Le contenu recherché a peut-être été déplacé ou supprimé.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="bg-gold inline-flex h-11 items-center justify-center rounded-xl px-5 text-sm font-semibold text-primary-foreground shadow-lg"
          >
            Retour à l’accueil
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);
  return (
    <div className="auth-shell dark flex min-h-screen items-center justify-center px-4">
      <div className="auth-card jm-fade-up w-full max-w-md rounded-3xl p-8 text-center sm:p-10">
        <BrandMark className="mx-auto size-14" />
        <h1 className="mt-6 font-display text-3xl">Un problème est survenu</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Une erreur inattendue empêche l’affichage de cette page. Réessayez dans quelques instants.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="bg-gold rounded-xl px-5 py-2.5 text-sm font-semibold text-primary-foreground"
          >
            Réessayer
          </button>
          <a href="/" className="rounded-xl border border-input px-5 py-2.5 text-sm font-medium">
            Retour à l’accueil
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "JorgardeMail" },
      {
        name: "description",
        content:
          "Messagerie multi-domaine avec adresses éphémères, conversations et espace d’administration.",
      },
      { name: "robots", content: "noindex, nofollow, noarchive" },
      { name: "theme-color", content: "#090d18" },
      { name: "color-scheme", content: "dark" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { property: "og:title", content: "JorgardeMail" },
      {
        property: "og:description",
        content:
          "Messagerie multi-domaine avec adresses éphémères, conversations et espace d’administration.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { rel: "icon", href: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
      { rel: "mask-icon", href: "/safari-pinned-tab.svg", color: "#55dcff" },
      { rel: "manifest", href: "/site.webmanifest" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="fr" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="dark bg-background text-foreground antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  );
}
