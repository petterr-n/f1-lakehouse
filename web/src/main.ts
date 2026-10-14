import "./style.css";
import type { QualifyingFile, QualifyingSession } from "./types";
import { esc, lapTime } from "./format";

const app = document.querySelector<HTMLDivElement>("#app")!;

async function load(): Promise<QualifyingFile> {
  const res = await fetch("data/qualifying.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load qualifying.json (HTTP ${res.status})`);
  return res.json();
}

function sessionLabel(s: QualifyingSession): string {
  return s.session_name === "Sprint Qualifying" ? `${s.location} (Sprint)` : s.location;
}

function render(data: QualifyingFile, season: number, sessionKey: number): void {
  const sessions = data.sessions.filter((s) => s.season === season);
  const session = sessions.find((s) => s.session_key === sessionKey) ?? sessions[sessions.length - 1];

  app.innerHTML = `
    <h1>Qualifying</h1>
    <div class="controls">
      <select id="season">
        ${data.seasons.map((y) => `<option ${y === season ? "selected" : ""}>${y}</option>`).join("")}
      </select>
      <select id="session">
        ${sessions
          .map((s) => `<option value="${s.session_key}" ${s === session ? "selected" : ""}>${esc(sessionLabel(s))}</option>`)
          .join("")}
      </select>
    </div>
    <table>
      <thead><tr><th>Pos</th><th>Driver</th><th>Team</th><th>Q1</th><th>Q2</th><th>Q3</th></tr></thead>
      <tbody>
        ${session.results
          .map(
            (r) => `
          <tr>
            <td>${r.position ?? (r.dns ? "DNS" : "–")}</td>
            <td><span class="bar" style="background:#${esc(r.team_colour ?? "888")}"></span>${esc(r.name)}</td>
            <td>${esc(r.team)}</td>
            <td>${lapTime(r.q1)}</td>
            <td>${lapTime(r.q2)}</td>
            <td>${lapTime(r.q3)}</td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  `;

  // Changing season jumps to that season's latest session; changing session just re-renders
  app.querySelector<HTMLSelectElement>("#season")!.onchange = (e) =>
    render(data, Number((e.target as HTMLSelectElement).value), -1);
  app.querySelector<HTMLSelectElement>("#session")!.onchange = (e) =>
    render(data, season, Number((e.target as HTMLSelectElement).value));
}

load()
  .then((data) => {
    const latest = data.sessions[data.sessions.length - 1];
    render(data, latest.season, latest.session_key);
  })
  .catch((err) => {
    app.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  });
