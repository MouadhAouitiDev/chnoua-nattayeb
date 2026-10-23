# Changes

## Cuisine bug (Italian -> Tunisian)
- api/chnoua.js: the frontend offers 37 cuisines, the backend knew 8; every unknown id silently became Tunisian.
  Now all 37 ids are mapped, an unknown id returns 400.
- The language rules ("keep Tunisian dish names, e.g. ojja, lablabi...") biased the model toward Tunisian food even for
  Italian/Japanese/etc. They are now only added for the Tunisian cuisine.
- Strict "RÈGLE CUISINE" in the prompt for non-Tunisian cuisines + the user turn starts with "Cuisine demandée : ...".
- Server-side audit: Tunisian dishes returned for another cuisine are rejected, retried once with feedback, never returned as-is.
- "More ideas" sends the dishes already shown (exclude) so the same 3 dishes are not repeated.

## Account
- Auth.js was in the project root: /api/auth returned 404. Moved to api/auth.js.
- Double tap on "Create account" sent 2 requests and showed "account already exists": button is now disabled while sending.
- Native browser validation (browser language, different rules) replaced by translated inline messages, same email regex as the server.
- Show/hide password, autofocus, no autocapitalize on email, error cleared when switching tabs, click on backdrop closes.
- "Log in to save" is a hint (grey), not a red error; the heart tapped before login is saved after login.
- Login returns the favorites (one request less that can fail after a successful login).
- Rate limit counts failures only (typos no longer lock people out), cookie 'Secure' only on https (works on localhost).

## Less scrolling (mobile 5410px -> 1377px)
- Cuisines: one swipeable row of 9 + "See all (37)"; the chosen cuisine is always visible.
- Ingredient shelf: 14 chips + "Show more"; Enter in the search box adds any ingredient; textarea moved in a collapsed "type them yourself".
- Nutrition studio collapsed by default.
- Recipes: steps collapsed except for the first recipe; page scrolls to the results.
- robots -> robots.txt

## 2026-10-23 updates
- Added an animated cooking pot in the ingredient area, with steam, lid movement, bubbling ingredients and flames; respects reduced-motion preferences.
- Added Arabic dialect selection for Tunisian, Algerian, Moroccan, Libyan and Egyptian Arabic. The selected dialect is sent to the recipe API and used in the generation instructions.
- Added a Premium / Pro pack entry point that requires account creation before continuing. Actual paid-feature access remains locked until a payment provider and subscription verification are integrated; account creation alone does not grant paid access.
