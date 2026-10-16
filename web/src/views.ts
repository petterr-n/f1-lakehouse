import type {
  ConstructorStanding,
  DriverStanding,
  QualifyingResult,
  QualifyingSession,
  RaceResult,
  RaceSession,
  RoundStandings,
  Tab,
  Weekend,
} from "./types";
import { colour, date, esc, lapTime, points, raceGap } from "./format";

export const TAB_LABELS: Record<Tab, string> = {
  race: "Race",
  qualifying: "Qualifying",
  sprint: "Sprint",
  sprintQualifying: "Sprint Qualifying",
};

export function tabsFor(w: Weekend): Tab[] {
  const tabs: Tab[] = [];
  if (w.race) tabs.push("race");
  if (w.qualifying) tabs.push("qualifying");
  if (w.sprint) tabs.push("sprint");
  if (w.sprintQualifying) tabs.push("sprintQualifying");
  return tabs;
}

const isSprintWeekend = (w: Weekend) => Boolean(w.sprint || w.sprintQualifying);

// ---------- Round picker ----------

export function roundStrip(weekends: Weekend[], selected: Weekend): string {
  return `
    <nav class="rounds" aria-label="Race weekends">
      ${weekends
        .map(
          (w) => `
        <button class="round ${w === selected ? "is-active" : ""}" data-round="${w.round}"
                aria-current="${w === selected ? "true" : "false"}">
          <span class="round-no">R${w.round}${isSprintWeekend(w) ? `<span class="sprint-dot" title="Sprint weekend">S</span>` : ""}</span>
          <span class="round-name">${esc(w.location)}</span>
        </button>`,
        )
        .join("")}
    </nav>`;
}

// ---------- Weekend hero ----------

interface PodiumEntry {
  pos: number;
  acronym: string;
  name: string;
  team: string;
  colour: string | null;
  detail: string;
}

function podiumFor(w: Weekend, tab: Tab): PodiumEntry[] {
  const race = tab === "race" ? w.race : tab === "sprint" ? w.sprint : undefined;
  if (race) {
    return race.results
      .filter((r) => r.position !== null && r.position <= 3)
      .map((r) => ({
        pos: r.position!,
        acronym: r.acronym,
        name: r.name,
        team: r.team,
        colour: r.team_colour,
        detail: raceGap(r),
      }));
  }
  const q = tab === "qualifying" ? w.qualifying : w.sprintQualifying;
  if (!q) return [];
  const pole = bestTime(q.results[0]);
  return q.results
    .filter((r) => r.position !== null && r.position <= 3)
    .map((r) => {
      const t = bestTime(r);
      return {
        pos: r.position!,
        acronym: r.acronym,
        name: r.name,
        team: r.team,
        colour: r.team_colour,
        detail: r.position === 1 || t === null || pole === null ? lapTime(t) : `+${(t - pole).toFixed(3)}`,
      };
    });
}

export function hero(w: Weekend, tab: Tab): string {
  const podium = podiumFor(w, tab);
  // Classic podium order: P2, P1, P3
  const ordered = [podium[1], podium[0], podium[2]].filter(Boolean);
  const isQuali = tab === "qualifying" || tab === "sprintQualifying";

  return `
    <header class="hero">
      <div class="hero-text">
        <p class="eyebrow">Round ${w.round} · ${w.season}${isSprintWeekend(w) ? ` · <span class="tag">Sprint weekend</span>` : ""}</p>
        <h1 class="hero-title">${esc(w.name)}</h1>
        <p class="hero-meta">${esc([w.location, w.country].filter(Boolean).join(", "))} · ${date(w.date)}</p>
      </div>
      <ol class="podium" aria-label="${isQuali ? "Top three in qualifying" : "Podium"}">
        ${ordered
          .map(
            (p) => `
          <li class="podium-step p${p.pos}" style="--team:${colour(p.colour)}">
            <span class="podium-pos">${isQuali && p.pos === 1 ? "POLE" : `P${p.pos}`}</span>
            <span class="podium-code">${esc(p.acronym)}</span>
            <span class="podium-name">${esc(p.name)}</span>
            <span class="podium-team">${esc(p.team)}</span>
            <span class="podium-detail">${esc(p.detail)}</span>
          </li>`,
          )
          .join("")}
      </ol>
    </header>`;
}

// ---------- Highlight tiles ----------

function tile(label: string, value: string, sub: string, team?: string | null, accent = ""): string {
  return `
    <div class="tile ${accent}" ${team !== undefined ? `style="--team:${colour(team)}"` : ""}>
      <span class="tile-label">${label}</span>
      <span class="tile-value">${value}</span>
      <span class="tile-sub">${sub}</span>
    </div>`;
}

export function highlights(w: Weekend, tab: Tab): string {
  const tiles: string[] = [];

  const race = tab === "race" ? w.race : tab === "sprint" ? w.sprint : undefined;
  if (race) {
    const quali = tab === "race" ? w.qualifying : w.sprintQualifying;
    const pole = quali?.results.find((r) => r.position === 1);
    if (pole) tiles.push(tile("Pole", esc(pole.acronym), lapTime(bestTime(pole)), pole.team_colour));

    const fl = race.results.find((r) => r.fastest_lap);
    if (fl) tiles.push(tile("Fastest lap", esc(fl.acronym), lapTime(fl.best_lap), fl.team_colour, "is-purple"));

    const mover = [...race.results]
      .filter((r) => r.gained !== null && r.status === "finished")
      .sort((a, b) => b.gained! - a.gained!)[0];
    if (mover && mover.gained! > 0)
      tiles.push(tile("Biggest mover", esc(mover.acronym), `+${mover.gained} places (P${mover.grid} → P${mover.position})`, mover.team_colour));

    const finished = race.results.filter((r) => r.status === "finished").length;
    tiles.push(tile("Finishers", `${finished}<small>/${race.results.length}</small>`, `${race.results.length - finished} did not finish`));
  } else {
    const q = tab === "qualifying" ? w.qualifying : w.sprintQualifying;
    if (!q) return "";
    const [p1, p2] = q.results;
    if (p1) tiles.push(tile("Pole time", lapTime(bestTime(p1)), esc(p1.name), p1.team_colour, "is-purple"));
    const t1 = p1 && bestTime(p1);
    const t2 = p2 && bestTime(p2);
    if (t1 && t2) tiles.push(tile("Front-row gap", `${(t2 - t1).toFixed(3)}s`, `${esc(p1.acronym)} ahead of ${esc(p2.acronym)}`));
    for (const stage of ["q1", "q2"] as const) {
      const best = fastestIn(q, stage);
      if (best) tiles.push(tile(`Fastest in ${stage.toUpperCase()}`, esc(best.acronym), lapTime(best[stage]), best.team_colour));
    }
  }

  return `<section class="tiles" aria-label="Highlights">${tiles.join("")}</section>`;
}

// ---------- Tabs ----------

export function tabs(w: Weekend, active: Tab): string {
  return `
    <div class="tabs" role="tablist">
      ${tabsFor(w)
        .map(
          (t) => `
        <button role="tab" class="tab ${t === active ? "is-active" : ""}" data-tab="${t}"
                aria-selected="${t === active}">${TAB_LABELS[t]}</button>`,
        )
        .join("")}
    </div>`;
}

// ---------- Race / sprint classification ----------

function driverCell(name: string, acronym: string, team: string, teamColour: string | null): string {
  return `
    <td class="driver" style="--team:${colour(teamColour)}">
      <div class="driver-inner">
        <span class="bar"></span>
        <span class="driver-text">
          <span class="driver-name"><span class="code">${esc(acronym)}</span><span class="full">${esc(name)}</span></span>
          <span class="driver-team">${esc(team)}</span>
        </span>
      </div>
    </td>`;
}

function gainedCell(r: RaceResult): string {
  if (r.grid === null) return `<td class="num muted hide-xs">–</td>`;
  const g = r.gained ?? 0;
  const delta = r.gained === null ? "" : g > 0 ? `<span class="up">▲${g}</span>` : g < 0 ? `<span class="down">▼${-g}</span>` : `<span class="same">–</span>`;
  return `<td class="num grid-cell hide-xs"><span class="muted">P${r.grid}</span> ${delta}</td>`;
}

export function raceTable(s: RaceSession): string {
  return `
    <div class="table-wrap">
      <table class="results">
        <thead>
          <tr>
            <th class="num">Pos</th><th>Driver</th><th class="num hide-xs">Grid</th>
            <th class="num hide-sm">Laps</th><th class="num">Time / gap</th>
            <th class="num hide-sm">Best lap</th><th class="num">Pts</th>
          </tr>
        </thead>
        <tbody>
          ${s.results
            .map(
              (r) => `
            <tr class="${r.status !== "finished" ? "is-out" : ""} ${r.position !== null && r.position <= 3 ? "is-podium" : ""}">
              <td class="num pos">${r.position ?? "–"}</td>
              ${driverCell(r.name, r.acronym, r.team, r.team_colour)}
              ${gainedCell(r)}
              <td class="num hide-sm muted">${r.laps}</td>
              <td class="num ${r.status !== "finished" ? "status" : ""}">${esc(raceGap(r))}</td>
              <td class="num hide-sm ${r.fastest_lap ? "purple" : "muted"}">${lapTime(r.best_lap)}</td>
              <td class="num pts">${r.points ? points(r.points) : ""}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

// ---------- Qualifying classification ----------

// The time a driver set in the last stage they reached
function bestTime(r: QualifyingResult | undefined): number | null {
  if (!r) return null;
  return r.q3 ?? r.q2 ?? r.q1;
}

function fastestIn(q: QualifyingSession, stage: "q1" | "q2" | "q3"): QualifyingResult | undefined {
  return q.results.filter((r) => r[stage] !== null).sort((a, b) => a[stage]! - b[stage]!)[0];
}

export function qualifyingTable(q: QualifyingSession): string {
  const fastest = {
    q1: fastestIn(q, "q1")?.q1 ?? null,
    q2: fastestIn(q, "q2")?.q2 ?? null,
    q3: fastestIn(q, "q3")?.q3 ?? null,
  };
  const cell = (r: QualifyingResult, stage: "q1" | "q2" | "q3", hide = "") => {
    const t = r[stage];
    const cls = t !== null && t === fastest[stage] ? "purple" : stage === (r.stage ?? "").toLowerCase() ? "" : "muted";
    return `<td class="num ${cls} ${hide}">${lapTime(t)}</td>`;
  };
  // Gap to the fastest time in the stage the driver was knocked out in
  const gap = (r: QualifyingResult) => {
    const stage = (r.stage ?? "Q1").toLowerCase() as "q1" | "q2" | "q3";
    const t = r[stage];
    const best = fastest[stage];
    if (r.dns) return "DNS";
    if (r.dsq) return "DSQ";
    if (t === null || best === null) return "";
    return t === best ? "" : `+${(t - best).toFixed(3)}`;
  };

  let lastStage: string | null | undefined;
  const rows = q.results.map((r) => {
    const divider = lastStage !== undefined && r.stage !== lastStage
      ? `<tr class="cut"><td colspan="7"><span>Knocked out in ${esc(r.stage ?? "–")}</span></td></tr>`
      : "";
    lastStage = r.stage;
    return `${divider}
      <tr class="${r.dns || r.dsq ? "is-out" : ""}">
        <td class="num pos">${r.position ?? "–"}</td>
        ${driverCell(r.name, r.acronym, r.team, r.team_colour)}
        ${cell(r, "q1", "hide-sm")}
        ${cell(r, "q2", "hide-sm")}
        ${cell(r, "q3", "hide-sm")}
        <td class="num show-sm">${lapTime(bestTime(r))}</td>
        <td class="num muted">${gap(r)}</td>
      </tr>`;
  });

  return `
    <div class="table-wrap">
      <table class="results">
        <thead>
          <tr>
            <th class="num">Pos</th><th>Driver</th>
            <th class="num hide-sm">Q1</th><th class="num hide-sm">Q2</th><th class="num hide-sm">Q3</th>
            <th class="num show-sm">Best</th><th class="num">Gap</th>
          </tr>
        </thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>`;
}

// ---------- Championship ----------

function change(pos: number, previous: number | null): string {
  if (previous === null) return `<span class="chg same" title="First round">•</span>`;
  const d = previous - pos;
  if (d > 0) return `<span class="chg up" title="Up ${d}">▲${d}</span>`;
  if (d < 0) return `<span class="chg down" title="Down ${-d}">▼${-d}</span>`;
  return `<span class="chg same" title="No change">–</span>`;
}

function standingRows<T extends DriverStanding | ConstructorStanding>(
  rows: T[],
  label: (r: T) => string,
  limit: number,
): string {
  const leader = rows[0]?.points || 1;
  return rows
    .slice(0, limit)
    .map(
      (r) => `
      <li class="standing" style="--team:${colour(r.team_colour)}">
        <span class="s-pos">${r.position}</span>
        ${change(r.position, r.previous)}
        <span class="s-name">${label(r)}</span>
        <span class="s-bar"><span style="width:${(r.points / leader) * 100}%"></span></span>
        <span class="s-pts">${points(r.points)}</span>
      </li>`,
    )
    .join("");
}

// "Show all" button under the drivers list (all teams always fit)
function toggle(total: number, expanded: boolean): string {
  if (total <= TOP) return "";
  return `<button class="more" data-action="toggle-drivers" aria-expanded="${expanded}">${expanded ? `Show top ${TOP}` : `Show all ${total} drivers`}</button>`;
}

const TOP = 10;

export function championship(
  s: RoundStandings | undefined,
  w: Weekend,
  allDrivers: boolean,
): string {
  if (!s) return "";
  const leader = s.drivers[0];
  const second = s.drivers[1];
  const asOf = s.round === w.round ? `after round ${s.round}` : `after round ${s.round} (round ${w.round} race not yet run)`;

  return `
    <section class="champ" aria-labelledby="champ-title">
      <div class="section-head">
        <div>
          <p class="eyebrow">${s.season} season · ${asOf}</p>
          <h2 id="champ-title">Championship</h2>
        </div>
        ${leader && second ? `<p class="lead-gap"><strong>${esc(leader.acronym)}</strong> leads by <strong>${points(leader.points - second.points)}</strong> pts</p>` : ""}
      </div>
      <div class="champ-grid">
        <div class="card">
          <h3>Drivers</h3>
          <ol class="standings">
            ${standingRows(s.drivers, (r) => `<span class="code">${esc(r.acronym)}</span><span class="full">${esc(r.name)}</span><span class="s-team">${esc(r.team)}</span>`, allDrivers ? Infinity : TOP)}
          </ol>
          ${toggle(s.drivers.length, allDrivers)}
        </div>
        <div class="card">
          <h3>Constructors</h3>
          <ol class="standings">
            ${standingRows(s.constructors, (r) => `<span class="full team-only">${esc(r.team)}</span>`, Infinity)}
          </ol>
        </div>
      </div>
    </section>`;
}
