/**
 * Local browser storage helpers for backend URL configuration and recent viva history.
 * Note: Raw study notes are never persisted in history.
 */

const STORAGE_KEYS = {
  BACKEND_URL: 'ai_viva_backend_url',
  VIVA_HISTORY: 'ai_viva_history'
};

const MAX_HISTORY_ITEMS = 10;
const STATIC_DEV_PORTS = new Set(['5500', '5501', '5173', '4173', '8000', '8080', '3000']);

export function getDefaultBackendUrl() {
  if (typeof window === 'undefined' || !window.location) {
    return 'http://localhost:3001';
  }

  const { protocol, hostname, port, origin } = window.location;
  if (protocol !== 'http:' && protocol !== 'https:') {
    return 'http://localhost:3001';
  }

  if (hostname.endsWith('.github.io')) {
    return '';
  }

  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    if (STATIC_DEV_PORTS.has(port)) {
      return `http://${hostname}:3001`;
    }
    return origin;
  }

  // Full-stack deployment served directly from the backend origin (e.g. Render)
  return origin;
}

export function hasSavedBackendUrl() {
  try {
    if (typeof localStorage === 'undefined') return false;
    const saved = localStorage.getItem(STORAGE_KEYS.BACKEND_URL);
    return Boolean(saved && typeof saved === 'string' && saved.trim());
  } catch {
    return false;
  }
}

export function getSavedBackendUrl() {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEYS.BACKEND_URL);
      if (saved && typeof saved === 'string' && saved.trim()) {
        return saved.trim().replace(/\/+$/, '').replace(/\/api(?:\/health)?$/i, '');
      }
    }
  } catch {
    // Ignore storage access errors
  }
  return getDefaultBackendUrl();
}

export function saveBackendUrl(url) {
  const normalized = (url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api(?:\/health)?$/i, '');
  try {
    if (typeof localStorage !== 'undefined') {
      if (normalized) {
        localStorage.setItem(STORAGE_KEYS.BACKEND_URL, normalized);
      } else {
        localStorage.removeItem(STORAGE_KEYS.BACKEND_URL);
      }
    }
  } catch {
    // Ignore storage access errors
  }
  return normalized;
}

export function getVivaHistory() {
  try {
    if (typeof localStorage === 'undefined') return [];
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
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.VIVA_HISTORY, JSON.stringify(updated));
    }
  } catch {
    // Ignore storage quota errors
  }
  return updated;
}

export function clearVivaHistory() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEYS.VIVA_HISTORY);
    }
  } catch {
    // Ignore storage access errors
  }
  return [];
}
