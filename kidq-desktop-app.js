(() => {
  "use strict";

  /* =====================================================================
     KidQData — THE BACKEND INTEGRATION POINT.
     Everything below this object only reads from it. To integrate a real
     backend, replace this literal with API responses of the same shape
     (and re-run prepSession(profileId) whenever the data changes).
     ===================================================================== */
  const KidQData = {
    profiles: [
      { id: "aarav", name: "Aarav", color: "#1F7A6D", face: "#FAF4E8" },
      { id: "meera", name: "Meera", face: "#2E2A24", color: "#C9B8E8" }
    ],
    // today's parent-picked session per profile; null = no session yet
    sessions: {
      // 30 minutes with 2 breaks, as locked. Four videos rather than three so the
      // breaks (which snap to the nearest video boundary at the 1/3 and 2/3 marks)
      // land after videos 1 and 3 — leaving the 2 -> 3 gap unbroken, which is where
      // autoplay is visible. With three equal videos every gap holds a break and
      // autoplay never gets a chance to show itself.
      aarav: {
        totalMinutes: 30,
        // One family account, so attribution is a household label on the session,
        // not a field on each video. Onboarding stores a single parent name per
        // family with no notion of who added a given item, so a per-video picker
        // would be inventing data the API cannot back.
        pickedBy: "Mumma & Papa",
        videos: [
          { id: "v1", title: "The Bunny Wakes Up", minutes: 8,
            src: "proposal-src/clip-b.mp4", poster: "proposal-src/thumb-b.jpg" },
          { id: "v2", title: "Butterfly in the Meadow", minutes: 7,
            src: "proposal-src/clip-a.mp4", poster: "proposal-src/thumb-a.jpg" },
          { id: "v3", title: "A Nap in the Sunshine", minutes: 8,
            src: "proposal-src/clip-a.mp4", poster: "proposal-src/thumb-a.jpg" },
          { id: "v4", title: "Bunny's Big Adventure", minutes: 7,
            src: "proposal-src/clip-b.mp4", poster: "proposal-src/thumb-b.jpg" }
        ]
      },
      meera: null
    },
    // yesterday's session (per profile) — powers the no-session replay path
    yesterdays: {
      meera: {
        totalMinutes: 17,
        replay: true,
        pickedBy: "Mumma & Papa",
        videos: [
          { id: "y1", title: "The Bunny Wakes Up", minutes: 8,
            src: "proposal-src/clip-b.mp4", poster: "proposal-src/thumb-b.jpg" },
          { id: "y2", title: "Butterfly in the Meadow", minutes: 9,
            src: "proposal-src/clip-a.mp4", poster: "proposal-src/thumb-a.jpg" }
        ]
      }
    },
    // parent-set "what's next" cards for the all-done screen
    whatsNext: [
      { label: "Play outside", scene: "kite", picked: false },
      { label: "Homework", scene: "book", picked: false },
      { label: "Sleep time", scene: "moon", picked: true, pickedBy: "Mumma & Papa" }
    ]
  };
  /* ===================== end backend integration point ================= */

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const video = $("#watch-video");
  const jingle = $("#jingle");
  const chime = $("#chime");

  let timers = [];
  let reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Stands in for the KidQ Parent app's per-family "Autoplay" toggle ("Play the
  // next video automatically within a session"). Default ON, matching today's
  // shipped behaviour exactly - flipping it off must change nothing about the
  // ON path (item 40). Session-level like reducedMotion above: a plain
  // variable, not part of `state`, so switching profiles or restarting the
  // demo flow does not reset it.
  let autoplay = true;
  // Stands in for the KidQ Parent app's per-family break-type setting
  // (Movement / Quiet-calm / Let KidQ alternate). Session-level source of
  // truth: state.session.breakType, defaulted in prepSession's projection
  // below. prepSession reinitialises this live variable from that field
  // every time a session starts, read fresh at gameForBreak() fire time (see
  // bucketForBreak below) — breakType only decides which bucket a break
  // draws from, never where breaks land.
  let breakType = "alternate";
  function setBreakType(v) {
    breakType = v;
  }
  // Stands in for the KidQ Parent app's family-wide "Sensory-friendly mode"
  // setting ("softer sounds, calmer visuals, fewer transitions" - parent-app
  // cross-check, PARENT-KID-CONTRADICTIONS item 7 / OPEN-ITEMS item 42). One
  // flag, two effects: forces reduce-motion on (already delivers "calmer
  // visuals, fewer transitions" - see setReducedMotion/setSensoryFriendly
  // below, defined together since the coupling needs followScreen) and drops
  // every audio element this file plays to SENSORY_VOLUME. Never to 0 -
  // softer, never silent - the audio carries meaning (e.g. the autoplay-off
  // nudge chime, item 40, is how a pre-reader knows it's their move).
  // Session-config field like breakType above: prepSession() seeds this live
  // flag from state.session.sensoryFriendly every time a session starts,
  // through setSensoryFriendly.
  let sensoryFriendly = false;
  // Softer, never silent. A starting point, not a tuned value - real number
  // wants testing against real families (PARENT-KID-CONTRADICTIONS item 7).
  // Scope: only audio the app itself produces as sound design - jingle,
  // chime, spoken instructions (say/sayLine) and the follow-break's
  // synthesized catch sound (plip). `video` is deliberately untouched: it is
  // permanently `video.muted = true` (startWatching) - the demo clips carry
  // no needed audio, so there is nothing there for this flag to soften.
  const SENSORY_VOLUME = 0.4;
  // The reduce-motion value that was live the moment sensory-friendly last
  // forced it on - restored when sensory-friendly turns off, so releasing the
  // force never stomps a reduce-motion the user chose independently before
  // the force (see setSensoryFriendly below). OS-level
  // prefers-reduced-motion (reducedMotion's own startup default, above) still
  // governs the baseline either way; this only remembers what to snap back to.
  let preSensoryMotion = false;
  const later = (fn, ms) => { const id = setTimeout(fn, reducedMotion ? Math.min(ms, 200) : ms); timers.push(id); return id; };
  // Phase timing for activity breaks. Unlike later(), this does NOT clamp under
  // reduced motion: a 1.5s hold in a break is the activity itself, not a
  // transition, and crushing it to 200ms would run the whole break in ~1.6s.
  // Still pushed into `timers`, so clearTimers() and showScreen() cancel it.
  const hold = (fn, ms) => { const id = setTimeout(fn, ms); timers.push(id); return id; };
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
  // Volume is set here, at play time, not once at load - so toggling
  // sensory-friendly mid-session applies to the very next sound, not the
  // next page load. Explicit 1 when off (not just "leave it alone") is what
  // restores full volume after the flag is turned back off.
  const safePlay = (m) => { if (!m) return; m.currentTime = 0; m.volume = sensoryFriendly ? SENSORY_VOLUME : 1; m.play().catch(() => {}); };
  const attemptPlay = (m) => { m.play().catch(() => { later(() => m.play().catch(() => {}), 200); }); };

  /* ---------- spoken instructions ----------
     A child aged 0-6 cannot read "Find 3 red things!". On that break the colour
     swatches carry the instruction visually, which leaves a child who is also
     low-vision or colour-blind with no instruction at all, so the breaks say
     their instruction out loud.

     speechSynthesis - the device's own voice - is the MVP choice: no assets to
     record, no files to ship, and it speaks whatever copy the break happens to
     carry, including a colour name chosen at runtime. The trade is that warmth
     and accent vary by device and are outside our control, and some platforms
     fetch voices from the network. Recorded voice in Indian English is the
     post-MVP upgrade, not a blocker.

     Speech is an enhancement throughout: if it is unavailable, blocked, or
     throws, every break still works exactly as before. */
  const speech = window.speechSynthesis || null;
  let voicePick = null;
  function pickVoice() {
    if (!speech) return null;
    const vs = speech.getVoices() || [];
    return vs.find((v) => v.lang === "en-IN")
        || vs.find((v) => v.lang && v.lang.startsWith("en"))
        || vs[0] || null;
  }
  if (speech && "onvoiceschanged" in speech) {
    speech.onvoiceschanged = () => { voicePick = pickVoice(); };
  }
  function say(text) {
    if (!speech) return;
    try {
      speech.cancel();
      const u = new SpeechSynthesisUtterance(text);
      voicePick = voicePick || pickVoice();
      if (voicePick) u.voice = voicePick;
      u.rate = 0.9;   // unhurried, to match the pace of everything else here
      u.pitch = 1.05; // a touch warm, well short of chirpy
      u.volume = sensoryFriendly ? SENSORY_VOLUME : 1; // sensory-friendly (item 42): same constant as every other audio path
      speech.speak(u);
    } catch (e) { /* never let a missing voice break a break */ }
  }
  /* Recorded lines (spec 13.5): a bundled clip is the same warm voice on every
     device - including TVs, whose web engines generally ship NO speechSynthesis
     voice - so the recording is the primary and the device TTS the fallback,
     not the other way around. Any failure falls back: missing file (play()
     rejects), blocked autoplay, or a throw. Fallback fires once. */
  let speakingClip = null;
  function sayLine(clip, text) {
    if (!clip) { say(text); return; }
    let fellBack = false;
    const fallBack = () => { if (!fellBack) { fellBack = true; say(text); } };
    try {
      clip.currentTime = 0;
      clip.volume = sensoryFriendly ? SENSORY_VOLUME : 1; // set at play time, same reasoning as safePlay above
      speakingClip = clip;
      const p = clip.play();
      if (p && p.catch) p.catch(fallBack);
    } catch (e) { fallBack(); }
  }

  function hush() {
    try { if (speech) speech.cancel(); } catch (e) {}
    if (speakingClip) {
      try { speakingClip.pause(); speakingClip.currentTime = 0; } catch (e) {}
      speakingClip = null;
    }
  }

  function showScreen(id) {
    clearTimers();
    hush(); // a line must never carry over into the next screen
    $$(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
  }
  function pop(el, wobble) {
    const cls = wobble ? "moontap" : "tapped";
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    later(() => el.classList.remove(cls), 950);
  }

  // Break-count digit balloon (shared, brand.md §5; user request 2026-09-15):
  // cycles four hues once per digit change - teal -> rose -> coral -> dusk
  // -> repeat. Three match the splash's own K/d/Q letters; rose replaces
  // gold in the "i" slot (2026-09-15, user-directed) since gold measured
  // 1.32-1.43:1 against this app's sky, failing the 3:1 floor outright -
  // see kidq-desktop-app.css above .kq-digitballoon.hue-rose for the full
  // measurement. Shared by tree (5-wide, wraps once per hold) and count
  // (10-wide, wraps twice). One helper, called from both screens' own
  // setXCount functions, so the cycle itself can never drift between them.
  const BALLOON_HUES = ["teal", "rose", "coral", "dusk"];
  function setBalloonHue(el, i) {
    el.classList.remove(...BALLOON_HUES.map((h) => `hue-${h}`));
    el.classList.add(`hue-${BALLOON_HUES[i % BALLOON_HUES.length]}`);
  }

  /* ---------- session state (derived from KidQData only) ---------- */
  // progress: per-video furthest-watched fraction (0..1) — keeps the sun's
  // place when the child switches videos mid-way; watched = fully finished
  const state = { profile: null, session: null, watched: new Set(), progress: {}, current: null,
                  breaks: [], breaksTaken: 0 };

  /* ---------- activity breaks ----------
     Break count and positions are config-driven (KidQ Parent app: break
     interval every 10/15/20 min), each landing on the nearest video boundary
     (never mid-video). Fewer videos means fewer places a break can sit: 2
     videos have only one boundary, 1 video has none.
     Break-type config (Movement / Quiet-calm / Let KidQ alternate) decides
     which bucket each break draws from — see bucketForBreak below. Under the
     default "alternate" setting this reproduces the original arc: early
     breaks draw from MOVE (child is still fresh), later ones from SETTLE (the
     day is winding down) — the same arc the sun itself travels.            */
  const BREAK_GAMES = {
    move:   ["find", "tree"],
    settle: ["breathe", "follow", "count", "flower_candle"]
  };

  // Returns the planned break points as fractions of the session's total
  // minutes, for a given break interval (parent-configured: 10/15/20 min).
  // Boundary i sits after video i, so i runs 1..n-1. Working in fractions (not
  // video indices) keeps breaks correct when the child switches videos from the
  // session strip — the day's progress is what decides, not the running order.
  //
  // Targets are k * interval / total for every k with k * interval < total —
  // interval-many minutes in, twice that, and so on, up to but not reaching
  // the end of the queue. Each target snaps to the nearest not-yet-used video
  // boundary, under two constraints (Opus review 2026-09-15 — unbounded
  // snapping mis-places breaks on lopsided queues, e.g. a 20+1+9-min queue at
  // every-10m put breaks at minutes 20 and 21):
  //   - max snap distance: a target whose nearest remaining boundary is more
  //     than half an interval away is dropped, not snapped.
  //   - min gap: a boundary within half an interval of an already-chosen
  //     break is not eligible for a later target.
  // Ties (a boundary exactly as close to a target as another) keep the
  // earlier boundary: the `<` below is strict, and bounds are walked in
  // increasing order, so the first (smaller) one found wins.
  //
  // Consequences, both intentional: break count is capped by boundary count
  // (n-1 for n videos) and by the constraints above, so a config that asks
  // for more breaks than fit gets fewer — matches the parent app's own
  // hedged copy ("About one break every N minutes"); and a session shorter
  // than one interval produces zero targets, so zero breaks
  // (state.breaks = []) — downstream code already handles that.
  function planBreaks(videos, intervalMinutes) {
    if (videos.length < 2) return [];
    const total = videos.reduce((s, v) => s + v.minutes, 0);
    if (!total) return [];
    let cum = 0;
    const bounds = [];
    for (let i = 0; i < videos.length - 1; i++) {
      cum += videos[i].minutes;
      bounds.push(cum / total);
    }
    const halfInterval = (intervalMinutes / 2) / total;
    const picked = [];
    for (let k = 1; k * intervalMinutes < total; k++) {
      const target = (k * intervalMinutes) / total;
      let best = null;
      bounds.forEach((b) => {
        if (picked.includes(b)) return;
        if (picked.some((p) => Math.abs(b - p) <= halfInterval)) return; // min gap
        if (best === null || Math.abs(b - target) < Math.abs(best - target)) best = b;
      });
      if (best !== null && Math.abs(best - target) <= halfInterval) picked.push(best); // max snap distance
    }
    return picked.sort((a, b) => a - b);
  }

  // Rotate within each bucket so consecutive breaks drawing from the same
  // bucket don't repeat immediately, and consecutive sessions differ (no
  // immediate repeat — with more breaks than bucket entries, a bucket does
  // eventually repeat within a session; the old "never twice in a session"
  // claim stops being true once break count can exceed two). Rotation is
  // per-load; a real build would seed this from the child's recent history.
  // *12, not *6 (spec 2026-09-16 kidq-flower-candle-break-design.md, Opus
  // finding 3; math corrected in a later diff review — see below): 6 was
  // the LCM of the old bucket sizes (move:2, settle:3); settle is now 4, so
  // the seed range must be a common multiple of 2 and 4 — 12 = LCM(2,3,4),
  // which also stays valid if a bucket returns to 3 entries. Left at 6,
  // `0..5 mod 4` would give breathe/follow double the pick frequency of
  // count/flower_candle — this keeps every settle entry equally likely
  // across a full rotation cycle.
  let breakRotation = Math.floor(Math.random() * 12);

  // Which bucket break `index` draws from, honouring the live breakType flag.
  function bucketForBreak(index) {
    if (breakType === "movement") return "move";
    if (breakType === "quiet") return "settle";
    // alternate (default): the PLANNED fraction decides (state.breaks[index]),
    // not sessionProgress() at fire time — a strip-switching child can fire a
    // break late, and the planned slot is the contract. <= 0.5, not <: the
    // default every-15m session yields exactly one break at fraction 0.5000,
    // and it must stay the movement break, matching today's original
    // "first break is always find" behaviour.
    return state.breaks[index] <= 0.5 ? "move" : "settle";
  }
  function gameForBreak(index) {
    const bucket = BREAK_GAMES[bucketForBreak(index)];
    return bucket[(breakRotation + index) % bucket.length];
  }

  function prepSession(profileId, sessionOverride) {
    state.profile = KidQData.profiles.find((p) => p.id === profileId) || KidQData.profiles[0];
    const src = sessionOverride || KidQData.sessions[state.profile.id];
    state.session = src ? {
      totalMinutes: src.totalMinutes,
      replay: !!src.replay,
      videos: [...src.videos],
      // Parent-configured break settings. prepSession PROJECTS the session
      // object — a field not listed here is silently dropped (as pickedBy
      // already was, above) — so these get their defaults applied right
      // here, once, rather than at every read site.
      breakEveryMinutes: src.breakEveryMinutes ?? 15,
      breakType: src.breakType ?? "alternate",
      // The parent app's family-wide Sensory-friendly setting (item 42).
      sensoryFriendly: src.sensoryFriendly ?? false
    } : null;
    state.watched = new Set();
    state.progress = {};
    state.current = null;
    // Interval is read once, here, at planning time.
    state.breaks = state.session ? planBreaks(state.session.videos, state.session.breakEveryMinutes) : [];
    state.breaksTaken = 0;
    // Seeds the live breakType flag (declared near `autoplay` above) from this
    // session's own config, through setBreakType(). breakType itself is read
    // live at gameForBreak() fire time, not captured here — this line only
    // sets its starting value.
    setBreakType(state.session ? state.session.breakType : "alternate");
    // Seeds the live sensoryFriendly flag the same way, through
    // setSensoryFriendly() (defined below, since it composes with the
    // reduce-motion coupling).
    setSensoryFriendly(state.session ? state.session.sensoryFriendly : false);
    return !!state.session;
  }

  // The household label for whoever picked the session. One family account, so
  // it is the same everywhere it appears rather than varying per video.
  //
  // "Mumma & Papa" is a fixed string for the MVP, decided rather than pending:
  // it is not derived from the family's parent_name and the parent cannot set
  // it. The cost is that it is wrong for households it does not describe - a
  // single parent, grandparents raising a child, or a family who say Amma and
  // Appa. Making it settable is a post-MVP change and needs nothing from the
  // API that is not already there.
  const pickerName = () => (state.session && state.session.pickedBy) || "Mumma & Papa";
  const pickerNameHtml = () => pickerName().replace(/&/g, "&amp;");
  const totalVideos = () => state.session.videos.length;
  const unwatched = () => state.session.videos.filter((v) => !state.watched.has(v.id));
  // the sun moves on the parents' allotted time: each video contributes its
  // minutes weighted by how much of it has actually been watched, so
  // switching videos mid-way never resets or rewinds the day
  function sessionProgress() {
    let mins = 0, total = 0;
    state.session.videos.forEach((v) => {
      total += v.minutes;
      mins += v.minutes * (state.watched.has(v.id) ? 1 : (state.progress[v.id] || 0));
    });
    return total ? Math.min(1, mins / total) : 0;
  }
  function minutesLeft(p) {
    return Math.max(1, Math.ceil(state.session.totalMinutes * (1 - p)));
  }

  /* ---------- sun-on-arc positioning (Q bezier of the arc svg) ---------- */
  function positionSun(el, p) {
    // History: t=0.06 overlapped the horizon line (since removed); a fix
    // targeting the line alone (0.37/0.26) turned out to still overlap the
    // video player's own top edge and had nearly flattened the sun's rise
    // to midday; 0.25/0.50 fixed both against the wide tier's then-92px
    // sun and 150px arc. Retuned again for the wide tier's shallower arc
    // (150px->80px) and smaller sun (92px->44px, kidq-desktop-app.css
    // #screen-watching.wide block) - matching KidQ's own deployed
    // early-access build, which uses a shallow arc + small sun that barely
    // competes with the player for height. 0.22/0.56 clears the smaller
    // sun against the shorter arc with margin, keeps the p=0.5 midday peak
    // exactly where it was (0.22 and 1-0.22 stay symmetric around 0.5,
    // same as every version before this), and recovers most of the
    // horizontal sweep (~53% of the sky's width, not ~28%).
    const t = 0.22 + p * 0.56;
    const bx = (1 - t) * (1 - t) * 30 + 2 * (1 - t) * t * 500 + t * t * 970;
    const by = (1 - t) * (1 - t) * 215 + 2 * (1 - t) * t * 5 + t * t * 215;
    el.style.left = (bx / 1000 * 100) + "%";
    el.style.top = (by / 220 * 100) + "%";
  }

  /* ---------- splash ---------- */
  const splash = $("#screen-splash");
  function startSplash() {
    splash.classList.remove("go", "off");
    showScreen("screen-splash");
    void splash.offsetWidth;
    splash.classList.add("go");
    safePlay(jingle);
    // That safePlay() above is a best-effort, not a guarantee. startSplash()
    // runs at the bottom of this file on load, before anyone has touched
    // anything, and every modern browser's autoplay policy blocks
    // HTMLMediaElement.play() with sound until the document has had at least
    // one real user gesture - play() rejects with NotAllowedError ("play()
    // failed because the user didn't interact with the document first").
    // safePlay swallows that rejection by design, so on a fresh profile with
    // no engagement history the splash jingle is simply silent. No code can
    // override that policy; the most we can do is take the first gesture we
    // are given and spend it on the jingle. Hence this one-shot listener:
    // `capture` so a handler further down the tree can't stop it reaching us,
    // `once` so it unregisters itself after the first tap and never leaks.
    //
    // Both guards matter. The splash is only ~2.4s long, so by the time a
    // child taps, the app has usually moved on to login or further - firing a
    // stale jingle over a later screen would read as a new bug, not a fix, so
    // we re-check that the splash is still the active screen using the same
    // classList.contains("active") idiom the rest of this file uses for
    // "is screen X still showing". And on a browser that DID have engagement
    // history, the load-time safePlay already worked, so restarting from 0
    // here would double-play or yank already-playing audio back to the top.
    // `paused && !currentTime` is exactly "never actually started": a jingle
    // that is mid-play isn't paused, and one that played through has a
    // non-zero currentTime, so neither gets clobbered. No extra flag needed -
    // the element's own state already says it.
    document.addEventListener("click", () => {
      if (!splash.classList.contains("active")) return;
      if (!jingle || !jingle.paused || jingle.currentTime) return;
      safePlay(jingle);
    }, { once: true, capture: true });
    later(() => splash.classList.add("off"), 2000);
    later(startLogin, 2400);
  }

  /* ---------- login (who's watching) ---------- */
  const whoRow = $("#who-row");
  function faceSvg(profile) {
    return `<svg viewBox="0 0 64 64" aria-hidden="true">
      <circle class="avdisc" cx="32" cy="32" r="30" fill="${profile.color}"/>
      <circle cx="25.5" cy="29" r="2.4" fill="${profile.face}"/><circle cx="38.5" cy="29" r="2.4" fill="${profile.face}"/>
      <path d="M24.5 37 Q32 43 39.5 37" fill="none" stroke="${profile.face}" stroke-width="2.6" stroke-linecap="round"/>
    </svg>`;
  }
  function startLogin() {
    whoRow.innerHTML = "";
    KidQData.profiles.forEach((p) => {
      const btn = document.createElement("button");
      btn.className = "kq-who";
      btn.setAttribute("aria-label", `${p.name} — touch to start your day`);
      btn.innerHTML = `<span class="facewrap"><span class="halo"></span>${faceSvg(p)}</span><span class="name">${p.name}</span>`;
      btn.addEventListener("click", () => {
        pop(btn);
        safePlay(jingle);
        const has = prepSession(p.id);
        later(() => (has ? startSunrise() : startNoSession()), 650);
      });
      whoRow.appendChild(btn);
    });
    showScreen("screen-login");
  }

  /* ---------- sunrise ---------- */
  const sunrise = $("#screen-sunrise");
  const startSun = $("#start-sun");
  function startSunrise() {
    sunrise.classList.remove("risen", "tapped");
    $("#screen-all-done").classList.remove("hifived");
    $("#whatsnext").classList.remove("in", "choose");
    $("#sunrise-greet").innerHTML = `Hi,<br>${state.profile.name}!`;
    const s = state.session;
    $("#sunrise-heartline").innerHTML = s.replay
      ? `<b>Yesterday's videos, one more time</b> · ${s.totalMinutes} min`
      : `<b>${pickerNameHtml()} picked ${s.videos.length} videos</b> · ${s.totalMinutes} min`;
    showScreen("screen-sunrise");
  }
  startSun.addEventListener("click", () => {
    if (sunrise.classList.contains("risen")) return;
    safePlay(jingle);
    sunrise.classList.add("tapped");
    later(() => sunrise.classList.add("risen"), 420);
    later(() => startWatching(unwatched()[0]), 1650);
  });

  /* ---------- watching ---------- */
  const watching = $("#screen-watching");
  const watchSunEl = $("#watch-sun");
  const watchPause = $("#watch-pause");

  // True only while the pause is the child's own tap, never while it's the
  // browser's. Chrome silently pauses a video-only background tab to save
  // power (~5s after it's hidden) with no error the app can catch - just a
  // real `pause` event it used to ignore, leaving the UI stuck claiming
  // "playing" over a frozen frame. That policy can't be prevented from here,
  // so the fix is to listen honestly (below) and recover on return to the
  // tab - but only when userPaused is false, so a browser-imposed recovery
  // can never talk over a pause the child actually chose.
  let userPaused = false;

  // the whole parent-picked session, always visible: Now playing ringed,
  // watched dimmed, and every card tappable to switch
  function renderStrip() {
    $("#watch-strip-label").textContent = state.session.replay
      ? "Yesterday's picks" : `${pickerName()}'s picks`;
    const row = $("#watch-queue");
    row.innerHTML = "";
    state.session.videos.forEach((v) => {
      const wrap = document.createElement("div");
      wrap.className = "kq-pickwrap";
      const btn = document.createElement("button");
      const isNow = v === state.current;
      btn.className = "kq-qcard kq-stripcard" + (isNow ? " now" : "") +
        (!isNow && state.watched.has(v.id) ? " watched" : "");
      btn.innerHTML = `<img src="${v.poster}" alt="">`;
      btn.setAttribute("aria-label", isNow ? `Now playing: ${v.title}` : `Play ${v.title}`);
      if (!isNow) btn.addEventListener("click", () => { safePlay(jingle); startWatching(v); });
      const lab = document.createElement("p");
      lab.className = "kq-qname" + (isNow ? " nowlab" : "");
      lab.textContent = isNow ? "Now playing" : v.title;
      wrap.append(btn, lab);
      row.appendChild(wrap);
    });
  }

  function updateSky() {
    const p = sessionProgress();
    positionSun(watchSunEl, p);
    $("#watch-veil").style.width = ((1 - p) * 100) + "%";
    $("#watch-knob").style.left = (p * 100) + "%";
    $("#watch-time").textContent = minutesLeft(p) + " min left";
    // sky colour follows the day: coral dawn -> radiant noon -> orange ember (brand sky stages)
    $("#watch-dawn").style.opacity = (Math.max(0, 1 - p / 0.3) * 0.65).toFixed(3);
    $("#watch-ember").style.opacity = (Math.max(0, Math.min(1, (p - 0.62) / 0.3)) * 0.6).toFixed(3);
    // bell-curve ray strength: gentle at the edges of the day, radiant at noon
    watchSunEl.querySelector(".rays").style.opacity = (0.35 + 0.5 * Math.sin(Math.PI * p)).toFixed(3);
  }

  function startWatching(videoObj) {
    state.current = videoObj;
    userPaused = false; // a new video never starts in a stale user-paused state
    watching.classList.remove("paused", "setting", "swapping");
    watchPause.setAttribute("aria-label", "Pause");
    $("#watch-av").textContent = state.profile.name[0];
    $("#watch-av").style.background = state.profile.color;
    $("#watch-name").textContent = `${state.profile.name}'s watch time`;
    $("#watch-count").textContent = `video ${state.session.videos.indexOf(videoObj) + 1} of ${totalVideos()}`;
    $("#watch-title").textContent = videoObj.title;
    $("#watch-picker").innerHTML = `<b>Picked by ${pickerNameHtml()}</b> · ${videoObj.minutes} min`;
    renderStrip();
    video.src = videoObj.src;
    video.poster = videoObj.poster;
    video.muted = true; // demo clips carry no needed audio; jingle/chime are the sound design
    video.currentTime = 0;
    attemptPlay(video);
    updateSky();
    showScreen("screen-watching");
  }

  video.addEventListener("timeupdate", () => {
    if (!watching.classList.contains("active") || !state.session) return;
    const frac = video.duration ? video.currentTime / video.duration : 0;
    // rewatching an already-finished video does not advance the day
    if (state.current && !state.watched.has(state.current.id)) {
      state.progress[state.current.id] = Math.max(state.progress[state.current.id] || 0, frac);
    }
    updateSky();
  });

  video.addEventListener("ended", () => {
    if (!watching.classList.contains("active")) return; // stray ended after a demo jump
    state.watched.add(state.current.id);
    renderStrip();
    if (unwatched().length === 0) startSunset(false);
    else if (breakIsDue()) startPlaytimeSeam();
    else if (autoplay) autoAdvance();
    // Autoplay off (item 40): no auto dip - land on the same choice screen a
    // break sends the child to, sun plus the remaining parent picks, and let
    // startChoice() decide there's no CHOICE_AUTO_MS timer to schedule.
    else startChoice();
  });

  // Keep the UI honest about the video's real state, whatever caused the
  // change - the browser's background-pause policy, or the click handler
  // below. Screen jumps and the swapping dip already pause/play the video
  // for their own reasons, so
  // these only act while watching is actually on screen; the same guard
  // ended() already uses. The click handler sets the same class/aria-label
  // itself, so these fire redundantly on that path - idempotent, not a
  // double-toggle.
  video.addEventListener("pause", () => {
    if (!watching.classList.contains("active")) return;
    if (video.ended) return; // a native pause fires right before ended too
    watching.classList.add("paused");
    watchPause.setAttribute("aria-label", "Resume");
  });
  video.addEventListener("play", () => {
    if (!watching.classList.contains("active")) return;
    watching.classList.remove("paused");
    watchPause.setAttribute("aria-label", "Pause");
  });

  // A break is due when the day has passed the next planned break point and the
  // child hasn't taken it yet. Breaks themselves never advance the sun.
  function breakIsDue() {
    if (state.breaksTaken >= state.breaks.length) return false;
    return sessionProgress() >= state.breaks[state.breaksTaken] - 0.001;
  }

  // The parent's picks play through on their own: one video rolls into the next
  // after a short dip, with no tap. This is not feed autoplay - the list is
  // finite, parent-chosen, and still ends at sunset. This is the AUTOPLAY-ON
  // path only (the `ended` handler above only calls this when `autoplay` is
  // true) - it is exactly today's shipped behaviour and item 40 must not
  // change a byte of it.
  //
  // Breaks used to be the exception here too: the choice screen after a break
  // (startChoice, below) waited indefinitely for a tap. Item 25 gave it its own
  // self-advance (CHOICE_AUTO_MS, in startChoice) so a child who doesn't
  // realise it's their move - or, on a cast TV, whose device isn't even in the
  // room - isn't stranded there either; that's now built, not just decided.
  // Item 40 makes CHOICE_AUTO_MS itself conditional on this same `autoplay`
  // flag: off, the choice screen nudges instead of timing out (see
  // scheduleNudge near startChoice). A tap still wins the instant it lands,
  // on every path: it picks the video, and picking a card picks a different
  // one.
  //
  // No jingle here: the jingle marks a child's choice, and this isn't one. If the
  // child taps a different card during the dip, their startWatching clears this
  // pending timer via showScreen, so their pick wins.
  function autoAdvance() {
    const next = unwatched()[0];
    watching.classList.add("swapping");
    later(() => startWatching(next), 700);
  }

  $("#watch-expand").addEventListener("click", (e) => {
    const wide = watching.classList.toggle("wide");
    e.currentTarget.setAttribute("aria-label", wide ? "Make the video smaller" : "Make the video bigger");
  });

  watchPause.addEventListener("click", () => {
    const pausing = !watching.classList.contains("paused");
    userPaused = pausing;
    watching.classList.toggle("paused", pausing);
    watchPause.setAttribute("aria-label", pausing ? "Resume" : "Pause");
    if (pausing) video.pause(); else attemptPlay(video);
  });

  // Recover from the browser's own background pause the moment the tab is
  // back in view - never from a pause the child chose (userPaused wins), and
  // never from a video that's already ended: autoAdvance's swapping dip holds
  // watching active for ~700ms with the old video paused-and-ended before the
  // src swap lands, and attemptPlay on an ended video would seek to 0 and
  // replay it for a split second. That case belongs to the ended flow, not
  // to this recovery.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!watching.classList.contains("active")) return;
    if (video.paused && !video.ended && !userPaused) attemptPlay(video);
  });

  /* ---------- sunset → all done ---------- */
  // afterBreak: startChoice's empty-queue shortcut lands here immediately
  // after a break's own ending (a chime for find/follow, a spoken line for
  // breathing) - chiming again here restarted the same <audio> element mid-
  // playback, or landed right on top of breathing's voice line (final review
  // M6). The plain end-of-session path (video `ended` with nothing left) is
  // the only place nothing has sounded yet, so it's the only path that chimes.
  function startSunset(afterBreak) {
    watching.classList.add("setting");
    if (!afterBreak) safePlay(chime);
    later(startAllDone, 1500);
  }

  /* ---------- playtime seam + activity breaks ---------- */
  // A ternary only ever reaches two games. Every new break must land here or it
  // silently runs breathing. startFlowerCandle is declared as a hoisted
  // function (below), not a const arrow (spec 2026-09-16 kidq-flower-candle-
  // break-design.md, Opus finding 14) - this literal runs before every
  // break's own function is declared further down the file, and only
  // survives because function declarations hoist.
  const BREAK_START = { find: startFind, breathe: startBreathing, follow: startFollow, tree: startTree, count: startCount, flower_candle: startFlowerCandle };

  // forceGame: the manual test hook (console-callable, e.g.
  // startPlaytimeSeam("flower_candle")) - kept and documented rather than
  // deleted (spec 2026-09-16 kidq-flower-candle-break-design.md §7) since
  // PR #36 removed the demo bar's own Break: jump buttons and the shipped
  // demo data cannot reach every bucket organically; cheapest permanent
  // verify path for every future break too.
  function startPlaytimeSeam(forceGame) {
    video.pause();
    showScreen("screen-playtime");
    const game = forceGame || gameForBreak(state.breaksTaken);
    if (!forceGame) state.breaksTaken += 1;
    // hold(), not later(): spec §9.2 wants this seam felt as a pause, not
    // skipped, even under reduced motion. Deliberate, not a regression - it
    // grew breathe/find's reduced-motion seam from later()'s 200ms cap to the
    // full 1600ms (final review M8), called out here since nothing else in
    // the diff said so.
    hold(() => (BREAK_START[game] || startBreathing)(), 1600);
  }

  /* --- SETTLE: breathe with the sun (sourced Lottie character) --- */
  const breathing = $("#screen-breathing");
  const breathHeadline = $("#breath-headline");
  const breathDots = $$("#breath-dots i");

  // The asset's sun contracts to frame 60 and expands back by 119, so the two
  // halves of its loop are the two halves of a breath.
  let brAnim = null;
  const BR_MID = 60, BR_END = 119;
  function initBreathe() {
    if (brAnim || !window.lottie || !window.KIDQ_BREATHE_ANIM) return;
    breathing.classList.add("lottie-on");
    brAnim = lottie.loadAnimation({ container: $("#breathe-lottie"), renderer: "svg",
      loop: false, autoplay: false, animationData: window.KIDQ_BREATHE_ANIM });
  }

  function startBreathing() {
    showScreen("screen-breathing");
    // Only the opening line is spoken. The sun's own swell and shrink is the
    // guide from there, and narrating all six half-breaths would talk over the
    // quiet this break exists to create.
    later(() => say("Three big slow breaths with the sun."), 600);
    initBreathe();
    breathing.classList.remove("ph-in", "ph-out", "celebrate");
    breathDots.forEach((d) => d.classList.remove("on"));
    const PHASE = 3200; // one half-breath, matched to the asset's own pacing
    let round = 0;
    function inhale() {
      breathing.classList.remove("ph-out");
      breathing.classList.add("ph-in");
      breathHeadline.textContent = "Breathe in…";
      if (brAnim && !reducedMotion) brAnim.playSegments([[BR_MID, BR_END]], true);
      else if (brAnim) brAnim.goToAndStop(BR_END, true);
      later(exhale, PHASE);
    }
    function exhale() {
      breathing.classList.remove("ph-in");
      breathing.classList.add("ph-out");
      breathHeadline.textContent = "Breathe out…";
      if (brAnim && !reducedMotion) brAnim.playSegments([[0, BR_MID]], true);
      else if (brAnim) brAnim.goToAndStop(BR_MID, true);
      later(() => {
        breathDots[round]?.classList.add("on");
        round += 1;
        if (round < 3) inhale(); else celebrate();
      }, PHASE);
    }
    function celebrate() {
      breathing.classList.remove("ph-out");
      breathing.classList.add("celebrate");
      breathHeadline.textContent = "You did it! ✨";
      say("You did it!");
      if (brAnim) brAnim.goToAndStop(BR_END, true);
      later(startChoice, 1900);
    }
    inhale();
  }

  /* --- MOVE: find three things of a colour ---
     The only break that sends the child away from the screen, so the app can't
     verify anything: one honest "I found them!" tap brings them back. No timer,
     no countdown — the child sets the pace.                                  */
  const findScreen = $("#screen-find");
  // No yellow. The sun on this screen is #FFC64D and the sun is also the "I found
  // them" button, so "find 3 yellow things" is answered by the screen itself - a
  // child can point at the sun and tap it in a second. This is the one break whose
  // whole point is to send them away from the screen.
  // The set is tuned in OKLCH, not by eye. All three sit at L~58 and chroma
  // 0.165, so no swatch reads as "the dark one" - the failure the old red had:
  // at C=0.146 and hue 32 it was brick, not red, which a child is being asked
  // to name out loud. Chroma stops short of the crayon primaries (0.19+), which
  // clear contrast fine but go electric against this warm cream sky.
  // Contrast is 3.02-4.24:1 across the day sky's three stops. A swatch is a
  // graphical object, so 3:1 is not strictly required - but a child with low
  // vision has to see this one to play, so the set is held to it.
  // Green is a true green, not a second teal: teal is the UI accent and must
  // not read as game content. No yellow - see the note above.
  // Documented in brand.md section 2 as game content colours.
  const FIND_COLOURS = [
    { name: "red",   hex: "#CC4C40" },
    { name: "blue",  hex: "#217AD8" },
    { name: "green", hex: "#049640" }
  ];
  let findRotation = Math.floor(Math.random() * FIND_COLOURS.length);
  function startFind() {
    const c = FIND_COLOURS[findRotation % FIND_COLOURS.length];
    findRotation += 1;
    findScreen.classList.remove("celebrate");
    findScreen.style.setProperty("--find-colour", c.hex);
    // the fill comes from --find-colour alone; setting it inline as well made the
    // CSS custom-property fallback dead code
    $$("#find-swatches i").forEach((s) => {
      // restart the staggered entrance: the elements persist between breaks, so
      // without a reflow the animation only ever plays on the first one
      s.style.animation = "none";
      void s.offsetWidth;
      s.style.animation = "";
    });
    $("#find-headline").textContent = `Find 3 ${c.name} things!`;
    $("#find-sub").textContent = "Look around the room. Touch the sun when you find them.";
    // said after showScreen below, so the screen is up before the voice starts
    // the sun is the control, so it is disabled rather than hidden - hiding it
    // would remove the mascot from the celebration
    $("#find-done").disabled = false;
    showScreen("screen-find");
    later(() => say(`Find 3 ${c.name} things. Look around the room, and touch the sun when you find them.`), 600);
  }
  $("#find-done").addEventListener("click", (e) => {
    if (findScreen.classList.contains("celebrate")) return;
    findScreen.classList.add("celebrate");
    $("#find-headline").textContent = "You found them! ✨";
    $("#find-sub").textContent = "Great looking.";
    say("You found them!"); // kept short: the next screen arrives in 1.9s and hushes
    $("#find-done").disabled = true;
    pop(e.currentTarget);
    safePlay(chime);
    later(startChoice, 1900);
  });

  /* --- SETTLE: follow the sun with your eyes --- */
  /* The clinical evidence for smooth pursuit is in DEGREES OF VISUAL ANGLE, so
     the design holds degrees constant and lets pixels fall out. Holding pixels
     constant cannot hold degrees constant: both pixel density and viewing
     distance change per device.

     near: CSS px per mm is roughly constant across phones and laptops, so one
     number works (phone ~32, laptop ~40, so 36).
     far:  a TV shell's viewport width is NOT fixed - 1280 and 960 are as common
           as 1920 - but a set's angular width in the room is stable. A 43" at
           ~2m subtends ~26.8 degrees. 2m, not 3m: small children sit closer than
           adults do. */
  const DEG_SUN = 2, DEG_PER_SEC = 8, NEAR_PX_PER_DEG = 36, TV_ANGULAR_WIDTH = 26.8;
  const appEl = $("#app");

  // data-context was never set anywhere, so pxPerDeg() always fell through to
  // the near default (final review I4). Spec S3's `@media (hover:none) and
  // (min-width:1100px)` can gate a stylesheet rule but not a dataset attribute
  // a script reads - matchMedia is the same query, evaluated in JS, so it can
  // actually flip the attribute. Re-checked on resize too: the query's own
  // change event covers a TV browser's own resolution changes, but the
  // existing resize listener is the belt-and-suspenders re-evaluation.
  const farQuery = window.matchMedia("(hover: none) and (min-width: 1100px)");
  function refreshContext() {
    appEl.dataset.context = farQuery.matches ? "far" : "near";
  }
  refreshContext();
  if (farQuery.addEventListener) farQuery.addEventListener("change", refreshContext);

  function pxPerDeg() {
    return appEl.dataset.context === "far"
      ? appEl.clientWidth / TV_ANGULAR_WIDTH
      : NEAR_PX_PER_DEG;
  }

  function applyContext() {
    const ppd = pxPerDeg();
    appEl.style.setProperty("--px-per-deg", ppd);
    appEl.style.setProperty("--ball", (DEG_SUN * ppd) + "px");
    return ppd;
  }

  const followField = $("#follow-field");
  const followHero  = $("#follow-hero");
  const followScreen = $("#screen-follow");
  const MIN_PASS_MS = 1600; // a shorter pass reads as a flicker, not as a target

  // Corner-to-corner is NOT good enough for the diagonal: its angle is then at
  // the mercy of the field's aspect ratio, and on a wide desktop field the
  // diagonal flattens to ~23 degrees off horizontal - close enough to the first
  // leg that it stops being a third direction. Clamp the horizontal extent so
  // the angle is at least 30 degrees, and centre what remains. Narrow fields are
  // untouched, since their diagonal is already steeper than 30.
  const MIN_DIAGONAL_DEG = 30;
  function diagonalLeg(maxX, maxY) {
    const dx = Math.min(maxX, maxY / Math.tan(MIN_DIAGONAL_DEG * Math.PI / 180));
    const off = (maxX - dx) / 2;
    return { from: {x: off, y: maxY}, to: {x: off + dx, y: 0} };
  }

  // Travel is the field's measured box minus one sun diameter, per axis.
  function legGeometry(dir) {
    const r = followField.getBoundingClientRect();
    const d = followHero.getBoundingClientRect().width;
    const maxX = Math.max(0, r.width  - d);
    const maxY = Math.max(0, r.height - d);
    const midX = maxX / 2, midY = maxY / 2;
    const legs = {
      across:   { from: {x: 0,    y: midY}, to: {x: maxX, y: midY} },
      updown:   { from: {x: midX, y: 0   }, to: {x: midX, y: maxY} },
      diagonal: diagonalLeg(maxX, maxY)
    };
    const leg = legs[dir];
    leg.travel = Math.hypot(leg.to.x - leg.from.x, leg.to.y - leg.from.y);
    return leg;
  }

  // Duration is derived so that ANGULAR speed is constant: a short leg takes
  // proportionally less time than a long one. The floor stops a very short pass
  // reading as a flicker; it binds on a phone's horizontal pass and nowhere on
  // a television.
  function passMs(travel) {
    return Math.max(MIN_PASS_MS, (travel / (DEG_PER_SEC * pxPerDeg())) * 1000);
  }

  function placeHero(pt) {
    followHero.style.translate = `${pt.x}px ${pt.y}px`;
  }

  function movePass(to, ms) {
    followHero.style.setProperty("--sweep", ms + "ms");
    placeHero(to);
    return ms;
  }

  /* THE CATCH (spec 13.3). Interaction is an enhancement, exactly like speech:
     a tap advances the game, and where no tap can come - a television - or none
     does come, the sun pops on its own. hold(), not later(): the wait is the
     activity's own pacing. The race between tap and timer is settled by onCatch
     nulling itself first, so the loser finds nothing to run. */
  const CATCH_WAIT_MS = 4500; // touch devices: never stuck
  const FAR_CATCH_MS  = 2000; // TV: a beat - no tap is coming
  let onCatch = null, catchTimer = 0;

  function land(i, done) {
    followHero.classList.add("landed");
    followHero.setAttribute("aria-disabled", "false");
    // Item 15's rule, wrapper/keyboard path: focus lands on the sun wherever
    // the sun is the action. Enter/Space then fire the button's click.
    followHero.focus({ preventScroll: true });
    onCatch = () => {
      onCatch = null;
      clearTimeout(catchTimer);
      followHero.classList.remove("landed");
      followHero.setAttribute("aria-disabled", "true");
      pop(followHero);
      plip();
      followDots[i]?.classList.add("on");
      hold(done, 620); // let the pop land before the fade to the next leg
    };
    catchTimer = hold(() => { if (onCatch) onCatch(); },
      appEl.dataset.context === "far" ? FAR_CATCH_MS : CATCH_WAIT_MS);
  }
  followHero.addEventListener("click", () => { if (onCatch) onCatch(); });

  /* The catch sound: two quick soft sine notes, Web Audio, no asset. Enhancement
     only - wrapped so a missing/blocked AudioContext costs nothing. The chime
     stays celebration-only, matching find. */
  let plipCtx = null;
  function plip() {
    try {
      plipCtx = plipCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (plipCtx.state === "suspended") plipCtx.resume().catch(() => {});
      const t = plipCtx.currentTime;
      // Sensory-friendly mode (item 42): this is real app audio (the
      // follow-the-sun catch sound), just synthesized via Web Audio rather
      // than an <audio> element, so it gets the same treatment as every
      // other sound the app plays - scaling the gain envelope's peak,
      // since a GainNode has no .volume property to set directly.
      const vol = sensoryFriendly ? SENSORY_VOLUME : 1;
      [659, 880].forEach((f, i) => {
        const o = plipCtx.createOscillator(), g = plipCtx.createGain();
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + i * .09);
        g.gain.exponentialRampToValueAtTime(.16 * vol, t + i * .09 + .02);
        g.gain.exponentialRampToValueAtTime(.0001, t + i * .09 + .24);
        o.connect(g); g.connect(plipCtx.destination);
        o.start(t + i * .09); o.stop(t + i * .09 + .26);
      });
    } catch (e) { /* silence is fine */ }
  }

  const FOLLOW_LEGS = ["across", "updown", "diagonal"];
  const followDots = $$("#follow-dots i");
  const FADE_MS = 300, BEAT_MS = 400;

  // The sun ends each leg where it began, so it must be repositioned for the
  // next one. A jump cut reads as a glitch and breaks the pursuit; an untracked
  // glide is a fourth direction the child will try to follow. So: fade out,
  // reposition while invisible, fade in, beat.
  function placeHidden(pt, then) {
    followHero.classList.add("gone");
    hold(() => {
      // --sweep:0ms alone can't reach a zero transition duration under
      // reduced motion: .reduce-motion * forces transition-duration:.12s
      // !important on everything, which outranks the custom property and
      // turned this "instant while hidden" reposition into a real, if brief,
      // glide - visible as a semi-transparent slide because the opacity
      // fade-in below starts concurrently (final review I3). .jump has two
      // classes against .reduce-motion *'s one, so its own !important wins
      // regardless of motion mode.
      followHero.classList.add("jump");
      placeHero(pt);
      followHero.offsetWidth;            // commit the jump before fading back in
      followHero.classList.remove("jump");
      followHero.classList.remove("gone");
      hold(then, FADE_MS + BEAT_MS);
    }, FADE_MS);
  }

  function runLeg(i, done) {
    const leg = legGeometry(FOLLOW_LEGS[i]);
    const ms = passMs(leg.travel);
    placeHidden(leg.from, () => {
      movePass(leg.to, ms);
      hold(() => {
        movePass(leg.from, ms);
        hold(() => land(i, done), ms);
      }, ms);
    });
  }

  function startFollow() {
    applyContext();
    followDots.forEach((d) => d.classList.remove("on"));
    followHero.classList.remove("gone", "tapped");
    followScreen.classList.remove("celebrate");
    // A resize or reduced-motion restart can arrive mid-landing: clear the
    // catch state so a stale onCatch can never fire against the new run.
    onCatch = null;
    followHero.classList.remove("landed");
    followHero.setAttribute("aria-disabled", "true");
    $("#follow-headline").innerHTML = '<span class="m-full">Follow the sun!</span><span class="m-reduced">Where\'s the sun?</span>';
    showScreen("screen-follow");
    hold(() => sayLine($("#voice-follow-intro"), "Follow the sun with your eyes. Catch it at the end!"), 600);
    let i = 0;
    const next = () => { i += 1; if (i < FOLLOW_LEGS.length) runLeg(i, next); else endFollow(); };
    runLeg(0, next);
  }

  function endFollow() {
    const r = followField.getBoundingClientRect();
    const d = followHero.getBoundingClientRect().width;
    placeHidden({ x: (r.width - d) / 2, y: (r.height - d) / 2 }, () => {
      // .celebrate and .tapped's rules tie at CSS specificity (final review
      // M1): if pop()'s own 950ms cleanup hadn't already removed .tapped by
      // now, the later .celebrate rule wouldn't win, and the pop wouldn't
      // (re)start. Removing it here makes that explicit instead of relying on
      // timing that happened to work out.
      followHero.classList.remove("tapped");
      followScreen.classList.add("celebrate");
      $("#follow-headline").innerHTML = '<span class="m-full">You did it! ✨</span><span class="m-reduced">You did it! ✨</span>';
      sayLine($("#voice-follow-done"), "You did it!");
      safePlay(chime);
      // hold, not later: later would fire this at 200ms under reduced motion
      // and cut the celebration off mid-word.
      hold(startChoice, 1900);
    });
  }

  /* --- MOVE: stand like a tree with the demonstrator (sourced Lottie character) ---
     No screen input at all, by physical design: her arms are overhead and she's
     balancing on one leg, so a tap mid-game would contradict the activity.
     Everything here is timed - every phase below uses hold(), never later(),
     spec's own rule since this break is all timers (spec §4). */
  const treeScreen = $("#screen-tree");
  const treeHeadline = $("#tree-headline");
  const treeCountBalloon = $("#tree-count-balloon");
  const treeCountBig = $("#tree-count-big");
  const treeCountTrail = $("#tree-count-trail");
  const treeDots = $$("#tree-dots i");
  const treeStage = $("#tree-stage");
  const treeLottieEl = $("#tree-lottie");

  let treeAnim = null;
  function initTree() {
    if (treeAnim || !window.lottie || !window.KIDQ_TREE_ANIM) return;
    treeScreen.classList.add("lottie-on");
    treeAnim = lottie.loadAnimation({ container: treeLottieEl, renderer: "svg",
      loop: true, autoplay: false, animationData: window.KIDQ_TREE_ANIM });
  }

  // The visible count is driven by the SAME hold chain as the spoken count, so
  // they cannot drift apart (spec §4) - never animation-delay staggering.
  // COUNT_STEP_MS are word-start offsets (ms, from the count clip's own
  // start) read from edge-tts's --write-subtitles output for
  // voice-tree-count.mp3 (en-IN-NeerjaNeural, --rate=-10%, matching follow's
  // pipeline); COUNT_MS (7800) is that clip's own measured length (mutagen).
  // The chain is tuned to this REAL clip, not the other way round - spec §5
  // is explicit that the hold chain follows the measured audio, and at this
  // unhurried a pace the real per-number gap runs ~1.4-1.7s, longer than the
  // spec's own ~1.1s/number estimate (logged honestly, not forced to fit).
  // BIG is the current number (the break-count digit pattern, brand.md);
  // TRAIL is what's still coming, shown small and dimmed beside it.
  const COUNT_BIG = ["5", "4", "3", "2", "1"];
  const COUNT_TRAIL = ["4 · 3 · 2 · 1", "3 · 2 · 1", "2 · 1", "1", ""];
  const COUNT_STEP_MS = [0, 1758, 3327, 4827, 6244];
  const COUNT_MS = 7800;
  // voice-tree-switch.mp3 measures 1.872s; hold past that so hold2's own
  // sayLine call never fires while this phase's clip might still be playing.
  const SWITCH_MS = 2100;
  const SWITCH_FLIP_MS = 450; // "flip at the apex" of the ~900ms up/down bounce

  // pop() (js, above) already does the remove/reflow/add + later() cleanup a
  // retriggerable squash-stretch needs; later()'s 200ms cleanup clamp under
  // reduced motion only delays removing the class, not the animation itself,
  // which the global .reduce-motion rule already crushes to instant - so
  // reduced motion needs no special-casing here (steer, 2026-09-15).
  // Balloon (user request 2026-09-15): pop() now targets the BALLOON
  // wrapper, not the bare glyph, so the whole balloon bounces in together;
  // setBalloonHue cycles teal->rose->coral->dusk, one step per digit.
  function setTreeCount(i) {
    treeCountBig.textContent = COUNT_BIG[i];
    treeCountTrail.textContent = COUNT_TRAIL[i];
    setBalloonHue(treeCountBalloon, i);
    pop(treeCountBalloon);
  }

  function treeCount(onDone) {
    for (let i = 1; i < COUNT_BIG.length; i++) {
      hold(() => setTreeCount(i), COUNT_STEP_MS[i]);
    }
    hold(onDone, COUNT_MS);
  }

  function treeSwitchLeg() {
    sayLine($("#voice-tree-switch"), "Other leg!");
    if (reducedMotion) {
      // Crossfade, no bounce (spec §6): fade out, flip the mirror + still
      // frame while invisible, fade back in - the same "never an untracked
      // glide" shape follow's placeHidden uses, just for a pose swap instead
      // of a position swap.
      treeStage.classList.add("crossfade");
      hold(() => {
        treeLottieEl.classList.add("mirrored");
        if (treeAnim) treeAnim.goToAndStop(0, true);
      }, 300);
      hold(() => treeStage.classList.remove("crossfade"), 600);
    } else {
      treeStage.classList.add("flipping");
      hold(() => treeLottieEl.classList.add("mirrored"), SWITCH_FLIP_MS);
      hold(() => treeStage.classList.remove("flipping"), 900);
    }
    hold(runHold2, SWITCH_MS);
  }

  function runHold1() {
    setTreeCount(0);
    sayLine($("#voice-tree-count"), "5… 4… 3… 2… 1!");
    treeCount(() => {
      treeDots[0]?.classList.add("on");
      treeStage.classList.add("settle"); // she steadies to upright between holds
      treeSwitchLeg();
    });
  }

  function runHold2() {
    treeStage.classList.remove("settle");
    setTreeCount(0);
    sayLine($("#voice-tree-count"), "5… 4… 3… 2… 1!");
    treeCount(() => {
      treeDots[1]?.classList.add("on");
      treeStage.classList.add("settle");
      celebrateTree();
    });
  }

  function celebrateTree() {
    treeScreen.classList.add("celebrate");
    treeHeadline.textContent = "You did it! ✨";
    treeCountBig.textContent = "";
    treeCountTrail.textContent = "";
    sayLine($("#voice-follow-done"), "You did it!");
    safePlay(chime);
    // hold(), not later(): matches every other break's celebration exit.
    hold(startChoice, 1900);
  }

  const TREE_INTRO_MS = 6360; // measured voice-tree-intro.mp3 length (mutagen)

  function startTree() {
    showScreen("screen-tree");
    initTree();
    treeScreen.classList.remove("celebrate");
    treeStage.classList.remove("flipping", "crossfade", "settle");
    treeLottieEl.classList.remove("mirrored");
    treeDots.forEach((d) => d.classList.remove("on"));
    treeHeadline.textContent = "Stand like a tree with me!";
    treeCountBalloon.classList.remove("tapped");
    setBalloonHue(treeCountBalloon, 0); // every fresh run starts back at teal
    treeCountBig.textContent = COUNT_BIG[0];
    treeCountTrail.textContent = COUNT_TRAIL[0];
    if (treeAnim) {
      if (reducedMotion) treeAnim.goToAndStop(0, true);
      else treeAnim.play();
    }
    hold(() => sayLine($("#voice-tree-intro"), "Stand like a tree with me! Arms up, one foot on your leg."), 600);
    hold(runHold1, 600 + TREE_INTRO_MS);
  }

  /* --- SETTLE: count to ten, eyes closed ---
     No input at all (spec 2026-09-15 kidq-count-to-ten-break-design.md §1):
     eyes are closed, so a tap would contradict the activity - everything
     here is timed, same discipline as tree pose. Donor: BREATHING's own
     .bsun dual-group eye markup (css, #screen-breathing .bsun .eyesClosed
     etc.) - the only sun with a working eye TOGGLE. The sunrise sun's eyes
     were rejected as a donor (spec §2): its unscoped .eyes-awake{opacity:0}
     only lifts under .screen.risen, which #screen-count never gets, so
     "Open your eyes!" would render no eyes at all. */
  const countScreen = $("#screen-count");
  const countHeadline = $("#count-headline");
  const countBalloon = $("#count-balloon");
  const countBig = $("#count-big");
  const countTrail = $("#count-trail");

  // Ten spoken numbers, ten SEPARATE clips (spec §4) - not one multi-word
  // track like tree's own count clip. Per-number clips let the hold chain
  // trigger each one at its own tick, so digits and audio stay in step even
  // on the device-TTS fallback (a single ~19s clip can't be paced, and
  // say() would finish early); no clip is ever still playing under the next
  // beat, since hush() (countTick, below) retires it first every time.
  // Named TEN_* rather than tree's own COUNT_* (kidq-desktop-app.js above)
  // to avoid redeclaring those consts in this shared module scope.
  const TEN_WORDS = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  const TEN_BIG = TEN_WORDS.map((_, i) => String(i + 1));
  // The WALKED-THROUGH numbers trail behind the current big digit (spec §1)
  // - the opposite direction from tree's own countdown trail, which
  // previews what's still coming. Same " · " join tree uses - the width
  // risk spec §1 names explicitly ("one orphaned '· 10' away from wrapping"
  // at the 390px tier) turned out not to need a thinner separator once
  // measured: the worst case (big="10", all nine numbers trailing) scrolls
  // to 180px against 330px usable at the narrowest tier (§8.1), so the
  // shared punctuation stays. font-variant-numeric:tabular-nums (css:
  // #screen-count .kq-breakcount-trail) keeps that measurement stable as
  // the digits themselves change width.
  const TEN_TRAIL = TEN_BIG.map((_, i) => TEN_BIG.slice(0, i).join(" · "));
  const TEN_CLIPS = TEN_WORDS.map((_, i) => $(`#voice-count-${i + 1}`));

  // voice-count-1..10.mp3 (edge-tts en-IN-NeerjaNeural --rate=-10%, same
  // pipeline/rate as follow and tree, confirmed against commit e7fa524) all
  // measure 1.872s (mutagen) - so the tick chain's own spacing IS the clip
  // length: "chain follows audio" (spec §1), each number given room to
  // finish before the next starts, hush() the safety net if a device ever
  // runs slow. voice-count-intro.mp3 measures 3.696s. voice-count-open.mp3
  // measures 2.280s; TEN_OPEN_MS adds a ~220ms buffer (same reasoning as
  // tree's own SWITCH_MS cushion) so the open line has time to finish
  // before the celebration's own sayLine call could ever collide with it.
  const TEN_INTRO_MS = 3696;
  const TEN_TICK_MS = 1872;
  const TEN_OPEN_MS = 2500;

  function setTenDigit(i) {
    countBig.textContent = TEN_BIG[i];
    countTrail.textContent = TEN_TRAIL[i];
    setBalloonHue(countBalloon, i); // teal/rose/coral/dusk, one step per tick
    // Quieter than tree's pop() (spec §1: "the entrance is a slow pulse,
    // not a bounce" - count is the settle game) - and, since the balloon
    // build (2026-09-15), a float rather than a scale-pulse: "drifting
    // gently up into place... slow float, no bounce", per the design brief.
    // Targets the BALLOON wrapper now, not the bare glyph, so the whole
    // balloon floats in together. Own remove/reflow/add dance (find's own
    // re-entrancy pattern, css:781-785) rather than widening pop()'s two
    // hardcoded class names for a third animation only this screen uses.
    countBalloon.classList.remove("pulse");
    void countBalloon.offsetWidth;
    countBalloon.classList.add("pulse");
    later(() => countBalloon.classList.remove("pulse"), 550); // kq-balloonfloat is 450ms; 100ms cleanup buffer, same proportion the old kq-countpulse kept (300ms anim / 350ms cleanup)
  }

  function countTick(i) {
    setTenDigit(i);
    hush(); // every tick's own line (spec §3): retires whatever came before
    sayLine(TEN_CLIPS[i], TEN_WORDS[i]);
  }

  function runTenCount() {
    countTick(0);
    for (let i = 1; i < TEN_BIG.length; i++) hold(() => countTick(i), i * TEN_TICK_MS);
    hold(openTenEyes, TEN_BIG.length * TEN_TICK_MS);
  }

  function openTenEyes() {
    countScreen.classList.remove("dim");
    hush();
    sayLine($("#voice-count-open"), "Open your eyes!");
    hold(celebrateCount, TEN_OPEN_MS);
  }

  function celebrateCount() {
    countScreen.classList.add("celebrate");
    countHeadline.textContent = "You did it! ✨";
    countBig.textContent = "";
    countTrail.textContent = "";
    sayLine($("#voice-follow-done"), "You did it!"); // shared ending clip, spec §4/§7.1
    safePlay(chime);
    hold(startChoice, 1900); // matches every other break's celebration exit
  }

  function startCount() {
    showScreen("screen-count");
    countScreen.classList.remove("celebrate");
    countScreen.classList.add("dim"); // sky dims + sun's eyes close, one state class (spec §2)
    countHeadline.textContent = "Close your eyes — count with me!";
    countBalloon.classList.remove("pulse");
    setBalloonHue(countBalloon, 0); // every fresh run starts back at teal
    countBig.textContent = TEN_BIG[0];
    countTrail.textContent = "";
    hold(() => sayLine($("#voice-count-intro"), "Close your eyes… and count with me!"), 600);
    hold(runTenCount, 600 + TEN_INTRO_MS);
  }

  /* --- SETTLE: smell the flower, blow out the candle ---
     Spec 2026-09-16 kidq-flower-candle-break-design.md. Promoted from
     breathing's own offline-fallback SVG row (index.html #screen-breathing)
     to its own full break, three rounds, zero taps - same no-input
     discipline as breathe and count. Every phase is voiced (spec §4: "0-6s
     can't read"), so this follows count's own hush-per-tick pattern rather
     than breathing's "only the opening line is spoken" choice. */
  const flowerScreen = $("#screen-flower-candle");
  const flowerHeadline = $("#flower-headline");
  const flowerDots = $$("#flower-dots i");

  // voice-flower-intro/-smell/-blow.mp3 (edge-tts en-IN-NeerjaNeural
  // --rate=-10%, same pipeline as follow/tree/count), measured with mutagen:
  // intro 4.224s, smell 2.352s, blow 2.568s. FC_PHASE_MS is the shared
  // smell/blow phase length (spec §4): max(the longer clip + a ~300ms
  // breathing room, 3500) capped ~4000 (finding 12 - 6 x 4.5s would overshoot
  // §1's own honest-length ceiling) - here the 3500 floor wins outright
  // (2568 + 300 = 2868 < 3500), same "measured, not the spec's own estimate"
  // lesson tree/count already established.
  const FC_INTRO_MS = 4224;
  const FC_SMELL_MS = 2352;
  const FC_BLOW_MS = 2568;
  const FC_PHASE_MS = 3500;

  // startFlowerCandle is a hoisted function declaration, not a const arrow
  // (spec Opus finding 14) - see the BREAK_START comment above for why.
  function startFlowerCandle() {
    showScreen("screen-flower-candle");
    // Re-entry safety (spec §6), same discipline as startBreathing/
    // startCount: clear every phase class so a restart (resize, reduced-
    // motion toggle) can never resume mid-round. Clearing .ph-blow alone
    // already relights the flame and resets the halo/petals/sun to their
    // rest state - all three are plain CSS defaults, not JS-tracked flags.
    flowerScreen.classList.remove("ph-smell", "ph-blow", "celebrate");
    flowerDots.forEach((d) => d.classList.remove("on"));
    flowerHeadline.textContent = "Smell the flower…";
    hold(() => sayLine($("#voice-flower-intro"), "Smell the flower… then blow out the candle!"), 600);
    let round = 0;
    function smell() {
      flowerScreen.classList.remove("ph-blow");
      flowerScreen.classList.add("ph-smell");
      flowerHeadline.textContent = "Smell the flower…";
      hush(); // every phase's own line (spec §4/finding 15) retires whatever came before
      sayLine($("#voice-flower-smell"), "Smell the flower…");
      hold(blow, FC_PHASE_MS);
    }
    function blow() {
      flowerScreen.classList.remove("ph-smell");
      flowerScreen.classList.add("ph-blow");
      flowerHeadline.textContent = "Blow out the candle!";
      hush();
      sayLine($("#voice-flower-blow"), "Blow out the candle!");
      // Round dot fills at BLOW-PHASE END (spec §4), same as breathe's own
      // `later(() => { breathDots[round]... }, PHASE)` idiom - so the dot
      // fill is deferred into the phase-end callback below, not fired the
      // instant the blow phase starts. isFinal is captured before `round`
      // increments, since the final round's own hold duration differs
      // (finding 12's cushion) from every earlier round's plain FC_PHASE_MS.
      const isFinal = round === 2;
      // Final round (spec §4, finding 12): the last blow phase must outlast
      // its own clip by a real cushion before celebration starts - the same
      // TEN_OPEN_MS reasoning count's own "Open your eyes!" line uses -
      // guaranteed algebraically here rather than by FC_PHASE_MS just
      // happening to be big enough today.
      hold(() => {
        flowerDots[round]?.classList.add("on");
        round += 1;
        if (isFinal) celebrate(); else smell();
      }, isFinal ? Math.max(FC_PHASE_MS, FC_BLOW_MS + 220) : FC_PHASE_MS);
    }
    function celebrate() {
      flowerScreen.classList.remove("ph-blow");
      flowerScreen.classList.add("celebrate");
      flowerHeadline.textContent = "You did it! ✨";
      hush(); // finding 15: hush before the celebration line too, not just the phase lines
      sayLine($("#voice-follow-done"), "You did it!"); // shared ending clip, spec §5/§7.1
      safePlay(chime);
      hold(startChoice, 1900); // matches every other break's celebration exit
    }
    hold(smell, 600 + FC_INTRO_MS);
  }

  /* ---------- after-break choice (within the parent's picks) ---------- */
  const choiceScreen = $("#screen-choice");
  const choiceSun = $("#choice-sun");
  const CHOICE_AUTO_MS = 4000; // item 25: choice screen self-advances if no tap. ~4s is a starting point to tune against a real child.

  // Item 40: with the parent's Autoplay setting off, this screen has no
  // CHOICE_AUTO_MS timer to fall back on - so, same worry item 25 raised, a
  // pre-reader who doesn't realise it's their move could be left sitting here
  // forever. Instead of a timeout, the sun nudges itself: a first attention
  // beat at ~7s, then every ~15s after that, for as long as the child sits
  // here. It never advances anything on its own - only a tap does that - so
  // "forever" is fine here in a way it wasn't for CHOICE_AUTO_MS.
  //
  // The beat reuses pop()'s existing squash-stretch (the same animation a
  // real tap produces elsewhere in the app) rather than inventing new motion,
  // plus a soft audio cue. hold(), not later(): the delay IS the nudge, not a
  // transition, so it must not clamp to 200ms under reduced motion - same
  // reasoning as CHOICE_AUTO_MS and HIFIVE_AUTO_MS.
  //
  // No cancellation wiring needed here: a tap (sun or a card) runs
  // startWatching -> showScreen -> clearTimers, which already wipes whatever
  // hold() is pending, CHOICE_AUTO_MS's or this one's.
  //
  // Audio placeholder: there's no recorded "Touch the sun for your next video"
  // line in the repo - voice-follow-intro/-done are follow-the-sun specific -
  // so this reuses the soft sunset chime for now. TODO(production): record a
  // spoken "Touch the sun for your next video" line for pre-readers, in the
  // same voice as the other clips, and play it here via sayLine() the way
  // startFollow does for its own intro line.
  const NUDGE_FIRST_MS = 7000, NUDGE_REPEAT_MS = 15000;
  function scheduleNudge(ms) {
    hold(() => {
      pop(choiceSun);
      safePlay(chime);
      scheduleNudge(NUDGE_REPEAT_MS);
    }, ms);
  }

  function startChoice() {
    // No video left: the day is over, and the decided flow ends at the moon -
    // sunset, then the all-done screen. A choice screen with nothing to choose
    // would strand the child (its sun-tap would start undefined). The rule
    // lives HERE, not in the callers, so no break - present or future - can
    // reach a dead choice screen.
    if (unwatched().length === 0) { startSunset(true); return; }
    const p = sessionProgress();
    positionSun(choiceSun, p);
    $("#choice-time").textContent = minutesLeft(p) + " min left";
    $("#choice-av").textContent = state.profile.name[0];
    $("#choice-av").style.background = state.profile.color;
    $("#choice-name").textContent = `${state.profile.name}'s watch time`;
    const left = unwatched();
    $("#choice-count").textContent = left.length === 1
      ? "1 video to go" : `${left.length} videos to go`;
    const row = $("#choice-cards");
    row.innerHTML = "";
    left.forEach((v) => {
      const wrap = document.createElement("div");
      wrap.className = "kq-pickwrap";
      const btn = document.createElement("button");
      btn.className = "kq-qcard kq-qcard--pick";
      btn.setAttribute("aria-label", `Watch ${v.title} next`);
      btn.innerHTML = `<img src="${v.poster}" alt="">`;
      btn.addEventListener("click", () => { safePlay(jingle); startWatching(v); });
      const name = document.createElement("p");
      name.className = "kq-qname";
      name.textContent = v.title;
      wrap.append(btn, name);
      row.appendChild(wrap);
    });
    showScreen("screen-choice");
    // No jingle: the jingle marks a child's choice, and this isn't one. A card tap
    // runs startWatching -> showScreen -> clearTimers, which cancels this pending timer.
    if (autoplay) hold(() => { const next = unwatched()[0]; if (next) startWatching(next); }, CHOICE_AUTO_MS);
    // Autoplay off (item 40): never schedule CHOICE_AUTO_MS - nudge instead,
    // see scheduleNudge above.
    else scheduleNudge(NUDGE_FIRST_MS);
  }
  choiceSun.addEventListener("click", () => {
    if (!choiceScreen.classList.contains("active")) return;
    safePlay(jingle);
    startWatching(unwatched()[0]);
  });

  /* ---------- all done ---------- */
  const allDone = $("#screen-all-done");
  const doneAnnounce = $("#done-announce");

  // high-five character animation (Lottie; the inline SVG hands are the fallback)
  let hfAnim = null;
  const HF_IDLE = 60, HF_END = 119, HF_DONE_POSE = 105; // apart/waiting · full end · resting-together pose
  function initHifive() {
    if (hfAnim || !window.lottie || !window.KIDQ_HIFIVE_ANIM) return;
    $("#high-five").classList.add("lottie-on");
    hfAnim = lottie.loadAnimation({ container: $("#hf-lottie"), renderer: "svg",
      loop: false, autoplay: false, animationData: window.KIDQ_HIFIVE_ANIM });
  }
  const SCENES = {
    kite: `<svg viewBox="0 0 88 52"><rect width="88" height="52" rx="11" fill="#CDE8E2"/><path d="M56 10 L66 20 L56 30 L46 20 Z" fill="#E2705E"/><path d="M56 30 q-6 8 -14 10" stroke="#2E2A24" stroke-width="1.6" fill="none" stroke-linecap="round"/><ellipse cx="24" cy="42" rx="16" ry="5" fill="#FFF" opacity=".8"/></svg>`,
    book: `<svg viewBox="0 0 88 52"><rect width="88" height="52" rx="11" fill="#F2E9D8"/><path d="M28 16 h14 v22 h-14 z" fill="#1F7A6D"/><path d="M44 16 h14 v22 h-14 z" fill="#FFC64D"/><path d="M43 16 v22" stroke="#2E2A24" stroke-width="1.6"/></svg>`,
    moon: `<svg viewBox="0 0 88 52"><rect width="88" height="52" rx="11" fill="#2B2955"/><circle cx="46" cy="26" r="12" fill="#FAF4E8"/><circle cx="41" cy="22" r="2.4" fill="#E4D6B8"/><circle cx="50" cy="30" r="1.8" fill="#E4D6B8"/><circle cx="20" cy="12" r="1.6" fill="#FAF4E8"/><circle cx="72" cy="38" r="1.6" fill="#FAF4E8"/></svg>`
  };
  // Same "nothing waits forever without a tap" rule as item 25's choice screen:
  // a young child may not reliably land the five, so the celebration also fires
  // on its own after a wait. Unlike item 25's jingle (which specifically marks a
  // child's OWN choice), the chime here already plays on other non-tap moments
  // elsewhere in the app (e.g. startSunset), so it stays on for the auto path too
  // - the day still earns its send-off whether or not the five landed.
  //
  // Deliberately NOT gated by the `autoplay` flag added for item 40: this
  // timer ends the session, it doesn't advance content, so the parent's
  // Autoplay setting ("play the next video automatically") has no opinion
  // about it either way.
  const HIFIVE_AUTO_MS = 4000; // starting point to tune against a real child, same as item 25
  function fiveUp() {
    if (allDone.classList.contains("hifived")) return;
    allDone.classList.add("hifived");
    if (hfAnim) {
      if (reducedMotion) hfAnim.goToAndStop(HF_DONE_POSE, true);
      else hfAnim.playSegments([[HF_IDLE, HF_END]], true); // the clap + floating dots
    }
    safePlay(chime);
    pop($("#done-moon"), true); // the moon wakes up and wobbles back at you
    // the headline/hf-say swaps above are plain class toggles with no
    // aria-live of their own (item 52) - this is the one place the whole
    // completion moment gets announced, whether the tap landed or this
    // fired on the auto path
    doneAnnounce.textContent = `High five! What a day! Bye bye, ${state.profile ? state.profile.name : "Aarav"}!`;
  }
  function startAllDone() {
    allDone.classList.remove("hifived");
    // a same-page restart can reach all-done a second time; clearing here
    // guarantees the next fiveUp() sets are a genuine text change, so the
    // live region announces every time, not just the first
    doneAnnounce.textContent = "";
    initHifive();
    if (hfAnim) {
      // entrance: the two hands rise in and wait, palms open, for the child's five
      if (reducedMotion) hfAnim.goToAndStop(HF_IDLE, true);
      else hfAnim.playSegments([[0, HF_IDLE]], true);
    }
    $("#done-gn").innerHTML = `Bye bye,<br>${state.profile ? state.profile.name : "Aarav"}! 👋`;
    const wn = $("#whatsnext");
    wn.classList.remove("in", "choose");
    const row = $("#wn-row");
    row.innerHTML = "";
    KidQData.whatsNext.forEach((item) => {
      const card = document.createElement("div");
      card.className = "wn-card" + (item.picked ? " wn-pick" : "");
      // The pick's badge, tilt and drifting hearts are the pitch's own treatment
      // (proposal-src/kidq-design-preview.html), restored here per explicit user
      // request after an earlier pass had re-skinned them calm (cream caption, no
      // tilt, no hearts). The one thing that stays retired either way: the pitch's
      // separate circular .pickheart badge - never asked for, would crowd the pill.
      card.innerHTML = `<div class="scene">${SCENES[item.scene] || ""}</div><span>${item.label}</span>` +
        (item.picked ? `<span class="wn-pick-tag"><svg class="kq-mheart" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17 C4 12 2 8.5 4.2 6.2 A3.4 3.4 0 0 1 10 7.4 A3.4 3.4 0 0 1 15.8 6.2 C18 8.5 16 12 10 17 Z" fill="currentColor"/></svg>${item.pickedBy || "Mumma & Papa"}'s pick</span>` +
          `<span class="wnheart h1" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M10 17 C4 12 2 8.5 4.2 6.2 A3.4 3.4 0 0 1 10 7.4 A3.4 3.4 0 0 1 15.8 6.2 C18 8.5 16 12 10 17 Z" fill="#E2705E"/></svg></span>` +
          `<span class="wnheart h2" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M10 17 C4 12 2 8.5 4.2 6.2 A3.4 3.4 0 0 1 10 7.4 A3.4 3.4 0 0 1 15.8 6.2 C18 8.5 16 12 10 17 Z" fill="#E2705E"/></svg></span>` +
          `<span class="wnheart h3" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M10 17 C4 12 2 8.5 4.2 6.2 A3.4 3.4 0 0 1 10 7.4 A3.4 3.4 0 0 1 15.8 6.2 C18 8.5 16 12 10 17 Z" fill="#E2705E"/></svg></span>`
        : "");
      row.appendChild(card);
    });
    showScreen("screen-all-done");
    later(() => wn.classList.add("in"), 700);
    later(() => wn.classList.add("choose"), 2700);
    // hold(), not later(): later() clamps to 200ms under reduced motion, which
    // would make the five impossible to catch - same reasoning as item 25's
    // CHOICE_AUTO_MS. showScreen()'s own clearTimers() above would wipe a timer
    // scheduled before it, so this is scheduled after, matching the two later()
    // calls right above it.
    hold(fiveUp, HIFIVE_AUTO_MS);
  }
  // fiveUp() re-checks the "hifived" guard itself, so if the child already
  // tapped before this timer fires, the auto path is a harmless no-op - no
  // separate cancellation needed (unlike item 25, there's no showScreen() call
  // on tap here to run clearTimers() for us).
  $("#high-five").addEventListener("click", fiveUp);
  $("#done-moon").addEventListener("click", (e) => pop(e.currentTarget, true));

  /* ---------- no session ---------- */
  const noSessionAnnounce = $("#no-session-announce");
  // aria-live only fires on a genuine text change - this screen's whole
  // interaction is a repeated fidget, so setting the same string twice in a
  // row (touching the same button twice) would silently drop the second
  // announcement, reproducing the exact gap item 49 fixed. Alternating a
  // trailing NBSP keeps every activation a real change without touching the
  // copy itself. Both handlers below share this one approach.
  function announceNoSession(msg) {
    noSessionAnnounce.textContent = (noSessionAnnounce.textContent === msg) ? msg + "\u00A0" : msg;
  }
  function startNoSession() {
    const y = state.profile ? KidQData.yesterdays[state.profile.id] : null;
    $("#yesterday-btn").style.display = y ? "" : "none";
    showScreen("screen-no-session");
  }
  $("#sleeping-sun").addEventListener("click", (e) => {
    const el = e.currentTarget;
    el.classList.remove("stir"); void el.offsetWidth; el.classList.add("stir");
    announceNoSession("The sun is still sleeping. Shh!");
  });
  $("#waiting-moon").addEventListener("click", (e) => {
    pop(e.currentTarget, true);
    announceNoSession("The moon is keeping watch. Shh!");
  });
  $("#yesterday-btn").addEventListener("click", () => {
    const y = KidQData.yesterdays[state.profile ? state.profile.id : "meera"];
    if (!y) return;
    prepSession(state.profile ? state.profile.id : "meera", y);
    startSunrise();
  });

  /* ---------- night light ---------- */
  const nightLight = $("#screen-night-light");
  $("#night-moon").addEventListener("click", (e) => {
    const lit = !nightLight.classList.contains("lit");
    nightLight.classList.toggle("lit", lit);
    e.currentTarget.setAttribute("aria-pressed", String(lit));
    pop(e.currentTarget, true);
    if (lit) safePlay(chime);
  });

  /* ---------- cast (visual mock only) ---------- */
  const cast = $("#screen-cast");
  positionSun($("#cast-sun"), 0.5);
  // mirrors #watch-pause's exact pattern (js ~647): flip the aria-label with
  // the state instead of leaving it hardcoded to "Pause". .kq-castpill's own
  // Playing/Paused swap already carries aria-live (index.html), so no
  // separate announcement is needed here.
  $("#cast-pause").addEventListener("click", (e) => {
    const pausing = !cast.classList.contains("paused");
    cast.classList.toggle("paused", pausing);
    e.currentTarget.setAttribute("aria-label", pausing ? "Resume the video on the TV" : "Pause the video on the TV");
  });

  // Applies a reduced-motion value everywhere it must be reflected - the
  // live variable and the root class - so sensory-friendly's
  // forced-on/released-off transitions (setSensoryFriendly, below) can reuse
  // exactly the same effects. Defined here rather than up with
  // reducedMotion's other declarations because it needs followScreen, below.
  function setReducedMotion(v) {
    reducedMotion = v;
    document.documentElement.classList.toggle("reduce-motion", reducedMotion);
    // Never restart mid-ending: the break stays "active" through its own
    // celebration AND through the silent hold startChoice/startSunset uses to
    // reach the moon (neither calls showScreen), so a naive restart-if-active
    // check would replay the whole break and, worse, cancel that pending
    // transition, stranding the child on a follow screen that never moves on
    // (final review I1).
    if (followScreen.classList.contains("active") && !followScreen.classList.contains("celebrate")) {
      clearTimers(); startFollow();
    }
  }
  if (reducedMotion) {
    document.documentElement.classList.add("reduce-motion");
  }

  // Sensory-friendly mode (item 42): forces reduce-motion on/off through
  // setReducedMotion above, without ever stomping a reduce-motion the user
  // chose independently before the force. `changed` guards BOTH the
  // motion-coupling side effect (skip entirely when sensoryFriendly's own
  // value isn't actually moving - e.g. prepSession() reseeding to the same
  // default on every plain login must not touch motion at all) and, within
  // that, setReducedMotion is only called when the target value actually
  // differs from the live one, so releasing the force back to an unchanged
  // value can't spuriously restart an in-flight follow break.
  function setSensoryFriendly(v) {
    const changed = v !== sensoryFriendly;
    sensoryFriendly = v;
    if (!changed) return;
    if (sensoryFriendly) {
      preSensoryMotion = reducedMotion; // remember what was live before the force
      if (!reducedMotion) setReducedMotion(true);
    } else if (reducedMotion !== preSensoryMotion) {
      setReducedMotion(preSensoryMotion); // release: restore, never assume off
    }
  }

  // Debounced so a window drag doesn't restart the break once per resize
  // event (M7); the celebrate guard mirrors setReducedMotion's own guard
  // above and is what actually stops the ending-replay bug (I1) - re-checked inside
  // the timeout too, since the 150ms wait can outlast the celebration itself.
  let followResizeTimer = 0;
  window.addEventListener("resize", () => {
    refreshContext();
    if (watching.classList.contains("active") && state.session) updateSky();
    if (choiceScreen.classList.contains("active") && state.session) positionSun(choiceSun, sessionProgress());
    positionSun($("#cast-sun"), 0.5);
    if (followScreen.classList.contains("active") && !followScreen.classList.contains("celebrate")) {
      clearTimeout(followResizeTimer);
      followResizeTimer = setTimeout(() => {
        if (followScreen.classList.contains("active") && !followScreen.classList.contains("celebrate")) {
          clearTimers(); startFollow();
        }
      }, 150);
    }
  });

  startSplash();
})();
