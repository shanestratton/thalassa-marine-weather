# Layout fixtures under release configuration

The buddy, weather, shore-contact and overdue layout specs now intercept the
exact public backend origin supplied by CI. Their local fictional origins remain
the fallback. Each test still fulfills only its named operations and refuses
every other external request. No feature assertion or deadline was relaxed.

The buddy and weather fixtures finish the real anonymous bootstrap before
installing their fictional owner and boat, preventing a late empty session from
retiring that scope. The development layout server disables Sentry so fictional
consent/contact interactions cannot emit production telemetry. Production build
configuration is unchanged.

All 20 cases pass in Chrome and WebKit at 300 and 375 px using the existing public
release configuration, with all backend/provider traffic intercepted locally.
Evidence: `work/validation137-configured-browser-fixtures-second.log` and
`work/fixtures137-configured-browser-second` in the task workspace. The initial
failed run and its traces are retained separately. Scoped formatting and lint
pass (the shared Playwright config is ignored by the repository lint rules).
