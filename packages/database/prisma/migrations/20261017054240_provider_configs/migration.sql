-- CreateEnum
CREATE TYPE "ProviderMode" AS ENUM ('SIMULATED', 'HTTP');

-- CreateTable
CREATE TABLE "provider_configs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "mode" "ProviderMode" NOT NULL,
    "base_url" TEXT,
    "credential" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_configs_organization_id_key" ON "provider_configs"("organization_id");

-- AddForeignKey
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
