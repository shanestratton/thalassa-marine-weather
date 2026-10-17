# Build142 native identity

This source changes exactly four project configuration fields from141 to142.
The immutable capture is `b0221d6a3cf0e1825b9ea6aa5cc9b93528dc103a`.
The strict guard compares the complete native tree with reviewed141 source
`fcec205f016867bc6ba03aa8ef8d485191ec25ba`. It permits only the project,
the previously reviewed chart/GRIB document plugin and local-chart Info.plist
declarations. Their exact hashes are pinned; changing a bound, security scope,
format, target, signing setting or another native file refuses admission.
EncryptedLargeStoragePlugin remains byte-identical to141, including its scoped
private comfort queue key. Historical139,140 and141 guards and immutable
fixtures stay unchanged.

The four historical/current Node suites pass27 tests, including the new7
immutable-capture and meaningful refusal cases. The first scoped lint invocation
caught a missing explicit Node Buffer import in the new test; its log is retained
at `work/validation142-native-identity-lint.log`. Adding that import changes no
test assertion. The repaired lint result is recorded separately.

This guard is source evidence. It does not compile Swift, sign an archive or
prove Files/iCloud/third-party file-provider behavior. The chart import's
15-second deadline remains cooperative around operating-system file-provider
operations. JavaScript retirement does not prove native picker dismissal or
cancel blocked OS work. The release owner still needs the exact unsigned Mac
compile and later device acceptance; this packet dispatches no workflow and
installs or activates nothing.
