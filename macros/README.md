# Food Tracker

A mobile-first PWA: photograph any food, Claude's vision API estimates its macros
(calories, protein, carbs, fat), and the app tracks your intake against daily goals —
all stored on your device.

## Features

- 📷 **Photo → macros** — snap a photo, Claude identifies the food, estimates the portion,
  and returns calories/protein/carbs/fat. Review and edit the estimate before saving.
- ✏️ **Manual entry & quick re-log** — log without a photo, or one-tap re-log recent foods.
- 🎯 **Daily goals** — set targets for calories and each macro, with two calorie modes:
  *stay under* (cutting) or *hit target* (±10%).
- 🔥 **Streaks & badges** — see at a glance which days hit the goal, and your current streak.
- 📊 **History** — 7-day calorie chart with your goal line, weekly averages, goal hit rate,
  and a per-day log.
- 📦 **Export** — download your full log as CSV or JSON.
- 🔒 **Private** — entries live in your browser's IndexedDB; your API key stays in
  localStorage on your device. Nothing is sent anywhere except food photos to the
  Anthropic API for analysis.

## Setup

1. **Host it** (camera access and service workers require HTTPS or `localhost`):

   - **Cloudflare Pages / Netlify / Vercel** (free, works with this private repo):
     connect the repo, no build command, output directory `/`. Every push auto-deploys.
   - **GitHub Pages** (needs a public repo or GitHub Pro): Settings → Pages →
     deploy from `main`, root folder.
   - **Locally** for development:

     ```sh
     npx serve .
     ```

2. **Get an Anthropic API key** at [console.anthropic.com](https://console.anthropic.com)
   and paste it into the app's **Settings** tab. It's stored only on your device.

3. **Install to your home screen** — open the app in your phone's browser and choose
   "Add to Home Screen" for a full-screen, app-like experience.

## How the analysis works

The app downscales your photo to ≤1024px, then calls the Anthropic Messages API directly
from the browser (`anthropic-dangerous-direct-browser-access` header) using the
`claude-opus-4-8` model with a structured-output JSON schema, so the response is always
machine-readable: food name, portion estimate, macros, confidence, and caveats.

Estimates are estimates — portion size from a single photo is inherently approximate.
The review screen lets you correct anything before saving.
