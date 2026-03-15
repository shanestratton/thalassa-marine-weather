# ADR-002: Offline-First with Local-Priority Storage

**Status:** Accepted  
**Date:** 2026-02-01  
**Deciders:** Shane Stratton

## Context

Sailors frequently lose internet connectivity offshore. The app must remain functional for core operations (viewing last weather, logging entries, managing checklists) without network access. Data must sync reliably when connectivity returns.

## Decision

Adopt an **offline-first, local-priority** storage strategy:

1. **Primary storage:** `localStorage` + Capacitor native storage for all user data
2. **Cloud sync:** Supabase (PostgreSQL + Realtime) for backup and cross-device sync
3. **Conflict resolution:** Last-write-wins with timestamp-based merging

## Architecture

```
User Action
  └→ Local Store (immediate write, instant UI)
       ├→ localStorage (web)
       └→ Capacitor Preferences (native iOS)
            └→ Background Sync Queue
                 └→ Supabase (when online)
                      └→ Realtime subscription (push updates to other devices)
```

### Key Design Choices

| Aspect            | Choice              | Rationale                                  |
| ----------------- | ------------------- | ------------------------------------------ |
| Write target      | Local first         | Instant response, works offline            |
| Sync direction    | Bidirectional       | Multi-device support                       |
| Conflict strategy | Last-write-wins     | Simple, predictable for single-user data   |
| Queue persistence | localStorage        | Survives app restart                       |
| Retry policy      | Exponential backoff | Handles intermittent satellite connections |

### Offline Capabilities

| Feature                | Offline Support              |
| ---------------------- | ---------------------------- |
| View last weather      | ✅ Cached in localStorage    |
| Ship's Log entries     | ✅ Full CRUD, syncs later    |
| Voyage management      | ✅ Local-first               |
| Checklists/Maintenance | ✅ Local-first               |
| Route planning         | ⚠️ Requires cached GRIB data |
| Live weather fetch     | ❌ Requires network          |
| Chat (Crew Talk)       | ⚠️ Read cached, queue sends  |

## Consequences

**Positive:**

- App remains usable in 95%+ of scenarios without connectivity
- Sub-10ms write latency (no network round-trip for user actions)
- Natural resilience to flaky satellite/marina WiFi

**Negative:**

- localStorage has 5-10MB limit — must be selective about cached data
- Last-write-wins can lose data in rare simultaneous multi-device edits
- Sync queue must handle Supabase schema changes gracefully
