import AuthenticationServices
import Capacitor
import UIKit

/**
 * Google OAuth in the system authentication session.
 *
 * SFSafariViewController is suitable for ordinary web content, but it does not
 * own an OAuth callback. ASWebAuthenticationSession does: iOS presents the
 * provider, captures only the registered callback scheme, and returns that URL
 * directly to this plugin. The default browser (including Chrome) therefore
 * cannot intercept or strand the sign-in.
 */
@objc(GoogleOAuthPlugin)
public final class GoogleOAuthPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "GoogleOAuthPlugin"
    public let jsName = "GoogleOAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise)
    ]

    private let allowedHost = "accounts.google.com"
    private let allowedCallbackScheme =
        "com.googleusercontent.apps.717700927804-t644h587eb4kaklh3cb495k2ec7q8q6v"
    private var authenticationSession: ASWebAuthenticationSession?
    private var pendingCall: CAPPluginCall?

    @objc func authorize(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.beginAuthorization(call)
        }
    }

    private func beginAuthorization(_ call: CAPPluginCall) {
        guard authenticationSession == nil, pendingCall == nil else {
            call.reject("A Google sign-in is already in progress", "GOOGLE_OAUTH_BUSY")
            return
        }
        guard let rawURL = call.getString("url"),
              rawURL.utf8.count <= 16_384,
              let url = URL(string: rawURL),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme == "https",
              components.host?.lowercased() == allowedHost,
              components.user == nil,
              components.password == nil else {
            call.reject("A valid Google authorization URL is required", "GOOGLE_OAUTH_INVALID_URL")
            return
        }
        guard call.getString("callbackScheme") == allowedCallbackScheme else {
            call.reject("The Google callback scheme is not registered for this app", "GOOGLE_OAUTH_INVALID_CALLBACK")
            return
        }

        pendingCall = call
        let session = ASWebAuthenticationSession(
            url: url,
            callbackURLScheme: allowedCallbackScheme
        ) { [weak self] callbackURL, error in
            DispatchQueue.main.async {
                self?.completeAuthorization(callbackURL: callbackURL, error: error)
            }
        }
        authenticationSession = session
        session.presentationContextProvider = self
        // Retain Google's system cookie jar so returning sailors can choose an
        // existing account. The OAuth request still uses prompt=select_account.
        session.prefersEphemeralWebBrowserSession = false

        guard session.start() else {
            finishWithError("Google sign-in could not be presented", code: "GOOGLE_OAUTH_PRESENTATION_FAILED")
            return
        }
    }

    private func completeAuthorization(callbackURL: URL?, error: Error?) {
        if let error = error as NSError? {
            if error.domain == ASWebAuthenticationSessionErrorDomain && error.code == 1 {
                finishWithError("CANCELLED", code: "CANCELLED")
            } else {
                finishWithError("Google sign-in did not complete", code: "GOOGLE_OAUTH_FAILED", error: error)
            }
            return
        }
        guard let callbackURL,
              callbackURL.scheme == allowedCallbackScheme,
              callbackURL.absoluteString.utf8.count <= 16_384 else {
            finishWithError("Google returned an invalid callback", code: "GOOGLE_OAUTH_INVALID_CALLBACK")
            return
        }

        let call = pendingCall
        pendingCall = nil
        authenticationSession = nil
        call?.resolve(["url": callbackURL.absoluteString])
    }

    private func finishWithError(_ message: String, code: String, error: Error? = nil) {
        let call = pendingCall
        pendingCall = nil
        authenticationSession = nil
        call?.reject(message, code, error)
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let window = bridge?.viewController?.view.window {
            return window
        }
        if let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap({ $0.windows })
            .first(where: { $0.isKeyWindow }) {
            return window
        }
        return ASPresentationAnchor()
    }
}
