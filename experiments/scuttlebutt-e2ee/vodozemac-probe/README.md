# Unchanged Olm / Apache provider experiment

This crate is isolated research, **not encryption enabled in Thalassa**. It uses
vodozemac 0.11.0 with explicit Olm v1 and no optional provider features. It does
not implement or modify a ratchet, handshake, KDF or cipher. There is no
post-quantum or Triple Ratchet claim. Signal proofs in the parent directory are
historical evidence only and cannot validate this provider.

## Reproduce on Apple Silicon macOS

Use Node 24 and a separately provisioned Rust toolchain (tested with 1.89.0).
Keep `CARGO_HOME` / `RUSTUP_HOME` in a dedicated research directory, outside the
app and the normal user toolchain. The runner does not install or download
anything. Provisioning Rust must use official downloads and checksum verification;
do not pipe arbitrary scripts into a shell or modify the app's package files.

From the repository root, with the isolated Cargo and rustc on `PATH` and the
matching `RUSTUP_HOME` configured:

```sh
CARGO_HOME=/absolute/research/cargo cargo fetch --locked --target aarch64-apple-darwin --manifest-path experiments/scuttlebutt-e2ee/vodozemac-probe/Cargo.toml
node experiments/scuttlebutt-e2ee/vodozemac-host-proof.mjs /absolute/research/cargo/bin/cargo /absolute/research/cargo
```

`Cargo.lock` is committed and hash-pinned along with the manifest. The runner
checks the resolved provider's version, licence and disabled features; the
published crate SHA-256 and VCS revision; and cached source files against the
verified archive. It runs offline, single-worker, without debug symbols or
incremental compilation, and creates its build directory under the system temp
directory. No Xcode project, app dependency, simulator or real account is touched.
Keep at least 1 GiB free before starting. Initial bootstrap/cache plus this small
test build used approximately 0.7 GiB on the development Mac; an iOS bridge build
would need a separate disk/memory check.

The runner supplies `THALASSA_VODO_PROBE_NODE` for the cross-language test. Direct
`cargo test` without that value deliberately fails instead of silently skipping
the TypeScript boundary. The helper converts upstream numeric type / unpadded
Base64 into Thalassa's envelope v2 / `olm-v1` / string type / padded Base64, then
returns the original provider bytes for real decryption. This helper is test
code, not a production native adapter.

## What the checks establish

- Real synthetic-peer prekey and normal exchanges, including bidirectional ratchets.
- Tampered and replayed messages reject; test-staged state commits only on success.
- Three out-of-order messages decrypt once each; no unlimited skipped-key claim.
- Account/session pickle restoration and encrypted-pickle wrong-key/tamper rejection.
- Non-contributory keys and mismatched inbound identity reject.
- Correctly addressed tampered initial messages do not consume the one-time key.
- Explicit caller-pinned identity and signed-prekey fixtures reject replacement.
- Real provider messages survive the TypeScript framing roundtrip and still decrypt.

All identities/messages are freshly generated synthetic fixtures. Plain pickles
and the fixed test pickle key remain in test memory. Test output never prints
private keys, pickles, ciphertext or message text.

## What this does not establish

No native Swift bridge, physical iPhone test, Keychain custody, durable atomic
state/outbox transaction, authenticated directory, Supabase relay, app cutover,
browser support or independent security audit. The synthetic signed-key encoding
is **not** a production bundle protocol and a self-signature does not prove user
ownership. Existing SQLite/Signal crash tests have not been joined to Olm.

Olm v1 uses a 64-bit truncated message MAC. Upstream v2 remains experimental and
is not enabled here. That trade-off, device/prekey authentication, rate limiting,
backup/rollback and compromised-device behaviour need explicit review. The
library's previous audit does not automatically audit this release/integration.

The maintained Matrix Swift package exposes the full Matrix SDK, not a bare Olm
drop-in for Supabase. Its normal room encryption uses Megolm; adopting it would
change the protocol/infrastructure design. The old official vodozemac-bindings
repository is unmaintained. Next is a narrow bridge around the unchanged library
using maintained binding tooling, then protected native persistence.

## Primary sources

- [Pinned provider and licence](https://github.com/matrix-org/vodozemac/tree/0.11.0)
- [Published checksum index](https://index.crates.io/vo/do/vodozemac)
- [Olm configuration](https://github.com/matrix-org/vodozemac/blob/0.11.0/src/olm/session_config.rs)
- [Matrix security analysis](https://matrix.org/blog/2026/02/analysis-of-reported-issues-in-vodozemac/)
- [Maintained Matrix Swift package](https://github.com/matrix-org/matrix-rust-components-swift)
- [Unmaintained older bindings](https://github.com/matrix-org/vodozemac-bindings)
- [UniFFI Swift support](https://mozilla.github.io/uniffi-rs/latest/swift/overview.html)
