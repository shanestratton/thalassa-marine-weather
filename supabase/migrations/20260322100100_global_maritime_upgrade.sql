-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Thalassa — Global Maritime Schema Upgrade                                 ║
-- ║  Adds HIN, IMO, flag state, and multi-unit support for international ops. ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- ── Vessel Identity: International Fields ──
ALTER TABLE public.vessel_identity
    ADD COLUMN IF NOT EXISTS hin TEXT,              -- Hull Identification Number (ISO 10087)
    ADD COLUMN IF NOT EXISTS imo_number TEXT,       -- IMO number (7 digits, ships > 100GT)
    ADD COLUMN IF NOT EXISTS flag_state TEXT,       -- Flag state (ISO 3166-1 alpha-2: AU, NZ, US)
    ADD COLUMN IF NOT EXISTS port_of_registry TEXT, -- Home port
    ADD COLUMN IF NOT EXISTS gross_tonnage DECIMAL, -- Gross tonnage (for customs)
    ADD COLUMN IF NOT EXISTS hull_length_m DECIMAL, -- Length overall in metres
    ADD COLUMN IF NOT EXISTS year_built INTEGER,
    ADD COLUMN IF NOT EXISTS hull_material TEXT     -- Fibreglass, Steel, Aluminium, Timber, Ferro
                             DEFAULT 'Fibreglass';

-- ── Ship's Stores: Multi-currency + unit system ──
ALTER TABLE public.inventory_items
    ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'AUD',
    ADD COLUMN IF NOT EXISTS unit_value DECIMAL DEFAULT 0,      -- Value per unit
    ADD COLUMN IF NOT EXISTS unit_system TEXT DEFAULT 'metric'   -- metric | imperial
        CHECK (unit_system IN ('metric', 'imperial'));

-- ── Voyages: Multi-voyage isolation fields ──
ALTER TABLE public.voyages
    ADD COLUMN IF NOT EXISTS voyage_number TEXT,           -- Sequential: V-001, V-002
    ADD COLUMN IF NOT EXISTS ocean_basin TEXT,             -- Pacific, Atlantic, Indian, etc.
    ADD COLUMN IF NOT EXISTS waypoints JSONB DEFAULT '[]'; -- [{lat,lng,name,eta}]
