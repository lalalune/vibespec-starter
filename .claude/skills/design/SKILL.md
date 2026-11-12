---
name: design
description: Design or review anything a person looks at, built from a spec in this repository: a page, screen, component, chart, dashboard, report or CLI output. Use before writing UI code, when choosing a layout or visual direction, and when reviewing UI for clutter, wordiness or missing spec content.
---

# Design from the spec

The spec decides what is on screen. Design decides how little it takes to show it.

## Before you draw

1. **Inventory.** For each story in `spec/<name>.md`, write down what the user
   must see or do, and the rule behind it. That list is the whole content:
   nothing off it ships, everything on it does.
2. **Cut.** For each item ask: does the user need to see this, here, now? What
   do they need that is not on the list? Remove what fails; add what is missing.
3. **Three directions.** Sketch three different approaches (layout, hierarchy,
   brand treatment), a sentence or a rough SVG each. Pick the one that shows the
   inventory with the fewest elements and the clearest identity.

## Rules

| Instead of | Use |
|---|---|
| A number inside a sentence | The number alone, large, or a bar, meter or chart |
| A status word | Color, shape or icon, with the word as its accessible name |
| A paragraph explaining a flow | A diagram |
| A label repeating what the element shows | Nothing |
| A chip, pill, badge or eyebrow | Position, weight or color, or nothing |
| A filled gap | Whitespace |

- **Visual first.** A chart, icon, color, shape or SVG before text. Keep
  `aria-label` and `alt` so the meaning survives without sight.
- **Few words.** No explanations, disclaimers, helper text, sub-headers,
  eyebrows, taglines or detail lines under titles. One heading per view at most.
- **Calm.** No cards in cards, dividers or decorative icons unless a story needs
  the distinction they draw. Empty space is not a slot to fill.
- **Brand, then usability.** One type pairing, a small palette with one accent,
  one spacing scale, all as shared tokens. Text contrast meets WCAG AA.
- **The spec is the scope.** No page, section, setting, onboarding or sample
  content the spec does not ask for, and no story left without its visible part.
- **One component system.** Search existing components, tokens and types first;
  extend a shared one before adding a one-off.

## Review: two or three passes

Reread the rules above before each pass, then ask:

- What could go with no story losing anything? Remove it.
- What text could be a visual? What visual could be smaller?
- What from the inventory is missing?
- Does the eye land first on what matters most?

Stop when a pass changes nothing. Report the chosen direction in one line, and
anything cut that the user might expect to see.
