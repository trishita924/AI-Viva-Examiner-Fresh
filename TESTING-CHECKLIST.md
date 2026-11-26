# Testing Checklist — AI Viva Examiner

## Part A: Automated Static & Structural Checks
- [x] JavaScript syntax check (`node --check`) on all backend and frontend JS modules.
- [x] HTML & asset path verification (`css/style.css`, `js/app.js`, `assets/icons/logo.svg`, `assets/icons/favicon.svg`).
- [x] Frontend DOM reference verification (every `document.getElementById` in `js/app.js` matches an `id` in `index.html`).
- [x] Frontend-to-backend API route & payload contract verification (`/api/health`, `/api/generate-question`, `/api/evaluate-answer`, `/api/generate-report`).
- [x] Deterministic score normalization (`0–5` clamping) and report total/percentage/classification math verification.
- [x] Follow-up answer preservation & 1-follow-up-per-question limit verification.
- [x] Secret & API key exposure scan (no hardcoded keys in frontend or backend).
- [x] Responsive CSS breakpoint check (`920px` tablet and `640px` mobile).

## Part B: Live Integration Tests (Requires Real `GEMINI_API_KEY` & `npm install`)
Run these steps after installing backend dependencies (`npm install`) and setting `GEMINI_API_KEY` in `backend/.env`:

1. **Backend Health**:
   - Start backend (`npm start`) and confirm `GET /api/health` returns `status: "ok"` and `geminiConfigured: true`.
2. **Document Extraction**:
   - Upload a valid `.pdf`, `.docx`, and `.txt` file and verify extracted text, filename, and word count update accurately.
   - Test an empty (0-byte) file, an unsupported file (e.g., `.png`), and a corrupted file to verify clear error messages.
3. **Question Generation**:
   - Start a viva and verify 5 distinct, non-duplicate conceptual and application-based questions grounded in the notes.
4. **Answer Evaluation & Follow-Up**:
   - Submit a partial answer to trigger a follow-up question; confirm original answer remains visible/preserved and combined evaluation produces a score between `0` and `5`.
   - Verify no second follow-up is triggered on the same question.
5. **Final Report**:
   - Complete all 5 questions and verify total marks out of `25`, percentage, classification, strengths, weaknesses, and revision recommendations render accurately.
6. **Error Handling**:
   - Stop the backend or enter an invalid URL and verify the UI displays a clear error without falling back to fake AI evaluation.
