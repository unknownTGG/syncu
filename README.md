# Syncu

**Automatic multicam and multi-recorder audio sync, inside Premiere Pro.**

Syncu lines up footage from any number of cameras and audio recorders by listening to their audio. It works like [Syncaila](https://syncaila.com/), but runs as a panel in Premiere, so there's no XML export and re-import.

- **Sample-accurate.** Audio is aligned to a fraction of a millisecond, not just to the nearest frame.
- **Full-length audio.** Recorder files are placed whole, never cut, so you can cut however you like afterwards.
- **Drift aware.** Recorders and cameras run on slightly different clocks. Syncu measures the drift and tells you how far a long take drifts by its ends. It can also cut long recordings at quiet moments and re-align each piece, but only if you turn that on.
- **Built for messy shoots.** It handles 3+ cameras, several recorders, start/stop clips, multi-file recorders (Zoom/Tascam), and silent clips (gimbal, drone, B-roll), which are placed by file time.
- **Three outputs, chosen per project:** a synced timeline, multicam-ready source sequences, or per-take sequences plus a master timeline.
- **Safe.** Everything goes into new sequences in a new bin. Your clips and existing sequences are never modified, and each build step can be undone.

> **Status: v0.1, early.** The sync engine and panel are heavily tested (see [Testing](#testing)), but not yet inside a real copy of Premiere. Please run the [self-test](#first-run-checklist) on first use and send the report back.

---

## Contents

- [Requirements](#requirements)
- [Install on Mac](#install-on-mac-apple-silicon)
- [Install on Windows](#install-on-windows)
- [First-run checklist](#first-run-checklist)
- [How to use](#how-to-use)
- [Output modes](#output-modes)
- [Settings](#settings)
- [Tips for best results](#tips-for-best-results)
- [Accuracy: what to expect](#accuracy-what-to-expect)
- [Troubleshooting](#troubleshooting)
- [Reporting a problem](#reporting-a-problem)
- [Updating and uninstalling](#updating-and-uninstalling)
- [Privacy and security](#privacy-and-security)
- [Known limitations](#known-limitations)
- [How it works](#how-it-works)
- [Development](#development)
- [Third-party software](#third-party-software)

---

## Requirements

| | Mac | Windows |
|---|---|---|
| OS | macOS 12+ on Apple Silicon (M1 or newer) | Windows 10/11, 64-bit |
| Premiere Pro | **26.2 or newer** | **26.2 or newer** |
| FFmpeg | Install with Homebrew (below) | Included in the download |
| Adobe **UXP Developer Tool** | Free, from the Creative Cloud app | Same |

Intel Macs aren't built yet. Ask if you need one.

---

## Install on Mac (Apple Silicon)

**1. Install FFmpeg** (one time). Open **Terminal** and run:

```bash
brew install ffmpeg
```

No Homebrew? Install it from [brew.sh](https://brew.sh) first.

**2. Download Syncu.** On this repo, go to the **Actions** tab, open the latest green ✔ **build** run, and scroll to **Artifacts**. Download **Syncu-mac-arm64** and unzip it. You need to be signed in to GitHub to see artifacts.

**3. Install the helper.** The helper is the small background program that does the audio analysis.

- In Terminal, type `bash ` (with a trailing space).
- Drag `install-mac.command` from the unzipped folder into the Terminal window.
- Press **Enter**.

You should see `Syncu helper is running`. It now starts by itself every time you log in.

> Use `bash` rather than double-clicking. GitHub's zip downloads strip the "executable" permission, and macOS blocks downloaded scripts.

**4. Load the panel into Premiere.**

1. Install **UXP Developer Tool** from the Creative Cloud app (*Apps → search "UXP"*).
2. Open Premiere Pro. If the Developer Tool doesn't see Premiere, turn on developer mode in Premiere's settings (look under *Plugins*).
3. In the UXP Developer Tool, click **Add Plugin**, choose `plugin/manifest.json` from the unzipped folder, then click **Load**.
4. In Premiere, open **Window → UXP Plugins → Syncu**.

The status light at the top right of the panel should be green and say **Ready**. If it isn't, see [Troubleshooting](#troubleshooting).

> A plugin loaded through the Developer Tool may need loading again after Premiere restarts. Open the UXP Developer Tool and click **Load** again.

---

## Install on Windows

1. **Download** **Syncu-win-x64** from the **Actions** tab (latest green run → **Artifacts**) and unzip it. FFmpeg is included.
2. **Install the helper.** Right-click `install-windows.ps1` → **Run with PowerShell**.
   - It copies the helper to `%LOCALAPPDATA%\Syncu` and starts it hidden at every login.
   - If Windows blocks the script, open PowerShell in that folder and run `powershell -ExecutionPolicy Bypass -File .\install-windows.ps1`.
3. **Load the panel** with the UXP Developer Tool, the same as Mac step 4: *Add Plugin* → `plugin\manifest.json` → *Load*.

---

## First-run checklist

Do this once. It takes about two minutes and tells us whether every Premiere feature Syncu relies on works on your version.

1. In the Project panel, select **one video clip** and **one audio-only clip** (for example a WAV from your recorder).
2. In the Syncu panel, open **Help & diagnostics** at the bottom and click **Run Premiere self-test**. It creates a throwaway sequence called *Syncu self-test*, which you can delete afterwards. Its clips are trimmed on purpose; real builds keep audio full length.
3. Click **Copy report** and paste it into the chat.

Any `FAIL` line in the self-test points to exactly what needs fixing.

---

## How to use

The panel is laid out top to bottom: **1 Source → 2 Output → 3 Results**. Each section folds away; a folded section's header still shows a one-line summary, such as *5 devices · 11 clips*. **Analyze** and **Build in Premiere** stay pinned at the bottom of the panel, and the rest scrolls.

### 1. Organize your media (recommended)

Put each device in its own bin: `Cam A`, `Cam B`, `Zoom`, `Lav 1`, and so on. Clips from the same device are never compared with each other, because a single camera can't record two things at once. Telling Syncu which clips belong together makes matching faster and more reliable.

### 2. Pick a source

| Source | When to use |
|---|---|
| **Selected bin(s), one bin per camera/recorder** | Recommended. Select your device bins in the Project panel. |
| **Selected bin(s), auto-detect devices** | Media isn't sorted. Syncu guesses devices from card folder names, e.g. `Cam A/Card 2/PRIVATE/M4ROOT/CLIP/C0001.MP4` → `Cam A`. |
| **Active timeline, one track per device** | You've already laid out clips Syncaila-style: one camera or recorder per track. |

Click **Scan selection**. The device list shows what was found: **CAM** for cameras, **REC** for recorders. **Rename a device** in the list to fix grouping: give two devices the same name to merge them, or different names to split them.

Multi-file recorders are detected automatically, for example Zoom `ZOOM0001_Tr1.WAV` / `_Tr2` / `_LR`, F-series `230101_0001_Tr1.wav`, and Tascam. Each file of a take gets its own track, and they stay locked together.

### 3. Pick an output

See [Output modes](#output-modes). Leave **Mute camera scratch audio** on unless you want to hear the camera mics.

### 4. Analyze

Click **Analyze**. A progress bar shows reading, matching and drift measurement. Afterwards you'll see a summary:

> `42 synced by audio · 3 by timestamp · 1 not placed`, plus any drift corrections

### 5. Review (if shown)

If anything is uncertain, a **Review** section appears.

- **Uncertain matches** show the clip pair, a confidence score, and a dropdown of candidate offsets. Pick the right one, optionally **nudge** it in milliseconds, tick **Use this match**, then click **Re-analyze with my fixes**.
- **Placed by file time** means the clip had no usable audio, so it was positioned by its file timestamp. Check it on the timeline; it's marked there with a marker.
- **Not placed** means no audio match was found and the clip's time couldn't be trusted. Place it manually.

### 6. Build

Click **Build in Premiere**. Syncu creates a new bin called **`Syncu <date time>`** containing the new sequences. Track layout:

- **Video:** V1 is the camera with the most footage, then the next camera, and so on.
- **Audio:** recorder tracks come first (A1, A2, …), each recorder file **full length**. Camera scratch audio sits below, on **muted** tracks.
- **Markers** flag clips that need a look, and scene starts in the synced-timeline mode.

Nothing in your existing project is changed. To start over, delete the Syncu bin.

---

## Output modes

| Mode | What you get | Best for |
|---|---|---|
| **Synced timeline** | One sequence with every device on its own track. Separate scenes are laid back to back with a 10 s gap and a marker. | Quick review, simple edits, podcasts |
| **Multicam-ready** | One aligned source sequence per scene. To make it a multicam clip, right-click it in the bin → *Create Multi-Camera Source Sequence*. Premiere doesn't let plugins do this step. | Multicam editing |
| **Per-take + master** | One sequence per take (overlapping camera clips grouped), plus a master timeline with every take nested in order. Recorder files are placed full length in every take they cover. To trim them to each take (±1 s), turn on *Per-take mode: trim recorder audio* in Advanced. | Narrative/interview shoots with many takes (Filmit-style) |

A **scene** is a group of clips that overlap in time. Separate events (morning interview, afternoon B-roll) become separate scenes.

---

## Settings

Under **Output → Advanced**:

| Setting | Default | Meaning |
|---|---|---|
| **Cut long recordings to fix clock drift** | Off | Off: every recorder file stays one clip, in perfect sync at its middle. The summary says how far its ends drift (e.g. 30 ppm over a 30-min take is ±27 ms at the ends). On: long files are cut at quiet moments so every piece stays within the drift tolerance. |
| **Drift tolerance (ms)** | 2 | Only used when cutting. Smaller means more cuts. At 30 ppm, 2 ms means one cut every ~2 minutes. |
| **Per-take mode: trim recorder audio to each take** | Off | Off: full-length recorder files in every take. On: trimmed to the take ±1 s. |
| **Auto-accept confidence** | 0.5 | Matches at or above this are used automatically. Matches between 0.15 and this value go to Review. Raise it if you see wrong matches; lower it if too much ends up in Review. Allowed range 0.05–0.99; anything else resets to 0.5, with a note in the log. |
| **Search accuracy** | Normal | *Fast* / *Normal* / *High*: the sample rate of the first-pass search. *High* can help with very noisy or distant camera audio. Final accuracy is always sample-level either way. |

---

## Tips for best results

- **Record scratch audio on every camera**, even a cheap built-in mic. Syncu matches by sound.
- **A loud, distinct moment** helps on noisy shoots: a clap, a slate, or just speech. Continuous music or applause is harder because it repeats.
- **Keep the original files.** Syncu reads the media files directly. Proxies are fine in Premiere, but the originals must be online.
- **Set camera clocks** (roughly) if you shoot silent B-roll. Silent clips are placed by file time, so a camera with an unset clock can't be placed. Syncu leaves such clips out rather than putting them hours away.
- **Very long projects:** a 1-hour recorder plus 160 camera clips analyzes in about 2 minutes on a 4-core machine. Apple Silicon is usually faster.

---

## Accuracy: what to expect

- **Audio vs. audio is sample-accurate.** In testing, typical error is 0.005–0.03 ms, and the worst case in a 161-clip shoot was 0.5 ms. That's tight enough to mix several mics without phasing.
- **Video can only sit on frame boundaries.** Each scene's main camera lands exactly; other cameras are snapped to the nearest frame, so at most ½ frame of picture offset. No editor can avoid this. Recorder audio always keeps its exact position.
- **Premiere snaps clip placement to whole frames**, audio included. Syncu places each recorder clip, measures where Premiere actually put it, and shifts it by the leftover fraction of a frame. Every placement is verified, and the log states the accuracy achieved (e.g. *audio placed sample-accurately*). If your Premiere version doesn't allow sub-frame shifts, audio is frame-accurate (±½ frame) and the log says so.
- **Drift:** with full-length clips (default), a recorder is exact at its middle and off by *drift × length ÷ 2* at its ends; the summary shows the number. With drift cuts on, every piece stays within the tolerance (default 2 ms).
- **Silent clips** are only as accurate as the camera clock and file timestamps, typically within about a second. Memory cards formatted exFAT/FAT store file times to the nearest 2 seconds.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Status says **helper not running** | Re-run the installer (`bash install-mac.command` / `install-windows.ps1`). To check by hand, run the helper in a terminal: Mac `~/Library/Application\ Support/Syncu/syncu-engine serve`, Windows `%LOCALAPPDATA%\Syncu\syncu-engine.exe serve`. If it says *port 47800 busy*, it's already running. |
| Status says **ffmpeg missing** | Mac: `brew install ffmpeg`, then re-run the installer. Windows: make sure `ffmpeg.exe` sits next to `syncu-engine.exe` in `%LOCALAPPDATA%\Syncu`. |
| Helper runs but the panel can't reach it | Copy the report. The `helper` section says why (e.g. Premiere blocked the request). |
| **Scan finds 0 clips** | Select bins or clips in the **Project panel** (not the timeline) before clicking Scan, or choose *Active timeline* as the source. |
| "only one device found" | Every clip landed in one device, so nothing can be matched. Put each camera/recorder in its own bin, or rename devices in the list. |
| Clips **not placed** | No audio match: check the clip has scratch audio and really overlaps another device's recording. Try *Search accuracy: High*, or fix it in Review. |
| A clip synced to the **wrong place** | Repetitive audio (music, PA) can fool any audio sync. Raise *Auto-accept confidence* so it goes to Review, pick the right candidate, then re-analyze. |
| Build fails partway | Undo (Cmd/Ctrl+Z) or delete the Syncu bin, then **Copy report** and send it. The log shows which step failed. |

---

## Reporting a problem

Under **Help & diagnostics** (bottom of the panel):

- **Copy report** copies a full diagnostic report; paste it into the chat.
- **Save…** saves the same text to a file.

The report contains:
- Premiere, OS, helper and FFmpeg versions
- your settings and the scanned clip list (your home folder is shortened to `~`)
- analysis results: every clip's placement, every match with its confidence
- the last build plan and the self-test results
- the panel log and the helper log

Logs are also kept on disk:
- **Panel log:** the plugin's data folder, `syncu-log.txt`.
- **Helper log on Mac:** `~/Library/Application Support/Syncu/helper.log`.
- **Live helper log:** `http://127.0.0.1:47800/log`, which needs the header `X-Syncu: 1`, e.g. `curl -H 'X-Syncu: 1' http://127.0.0.1:47800/log`.

---

## Updating and uninstalling

**Update:**
1. Download the newest artifact.
2. Re-run the installer. It replaces the helper and restarts it.
3. In the UXP Developer Tool, remove the old plugin entry, then *Add Plugin* the new `plugin/manifest.json` and click *Load*.

**Uninstall on Mac:** run `bash uninstall-mac.command`, then remove the plugin in the UXP Developer Tool.

**Uninstall on Windows:** delete `%LOCALAPPDATA%\Syncu` and `SyncuHelper.vbs` from your Startup folder (Win+R → `shell:startup`). End `syncu-engine.exe` in Task Manager, and remove the plugin in the Developer Tool.

---

## Privacy and security

- **Everything runs on your computer.** No media, audio or project data is uploaded anywhere.
- **The helper only listens on `127.0.0.1`,** so other devices on your network can't reach it.
- **It rejects requests without a private header**, which stops random websites from talking to it.
- **Requests can't choose which program it runs.** It only ever runs FFmpeg, found on your own system.
- **It only reads media files**; it never writes to or deletes them.

---

## Known limitations

- **Not yet tested inside real Premiere.** Run the self-test and send the report.
- **Multicam clips:** Premiere doesn't let plugins create multicam source sequences. Syncu builds the aligned sequence; you do the final right-click.
- **Video is never cut for drift.** If two long cameras drift against each other, the non-reference camera is aligned at its middle, and a note is logged.
- **Camera audio with many separate mono channels** may use more audio tracks than planned. Tell us if tracks look shuffled.
- **Mac builds are Apple Silicon only** for now.
- **Developer-mode install:** Syncu loads through the UXP Developer Tool rather than the Creative Cloud marketplace. A signed `.ccx` package is possible later.

---

## How it works

```
Premiere Pro ── Syncu panel (UXP, JavaScript) ── HTTP 127.0.0.1:47800 ──▶ Syncu Helper (C++)
                 • scans bins / timeline                                   • FFmpeg decodes audio
                 • detects devices, multi-file takes                       • GCC-PHAT cross-correlation
                 • review UI                                               • sample-accurate refinement
                 • builds sequences, tracks, markers                       • drift measurement
                 • logs + reports                                          • global least-squares solve
```

1. **Decode:** every file's audio is read once by FFmpeg. Times are measured against the file's own timeline, so cameras whose audio starts after their video are handled.
2. **Coarse search:** every pair of clips from *different* devices is cross-correlated (GCC-PHAT at 2 kHz). That finds candidate offsets and a confidence score that rewards a single clear match.
3. **Fine alignment:** promising matches are refined at 48 kHz with sub-sample interpolation. Polarity-inverted mics are detected.
4. **Drift:** long overlaps are measured every 60 s, and a straight-line fit gives each device's clock error in ppm.
5. **Global solve:** all matches feed one least-squares model that solves every clip's position *and* clock rate together. Inconsistent matches are dropped automatically, which keeps 3+ cameras and several recorders in agreement.
6. **Placement:** silent clips are placed by file time, using each device's clock offset. Clips more than an hour outside their scene are rejected as bad clocks.
7. **Build:** the panel lays out tracks, snaps video to frames, trims drift pieces, mutes scratch audio and adds markers, using Premiere's UXP API.

Why a separate helper instead of code inside Premiere? Adobe requires native in-Premiere add-ons to be signed and notarized with a paid Apple Developer ID. The helper needs neither, and it's identical on Mac and Windows.

---

## Development

```
engine/            C++ sync engine + helper (syncu-engine)
  src/             fft, audio (FFmpeg), sync, project (solver), api (JSON), server (HTTP), log
  tests/           run_tests.py (synthetic shoots with known truth), bench_large.py
  third_party/     nlohmann/json, pocketfft
plugin/            UXP panel (manifest, index.html, js/)
  tests/           plan.test.js (layout planner), sim/ (mock Premiere end-to-end)
scripts/           install / uninstall scripts
docs/SPEC.md       design notes and roadmap
.github/workflows  build + test on macOS (arm64) and Windows, packaged artifacts
```

Build and test (needs CMake, a C++17 compiler, FFmpeg, Python 3 with numpy, Node 22):

```bash
cmake -S engine -B engine/build && cmake --build engine/build -j

# Engine: synthetic shoots with known offsets, drift, AAC, polarity, silent clips...
SYNCU_ENGINE=engine/build/syncu-engine SYNCU_TEST_MEDIA=/tmp/syncu-media python3 engine/tests/run_tests.py

# Panel layout planner
node plugin/tests/plan.test.js

# End-to-end: real panel + real helper + mock Premiere (reuses the media above)
(cd plugin/tests/sim && npm install && node run-sim.js /tmp/syncu-media)

# 161-clip / 1-hour benchmark
SYNCU_ENGINE=engine/build/syncu-engine python3 engine/tests/bench_large.py /tmp/syncu-bench
```

Handy helper commands:

```bash
engine/build/syncu-engine serve                 # run the helper in a terminal (see its log live)
engine/build/syncu-engine match a.wav b.mp4     # offset of b relative to a, as JSON
engine/build/syncu-engine analyze request.json  # full analysis, JSON in/out
```

### Testing

Every push builds and tests on **macOS (Apple Silicon)** and **Windows** via GitHub Actions:

- **Engine suite:** sub-sample offsets on AAC camera audio, polarity inversion, unrelated-audio rejection, 40 ppm drift measurement and cutting, a camera whose audio starts after its video, silent clips, a silent camera with a wrong clock.
- **Planner tests:** track layout, frame snapping, takes, scratch-track muting, drift pieces kept on one track.
- **Simulation:** the real panel driving a simulated Premiere against the real helper. It runs scan → analyze → build in all three modes, the self-test, the report, and the helper going down, and checks every clip's position against the truth. The simulated Premiere is deliberately strict where Adobe's docs are vague.

---

## Third-party software

- [nlohmann/json](https://github.com/nlohmann/json): MIT License.
- [pocketfft](https://github.com/mreineck/pocketfft): BSD 3-Clause License (see `engine/third_party/pocketfft/LICENSE.md`).
- [FFmpeg](https://ffmpeg.org): run as a separate program. The Windows download bundles a GPL build from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds); on Mac, FFmpeg comes from Homebrew.

Adobe, Premiere Pro and Creative Cloud are trademarks of Adobe. Syncu is an independent project, not affiliated with Adobe or Syncaila.
