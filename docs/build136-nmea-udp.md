# Build 136-06: additional sentences and unicast UDP

Source implementation is prepared; a physical iPhone/gateway test and Mac native
compile remain required. There is no Pi deployment or native build-number change.

## Measurement contract

- MDA pressure accepts declared bar or inHg units. XDR accepts declared bar or Pa
  only for known atmospheric sensor names, including Baro, Barometer and the
  manufacturer-identified USB-BAR20-N. Engine, fuel, unknown-name and unknown-unit
  pressure do not become atmospheric observations. Conflicting duplicate MDA
  units are refused. Plausible pressure is 800–1100 hPa.
- These sources do not establish a sea-level correction. The Barometer panel
  labels gateway readings as sensor pressure. A fresh Pi barometer wins, then
  the gateway, then the phone. History is memory-only, six hours/361 minute
  buckets, segmented by gateway/sensor and cleared on disconnect or account
  change. A silent gateway expires after 13 seconds. A delayed Pi request cannot
  overwrite a newer gateway fallback observation.
- VLW exposes its water-referenced total and since-reset log separately in the
  Speed panel. It does not replace the app's SOG-integrated Trip or use the
  optional ground-distance extension as water distance.
- GLL requires valid status and a measured GNSS mode. VTG honours independent
  true-course and knots/kmh tags; inconsistent duplicate speeds and invalid,
  estimated, manual or simulated modes are refused. RMC likewise excludes those
  non-measured modes. Missing legacy mode fields remain compatible. Missing
  values stay null; real zero is preserved.
- SeaSmart `$PCDIN` requires a verified checksum, fixed hex framing and complete
  payload lengths. The read-only PGN whitelist is 127250, 127257, 127488, 127489,
  128259, 128267, 129025, 129026 and 130306. Existing PGN decoders preserve
  unavailable sentinels. Unsupported PGNs, commands, fast-packet fragments and
  GNSS 129029 without an implemented fix-quality adapter are refused.
- PGN heading/course reference, wind reference and original native receipt
  clocks are preserved. The SeaSmart uptime tick is never treated as UTC.
  Depth remains explicitly below the transducer; no offset is guessed. Dynamic
  engine readings carry source address/instance identity and seconds/Celsius/
  kPa units. Observing engine instance zero does not prove a single-engine boat;
  it can suppress sailing performance but cannot accrue one engine's RPM hours.

## Transport and user flow

The Gateway page preserves TCP as the existing default and offers UDP unicast.
Its host is the sender gateway; the selected port is the phone's receive port.
Once bound, the page displays the phone's actual Wi-Fi address and port to put
into the gateway's destination configuration. Port/address validation precedes
service changes. Web and Android receive an honest unsupported result; they
never substitute a WAN/TCP/WebSocket transport for UDP.

`NmeaUdpPlugin.swift` dispatches start/stop work onto its own serial utility
queue. It uses a nonblocking BSD socket and DispatchSourceRead, with no blocking
receive loop on Capacitor's plugin queue. It binds only the current en0 IPv4
address and accepts only the configured unicast sender on that subnet, excluding
network/broadcast/self addresses. There is no multicast group membership,
broadcast flag, DNS lookup, scanning or outbound datagram.

Bounds are 16 KiB/datagram, 128 datagrams/dispatch turn, 512 KiB/s received,
64 datagrams/64 KiB per bridge batch at 40 ms, and at most 256 sentences per
datagram. Overflow is counted and surfaced as an input-budget diagnostic. Packet
boundaries never join a truncated sentence to the next datagram. Native receipt
time reaches the per-sensor clocks. Session IDs, generation checks and listener
removal fence cancelled/old callbacks; a ten-second bridge-start deadline avoids
an unresolved native start latching the lane. Native and app visibility handlers
close it in the background. Foreground/retry still asks the Pi-first policy.

The existing local-network purpose string now covers Pi, Signal K and gateway
connections. Broadcast/multicast remain unavailable until Apple grants its
restricted entitlement and an entitled physical-device test passes. No
entitlement is added or presumed from simulator success.

## Validation and limits

Focused tests exercise pure fields, real listener/store seams, pressure source
arbitration, native bridge cancellation/late callbacks, original clocks,
background/policy transitions, and bounds. Existing TCP reconnect, GPS, checksum,
datum, source-policy and gateway-page regressions remain active. Native source
registration is checked independently of JavaScript mocks.

The actual Gateway page was exercised in Chrome and WebKit at 300/375 px. The
test changes transport, validates a multicast-address refusal, reaches Connect,
checks its hit target above the tab bar, and receives the true web-unavailable
result. It records zero non-local requests and zero gateway WebSockets. This is
browser layout/source integration proof, not UDP radio, iOS privacy or battery
proof. The Swift source must compile on the release Mac before native readiness.

Primary references checked 16 October 2026:

- [Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
  and [multicast entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.multicast).
- [Trimble VTG fields and modes](https://receiverhelp.trimble.com/oem-gnss/nmea0183-messages-vtg.html)
  and [GLL fields](https://help.fieldsystems.trimble.com/sps/nmea0183-messages-gll.htm).
- [Simrad VLW water/ground fields](https://www.simrad.online/fisherysounder/help/online_help_en/_interface_specifications/GUID-51DA9964-CFC3-471E-B582-31D87FBCC897.html).
- [Dracal BAR20-N pressure output](https://www.dracal.com/en/product/bar20-n/)
  and [Yacht Devices XDR pressure examples](https://yachtd.com/news/seatalk1_autopilots.html).
- [SeaSmart manufacturer protocol](https://www.seasmart.net/pdf/SeaSmart_HTTP_Protocol_RevG_043012.pdf).

136-07 direct Signal K settings, authenticated stream and notifications are a
separate checkpoint. Root owns course/resource HTTP endpoints and the follow/
unfollow interlocks; this transport adds no autopilot or route-control UI.
