"""140-01's separate global scope. Does not relax regional facilities caps."""
import re

REGIONS = frozenset(("africa", "antarctica", "asia", "australia-oceania", "central-america", "europe", "north-america", "south-america"))
COHORTS = frozenset("https://download.geofabrik.de/" + region for region in REGIONS)
KINDS = ("marina", "fuel", "boat_ramp", "pump_out")
SELECTORS = (
    "nwr/leisure=marina,slipway", "nwr/service=slipway", "nwr/waterway=fuel,sanitary_dump_station",
    "nwr/amenity=sanitary_dump_station", "nwr/seamark:type=small_craft_facility,bunker_station",
)

def validate_sources(rows):
    sources = [re.sub(r"-(?:latest|\d{6})\.osm\.pbf$", "", row.get("sourceUrl", row.get("url", ""))) for row in rows]
    if len(sources) != 8 or set(sources) != COHORTS:
        raise ValueError("Worldwide facilities requires exactly the eight original continental source cohorts")

def validate_cohorts(rows):
    if len(rows) != 8 or {row.get("id") for row in rows} != COHORTS:
        raise ValueError("Worldwide facilities cannot omit or invent a continental cohort")
