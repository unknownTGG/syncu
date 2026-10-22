#include "server.h"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cctype>
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
#include "log.h"

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

const char* kVersion = "0.1.7";

struct Job {
  std::atomic<double> progress{0.0};
  std::mutex mu;
  std::string message = "Queued";
  std::string result;  // JSON, set when done
  std::atomic<bool> done{false};
};

// ---- Self-update ----
// The panel hands us a release asset URL; we download it, run its installer
// in update mode (replaces this binary, installs the panel .ccx) and then
// exit so the new helper takes over (launchd restarts us on macOS; on
// Windows we start it ourselves).
struct UpdateState {
  std::mutex mu;
  std::string state = "idle";  // idle | running | restarting | failed
  std::string message;
} g_update;

const char* kReleasePrefix = "https://github.com/unknownTGG/syncu/releases/download/";

bool safeUrl(const std::string& u) {
  if (u.rfind(kReleasePrefix, 0) != 0 || u.size() > 300) return false;
  for (char c : u)
    if (!(std::isalnum((unsigned char)c) || std::strchr("._/:-", c))) return false;
  return u.find("..") == std::string::npos;
}

void setUpdate(const std::string& st, const std::string& msg) {
  std::lock_guard<std::mutex> l(g_update.mu);
  g_update.state = st;
  g_update.message = msg;
  (st == "failed" ? logError : logInfo)("update: " + st + (msg.empty() ? "" : ": " + msg));
}

std::string readTail(const std::string& path, size_t n) {
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return "";
  std::string s;
  char b[4096];
  size_t k;
  while ((k = std::fread(b, 1, sizeof(b), f)) > 0) s.append(b, k);
  std::fclose(f);
  return s.size() > n ? s.substr(s.size() - n) : s;
}

void runUpdate(std::string url) {
#if defined(_WIN32)
  const char* tmp = std::getenv("TEMP");
  const std::string dir = std::string(tmp ? tmp : "C:\\Windows\\Temp") + "\\syncu-update";
  const std::string script = dir + "\\update.ps1", logf = dir + "\\update.log";
  CreateDirectoryW(widen(dir).c_str(), nullptr);
  if (std::FILE* f = _wfopen(widen(script).c_str(), L"wb")) {
    std::fprintf(f,
                 "$ErrorActionPreference = 'Stop'\r\n"
                 "$d = Split-Path -Parent $MyInvocation.MyCommand.Path\r\n"
                 "Remove-Item -Recurse -Force (Join-Path $d 'Syncu') -ErrorAction SilentlyContinue\r\n"
                 "Invoke-WebRequest -UseBasicParsing -Uri '%s' -OutFile (Join-Path $d 's.zip')\r\n"
                 "Expand-Archive -Force (Join-Path $d 's.zip') $d\r\n"
                 "& (Join-Path $d 'Syncu\\install-windows.ps1') -Update\r\n",
                 url.c_str());
    std::fclose(f);
  }
  const std::string cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" > \"" + logf + "\" 2>&1";
  setUpdate("running", "downloading and installing");
  const int rc = _wsystem(widen(cmd).c_str());
#else
  const std::string dir = "/tmp/syncu-update-" + std::to_string(::getpid());
  const std::string script = dir + "/update.sh", logf = dir + "/update.log";
  std::system(("mkdir -p " + dir).c_str());
  if (std::FILE* f = std::fopen(script.c_str(), "wb")) {
    std::fprintf(f,
                 "set -e\n"
                 "cd \"$(dirname \"$0\")\"\n"
                 "rm -rf Syncu s.zip\n"
                 "curl -fsSL -o s.zip '%s'\n"
                 "ditto -x -k s.zip . 2>/dev/null || unzip -q s.zip\n"
                 "bash Syncu/install-mac.command --update\n",
                 url.c_str());
    std::fclose(f);
  }
  setUpdate("running", "downloading and installing");
  const int rc = std::system(("/bin/bash " + script + " > " + logf + " 2>&1").c_str());
#endif
  const std::string tail = readTail(logf, 1500);
  if (!tail.empty()) logInfo("update log:\n" + tail);
  if (rc != 0) {
    setUpdate("failed", "installer exited with " + std::to_string(rc) + (tail.empty() ? "" : ": " + tail.substr(tail.size() > 300 ? tail.size() - 300 : 0)));
    return;
  }
  setUpdate("restarting", "installed; restarting the helper");
  std::this_thread::sleep_for(std::chrono::milliseconds(1500));  // let the panel see it
#if defined(_WIN32)
  // Start the new helper (it waits for our port), then step aside.
  const char* la = std::getenv("LOCALAPPDATA");
  std::wstring exe = widen(std::string(la ? la : "") + "\\Syncu\\syncu-engine.exe");
  std::wstring line = L"\"" + exe + L"\" serve";
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  if (CreateProcessW(exe.c_str(), line.data(), nullptr, nullptr, FALSE,
                     DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  } else {
    setUpdate("failed", "installed, but couldn't start the new helper; log out and back in");
    return;
  }
#endif
  std::exit(0);  // macOS: launchd (KeepAlive) starts the new binary
}

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
      static const std::string ffv = ffmpegVersion();
#if defined(_WIN32)
      const char* os = "windows";
#elif defined(__APPLE__)
      const char* os = "macos";
#else
      const char* os = "linux";
#endif
      respond(s, 200, json{{"ok", true}, {"version", kVersion}, {"ffmpeg", ffmpegPath()},
                           {"ffmpegVersion", ffv}, {"os", os}}.dump());
    } else if (req.method == "GET" && req.path == "/log") {
      respond(s, 200, json{{"ok", true}, {"lines", recentLog(1500)}}.dump());
    } else if (req.method == "POST" && req.path == "/analyze") {
      std::string body = sanitize(req.body);
      auto job = std::make_shared<Job>();
      int id;
      {
        std::lock_guard<std::mutex> l(g_jobsMu);
        id = g_nextJob++;
        g_jobs[id] = job;
      }
      logInfo("job " + std::to_string(id) + " started (" + std::to_string(body.size()) + " bytes)");
      std::thread([job, body, id] {
        job->result = analyzeJson(body, [job](double f, const std::string& m) {
          job->progress = f;
          std::lock_guard<std::mutex> l(job->mu);
          job->message = m;
        });
        job->done = true;
        logInfo("job " + std::to_string(id) + " finished");
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
    } else if (req.method == "POST" && req.path == "/update") {
      const std::string url = json::parse(req.body).value("url", "");
      if (!safeUrl(url)) {
        respond(s, 400, R"({"ok":false,"error":"not a Syncu release URL"})");
      } else {
        bool busy;
        {
          std::lock_guard<std::mutex> l(g_update.mu);
          busy = g_update.state == "running" || g_update.state == "restarting";
        }
        if (busy) {
          respond(s, 400, R"({"ok":false,"error":"an update is already running"})");
        } else {
          setUpdate("running", "starting");
          std::thread(runUpdate, url).detach();
          respond(s, 200, R"({"ok":true})");
        }
      }
    } else if (req.method == "GET" && req.path == "/update") {
      std::lock_guard<std::mutex> l(g_update.mu);
      respond(s, 200, json{{"ok", true}, {"state", g_update.state}, {"message", g_update.message}}.dump());
    } else if (req.method == "POST" && req.path == "/match") {
      respond(s, 200, matchJson(sanitize(req.body)));
    } else {
      respond(s, 404, R"({"ok":false,"error":"not found"})");
    }
  } catch (const std::exception& e) {
    logError(req.method + " " + req.path + ": " + e.what());
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
  // After a self-update the old helper may still hold the port for a moment.
  bool bound = false;
  for (int attempt = 0; attempt < 40 && !bound; ++attempt) {
    bound = bind(ls, (sockaddr*)&addr, sizeof(addr)) == 0;
    if (!bound) std::this_thread::sleep_for(std::chrono::milliseconds(250));
  }
  if (!bound) {
    std::fprintf(stderr, "Syncu helper: port %d busy (already running?)\n", port);
    return 1;
  }
  listen(ls, 16);
  logInfo(std::string("Syncu helper ") + kVersion + " listening on 127.0.0.1:" +
          std::to_string(port) + " (ffmpeg: " + ffmpegPath() + ", " + ffmpegVersion() + ")");
  for (;;) {
    sock_t c = accept(ls, nullptr, nullptr);
    if (c == INVALID_SOCKET) continue;
    std::thread(handle, c).detach();
  }
}

}  // namespace syncu
