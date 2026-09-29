# Dish recognition integration

This repository is the GitHub Pages web build, not the application's original source project. The integration is attached to the existing app bundle so it can be exercised without replacing unrelated assets.

## Flow

1. When a meal photo is selected in the existing publish form, recognition starts automatically. `assets/dish-recognition.js` resizes a browser-side copy to at most 1280 px and JPEG quality 0.82. The original file remains the meal photo upload.
2. The browser sends the resized copy to the `recognize-dishes` Edge Function with the current Supabase Auth JWT. The model credential is never sent to the browser. The local implementation accepts both the deployed JSON response and the proposed newline-delimited stream so it remains compatible during rollout.
3. The review dialog shows one crop per dish and an editable name. “Fill names” copies the reviewed names into the existing meal form.
4. On the existing meal-photo Storage upload and `meals` upsert, the browser request hook adds normalized `bbox`, `confidence`, and `needs_confirmation` values to the matching `dishes` JSONB entries. It prefers exact names and preserves separate boxes for repeated dish names; if the form still has a one-to-one dish list after a rename, unmatched names keep their original crop by order. If a meal photo is replaced without a fresh recognition result, stale crop metadata is removed while dish names remain. No base64 thumbnails are stored in Postgres.
5. After publishing, the recent-meal card can show “查看菜品截图”. It reads the matching meal row and public photo already used by the app, then recreates the crops in the browser. This display step makes no model request and performs no photo or database writes.

The current app has no fixed dish-count limit. Users can add a missed dish manually even after recognition finishes.

## Progressive results

The deployed Edge Function asks the Qwen model for streamed JSON and forwards each complete dish as soon as it can be safely parsed. Early results can be checked while later dishes continue. This can reduce time-to-first-edit, but does not reduce the model's total generation time or call count. The browser also accepts a complete JSON response for compatibility.

## Function configuration

- Project: `lbzuahqvdzwwxqxbbohd`
- Function: `recognize-dishes`
- `verify_jwt = true`; the current app signs in anonymously and stores its session under the standard Supabase Auth key.
- The `SILICONFLOW_API_KEY` is configured as a Supabase Edge Function secret; it is intentionally absent from this repository and browser code.
- The function uses `Qwen/Qwen3.5-4B`, low image detail, disabled reasoning, a 900-token output cap, and a 28-second model timeout. Check current provider availability and pricing before changing models.
- Browser CORS is restricted to the GitHub Pages origin and local preview ports in `index.ts`.
- The function was confirmed active in project `lbzuahqvdzwwxqxbbohd` as version 3 on 2026-09-30, with JWT verification enabled.

## Verification and current limits

Run the local integration tests with Node 24 or later:

```sh
node --experimental-strip-types --test tests/*.test.mjs
```

These tests cover browser-side crop geometry, JSONB bbox attachment, function auth/CORS behavior, normalization, the selected model settings, malformed requests, context size, and the in-memory per-user rate limit. They do not substitute for a Deno Edge Runtime deployment test.

The current rate limiter is best-effort and is local to each Edge Function instance. Before relying on a strict quota, add a persistent per-user/IP quota or other abuse control. Local tests use a mocked upstream stream; they do not establish that SiliconFlow or Supabase will flush a streamed response promptly in production.

### Historical live timing check (2026-09-28)

An earlier JSON-response version returned in about 18 s for one existing public meal photo, with four editable candidates and two usable crops. Other calls took about 15.7 s and 24.6 s; several hit the 28 s model timeout. This is historical baseline data, not a current latency guarantee for the streamed version 3 function. Provider response time remains the main open performance risk.
