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
  for (const record of snapshot.records) {
    if (query && !`${record.path} ${record.metadata.names.en} ${record.metadata.names.el}`.toLocaleLowerCase().includes(query)) continue;
    const option = new Option(`${"\u00a0\u00a0".repeat(record.path.split("/").length - 1)}${record.metadata.names.en} · ${record.type}`, record.path);
    option.dataset.type = record.type;
    $("records").append(option);
  }
  $("records").value = current?.path || "";
}
function fillParents() {
  const previous = $("parent").value;
  $("parent").replaceChildren();
  for (const record of snapshot.records) {
    if (record.type === "region" || (current?.type === "village" && record.type === "subregion")) {
      $("parent").append(new Option(record.path, record.path));
    }
  }
  if ([...$("parent").options].some((option) => option.value === previous)) $("parent").value = previous;
}
async function refresh() {
  snapshot = await api("archive"); displayRecords(); fillParents();
}
function canDiscard() { return !dirty || window.confirm("Discard this unsent draft and select another record?"); }
function openRecord(record, creating = false) {
  current = { ...record, creating };
  $("edit").reset();
  $("edit").hidden = false; $("empty").hidden = true;
  $("heading").textContent = `${creating ? "Add" : "Edit"} ${record.type}`;
  $("record-path").textContent = creating ? "" : `info/${record.path}/`;
  $("creation").hidden = !creating;
  $("parent-label").hidden = record.type === "region";
  $("slug").required = creating;
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
  fillParents(); renderInfo(); invalidate(); dirty = false;
}
function changeFromForm() {
  let path = current.path;
  if (current.creating) {
    const folder = $("slug").value + (current.type === "subregion" ? " (subregion)" : "");
    path = current.type === "region" ? folder : `${$("parent").value}/${folder}`;
  }
  const action = current.creating ? "create" : $("delete").checked ? "delete" : "update";
  if (action === "delete") return { action, path };
  const metadata = { names: { en: $("name-en").value.trim(), el: $("name-el").value.trim() } };
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
function showChanges(changes) {
  $("changes").replaceChildren();
  for (const change of changes) {
    const details = document.createElement("details"); details.open = true;
    const summary = document.createElement("summary"); summary.textContent = change.path;
    const pair = document.createElement("div"); pair.className = "pair";
    for (const [label, text] of [["Before", change.before], ["After", change.after]]) {
      const column = document.createElement("div");
      const heading = document.createElement("h3"); heading.textContent = label;
      const pre = document.createElement("pre"); pre.textContent = text === null ? "(File absent)" : text;
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
  status("Latest archive loaded. Your draft is kept. Preview it to compare against the latest content before submitting.");
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
$("edit").addEventListener("input", () => { invalidate(); renderInfo(); });
$("edit").addEventListener("submit", (event) => {
  event.preventDefault(); perform(async () => {
    const request = { base: snapshot.revision, change: changeFromForm() };
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
