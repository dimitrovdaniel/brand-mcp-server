# Haferglück: colour and typography

## Colour roles
Use semantic tokens in code (`color.text.default`, `color.action.primary` …), never primitives or hex values.

| Role | Token | Value |
|---|---|---|
| Page background | `color.surface.default` | Oat 50 `#FBF7EF` |
| Cards, sections | `color.surface.subtle` | Oat 100 `#F6EFE2` |
| Brand blocks, footer | `color.surface.brand` | Forest 700 `#1F4D3A` |
| Highlight blocks | `color.surface.accent` | Sun 400 `#F2B33D` |
| Body text | `color.text.default` | Ink 900 `#1B1B18` |
| Primary button | `color.action.primary` | Forest 700 `#1F4D3A` |
| Prices, badges | `color.accent.secondary` | Berry 600 `#B23A5B` |

## Proportions
Roughly 60 % oat, 25 % forest green, 10 % sun yellow, 5 % berry. Sun yellow is a highlight, not a background for whole pages.

## Signature pairing
Sun-yellow headline on forest green. It is the most recognisable Haferglück look; use it once per layout, for the key message.

## Contrast
Only use the pairs listed in the colour-pair rules. White text on sun yellow and berry on forest green are not allowed.

## Typefaces
- **Fraunces Bold** for display and headlines. Sentence case, tight line-height (1.1–1.15).
- **Inter** for body, UI and legal text. Regular 400 for body, Medium 500 for titles.
- Fallbacks: Georgia for Fraunces, Helvetica Neue / Arial for Inter.

## Type scale
Display 56 px, headline 40 px, title 28 px, body 16 px, caption 14 px. Body text is never smaller than 16 px on screens. Line length at most 70 characters.
