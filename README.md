# HS AI Solutions Portfolio — Moon AI Assistant + Site Telemetry

This bundle contains the portfolio, a locally bundled AI-neural-network background video, the Moon AI assistant, and privacy-aware opt-in aggregate telemetry.

## 1. Configure your AI API key

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Set `API_KEY`, `API_BASE_URL`, and `API_MODEL` for the OpenAI-compatible API provider you choose.
4. Set `TELEMETRY_ADMIN_TOKEN` to a long random secret. Keep it private.
5. Run:

   ```bash
   npm install
   npm start
   ```

6. Open `http://localhost:3000`.

The API key is read by the server only. Do not put it in `index.html`, client-side JavaScript, or a public repository. The backend expects an OpenAI-compatible `POST /chat/completions` endpoint. Provider base URLs and model IDs vary, so use the exact values from your provider dashboard.

## 2. Hosting

Deploy this entire folder as a Node web service (for example, a Node service on Render). Set the environment variables in the hosting dashboard; do not upload `.env`. Build command: `npm install`. Start command: `npm start`. If the host has an ephemeral filesystem, configure a persistent disk and set `DATA_DIR` to its mount path if you want telemetry to survive restarts/redeploys.

### Keep the frontend on Vercel (optional)

You can leave your portfolio on Vercel and deploy this Node backend as a separate service. In `index.html`, set `<meta name="hs-api-base" content="https://YOUR-BACKEND-HOST">` to the deployed backend origin (no trailing slash). In the backend environment, set `SITE_ORIGIN` to your exact Vercel portfolio origin, for example `https://your-site.vercel.app`. This allows the browser to call the backend across origins. The backend also serves the portfolio itself if you prefer a single Node deployment. Do not place the API key in the Vercel frontend environment if it is exposed to browser code; it belongs only in the backend environment.

## 3. Assistant scope

The server system prompt restricts the assistant to Harshan Seliyan, HS AI Solutions, its own projects, and authorized site telemetry. It will politely redirect requests asking it to recommend or promote other organizations/products. The prompt is a behavioral instruction, not a cryptographic guarantee; do not use the assistant as an access-control boundary for sensitive data.

## 4. Telemetry and consent

Analytics is opt-in. Visitors can allow or decline. The backend stores aggregate counts for page views, interaction labels, time-on-page seconds, and consent grants. It does not intentionally store IP addresses, user-agent strings, full URL query strings, or chat message content. No visitor IDs are stored, so unique visitor counts cannot be calculated. Check your hosting provider's own access logs and privacy policy separately.

Private telemetry is available to the site owner only when the `TELEMETRY_ADMIN_TOKEN` matches. In the chat widget, click **SITE OWNER**, enter the token, save it for that browser tab, then ask for site telemetry. The token is sent only in the request header and stored in sessionStorage for that tab. `GET /api/telemetry/summary` is also protected by the same token.

## 5. Background video

`assets/hero-background.mp4` is a locally bundled, generated abstract neural-network animation in the portfolio's charcoal, copper, and sage palette. Keep the `assets` folder beside `index.html` when deploying.
