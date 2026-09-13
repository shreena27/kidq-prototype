# KidQ — App Prototype

An interactive design prototype for **KidQ**, a parent-curated, session-based,
no-autoplay kids video app for India.

**▶ Live: https://shreena27.github.io/kidq-prototype/**

## What this is

This is the **design deliverable** — a working front-end prototype used to review
and react to the child-mode experience. It is not the product build. The backend
and implementation live in a separate repository.

Everything the backend will eventually own is isolated in a single object,
`KidQData`, at the top of `kidq-desktop-app.js`: profiles, sessions per profile
(including the deliberate "no session today" case), yesterday's sessions, and the
what's-next cards. Every other line only ever reads from it. Swapping that object
for real API responses of the same shape is the whole integration.

## The idea

A parent picks a handful of videos. The child gets exactly those, in a session
that visibly ends. There is no algorithm, no autoplay, no infinite feed.

Time is shown as a **sky**: the sun crosses an arc from sunrise to sunset across
the session, driven by real playback progress, so a child who cannot read a clock
can still see how much of the day is left. When the sun sets, the session is over.

Between videos the sun comes down to play — short activity breaks that break up
screen time rather than extend it.

## Walking through it

The demo bar in the bottom-right corner is a review aid, not part of the product.
Use it to restart the flow or jump straight to any screen.

The full journey: splash → who's watching → sunrise → watching → playtime →
activity break → watching → sunset → all done → night-light. Standalone screens
for the no-session state and cast mode are reachable from the demo bar.

Three things worth looking for:

- **The parent's picks play through on their own.** One video rolls into the next
  without a tap. This is not feed autoplay: the list is finite, the parent chose
  it, and it still ends at sunset. Coming back from an activity break is the one
  deliberate exception — that always needs a tap, because a break exists to
  interrupt screen time and sliding straight out of it would undo that.
- **Breaks land on time, not on video count.** A session gets exactly two breaks,
  at the one-third and two-thirds marks of the parent's allotted minutes, each
  snapping to the nearest video boundary so a break never interrupts a video.
- **The sun tracks allotted time, not videos finished.** Switching between videos
  mid-session never rewinds it, and rewatching something already finished does not
  push it forward.

## Files

| File | What it is |
|---|---|
| `index.html` | The app |
| `kidq-desktop-app.css` | All styling, responsive via container queries |
| `kidq-desktop-app.js` | State machine + `KidQData` (the backend integration point) |
| `kidq-hifive-anim.js` | High-five Lottie, recoloured to brand |
| `kidq-breathe-anim.js` | Breathing-sun Lottie, recoloured to brand |
| `proposal-src/` | Demo video, thumbnails, and audio |

## Regenerating this folder

Do not hand-edit files here. They are generated from the KidQ working sources by
`build-site.sh`, which wraps the app fragment in a real HTML document (it has no
`<head>` or charset of its own, and mojibakes without one). Re-run that script
after any source change, then commit.

## Credits

- Demo footage: *Big Buck Bunny* © Blender Foundation, [CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/)
- Breathing animation: *"Sunrise – Breathe in Breathe out"* by Palak Jain
  (LottieFiles, Lottie Simple License), recoloured to brand
- High-five animation: *"Hand clap 2"* by Nicolas Binaghi
  (LottieFiles, free licence), recoloured to brand
- Typefaces: Baloo 2 and Mukta by [Ek Type](https://ektype.in/)
