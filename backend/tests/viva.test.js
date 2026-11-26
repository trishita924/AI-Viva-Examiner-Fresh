import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../app.js';
import {
  normalizeScore,
  getClassification,
  getConfiguredModel,
  isGeminiConfigured,
  setClientFactory,
  resetClientFactory,
  DEFAULT_MODEL
} from '../services/geminiService.js';

const SAMPLE_NOTES =
  'Operating systems manage hardware resources including CPU scheduling, virtual memory paging, ' +
  'deadlock avoidance using Banker algorithm, and inter-process synchronization with semaphores and mutex locks.';

async function startTestServer(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`
  };
}

async function stopTestServer(server) {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

afterEach(() => {
  resetClientFactory();
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_FALLBACK_MODELS;
  delete process.env.GEMINI_TIMEOUT_MS;
  delete process.env.ALLOWED_ORIGINS;
  process.env.NODE_ENV = 'test';
});

describe('Deterministic grading & configuration helpers', () => {
  it('normalizes scores to [0, 5] in 0.5 increments', () => {
    assert.equal(normalizeScore(-2), 0);
    assert.equal(normalizeScore(7.5), 5);
    assert.equal(normalizeScore(3.26), 3.5);
    assert.equal(normalizeScore(3.24), 3);
    assert.equal(normalizeScore(4.5), 4.5);
    assert.equal(normalizeScore('not-a-number'), 0);
    assert.equal(normalizeScore(Number.NaN), 0);
    assert.equal(normalizeScore(Number.POSITIVE_INFINITY), 0);
  });

  it('computes classification boundaries accurately', () => {
    assert.equal(getClassification(100), 'Distinction');
    assert.equal(getClassification(85), 'Distinction');
    assert.equal(getClassification(84.9), 'Merit');
    assert.equal(getClassification(70), 'Merit');
    assert.equal(getClassification(69.9), 'Pass');
    assert.equal(getClassification(50), 'Pass');
    assert.equal(getClassification(49.9), 'Needs Improvement');
    assert.equal(getClassification(0), 'Needs Improvement');
  });

  it('defaults to gemini-3.8-flash and rejects placeholder API keys', () => {
    delete process.env.GEMINI_MODEL;
    assert.equal(getConfiguredModel(), DEFAULT_MODEL);
    assert.equal(DEFAULT_MODEL, 'gemini-3.8-flash');

    process.env.GEMINI_API_KEY = 'your_gemini_api_key_here';
    assert.equal(isGeminiConfigured(), false);

    process.env.GEMINI_API_KEY = 'real-looking-test-key';
    assert.equal(isGeminiConfigured(), true);
  });
});

describe('Express API, Static Frontend Serving, and CORS', () => {
  it('serves frontend HTML/CSS/JS and protects backend files', async () => {
    const app = createApp({ enableRateLimit: false });
    const { server, baseUrl } = await startTestServer(app);

    try {
      const homeRes = await fetch(`${baseUrl}/`);
      assert.equal(homeRes.status, 200);
      assert.match(homeRes.headers.get('content-type') || '', /text\/html/);
      const html = await homeRes.text();
      assert.match(html, /AI Viva Examiner/);

      const cssRes = await fetch(`${baseUrl}/css/style.css`);
      assert.equal(cssRes.status, 200);

      const jsRes = await fetch(`${baseUrl}/js/app.js`);
      assert.equal(jsRes.status, 200);

      const envProbe = await fetch(`${baseUrl}/backend/.env`);
      assert.equal(envProbe.status, 404);

      const serverProbe = await fetch(`${baseUrl}/backend/server.js`);
      assert.equal(serverProbe.status, 404);
    } finally {
      await stopTestServer(server);
    }
  });

  it('reports health status accurately', async () => {
    const app = createApp({ enableRateLimit: false });
    const { server, baseUrl } = await startTestServer(app);

    try {
      const res = await fetch(`${baseUrl}/api/health`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'ok');
      assert.equal(data.service, 'ai-viva-examiner-backend');
      assert.equal(data.model, 'gemini-3.8-flash');
      assert.equal(data.geminiConfigured, false);
    } finally {
      await stopTestServer(server);
    }
  });

  it('allows localhost origins in dev even when ALLOWED_ORIGINS is set, and blocks unknown origins in prod', async () => {
    process.env.ALLOWED_ORIGINS = 'https://example.github.io';
    process.env.NODE_ENV = 'development';
    const devApp = createApp({ enableRateLimit: false });
    const devSrv = await startTestServer(devApp);

    try {
      const devCors = await fetch(`${devSrv.baseUrl}/api/health`, {
        headers: { Origin: 'http://localhost:4173' }
      });
      assert.equal(devCors.status, 200);
      assert.equal(devCors.headers.get('access-control-allow-origin'), 'http://localhost:4173');
    } finally {
      await stopTestServer(devSrv.server);
    }

    process.env.NODE_ENV = 'production';
    const prodApp = createApp({ enableRateLimit: false });
    const prodSrv = await startTestServer(prodApp);

    try {
      const allowedProd = await fetch(`${prodSrv.baseUrl}/api/health`, {
        headers: { Origin: 'https://example.github.io' }
      });
      assert.equal(allowedProd.status, 200);
      assert.equal(allowedProd.headers.get('access-control-allow-origin'), 'https://example.github.io');

      const blockedProd = await fetch(`${prodSrv.baseUrl}/api/health`, {
        headers: { Origin: 'https://evil.example.com' }
      });
      assert.equal(blockedProd.status, 403);
      const errBody = await blockedProd.json();
      assert.equal(errBody.error.code, 'CORS_FORBIDDEN');
    } finally {
      await stopTestServer(prodSrv.server);
    }
  });

  it('returns 503 when Gemini API key is not configured and validates request payloads', async () => {
    const app = createApp({ enableRateLimit: false });
    const { server, baseUrl } = await startTestServer(app);

    try {
      const shortNotesRes = await fetch(`${baseUrl}/api/generate-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'too short', questionNumber: 1 })
      });
      assert.equal(shortNotesRes.status, 400);
      assert.equal((await shortNotesRes.json()).error.code, 'INVALID_NOTES');

      const missingKeyRes = await fetch(`${baseUrl}/api/generate-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: SAMPLE_NOTES, questionNumber: 1, totalQuestions: 5 })
      });
      assert.equal(missingKeyRes.status, 503);
      assert.equal((await missingKeyRes.json()).error.code, 'GEMINI_NOT_CONFIGURED');

      const badJsonRes = await fetch(`${baseUrl}/api/generate-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid-json'
      });
      assert.equal(badJsonRes.status, 400);
      assert.equal((await badJsonRes.json()).error.code, 'INVALID_JSON');

      const badFollowUpFlag = await fetch(`${baseUrl}/api/evaluate-answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes: SAMPLE_NOTES,
          question: 'Explain paging.',
          answer: 'Paging splits virtual memory into fixed-size pages.',
          isFollowUp: 'false'
        })
      });
      assert.equal(badFollowUpFlag.status, 400);
      assert.equal((await badFollowUpFlag.json()).error.code, 'INVALID_FOLLOWUP_FLAG');
    } finally {
      await stopTestServer(server);
    }
  });
});

describe('Full Viva Exam Flow with Mocked Gemini Interactions API', () => {
  it('completes question generation, follow-up clarification, and report generation', async () => {
    const calls = [];
    setClientFactory(() => ({
      interactions: {
        async create(params) {
          calls.push(params);
          if (params.system_instruction.includes('generate ONE viva examination question')) {
            return {
              output_text: JSON.stringify({
                topic: 'Virtual Memory Paging',
                question: 'Explain how paging prevents external fragmentation.',
                questionType: 'conceptual'
              })
            };
          }
          if (params.system_instruction.includes('university viva voce examiner')) {
            if (params.input.includes("EXAMINER'S FOLLOW-UP QUESTION")) {
              return {
                output_text: JSON.stringify({
                  score: 4.5,
                  whatWasCorrect: 'Correctly explained page tables and frame mapping.',
                  missingConcepts: ['TLB caching overhead'],
                  feedback: 'Strong clarification combining both answers.',
                  correctExplanation: 'Paging maps fixed virtual pages to physical frames via page tables.',
                  needsFollowUp: true, // Should be forced false by server!
                  followUpQuestion: 'Should never appear as a second follow-up'
                })
              };
            }
            return {
              output_text: JSON.stringify({
                score: 2.5,
                whatWasCorrect: 'Identified fixed-size pages.',
                missingConcepts: ['Page table translation'],
                feedback: 'Explain how virtual addresses translate to physical frames.',
                correctExplanation: 'Virtual pages map to physical frames using a page table.',
                needsFollowUp: true,
                followUpQuestion: 'How does the OS translate a virtual page number to a physical frame?'
              })
            };
          }
          return {
            output_text: JSON.stringify({
              overallSummary: 'Solid understanding across OS memory and concurrency topics.',
              strengths: ['Virtual Memory Paging'],
              weaknesses: ['TLB caching'],
              revisionPriorities: ['Review TLB hit ratio impact']
            })
          };
        }
      }
    }));

    const app = createApp({ enableRateLimit: false });
    const { server, baseUrl } = await startTestServer(app);

    try {
      // 1. Generate Question
      const qRes = await fetch(`${baseUrl}/api/generate-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: SAMPLE_NOTES, questionNumber: 1, totalQuestions: 5, previousQuestions: [] })
      });
      assert.equal(qRes.status, 200);
      const { question } = await qRes.json();
      assert.equal(question.topic, 'Virtual Memory Paging');
      assert.equal(question.questionType, 'conceptual');

      // Verify privacy & modern Gemini Interactions parameters
      assert.equal(calls[0].model, 'gemini-3.8-flash');
      assert.equal(calls[0].store, false);
      assert.equal(calls[0].response_format.mime_type, 'application/json');
      assert.equal(calls[0].generation_config.thinking_level, 'low');

      // 2. Evaluate partial answer -> triggers 1st follow-up
      const ev1Res = await fetch(`${baseUrl}/api/evaluate-answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes: SAMPLE_NOTES,
          question: question.question,
          topic: question.topic,
          answer: 'Memory is divided into fixed size pages.',
          isFollowUp: false,
          followUpCount: 0
        })
      });
      assert.equal(ev1Res.status, 200);
      const { evaluation: ev1 } = await ev1Res.json();
      assert.equal(ev1.needsFollowUp, true);
      assert.match(ev1.followUpQuestion, /virtual page number/i);

      // 3. Evaluate follow-up -> enforces max 1 follow-up per question
      const ev2Res = await fetch(`${baseUrl}/api/evaluate-answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes: SAMPLE_NOTES,
          question: question.question,
          topic: question.topic,
          answer: 'The MMU looks up the page number in the page table to get the frame number.',
          isFollowUp: true,
          originalAnswer: 'Memory is divided into fixed size pages.',
          followUpQuestion: ev1.followUpQuestion,
          followUpCount: 1
        })
      });
      assert.equal(ev2Res.status, 200);
      const { evaluation: ev2 } = await ev2Res.json();
      assert.equal(ev2.score, 4.5);
      assert.equal(ev2.needsFollowUp, false);
      assert.equal(ev2.followUpQuestion, '');

      // 4. Generate Final Report across 5 evaluations
      const evaluations = [4.5, 4.0, 4.5, 4.0, 4.5].map((score, idx) => ({
        topic: `Topic ${idx + 1}`,
        question: `Question ${idx + 1}?`,
        score,
        whatWasCorrect: 'Clear explanation.',
        missingConcepts: [],
        feedback: 'Good work.'
      }));

      const repRes = await fetch(`${baseUrl}/api/generate-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evaluations })
      });
      assert.equal(repRes.status, 200);
      const { report } = await repRes.json();
      assert.equal(report.totalScore, 21.5);
      assert.equal(report.maxScore, 25);
      assert.equal(report.percentage, 86);
      assert.equal(report.classification, 'Distinction');
      assert.deepEqual(report.strengths, ['Virtual Memory Paging']);
    } finally {
      await stopTestServer(server);
    }
  });

  it('maps upstream Gemini errors (429, 401, 404, timeout, invalid JSON) cleanly', async () => {
    const app = createApp({ enableRateLimit: false });
    const { server, baseUrl } = await startTestServer(app);

    try {
      setClientFactory(() => ({
        interactions: {
          async create() {
            const err = new Error('Rate limit');
            err.status = 429;
            throw err;
          }
        }
      }));
      const r429 = await fetch(`${baseUrl}/api/generate-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: SAMPLE_NOTES, questionNumber: 1 })
      });
      assert.equal(r429.status, 429);
      assert.equal((await r429.json()).error.code, 'GEMINI_RATE_LIMIT');

      setClientFactory(() => ({
        interactions: {
          async create() {
            const err = new Error('API key not valid');
            err.status = 400;
            throw err;
          }
        }
      }));
      const rAuth = await fetch(`${baseUrl}/api/generate-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: SAMPLE_NOTES, questionNumber: 1 })
      });
      assert.equal(rAuth.status, 502);
      assert.equal((await rAuth.json()).error.code, 'GEMINI_AUTH_ERROR');

      setClientFactory(() => ({
        interactions: {
          async create() {
            const err = new Error('Model not found');
            err.status = 404;
            throw err;
          }
        }
      }));
      const r404 = await fetch(`${baseUrl}/api/generate-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: SAMPLE_NOTES, questionNumber: 1 })
      });
      assert.equal(r404.status, 502);
      assert.equal((await r404.json()).error.code, 'GEMINI_MODEL_NOT_FOUND');

      setClientFactory(() => ({
        interactions: {
          async create() {
            return { output_text: 'not valid json {' };
          }
        }
      }));
      const rJson = await fetch(`${baseUrl}/api/generate-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: SAMPLE_NOTES, questionNumber: 1 })
      });
      assert.equal(rJson.status, 502);
      assert.equal((await rJson.json()).error.code, 'GEMINI_INVALID_JSON');

      process.env.GEMINI_TIMEOUT_MS = '30';
      setClientFactory(() => ({
        interactions: {
          create(_params, options) {
            return new Promise((_resolve, reject) => {
              options?.fetchOptions?.signal?.addEventListener('abort', () => {
                const abortErr = new Error('Aborted');
                abortErr.name = 'AbortError';
                reject(abortErr);
              });
            });
          }
        }
      }));
      const rTimeout = await fetch(`${baseUrl}/api/generate-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: SAMPLE_NOTES, questionNumber: 1 })
      });
      assert.equal(rTimeout.status, 504);
      assert.equal((await rTimeout.json()).error.code, 'GEMINI_TIMEOUT');
    } finally {
      await stopTestServer(server);
    }
  });

  it('prevents string "false" needsFollowUp coercion, handles multibyte 40k notes, and handles 404/413 routes', async () => {
    setClientFactory(() => ({
      interactions: {
        async create() {
          return {
            output_text: JSON.stringify({
              score: 3,
              whatWasCorrect: 'Accurate summary.',
              missingConcepts: [],
              feedback: 'Good.',
              correctExplanation: 'Full explanation.',
              needsFollowUp: 'false',
              followUpQuestion: 'Should not trigger because needsFollowUp is a string'
            })
          };
        }
      }
    }));

    const app = createApp({ enableRateLimit: false });
    const { server, baseUrl } = await startTestServer(app);

    try {
      const multibyteNotes = 'α'.repeat(40000);
      const evRes = await fetch(`${baseUrl}/api/evaluate-answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes: multibyteNotes,
          question: 'Explain alpha particles.',
          answer: 'Alpha particles are helium nuclei.'
        })
      });
      assert.equal(evRes.status, 200);
      const { evaluation } = await evRes.json();
      assert.equal(evaluation.needsFollowUp, false);
      assert.equal(evaluation.followUpQuestion, '');

      const unknownApiRes = await fetch(`${baseUrl}/api/nonexistent`);
      assert.equal(unknownApiRes.status, 404);
      assert.equal((await unknownApiRes.json()).error.code, 'NOT_FOUND');

      const hugeRes = await fetch(`${baseUrl}/api/generate-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'a'.repeat(350000), questionNumber: 1 })
      });
      assert.equal(hugeRes.status, 413);
      assert.equal((await hugeRes.json()).error.code, 'PAYLOAD_TOO_LARGE');
    } finally {
      await stopTestServer(server);
    }
  });

  it('automatically fails over to fallback model when primary model returns 503 overload', async () => {
    const attemptedModels = [];
    setClientFactory(() => ({
      interactions: {
        async create(params) {
          attemptedModels.push(params.model);
          if (params.model === 'gemini-3.8-flash') {
            const err = new Error('503 gemini-3.8-flash is currently experiencing high demand');
            err.status = 503;
            throw err;
          }
          return {
            output_text: JSON.stringify({
              topic: 'Deadlock Prevention',
              question: 'How does ordering resource requests prevent circular wait?',
              questionType: 'conceptual'
            })
          };
        }
      }
    }));

    const app = createApp({ enableRateLimit: false });
    const { server, baseUrl } = await startTestServer(app);

    try {
      const res = await fetch(`${baseUrl}/api/generate-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: SAMPLE_NOTES, questionNumber: 1 })
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.question.topic, 'Deadlock Prevention');
      assert.deepEqual(attemptedModels, ['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
    } finally {
      await stopTestServer(server);
    }
  });

  it('returns 503 GEMINI_UNAVAILABLE when all candidate models are overloaded', async () => {
    setClientFactory(() => ({
      interactions: {
        async create() {
          const err = new Error('503 high demand');
          err.status = 503;
          throw err;
        }
      }
    }));

    const app = createApp({ enableRateLimit: false });
    const { server, baseUrl } = await startTestServer(app);

    try {
      const res = await fetch(`${baseUrl}/api/generate-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: SAMPLE_NOTES, questionNumber: 1 })
      });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error.code, 'GEMINI_UNAVAILABLE');
    } finally {
      await stopTestServer(server);
    }
  });
});
