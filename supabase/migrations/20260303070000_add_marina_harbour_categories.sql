-- Add marina_exit and harbour_entry categories to shared_tracks
-- Migration: 20260303_add_marina_harbour_categories.sql
--
-- Context: Community route sharing now supports marina exit and harbour
-- entry routes. These are contributed by experienced skippers to help
-- others navigate unfamiliar coastal approaches.
--
-- Also adds pin_* categories for local service waypoints.

ALTER TABLE shared_tracks DROP CONSTRAINT IF EXISTS shared_tracks_category_check;
ALTER TABLE shared_tracks ADD CONSTRAINT shared_tracks_category_check
    CHECK (category IN (
        'anchorage', 'port_entry', 'marina_exit', 'harbour_entry',
        'walking', 'reef_passage', 'coastal', 'offshore',
        'bar_crossing', 'driving',
        'pin_repairs', 'pin_food', 'pin_fuel', 'pin_supplies', 'pin_scenic'
    ));
