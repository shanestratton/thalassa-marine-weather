-- Account deletion could not finish for anyone who had ever ticked an item off
-- the shopping list, and left the account BRICKED when it failed.
--
-- guard_grocery_purchase_delete() (20260723104300_atomic_grocery_purchase.sql)
-- fires BEFORE DELETE on public.shopping_list and, for any row with
-- purchased = true, raises twice over:
--
--   * 42501, because it demands auth.uid() and a Stores permission — and the
--     deletion scrub runs as service role, where auth.uid() is NULL; and
--   * 23514, "Undo the grocery purchase before deleting the item".
--
-- The scrub deletes shopping_list rows by user_id, so the whole deletion
-- transaction aborts. What it leaves behind is worse than residue: the
-- tombstone in account_deletion_jobs is written BEFORE the destructive steps
-- and never rolled back, so the account ends up permanently write-fenced —
-- read-only, undeletable, and still signed in — with no recovery short of
-- hand-written SQL. That is the opposite of what a delete button is for.
--
-- The guard itself is right for ordinary use: deleting a purchased row would
-- orphan its deterministic Stores receipt, and the supported flow is an atomic
-- undo first. It simply must not apply when the whole account is going. The
-- deletion scrub already announces itself for exactly this purpose —
-- scrub_account_deletion_survivors() sets thalassa.account_deletion_scrub, and
-- one other trigger in this schema already honours it — so this guard now
-- checks the same flag. It is a transaction-local GUC set by a SECURITY
-- DEFINER function, so it cannot be spoofed by a client.
--
-- Audited 2026-08-28. Nothing else changes: same function name, same trigger,
-- same behaviour for every non-deletion delete.

CREATE OR REPLACE FUNCTION public.guard_grocery_purchase_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    -- The account is being deleted. The receipt this guard protects is being
    -- deleted in the same sweep, so there is nothing left to orphan.
    IF current_setting('thalassa.account_deletion_scrub', true) = 'true' THEN
        RETURN OLD;
    END IF;

    IF OLD.purchased THEN
        IF auth.uid() IS NULL
           OR NOT public.can_access_vessel_register(OLD.user_id, 'stores', true) THEN
            RAISE EXCEPTION 'Ship''s Stores edit permission is required'
                USING ERRCODE = '42501';
        END IF;

        -- Deleting a purchased row would orphan its deterministic Stores
        -- receipt. The supported flow is an atomic undo followed by deletion.
        RAISE EXCEPTION 'Undo the grocery purchase before deleting the item'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;
