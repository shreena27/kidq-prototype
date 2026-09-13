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
  const later = (fn, ms) => { const id = setTimeout(fn, reducedMotion ? Math.min(ms, 200) : ms); timers.push(id); return id; };
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
  const safePlay = (m) => { if (!m) return; m.currentTime = 0; m.play().catch(() => {}); };
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
      speech.speak(u);
    } catch (e) { /* never let a missing voice break a break */ }
  }
  function hush() { try { if (speech) speech.cancel(); } catch (e) {} }

  function showScreen(id) {
    clearTimers();
    hush(); // a line must never carry over into the next screen
    $$(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
    $$("[data-demo]").forEach((b) => b.classList.remove("selected"));
  }
  function pop(el, wobble) {
    const cls = wobble ? "moontap" : "tapped";
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    later(() => el.classList.remove(cls), 950);
  }

  /* ---------- session state (derived from KidQData only) ---------- */
  // progress: per-video furthest-watched fraction (0..1) — keeps the sun's
  // place when the child switches videos mid-way; watched = fully finished
  const state = { profile: null, session: null, watched: new Set(), progress: {}, current: null,
                  breaks: [], breaksTaken: 0 };

  /* ---------- activity breaks ----------
     Exactly two breaks per session, at the 1/3 and 2/3 points of the parent's
     allotted minutes, each landing on the nearest video boundary (never
     mid-video). Fewer videos means fewer places a break can sit: 2 videos have
     only one boundary, 1 video has none.
     Break 1 draws from MOVE (child is still fresh), break 2 from SETTLE (the
     day is winding down) — the same arc the sun itself travels.             */
  const BREAK_GAMES = {
    move:   ["find"],
    settle: ["breathe"]
    // next round: "tree" (stand like a tree) joins move;
    //             "count" and "eyes" join settle
  };

  // Returns the two break points as fractions of the session's total minutes.
  // Boundary i sits after video i, so i runs 1..n-1. Working in fractions (not
  // video indices) keeps breaks correct when the child switches videos from the
  // session strip — the day's progress is what decides, not the running order.
  function planBreaks(videos) {
    if (videos.length < 2) return [];
    const total = videos.reduce((s, v) => s + v.minutes, 0);
    if (!total) return [];
    let cum = 0;
    const bounds = [];
    for (let i = 0; i < videos.length - 1; i++) {
      cum += videos[i].minutes;
      bounds.push(cum / total);
    }
    const picked = [];
    [1 / 3, 2 / 3].forEach((target) => {
      let best = null;
      bounds.forEach((b) => {
        if (picked.includes(b)) return;
        if (best === null || Math.abs(b - target) < Math.abs(best - target)) best = b;
      });
      if (best !== null) picked.push(best);
    });
    return picked.sort((a, b) => a - b);
  }

  // Rotate within each bucket so the same session never serves a game twice and
  // consecutive sessions differ. Rotation is per-load; a real build would seed
  // this from the child's recent history.
  let breakRotation = Math.floor(Math.random() * 6);
  function gameForBreak(index) {
    const bucket = index === 0 ? BREAK_GAMES.move : BREAK_GAMES.settle;
    return bucket[(breakRotation + index) % bucket.length];
  }

  function prepSession(profileId, sessionOverride) {
    state.profile = KidQData.profiles.find((p) => p.id === profileId) || KidQData.profiles[0];
    const src = sessionOverride || KidQData.sessions[state.profile.id];
    state.session = src ? { totalMinutes: src.totalMinutes, replay: !!src.replay, videos: [...src.videos] } : null;
    state.watched = new Set();
    state.progress = {};
    state.current = null;
    state.breaks = state.session ? planBreaks(state.session.videos) : [];
    state.breaksTaken = 0;
    return !!state.session;
  }

  // The household label for whoever picked the session. One family account, so
  // it is the same everywhere it appears rather than varying per video.
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
    const t = 0.06 + p * 0.88;
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
      btn.setAttribute("aria-label", `${p.name} — tap to start your day`);
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
    markDemo("login");
  }

  /* ---------- sunrise ---------- */
  const sunrise = $("#screen-sunrise");
  const startSun = $("#start-sun");
  function startSunrise() {
    sunrise.classList.remove("risen", "tapped");
    $("#screen-all-done").classList.remove("hifived");
    $("#whatsnext").classList.remove("in", "choose");
    $("#sunrise-greet").innerHTML = `Good morning,<br>${state.profile.name}!`;
    const s = state.session;
    $("#sunrise-heartline").innerHTML = s.replay
      ? `<b>Yesterday's videos, one more time</b> · ${s.totalMinutes} min`
      : `<b>${pickerNameHtml()} picked ${s.videos.length} videos</b> · ${s.totalMinutes} min`;
    showScreen("screen-sunrise");
    markDemo("sunrise");
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

  let demoSkyP = null; // demo-bar override to preview day stages
  function updateSky() {
    const p = demoSkyP !== null ? demoSkyP : sessionProgress();
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
    demoSkyP = null;
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
    if (unwatched().length === 0) startSunset();
    else if (breakIsDue()) startPlaytimeSeam();
    else autoAdvance();
  });

  // A break is due when the day has passed the next planned break point and the
  // child hasn't taken it yet. Breaks themselves never advance the sun.
  function breakIsDue() {
    if (state.breaksTaken >= state.breaks.length) return false;
    return sessionProgress() >= state.breaks[state.breaksTaken] - 0.001;
  }

  // The parent's picks play through on their own: one video rolls into the next
  // after a short dip, with no tap. This is not feed autoplay - the list is
  // finite, parent-chosen, and still ends at sunset.
  //
  // Breaks are the deliberate exception. Coming back from one always needs a tap
  // (see startChoice), because a break exists to interrupt screen time, and
  // sliding straight out of it into another video would undo that.
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
    watching.classList.toggle("paused", pausing);
    watchPause.setAttribute("aria-label", pausing ? "Resume" : "Pause");
    if (pausing) video.pause(); else attemptPlay(video);
  });

  /* ---------- sunset → all done ---------- */
  function startSunset() {
    watching.classList.add("setting");
    safePlay(chime);
    later(startAllDone, 1500);
  }

  /* ---------- playtime seam + activity breaks ---------- */
  function startPlaytimeSeam(forceGame) {
    video.pause();
    showScreen("screen-playtime");
    const game = forceGame || gameForBreak(state.breaksTaken);
    if (!forceGame) state.breaksTaken += 1;
    later(() => (game === "find" ? startFind() : startBreathing()), 1600);
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
  // Red is #C2543F, not the coral heart token: coral doesn't read as red to a
  // 2-4 year old learning colours, and this red clears 3:1 on the sky unaided.
  const FIND_COLOURS = [
    { name: "red",   hex: "#C2543F" },
    { name: "blue",  hex: "#6FA8DC" },
    { name: "green", hex: "#5FA88A" }
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
    $("#find-sub").textContent = "Look around the room. Tap the sun when you find them.";
    // said after showScreen below, so the screen is up before the voice starts
    // the sun is the control, so it is disabled rather than hidden - hiding it
    // would remove the mascot from the celebration
    $("#find-done").disabled = false;
    showScreen("screen-find");
    later(() => say(`Find 3 ${c.name} things. Look around the room, and tap the sun when you find them.`), 600);
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

  /* ---------- after-break choice (within the parent's picks) ---------- */
  const choiceScreen = $("#screen-choice");
  const choiceSun = $("#choice-sun");
  function startChoice() {
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
  }
  choiceSun.addEventListener("click", () => {
    if (!choiceScreen.classList.contains("active")) return;
    safePlay(jingle);
    startWatching(unwatched()[0]);
  });

  /* ---------- all done ---------- */
  const allDone = $("#screen-all-done");

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
  function startAllDone() {
    allDone.classList.remove("hifived");
    initHifive();
    if (hfAnim) {
      // entrance: the two hands rise in and wait, palms open, for the child's five
      if (reducedMotion) hfAnim.goToAndStop(HF_IDLE, true);
      else hfAnim.playSegments([[0, HF_IDLE]], true);
    }
    $("#done-gn").innerHTML = `Good night,<br>${state.profile ? state.profile.name : "Aarav"}! 🌙`;
    const wn = $("#whatsnext");
    wn.classList.remove("in", "choose");
    const row = $("#wn-row");
    row.innerHTML = "";
    KidQData.whatsNext.forEach((item) => {
      const card = document.createElement("div");
      card.className = "wn-card" + (item.picked ? " wn-pick" : "");
      card.innerHTML = `<div class="scene">${SCENES[item.scene] || ""}</div><span>${item.label}</span>` +
        (item.picked ? `<svg class="wn-pick-heart" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17 C4 12 2 8.5 4.2 6.2 A3.4 3.4 0 0 1 10 7.4 A3.4 3.4 0 0 1 15.8 6.2 C18 8.5 16 12 10 17 Z" fill="#E2705E"/></svg>` : "");
      row.appendChild(card);
    });
    showScreen("screen-all-done");
    later(() => wn.classList.add("in"), 700);
    later(() => wn.classList.add("choose"), 2700);
  }
  $("#high-five").addEventListener("click", () => {
    if (allDone.classList.contains("hifived")) return;
    allDone.classList.add("hifived");
    if (hfAnim) {
      if (reducedMotion) hfAnim.goToAndStop(HF_DONE_POSE, true);
      else hfAnim.playSegments([[HF_IDLE, HF_END]], true); // the clap + floating dots
    }
    safePlay(chime);
    pop($("#done-moon"), true); // the moon wakes up and wobbles back at you
  });
  $("#done-moon").addEventListener("click", (e) => pop(e.currentTarget, true));

  /* ---------- no session ---------- */
  function startNoSession() {
    const y = state.profile ? KidQData.yesterdays[state.profile.id] : null;
    $("#yesterday-btn").style.display = y ? "" : "none";
    showScreen("screen-no-session");
    markDemo("no-session");
  }
  $("#sleeping-sun").addEventListener("click", (e) => {
    const el = e.currentTarget;
    el.classList.remove("stir"); void el.offsetWidth; el.classList.add("stir");
  });
  $("#waiting-moon").addEventListener("click", (e) => pop(e.currentTarget, true));
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
  $("#cast-pause").addEventListener("click", () => cast.classList.toggle("paused"));

  /* ---------- demo bar ---------- */
  function markDemo(name) {
    $$("[data-demo]").forEach((b) => b.classList.toggle("selected", b.dataset.demo === name));
  }
  $$("[data-demo]").forEach((b) => b.addEventListener("click", () => {
    clearTimers();
    video.pause();
    const name = b.dataset.demo;
    if (name === "login") startLogin();
    if (name === "sunrise") { prepSession("aarav"); startSunrise(); }
    if (name === "no-session") { prepSession("meera"); startNoSession(); }
    if (name === "night-light") {
      $("#night-greet").innerHTML = `Good night,<br>${state.profile ? state.profile.name : "Aarav"}!`;
      showScreen("screen-night-light");
      markDemo("night-light");
    }
    if (name === "cast") { showScreen("screen-cast"); markDemo("cast"); }
  }));
  // jump straight to either break screen without playing through a whole video
  $$("[data-break]").forEach((b) => b.addEventListener("click", () => {
    clearTimers();
    video.pause();
    if (!state.session) prepSession("aarav");
    (b.dataset.break === "find" ? startFind : startBreathing)();
  }));

  $$("[data-sky]").forEach((b) => b.addEventListener("click", () => {
    if (!state.session || !state.current) { prepSession("aarav"); startWatching(unwatched()[0]); }
    else if (!watching.classList.contains("active")) showScreen("screen-watching");
    demoSkyP = Number(b.dataset.sky);
    watching.classList.toggle("setting", !!b.dataset.dusk);
    updateSky();
  }));

  $("#restart-flow").addEventListener("click", () => { clearTimers(); video.pause(); startSplash(); });

  $("#motion-toggle").addEventListener("click", (e) => {
    reducedMotion = !reducedMotion;
    document.documentElement.classList.toggle("reduce-motion", reducedMotion);
    e.currentTarget.setAttribute("aria-pressed", String(reducedMotion));
    e.currentTarget.textContent = reducedMotion ? "Motion reduced" : "Reduce motion";
  });
  if (reducedMotion) {
    document.documentElement.classList.add("reduce-motion");
    $("#motion-toggle").setAttribute("aria-pressed", "true");
    $("#motion-toggle").textContent = "Motion reduced";
  }

  window.addEventListener("resize", () => {
    if (watching.classList.contains("active") && state.session) updateSky();
    if (choiceScreen.classList.contains("active") && state.session) positionSun(choiceSun, sessionProgress());
    positionSun($("#cast-sun"), 0.5);
  });

  startSplash();
})();
