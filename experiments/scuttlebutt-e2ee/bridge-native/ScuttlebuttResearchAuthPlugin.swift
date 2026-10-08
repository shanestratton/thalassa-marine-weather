// ISOLATED auth + one-peer research bridge. This is NOT PrivateMessageNativePort and
// never exposes native keys, stores, pickles, coordinator handles or tokens.
import Foundation
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
    private var host: ResearchAuthHost?
    private var trusted: ResearchAuthConfiguration?
    private var messaging: ResearchMessagingAdapter?
    private var privateMessaging: ResearchPrivateMessageAdapter?
    private var messageTransport: VodozemacRelayTransport?
    private static let unavailable: [String: Any] = ["status": "unavailable", "reason": "unavailable"]

    public override func load() {
        trusted = try? ResearchAuthConfiguration.bundled()
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
        guard exactOptions(call, ["mode"]), let mode = call.getString("mode"),
              mode == "verify" || mode == "sign_out" else { call.resolve(Self.unavailable); return }
        do {
            // Durable native fence completes before the SDK is allowed to get a
            // token. No lock remains held across the later authentication await.
            let fence = try facade().fenceSession(mode: mode == "verify" ? .verify : .signOut)
            call.resolve(["status": "fenced", "authFence": fence.authFence])
        } catch { call.resolve(Self.unavailable) }
    }

    @objc public func authenticate(_ call: CAPPluginCall) {
        guard exactOptions(call, ["accessToken", "authFence"]),
              let bearer = call.getString("accessToken"), (1...8192).contains(bearer.utf8.count),
              let fence = call.getString("authFence"), fence.count == 36,
              UUID(uuidString: fence)?.uuidString.lowercased() == fence,
              let facade = try? facade() else { call.resolve(Self.unavailable); return }
        Task {
            do {
                let account = try await facade.authenticate(accessToken: bearer, authFence: fence)
                call.resolve(Self.result(account))
            } catch { call.resolve(Self.unavailable) }
        }
    }

    @objc public func currentAccount(_ call: CAPPluginCall) {
        guard exactOptions(call, []), let facade = try? facade(), let account = facade.currentAccount() else {
            call.resolve(Self.unavailable); return
        }
        call.resolve(Self.result(account))
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
        do { call.resolve(try privateMessageAdapter().issue(credentialBinding: binding).publish()) }
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
        do { call.resolve(try operation(privateMessageAdapter(), version).publish()) }
        catch { call.resolve(Self.unavailable) }
    }
    private func privateMessageAsync(_ call: CAPPluginCall, names: Set<String>,
        operation: @escaping (ResearchPrivateMessageAdapter, String) async throws -> ResearchPrivateMessageResult) {
        guard exactOptions(call, names.union(["lifecycleVersion"])),
              let version = call.getString("lifecycleVersion"), version.utf8.count == 36,
              let adapter = try? privateMessageAdapter() else { call.resolve(Self.unavailable); return }
        Task {
            do {
                let result = try await operation(adapter, version)
                call.resolve(try result.publish())
            } catch { call.resolve(Self.unavailable) }
        }
    }

    private func message(_ call: CAPPluginCall, names: Set<String>,
                         operation: (ResearchMessagingAdapter, String) throws -> ResearchMessagingResult) {
        guard exactOptions(call, names.union(["credentialBinding"])),
              let binding = call.getString("credentialBinding"), binding.utf8.count == 36 else {
            call.resolve(Self.unavailable); return
        }
        do {
            let result = try operation(messagingAdapter(), binding)
            call.resolve(try result.publish())
        } catch { call.resolve(Self.unavailable) }
    }

    private func messageAsync(_ call: CAPPluginCall, names: Set<String>,
                              operation: @escaping (ResearchMessagingAdapter, String) async throws -> ResearchMessagingResult) {
        guard exactOptions(call, names.union(["credentialBinding"])),
              let binding = call.getString("credentialBinding"), binding.utf8.count == 36,
              let adapter = try? messagingAdapter() else { call.resolve(Self.unavailable); return }
        Task {
            do {
                let result = try await operation(adapter, binding)
                // Final ORIGINAL-snapshot guard, immediately before JS resolve.
                // A commit may have succeeded earlier; late output still refuses.
                call.resolve(try result.publish())
            } catch { call.resolve(Self.unavailable) }
        }
    }

    private static func result(_ account: DmSessionAccount) -> [String: Any] {
        ["status": "authenticated", "account": ["accountId": account.accountId,
            "deviceId": account.deviceId, "credentialBinding": account.credentialBinding,
            "serverVerified": account.serverVerified]]
    }
}
