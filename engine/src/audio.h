#pragma once
#include <string>
#include <vector>

namespace syncu {

struct DecodeOptions {
  int sampleRate = 2000;  // output rate (Hz)
  int channel = -1;       // -1 = mix all channels to mono, else pick channel N
  int stream = 0;         // which audio stream in the file
  double start = 0.0;     // seconds into the file
  double duration = -1.0; // seconds, < 0 = to end
};

// Path to the ffmpeg executable. Defaults to "ffmpeg" on PATH; the plugin
// points this at the binary bundled next to the add-on.
void setFfmpegPath(const std::string& path);
const std::string& ffmpegPath();

// Decode audio from any file FFmpeg can read into mono float samples.
// Throws std::runtime_error on failure.
std::vector<float> decodeAudio(const std::string& path, const DecodeOptions& opts);

// Time of the first video frame on the file's timeline (seconds), 0 for
// audio-only files. Premiere's clip time zero is this frame.
double videoStartTime(const std::string& path);

// First line of `ffmpeg -version`, or "" if ffmpeg can't be run.
std::string ffmpegVersion();

// Duration of the first audio stream in seconds (via a fast decode probe).
double probeDuration(const std::string& path);

#ifdef _WIN32
std::wstring widen(const std::string& utf8);  // UTF-8 -> UTF-16
#endif

}  // namespace syncu
