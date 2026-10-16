# Explicit private routing exclusions and retained MPA context

This bounded 139-04 source packet follows `9d9dfabb3` with the normal merge of engine foundation `eb72aebf8`. It changes no router or engine caller. Root and the tide/holding reader integrate the leased API separately.

## Explicit policy

The existing **Your overlays** sheet adds **Avoid while routing** inside each saved file. Its label is a 44 px minimum touch target. The control is disabled for files without polygons. New imports and old indexes without the field default to OFF. Imported properties cannot activate it. Visibility, polygon-entry notices and routing avoidance remain independent: hiding an explicitly enabled file does not remove its no-go polygons from a route.

Enabling requires an existing saved polygon file to pass its normal byte/SHA-256/content/metadata proof before the private index is written. The existing account-scoped writer queue, immutable content files, total limits and write/rename identity checks remain in use. Invalid policy types, corrupt enabled files and invalid enabled polygon metadata refuse a routing read. They cannot become an empty no-go list. No private geometry is read in the anonymous scope.

## Route-context API

`services/routing/routingExclusions.ts` exports:

```ts
readCurrentRoutingExclusions({ bbox, signal });
// bbox: readonly [west, south, east, north]; west > east denotes a dateline window
// -> Promise<CurrentRoutingExclusions>
// { manual?, marineParks?, advisories, isCurrent(), release() }
```

It captures the actual auth scope/generation, overlay generation and retained MPA owner/source identity. Every asynchronous library/file read is followed by a fence check. A/B/A identity changes, a committed overlay update, source replacement/release/TTL expiry or cancellation retires the result. Consumers must check `isCurrent()` before and after source/worker/final-verification awaits, reject stale results, and call `release()` in `finally`. A thrown manual-context error must not be replaced by an empty collection. Release clears the returned geometry references and the retained-MPA owner reference.

The synchronous `routingExclusionContextKey()` export binds the auth key/generation, overlay generation, retained MPA owner identity/generation/validation clock and freshness. Use it in request deduplication and pre/post-await checks so an Avoid edit cannot join an old run. It changes on source expiry even without a generation event. Route and active-vessel request identities remain separate caller fences.

The manual collection contains only complete enabled polygons/MultiPolygons intersecting the requested bbox, including enclosing polygons. Points/lines, labels and other private properties are omitted. Geometry is never clipped, translated, reclassified or adopted as water/depth. Dateline filtering keeps complete original geometry; the engine remains responsible for any unsupported route-frame refusal.

`borrowRetainedMpaDataset({ bbox, signal })` in `services/weather/api/mpaDataset.ts` reads only the already verified in-memory dataset. It never fetches, renews TTL or copies the full footprint. It borrows complete selected feature references with a 2,000-feature/50,000-vertex output ceiling, checks the existing 30-minute cache TTL and 14-day publication age, and follows the existing owner epoch, source object and validation-clock identity. An over-budget slice returns no partial footprint. Absent, expired or over-budget data has an explicit advisory. Indicative classifications add caution only and imply no prohibition, transit permission or safe water.

## Evidence and limits

- **118 cases / 10 suites pass**: real private persistence and concurrent operations, default OFF/backward indexes, independent controls, enabling integrity proof, corrupted active policies/files, anonymous privacy, cancellation/account A/B/A/generation/source retirement, dedupe-key and input-bounds snapshots, retained-MPA reference/no-fetch/no-renewal/expiry/output bounds, existing overlay import/render, MPA trust/lifecycle, and engine exclusion detour/final audit. Log: `work/validation139-manual-exclusions-key-final.log`.
- **Eight Chrome/WebKit phone browser cases pass**, using the actual sheet, private filesystem adapter and context reader with synthetic local polygon/point files, no account/provider/boat actions. They check default OFF, a disabled point policy, independent visibility/notices, actual context inclusion/removal, a reachable 44 px label, and zero document growth at 300/375 px, 130% text, keyboard up/down. Final log: `work/validation139-manual-exclusions-browser-freeze.log`; screenshots: `work/manual-exclusions139-browser-results`. The tight 300 px WebKit view was inspected; the existing import timestamp wraps inside the card.
- Scoped lint/format/diff checks are part of this packet. No whole-app TypeScript/production build, backend/Pi deployment, watch action or physical navigation acceptance was performed. Root owns the composed gates and downstream adoption.
