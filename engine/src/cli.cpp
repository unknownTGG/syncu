// syncu-engine: command-line front end to the sync engine, for testing
// outside Premiere.
//
//   syncu-engine match A B          offset of B relative to A (JSON)
//   syncu-engine drift A B OFFSET   clock drift across the overlap (JSON)
//   syncu-engine analyze REQ.json   full project analysis (JSON in/out)
//   syncu-engine serve [PORT]       run the helper the Premiere panel talks to

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "api.h"
#include "server.h"
#include "audio.h"
#include "sync.h"

namespace {

bool exists(const std::string& p) {
  std::ifstream f(p);
  return f.good();
}

// Find ffmpeg: $SYNCU_FFMPEG, next to this executable, Homebrew, then PATH.
void locateFfmpeg(const char* argv0) {
  if (const char* ff = std::getenv("SYNCU_FFMPEG")) {
    syncu::setFfmpegPath(ff);
    return;
  }
#ifdef _WIN32
  const char* exe = "ffmpeg.exe";
  const char sep = '\\';
#else
  const char* exe = "ffmpeg";
  const char sep = '/';
#endif
  std::string self = argv0;
  auto cut = self.find_last_of("/\\");
  std::vector<std::string> tries;
  if (cut != std::string::npos) tries.push_back(self.substr(0, cut) + sep + exe);
#ifndef _WIN32
  tries.push_back("/opt/homebrew/bin/ffmpeg");
  tries.push_back("/usr/local/bin/ffmpeg");
#endif
  for (const auto& t : tries)
    if (exists(t)) { syncu::setFfmpegPath(t); return; }
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::cerr << "usage: syncu-engine match A B | drift A B OFFSET | analyze REQUEST.json | serve [PORT]\n";
    return 2;
  }
  locateFfmpeg(argv[0]);
  const std::string cmd = argv[1];

  if (cmd == "serve") return syncu::runServer(argc >= 3 ? std::atoi(argv[2]) : 47800);

  if (cmd == "match" && argc >= 4) {
    nlohmann::json req = {{"a", argv[2]}, {"b", argv[3]}};
    std::cout << syncu::matchJson(req.dump()) << "\n";
    return 0;
  }
  if (cmd == "drift" && argc >= 5) {
    syncu::DriftOptions o;
    auto r = syncu::measureDrift(argv[2], argv[3], std::stod(argv[4]), o);
    nlohmann::json pts = nlohmann::json::array();
    for (auto& p : r.points)
      pts.push_back({{"timeB", p.timeB}, {"offset", p.offset}, {"corr", p.corr}, {"inlier", p.inlier}});
    std::cout << nlohmann::json{{"valid", r.valid}, {"offsetAtB0", r.offsetAtB0},
                                {"ppm", r.ppm}, {"residualRms", r.residualRms},
                                {"points", pts}}.dump()
              << "\n";
    return 0;
  }
  if (cmd == "analyze" && argc >= 3) {
    std::ifstream f(argv[2]);
    if (!f) { std::cerr << "cannot read " << argv[2] << "\n"; return 1; }
    std::stringstream ss;
    ss << f.rdbuf();
    std::string res = syncu::analyzeJson(ss.str(), [](double frac, const std::string& msg) {
      std::fprintf(stderr, "\r%3d%% %-20s", int(frac * 100), msg.c_str());
    });
    std::fprintf(stderr, "\n");
    std::cout << res << "\n";
    return 0;
  }
  std::cerr << "bad arguments\n";
  return 2;
}
