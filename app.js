// ============================================================================
// Tanpura Engine — Web Audio playback, scheduling, tuning
// ============================================================================

// Sample sets: each recorded set has a native root note + whichever strings
// were actually recorded. "kharaj" and "sa" are present in every set; the
// second string ("jawari" string) varies by set.
const SAMPLE_SETS = {
  "C#3": {
    label: "C#3",
    root: "C#3",
    files: {
      kharaj: "assets/audio/Tanpura_C%233_Kharaj.wav",
      sa: "assets/audio/Tanpura_C%233_Sa.wav",
      pa: "assets/audio/Tanpura_C%233_Pa.wav",
      ni: "assets/audio/Tanpura_C%233_Ni.wav",
    },
  },
  "C#3Alt": {
    label: "C#3 Alt",
    root: "C#3",
    files: {
      kharaj: "assets/audio/Tanpura_C%233Alt_Kharaj.wav",
      sa: "assets/audio/Tanpura_C%233Alt_Sa.wav",
      pa: "assets/audio/Tanpura_C%233Alt_Pa.wav",
    },
  },
  "G#3": {
    label: "G#3",
    root: "G#3",
    files: {
      kharaj: "assets/audio/Tanpura_G%233_Kharaj.wav",
      sa: "assets/audio/Tanpura_G%233_Sa.wav",
    },
    // No Pa (or Ni) was ever recorded at G#3 — the female-register anchor
    // only has Kharaj/Sa. Without this, every sruthi from F3 upward (the
    // whole G#3 side of the register split) silently lost the Pa option,
    // and Ma along with it, since Ma is itself derived from Pa. Derive a
    // G#3 Pa from C#3's real Pa recording, pitched up 7 semitones
    // (C#3 -> G#3 = +7), using the exact same duration-preserving
    // resample+WSOLA pitch shift already used below to derive Ma from Pa.
    derivePa: { fromSet: "C#3", semitones: 7 },
  },
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function noteToMidi(note) {
  // note like "C#3"
  const m = note.match(/^([A-G]#?)(-?\d+)$/);
  const name = m[1];
  const octave = parseInt(m[2], 10);
  return NOTE_NAMES.indexOf(name) + (octave + 1) * 12;
}

function midiToNote(midi) {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return { name, octave, label: `${name}${octave}` };
}

// Reference range: A2 to E4 (1.5 octaves). Samples are rooted at C#3/G#3,
// so pushing far beyond this starts to sound stretched/artificial.
const MIN_KEY_MIDI = noteToMidi("A2");
const MAX_KEY_MIDI = noteToMidi("E4");

// ----------------------------------------------------------------------------
// Register/anchor selection.
//
// Every sample set is rooted at one recorded note ("C#3" for C#3 and
// C#3Alt, "G#3" for G#3). Rather than stretching one fixed set across the
// whole 1.5-octave range, group the sets by root and, for any selected
// key, use whichever root is nearest — exactly the "minimize |semitone
// distance| to the nearest recorded anchor" logic real multi-sample
// tanpura apps use. With two anchors 7 semitones apart (C#3=49, G#3=56)
// this puts the crossover at the exact mid-octave point: MIDI 52/53,
// i.e. the boundary between E3 and F3.
// ----------------------------------------------------------------------------
function buildAnchorRoots() {
  const byRoot = new Map();
  Object.entries(SAMPLE_SETS).forEach(([key, set]) => {
    if (!byRoot.has(set.root)) byRoot.set(set.root, []);
    byRoot.get(set.root).push(key);
  });
  return [...byRoot.entries()].map(([root, keys]) => ({
    root,
    midi: noteToMidi(root),
    keys, // sample-set keys that share this root
  }));
}
const ANCHOR_ROOTS = buildAnchorRoots();

// The "alt" recordings are a male voicing of the instrument vs. the
// default female voicing (not to be confused with the C#3/G#3 register
// split, which is a separate male/female pitch-anchor distinction) and
// only exist for one anchor group right now — whichever group has
// more than one recorded key. Figure out which key is "base" and which
// is "alt" from that group so a single global toggle can drive both
// voices at once, regardless of which register they're currently in.
const ALT_GROUP = ANCHOR_ROOTS.find((a) => a.keys.length > 1);
const ALT_BASE_KEY = ALT_GROUP ? ALT_GROUP.keys.find((k) => !k.endsWith("Alt")) : null;
const ALT_ALT_KEY = ALT_GROUP ? ALT_GROUP.keys.find((k) => k.endsWith("Alt")) : null;

// Picks the anchor (root note) whose MIDI value is closest to `midi`.
// Ties fall to whichever anchor appears first (lower root), matching the
// PDF's documented E3/F3 boundary rather than F3/F#3.
function nearestAnchor(midi) {
  let best = ANCHOR_ROOTS[0];
  let bestDist = Infinity;
  for (const a of ANCHOR_ROOTS) {
    const d = Math.abs(midi - a.midi);
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  return best;
}

// Traditional 6-beat plucking cycle:
//   Beat 1: first string (Pa/Ma/Ni)
//   Beat 2: rest — lets Beat 1's upper partials bloom before the next strike
//   Beat 3: Sa — struck once, then held through Beat 4 rather than
//     re-struck. Re-triggering the same sample a beat later reproduced its
//     sharp attack transient twice in quick succession, which read as an
//     extra audible "pluck" rather than a single sustained Sa; letting the
//     one strike ring through both beats (its natural decay is long
//     enough to cover this) sounds like one held note instead.
//   Beat 4: rest — Beat 3's Sa continues ringing through this beat
//   Beat 5: Kharaj (bass)
//   Beat 6: rest — lets the bass string's long decay tail finish
// `null` marks a rest beat: the scheduler still advances the clock for it,
// it just doesn't trigger a sample.
function buildSequence(secondNote) {
  if (secondNote) return [secondNote, null, "sa", null, "kharaj", null];
  return [null, null, "sa", null, "kharaj", null];
}

// ----------------------------------------------------------------------------
// Duration-preserving pitch shift (used to derive Ma from a Pa recording).
//
// Two steps:
//   1. Resample (native playbackRate) — shifts pitch correctly, but changes
//      duration (slower playback = longer, for a downward shift).
//   2. WSOLA time-stretch that resampled result back to the original
//      duration. Plain overlap-add is NOT enough here — on a highly
//      periodic sustained tone like a drone string, unaligned grains
//      cause comb-filtering that audibly distorts the pitch. WSOLA fixes
//      this by searching a small window for the grain position whose
//      waveform best continues the previous grain (highest correlation),
//      keeping the tone's cycles in phase across the splice.
// ----------------------------------------------------------------------------

function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}

function wsolaTimeStretch(channelData, stretchFactor, sampleRate) {
  const frameSize = 4096; // long enough to cover several cycles of a low drone fundamental
  const synthesisHop = 1024; // 75% overlap
  const searchRange = 600; // samples to search around the ideal position for best phase match
  const overlap = frameSize - synthesisHop;

  const inputLen = channelData.length;
  const outputLen = Math.max(1, Math.round(inputLen * stretchFactor));
  const analysisHop = Math.max(1, Math.round(synthesisHop / stretchFactor));
  const window = hannWindow(frameSize);

  const output = new Float32Array(outputLen + frameSize);
  const weight = new Float32Array(outputLen + frameSize);

  let inPos = 0;
  let outPos = 0;
  let prevTail = null; // reference segment the next grain should phase-continue from

  const dot = (a, aStart, b, len) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += a[aStart + i] * b[i];
    return s;
  };
  const norm = (a, aStart, len) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += a[aStart + i] * a[aStart + i];
    return Math.sqrt(s) + 1e-9;
  };

  while (outPos < outputLen && inPos + frameSize <= inputLen) {
    let actualPos = inPos;

    if (prevTail) {
      const lo = Math.max(0, inPos - searchRange);
      const hi = Math.min(inputLen - frameSize, inPos + searchRange);
      let bestScore = -Infinity;
      let bestPos = inPos;
      const refNorm = norm(prevTail, 0, overlap);
      for (let cand = lo; cand <= hi; cand++) {
        const score = dot(channelData, cand, prevTail, overlap) / norm(channelData, cand, overlap) / refNorm;
        if (score > bestScore) {
          bestScore = score;
          bestPos = cand;
        }
      }
      actualPos = bestPos;
    }

    for (let i = 0; i < frameSize; i++) {
      const outIdx = outPos + i;
      const w = window[i];
      output[outIdx] += channelData[actualPos + i] * w;
      weight[outIdx] += w;
    }

    prevTail = channelData.slice(actualPos + synthesisHop, actualPos + synthesisHop + overlap);
    inPos = actualPos + analysisHop;
    outPos += synthesisHop;
  }

  const result = output.slice(0, outputLen);
  for (let i = 0; i < outputLen; i++) {
    if (weight[i] > 1e-6) result[i] /= weight[i];
  }
  return result;
}

// Bakes a playbackRate change into an actual new buffer via an
// OfflineAudioContext, so the result can be cached and reused at rate 1.0.
async function bakeResample(buffer, rate) {
  const outLength = Math.max(1, Math.round(buffer.length / rate));
  const offlineCtx = new OfflineAudioContext(buffer.numberOfChannels, outLength, buffer.sampleRate);
  const src = offlineCtx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  src.connect(offlineCtx.destination);
  src.start(0);
  return offlineCtx.startRendering();
}

async function pitchShiftPreserveDuration(audioCtx, buffer, semitones) {
  const rate = Math.pow(2, semitones / 12);
  // Step 1: shift pitch via resample (changes duration in the process).
  const resampled = await bakeResample(buffer, rate);
  // Step 2: WSOLA-stretch back to the original duration; stretching alone
  // doesn't change pitch, so the pitch set in step 1 is preserved.
  const numChannels = resampled.numberOfChannels;
  const outBuffer = audioCtx.createBuffer(numChannels, buffer.length, buffer.sampleRate);
  for (let ch = 0; ch < numChannels; ch++) {
    const fixed = wsolaTimeStretch(resampled.getChannelData(ch), rate, buffer.sampleRate);
    outBuffer.copyToChannel(fixed.length === buffer.length ? fixed : padOrTrim(fixed, buffer.length), ch);
  }
  return outBuffer;
}

function padOrTrim(arr, targetLength) {
  if (arr.length === targetLength) return arr;
  const out = new Float32Array(targetLength);
  out.set(arr.subarray(0, Math.min(arr.length, targetLength)));
  return out;
}

class SampleLibrary {
  constructor(audioCtx) {
    this.ctx = audioCtx;
    this.cache = new Map(); // url -> AudioBuffer
    this.derivedCache = new Map(); // "url::semitones" -> Promise<AudioBuffer>
    this._fallbackNiPromise = null;
  }

  async load(url) {
    if (this.cache.has(url)) return this.cache.get(url);
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(arr);
    this.cache.set(url, buf);
    return buf;
  }

  // Derives a pitch-shifted, duration-preserved buffer from an already-
  // loaded source buffer, computed once per (source url, semitone shift)
  // and cached for reuse.
  async getPitchShifted(sourceUrl, sourceBuffer, semitones) {
    const key = `${sourceUrl}::${semitones}`;
    if (!this.derivedCache.has(key)) {
      this.derivedCache.set(key, pitchShiftPreserveDuration(this.ctx, sourceBuffer, semitones));
    }
    return this.derivedCache.get(key);
  }

  async loadSet(setKey) {
    const set = SAMPLE_SETS[setKey];
    const entries = Object.entries(set.files);
    const buffers = {};
    await Promise.all(
      entries.map(async ([note, url]) => {
        buffers[note] = await this.load(url);
      })
    );
    return buffers;
  }

  // Every sample set uses the same Ni recording (C#3's) when it wasn't
  // recorded with its own, so every tanpura can offer a Ni option.
  async loadFallbackNi() {
    if (!this._fallbackNiPromise) {
      this._fallbackNiPromise = this.load(SAMPLE_SETS["C#3"].files.ni);
    }
    return this._fallbackNiPromise;
  }

  // Loads every sample set up front and pre-derives every note that
  // requires pitch-shifted synthesis (e.g. Ma from Pa via WSOLA).
  //
  // This matters for the register auto-switch: WSOLA is an O(n) search
  // over a multi-second buffer and is genuinely slow (can be well over
  // 100ms on a long kharaj/sa-length recording). If that computation only
  // ran the first time a register was entered, crossing the E3/F3
  // boundary live would cause an audible stall right as the new sample
  // starts — the exact "delay to show effect" this app is trying to
  // avoid. Running it once here, behind the loading screen, means every
  // set switch during actual play is just swapping references to
  // already-decoded, already-derived buffers — effectively instant.
  // Loads + pre-derives a single sample set. Broken out of prewarmAll()
  // so startup can warm just the one set that's actually about to play
  // (fast) and warm the rest afterward in the background (see init()),
  // instead of blocking the loading screen on every set every time.
  async prewarmSet(key) {
    const set = SAMPLE_SETS[key];
    const buffers = await this.loadSet(key);
    if (buffers.pa) {
      await this.getPitchShifted(set.files.pa, buffers.pa, -2);
    } else if (set.derivePa) {
      // Mirror setSampleSet()'s derivation exactly, including the
      // tagged cache key, so the real call later hits these same
      // cache entries instead of recomputing.
      const sourceSet = SAMPLE_SETS[set.derivePa.fromSet];
      const sourceBuffer = await this.load(sourceSet.files.pa);
      const derivedPa = await this.getPitchShifted(sourceSet.files.pa, sourceBuffer, set.derivePa.semitones);
      await this.getPitchShifted(`${sourceSet.files.pa}#derived-${key}`, derivedPa, -2);
    }
  }

  async prewarmAll() {
    await Promise.all(Object.keys(SAMPLE_SETS).map((key) => this.prewarmSet(key)));
    await this.loadFallbackNi();
  }
}

// How long each pluck's attack is faded in over, in seconds, to round off
// the sharp recorded strike transient. Long enough to be clearly audible
// as "less percussive"; short enough that it doesn't smear the sense of
// individual strings plucking in sequence.
const PLUCK_ATTACK_TIME = 0.035;

// A single tanpura voice: owns its own gain/pan nodes, its own scheduler,
// and knows how to pluck through a 3- or 4- string cycle indefinitely.
class TanpuraVoice {
  constructor(audioCtx, destination, library, id) {
    this.ctx = audioCtx;
    this.library = library;
    this.id = id;

    this.gainNode = audioCtx.createGain();
    this.panNode = audioCtx.createStereoPanner();
    this.gainNode.connect(this.panNode);
    this.panNode.connect(destination);

    this.setNode = "C#3";
    this.buffers = null;
    this.secondNote = "pa"; // 'pa' | 'ni' | null (off)
    this.enabled = false;

    this.volume = 0.8;
    this.pan = 0;
    this.gainNode.gain.value = this.volume;
    this.panNode.pan.value = this.pan;

    // tuning
    this.globalSemitoneShift = 0; // set by the shared key control
    this.globalCents = 0; // set by the shared fine-tune slider

    // tempo: seconds between successive plucks in the cycle (default 105 BPM)
    this.pluckInterval = 60 / 105;
    // "Vary Tempos": small per-pluck timing jitter so two simultaneous
    // tanpuras don't phase-lock into a mechanical, comb-filtered loop.
    this.varyTempo = true;

    // scheduler state
    this._running = false;
    this._nextPluckTime = 0;
    this._seqIndex = 0;
    this._lookahead = 0.1; // seconds, how far ahead we schedule
    this._schedulerTimer = null;
    this._activeSources = [];
    this.onPluck = null; // callback(noteName) for UI pulse
  }

  async setSampleSet(setKey) {
    this.setNode = setKey;
    this.buffers = await this.library.loadSet(setKey);

    // noteSources maps a playable note name -> { buffer, extraSemitones }.
    // "extraSemitones" lets us derive notes we don't have a direct
    // recording for (Ma = the Pa recording, pitched down two semitones).
    const noteSources = {
      kharaj: { buffer: this.buffers.kharaj, extraSemitones: 0 },
      sa: { buffer: this.buffers.sa, extraSemitones: 0 },
    };

    // paBuffer/paUrl feed the Ma-from-Pa derivation just below. Sets that
    // have their own recorded Pa use it directly; sets that don't (G#3)
    // derive one from another set's Pa via derivePa — same pitch-shift
    // method, just at a different (larger) semitone offset than the -2
    // used for Ma.
    let paBuffer = this.buffers.pa;
    let paUrl = SAMPLE_SETS[setKey].files.pa;

    const deriveSpec = SAMPLE_SETS[setKey].derivePa;
    if (!paBuffer && deriveSpec) {
      const sourceSet = SAMPLE_SETS[deriveSpec.fromSet];
      const sourceBuffer = await this.library.load(sourceSet.files.pa);
      paBuffer = await this.library.getPitchShifted(sourceSet.files.pa, sourceBuffer, deriveSpec.semitones);
      // Tag the URL for the Ma derivation below so its cache key doesn't
      // collide with the real "<source pa url>::-2" entry the source set
      // itself uses to derive its own Ma.
      paUrl = `${sourceSet.files.pa}#derived-${setKey}`;
    }

    if (paBuffer) {
      noteSources.pa = { buffer: paBuffer, extraSemitones: 0 };
      const maBuffer = await this.library.getPitchShifted(paUrl, paBuffer, -2);
      noteSources.ma = { buffer: maBuffer, extraSemitones: 0 };
    }
    if (this.buffers.ni) {
      noteSources.ni = { buffer: this.buffers.ni, extraSemitones: 0 };
    } else {
      noteSources.ni = { buffer: await this.library.loadFallbackNi(), extraSemitones: 0 };
    }
    this.noteSources = noteSources;

    // if current secondNote isn't available in the new set, fall back
    if (this.secondNote && !this.noteSources[this.secondNote]) {
      const available = this.availableSecondNotes();
      this.secondNote = available[0] || null;
    }
  }

  availableSecondNotes() {
    if (!this.noteSources) return [];
    return Object.keys(this.noteSources).filter((n) => n !== "kharaj" && n !== "sa");
  }

  setSecondNote(note) {
    // note is null for "just drone, no second string" or a string like 'pa'/'ni'
    this.secondNote = note;
  }

  setVolume(v) {
    this.volume = v;
    this.gainNode.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  setPan(p) {
    this.pan = p;
    this.panNode.pan.setTargetAtTime(p, this.ctx.currentTime, 0.01);
  }

  setTempo(secondsBetweenPlucks) {
    this.pluckInterval = secondsBetweenPlucks;
  }

  setVaryTempo(enabled) {
    this.varyTempo = enabled;
  }

  setTuning(semitoneShift, cents) {
    this.globalSemitoneShift = semitoneShift;
    this.globalCents = cents;
    // Re-apply to every string currently ringing, not just the next pluck —
    // otherwise a slider move can take up to a full sample's decay time
    // (several seconds) to be audible, and different strings would drift
    // in and out of tune with each other as they update one at a time.
    //
    // A previous version used setTargetAtTime(..., 0.01), an exponential
    // approach that only settles after ~5 time constants (~50ms) and never
    // mathematically reaches the target — noticeable as "catch-up lag" when
    // scrubbing the fine-tune slider quickly, especially across several
    // ringing strings at once. Instead: cancel any in-flight ramp, anchor
    // an explicit start value at the AudioParam's *actual current* value
    // (not the old target — otherwise a still-in-flight ramp causes an
    // audible jump), then linearly ramp to the new rate over 4ms. 4ms is
    // short enough to read as instantaneous but long enough that the web
    // audio renderer smooths the transition sample-by-sample instead of
    // stepping it, so there's no click even on repeated rapid slider input.
    const rate = this._playbackRate();
    const now = this.ctx.currentTime;
    this._activeSources.forEach(({ source, extraFactor }) => {
      const target = rate * extraFactor;
      source.playbackRate.cancelScheduledValues(now);
      source.playbackRate.setValueAtTime(source.playbackRate.value, now);
      source.playbackRate.linearRampToValueAtTime(target, now + 0.004);
    });
  }

  _playbackRate() {
    // Combine semitone transposition + fine cents into one rate multiplier.
    const semitoneFactor = Math.pow(2, this.globalSemitoneShift / 12);
    const centsFactor = Math.pow(2, this.globalCents / 1200);
    return semitoneFactor * centsFactor;
  }

  _pluck(noteName, when) {
    const source = this.noteSources && this.noteSources[noteName];
    if (!source) return;
    const src = this.ctx.createBufferSource();
    src.buffer = source.buffer;
    const extraFactor = Math.pow(2, (source.extraSemitones || 0) / 12);
    src.playbackRate.value = this._playbackRate() * extraFactor;

    // Soften the pluck's attack transient. The recorded attack is the
    // sharpest, most percussive instant in the sample — starting playback
    // at full volume reproduces that strike exactly, which is what makes
    // each note read as a distinct "pluck" rather than part of a
    // continuous drone. Fading each note in over PLUCK_ATTACK_TIME rounds
    // that transient off without touching the sustain/decay portion that
    // gives the string its actual tone.
    const envelope = this.ctx.createGain();
    envelope.gain.setValueAtTime(0, when);
    envelope.gain.linearRampToValueAtTime(1, when + PLUCK_ATTACK_TIME);
    src.connect(envelope);
    envelope.connect(this.gainNode);

    src.start(when);
    const entry = { source: src, extraFactor };
    this._activeSources.push(entry);
    src.onended = () => {
      const idx = this._activeSources.indexOf(entry);
      if (idx >= 0) this._activeSources.splice(idx, 1);
    };
    if (this.onPluck) {
      const delayMs = Math.max(0, (when - this.ctx.currentTime) * 1000);
      setTimeout(() => this.onPluck(noteName), delayMs);
    }
  }

  start() {
    if (this._running || !this.noteSources) return;
    this._running = true;
    this._seqIndex = 0;
    this._nextPluckTime = this.ctx.currentTime + 0.05;
    this._tick();
  }

  stop() {
    this._running = false;
    if (this._schedulerTimer) clearTimeout(this._schedulerTimer);
    this._schedulerTimer = null;
    // let currently-sounding plucks ring out naturally; just stop scheduling new ones
  }

  _tick() {
    if (!this._running) return;
    const sequence = buildSequence(this.secondNote && this.noteSources[this.secondNote] ? this.secondNote : null);

    while (this._nextPluckTime < this.ctx.currentTime + this._lookahead) {
      const note = sequence[this._seqIndex % sequence.length];
      if (note) this._pluck(note, this._nextPluckTime);
      const jitter = this.varyTempo ? 1 + (Math.random() * 2 - 1) * 0.045 : 1;
      this._nextPluckTime += this.pluckInterval * jitter;
      this._seqIndex++;
    }
    this._schedulerTimer = setTimeout(() => this._tick(), 25);
  }
}

// ============================================================================
// App wiring
// ============================================================================

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioCtx.createGain();
masterGain.gain.value = 0.9;
masterGain.connect(audioCtx.destination);

const library = new SampleLibrary(audioCtx);

const voice1 = new TanpuraVoice(audioCtx, masterGain, library, 1);
const voice2 = new TanpuraVoice(audioCtx, masterGain, library, 2);

// Shared tonic/key state
let baseMidi = noteToMidi("C#3"); // the displayed reference key
let fineCents = 0;
let altVoice = false; // global "alt tanpura" toggle — same wav variant for both voices

// Panels whose second-string selection was restored from last session as
// "was playing" get queued here rather than started immediately, since
// Web Audio can't produce sound until the first user gesture resumes the
// AudioContext (see resumeOnce below). Populated by setupPanel().
const pendingAutoStart = [];

// Each voice tracks which sample set the user *prefers* (chosen via the
// dropdown, e.g. "C#3" vs "C#3 Alt") independently of which set is
// actually sounding right now. The active set is decided automatically
// from the current key: whichever recorded anchor (C#3-family or G#3) is
// nearest wins, exactly mirroring the male/female register-switch logic
// described for real tanpura apps — see nearestAnchor() above. This
// replaces the old approach of stretching one fixed set up to 6
// semitones in either direction, which is both further from the source
// recording (more artifacts) and never actually changes which file is
// playing no matter how far the key moves.
async function applyTuningToVoices() {
  await Promise.all(
    [voice1, voice2].map(async (voice) => {
      const anchor = nearestAnchor(baseMidi);
      const desiredKey = anchor.keys.includes(voice.preferredSetKey)
        ? voice.preferredSetKey
        : anchor.keys[0];

      if (voice.setNode !== desiredKey) {
        // Buffers were prewarmed at startup, so this resolves on the next
        // microtask (cache hit) rather than waiting on a fetch/decode —
        // the register change is audible on the very next scheduled pluck.
        await voice.setSampleSet(desiredKey);
        if (voice.panel) renderNoteButtons(voice.panel, voice);
      }

      const shift = baseMidi - anchor.midi;
      voice.setTuning(shift, fineCents);

      if (voice.panel) updateActiveSampleReadout(voice.panel, voice, anchor);
    })
  );
}

function updateActiveSampleReadout(panel, voice, anchor) {
  if (!panel.activeSample) return;
  const registerLabel = anchor.root === "G#3" ? "female register" : "male register";
  const isAuto = voice.setNode !== voice.preferredSetKey;
  panel.activeSample.textContent = isAuto
    ? `auto → ${voice.setNode} · ${registerLabel}`
    : `${voice.setNode} · ${registerLabel}`;
}

// ----- UI wiring -----

// ----------------------------------------------------------------------------
// Settings persistence — remembers key, tuning, tempo, alt-voice, and each
// panel's volume/pan/second-string/playing state across app restarts.
// Electron's renderer keeps its own localStorage under the app's user-data
// directory, so this survives closing and reopening the app.
// ----------------------------------------------------------------------------
const SETTINGS_KEY = "tanpura.settings.v1";

function currentSettings() {
  return {
    baseMidi,
    fineCents,
    tempoBpm: parseFloat(els.tempo.value),
    varyTempo: els.varyTempo.checked,
    altVoice,
    panels: [voice1, voice2].map((voice) => ({
      volume: voice.volume,
      pan: voice.pan,
      secondNote: voice.secondNote,
      playing: voice.panel ? voice.panel.root.classList.contains("is-playing") : false,
    })),
  };
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings()));
  } catch (err) {
    // Storage can fail (disabled, quota, etc.) — losing "remember last
    // settings" isn't worth breaking playback over, so just ignore it.
    console.warn("Could not save settings:", err);
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn("Could not load saved settings:", err);
    return null;
  }
}

const els = {
  keyDisplayNote: document.getElementById("keyNote"),
  keyDisplayOct: document.getElementById("keyOct"),
  keyUp: document.getElementById("keyUp"),
  keyDown: document.getElementById("keyDown"),
  fineTune: document.getElementById("fineTune"),
  fineTuneLabel: document.getElementById("fineTuneLabel"),
  varyTempo: document.getElementById("varyTempo"),
  altVoice: document.getElementById("altVoice"),
  tempo: document.getElementById("tempo"),
  tempoLabel: document.getElementById("tempoLabel"),
  panels: [1, 2].map((n) => ({
    root: document.getElementById(`tanpura${n}`),
    activeSample: document.getElementById(`activeSample${n}`),
    noteButtons: document.getElementById(`notes${n}`),
    volume: document.getElementById(`vol${n}`),
    pan: document.getElementById(`pan${n}`),
    strings: document.getElementById(`strings${n}`),
  })),
};

function updateKeyDisplay() {
  const { name, octave } = midiToNote(baseMidi);
  els.keyDisplayNote.textContent = name;
  els.keyDisplayOct.textContent = octave;
  els.keyUp.disabled = baseMidi >= MAX_KEY_MIDI;
  els.keyDown.disabled = baseMidi <= MIN_KEY_MIDI;
}

els.keyUp.addEventListener("click", () => {
  if (baseMidi >= MAX_KEY_MIDI) return;
  baseMidi += 1;
  updateKeyDisplay();
  void applyTuningToVoices();
  saveSettings();
});
els.keyDown.addEventListener("click", () => {
  if (baseMidi <= MIN_KEY_MIDI) return;
  baseMidi -= 1;
  updateKeyDisplay();
  void applyTuningToVoices();
  saveSettings();
});
els.fineTune.addEventListener("input", (e) => {
  // slider -50..50 maps directly to cents. Fine-tuning never crosses a
  // register boundary on its own (±50 cents is under a semitone), so this
  // call always resolves synchronously in practice — no set switch, just
  // an instant playbackRate ramp via setTuning().
  fineCents = parseFloat(e.target.value);
  void applyTuningToVoices();
  updateFineTuneReadout();
  saveSettings();
});
els.tempo.addEventListener("input", (e) => {
  const bpm = parseFloat(e.target.value);
  const secondsPerPluck = 60 / bpm;
  voice1.setTempo(secondsPerPluck);
  voice2.setTempo(secondsPerPluck);
  els.tempoLabel.textContent = `${bpm}`;
  saveSettings();
});

// Single toggle for both tanpuras' wav variant — the "Alt" recordings are
// a different voicing of the instrument (alt = male voice, base =
// female voice), independent of the C#3/G#3 key-register split. Swapping
// preferredSetKey and re-running applyTuningToVoices() is
// enough: both sets were prewarmed, so this takes effect click-free on
// the next scheduled pluck, same as a register auto-switch.
els.altVoice.addEventListener("change", async (e) => {
  altVoice = e.target.checked;
  if (ALT_BASE_KEY && ALT_ALT_KEY) {
    const key = altVoice ? ALT_ALT_KEY : ALT_BASE_KEY;
    voice1.preferredSetKey = key;
    voice2.preferredSetKey = key;
    await applyTuningToVoices();
  }
  saveSettings();
});

function updateFineTuneReadout() {
  const semitoneValue = fineCents / 100;
  const sign = semitoneValue > 0 ? "+" : semitoneValue < 0 ? "" : "±";
  els.fineTuneLabel.textContent = `${sign}${semitoneValue.toFixed(2)}`;
  els.fineTuneLabel.classList.remove(
    "tune-readout--centered",
    "tune-readout--flat",
    "tune-readout--sharp"
  );
  if (fineCents === 0) els.fineTuneLabel.classList.add("tune-readout--centered");
  else if (fineCents < 0) els.fineTuneLabel.classList.add("tune-readout--flat");
  else els.fineTuneLabel.classList.add("tune-readout--sharp");
}

els.varyTempo.addEventListener("change", (e) => {
  voice1.setVaryTempo(e.target.checked);
  voice2.setVaryTempo(e.target.checked);
  saveSettings();
});

const NOTE_LABELS = { pa: "Pa", ni: "Ni", ma: "Ma" };

async function setupPanel(panel, voice, defaultSet, saved) {
  voice.panel = panel;
  // Which variant (base vs. "Alt") this voice prefers is now driven by
  // the single global "alt tanpura" toggle rather than a per-panel
  // dropdown — see the els.altVoice change listener above.
  // applyTuningToVoices() still decides the actually-sounding set based
  // on the current register.
  voice.preferredSetKey =
    ALT_BASE_KEY && ALT_ALT_KEY ? (altVoice ? ALT_ALT_KEY : ALT_BASE_KEY) : defaultSet;

  if (saved && typeof saved.volume === "number") {
    voice.volume = saved.volume;
    panel.volume.value = String(saved.volume);
  }
  if (saved && typeof saved.pan === "number") {
    voice.pan = saved.pan;
    panel.pan.value = String(saved.pan);
  }

  await voice.setSampleSet(defaultSet);
  voice.setVolume(voice.volume);
  voice.setPan(voice.pan);
  await applyTuningToVoices();

  // Restore which second string was selected. This only sets the voice's
  // state and highlights the right button — it does NOT start playback,
  // since Web Audio can't produce sound until the first user gesture
  // resumes the AudioContext. init() queues these panels to actually
  // start as soon as that first click/tap happens.
  if (saved && saved.secondNote && voice.noteSources && voice.noteSources[saved.secondNote]) {
    voice.setSecondNote(saved.secondNote);
    if (saved.playing) {
      setPanelPlayingState(panel, true);
      pendingAutoStart.push({ panel, voice });
    }
  }
  renderNoteButtons(panel, voice);

  panel.volume.addEventListener("input", (e) => {
    voice.setVolume(parseFloat(e.target.value));
    saveSettings();
  });
  panel.pan.addEventListener("input", (e) => {
    voice.setPan(parseFloat(e.target.value));
    saveSettings();
  });

  voice.onPluck = (noteName) => pulseString(panel, noteName);
}

function renderNoteButtons(panel, voice) {
  panel.noteButtons.innerHTML = "";
  const buttons = {}; // 'off' | note name -> button element

  const makeButton = (label, value, isOff) => {
    const btn = document.createElement("button");
    btn.className = "note-btn" + (isOff ? " note-btn--off" : "");
    btn.textContent = label;
    btn.dataset.value = value === null ? "off" : value;
    btn.addEventListener("click", () => {
      [...panel.noteButtons.children].forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      if (value === null) {
        voice.stop();
        setPanelPlayingState(panel, false);
      } else {
        voice.setSecondNote(value);
        if (!panel.root.classList.contains("is-playing")) {
          voice.start();
          setPanelPlayingState(panel, true);
        }
      }
      saveSettings();
    });
    buttons[value === null ? "off" : value] = btn;
    return btn;
  };

  const offBtn = makeButton("Off", null, true);
  panel.noteButtons.appendChild(offBtn);

  voice.availableSecondNotes().forEach((note) => {
    const label = NOTE_LABELS[note] || note;
    panel.noteButtons.appendChild(makeButton(label, note, false));
  });

  // This re-runs whenever the register auto-switches mid-play (e.g.
  // crossing the E3/F3 boundary while a note is ringing), and the voice
  // keeps playing straight through that switch — it never actually
  // stopped. Reflect that here instead of unconditionally re-highlighting
  // "Off", which made a live register change look like playback had been
  // silently turned off.
  const activeKey =
    panel.root.classList.contains("is-playing") && voice.secondNote && buttons[voice.secondNote]
      ? voice.secondNote
      : "off";
  buttons[activeKey].classList.add("active");
}

function setPanelPlayingState(panel, playing) {
  panel.root.classList.toggle("is-playing", playing);
}

function pulseString(panel, noteName) {
  const selector =
    noteName === "kharaj" || noteName === "sa"
      ? `[data-string="${noteName}"]`
      : `[data-string="second"]`; // pa, ma, ni all live on the "2nd string" row

  const matches = panel.strings.querySelectorAll(selector);
  if (!matches.length) return;

  // the two Sa rows should alternate rather than both flash at once
  panel._pulseCounters = panel._pulseCounters || {};
  const idx = (panel._pulseCounters[selector] || 0) % matches.length;
  panel._pulseCounters[selector] = idx + 1;

  const el = matches[idx];
  el.classList.remove("pulse");
  // force reflow so the animation can retrigger
  void el.offsetWidth;
  el.classList.add("pulse");
}

async function init() {
  const saved = loadSettings();
  if (saved) {
    if (typeof saved.baseMidi === "number") {
      baseMidi = Math.min(MAX_KEY_MIDI, Math.max(MIN_KEY_MIDI, saved.baseMidi));
    }
    if (typeof saved.fineCents === "number") fineCents = saved.fineCents;
    if (typeof saved.tempoBpm === "number") {
      els.tempo.value = String(saved.tempoBpm);
      els.tempoLabel.textContent = `${saved.tempoBpm}`;
    }
    if (typeof saved.varyTempo === "boolean") els.varyTempo.checked = saved.varyTempo;
    if (typeof saved.altVoice === "boolean" && ALT_ALT_KEY) altVoice = saved.altVoice;
  }
  els.fineTune.value = String(fineCents);
  els.altVoice.checked = altVoice;
  voice1.setTempo(60 / parseFloat(els.tempo.value));
  voice2.setTempo(60 / parseFloat(els.tempo.value));
  voice1.setVaryTempo(els.varyTempo.checked);
  voice2.setVaryTempo(els.varyTempo.checked);

  updateKeyDisplay();
  updateFineTuneReadout();

  // Only load + pre-derive the ONE sample set that's actually about to
  // play (whichever register the restored/default key lands in), plus
  // the small fallback-Ni file. That's the real bottleneck behind the
  // old startup time — deriving Ma (and, for G#3, Pa too) via WSOLA is
  // genuinely slow, and doing it for all three sets up front meant the
  // loading screen sat there for every one of them even though only one
  // is needed to start making sound. The rest warm quietly in the
  // background right after (see below) so register/alt switches are
  // still instant later — this just stops making the user wait for
  // sample sets they may never touch.
  const anchor = nearestAnchor(baseMidi);
  const initialKey =
    ALT_ALT_KEY && anchor.keys.includes(altVoice ? ALT_ALT_KEY : ALT_BASE_KEY)
      ? altVoice ? ALT_ALT_KEY : ALT_BASE_KEY
      : anchor.keys[0];
  await library.prewarmSet(initialKey);
  await library.loadFallbackNi();

  const savedPanels = Array.isArray(saved && saved.panels) ? saved.panels : [null, null];
  await Promise.all([
    setupPanel(els.panels[0], voice1, initialKey, savedPanels[0]),
    setupPanel(els.panels[1], voice2, initialKey, savedPanels[1]),
  ]);

  document.getElementById("loading").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");

  // Warm the remaining sample sets in the background, without blocking
  // the UI — already-warmed entries (initialKey, fallback Ni) are cached
  // and skipped, so this only does the actual remaining work.
  library.prewarmAll().catch((err) => console.warn("Background prewarm failed:", err));
}

window.addEventListener("beforeunload", () => saveSettings());

document.addEventListener("DOMContentLoaded", () => {
  // Web Audio requires a user gesture to resume in most browsers.
  const resumeOnce = () => {
    if (audioCtx.state === "suspended") audioCtx.resume();
    // Panels restored as "was playing" from last session couldn't
    // actually start any earlier than this — there's no sound until the
    // AudioContext resumes. Kick them off now, right on the gesture that
    // unlocks audio, so playback resumes as soon as possible.
    pendingAutoStart.splice(0).forEach(({ voice }) => voice.start());
    document.removeEventListener("click", resumeOnce);
  };
  document.addEventListener("click", resumeOnce);
  init();
});
