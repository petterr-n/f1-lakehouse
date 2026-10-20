// Track map for the replay: the circuit outline plus one dot per car, moving in race time.
// Data comes from map/<session_key>.json (gold_track_outline + gold_location_frames).
//
// The replay works in laps, the map in seconds. `laps` in the file says when the leader
// finished each lap, so a lap on the slider becomes a moment in the race, and between two
// laps the dots are animated smoothly through every position in between.

import type { MapFile, ReplayDriver } from "./types";
import { colour, esc } from "./format";

const SVG = "http://www.w3.org/2000/svg";

// Map files are big-ish (~600 KB) and never change: fetch each at most once
const cache = new Map<number, Promise<MapFile | null>>();
export function loadMap(key: number): Promise<MapFile | null> {
  if (!cache.has(key)) {
    cache.set(
      key,
      fetch(`data/map/${key}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    );
  }
  return cache.get(key)!;
}

export interface TrackMap {
  /** Race time (s after the start) for a lap number on the slider. Lap 0 = the start. */
  timeOfLap(lap: number): number;
  /** Move the cars to race time t, animated over ms (0 = jump). Cars in `hidden` are not drawn. */
  goTo(t: number, ms: number, hidden: Set<string>): void;
  /** Stop the cars where they are right now (pause). */
  pause(): void;
  /** The race time currently shown, in seconds after the start. */
  time(): number;
  destroy(): void;
}

export function createTrackMap(
  host: HTMLElement,
  map: MapFile,
  drivers: ReplayDriver[],
  poleId?: string, // the car that started first: the line is drawn where it stood on the grid
): TrackMap {
  // OpenF1's y axis points up, SVG's points down: flip y once here
  const outline = map.outline.map(([x, y]) => [x, -y] as const);
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const size = Math.max(maxX - minX, maxY - minY);
  const pad = size * 0.06;
  const dot = size * 0.014;

  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`);
  svg.setAttribute("class", "track-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Track map with the position of every car");

  const d = "M" + outline.map(([x, y]) => `${x},${y}`).join("L") + "Z";

  // Start line: where the pole sitter stood when the race started, snapped onto the outline.
  // Falls back to the outline's first point (where the fast lap began) if that's unknown.
  let k = 0;
  const pole = map.cars.find((c) => c.id === poleId);
  if (pole) {
    let gx: number | null = null, gy: number | null = null;
    for (let i = 0; i + 1 < pole.xy.length && i < 20; i += 2) {
      if (pole.xy[i] != null && pole.xy[i + 1] != null) {
        gx = pole.xy[i]!; gy = -pole.xy[i + 1]!;
        break;
      }
    }
    if (gx !== null && gy !== null) {
      let best = Infinity;
      outline.forEach(([x, y], i) => {
        const dist = (x - gx!) ** 2 + (y - gy!) ** 2;
        if (dist < best) { best = dist; k = i; }
      });
    }
  }
  const [sx, sy] = outline[k];
  const [nx, ny] = outline[(k + 4) % outline.length];
  const len = Math.hypot(nx - sx, ny - sy) || 1;
  const [px, py] = [-(ny - sy) / len, (nx - sx) / len]; // perpendicular to the driving direction
  const half = dot * 2.4;
  const bar = `x1="${sx + px * half}" y1="${sy + py * half}" x2="${sx - px * half}" y2="${sy - py * half}"`;

  svg.innerHTML = `
    <path class="track-edge" d="${d}" stroke-width="${dot * 2.6}" />
    <path class="track-line" d="${d}" stroke-width="${dot * 0.35}" />
    <g class="track-finish">
      <title>Start / finish line</title>
      <line ${bar} stroke-width="${dot * 1.1}" class="finish-base" />
      <line ${bar} stroke-width="${dot * 1.1}" stroke-dasharray="${dot * 0.55}" class="finish-check" />
    </g>
    <g class="track-cars"></g>`;
  const layer = svg.querySelector("g.track-cars")!;

  // One dot per car that has positions; keyed by driver id, the same key the replay uses
  const byId = new Map(drivers.map((dr) => [dr.id, dr]));
  const cars = map.cars
    .filter((c) => byId.has(c.id))
    .map((c) => {
      const dr = byId.get(c.id)!;
      const g = document.createElementNS(SVG, "g");
      g.setAttribute("class", "car");
      g.style.setProperty("--team", colour(dr.team_colour));
      g.innerHTML = `
        <title>${esc(dr.name)}</title>
        <circle r="${dot}" />
        <text x="${dot * 1.5}" y="${dot * 0.55}" font-size="${dot * 1.9}">${esc(dr.acronym)}</text>`;
      layer.appendChild(g);
      return { id: c.id, xy: c.xy, g };
    });

  host.replaceChildren(svg);

  // ---- time lookups ----
  const lapTimes = new Map(map.laps.map(([lap, t]) => [lap, t]));
  const end = (map.cars[0]?.xy.length ?? 2) / 2 - 1;

  function timeOfLap(lap: number): number {
    if (lap <= 0) return 0;
    for (let l = lap; l > 0; l--) {
      const t = lapTimes.get(l);
      if (t !== undefined) return Math.min(t, end * map.step);
    }
    return 0;
  }

  // Position at time t, interpolated between the two nearest samples. null = no data then.
  function posAt(xy: (number | null)[], t: number): [number, number] | null {
    const f = Math.max(0, t / map.step);
    const i = Math.min(Math.floor(f), end);
    const x0 = xy[2 * i], y0 = xy[2 * i + 1];
    if (x0 === null || y0 === null || x0 === undefined || y0 === undefined) return null;
    const a = f - i;
    const x1 = xy[2 * i + 2], y1 = xy[2 * i + 3];
    if (!a || x1 == null || y1 == null) return [x0, -y0];
    return [x0 + (x1 - x0) * a, -(y0 + (y1 - y0) * a)];
  }

  let now = 0;
  let hidden = new Set<string>();
  function render(t: number): void {
    now = t;
    for (const c of cars) {
      const p = hidden.has(c.id) ? null : posAt(c.xy, t);
      if (!p) {
        c.g.style.display = "none";
        continue;
      }
      c.g.style.display = "";
      c.g.setAttribute("transform", `translate(${p[0].toFixed(1)},${p[1].toFixed(1)})`);
    }
  }

  let raf = 0;
  function goTo(target: number, ms: number, hide: Set<string>): void {
    cancelAnimationFrame(raf);
    hidden = hide;
    if (ms <= 0 || target <= now) {
      render(target); // jumping, or going backwards: no animation
      return;
    }
    const from = now;
    const started = performance.now();
    const step = (time: number) => {
      const k = Math.min(1, (time - started) / ms);
      render(from + (target - from) * k);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  return {
    timeOfLap,
    goTo,
    pause: () => cancelAnimationFrame(raf), // `now` stays where the animation got to
    time: () => now,
    destroy: () => cancelAnimationFrame(raf),
  };
}
