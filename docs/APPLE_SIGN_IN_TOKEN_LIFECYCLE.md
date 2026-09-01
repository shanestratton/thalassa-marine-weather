# Sign in with Apple token lifecycle

Thalassa follows [Apple TN3194](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple): a new native Apple authorization is not accepted as complete until its one-time authorization code has been exchanged by the authenticated server, the returned Apple identity has been matched to the Supabase caller, and the refresh token has been encrypted and retained for deletion-time revocation.

## Server-only configuration

Create a Sign in with Apple key in Apple Developer Certificates, Identifiers & Profiles. Associate it with the primary App ID `com.thalassa.weather`, download the `.p8` file, and record its Key ID and the Apple Developer Team ID. Configure these Supabase Edge Function secrets; none belongs in a `VITE_` variable, Xcode build setting, Capacitor config, or client bundle:

- `APPLE_SIGN_IN_CLIENT_ID` — `com.thalassa.weather`, exactly matching the native authorization request.
- `APPLE_SIGN_IN_TEAM_ID` — Apple Developer Team ID.
- `APPLE_SIGN_IN_KEY_ID` — Key ID of the Sign in with Apple `.p8` key.
- `APPLE_SIGN_IN_PRIVATE_KEY` — complete `.p8` contents, including the PEM header and footer.
- `APPLE_REFRESH_TOKEN_ENCRYPTION_KEY` — an independent, random 32-byte key encoded as standard base64. Generate it with `openssl rand -base64 32` and store a recoverable copy in the release credential vault.

The Edge runtime generates a short-lived ES256 Apple client-secret JWT from the `.p8` key. There is no static Apple client secret to place in the app. Do not rotate `APPLE_REFRESH_TOKEN_ENCRYPTION_KEY` without first re-encrypting every retained token; losing it converts affected accounts to the manual-revocation path.

## Release order

Native Apple sign-in is compile-time fail-closed by default. `VITE_APPLE_SIGN_IN_ENABLED` must remain unset (or any value other than the exact string `true`) while these gates are incomplete; native beta users receive the working email OTP door instead. The public-beta candidate also omits `com.apple.developer.applesignin` from `ios/App/App/App.entitlements`, so its provisioning profile does not advertise a disabled capability. The native monitoring implementation remains compiled but unreachable. Browser Apple OAuth is a separate lane, gated by `VITE_APPLE_WEB_SIGN_IN_ENABLED`, the Apple Services ID, and the Supabase callback/client secret; enabling it does not enable or claim the native entitlement.

1. Apply `20260805090000_apple_sign_in_token_lifecycle.sql` and `20260805091000_apple_server_notification_queue.sql`. Both tables have forced RLS, no client policy or grant, and are accessible only through the service role.
2. Set and independently verify all five secrets above.
3. Deploy `register-apple-token`, then deploy `delete-account`. Both must retain `verify_jwt = true` from `supabase/config.toml`.
4. On a disposable Apple account, complete a fresh native authorization and confirm `register-apple-token` returns `{ "registered": true }` without exposing a token.
5. Delete that account in-app and confirm Apple revocation succeeds before the Supabase auth user and encrypted row disappear.
6. Finish and independently review the destructive processor for `apple_server_notification_queue`. The checked-in `apple-server-notification` receiver verifies Apple's RS256 JWS, issuer, and App-ID audience, then records `consent-revoked` or `account-deleted` as an auditable `pending` event. It intentionally does not claim or perform account deletion.
7. Only after that processor is tested, deploy the receiver with `verify_jwt = false`, register its TLS URL on the primary App ID in Apple Developer, and prove signed delivery plus idempotent complete deletion using a disposable account. An unsigned or wrong-audience payload must return `401` and a queue-write failure must return `503`.
8. Re-enable the Sign in with Apple capability for `com.thalassa.weather` in Apple Developer/Xcode and restore the `com.apple.developer.applesignin` entitlement to `ios/App/App/App.entitlements`. Confirm the distribution profile carries the matching entitlement.
9. Set `VITE_APPLE_SIGN_IN_ENABLED=true` only for a fresh candidate built after every gate above is green.

The migrations, secrets, deployed functions, completed server-event processor, and registered Apple endpoint are required before enabling Apple sign-in for external testers. The code intentionally fails a fresh Apple sign-in closed if registration cannot complete. Accounts created before this lifecycle have no retained token; TN3194 says their data deletion must still proceed, after which Thalassa displays the manual iOS “Sign in with Apple” removal instruction.
