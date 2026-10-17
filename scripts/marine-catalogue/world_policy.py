"""140-01's separate global scope. Does not relax regional facilities caps."""
import re

REGIONS = frozenset(("africa", "antarctica", "asia", "australia-oceania", "central-america", "europe", "north-america", "south-america"))
COHORTS = frozenset("https://download.geofabrik.de/" + region for region in REGIONS)
KINDS = ("marina", "fuel", "boat_ramp", "pump_out")
SELECTORS = (
    "nwr/leisure=marina,slipway", "nwr/service=slipway", "nwr/waterway=fuel,sanitary_dump_station",
    "nwr/amenity=sanitary_dump_station", "nwr/seamark:type=small_craft_facility,bunker_station",
)

def download_deadline_seconds(source):
    """World-only transfer budget at4MiB/s, bounded to1–3 hours per source.

    The first wx trial measured about5.8MB/s. Europe alone is35.24GB;
    the regional one-hour budget cannot admit that legitimate original.
    The separate24-hour service limit remains authoritative.
    """
    cohort = re.sub(r"-(?:latest|\d{6})\.osm\.pbf$", "", source.get("url", ""))
    maximum = source.get("maxBytes")
    if cohort not in COHORTS or type(maximum) is not int or not 0 < maximum <= 64 * 1024**3:
        raise ValueError("World transfer budget requires an original admitted continental source")
    return max(3600, min(10800, (maximum + 4 * 1024**2 - 1) // (4 * 1024**2)))

def validate_sources(rows):
    sources = [re.sub(r"-(?:latest|\d{6})\.osm\.pbf$", "", row.get("sourceUrl", row.get("url", ""))) for row in rows]
    if len(sources) != 8 or set(sources) != COHORTS:
        raise ValueError("Worldwide facilities requires exactly the eight original continental source cohorts")

def validate_cohorts(rows):
    if len(rows) != 8 or {row.get("id") for row in rows} != COHORTS:
        raise ValueError("Worldwide facilities cannot omit or invent a continental cohort")
