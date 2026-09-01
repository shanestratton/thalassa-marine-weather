-- Definer hygiene repair for the 2026-08-29 account-deletion migrations.
--
-- 20260829020000 and 20260829030000 created three SECURITY DEFINER
-- functions without saying who may EXECUTE them, so they inherited
-- EXECUTE TO PUBLIC (caught by scripts/audit-supabase-migrations.mjs).
-- Those files now carry these same REVOKEs for any fresh environment,
-- but the live database already ran the originals — this migration
-- brings it to the same state.
--
-- account_deletion_storage_inventory(UUID) takes an arbitrary user id
-- and reads storage.objects, so only the service-role deletion path may
-- call it. The other two are trigger functions: triggers still fire
-- (EXECUTE is checked when the trigger is created, not per row), but
-- nothing may invoke them directly.

REVOKE ALL ON FUNCTION public.guard_grocery_purchase_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_deletion_storage_inventory(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_tombstoned_storage_write() FROM PUBLIC, anon, authenticated;
