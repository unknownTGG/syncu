#!/usr/bin/env python3
"""Hard-case benchmark modelled on an outdoor shoot: a close recorder per
take, and two distant cameras whose audio is quiet (about -50 dBFS), late by
the sound's travel time, reverberant, AAC-compressed and buried in wind
rumble. Plus unrelated camera clips that must not be matched to anything.

    SYNCU_ENGINE=build/syncu-engine python3 tests/farm_eval.py [media-dir]

"In sync" means the camera's waveform lines up with the recorder's, which
is what an editor checks on the timeline (so the acoustic delay is part of
the truth).
"""
import json
import os
import subprocess
import sys
import tempfile
import time

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from run_tests import SR, speechlike, write_wav, frac_shift, rng  # noqa: E402

ENGINE = os.environ.get("SYNCU_ENGINE", "build/syncu-engine")


def far_mic(x, delay_s, level_db, wind_db):
    """What a distant camera mic hears."""
    n = len(x)
    # Reverb: direct sound plus an exponentially decaying diffuse tail.
    ir_len = int(0.6 * SR)
    t = np.arange(ir_len) / SR
    tail = rng.standard_normal(ir_len) * np.exp(-6.9 * t / 0.5) * 0.08
    tail[: int(0.003 * SR)] = 0
    ir = tail
    ir[0] = 1.0
    N = 1 << (n + ir_len).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, N) * np.fft.rfft(ir, N), N)[:n]
    y = frac_shift(y, delay_s * SR)
    y *= 10 ** (level_db / 20) / (np.sqrt(np.mean(y ** 2)) + 1e-12)
    # Wind: strong low-frequency rumble with gusts.
    w = np.cumsum(rng.standard_normal(n))
    w -= np.convolve(w, np.ones(4801) / 4801, mode="same")
    # Gusts: a smooth random level curve (no steps, which would be clicks
    # at the same spots in every file).
    knots = 0.4 + np.abs(rng.standard_normal(n // SR + 2))
    w *= np.interp(np.arange(n) / SR, np.arange(len(knots)), knots)
    w *= 10 ** ((level_db + wind_db) / 20) / (np.sqrt(np.mean(w ** 2)) + 1e-12)
    hiss = rng.standard_normal(n) * 10 ** ((level_db - 18) / 20)
    return y + w + hiss


def with_pauses(x):
    """Real takes are lines separated by pauses and action: gate speech
    into 3-12 s bursts with 2-10 s gaps of nothing but ambience."""
    g = np.zeros(len(x))
    t = int(rng.uniform(0, 3) * SR)
    while t < len(x):
        ln = int(rng.uniform(3, 12) * SR)
        g[t: t + ln] = 1.0
        t += ln + int(rng.uniform(2, 10) * SR)
    ramp = np.hanning(int(0.1 * SR))
    g = np.convolve(g, ramp / ramp.sum(), mode="same")
    return x * g


def write_aac(path, x):
    wav = path + ".wav"
    write_wav(wav, x)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav, "-c:a", "aac", "-b:a", "128k", path], check=True)
    os.remove(wav)


def generate(d):
    clips, truth = [], {}
    for s in range(14):
        ln = rng.uniform(60, 180)
        src = with_pauses(speechlike(ln + 20))
        rec = src[10 * SR: int((10 + ln) * SR)]
        rid = f"rec{s:02d}"
        write_wav(f"{d}/{rid}.wav", rec + rng.standard_normal(len(rec)) * 0.002)
        clips.append({"id": rid, "path": f"{d}/{rid}.wav", "device": "rec"})
        for cam in ("fuji", "sony"):
            if cam == "sony" and rng.uniform() < 0.3:
                continue
            start = rng.uniform(-6, 15)       # camera start vs recorder, s
            end = ln - rng.uniform(-6, 15)
            delay = rng.uniform(0.004, 0.025)  # 1.4 m .. 8.5 m away
            a, b = int((10 + start) * SR), int((10 + end) * SR)
            x = far_mic(src[max(0, a): min(len(src), b)], delay, rng.uniform(-58, -46), rng.uniform(-3, 6))
            cid = f"{cam}{s:02d}"
            write_aac(f"{d}/{cid}.m4a", x)
            clips.append({"id": cid, "path": f"{d}/{cid}.m4a", "device": cam, "isVideo": True})
            truth[cid] = {"scene": rid, "rel": max(a, 0) / SR - 10 - delay}
    for k in range(16):  # B-roll / other takes with no matching recording
        x = far_mic(with_pauses(speechlike(rng.uniform(20, 90))), 0.01, rng.uniform(-58, -46), rng.uniform(-3, 6))
        cid = f"broll{k:02d}"
        write_aac(f"{d}/{cid}.m4a", x)
        clips.append({"id": cid, "path": f"{d}/{cid}.m4a", "device": "fuji" if k % 2 else "sony", "isVideo": True})
        truth[cid] = None
    return clips, truth


def run(d, clips, truth):
    with open(f"{d}/req.json", "w") as f:
        json.dump({"clips": clips}, f)
    t0 = time.time()
    r = subprocess.run([ENGINE, "analyze", f"{d}/req.json"], capture_output=True, text=True, check=True)
    elapsed = time.time() - t0
    by = {c["id"]: c for c in json.loads(r.stdout)["clips"]}
    errs, missed, wrong, false_pos = [], [], [], []
    for cid, t in truth.items():
        c = by[cid]
        if t is None:
            if c["method"] == "audio":
                false_pos.append(cid)
            continue
        rc = by[t["scene"]]
        if c["method"] != "audio" or rc["method"] != "audio" or c["component"] != rc["component"]:
            missed.append(cid)
            continue
        e = abs((c["position"] - rc["position"]) - t["rel"])
        (errs if e < 0.5 else wrong).append(e if e < 0.5 else cid)
    errs = np.array(errs) * 1000
    print(f"analysis {elapsed:.1f} s; cameras in sync {len(errs)}/{sum(t is not None for t in truth.values())}, "
          f"missed {len(missed)}, wrong place {len(wrong)}, b-roll falsely matched {len(false_pos)}")
    if len(errs):
        print(f"error ms: median {np.median(errs):.2f}, 90% {np.percentile(errs, 90):.2f}, worst {errs.max():.2f}")
    return len(wrong) == 0 and len(false_pos) == 0 and len(errs) and errs.max() < 3.0


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="syncu-farm-")
    os.makedirs(d, exist_ok=True)
    if os.path.exists(f"{d}/truth.json"):
        with open(f"{d}/truth.json") as f:
            saved = json.load(f)
        clips, truth = saved["clips"], saved["truth"]
    else:
        clips, truth = generate(d)
        with open(f"{d}/truth.json", "w") as f:
            json.dump({"clips": clips, "truth": truth}, f)
    print("media in", d)
    ok = run(d, clips, truth)
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
