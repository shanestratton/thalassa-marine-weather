import Foundation
import Capacitor
import AVFoundation
import Vision
import VisionKit
import UIKit

/**
 * DataScannerPlugin — Native barcode / QR scanner for Capacitor.
 *
 * Replaces @capacitor-mlkit/barcode-scanning (Google MLKit) with Apple's
 * first-party `DataScannerViewController` from VisionKit (iOS 16+).
 *
 * Why we switched:
 *   - MLKit ships without a platform load command in its framework binary,
 *     which Xcode flags as a warning on every build.
 *   - MLKit adds ~30 MB to the app binary (ML models, TensorFlow Lite).
 *   - DataScannerViewController is Apple-maintained, purpose-built for
 *     iOS 16+, and does everything we need for inventory scanning.
 *
 * Exposed TypeScript API (mirrors the old MLKit surface so call sites
 * barely change):
 *   - checkPermissions() → { camera: 'granted' | 'denied' | 'prompt' }
 *   - requestPermissions() → { camera: 'granted' | 'denied' }
 *   - scan({ formats? }) → { barcodes: [{ rawValue, format }] }
 *   - isSupported() → { supported: boolean, reason?: string }
 */
@objc(DataScannerPlugin)
public class DataScannerPlugin: CAPPlugin {

    // Retain the VC while it's presented — otherwise it gets deallocated
    // the moment `present()` returns.
    private var scannerVC: DataScannerViewController?
    // The Capacitor call we're currently serving. Stashed so the VC
    // delegate can resolve it when a barcode is recognised or the user
    // cancels.
    private var pendingCall: CAPPluginCall?
    // Delegate object kept around for the life of the scan session.
    private var delegateProxy: ScannerDelegateProxy?

    // MARK: - Permissions
    // `checkPermissions` / `requestPermissions` are declared on `CAPPlugin`
    // itself so Capacitor can wire generic permission-plumbing calls to any
    // plugin. We override both with our camera-specific implementation —
    // `override public` is required because the base methods are public.

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        let state = AVCaptureDevice.authorizationStatus(for: .video)
        call.resolve(["camera": permissionString(for: state)])
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        let state = AVCaptureDevice.authorizationStatus(for: .video)
        if state == .notDetermined {
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    call.resolve(["camera": granted ? "granted" : "denied"])
                }
            }
        } else {
            call.resolve(["camera": self.permissionString(for: state)])
        }
    }

    private func permissionString(for state: AVAuthorizationStatus) -> String {
        switch state {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        case .notDetermined: return "prompt"
        @unknown default: return "denied"
        }
    }

    // MARK: - Support check
    //
    // `DataScannerViewController.isSupported` / `.isAvailable` are
    // main-actor-isolated under Swift 6 strict concurrency, so every
    // access must happen on the main thread. We dispatch explicitly
    // rather than annotating the plugin methods @MainActor — Capacitor
    // invokes plugin entry points off the main thread and we don't want
    // to deadlock the bridge.

    @objc func isSupported(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else {
            call.resolve([
                "supported": false,
                "reason": "iOS 16.0 or later required."
            ])
            return
        }
        DispatchQueue.main.async {
            let supported = DataScannerViewController.isSupported
            let available = DataScannerViewController.isAvailable
            if !supported {
                call.resolve([
                    "supported": false,
                    "reason": "Device does not support DataScannerViewController (requires A12 Bionic or newer with neural engine)."
                ])
                return
            }
            if !available {
                call.resolve([
                    "supported": false,
                    "reason": "DataScannerViewController not available — check camera permissions."
                ])
                return
            }
            call.resolve(["supported": true])
        }
    }

    // MARK: - Scan

    @objc func scan(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else {
            call.reject("iOS 16.0 or later required for DataScannerViewController")
            return
        }

        // Camera permission must already be granted. If not, fail early
        // with a message callers can distinguish from "user cancelled".
        let authState = AVCaptureDevice.authorizationStatus(for: .video)
        if authState != .authorized {
            call.reject("Camera permission not granted.")
            return
        }

        // Optional `formats` array — if omitted, accept all supported
        // barcode types. Map our shared format strings to VisionKit
        // symbologies. Any format we don't recognise is silently dropped.
        let requested = call.getArray("formats", String.self) ?? []
        let symbologies: [VNBarcodeSymbology] = mapFormats(requested)

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            // Check support/availability inside the main-thread block —
            // both properties are main-actor-isolated under Swift 6.
            guard DataScannerViewController.isSupported,
                  DataScannerViewController.isAvailable else {
                call.reject("DataScannerViewController is not supported or available on this device.")
                return
            }

            let recognizedTypes: [DataScannerViewController.RecognizedDataType] = [
                .barcode(symbologies: symbologies.isEmpty ? [] : symbologies)
            ]

            let vc = DataScannerViewController(
                recognizedDataTypes: Set(recognizedTypes),
                qualityLevel: .balanced,
                recognizesMultipleItems: false,
                isHighFrameRateTrackingEnabled: false,
                isPinchToZoomEnabled: true,
                isGuidanceEnabled: true,
                isHighlightingEnabled: true
            )

            let proxy = ScannerDelegateProxy { [weak self] result in
                self?.finishScan(with: result)
            }
            vc.delegate = proxy
            self.delegateProxy = proxy

            // Wrap in a nav controller so we can add a Cancel button.
            let nav = UINavigationController(rootViewController: vc)
            vc.title = "Scan Barcode"
            vc.navigationItem.leftBarButtonItem = UIBarButtonItem(
                barButtonSystemItem: .cancel,
                target: proxy,
                action: #selector(ScannerDelegateProxy.cancelTapped)
            )
            nav.modalPresentationStyle = .fullScreen

            self.scannerVC = vc
            self.pendingCall = call

            guard let rootVC = self.bridge?.viewController else {
                call.reject("No root view controller available to present scanner.")
                return
            }
            rootVC.present(nav, animated: true) {
                do {
                    try vc.startScanning()
                } catch {
                    self.finishScan(with: .failure(error))
                }
            }
        }
    }

    // Called by the delegate proxy when scanning completes (success,
    // cancel, or error). Dismisses the presented VC and resolves/rejects
    // the pending Capacitor call.
    @available(iOS 16.0, *)
    private func finishScan(with result: Result<RecognizedItem?, Error>) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let call = self.pendingCall
            self.pendingCall = nil

            self.scannerVC?.stopScanning()
            self.scannerVC?.presentingViewController?.dismiss(animated: true)
            self.scannerVC = nil
            self.delegateProxy = nil

            switch result {
            case .success(let item):
                guard let item = item else {
                    // User cancelled — match MLKit convention of returning
                    // an empty barcodes array rather than an error.
                    call?.resolve(["barcodes": []])
                    return
                }
                if case .barcode(let barcode) = item {
                    let rawValue = barcode.payloadStringValue ?? ""
                    let format = symbologyToString(barcode.observation.symbology)
                    call?.resolve([
                        "barcodes": [
                            ["rawValue": rawValue, "format": format]
                        ]
                    ])
                } else {
                    call?.resolve(["barcodes": []])
                }
            case .failure(let err):
                call?.reject("Scanner error: \(err.localizedDescription)")
            }
        }
    }

    // MARK: - Format mapping

    /// Map our cross-platform format strings to VisionKit symbologies.
    /// Keeps the TypeScript API stable (same strings the old MLKit
    /// `BarcodeFormat` enum used, lowercased).
    @available(iOS 16.0, *)
    private func mapFormats(_ formats: [String]) -> [VNBarcodeSymbology] {
        if formats.isEmpty {
            // No filter → return default common set.
            return [.ean13, .ean8, .upce, .code128, .code39, .qr]
        }
        var out: [VNBarcodeSymbology] = []
        for f in formats {
            switch f.lowercased() {
            case "ean13", "ean-13": out.append(.ean13)
            case "ean8", "ean-8": out.append(.ean8)
            // UPC-A is structurally a 13-digit EAN-13 with a leading 0,
            // so VisionKit detects it via .ean13. Alias it.
            case "upca", "upc-a": if !out.contains(.ean13) { out.append(.ean13) }
            case "upce", "upc-e": out.append(.upce)
            case "code128": out.append(.code128)
            case "code39": out.append(.code39)
            case "code93": out.append(.code93)
            case "qrcode", "qr": out.append(.qr)
            case "aztec": out.append(.aztec)
            case "datamatrix": out.append(.dataMatrix)
            case "pdf417": out.append(.pdf417)
            case "itf14": out.append(.itf14)
            case "i2of5": out.append(.i2of5)
            default: break // silently drop unknown formats
            }
        }
        // Dedup while preserving order.
        var seen = Set<String>()
        return out.filter { seen.insert($0.rawValue).inserted }
    }
}

// MARK: - Delegate proxy
// Kept as a separate class so DataScannerPlugin (which must be @objc
// NSObject-derived via CAPPlugin) can retain it without forcing the
// delegate methods onto the plugin's own surface.

@available(iOS 16.0, *)
private final class ScannerDelegateProxy: NSObject, DataScannerViewControllerDelegate {

    private let completion: (Result<RecognizedItem?, Error>) -> Void
    private var delivered = false

    init(completion: @escaping (Result<RecognizedItem?, Error>) -> Void) {
        self.completion = completion
    }

    @objc func cancelTapped() {
        deliver(.success(nil))
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
        deliver(.success(item))
    }

    // Auto-fire when an item is first added. Most inventory scans are
    // "point and get the first hit", so we treat first-detection the
    // same as a tap.
    func dataScanner(
        _ dataScanner: DataScannerViewController,
        didAdd addedItems: [RecognizedItem],
        allItems: [RecognizedItem]
    ) {
        if let first = addedItems.first {
            deliver(.success(first))
        }
    }

    func dataScanner(
        _ dataScanner: DataScannerViewController,
        becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
    ) {
        deliver(.failure(NSError(
            domain: "DataScannerPlugin",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: "Scanner became unavailable: \(error)"]
        )))
    }

    private func deliver(_ result: Result<RecognizedItem?, Error>) {
        if delivered { return }
        delivered = true
        completion(result)
    }
}

/// Map VNBarcodeSymbology back to our cross-platform format string
/// (free function so both the plugin and proxy can reach it).
@available(iOS 16.0, *)
private func symbologyToString(_ symbology: VNBarcodeSymbology) -> String {
    switch symbology {
    case .ean13: return "Ean13"
    case .ean8: return "Ean8"
    case .upce: return "UpcE"
    case .code128: return "Code128"
    case .code39, .code39Checksum, .code39FullASCII, .code39FullASCIIChecksum: return "Code39"
    case .code93, .code93i: return "Code93"
    case .qr, .microQR: return "QrCode"
    case .aztec: return "Aztec"
    case .dataMatrix: return "DataMatrix"
    case .pdf417: return "Pdf417"
    case .itf14: return "Itf14"
    case .i2of5, .i2of5Checksum: return "I2of5"
    default: return symbology.rawValue
    }
}
