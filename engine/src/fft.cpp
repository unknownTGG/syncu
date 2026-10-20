#include "fft.h"

#include <algorithm>
#include <cmath>

#include <pocketfft/pocketfft_hdronly.h>

namespace syncu {

size_t fftSize(size_t n) {
  return pocketfft::detail::util::good_size_real(std::max<size_t>(n, 1));
}

std::vector<cfloat> spectrum(const std::vector<float>& x, size_t n) {
  std::vector<float> in(n, 0.0f);
  std::copy(x.begin(), x.begin() + std::min(x.size(), n), in.begin());
  std::vector<cfloat> out(n / 2 + 1);
  pocketfft::r2c<float>({n}, {sizeof(float)}, {sizeof(cfloat)}, 0, pocketfft::FORWARD,
                        in.data(), out.data(), 1.0f);
  return out;
}

std::vector<float> crossCorrelate(const std::vector<float>& a,
                                  const std::vector<float>& b, bool phat) {
  if (a.empty() || b.empty()) return {};
  const size_t n = fftSize(a.size() + b.size() - 1);
  return crossCorrelateSpec(spectrum(a, n), n, a.size(), b, phat);
}

std::vector<float> crossCorrelateSpec(const std::vector<cfloat>& specA, size_t n,
                                      size_t lenA, const std::vector<float>& b,
                                      bool phat) {
  if (lenA == 0 || b.empty()) return {};
  std::vector<cfloat> x = spectrum(b, n);
  for (size_t i = 0; i < x.size(); ++i) {
    // a * conj(b), written out (std::complex multiply is slow without -ffast-math).
    const float ar = specA[i].real(), ai = specA[i].imag();
    const float br = x[i].real(), bi = x[i].imag();
    float re = ar * br + ai * bi, im = ai * br - ar * bi;
    if (phat) {
      const float m = std::sqrt(re * re + im * im);
      if (m > 1e-12f) re /= m, im /= m;
      else re = im = 0.0f;
    }
    x[i] = cfloat(re, im);
  }
  std::vector<float> circ(n);
  pocketfft::c2r<float>({n}, {sizeof(cfloat)}, {sizeof(float)}, 0, pocketfft::BACKWARD,
                        x.data(), circ.data(), 1.0f / float(n));

  // Circular result: lag k >= 0 at index k, lag k < 0 at index n + k.
  const size_t outLen = lenA + b.size() - 1;
  std::vector<float> out(outLen);
  const size_t negCount = b.size() - 1;
  for (size_t i = 0; i < negCount; ++i) out[i] = circ[n - negCount + i];
  for (size_t i = 0; i < lenA; ++i) out[negCount + i] = circ[i];
  return out;
}

}  // namespace syncu
