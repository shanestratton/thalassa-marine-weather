-- Public-beta account deletion support.
--
-- Apple requires account-creating apps to let every user initiate complete
-- deletion in-app. Most Thalassa tables already reference auth.users with
-- ON DELETE CASCADE. The relationships below intentionally retain shared
-- operational/moderation history, so they must release the deleted identity
-- instead of blocking auth.admin.deleteUser(). User-created rows that should
-- disappear completely are removed by the authenticated delete-account Edge
-- Function before the auth record is deleted.

ALTER TABLE IF EXISTS public.manifest_invites
    DROP CONSTRAINT IF EXISTS manifest_invites_accepted_by_fkey;
ALTER TABLE IF EXISTS public.manifest_invites
    ADD CONSTRAINT manifest_invites_accepted_by_fkey
    FOREIGN KEY (accepted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.watch_assignments
    DROP CONSTRAINT IF EXISTS watch_assignments_assigned_by_fkey;
ALTER TABLE IF EXISTS public.watch_assignments
    ADD CONSTRAINT watch_assignments_assigned_by_fkey
    FOREIGN KEY (assigned_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.voyages
    DROP CONSTRAINT IF EXISTS voyages_weather_master_id_fkey;
ALTER TABLE IF EXISTS public.voyages
    ADD CONSTRAINT voyages_weather_master_id_fkey
    FOREIGN KEY (weather_master_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.personal_ports
    DROP CONSTRAINT IF EXISTS personal_ports_public_approved_by_fkey;
ALTER TABLE IF EXISTS public.personal_ports
    ADD CONSTRAINT personal_ports_public_approved_by_fkey
    FOREIGN KEY (public_approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.guardian_alerts
    DROP CONSTRAINT IF EXISTS guardian_alerts_source_user_id_fkey;
ALTER TABLE IF EXISTS public.guardian_alerts
    ADD CONSTRAINT guardian_alerts_source_user_id_fkey
    FOREIGN KEY (source_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.guardian_alerts
    DROP CONSTRAINT IF EXISTS guardian_alerts_target_user_id_fkey;
ALTER TABLE IF EXISTS public.guardian_alerts
    ADD CONSTRAINT guardian_alerts_target_user_id_fkey
    FOREIGN KEY (target_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.chat_channels
    DROP CONSTRAINT IF EXISTS chat_channels_proposed_by_fkey;
ALTER TABLE IF EXISTS public.chat_channels
    ADD CONSTRAINT chat_channels_proposed_by_fkey
    FOREIGN KEY (proposed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Audit rows are retained for abuse/security investigations, but the account
-- identifier and free-form details are redacted by the deletion function.
ALTER TABLE IF EXISTS public.admin_audit_log
    ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE IF EXISTS public.admin_audit_log
    DROP CONSTRAINT IF EXISTS admin_audit_log_actor_id_fkey;
ALTER TABLE IF EXISTS public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_actor_id_fkey
    FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;
