-- One PENDING invitation per (organization, email) — the store-level arbiter
-- (org-membership-management design D1). Partial unique: revoked/accepted rows
-- never block a legitimate re-invite.
CREATE UNIQUE INDEX "org_invitations_organization_id_email_pending_key"
    ON "org_invitations"("organization_id", "email")
    WHERE "status" = 'PENDING';
