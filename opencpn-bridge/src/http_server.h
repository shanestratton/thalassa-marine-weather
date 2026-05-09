/*
 * http_server.h — wraps cpp-httplib in a Start/Stop lifecycle
 *
 * The plugin owns one HttpServer. Start() spawns a background thread
 * that runs the listen loop; Stop() blocks until the thread joins.
 * Routes are registered on construction and call into the
 * FeatureExtractor for /features queries.
 */

#ifndef THALASSA_HTTP_SERVER_H
#define THALASSA_HTTP_SERVER_H

#include <atomic>
#include <memory>
#include <string>
#include <thread>

class FeatureExtractor;

namespace httplib {
class Server;
}  // namespace httplib

class HttpServer {
public:
    HttpServer(std::string host, int port, FeatureExtractor* extractor);
    ~HttpServer();

    // Non-copyable.
    HttpServer(const HttpServer&) = delete;
    HttpServer& operator=(const HttpServer&) = delete;

    /** Start the listen loop in a background thread. Returns false if
     *  the server failed to bind (e.g. port in use). */
    bool Start();

    /** Stop the server and join the thread. Idempotent. */
    void Stop();

    bool IsRunning() const { return m_running.load(); }

private:
    std::string m_host;
    int m_port;
    FeatureExtractor* m_extractor;  // not owned
    std::unique_ptr<httplib::Server> m_server;
    std::thread m_thread;
    std::atomic<bool> m_running{false};
};

#endif  // THALASSA_HTTP_SERVER_H
