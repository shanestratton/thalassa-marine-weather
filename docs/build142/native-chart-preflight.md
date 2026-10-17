# Native local-chart preflight

Reviewed frozen `37d15580bb92b6588ad049b1b0518501a5b51926` against exact build139
source `7684f4a08ef691594de12f8dc044464f70fb0547`. This is a source review, not an
Xcode compile, a native runtime test or a physical file-provider result.

## Concrete picker repair

The picker delegate serialized its returned security-scoped URL with
`url.absoluteString`; the copy helper reconstructed a new `URL(string:)` before
starting security-scoped access. The original URL carries access information that
the string does not preserve. Consequently a chosen file outside the app container
could be refused despite the user selecting it. The delegate now passes the
original `URL` object, retained by the existing serial copy closure. Its string is
used separately for the 8 KiB input bound. Open-in still uses the original strict
file-URL string fallback and the same host/credentials/query/fragment/extension and
owner-namespace restrictions. The chosen source receives one access call and a
matching conditional `defer` stop across coordinated reads, success and failure.

Apple documents the [picker's security-scoped URLs and coordinated access](https://developer.apple.com/documentation/uikit/providing-access-to-directories)
and the [balanced resource access API](<https://developer.apple.com/documentation/foundation/nsurl/startaccessingsecurityscopedresource()>).
The source defect is identified from those contracts; no actual iCloud or
third-party provider refusal/success is asserted by this review.

## Native surface and API assessment

Only `ios/App/App/GribDocumentPlugin.swift` and `ios/App/App/Info.plist` differ from
the exact139 native baseline. There are no new native source files, build graph,
entitlement, privacy-manifest, scene relay, bridge registration or Watch changes.
The existing plugin remains in the compiled App target and registered bridge.
The App target is iOS17 / Swift5 mode, covering UIKit/UniformTypeIdentifiers and
the FileHandle APIs used here. No concrete additional API/build error was found
by inspection; the required actual Mac compiler remains a separate gate.

The one retained `CAPPluginCall` instance is appropriate for one asynchronous
completion under [Capacitor's saved-call contract](https://capacitorjs.com/docs/core-apis/saving-calls).
Picker presentation and delegate state remain on the main queue. Success and
Cancel clear that call. The serial copy validates an original regular non-symlink
file, copies in 64 KiB chunks, checks exact final length, uses generated owner/UUID
paths and removes failed chart destinations. Chart-only limits remain 32 MiB per
file, eight files / 64 MiB globally plus separately bounded index metadata and
128 enumeration visits. Backups remain excluded; the app's own Documents/Cache
cannot be an incoming chart source apart from the incoming Inbox. Existing
GRIB/GPX methods retain their destinations and limits. A filename, UTI or own/open
declaration is not content or licence verification; JS checks header/hash after
the bounded private copy.

Info.plist adds two imported UTIs (MBTiles/KAP) and one Alternate Viewer document
entry covering those types and standard `public.tiff`. The previous GRIB/GPX
entries and all other plist values remain unchanged. File sharing and opening
the app Documents in place stay disabled. No `.bsb` catalogue handler or broad
new sandbox entitlement is declared.

## Lifetime limits and remaining evidence

The native 15-second copy clock is cooperative. NSFileCoordinator, resource lookup
and FileHandle calls can block inside the OS; the clock cannot interrupt those
calls. The same serial queue serves imports, so a stalled provider may delay later
imports until it returns. JS abort/account retirement releases its own wait and
cleans the captured owner's late generated copy; it does not forcibly dismiss the
native picker or cancel OS work. User Cancel clears the native pending call. These
are existing disclosed boundaries, not new hard cancellation guarantees. No wider
cancel API or permission change is introduced by this repair.

The new source regression first fails on the original string round-trip (one
failure / one pass), then the repaired focused group passes 44 cases in five
suites: native chart/GRIB contracts, storage races, Open-in queue and bounded wait.
Scope balancing and original-URL flow are source contracts; mocked storage races
do not prove OS grants or physical cancellation. Logs are
`work/validation142-native-picker-scope-{baseline,focused,lint}.log` outside the
checkout. Scoped lint, formatting and `git diff --check` pass.

All four native build settings at the reviewed source still say139. The parent
must prepare the deliberate142 identity change, exact native allowlist/hashes and
unsigned Mac compile before claiming a142 native build. Physical Files/local,
iCloud/third-party selection, cancellation and locked-device behavior still need
native evidence. No compiler, production build, signing, upload, deployment or
hardware action was performed in this review/repair.
