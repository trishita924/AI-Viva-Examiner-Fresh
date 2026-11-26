import { GoogleGenAI } from '@google/genai';
import { AppError } from '../middleware/errorHandler.js';

export const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'];
const DEFAULT_TIMEOUT_MS = 35000;

let clientFactoryOverride = null;

/**
 * Allows tests to inject a mock Gemini client factory without mutating env/network state.
 */
export function setClientFactory(factory) {
  clientFactoryOverride = typeof factory === 'function' ? factory : null;
}

/**
 * Restores the default GoogleGenAI client factory.
 */
export function resetClientFactory() {
  clientFactoryOverride = null;
}

/**
 * Returns configured Gemini model name.
 */
export function getConfiguredModel() {
  const configured = (process.env.GEMINI_MODEL || '').trim();
  return configured || DEFAULT_MODEL;
}

/**
 * Returns ordered list of candidate models (primary configured model followed by fallback Flash models).
 */
export function getCandidateModels() {
  const primary = getConfiguredModel();
  const envFallbacks = (process.env.GEMINI_FALLBACK_MODELS || '').trim();

  if (envFallbacks.toLowerCase() === 'none') {
    return [primary];
  }

  const fallbacks = envFallbacks
    ? envFallbacks.split(',').map((m) => m.trim()).filter(Boolean)
    : DEFAULT_FALLBACK_MODELS;

  const seen = new Set([primary]);
  const ordered = [primary];
  for (const candidate of fallbacks) {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      ordered.push(candidate);
    }
  }
  return ordered;
}

/**
 * Checks if GEMINI_API_KEY is configured and non-placeholder.
 */
export function isGeminiConfigured() {
  if (clientFactoryOverride) {
    return true;
  }
  const key = (process.env.GEMINI_API_KEY || '').trim();
  return Boolean(key && key !== 'your_gemini_api_key_here');
}

function getTimeoutMs() {
  const parsed = Number(process.env.GEMINI_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * Lazily instantiates the official GoogleGenAI client.
 */
function getClient() {
  if (clientFactoryOverride) {
    return clientFactoryOverride();
  }
  if (!isGeminiConfigured()) {
    throw new AppError(
      'Gemini API key is not configured on the server. Set GEMINI_API_KEY in backend/.env.',
      503,
      'GEMINI_NOT_CONFIGURED'
    );
  }
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY.trim(),
    httpOptions: {
      timeout: getTimeoutMs()
    }
  });
}

function isLegacyGeminiTwoModel(model) {
  return /^gemini-2\./i.test(model);
}

/**
 * Extracts text content from a Gemini Interactions API response.
 */
function extractInteractionText(interaction) {
  if (typeof interaction?.output_text === 'string' && interaction.output_text.trim()) {
    return interaction.output_text.trim();
  }

  if (Array.isArray(interaction?.steps)) {
    const parts = [];
    for (let i = interaction.steps.length - 1; i >= 0; i -= 1) {
      const step = interaction.steps[i];
      if (step?.type === 'user_input') {
        break;
      }
      if (step?.type === 'model_output' && Array.isArray(step.content)) {
        const textSegments = step.content
          .filter((item) => item?.type === 'text' && typeof item.text === 'string')
          .map((item) => item.text);
        if (textSegments.length > 0) {
          parts.unshift(textSegments.join(''));
        }
      }
    }
    const combined = parts.join('').trim();
    if (combined) {
      return combined;
    }
  }

  return '';
}

/**
 * Parses JSON output from model response, stripping accidental markdown code fences.
 */
function parseModelJson(rawText) {
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected JSON object');
    }
    return parsed;
  } catch {
    throw new AppError('Gemini returned malformed JSON output.', 502, 'GEMINI_INVALID_JSON');
  }
}

const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    topic: {
      type: 'string',
      description: 'Short 2-5 word topic label from the notes.'
    },
    question: {
      type: 'string',
      description: 'Clear, specific viva examination question grounded in the notes.'
    },
    questionType: {
      type: 'string',
      enum: ['conceptual', 'application'],
      description: 'Whether the question tests conceptual understanding or application.'
    }
  },
  required: ['topic', 'question', 'questionType']
};

const EVALUATION_SCHEMA = {
  type: 'object',
  properties: {
    score: {
      type: 'number',
      description: 'Numeric score between 0 and 5 in 0.5 increments.'
    },
    whatWasCorrect: {
      type: 'string',
      description: 'Specific explanation of what the student answered correctly.'
    },
    missingConcepts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific missing or inaccurate concepts; empty array if none.'
    },
    feedback: {
      type: 'string',
      description: 'Constructive, actionable feedback for the student.'
    },
    correctExplanation: {
      type: 'string',
      description: 'Clear, accurate reference explanation grounded in the notes.'
    },
    needsFollowUp: {
      type: 'boolean',
      description: 'True only if a single targeted follow-up question is warranted.'
    },
    followUpQuestion: {
      type: 'string',
      description: 'Concise follow-up question if needsFollowUp is true, otherwise empty string.'
    }
  },
  required: [
    'score',
    'whatWasCorrect',
    'missingConcepts',
    'feedback',
    'correctExplanation',
    'needsFollowUp',
    'followUpQuestion'
  ]
};

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    overallSummary: {
      type: 'string',
      description: '2-3 sentence summary of the student performance across all 5 questions.'
    },
    strengths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific strengths observed across the evaluations.'
    },
    weaknesses: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific conceptual gaps or weak topics.'
    },
    revisionPriorities: {
      type: 'array',
      items: { type: 'string' },
      description: 'Concrete revision actions based on the evaluations.'
    }
  },
  required: ['overallSummary', 'strengths', 'weaknesses', 'revisionPriorities']
};

function isRetryableWithFallback(err) {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  return status === 503 || status === 500 || status === 429 || status === 404;
}

function mapUpstreamError(err, model, timedOut) {
  if (err instanceof AppError) {
    return err;
  }

  if (
    timedOut ||
    err?.name === 'AbortError' ||
    err?.name === 'APIConnectionTimeoutError' ||
    err?.name === 'ContinuationInterruptedError'
  ) {
    return new AppError('The AI service timed out while processing your request.', 504, 'GEMINI_TIMEOUT');
  }

  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  const message = String(err?.message || '');

  if (status === 429) {
    return new AppError('Gemini API rate limit exceeded. Please wait a moment and try again.', 429, 'GEMINI_RATE_LIMIT');
  }
  if (status === 401 || status === 403 || (status === 400 && /api[_ ]?key/i.test(message))) {
    return new AppError('Gemini API authentication failed. Verify backend GEMINI_API_KEY.', 502, 'GEMINI_AUTH_ERROR');
  }
  if (status === 404) {
    return new AppError(
      `Configured Gemini model "${model}" was not found or is unavailable. Check GEMINI_MODEL in backend/.env.`,
      502,
      'GEMINI_MODEL_NOT_FOUND'
    );
  }
  if (status === 503) {
    return new AppError(
      'Google Gemini is currently experiencing high demand. Please retry in a few moments.',
      503,
      'GEMINI_UNAVAILABLE'
    );
  }
  if (status === 400) {
    return new AppError('Gemini rejected the request payload. Check model configuration and input.', 502, 'GEMINI_BAD_REQUEST');
  }
  return new AppError('Failed to communicate with Google Gemini API.', 502, 'GEMINI_UPSTREAM_ERROR');
}

async function attemptSingleModel({ ai, model, systemInstruction, prompt, schema, remainingMs }) {
  const controller = new AbortController();
  let timeoutId;
  let timedOut = false;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new AppError('The AI service timed out while processing your request.', 504, 'GEMINI_TIMEOUT'));
    }, remainingMs);
  });

  const interactionParams = {
    model,
    system_instruction: systemInstruction,
    input: prompt,
    store: false,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema
    }
  };

  if (!isLegacyGeminiTwoModel(model)) {
    interactionParams.generation_config = {
      thinking_level: 'low'
    };
  }

  try {
    // Disable multi-backoff SDK retries so overloaded models (503) fail fast into fallback models
    const apiPromise = ai.interactions.create(interactionParams, {
      timeout_ms: remainingMs,
      maxRetries: 0,
      fetchOptions: { signal: controller.signal }
    });

    const interaction = await Promise.race([apiPromise, timeoutPromise]);
    const rawText = extractInteractionText(interaction);

    if (!rawText) {
      throw new AppError('Gemini returned an empty response.', 502, 'GEMINI_EMPTY_RESPONSE');
    }

    return parseModelJson(rawText);
  } catch (err) {
    throw mapUpstreamError(err, model, timedOut || controller.signal.aborted);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Executes a Gemini Interactions API call with total timeout budget, fast failover across models on 503/429,
 * strict JSON schema enforcement, and safe error mapping.
 */
async function callGeminiJson({ systemInstruction, prompt, schema }) {
  const ai = getClient();
  const candidates = getCandidateModels();
  const totalBudgetMs = getTimeoutMs();
  const deadline = Date.now() + totalBudgetMs;

  let lastError = null;
  let lastModel = candidates[0];

  for (let i = 0; i < candidates.length; i += 1) {
    const model = candidates[i];
    lastModel = model;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new AppError('The AI service timed out while processing your request.', 504, 'GEMINI_TIMEOUT');
    }

    try {
      return await attemptSingleModel({
        ai,
        model,
        systemInstruction,
        prompt,
        schema,
        remainingMs
      });
    } catch (err) {
      lastError = err;
      const hasMoreCandidates = i < candidates.length - 1;
      const canFallback =
        hasMoreCandidates &&
        (isRetryableWithFallback(err) ||
          err?.code === 'GEMINI_UNAVAILABLE' ||
          err?.code === 'GEMINI_RATE_LIMIT' ||
          err?.code === 'GEMINI_MODEL_NOT_FOUND');

      if (!canFallback) {
        throw err;
      }

      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[Gemini] ${model} failed (${err.code}); trying fallback model ${candidates[i + 1]}...`);
      }
    }
  }

  throw lastError || mapUpstreamError(new Error('All candidate models failed'), lastModel, false);
}

/**
 * Clamps and normalizes a numeric score to [0, 5] in 0.5 increments.
 */
export function normalizeScore(rawScore) {
  const num = Number(rawScore);
  if (!Number.isFinite(num)) {
    return 0;
  }
  const clamped = Math.max(0, Math.min(5, num));
  return Math.round(clamped * 2) / 2;
}

/**
 * Computes deterministic performance classification from percentage.
 */
export function getClassification(percentage) {
  if (percentage >= 85) return 'Distinction';
  if (percentage >= 70) return 'Merit';
  if (percentage >= 50) return 'Pass';
  return 'Needs Improvement';
}

function normalizeQuestionType(rawType, targetStyle) {
  const normalized = typeof rawType === 'string' ? rawType.trim().toLowerCase() : '';
  if (normalized === 'application' || normalized === 'application-based') {
    return 'application';
  }
  if (normalized === 'conceptual') {
    return 'conceptual';
  }
  return targetStyle === 'application-based' ? 'application' : 'conceptual';
}

/**
 * Generates one viva question grounded strictly in the provided study notes.
 */
export async function generateQuestion({ notes, questionNumber, totalQuestions = 5, previousQuestions = [] }) {
  const targetStyle = questionNumber % 2 === 0 ? 'application-based' : 'conceptual';

  const systemInstruction = `You are an expert university viva voce examiner.
Your task is to generate ONE viva examination question strictly grounded in the student's uploaded study notes.
Rules:
1. Never invent topics, facts, or concepts that are not present in the provided notes.
2. Do not duplicate or rephrase any previously asked questions.
3. Match the requested question style (${targetStyle}) where conceptual tests understanding of principles/definitions/mechanisms and application-based tests applying concepts to a scenario, comparison, or problem.
4. Keep the question clear, specific, and answerable in 2-6 sentences.
5. Return ONLY valid JSON matching the requested schema.`;

  const previousBlock =
    previousQuestions.length > 0
      ? `Previously asked questions (DO NOT duplicate these topics or angles):\n${previousQuestions
          .map((q, idx) => `${idx + 1}. [${q.topic || 'General'}] ${q.question}`)
          .join('\n')}`
      : 'None yet (this is the first question).';

  const prompt = `Question ${questionNumber} of ${totalQuestions} (Target style: ${targetStyle}).

${previousBlock}

STUDY NOTES:
"""
${notes}
"""`;

  const result = await callGeminiJson({
    systemInstruction,
    prompt,
    schema: QUESTION_SCHEMA
  });

  if (!result || typeof result.question !== 'string' || !result.question.trim()) {
    throw new AppError('Gemini did not return a valid question.', 502, 'GEMINI_INVALID_QUESTION');
  }

  return {
    number: questionNumber,
    topic: typeof result.topic === 'string' && result.topic.trim() ? result.topic.trim() : `Topic ${questionNumber}`,
    question: result.question.trim(),
    questionType: normalizeQuestionType(result.questionType, targetStyle)
  };
}

/**
 * Evaluates a student's answer (and optional follow-up answer) against the study notes.
 */
export async function evaluateAnswer({
  notes,
  question,
  topic,
  answer,
  isFollowUp = false,
  originalAnswer = '',
  followUpQuestion = '',
  followUpCount = 0
}) {
  const canAskFollowUp = !isFollowUp && followUpCount < 1;

  const systemInstruction = `You are a fair, rigorous university viva voce examiner.
Evaluate the student's answer strictly against the provided study notes and the asked question.
Rules:
1. Score strictly between 0 and 5 (you may use 0.5 increments such as 3.5, or whole numbers). Never return null.
2. Explain specifically what the student got right ("whatWasCorrect").
3. List specific missing or inaccurate concepts ("missingConcepts" as an array of short strings; empty array if none).
4. Provide constructive, actionable feedback ("feedback").
5. Provide a clear, accurate reference explanation ("correctExplanation") grounded in the notes.
6. Follow-up policy:
   - ${canAskFollowUp ? 'If the answer is partially correct or incomplete (typically score between 1.5 and 4.0) and a targeted probing question would help clarify understanding, set "needsFollowUp": true and provide a concise "followUpQuestion". Otherwise set "needsFollowUp": false and "followUpQuestion": "".' : 'Follow-up limit reached or already evaluating a follow-up. You MUST set "needsFollowUp": false and "followUpQuestion": "".'}
   - ${isFollowUp ? 'You are evaluating the ORIGINAL answer and the FOLLOW-UP answer TOGETHER as one combined response.' : ''}
7. Return ONLY valid JSON matching the requested schema.`;

  const answerSection = isFollowUp
    ? `ORIGINAL QUESTION (${topic}):
${question}

STUDENT'S ORIGINAL ANSWER:
"""
${originalAnswer}
"""

EXAMINER'S FOLLOW-UP QUESTION:
${followUpQuestion}

STUDENT'S FOLLOW-UP ANSWER:
"""
${answer}
"""`
    : `QUESTION (${topic}):
${question}

STUDENT'S ANSWER:
"""
${answer}
"""`;

  const prompt = `${answerSection}

REFERENCE STUDY NOTES:
"""
${notes}
"""`;

  const result = await callGeminiJson({
    systemInstruction,
    prompt,
    schema: EVALUATION_SCHEMA
  });

  const score = normalizeScore(result?.score);
  const needsFollowUp =
    canAskFollowUp &&
    result?.needsFollowUp === true &&
    typeof result?.followUpQuestion === 'string' &&
    result.followUpQuestion.trim().length > 0;

  return {
    score,
    maxScore: 5,
    whatWasCorrect:
      typeof result?.whatWasCorrect === 'string' && result.whatWasCorrect.trim()
        ? result.whatWasCorrect.trim()
        : 'Partial understanding demonstrated.',
    missingConcepts: Array.isArray(result?.missingConcepts)
      ? result.missingConcepts.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [],
    feedback:
      typeof result?.feedback === 'string' && result.feedback.trim()
        ? result.feedback.trim()
        : 'Review the core concepts in your notes for this topic.',
    correctExplanation:
      typeof result?.correctExplanation === 'string' && result.correctExplanation.trim()
        ? result.correctExplanation.trim()
        : 'Refer to the study notes for the complete explanation.',
    needsFollowUp,
    followUpQuestion: needsFollowUp ? result.followUpQuestion.trim() : ''
  };
}

/**
 * Generates a comprehensive final viva report from the 5 question evaluations.
 * Total score, percentage, and classification are computed deterministically on the server.
 */
export async function generateReport({ evaluations }) {
  const maxScore = evaluations.length * 5;
  const totalScore =
    Math.round(evaluations.reduce((sum, item) => sum + normalizeScore(item.score), 0) * 10) / 10;
  const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 1000) / 10 : 0;
  const classification = getClassification(percentage);

  const systemInstruction = `You are a senior academic examiner compiling a final viva voce performance report.
Analyze the student's actual 5 question evaluations and produce an insightful, specific synthesis.
Rules:
1. Base strengths, weaknesses, and revision priorities strictly on the provided evaluations.
2. Reference specific topics from the 5 questions.
3. Return ONLY valid JSON matching the requested schema.`;

  const evalSummary = evaluations
    .map((ev, idx) => {
      const topic = typeof ev.topic === 'string' && ev.topic.trim() ? ev.topic.trim() : `Topic ${idx + 1}`;
      const whatWasCorrect =
        typeof ev.whatWasCorrect === 'string' && ev.whatWasCorrect.trim() ? ev.whatWasCorrect.trim() : 'N/A';
      const feedback = typeof ev.feedback === 'string' && ev.feedback.trim() ? ev.feedback.trim() : 'N/A';
      const missing =
        Array.isArray(ev.missingConcepts) && ev.missingConcepts.length > 0
          ? ev.missingConcepts.filter((c) => typeof c === 'string' && c.trim()).join('; ') || 'None'
          : 'None';
      return `Q${idx + 1} [${topic}] - Score: ${normalizeScore(ev.score)}/5
Question: ${ev.question}
What was correct: ${whatWasCorrect}
Missing concepts: ${missing}
Feedback: ${feedback}`;
    })
    .join('\n\n');

  const prompt = `Total Score: ${totalScore}/${maxScore} (${percentage}% - ${classification})

QUESTION EVALUATIONS:
${evalSummary}`;

  const result = await callGeminiJson({
    systemInstruction,
    prompt,
    schema: REPORT_SCHEMA
  });

  return {
    totalScore,
    maxScore,
    percentage,
    classification,
    overallSummary:
      typeof result?.overallSummary === 'string' && result.overallSummary.trim()
        ? result.overallSummary.trim()
        : `You scored ${totalScore} out of ${maxScore} (${percentage}%), achieving a ${classification} standing.`,
    strengths: Array.isArray(result?.strengths)
      ? result.strengths.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
      : [],
    weaknesses: Array.isArray(result?.weaknesses)
      ? result.weaknesses.filter((w) => typeof w === 'string' && w.trim()).map((w) => w.trim())
      : [],
    revisionPriorities: Array.isArray(result?.revisionPriorities)
      ? result.revisionPriorities.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim())
      : []
  };
}
