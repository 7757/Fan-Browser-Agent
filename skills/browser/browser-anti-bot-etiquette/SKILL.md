---
name: browser-anti-bot-etiquette
description: "Use when a site appears to be blocking automation — endless reloads, blank/white pages, interstitial challenges, or actions that silently keep failing. Recognize the block, stop gracefully and tell the user, never brute-force retry, and respect robots/login/CAPTCHA boundaries (route CAPTCHAs to a human, do not solve them)."
version: 1.0.0
author: Fan Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  fan:
    tags: [browser, anti-bot, etiquette, rate-limit, captcha, blocking, eb-tools, ethics]
    related_skills: [browser-element-inspection, browser-scroll-recovery, browser-form-filling, fan-agent]
    fallback_for_toolsets: [browser_program]
---

# Browser Anti-Bot Etiquette

## Overview

Many sites actively detect and block automation: Cloudflare/Akamai/PerimeterX interstitials, rate-limit walls, "unusual traffic" pages, bot challenges, and silent shadow-blocks where every action quietly no-ops. When you hit one of these, the worst thing you can do is keep hammering — repeated reloads and clicks raise your fingerprint, can escalate the block to the user's IP/account, and waste turns. The right move is to *recognize* the block, *stop*, and *hand back to the user* with a clear explanation.

This skill is about restraint and detection, not evasion. You do not bypass protections, spoof fingerprints, or solve CAPTCHAs. You detect the wall, back off, and report.

## When to Use

- A page reloads itself over and over, or `browser_observe` keeps returning a near-empty/blank DOM.
- You see challenge text: "Verify you are human", "Checking your browser", "Unusual traffic", "Access denied", "Rate limit exceeded", HTTP 403/429.
- Repeated `browser_click` / `browser_type` actions land but the page state never advances (silent shadow-block).
- A login wall, paywall, or CAPTCHA stands between you and the goal.
- Don't use for: ordinary slow loads (use `browser_settle` / `browser_wait`), or content merely below the fold (use `browser-scroll-recovery`). Those are not blocks.

## Recognize the Block

Read the latest observation and look for these signals. Use `browser_element` / `browser_evaluate_js` to confirm rather than guessing from a screenshot.

| Signal | How to confirm | Likely cause |
|---|---|---|
| Blank/white page, tiny DOM | `browser_observe` returns few/no interactive elements | JS challenge or hard block |
| Page reloads on a loop | DOM/URL keep resetting across `browser_observe` calls | "Checking your browser" interstitial |
| Challenge text on page | `browser_search_page(query="unusual traffic")` / `browser_search_page(query="verify you are human")` | Bot challenge / rate limit |
| Actions land but nothing changes | re-`browser_observe` after the action — same state, same indices | Shadow-block / soft ban |
| 403 / 429 / "Access denied" | `browser_evaluate_js(code="document.title")` or page text | HTTP-level block / rate limit |
| CAPTCHA widget present | `browser_find_elements(selector="iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[title*='challenge']")` | CAPTCHA gate |

A single failed action is not a block. A *pattern* — the same non-progress two or three times in a row, or an explicit challenge string — is.

## Back Off Gracefully — The Stop Rule

Once you have confirmed a block, **stop driving the page**. Do not enter a reload/retry loop. Concretely:

1. **At most one gentle recovery attempt.** A single `browser_settle` (in case it was a slow interstitial that resolves itself) or **one** `browser_reload`. If the block persists after that, do not try again.
2. **Do not escalate.** No rapid-fire reloads, no clicking the challenge repeatedly, no switching tabs to retry the same URL, no faster typing. Each retry strengthens the site's bot signal.
3. **Capture evidence once.** Take a single `browser_screenshot()` and read the challenge text (`browser_search_page` / `browser_evaluate_js(code="document.body.innerText")`, capped) so you can describe exactly what blocked you.
4. **Report and hand back.** Tell the user plainly: which site, what kind of wall (CAPTCHA / "checking your browser" / 403 / login / rate limit), what you tried, and what you need from them (solve the CAPTCHA in the visible browser, log in manually, or confirm they want you to wait and retry later).

The block is information, not a failure to grind through. A clean stop with a clear explanation is the correct outcome.

## CAPTCHA — Route to a Human, Never Solve

When the wall is a CAPTCHA (reCAPTCHA, hCaptcha, Turnstile, image/text challenge):

- **Do not attempt to solve it** — not by clicking image tiles, not via `browser_evaluate_js`, not through any third-party solver. Solving CAPTCHAs defeats a protection the site owner put up on purpose.
- The browser is embedded and **visible to the user**. The right pattern is to pause and let the *human* complete the challenge in that visible browser, then continue. If a `captcha-wait` skill is available in this session, follow it to pause and resume; otherwise, stop and ask the user to solve the challenge in the browser, then tell you when it's done.
- After the human solves it, re-`browser_observe` and continue from the post-challenge state.

## Respect Site Boundaries

- **robots / Terms.** If the user's goal requires hammering a site that clearly resists automation, surface that tension instead of silently powering through. Honor obvious "no automation" signals.
- **Login walls.** Do not guess credentials or attempt to brute-force a login. Ask the user to log in manually in the visible browser, then resume on the authenticated page.
- **Rate limits (429 / "slow down").** Stop. Report that the site is rate-limiting. Do not invent a backoff-and-retry loop — ask the user whether to wait and retry later. Never fabricate delays or counts (no magic numbers); if a wait is needed, get the duration from the user or the site's own `Retry-After`.
- **Paywalls.** Report the paywall; do not try to circumvent it.

## Common Pitfalls

1. **Retry loops.** Reloading or re-clicking a challenge repeatedly is the single biggest mistake — it escalates the block and burns turns. One gentle recovery attempt, then stop.

2. **Mistaking a slow load or below-the-fold content for a block.** Use `browser_settle`/`browser_wait` for slow pages and `browser_scroll`/`browser_scroll_to_text` for hidden content before concluding you're blocked.

3. **Trying to solve a CAPTCHA.** Out of scope and against the site's intent. Hand it to the human in the visible browser.

4. **Silently continuing after a shadow-block.** If actions land but state never advances, you are blocked — stop and report, don't keep "trying harder."

5. **Inventing backoff timings or retry caps.** Don't guess "wait 30s, retry 3x." Ask the user or read the site's `Retry-After`. Arbitrary magic numbers are wrong here.

6. **Powering through a login/paywall.** Never brute-force or guess credentials. Ask the user to authenticate in the visible browser.

7. **Not capturing evidence before stopping.** Take one screenshot and read the challenge text so your report to the user is concrete, not "it didn't work."

## Verification Checklist

- [ ] Confirmed a *pattern* of blocking (repeated non-progress or explicit challenge text), not a one-off failure
- [ ] Made at most one gentle recovery attempt (`browser_settle` or a single `browser_reload`), then stopped
- [ ] Did NOT enter a reload/retry loop or speed up actions to "get past" the wall
- [ ] Captured one `browser_screenshot` and read the challenge text for the report
- [ ] CAPTCHA routed to the human in the visible browser (or `captcha-wait`), never auto-solved
- [ ] Login/paywall handed to the user, no credential guessing
- [ ] Reported to the user: site, block type, what was tried, and what's needed from them — no invented backoff numbers
