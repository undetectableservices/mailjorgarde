# -------- build ------------------------------------------------------
FROM oven/bun:1 AS build
WORKDIR /app

# Public Supabase values must be baked into the browser bundle at build
# time (Vite replaces import.meta.env.VITE_* statically).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY . .

# Fail early and loudly instead of shipping an image that white-screens.
RUN test -n "$VITE_SUPABASE_URL" || (echo "ERROR: VITE_SUPABASE_URL build arg is empty. Set SUPABASE_URL in .env and re-run ./run.sh" >&2; exit 1)
RUN test -n "$VITE_SUPABASE_PUBLISHABLE_KEY" || (echo "ERROR: VITE_SUPABASE_PUBLISHABLE_KEY build arg is empty. Set SUPABASE_PUBLISHABLE_KEY in .env and re-run ./run.sh" >&2; exit 1)

# NITRO_PRESET pins a plain Node server output (.output/server/index.mjs)
# instead of the default Cloudflare Worker bundle, which cannot run here.
ENV NITRO_PRESET=node-server
RUN bun run build

# -------- runtime ----------------------------------------------------
# node:alpine (not bun) — the node-server preset emits a Node bundle, and
# alpine ships wget, which the compose healthcheck uses.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=6969
ENV HOST=0.0.0.0
COPY --from=build /app/.output ./.output
COPY --from=build /app/scripts/provision-admin.mjs ./scripts/provision-admin.mjs
EXPOSE 6969
USER node
CMD ["node", ".output/server/index.mjs"]
