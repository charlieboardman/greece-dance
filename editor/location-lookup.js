// Self-contained, optional village-form assistance. The editor owns draft/save state;
// this module emits one normal input event only after an explicit candidate choice.
export function mountLocationLookup({ request, context, editable }) {
  const $ = id => document.getElementById(id);
  const root = $("location-lookup");
  const find = document.createElement("button");
  find.type = "button"; find.id = "find-location"; find.textContent = "Find location";
  const message = document.createElement("p");
  message.id = "lookup-status"; message.setAttribute("role", "status");
  const results = document.createElement("ul"); results.id = "lookup-results";
  const greekLabel = document.createElement("label"); greekLabel.className = "check";
  const greek = document.createElement("input"); greek.type = "checkbox"; greek.id = "lookup-use-greek";
  greekLabel.append(greek, "Also use the suggested Greek name (may include a region or a modern name)");
  const more = document.createElement("button"); more.type = "button"; more.id = "lookup-more";
  more.className = "secondary"; more.textContent = "Search more matches, including Wikipedia";
  root.append(find, message, greekLabel, results, more);
  let controller = null;
  let generation = 0;
  let applying = false;
  let resultKey = "";
  const key = () => JSON.stringify([context(), ...["name-el", "latitude", "longitude"].map(id => $(id).value)]);
  const clear = () => {
    generation++;
    controller?.abort(); controller = null;
    results.replaceChildren(); more.hidden = true; greekLabel.hidden = true;
    message.textContent = ""; resultKey = "";
    sync();
  };
  function sync() {
    const disabled = !editable();
    if (disabled && controller) clear();
    find.disabled = disabled || !!controller;
    more.disabled = disabled || !!controller;
    greek.disabled = disabled;
    results.querySelectorAll("button").forEach(button => { button.disabled = disabled; });
    root.setAttribute("aria-busy", String(!!controller));
    find.textContent = controller ? "Finding places…" : "Find location";
  }
  function link(text, href) {
    const a = document.createElement("a"); a.textContent = text;
    a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
    return a;
  }
  function show(candidates) {
    results.replaceChildren();
    greek.checked = !$("name-el").value.trim();
    greekLabel.hidden = !candidates.some(c => c.greek);
    for (const candidate of candidates) {
      const li = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = [candidate.name, candidate.greek].filter(Boolean).join(" · ");
      const detail = document.createElement("p"); detail.textContent = candidate.description;
      const coordinates = document.createElement("p");
      coordinates.textContent = `${candidate.latitude}, ${candidate.longitude}${candidate.greek ? "" : " · No Greek name available"}`;
      const actions = document.createElement("div"); actions.className = "lookup-actions";
      const use = document.createElement("button"); use.type = "button"; use.textContent = "Use these coordinates";
      use.addEventListener("click", () => {
        if (!editable() || controller || resultKey !== key()) return clear();
        applying = true;
        $("latitude").value = candidate.latitude;
        $("longitude").value = candidate.longitude;
        if (greek.checked && candidate.greek) $("name-el").value = candidate.greek;
        // Normal input handling invalidates previews and persists the complete draft.
        $("latitude").dispatchEvent(new Event("input", { bubbles: true }));
        applying = false;
        clear();
        message.textContent = "Location filled. Check the coordinates and Greek name before saving. English name unchanged.";
      });
      const map = new URL("https://www.openstreetmap.org/");
      map.search = new URLSearchParams({ mlat: candidate.latitude, mlon: candidate.longitude });
      map.hash = `map=12/${candidate.latitude}/${candidate.longitude}`;
      actions.append(use, link(candidate.source, candidate.url), link("View on map ↗", map.href));
      li.append(title, detail, coordinates, actions); results.append(li);
    }
  }
  async function search(includeWikipedia = false) {
    if (!editable() || controller) return;
    clear();
    const input = context();
    if (!input.query.trim()) { message.textContent = "Enter an English place name first."; return; }
    const started = ++generation;
    const startedKey = key();
    controller = new AbortController();
    sync(); message.textContent = "Searching places in this region’s approximate search area…";
    try {
      const result = await request({ ...input, includeWikipedia }, controller.signal);
      if (started !== generation || startedKey !== key() || !editable()) return;
      resultKey = startedKey;
      show(result.candidates);
      more.hidden = result.wikipediaSearched;
      message.textContent = [result.candidates.length
        ? "Choose a place after checking its location. Nothing is filled automatically."
        : "No matching places found. Try another spelling or enter the details manually.",
      result.limited ? "Showing the first eight matches; a more specific name may help." : "", ...(result.warnings || [])].filter(Boolean).join(" ");
    } catch (error) {
      if (started !== generation) return;
      message.textContent = error.message || "Lookup unavailable. You can enter the location manually.";
    } finally {
      if (started === generation) { controller = null; sync(); }
    }
  }
  find.addEventListener("click", () => search());
  more.addEventListener("click", () => search(true));
  $("edit").addEventListener("reset", clear);
  for (const event of ["input", "change"]) $("edit").addEventListener(event, e => {
    if (!applying && ["name-en", "name-el", "region", "subregion", "latitude", "longitude", "delete"].includes(e.target.id)) clear();
  });
  clear();
  return { sync, clear };
}
