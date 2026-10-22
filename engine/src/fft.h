#pragma once
#include <complex>
#include <cstddef>
#include <vector>

namespace syncu {

using cfloat = std::complex<float>;

// Smallest FFT length >= n that pocketfft handles fast (2^a 3^b 5^c ...).
size_t fftSize(size_t n);

// Full linear cross-correlation r[k] = sum_n a[n + k] * b[n], for lags
// k in [-(b.size()-1), a.size()-1]. Returned vector index i maps to lag
// i - (b.size() - 1). With phat=true the cross-spectrum is whitened
// (GCC-PHAT), which gives a sharp peak that is robust to reverb/EQ.
std::vector<float> crossCorrelate(const std::vector<float>& a,
                                  const std::vector<float>& b, bool phat);

// Real-input spectrum of x zero-padded to n (n/2 + 1 bins).
std::vector<cfloat> spectrum(const std::vector<float>& x, size_t n);

// Same as crossCorrelate, with a's spectrum precomputed at
// n = fftSize(lenA + b.size() - 1) (lets a long file be transformed once).
std::vector<float> crossCorrelateSpec(const std::vector<cfloat>& specA, size_t n,
                                      size_t lenA, const std::vector<float>& b,
                                      bool phat);

// Generalised cross-correlation with the cross-spectrum divided by its
// magnitude^beta (beta = 1 is PHAT, 0 is plain correlation), keeping only
// bins between loHz and hiHz. Same lag layout as crossCorrelate.
std::vector<float> crossCorrelateWeighted(const std::vector<float>& a,
                                          const std::vector<float>& b, int rate,
                                          float beta, double loHz, double hiHz);

}  // namespace syncu
