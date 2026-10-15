# ─── Base: workspace manifests + the pinned pnpm ─────────────────────────────
# The build context is the workspace root (design D10): a workspace install
# needs the root manifest, the workspace declaration, and the lockfile.
FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./

# Every workspace member's manifest, so the filtered install can resolve
# @repo/api's dependency graph (@repo/core -> @repo/database -> @repo/shared
# and the two config packages) without dragging the sibling apps' manifests'
# dependency trees into the image.
COPY apps/api/package.json apps/api/
COPY packages/core/package.json packages/core/
COPY packages/database/package.json packages/database/
COPY packages/shared/package.json packages/shared/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/eslint-config/package.json packages/eslint-config/

# ─── Dev: full workspace for the API with hot reload (compose target) ────────
FROM base AS dev
RUN apk add --no-cache dumb-init
# Frozen install filtered to the API and its workspace dependencies (design
# D5/D10): no worker, no web, and no sibling app's dependencies.
RUN pnpm install --frozen-lockfile --filter @repo/api...
COPY packages/shared/ packages/shared/
COPY packages/typescript-config/ packages/typescript-config/
COPY packages/eslint-config/ packages/eslint-config/
COPY packages/database/ packages/database/
COPY packages/core/ packages/core/
COPY apps/api/ apps/api/
# The compiled internal packages the entrypoint imports at runtime.
RUN pnpm --filter @repo/shared build && \
    pnpm --filter @repo/database exec prisma generate && \
    pnpm --filter @repo/database build && \
    pnpm --filter @repo/core build
EXPOSE 3000
CMD ["pnpm", "--filter", "@repo/api", "dev"]

# ─── Build: compile the API and its workspace dependencies ───────────────────
FROM base AS build
RUN pnpm install --frozen-lockfile --filter @repo/api...
COPY packages/shared/ packages/shared/
COPY packages/typescript-config/ packages/typescript-config/
COPY packages/eslint-config/ packages/eslint-config/
COPY packages/database/ packages/database/
COPY packages/core/ packages/core/
COPY apps/api/ apps/api/
RUN pnpm --filter @repo/shared build && \
    pnpm --filter @repo/database exec prisma generate && \
    pnpm --filter @repo/database build && \
    pnpm --filter @repo/core build && \
    pnpm --filter @repo/api build

# ─── Production: minimal runtime image ──────────────────────────────────────
# The workspace tree is copied whole from the build stage (compiled dist/, the
# filtered install), so the symlinks between members stay consistent.
FROM node:20-alpine AS prod
RUN apk add --no-cache dumb-init
WORKDIR /repo
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared/ packages/shared/
COPY --from=build /repo/packages/typescript-config/ packages/typescript-config/
COPY --from=build /repo/packages/eslint-config/ packages/eslint-config/
COPY --from=build /repo/packages/database/ packages/database/
COPY --from=build /repo/packages/core/ packages/core/
COPY --from=build /repo/apps/api/ apps/api/
COPY apps/api/docker-entrypoint.sh apps/api/docker-entrypoint.sh
RUN chmod +x apps/api/docker-entrypoint.sh
EXPOSE 3000
USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["./apps/api/docker-entrypoint.sh"]
