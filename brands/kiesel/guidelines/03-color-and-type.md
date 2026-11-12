# Kiesel: colour and typography

## Colour roles
Use semantic tokens in code. Primitives and hex values are for the token files only.

| Role | Token | Value |
|---|---|---|
| Page background | `color.surface.default` | White `#FFFFFF` |
| Sections | `color.surface.subtle` | Pebble 100 `#F2F3F0` |
| Brand blocks | `color.surface.brand` | Aqua 700 `#136A73` |
| Highlight for numbers | `color.surface.accent` | Lime 400 `#B5D334` |
| Body text | `color.text.default` | Slate 900 `#16222B` |
| Primary button | `color.action.primary` | Aqua 700 `#136A73` |

## Proportions
Mostly white and pebble (about 70 %), aqua for brand blocks (20 %), lime only for key numbers (at most 10 %).

## Numbers in lime
Kiesel's signature: one large key number (“−70 % Plastik”) in lime on aqua, or slate on a lime block. Lime on aqua is only for large text (24 px+) and icons.

## Contrast
Only use pairs from the colour-pair rules. White on lime and red on aqua are not allowed.

## Typefaces
- **Space Grotesk** Medium/Bold for headlines and key numbers.
- **IBM Plex Sans** for body, UI and legal text.
- Fallback: Arial.

## Type scale
Display 56 px, headline 40 px, title 28 px, body 16 px, caption 14 px. Line length at most 75 characters. Corners are nearly square: `radius.sm` 2 px for inputs, `radius.md` 4 px for cards and buttons.
