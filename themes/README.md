# Themes

Each subdirectory is one college theme:

    themes/<slug>/theme.json   # colors, fonts, logo metadata
    themes/<slug>/logo.svg     # optional; see trademark note

## Trademark note

**Do not commit college logos to this public repo.** University seals and
marks (K-State Powercat, MIT seal, Georgia Tech Buzz, Virginia Tech VT,
Illinois Block I, etc.) are trademarks. Each club should obtain written
permission from their university licensing office and drop the approved
asset into `themes/<slug>/logo.svg` on their local/deployed copy.

If the file is missing or empty, Ham-Net-Assistant renders a neutral
ham-radio icon with the theme's `shortName`.

## Adding a new college

1. `cp -r themes/default themes/<slug>`
2. Edit `theme.json`: slug, name, shortName, colors, font, attribution
3. Restart the app — themes are auto-discovered
