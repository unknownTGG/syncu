#!/usr/bin/env python3
"""End-to-end engine tests on synthetic shoots with known ground truth.

Builds a fake multicam shoot (speech-like audio, room tone, reverb, AAC
camera files, a drifting recorder, a silent clip, an unrelated clip), runs
syncu-engine on it and checks the offsets against the truth.

Needs: python3 + numpy, ffmpeg on PATH, SYNCU_ENGINE=path/to/syncu-engine.
"""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

SR = 48000
ENGINE = os.environ.get("SYNCU_ENGINE", "build/syncu-engine")
rng = np.random.default_rng(1234)
failures = []


def check(name, ok, detail):
    print(("PASS " if ok else "FAIL ") + name + ": " + detail)
    if not ok:
        failures.append(name)


def speechlike(seconds):
    """Bursty band-limited noise with pitch: syllables separated by gaps."""
    n = int(seconds * SR)
    out = np.zeros(n)
    t = 0
    while t < n:
        dur = int(rng.uniform(0.08, 0.35) * SR)
        gap = int(rng.uniform(0.02, 0.4) * SR)
        if t + dur > n:
            break
        f0 = rng.uniform(90, 250)
        tt = np.arange(dur) / SR
        voiced = sum(np.sin(2 * np.pi * f0 * k * tt + rng.uniform(0, 6)) / k for k in range(1, 12))
        noise = rng.standard_normal(dur) * 0.3
        env = np.hanning(dur) * rng.uniform(0.2, 1.0)
        out[t:t + dur] += (voiced + noise) * env
        t += dur + gap
    return out / np.max(np.abs(out)) * 0.5


def frac_shift(x, delay_samples):
    """Delay x by a fractional number of samples (FFT phase shift)."""
    n = len(x)
    N = 1 << (2 * n - 1).bit_length()
    X = np.fft.rfft(x, N)
    f = np.fft.rfftfreq(N)
    y = np.fft.irfft(X * np.exp(-2j * np.pi * f * delay_samples), N)
    return y[:n]


def resample_drift(x, ppm):
    """Simulate a device whose clock runs fast by `ppm`: its sample k is
    true time k / (SR * (1 + ppm*1e-6))."""
    ratio = 1.0 + ppm * 1e-6
    t_dev = np.arange(int(len(x) * ratio)) / ratio
    t_dev = t_dev[t_dev < len(x) - 1]
    return np.interp(t_dev, np.arange(len(x)), x)


def room(x, snr_db, reverb=True):
    y = x.copy()
    if reverb:  # a few early reflections
        for d, g in [(0.011, 0.5), (0.023, 0.35), (0.041, 0.2)]:
            k = int(d * SR)
            y[k:] += g * x[:-k]
    noise = rng.standard_normal(len(y))
    p_sig = np.mean(y ** 2)
    noise *= np.sqrt(p_sig / (10 ** (snr_db / 10))) / np.std(noise)
    return y + noise


def write_wav(path, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "1",
                    "-i", "-", path], input=pcm, check=True)


def write_cam(path, x, codec="aac"):
    """A small video file with the given audio (like a camera clip)."""
    dur = len(x) / SR
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
    subprocess.run(["ffmpeg", "-v", "error", "-y",
                    "-f", "lavfi", "-i", f"color=c=gray:s=160x90:r=24000/1001:d={dur}",
                    "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "-",
                    "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
                    "-c:a", codec, "-b:a", "192k", path], input=pcm, check=True)


def engine(*args):
    r = subprocess.run([ENGINE, *args], capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def main():
    d = tempfile.mkdtemp(prefix="syncu-test-")
    print("media in", d)

    scene = speechlike(700)  # the "true" sound in the room, 700 s

    # ---- Test 1: camera (AAC in MP4) vs recorder, sub-sample offset ----
    rec = room(scene[: 300 * SR], 30, reverb=False)
    write_wav(f"{d}/rec1.wav", rec)
    true_off = 123.456789  # camera starts this many seconds into the recorder
    cam_src = frac_shift(scene, -0.37)  # extra 0.37-sample sub-sample shift
    start = int(true_off * SR)
    cam = room(cam_src[start:start + 40 * SR], 12)
    write_cam(f"{d}/cam1.mp4", cam)
    m = engine("match", f"{d}/rec1.wav", f"{d}/cam1.mp4")
    expect = true_off + 0.37 / SR
    err = abs(m["offset"] - expect)
    check("match/aac sub-sample", m["found"] and err < 50e-6,
          f"offset {m['offset']:.6f} vs {expect:.6f} (err {err*1e6:.1f} us, conf {m['confidence']:.2f})")

    # ---- Test 2: WAV-vs-WAV, inverted polarity ----
    b = -room(scene[50 * SR: 80 * SR], 20)
    write_wav(f"{d}/inv.wav", b)
    m = engine("match", f"{d}/rec1.wav", f"{d}/inv.wav")
    err = abs(m["offset"] - 50.0)
    check("match/polarity", m["found"] and err < 50e-6 and m["polarityInverted"],
          f"offset {m['offset']:.6f} (err {err*1e6:.1f} us), inverted={m['polarityInverted']}")

    # ---- Test 3: unrelated audio must not match confidently ----
    write_wav(f"{d}/other.wav", room(speechlike(30), 20))
    m = engine("match", f"{d}/rec1.wav", f"{d}/other.wav")
    check("match/unrelated rejected", m["confidence"] < 0.5,
          f"confidence {m['confidence']:.2f}")

    # ---- Test 4: drift measurement (recorder +40 ppm vs camera) ----
    long_cam = room(scene[: 650 * SR], 15)
    write_cam(f"{d}/camlong.mp4", long_cam)
    drift_rec = room(resample_drift(scene[5 * SR: 655 * SR], 40.0), 30, reverb=False)
    write_wav(f"{d}/recdrift.wav", drift_rec)
    m = engine("match", f"{d}/camlong.mp4", f"{d}/recdrift.wav")
    dr = engine("drift", f"{d}/camlong.mp4", f"{d}/recdrift.wav", str(m["offset"]))
    # Recorder sample k = true time k/(1+40e-6) -> offset grows by -40 ppm of tB.
    check("drift/ppm", dr["valid"] and abs(dr["ppm"] + 40.0) < 1.5,
          f"measured {dr['ppm']:.2f} ppm (expect -40.0), rms {dr['residualRms']*1e6:.1f} us")

    # ---- Test 5: full project (multicam + recorders + silent + drift) ----
    clips = []
    truth = {}  # id -> true scene time at clip local t=0 (no drift)

    def add(cid, path, device, t0, **kw):
        clips.append({"id": cid, "path": path, "device": device, **kw})
        truth[cid] = t0

    # Camera A: one long take (reference), Camera B: start/stop clips,
    # Recorder: long drifting file, plus a silent gimbal clip on camera B
    # and an unrelated clip on camera C.
    add("A1", f"{d}/camlong.mp4", "camA", 0.0, isVideo=True)
    for i, (s, ln) in enumerate([(20, 45), (90, 60), (200, 30), (320, 80), (500, 50)]):
        p = f"{d}/camB_{i}.mp4"
        write_cam(p, room(frac_shift(scene, 0.25)[s * SR:(s + ln) * SR], 10))
        add(f"B{i}", p, "camB", s - 0.25 / SR, isVideo=True, timestamp=1.7e9 + s)
    # Silent clip on camera B, recorded at scene time 400 s (timestamp only).
    write_cam(f"{d}/camB_silent.mp4", np.zeros(20 * SR))
    add("Bsilent", f"{d}/camB_silent.mp4", "camB", 400.0, isVideo=True,
        hasAudio=False, duration=20.0, timestamp=1.7e9 + 400)
    add("R1", f"{d}/recdrift.wav", "zoom", 5.0)
    add("X1", f"{d}/other.wav", "camC", None, isVideo=True)
    # A gimbal camera with no audio at all, its clock ~2 s off: placed by
    # timestamp against the other devices' clocks.
    write_cam(f"{d}/gimbal.mp4", np.zeros(15 * SR))
    add("G1", f"{d}/gimbal.mp4", "gimbal", 250.0, isVideo=True, hasAudio=False,
        duration=15.0, timestamp=1.7e9 + 250 + 2.0)

    req = {"clips": clips, "options": {"driftTolerance": 0.002}}
    with open(f"{d}/req.json", "w") as f:
        json.dump(req, f)
    res = engine("analyze", f"{d}/req.json")
    check("analyze/ok", res.get("ok"), res.get("error", ""))
    by = {c["id"]: c for c in res["clips"]}
    a0 = by["A1"]["position"]
    for cid in ["B0", "B1", "B2", "B3", "B4"]:
        c = by[cid]
        rel = c["segments"][0]["position"] - c["segments"][0]["start"] - a0
        err = abs(rel - truth[cid])
        check(f"analyze/{cid}", c["method"] == "audio" and err < 0.0005,
              f"pos {rel:.6f} vs {truth[cid]:.6f} (err {err*1e3:.3f} ms)")

    # Recorder: every segment must be within tolerance at its own middle.
    r = by["R1"]
    worst = 0.0
    for s in r["segments"]:
        mid = 0.5 * (s["start"] + s["end"])
        true_t = 5.0 + mid / (1 + 40e-6)
        placed = s["position"] + (mid - s["start"]) - a0
        worst = max(worst, abs(placed - true_t))
    check("analyze/recorder drift cuts", r["method"] == "audio" and len(r["segments"]) > 1 and worst < 0.001,
          f"{len(r['segments'])} segments, drift {r['driftPpm']:.1f} ppm, worst mid error {worst*1e3:.3f} ms")

    s = by["Bsilent"]
    rel = s["position"] - a0
    check("analyze/silent by timestamp", s["method"] == "timestamp" and abs(rel - 400.0) < 1.0 and s["needsReview"],
          f"pos {rel:.3f} vs 400.0, method {s['method']}")
    g = by["G1"]
    rel = g["position"] - a0
    check("analyze/silent device by timestamp", g["method"] == "timestamp" and abs(rel - 250.0) < 3.0,
          f"pos {rel:.3f} vs 250.0 (clock 2 s off), method {g['method']}")
    check("analyze/unrelated unsynced", by["X1"]["method"] == "none" and by["X1"]["needsReview"],
          f"method {by['X1']['method']}")

    print()
    if failures:
        print(f"{len(failures)} FAILED: {', '.join(failures)}")
        sys.exit(1)
    print("all tests passed")


if __name__ == "__main__":
    main()
