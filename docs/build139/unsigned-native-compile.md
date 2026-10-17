# Unsigned native compile preparation

This manual workflow is pinned to source `57a5d8eb02b4aa4c7a8f2117c0dcaa1cf5d5932e`, a checked139 checkpoint. It is prepared for root review and has not been dispatched. It is not the final139 release-source freeze.

Compared with proposed138 `e4722dfc5eea78e2a2af8ffd83134da06ce301e0`, the complete iOS tree differs only in four `CURRENT_PROJECT_VERSION` declarations (138→139) and two approved compiled Watch files. `native-identity139.mjs` checks exact normalized project bytes and the two committed Swift SHA256 values. The eleven files under historical `ios/WatchApp` remain unchanged. Native tracked modifications during Capacitor sync are refused.

The hosted Mac job requires macos26, Xcode26.6 and Node24. It runs the unchanged production `ship:beta` gate with the existing public repository Vite variables, including Capacitor sync and existing artifact/budget checks. Source and control checkouts are separate, and checkout credentials are not persisted. It names no Apple key, certificate, P8 or secret context. There is no signing, archive/export, Sentry sourcemap upload, deployment or TestFlight upload command.

The shared App scheme has an empty target-dependency list: an iOS Simulator compile alone does not compile the separate Watch target. The job therefore builds App for generic iOS Simulator and explicitly builds `ThalassaWatch Watch App` for watchsimulator, both with `CODE_SIGNING_ALLOWED=NO`. It changes no target, scheme or Swift source. This proves compilation only; no runtime, background alarm, hardware, WKWebView, entitlement or distribution-signature acceptance is implied.

Only bounded text logs (up to2MiB per build command) and JSON SHA256/size inventories are retained for seven days. The proof compares every actual dist file with Capacitor's copied public directory and the compiled iOS app's public directory. Maps, unexpected public additions and native/key artifacts are refused. Capacitor's two generated Cordova bridge files are separately disclosed. No built app, executable, native archive, web bundle, certificate or private key is an uploaded artifact.
