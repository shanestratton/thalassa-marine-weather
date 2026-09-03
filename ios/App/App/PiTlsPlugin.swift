import Foundation
import Capacitor

/**
 * PiTlsPlugin — pinned HTTPS to the boat's Raspberry Pi.
 *
 * Why this plugin exists
 * ──────────────────────
 * The Pi serves the boat LAN over TLS using a certificate issued from its own
 * pairing identity key (pi-cache/src/tlsIdentity.ts). No CA signs it — none
 * can, because a boat offshore has no DNS, no ACME, and no tolerance for a
 * certificate that expires mid-passage. iOS therefore rejects it in both
 * WKWebView `fetch` and CapacitorHttp, which is correct default behaviour and
 * the reason Pi integration was held out of the public beta.
 *
 * The fix is not to weaken validation, it is to REPLACE it with a stricter
 * one. System trust asks "did somebody in the trust store vouch for this
 * name?". We ask a sharper question: "is this the exact key the skipper pinned
 * when they paired with their own Pi?" A public CA cannot answer that, and an
 * attacker who obtains a perfectly valid certificate for some other name still
 * fails it.
 *
 * What is checked, and what deliberately is not
 * ────────────────────────────────────────────
 *  ✓ The leaf certificate's SubjectPublicKeyInfo equals the pinned SPKI, byte
 *    for byte, compared in constant time.
 *  ✗ Chain to a trusted root — there is none, by design.
 *  ✗ Hostname match — PiPairingService's model is "identity is the key, not
 *    the host" (a Pi that moves from calypso.local to a DHCP address is the
 *    same Pi). The key IS the name here; checking a hostname as well would add
 *    no security and would break the boat's own DHCP.
 *  ✗ Expiry — a pinned self-signed certificate has no revocation story that an
 *    offline boat could act on, and locking the chartplotter at a date is a
 *    worse failure than serving past it. The Pi re-issues within 30 days of
 *    expiry anyway.
 *
 * Because the pin is the identity key, this composes with — rather than
 * replaces — the existing challenge/response and per-payload signatures. TLS
 * adds confidentiality; those still carry authentication and integrity. An
 * on-path box cannot terminate this TLS session without the private key, which
 * is the same key it already could not answer a pairing challenge with.
 *
 * ATS note: overriding server-trust evaluation from a URLSession delegate is
 * permitted; App Transport Security governs the TLS version and cipher suite,
 * not who vouches for the certificate. The Pi is pinned to TLS 1.2+ with an EC
 * key, so the negotiated suite is ECDHE-ECDSA and ATS is satisfied without any
 * Info.plist exception. There is no NSAllowsArbitraryLoads here and there must
 * never be one — that would relax the whole app to get one host right.
 */
@objc(PiTlsPlugin)
public class PiTlsPlugin: CAPPlugin {

    /// One session per pinned key. URLSession keeps its delegate for its whole
    /// lifetime, and connection reuse across requests to the same Pi is worth
    /// having on a slow boat LAN.
    private var sessions: [String: URLSession] = [:]
    private let sessionsLock = NSLock()

    /// The one path reachable without a pin. See `request` for why this is
    /// enforced here rather than in JavaScript.
    private static let unpinnedPath = "/api/pair/info"

    private func session(forPin pin: Data?) -> URLSession {
        // Unpinned sessions are never cached or reused: each pairing attempt
        // gets a fresh delegate so a captured key can't leak between them.
        if pin == nil {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 30
            config.waitsForConnectivity = false
            config.allowsCellularAccess = false
            config.urlCache = nil
            return URLSession(configuration: config, delegate: PinnedTrustDelegate(pinnedSpki: nil), delegateQueue: nil)
        }

        let key = pin!.base64EncodedString()
        sessionsLock.lock()
        defer { sessionsLock.unlock() }
        if let existing = sessions[key] { return existing }

        let config = URLSessionConfiguration.ephemeral
        // The Pi is on the LAN; a request that has not connected in this long
        // is not going to. Kept short so discovery sweeps stay responsive.
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = false
        // Cellular and VPN routes are ALLOWED on a pinned session, and must be.
        //
        // This used to be `allowsCellularAccess = false`, on the reasoning that
        // "this is a link-local conversation and nothing else". That is not
        // true of this app: PiCacheService's host ladder falls back to the
        // punter's tailnet, where the Pi serves the identical certificate on
        // its 100.x address — the pin is key-equality, not hostname, so the
        // trust model does not change with the network. The flag therefore
        // forbade exactly the path the service is built to use.
        //
        // It failed silently and confusingly: with Tailscale up, iOS reports
        // the tunnel's path as cellular-backed, so URLSession refused the
        // request instantly with NSURLErrorNotConnectedToInternet — "The
        // Internet connection appears to be offline." — WITHOUT SENDING A
        // PACKET. Measured 2026-09-03: Shane's phone on Wi-Fi with Tailscale
        // connected, the Pi answering this Mac on both addresses, and zero
        // requests from the phone in the Pi's log over thirty minutes.
        //
        // Nothing is given up. A pinned session only completes against a peer
        // holding the pinned key, so a captive portal or a cellular proxy
        // cannot read it or stand in for the Pi — the pin, not the interface,
        // is what makes this safe. The unpinned pairing path above keeps the
        // restriction, because there it IS link-local by definition and there
        // is no pin yet to protect the exchange.
        config.allowsCellularAccess = true
        config.urlCache = nil

        let delegate = PinnedTrustDelegate(pinnedSpki: pin)
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        sessions[key] = session
        return session
    }

    /**
     * request — perform one pinned HTTPS call.
     *
     * Mirrors the shape of CapacitorHttp's get/post so services/piTls.ts can
     * stand in for it call-for-call: { url, method, headers, data, pinnedSpki,
     * connectTimeout, readTimeout, responseType }.
     */
    @objc func request(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("A url is required")
            return
        }
        guard url.scheme?.lowercased() == "https" else {
            // Refusing here rather than in JS keeps the guarantee on the side
            // of the boundary that enforces it: no caller can talk cleartext
            // to the Pi by constructing a different URL.
            call.reject("Refusing a non-HTTPS Pi URL — the boat LAN is encrypted or it is nothing")
            return
        }
        // ── First contact ──────────────────────────────────────────────
        // Pairing is a chicken-and-egg: the key to pin is the very thing the
        // Pi is about to hand over. So exactly one path may be fetched with no
        // pin — the pairing card — and the response carries `peerSpki`, the
        // key that actually terminated the TLS session. JS then requires that
        // it equals the advertised publicKeySpki AND that the same key answers
        // a random challenge, before anything is stored.
        //
        // That binds the encrypted channel to the pairing identity: the TOFU
        // window is exactly the one the skipper already sees on the pairing
        // card, and it cannot be widened by asking for a different path,
        // because the check is here rather than in JavaScript where a future
        // call site could forget it.
        let pin = call.getString("pinnedSpki").flatMap { Data(base64Encoded: $0) }.flatMap { $0.isEmpty ? nil : $0 }
        if pin == nil && url.path != Self.unpinnedPath {
            call.reject(
                "Refusing \(url.path) without a pinned key — only \(Self.unpinnedPath) may be fetched while pairing",
                "PIN_REQUIRED"
            )
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = (call.getString("method") ?? "GET").uppercased()
        request.timeoutInterval = Double(call.getInt("readTimeout") ?? 30000) / 1000.0
        // A stale cached body would silently defeat the freshness the app
        // expects from a local cache server.
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData

        if let headers = call.getObject("headers") {
            for (name, value) in headers {
                if let value = value as? String { request.setValue(value, forHTTPHeaderField: name) }
            }
        }
        if let body = call.getString("data") {
            request.httpBody = body.data(using: .utf8)
            if request.value(forHTTPHeaderField: "Content-Type") == nil {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
        }

        let wantsBase64 = (call.getString("responseType") ?? "text").lowercased() == "arraybuffer"

        let session = self.session(forPin: pin)
        session.dataTask(with: request) { [weak session] data, response, error in
            if let error = error as NSError? {
                // Surface the pin failure distinctly. "cancelled" is what a
                // rejected server trust looks like from up here, and reporting
                // it as a generic network blip would send the next reader
                // hunting for a Wi-Fi problem that does not exist.
                if error.code == NSURLErrorCancelled || error.code == NSURLErrorServerCertificateUntrusted {
                    call.reject(
                        "Pi certificate did not match the paired key — refusing the connection",
                        "PIN_MISMATCH"
                    )
                    return
                }
                call.reject(error.localizedDescription, String(error.code))
                return
            }
            guard let http = response as? HTTPURLResponse else {
                call.reject("No HTTP response from the Pi")
                return
            }

            var headers: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                if let key = key as? String, let value = value as? String { headers[key] = value }
            }

            let payload = data ?? Data()
            // The key that actually terminated this TLS session. On a pinned
            // request it necessarily equals the pin; on the pairing fetch it is
            // what JS binds the advertised identity to.
            let peerSpki = (session?.delegate as? PinnedTrustDelegate)?.observedSpki?.base64EncodedString() ?? ""
            call.resolve([
                "status": http.statusCode,
                "headers": headers,
                "peerSpki": peerSpki,
                "data": wantsBase64 ? payload.base64EncodedString() : (String(data: payload, encoding: .utf8) ?? ""),
            ])
        }.resume()
    }
}

/**
 * The trust decision itself, kept in its own type so it has no access to the
 * plugin's call state and cannot be talked out of its answer.
 */
final class PinnedTrustDelegate: NSObject, URLSessionDelegate {

    /// nil means "pairing fetch": accept the certificate but report its key, so
    /// JS can bind it to the pairing card and the challenge. Only ever reached
    /// for /api/pair/info — the plugin refuses every other path without a pin.
    private let pinnedSpki: Data?

    /// The leaf key observed on the handshake, for the caller to check.
    private(set) var observedSpki: Data?

    init(pinnedSpki: Data?) {
        self.pinnedSpki = pinnedSpki
    }

    /// ASN.1 SubjectPublicKeyInfo prefix for id-ecPublicKey / prime256v1.
    /// SecKeyCopyExternalRepresentation hands back a bare X9.63 point for an EC
    /// key, but the app pins full SPKI DER (that is what Node exported and what
    /// WebCrypto imports). Re-attaching the header is what makes the two
    /// directly comparable, rather than teaching either side a second format.
    private static let p256SpkiHeader = Data([
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86,
        0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
        0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03,
        0x42, 0x00
    ])

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        guard let presented = Self.leafSpki(of: trust) else {
            NSLog("[PiTls] could not read a P-256 public key from the Pi's certificate")
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        observedSpki = presented

        guard let pinnedSpki = pinnedSpki else {
            // Pairing fetch. Accepting here is not a trust decision — nothing
            // is stored and no app data is sent until JS has matched this key
            // against the pairing card AND a signed challenge.
            completionHandler(.useCredential, URLCredential(trust: trust))
            return
        }

        guard Self.constantTimeEquals(presented, pinnedSpki) else {
            NSLog("[PiTls] certificate key does not match the paired Pi — rejecting")
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        // Matched the pinned key: this IS the skipper's Pi. Accept the trust
        // object as-is — deliberately without SecTrustEvaluate, which would
        // only ever ask the unanswerable CA question.
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    /// Full SPKI DER of the leaf certificate's public key, or nil.
    private static func leafSpki(of trust: SecTrust) -> Data? {
        guard let certificate = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first,
              let key = SecCertificateCopyKey(certificate),
              let raw = SecKeyCopyExternalRepresentation(key, nil) as Data? else { return nil }

        // 0x04 || X || Y for P-256 — 65 bytes. Anything else is not the curve
        // the Pi issues on, so treat it as a mismatch rather than guessing.
        guard raw.count == 65, raw.first == 0x04 else { return nil }
        return p256SpkiHeader + raw
    }

    /// Length-independent, early-exit-free comparison. The pinned value is not
    /// secret, so this is belt-and-braces rather than load-bearing — but a
    /// timing-variable memcmp in a trust decision is the kind of thing that
    /// becomes load-bearing later, in code nobody re-reads.
    private static func constantTimeEquals(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var difference: UInt8 = 0
        for index in 0..<a.count { difference |= a[index] ^ b[index] }
        return difference == 0
    }
}
