#include "fft.h"

#include <cmath>

namespace syncu {

constexpr double kPi = 3.14159265358979323846;

size_t nextPow2(size_t n) {
  size_t p = 1;
  while (p < n) p <<= 1;
  return p;
}

void fft(std::vector<cfloat>& data, bool inverse) {
  const size_t n = data.size();
  if (n < 2) return;

  // Bit-reversal permutation.
  for (size_t i = 1, j = 0; i < n; ++i) {
    size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(data[i], data[j]);
  }

  // Twiddles are computed in double so large transforms stay accurate.
  for (size_t len = 2; len <= n; len <<= 1) {
    const double ang = 2.0 * kPi / double(len) * (inverse ? 1.0 : -1.0);
    const size_t half = len / 2;
    std::vector<cfloat> tw(half);
    for (size_t k = 0; k < half; ++k)
      tw[k] = cfloat(float(std::cos(ang * double(k))), float(std::sin(ang * double(k))));
    for (size_t i = 0; i < n; i += len) {
      for (size_t k = 0; k < half; ++k) {
        cfloat u = data[i + k];
        cfloat v = data[i + k + half] * tw[k];
        data[i + k] = u + v;
        data[i + k + half] = u - v;
      }
    }
  }

  if (inverse) {
    const float inv = 1.0f / float(n);
    for (auto& x : data) x *= inv;
  }
}

std::vector<float> crossCorrelate(const std::vector<float>& a,
                                  const std::vector<float>& b, bool phat) {
  if (a.empty() || b.empty()) return {};
  const size_t outLen = a.size() + b.size() - 1;
  const size_t n = nextPow2(outLen);

  std::vector<cfloat> fa(n), fb(n);
  for (size_t i = 0; i < a.size(); ++i) fa[i] = a[i];
  for (size_t i = 0; i < b.size(); ++i) fb[i] = b[i];
  fft(fa, false);
  fft(fb, false);

  for (size_t i = 0; i < n; ++i) {
    cfloat x = fa[i] * std::conj(fb[i]);
    if (phat) {
      float m = std::abs(x);
      x = m > 1e-12f ? x / m : cfloat(0.0f, 0.0f);
    }
    fa[i] = x;
  }
  std::vector<cfloat>().swap(fb);
  fft(fa, true);

  // Circular result: lag k >= 0 at index k, lag k < 0 at index n + k.
  std::vector<float> out(outLen);
  const size_t negCount = b.size() - 1;
  for (size_t i = 0; i < negCount; ++i) out[i] = fa[n - negCount + i].real();
  for (size_t i = 0; i < a.size(); ++i) out[negCount + i] = fa[i].real();
  return out;
}

}  // namespace syncu
