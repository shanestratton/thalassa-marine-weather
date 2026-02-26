#!/usr/bin/env python3
"""Analyze seamark types in nav_markers.geojson."""
import json

with open("nav_markers.geojson", "r", encoding="utf-8") as f:
    data = json.load(f)

features = data.get("features", [])
print(f"Total features: {len(features)}")

# Count by _class
by_class = {}
by_type = {}
for feat in features:
    props = feat.get("properties", {})
    cls = props.get("_class", "unknown")
    typ = props.get("seamark:type", props.get("type", "unknown"))
    by_class[cls] = by_class.get(cls, 0) + 1
    by_type[typ] = by_type.get(typ, 0) + 1

print("\nBy _class:")
for cls, count in sorted(by_class.items(), key=lambda x: -x[1]):
    print(f"  {cls}: {count}")

print("\nBy seamark:type:")
for typ, count in sorted(by_type.items(), key=lambda x: -x[1]):
    print(f"  {typ}: {count}")

# Check for common land-based types
print("\nSample 'danger' features:")
for feat in features:
    if feat.get("properties", {}).get("_class") == "danger":
        print(f"  {feat['properties']}")
        break

print("\nSample 'special' features:")
for feat in features:
    if feat.get("properties", {}).get("_class") == "special":
        print(f"  {feat['properties']}")
        break

print("\nSample 'light' features:")
for feat in features:
    if feat.get("properties", {}).get("_class") == "light":
        print(f"  {feat['properties']}")
        break
