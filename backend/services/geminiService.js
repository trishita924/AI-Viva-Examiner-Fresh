import { GoogleGenAI } from '@google/genai';
import { AppError } from '../middleware/errorHandler.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 35000;

/**
 * Returns configured Gemini model name.
 */
export function getConfiguredModel() {
  return (process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
}

/**
 * Checks if GEMINI_API_KEY is configured and non-placeholder.
 */
export function isGeminiConfigured() {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  return Boolean(key && key !== 'your_gemini_api_key_here');
}

/**
 * Lazily instantiates the official GoogleGenAI client.
 */
function getClient() {
  if (!isGeminiConfigured()) {
    throw new AppError(
      'Gemini API key is not configured on the server. Set GEMINI_API_KEY in the backend environment.',
      503,
      'GEMINI_NOT_CONFIGURED'
    );
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY.trim() });
}

/**
 * Executes a Gemini generateContent call with timeout and structured JSON parsing.
 */
async function callGeminiJson({ systemInstruction, prompt, temperature = 0.3 }) {
  const ai = getClient();
  const model = getConfiguredModel();
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new AppError('The AI service timed out while processing your request.', 504, 'GEMINI_TIMEOUT'));
    }, timeoutMs);
  });

  try {
    const apiPromise = ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction,
        temperature,
        responseMimeType: 'application/json'
      }
    });

    const response = await Promise.race([apiPromise, timeoutPromise]);
    const rawText = typeof response?.text === 'string' ? response.text.trim() : '';

    if (!rawText) {
      throw new AppError('Gemini returned an empty response.', 502, 'GEMINI_EMPTY_RESPONSE');
    }

    // Strip accidental markdown code fences if present
    const cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      throw new AppError('Gemini returned malformed JSON output.', 502, 'GEMINI_INVALID_JSON');
    }
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    const status = err?.status || err?.statusCode;
    if (status === 429) {
      throw new AppError('Gemini API rate limit exceeded. Please wait a moment and try again.', 429, 'GEMINI_RATE_LIMIT');
    }
    if (status === 401 || status === 403) {
      throw new AppError('Gemini API authentication failed. Verify backend GEMINI_API_KEY.', 502, 'GEMINI_AUTH_ERROR');
    }
    throw new AppError('Failed to communicate with Google Gemini API.', 502, 'GEMINI_UPSTREAM_ERROR');
  }
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

/**
 * Generates one viva question grounded strictly in the provided study notes.
 */
export async function generateQuestion({ notes, questionNumber, totalQuestions = 5, previousQuestions = [] }) {
  const questionType = questionNumber % 2 === 0 ? 'application-based' : 'conceptual';

  const systemInstruction = `You are an expert university viva voce examiner.
Your task is to generate ONE viva examination question strictly grounded in the student's uploaded study notes.
Rules:
1. Never invent topics, facts, or concepts that are not present in the provided notes.
2. Do not duplicate or rephrase any previously asked questions.
3. Match the requested question style (${questionType}) where conceptual tests understanding of principles/definitions/mechanisms and application-based tests applying concepts to a scenario, comparison, or problem.
4. Keep the question clear, specific, and answerable in 2-6 sentences.
5. Return ONLY valid JSON with this exact schema:
{
  "topic": "Short 2-5 word topic label from the notes",
  "question": "The viva question text",
  "questionType": "conceptual" | "application"
}`;

  const previousBlock =
    previousQuestions.length > 0
      ? `Previously asked questions (DO NOT duplicate these topics or angles):\n${previousQuestions
          .map((q, idx) => `${idx + 1}. [${q.topic || 'General'}] ${q.question}`)
          .join('\n')}`
      : 'None yet (this is the first question).';

  const prompt = `Question ${questionNumber} of ${totalQuestions} (Target style: ${questionType}).

${previousBlock}

STUDY NOTES:
"""
${notes}
"""`;

  const result = await callGeminiJson({
    systemInstruction,
    prompt,
    temperature: 0.4
  });

  if (!result || typeof result.question !== 'string' || !result.question.trim()) {
    throw new AppError('Gemini did not return a valid question.', 502, 'GEMINI_INVALID_QUESTION');
  }

  return {
    number: questionNumber,
    topic: typeof result.topic === 'string' && result.topic.trim() ? result.topic.trim() : `Topic ${questionNumber}`,
    question: result.question.trim(),
    questionType: result.questionType === 'application' ? 'application' : questionType === 'application-based' ? 'application' : 'conceptual'
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
7. Return ONLY valid JSON with this exact schema:
{
  "score": number (0 to 5),
  "whatWasCorrect": string,
  "missingConcepts": string[],
  "feedback": string,
  "correctExplanation": string,
  "needsFollowUp": boolean,
  "followUpQuestion": string
}`;

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
    temperature: 0.2
  });

  const score = normalizeScore(result?.score);
  const needsFollowUp = canAskFollowUp && Boolean(result?.needsFollowUp) && typeof result?.followUpQuestion === 'string' && result.followUpQuestion.trim().length > 0;

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
  const totalScore = Math.round(
    evaluations.reduce((sum, item) => sum + normalizeScore(item.score), 0) * 10
  ) / 10;
  const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 1000) / 10 : 0;
  const classification = getClassification(percentage);

  const systemInstruction = `You are a senior academic examiner compiling a final viva voce performance report.
Analyze the student's actual 5 question evaluations and produce an insightful, specific synthesis.
Rules:
1. Base strengths, weaknesses, and revision priorities strictly on the provided evaluations.
2. Reference specific topics from the 5 questions.
3. Return ONLY valid JSON with this exact schema:
{
  "overallSummary": "2-3 sentence summary of the student's performance",
  "strengths": ["specific strength 1", "specific strength 2"],
  "weaknesses": ["specific gap or weak topic 1", "specific gap 2"],
  "revisionPriorities": ["concrete revision action 1", "concrete revision action 2", "concrete revision action 3"]
}`;

  const evalSummary = evaluations
    .map((ev, idx) => {
      const missing = Array.isArray(ev.missingConcepts) && ev.missingConcepts.length > 0
        ? ev.missingConcepts.join('; ')
        : 'None';
      return `Q${idx + 1} [${ev.topic}] - Score: ${normalizeScore(ev.score)}/5
Question: ${ev.question}
What was correct: ${ev.whatWasCorrect}
Missing concepts: ${missing}
Feedback: ${ev.feedback}`;
    })
    .join('\n\n');

  const prompt = `Total Score: ${totalScore}/${maxScore} (${percentage}% - ${classification})

QUESTION EVALUATIONS:
${evalSummary}`;

  const result = await callGeminiJson({
    systemInstruction,
    prompt,
    temperature: 0.25
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
