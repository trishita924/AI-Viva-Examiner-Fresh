/**
 * Centralized frontend-to-backend API client.
 * Never calls Google Gemini directly; all AI requests route through the Express backend.
 */

import { getSavedBackendUrl, saveBackendUrl } from './storage.js';

const REQUEST_TIMEOUT_MS = 50000;
const HEALTH_TIMEOUT_MS = 15000;
const inFlightKeys = new Set();
let healthAbortController = null;

export class ApiError extends Error {
  constructor(message, status = 0, code = 'NETWORK_ERROR') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function getBackendBaseUrl() {
  return getSavedBackendUrl();
}

export function setBackendBaseUrl(url) {
  return saveBackendUrl(url);
}

/**
 * Validates and normalizes a user-entered backend URL.
 * Strips accidental trailing slashes or `/api` suffixes.
 */
export function validateBackendUrl(rawUrl) {
  const trimmed = (rawUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api(?:\/health)?$/i, '');

  if (!trimmed) {
    return { valid: false, error: 'Please enter a backend URL (e.g., http://localhost:3001 or your Render URL).' };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: 'Backend URL must start with http:// or https://.' };
    }
    return { valid: true, url: trimmed };
  } catch {
    return { valid: false, error: 'Invalid URL format. Include http:// or https://.' };
  }
}

/**
 * Core JSON fetch wrapper with timeout, abort support, duplicate submission prevention, and structured errors.
 */
async function requestJson(
  endpoint,
  { method = 'GET', body = null, dedupeKey = null, timeoutMs = REQUEST_TIMEOUT_MS, signal = null, baseUrlOverride = null } = {}
) {
  const baseUrl = baseUrlOverride ?? getBackendBaseUrl();
  if (!baseUrl) {
    throw new ApiError(
      'Backend URL is not configured. Enter your backend URL in the Backend Connection panel.',
      0,
      'BACKEND_URL_MISSING'
    );
  }

  if (dedupeKey && inFlightKeys.has(dedupeKey)) {
    throw new ApiError('A request is already in progress. Please wait.', 0, 'DUPLICATE_REQUEST');
  }

  if (dedupeKey) {
    inFlightKeys.add(dedupeKey);
  }

  const controller = new AbortController();
  let didTimeout = false;
  let externalAborted = false;

  const onExternalAbort = () => {
    externalAborted = true;
    controller.abort();
  };

  if (signal) {
    if (signal.aborted) {
      if (dedupeKey) inFlightKeys.delete(dedupeKey);
      throw new ApiError('Request was cancelled.', 0, 'ABORTED');
    }
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  try {
    const options = {
      method,
      signal: controller.signal
    };

    if (body !== null) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${baseUrl}${endpoint}`, options);
    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const data = isJson ? await response.json().catch(() => null) : null;

    if (!response.ok) {
      const serverMsg = data?.error?.message || `Server returned HTTP ${response.status}.`;
      const serverCode = data?.error?.code || 'SERVER_ERROR';
      throw new ApiError(serverMsg, response.status, serverCode);
    }

    if (!data) {
      throw new ApiError('Backend returned an empty or non-JSON response.', response.status, 'INVALID_RESPONSE');
    }

    return data;
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    if (err?.name === 'AbortError') {
      if (externalAborted && !didTimeout) {
        throw new ApiError('Request was cancelled.', 0, 'ABORTED');
      }
      throw new ApiError('Request timed out while waiting for the Gemini backend.', 504, 'TIMEOUT');
    }
    throw new ApiError(
      'Unable to reach the backend server. Check that the server is running, the URL is correct, and CORS is configured.',
      0,
      'NETWORK_UNREACHABLE'
    );
  } finally {
    clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener('abort', onExternalAbort);
    }
    if (dedupeKey) {
      inFlightKeys.delete(dedupeKey);
    }
  }
}

export async function checkHealth({ timeoutMs = HEALTH_TIMEOUT_MS, baseUrlOverride = null } = {}) {
  if (healthAbortController) {
    healthAbortController.abort();
  }
  const controller = new AbortController();
  healthAbortController = controller;

  try {
    return await requestJson('/api/health', {
      method: 'GET',
      timeoutMs,
      signal: controller.signal,
      baseUrlOverride
    });
  } finally {
    if (healthAbortController === controller) {
      healthAbortController = null;
    }
  }
}

export async function generateQuestion({ notes, questionNumber, totalQuestions = 5, previousQuestions = [], signal = null }) {
  return requestJson('/api/generate-question', {
    method: 'POST',
    body: { notes, questionNumber, totalQuestions, previousQuestions },
    dedupeKey: `generate-question-${questionNumber}`,
    signal
  });
}

export async function evaluateAnswer({
  notes,
  question,
  topic,
  answer,
  isFollowUp = false,
  originalAnswer = '',
  followUpQuestion = '',
  followUpCount = 0,
  signal = null
}) {
  return requestJson('/api/evaluate-answer', {
    method: 'POST',
    body: {
      notes,
      question,
      topic,
      answer,
      isFollowUp,
      originalAnswer,
      followUpQuestion,
      followUpCount
    },
    dedupeKey: 'evaluate-answer',
    signal
  });
}

export async function generateReport({ evaluations, signal = null }) {
  return requestJson('/api/generate-report', {
    method: 'POST',
    body: { evaluations },
    dedupeKey: 'generate-report',
    signal
  });
}
