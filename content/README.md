# Editing `dances.md`

[`dances.md`](dances.md) is the single content source. Its complete format is:

```md
# Region name
Greek: …                     <!-- required -->
Color: #d71908               <!-- required: six-digit hex color -->

## Village name
Greek: …                     <!-- required -->
Latitude: 42.775             <!-- required: number from -90 to 90; 3–5 decimals recommended -->
Longitude: 27.817            <!-- required: number from -180 to 180; 3–5 decimals recommended -->
Subregion: …                 <!-- optional -->
Greek subregion: …           <!-- required when Subregion is present -->

Info:                        <!-- optional: English Markdown follows -->
English information

Greek info:                  <!-- optional: Greek Markdown; falls back to English -->
Greek information
```

Blank lines outside information are optional. `#` starts a region, `##` starts
a village, and information continues until the next info label, village, or
region. HTML comments are allowed anywhere. Save the file and reload the page;
there is no content build step.
