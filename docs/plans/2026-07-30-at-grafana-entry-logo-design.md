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
- G arc: open C-shaped arc in the **right half only**, clear gap from chevron (same column as Terminal’s T); path  
  `M101 50C95 40 90 38 83 38C75 38 70 49 70 66C70 83 75 94 83 94C90 94 95 92 101 82`  
  stroke `#FFFFFF` width 11
- Crossbar: `M84 66 H104` stroke `#35D07F` width 11 (spur into the opening only; does not reach the chevron)

**Activity (`at-grafana-activity.svg`):**
- ViewBox `0 0 24 24`, no background fill
- Chevron: same as Terminal activity  
  `M4.75 6.75 9.9 12 4.75 17.25` stroke `currentColor` width 2.35
- G arc (right half):  
  `M19.7 8.4C18.5 7.0 17.4 6.5 15.9 6.5c-1.8 0-2.85 2.0-2.85 5.5s1.05 5.5 2.85 5.5c1.15 0 2.1-.55 2.9-1.5`  
  stroke `currentColor` width 2.2
- Crossbar: `M15.9 12 H20.1` stroke `currentColor` width 2.2

Paths may be tuned ±1–2 units for optical balance, as long as the balanced-open proportion, right-half placement (no overlap with `>`), and color roles are preserved.

## Acceptance criteria

1. Side-by-side with Terminal/JumpServer: same background, chevron, stroke weight language; letter clearly reads as **G**, not T/J/O/C.
2. Activity icon remains legible in VS Code Activity Bar (~16–24px rendered).
3. Marketplace PNG renders cleanly at 128px; no black fill-only placeholder remains as the entry icon.
4. Packaged `.vsix` includes the new media files and `package.json` points to them.

## Out of scope follow-ups

- Updating JumpServer’s marketplace PNG if it still mirrors Terminal’s T (separate repo).
- Dark/light dual marketplace assets (series currently uses one dark squircle).
