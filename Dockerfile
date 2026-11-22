# Next.js standalone image (needs `output: "standalone"` in next.config.ts).
# Build:  docker build -t talenco-web:<tag> \
#           --build-arg NEXT_PUBLIC_SUPABASE_URL=... --build-arg NEXT_PUBLIC_APP_URL=... \
#           --build-arg NEXT_PUBLIC_TURNSTILE_SITE_KEY=... .
# NEXT_PUBLIC_* values are inlined into the bundle at build time, so they are build args.
# Every other variable (secrets) is read at runtime from the compose env_file and never enters the image.

# Stage 1: build with the Node version from .nvmrc
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=""
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    NEXT_TELEMETRY_DISABLED=1
# `next build` imports every route to collect page data, and lib/env.ts throws at import when a required
# server variable is missing. These placeholders exist only for this one command: they are not build args,
# not ENV, and not in the runtime stage, so the real values must come from the runtime env and lib/env.ts
# still rejects a container started without them. Keep this list in sync with REQUIRED_SERVER in lib/env.ts.
# ponytail: placeholder list duplicates lib/env.ts; drop it once env validation skips NEXT_PHASE=phase-production-build.
RUN SUPABASE_SERVICE_ROLE_KEY=build-placeholder RESEND_API_KEY=build-placeholder \
    RESEND_FROM_EMAIL=build-placeholder UPSTASH_REDIS_REST_URL=https://build-placeholder.invalid \
    UPSTASH_REDIS_REST_TOKEN=build-placeholder TURNSTILE_SECRET_KEY=build-placeholder \
    XENDIT_SECRET_KEY=build-placeholder PEEKA_FORWARD_SECRET=build-placeholder \
    INSTALLMENT_CRON_SECRET=build-placeholder ADMIN_PASSWORD=build-placeholder \
    PAYMENT_SERVICE_URL=https://build-placeholder.invalid PAYMENT_APP_KEY=build-placeholder \
    PAYMENT_WEBHOOK_SECRET=build-placeholder \
    npm run build

# Stage 2: run the standalone server as the non-root `node` user
FROM node:24-alpine
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
