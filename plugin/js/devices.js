// Device and multi-file-recorder detection from file paths.
window.Syncu = window.Syncu || {};

Syncu.devices = (() => {
  const AUDIO_EXT = /\.(wav|bwf|mp3|aif|aiff|m4a|flac|ogg)$/i;

  // Card/folder names cameras create that say nothing about which camera it is.
  const GENERIC_DIR = /^(clip|clips|private|m4root|dcim|\d{3}[a-z_]*|avchd|bdmv|stream|xdroot|card\s*\d*|contents|video|videos|audio|sub|footage|media|raw|mp4|mov)$/i;

  // Multi-file recorder takes: ZOOM0001_Tr1.WAV, 230101_0001_TrLR.wav,
  // TASCAM_0001S12.wav, Take1_1.wav, etc. Returns the take stem or null.
  const TRACK_SUFFIX = [
    /^(.*?)[_-](?:tr|track|ch|mic)[ _-]?(?:\d{1,2}|lr|ms|l|r|[a-z])$/i,
    /^(.*?)[_-]?(?:lr|ms)$/i,
    /^(tascam_\d{4})[sm]\d{1,3}$/i,
    /^(.*?)_(\d{1,2})$/,
  ];

  function splitPath(p) {
    return p.split(/[\\/]/).filter(Boolean);
  }

  function baseName(p) {
    const parts = splitPath(p);
    return parts[parts.length - 1] || p;
  }

  function stem(p) {
    return baseName(p).replace(/\.[^.]+$/, "");
  }

  function isAudioFile(p) {
    return AUDIO_EXT.test(p);
  }

  // The first meaningful folder above the file, e.g. ".../Cam A/Card 2/PRIVATE/M4ROOT/CLIP/C0001.MP4" -> "Cam A/Card 2".
  function folderDevice(p) {
    const parts = splitPath(p).slice(0, -1);
    while (parts.length && GENERIC_DIR.test(parts[parts.length - 1])) parts.pop();
    // Card folders are per-card, not per-camera: drop a trailing "Card 2"-style
    // folder only if something meaningful sits above it.
    if (parts.length > 1 && /^(card|roll|reel|day)[\s_-]*\d+$/i.test(parts[parts.length - 1])) parts.pop();
    return parts.length ? parts[parts.length - 1] : "Unknown";
  }

  function takeStem(p) {
    const s = stem(p);
    for (const re of TRACK_SUFFIX) {
      const m = s.match(re);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  // clips: [{ id, path, name, bin }]; mode: "bins" | "auto" | "timeline"
  // (timeline clips arrive with device already set). Fills device, group, isVideo.
  function classify(clips, mode) {
    for (const c of clips) {
      c.isVideo = c.isVideo ?? !isAudioFile(c.path);
      if (mode === "bins") c.device = c.device || c.bin || folderDevice(c.path);
      else if (mode === "auto") c.device = folderDevice(c.path);
    }
    // Group multi-file recorder takes only when 2+ audio files in the same
    // device share a stem (so a lone "Interview_1.wav" stays ungrouped).
    const byStem = new Map();
    for (const c of clips) {
      if (c.isVideo) continue;
      const t = takeStem(c.path);
      if (!t) continue;
      const key = c.device + "\u001f" + t.toLowerCase();
      if (!byStem.has(key)) byStem.set(key, []);
      byStem.get(key).push(c);
    }
    for (const [key, members] of byStem) {
      if (members.length < 2) continue;
      for (const c of members) c.group = key.split("\u001f")[1];
    }
    return clips;
  }

  function summarize(clips) {
    const devs = new Map();
    for (const c of clips) {
      if (!devs.has(c.device)) devs.set(c.device, { name: c.device, video: 0, audio: 0, groups: new Set() });
      const d = devs.get(c.device);
      if (c.isVideo) d.video++;
      else d.audio++;
      if (c.group) d.groups.add(c.group);
    }
    return [...devs.values()];
  }

  return { classify, summarize, baseName, isAudioFile, folderDevice, takeStem };
})();
