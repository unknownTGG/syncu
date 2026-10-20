#include "server.h"

#include <atomic>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>

#include <nlohmann/json.hpp>

#include "api.h"
#include "audio.h"

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
using sock_t = SOCKET;
#define CLOSESOCK closesocket
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
using sock_t = int;
#define CLOSESOCK close
#define INVALID_SOCKET (-1)
#endif

namespace syncu {

namespace {

const char* kVersion = "0.1.0";

struct Job {
  std::atomic<double> progress{0.0};
  std::mutex mu;
  std::string message = "Queued";
  std::string result;  // JSON, set when done
  std::atomic<bool> done{false};
};

std::mutex g_jobsMu;
std::map<int, std::shared_ptr<Job>> g_jobs;
int g_nextJob = 1;

struct Request {
  std::string method, path, query, body;
  std::map<std::string, std::string> headers;  // lower-case keys
};

std::string lower(std::string s) {
  for (auto& c : s) c = char(std::tolower((unsigned char)c));
  return s;
}

bool readRequest(sock_t s, Request& req) {
  std::string data;
  char buf[65536];
  size_t headerEnd = std::string::npos;
  while (headerEnd == std::string::npos) {
    int n = recv(s, buf, sizeof(buf), 0);
    if (n <= 0) return false;
    data.append(buf, size_t(n));
    headerEnd = data.find("\r\n\r\n");
    if (data.size() > (1 << 20) && headerEnd == std::string::npos) return false;
  }
  std::istringstream hs(data.substr(0, headerEnd));
  std::string line;
  std::getline(hs, line);
  std::istringstream rl(line);
  std::string target;
  rl >> req.method >> target;
  auto q = target.find('?');
  req.path = target.substr(0, q);
  if (q != std::string::npos) req.query = target.substr(q + 1);
  while (std::getline(hs, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    auto c = line.find(':');
    if (c == std::string::npos) continue;
    std::string v = line.substr(c + 1);
    v.erase(0, v.find_first_not_of(' '));
    req.headers[lower(line.substr(0, c))] = v;
  }
  size_t len = req.headers.count("content-length")
                   ? size_t(std::stoul(req.headers["content-length"])) : 0;
  if (len > (64u << 20)) return false;
  req.body = data.substr(headerEnd + 4);
  while (req.body.size() < len) {
    int n = recv(s, buf, sizeof(buf), 0);
    if (n <= 0) return false;
    req.body.append(buf, size_t(n));
  }
  req.body.resize(len);
  return true;
}

void respond(sock_t s, int code, const std::string& body) {
  const char* text = code == 200 ? "OK" : code == 404 ? "Not Found"
                   : code == 403 ? "Forbidden" : "Bad Request";
  std::ostringstream o;
  o << "HTTP/1.1 " << code << " " << text << "\r\n"
    << "Content-Type: application/json\r\n"
    << "Content-Length: " << body.size() << "\r\n"
    << "Connection: close\r\n\r\n"
    << body;
  std::string out = o.str();
  size_t sent = 0;
  while (sent < out.size()) {
    int n = send(s, out.data() + sent, int(out.size() - sent), 0);
    if (n <= 0) break;
    sent += size_t(n);
  }
}

// Requests may never choose which executable we run.
std::string sanitize(const std::string& body) {
  auto j = nlohmann::json::parse(body);
  j.erase("ffmpeg");
  return j.dump();
}

void handle(sock_t s) {
  Request req;
  if (!readRequest(s, req)) { CLOSESOCK(s); return; }
  using nlohmann::json;
  try {
    if (req.headers["x-syncu"] != "1") {
      respond(s, 403, R"({"ok":false,"error":"missing X-Syncu header"})");
    } else if (req.method == "GET" && req.path == "/health") {
      respond(s, 200, json{{"ok", true}, {"version", kVersion}, {"ffmpeg", ffmpegPath()}}.dump());
    } else if (req.method == "POST" && req.path == "/analyze") {
      std::string body = sanitize(req.body);
      auto job = std::make_shared<Job>();
      int id;
      {
        std::lock_guard<std::mutex> l(g_jobsMu);
        id = g_nextJob++;
        g_jobs[id] = job;
      }
      std::thread([job, body] {
        job->result = analyzeJson(body, [job](double f, const std::string& m) {
          job->progress = f;
          std::lock_guard<std::mutex> l(job->mu);
          job->message = m;
        });
        job->done = true;
      }).detach();
      respond(s, 200, json{{"ok", true}, {"job", id}}.dump());
    } else if (req.method == "GET" && req.path == "/job") {
      int id = req.query.rfind("id=", 0) == 0 ? std::atoi(req.query.c_str() + 3) : 0;
      std::shared_ptr<Job> job;
      {
        std::lock_guard<std::mutex> l(g_jobsMu);
        if (g_jobs.count(id)) job = g_jobs[id];
      }
      if (!job) {
        respond(s, 404, R"({"ok":false,"error":"no such job"})");
      } else {
        json out = {{"ok", true}, {"done", job->done.load()}, {"progress", job->progress.load()}};
        {
          std::lock_guard<std::mutex> l(job->mu);
          out["message"] = job->message;
        }
        if (job->done) {
          out["result"] = json::parse(job->result);
          std::lock_guard<std::mutex> l(g_jobsMu);
          g_jobs.erase(id);
        }
        respond(s, 200, out.dump());
      }
    } else if (req.method == "POST" && req.path == "/match") {
      respond(s, 200, matchJson(sanitize(req.body)));
    } else {
      respond(s, 404, R"({"ok":false,"error":"not found"})");
    }
  } catch (const std::exception& e) {
    respond(s, 400, json{{"ok", false}, {"error", e.what()}}.dump());
  }
  CLOSESOCK(s);
}

}  // namespace

int runServer(int port) {
#ifdef _WIN32
  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);
#endif
  sock_t ls = socket(AF_INET, SOCK_STREAM, 0);
  if (ls == INVALID_SOCKET) { std::perror("socket"); return 1; }
  int yes = 1;
  setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, (const char*)&yes, sizeof(yes));
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(uint16_t(port));
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);  // never reachable from the network
  if (bind(ls, (sockaddr*)&addr, sizeof(addr)) != 0) {
    std::fprintf(stderr, "Syncu helper: port %d busy (already running?)\n", port);
    return 1;
  }
  listen(ls, 16);
  std::fprintf(stderr, "Syncu helper %s listening on 127.0.0.1:%d (ffmpeg: %s)\n",
               kVersion, port, ffmpegPath().c_str());
  for (;;) {
    sock_t c = accept(ls, nullptr, nullptr);
    if (c == INVALID_SOCKET) continue;
    std::thread(handle, c).detach();
  }
}

}  // namespace syncu
