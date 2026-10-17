-- 140-06: catch details are private even when their wildlife sighting is Crew.
-- A sidecar is required: sightings' whole-row SELECT/Realtime intentionally
-- reaches crew, so private columns on that table would leak those fields.
BEGIN;

-- A schema-wide publication would silently include a new private table. Refuse
-- that configuration rather than change any existing publication or feed.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_publication p
        LEFT JOIN pg_publication_namespace pn ON pn.pnpubid = p.oid
        LEFT JOIN pg_namespace n ON n.oid = pn.pnnspid
        WHERE p.pubname = 'supabase_realtime'
          AND (p.puballtables OR n.nspname = 'public')
    ) THEN
        RAISE EXCEPTION 'Private catches require explicit Realtime table membership; migration refused';
    END IF;
END $$;

CREATE TABLE public.sighting_catches (
    sighting_id UUID PRIMARY KEY REFERENCES public.sightings(id) ON DELETE CASCADE,
    observer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    species TEXT CHECK (species IS NULL OR (species = btrim(species) AND char_length(species) BETWEEN 1 AND 120)),
    length_cm NUMERIC(6, 1) CHECK (length_cm > 0 AND length_cm <= 2000),
    disposition TEXT CHECK (disposition IN ('kept', 'released')),
    CONSTRAINT sighting_catch_has_details CHECK (species IS NOT NULL OR length_cm IS NOT NULL OR disposition IS NOT NULL)
);
CREATE INDEX sighting_catches_observer_idx ON public.sighting_catches(observer_id);
ALTER TABLE public.sighting_catches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sighting_catches FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.sighting_catches TO authenticated;
GRANT UPDATE (species, length_cm, disposition) ON TABLE public.sighting_catches TO authenticated;

CREATE POLICY "Catch: observer reads" ON public.sighting_catches FOR SELECT TO authenticated
    USING (observer_id = (SELECT auth.uid()));
CREATE POLICY "Catch: observer inserts on own fish sighting" ON public.sighting_catches FOR INSERT TO authenticated
    WITH CHECK (
        observer_id = (SELECT auth.uid()) AND EXISTS (
            SELECT 1 FROM public.sightings s
            WHERE s.id = sighting_id AND s.observer_id = (SELECT auth.uid()) AND s.taxon_group = 'fish'
        )
    );
CREATE POLICY "Catch: observer edits on own fish sighting" ON public.sighting_catches FOR UPDATE TO authenticated
    USING (observer_id = (SELECT auth.uid()))
    WITH CHECK (
        observer_id = (SELECT auth.uid()) AND EXISTS (
            SELECT 1 FROM public.sightings s
            WHERE s.id = sighting_id AND s.observer_id = (SELECT auth.uid()) AND s.taxon_group = 'fish'
        )
    );
CREATE POLICY "Catch: observer deletes" ON public.sighting_catches FOR DELETE TO authenticated
    USING (observer_id = (SELECT auth.uid()));

-- Existing deletion jobs fence writes before auth.users is removed. Both the
-- observer and the real sighting have CASCADE FKs, so eventual deletion removes
-- catch details without a second external deletion workflow or new bucket.
CREATE TRIGGER account_deletion_write_fence BEFORE INSERT OR UPDATE ON public.sighting_catches
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('observer_id');
COMMENT ON TABLE public.sighting_catches IS
    '140-06: observer-only catch details. Never publish to Realtime or join into shared/public sightings or Darwin Core exports. Parent sighting visibility is unchanged.';
COMMIT;
