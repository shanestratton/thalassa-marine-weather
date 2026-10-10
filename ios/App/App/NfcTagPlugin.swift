import Foundation
import Capacitor
import CoreNFC

/**
 * NfcTagPlugin — the NFC tags on Ship's Stores boxes (126-11b).
 *
 * A box's tag holds one link, https://www.thalassawx.app/box/<random id>, and
 * nothing else (www: the apex redirects, and Apple follows no redirect). Holding an unlocked iPhone XS or later to it opens Thalassa on
 * that box (iOS reads the tag in the background and hands the universal link
 * to SceneDelegate); Scan box reads it from inside the app on any iPhone with
 * NFC, which is also the way in Airplane mode.
 *
 * Exposed to TypeScript as `NfcTag` (services/native/nfcTags.ts):
 *   - isAvailable() → { available }     an iPhone with NFC (not an iPad, not the simulator)
 *   - write({ url }) → { outcome, tagType? }
 *   - scan()         → { outcome, url? }
 *
 * Writing finds ONE tag and checks it before anything is sent: an NFC Forum
 * Type 2 tag of the MIFARE Ultralight family (NTAG213, 215 and 216 are), NDEF,
 * not locked, and big enough for the link (about 63 bytes; an NTAG213 holds
 * 144). It writes one URI record, then reads the tag straight back where it
 * sits on the box, so a tag that can't be read there (a plain sticker on
 * metal) is caught at once. It NEVER locks a tag: any tag can be rewritten
 * for another box.
 *
 * The bridge-queue trap (capacitor-bridge-queue): Capacitor runs every plugin
 * call on one serial queue, so a call that waits stalls every other plugin.
 * Each call here hands its job to the main queue and returns at once; every
 * answer comes from a Core NFC callback, and `NfcTagJob.finish` answers the
 * call once and invalidates the session on every way out (written, refused,
 * cancelled, timed out, or replaced by the next job). A session left open
 * would make the next one fail with "session already active".
 *
 * Needs com.apple.developer.nfc.readersession.formats = [TAG] (App.entitlements;
 * "NDEF" is refused by App Store validation) and NFCReaderUsageDescription.
 */
@objc(NfcTagPlugin)
public class NfcTagPlugin: CAPPlugin {
    /// The one job iOS's NFC sheet is running. Touched only on the main queue.
    private var job: NfcTagJob?

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": NFCTagReaderSession.readingAvailable])
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let url = call.getString("url"),
              let record = NFCNDEFPayload.wellKnownTypeURIPayload(string: url) else {
            call.resolve(["outcome": "failed"])
            return
        }
        start(NfcTagJob(call: call, writing: NFCNDEFMessage(records: [record]), url: url))
    }

    @objc func scan(_ call: CAPPluginCall) {
        start(NfcTagJob(call: call, writing: nil, url: nil))
    }

    /// Hand the job to the main queue and return: the bridge queue never waits on NFC.
    private func start(_ next: NfcTagJob) {
        DispatchQueue.main.async { [self] in
            // One sheet at a time: a job still open ends as cancelled, its session invalidated.
            job?.finish(["outcome": "cancelled"])
            job = next
            next.begin { [weak plugin = self, weak ended = next] in
                if let ended, plugin?.job === ended { plugin?.job = nil }
            }
        }
    }
}

/// One write or one read, run by iOS's NFC sheet, every step a Core NFC callback on the main queue.
final class NfcTagJob: NSObject, NFCTagReaderSessionDelegate {
    private var call: CAPPluginCall?
    /// The message to write; nil to read.
    private let message: NFCNDEFMessage?
    private let url: String?
    private var session: NFCTagReaderSession?
    private var onEnd: (() -> Void)?
    /// What iOS's sheet says as it closes on a tag that isn't a box tag: Scan box says what the app will.
    private var notOurs: String {
        message == nil ? "This tag isn't a box tag from Thalassa." : "This isn't an NFC tag this iPhone can write."
    }

    init(call: CAPPluginCall, writing message: NFCNDEFMessage?, url: String?) {
        self.call = call
        self.message = message
        self.url = url
    }

    func begin(onEnd: @escaping () -> Void) {
        self.onEnd = onEnd
        guard NFCTagReaderSession.readingAvailable,
              let session = NFCTagReaderSession(pollingOption: .iso14443, delegate: self, queue: .main) else {
            finish(["outcome": "unsupported"])
            return
        }
        self.session = session
        session.alertMessage = message == nil
            ? "Hold the top of your iPhone to the tag on the box."
            : "Hold the top of your iPhone to the tag on the box, and keep still until it says written."
        session.begin()
    }

    /// Answer the call once, then end the session. `words` shows on iOS's sheet as it closes.
    func finish(_ result: [String: Any], words: String? = nil) {
        guard let call else { return }
        self.call = nil
        if let words {
            session?.invalidate(errorMessage: words)
        } else {
            session?.invalidate()
        }
        session = nil
        call.resolve(result)
        onEnd?()
        onEnd = nil
    }

    // MARK: NFCTagReaderSessionDelegate

    func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {}

    func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
        // iOS closed the sheet: Cancel, the 60-second limit, or a system error. A job
        // already answered (including by our own invalidate) has nothing left to say.
        self.session = nil
        switch (error as? NFCReaderError)?.code {
        case .readerSessionInvalidationErrorUserCanceled?, .readerSessionInvalidationErrorSessionTimeout?:
            finish(["outcome": "cancelled"])
        case .readerErrorUnsupportedFeature?:
            finish(["outcome": "unsupported"])
        default:
            finish(["outcome": "failed"])
        }
    }

    func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
        guard tags.count == 1, let found = tags.first else {
            session.alertMessage = "More than one tag here. Hold your iPhone to just one."
            session.restartPolling()
            return
        }
        // Box tags are MIFARE Ultralight-family Type 2 tags (NTAG213, 215, 216). MIFARE
        // Classic, DESFire, Plus, ISO 15693 and FeliCa tags are refused before anything is sent.
        guard case let .miFare(tag) = found, tag.mifareFamily == .ultralight else {
            finish(["outcome": "not_ndef"], words: notOurs)
            return
        }
        session.connect(to: found) { [weak self] error in
            guard let self else { return }
            if error != nil {
                self.finish(["outcome": "failed"], words: "The tag moved away.")
                return
            }
            tag.queryNDEFStatus { [weak self] status, capacity, error in
                guard let self else { return }
                if error != nil {
                    self.finish(["outcome": "failed"], words: "The tag moved away.")
                } else if status == .notSupported {
                    self.finish(["outcome": "not_ndef"], words: self.notOurs)
                } else if let message = self.message {
                    self.write(message, to: tag, status: status, capacity: capacity)
                } else {
                    self.read(tag)
                }
            }
        }
    }

    // MARK: Write, then read it straight back

    private func write(_ message: NFCNDEFMessage, to tag: NFCMiFareTag, status: NFCNDEFStatus, capacity: Int) {
        if status == .readOnly {
            finish(["outcome": "read_only"], words: "This tag is locked and can't be rewritten.")
            return
        }
        // The whole message must fit: an NTAG213 holds 144 bytes, the box link about 63.
        guard capacity >= message.length else {
            finish(["outcome": "too_small"], words: "This tag is too small. Use NTAG213, 215 or 216.")
            return
        }
        tag.writeNDEF(message) { [weak self] error in
            guard let self else { return }
            if let error {
                switch (error as? NFCReaderError)?.code {
                case .ndefReaderSessionErrorTagNotWritable?:
                    self.finish(["outcome": "read_only"], words: "This tag is locked and can't be rewritten.")
                case .ndefReaderSessionErrorTagSizeTooSmall?:
                    self.finish(["outcome": "too_small"], words: "This tag is too small. Use NTAG213, 215 or 216.")
                default:
                    self.finish(["outcome": "failed"], words: "Not written. Hold still and try again.")
                }
                return
            }
            // Read it back where it sits on the box: a tag that can't be read there is caught now.
            tag.readNDEF { [weak self] read, error in
                guard let self else { return }
                guard error == nil, let read, Self.firstURI(read) == self.url else {
                    self.finish(["outcome": "not_verified"], words: "The tag didn't read back.")
                    return
                }
                // The tag's own name, best effort, for the check against the packet: NTAG21x
                // answer GET_VERSION (0x60). Nothing rides on it; the write is already proven.
                tag.sendMiFareCommand(commandPacket: Data([0x60])) { [weak self] version, error in
                    guard let self else { return }
                    var result: [String: Any] = ["outcome": "written"]
                    if error == nil, let type = Self.ntagName(version) { result["tagType"] = type }
                    self.session?.alertMessage = "Tag written"
                    self.finish(result)
                }
            }
        }
    }

    // MARK: Scan

    private func read(_ tag: NFCMiFareTag) {
        tag.readNDEF { [weak self] message, error in
            guard let self else { return }
            // A blank tag reads as a zero-length error: no link on it, so no box's tag.
            if let error, (error as? NFCReaderError)?.code != .ndefReaderSessionErrorZeroLengthMessage {
                self.finish(["outcome": "failed"], words: "The tag moved away.")
                return
            }
            self.session?.alertMessage = "Tag read"
            self.finish(["outcome": "read", "url": message.flatMap(Self.firstURI) ?? ""])
        }
    }

    /// The first URI record on the tag, as text.
    private static func firstURI(_ message: NFCNDEFMessage) -> String? {
        message.records.lazy.compactMap { $0.wellKnownTypeURIPayload()?.absoluteString }.first
    }

    /// NTAG213/215/216 by GET_VERSION's storage-size byte (NXP vendor 0x04, product type 0x04 = NTAG).
    private static func ntagName(_ version: Data) -> String? {
        let bytes = [UInt8](version)
        guard bytes.count >= 8, bytes[1] == 0x04, bytes[2] == 0x04 else { return nil }
        switch bytes[6] {
        case 0x0F: return "NTAG213"
        case 0x11: return "NTAG215"
        case 0x13: return "NTAG216"
        default: return nil
        }
    }
}
