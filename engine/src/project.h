#pragma once
#include <functional>
#include <string>
#include <vector>

#include "sync.h"

namespace syncu {

// One media file to sync. `device` groups clips from the same camera or
// recorder (they never overlap in time, so they are never matched with each
// other). For multi-file recorders (one WAV per mic) give every file of a
// take the same `device` + `group` so they move together.
struct ClipInfo {
  std::string id;
  std::string path;
  std::string altPath;      // e.g. Premiere proxy, used when `path` is offline
  std::string device;
  std::string group;        // optional: files that are sample-locked together
  bool isVideo = false;     // video clips are never cut for drift unless needed
  bool hasAudio = true;     // false -> placed by timestamp only
  double duration = -1.0;   // seconds; < 0 = measure
  double timestamp = -1.0;  // recording start (epoch seconds), < 0 = unknown
  int channel = -1;         // audio channel to analyse, -1 = mix
};

// A user-confirmed offset from the Review panel (offset = tA - tB).
struct ManualEdge {
  std::string a, b;
  double offset;
};

struct AnalyzeOptions {
  MatchOptions match;
  float autoConfidence = 0.5f;    // edges at/above this are used automatically
  float reviewConfidence = 0.15f; // between review and auto -> needs review
  double driftMinOverlap = 180.0; // seconds of overlap before measuring drift
  double driftStep = 60.0;        // seconds between drift measurements
  double driftTolerance = 0.002;  // seconds; max sync error before cutting
  double outlierTolerance = 0.02; // seconds; edges worse than this are dropped
  int threads = 0;                // 0 = hardware concurrency
  std::vector<ManualEdge> manualEdges;
};

struct Segment {
  double start, end;  // seconds into the clip (in/out points)
  double position;    // timeline seconds where `start` lands
};

struct ClipResult {
  std::string id;
  std::string method = "none";  // audio | manual | timestamp | none
  int component = -1;           // clips in the same component share a clock
  double position = 0.0;        // timeline seconds of the clip's time zero
  double drift = 0.0;           // clock-rate error vs reference (ppm)
  float confidence = 0.0f;
  bool needsReview = false;
  std::vector<Segment> segments;  // >1 when cut to correct drift
  std::string source = "original";  // original | proxy | missing
  double duration = 0.0;            // seconds of media (0 = unknown)
};

struct EdgeResult {
  std::string a, b;
  MatchResult match;
  std::string status;  // used | review | rejected | outlier | manual
  double residual = 0.0;
};

struct AnalyzeResult {
  std::vector<ClipResult> clips;
  std::vector<EdgeResult> edges;
  int components = 0;
};

using ProgressFn = std::function<void(double fraction, const std::string& msg)>;

AnalyzeResult analyzeProject(const std::vector<ClipInfo>& clips,
                             const AnalyzeOptions& opts,
                             const ProgressFn& progress = nullptr);

}  // namespace syncu
