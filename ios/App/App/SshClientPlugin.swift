import Foundation
import Capacitor
import NMSSH

/**
 * SshClientPlugin — One-shot SSH command execution for Pi provisioning.
 *
 * Connects to a host via SSH, authenticates with password, executes a single
 * command, and returns stdout + exit code. Used by PiProvisionService to
 * install the Thalassa Cache server on the skipper's Raspberry Pi without
 * them ever opening a terminal.
 *
 * Security notes:
 *   - Host key verification is skipped (local network, one-time setup)
 *   - Password is only held in memory for the duration of the call
 *   - All work happens on a background queue
 */
@objc(SshClientPlugin)
public class SshClientPlugin: CAPPlugin {

    @objc func execute(_ call: CAPPluginCall) {
        guard let host = call.getString("host"),
              let username = call.getString("username"),
              let password = call.getString("password"),
              let command = call.getString("command") else {
            call.reject("Missing required parameters: host, username, password, command")
            return
        }

        let port = call.getInt("port") ?? 22
        let timeout = call.getInt("timeout") ?? 300 // 5 min default

        DispatchQueue.global(qos: .userInitiated).async {
            let session = NMSSHSession(host: host, port: port, andUsername: username)
            session.timeout = timeout

            // Connect
            session.connect()
            guard session.isConnected else {
                call.reject("Could not connect to \(host):\(port) — check the IP and that SSH is enabled on the Pi")
                return
            }

            // Authenticate
            session.authenticate(byPassword: password)
            guard session.isAuthorized else {
                session.disconnect()
                call.reject("Wrong username or password")
                return
            }

            // Execute
            var error: NSError?
            let output = session.channel.execute(command, error: &error, timeout: NSNumber(value: timeout))

            let exitCode = session.channel.exitStatus()

            session.disconnect()

            if let error = error {
                call.reject("Command failed: \(error.localizedDescription)")
                return
            }

            call.resolve([
                "stdout": output ?? "",
                "exitCode": exitCode
            ])
        }
    }

    /// Quick connectivity check — connect + auth only, no command.
    @objc func testConnection(_ call: CAPPluginCall) {
        guard let host = call.getString("host"),
              let username = call.getString("username"),
              let password = call.getString("password") else {
            call.reject("Missing required parameters: host, username, password")
            return
        }

        let port = call.getInt("port") ?? 22

        DispatchQueue.global(qos: .userInitiated).async {
            let session = NMSSHSession(host: host, port: port, andUsername: username)
            session.timeout = 10

            session.connect()
            guard session.isConnected else {
                call.resolve(["reachable": false, "authenticated": false, "error": "Connection refused"])
                return
            }

            session.authenticate(byPassword: password)
            let authed = session.isAuthorized
            session.disconnect()

            call.resolve([
                "reachable": true,
                "authenticated": authed,
                "error": authed ? "" : "Wrong username or password"
            ])
        }
    }
}
