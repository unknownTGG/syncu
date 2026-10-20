#include "sync.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

#include "audio.h"
#include "fft.h"

namespace syncu {

void removeDc(std::vector<float>& x) {
  if (x.empty()) return;
  double mean = 0.0;
  for (float v : x) mean += v;
  mean /= double(x.size());
  for (auto& v : x) v -= float(mean);
}

namespace {

// Vertex of the parabola through (-1, ym), (0, y0), (1, yp).
double parabolicPeak(double ym, double y0, double yp) {
  double den = ym - 2.0 * y0 + yp;
  if (std::fabs(den) < 1e-20) return 0.0;
  double d = 0.5 * (ym - yp) / den;
  return std::clamp(d, -0.5, 0.5);
}

float clamp01(float v) { return std::min(1.0f, std::max(0.0f, v)); }

}  // namespace

std::vector<Candidate> coarseSearch(const std::vector<float>& a,
                                    const std::vector<float>& b, int rate,
                                    double minOverlap, int maxCandidates,
                                    SpectrumCache* cacheA) {
  if (a.empty() || b.empty()) return {};
  std::vector<float> r;
  const size_t n = nextPow2(a.size() + b.size() - 1);
  if (cacheA) {
    std::lock_guard<std::mutex> l(cacheA->mu);
    if (cacheA->n != n) {
      cacheA->spec = spectrum(a, n);
      cacheA->n = n;
    }
  }
  if (cacheA) r = crossCorrelateSpec(cacheA->spec, a.size(), b, /*phat=*/true);
  else r = crossCorrelate(a, b, /*phat=*/true);
  if (r.empty()) return {};

  const long long lenA = (long long)a.size(), lenB = (long long)b.size();
  const long long minOv = std::min<long long>(
      (long long)(minOverlap * rate), std::min(lenA, lenB));

  // Magnitude over the valid lag range (enough overlap); polarity-inverted
  // matches show up as negative peaks, so use |r|.
  std::vector<float> mag(r.size(), 0.0f);
  double sumSq = 0.0;
  size_t valid = 0;
  for (size_t i = 0; i < r.size(); ++i) {
    long long k = (long long)i - (lenB - 1);
    long long ov = std::min(lenA, k + lenB) - std::max(0LL, k);
    if (ov < minOv) continue;
    mag[i] = std::fabs(r[i]);
    sumSq += double(mag[i]) * mag[i];
    ++valid;
  }
  if (valid == 0) return {};
  const float noise = float(std::sqrt(sumSq / double(valid))) + 1e-12f;

  // Pick peaks, excluding +/-50 ms around each one already taken.
  const long long excl = std::max(1LL, (long long)(0.05 * rate));
  std::vector<Candidate> out;
  for (int c = 0; c < maxCandidates; ++c) {
    size_t best = 0;
    float bestV = 0.0f;
    for (size_t i = 0; i < mag.size(); ++i)
      if (mag[i] > bestV) bestV = mag[i], best = i;
    if (bestV <= 0.0f) break;
    double frac = 0.0;
    if (best > 0 && best + 1 < r.size())
      frac = parabolicPeak(std::fabs(r[best - 1]), std::fabs(r[best]),
                           std::fabs(r[best + 1]));
    long long k = (long long)best - (lenB - 1);
    out.push_back({(double(k) + frac) / rate, bestV / noise});
    long long lo = std::max(0LL, (long long)best - excl);
    long long hi = std::min((long long)mag.size() - 1, (long long)best + excl);
    for (long long i = lo; i <= hi; ++i) mag[i] = 0.0f;
  }
  return out;
}

double refineOffset(const std::vector<float>& aSegIn, double aStart,
                    const std::vector<float>& bSegIn, double bStart, int rate,
                    double guess, double search, float* corr) {
  std::vector<float> a = aSegIn, b = bSegIn;
  removeDc(a);
  removeDc(b);
  if (a.size() < b.size() || b.empty())
    throw std::runtime_error("refineOffset: A segment must cover B segment");

  std::vector<float> r = crossCorrelate(a, b, /*phat=*/false);
  const long long lenA = (long long)a.size(), lenB = (long long)b.size();

  // Energy of each length-lenB window of A, via prefix sums.
  std::vector<double> pre(a.size() + 1, 0.0);
  for (size_t i = 0; i < a.size(); ++i) pre[i + 1] = pre[i] + double(a[i]) * a[i];
  double eb = 0.0;
  for (float v : b) eb += double(v) * v;

  auto norm = [&](long long k) -> double {
    if (k < 0 || k + lenB > lenA) return 0.0;
    double ea = pre[k + lenB] - pre[k];
    double den = std::sqrt(ea * eb);
    return den > 1e-20 ? double(r[size_t(k + lenB - 1)]) / den : 0.0;
  };

  const long long k0 = std::llround((bStart + guess - aStart) * rate);
  const long long s = std::max(1LL, (long long)std::ceil(search * rate));
  long long bestK = k0;
  double bestV = 0.0;
  for (long long k = k0 - s; k <= k0 + s; ++k) {
    double v = norm(k);
    if (std::fabs(v) > std::fabs(bestV)) bestV = v, bestK = k;
  }
  const double sign = bestV < 0 ? -1.0 : 1.0;
  double frac = parabolicPeak(sign * norm(bestK - 1), sign * bestV,
                              sign * norm(bestK + 1));
  if (corr) *corr = float(bestV);
  return aStart + (double(bestK) + frac) / rate - bStart;
}

std::vector<float> computeEnvelope(const std::vector<float>& x, int rate,
                                   double hop) {
  const size_t h = std::max<size_t>(1, size_t(hop * rate));
  std::vector<float> env;
  env.reserve(x.size() / h + 1);
  for (size_t i = 0; i < x.size(); i += h) {
    double s = 0.0;
    size_t e = std::min(x.size(), i + h);
    for (size_t j = i; j < e; ++j) s += double(x[j]) * x[j];
    env.push_back(float(std::sqrt(s / double(e - i))));
  }
  return env;
}

MatchResult matchFiles(const std::string& pathA, const std::string& pathB,
                       const MatchOptions& opts) {
  DecodeOptions da, db;
  da.sampleRate = db.sampleRate = opts.coarseRate;
  da.channel = opts.channelA;
  db.channel = opts.channelB;
  std::vector<float> a = decodeAudio(pathA, da), b = decodeAudio(pathB, db);
  removeDc(a);
  removeDc(b);
  return matchDecoded(pathA, pathB, a, b, opts);
}

MatchResult matchDecoded(const std::string& pathA, const std::string& pathB,
                         const std::vector<float>& a,
                         const std::vector<float>& b,
                         const MatchOptions& opts,
                         SpectrumCache* cacheA) {
  MatchResult res;
  const double durA = double(a.size()) / opts.coarseRate;
  const double durB = double(b.size()) / opts.coarseRate;

  res.candidates = coarseSearch(a, b, opts.coarseRate, opts.minOverlap,
                                opts.maxCandidates, cacheA);
  if (res.candidates.empty()) return res;

  const Candidate& best = res.candidates[0];
  res.coarseOffset = best.offset;
  res.peakRatio = res.candidates.size() > 1
                      ? best.score / std::max(1e-6f, res.candidates[1].score)
                      : best.score;

  // Overlap in B time at this offset.
  const double ovS = std::max(0.0, -best.offset);
  const double ovE = std::min(durB, durA - best.offset);
  res.overlap = std::max(0.0, ovE - ovS);
  if (res.overlap <= 0.0) return res;

  // Confidence: a match needs a clearly unique coarse peak (ratio), a peak
  // well above the noise floor (score), and real waveform similarity.
  const float cRatio = clamp01((res.peakRatio - 1.0f) / 1.5f);
  const float cScore = clamp01((best.score - 6.0f) / 14.0f);
  const float coarseConf = std::sqrt(cRatio * cScore);
  if (coarseConf < opts.refineMinCoarse) {
    res.offset = best.offset;
    res.timeB = 0.5 * (ovS + ovE);
    res.confidence = coarseConf * 0.6f;
    res.found = res.confidence > 0.0f;
    return res;
  }

  // Refine on the loudest stretch of the overlap (most signal to lock onto).
  const double win = std::min(opts.fineWindow, res.overlap);
  const double hop = 0.05;
  std::vector<float> env = computeEnvelope(b, opts.coarseRate, hop);
  const size_t wHops = std::max<size_t>(1, size_t(win / hop));
  size_t i0 = size_t(ovS / hop), i1 = size_t(std::max(ovS, ovE - win) / hop);
  i1 = std::min(i1, env.size() > wHops ? env.size() - wHops : 0);
  double run = 0.0, bestRun = -1.0;
  size_t bestI = i0;
  for (size_t i = i0; i < std::min(env.size(), i0 + wHops); ++i) run += env[i] * env[i];
  for (size_t i = i0; i <= i1; ++i) {
    if (run > bestRun) bestRun = run, bestI = i;
    if (i + wHops < env.size()) run += env[i + wHops] * env[i + wHops];
    run -= env[i] * env[i];
  }
  const double bStart = std::max(ovS, double(bestI) * hop);

  const double pad = opts.fineSearch + 0.002;
  DecodeOptions fa, fb;
  fa.sampleRate = fb.sampleRate = opts.fineRate;
  fa.channel = opts.channelA;
  fb.channel = opts.channelB;
  fb.start = bStart;
  fb.duration = win;
  double aStart = bStart + best.offset - pad;
  double aLead = 0.0;
  if (aStart < 0.0) aLead = -aStart, aStart = 0.0;
  fa.start = aStart;
  fa.duration = win + 2 * pad - aLead;
  std::vector<float> aSeg = decodeAudio(pathA, fa);
  std::vector<float> bSeg = decodeAudio(pathB, fb);
  // Edge case: overlap at the very start/end of A; trim B to fit inside A.
  const long long lead = std::llround(aLead * opts.fineRate);
  if (lead > 0) {
    bSeg.erase(bSeg.begin(), bSeg.begin() + std::min<long long>(lead, (long long)bSeg.size()));
    fb.start += double(lead) / opts.fineRate;
  }
  const size_t maxB = aSeg.size() > size_t(2 * pad * opts.fineRate)
                          ? aSeg.size() - size_t(2 * pad * opts.fineRate) : 0;
  if (bSeg.size() > maxB) bSeg.resize(maxB);

  res.timeB = 0.5 * (ovS + ovE);
  if (bSeg.size() < size_t(0.5 * opts.fineRate)) {
    res.offset = best.offset;  // too little audio to refine; keep coarse
  } else {
    res.timeB = fb.start + 0.5 * double(bSeg.size()) / opts.fineRate;
    float corr = 0.0f;
    res.offset = refineOffset(aSeg, aStart, bSeg, fb.start, opts.fineRate,
                              best.offset, opts.fineSearch, &corr);
    res.correlation = corr;
    res.polarityInverted = corr < 0.0f;
  }

  const float cCorr = clamp01(std::fabs(res.correlation) / 0.5f);
  res.confidence = coarseConf * (0.6f + 0.4f * cCorr);
  res.found = res.confidence > 0.0f;
  return res;
}

namespace {

struct Fit {
  double a = 0.0, b = 0.0;  // y = a + b x
};

Fit leastSquares(const std::vector<DriftPoint>& pts) {
  double n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const auto& p : pts) {
    if (!p.inlier) continue;
    n += 1; sx += p.timeB; sy += p.offset;
    sxx += p.timeB * p.timeB; sxy += p.timeB * p.offset;
  }
  Fit f;
  if (n == 0) return f;
  double den = n * sxx - sx * sx;
  if (n < 2 || std::fabs(den) < 1e-12) {
    f.a = sy / n;
    return f;
  }
  f.b = (n * sxy - sx * sy) / den;
  f.a = (sy - f.b * sx) / n;
  return f;
}

}  // namespace

DriftResult measureDrift(const std::string& pathA, const std::string& pathB,
                         double offset, const DriftOptions& opts,
                         double durA, double durB) {
  DriftResult res;
  if (durA < 0.0) durA = probeDuration(pathA);
  if (durB < 0.0) durB = probeDuration(pathB);
  const double ovS = std::max(0.0, -offset);
  const double ovE = std::min(durB, durA - offset);
  if (ovE - ovS < 2 * opts.window) return res;

  Fit fit{offset, 0.0};
  const double pad = opts.search + 0.002;
  for (double t = ovS + 0.5 * opts.window; t + 0.5 * opts.window <= ovE;
       t += opts.step) {
    const double bStart = t - 0.5 * opts.window;
    const double guess = fit.a + fit.b * t;
    const double aStart = bStart + guess - pad;
    if (aStart < 0.0 || aStart + opts.window + 2 * pad > durA) continue;

    DecodeOptions fa, fb;
    fa.sampleRate = fb.sampleRate = opts.rate;
    fa.channel = opts.channelA;
    fb.channel = opts.channelB;
    fa.start = aStart;
    fa.duration = opts.window + 2 * pad;
    fb.start = bStart;
    fb.duration = opts.window;
    std::vector<float> aSeg = decodeAudio(pathA, fa);
    std::vector<float> bSeg = decodeAudio(pathB, fb);
    if (bSeg.size() < size_t(opts.rate) || aSeg.size() < bSeg.size()) continue;

    float corr = 0.0f;
    double off = refineOffset(aSeg, aStart, bSeg, bStart, opts.rate, guess,
                              opts.search, &corr);
    // Quiet windows give junk; only keep clear locks.
    res.points.push_back({t, off, corr, std::fabs(corr) >= 0.3f});
    fit = leastSquares(res.points);
  }

  // Robust refit: drop points far from the line (MAD-based), twice.
  for (int pass = 0; pass < 2; ++pass) {
    std::vector<double> resid;
    for (const auto& p : res.points)
      if (p.inlier) resid.push_back(std::fabs(p.offset - (fit.a + fit.b * p.timeB)));
    if (resid.size() < 3) break;
    std::nth_element(resid.begin(), resid.begin() + resid.size() / 2, resid.end());
    const double mad = resid[resid.size() / 2];
    const double lim = std::max(4.0 * 1.4826 * mad, 2.0 / opts.rate);
    for (auto& p : res.points)
      if (p.inlier && std::fabs(p.offset - (fit.a + fit.b * p.timeB)) > lim)
        p.inlier = false;
    fit = leastSquares(res.points);
  }

  int n = 0;
  double ss = 0.0;
  for (const auto& p : res.points) {
    if (!p.inlier) continue;
    double e = p.offset - (fit.a + fit.b * p.timeB);
    ss += e * e;
    ++n;
  }
  res.valid = n >= 3;
  res.offsetAtB0 = fit.a;
  res.slope = fit.b;
  res.ppm = fit.b * 1e6;
  res.residualRms = n ? std::sqrt(ss / n) : 0.0;
  return res;
}

std::vector<DriftSegment> planDriftCuts(const DriftResult& drift,
                                        double ovS, double ovE,
                                        double tolerance,
                                        const std::vector<float>& env,
                                        int envRate) {
  std::vector<DriftSegment> segs;
  auto offsetAt = [&](double t) { return drift.offsetAtB0 + drift.slope * t; };
  const double slope = std::fabs(drift.slope);
  // Each piece is aligned at its middle, so the error at its ends is
  // slope * L / 2; keep that under the tolerance.
  const double L = slope > 1e-12 ? 2.0 * tolerance / slope : 1e18;
  if (ovE - ovS <= L) {
    segs.push_back({ovS, ovE, offsetAt(0.5 * (ovS + ovE))});
    return segs;
  }

  // Snap each ideal cut to the quietest spot nearby, but never so far that
  // a piece overshoots the tolerance (cuts only move earlier).
  std::vector<double> cuts;
  double prev = ovS;
  while (ovE - prev > L) {
    double ideal = prev + L;
    double lo = std::max(prev + 0.5 * L, ideal - std::min(10.0, 0.25 * L));
    double best = ideal;
    if (!env.empty()) {
      float bestE = 1e30f;
      for (size_t i = size_t(std::max(0.0, lo * envRate));
           i <= size_t(ideal * envRate) && i < env.size(); ++i) {
        if (env[i] < bestE) bestE = env[i], best = double(i) / envRate;
      }
    }
    cuts.push_back(best);
    prev = best;
  }

  double s = ovS;
  for (double c : cuts) {
    segs.push_back({s, c, offsetAt(0.5 * (s + c))});
    s = c;
  }
  segs.push_back({s, ovE, offsetAt(0.5 * (s + ovE))});
  return segs;
}

}  // namespace syncu
