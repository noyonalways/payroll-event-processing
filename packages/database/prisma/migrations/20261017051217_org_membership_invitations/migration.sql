-- CreateEnum
CREATE TYPE "OrgInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "org_invitations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "OrgInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invited_by" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "accepted_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_invitations_token_hash_key" ON "org_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "org_invitations_organization_id_status_idx" ON "org_invitations"("organization_id", "status");

-- AddForeignKey
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
