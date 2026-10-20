# Syncu: Build Spec (v0.1)

A Syncaila-style automatic multicam and multi-recorder audio sync that runs inside Premiere Pro, with no XML round trip.

## Targets
- Premiere Pro 26.2+ (UXP official since 25.6; hybrid native add-ons since 26.2)
- macOS Apple Silicon first, then Windows x64 from the same codebase
- Personal use: sideloaded with the UXP Developer Tool, no licensing
- Built by GitHub Actions in a private repo; you download a ready-to-load package

## Architecture (as built in v0.1)
```
Premiere Pro ── Syncu panel (UXP, plain JS) ──HTTP 127.0.0.1:47800──▶ Syncu Helper (C++)
```
- **Why a helper instead of a hybrid `.uxpaddon`:** Adobe requires Mac add-ons to be signed and notarized with a paid Apple Developer ID, and the hybrid SDK sits behind the Adobe Developer Console. The helper needs neither, and it works on Premiere 25.6+.
- The helper auto-starts at login (LaunchAgent on Mac, Startup entry on Windows) and listens on localhost only. It requires an `X-Syncu` header, and requests can't choose the executable it runs.
- If you get an Apple Developer ID later, the same engine (`syncu_core`) can be wrapped as an add-on.

## Sync engine (accuracy: sub-frame plus drift)
1. **Decode**: FFmpeg reads the audio from MOV/MP4/MXF/WAV/BWF (including multi-file recorders) and makes a mono mix (or the best channel), with polarity-inversion handling.
2. **Coarse match**: downsample to about 8 kHz, compute onset/energy envelopes, and run FFT cross-correlation (GCC-PHAT) of each clip against each recorder. This makes it fast across hour-long files.
3. **Fine match**: at full sample rate, GCC-PHAT in a ±50 ms window around the coarse peak, plus parabolic interpolation, gives sub-sample offsets.
4. **Confidence**: the ratio of the top peak to the second peak, and agreement between windows. Repeated audio (music, PA) yields alternative candidates for the Review panel.
5. **Drift**: measure the offset in windows along each long overlap, then fit a linear model to get the drift in ppm.
6. **Graph solve**: treat every clip as a node and every match as an edge. A global least-squares solve keeps 3+ cameras and multiple recorders consistent with each other, and rejects outlier matches.
7. **Silent clips**: placed by file timestamp, creation metadata and clip order relative to their synced neighbors on the same device, then flagged as "timestamp-placed".

## Drift correction: auto-cut and re-align (your choice)
- When drift exceeds a threshold (default ½ frame), split the recorder clip every N minutes (auto-chosen from the ppm figure, adjustable) and nudge each piece back to perfect sync.
- Cuts are placed in silence or low-energy spots where possible, so they're inaudible.

## Inputs (all three)
- **Selected bin(s)**: auto-classify cameras vs recorders.
- **Current timeline tracks**: one track per device, Syncaila-style.
- **Auto-detect by device**: group by metadata (camera model/serial), folder and file-name patterns. You can correct the groups in the panel before syncing.

## Outputs (chosen per project in the panel)
- **Synced timeline**: one track per camera/recorder, all aligned.
- **Multicam-ready**: an aligned source sequence laid out for Premiere's multicam workflow (cameras V1..Vn, recorders on top audio tracks).
- **Per-take sequences**: one synced sequence per take, plus a master timeline that nests them.
- In every mode, camera scratch audio is kept on its own tracks, **muted**, below the recorder audio.
- Everything goes into a new "Synced" bin. Originals are never modified. The whole build is one undo step (`executeTransaction`).

## Review panel
- Confident matches apply automatically. Doubtful ones are listed with a waveform overlay, a confidence score, alternative candidates, a nudge control, and accept/reject.

## Known risks to verify first (spike week)
1. **Sub-frame placement**: confirm UXP accepts clip positions at audio-sample precision (TickTime is 254,016,000,000 ticks/sec, so it should). If it doesn't, fall back to frame placement plus a sub-frame note.
2. **Moving existing clips**: there is no documented move action. "Sync in place" would use clone-at-offset plus `createRemoveItemsAction`. Output modes that build new sequences avoid the problem.
3. **Multicam source sequence**: there is no API to create one. "Multicam-ready" builds the aligned sequence, then you run Create Multi-Camera Source Sequence from it (one right-click).
4. **Track creation**: there is no addTrack call. Tracks are created by inserting past the last track index (documented behavior).
5. **Hybrid add-on toolchain**: avoided in v0.1 (see Architecture).
6. **Trimming drift pieces**: done by staging the full clip on a scratch track, trimming its in/out points, and cloning the piece onto its real track. The self-test verifies each step.

## Milestones
1. Spike: a UXP panel that lists the selected bin and places one clip at a sub-frame time, plus a native add-on hello-world built by CI.
2. Engine: decode, coarse/fine correlation and a confidence score, tested on Linux with synthetic and real clips.
3. Multicam graph solve, drift measurement and auto-cut planning.
4. Output builders (3 modes) and scratch-audio handling.
5. Review panel UI.
6. Windows build and polish.
