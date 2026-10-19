// Race replay: plays back replay/<session_key>.json lap by lap.
// Everything was computed in the lakehouse (gold_race_lap_order); this file only animates it.
//
// The rest of the site re-renders with innerHTML on every click. The replay can't work like
// that (it would restart on every tick), so it owns its own DOM: one row per driver that
// stays in place and slides to its new position with a CSS transform.

import type { ReplayEntry, ReplayFile } from "./types";
import { colour, esc, lapTime } from "./format";

const SPEEDS = [0.5, 1, 2, 4]; // laps per second

// Replay files are small and never change, so each one is fetched at most once
const cache = new Map<number, Promise<ReplayFile | null>>();
function load(key: number): Promise<ReplayFile | null> {
  if (!cache.has(key)) {
    cache.set(
      key,
      fetch(`data/replay/${key}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    );
  }
  return cache.get(key)!;
}

// Survives re-renders of the page (e.g. "Show all drivers"), so the replay doesn't jump back to the grid
interface PlayState {
  key: number;
  index: number; // position in data.laps, not the lap number
  speed: number;
  playing: boolean;
}
let state: PlayState | null = null;
let stopCurrent: (() => void) | null = null;

export function stopReplay(): void {
  stopCurrent?.();
  stopCurrent = null;
}

export function mountReplay(root: HTMLElement, key: number): void {
  stopReplay();
  let alive = true;
  stopCurrent = () => {
    alive = false;
  };
  root.innerHTML = `<p class="replay-msg">Loading replay…</p>`;

  load(key).then((data) => {
    if (!alive || !root.isConnected) return;
    if (!data || data.laps.length < 2) {
      root.innerHTML = `<p class="replay-msg">No lap data for this race.</p>`;
      return;
    }
    if (!state || state.key !== key) state = { key, index: 0, speed: 1, playing: false };
    stopCurrent = start(root, data, state);
  });
}

// ---------- Precomputed lookups ----------

interface Shown {
  driver: number;
  pos: number; // 0-based slot in the tower
  gap: string;
  lap: string; // last lap time
  purple: boolean; // fastest lap of the race so far
  out: boolean;
}

function prepare(data: ReplayFile) {
  const n = data.drivers.length;
  const last = data.laps.length - 1;
  const finalLap = data.laps[last].lap;

  // Each driver's entry per lap index, and the last lap index they completed
  const entries: (ReplayEntry | undefined)[][] = data.drivers.map(() => []);
  const firstSeen = new Array<number>(n).fill(Infinity);
  const lastSeen = new Array<number>(n).fill(-1);
  data.laps.forEach((l, i) =>
    l.order.forEach((e) => {
      entries[e[0]][i] = e;
      firstSeen[e[0]] = Math.min(firstSeen[e[0]], i);
      lastSeen[e[0]] = i;
    }),
  );

  // Fastest lap so far, at each point in the race
  const bestUpTo: (number | null)[] = [];
  let best: number | null = null;
  data.laps.forEach((l) => {
    for (const e of l.order) if (e[3] !== null && (best === null || e[3] < best)) best = e[3];
    bestUpTo.push(best);
  });

  const gapText = (e: ReplayEntry, isLeader: boolean, isGrid: boolean) => {
    if (isGrid) return "";
    if (isLeader) return "Leader";
    if (e[2] > 0) return `+${e[2]} lap${e[2] > 1 ? "s" : ""}`;
    return e[1] === null ? "" : `+${e[1].toFixed(3)}`;
  };

  // The tower at lap index i
  function frame(i: number): Shown[] {
    const isGrid = data.laps[i].lap === 0;
    const bestNow = bestUpTo[i];
    const shown: Shown[] = data.laps[i].order.map((e, k) => ({
      driver: e[0],
      pos: k,
      gap: gapText(e, k === 0, isGrid),
      lap: lapTime(e[3]),
      purple: e[3] !== null && e[3] === bestNow,
      out: false,
    }));

    // Cars missing on this lap: either they finished a lap or more down (still classified),
    // retired, or started from the pit lane and haven't completed a lap yet
    const present = new Set(shown.map((s) => s.driver));
    const lapped: { d: number; e: ReplayEntry; seen: number }[] = [];
    const retired: { d: number; e?: ReplayEntry; seen: number }[] = [];
    for (let d = 0; d < n; d++) {
      if (present.has(d)) continue;
      const seen = Math.min(lastSeen[d], i);
      const e = seen >= 0 && firstSeen[d] <= i ? entries[d][seen] : undefined;
      if (e && data.laps[seen].lap + e[2] >= finalLap && lastSeen[d] === seen) lapped.push({ d, e, seen });
      else retired.push({ d, e, seen });
    }
    lapped.sort((a, b) => b.seen - a.seen || data.laps[a.seen].order.indexOf(a.e) - data.laps[b.seen].order.indexOf(b.e));
    retired.sort((a, b) => b.seen - a.seen);

    for (const x of lapped)
      shown.push({ driver: x.d, pos: shown.length, gap: gapText(x.e, false, false), lap: lapTime(x.e[3]), purple: false, out: false });
    for (const x of retired) {
      const started = x.e && firstSeen[x.d] <= i;
      shown.push({
        driver: x.d,
        pos: shown.length,
        gap: started ? "OUT" : "PIT",
        lap: started && data.laps[x.seen].lap > 0 ? `lap ${data.laps[x.seen].lap}` : "",
        purple: false,
        out: true,
      });
    }
    return shown;
  }

  return { n, last, finalLap, frame };
}

// ---------- The player ----------

function start(root: HTMLElement, data: ReplayFile, st: PlayState): () => void {
  const { n, last, finalLap, frame } = prepare(data);
  st.index = Math.min(st.index, last);

  root.innerHTML = `
    <div class="replay">
      <div class="replay-bar">
        <button class="replay-play" type="button" data-replay="play"></button>
        <div class="replay-lap" aria-live="off">
          <span class="replay-lap-label">Lap</span>
          <strong class="replay-lap-no"></strong><span class="replay-lap-of">/ ${finalLap}</span>
        </div>
        <input class="replay-slider" type="range" min="0" max="${last}" step="1" aria-label="Lap" />
        <label class="replay-speed">
          <span class="visually-hidden">Playback speed</span>
          <select>
            ${SPEEDS.map((s) => `<option value="${s}">${s} lap${s === 1 ? "" : "s"}/s</option>`).join("")}
          </select>
        </label>
      </div>
      <ol class="replay-tower" style="--rows:${n}">
        ${data.drivers
          .map(
            (d, i) => `
          <li class="rp-row" data-d="${i}" style="--team:${colour(d.team_colour)}">
            <span class="rp-pos"></span>
            <span class="rp-delta"></span>
            <span class="bar"></span>
            <span class="rp-who"><span class="code">${esc(d.acronym)}</span><span class="rp-team">${esc(d.team)}</span></span>
            <span class="rp-gap"></span>
            <span class="rp-lap"></span>
          </li>`,
          )
          .join("")}
      </ol>
    </div>`;

  const play = root.querySelector<HTMLButtonElement>(".replay-play")!;
  const lapNo = root.querySelector<HTMLElement>(".replay-lap-no")!;
  const slider = root.querySelector<HTMLInputElement>(".replay-slider")!;
  const speed = root.querySelector<HTMLSelectElement>(".replay-speed select")!;
  const tower = root.querySelector<HTMLElement>(".replay-tower")!;
  const rows = [...root.querySelectorAll<HTMLElement>(".rp-row")];
  let prevPos: number[] | null = null;
  let timer: number | undefined;

  speed.value = String(st.speed);

  function draw(): void {
    const shown = frame(st.index);
    const lap = data.laps[st.index].lap;
    lapNo.textContent = lap === 0 ? "Grid" : String(lap);
    slider.value = String(st.index);
    slider.style.setProperty("--fill", `${(st.index / last) * 100}%`);

    const pos: number[] = [];
    for (const s of shown) {
      const row = rows[s.driver];
      pos[s.driver] = s.pos;
      row.style.setProperty("--pos", String(s.pos));
      row.classList.toggle("is-out", s.out);
      row.querySelector(".rp-pos")!.textContent = s.out ? "" : String(s.pos + 1);
      row.querySelector(".rp-gap")!.textContent = s.gap;
      const lapEl = row.querySelector<HTMLElement>(".rp-lap")!;
      lapEl.textContent = s.lap;
      lapEl.classList.toggle("purple", s.purple);

      // Places gained or lost since the previous frame
      const delta = row.querySelector<HTMLElement>(".rp-delta")!;
      const moved = prevPos && !s.out ? prevPos[s.driver] - s.pos : 0;
      delta.textContent = moved > 0 ? `▲${moved}` : moved < 0 ? `▼${-moved}` : "";
      delta.className = `rp-delta ${moved > 0 ? "up" : moved < 0 ? "down" : ""}`;
    }
    prevPos = pos;
  }

  function setPlaying(on: boolean): void {
    st.playing = on && st.index < last;
    play.textContent = st.playing ? "❚❚ Pause" : st.index >= last ? "↺ Replay" : "▶ Play";
    play.setAttribute("aria-label", st.playing ? "Pause" : "Play");
    window.clearInterval(timer);
    if (st.playing) {
      const ms = 1000 / st.speed;
      tower.style.setProperty("--dur", `${Math.min(700, ms * 0.8)}ms`);
      timer = window.setInterval(() => {
        if (st.index < last) {
          st.index++;
          draw();
        }
        if (st.index >= last) setPlaying(false); // also covers dragging the slider to the end mid-play
      }, ms);
    }
  }

  play.addEventListener("click", () => {
    if (!st.playing && st.index >= last) {
      st.index = 0; // start over from the grid
      prevPos = null;
      draw();
    }
    setPlaying(!st.playing);
  });
  slider.addEventListener("input", () => {
    st.index = Number(slider.value);
    prevPos = null; // jumping: no ▲▼ arrows
    draw();
  });
  speed.addEventListener("change", () => {
    st.speed = Number(speed.value);
    if (st.playing) setPlaying(true);
  });

  draw();
  setPlaying(st.playing);
  return () => window.clearInterval(timer);
}
