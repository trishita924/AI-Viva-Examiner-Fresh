# Privacy & Data Handling Policy

This document explains how **AI Viva Examiner** processes your study notes, answers, and evaluation results.

## 1. Document Extraction in the Browser
- When you upload a **PDF**, **DOCX**, or **TXT** file, the text extraction runs locally inside your web browser using PDF.js, Mammoth.js, or the browser File API.
- The original binary file itself is not uploaded to the backend server.

## 2. Backend & Google Gemini API Processing
- When you start a viva examination, the extracted study text and your submitted answers are sent over HTTP/HTTPS to the **Express.js backend**.
- The backend forwards the relevant study text, questions, and answers to the **Google Gemini API** (`@google/genai` Interactions API with `store: false`) to generate questions, evaluate responses, ask follow-up clarifications, and compile your final report.
- **This application is not purely local**: an active backend connection and Google Gemini API processing are required for all AI features.

## 3. Data Retention & Logging
- **No Permanent Server Storage**: The backend does not use a database or file storage to permanently save your uploaded notes, questions, or answers. Data is held in memory only for the duration of each API request, and Gemini Interactions API requests explicitly set `store: false`.
- **Privacy-Safe Server Logs**: The backend logs only operational metadata (HTTP method, endpoint path, status code, and response time). It never logs your study notes or student answers.
- **Browser Local Storage**: Your configured backend URL and a summary of past viva scores (source filename, date, total score, percentage, and classification) are stored in your browser's `localStorage` for convenience. Raw study notes are not saved in history, and you can clear history at any time using the **Clear** button.

## 4. Security Practices
- Your `GEMINI_API_KEY` is stored strictly on the backend via environment variables and is never exposed to the browser.
- Production deployments use HTTPS, Helmet security headers, rate limiting, and explicit CORS origin allowlists.
