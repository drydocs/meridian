# Brand guidelines

<p align="center">
  <svg viewBox="4 4 32 17" width="180" fill="none"><defs><linearGradient id="mg-hero" x1="34" y1="20" x2="17" y2="17" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#10b981"/></linearGradient></defs><path d="M34 20 A14 14 0 0 0 6 20 A11 11 0 0 1 28 20 A8 8 0 0 0 12 20 A5 5 0 0 1 22 20" stroke="url(#mg-hero)" stroke-width="2.25"/><circle cx="17" cy="17.3" r="2.6" fill="url(#mg-hero)"/></svg>
</p>

<p align="center" style="font-size:2.5rem;font-weight:800;letter-spacing:-0.02em">Meridian</p>

## What Meridian is

A non-custodial USDC yield aggregator on Stellar, built for savers in unstable-currency economies. Deposits are routed across Blend and DeFindex, whichever is paying more, while custody stays with the saver's own wallet (Freighter, xBull, or LOBSTR). Meridian is live on Stellar mainnet. See [Mainnet Deployment](../operations/mainnet-deployment.md) for the current deployment's status. The brand exists to make that trustworthy and legible to people who have every reason to be skeptical of anything claiming to protect their money.

**Stability:** dollar-denominated and stablecoin-based. The goal is capital that holds its value first and grows second.

**Convergence:** capital doesn't sit in one place. Meridian continuously finds and settles on whichever protocol is paying more.

**Self-custody:** Meridian never holds user funds. Ownership stays in the saver's own wallet, always.

**Plain language:** built for everyday savers, not crypto natives. No jargon where a plain sentence will do.

**Audience:** emerging-market savers, West Africa first. Their local currency has already taught them not to trust promises about their money.

**Voice:** direct, calm, specific. States what happens and why. Never hypes a rate, hides material risk, or overstates the current state of the deployment.

## Logo & concept: Convergence

Three arcs share one center: Blend, DeFindex, and room for whatever routes are added later. Each ends flush on the same line instead of trailing off. The landing dot is where a deposit actually sits, not a fixed point but wherever the outermost arc currently resolves. One continuous idea, not a letterform or a borrowed icon.

The construction uses four concentric radii (r14, r11, r8, r5) from one center on a 40×40 unit grid, and the fourth radius (r5) is the landing dot.

**Clear space:** the minimum clear space on every side equals the radius of the landing dot. Nothing else (text, edges, other marks) enters that margin.

**Minimum size:** 16px digital. Icon only, no gradient below this size.

## Logo variations

<table style="table-layout:fixed;width:100%">
<tr>
<td width="25%" align="center" style="background:#070d19;padding:24px;border-radius:8px">
  <svg viewBox="4 4 32 17" width="72" fill="none"><defs><linearGradient id="mg-dark" x1="34" y1="20" x2="17" y2="17" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#10b981"/></linearGradient></defs><path d="M34 20 A14 14 0 0 0 6 20 A11 11 0 0 1 28 20 A8 8 0 0 0 12 20 A5 5 0 0 1 22 20" stroke="url(#mg-dark)" stroke-width="2.25"/><circle cx="17" cy="17.3" r="2.6" fill="url(#mg-dark)"/></svg><br/>
  <span style="color:#f0f4ff;font-size:13px">Dark (default)</span>
</td>
<td width="25%" align="center" style="background:#f4f6fb;padding:24px;border-radius:8px">
  <svg viewBox="4 4 32 17" width="72" fill="none"><defs><linearGradient id="mg-light" x1="34" y1="20" x2="17" y2="17" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#10b981"/></linearGradient></defs><path d="M34 20 A14 14 0 0 0 6 20 A11 11 0 0 1 28 20 A8 8 0 0 0 12 20 A5 5 0 0 1 22 20" stroke="url(#mg-light)" stroke-width="2.25"/><circle cx="17" cy="17.3" r="2.6" fill="url(#mg-light)"/></svg><br/>
  <span style="color:#070d19;font-size:13px">Light</span>
</td>
<td width="25%" align="center" style="background:#10b981;padding:24px;border-radius:8px">
  <svg viewBox="4 4 32 17" width="72" fill="none"><path d="M34 20 A14 14 0 0 0 6 20 A11 11 0 0 1 28 20 A8 8 0 0 0 12 20 A5 5 0 0 1 22 20" stroke="#070d19" stroke-width="2.25"/><circle cx="17" cy="17.3" r="2.6" fill="#070d19"/></svg><br/>
  <span style="color:#070d19;font-size:13px">On green</span>
</td>
<td width="25%" align="center" style="background:#f0f4ff;padding:24px;border-radius:8px">
  <svg viewBox="4 4 32 17" width="72" fill="none"><path d="M34 20 A14 14 0 0 0 6 20 A11 11 0 0 1 28 20 A8 8 0 0 0 12 20 A5 5 0 0 1 22 20" stroke="#070d19" stroke-width="2.25"/><circle cx="17" cy="17.3" r="2.6" fill="#070d19"/></svg><br/>
  <span style="color:#070d19;font-size:13px">Monochrome</span>
</td>
</tr>
</table>

**Small sizes and favicon:** the gradient drops to `#10B981` below 24px so it never bands, and below that size it's icon only. Never pair the mark this small with the wordmark. See `apps/web/public/brand/` for the source SVGs (`logo-mark.svg`, `logo-mark-solid.svg`) and the rendered favicons at 16, 32, 180, and 512px.

## Misuse

The mark is one specific shape, one specific gradient direction, drawn once. Every rule below protects something load-bearing, not something decorative.

- **Don't recolor it**, since blue-to-green represents capital entering and settling.
- **Don't stretch or squash it.** Scale uniformly, always.
- **Don't rotate it**, because the baseline is a fixed horizon, not a wheel.
- **Don't add shadows, glow, or bevel.** It's flat, always.
- **Don't redraw the geometry.** No extra rings, dashed lines, or rounded caps.
- **Don't place it on a busy or low-contrast background.**

## Color

Six colors, all now consistently applied across the app, the landing page, and this documentation site.

<table>
<tr><td width="72" style="background:#070d19;border-radius:6px">&nbsp;</td><td><strong>Night</strong> (<code>#070D19</code>): primary background</td></tr>
<tr><td style="background:#0d1e35;border-radius:6px">&nbsp;</td><td><strong>Deep</strong> (<code>#0D1E35</code>): surfaces, cards, favicon tiles</td></tr>
<tr><td style="background:#f0f4ff;border-radius:6px">&nbsp;</td><td><strong>Paper</strong> (<code>#F0F4FF</code>): primary text, light backgrounds</td></tr>
<tr><td style="background:#3b82f6;border-radius:6px">&nbsp;</td><td><strong>Entry</strong> (<code>#3B82F6</code>): where capital comes in</td></tr>
<tr><td style="background:#10b981;border-radius:6px">&nbsp;</td><td><strong>Settled</strong> (<code>#10B981</code>): where capital lands</td></tr>
<tr><td style="background:linear-gradient(90deg,#3b82f6,#10b981);border-radius:6px">&nbsp;</td><td><strong>Convergence gradient</strong>: Entry to Settled, mark only</td></tr>
</table>

**Usage:** Night is the default surface. The product is dark by default, and light is the alternate, not the other way round. The gradient belongs to the mark alone, never applied to text, buttons, or UI chrome.

**Contrast:** Paper on Night is 17.7:1, Entry on Night is 5.3:1, and Settled on Night is 7.7:1. All pass WCAG AA for text at any size used in product.

## Typography

The product uses one type family, **Inter**, with no exceptions. It's already the product's system font, so the mark carries the personality while the type stays out of the way and stays legible on low-end Android screens.

| Style | Size / weight                            | Usage                          |
| ----- | ---------------------------------------- | ------------------------------ |
| H1    | 56px / 800, -2% tracking                 | Page titles, hero statements   |
| H2    | 32px / 700                               | Section headings               |
| Body  | 19px / 400, 1.6 line-height              | Paragraphs, descriptions       |
| Label | 11-13px mono, uppercase, 14-16% tracking | Status, metadata, eyebrow text |

## Applications

- **App icon:** the mark on a dark (`#0D1E35`) tile with rounded corners.
- **Browser tab and favicon:** the mark in green below 24px, the gradient mark at 32px and above, on the same dark tile.
- **Product header:** the gradient mark at small scale beside the "Meridian" wordmark.
- **Social avatar:** the mark inverted, a dark stroke on a green circle.

See `apps/web/public/brand/logo-mark.svg` and `logo-mark-solid.svg` for the source files these are generated from.
