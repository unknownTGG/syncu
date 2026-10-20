#pragma once
#include <string>

#include "project.h"

namespace syncu {

// JSON entry points shared by the CLI and the Premiere add-on, so both
// speak exactly the same protocol. See docs/ENGINE_API.md.
//
// analyze request:
//   { "ffmpeg": "/path/to/ffmpeg",          (optional)
//     "options": { "autoConfidence": 0.5, "driftTolerance": 0.002, ... },
//     "clips": [ { "id", "path", "device", "group", "isVideo", "hasAudio",
//                  "duration", "timestamp", "channel" } ],
//     "manualEdges": [ { "a", "b", "offset" } ] }
std::string analyzeJson(const std::string& request, const ProgressFn& progress);

// match request: { "a": path, "b": path, "options": {...} }
std::string matchJson(const std::string& request);

}  // namespace syncu
