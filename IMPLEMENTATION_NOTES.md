# Implementation Notes for Static Widget Panel

## Current Challenge
Implementing static 2x5 widget panel in 1509-line HeroSlide component without file corruption.

## Strategy
Due to file size and complexity, taking phased approach:

### Phase 1: Add Wrapper & Static Widgets ✅ NEXT
- Add flex-col wrapper around return
- Insert static header (as done before)
- Insert static 2x5 widgets below header
- Keep carousel unchanged for now

### Phase 2: Remove Duplicate Widgets
- Once Phase 1 works, remove duplicate widgets from carousel
- This way we always have working code

### Phase 3: Reorder Bottom Row
- Vis → UV → Sunrise → Sunset → Moon

## Key Files
- `HeroSlide.tsx` (current, clean backup - 1509 lines)
- `HeroSlide.backup.tsx` (original backup - identical)

## Next Action
Make ONE surgical edit to add static widgets, test compile, then proceed.
