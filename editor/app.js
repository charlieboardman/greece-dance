import { newPlacePath, recordId, hierarchyRecords, availableSubregions } from "./places.js";

const $ = (id) => document.getElementById(id);
let csrf = "";
let snapshot = null;
let current = null;
let proposal = null;
let dirty = false;
let busy = false;

function status(message, error = false) { $("status").textContent = message; $("status").classList.toggle("error", error); }
function invalidate() { proposal = null; $("preview").hidden = true; dirty = true; }
async function api(endpoint, body) {
  const response = await fetch(`/api/editor/${endpoint}`, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) { $("login").hidden = false; $("workspace").hidden = true; }
    throw new Error(result.error || "The request failed.");
  }
  return result;
}
async function perform(task) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try { await task(); } catch (error) { status(error.message, true); }
  finally { busy = false; document.querySelectorAll("button").forEach((button) => { button.disabled = false; }); }
}
function displayRecords() {
  const query = $("search").value.trim().toLocaleLowerCase();
  $("records").replaceChildren();
  for (const { record, depth } of hierarchyRecords(snapshot.records)) {
    if (query && !`${record.path} ${record.metadata.names.en} ${record.metadata.names.el}`.toLocaleLowerCase().includes(query)) continue;
    const option = new Option(`${"\u00a0\u00a0".repeat(depth)}${record.metadata.names.en} · ${record.type}`, record.path);
    option.dataset.type = record.type;
    $("records").append(option);
  }
  $("records").value = current?.path || "";
}
function fillSubregions(selected = $("subregion").value) {
  $("subregion").replaceChildren(new Option("None", ""));
  for (const record of availableSubregions(snapshot.records, $("region").value)) {
    $("subregion").append(new Option(record.metadata.names.en, recordId(record)));
  }
  $("subregion").value = [...$("subregion").options].some(option => option.value === selected) ? selected : "";
}
function fillLocations(region = $("region").value, subregion = $("subregion").value) {
  $("region").replaceChildren();
  for (const record of snapshot.records.filter(r => r.type === "region").sort((a,b) => a.metadata.names.en.localeCompare(b.metadata.names.en, "en"))) {
    $("region").append(new Option(record.metadata.names.en, recordId(record)));
  }
  if (region) {
    if (![...$("region").options].some(option => option.value === region)) $("region").append(new Option("Previously selected region (unavailable)", region));
    $("region").value = region;
  }
  fillSubregions(subregion);
  if (subregion && ![...$("subregion").options].some(option => option.value === subregion)) {
    $("subregion").append(new Option("Previously selected subregion (unavailable)", subregion));
    $("subregion").value = subregion;
  }
}
async function refresh() {
  snapshot = await api("archive"); displayRecords(); fillLocations();
}
function canDiscard() { return !dirty || window.confirm("Discard this unsent draft and select another record?"); }
function openRecord(record, creating = false) {
  current = { ...record, creating, base: snapshot.revision };
  $("edit").reset();
  $("edit").hidden = false; $("empty").hidden = true;
  $("heading").textContent = `${creating ? "Add" : "Edit"} ${record.type}`;
  $("location-fields").hidden = record.type === "region";
  $("region").disabled = record.type === "region";
  $("subregion-label").hidden = record.type !== "village";
  $("color-label").hidden = record.type !== "region";
  $("village-fields").hidden = record.type !== "village";
  $("latitude").required = $("longitude").required = record.type === "village";
  $("delete-label").hidden = creating;
  $("name-en").value = record.metadata?.names.en || "";
  $("name-el").value = record.metadata?.names.el || "";
  $("color").value = record.metadata?.color || "#336699";
  $("latitude").value = record.metadata?.latitude ?? "";
  $("longitude").value = record.metadata?.longitude ?? "";
  for (const language of ["en", "el"]) $(`info-${language}`).value = record.info?.[language] || "";
  fillLocations(record.metadata?.region || "", record.metadata?.subregion || ""); renderInfo(); invalidate(); dirty = false;
}
function changeFromForm() {
  let path = current.path;
  if (current.creating) {
    path = newPlacePath(current.type, $("name-en").value, snapshot.records);
  }
  const action = current.creating ? "create" : $("delete").checked ? "delete" : "update";
  if (action === "delete") return { action, path };
  const metadata = { names: { en: $("name-en").value.trim(), el: $("name-el").value.trim() } };
  if (current.type !== "region") metadata.region = $("region").value;
  if (current.type === "village") metadata.subregion = $("subregion").value || null;
  if (current.type === "region") metadata.color = $("color").value;
  if (current.type === "village") Object.assign(metadata, { latitude: Number($("latitude").value), longitude: Number($("longitude").value) });
  return { action, path, metadata, ...(current.type === "village" ? { info: { en: $("info-en").value, el: $("info-el").value } } : {}) };
}
const renderer = new window.marked.Renderer();
const escape = (text) => text.replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
renderer.html = ({ text }) => escape(text);
renderer.image = ({ text }) => escape(text);
function renderInfo() {
  for (const language of ["en", "el"]) {
    const text = $(`info-${language}`).value || $("info-en").value;
    $(`render-${language}`).innerHTML = window.DOMPurify.sanitize(window.marked.parse(text, { renderer, async: false }));
  }
}
function previewText(filename, text) {
  if (text === null) return "(Not present)";
  if (!filename.endsWith(".json")) return text;
  const metadata = JSON.parse(text);
  const nameFor = (collection, id) => snapshot.records.find(record => record.path === `${collection}/${id}`)?.metadata.names.en || "Unavailable";
  const lines = [`English name: ${metadata.names.en}`, `Greek name: ${metadata.names.el}`];
  if (metadata.region) lines.push(`Region: ${nameFor("regions", metadata.region)}`);
  if ("subregion" in metadata) lines.push(`Subregion: ${metadata.subregion === null ? "None" : nameFor("subregions", metadata.subregion)}`);
  if (metadata.color) lines.push(`Color: ${metadata.color}`);
  if ("latitude" in metadata) lines.push(`Latitude: ${metadata.latitude}`, `Longitude: ${metadata.longitude}`);
  return lines.join("\n");
}
function showChanges(changes) {
  $("changes").replaceChildren();
  for (const change of changes) {
    const details = document.createElement("details"); details.open = true;
    const summary = document.createElement("summary"); const field = change.path.split("/").at(-1);
    const label = field === "info.en.md" ? "English info" : field === "info.el.md" ? "Greek info" : "Details";
    summary.textContent = `${$("name-en").value.trim()} · ${label}`;
    const pair = document.createElement("div"); pair.className = "pair";
    for (const [label, text] of [["Before", change.before], ["After", change.after]]) {
      const column = document.createElement("div");
      const heading = document.createElement("h3"); heading.textContent = label;
      const pre = document.createElement("pre"); pre.textContent = previewText(change.path, text);
      column.append(heading, pre); pair.append(column);
    }
    details.append(summary, pair); $("changes").append(details);
  }
  $("preview").hidden = false;
  $("preview").scrollIntoView({ block: "start", behavior: "smooth" });
}

$("login").addEventListener("submit", (event) => {
  event.preventDefault(); perform(async () => {
    ({ csrf } = await api("login", { password: new FormData(event.target).get("password") }));
    event.target.reset(); $("login").hidden = true; $("workspace").hidden = false; $("logout").hidden = false;
    status("Loading the latest archive…");
    if (!snapshot) await refresh();
    status("Choose a record or add a new one. Submitted changes await review before publication.");
  });
});
$("logout").addEventListener("click", () => {
  if (!canDiscard()) return;
  perform(async () => { await api("logout", {}); dirty = false; location.reload(); });
});
$("refresh").addEventListener("click", () => perform(async () => {
  await refresh(); proposal = null; $("preview").hidden = true;
  status("Latest archive loaded. Your draft and its original version are kept. If there is a conflict, reopen the record to start from the latest version.");
}));
$("search").addEventListener("input", () => displayRecords());
$("records").addEventListener("change", () => {
  if (busy || !canDiscard()) { $("records").value = current?.path || ""; return; }
  openRecord(snapshot.records.find((record) => record.path === $("records").value));
});
for (const type of ["region", "subregion", "village"]) $("new-" + type).addEventListener("click", () => {
  if (!canDiscard()) return;
  if (type !== "region" && !snapshot.records.some((r) => r.type === "region")) return status("Add a region first.", true);
  openRecord({ type }, true);
});
$("region").addEventListener("change", () => { fillSubregions(); invalidate(); });
$("edit").addEventListener("input", () => { invalidate(); renderInfo(); });
$("edit").addEventListener("submit", (event) => {
  event.preventDefault(); perform(async () => {
    const request = { base: current.base, change: changeFromForm() };
    const preview = await api("preview", request);
    // Keep exactly the data previewed, even if the form changes while the request runs.
    if (JSON.stringify(request.change) !== JSON.stringify(changeFromForm())) return status("The draft changed during preview. Preview it again.");
    proposal = { ...request, previewHash: preview.previewHash, submissionId: crypto.randomUUID() };
    showChanges(preview.changes); status("Review the changes below, then submit them for review.");
  });
});
$("submit").addEventListener("click", () => perform(async () => {
  if (!proposal) return;
  const submitted = proposal;
  status("Submitting your proposal…");
  const result = await api("submit", submitted);
  if (proposal === submitted) { dirty = false; proposal = null; $("preview").hidden = true; }
  status(`Pull request #${result.number} submitted. It will go live after it is merged and deployed. `);
  const link = document.createElement("a"); link.textContent = "View pull request"; link.href = result.url; link.target = "_blank"; link.rel = "noopener noreferrer";
  $("status").append(link);
}));
window.addEventListener("beforeunload", (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
try {
  ({ csrf } = await api("session")); $("workspace").hidden = false; $("logout").hidden = false;
  await perform(refresh);
} catch (error) { $("login").hidden = false; status(error.message); }
