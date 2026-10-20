#include "audio.h"

#include <cstdio>
#include <sstream>
#include <stdexcept>

#ifdef _WIN32
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

namespace syncu {

namespace {

std::string g_ffmpeg = "ffmpeg";

std::string quote(const std::string& s) {
#ifdef _WIN32
  // cmd.exe: wrap in double quotes; double quotes are illegal in Windows paths.
  return "\"" + s + "\"";
#else
  std::string out = "'";
  for (char c : s) {
    if (c == '\'') out += "'\\''";
    else out += c;
  }
  return out + "'";
#endif
}

#ifdef _WIN32
const char* kNullErr = " 2>NUL";
#else
const char* kNullErr = " 2>/dev/null";
#endif

}  // namespace

#ifdef _WIN32
std::wstring widen(const std::string& utf8) {
  int n = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
  std::wstring w(size_t(n > 0 ? n - 1 : 0), L'\0');
  if (n > 1) MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, &w[0], n);
  return w;
}
#endif

void setFfmpegPath(const std::string& path) { g_ffmpeg = path; }
const std::string& ffmpegPath() { return g_ffmpeg; }

std::vector<float> decodeAudio(const std::string& path, const DecodeOptions& opts) {
  std::ostringstream cmd;
  cmd.precision(9);
  cmd << quote(g_ffmpeg) << " -nostdin -v error";
  // -ss before -i seeks quickly; FFmpeg still decodes accurately to the
  // requested sample for audio.
  if (opts.start > 0.0) cmd << " -ss " << std::fixed << opts.start;
  cmd << " -i " << quote(path);
  if (opts.duration >= 0.0) cmd << " -t " << std::fixed << opts.duration;
  cmd << " -map 0:a:" << opts.stream << " -vn";
  if (opts.channel >= 0)
    cmd << " -af " << quote("pan=mono|c0=c" + std::to_string(opts.channel));
  else
    cmd << " -ac 1";
  cmd << " -ar " << opts.sampleRate << " -f f32le -" << kNullErr;

#ifdef _WIN32
  // cmd.exe strips one level of outer quotes when the line starts with one.
  // Wide API so non-ASCII file names (é, ü, 日本) survive.
  std::wstring line = widen("\"" + cmd.str() + "\"");
  FILE* pipe = _wpopen(line.c_str(), L"rb");
#define pclose _pclose
#else
  std::string line = cmd.str();
  FILE* pipe = popen(line.c_str(), "r");
#endif
  if (!pipe) throw std::runtime_error("failed to start ffmpeg");

  std::vector<float> samples;
  float buf[8192];
  size_t n;
  while ((n = fread(buf, sizeof(float), 8192, pipe)) > 0)
    samples.insert(samples.end(), buf, buf + n);
  int status = pclose(pipe);
  if (status != 0 && samples.empty())
    throw std::runtime_error("ffmpeg could not decode audio from: " + path);
  return samples;
}

double probeDuration(const std::string& path) {
  DecodeOptions o;
  o.sampleRate = 1000;
  return double(decodeAudio(path, o).size()) / 1000.0;
}

}  // namespace syncu
