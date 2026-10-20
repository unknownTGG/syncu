#include "audio.h"

#include "log.h"

#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <stdexcept>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#define pclose _pclose
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
  // aresample first_pts=0 pads silence when the audio stream starts after
  // the file's time zero, so sample 0 is always container time 0 (or the
  // -ss position) even for files whose audio is offset from the video.
  std::string af = "aresample=first_pts=0";
  if (opts.channel >= 0) af = "pan=mono|c0=c" + std::to_string(opts.channel) + "," + af;
  cmd << " -af " << quote(af) << " -ac 1";
  cmd << " -ar " << opts.sampleRate << " -f f32le -" << kNullErr;

#ifdef _WIN32
  // cmd.exe strips one level of outer quotes when the line starts with one.
  // Wide API so non-ASCII file names (é, ü, 日本) survive.
  std::wstring line = widen("\"" + cmd.str() + "\"");
  FILE* pipe = _wpopen(line.c_str(), L"rb");
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
  if (status != 0 && samples.empty()) {
    logError("ffmpeg failed (status " + std::to_string(status) + "): " + cmd.str());
    throw std::runtime_error("ffmpeg could not decode audio from: " + path);
  }
  if (status != 0)
    logWarn("ffmpeg exited " + std::to_string(status) + " after " +
            std::to_string(samples.size()) + " samples: " + path);
  return samples;
}

double videoStartTime(const std::string& path) {
  std::ostringstream cmd;
  cmd << quote(g_ffmpeg) << " -nostdin -hide_banner -i " << quote(path)
      << " -map 0:v:0 -vf showinfo -frames:v 1 -f null - 2>&1";
#ifdef _WIN32
  FILE* pipe = _wpopen(widen("\"" + cmd.str() + "\"").c_str(), L"rb");
#else
  FILE* pipe = popen(cmd.str().c_str(), "r");
#endif
  if (!pipe) return 0.0;
  std::string out;
  char buf[4096];
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), pipe)) > 0) out.append(buf, n);
  pclose(pipe);
  // First frame line: "[Parsed_showinfo_0 @ ...] n:   0 pts: 0 pts_time:0.04 ..."
  auto at = out.find("Parsed_showinfo");
  if (at == std::string::npos) return 0.0;
  auto pt = out.find("pts_time:", at);
  if (pt == std::string::npos) return 0.0;
  double v = std::atof(out.c_str() + pt + 9);
  if (v != 0.0) logInfo("video starts at " + std::to_string(v) + " s in " + path);
  return v;
}

std::string ffmpegVersion() {
  std::string cmd = quote(g_ffmpeg) + " -version" + kNullErr;
#ifdef _WIN32
  FILE* pipe = _wpopen(widen("\"" + cmd + "\"").c_str(), L"rb");
#else
  FILE* pipe = popen(cmd.c_str(), "r");
#endif
  if (!pipe) return "";
  char buf[512] = {0};
  std::string first = fgets(buf, sizeof(buf), pipe) ? buf : "";
  while (fgets(buf, sizeof(buf), pipe)) {
  }
  pclose(pipe);
  while (!first.empty() && (first.back() == '\n' || first.back() == '\r')) first.pop_back();
  return first;
}

double probeDuration(const std::string& path) {
  DecodeOptions o;
  o.sampleRate = 1000;
  return double(decodeAudio(path, o).size()) / 1000.0;
}

}  // namespace syncu
