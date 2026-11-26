/**
 * Local browser storage helpers for backend URL configuration and recent viva history.
 * Note: Raw study notes are never persisted in history.
 */

const STORAGE_KEYS = {
  BACKEND_URL: 'ai_viva_backend_url',
  VIVA_HISTORY: 'ai_viva_history'
};

const MAX_HISTORY_ITEMS = 10;

export function getDefaultBackendUrl() {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3001';
  }
  return '';
}

export function getSavedBackendUrl() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.BACKEND_URL);
    if (saved && typeof saved === 'string') {
      return saved.trim().replace(/\/+$/, '');
    }
  } catch {
    // Ignore storage access errors
  }
  return getDefaultBackendUrl();
}

export function saveBackendUrl(url) {
  const normalized = (url || '').trim().replace(/\/+$/, '');
  try {
    if (normalized) {
      localStorage.setItem(STORAGE_KEYS.BACKEND_URL, normalized);
    } else {
      localStorage.removeItem(STORAGE_KEYS.BACKEND_URL);
    }
  } catch {
    // Ignore storage access errors
  }
  return normalized;
}

export function getVivaHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.VIVA_HISTORY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveVivaHistoryItem(entry) {
  const current = getVivaHistory();
  const updated = [entry, ...current].slice(0, MAX_HISTORY_ITEMS);
  try {
    localStorage.setItem(STORAGE_KEYS.VIVA_HISTORY, JSON.stringify(updated));
  } catch {
    // Ignore storage quota errors
  }
  return updated;
}

export function clearVivaHistory() {
  try {
    localStorage.removeItem(STORAGE_KEYS.VIVA_HISTORY);
  } catch {
    // Ignore storage access errors
  }
  return [];
}
