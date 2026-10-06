# Self-hosted fonts

DM Sans (normal weights 400, 500, 600) and Gloock (normal weight 400) are served
from this directory through `fonts.css`. Each family includes its original
copyright notice and SIL Open Font License in `OFL.txt`. No visible attribution
is required. Preserve these notices and font license metadata when updating.

These are the full TrueType faces supplied by the existing Google Fonts CSS
request, converted to WOFF2 with FontTools 4.61.1 without subsetting or changing
outlines. Character coverage and the existing fallback behavior are preserved.
Browsers load only local assets; Google is not contacted at runtime.

Retrieved 2026-10-06 from:

- DM Sans 400: https://fonts.gstatic.com/s/dmsans/v17/rP2tp2ywxg089UriI5-g4vlH9VoD8CmcqZG40F9JadbnoEwAopxhTg.ttf
- DM Sans 500: https://fonts.gstatic.com/s/dmsans/v17/rP2tp2ywxg089UriI5-g4vlH9VoD8CmcqZG40F9JadbnoEwAkJxhTg.ttf
- DM Sans 600: https://fonts.gstatic.com/s/dmsans/v17/rP2tp2ywxg089UriI5-g4vlH9VoD8CmcqZG40F9JadbnoEwAfJthTg.ttf
- Gloock 400: https://fonts.gstatic.com/s/gloock/v8/Iurb6YFw84WUY4N5jw.ttf

License sources:

- https://github.com/google/fonts/blob/main/ofl/dmsans/OFL.txt
- https://github.com/google/fonts/blob/main/ofl/gloock/OFL.txt

To update, download the requested normal faces and their current licenses from
Google Fonts, convert the full faces to WOFF2, retain all font metadata, and
replace the files and licenses together. Verify the declared weights, served
WOFF2 signatures, and local CSS URLs with `npm run smoke` before deployment.
