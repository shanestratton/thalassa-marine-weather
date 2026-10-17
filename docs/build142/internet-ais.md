# 142-03 · Internet AIS to a local Signal K JSON input

The Pi now has an explicitly enabled, read-only producer at loopback TCP10112.
It emits bounded Signal K deltas under `thalassa-internet-ais.<provider>`, using
each original report timestamp, positions and SI speed/course values. CRLF frames
contain no invented VDM message, transponder class, radio status, heading or boat
name. Source labels distinguish AISStream, AISHub and a relayed receiver; every
one is an internet observation on this connection. No NMEA2000 output, gateway
connection, provider subscription or hardware configuration is created.

The producer defaults off. It requires both the operator enable flag and a
separate source-handling review, ordinary Pi internet permission, the current
paired relay credential and account epoch, and a fresh original instrument fix
with a known own MMSI. The local consumer must preserve source labels, prefer
radio observations, discard observations at original time+120s, and exclude this
source from N2K output and radio/MFD collision alarms. The review flag records
an operator assertion. It does not verify any installed Signal K plugin or MFD.
Actual Signal K/plotter acceptance remains pending; unsupported consumers stay
off. Existing ordinary boat telemetry and radio watch continue independently.

The final own-fix read checks current source identity and original age. It does
not observe an independent epoch for a transient selected GPS A→B→A within one
poll. This is no continuous instrument/source-authority proof.

The existing Pi radio reader excludes known internet-selected dynamic leaves.
Where the actual Signal K document provides a recent non-internet alternative,
the reader uses that original value and timestamp without mutating the source.
An absent alternative stays unknown. Legacy untagged receiver leaves retain
their existing behavior; stripping source labels is therefore unsupported.

While a local consumer is connected, a poll can request at most100 observations
within25NM, every30s. It retains no offline backlog. Original target clocks are
at most120s old and at most5s ahead; an original own fix must remain within20s.
Owner/policy A→B→A, source replacement, close, timeout and late results cannot
publish an old candidate. Currentness is checked again immediately before each
write. The loopback stream caps two consumers,1024B per frame,64KiB per poll and
socket queued bytes. Backpressure or incoming commands close that consumer.
Already delivered observations cannot be recalled from an external display;
that display's verified original-time expiry remains necessary.

`pi-internet-ais` is a new default-disabled Edge reader. It retains gateway JWT
verification and authenticates the existing scoped Pi relay inside the function.
The Pi holds no service key or user session. Existing service-only quota and
AIS coverage/query RPCs enforce fixed25NM/100-result requests,120/hour and4/minute
per actual owner. Unknown providers, old positions and own-vessel reports do not
become observations. Initial and post-query relay/deletion checks refuse retired
access; these bounded separate reads are not claimed as a database transaction
locking revocation through network delivery. Empty or held coverage is never an
all-clear. The old app `vessels-nearby` function is unchanged. No migration or
live Edge/env change is included.

The portable wire contract is authored once in `utils/internetAis.ts`, Deno
formatted and byte-mirrored into Pi/Edge by `sync-internet-ais.mjs --check`.
There is no new phone runtime import or library dependency. Final composed phone
size remains a separate root release check.

Primary formats and supported input were checked against the
[Signal K data model](https://signalk.org/specification/1.8.2/doc/data_model.html),
[multiple-source model](https://signalk.org/specification/1.8.2/doc/data_model_multiple_values.html),
[TCP framing](https://signalk.org/specification/1.8.2/doc/streaming_api.html), and
[the server's SignalK TCP input pipeline](https://github.com/SignalK/signalk-server/blob/master/packages/streams/src/simple.ts).
For an independently reviewed installation, its Data Connections page can select
Signal K/TCP on127.0.0.1:10112, without overriding original timestamps. This is a
fixed producer feed for that input, with no discovery or subscription service.
No settings file is automatically rewritten.

Focused source checks passed31 Node cases (including15 unchanged LAN cases),
27 unchanged Pi watch cases and28 Edge/JWT/phone-radio/mirror cases. Pi-only TypeScript,
the actual frozen Deno entrypoint check, Deno lint/format and scoped ESLint passed.
The TCP cases use real loopback sockets; HTTP/Edge/provider data are synthetic.
No actual provider query, Edge deployment, Signal K ingestion, MFD display,
N2K source exclusion or hardware alarm behavior is claimed from these checks.
