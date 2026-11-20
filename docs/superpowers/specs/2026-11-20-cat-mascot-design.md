# Cat mascot with a tip bubble (short design)

Date: 2026-11-20. Approved in chat. A small change.

- **Intent:** a friendly cat mascot for the portal, with a pop-up tip bubble like other sites. First version is decorative: no function.
- **Goals:** a small sitting cat in the bottom-right corner of every signed-in page; about two seconds after a page loads a bubble shows one
  static tip; × closes it until the next load; clicking the cat shows the next tip. Works in every theme (light and dark), at phone width,
  and stays still for people who ask for reduced motion.
- **Non-goals:** no links, actions, data, chat or settings; no remembered dismissal; no name change (the app stays "Agent Portal" until a
  name is chosen).
- **Approaches:** an inline SVG drawn in the portal's own code, coloured with theme tokens (chosen); an animation library such as Lottie
  (rejected: a new dependency for an idle blink); an image or emoji (rejected: does not follow themes, licensing).
- **Build:** `web/src/components/CatMascot.jsx`, `web/src/styles/mascot.css`, mounted once in `App.jsx`; a UI smoke case in the
  projects section. Eight tips, all checked against the real shortcuts and pages.
