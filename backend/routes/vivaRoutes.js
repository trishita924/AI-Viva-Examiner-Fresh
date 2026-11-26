import { Router } from 'express';
import {
  generateQuestion,
  evaluateAnswer,
  generateReport,
  getConfiguredModel,
  isGeminiConfigured
} from '../services/geminiService.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

const MAX_NOTES_CHARS = 40000;
const MIN_NOTES_CHARS = 50;
const MAX_ANSWER_CHARS = 5000;

/**
 * GET /api/health
 * Health check endpoint for connection verification and Render monitoring.
 */
router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ai-viva-examiner-backend',
    model: getConfiguredModel(),
    geminiConfigured: isGeminiConfigured(),
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /api/generate-question
 * Generates a single viva question grounded in the uploaded study notes.
 */
router.post('/generate-question', async (req, res, next) => {
  try {
    const { notes, questionNumber, totalQuestions = 5, previousQuestions = [] } = req.body || {};

    if (typeof notes !== 'string' || notes.trim().length < MIN_NOTES_CHARS) {
      throw new AppError(
        `Study notes must be a string with at least ${MIN_NOTES_CHARS} characters.`,
        400,
        'INVALID_NOTES'
      );
    }

    if (notes.length > MAX_NOTES_CHARS) {
      throw new AppError(
        `Study notes exceed the maximum allowed length of ${MAX_NOTES_CHARS} characters.`,
        400,
        'NOTES_TOO_LARGE'
      );
    }

    const qNum = Number(questionNumber);
    const total = Number(totalQuestions);
    if (!Number.isInteger(qNum) || qNum < 1 || qNum > 5) {
      throw new AppError('questionNumber must be an integer between 1 and 5.', 400, 'INVALID_QUESTION_NUMBER');
    }
    if (!Number.isInteger(total) || total !== 5) {
      throw new AppError('totalQuestions must be 5.', 400, 'INVALID_TOTAL_QUESTIONS');
    }

    if (!Array.isArray(previousQuestions) || previousQuestions.length > 4) {
      throw new AppError('previousQuestions must be an array of up to 4 items.', 400, 'INVALID_PREVIOUS_QUESTIONS');
    }

    const sanitizedPrevious = previousQuestions
      .filter((item) => item && typeof item.question === 'string')
      .map((item) => ({
        topic: typeof item.topic === 'string' ? item.topic.slice(0, 120) : '',
        question: item.question.slice(0, 500)
      }));

    const question = await generateQuestion({
      notes: notes.trim(),
      questionNumber: qNum,
      totalQuestions: total,
      previousQuestions: sanitizedPrevious
    });

    res.json({ question });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/evaluate-answer
 * Evaluates a student's answer (or original + follow-up answer together).
 */
router.post('/evaluate-answer', async (req, res, next) => {
  try {
    const {
      notes,
      question,
      topic = 'General',
      answer,
      isFollowUp = false,
      originalAnswer = '',
      followUpQuestion = '',
      followUpCount = 0
    } = req.body || {};

    if (typeof notes !== 'string' || notes.trim().length < MIN_NOTES_CHARS) {
      throw new AppError('Valid study notes are required for evaluation.', 400, 'INVALID_NOTES');
    }
    if (notes.length > MAX_NOTES_CHARS) {
      throw new AppError('Study notes exceed maximum allowed length.', 400, 'NOTES_TOO_LARGE');
    }
    if (typeof question !== 'string' || !question.trim()) {
      throw new AppError('Question text is required.', 400, 'INVALID_QUESTION');
    }
    if (typeof answer !== 'string' || !answer.trim()) {
      throw new AppError('Student answer cannot be empty.', 400, 'EMPTY_ANSWER');
    }
    if (answer.length > MAX_ANSWER_CHARS) {
      throw new AppError(`Answer exceeds maximum length of ${MAX_ANSWER_CHARS} characters.`, 400, 'ANSWER_TOO_LARGE');
    }

    if (isFollowUp && (typeof originalAnswer !== 'string' || !originalAnswer.trim())) {
      throw new AppError('originalAnswer is required when evaluating a follow-up.', 400, 'MISSING_ORIGINAL_ANSWER');
    }

    const evaluation = await evaluateAnswer({
      notes: notes.trim(),
      question: question.trim(),
      topic: typeof topic === 'string' ? topic.trim().slice(0, 120) : 'General',
      answer: answer.trim(),
      isFollowUp: Boolean(isFollowUp),
      originalAnswer: typeof originalAnswer === 'string' ? originalAnswer.trim().slice(0, MAX_ANSWER_CHARS) : '',
      followUpQuestion: typeof followUpQuestion === 'string' ? followUpQuestion.trim().slice(0, 500) : '',
      followUpCount: Number(followUpCount) || 0
    });

    res.json({ evaluation });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/generate-report
 * Generates the final viva report based on the 5 question evaluations.
 */
router.post('/generate-report', async (req, res, next) => {
  try {
    const { evaluations } = req.body || {};

    if (!Array.isArray(evaluations) || evaluations.length !== 5) {
      throw new AppError('Exactly 5 question evaluations are required to generate the final report.', 400, 'INVALID_EVALUATIONS');
    }

    for (let i = 0; i < evaluations.length; i += 1) {
      const ev = evaluations[i];
      if (!ev || typeof ev.question !== 'string' || typeof ev.score !== 'number' || Number.isNaN(ev.score)) {
        throw new AppError(`Evaluation at index ${i} is missing required fields (question, numeric score).`, 400, 'INVALID_EVALUATION_ITEM');
      }
    }

    const report = await generateReport({ evaluations });
    res.json({ report });
  } catch (err) {
    next(err);
  }
});

export default router;
