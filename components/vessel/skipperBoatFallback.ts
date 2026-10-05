/**
 * What a skipper's boat is called while her name is not known. Its own tiny
 * module so The Glass can name a crewed boat without loading the binder line's
 * UI (2026-10-05); SharedBinderLine re-exports it for the pages that use it.
 */
export const SKIPPER_BOAT_FALLBACK = "your skipper's boat";
