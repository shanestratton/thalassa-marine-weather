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

## Release order

Native Apple sign-in remains compile-time fail-closed: only the exact string `true` for `VITE_APPLE_SIGN_IN_ENABLED` exposes the native door. The committed public-beta profile now enables it and `ios/App/App/App.entitlements` carries `com.apple.developer.applesignin`; those two states are enforced as an exact pair by the release gate. Browser Apple OAuth is a separate lane, gated by `VITE_APPLE_WEB_SIGN_IN_ENABLED`, the Apple Services ID, and the Supabase callback/client secret.

1. Apply `20260805090000_apple_sign_in_token_lifecycle.sql` and `20260805091000_apple_server_notification_queue.sql`. Both tables have forced RLS, no client policy or grant, and are accessible only through the service role.
2. Set and independently verify all six secrets above.
3. Deploy `register-apple-token`, then deploy `delete-account`. Both must retain `verify_jwt = true` from `supabase/config.toml`.
4. On a disposable Apple account, complete a fresh native authorization and confirm `register-apple-token` returns `{ "registered": true }` without exposing a token.
5. Delete that account in-app and confirm Apple revocation succeeds before the Supabase auth user and encrypted row disappear.
6. Deploy the destructive processor for `apple_server_notification_queue`. The receiver verifies Apple's RS256 JWS, issuer, and App-ID audience, records `consent-revoked` or `account-deleted` as an auditable `pending` event, then invokes `delete-account` with only the verified queue JTI and the dedicated processor secret. The processor resolves the user from that service-role-only queue; callers cannot supply a user ID.
7. Deploy the receiver with `verify_jwt = false`, register its TLS URL on the primary App ID in Apple Developer, and prove idempotent complete deletion using a disposable account. An unsigned or wrong-audience payload must return `401`; queue or processor failure must return `503` so Apple can retry.
8. Enable the Sign in with Apple capability for `com.thalassa.weather` and add the `com.apple.developer.applesignin` entitlement. Confirm the signed distribution profile carries it.
9. Set `VITE_APPLE_SIGN_IN_ENABLED=true` and `VITE_ACCOUNT_DELETION_ENABLED=true` only for a fresh candidate built after every server and native gate above is green.

As of 2026-09-02, the migrations and six secrets are deployed, the live server-event processor passed a disposable production deletion smoke, and the Apple App ID endpoint is registered as `https://pcisdplnodrphauixcau.supabase.co/functions/v1/apple-server-notification`. Native Apple sign-in and in-app deletion are enabled together in the committed release profile. A fresh Apple sign-in still fails closed if server token registration cannot complete. Accounts created before this lifecycle have no retained token; their data deletion still proceeds and Thalassa displays the manual iOS “Sign in with Apple” removal instruction.
