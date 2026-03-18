-- ============================================================================
-- Guardian Profiles — Maritime Neighborhood Watch Identity Layer
--
-- Links Thalassa users to their vessel's MMSI for the Guardian safety system.
-- Stores arm/disarm state, geofence home, and vessel identity.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

-- ── Guardian Profiles ──
CREATE TABLE IF NOT EXISTS public.guardian_profiles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    mmsi BIGINT UNIQUE,                       -- Claimed AIS identity (one per user)
    mmsi_verified BOOLEAN DEFAULT false,      -- Verified via course-change challenge
    vessel_name TEXT,                          -- "S/V Poodle Power"
    vessel_bio TEXT,                           -- Free-text vessel description
    owner_name TEXT,                           -- "Shane"
    dog_name TEXT,                             -- Critical field 🐕
    
    -- ARM / BOLO state
    armed BOOLEAN DEFAULT false,              -- BOLO arm state
    armed_at TIMESTAMPTZ,                     -- When armed was activated
    armed_location GEOGRAPHY(POINT, 4326),    -- Position when armed (for 50m movement check)
    
    -- Digital Tripwire (Geofence)
    home_coordinate GEOGRAPHY(POINT, 4326),   -- Geofence home base
    home_radius_m REAL DEFAULT 100,           -- Geofence radius in meters
    
    -- Last known position from app GPS heartbeat
    last_known_lat DOUBLE PRECISION,
    last_known_lon DOUBLE PRECISION,
    last_known_at TIMESTAMPTZ,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Spatial index for proximity queries on last known position
CREATE INDEX IF NOT EXISTS guardian_profiles_location_idx
    ON public.guardian_profiles
    USING GIST (
        ST_SetSRID(ST_MakePoint(
            COALESCE(last_known_lon, 0),
            COALESCE(last_known_lat, 0)
        ), 4326)::geography
    )
    WHERE last_known_lat IS NOT NULL AND last_known_lon IS NOT NULL;

-- Index for armed vessel watchdog queries
CREATE INDEX IF NOT EXISTS guardian_profiles_armed_idx
    ON public.guardian_profiles (armed)
    WHERE armed = true;

-- ── RLS ──
ALTER TABLE public.guardian_profiles ENABLE ROW LEVEL SECURITY;

-- Everyone can see Guardian profiles (for Bay Presence discovery)
CREATE POLICY "Guardian profiles are readable by authenticated users"
    ON public.guardian_profiles FOR SELECT
    TO authenticated
    USING (true);

-- Users can create/update their own profile
CREATE POLICY "Users can insert own guardian profile"
    ON public.guardian_profiles FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own guardian profile"
    ON public.guardian_profiles FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Service role can update any profile (for Railway Watchdog)
CREATE POLICY "Service role can manage all guardian profiles"
    ON public.guardian_profiles FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- ── RPC: Find Thalassa users near a point (Bay Presence) ──
CREATE OR REPLACE FUNCTION public.thalassa_users_nearby(
    query_lat DOUBLE PRECISION,
    query_lon DOUBLE PRECISION,
    radius_nm DOUBLE PRECISION DEFAULT 5
)
RETURNS TABLE (
    user_id UUID,
    vessel_name TEXT,
    owner_name TEXT,
    dog_name TEXT,
    mmsi BIGINT,
    armed BOOLEAN,
    distance_nm DOUBLE PRECISION,
    last_known_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        gp.user_id,
        gp.vessel_name,
        gp.owner_name,
        gp.dog_name,
        gp.mmsi,
        gp.armed,
        -- Convert meters to nautical miles (1 NM = 1852 m)
        ST_Distance(
            ST_SetSRID(ST_MakePoint(gp.last_known_lon, gp.last_known_lat), 4326)::geography,
            ST_SetSRID(ST_MakePoint(query_lon, query_lat), 4326)::geography
        ) / 1852.0 AS distance_nm,
        gp.last_known_at
    FROM public.guardian_profiles gp
    WHERE gp.last_known_lat IS NOT NULL
      AND gp.last_known_lon IS NOT NULL
      -- Only include profiles with recent position (within 24 hours)
      AND gp.last_known_at > NOW() - INTERVAL '24 hours'
      -- Spatial filter: within radius (convert NM to meters)
      AND ST_DWithin(
          ST_SetSRID(ST_MakePoint(gp.last_known_lon, gp.last_known_lat), 4326)::geography,
          ST_SetSRID(ST_MakePoint(query_lon, query_lat), 4326)::geography,
          radius_nm * 1852
      )
    ORDER BY distance_nm ASC
    LIMIT 50;
$$;

-- ── RPC: Update last known position (GPS heartbeat from app) ──
CREATE OR REPLACE FUNCTION public.guardian_heartbeat(
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO public.guardian_profiles (user_id, last_known_lat, last_known_lon, last_known_at)
    VALUES (auth.uid(), lat, lon, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
        last_known_lat = EXCLUDED.last_known_lat,
        last_known_lon = EXCLUDED.last_known_lon,
        last_known_at = NOW(),
        updated_at = NOW();
END;
$$;

-- ── RPC: ARM vessel (BOLO system) ──
CREATE OR REPLACE FUNCTION public.guardian_arm(
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.guardian_profiles
    SET armed = true,
        armed_at = NOW(),
        armed_location = ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
        updated_at = NOW()
    WHERE user_id = auth.uid();
    
    RETURN FOUND;
END;
$$;

-- ── RPC: DISARM vessel ──
CREATE OR REPLACE FUNCTION public.guardian_disarm()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.guardian_profiles
    SET armed = false,
        armed_at = NULL,
        armed_location = NULL,
        updated_at = NOW()
    WHERE user_id = auth.uid();
    
    RETURN FOUND;
END;
$$;

-- Enable Realtime for guardian_profiles (for live Bay Presence updates)
ALTER PUBLICATION supabase_realtime ADD TABLE guardian_profiles;
