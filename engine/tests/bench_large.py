#!/usr/bin/env python3
"""Large-shoot benchmark: 1 h drifting recorder + 4 cameras x 40 start/stop
clips. Reports analysis time and checks every clip's sync against the truth.

    SYNCU_ENGINE=build/syncu-engine python3 tests/bench_large.py [media-dir]
"""
import json
import os
import subprocess
import sys
import tempfile
import time

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from run_tests import SR, speechlike, room, resample_drift, write_wav, rng  # noqa: E402

ENGINE = os.environ.get("SYNCU_ENGINE", "build/syncu-engine")


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="syncu-bench-")
    os.makedirs(d, exist_ok=True)
    print("media in", d)
    if os.path.exists(f"{d}/truth.json"):
        with open(f"{d}/truth.json") as f:
            saved = json.load(f)
        clips, truth = saved["clips"], saved["truth"]
        print("reusing media")
    else:
        clips, truth = generate(d)
        with open(f"{d}/truth.json", "w") as f:
            json.dump({"clips": clips, "truth": truth}, f)
    run(d, clips, truth)


def generate(d):
    t0 = time.time()
    scene = speechlike(3700)
    write_wav(f"{d}/rec.wav", room(resample_drift(scene[10 * SR: 3610 * SR], 30.0), 30, reverb=False))
    clips = [{"id": "rec", "path": f"{d}/rec.wav", "device": "rec"}]
    truth = {}
    for cam in range(4):
        t = rng.uniform(15, 40)
        for k in range(40):
            ln = rng.uniform(20, 70)
            if t + ln > 3600:
                break
            cid = f"cam{cam}_{k:02d}"
            write_wav(f"{d}/{cid}.wav", room(scene[int(t * SR): int((t + ln) * SR)], rng.uniform(6, 18)))
            clips.append({"id": cid, "path": f"{d}/{cid}.wav", "device": f"cam{cam}", "isVideo": True})
            truth[cid] = t
            t += ln + rng.uniform(5, 40)
    print(f"generated {len(clips)} files in {time.time() - t0:.0f} s")
    return clips, truth


def run(d, clips, truth):
    with open(f"{d}/req.json", "w") as f:
        json.dump({"clips": clips}, f)
    t0 = time.time()
    r = subprocess.run([ENGINE, "analyze", f"{d}/req.json"], capture_output=True, text=True, check=True)
    elapsed = time.time() - t0
    res = json.loads(r.stdout)
    by = {c["id"]: c for c in res["clips"]}
    # Camera clips have no drift; compare relative to the first synced camera clip.
    ref = next(k for k in truth if by[k]["method"] == "audio")
    errs, missing = [], []
    for k, t in truth.items():
        c = by[k]
        if c["method"] != "audio":
            missing.append(k)
            continue
        errs.append(abs((c["position"] - by[ref]["position"]) - (t - truth[ref])))
    rec = by["rec"]
    print(f"analysis: {elapsed:.1f} s for {len(clips)} clips; scenes {res['components']}")
    print(f"cameras synced {len(errs)}/{len(truth)}; worst error {max(errs) * 1000:.3f} ms; "
          f"recorder drift {rec['driftPpm']:.2f} ppm (true -30), {len(rec['segments'])} pieces")
    ok = not missing and max(errs) < 0.001 and abs(rec["driftPpm"] + 30) < 1.0 and res["components"] == 1
    print("PASS" if ok else f"FAIL (unsynced: {missing[:5]})")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
