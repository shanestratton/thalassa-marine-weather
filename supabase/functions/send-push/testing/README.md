# Actual sender boundary proof

This explicit test imports the production `../index.ts`. An import map replaces only the HTTP server registration,
database transport and base64 transport dependency. Production queue handling, JWT signing, retry loop, policy and
overdue guards execute unchanged. Keys and records are generated synthetic fixtures; the command grants read access only
to the local source closure and env access only to eight overwritten fixture variables. Network modules and network
access are denied. No provider message or real database connection is possible.

From `supabase/functions`, run:

```sh
deno test --no-config --no-lock --no-remote --deny-net \
  --allow-read=send-push,_shared,../../utils \
  --import-map=send-push/testing/import-map.json \
  --allow-env=SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,APNS_KEY_ID,APNS_TEAM_ID,APNS_KEY_P8,APNS_PRODUCTION,APNS_CRITICAL_ALERTS_ENABLED,APNS_BUNDLE_ID \
  send-push/testing/handler.case.ts
```

The ordinary Edge typecheck checks the production entry against the real SDK separately. Fixture database attempt
coalescing is only a transport model; actual PostgreSQL concurrency is established by
`supabase/tests/overdue-watch-db.mjs` and its blocked-session proof.
