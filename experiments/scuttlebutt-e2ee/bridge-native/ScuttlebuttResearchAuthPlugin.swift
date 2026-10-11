// ISOLATED auth + one-peer research bridge. This is NOT PrivateMessageNativePort and
// never exposes native keys, stores, pickles, coordinator handles or tokens.
import Foundation
import CoreFoundation
import Capacitor

@objc(ScuttlebuttResearchAuthPlugin)
public final class ScuttlebuttResearchAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScuttlebuttResearchAuthPlugin"
    public let jsName = "ScuttlebuttResearchAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configuration", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fenceSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "currentAccount", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lifecycleState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledgeClosedPresentation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "messageState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "messagePrivateAdmission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "messagePairingCard", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "messageInspectPeerCard", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "messageConfirmPeer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "messageRegisterDevice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "messageClaimPeer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "messageRefreshPolicy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "messageRequireProtected", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "messageAccountMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "messageThread", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "messagePrepareText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "messageSendPending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "messageSyncInbox", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "privateMessageIssue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "privateMessageReadiness", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "privateMessagePermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "privateMessageInbox", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "privateMessageThread", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "privateMessageSendText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "privateMessageRetryPending", returnType: CAPPluginReturnPromise),
    ]
    private let hostLock = NSLock()
    private let sceneAuthority = ResearchSceneAuthority()
    @MainActor var onScenePresentationClosed: (() -> Void)?
    @MainActor private var sceneAcknowledgementInFlight = false
    private var host: ResearchAuthHost?
    private var trusted: ResearchAuthConfiguration?
    private var messaging: ResearchMessagingAdapter?
    private var privateMessaging: ResearchPrivateMessageAdapter?
    private var messageTransport: VodozemacRelayTransport?
    private static let unavailable: [String: Any] = ["status": "unavailable", "reason": "unavailable"]

    // Native App-owned callbacks, never a JS option or a fixture mutation.
    @MainActor func suspendSceneAuthority() {
        let descriptor = sceneAuthority.suspend {
            self.hostLock.lock(); let existing = self.host; self.hostLock.unlock()
            guard let existing else { return .absentAuthority }
            do {
                _ = try existing.facade.fenceSession(mode: .verify)
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
                ResearchFullAppProtectedUiFixture.noteSceneVerifyCompletion(existing.facade)
#endif
                return .verifyCompleted
            } catch { return .failed }
        }
        notifyListeners("sceneAuthorityChanged", data: descriptor.json, retainUntilConsumed: false)
    }
    @MainActor func sceneBecameActive() -> Bool {
        let descriptor = sceneAuthority.becameActive()
        notifyListeners("sceneAuthorityChanged", data: descriptor.json, retainUntilConsumed: false)
        return descriptor.phase == .active
    }
    func nativeSceneDescriptor() -> ResearchSceneAuthority.Descriptor { sceneAuthority.descriptor() }

    @objc public func lifecycleState(_ call: CAPPluginCall) {
        guard exactOptions(call, []) else { call.resolve(Self.unavailable); return }
        call.resolve(sceneAuthority.descriptor().json)
    }

    // CAPPlugin retains event arrays without a bound. Register only this fixed
    // nonretaining event on main; consumers explicitly reread current state.
    @objc public override func addListener(_ call: CAPPluginCall) {
        guard Set(call.jsObjectRepresentation.keys) == ["eventName"],
              call.getString("eventName") == "sceneAuthorityChanged" else { call.resolve(Self.unavailable); return }
        DispatchQueue.main.async { self.addSceneListener(call) }
    }
    @MainActor private func addSceneListener(_ call: CAPPluginCall) {
        guard !hasListeners("sceneAuthorityChanged") else { call.reject("Unavailable"); return }
        super.addListener(call)
        notifyListeners("sceneAuthorityChanged", data: sceneAuthority.descriptor().json, retainUntilConsumed: false)
    }
    @objc public override func removeListener(_ call: CAPPluginCall) {
        guard Set(call.jsObjectRepresentation.keys) == ["eventName", "callbackId"],
              call.getString("eventName") == "sceneAuthorityChanged" else { call.resolve(Self.unavailable); return }
        DispatchQueue.main.async { self.removeSceneListener(call) }
    }
    @MainActor private func removeSceneListener(_ call: CAPPluginCall) { super.removeListener(call) }
    @objc public override func removeAllListeners(_ call: CAPPluginCall) {
        guard Set(call.jsObjectRepresentation.keys).isEmpty else { call.resolve(Self.unavailable); return }
        DispatchQueue.main.async { self.removeAllSceneListeners(call) }
    }
    @MainActor private func removeAllSceneListeners(_ call: CAPPluginCall) { super.removeAllListeners(call) }

    @objc public func acknowledgeClosedPresentation(_ call: CAPPluginCall) {
        guard exactOptions(call, ["epoch", "domFacts"]),
              let epoch = call.getString("epoch"), Self.canonicalEpoch(epoch),
              let options = call.getObject("domFacts"), Self.closedDomFacts(options)?.isClosed == true else {
            call.resolve(Self.unavailable); return
        }
        DispatchQueue.main.async { self.observeClosedPresentation(epoch: epoch, call: call) }
    }
    @MainActor private func observeClosedPresentation(epoch: String, call: CAPPluginCall) {
        guard !sceneAcknowledgementInFlight, sceneAuthority.mayObserveClosure(epoch: epoch),
              let ownedView = webView, let ownedWindow = ownedView.window,
              !ownedView.isLoading, let ownedURL = Self.ownedDocumentURL(ownedView.url),
              let ownedItem = ownedView.backForwardList.currentItem, ownedItem.url == ownedURL,
              ownedWindow.windowScene?.activationState == .foregroundActive,
              onScenePresentationClosed != nil else { call.resolve(Self.unavailable); return }
        sceneAcknowledgementInFlight = true
        // Fixed read-only DOM query. No supplied JS/function, text, password or
        // message value is returned; only five bounded booleans cross WebKit.
        let script = """
        (() => {
          if (document.readyState !== 'complete') throw new Error('Unavailable');
          const compose = document.querySelector('input[aria-label="Message Paired sailor"]');
          const password = document.getElementById('pilot-password');
          const labels = ['Sign in and verify','Reverify','Explicit logout','Check native setup and open messages'];
          const buttons = document.querySelectorAll('button');
          if (buttons.length > 128) throw new Error('Unavailable');
          const controls = Array.from(buttons).filter(node => node.textContent.length <= 128 && labels.includes(node.textContent.trim()));
          const complete = labels.every(label => controls.filter(node => node.textContent.trim() === label).length === 1);
          const open = controls.filter(node => node.textContent.trim() === 'Check native setup and open messages');
          return {logPresent: !!document.querySelector('[role="log"]'),
            composeEmpty: !compose || compose.value === '', passwordEmpty: !!password && password.value === '',
            privateOpenEnabled: open.some(node => !node.disabled),
            verificationControlsDisabled: complete && controls.length === labels.length && controls.every(node => node.disabled)};
        })()
        """
        ownedView.evaluateJavaScript(script) { [weak self, weak ownedView, weak ownedWindow] raw, error in
            DispatchQueue.main.async {
                guard let self else { call.resolve(Self.unavailable); return }
                defer { self.sceneAcknowledgementInFlight = false }
                guard error == nil, let ownedView, let ownedWindow, self.webView === ownedView,
                      ownedView.window === ownedWindow, ownedWindow.windowScene?.activationState == .foregroundActive,
                      !ownedView.isLoading, Self.ownedDocumentURL(ownedView.url) == ownedURL,
                      ownedView.backForwardList.currentItem === ownedItem, ownedItem.url == ownedURL,
                      self.sceneAuthority.mayObserveClosure(epoch: epoch),
                      let facts = Self.closedDomFacts(raw), facts.isClosed,
                      let release = self.onScenePresentationClosed else { call.resolve(Self.unavailable); return }
                do {
                    let descriptor = try self.sceneAuthority.acknowledge(epoch: epoch, observed: facts)
                    release()
                    self.notifyListeners("sceneAuthorityChanged", data: descriptor.json, retainUntilConsumed: false)
                    call.resolve(descriptor.json)
                } catch { call.resolve(Self.unavailable) }
            }
        }
    }
    private static func canonicalEpoch(_ value: String) -> Bool {
        value.utf8.count == 36 && UUID(uuidString: value)?.uuidString.lowercased() == value
    }
    private static func ownedDocumentURL(_ candidate: URL?) -> URL? {
        guard let url = candidate, url.scheme == "capacitor", url.host == "localhost",
              url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
              ["capacitor://localhost", "capacitor://localhost/"].contains(url.absoluteString) else { return nil }
        return url
    }
    private static func closedDomFacts(_ raw: Any?) -> ResearchSceneAuthority.ClosedDomFacts? {
        let names = ["logPresent", "composeEmpty", "passwordEmpty", "privateOpenEnabled", "verificationControlsDisabled"]
        guard let row = raw as? [String: Any], Set(row.keys) == Set(names) else { return nil }
        var values: [String: Bool] = [:]
        for name in names {
            guard let number = row[name] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
            values[name] = number.boolValue
        }
        guard let log = values["logPresent"], let compose = values["composeEmpty"], let password = values["passwordEmpty"],
              let open = values["privateOpenEnabled"], let controls = values["verificationControlsDisabled"] else { return nil }
        return .init(logPresent: log, composeEmpty: compose, passwordEmpty: password,
            privateOpenEnabled: open, verificationControlsDisabled: controls)
    }

    public override func load() {
        trusted = try? ResearchAuthConfiguration.bundled()
        DispatchQueue.main.async {
            self.notifyListeners("sceneAuthorityChanged", data: self.sceneAuthority.descriptor().json, retainUntilConsumed: false)
        }
    }

    private func facade() throws -> VodozemacSessionFacade {
        hostLock.lock(); defer { hostLock.unlock() }
        guard let configuration = trusted else { throw ResearchAuthHostError.unavailable }
        if let host { return host.facade }
        let opened = try ResearchAuthHost(configuration: configuration)
        host = opened
        return opened.facade
    }

    private func messagingAdapter() throws -> ResearchMessagingAdapter {
        hostLock.lock(); defer { hostLock.unlock() }
        guard let configuration = trusted else { throw ResearchAuthHostError.unavailable }
        if let messaging { return messaging }
        // Reuse the EXACT host/facade that authenticates SDK bearers. Creating a
        // second Directory/facade would create a different lifecycle authority.
        let opened: ResearchAuthHost
        if let host { opened = host }
        else { opened = try ResearchAuthHost(configuration: configuration); host = opened }
        let transport = try transportWhileLocked()
        let adapter = ResearchMessagingAdapter(facade: opened.facade, transport: transport,
            projectOrigin: ResearchAuthConfiguration.origin, conversationId: ResearchAuthConfiguration.conversation)
        messaging = adapter
        return adapter
    }

    private func transportWhileLocked() throws -> VodozemacRelayTransport {
        if let messageTransport { return messageTransport }
#if E2EE_LOCAL_UI_FIXTURE
        let transport = try ResearchLocalUiFixture.relayTransport()
#else
        let transport = try VodozemacRelayTransport(serviceOrigin: ResearchAuthConfiguration.origin,
            serviceBasePath: "/functions/v1/scuttlebutt-e2ee-pilot")
#endif
        messageTransport = transport
        return transport
    }

    private func privateMessageAdapter() throws -> ResearchPrivateMessageAdapter {
        hostLock.lock(); defer { hostLock.unlock() }
        guard let configuration = trusted else { throw ResearchAuthHostError.unavailable }
        if let privateMessaging { return privateMessaging }
        let opened: ResearchAuthHost
        if let host { opened = host }
        else { opened = try ResearchAuthHost(configuration: configuration); host = opened }
        let adapter = ResearchPrivateMessageAdapter(facade: opened.facade, transport: try transportWhileLocked())
        privateMessaging = adapter
        return adapter
    }

    private func exactOptions(_ call: CAPPluginCall, _ names: Set<String>) -> Bool {
#if E2EE_LOCAL_UI_FIXTURE
        guard ResearchLocalUiFixture.allow(method: call.methodName) else { return false }
#endif
        return Set(call.jsObjectRepresentation.keys) == names
    }

    @objc public func configuration(_ call: CAPPluginCall) {
        guard exactOptions(call, []), let configuration = trusted else {
            call.resolve(Self.unavailable); return
        }
        call.resolve(["status": "configured", "research": true,
            "label": "Encryption test—not reviewed", "supabaseUrl": ResearchAuthConfiguration.origin,
            "publicApiKey": configuration.publicApiKey])
    }

    @objc public func fenceSession(_ call: CAPPluginCall) {
        guard exactOptions(call, ["mode", "epoch"]), let epoch = call.getString("epoch"), Self.canonicalEpoch(epoch), let mode = call.getString("mode"),
              mode == "verify" || mode == "sign_out" else { call.resolve(Self.unavailable); return }
        do {
            // Durable native fence completes before the SDK is allowed to get a
            // token. No lock remains held across the later authentication await.
            try sceneAuthority.withActive(epoch: epoch) {
                let ownedFacade = try facade()
                let fence = try ownedFacade.fenceSession(mode: mode == "verify" ? .verify : .signOut)
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
            // Synchronous success only, after the existing durable fence returns.
            // No Task may reorder the completion relative to UIKit observations.
                if mode == "verify" { ResearchFullAppProtectedUiFixture.noteSceneVerifyCompletion(ownedFacade) }
#endif
                call.resolve(["status": "fenced", "authFence": fence.authFence])
            }
        } catch { call.resolve(Self.unavailable) }
    }

    @objc public func authenticate(_ call: CAPPluginCall) {
        guard exactOptions(call, ["accessToken", "authFence", "epoch"]),
              let epoch = call.getString("epoch"), Self.canonicalEpoch(epoch),
              let bearer = call.getString("accessToken"), (1...8192).contains(bearer.utf8.count),
              let fence = call.getString("authFence"), fence.count == 36,
              UUID(uuidString: fence)?.uuidString.lowercased() == fence,
              let admitted = try? sceneAuthority.begin(epoch: epoch, { try facade() }) else { call.resolve(Self.unavailable); return }
        Task {
            do {
                try self.sceneAuthority.withCurrent(admitted.0) { () }
                let account = try await admitted.1.authenticate(accessToken: bearer, authFence: fence)
                try self.sceneAuthority.withCurrent(admitted.0) { call.resolve(Self.result(account)) }
            } catch { call.resolve(Self.unavailable) }
        }
    }

    @objc public func currentAccount(_ call: CAPPluginCall) {
        guard exactOptions(call, ["epoch"]), let epoch = call.getString("epoch"), Self.canonicalEpoch(epoch) else { call.resolve(Self.unavailable); return }
        do {
            try sceneAuthority.withActive(epoch: epoch) {
                hostLock.lock(); let existing = host; hostLock.unlock()
                guard let account = existing?.facade.currentAccount() else { call.resolve(Self.unavailable); return }
                call.resolve(Self.result(account))
            }
        } catch { call.resolve(Self.unavailable) }
    }

    // These serializers never accept identity claims, generations, clocks,
    // URLs, wires, response bodies, records or native capabilities from JS.
    @objc public func messageState(_ call: CAPPluginCall) {
        message(call, names: []) { try $0.messageState(credentialBinding: $1) }
    }
    @objc public func messagePrivateAdmission(_ call: CAPPluginCall) {
        message(call, names: []) { try $0.privateAdmissionState(credentialBinding: $1) }
    }
    @objc public func messagePairingCard(_ call: CAPPluginCall) {
        message(call, names: []) { try $0.pairingCard(credentialBinding: $1) }
    }
    @objc public func messageInspectPeerCard(_ call: CAPPluginCall) {
        message(call, names: ["card"]) { adapter, binding in
            guard let card = call.getString("card") else { throw ResearchMessagingAdapterError.unavailable }
            return try adapter.inspectPeerCard(credentialBinding: binding, card: card)
        }
    }
    @objc public func messageConfirmPeer(_ call: CAPPluginCall) {
        message(call, names: ["card", "confirmedFingerprint"]) { adapter, binding in
            guard let card = call.getString("card"), let fingerprint = call.getString("confirmedFingerprint") else {
                throw ResearchMessagingAdapterError.unavailable
            }
            return try adapter.confirmPeer(credentialBinding: binding, card: card, confirmedFingerprint: fingerprint)
        }
    }
    @objc public func messageRegisterDevice(_ call: CAPPluginCall) {
        messageAsync(call, names: []) { try await $0.registerDevice(credentialBinding: $1) }
    }
    @objc public func messageClaimPeer(_ call: CAPPluginCall) {
        messageAsync(call, names: []) { try await $0.claimPeer(credentialBinding: $1) }
    }
    @objc public func messageRefreshPolicy(_ call: CAPPluginCall) {
        messageAsync(call, names: []) { try await $0.refreshPolicy(credentialBinding: $1) }
    }
    @objc public func messageRequireProtected(_ call: CAPPluginCall) {
        messageAsync(call, names: []) { try await $0.requireProtected(credentialBinding: $1) }
    }
    @objc public func messageAccountMode(_ call: CAPPluginCall) {
        messageAsync(call, names: []) { try await $0.refreshAccountMode(credentialBinding: $1) }
    }
    @objc public func messageThread(_ call: CAPPluginCall) {
        message(call, names: []) { try $0.thread(credentialBinding: $1) }
    }
    @objc public func messagePrepareText(_ call: CAPPluginCall) {
        message(call, names: ["clientMessageId", "text"]) { adapter, binding in
            guard let id = call.getString("clientMessageId"), let text = call.getString("text") else {
                throw ResearchMessagingAdapterError.unavailable
            }
            return try adapter.prepareText(credentialBinding: binding, clientMessageId: id, text: text)
        }
    }
    @objc public func messageSendPending(_ call: CAPPluginCall) {
#if E2EE_LOCAL_UI_FIXTURE
        // Refuse before even malformed pre-helper options can bypass counting.
        guard ResearchLocalUiFixture.allow(method: call.methodName) else { call.resolve(Self.unavailable); return }
#endif
        // Extract bounded string before Task. No caller options object is kept
        // as an authority source while the original native snapshot awaits HTTP.
        guard let id = call.getString("clientMessageId"), id.utf8.count == 36 else {
            call.resolve(Self.unavailable); return
        }
        messageAsync(call, names: ["clientMessageId"]) { adapter, binding in
            try await adapter.sendPending(credentialBinding: binding, clientMessageId: id)
        }
    }
    @objc public func messageSyncInbox(_ call: CAPPluginCall) {
        messageAsync(call, names: []) { try await $0.syncInbox(credentialBinding: $1) }
    }

    @objc public func privateMessageIssue(_ call: CAPPluginCall) {
        guard exactOptions(call, ["credentialBinding"]), let binding = call.getString("credentialBinding") else {
            call.resolve(Self.unavailable); return
        }
        do { try sceneAuthority.withActive { call.resolve(try privateMessageAdapter().issue(credentialBinding: binding).publish()) } }
        catch { call.resolve(Self.unavailable) }
    }
    @objc public func privateMessageReadiness(_ call: CAPPluginCall) {
        privateMessage(call, names: []) { try $0.readiness(lifecycleVersion: $1) }
    }
    @objc public func privateMessageThread(_ call: CAPPluginCall) {
        privateMessage(call, names: ["peerAccountId"]) { adapter, version in
            guard let peer = call.getString("peerAccountId") else { throw ResearchPrivateMessageAdapterError.unavailable }
            return try adapter.thread(lifecycleVersion: version, peerAccountId: peer)
        }
    }
    @objc public func privateMessagePermissions(_ call: CAPPluginCall) {
#if E2EE_LOCAL_UI_FIXTURE
        guard ResearchLocalUiFixture.allow(method: call.methodName) else { call.resolve(Self.unavailable); return }
#endif
        guard let peer = call.getString("peerAccountId") else { call.resolve(Self.unavailable); return }
        privateMessageAsync(call, names: ["peerAccountId"]) {
            try await $0.permissions(lifecycleVersion: $1, peerAccountId: peer)
        }
    }
    @objc public func privateMessageInbox(_ call: CAPPluginCall) {
        privateMessageAsync(call, names: []) { try await $0.inbox(lifecycleVersion: $1) }
    }
    @objc public func privateMessageSendText(_ call: CAPPluginCall) {
#if E2EE_LOCAL_UI_FIXTURE
        guard ResearchLocalUiFixture.allow(method: call.methodName) else { call.resolve(Self.unavailable); return }
#endif
        guard let peer = call.getString("peerAccountId"), let id = call.getString("clientMessageId"),
              let text = call.getString("text") else { call.resolve(Self.unavailable); return }
        privateMessageAsync(call, names: ["peerAccountId", "clientMessageId", "text"]) {
            try await $0.sendText(lifecycleVersion: $1, peerAccountId: peer, clientMessageId: id, text: text)
        }
    }
    @objc public func privateMessageRetryPending(_ call: CAPPluginCall) {
#if E2EE_LOCAL_UI_FIXTURE
        guard ResearchLocalUiFixture.allow(method: call.methodName) else { call.resolve(Self.unavailable); return }
#endif
        guard let peer = call.getString("peerAccountId"), let id = call.getString("clientMessageId") else {
            call.resolve(Self.unavailable); return
        }
        privateMessageAsync(call, names: ["peerAccountId", "clientMessageId"]) {
            try await $0.retryPending(lifecycleVersion: $1, peerAccountId: peer, clientMessageId: id)
        }
    }

    private func privateMessage(_ call: CAPPluginCall, names: Set<String>,
        operation: (ResearchPrivateMessageAdapter, String) throws -> ResearchPrivateMessageResult) {
        guard exactOptions(call, names.union(["lifecycleVersion"])),
              let version = call.getString("lifecycleVersion"), version.utf8.count == 36 else {
            call.resolve(Self.unavailable); return
        }
        do { try sceneAuthority.withActive { call.resolve(try operation(privateMessageAdapter(), version).publish()) } }
        catch { call.resolve(Self.unavailable) }
    }
    private func privateMessageAsync(_ call: CAPPluginCall, names: Set<String>,
        operation: @escaping (ResearchPrivateMessageAdapter, String) async throws -> ResearchPrivateMessageResult) {
        guard exactOptions(call, names.union(["lifecycleVersion"])),
              let version = call.getString("lifecycleVersion"), version.utf8.count == 36,
              let admitted = try? sceneAuthority.begin({ try privateMessageAdapter() }) else { call.resolve(Self.unavailable); return }
        Task {
            do {
                try self.sceneAuthority.withCurrent(admitted.0) { () }
                let result = try await operation(admitted.1, version)
                try self.sceneAuthority.withCurrent(admitted.0) {
                    let published = try result.publish()
#if E2EE_FULL_APP_PROTECTED_UI_FIXTURE
                ResearchFullAppProtectedUiFixture.notePmResult(method: call.methodName, status: published["status"] as? String ?? "unavailable")
#elseif E2EE_PROTECTED_UI_FIXTURE
                ResearchLocalUiFixture.notePmResult(method: call.methodName, status: published["status"] as? String ?? "unavailable")
#endif
                    call.resolve(published)
                }
            } catch {
#if E2EE_FULL_APP_PROTECTED_UI_FIXTURE
                ResearchFullAppProtectedUiFixture.notePmResult(method: call.methodName, status: "unavailable")
#elseif E2EE_PROTECTED_UI_FIXTURE
                ResearchLocalUiFixture.notePmResult(method: call.methodName, status: "unavailable")
#endif
                call.resolve(Self.unavailable)
            }
        }
    }

    private func message(_ call: CAPPluginCall, names: Set<String>,
                         operation: (ResearchMessagingAdapter, String) throws -> ResearchMessagingResult) {
        guard exactOptions(call, names.union(["credentialBinding"])),
              let binding = call.getString("credentialBinding"), binding.utf8.count == 36 else {
            call.resolve(Self.unavailable); return
        }
        do {
            try sceneAuthority.withActive {
                let result = try operation(messagingAdapter(), binding)
                call.resolve(try result.publish())
            }
        } catch { call.resolve(Self.unavailable) }
    }

    private func messageAsync(_ call: CAPPluginCall, names: Set<String>,
                              operation: @escaping (ResearchMessagingAdapter, String) async throws -> ResearchMessagingResult) {
        guard exactOptions(call, names.union(["credentialBinding"])),
              let binding = call.getString("credentialBinding"), binding.utf8.count == 36,
              let admitted = try? sceneAuthority.begin({ try messagingAdapter() }) else { call.resolve(Self.unavailable); return }
        Task {
            do {
                try self.sceneAuthority.withCurrent(admitted.0) { () }
                let result = try await operation(admitted.1, binding)
                // Final ORIGINAL-snapshot guard, immediately before JS resolve.
                // A commit may have succeeded earlier; late output still refuses.
                try self.sceneAuthority.withCurrent(admitted.0) { call.resolve(try result.publish()) }
            } catch { call.resolve(Self.unavailable) }
        }
    }

    private static func result(_ account: DmSessionAccount) -> [String: Any] {
        ["status": "authenticated", "account": ["accountId": account.accountId,
            "deviceId": account.deviceId, "credentialBinding": account.credentialBinding,
            "serverVerified": account.serverVerified]]
    }
}
