#!/bin/sh
set -e

echo "Running Prisma migrations..."
# The CLI lives in @repo/database (its declared dependency), and the schema it
# owns is at packages/database/prisma (design D10). DATABASE_URL arrives from
# the environment (compose injects it); there is no env file in the image.
./packages/database/node_modules/.bin/prisma migrate deploy \
  --schema=packages/database/prisma/schema.prisma

echo "Starting NestJS API..."
exec node apps/api/dist/main.js
