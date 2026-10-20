#pragma once
#include <string>
#include <vector>

namespace syncu {

// Thread-safe in-memory log (last few thousand lines), mirrored to stderr.
// The panel fetches it via GET /log so a single report has both sides.
void logLine(const char* level, const std::string& msg);
inline void logInfo(const std::string& m) { logLine("info", m); }
inline void logWarn(const std::string& m) { logLine("warn", m); }
inline void logError(const std::string& m) { logLine("error", m); }

std::vector<std::string> recentLog(size_t maxLines);

}  // namespace syncu
