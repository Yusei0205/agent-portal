# Kyuubit: name, lucky-clover theme, pixel logo and mascot

Date: 2026-11-21. Status: approved by the owner ("proceed with your recommendation", then "apply this to every other appearance template also").
Visual reference: the owner's pixel calico (front-facing, chunky 16x16 pixels, brown left half, orange right half, cream blaze, tall dark eyes,
pink ears/cheeks/nose, gold collar with a bell, orange tail on the left) and the concept sheet approved in chat (logo 2 = head and clover charm).

## Intent

The portal is personal. It becomes **Kyuubit** (kyū = nine, nine lives; bit = code), with a lucky-clover look: the owner's pixel calico wears a
four-leaf clover charm instead of a bell. Success: every screen says Kyuubit with the pixel-cat logo, whatever appearance template is chosen;
a new "Kyuubit" template gives the clover-green and gold look in dark and light; the roaming mascot looks like the owner's cat.

## Goals

1. **Brand everywhere.** Product name `Kyuubit`, tagline `Lucky agents. Nine lives.`, logo = `docs/superpowers/assets/kyuubit-logo.svg`
   (the pixel head and clover charm, fixed colours). Applied to: every built-in template's `brand` (all files in `shared/themes/*.json`,
   including Clovi, whose "by Axrail.AI" branding goes), the code fallbacks that say `Agent Portal` in the web UI (Rail, App top bar, Auth,
   setup wizard and deploy-target headings, help content, the browser tab title), the favicon `web/favicon.svg` (same pixel head on a transparent background),
   and the cat assistant's system prompt ("in Kyuubit").
2. **Kyuubit template.** New built-in `shared/themes/kyuubit.json`, registered wherever the other built-ins are (web registry, server built-ins,
   Appearance built-in id list, build-time bundled themes if listed). Colours (dark): canvas `#0E0F13`, rail `#111318`, panel `#16181E`, raised `#1C1F26`,
   line `#23262E`, ink `#ECE7DE`, ink-2 `#BFC4C0`, ink-3 `#9AA19D`, accent `#3FAE6E`, accent-ink `#06180D`, link `#7FD9A0`, warn/gold `#F2B33C`.
   Light: canvas `#FBF8EF`, rail `#F3F0E4`, panel `#FFFFFF`, raised `#F6F3E8`, line `#E4E0D2`, ink `#22302A`, ink-2 `#44524A`, ink-3 `#6B7A70`,
   accent `#2F8F5B`, accent-ink `#FFFFFF`, link `#2F8F5B`, warn/gold `#956A0C`. Other tokens follow the existing templates' shape with matching
   washes; contrast of ink and accent text against their backgrounds at least 4.5:1.
3. **Default.** `kyuubit` becomes the default template for new installs (server default, web fallback, theme-init fallback). An existing install
   whose active template is still the old default `aethrix-night` is switched once to `kyuubit`, recorded by a marker setting so that choosing
   another template later is respected (idempotent startup step, both SQLite and DynamoDB through the settings repository).
4. **Mascot.** The roaming cat's sprites keep every animation and frame count, but the calico pattern matches the reference: head and body split
   brown (left) and orange (right) with a cream blaze down the face and a cream/grey belly; pink ears, cheeks and nose; gold collar; the gold tag
   becomes a small green four-leaf clover charm with a gold centre; the tail is orange. The celebrate sparkles become small clover leaves.
5. **Login illustration.** The login page shows the larger cat-with-clover illustration (concept 3) above the sign-in form, decorative
   (`aria-hidden`), hidden on short phone screens if it would push the form below the fold.

## Non-goals and constraints

- Server-side identity strings stay unchanged: git commit identity and PR/auto-fix footers, MFA issuer (would rename existing authenticator
  entries), MCP client name, guard messages, run-folder notes. Only what the owner sees in the portal changes.
- Each template keeps its own colours and fonts; only `brand` changes in the other templates.
- No new dependency; no image files other than the SVG logo/favicon; theme tokens for UI; reduced motion respected.

## Approaches

1. **Brand in every template JSON + new template + default switch (chosen).** Uses the existing brand mechanism; a custom template can still carry its own brand.
2. One global brand setting overriding templates: cleaner long term, but a new admin setting and API for a personal portal. Rejected for now.

## Builder's calls

- Tagline text, the exact token values not listed above, and the marker key name (`theme.kyuubit_default_applied`).
- Clover sparkles reuse the existing sparkle elements with a clover shape.
