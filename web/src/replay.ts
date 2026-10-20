// Race replay: plays back replay/<session_key>.json lap by lap.
// Everything was computed in the lakehouse (gold_race_lap_order); this file only animates it.
//
// The rest of the site re-renders with innerHTML on every click. The replay can't work like
// that (it would restart on every tick), so it owns its own DOM: one row per driver that
// stays in place and slides to its new position with a CSS transform.

import type { MapFile, Neutralisation, ReplayEntry, ReplayFile } from "./types";
import { createTrackMap, loadMap } from "./trackmap";
import { colour, esc, lapTime } from "./format";

// Playback speed as a multiple of real race time: at 20x a 95-second lap takes ~5 s.
// Each lap gets its own duration, so safety car laps play slower, just like in the race.
const SPEEDS = [5, 10, 20, 50, 100];
const DEFAULT_SPEED = 20;

const TYRE_NAMES: Record<string, string> = { S: "Soft", M: "Medium", H: "Hard", I: "Intermediate", W: "Wet" };
const FLAG_TEXT: Record<Neutralisation["kind"], string> = {
  SC: "Safety car",
  VSC: "Virtual safety car",
  RED: "Red flag",
};

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

  // The map file is optional: only current-season races with enough position data have one
  Promise.all([load(key), loadMap(key)]).then(([data, map]) => {
    if (!alive || !root.isConnected) return;
    if (!data || data.laps.length < 2) {
      root.innerHTML = `<p class="replay-msg">No lap data for this race.</p>`;
      return;
    }
    if (!state || state.key !== key) state = { key, index: 0, speed: DEFAULT_SPEED, playing: false };
    stopCurrent = start(root, data, state, map);
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
  tyre: string | null; // S / M / H / I / W
  age: number | null; // laps on this set
  pitted: boolean; // came into the pits at the end of this lap
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

  // Tyre and pit stop for one entry. On the grid, show the tyre each car starts on (from lap 1).
  const startTyre = (d: number) => entries[d][1]?.[4] ?? null;
  const tyreOf = (e: ReplayEntry, isGrid: boolean) =>
    isGrid
      ? { tyre: startTyre(e[0]), age: null, pitted: false }
      : { tyre: e[4] ?? null, age: e[5] ?? null, pitted: e[6] === 1 };

  // Safety car / VSC / red flag active on a given lap number, if any
  const periods = data.neutralisations ?? [];
  const flagAt = (lap: number): Neutralisation | undefined =>
    lap === 0 ? undefined : periods.find((p) => lap >= p.from && lap <= (p.to ?? finalLap));

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
      ...tyreOf(e, isGrid),
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
      shown.push({
        driver: x.d,
        pos: shown.length,
        gap: gapText(x.e, false, false),
        lap: lapTime(x.e[3]),
        purple: false,
        out: false,
        ...tyreOf(x.e, false),
        pitted: false,
      });
    for (const x of retired) {
      const started = x.e && firstSeen[x.d] <= i;
      shown.push({
        driver: x.d,
        pos: shown.length,
        gap: started ? "OUT" : "PIT",
        lap: started && data.laps[x.seen].lap > 0 ? `lap ${data.laps[x.seen].lap}` : "",
        purple: false,
        out: true,
        tyre: null,
        age: null,
        pitted: false,
      });
    }
    return shown;
  }

  return { n, last, finalLap, frame, flagAt, periods };
}

// ---------- The player ----------

function start(root: HTMLElement, data: ReplayFile, st: PlayState, mapData: MapFile | null): () => void {
  const { n, last, finalLap, frame, flagAt, periods } = prepare(data);

  // Where each period sits on the slider, as a percentage of the race
  const indexOfLap = (lap: number) => Math.max(0, data.laps.findIndex((l) => l.lap >= lap));
  const marks = periods
    .map((p) => {
      const from = indexOfLap(p.from) - 0.5;
      const to = (p.to === null ? last : indexOfLap(p.to)) + 0.5;
      const left = Math.max(0, (from / last) * 100);
      const width = Math.max(0.8, (Math.min(last, to) / last) * 100 - left);
      return `<span class="rp-mark rp-mark-${p.kind.toLowerCase()}" style="left:${left}%;width:${width}%"
                    title="${FLAG_TEXT[p.kind]}, lap ${p.from}${p.to && p.to !== p.from ? `–${p.to}` : ""}"></span>`;
    })
    .join("");
  st.index = Math.min(st.index, last);

  root.innerHTML = `
    <div class="replay">
      <div class="replay-bar">
        <button class="replay-play" type="button" data-replay="play"></button>
        <div class="replay-lap" aria-live="off">
          <span class="replay-lap-label">Lap</span>
          <strong class="replay-lap-no"></strong><span class="replay-lap-of">/ ${finalLap}</span>
        </div>
        <div class="replay-track">
          <input class="replay-slider" type="range" min="0" max="${last}" step="1" aria-label="Lap" />
          <div class="rp-marks" aria-hidden="true">${marks}</div>
        </div>
        <label class="replay-speed">
          <span class="visually-hidden">Playback speed</span>
          <select>
            ${SPEEDS.map((s) => `<option value="${s}">${s}× speed</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="replay-flag" aria-live="polite" hidden></div>
      <div class="replay-body ${mapData ? "has-map" : ""}">
      ${mapData ? `<figure class="replay-map"><div class="track"></div><figcaption>Positions from OpenF1, every ${mapData.step} s</figcaption></figure>` : ""}
      <ol class="replay-tower" style="--rows:${n}">
        ${data.drivers
          .map(
            (d, i) => `
          <li class="rp-row" data-d="${i}" style="--team:${colour(d.team_colour)}">
            <span class="rp-pos"></span>
            <span class="rp-delta"></span>
            <span class="bar"></span>
            <span class="rp-who">
              <span class="code">${esc(d.acronym)}</span><span class="rp-team">${esc(d.team)}</span>
              <span class="rp-pit" hidden>PIT</span>
            </span>
            <span class="rp-tyre"><span class="tyre"></span><span class="tyre-age"></span></span>
            <span class="rp-gap"></span>
            <span class="rp-lap"></span>
          </li>`,
          )
          .join("")}
      </ol>
      </div>
    </div>`;

  const play = root.querySelector<HTMLButtonElement>(".replay-play")!;
  const lapNo = root.querySelector<HTMLElement>(".replay-lap-no")!;
  const slider = root.querySelector<HTMLInputElement>(".replay-slider")!;
  const speed = root.querySelector<HTMLSelectElement>(".replay-speed select")!;
  const tower = root.querySelector<HTMLElement>(".replay-tower")!;
  const flag = root.querySelector<HTMLElement>(".replay-flag")!;
  const rows = [...root.querySelectorAll<HTMLElement>(".rp-row")];
  let prevPos: number[] | null = null;
  let timer: number | undefined;
  // Pole sitter = first car on the grid (lap 0); the start line goes where that car stood
  const grid = data.laps.find((l) => l.lap === 0);
  const poleId = grid?.order[0] ? data.drivers[grid.order[0][0]].id : undefined;
  const map = mapData
    ? createTrackMap(root.querySelector<HTMLElement>(".replay-map .track")!, mapData, data.drivers, poleId)
    : null;

  if (!SPEEDS.includes(st.speed)) st.speed = DEFAULT_SPEED;
  speed.value = String(st.speed);

  // How long a lap took in the race: the leader's lap time (the grid → lap 1 uses lap 1)
  const lapSeconds = (i: number) => {
    const t = data.laps[i]?.order[0]?.[3];
    return t && t > 20 ? t : 90;
  };

  let hiddenOnMap = new Set<string>();

  // ms = how long to animate the map to this lap (0 = jump, -1 = leave the map alone)
  function draw(ms = 0): void {
    const shown = frame(st.index);
    const lap = data.laps[st.index].lap;
    lapNo.textContent = lap === 0 ? "Grid" : String(lap);
    slider.value = String(st.index);
    slider.style.setProperty("--fill", `${(st.index / last) * 100}%`);

    // Banner while a safety car, VSC or red flag is out
    const active = flagAt(lap);
    flag.hidden = !active;
    if (active) {
      flag.textContent = FLAG_TEXT[active.kind];
      flag.className = `replay-flag is-${active.kind.toLowerCase()}`;
    }

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

      // Tyre badge (letter in a ring of the compound's colour) and laps on the set
      const tyre = row.querySelector<HTMLElement>(".tyre")!;
      tyre.textContent = s.tyre ?? "";
      tyre.className = s.tyre ? `tyre t-${s.tyre}` : "tyre";
      tyre.title = s.tyre ? `${TYRE_NAMES[s.tyre] ?? s.tyre}${s.age !== null ? `, ${s.age} laps old` : ""}` : "";
      row.querySelector(".tyre-age")!.textContent = s.age !== null ? String(s.age) : "";
      row.querySelector<HTMLElement>(".rp-pit")!.hidden = !s.pitted;

      // Places gained or lost since the previous frame
      const delta = row.querySelector<HTMLElement>(".rp-delta")!;
      const moved = prevPos && !s.out ? prevPos[s.driver] - s.pos : 0;
      delta.textContent = moved > 0 ? `▲${moved}` : moved < 0 ? `▼${-moved}` : "";
      delta.className = `rp-delta ${moved > 0 ? "up" : moved < 0 ? "down" : ""}`;
    }
    prevPos = pos;

    // Track map: put the cars where they were when the leader finished this lap; retired cars disappear
    hiddenOnMap = new Set(shown.filter((s) => s.out).map((s) => data.drivers[s.driver].id));
    if (map && ms >= 0) map.goTo(map.timeOfLap(lap), ms, hiddenOnMap);
  }

  function setPlaying(on: boolean): void {
    st.playing = on && st.index < last;
    play.textContent = st.playing ? "❚❚ Pause" : st.index >= last ? "↺ Replay" : "▶ Play";
    play.setAttribute("aria-label", st.playing ? "Pause" : "Play");
    window.clearTimeout(timer);
    if (st.playing) playNextLap();
    else map?.pause(); // freeze the cars where they are, mid-lap if need be
  }

  // Play one lap: the map drives through it in (lap time / speed), then the tower shows the order
  // at the end of it. One timeout per lap, because every lap has its own length.
  function playNextLap(): void {
    if (st.index >= last) return setPlaying(false);
    const full = (lapSeconds(st.index + 1) / st.speed) * 1000;
    let ms = full;
    if (map) {
      // Resuming after a pause: the cars may already be part-way round this lap,
      // so only play the part that's left, from where they stopped
      const from = map.timeOfLap(data.laps[st.index].lap);
      const to = map.timeOfLap(data.laps[st.index + 1].lap);
      const done = to > from ? Math.min(1, Math.max(0, (map.time() - from) / (to - from))) : 0;
      ms = full * (1 - done);
      map.goTo(to, ms, hiddenOnMap);
    }
    tower.style.setProperty("--dur", `${Math.min(700, full * 0.6)}ms`);
    timer = window.setTimeout(() => {
      st.index++;
      draw(-1); // the map is already there
      if (st.index >= last) setPlaying(false);
      else playNextLap();
    }, ms);
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
    if (st.playing) setPlaying(true); // carry on playing from the new lap
  });
  speed.addEventListener("change", () => {
    st.speed = Number(speed.value);
    if (st.playing) setPlaying(true); // carries on from where the cars are, at the new speed
  });

  draw();
  setPlaying(st.playing);
  return () => {
    window.clearTimeout(timer);
    map?.destroy();
  };
}
