# Tanpura

A two-voice tanpura drone player using your own recorded samples
(C#3, C#3 Alt, G#3 — Kharaj, Sa, Pa, Ni).

## Try it instantly (no install)
Just double-click `index.html`, or run a tiny local server and open it —
either works, but a local server avoids browser file:// restrictions:

```
npx serve .
```
then open the printed http://localhost:... address. Click anywhere once
(browsers require a click before audio can play), then pick a note on
either Tanpura panel to start it.

## Run as a desktop app (development)
Requires Node.js (get it from nodejs.org if you don't have it).

```
npm install
npm start
```
This opens the app in its own window instead of a browser tab.

## Build a real .exe / .dmg / AppImage
```
npm install
npm run dist
```
This uses electron-builder to produce installers in `dist/`:
- Windows: `dist/Tanpura Setup 1.0.0.exe`
- Mac: `dist/Tanpura-1.0.0.dmg`
- Linux: `dist/Tanpura-1.0.0.AppImage`

Notes:
- Building a **Windows .exe works natively if you run this on Windows**.
  Building it from Mac/Linux is possible but needs Wine installed; it's
  usually easier to just build on a Windows machine, or use a free CI
  service (e.g. GitHub Actions with `electron-builder` — ask me if you
  want a ready-made workflow file for this).
- No code signing is set up, so Windows SmartScreen / Mac Gatekeeper may
  warn on first launch ("unknown publisher") — that's expected for an
  unsigned personal app; users can click through it.

## How the tuning works
- The **+/− buttons** transpose the reference key semitone by semitone.
- The **flat/sharp slider** fine-tunes ±50 cents on top of that.
- Both controls work by adjusting the playback speed of the recorded
  samples, applied live to whatever is currently ringing via a 4ms
  linear ramp on the AudioParam — not a full sample restart — so a
  slider move or key change is audible essentially instantly, with no
  click and no "catch-up" lag.
- **Automatic register switching:** the app is rooted at two recorded
  anchors, C#3 (male register) and G#3 (female register), 7 semitones
  apart. Rather than stretching one fixed sample across the whole
  1.5-octave range, each voice automatically plays from whichever
  anchor is nearest to the selected key — the crossover sits at the
  exact midpoint, the boundary between E3 and F3. This keeps every key
  within about 4 semitones of a real recording instead of up to 6+.
  The **set dropdown** only lets you choose which male-register
  variant (C#3 vs C#3 Alt) is preferred; G#3 is used automatically
  whenever the key crosses into the female register, and a small label
  under the dropdown shows which sample is actually sounding. All
  sample sets (and the WSOLA-derived Ma) are pre-loaded at startup, so
  crossing that boundary during play doesn't stall to decode or
  compute anything — it's just a reference swap.

## Adding more sample sets or keys later
Add entries to the `SAMPLE_SETS` object at the top of `app.js`, pointing
at new .wav files dropped into `assets/audio/`. The UI will pick them up
automatically (note-selector buttons and second-string options are
generated from whatever's present in each set).
