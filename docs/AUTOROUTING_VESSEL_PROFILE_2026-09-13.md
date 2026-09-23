# Autorouting vessel profile contract — 13 September 2026

The contract was deployed in `autorouting-trial` version 2 on 13 September 2026,
and its client was installed as a signed development build on the test iPhone.
This does not establish provider clearance or navigation validation. Live
calculation failures and the remaining controlled tests are recorded in
[the review handoff](AUTOROUTING_REVIEW_HANDOFF_2026-09-13.md).

The authenticated [SevenCs Route Network request documentation](https://aws-rnw-03.chartworld.com/documentation#tag/Route/paths/~1api~1route/post), service **3.3.2.29**, was rechecked in the main task against the rendered schema and request payload. The verified mappings are:

| Stored vessel field | Trial value                             | SevenCs request field |
| ------------------- | --------------------------------------- | --------------------- |
| `length`, feet      | `vesselProfile.length.valueM`, metres   | `vessel.length`       |
| `beam`, feet        | `vesselProfile.beam.valueM`, metres     | `vessel.beam`         |
| `airDraft`, feet    | `vesselProfile.airDraft.valueM`, metres | `safety.airDraft`     |
| `draft`, feet       | `draftM`, metres                        | `safety.draft`        |

The documented length, beam and air-draft fields accept a nullable double greater than or equal to zero, with a default of zero. Thalassa omits missing dimensions and reports them as missing; it does not assert that a default zero describes the boat. Air draft belongs under `safety`, not under `vessel`. The separate documented `safety.clearance.vertical` margin defaults to zero and remains omitted. The fixed 0.5 m water-area under-keel margin and no-tide-credit policy remain unchanged. No turning radius is invented.

The opening snapshot converts stored feet once, without rounding or fallback dimensions. `estimatedFields` is retained as measured/estimated/missing status for length, beam and air draft, with a separate draft status. Missing draft disables calculation; estimated draft remains explicitly incomplete. The provider receives available numeric dimensions only. Measurement status is Thalassa metadata, not an invented SevenCs field or a provider certification.

Both client and edge validate the nested profile strictly and detach it before asynchronous work. Trial bounds are length 300 m, beam 100 m and air draft 150 m; these are Thalassa input limits, not claimed SevenCs limits. Non-finite, non-positive, unknown-field and oversized direct inputs reject. Invalid stored dimensions become missing rather than fabricated values.

A ready, entitled server advertises `vesselProfile: true`. Profile-bearing calculations perform an authenticated capability check before requesting a route and require an exact validated profile acknowledgement in the response. Old servers cannot silently discard dimensions. Legacy no-profile requests remain compatible but explicitly report unknown draft provenance and unknown dimensions. The local review carries draft assumptions and binds its evidence to the exact geometry, vessel snapshot, draft and chart registry.

Focused synthetic tests cover feet conversion, nested snapshots, measured/estimated/missing status, malformed inputs, bounds, old-server refusal, account changes, exact acknowledgement, exact provider field placement, omitted missing dimensions, preservation of chart constraints, and unchanged clearance/turning policy. They make no real provider requests and do not establish overhead or navigational clearance.
