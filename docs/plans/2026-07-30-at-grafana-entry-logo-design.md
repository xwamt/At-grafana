# AT Grafana Entry Logo Design

## Status
Approved for implementation

## Date
2026-07-30

## Context

AT Grafana currently uses a generic black bar-chart SVG (`media/icon.svg`) as the Activity Bar entry icon. Sibling plugins in the AT series use a shared visual language:

| Plugin | Letter glyph | Activity icon pattern |
|--------|--------------|------------------------|
| at-terminal | **T** | `>` + T (crossbar + stem + green baseline) |
| at-jumpserver | **J** | `>` + J (top bar + stem with inward hook) |
| at-grafana | **G** (this design) | `>` + open G (white arc + green crossbar) |

Marketplace icons for Terminal/JumpServer share: rounded square `#172033`, cyan chevron `#00C2D1`, white primary stroke, green accent `#35D07F`, thick rounded stroke caps.

## Goals

1. Replace the placeholder bar-chart with a **G-variant** logo that reads as the same AT-series family as Terminal/JumpServer.
2. Ship **both** surfaces: Marketplace color icon and Activity Bar monochrome line icon.
3. Keep naming aligned with siblings (`at-*-icon`, `at-*-activity`).

## Non-goals

- Redesigning at-terminal or at-jumpserver icons.
- Introducing Grafana brand orange/red into the AT series palette.
- Animations, multi-resolution icon packs beyond SVG + one PNG export.

## Decisions

### Surfaces
- **Marketplace:** 128×128 color squircle icon (`package.json` → `icon`).
- **Activity Bar:** 24×24 `currentColor` stroke icon (`contributes.viewsContainers.activitybar[].icon`).

### Palette (series family)
| Role | Hex | Use |
|------|-----|-----|
| Background | `#172033` | Marketplace rounded rect only |
| Chevron | `#00C2D1` | `>` prompt |
| Primary glyph | `#FFFFFF` | G arc (marketplace) |
| Accent | `#35D07F` | G crossbar (marketplace) |
| Activity | `currentColor` | Both chevron and G strokes |

### Glyph: balanced open G
- Left: same chevron geometry as Terminal/JumpServer marketplace/activity icons.
- Right: open circular arc (~¾ circle, opening on the right) in white / `currentColor`.
- Horizontal green / `currentColor` crossbar through the arc midpoint, extending to the open side — analogous to Terminal’s green baseline as the series “signature” stroke.
- Stroke weights: marketplace ~11–12px on 128 viewBox; activity ~2.2–2.35 on 24 viewBox; `stroke-linecap="round"`.
- Rejected: spur-G (extra stem; crowded at 16px), angular polyline G (weaker recognition), wide-open and tight-open proportion variants.

## Deliverables

| File | Purpose |
|------|---------|
| `media/at-grafana-icon.svg` | Source marketplace icon (128×128) |
| `media/at-grafana-icon.png` | Exported PNG for `package.json` `icon` (VS Code marketplace) |
| `media/at-grafana-activity.svg` | Activity Bar icon (24×24, `currentColor`) |

### Wiring
- Set `package.json` `"icon": "media/at-grafana-icon.png"`.
- Point Activity Bar container icon to `media/at-grafana-activity.svg`.
- Remove unused placeholder `media/icon.svg` once references are updated.
- Ensure `scripts/package.mjs` continues to copy `media/` into the VSIX (already does).

### SVG geometry (canonical)

**Marketplace (`at-grafana-icon.svg`):**
- ViewBox `0 0 128 128`
- Background: `rect` x=10 y=10 w=108 h=108 rx=26 fill `#172033`
- Chevron: `M38 42 L62 64 L38 86` stroke `#00C2D1` width 12
- G arc: open C-shaped arc centered in the right half; approximate path  
  `M99 51c-5-10-15-17-28-17-22 0-38 16.5-38 38s16 38 38 38c12.5 0 23-6.5 28-17`  
  stroke `#FFFFFF` width 11
- Crossbar: `M71 72 H102` stroke `#35D07F` width 11

**Activity (`at-grafana-activity.svg`):**
- ViewBox `0 0 24 24`, no background fill
- Chevron: same as Terminal activity  
  `M4.75 6.75 9.9 12 4.75 17.25` stroke `currentColor` width 2.35
- G arc:  
  `M19.55 8.7C18.45 7.15 16.65 6.25 14.55 6.25c-3.35 0-5.95 2.55-5.95 5.75s2.6 5.75 5.95 5.75c1.5 0 2.85-.55 3.85-1.5`  
  stroke `currentColor` width 2.2
- Crossbar: `M13.85 12 H19.65` stroke `currentColor` width 2.2

Paths may be tuned ±1–2 units during implementation for optical balance, as long as the balanced-open proportion and color roles are preserved.

## Acceptance criteria

1. Side-by-side with Terminal/JumpServer: same background, chevron, stroke weight language; letter clearly reads as **G**, not T/J/O/C.
2. Activity icon remains legible in VS Code Activity Bar (~16–24px rendered).
3. Marketplace PNG renders cleanly at 128px; no black fill-only placeholder remains as the entry icon.
4. Packaged `.vsix` includes the new media files and `package.json` points to them.

## Out of scope follow-ups

- Updating JumpServer’s marketplace PNG if it still mirrors Terminal’s T (separate repo).
- Dark/light dual marketplace assets (series currently uses one dark squircle).
