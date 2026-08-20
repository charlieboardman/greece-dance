export class DancesMarkdownError extends Error {
  constructor(message, { line = null, field = "" } = {}) {
    super(message);
    this.name = "DancesMarkdownError";
    this.line = line;
    this.field = field;
  }

  get location() {
    const parts = ["dances.md"];
    if (this.line !== null) parts.push(`line ${this.line}`);
    if (this.field) parts.push(`field “${this.field}”`);
    return parts.join(", ");
  }
}

const FIELD_KEYS = new Map([
  ["greek", "greek_name"],
  ["color", "color"],
  ["latitude", "latitude"],
  ["longitude", "longitude"],
  ["subregion", "subregion"],
  ["greek subregion", "subregion_greek_name"]
]);
const FIELD_LABELS = {
  greek_name: "Greek",
  color: "Color",
  latitude: "Latitude",
  longitude: "Longitude",
  subregion: "Subregion",
  subregion_greek_name: "Greek subregion"
};
const REGION_FIELDS = new Set(["greek_name", "color"]);
const VILLAGE_FIELDS = new Set([
  "greek_name", "latitude", "longitude", "subregion", "subregion_greek_name"
]);
const INFO_LABELS = new Map([
  ["info", "en"],
  ["greek info", "el"]
]);

export function parseDancesMarkdown(source) {
  if (typeof source !== "string") {
    throw new DancesMarkdownError("The dances content must be text.");
  }

  const normalizedSource = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const lines = stripComments(normalizedSource).split("\n");
  const regions = [];
  const places = [];
  const regionIds = new Set();
  const placeIds = new Set();
  let currentRegion = null;
  let currentVillage = null;
  let currentInfoLanguage = null;
  let infoFence = null;

  const finishVillage = () => {
    if (!currentVillage) return;
    const greekName = requiredField(currentVillage, "greek_name");
    const latitude = coordinateField(currentVillage, "latitude", -90, 90);
    const longitude = coordinateField(currentVillage, "longitude", -180, 180);
    const subregion = optionalField(currentVillage, "subregion");
    const subregionGreekName = optionalField(currentVillage, "subregion_greek_name");
    if (Boolean(subregion) !== Boolean(subregionGreekName)) {
      const missing = subregion ? "subregion_greek_name" : "subregion";
      fail(
        `${fieldLabel(missing)} is required when its companion subregion field is present.`,
        currentVillage.line,
        fieldLabel(missing)
      );
    }

    const idParts = [currentRegion.id];
    if (subregion) idParts.push(slug(subregion));
    idParts.push(slug(currentVillage.name));
    const id = idParts.join("--");
    if (placeIds.has(id)) {
      fail(`Another village produces the same generated key “${id}”.`, currentVillage.line);
    }
    placeIds.add(id);

    const village = {
      id,
      name: currentVillage.name,
      names: { en: currentVillage.name, el: greekName },
      coordinates: [latitude, longitude],
      info: {
        en: currentVillage.infoLines.en.join("\n").trim(),
        el: currentVillage.infoLines.el.join("\n").trim()
      }
    };

    if (subregion) {
      let group = currentRegion._subregions.get(subregion);
      if (!group) {
        const subregionId = slug(subregion);
        if (currentRegion.subregions.some((item) => item.id === subregionId)) {
          fail(
            `Subregion “${subregion}” produces the same generated key as another subregion in ${currentRegion.name}.`,
            currentVillage.line,
            fieldLabel("subregion")
          );
        }
        group = {
          id: subregionId,
          name: subregion,
          names: { en: subregion, el: subregionGreekName },
          villages: []
        };
        currentRegion._subregions.set(subregion, group);
        currentRegion.subregions.push(group);
      } else if (group.names.el !== subregionGreekName) {
        fail(
          `Use the same Greek subregion for every village in “${subregion}”.`,
          fieldLine(currentVillage, "subregion_greek_name"),
          fieldLabel("subregion_greek_name")
        );
      }
      group.villages.push(village);
    } else {
      currentRegion.villages.push(village);
    }

    places.push({
      ...village,
      lat: latitude,
      lon: longitude,
      regionId: currentRegion.id,
      subregionName: subregion,
      subregionNames: subregion
        ? { en: subregion, el: subregionGreekName }
        : { en: "", el: "" }
    });
    currentVillage = null;
    currentInfoLanguage = null;
    infoFence = null;
  };

  const finishRegion = () => {
    finishVillage();
    if (!currentRegion) return;
    currentRegion.names.el = requiredField(currentRegion, "greek_name");
    currentRegion.color = requiredField(currentRegion, "color").toLowerCase();
    if (!/^#[0-9a-f]{6}$/u.test(currentRegion.color)) {
      fail(
        "Color must be a six-digit hex value such as #e5a83f.",
        fieldLine(currentRegion, "color"),
        fieldLabel("color")
      );
    }
    delete currentRegion._fields;
    delete currentRegion._subregions;
    delete currentRegion.line;
    currentRegion = null;
  };

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine;
    if (currentInfoLanguage) {
      if (infoFence) {
        currentVillage.infoLines[currentInfoLanguage].push(line);
        const closingFence = /^\s{0,3}(`{3,}|~{3,})\s*$/u.exec(line);
        if (
          closingFence
          && closingFence[1][0] === infoFence.character
          && closingFence[1].length >= infoFence.length
        ) {
          infoFence = null;
        }
        return;
      }

      const openingFence = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (openingFence) {
        infoFence = {
          character: openingFence[1][0],
          length: openingFence[1].length
        };
        currentVillage.infoLines[currentInfoLanguage].push(line);
        return;
      }
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/u.exec(line);

    if (heading?.[1] === "#") {
      finishRegion();
      const name = heading[2].trim();
      const id = slug(name);
      if (regionIds.has(id)) {
        fail(`Another region produces the same generated key “${id}”.`, lineNumber);
      }
      regionIds.add(id);
      currentRegion = {
        id,
        name,
        names: { en: name, el: "" },
        color: "",
        villages: [],
        subregions: [],
        _fields: new Map(),
        _subregions: new Map(),
        line: lineNumber
      };
      regions.push(currentRegion);
      return;
    }

    if (heading?.[1] === "##") {
      if (!currentRegion) fail("A village must appear beneath a region heading.", lineNumber);
      finishVillage();
      currentVillage = {
        name: heading[2].trim(),
        line: lineNumber,
        _fields: new Map(),
        _infoSections: new Map(),
        infoLines: { en: [], el: [] }
      };
      return;
    }

    const labeledLine = parseLabeledLine(line);
    const infoLanguage = labeledLine ? INFO_LABELS.get(labeledLine.label) : null;
    if (infoLanguage) {
      if (labeledLine.value) {
        fail("Place information on the lines following this label.", lineNumber, infoLabel(infoLanguage));
      }
      if (!currentVillage) fail("Information must appear beneath a village heading.", lineNumber);
      if (currentVillage._infoSections.has(infoLanguage)) {
        fail(`A village can only have one ${infoLabel(infoLanguage)} section.`, lineNumber);
      }
      currentVillage._infoSections.set(infoLanguage, lineNumber);
      currentInfoLanguage = infoLanguage;
      infoFence = null;
      return;
    }

    if (currentInfoLanguage) {
      currentVillage.infoLines[currentInfoLanguage].push(line);
      return;
    }

    if (!line.trim()) return;
    if (heading) {
      fail(
        "Only region (#) and village (##) headings are allowed outside information.",
        lineNumber
      );
    }

    if (!labeledLine) {
      fail("Expected a heading, a Field: value line, or an HTML comment.", lineNumber);
    }
    if (INFO_LABELS.has(labeledLine.label)) {
      fail("Place information on the lines following this label.", lineNumber, canonicalLabel(labeledLine.label));
    }
    const key = FIELD_KEYS.get(labeledLine.label);
    const record = currentVillage || currentRegion;
    const shownLabel = key ? fieldLabel(key) : canonicalLabel(labeledLine.label);
    if (!record) fail("Fields must appear beneath a region or village heading.", lineNumber, shownLabel);
    const allowedFields = currentVillage ? VILLAGE_FIELDS : REGION_FIELDS;
    if (!key || !allowedFields.has(key)) {
      fail(
        `Unknown ${currentVillage ? "village" : "region"} field “${shownLabel}”.`,
        lineNumber,
        shownLabel
      );
    }
    if (record._fields.has(key)) fail(`Duplicate field “${shownLabel}”.`, lineNumber, shownLabel);
    record._fields.set(key, { value: labeledLine.value, line: lineNumber });
  });

  finishRegion();
  if (!regions.length) throw new DancesMarkdownError("Add at least one region heading.");
  return { regions, places };
}

export function stripComments(source) {
  let result = "";
  let inComment = false;
  let commentLine = null;
  let line = 1;

  for (let index = 0; index < source.length;) {
    if (!inComment && source.startsWith("<!--", index)) {
      inComment = true;
      commentLine = line;
      index += 4;
      continue;
    }
    if (inComment && source.startsWith("-->", index)) {
      inComment = false;
      commentLine = null;
      index += 3;
      continue;
    }

    const character = source[index];
    if (character === "\n") {
      result += "\n";
      line += 1;
    } else if (!inComment) {
      result += character;
    }
    index += 1;
  }

  if (inComment) fail("This HTML comment is not closed with -->.", commentLine);
  return result;
}

function requiredField(record, key) {
  const value = optionalField(record, key);
  if (!value) fail("This field is required.", record.line, fieldLabel(key));
  return value;
}

function optionalField(record, key) {
  return record._fields.get(key)?.value || "";
}

function fieldLine(record, key) {
  return record._fields.get(key)?.line || record.line;
}

function coordinateField(record, key, minimum, maximum) {
  const value = requiredField(record, key);
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value)) {
    fail("This field must be a decimal number.", fieldLine(record, key), fieldLabel(key));
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    fail("This field must be a decimal number.", fieldLine(record, key), fieldLabel(key));
  }
  if (number < minimum || number > maximum) {
    fail(
      `${fieldLabel(key)} must be between ${minimum} and ${maximum}.`,
      fieldLine(record, key),
      fieldLabel(key)
    );
  }
  return number;
}

function parseLabeledLine(line) {
  const match = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/u.exec(line);
  if (!match) return null;
  return {
    label: match[1].trim().replace(/\s+/gu, " ").toLowerCase(),
    value: match[2].trim()
  };
}

function fieldLabel(key) {
  return FIELD_LABELS[key] || key;
}

function infoLabel(language) {
  return language === "el" ? "Greek info" : "Info";
}

function canonicalLabel(label) {
  return label.replace(/(^|\s)\p{Letter}/gu, (character) => character.toUpperCase());
}

function slug(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "item";
}

function fail(message, line, field = "") {
  throw new DancesMarkdownError(message, { line, field });
}
