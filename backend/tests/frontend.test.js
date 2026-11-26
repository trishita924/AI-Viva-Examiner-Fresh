import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { createApp } from '../app.js';
import { setClientFactory, resetClientFactory } from '../services/geminiService.js';
import {
  validateBackendUrl,
  checkHealth,
  generateQuestion,
  evaluateAnswer,
  generateReport,
  setBackendBaseUrl
} from '../../js/api.js';
import {
  extractTextFromFile,
  countWords,
  MAX_EXTRACTED_CHARS,
  MAX_FILE_SIZE_BYTES
} from '../../js/file-extractor.js';
import {
  getDefaultBackendUrl,
  getSavedBackendUrl,
  saveBackendUrl,
  saveVivaHistoryItem,
  getVivaHistory,
  clearVivaHistory
} from '../../js/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');

function createMockLocalStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    }
  };
}

afterEach(() => {
  resetClientFactory();
  delete globalThis.window;
  delete globalThis.localStorage;
  process.env.NODE_ENV = 'test';
});

describe('Frontend DOM & Asset Integrity', () => {
  it('verifies every getElementById in js/app.js exists in index.html', () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'app.js'), 'utf8');

    const idMatches = [...appJs.matchAll(/document\.getElementById\(['"]([^'"]+)['"]\)/g)];
    assert.ok(idMatches.length > 30, 'Expected DOM bindings in js/app.js');

    for (const match of idMatches) {
      const id = match[1];
      assert.ok(
        html.includes(`id="${id}"`) || html.includes(`id='${id}'`),
        `Missing element id="${id}" in index.html`
      );
    }
  });

  it('verifies referenced local assets exist on disk', () => {
    assert.ok(fs.existsSync(path.join(ROOT_DIR, 'css', 'style.css')));
    assert.ok(fs.existsSync(path.join(ROOT_DIR, 'js', 'app.js')));
    assert.ok(fs.existsSync(path.join(ROOT_DIR, 'assets', 'icons', 'favicon.svg')));
    assert.ok(fs.existsSync(path.join(ROOT_DIR, 'assets', 'icons', 'logo.svg')));
  });
});

describe('Frontend URL Validation, Storage & File Extraction', () => {
  it('validates and normalizes backend URLs including stripping /api suffixes', () => {
    assert.equal(validateBackendUrl('').valid, false);
    assert.equal(validateBackendUrl('ftp://localhost:3001').valid, false);
    assert.equal(validateBackendUrl('not-a-url').valid, false);

    assert.deepEqual(validateBackendUrl('http://localhost:3001/'), {
      valid: true,
      url: 'http://localhost:3001'
    });
    assert.deepEqual(validateBackendUrl('http://localhost:3001/api/'), {
      valid: true,
      url: 'http://localhost:3001'
    });
    assert.deepEqual(validateBackendUrl('https://viva-api.onrender.com/api/health'), {
      valid: true,
      url: 'https://viva-api.onrender.com'
    });
  });

  it('auto-detects default backend URL for Express-hosted, local static, and GitHub Pages origins', () => {
    globalThis.window = {
      location: { protocol: 'http:', hostname: 'localhost', port: '3001', origin: 'http://localhost:3001' }
    };
    assert.equal(getDefaultBackendUrl(), 'http://localhost:3001');

    globalThis.window = {
      location: { protocol: 'http:', hostname: '127.0.0.1', port: '5500', origin: 'http://127.0.0.1:5500' }
    };
    assert.equal(getDefaultBackendUrl(), 'http://127.0.0.1:3001');

    globalThis.window = {
      location: { protocol: 'https:', hostname: 'my-viva.onrender.com', port: '', origin: 'https://my-viva.onrender.com' }
    };
    assert.equal(getDefaultBackendUrl(), 'https://my-viva.onrender.com');

    globalThis.window = {
      location: { protocol: 'https:', hostname: 'student.github.io', port: '', origin: 'https://student.github.io' }
    };
    assert.equal(getDefaultBackendUrl(), '');
  });

  it('persists backend URL and caps history at 10 entries', () => {
    globalThis.localStorage = createMockLocalStorage();
    globalThis.window = {
      location: { protocol: 'http:', hostname: 'localhost', port: '3001', origin: 'http://localhost:3001' }
    };

    saveBackendUrl('http://localhost:3001/api/');
    assert.equal(getSavedBackendUrl(), 'http://localhost:3001');

    for (let i = 1; i <= 12; i += 1) {
      saveVivaHistoryItem({ sourceName: `Note ${i}`, totalScore: 20, maxScore: 25, percentage: 80, classification: 'Merit', date: 'Nov 26' });
    }
    const history = getVivaHistory();
    assert.equal(history.length, 10);
    assert.equal(history[0].sourceName, 'Note 12');

    clearVivaHistory();
    assert.deepEqual(getVivaHistory(), []);
  });

  it('extracts TXT files and rejects empty, unsupported, oversized, and whitespace-only files', async () => {
    assert.equal(countWords('  hello   world \n viva '), 3);

    const validTxt = new File(['Neural networks learn weights through backpropagation and gradient descent.'], 'notes.txt', {
      type: 'text/plain'
    });
    const result = await extractTextFromFile(validTxt);
    assert.equal(result.filename, 'notes.txt');
    assert.equal(result.wordCount, 9);
    assert.equal(result.truncated, false);

    const longTxt = new File(['a'.repeat(MAX_EXTRACTED_CHARS + 500)], 'long.txt', { type: 'text/plain' });
    const truncatedRes = await extractTextFromFile(longTxt);
    assert.equal(truncatedRes.truncated, true);
    assert.equal(truncatedRes.charCount, MAX_EXTRACTED_CHARS);

    const emptyFile = new File([], 'empty.txt', { type: 'text/plain' });
    await assert.rejects(() => extractTextFromFile(emptyFile), /empty \(0 bytes\)/i);

    const whitespaceFile = new File(['   \n\t  '], 'blank.txt', { type: 'text/plain' });
    await assert.rejects(() => extractTextFromFile(whitespaceFile), /No readable text/i);

    const badExt = new File(['binary'], 'diagram.png', { type: 'image/png' });
    await assert.rejects(() => extractTextFromFile(badExt), /Unsupported file type/i);

    const fakeOversized = { name: 'huge.txt', size: MAX_FILE_SIZE_BYTES + 1 };
    await assert.rejects(() => extractTextFromFile(fakeOversized), /exceeds the 10 MB upload limit/i);
  });
});

describe('Frontend js/api.js <-> Express Backend Live HTTP Integration', () => {
  it('connects frontend API client directly to backend Express server across all endpoints', async () => {
    globalThis.localStorage = createMockLocalStorage();
    setClientFactory(() => ({
      interactions: {
        async create(params) {
          if (params.system_instruction.includes('generate ONE viva examination question')) {
            return {
              output_text: JSON.stringify({
                topic: 'CAP Theorem',
                question: 'Explain the trade-off between consistency and availability during a network partition.',
                questionType: 'conceptual'
              })
            };
          }
          if (params.system_instruction.includes('university viva voce examiner')) {
            return {
              output_text: JSON.stringify({
                score: 4,
                whatWasCorrect: 'Explained partition tolerance trade-off clearly.',
                missingConcepts: [],
                feedback: 'Well structured response.',
                correctExplanation: 'During a partition, distributed systems choose consistency (CP) or availability (AP).',
                needsFollowUp: false,
                followUpQuestion: ''
              })
            };
          }
          return {
            output_text: JSON.stringify({
              overallSummary: 'Strong distributed systems understanding.',
              strengths: ['CAP Theorem'],
              weaknesses: [],
              revisionPriorities: ['Practice consensus protocols']
            })
          };
        }
      }
    }));

    const app = createApp({ enableRateLimit: false });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    setBackendBaseUrl(baseUrl);

    try {
      const health = await checkHealth();
      assert.equal(health.status, 'ok');
      assert.equal(health.geminiConfigured, true);

      const notes =
        'Distributed systems must handle network partitions. Under the CAP theorem, a distributed data store ' +
        'can simultaneously provide at most two of consistency, availability, and partition tolerance.';

      const qResp = await generateQuestion({ notes, questionNumber: 1, totalQuestions: 5, previousQuestions: [] });
      assert.equal(qResp.question.topic, 'CAP Theorem');

      const evalResp = await evaluateAnswer({
        notes,
        question: qResp.question.question,
        topic: qResp.question.topic,
        answer: 'During a network partition, nodes cannot communicate, so we must pick consistency or availability.',
        isFollowUp: false,
        followUpCount: 0
      });
      assert.equal(evalResp.evaluation.score, 4);

      const evaluations = Array.from({ length: 5 }, (_, idx) => ({
        topic: `Topic ${idx + 1}`,
        question: qResp.question.question,
        score: 4,
        whatWasCorrect: evalResp.evaluation.whatWasCorrect,
        missingConcepts: evalResp.evaluation.missingConcepts,
        feedback: evalResp.evaluation.feedback
      }));

      const repResp = await generateReport({ evaluations });
      assert.equal(repResp.report.totalScore, 20);
      assert.equal(repResp.report.percentage, 80);
      assert.equal(repResp.report.classification, 'Merit');

      // Rapid overlapping health checks should cleanly supersede previous check without DUPLICATE_REQUEST
      const [h1, h2] = await Promise.allSettled([checkHealth(), checkHealth()]);
      assert.equal(h1.status, 'rejected');
      assert.equal(h1.reason.code, 'ABORTED');
      assert.equal(h2.status, 'fulfilled');
      assert.equal(h2.value.status, 'ok');

      // External AbortController cancellation surfaces ABORTED cleanly
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        () => generateQuestion({ notes, questionNumber: 2, totalQuestions: 5, previousQuestions: [], signal: controller.signal }),
        (err) => err.code === 'ABORTED'
      );
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
