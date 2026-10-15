# ─── Build: compile the Vite/React bundle from the workspace ────────────────
# The build context is the workspace root (design D10), so the install is the
# workspace's frozen lockfile filtered to @repo/web and its workspace
# dependency (@repo/shared — the UI imports the event-type contract from it).
FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/eslint-config/package.json packages/eslint-config/
RUN pnpm install --frozen-lockfile --filter @repo/web...
COPY packages/shared/ packages/shared/
COPY packages/typescript-config/ packages/typescript-config/
COPY packages/eslint-config/ packages/eslint-config/
COPY apps/web/ apps/web/
# @repo/web imports @repo/shared's compiled surface (design D6), so build it
# before the app's `tsc -b && vite build`.
RUN pnpm --filter @repo/shared build
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm --filter @repo/web build

# ─── Production: static SPA served by nginx ─────────────────────────────────
FROM nginx:alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
