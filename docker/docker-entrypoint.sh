#!/bin/sh
set -e

echo "Running Prisma migrations..."
# prisma is a production dependency (see package.json), so its CLI survives the
# prod image's `npm prune --omit=dev`. Call the local binary directly — `npx`
# would try to fetch an arbitrary version from the registry if it were missing.
./node_modules/.bin/prisma migrate deploy

echo "Starting NestJS API..."
exec node dist/src/main
