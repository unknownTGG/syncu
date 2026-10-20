#pragma once
#include <complex>
#include <mutex>
#include <string>
#include <vector>

namespace syncu {

// Sign convention everywhere: offset = (time in A) - (time in B) for the
// same sound, i.e. B starts `offset` seconds after A starts. Placing B on
// the timeline at A.start + offset puts them in sync.

// Caches the spectrum of a long file so matching many clips against it
// transforms it once. Thread-safe; holds one FFT size.
struct SpectrumCache {
  std::mutex mu;
  size_t n = 0;
  std::vector<std::complex<float>> spec;
};

struct Candidate {
  double offset = 0.0;  // seconds
  float score = 0.0f;   // normalized peak height (peak / noise floor)
};

struct MatchOptions {
  int coarseRate = 2000;      // Hz, for the whole-file search
  int fineRate = 48000;       // Hz, for sample-accurate refinement
  double fineWindow = 15.0;   // seconds of B used for refinement
  double fineSearch = 0.004;  // +/- seconds searched around the coarse peak
  double minOverlap = 2.0;    // seconds; shorter overlaps are rejected
  int channelA = -1, channelB = -1;
  int maxCandidates = 5;
  // Skip the (costly, decode-heavy) fine step when the coarse match alone
  // already scores below this; such pairs are rejected anyway.
  float refineMinCoarse = 0.08f;
};

struct MatchResult {
  bool found = false;
  double offset = 0.0;       // refined, seconds
  double coarseOffset = 0.0; // seconds
  float confidence = 0.0f;   // 0..1
  float peakRatio = 0.0f;    // best / second-best coarse peak
  float correlation = 0.0f;  // normalized fine correlation at the peak (-1..1)
  bool polarityInverted = false;
  double overlap = 0.0;      // seconds of shared audio at this offset
  double timeB = 0.0;        // B time (s) where the refined offset was measured
  std::vector<Candidate> candidates;  // best first, for the Review panel
};

// Pure-signal versions (used by tests and by callers that already decoded).
// `a` and `b` should already have their DC removed (see removeDc).
std::vector<Candidate> coarseSearch(const std::vector<float>& a,
                                    const std::vector<float>& b, int rate,
                                    double minOverlap, int maxCandidates,
                                    SpectrumCache* cacheA = nullptr);

void removeDc(std::vector<float>& x);

// Refine around `guess`, given decoded segments: `aSeg` starts at aStart
// seconds in A, `bSeg` starts at bStart seconds in B. Returns the refined
// offset; writes the normalized correlation (signed) to *corr.
double refineOffset(const std::vector<float>& aSeg, double aStart,
                    const std::vector<float>& bSeg, double bStart, int rate,
                    double guess, double search, float* corr);

// Full file-to-file match: coarse search over both whole files, then
// sample-accurate refinement of the best candidate.
MatchResult matchFiles(const std::string& a, const std::string& b,
                       const MatchOptions& opts);

// Same, with both files already decoded at opts.coarseRate (lets callers
// decode each file once and match it against many others).
MatchResult matchDecoded(const std::string& a, const std::string& b,
                         const std::vector<float>& coarseA,
                         const std::vector<float>& coarseB,
                         const MatchOptions& opts,
                         SpectrumCache* cacheA = nullptr);

struct DriftPoint {
  double timeB;   // seconds into B (window centre)
  double offset;  // measured offset at that point
  float corr;
  bool inlier;
};

struct DriftResult {
  bool valid = false;
  double offsetAtB0 = 0.0;  // fitted offset at B time 0
  double slope = 0.0;       // d(offset)/d(timeB), dimensionless
  double ppm = 0.0;         // slope * 1e6
  double residualRms = 0.0; // seconds
  std::vector<DriftPoint> points;
};

struct DriftOptions {
  int rate = 48000;
  double window = 8.0;   // seconds per measurement
  double step = 60.0;    // seconds between measurements
  double search = 0.02;  // +/- seconds around the prediction
  int channelA = -1, channelB = -1;
};

// Measure how the offset changes across a long overlap (clock drift).
// durA/durB < 0 means "probe the file".
DriftResult measureDrift(const std::string& a, const std::string& b,
                         double offset, const DriftOptions& opts,
                         double durA = -1.0, double durB = -1.0);

// Plan where to cut B so every piece stays within `tolerance` seconds of
// perfect sync. Cuts snap to quiet spots in B (from its envelope).
struct DriftSegment {
  double startB, endB;  // seconds into B
  double offset;        // offset to use for this piece
};

// RMS envelope with one value per `hop` seconds (e.g. 0.05 -> 20 Hz).
std::vector<float> computeEnvelope(const std::vector<float>& x, int rate,
                                   double hop);

std::vector<DriftSegment> planDriftCuts(const DriftResult& drift,
                                        double overlapStartB, double overlapEndB,
                                        double tolerance,
                                        const std::vector<float>& envelopeB,
                                        int envelopeRate);

}  // namespace syncu
