# Syncu

Automatic multicam and multi-recorder audio sync **inside Premiere Pro**, Syncaila-style but without the XML round trip.

- Syncs any number of cameras and audio recorders by their audio, to a fraction of a millisecond.
- Fixes clock drift on long takes by cutting the recorder audio at quiet spots and re-aligning each piece.
- Places silent clips (gimbal, drone, B-roll) by file time.
- Builds a **synced timeline**, **multicam-ready source sequences**, or **per-take sequences plus a master timeline**, chosen per project.
- Puts camera scratch audio on its own muted tracks under the recorder audio.
- Sends doubtful matches to a **Review** list, where you pick the right candidate or nudge it.
- Creates new sequences in a new bin and never touches your originals.

## How it works

```
Premiere Pro ── Syncu panel (UXP, JS) ──HTTP 127.0.0.1:47800──▶ Syncu Helper (C++)
                 scan bins / timeline                           FFmpeg decode
                 build sequences                                GCC-PHAT correlation
                 review UI                                      sub-sample refinement
                                                                drift fit + global solve
```

The heavy lifting runs in a small native helper so it's fast and identical on Mac and Windows. Adobe's in-process alternative, a hybrid `.uxpaddon`, requires an Apple Developer ID to sign and notarize. The helper only listens on localhost.

## Install (Mac, Apple Silicon)

1. Install FFmpeg: `brew install ffmpeg` (get Homebrew from https://brew.sh).
2. Download the latest **Syncu-mac-arm64** artifact from the repo's *Actions* tab and unzip it.
3. Double-click `install-mac.command`. If macOS blocks it: right-click → Open. This installs the helper and starts it at every login.
4. Install the **UXP Developer Tool** from Creative Cloud. Click *Add Plugin*, pick `plugin/manifest.json`, then *Load*.
5. In Premiere: *Window → UXP Plugins → Syncu*. The pill at the top should turn green.

## Install (Windows)

1. Download **Syncu-win-x64** from *Actions* and unzip it. FFmpeg is included.
2. Right-click `install-windows.ps1` → *Run with PowerShell*.
3. Load `plugin\manifest.json` in the UXP Developer Tool, same as on Mac.

## Use

1. **Source**, one of:
   - **Selected bins, one bin per device**: put each camera and each recorder in its own bin, then select those bins.
   - **Auto-detect devices**: select bins or clips; devices are guessed from card folders. Rename a device in the list to merge or split.
   - **Active timeline**: lay out one track per camera or recorder, like Syncaila.
2. **Output**: synced timeline / multicam-ready / per-take + master.
3. **Analyze**, then check the **Review** list if it appears, then **Build**.

Multi-file recorders (Zoom `ZOOM0001_Tr1.WAV`, `_Tr2`, `_LR`, F-series, Tascam) are detected automatically. Each file of a take gets its own track, and the files move together.

### Accuracy notes

- Audio-to-audio sync is sample-accurate. In the test suite the error is about 0.02 ms.
- Video can only sit on frame boundaries. The longest camera of each scene is placed exactly; other cameras are snapped to the nearest frame. That's at most ½ frame of picture offset, which no NLE can avoid. Recorder audio keeps its exact position.
- Drift tolerance defaults to 2 ms (*Advanced*). At a typical 30 ppm, that's one cut every ~2 minutes, placed at the quietest nearby moment.

## First run: please do the self-test

Some Premiere UXP calls are thinly documented. Select one video clip and one audio-only clip in the Project panel, then open *Diagnostics → Run Premiere API self-test*. Copy the log and send it back; it says exactly which build steps work on your Premiere version.

## Develop

```bash
cmake -S engine -B engine/build && cmake --build engine/build -j
SYNCU_ENGINE=engine/build/syncu-engine python3 engine/tests/run_tests.py   # needs ffmpeg + numpy
node plugin/tests/plan.test.js
engine/build/syncu-engine serve            # run the helper in a terminal
engine/build/syncu-engine match a.wav b.mp4
```

The spec and roadmap are in [docs/SPEC.md](docs/SPEC.md).
