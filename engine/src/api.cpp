#include "api.h"

#include <nlohmann/json.hpp>

#include "audio.h"
#include "log.h"

namespace syncu {

using nlohmann::json;

namespace {

template <typename T>
void get(const json& j, const char* key, T& out) {
  if (j.contains(key) && !j[key].is_null()) out = j[key].get<T>();
}

void readMatchOptions(const json& o, MatchOptions& m) {
  get(o, "coarseRate", m.coarseRate);
  get(o, "fineRate", m.fineRate);
  get(o, "fineWindow", m.fineWindow);
  get(o, "fineSearch", m.fineSearch);
  get(o, "minOverlap", m.minOverlap);
  get(o, "maxCandidates", m.maxCandidates);
  get(o, "refineMinCoarse", m.refineMinCoarse);
}

json matchToJson(const MatchResult& m) {
  json c = json::array();
  for (const auto& k : m.candidates) c.push_back({{"offset", k.offset}, {"score", k.score}});
  return {{"found", m.found},
          {"offset", m.offset},
          {"coarseOffset", m.coarseOffset},
          {"confidence", m.confidence},
          {"peakRatio", m.peakRatio},
          {"correlation", m.correlation},
          {"agreement", m.agreement},
          {"polarityInverted", m.polarityInverted},
          {"overlap", m.overlap},
          {"timeB", m.timeB},
          {"candidates", c}};
}

}  // namespace

std::string analyzeJson(const std::string& request, const ProgressFn& progress) {
  try {
    json req = json::parse(request);
    if (req.contains("ffmpeg")) setFfmpegPath(req["ffmpeg"].get<std::string>());

    AnalyzeOptions opts;
    if (req.contains("options")) {
      const json& o = req["options"];
      readMatchOptions(o, opts.match);
      get(o, "autoConfidence", opts.autoConfidence);
      get(o, "reviewConfidence", opts.reviewConfidence);
      get(o, "driftMinOverlap", opts.driftMinOverlap);
      get(o, "driftStep", opts.driftStep);
      get(o, "driftTolerance", opts.driftTolerance);
      get(o, "outlierTolerance", opts.outlierTolerance);
      get(o, "consistencyTolerance", opts.consistencyTolerance);
      get(o, "overlapTolerance", opts.overlapTolerance);
      get(o, "maxDrift", opts.maxDrift);
      get(o, "useNameHints", opts.useNameHints);
      get(o, "threads", opts.threads);
    }
    for (const auto& m : req.value("manualEdges", json::array()))
      opts.manualEdges.push_back({m.at("a"), m.at("b"), m.at("offset")});

    std::vector<ClipInfo> clips;
    for (const auto& c : req.at("clips")) {
      ClipInfo ci;
      ci.id = c.at("id").get<std::string>();
      ci.path = c.at("path").get<std::string>();
      ci.device = c.value("device", ci.path);
      get(c, "group", ci.group);
      get(c, "isVideo", ci.isVideo);
      get(c, "hasAudio", ci.hasAudio);
      get(c, "duration", ci.duration);
      get(c, "timestamp", ci.timestamp);
      get(c, "channel", ci.channel);
      get(c, "altPath", ci.altPath);
      clips.push_back(ci);
    }

    AnalyzeResult r = analyzeProject(clips, opts, progress);

    json out = {{"ok", true}, {"components", r.components}};
    json jc = json::array();
    for (const auto& c : r.clips) {
      json segs = json::array();
      for (const auto& s : c.segments)
        segs.push_back({{"start", s.start}, {"end", s.end}, {"position", s.position}});
      jc.push_back({{"id", c.id},
                    {"method", c.method},
                    {"component", c.component},
                    {"position", c.position},
                    {"driftPpm", c.drift},
                    {"confidence", c.confidence},
                    {"needsReview", c.needsReview},
                    {"segments", segs},
                    {"source", c.source},
                    {"duration", c.duration}});
    }
    json je = json::array();
    for (const auto& e : r.edges)
      je.push_back({{"a", e.a}, {"b", e.b}, {"status", e.status},
                    {"residual", e.residual}, {"match", matchToJson(e.match)}});
    out["clips"] = jc;
    out["edges"] = je;
    return out.dump();
  } catch (const std::exception& e) {
    logError(std::string("analyze request failed: ") + e.what());
    return json{{"ok", false}, {"error", e.what()}}.dump();
  }
}

std::string matchJson(const std::string& request) {
  try {
    json req = json::parse(request);
    if (req.contains("ffmpeg")) setFfmpegPath(req["ffmpeg"].get<std::string>());
    MatchOptions m;
    if (req.contains("options")) readMatchOptions(req["options"], m);
    MatchResult r = matchFiles(req.at("a"), req.at("b"), m);
    json out = matchToJson(r);
    out["ok"] = true;
    return out.dump();
  } catch (const std::exception& e) {
    return json{{"ok", false}, {"error", e.what()}}.dump();
  }
}

}  // namespace syncu
