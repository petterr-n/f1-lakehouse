import "./style.css";
import type { Tab, Weekend } from "./types";
import { loadData, standingsFor, type SiteData } from "./data";
import { esc } from "./format";
import { championship, hero, highlights, qualifyingTable, raceTable, roundStrip, tabs, tabsFor } from "./views";

const app = document.querySelector<HTMLDivElement>("#app")!;

// What's on screen. Kept in the URL (#/2026/17/qualifying) so links can be shared.
interface State {
  season: number;
  round: number;
  tab: Tab;
  allDrivers: boolean;
}

function readHash(data: SiteData): State {
  const latest = data.weekends[data.weekends.length - 1];
  const [season, round, tab] = location.hash.replace(/^#\/?/, "").split("/");
  const w =
    data.weekends.find((w) => w.season === Number(season) && w.round === Number(round)) ??
    data.weekends.filter((w) => w.season === Number(season)).at(-1) ??
    latest;
  const available = tabsFor(w);
  return {
    season: w.season,
    round: w.round,
    tab: available.includes(tab as Tab) ? (tab as Tab) : available[0],
    allDrivers: false,
  };
}

function render(data: SiteData, state: State): void {
  const season = data.weekends.filter((w) => w.season === state.season);
  const w: Weekend = season.find((w) => w.round === state.round)!;

  const session =
    state.tab === "race" ? raceTable(w.race!)
    : state.tab === "sprint" ? raceTable(w.sprint!)
    : state.tab === "qualifying" ? qualifyingTable(w.qualifying!)
    : qualifyingTable(w.sprintQualifying!);

  app.innerHTML = `
    <div class="topbar">
      <div class="page topbar-inner">
        <a class="brand" href="#/"><span class="brand-mark"></span>F1 Lakehouse</a>
        <label class="season-select">
          <span class="visually-hidden">Season</span>
          <select id="season">
            ${data.seasons.map((y) => `<option ${y === state.season ? "selected" : ""}>${y}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="page">${roundStrip(season, w)}</div>
    </div>

    <main class="page">
      ${hero(w, state.tab)}
      ${tabs(w, state.tab)}
      ${highlights(w, state.tab)}
      <section class="session" aria-label="Classification">${session}</section>
      ${championship(standingsFor(data, w.season, w.round), w, state.allDrivers)}
    </main>

    <footer class="page footer">
      <p>Data from <a href="https://openf1.org">OpenF1</a>, processed by a Databricks lakehouse pipeline.
         Updated ${new Date(data.generatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.</p>
      <p><a href="https://github.com/petterr-n/f1-lakehouse">Source on GitHub</a></p>
    </footer>
  `;

  // Keep the selected round visible in the strip
  app.querySelector(".round.is-active")?.scrollIntoView({ inline: "center", block: "nearest" });
}

function go(data: SiteData, state: State): void {
  const hash = `#/${state.season}/${state.round}/${state.tab}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
  render(data, state);
}

loadData()
  .then((data) => {
    let state = readHash(data);
    go(data, state);

    // One set of listeners on the root; the content underneath is re-rendered freely
    app.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-round], [data-tab], [data-action]");
      if (!el) return;
      if (el.dataset.round) {
        const round = Number(el.dataset.round);
        const w = data.weekends.find((w) => w.season === state.season && w.round === round)!;
        const tab = tabsFor(w).includes(state.tab) ? state.tab : tabsFor(w)[0];
        state = { ...state, round, tab };
      } else if (el.dataset.tab) {
        state = { ...state, tab: el.dataset.tab as Tab };
      } else if (el.dataset.action === "toggle-drivers") {
        state = { ...state, allDrivers: !state.allDrivers };
      }
      go(data, state);
    });

    app.addEventListener("change", (e) => {
      const el = e.target as HTMLSelectElement;
      if (el.id !== "season") return;
      location.hash = `#/${el.value}`; // latest round of that season
    });

    window.addEventListener("hashchange", () => {
      state = { ...readHash(data), allDrivers: state.allDrivers };
      render(data, state);
    });

    // Arrow keys step through rounds
    document.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const season = data.weekends.filter((w) => w.season === state.season);
      const i = season.findIndex((w) => w.round === state.round) + (e.key === "ArrowRight" ? 1 : -1);
      if (season[i]) location.hash = `#/${state.season}/${season[i].round}/${state.tab}`;
    });
  })
  .catch((err) => {
    app.innerHTML = `<p class="page error">${esc(err.message)}</p>`;
  });
