-- Sightings (Shane 2026-10-05): "we need to have some kind of a thing is
-- scuttlebutt where punters can track birds, turtles, whales, even fish ...
-- something that governments will be jealous of." Then: "go with your picks,
-- call it sightings".
--
-- A punter logs what they saw from the boat: a group in one tap (whale,
-- dolphin, dugong, turtle, seabird, shark or ray, fish, other), the species
-- later from a curated Queensland / Great Barrier Reef catalogue, a count, and
-- the context the boat already knows (its GPS, the water temperature and depth
-- off the instruments, the wind, the voyage). Rows are shaped as Darwin Core
-- (scientificName, vernacularName, individualCount, eventDate,
-- decimalLatitude/Longitude, coordinateUncertaintyInMeters, basisOfRecord
-- 'HumanObservation', samplingProtocol, occurrenceRemarks), so a later export
-- to the Atlas of Living Australia is a mapping, not a migration.
--
-- Who sees a row (all enforced HERE, never only in the app):
--   - private: the observer only.
--   - crew: the observer, the boat's skipper (vessel_owner_id) and the
--     skipper's ACCEPTED crew (vessel_crew; guard_vessel_crew_acceptance,
--     20261004120000, means only the invited person can make a membership
--     accepted, and 20261005140000, pushed with this file, means nobody can
--     move a membership to another skipper or be their own crew). Live,
--     including over Realtime. Any accepted membership counts, voyage-scoped
--     ones too, for as long as it lasts (as get_crew_vessel_view reads it):
--     limiting a passage guest to that passage is a product call for Shane.
--   - public: the same crew live; everyone else ONLY through
--     get_public_sightings(), never the table, three hours late and on a grid:
--       * a row appears only when its whole time bucket (10 minutes, or the
--         hour when coarse) is more than 3 hours old, keyed on the later of
--         the server's created_at and the event time, so watching for the
--         moment a row first appears tells nothing finer than the bucket;
--       * the position is a grid-cell centre: 0.01 deg (about 1 km), or
--         0.1 deg (about 8 km) when coarse: a threatened species, a row that
--         was EVER named as one (ever_sensitive, sticky), or any group-only
--         row (a group is refined to a species later, and the public copy
--         must not get finer when it is);
--       * the time is floored to the bucket; the box filter tests the
--         FUZZED point (the raw pre-filter is one coarse cell wider), so
--         moving the box edges cannot recover an exact position;
--       * the id is per precision, md5(id || ':fine' or ':coarse'), so a
--         copy cached before a refinement cannot be linked by id to the
--         same sighting after it;
--       * never the photos, remarks, observer, boat or voyage. Signed-in
--         callers only; anon gets nothing in v1.
--   - fish: never public (CHECK), so a catch spot or a catch inside a green
--     zone is never published. Private by default; Crew is allowed.
--   Credit on a public row is the observer's OWN voyage-log handle, only when
--   they ticked it for that row, that log is enabled, and the row is not
--   coarse (a public voyage log's track would place a threatened animal
--   better than its 8 km cell); otherwise NULL, which the app shows as
--   'A Thalassa sailor'. Crew can never publicise the skipper's boat.
--
-- Writes:
--   - Only as yourself (observer_id = auth.uid()), and only against your own
--     boat or a skipper's boat you are ACCEPTED crew on. The hull is resolved
--     here: a boat_id that is not that skipper's live (unarchived) boat is
--     replaced by the one get_crew_vessel_view (20261003120000) would pick, so
--     an offline phone whose fleet id never reached the server still syncs.
--   - Species must come from public.sighting_taxa (seeded below from the app's
--     catalogue, data/sightings/species-qld-gbr.v1.json; a test keeps the two
--     identical); vernacular name and rank are copied from it, so public text
--     never needs moderation. Free text lives only in occurrence_remarks,
--     which no public path returns.
--   - Where and when cannot change after the insert (delete and log again);
--     the boat may only go to NULL (the FK SET NULL actions and the account
--     deletion scrub), and a Crew row whose skipper is gone becomes Private.
--   - created_at is the server's clock; event_date must be within 60 days
--     before and 5 minutes after it. Caps: 60 sightings per observer per hour
--     of event time, 1000 inserts per observer per 24 hours of server time
--     (P0001), so a week of offline logs still flushes at once.
--   - Photos: private bucket sighting-photos, JPEG only, 2 MB, path
--     <observer>/<sighting>/<0-3>.jpg. The app strips EXIF and GPS before the
--     upload (services/sightings/photoStrip.ts). Readable by the uploader and
--     by whoever can read a row that lists that exact path; a row can only
--     list its own observer's paths for its own id, so nobody can borrow
--     another person's photo by naming it.
--
-- Realtime: sightings joins supabase_realtime for the crew feed. Realtime
-- applies the SELECT policy to every INSERT and UPDATE it delivers, and other
-- boats' public rows are not readable through the table, so the delay holds
-- there too. DELETE events are different (Supabase: RLS cannot be checked on
-- a deleted row, and delete events cannot be filtered): EVERY signed-in
-- subscriber to this table receives the id of every deleted sighting, any
-- boat's, as it happens. The old record carries the primary key only (a
-- random uuid, never shown publicly: the public read returns its own ids),
-- so this leaks that some sighting was deleted and when, never what or where.
-- Accepted for v1; moving the crew feed to Broadcast on private channels
-- (RLS on realtime.messages) would close it.
--
-- Account deletion: rows go with the observer (ON DELETE CASCADE); a crew
-- row on a deleted skipper's boat keeps its observer and loses the boat. The
-- write fence refuses a tombstoned observer. sighting-photos is ALREADY in
-- the path-based storage inventory and the tombstone storage fence: the
-- seabed migration (20261005130000, live) redefined both with
-- 'seabed-soundings' and 'sighting-photos'. This file does not redefine
-- them, so it cannot drop a bucket a later migration added
-- (tests/seabedMigration.test.ts holds the newest definition to a superset).
--
-- Written, NOT pushed: Shane says "yes, push it" first, and it goes up
-- together with 20261005140000_vessel_crew_owner_pinned.sql (numbered after
-- the live seabed migration, so a plain `db push` takes both in order). Until
-- then the app logs to the phone and holds quietly on PGRST205 / 42P01 /
-- PGRST202 / 42883 (services/sightings/sightingSync.ts). Safe to re-run: IF
-- NOT EXISTS, CREATE OR REPLACE, ON CONFLICT, DROP ... IF EXISTS before every
-- trigger and policy. No BEGIN or COMMIT: the pre-push replay runs this file
-- twice inside a rolled-back transaction.

SET LOCAL lock_timeout = '5s';

-- ── 1. The species catalogue ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sighting_taxa (
    scientific_name TEXT PRIMARY KEY CHECK (char_length(scientific_name) BETWEEN 3 AND 120),
    taxon_group TEXT NOT NULL
        CHECK (taxon_group IN ('whale', 'dolphin', 'dugong', 'turtle', 'seabird', 'shark_ray', 'fish', 'other')),
    vernacular_name TEXT NOT NULL CHECK (char_length(vernacular_name) BETWEEN 2 AND 120),
    taxon_rank TEXT NOT NULL CHECK (char_length(taxon_rank) BETWEEN 3 AND 30),
    family TEXT CHECK (family IS NULL OR char_length(family) BETWEEN 2 AND 80),
    class TEXT CHECK (class IS NULL OR char_length(class) BETWEEN 2 AND 80),
    sensitive BOOLEAN NOT NULL,
    status TEXT CHECK (status IS NULL OR char_length(status) <= 200),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.sighting_taxa ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sighting_taxa FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.sighting_taxa TO authenticated;

DROP POLICY IF EXISTS "Signed-in users read the sightings catalogue" ON public.sighting_taxa;
CREATE POLICY "Signed-in users read the sightings catalogue"
    ON public.sighting_taxa FOR SELECT TO authenticated
    USING (true);

COMMENT ON TABLE public.sighting_taxa IS
    'Sightings species catalogue (2026-10-05), seeded from data/sightings/species-qld-gbr.v1.json. sensitive = threatened (EPBC, QLD NCA or IUCN CR/EN/VU): generalised to 0.1 deg in every public output.';

-- SEED:BEGIN (generated from data/sightings/species-qld-gbr.v1.json; tests/sightings/SightingsCatalogue.test.ts keeps them equal)
INSERT INTO public.sighting_taxa (scientific_name, taxon_group, vernacular_name, taxon_rank, family, class, sensitive, status)
VALUES
    ('Megaptera novaeangliae', 'whale', 'Humpback whale', 'species', 'Balaenopteridae', 'Mammalia', false, 'EPBC: removed from the threatened list 2022 (still Migratory, Marine); IUCN LC'),
    ('Balaenoptera acutorostrata', 'whale', 'Dwarf minke whale', 'species', 'Balaenopteridae', 'Mammalia', false, 'IUCN LC (species); dwarf form is an unnamed subspecies'),
    ('Balaenoptera bonaerensis', 'whale', 'Antarctic minke whale', 'species', 'Balaenopteridae', 'Mammalia', false, 'IUCN NT'),
    ('Balaenoptera edeni', 'whale', 'Bryde''s whale', 'species', 'Balaenopteridae', 'Mammalia', false, 'IUCN LC'),
    ('Balaenoptera omurai', 'whale', 'Omura''s whale', 'species', 'Balaenopteridae', 'Mammalia', false, 'IUCN DD'),
    ('Balaenoptera musculus', 'whale', 'Blue whale', 'species', 'Balaenopteridae', 'Mammalia', true, 'EPBC Endangered; IUCN EN'),
    ('Balaenoptera physalus', 'whale', 'Fin whale', 'species', 'Balaenopteridae', 'Mammalia', true, 'EPBC Vulnerable; IUCN VU'),
    ('Balaenoptera borealis', 'whale', 'Sei whale', 'species', 'Balaenopteridae', 'Mammalia', true, 'EPBC Vulnerable; IUCN EN'),
    ('Eubalaena australis', 'whale', 'Southern right whale', 'species', 'Balaenidae', 'Mammalia', true, 'EPBC Endangered; IUCN LC'),
    ('Physeter macrocephalus', 'whale', 'Sperm whale', 'species', 'Physeteridae', 'Mammalia', true, 'IUCN VU'),
    ('Kogia breviceps', 'whale', 'Pygmy sperm whale', 'species', 'Kogiidae', 'Mammalia', false, 'IUCN LC'),
    ('Kogia sima', 'whale', 'Dwarf sperm whale', 'species', 'Kogiidae', 'Mammalia', false, 'IUCN LC'),
    ('Ziphius cavirostris', 'whale', 'Cuvier''s beaked whale', 'species', 'Ziphiidae', 'Mammalia', false, 'IUCN LC'),
    ('Mesoplodon densirostris', 'whale', 'Blainville''s beaked whale', 'species', 'Ziphiidae', 'Mammalia', false, 'IUCN LC'),
    ('Orcinus orca', 'whale', 'Killer whale', 'species', 'Delphinidae', 'Mammalia', false, 'IUCN DD'),
    ('Pseudorca crassidens', 'whale', 'False killer whale', 'species', 'Delphinidae', 'Mammalia', false, 'IUCN NT'),
    ('Globicephala macrorhynchus', 'whale', 'Short-finned pilot whale', 'species', 'Delphinidae', 'Mammalia', false, 'IUCN LC'),
    ('Peponocephala electra', 'whale', 'Melon-headed whale', 'species', 'Delphinidae', 'Mammalia', false, 'IUCN LC'),
    ('Feresa attenuata', 'whale', 'Pygmy killer whale', 'species', 'Delphinidae', 'Mammalia', false, 'IUCN LC'),
    ('Tursiops aduncus', 'dolphin', 'Indo-Pacific bottlenose dolphin', 'species', 'Delphinidae', 'Mammalia', false, 'IUCN NT'),
    ('Tursiops truncatus', 'dolphin', 'Common bottlenose dolphin', 'species', 'Delphinidae', 'Mammalia', false, 'IUCN LC'),
    ('Sousa sahulensis', 'dolphin', 'Australian humpback dolphin', 'species', 'Delphinidae', 'Mammalia', true, 'EPBC Vulnerable (from 5 Mar 2025); IUCN VU'),
    ('Orcaella heinsohni', 'dolphin', 'Australian snubfin dolphin', 'species', 'Delphinidae', 'Mammalia', true, 'EPBC Vulnerable (from 5 Mar 2025); IUCN VU'),
    ('Stenella longirostris', 'dolphin', 'Spinner dolphin', 'species', 'Delphinidae', 'Mammalia', false, 'IUCN LC'),
    ('Stenella attenuata', 'dolphin', 'Pantropical spotted dolphin', 'species', 'Delphinidae', 'Mammalia', false, 'IUCN LC'),
    ('Stenella coeruleoalba', 'dolphin', 'Striped dolphin', 'species', 'Delphinidae', 'Mammalia', false, 'IUCN LC'),
    ('Delphinus delphis', 'dolphin', 'Common dolphin', 'species', 'Delphinidae', 'Mammalia', false, 'IUCN LC'),
    ('Steno bredanensis', 'dolphin', 'Rough-toothed dolphin', 'species', 'Delphinidae', 'Mammalia', false, 'IUCN LC'),
    ('Grampus griseus', 'dolphin', 'Risso''s dolphin', 'species', 'Delphinidae', 'Mammalia', false, 'IUCN LC'),
    ('Lagenodelphis hosei', 'dolphin', 'Fraser''s dolphin', 'species', 'Delphinidae', 'Mammalia', false, 'IUCN LC'),
    ('Dugong dugon', 'dugong', 'Dugong', 'species', 'Dugongidae', 'Mammalia', true, 'IUCN VU; QLD Nature Conservation Act Vulnerable; EPBC Migratory, Marine'),
    ('Chelonia mydas', 'turtle', 'Green turtle', 'species', 'Cheloniidae', 'Reptilia', true, 'EPBC Vulnerable; IUCN EN'),
    ('Caretta caretta', 'turtle', 'Loggerhead turtle', 'species', 'Cheloniidae', 'Reptilia', true, 'EPBC Endangered; IUCN VU'),
    ('Eretmochelys imbricata', 'turtle', 'Hawksbill turtle', 'species', 'Cheloniidae', 'Reptilia', true, 'EPBC Vulnerable; IUCN CR'),
    ('Natator depressus', 'turtle', 'Flatback turtle', 'species', 'Cheloniidae', 'Reptilia', true, 'EPBC Vulnerable; IUCN DD'),
    ('Lepidochelys olivacea', 'turtle', 'Olive ridley turtle', 'species', 'Cheloniidae', 'Reptilia', true, 'EPBC Endangered; IUCN VU'),
    ('Dermochelys coriacea', 'turtle', 'Leatherback turtle', 'species', 'Dermochelyidae', 'Reptilia', true, 'EPBC Endangered; IUCN VU'),
    ('Sula leucogaster', 'seabird', 'Brown booby', 'species', 'Sulidae', 'Aves', false, 'IUCN LC'),
    ('Sula dactylatra', 'seabird', 'Masked booby', 'species', 'Sulidae', 'Aves', false, 'IUCN LC'),
    ('Sula sula', 'seabird', 'Red-footed booby', 'species', 'Sulidae', 'Aves', false, 'IUCN LC'),
    ('Morus serrator', 'seabird', 'Australasian gannet', 'species', 'Sulidae', 'Aves', false, 'IUCN LC'),
    ('Fregata minor', 'seabird', 'Great frigatebird', 'species', 'Fregatidae', 'Aves', false, 'IUCN LC'),
    ('Fregata ariel', 'seabird', 'Lesser frigatebird', 'species', 'Fregatidae', 'Aves', false, 'IUCN LC'),
    ('Phaethon rubricauda', 'seabird', 'Red-tailed tropicbird', 'species', 'Phaethontidae', 'Aves', false, 'IUCN LC'),
    ('Phaethon lepturus', 'seabird', 'White-tailed tropicbird', 'species', 'Phaethontidae', 'Aves', false, 'IUCN LC'),
    ('Ardenna pacifica', 'seabird', 'Wedge-tailed shearwater', 'species', 'Procellariidae', 'Aves', false, 'IUCN LC'),
    ('Ardenna tenuirostris', 'seabird', 'Short-tailed shearwater', 'species', 'Procellariidae', 'Aves', false, 'IUCN LC'),
    ('Oceanites oceanicus', 'seabird', 'Wilson''s storm petrel', 'species', 'Oceanitidae', 'Aves', false, 'IUCN LC'),
    ('Anous minutus', 'seabird', 'Black noddy', 'species', 'Laridae', 'Aves', false, 'IUCN LC'),
    ('Anous stolidus', 'seabird', 'Brown noddy', 'species', 'Laridae', 'Aves', false, 'IUCN LC'),
    ('Onychoprion fuscatus', 'seabird', 'Sooty tern', 'species', 'Laridae', 'Aves', false, 'IUCN LC'),
    ('Onychoprion anaethetus', 'seabird', 'Bridled tern', 'species', 'Laridae', 'Aves', false, 'IUCN LC'),
    ('Thalasseus bergii', 'seabird', 'Greater crested tern', 'species', 'Laridae', 'Aves', false, 'IUCN LC'),
    ('Thalasseus bengalensis', 'seabird', 'Lesser crested tern', 'species', 'Laridae', 'Aves', false, 'IUCN LC'),
    ('Sterna dougallii', 'seabird', 'Roseate tern', 'species', 'Laridae', 'Aves', false, 'IUCN LC'),
    ('Sterna sumatrana', 'seabird', 'Black-naped tern', 'species', 'Laridae', 'Aves', false, 'IUCN LC'),
    ('Hydroprogne caspia', 'seabird', 'Caspian tern', 'species', 'Laridae', 'Aves', false, 'IUCN LC'),
    ('Gelochelidon macrotarsa', 'seabird', 'Australian tern', 'species', 'Laridae', 'Aves', false, 'IUCN LC'),
    ('Chroicocephalus novaehollandiae', 'seabird', 'Silver gull', 'species', 'Laridae', 'Aves', false, 'IUCN LC'),
    ('Pelecanus conspicillatus', 'seabird', 'Australian pelican', 'species', 'Pelecanidae', 'Aves', false, 'IUCN LC'),
    ('Phalacrocorax varius', 'seabird', 'Pied cormorant', 'species', 'Phalacrocoracidae', 'Aves', false, 'IUCN LC'),
    ('Microcarbo melanoleucos', 'seabird', 'Little pied cormorant', 'species', 'Phalacrocoracidae', 'Aves', false, 'IUCN LC'),
    ('Phalacrocorax sulcirostris', 'seabird', 'Little black cormorant', 'species', 'Phalacrocoracidae', 'Aves', false, 'IUCN LC'),
    ('Phalacrocorax carbo', 'seabird', 'Great cormorant', 'species', 'Phalacrocoracidae', 'Aves', false, 'IUCN LC'),
    ('Anhinga novaehollandiae', 'seabird', 'Australasian darter', 'species', 'Anhingidae', 'Aves', false, 'IUCN LC'),
    ('Egretta sacra', 'seabird', 'Eastern reef egret', 'species', 'Ardeidae', 'Aves', false, 'IUCN LC'),
    ('Haliaeetus leucogaster', 'seabird', 'White-bellied sea-eagle', 'species', 'Accipitridae', 'Aves', false, 'IUCN LC'),
    ('Pandion haliaetus', 'seabird', 'Eastern osprey', 'species', 'Pandionidae', 'Aves', false, 'IUCN LC'),
    ('Haliastur indus', 'seabird', 'Brahminy kite', 'species', 'Accipitridae', 'Aves', false, 'IUCN LC'),
    ('Haematopus longirostris', 'seabird', 'Pied oystercatcher', 'species', 'Haematopodidae', 'Aves', false, 'IUCN LC'),
    ('Haematopus fuliginosus', 'seabird', 'Sooty oystercatcher', 'species', 'Haematopodidae', 'Aves', false, 'IUCN LC'),
    ('Numenius phaeopus', 'seabird', 'Whimbrel', 'species', 'Scolopacidae', 'Aves', false, 'IUCN LC'),
    ('Ardenna carneipes', 'seabird', 'Flesh-footed shearwater', 'species', 'Procellariidae', 'Aves', true, 'IUCN NT'),
    ('Ardenna grisea', 'seabird', 'Sooty shearwater', 'species', 'Procellariidae', 'Aves', false, 'IUCN NT'),
    ('Pseudobulweria rostrata', 'seabird', 'Tahiti petrel', 'species', 'Procellariidae', 'Aves', false, 'IUCN NT'),
    ('Pterodroma solandri', 'seabird', 'Providence petrel', 'species', 'Procellariidae', 'Aves', true, 'IUCN VU'),
    ('Pterodroma heraldica', 'seabird', 'Herald petrel', 'species', 'Procellariidae', 'Aves', true, 'EPBC Critically Endangered; IUCN LC'),
    ('Pterodroma leucoptera', 'seabird', 'Gould''s petrel', 'species', 'Procellariidae', 'Aves', true, 'EPBC Endangered (ssp. leucoptera); IUCN VU'),
    ('Diomedea exulans', 'seabird', 'Wandering albatross', 'species', 'Diomedeidae', 'Aves', true, 'EPBC Vulnerable; IUCN VU'),
    ('Thalassarche melanophris', 'seabird', 'Black-browed albatross', 'species', 'Diomedeidae', 'Aves', true, 'EPBC Vulnerable; IUCN LC'),
    ('Thalassarche cauta', 'seabird', 'Shy albatross', 'species', 'Diomedeidae', 'Aves', true, 'EPBC Endangered (from 3 Jul 2020); IUCN NT'),
    ('Sternula albifrons', 'seabird', 'Little tern', 'species', 'Laridae', 'Aves', true, 'EPBC Vulnerable (2025); QLD Nature Conservation Act Endangered'),
    ('Esacus magnirostris', 'seabird', 'Beach stone-curlew', 'species', 'Burhinidae', 'Aves', true, 'QLD Nature Conservation Act Vulnerable; IUCN NT'),
    ('Numenius madagascariensis', 'seabird', 'Eastern curlew', 'species', 'Scolopacidae', 'Aves', true, 'EPBC Critically Endangered; IUCN EN'),
    ('Limosa lapponica', 'seabird', 'Bar-tailed godwit', 'species', 'Scolopacidae', 'Aves', true, 'EPBC Endangered (ssp. baueri, from 5 Jan 2024); IUCN NT'),
    ('Calidris tenuirostris', 'seabird', 'Great knot', 'species', 'Scolopacidae', 'Aves', true, 'EPBC Vulnerable (from 5 Jan 2024); IUCN EN'),
    ('Calidris canutus', 'seabird', 'Red knot', 'species', 'Scolopacidae', 'Aves', true, 'EPBC Vulnerable (from 5 Jan 2024); IUCN NT'),
    ('Charadrius mongolus', 'seabird', 'Lesser sand plover', 'species', 'Charadriidae', 'Aves', true, 'EPBC Endangered; IUCN EN'),
    ('Charadrius leschenaultii', 'seabird', 'Greater sand plover', 'species', 'Charadriidae', 'Aves', true, 'EPBC Vulnerable; IUCN NT'),
    ('Rhincodon typus', 'shark_ray', 'Whale shark', 'species', 'Rhincodontidae', 'Chondrichthyes', true, 'EPBC Vulnerable, Migratory; IUCN EN'),
    ('Galeocerdo cuvier', 'shark_ray', 'Tiger shark', 'species', 'Galeocerdonidae', 'Chondrichthyes', false, 'IUCN NT'),
    ('Carcharhinus leucas', 'shark_ray', 'Bull shark', 'species', 'Carcharhinidae', 'Chondrichthyes', true, 'IUCN VU'),
    ('Carcharodon carcharias', 'shark_ray', 'White shark', 'species', 'Lamnidae', 'Chondrichthyes', true, 'EPBC Vulnerable; IUCN VU'),
    ('Sphyrna mokarran', 'shark_ray', 'Great hammerhead', 'species', 'Sphyrnidae', 'Chondrichthyes', true, 'IUCN CR (not EPBC listed)'),
    ('Sphyrna lewini', 'shark_ray', 'Scalloped hammerhead', 'species', 'Sphyrnidae', 'Chondrichthyes', true, 'EPBC Conservation Dependent; IUCN CR'),
    ('Carcharias taurus', 'shark_ray', 'Grey nurse shark', 'species', 'Odontaspididae', 'Chondrichthyes', true, 'EPBC Critically Endangered (east coast population); IUCN CR'),
    ('Triaenodon obesus', 'shark_ray', 'Whitetip reef shark', 'species', 'Carcharhinidae', 'Chondrichthyes', true, 'IUCN VU'),
    ('Carcharhinus melanopterus', 'shark_ray', 'Blacktip reef shark', 'species', 'Carcharhinidae', 'Chondrichthyes', true, 'IUCN VU'),
    ('Carcharhinus amblyrhynchos', 'shark_ray', 'Grey reef shark', 'species', 'Carcharhinidae', 'Chondrichthyes', true, 'IUCN EN'),
    ('Carcharhinus albimarginatus', 'shark_ray', 'Silvertip shark', 'species', 'Carcharhinidae', 'Chondrichthyes', true, 'IUCN VU'),
    ('Carcharhinus longimanus', 'shark_ray', 'Oceanic whitetip shark', 'species', 'Carcharhinidae', 'Chondrichthyes', true, 'IUCN CR'),
    ('Negaprion acutidens', 'shark_ray', 'Sicklefin lemon shark', 'species', 'Carcharhinidae', 'Chondrichthyes', true, 'IUCN EN'),
    ('Nebrius ferrugineus', 'shark_ray', 'Tawny nurse shark', 'species', 'Ginglymostomatidae', 'Chondrichthyes', true, 'IUCN VU'),
    ('Stegostoma tigrinum', 'shark_ray', 'Zebra shark', 'species', 'Stegostomatidae', 'Chondrichthyes', true, 'IUCN EN'),
    ('Hemiscyllium ocellatum', 'shark_ray', 'Epaulette shark', 'species', 'Hemiscylliidae', 'Chondrichthyes', false, 'IUCN LC'),
    ('Orectolobus maculatus', 'shark_ray', 'Spotted wobbegong', 'species', 'Orectolobidae', 'Chondrichthyes', false, 'IUCN LC'),
    ('Mobula alfredi', 'shark_ray', 'Reef manta ray', 'species', 'Mobulidae', 'Chondrichthyes', true, 'IUCN VU'),
    ('Mobula birostris', 'shark_ray', 'Oceanic manta ray', 'species', 'Mobulidae', 'Chondrichthyes', true, 'IUCN EN'),
    ('Aetobatus ocellatus', 'shark_ray', 'Whitespotted eagle ray', 'species', 'Aetobatidae', 'Chondrichthyes', true, 'IUCN EN'),
    ('Taeniura lymma', 'shark_ray', 'Bluespotted ribbontail ray', 'species', 'Dasyatidae', 'Chondrichthyes', false, 'IUCN LC'),
    ('Neotrygon australiae', 'shark_ray', 'Bluespotted maskray', 'species', 'Dasyatidae', 'Chondrichthyes', true, 'IUCN LC'),
    ('Pastinachus ater', 'shark_ray', 'Cowtail stingray', 'species', 'Dasyatidae', 'Chondrichthyes', true, 'IUCN VU'),
    ('Glaucostegus typus', 'shark_ray', 'Giant shovelnose ray', 'species', 'Glaucostegidae', 'Chondrichthyes', true, 'IUCN CR'),
    ('Rhynchobatus australiae', 'shark_ray', 'Bottlenose wedgefish', 'species', 'Rhinidae', 'Chondrichthyes', true, 'IUCN CR'),
    ('Pristis zijsron', 'shark_ray', 'Green sawfish', 'species', 'Pristidae', 'Chondrichthyes', true, 'EPBC Vulnerable; IUCN CR'),
    ('Pristis pristis', 'shark_ray', 'Largetooth sawfish', 'species', 'Pristidae', 'Chondrichthyes', true, 'EPBC Vulnerable; IUCN CR'),
    ('Anoxypristis cuspidata', 'shark_ray', 'Narrow sawfish', 'species', 'Pristidae', 'Chondrichthyes', true, 'IUCN EN'),
    ('Pristis clavata', 'shark_ray', 'Dwarf sawfish', 'species', 'Pristidae', 'Chondrichthyes', true, 'EPBC Vulnerable; IUCN EN'),
    ('Plectropomus leopardus', 'fish', 'Common coral trout', 'species', 'Serranidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Lutjanus sebae', 'fish', 'Red emperor', 'species', 'Lutjanidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Lutjanus argentimaculatus', 'fish', 'Mangrove jack', 'species', 'Lutjanidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Lutjanus carponotatus', 'fish', 'Stripey snapper', 'species', 'Lutjanidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Lethrinus nebulosus', 'fish', 'Spangled emperor', 'species', 'Lethrinidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Lethrinus miniatus', 'fish', 'Redthroat emperor', 'species', 'Lethrinidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Lethrinus laticaudis', 'fish', 'Grass emperor', 'species', 'Lethrinidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Chrysophrys auratus', 'fish', 'Snapper', 'species', 'Sparidae', 'Actinopterygii', false, 'IUCN not assessed'),
    ('Scomberomorus commerson', 'fish', 'Spanish mackerel', 'species', 'Scombridae', 'Actinopterygii', false, 'IUCN NT'),
    ('Caranx ignobilis', 'fish', 'Giant trevally', 'species', 'Carangidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Gnathanodon speciosus', 'fish', 'Golden trevally', 'species', 'Carangidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Scomberoides commersonnianus', 'fish', 'Queenfish', 'species', 'Carangidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Rachycentron canadum', 'fish', 'Cobia', 'species', 'Rachycentridae', 'Actinopterygii', false, 'IUCN LC'),
    ('Coryphaena hippurus', 'fish', 'Mahi-mahi', 'species', 'Coryphaenidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Thunnus albacares', 'fish', 'Yellowfin tuna', 'species', 'Scombridae', 'Actinopterygii', false, 'IUCN LC'),
    ('Thunnus tonggol', 'fish', 'Longtail tuna', 'species', 'Scombridae', 'Actinopterygii', false, 'IUCN DD'),
    ('Euthynnus affinis', 'fish', 'Mackerel tuna', 'species', 'Scombridae', 'Actinopterygii', false, 'IUCN LC'),
    ('Acanthocybium solandri', 'fish', 'Wahoo', 'species', 'Scombridae', 'Actinopterygii', false, 'IUCN LC'),
    ('Istiompax indica', 'fish', 'Black marlin', 'species', 'Istiophoridae', 'Actinopterygii', false, 'IUCN DD'),
    ('Platycephalus fuscus', 'fish', 'Dusky flathead', 'species', 'Platycephalidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Sillago ciliata', 'fish', 'Sand whiting', 'species', 'Sillaginidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Acanthopagrus australis', 'fish', 'Yellowfin bream', 'species', 'Sparidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Mugil cephalus', 'fish', 'Sea mullet', 'species', 'Mugilidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Sphyraena barracuda', 'fish', 'Great barracuda', 'species', 'Sphyraenidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Amphiprion percula', 'fish', 'Clown anemonefish', 'species', 'Pomacentridae', 'Actinopterygii', false, 'IUCN LC'),
    ('Zanclus cornutus', 'fish', 'Moorish idol', 'species', 'Zanclidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Gymnothorax javanicus', 'fish', 'Giant moray', 'species', 'Muraenidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Platax pinnatus', 'fish', 'Pinnate batfish', 'species', 'Ephippidae', 'Actinopterygii', false, 'IUCN LC'),
    ('Plectropomus maculatus', 'fish', 'Barcheek coral trout', 'species', 'Serranidae', 'Actinopterygii', true, 'IUCN LC'),
    ('Scomberomorus munroi', 'fish', 'Spotted mackerel', 'species', 'Scombridae', 'Actinopterygii', true, 'IUCN NT'),
    ('Istiophorus platypterus', 'fish', 'Sailfish', 'species', 'Istiophoridae', 'Actinopterygii', true, 'IUCN LC'),
    ('Lates calcarifer', 'fish', 'Barramundi', 'species', 'Latidae', 'Actinopterygii', true, 'IUCN LC'),
    ('Epinephelus tukula', 'fish', 'Potato cod', 'species', 'Serranidae', 'Actinopterygii', true, 'IUCN LC; no-take in the Marine Park'),
    ('Makaira nigricans', 'fish', 'Blue marlin', 'species', 'Istiophoridae', 'Actinopterygii', true, 'IUCN VU'),
    ('Pomatomus saltatrix', 'fish', 'Tailor', 'species', 'Pomatomidae', 'Actinopterygii', true, 'IUCN VU'),
    ('Cheilinus undulatus', 'fish', 'Humphead Maori wrasse', 'species', 'Labridae', 'Actinopterygii', true, 'IUCN EN; no-take in Queensland'),
    ('Epinephelus lanceolatus', 'fish', 'Queensland groper', 'species', 'Serranidae', 'Actinopterygii', true, 'IUCN VU; no-take in Queensland'),
    ('Bolbometopon muricatum', 'fish', 'Bumphead parrotfish', 'species', 'Scaridae', 'Actinopterygii', true, 'IUCN VU'),
    ('Mola mola', 'fish', 'Ocean sunfish', 'species', 'Molidae', 'Actinopterygii', true, 'IUCN VU'),
    ('Exocoetidae', 'fish', 'Flying fish', 'family', 'Exocoetidae', 'Actinopterygii', false, 'Family level, not assessed'),
    ('Crocodylus porosus', 'other', 'Saltwater crocodile', 'species', 'Crocodylidae', 'Reptilia', true, 'QLD Nature Conservation Act Vulnerable; IUCN LC'),
    ('Aipysurus laevis', 'other', 'Olive sea snake', 'species', 'Elapidae', 'Reptilia', false, 'IUCN LC'),
    ('Hydrophis platurus', 'other', 'Yellow-bellied sea snake', 'species', 'Elapidae', 'Reptilia', false, 'IUCN LC'),
    ('Tridacna gigas', 'other', 'Giant clam', 'species', 'Cardiidae', 'Bivalvia', true, 'IUCN VU'),
    ('Acanthaster solaris', 'other', 'Crown-of-thorns starfish', 'species', 'Acanthasteridae', 'Asteroidea', false, 'Native outbreak species; report to Eye on the Reef'),
    ('Chironex fleckeri', 'other', 'Box jellyfish', 'species', 'Chirodropidae', 'Cubozoa', false, 'Not assessed; dangerous to people'),
    ('Physalia physalis', 'other', 'Bluebottle', 'species', 'Physaliidae', 'Hydrozoa', false, 'Not assessed'),
    ('Hapalochlaena', 'other', 'Blue-ringed octopus', 'genus', 'Octopodidae', 'Cephalopoda', false, 'Genus level, not assessed'),
    ('Sepia latimanus', 'other', 'Broadclub cuttlefish', 'species', 'Sepiidae', 'Cephalopoda', true, 'IUCN DD'),
    ('Trichodesmium erythraeum', 'other', 'Sea sawdust (Trichodesmium)', 'species', 'Microcoleaceae', 'Cyanophyceae', false, 'Cyanobacteria bloom, not assessed')
ON CONFLICT (scientific_name) DO UPDATE
    SET taxon_group = EXCLUDED.taxon_group,
        vernacular_name = EXCLUDED.vernacular_name,
        taxon_rank = EXCLUDED.taxon_rank,
        family = EXCLUDED.family,
        class = EXCLUDED.class,
        sensitive = EXCLUDED.sensitive,
        status = EXCLUDED.status,
        updated_at = now();
-- SEED:END

-- ── 2. The sightings ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sightings (
    -- Client-generated, so a retried insert is idempotent (23505 = already there).
    id UUID PRIMARY KEY,
    observer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    vessel_owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    boat_id UUID REFERENCES public.boats(id) ON DELETE SET NULL,
    -- The ship's log voyage id ('voyage_<ms>_<rand>', TEXT like ship_logs.voyage_id); no FK.
    voyage_id TEXT CHECK (voyage_id IS NULL OR char_length(voyage_id) BETWEEN 1 AND 80),
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'crew', 'public')),

    -- What was seen. scientific_name NULL = the group only (Darwin Core then
    -- carries the group's placeholder taxon).
    taxon_group TEXT NOT NULL
        CHECK (taxon_group IN ('whale', 'dolphin', 'dugong', 'turtle', 'seabird', 'shark_ray', 'fish', 'other')),
    scientific_name TEXT CHECK (scientific_name IS NULL OR char_length(scientific_name) BETWEEN 3 AND 120),
    vernacular_name TEXT,
    taxon_rank TEXT,
    individual_count INTEGER NOT NULL DEFAULT 1 CHECK (individual_count BETWEEN 1 AND 10000),
    count_is_estimate BOOLEAN NOT NULL DEFAULT false,
    has_calf BOOLEAN NOT NULL DEFAULT false,
    behavior TEXT CHECK (behavior IS NULL OR char_length(behavior) BETWEEN 1 AND 60),
    observed_distance_m INTEGER CHECK (observed_distance_m IS NULL OR observed_distance_m IN (100, 500, 1000, 3000)),

    -- When.
    event_date TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Where: the observing vessel's position (or the phone's, tagged).
    decimal_latitude DOUBLE PRECISION NOT NULL CHECK (decimal_latitude BETWEEN -90 AND 90),
    decimal_longitude DOUBLE PRECISION NOT NULL CHECK (decimal_longitude BETWEEN -180 AND 180),
    position_accuracy_m INTEGER CHECK (position_accuracy_m IS NULL OR position_accuracy_m BETWEEN 1 AND 100000),
    coordinate_uncertainty_in_meters INTEGER
        CHECK (coordinate_uncertainty_in_meters IS NULL OR coordinate_uncertainty_in_meters BETWEEN 1 AND 100000),
    position_source TEXT NOT NULL CHECK (position_source IN ('bus', 'pi', 'cloud', 'phone')),
    position_fix_at TIMESTAMPTZ,
    sampling_protocol TEXT NOT NULL DEFAULT 'opportunistic vessel-based observation'
        CHECK (sampling_protocol IN ('opportunistic vessel-based observation', 'opportunistic shore-based observation')),

    -- Context, each tagged with where it came from.
    sea_temp_c REAL CHECK (sea_temp_c IS NULL OR sea_temp_c BETWEEN -3 AND 40),
    sea_temp_source TEXT CHECK (sea_temp_source IS NULL OR sea_temp_source IN ('instrument', 'forecast')),
    water_depth_m REAL CHECK (water_depth_m IS NULL OR water_depth_m BETWEEN 0 AND 12000),
    depth_reference TEXT
        CHECK (depth_reference IS NULL OR depth_reference IN ('below-transducer', 'below-waterline', 'below-keel')),
    wind_speed_kts REAL CHECK (wind_speed_kts IS NULL OR wind_speed_kts BETWEEN 0 AND 200),
    wind_dir_deg SMALLINT CHECK (wind_dir_deg IS NULL OR wind_dir_deg BETWEEN 0 AND 360),
    wind_source TEXT CHECK (wind_source IS NULL OR wind_source IN ('instrument', 'forecast')),
    wave_height_m REAL CHECK (wave_height_m IS NULL OR wave_height_m BETWEEN 0 AND 30),
    wx_model TEXT CHECK (wx_model IS NULL OR char_length(wx_model) BETWEEN 1 AND 60),
    sog_kts REAL CHECK (sog_kts IS NULL OR sog_kts BETWEEN 0 AND 80),
    cog_deg SMALLINT CHECK (cog_deg IS NULL OR cog_deg BETWEEN 0 AND 360),
    heading_deg SMALLINT CHECK (heading_deg IS NULL OR heading_deg BETWEEN 0 AND 360),

    -- Crew / Private only: no public path returns these.
    occurrence_remarks TEXT CHECK (occurrence_remarks IS NULL OR char_length(occurrence_remarks) BETWEEN 1 AND 1000),
    photo_paths TEXT[] NOT NULL DEFAULT '{}'::TEXT[] CHECK (cardinality(photo_paths) <= 4),
    observer_display TEXT CHECK (observer_display IS NULL OR char_length(observer_display) BETWEEN 1 AND 60),

    credit_public BOOLEAN NOT NULL DEFAULT false,
    -- Set by the trigger, never by a client: once named as a threatened
    -- species, the public copy stays on the coarse grid whatever it is renamed to.
    ever_sensitive BOOLEAN NOT NULL DEFAULT false,
    basis_of_record TEXT NOT NULL DEFAULT 'HumanObservation' CHECK (basis_of_record = 'HumanObservation'),
    client_version TEXT CHECK (client_version IS NULL OR char_length(client_version) BETWEEN 1 AND 40),

    CONSTRAINT sightings_not_null_island CHECK (NOT (decimal_latitude = 0 AND decimal_longitude = 0)),
    CONSTRAINT sightings_fish_never_public CHECK (NOT (taxon_group = 'fish' AND visibility = 'public')),
    CONSTRAINT sightings_crew_needs_a_boat CHECK (visibility <> 'crew' OR vessel_owner_id IS NOT NULL),
    CONSTRAINT sightings_boat_needs_its_owner CHECK (boat_id IS NULL OR vessel_owner_id IS NOT NULL)
);

ALTER TABLE public.sightings ENABLE ROW LEVEL SECURITY;

-- Signed-in users only, through RLS. UPDATE is column-limited to what an
-- observer may edit; the trigger below holds the same line for every writer.
REVOKE ALL ON TABLE public.sightings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.sightings TO authenticated;
GRANT UPDATE (
    taxon_group,
    scientific_name,
    individual_count,
    count_is_estimate,
    has_calf,
    behavior,
    observed_distance_m,
    occurrence_remarks,
    photo_paths,
    visibility,
    credit_public,
    observer_display,
    client_version
) ON TABLE public.sightings TO authenticated;

COMMENT ON TABLE public.sightings IS
    'Sightings (2026-10-05): wildlife seen from a boat, Darwin Core shaped. private = observer; crew = observer + skipper + accepted crew, live; public = the same crew live, everyone else only via get_public_sightings (3 h late, grid-fuzzed). Fish never public.';

CREATE INDEX IF NOT EXISTS sightings_observer_event_idx ON public.sightings (observer_id, event_date DESC);
CREATE INDEX IF NOT EXISTS sightings_observer_created_idx ON public.sightings (observer_id, created_at);
CREATE INDEX IF NOT EXISTS sightings_vessel_event_idx ON public.sightings (vessel_owner_id, event_date DESC);
CREATE INDEX IF NOT EXISTS sightings_boat_idx ON public.sightings (boat_id) WHERE boat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sightings_public_event_idx
    ON public.sightings (event_date DESC)
    WHERE visibility = 'public' AND taxon_group <> 'fish';
CREATE INDEX IF NOT EXISTS sightings_public_latitude_idx
    ON public.sightings (decimal_latitude)
    WHERE visibility = 'public' AND taxon_group <> 'fish';

-- ── 3. Helpers ──────────────────────────────────────────────────────────────

-- Is the caller this skipper, or his ACCEPTED crew? The read and write test
-- for a boat's sightings. Any accepted membership counts (vessel-level, as
-- can_access_vessel_register and get_crew_vessel_view read it). It answers
-- only about the caller's own memberships, so it is no oracle.
CREATE OR REPLACE FUNCTION public.sighting_vessel_member(p_owner_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT auth.uid() IS NOT NULL
       AND p_owner_id IS NOT NULL
       AND (
            p_owner_id = auth.uid()
            OR EXISTS (
                SELECT 1
                  FROM public.vessel_crew AS m
                 WHERE m.owner_id = p_owner_id
                   AND m.crew_user_id = auth.uid()
                   AND m.status = 'accepted'
            )
       );
$$;

REVOKE ALL ON FUNCTION public.sighting_vessel_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sighting_vessel_member(UUID) TO authenticated;
COMMENT ON FUNCTION public.sighting_vessel_member(UUID) IS
    'Sightings: true when the caller is p_owner_id or accepted crew of p_owner_id (2026-10-05).';

-- The centre of the grid cell a coordinate falls in: 0.01 deg, or 0.1 deg
-- when coarse. Numeric arithmetic, so a value on a cell edge lands in the
-- same cell every time.
CREATE OR REPLACE FUNCTION public.sighting_fuzz(p_value DOUBLE PRECISION, p_coarse BOOLEAN)
RETURNS DOUBLE PRECISION
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT ((floor(p_value::NUMERIC / cell.step) + 0.5) * cell.step)::DOUBLE PRECISION
      FROM (SELECT (CASE WHEN p_coarse THEN 0.1 ELSE 0.01 END)::NUMERIC AS step) AS cell;
$$;

REVOKE ALL ON FUNCTION public.sighting_fuzz(DOUBLE PRECISION, BOOLEAN) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.sighting_fuzz(DOUBLE PRECISION, BOOLEAN) IS
    'Sightings: grid-cell centre, 0.01 deg or 0.1 deg (coarse). Used by get_public_sightings only.';

-- ── 4. The write guard ──────────────────────────────────────────────────────

-- SECURITY DEFINER because a crew member's hull pick reads the skipper's
-- boats and active selection, which their own RLS does not show them. It
-- reads only the caller's JWT and the rows it validates against.
CREATE OR REPLACE FUNCTION public.sightings_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    actor UUID := auth.uid();
    taxon_group_found TEXT;
    taxon_vernacular TEXT;
    taxon_rank_found TEXT;
    taxon_sensitive BOOLEAN;
    hull UUID;
    nearby INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.created_at := now();
        NEW.ever_sensitive := false;

        IF actor IS NOT NULL AND NEW.observer_id IS DISTINCT FROM actor THEN
            RAISE EXCEPTION 'A sighting is logged by its own observer' USING ERRCODE = '42501';
        END IF;

        IF NEW.event_date < now() - INTERVAL '60 days' OR NEW.event_date > now() + INTERVAL '5 minutes' THEN
            RAISE EXCEPTION 'A sighting''s time must be within the last 60 days' USING ERRCODE = '23514';
        END IF;

        IF NEW.vessel_owner_id IS NULL THEN
            NEW.boat_id := NULL;
        ELSE
            IF actor IS NOT NULL AND NOT public.sighting_vessel_member(NEW.vessel_owner_id) THEN
                RAISE EXCEPTION 'Sightings can only be logged on your own boat or one you are crew on'
                    USING ERRCODE = '42501';
            END IF;

            IF NEW.boat_id IS NOT NULL AND NOT EXISTS (
                SELECT 1
                  FROM public.boats AS b
                 WHERE b.id = NEW.boat_id
                   AND b.owner_id = NEW.vessel_owner_id
                   AND b.archived_at IS NULL
            ) THEN
                NEW.boat_id := NULL;
            END IF;

            IF NEW.boat_id IS NULL THEN
                -- get_crew_vessel_view's hull pick: the hull the observer is a
                -- member of, then the skipper's active selection, then the
                -- most recently updated; never archived.
                SELECT boat.id
                  INTO hull
                  FROM public.boats AS boat
                  LEFT JOIN public.boat_members AS me
                    ON me.boat_id = boat.id
                   AND me.user_id = NEW.observer_id
                  LEFT JOIN public.user_active_vessels AS active
                    ON active.user_id = boat.owner_id
                   AND active.boat_id = boat.id
                 WHERE boat.owner_id = NEW.vessel_owner_id
                   AND boat.archived_at IS NULL
                 ORDER BY (me.user_id IS NOT NULL) DESC, (active.boat_id IS NOT NULL) DESC, boat.updated_at DESC, boat.id
                 LIMIT 1;
                NEW.boat_id := hull;
            END IF;
        END IF;

        IF actor IS NOT NULL THEN
            SELECT count(*)
              INTO nearby
              FROM public.sightings AS s
             WHERE s.observer_id = NEW.observer_id
               AND s.event_date BETWEEN NEW.event_date - INTERVAL '30 minutes' AND NEW.event_date + INTERVAL '30 minutes';
            IF nearby >= 60 THEN
                RAISE EXCEPTION 'Too many sightings in one hour' USING ERRCODE = 'P0001';
            END IF;

            SELECT count(*)
              INTO nearby
              FROM public.sightings AS s
             WHERE s.observer_id = NEW.observer_id
               AND s.created_at > now() - INTERVAL '24 hours';
            IF nearby >= 1000 THEN
                RAISE EXCEPTION 'Too many sightings in one day' USING ERRCODE = 'P0001';
            END IF;
        END IF;
    ELSE
        IF NEW.id IS DISTINCT FROM OLD.id THEN
            RAISE EXCEPTION 'A sighting keeps its id' USING ERRCODE = '22023';
        END IF;
        NEW.observer_id := OLD.observer_id;
        NEW.created_at := OLD.created_at;
        NEW.ever_sensitive := OLD.ever_sensitive;

        IF NEW.event_date IS DISTINCT FROM OLD.event_date
           OR NEW.decimal_latitude IS DISTINCT FROM OLD.decimal_latitude
           OR NEW.decimal_longitude IS DISTINCT FROM OLD.decimal_longitude
           OR NEW.position_accuracy_m IS DISTINCT FROM OLD.position_accuracy_m
           OR NEW.coordinate_uncertainty_in_meters IS DISTINCT FROM OLD.coordinate_uncertainty_in_meters
           OR NEW.position_source IS DISTINCT FROM OLD.position_source
           OR NEW.position_fix_at IS DISTINCT FROM OLD.position_fix_at
           OR NEW.sampling_protocol IS DISTINCT FROM OLD.sampling_protocol
           OR NEW.voyage_id IS DISTINCT FROM OLD.voyage_id
           OR NEW.sea_temp_c IS DISTINCT FROM OLD.sea_temp_c
           OR NEW.sea_temp_source IS DISTINCT FROM OLD.sea_temp_source
           OR NEW.water_depth_m IS DISTINCT FROM OLD.water_depth_m
           OR NEW.depth_reference IS DISTINCT FROM OLD.depth_reference
           OR NEW.wind_speed_kts IS DISTINCT FROM OLD.wind_speed_kts
           OR NEW.wind_dir_deg IS DISTINCT FROM OLD.wind_dir_deg
           OR NEW.wind_source IS DISTINCT FROM OLD.wind_source
           OR NEW.wave_height_m IS DISTINCT FROM OLD.wave_height_m
           OR NEW.wx_model IS DISTINCT FROM OLD.wx_model
           OR NEW.sog_kts IS DISTINCT FROM OLD.sog_kts
           OR NEW.cog_deg IS DISTINCT FROM OLD.cog_deg
           OR NEW.heading_deg IS DISTINCT FROM OLD.heading_deg THEN
            RAISE EXCEPTION 'Where and when a sighting happened cannot change: delete it and log it again'
                USING ERRCODE = '22023';
        END IF;

        -- The boat may only go away (FK SET NULL, the deletion scrub), never move.
        IF NEW.vessel_owner_id IS DISTINCT FROM OLD.vessel_owner_id THEN
            IF NEW.vessel_owner_id IS NOT NULL THEN
                RAISE EXCEPTION 'A sighting cannot move to another boat' USING ERRCODE = '22023';
            END IF;
            NEW.boat_id := NULL;
            IF NEW.visibility = 'crew' THEN
                NEW.visibility := 'private';
            END IF;
        END IF;
        IF NEW.boat_id IS DISTINCT FROM OLD.boat_id AND NEW.boat_id IS NOT NULL THEN
            RAISE EXCEPTION 'A sighting cannot move to another boat' USING ERRCODE = '22023';
        END IF;
    END IF;

    NEW.updated_at := now();
    NEW.basis_of_record := 'HumanObservation';

    -- On UPDATE only when the species or group changed, so a catalogue
    -- revision can never block the FK SET NULL actions or the deletion scrub.
    IF TG_OP = 'UPDATE'
       AND NEW.scientific_name IS NOT DISTINCT FROM OLD.scientific_name
       AND NEW.taxon_group IS NOT DISTINCT FROM OLD.taxon_group THEN
        NEW.vernacular_name := OLD.vernacular_name;
        NEW.taxon_rank := OLD.taxon_rank;
    ELSIF NEW.scientific_name IS NULL THEN
        NEW.vernacular_name := NULL;
        NEW.taxon_rank := NULL;
    ELSE
        SELECT t.taxon_group, t.vernacular_name, t.taxon_rank, t.sensitive
          INTO taxon_group_found, taxon_vernacular, taxon_rank_found, taxon_sensitive
          FROM public.sighting_taxa AS t
         WHERE t.scientific_name = NEW.scientific_name;
        IF NOT FOUND OR taxon_group_found IS DISTINCT FROM NEW.taxon_group THEN
            RAISE EXCEPTION 'That species is not in the catalogue for that group' USING ERRCODE = '23514';
        END IF;
        NEW.vernacular_name := taxon_vernacular;
        NEW.taxon_rank := taxon_rank_found;
        -- Sticky: once named as threatened, the public copy stays coarse.
        IF taxon_sensitive THEN
            NEW.ever_sensitive := true;
        END IF;
    END IF;

    IF (TG_OP = 'INSERT' OR NEW.photo_paths IS DISTINCT FROM OLD.photo_paths)
       AND cardinality(NEW.photo_paths) > 0 AND (
        (SELECT count(DISTINCT u.p) FROM unnest(NEW.photo_paths) AS u(p)) <> cardinality(NEW.photo_paths)
        OR EXISTS (
            SELECT 1
              FROM unnest(NEW.photo_paths) AS u(p)
             WHERE u.p IS NULL
                OR u.p !~ ('^' || NEW.observer_id::TEXT || '/' || NEW.id::TEXT || '/[0-3]\.jpg$')
        )
    ) THEN
        RAISE EXCEPTION 'A sighting lists only its own photos' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sightings_before_write() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.sightings_before_write() IS
    'BEFORE INSERT OR UPDATE on sightings (2026-10-05): own observer, own or accepted-crew boat, hull pick, catalogue species, sticky ever_sensitive, immutable where/when, own photo paths, rate caps.';

DROP TRIGGER IF EXISTS sightings_before_write ON public.sightings;
CREATE TRIGGER sightings_before_write
    BEFORE INSERT OR UPDATE ON public.sightings
    FOR EACH ROW EXECUTE FUNCTION public.sightings_before_write();

-- A deleted account's tombstone refuses new writes, as on every user-owned
-- table (20260806120000_account_deletion_durability.sql). Fires first (name order).
DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.sightings;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.sightings
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('observer_id');

-- ── 5. Row level security ───────────────────────────────────────────────────

DROP POLICY IF EXISTS "Sightings: observer and boat read" ON public.sightings;
CREATE POLICY "Sightings: observer and boat read"
    ON public.sightings FOR SELECT TO authenticated
    USING (
        observer_id = auth.uid()
        OR (
            visibility IN ('crew', 'public')
            AND vessel_owner_id IS NOT NULL
            AND public.sighting_vessel_member(vessel_owner_id)
        )
    );

DROP POLICY IF EXISTS "Sightings: log your own" ON public.sightings;
CREATE POLICY "Sightings: log your own"
    ON public.sightings FOR INSERT TO authenticated
    WITH CHECK (
        observer_id = auth.uid()
        AND (vessel_owner_id IS NULL OR public.sighting_vessel_member(vessel_owner_id))
    );

-- Removed crew keep their rows but cannot share them with the boat again.
DROP POLICY IF EXISTS "Sightings: edit your own" ON public.sightings;
CREATE POLICY "Sightings: edit your own"
    ON public.sightings FOR UPDATE TO authenticated
    USING (observer_id = auth.uid())
    WITH CHECK (
        observer_id = auth.uid()
        AND (vessel_owner_id IS NULL OR visibility = 'private' OR public.sighting_vessel_member(vessel_owner_id))
    );

DROP POLICY IF EXISTS "Sightings: delete your own" ON public.sightings;
CREATE POLICY "Sightings: delete your own"
    ON public.sightings FOR DELETE TO authenticated
    USING (observer_id = auth.uid());

-- ── 6. The public read: three hours late, on a grid ─────────────────────────

CREATE OR REPLACE FUNCTION public.get_public_sightings(
    p_south DOUBLE PRECISION,
    p_west DOUBLE PRECISION,
    p_north DOUBLE PRECISION,
    p_east DOUBLE PRECISION,
    p_before TIMESTAMPTZ DEFAULT NULL,
    p_before_id UUID DEFAULT NULL,
    p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
    sighting_id UUID,
    taxon_group TEXT,
    scientific_name TEXT,
    vernacular_name TEXT,
    taxon_rank TEXT,
    individual_count INTEGER,
    has_calf BOOLEAN,
    event_time TIMESTAMPTZ,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    uncertainty_m INTEGER,
    generalised BOOLEAN,
    credit TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    cutoff TIMESTAMPTZ := now() - INTERVAL '3 hours';
    lim INTEGER := greatest(1, least(200, COALESCE(p_limit, 100)));
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN;
    END IF;

    IF p_south IS NULL OR p_west IS NULL OR p_north IS NULL OR p_east IS NULL
       OR p_south < -90 OR p_north > 90 OR p_south >= p_north
       OR p_west < -180 OR p_east > 180 OR p_west >= p_east
       OR p_north - p_south > 30 OR p_east - p_west > 30 THEN
        RAISE EXCEPTION 'A sightings box is south < north, west < east, at most 30 degrees each way'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH candidates AS (
        SELECT s.id AS c_id,
               s.observer_id AS c_observer,
               s.boat_id AS c_boat,
               s.taxon_group AS c_group,
               s.scientific_name AS c_name,
               t.vernacular_name AS c_vernacular,
               t.taxon_rank AS c_rank,
               s.individual_count AS c_count,
               s.has_calf AS c_calf,
               s.event_date AS c_event,
               greatest(s.created_at, s.event_date) AS c_seen,
               s.decimal_latitude AS c_lat,
               s.decimal_longitude AS c_lon,
               s.coordinate_uncertainty_in_meters AS c_uncertainty,
               s.credit_public AS c_credit,
               -- Coarse: any group-only row, a row ever named as threatened,
               -- and a named species by its catalogue flag (unknown = coarse).
               (s.scientific_name IS NULL OR s.ever_sensitive OR COALESCE(t.sensitive, true)) AS c_coarse
          FROM public.sightings AS s
          LEFT JOIN public.sighting_taxa AS t
            ON t.scientific_name = s.scientific_name
         WHERE s.visibility = 'public'
           AND s.taxon_group <> 'fish'
           -- Pre-filters only: the bucket gate below decides.
           AND s.created_at <= cutoff
           AND s.event_date <= cutoff
           AND s.decimal_latitude BETWEEN p_south - 0.1 AND p_north + 0.1
           AND s.decimal_longitude BETWEEN p_west - 0.1 AND p_east + 0.1
    ),
    bucketed AS (
        SELECT c.*,
               CASE WHEN c.c_coarse THEN INTERVAL '1 hour' ELSE INTERVAL '10 minutes' END AS c_bucket
          FROM candidates AS c
    ),
    fuzzed AS (
        SELECT b.*,
               public.sighting_fuzz(b.c_lat, b.c_coarse) AS f_lat,
               public.sighting_fuzz(b.c_lon, b.c_coarse) AS f_lon,
               CASE
                   WHEN b.c_coarse THEN date_trunc('hour', b.c_event, 'UTC')
                   ELSE date_bin(INTERVAL '10 minutes', b.c_event, TIMESTAMPTZ '2000-01-01 00:00:00+00')
               END AS f_time,
               -- Per precision, so the fine and coarse copies of one row do not link.
               md5(b.c_id::TEXT || CASE WHEN b.c_coarse THEN ':coarse' ELSE ':fine' END)::UUID AS f_id
          FROM bucketed AS b
         -- A row appears only once its whole bucket is 3 hours old, so the
         -- moment it first appears says no more than its floored time.
         WHERE date_bin(b.c_bucket, b.c_seen, TIMESTAMPTZ '2000-01-01 00:00:00+00') + b.c_bucket <= cutoff
    )
    SELECT f.f_id,
           f.c_group,
           f.c_name,
           f.c_vernacular,
           f.c_rank,
           f.c_count,
           f.c_calf,
           f.f_time,
           f.f_lat,
           f.f_lon,
           greatest(CASE WHEN f.c_coarse THEN 7850 ELSE 790 END, COALESCE(f.c_uncertainty, 0)),
           f.c_coarse,
           -- Never on a coarse row: a credited public voyage log's track would
           -- place a threatened animal better than its 8 km cell.
           CASE
               WHEN f.c_credit AND NOT f.c_coarse THEN (
                   SELECT cfg.handle
                     FROM public.voyage_log_configs AS cfg
                    WHERE cfg.owner_id = f.c_observer
                      AND cfg.enabled
                      AND cfg.handle IS NOT NULL
                    ORDER BY COALESCE(cfg.boat_id = f.c_boat, false) DESC,
                             (cfg.scope = 'personal') DESC,
                             cfg.created_at,
                             cfg.id
                    LIMIT 1
               )
           END
      FROM fuzzed AS f
     -- The box is tested on the FUZZED point only.
     WHERE f.f_lat BETWEEN p_south AND p_north
       AND f.f_lon BETWEEN p_west AND p_east
       AND (
            p_before IS NULL
            OR (f.f_time, f.f_id) < (p_before, COALESCE(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::UUID))
       )
     ORDER BY f.f_time DESC, f.f_id DESC
     LIMIT lim;
END;
$$;

REVOKE ALL ON FUNCTION public.get_public_sightings(
    DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, UUID, INTEGER
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_public_sightings(
    DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, UUID, INTEGER
) TO authenticated;
COMMENT ON FUNCTION public.get_public_sightings(
    DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, UUID, INTEGER
) IS
    'Sightings public read (2026-10-05): public non-fish rows whose whole 10-minute (fine) or hour (coarse) bucket is 3 h old by server and event time, on a 0.01/0.1 deg grid (coarse: threatened, ever named threatened, or group-only), time floored, per-precision ids, box tested on the fuzzed point, no credit on coarse rows; no photos, remarks, observer, boat or voyage. Signed-in callers only. Page with (event_time, sighting_id) of the last row.';

-- ── 7. Realtime: the crew feed ──────────────────────────────────────────────

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
       AND NOT EXISTS (
           SELECT 1
             FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = 'sightings'
       ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.sightings;
    END IF;
END;
$$;

-- ── 8. Photos ───────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('sighting-photos', 'sighting-photos', false, 2097152, ARRAY['image/jpeg']::TEXT[])
ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Sighting photos: upload to your own folder" ON storage.objects;
CREATE POLICY "Sighting photos: upload to your own folder"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'sighting-photos'
        AND split_part(name, '/', 1) = auth.uid()::TEXT
        AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-3]\.jpg$'
    );

DROP POLICY IF EXISTS "Sighting photos: delete your own" ON storage.objects;
CREATE POLICY "Sighting photos: delete your own"
    ON storage.objects FOR DELETE TO authenticated
    USING (
        bucket_id = 'sighting-photos'
        AND split_part(name, '/', 1) = auth.uid()::TEXT
    );

-- Yours, or a photo a row you can read lists (that row's own observer and
-- id, so the row cannot name someone else's). The row read runs under the
-- reader's RLS: crew open crew rows' photos, strangers open nothing. No
-- UPDATE policy: photos are never overwritten.
DROP POLICY IF EXISTS "Sighting photos: read yours and your boat's" ON storage.objects;
CREATE POLICY "Sighting photos: read yours and your boat's"
    ON storage.objects FOR SELECT TO authenticated
    USING (
        bucket_id = 'sighting-photos'
        AND (
            split_part(name, '/', 1) = auth.uid()::TEXT
            OR CASE
                WHEN name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-3]\.jpg$'
                THEN EXISTS (
                    SELECT 1
                      FROM public.sightings AS s
                     WHERE s.id = split_part(objects.name, '/', 2)::UUID
                       AND s.observer_id = split_part(objects.name, '/', 1)::UUID
                       AND objects.name = ANY (s.photo_paths)
                )
                ELSE false
            END
        )
    );
