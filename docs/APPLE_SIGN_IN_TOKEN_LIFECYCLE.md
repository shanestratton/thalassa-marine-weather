# Sign in with Apple token lifecycle

Thalassa follows [Apple TN3194](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple): a new native Apple authorization is not accepted as complete until its one-time authorization code has been exchanged by the authenticated server, the returned Apple identity has been matched to the Supabase caller, and the refresh token has been encrypted and retained for deletion-time revocation.

## Server-only configuration

Create a Sign in with Apple key in Apple Developer Certificates, Identifiers & Profiles. Associate it with the primary App ID `com.thalassa.weather`, download the `.p8` file, and record its Key ID and the Apple Developer Team ID. Configure these Supabase Edge Function secrets; none belongs in a `VITE_` variable, Xcode build setting, Capacitor config, or client bundle:

- `APPLE_SIGN_IN_CLIENT_ID` — `com.thalassa.weather`, exactly matching the native authorization request.
- `APPLE_SIGN_IN_TEAM_ID` — Apple Developer Team ID.
- `APPLE_SIGN_IN_KEY_ID` — Key ID of the Sign in with Apple `.p8` key.
- `APPLE_SIGN_IN_PRIVATE_KEY` — complete `.p8` contents, including the PEM header and footer.
- `APPLE_REFRESH_TOKEN_ENCRYPTION_KEY` — an independent, random 32-byte key encoded as standard base64. Generate it with `openssl rand -base64 32` and store a recoverable copy in the release credential vault.
- `APPLE_NOTIFICATION_PROCESSOR_SECRET` — an independent high-entropy secret used only between the public, Apple-JWS-verifying receiver and the JWT-gated deletion Function. It must not reuse the service-role key or any Apple credential.

The Edge runtime generates a short-lived ES256 Apple client-secret JWT from the `.p8` key. There is no static Apple client secret to place in the app. Do not rotate `APPLE_REFRESH_TOKEN_ENCRYPTION_KEY` without first re-encrypting every retained token; losing it converts affected accounts to the manual-revocation path.

## Repeat sign-ins never revoke

Apple's `/auth/revoke` ends the user's whole Sign in with Apple authorization for the app, not one token ([Revoke tokens](https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens): "Invalidate the tokens and associated user authorizations for a user"). Until build 123, `register-apple-token` revoked the previously stored token on every repeat sign-in, which ended the sign-in that had just happened: the native credential monitor reported "revoked", the app signed out, and Apple emailed the user that Thalassa had revoked their Sign in with Apple. Now:

- a repeat sign-in rotates the stored ciphertext to the newest token and revokes nothing; one stored token per user is enough, because revoking it at account deletion ends all of that user's authorization;
- compensating revocation runs only for a first Sign in with Apple (the Apple identity was linked in the last 15 minutes) whose token could not be persisted, and only when no stored row tracks that Apple subject. An older Apple account with no stored token (most accounts predate token retention) is never revoked, because its authorization is live on the sailor's other devices; account deletion already covers it through the manual-removal (`manual_required`) path;
- a sign-in that loses the optimistic-concurrency race never revokes: it succeeds when the winner's row holds the same Apple subject, and otherwise asks the client to start again;
- in-app account deletion still revokes the stored token before any data is removed (TN3194).

The decisions live in `supabase/functions/register-apple-token/registration.ts` and `supabase/functions/apple-server-notification/notification.ts`, each with Deno behaviour tests beside it.

## In the app (build 124)

A native Apple sign-in has four steps: `authorize` (Apple's sheet), `supabase_id_token`, `bind_credential` (the Keychain-bound credential monitor) and `register_token` (this function). Supabase reports `SIGNED_IN` after the second, so:

- the sign-in sheet stays open and busy until all four have finished, and a failure shows its step on the open sheet ("Apple Sign-In couldn't finish (server, 502). Try again."). The attempt lives in `services/auth/appleSignInAttempt.ts`, so a caller that unmounts the sheet at `SIGNED_IN` shows the failure when it renders the sheet again. Callers that close their sheet when the account changes (the Galley, the Vessel hub's claim card) skip that close while `appleSignInHoldsSheet()` is true. Only the sailor's own close (the button or Escape) drops a failure still to come; one that lands while a caller had the sheet closed is shown on the next open, within five minutes;
- a failed `bind_credential` or `register_token` discards the new session. If `signOut({ scope: 'local' })` cannot reach Supabase (it still calls `/logout`, and keeps the session when that fails), the session is removed on the device without the network and the app is fenced signed out (`fenceSignedOutOnThisDevice`), so an unregistered session never stays signed in;
- only `ASAuthorizationError` 1001 (canceled) is silent. 1000 (unknown) says "Apple Sign-In didn't complete (Apple error 1000). Try again.";
- every failed step is reported to Sentry as `apple_signin_failed step=… code=… reason=…`, and every handled native revocation as `apple_credential_revoked reason=… state=…`. Neither carries a token, code, nonce, email or Apple user id (`tests/AppleSignInTelemetryNoSecrets.test.ts`);
- `patches/@capacitor-community+apple-sign-in+7.1.0.patch` (applied by `npm ci`) starts the Apple sheet on the main thread with a presentation anchor, holds the pending call on the plugin, and rejects with the Apple error code;
- a native revocation that finishes after the sailor has signed in again leaves the new session signed in (`stores/authStore.ts`).

## Release order

Native Apple sign-in remains compile-time fail-closed: only the exact string `true` for `VITE_APPLE_SIGN_IN_ENABLED` exposes the native door. The committed public-beta profile now enables it and `ios/App/App/App.entitlements` carries `com.apple.developer.applesignin`; those two states are enforced as an exact pair by the release gate. Browser Apple OAuth is a separate lane, gated by `VITE_APPLE_WEB_SIGN_IN_ENABLED`, the Apple Services ID, and the Supabase callback/client secret.

1. Apply `20260805090000_apple_sign_in_token_lifecycle.sql` and `20260805091000_apple_server_notification_queue.sql`. Both tables have forced RLS, no client policy or grant, and are accessible only through the service role.
2. Set and independently verify all six secrets above.
3. Deploy `register-apple-token`, then deploy `delete-account`. Both must retain `verify_jwt = true` from `supabase/config.toml`.
4. On a disposable Apple account, complete a fresh native authorization and confirm `register-apple-token` returns `{ "registered": true }` without exposing a token.
5. Delete that account in-app and confirm Apple revocation succeeds before the Supabase auth user and encrypted row disappear.
6. Deploy the destructive processor for `apple_server_notification_queue`. The receiver verifies Apple's RS256 JWS, issuer, and App-ID audience. An `account-deleted` event (Apple's older spelling `account-delete` is accepted as the same event) is recorded as an auditable `pending` row, then `delete-account` is invoked with only the verified queue JTI and the dedicated processor secret. The processor resolves the user from that service-role-only queue; callers cannot supply a user ID, and it refuses any queued row that is not `account-deleted`. A `consent-revoked` event is a sign-out, never a deletion: the receiver ends the user's Supabase sessions started at or before the event and deletes the stored Apple token row. While an account deletion is in progress for that user (an `account_deletion_jobs` row exists) it touches nothing: TN3194 says Apple sends `consent-revoked` after the app's own revoke too, and a deletion resumed in `apple_revocation_state = 'revoking'` needs the token row. Any event older than the stored row's `updated_at` (the user's latest Apple sign-in) is acknowledged and ignored. Apple's servers send the `events` claim as a JSON-encoded string with a millisecond `event_time` (the documentation example shows an object); both forms are accepted. The live proof in step 7 must include a real `consent-revoked` from Settings → Apple Account → Sign in with Apple → Stop Using.
7. Deploy the receiver with `verify_jwt = false`, register its TLS URL on the primary App ID in Apple Developer, and prove idempotent complete deletion using a disposable account. An unsigned or wrong-audience payload must return `401`; queue or processor failure must return `503` so Apple can retry.
8. Enable the Sign in with Apple capability for `com.thalassa.weather` and add the `com.apple.developer.applesignin` entitlement. Confirm the signed distribution profile carries it.
9. Set `VITE_APPLE_SIGN_IN_ENABLED=true` and `VITE_ACCOUNT_DELETION_ENABLED=true` only for a fresh candidate built after every server and native gate above is green.

As of 2026-09-02, the migrations and six secrets are deployed, the live server-event processor passed a disposable production deletion smoke, and the Apple App ID endpoint is registered as `https://pcisdplnodrphauixcau.supabase.co/functions/v1/apple-server-notification`. Native Apple sign-in and in-app deletion are enabled together in the committed release profile. A fresh Apple sign-in still fails closed if server token registration cannot complete. Accounts created before this lifecycle have no retained token; their data deletion still proceeds and Thalassa displays the manual iOS “Sign in with Apple” removal instruction.
