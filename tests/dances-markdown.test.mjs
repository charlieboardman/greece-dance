import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DancesMarkdownError, parseDancesMarkdown, stripComments } from "../dances-markdown.js";

test("the canonical Markdown remains valid as its content changes", async () => {
  const source = await readFile(new URL("../content/dances.md", import.meta.url), "utf8");
  const atlas = parseDancesMarkdown(source);

  const hierarchyPlaces = atlas.regions.flatMap((region) => [
    ...region.villages,
    ...region.subregions.flatMap((subregion) => subregion.villages)
  ]);

  assert.ok(atlas.regions.length > 0);
  assert.equal(atlas.places.length, hierarchyPlaces.length);
  assert.ok(atlas.regions.every((region) => region.names.en && region.names.el));
  assert.ok(atlas.places.every((place) => place.names.en && place.names.el));
  assert.ok(atlas.places.every((place) => typeof place.info.en === "string"));
  assert.ok(atlas.places.every((place) => typeof place.info.el === "string"));
  assert.equal(new Set(atlas.regions.map((region) => region.id)).size, atlas.regions.length);
  assert.equal(new Set(atlas.places.map((place) => place.id)).size, atlas.places.length);
  assert.doesNotMatch(
    source,
    /^(?:greek_name|latitude|longitude|subregion|subregion_greek_name|color)=|^### info/mu
  );
});

test("HTML comments apply globally and can span multiple lines", () => {
  const atlas = parseDancesMarkdown(`
# Test Region <!-- source note -->
Greek: Περιοχή <!-- translated name -->
Color: #336699

<!--
This multi-line comment is ignored.
It preserves the source line count.
-->

## Test Village <!-- source note -->
Greek: Χωριό
Latitude: 40
Longitude: 22

Info:
Visit https://example.com/path//segment
Keep this <!-- remove the aside --> text.
<!-- Remove this entire line. -->
  `);

  assert.equal(atlas.regions[0].name, "Test Region");
  assert.equal(
    atlas.places[0].info.en,
    "Visit https://example.com/path//segment\nKeep this  text."
  );
  assert.equal(stripComments("value <!-- note -->"), "value ");
  assert.equal(stripComments("before\n<!-- note\non two lines -->\nafter"), "before\n\n\nafter");
});

test("unclosed HTML comments identify their starting line", () => {
  assert.throws(
    () => parseDancesMarkdown("# Region\n<!-- unfinished"),
    (error) => {
      assert.ok(error instanceof DancesMarkdownError);
      assert.equal(error.location, "dances.md, line 2");
      assert.equal(error.message, "This HTML comment is not closed with -->.");
      return true;
    }
  );
});

test("Markdown headings inside fenced info code remain content", () => {
  const atlas = parseDancesMarkdown(`
# Test Region
Greek: Περιοχή
Color: #336699

## Test Village
Greek: Χωριό
Latitude: 40
Longitude: 22

Info:
\`\`\`md
# This is not a region
## This is not a village
Info:
\`\`\`

After the code.
  `);

  assert.equal(atlas.regions.length, 1);
  assert.equal(atlas.places.length, 1);
  assert.match(atlas.places[0].info.en, /^```md\n# This is not a region/mu);
  assert.match(atlas.places[0].info.en, /After the code\.$/u);
});

test("level-three and deeper Markdown headings remain information", () => {
  const atlas = parseDancesMarkdown(`
# Test Region
Greek: Περιοχή
Color: #336699
## Test Village
Greek: Χωριό
Latitude: 40
Longitude: 22
Info:
### History
Text beneath the heading.
  `);

  assert.equal(atlas.places[0].info.en, "### History\nText beneath the heading.");
});

test("structural whitespace and field capitalization do not affect parsing", () => {
  const atlas = parseDancesMarkdown(`# Test Region
  greek : Περιοχή
COLOR:#336699
## Test Village
Greek: Χωριό
Latitude : 40
longitude:22
Info:
Text.`);

  assert.equal(atlas.regions[0].names.el, "Περιοχή");
  assert.deepEqual(atlas.places[0].coordinates, [40, 22]);
  assert.equal(atlas.places[0].info.en, "Text.");
});

test("English and Greek info sections are parsed independently", () => {
  const atlas = parseDancesMarkdown(`
# Test Region
Greek: Περιοχή
Color: #336699

## Test Village
Greek: Χωριό
Latitude: 40
Longitude: 22

Info:
English **description**

Greek info:
Ελληνική **περιγραφή**
  `);

  assert.deepEqual(atlas.places[0].info, {
    en: "English **description**",
    el: "Ελληνική **περιγραφή**"
  });
});

test("duplicate localized info sections identify their line", () => {
  const source = `# Test Region
Greek: Περιοχή
Color: #336699
## Test Village
Greek: Χωριό
Latitude: 40
Longitude: 22
Greek info:
Πρώτο
Greek info:
Δεύτερο`;

  assert.throws(
    () => parseDancesMarkdown(source),
    (error) => {
      assert.ok(error instanceof DancesMarkdownError);
      assert.equal(error.location, "dances.md, line 10");
      assert.equal(error.message, "A village can only have one Greek info section.");
      return true;
    }
  );
});

test("localized info labels inside fenced code remain content", () => {
  const atlas = parseDancesMarkdown(`
# Test Region
Greek: Περιοχή
Color: #336699
## Test Village
Greek: Χωριό
Latitude: 40
Longitude: 22
Info:
\`\`\`md
Greek info:
\`\`\`
Still English.
Greek info:
Ελληνικά.
  `);

  assert.match(atlas.places[0].info.en, /Greek info:/u);
  assert.match(atlas.places[0].info.en, /Still English\.$/u);
  assert.equal(atlas.places[0].info.el, "Ελληνικά.");
});

test("subregion fields must be paired and consistently translated", () => {
  const missingTranslation = `
# Test Region
Greek: Περιοχή
Color: #336699
## First Village
Greek: Πρώτο Χωριό
Latitude: 40
Longitude: 22
Subregion: Test Area
  `;
  assert.throws(
    () => parseDancesMarkdown(missingTranslation),
    (error) => {
      assert.ok(error instanceof DancesMarkdownError);
      assert.equal(error.location, "dances.md, line 5, field “Greek subregion”");
      return true;
    }
  );

  const inconsistentTranslation = `
# Test Region
Greek: Περιοχή
Color: #336699
## First Village
Greek: Πρώτο Χωριό
Latitude: 40
Longitude: 22
Subregion: Test Area
Greek subregion: Πρώτη Περιοχή
## Second Village
Greek: Δεύτερο Χωριό
Latitude: 41
Longitude: 23
Subregion: Test Area
Greek subregion: Δεύτερη Περιοχή
  `;
  assert.throws(
    () => parseDancesMarkdown(inconsistentTranslation),
    /Use the same Greek subregion/u
  );
});

test("validation errors identify the line and field", () => {
  const source = `
# Test Region
Greek: Περιοχή
Color: #336699
## Broken Village
Greek: Χωριό
Latitude: nowhere
Longitude: 22
  `;

  assert.throws(
    () => parseDancesMarkdown(source),
    (error) => {
      assert.ok(error instanceof DancesMarkdownError);
      assert.equal(error.location, "dances.md, line 7, field “Latitude”");
      assert.equal(error.message, "This field must be a decimal number.");
      return true;
    }
  );
});

test("coordinate fields accept whole numbers and arbitrary decimal precision", () => {
  const atlas = parseDancesMarkdown(`
# Test Region
Greek: Περιοχή
Color: #336699
## Test Village
Greek: Χωριό
Latitude: 40
Longitude: 22.123456789
  `);

  assert.deepEqual(atlas.places[0].coordinates, [40, 22.123456789]);
});

test("information starts on the line after its label", () => {
  assert.throws(
    () => parseDancesMarkdown(`# Test Region
Greek: Περιοχή
Color: #336699
## Test Village
Greek: Χωριό
Latitude: 40
Longitude: 22
Info: Inline text`),
    (error) => {
      assert.ok(error instanceof DancesMarkdownError);
      assert.equal(error.location, "dances.md, line 8, field “Info”");
      assert.equal(error.message, "Place information on the lines following this label.");
      return true;
    }
  );
});
