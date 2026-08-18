# Design system

## Direction

The interface uses the internal visual language “Quiet Paper and Signal”. Warm
neutral surfaces create a continuous workspace; a restrained pine accent marks
focus, selection, and primary actions. Provider colors are confined to small
source marks.

The main shell is intentionally flat. Columns use one-pixel dividers rather
than card containers or shadows. Shadows are reserved for menus, compose, and
modal dialogs.

## Foundation

- Four-pixel spacing grid with 2px and 6px optical adjustments
- System UI font stack, weights 400, 500, and 600
- Reading width capped at 720px
- Interface text 14/20, preview 13/19, reading text 16/26
- Control radii from 6px to 12px; compose and dialogs use 16px
- Touch targets are at least 44 by 44 CSS pixels on mobile

Primary light tokens:

| Role | Value |
| --- | --- |
| Canvas | `#F4F5F2` |
| Surface | `#FBFCFA` |
| Navigation | `#EFF1ED` |
| Primary text | `#1D211F` |
| Secondary text | `#59615D` |
| Accent | `#316C61` |
| Accent surface | `#DDEBE6` |

Primary dark tokens:

| Role | Value |
| --- | --- |
| Canvas | `#111411` |
| Surface | `#181C19` |
| Navigation | `#141814` |
| Primary text | `#EEF2EE` |
| Secondary text | `#ABB4AD` |
| Accent | `#78B7A8` |
| Accent surface | `#1D332D` |

## Layout

| Width | Behavior |
| --- | --- |
| 1280px and above | 240px navigation, 360–420px list, flexible reader |
| 1024–1279px | 72px navigation rail, 344px list, flexible reader |
| 900–1023px | navigation drawer, 336px list, flexible reader |
| below 900px | single main pane with explicit back navigation |

The message list, reader, and navigation manage their own desktop scroll
regions. Single-pane layouts use one content scroll region and preserve the
current mailbox state.

## Interaction

- Selected thread, bulk selection, unread state, and keyboard focus use distinct
  signals.
- Mobile swipe reveals actions and never performs destructive full-swipe.
- Compose is a single 640–720px dialog on desktop and a full-screen surface on
  mobile.
- Default motion durations range from 150ms to 280ms and never exceed 300ms.
- Reduced-motion mode removes translation, scale, and continuous rotation.
- External images are blocked with a neutral privacy explanation.
- Arbitrary HTML mail is never color-inverted in dark mode.

The application-controlled interface targets WCAG 2.2 AA. Third-party HTML mail
cannot be assumed accessible, so the production reader must also provide a
simplified or plain-text view.

