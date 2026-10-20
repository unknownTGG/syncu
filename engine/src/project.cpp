#include "project.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <map>
#include <memory>
#include <mutex>
#include <numeric>
#include <thread>

#include "audio.h"
#include "log.h"

#include <chrono>
#include <cstdio>

#include <sys/stat.h>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

namespace syncu {

namespace {

void parallelFor(size_t n, int threads, const std::function<void(size_t)>& fn) {
  if (threads <= 0) threads = std::max(1u, std::thread::hardware_concurrency());
  threads = int(std::min<size_t>(size_t(threads), std::max<size_t>(n, 1)));
  std::atomic<size_t> next{0};
  std::vector<std::thread> pool;
  for (int t = 0; t < threads; ++t)
    pool.emplace_back([&] {
      for (size_t i; (i = next++) < n;) fn(i);
    });
  for (auto& th : pool) th.join();
}

struct Node {
  std::vector<size_t> clips;  // indices into the input clip list
  size_t lead = SIZE_MAX;     // clip whose audio represents this node
  std::string device;
  bool isVideo = false;
  double duration = 0.0;
  std::vector<float> coarse;    // DC removed
  std::vector<float> envelope;  // 20 Hz RMS, for quiet-spot cut snapping
  std::unique_ptr<SpectrumCache> spec;  // long files only
};

struct Obs {  // one offset observation on an edge
  double tB, offset, weight;
};

struct UnionFind {
  std::vector<int> p;
  explicit UnionFind(size_t n) : p(n) { std::iota(p.begin(), p.end(), 0); }
  int find(int x) { return p[x] == x ? x : p[x] = find(p[x]); }
  void join(int a, int b) { p[find(a)] = find(b); }
};

// Solve the dense symmetric system A x = b in place (Gaussian elimination
// with partial pivoting). Returns false if singular.
bool solveDense(std::vector<double>& A, std::vector<double>& b, size_t n) {
  for (size_t c = 0; c < n; ++c) {
    size_t piv = c;
    for (size_t r = c + 1; r < n; ++r)
      if (std::fabs(A[r * n + c]) > std::fabs(A[piv * n + c])) piv = r;
    if (std::fabs(A[piv * n + c]) < 1e-18) return false;
    if (piv != c) {
      for (size_t k = 0; k < n; ++k) std::swap(A[c * n + k], A[piv * n + k]);
      std::swap(b[c], b[piv]);
    }
    for (size_t r = c + 1; r < n; ++r) {
      double f = A[r * n + c] / A[c * n + c];
      if (f == 0.0) continue;
      for (size_t k = c; k < n; ++k) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  for (size_t c = n; c-- > 0;) {
    double s = b[c];
    for (size_t k = c + 1; k < n; ++k) s -= A[c * n + k] * b[k];
    b[c] = s / A[c * n + c];
  }
  return true;
}

// Recording start estimated from the file's modification time: cameras and
// recorders close the file when recording stops, so start = mtime - duration.
double fileStartTime(const std::string& path, double duration) {
  double mtime = -1.0;
#ifdef _WIN32
  WIN32_FILE_ATTRIBUTE_DATA fa;
  if (!GetFileAttributesExW(widen(path).c_str(), GetFileExInfoStandard, &fa)) return -1.0;
  ULARGE_INTEGER t;
  t.LowPart = fa.ftLastWriteTime.dwLowDateTime;
  t.HighPart = fa.ftLastWriteTime.dwHighDateTime;
  mtime = double(t.QuadPart) / 1e7 - 11644473600.0;  // 100 ns since 1601 -> Unix
#else
  struct stat st;
  if (stat(path.c_str(), &st) != 0) return -1.0;
#ifdef __APPLE__
  mtime = double(st.st_mtimespec.tv_sec) + st.st_mtimespec.tv_nsec * 1e-9;
#else
  mtime = double(st.st_mtim.tv_sec) + st.st_mtim.tv_nsec * 1e-9;
#endif
#endif
  return mtime - std::max(0.0, duration);
}

}  // namespace

AnalyzeResult analyzeProject(const std::vector<ClipInfo>& clips,
                             const AnalyzeOptions& opts,
                             const ProgressFn& progress) {
  auto report = [&](double f, const std::string& m) {
    if (progress) progress(f, m);
  };
  using clock = std::chrono::steady_clock;
  const auto t0 = clock::now();
  auto elapsed = [&] {
    char b[32];
    std::snprintf(b, sizeof(b), "%.1fs", std::chrono::duration<double>(clock::now() - t0).count());
    return std::string(b);
  };
  auto fmt = [](const char* f, double a, double b = 0, double c = 0) {
    char buf[160];
    std::snprintf(buf, sizeof(buf), f, a, b, c);
    return std::string(buf);
  };
  logInfo("analyze: " + std::to_string(clips.size()) + " clips, autoConfidence " +
          fmt("%.2f", opts.autoConfidence) + ", driftTolerance " +
          fmt("%.1f ms", opts.driftTolerance * 1000) + ", coarseRate " +
          std::to_string(opts.match.coarseRate) + ", manual edges " +
          std::to_string(opts.manualEdges.size()));
  AnalyzeResult out;

  // ---- 1. Group clips into nodes (one position + clock per node). ----
  std::vector<Node> nodes;
  std::vector<int> nodeOf(clips.size(), -1);
  {
    std::map<std::string, int> byGroup;
    for (size_t i = 0; i < clips.size(); ++i) {
      const auto& c = clips[i];
      int n;
      auto key = c.device + "\x1f" + c.group;
      if (!c.group.empty() && byGroup.count(key)) {
        n = byGroup[key];
      } else {
        n = int(nodes.size());
        nodes.push_back({});
        nodes[n].device = c.device;
        if (!c.group.empty()) byGroup[key] = n;
      }
      nodes[n].clips.push_back(i);
      nodes[n].isVideo |= c.isVideo;
      if (c.hasAudio && nodes[n].lead == SIZE_MAX) nodes[n].lead = i;
      nodes[n].duration = std::max(nodes[n].duration, c.duration);
      nodeOf[i] = n;
    }
  }

  // Where each video file's first frame sits on its own timeline; analysis
  // runs on the file timeline, Premiere counts from the first frame.
  std::vector<double> videoStart(clips.size(), 0.0);
  parallelFor(clips.size(), opts.threads, [&](size_t i) {
    if (clips[i].isVideo) videoStart[i] = videoStartTime(clips[i].path);
  });

  // ---- 2. Decode every lead file once at the coarse rate. ----
  std::atomic<size_t> decoded{0};
  std::mutex errMu;
  parallelFor(nodes.size(), opts.threads, [&](size_t n) {
    Node& node = nodes[n];
    if (node.lead != SIZE_MAX) {
      DecodeOptions d;
      d.sampleRate = opts.match.coarseRate;
      d.channel = clips[node.lead].channel;
      try {
        node.coarse = decodeAudio(clips[node.lead].path, d);
      } catch (const std::exception& e) {
        logWarn("no usable audio in " + clips[node.lead].path + ": " + e.what());
        node.coarse.clear();  // unreadable audio -> treated as silent
      }
      node.duration = std::max(node.duration,
                               double(node.coarse.size()) / opts.match.coarseRate);
      removeDc(node.coarse);
      node.envelope = computeEnvelope(node.coarse, opts.match.coarseRate, 0.05);
      // Files over 5 minutes get matched against many clips: cache their FFT.
      if (node.coarse.size() > size_t(300 * opts.match.coarseRate))
        node.spec = std::make_unique<SpectrumCache>();
      // A silent track (gimbal/drone with the mic off, or no mic at all)
      // can't be matched; treat it as no audio so the clip is placed by time.
      if (!node.coarse.empty()) {
        double ss = 0.0;
        for (float x : node.coarse) ss += double(x) * x;
        const double rms = std::sqrt(ss / double(node.coarse.size()));
        if (rms < 1e-3) {  // below -60 dBFS
          logInfo("audio is silent (" + fmt("%.1f dBFS", 20 * std::log10(rms + 1e-12)) +
                  "), placing by time: " + clips[node.lead].path);
          node.coarse.clear();
        }
      }
      if (node.coarse.size() < size_t(opts.match.minOverlap * opts.match.coarseRate)) {
        if (!node.coarse.empty()) logWarn("audio too short to match: " + clips[node.lead].path);
        node.coarse.clear();
      }
    }
    report(0.3 * double(++decoded) / nodes.size(), "Reading audio");
  });

  {
    int withAudio = 0;
    for (auto& n : nodes) withAudio += !n.coarse.empty();
    logInfo("decoded " + std::to_string(nodes.size()) + " nodes (" + std::to_string(withAudio) +
            " with audio) in " + elapsed());
  }

  // ---- 3. Match every cross-device pair of nodes. ----
  struct Pair { int a, b; };
  std::vector<Pair> pairs;
  for (int a = 0; a < int(nodes.size()); ++a)
    for (int b = a + 1; b < int(nodes.size()); ++b)
      if (nodes[a].device != nodes[b].device && !nodes[a].coarse.empty() &&
          !nodes[b].coarse.empty())
        pairs.push_back({a, b});

  std::vector<EdgeResult> edges(pairs.size());
  std::vector<std::pair<int, int>> edgeNodes(pairs.size());
  std::atomic<size_t> matched{0};
  parallelFor(pairs.size(), opts.threads, [&](size_t i) {
    const Pair& p = pairs[i];
    // Match the shorter file against the longer one (B = shorter).
    int A = p.a, B = p.b;
    if (nodes[A].coarse.size() < nodes[B].coarse.size()) std::swap(A, B);
    EdgeResult& e = edges[i];
    e.a = clips[nodes[A].lead].id;
    e.b = clips[nodes[B].lead].id;
    edgeNodes[i] = {A, B};
    try {
      e.match = matchDecoded(clips[nodes[A].lead].path, clips[nodes[B].lead].path,
                             nodes[A].coarse, nodes[B].coarse, opts.match,
                             nodes[A].spec.get());
    } catch (const std::exception& ex) {
      logError("match " + e.a + " / " + e.b + " failed: " + ex.what());
      e.match = MatchResult{};
    }
    if (e.match.found && e.match.confidence >= opts.autoConfidence) e.status = "used";
    else if (e.match.found && e.match.confidence >= opts.reviewConfidence) e.status = "review";
    else e.status = "rejected";
    report(0.3 + 0.4 * double(++matched) / std::max<size_t>(1, pairs.size()),
           "Matching audio");
  });

  {
    int used = 0, review = 0;
    for (auto& e : edges) used += e.status == "used", review += e.status == "review";
    logInfo("matched " + std::to_string(pairs.size()) + " pairs in " + elapsed() + ": " +
            std::to_string(used) + " confident, " + std::to_string(review) + " for review");
    for (auto& e : edges)
      if (e.status != "rejected")
        logInfo("  " + e.status + " " + e.a + " <- " + e.b +
                fmt(" offset %.6f s conf %.2f ratio %.2f", e.match.offset, e.match.confidence, e.match.peakRatio) +
                fmt(" corr %.2f overlap %.1f s", e.match.correlation, e.match.overlap));
  }

  // Manual edges from the Review panel override automatic ones.
  std::map<std::string, int> nodeById;
  for (size_t i = 0; i < clips.size(); ++i) nodeById[clips[i].id] = nodeOf[i];
  for (const auto& m : opts.manualEdges) {
    if (!nodeById.count(m.a) || !nodeById.count(m.b)) continue;
    int A = nodeById[m.a], B = nodeById[m.b];
    for (size_t i = 0; i < edges.size(); ++i) {
      auto [x, y] = edgeNodes[i];
      if ((x == A && y == B) || (x == B && y == A)) edges[i].status = "rejected";
    }
    EdgeResult e;
    e.a = m.a;
    e.b = m.b;
    e.status = "manual";
    e.match.found = true;
    e.match.offset = m.offset;
    e.match.confidence = 1.0f;
    double ovS = std::max(0.0, -m.offset);
    double ovE = std::min(nodes[B].duration, nodes[A].duration - m.offset);
    e.match.overlap = std::max(0.0, ovE - ovS);
    edges.push_back(e);
    edgeNodes.push_back({A, B});
  }

  // ---- 4. Observations per edge (drift-measured for long overlaps). ----
  std::vector<std::vector<Obs>> obs(edges.size());
  std::vector<size_t> driftJobs;
  for (size_t i = 0; i < edges.size(); ++i) {
    const auto& e = edges[i];
    if (e.status != "used" && e.status != "manual") continue;
    const auto [A, B] = edgeNodes[i];
    const double ovS = std::max(0.0, -e.match.offset);
    const double ovE = std::min(nodes[B].duration, nodes[A].duration - e.match.offset);
    const double w = e.status == "manual" ? 10.0 : e.match.confidence;
    const double tB = e.status == "manual" ? 0.5 * (ovS + ovE) : e.match.timeB;
    obs[i].push_back({tB, e.match.offset, w});
    if (e.match.overlap >= opts.driftMinOverlap && nodes[A].lead != SIZE_MAX &&
        nodes[B].lead != SIZE_MAX)
      driftJobs.push_back(i);
  }
  std::atomic<size_t> drifted{0};
  parallelFor(driftJobs.size(), opts.threads, [&](size_t j) {
    size_t i = driftJobs[j];
    const auto [A, B] = edgeNodes[i];
    DriftOptions d;
    d.rate = opts.match.fineRate;
    d.step = opts.driftStep;
    d.channelA = clips[nodes[A].lead].channel;
    d.channelB = clips[nodes[B].lead].channel;
    try {
      DriftResult r = measureDrift(clips[nodes[A].lead].path, clips[nodes[B].lead].path,
                                   edges[i].match.offset, d, nodes[A].duration,
                                   nodes[B].duration);
      logInfo("drift " + edges[i].a + " <- " + edges[i].b +
              fmt(": %.2f ppm, rms %.1f us, %g points", r.ppm, r.residualRms * 1e6, double(r.points.size())) +
              (r.valid ? "" : " (not enough clean windows; ignored)"));
      if (r.valid) {
        const double w = edges[i].match.confidence;
        std::vector<Obs> pts;
        for (const auto& p : r.points)
          if (p.inlier) pts.push_back({p.timeB, p.offset, w});
        obs[i] = pts;
      }
    } catch (const std::exception& ex) {
      logError("drift " + edges[i].a + " <- " + edges[i].b + " failed: " + ex.what());
    }
    report(0.7 + 0.25 * double(++drifted) / std::max<size_t>(1, driftJobs.size()),
           "Measuring drift");
  });

  // ---- 5. Global least-squares solve with outlier rejection. ----
  // Model: timeline = x_n + (1 + eps_n) * t_n. An observation on edge
  // (A, B) at B-time tB with offset o = tA - tB gives the linear equation
  //   x_B - x_A + eps_B * tB - eps_A * (tB + o) = o.
  const size_t N = nodes.size();
  std::vector<double> x(N, 0.0), eps(N, 0.0);
  std::vector<int> comp(N, -1);
  for (int iter = 0; iter < 1000; ++iter) {
    UnionFind uf(N);
    for (size_t i = 0; i < edges.size(); ++i)
      if (edges[i].status == "used" || edges[i].status == "manual")
        uf.join(edgeNodes[i].first, edgeNodes[i].second);

    std::map<int, std::vector<int>> members;
    for (size_t n = 0; n < N; ++n) members[uf.find(int(n))].push_back(int(n));

    std::fill(comp.begin(), comp.end(), -1);
    int nextComp = 0;
    for (auto& [root, mem] : members) {
      bool linked = mem.size() > 1;
      if (!linked) continue;
      const int c = nextComp++;
      // Reference: longest video node, else longest node (x = 0, eps = 0).
      int ref = mem[0];
      for (int n : mem) {
        bool better = (nodes[n].isVideo && !nodes[ref].isVideo) ||
                      (nodes[n].isVideo == nodes[ref].isVideo &&
                       nodes[n].duration > nodes[ref].duration);
        if (better) ref = n;
      }
      std::map<int, size_t> col;  // node -> index of its x; eps at +1
      for (int n : mem) {
        comp[n] = c;
        if (n != ref) col[n] = col.size() * 2;
      }
      const size_t M = col.size() * 2;
      std::vector<double> AtA(M * M, 0.0), Atb(M, 0.0);
      auto addRow = [&](const std::vector<std::pair<size_t, double>>& row,
                        double rhs, double w) {
        for (auto& [i, vi] : row) {
          Atb[i] += w * vi * rhs;
          for (auto& [j, vj] : row) AtA[i * M + j] += w * vi * vj;
        }
      };
      for (size_t i = 0; i < edges.size(); ++i) {
        if (edges[i].status != "used" && edges[i].status != "manual") continue;
        const auto [A, B] = edgeNodes[i];
        if (comp[A] != c) continue;
        for (const auto& o : obs[i]) {
          std::vector<std::pair<size_t, double>> row;
          if (B != ref) row.push_back({col[B], 1.0}), row.push_back({col[B] + 1, o.tB});
          if (A != ref) row.push_back({col[A], -1.0}), row.push_back({col[A] + 1, -(o.tB + o.offset)});
          addRow(row, o.offset, o.weight);
        }
      }
      // Weak prior pulling every clock-rate error to zero; it only matters
      // for nodes whose drift isn't measured (short overlaps).
      for (auto& [n, ci] : col) addRow({{ci + 1, 1.0}}, 0.0, 1.0);

      if (!solveDense(AtA, Atb, M)) continue;
      x[ref] = 0.0;
      eps[ref] = 0.0;
      for (auto& [n, ci] : col) x[n] = Atb[ci], eps[n] = Atb[ci + 1];
    }
    out.components = nextComp;

    // Residuals; drop the single worst automatic edge if over tolerance.
    double worst = 0.0;
    int worstEdge = -1;
    for (size_t i = 0; i < edges.size(); ++i) {
      auto& e = edges[i];
      if (e.status != "used" && e.status != "manual") continue;
      const auto [A, B] = edgeNodes[i];
      double ss = 0.0;
      for (const auto& o : obs[i]) {
        double pred = x[B] - x[A] + eps[B] * o.tB - eps[A] * (o.tB + o.offset);
        ss += (pred - o.offset) * (pred - o.offset);
      }
      e.residual = obs[i].empty() ? 0.0 : std::sqrt(ss / obs[i].size());
      if (e.status == "used" && e.residual > worst) worst = e.residual, worstEdge = int(i);
    }
    if (worst <= opts.outlierTolerance || worstEdge < 0) break;
    logWarn("dropping inconsistent match " + edges[worstEdge].a + " <- " + edges[worstEdge].b +
            fmt(" (residual %.2f ms)", worst * 1000));
    edges[worstEdge].status = "outlier";
  }

  // ---- 6. Per-clip results. ----
  out.clips.resize(clips.size());
  for (size_t i = 0; i < clips.size(); ++i) {
    auto& r = out.clips[i];
    r.id = clips[i].id;
    const int n = nodeOf[i];
    if (comp[n] < 0) continue;
    r.component = comp[n];
    r.position = x[n];
    r.drift = eps[n] * 1e6;
    r.method = "audio";
    for (size_t k = 0; k < edges.size(); ++k) {
      if (edges[k].status != "used" && edges[k].status != "manual") continue;
      if (edgeNodes[k].first != n && edgeNodes[k].second != n) continue;
      if (edges[k].status == "manual") r.method = "manual";
      r.confidence = std::max(r.confidence, edges[k].match.confidence);
    }
  }

  // Clips with only review-level matches get flagged.
  for (size_t k = 0; k < edges.size(); ++k) {
    if (edges[k].status != "review") continue;
    for (int n : {edgeNodes[k].first, edgeNodes[k].second})
      for (size_t i : nodes[n].clips)
        if (out.clips[i].method == "none") out.clips[i].needsReview = true;
  }

  // ---- 7. Timestamp placement for silent / unmatched clips. ----
  // Callers may not know timestamps; fall back to file modification times.
  std::vector<ClipInfo> withTs;
  bool anyMissing = false;
  for (const auto& c : clips) anyMissing |= c.timestamp < 0;
  if (anyMissing) {
    withTs = clips;
    for (size_t i = 0; i < withTs.size(); ++i)
      if (withTs[i].timestamp < 0) {
        double dur = withTs[i].duration > 0 ? withTs[i].duration : nodes[nodeOf[i]].duration;
        withTs[i].timestamp = fileStartTime(withTs[i].path, dur);
      }
  }
  const std::vector<ClipInfo>& tclips = anyMissing ? withTs : clips;
  // Per device, estimate (timeline position - recording timestamp) from the
  // clips that synced by audio, then apply it to the rest of that device.
  std::map<std::pair<std::string, int>, std::vector<double>> devDelta;
  std::map<int, std::vector<double>> anyDelta;
  for (size_t i = 0; i < clips.size(); ++i)
    if (out.clips[i].method != "none" && tclips[i].timestamp >= 0) {
      double d = out.clips[i].position - tclips[i].timestamp;
      devDelta[{clips[i].device, out.clips[i].component}].push_back(d);
      anyDelta[out.clips[i].component].push_back(d);
    }
  auto median = [](std::vector<double> v) {
    std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end());
    return v[v.size() / 2];
  };
  // Span of each scene from its audio-synced clips, to catch bad clocks.
  std::map<int, std::pair<double, double>> span;
  for (size_t i = 0; i < clips.size(); ++i) {
    const auto& r = out.clips[i];
    if (r.method != "audio" && r.method != "manual") continue;
    const double dur = clips[i].duration > 0 ? clips[i].duration : nodes[nodeOf[i]].duration;
    auto it = span.find(r.component);
    if (it == span.end()) span[r.component] = {r.position, r.position + dur};
    else it->second = {std::min(it->second.first, r.position), std::max(it->second.second, r.position + dur)};
  }
  for (size_t i = 0; i < clips.size(); ++i) {
    auto& r = out.clips[i];
    if (r.method != "none" || tclips[i].timestamp < 0) continue;
    // Prefer the component with the most clips from the same device.
    int bestComp = -1;
    size_t bestCount = 0;
    for (auto& [key, v] : devDelta)
      if (key.first == clips[i].device && v.size() > bestCount)
        bestCount = v.size(), bestComp = key.second;
    if (bestComp >= 0) {
      r.position = tclips[i].timestamp + median(devDelta[{clips[i].device, bestComp}]);
      r.component = bestComp;
    } else if (!anyDelta.empty() && nodes[nodeOf[i]].coarse.empty()) {
      // Whole device is silent (e.g. gimbal with no mic): trust its clock
      // against everyone else's. Clips that have audio but matched nothing
      // are more likely unrelated, so they stay unplaced.
      auto it = std::max_element(anyDelta.begin(), anyDelta.end(),
                                 [](auto& p, auto& q) { return p.second.size() < q.second.size(); });
      r.position = tclips[i].timestamp + median(it->second);
      r.component = it->first;
    } else {
      continue;
    }
    // A camera with an unset clock would land days or years away; leave
    // it unplaced rather than stretch the timeline.
    const double dur = clips[i].duration > 0 ? clips[i].duration : nodes[nodeOf[i]].duration;
    auto sp = span.find(r.component);
    if (sp != span.end() && (r.position + dur < sp->second.first - 3600.0 ||
                             r.position > sp->second.second + 3600.0)) {
      logWarn("clock looks wrong for " + clips[i].path + fmt(": would land %.0f s outside its scene; not placed",
              r.position < sp->second.first ? sp->second.first - r.position - dur : r.position - sp->second.second));
      r.position = 0.0;
      r.component = -1;
      continue;
    }
    r.method = "timestamp";
    r.needsReview = true;
  }

  for (auto& r : out.clips)
    if (r.method == "none") r.needsReview = true;

  // ---- 8. Segments (drift cuts), then shift each component to start at 0. ----
  for (size_t i = 0; i < clips.size(); ++i) {
    auto& r = out.clips[i];
    if (r.component < 0) continue;
    const int n = nodeOf[i];
    const double dur = clips[i].duration > 0 ? clips[i].duration : nodes[n].duration;
    const double e = r.method == "audio" || r.method == "manual" ? eps[n] : 0.0;
    if (std::fabs(e) * dur <= 2.0 * opts.driftTolerance) {
      // Align at the middle so the error is split between both ends.
      r.segments.push_back({0.0, dur, r.position + e * 0.5 * dur});
      continue;
    }
    DriftResult d;
    d.offsetAtB0 = 0.0;
    d.slope = e;
    for (auto& s : planDriftCuts(d, 0.0, dur, opts.driftTolerance, nodes[n].envelope, 20)) {
      // Piece [start, end] keeps its own middle in sync:
      // timeline(start) = x + eps * mid + start.
      r.segments.push_back({s.startB, s.endB, r.position + s.offset + s.startB});
    }
  }
  // File timeline -> Premiere clip time (zero at the first video frame).
  for (size_t i = 0; i < clips.size(); ++i) {
    auto& r = out.clips[i];
    const double v = videoStart[i];
    if (r.component < 0 || v == 0.0) continue;
    r.position += v;
    std::vector<Segment> segs;
    for (auto s : r.segments) {
      s.start -= v;
      s.end -= v;
      if (s.end <= 0.0) continue;
      if (s.start < 0.0) s.position -= s.start, s.start = 0.0;
      segs.push_back(s);
    }
    r.segments = segs;
  }

  for (int c = 0; c < out.components; ++c) {
    double minPos = 1e300;
    for (auto& r : out.clips)
      if (r.component == c)
        for (auto& s : r.segments) minPos = std::min(minPos, s.position);
    if (minPos == 1e300) continue;
    for (auto& r : out.clips) {
      if (r.component != c) continue;
      r.position -= minPos;
      for (auto& s : r.segments) s.position -= minPos;
    }
  }

  {
    int byAudio = 0, byTs = 0, none = 0;
    for (auto& r : out.clips) {
      byAudio += r.method == "audio" || r.method == "manual";
      byTs += r.method == "timestamp";
      none += r.method == "none";
      logInfo("  clip " + r.id + " " + r.method + fmt(" pos %.6f drift %.1f ppm", r.position, r.drift) +
              " segments " + std::to_string(r.segments.size()) + (r.needsReview ? " REVIEW" : ""));
    }
    logInfo("analyze done in " + elapsed() + ": " + std::to_string(out.components) + " scene(s), " +
            std::to_string(byAudio) + " by audio, " + std::to_string(byTs) + " by timestamp, " +
            std::to_string(none) + " unplaced");
  }
  out.edges = std::move(edges);
  report(1.0, "Done");
  return out;
}

}  // namespace syncu
