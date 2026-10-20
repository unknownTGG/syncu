#pragma once

namespace syncu {

// Minimal localhost-only HTTP server so the Premiere panel can talk to the
// engine without a signed native add-on. Blocks forever.
//
//   GET  /health            -> {"ok":true,"version":...,"ffmpeg":...}
//   POST /analyze  (json)   -> {"job": N}           (runs in background)
//   GET  /job?id=N          -> {"done":bool,"progress":0..1,"message":...,"result":{...}}
//   POST /match    (json)   -> match result
//
// Every request must carry the header "X-Syncu: 1" (browsers can't add it
// cross-origin without a preflight, which we never approve).
int runServer(int port);

}  // namespace syncu
