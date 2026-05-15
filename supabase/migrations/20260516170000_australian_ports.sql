-- ═══════════════════════════════════════════════════════════════
-- Australian seaports — destination geocode fix
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
--
-- Why this exists
-- ────────────────
-- The route planner geocodes user-typed destinations (e.g. "Port of
-- Brisbane") through Mapbox + a fallback chain. Mapbox's "Port of
-- Brisbane" lookup historically lands at the cargo gate / road
-- centroid — about 2.5 km NW of the actual port pinpoint and well
-- west of the marked shipping channel. A* then routes to those off-
-- channel coords through coarse-bathymetry CAUTION cells, painting
-- the Brisbane half of every passage plan red.
--
-- Source dataset
-- ──────────────
-- DITRDCSA (federal Department of Infrastructure) "Australian
-- Seaports" — 82 features, Point geometry, schema { Port, FPoE }.
-- Includes all major seaports + minor seaports declared as First
-- Ports of Entry per agriculture.gov.au.
--
--   https://catalogue.data.infrastructure.gov.au/dataset/australian-seaports
--
-- Caveats from the source: "for information purposes only and are
-- not intended for navigation or to precisely locate any particular
-- feature." Fine for us — we're using these as DESTINATION
-- coordinates that then feed the inshore router; the router itself
-- handles the actual nav. 82 ports is enough to cover every common
-- cruising destination on the Australian coast.
--
-- Population: seeded inline in this migration (82 rows).
-- Serving:    services/weather/api/geocoding.ts parseLocation()
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.australian_ports (
    id          INTEGER PRIMARY KEY,    -- DITRDCSA OBJECTID
    name        TEXT    NOT NULL,       -- "Brisbane", "Port Botany", …
    lat         DOUBLE PRECISION NOT NULL,
    lon         DOUBLE PRECISION NOT NULL,
    fpoe        BOOLEAN NOT NULL DEFAULT FALSE, -- First Port of Entry
    source      TEXT    NOT NULL DEFAULT 'DITRDCSA',
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive name lookups dominate the query shape.
CREATE INDEX IF NOT EXISTS idx_aus_ports_name_lower
    ON public.australian_ports (LOWER(name));

-- RLS off — this is reference data the iOS client reads with the
-- anon key. No writes from the client.
ALTER TABLE public.australian_ports DISABLE ROW LEVEL SECURITY;

-- Allow public SELECT via the anon role since RLS is off and the
-- table is intentionally world-readable reference data.
GRANT SELECT ON public.australian_ports TO anon, authenticated;

-- ── Seed: 82 ports from DITRDCSA Australian_Seaports.geojson ───────
-- Generated once from the published GeoJSON. Re-run the migration
-- only if the source publishes a meaningfully changed dataset; the
-- INSERT … ON CONFLICT pattern is idempotent.

INSERT INTO public.australian_ports (id, name, lat, lon, fpoe)
VALUES
                    (1, 'Sydney', -33.857800, 151.208630, TRUE),
                    (2, 'Port Botany', -33.969170, 151.222260, TRUE),
                    (3, 'Coffs Harbour', -30.303500, 153.145980, TRUE),
                    (4, 'Eden', -37.102460, 149.929150, TRUE),
                    (5, 'Lord Howe Island', -31.522940, 159.058470, FALSE),
                    (6, 'Newcastle', -32.915100, 151.771460, TRUE),
                    (7, 'Port Kembla', -34.460750, 150.890290, TRUE),
                    (8, 'Jervis Bay', -35.122740, 150.706860, FALSE),
                    (9, 'Darwin', -12.470490, 130.844310, TRUE),
                    (10, 'Melville Bay', -12.192570, 136.686060, TRUE),
                    (11, 'Milner Bay', -13.858330, 136.421580, TRUE),
                    (12, 'Christmas Island', -10.425240, 105.672250, TRUE),
                    (13, 'Macquarie Island', -54.498520, 158.938210, FALSE),
                    (14, 'Port Kennedy', -10.585050, 142.221250, TRUE),
                    (15, 'Brisbane', -27.374630, 153.170980, TRUE),
                    (16, 'Cairns', -16.939510, 145.776670, TRUE),
                    (17, 'Bowen (Abbot Point)', -19.867260, 148.065420, TRUE),
                    (18, 'Bundaberg', -24.769940, 152.383490, TRUE),
                    (19, 'Gladstone', -23.829620, 151.239200, TRUE),
                    (20, 'Hay Point', -21.275480, 149.292220, TRUE),
                    (21, 'Karumba', -17.495190, 140.830630, FALSE),
                    (22, 'Lockhart River (Quintell Beach)', -12.794790, 143.359570, FALSE),
                    (23, 'Lucinda', -18.524120, 146.331220, TRUE),
                    (24, 'Mackay', -21.106170, 149.221890, TRUE),
                    (25, 'Mourilyan', -17.598800, 146.120800, TRUE),
                    (26, 'Port Alma', -23.582950, 150.861540, TRUE),
                    (27, 'Townsville', -19.249980, 146.836960, FALSE),
                    (28, 'Weipa', -12.669390, 141.870080, TRUE),
                    (29, 'Cooktown', -15.459890, 145.249790, FALSE),
                    (30, 'Fitzalan Passage (Hamilton Island, Whitsundays)', -20.347590, 148.952280, FALSE),
                    (31, 'Coral Sea Marina, Airlie Beach', -20.272550, 148.724370, TRUE),
                    (32, 'Percy Island', -21.654190, 150.245390, FALSE),
                    (33, 'Port Adelaide', -34.775700, 138.485130, TRUE),
                    (34, 'Ardrossan', -34.437880, 137.914180, TRUE),
                    (35, 'Port Bonython', -32.989730, 137.767680, TRUE),
                    (36, 'Port Giles', -35.022160, 137.760660, TRUE),
                    (37, 'Port Lincoln', -34.721860, 135.868990, TRUE),
                    (38, 'Port Pirie', -33.169440, 138.012550, TRUE),
                    (39, 'Thevenard', -32.148180, 133.652810, TRUE),
                    (40, 'Wallaroo', -33.930160, 137.619300, TRUE),
                    (41, 'Hobart', -42.880400, 147.340400, TRUE),
                    (42, 'Burnie', -41.052240, 145.909780, TRUE),
                    (43, 'Devonport', -41.181920, 146.367110, TRUE),
                    (44, 'Launceston (Bell Bay)', -41.135340, 146.859790, TRUE),
                    (45, 'Port Latta', -40.851270, 145.382160, TRUE),
                    (46, 'Spring Bay', -42.546670, 147.931830, FALSE),
                    (47, 'Stanley', -40.762400, 145.295090, FALSE),
                    (48, 'Wineglass Bay', -42.144330, 148.286390, FALSE),
                    (49, 'Melbourne', -37.812630, 144.918960, TRUE),
                    (50, 'Port Welshpool', -38.709950, 146.386170, FALSE),
                    (51, 'Geelong', -38.109690, 144.363510, TRUE),
                    (52, 'Portland', -38.354260, 141.620140, TRUE),
                    (53, 'Fremantle', -32.050870, 115.734650, TRUE),
                    (54, 'Albany', -35.034100, 117.897290, TRUE),
                    (55, 'Broome', -18.002520, 122.207760, TRUE),
                    (56, 'Bunbury', -33.321090, 115.667370, TRUE),
                    (57, 'Cape Cuvier', -24.225640, 113.394130, FALSE),
                    (58, 'Cape Preston', -20.841730, 116.207400, FALSE),
                    (59, 'Carnarvon', -24.898810, 113.649640, FALSE),
                    (60, 'Dampier', -20.641890, 116.727400, TRUE),
                    (61, 'Esperance', -33.872520, 121.897500, TRUE),
                    (62, 'Exmouth', -21.954990, 114.138790, FALSE),
                    (63, 'Geraldton', -28.780180, 114.588760, TRUE),
                    (64, 'Onslow', -21.647460, 115.103060, FALSE),
                    (65, 'Port Hedland', -20.314210, 118.579380, TRUE),
                    (66, 'Port Walcott', -20.599010, 117.172220, TRUE),
                    (67, 'Bing Bong', -15.629420, 136.388310, FALSE),
                    (68, 'Cockatoo Island', -16.094190, 123.600230, FALSE),
                    (69, 'Koolan Island', -16.134280, 123.736320, FALSE),
                    (70, 'Cocos (Keeling) Islands', -12.116870, 96.894060, TRUE),
                    (71, 'Derby', -17.292890, 123.609420, FALSE),
                    (72, 'Grassy', -40.064390, 144.059590, FALSE),
                    (73, 'Westernport', -38.301130, 145.220430, TRUE),
                    (74, 'Lady Barron', -40.213940, 148.241990, FALSE),
                    (75, 'Norfolk Island', -29.057790, 167.954650, TRUE),
                    (76, 'Point Wilson', -38.087480, 144.508370, FALSE),
                    (77, 'Useless Loop (Shark Bay)', -26.106520, 113.396260, FALSE),
                    (78, 'Whyalla', -33.013110, 137.595730, TRUE),
                    (79, 'Wyndham', -15.452250, 128.104220, TRUE),
                    (80, 'Yamba', -29.435990, 153.349440, TRUE),
                    (81, 'Yelcher Beach', -14.242000, 129.436060, FALSE),
                    (82, 'Gold Coast Broadwater', -27.968410, 153.424990, TRUE)
ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name,
        lat = EXCLUDED.lat,
        lon = EXCLUDED.lon,
        fpoe = EXCLUDED.fpoe,
        source = EXCLUDED.source,
        fetched_at = now();

-- ═══════════════════════════════════════════════════════════════
-- Done. To inspect after running:
--   SELECT name, lat, lon, fpoe FROM public.australian_ports
--     WHERE LOWER(name) LIKE '%brisbane%';
-- ═══════════════════════════════════════════════════════════════
