#include "log.h"

#include <chrono>
#include <cstdio>
#include <ctime>
#include <deque>
#include <mutex>

namespace syncu {

namespace {
std::mutex g_mu;
std::deque<std::string> g_lines;
const size_t kMaxLines = 5000;
}  // namespace

void logLine(const char* level, const std::string& msg) {
  using namespace std::chrono;
  auto now = system_clock::now();
  std::time_t t = system_clock::to_time_t(now);
  int ms = int(duration_cast<milliseconds>(now.time_since_epoch()).count() % 1000);
  std::tm tm{};
#ifdef _WIN32
  localtime_s(&tm, &t);
#else
  localtime_r(&t, &tm);
#endif
  char ts[32];
  std::snprintf(ts, sizeof(ts), "%02d:%02d:%02d.%03d", tm.tm_hour, tm.tm_min, tm.tm_sec, ms);
  std::string line = std::string(ts) + " [" + level + "] " + msg;
  std::lock_guard<std::mutex> l(g_mu);
  std::fprintf(stderr, "%s\n", line.c_str());
  g_lines.push_back(line);
  while (g_lines.size() > kMaxLines) g_lines.pop_front();
}

std::vector<std::string> recentLog(size_t maxLines) {
  std::lock_guard<std::mutex> l(g_mu);
  size_t n = std::min(maxLines, g_lines.size());
  return std::vector<std::string>(g_lines.end() - long(n), g_lines.end());
}

}  // namespace syncu
