#pragma once
#include <complex>
#include <cstddef>
#include <vector>

namespace syncu {

using cfloat = std::complex<float>;

// In-place iterative radix-2 FFT. data.size() must be a power of two.
void fft(std::vector<cfloat>& data, bool inverse);

size_t nextPow2(size_t n);

// Full linear cross-correlation r[k] = sum_n a[n + k] * b[n], for lags
// k in [-(b.size()-1), a.size()-1]. Returned vector index i maps to lag
// i - (b.size() - 1). With phat=true the cross-spectrum is whitened
// (GCC-PHAT), which gives a sharp peak that is robust to reverb/EQ.
std::vector<float> crossCorrelate(const std::vector<float>& a,
                                  const std::vector<float>& b, bool phat);

}  // namespace syncu
