# AI Viva Examiner

An interactive oral examination (viva voce) web application powered by **Google Gemini** (`@google/genai` Interactions API). Upload PDF, DOCX, or TXT study notes—or paste text directly—and take a structured 5-question oral exam with adaptive follow-up probing, rubric-based scoring, and a detailed final performance report.

---

## Key Features

- **Browser-Side Document Extraction**: Extracts text locally in the browser from **PDF** (via PDF.js), **DOCX** (via Mammoth.js), and **TXT** files (up to 10 MB / 40,000 characters) without uploading raw binary documents to the server.
- **5-Question Adaptive Viva Voce**: Generates 5 non-duplicate, note-grounded questions alternating between **conceptual** and **application-based** prompts.
- **Targeted Follow-Up Probing**: When an answer is partially correct or incomplete, the examiner asks up to **1 follow-up clarification** per question, preserves the original answer in the UI, and grades both responses together.
- **Deterministic Scoring & Standing**:
  - Each question is scored `0–5` (normalized to `0.5` increments), for a total out of **25 marks**.
  - Classifications are computed deterministically on the backend:
    - **Distinction**: `≥ 85%`
    - **Merit**: `≥ 70%`
    - **Pass**: `≥ 50%`
    - **Needs Improvement**: `< 50%`
- **Comprehensive Final Report**: Summarizes overall performance, strengths, areas to improve, revision priorities, and a full question-by-question breakdown.
- **Recent Viva History**: Saves up to 10 completed score summaries in browser `localStorage` (raw study notes are never saved).
- **Unified Full-Stack & Split Deployment Support**: Express serves both the REST API (`/api/*`) and the static frontend out of the box on a single port, while also supporting standalone frontend hosting (e.g., GitHub Pages / Live Server) connected to a remote Express backend.
- **Privacy-First Design**: Uses Gemini Interactions API with `store: false`, holds request data transiently in memory only, logs only operational metadata (never notes or student answers), and keeps `GEMINI_API_KEY` strictly server-side. See [PRIVACY.md](PRIVACY.md).

---

## Architecture

```text
+-----------------------------------+        HTTP/HTTPS (JSON)        +-----------------------------------+
|       Browser Frontend            |  <--------------------------->  |     Express.js Backend            |
|  index.html, css/, js/            |                                 |  backend/app.js, server.js        |
|  - PDF.js / Mammoth.js / File API |   /api/health                   |  - Helmet CSP, CORS, Rate Limiter |
|  - Setup, Viva Exam, Report UI    |   /api/generate-question        |  - Payload Validation & Grading   |
|  - localStorage (URL & scores)    |   /api/evaluate-answer          |  - Serves static frontend (/)     |
+-----------------------------------+   /api/generate-report          +-----------------+-----------------+
                                                                                        |
                                                                                        | @google/genai
                                                                                        | (Interactions API, store: false)
                                                                                        v
                                                                      +-----------------------------------+
                                                                      |       Google Gemini API           |
                                                                      |   Default: gemini-3.8-flash       |
                                                                      +-----------------------------------+
```

---

## Project Structure

```text
AI-Viva-Examiner-Fresh/
├── index.html                  # Main SPA shell (Setup, Examination, Final Report views)
├── css/
│   └── style.css               # Dark-theme responsive styling & breakpoints (920px, 640px)
├── js/
│   ├── app.js                  # Application state machine, UI rendering, error recovery
│   ├── api.js                  # Centralized backend API client with timeouts & abort support
│   ├── file-extractor.js       # Browser-side PDF, DOCX, and TXT text extraction & validation
│   └── storage.js              # Backend URL auto-detection & localStorage history helpers
├── assets/
│   └── icons/
│       ├── favicon.svg
│       └── logo.svg
├── backend/
│   ├── app.js                  # Express app factory (security, CORS, API routes, static hosting)
│   ├── server.js               # HTTP server entrypoint & graceful shutdown
│   ├── package.json            # Dependencies & npm scripts
│   ├── .env.example            # Environment variable template
│   ├── routes/
│   │   └── vivaRoutes.js       # REST route handlers & strict payload validation
│   ├── services/
│   │   └── geminiService.js    # @google/genai Interactions client, JSON schemas, score math
│   ├── middleware/
│   │   └── errorHandler.js     # AppError, 404 handler, and centralized JSON error formatting
│   └── tests/
│       ├── viva.test.js        # Backend unit, validation, CORS, and mocked Gemini API tests
│       └── frontend.test.js    # Frontend DOM integrity, extraction, storage & HTTP tests
├── PRIVACY.md                  # Privacy & data handling documentation
├── TESTING-CHECKLIST.md        # Automated & manual QA checklist
└── README.md                   # Project documentation
```

---

## Prerequisites

- **Node.js** `>= 20.0.0` and **npm**
- A **Google Gemini API key** from [Google AI Studio](https://aistudio.google.com/)

---

## Quick Start (Full-Stack Single Command)

Because the Express backend serves both the API (`/api/*`) and the frontend (`index.html`, `css/`, `js/`, `assets/`), you can run the entire connected application with one server:

1. **Install backend dependencies**
   ```bash
   cd backend
   npm install
   ```

2. **Configure environment variables**
   ```bash
   # On macOS / Linux:
   cp .env.example .env

   # On Windows PowerShell:
   Copy-Item .env.example .env
   ```
   Open `backend/.env` and set your real API key:
   ```env
   GEMINI_API_KEY=your_actual_gemini_api_key
   ```

3. **Start the application**
   ```bash
   npm start
   ```
   Open **`http://localhost:3001`** in your browser.
   - The frontend automatically detects the backend at `http://localhost:3001` and displays **Gemini Connected** in the top navigation bar.

> **Using a separate frontend server?**
> If you prefer serving the root directory with VS Code Live Server (`:5500`), `npx serve`, or `python -m http.server 8080`, keep the backend running on port `3001`. Development CORS automatically allows `localhost` and `127.0.0.1` on any port, and the frontend auto-targets `:3001` (or you can set any URL in the **Backend Connection** panel).

---

## Configuration (`backend/.env`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3001` | Port the Express server listens on. |
| `NODE_ENV` | `development` | Set to `production` in deployed environments to enforce strict CORS allowlists and hide 5xx stack details. |
| `GEMINI_API_KEY` | *(required)* | Server-side Google Gemini API key (never exposed to the browser). |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Primary Gemini model ID used for question generation, evaluation, and reporting. |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.5-flash-lite,gemini-3.6-flash` | Optional comma-separated fallback models used automatically on transient `503`/`429` overload (set to `none` to disable). |
| `ALLOWED_ORIGINS` | `http://localhost:5500,...` | Comma-separated allowed frontend origins for CORS (required in production when frontend and backend use different domains). |
| `GEMINI_TIMEOUT_MS` | `35000` | Upstream Gemini API request timeout in milliseconds. |

---

## API Reference

All endpoints accept and return `application/json`. Error responses follow:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description"
  }
}
```

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Returns service health, active Gemini model, and whether `GEMINI_API_KEY` is configured. |
| `POST` | `/api/generate-question` | Generates one conceptual (`Q1/Q3/Q5`) or application (`Q2/Q4`) question grounded in `notes` (`50–40,000` chars). |
| `POST` | `/api/evaluate-answer` | Evaluates a student answer (max `5,000` chars) and optionally returns 1 follow-up clarification question (`needsFollowUp`). |
| `POST` | `/api/generate-report` | Validates the 5 evaluations, computes deterministic totals/percentage/classification, and generates feedback insights. |

---

## Testing

Run syntax verification and the automated backend + frontend test suite (powered by Node's built-in test runner):

```bash
cd backend
npm run check
npm test
```

What is covered automatically:
- **Backend Unit & API Integration (`tests/viva.test.js`)**: Score clamping (`0–5` in `0.5` steps), percentage & classification thresholds, request validation, malformed JSON & oversized payload handling (`400`/`413`), static asset serving & secret isolation (`/backend/.env` returns `404`), dev vs prod CORS enforcement, mocked Gemini Interactions API full viva flow (including 1-follow-up limit), and upstream error mapping (`429`, `400/401/403`, `404`, `504` timeout).
- **Frontend & Contract Verification (`tests/frontend.test.js`)**: Verifies every `document.getElementById` in `js/app.js` matches `index.html`, local asset integrity, backend URL normalization (stripping trailing slashes and `/api`), `localStorage` history capping, file extraction validation, and live HTTP round-trips between `js/api.js` and Express.

For manual live testing steps with a real `GEMINI_API_KEY`, see [TESTING-CHECKLIST.md](TESTING-CHECKLIST.md).

---

## Deployment

### Option A: Single-Service Full-Stack (Render)
1. Deploy the repository root as a Node Web Service on Render.
2. **Build Command**: `cd backend && npm install`
3. **Start Command**: `cd backend && npm start`
4. **Environment Variables**:
   - `NODE_ENV=production`
   - `GEMINI_API_KEY=<your_key>`
   - `GEMINI_MODEL=gemini-3.8-flash`
5. Access your Render URL directly—the frontend automatically connects to its same-origin backend.

### Option B: Split Hosting (GitHub Pages + Render)
1. Deploy `backend/` to Render with `NODE_ENV=production`, `GEMINI_API_KEY`, and `ALLOWED_ORIGINS=https://<your-username>.github.io`.
2. Enable GitHub Pages on the repository root for the static frontend.
3. Open your GitHub Pages site, enter your Render backend URL in the **Backend Connection** panel, and click **Connect**.

---

## Security & Privacy

- `GEMINI_API_KEY` is read exclusively by the Express server from environment variables and is never bundled into frontend JavaScript.
- Rate limiting is applied to `/api/*` (`200` requests / 15 min) with stricter limits on AI endpoints (`60` requests / 15 min).
- Express exposes only `index.html`, `css/`, `js/`, and `assets/` when serving the frontend—`backend/` and `.env` are never publicly accessible.
- Review [PRIVACY.md](PRIVACY.md) for complete data-handling details.
