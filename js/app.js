import {
  checkHealth,
  generateQuestion,
  evaluateAnswer,
  generateReport,
  getBackendBaseUrl,
  setBackendBaseUrl,
  validateBackendUrl
} from './api.js';
import {
  extractTextFromFile,
  countWords,
  MIN_NOTES_CHARS,
  MAX_EXTRACTED_CHARS
} from './file-extractor.js';
import {
  getVivaHistory,
  saveVivaHistoryItem,
  clearVivaHistory
} from './storage.js';

const TOTAL_QUESTIONS = 5;

const state = {
  notes: '',
  sourceName: 'Manual input',
  backendConnected: false,
  geminiConfigured: false,
  isBusy: false,
  exam: {
    currentQuestionNumber: 0,
    currentQuestion: null,
    originalAnswer: '',
    followUpQuestion: '',
    followUpCount: 0,
    awaitingFollowUp: false,
    evaluations: []
  }
};

// DOM References
const dom = {
  // Topbar
  connectionBadge: document.getElementById('connection-badge'),
  connectionDot: document.getElementById('connection-dot'),
  connectionText: document.getElementById('connection-text'),
  connectionModel: document.getElementById('connection-model'),

  // Views
  viewSetup: document.getElementById('view-setup'),
  viewExam: document.getElementById('view-exam'),
  viewReport: document.getElementById('view-report'),

  // Setup
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  browseFilesBtn: document.getElementById('browse-files-btn'),
  extractionStatus: document.getElementById('extraction-status'),
  fileNameBadge: document.getElementById('file-name-badge'),
  wordCountBadge: document.getElementById('word-count-badge'),
  charCountBadge: document.getElementById('char-count-badge'),
  notesTextarea: document.getElementById('notes-textarea'),
  clearNotesBtn: document.getElementById('clear-notes-btn'),
  startVivaBtn: document.getElementById('start-viva-btn'),
  setupErrorBanner: document.getElementById('setup-error-banner'),
  backendUrlInput: document.getElementById('backend-url-input'),
  saveConnectBtn: document.getElementById('save-connect-btn'),
  connectionFeedback: document.getElementById('connection-feedback'),
  historyList: document.getElementById('history-list'),
  clearHistoryBtn: document.getElementById('clear-history-btn'),

  // Exam
  examProgressText: document.getElementById('exam-progress-text'),
  examProgressBar: document.getElementById('exam-progress-bar'),
  runningTotalBadge: document.getElementById('running-total-badge'),
  exitVivaBtn: document.getElementById('exit-viva-btn'),
  examErrorBanner: document.getElementById('exam-error-banner'),
  questionTopicBadge: document.getElementById('question-topic-badge'),
  questionTypeBadge: document.getElementById('question-type-badge'),
  questionLoading: document.getElementById('question-loading'),
  questionText: document.getElementById('question-text'),
  primaryAnswerBox: document.getElementById('primary-answer-box'),
  answerTextarea: document.getElementById('answer-textarea'),
  submitAnswerBtn: document.getElementById('submit-answer-btn'),
  followupCard: document.getElementById('followup-card'),
  followupQuestionText: document.getElementById('followup-question-text'),
  originalAnswerPreview: document.getElementById('original-answer-preview'),
  followupTextarea: document.getElementById('followup-textarea'),
  submitFollowupBtn: document.getElementById('submit-followup-btn'),
  feedbackCard: document.getElementById('feedback-card'),
  questionScoreBadge: document.getElementById('question-score-badge'),
  feedbackCorrect: document.getElementById('feedback-correct'),
  feedbackMissing: document.getElementById('feedback-missing'),
  feedbackConstructive: document.getElementById('feedback-constructive'),
  feedbackExplanation: document.getElementById('feedback-explanation'),
  nextQuestionBtn: document.getElementById('next-question-btn'),

  // Report
  reportLoading: document.getElementById('report-loading'),
  reportErrorBanner: document.getElementById('report-error-banner'),
  reportContent: document.getElementById('report-content'),
  reportClassification: document.getElementById('report-classification'),
  reportSummary: document.getElementById('report-summary'),
  reportTotalScore: document.getElementById('report-total-score'),
  reportPercentage: document.getElementById('report-percentage'),
  reportStrengths: document.getElementById('report-strengths'),
  reportWeaknesses: document.getElementById('report-weaknesses'),
  reportRevisions: document.getElementById('report-revisions'),
  reportQuestionsList: document.getElementById('report-questions-list'),
  restartVivaBtn: document.getElementById('restart-viva-btn')
};

function showView(viewName) {
  dom.viewSetup.classList.toggle('hidden', viewName !== 'setup');
  dom.viewSetup.classList.toggle('active', viewName === 'setup');
  dom.viewExam.classList.toggle('hidden', viewName !== 'exam');
  dom.viewExam.classList.toggle('active', viewName === 'exam');
  dom.viewReport.classList.toggle('hidden', viewName !== 'report');
  dom.viewReport.classList.toggle('active', viewName === 'report');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showBanner(el, message, variant = 'error') {
  if (!message) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.className = `alert alert-${variant}`;
  el.textContent = message;
  el.classList.remove('hidden');
}

function updateNotesMetrics() {
  const text = dom.notesTextarea.value;
  state.notes = text;
  const words = countWords(text);
  dom.fileNameBadge.textContent = `Source: ${state.sourceName}`;
  dom.wordCountBadge.textContent = `${words.toLocaleString()} words`;
  dom.charCountBadge.textContent = `${text.length.toLocaleString()} / ${MAX_EXTRACTED_CHARS.toLocaleString()} chars`;
}

function setConnectionStatus({ connected, geminiConfigured = false, model = '', message = '' }) {
  state.backendConnected = connected;
  state.geminiConfigured = geminiConfigured;

  dom.connectionBadge.classList.remove('connected', 'disconnected');
  if (connected && geminiConfigured) {
    dom.connectionBadge.classList.add('connected');
    dom.connectionText.textContent = 'Gemini Connected';
    dom.connectionModel.textContent = model;
    dom.connectionModel.classList.remove('hidden');
  } else if (connected && !geminiConfigured) {
    dom.connectionBadge.classList.add('disconnected');
    dom.connectionText.textContent = 'API Key Missing';
    dom.connectionModel.classList.add('hidden');
  } else {
    dom.connectionBadge.classList.add('disconnected');
    dom.connectionText.textContent = 'Backend Offline';
    dom.connectionModel.classList.add('hidden');
  }

  if (message) {
    dom.connectionFeedback.textContent = message;
  }
}

async function testBackendConnection() {
  const currentUrl = getBackendBaseUrl();
  if (!currentUrl) {
    setConnectionStatus({
      connected: false,
      message: 'Enter your Render or local backend URL and click Connect.'
    });
    return;
  }

  dom.connectionText.textContent = 'Connecting...';
  try {
    const data = await checkHealth();
    const configured = Boolean(data.geminiConfigured);
    setConnectionStatus({
      connected: true,
      geminiConfigured: configured,
      model: data.model || 'gemini-2.5-flash',
      message: configured
        ? `Connected to ${currentUrl} (Model: ${data.model}).`
        : 'Backend reachable, but the server Gemini API key is not configured.'
    });
  } catch (err) {
    setConnectionStatus({
      connected: false,
      message: err.message
    });
  }
}

function renderHistory() {
  const history = getVivaHistory();
  dom.historyList.innerHTML = '';

  if (history.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No completed vivas yet. Your recent scores will appear here.';
    dom.historyList.appendChild(empty);
    return;
  }

  history.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'history-item';

    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = item.sourceName || 'Study Notes Viva';

    const date = document.createElement('div');
    date.className = 'history-date';
    date.textContent = `${item.date} • ${item.classification}`;

    left.appendChild(title);
    left.appendChild(date);

    const score = document.createElement('div');
    score.className = 'history-score';
    score.textContent = `${item.totalScore} / ${item.maxScore} (${item.percentage}%)`;

    row.appendChild(left);
    row.appendChild(score);
    dom.historyList.appendChild(row);
  });
}

async function handleFileSelection(file) {
  if (!file) return;
  showBanner(dom.setupErrorBanner, '');
  showBanner(dom.extractionStatus, 'Extracting text from file...', 'warning');

  try {
    const result = await extractTextFromFile(file);
    state.sourceName = result.filename;
    dom.notesTextarea.value = result.text;
    updateNotesMetrics();

    if (result.truncated) {
      showBanner(
        dom.extractionStatus,
        `Extracted "${result.filename}". Text was trimmed to ${MAX_EXTRACTED_CHARS.toLocaleString()} characters to fit API limits.`,
        'warning'
      );
    } else {
      showBanner(
        dom.extractionStatus,
        `Successfully extracted ${result.wordCount.toLocaleString()} words from "${result.filename}".`,
        'success'
      );
    }
  } catch (err) {
    showBanner(dom.extractionStatus, err.message, 'error');
  }
}

function computeRunningTotal() {
  const sum = state.exam.evaluations.reduce((acc, ev) => acc + (Number(ev.score) || 0), 0);
  return Math.round(sum * 10) / 10;
}

function updateExamHeader() {
  const qNum = state.exam.currentQuestionNumber;
  dom.examProgressText.textContent = `Question ${qNum} of ${TOTAL_QUESTIONS}`;
  dom.examProgressBar.style.width = `${(qNum / TOTAL_QUESTIONS) * 100}%`;
  dom.runningTotalBadge.textContent = `Running Total: ${computeRunningTotal()} / 25`;
}

async function loadNextQuestion() {
  if (state.isBusy) return;
  state.isBusy = true;

  state.exam.currentQuestionNumber += 1;
  state.exam.currentQuestion = null;
  state.exam.originalAnswer = '';
  state.exam.followUpQuestion = '';
  state.exam.followUpCount = 0;
  state.exam.awaitingFollowUp = false;

  updateExamHeader();
  showBanner(dom.examErrorBanner, '');

  dom.questionText.textContent = '';
  dom.questionTopicBadge.textContent = 'Loading topic...';
  dom.questionTypeBadge.textContent = '...';
  dom.questionLoading.classList.remove('hidden');

  dom.primaryAnswerBox.classList.add('hidden');
  dom.followupCard.classList.add('hidden');
  dom.feedbackCard.classList.add('hidden');
  dom.answerTextarea.value = '';
  dom.followupTextarea.value = '';

  try {
    const previousQuestions = state.exam.evaluations.map((ev) => ({
      topic: ev.topic,
      question: ev.question
    }));

    const data = await generateQuestion({
      notes: state.notes,
      questionNumber: state.exam.currentQuestionNumber,
      totalQuestions: TOTAL_QUESTIONS,
      previousQuestions
    });

    const q = data.question;
    state.exam.currentQuestion = q;

    dom.questionTopicBadge.textContent = q.topic;
    dom.questionTypeBadge.textContent = q.questionType;
    dom.questionText.textContent = q.question;
    dom.questionLoading.classList.add('hidden');
    dom.primaryAnswerBox.classList.remove('hidden');
    dom.answerTextarea.focus();
  } catch (err) {
    dom.questionLoading.classList.add('hidden');
    showBanner(dom.examErrorBanner, err.message, 'error');
  } finally {
    state.isBusy = false;
  }
}

function renderEvaluationFeedback(evaluation) {
  dom.questionScoreBadge.textContent = `${evaluation.score} / 5`;
  dom.feedbackCorrect.textContent = evaluation.whatWasCorrect;
  dom.feedbackConstructive.textContent = evaluation.feedback;
  dom.feedbackExplanation.textContent = evaluation.correctExplanation;

  dom.feedbackMissing.innerHTML = '';
  if (Array.isArray(evaluation.missingConcepts) && evaluation.missingConcepts.length > 0) {
    evaluation.missingConcepts.forEach((concept) => {
      const li = document.createElement('li');
      li.textContent = concept;
      dom.feedbackMissing.appendChild(li);
    });
  } else {
    const li = document.createElement('li');
    li.textContent = 'No major concepts missing.';
    dom.feedbackMissing.appendChild(li);
  }

  dom.nextQuestionBtn.textContent =
    state.exam.currentQuestionNumber >= TOTAL_QUESTIONS
      ? 'Finish & View Final Report'
      : 'Next Question';

  dom.feedbackCard.classList.remove('hidden');
  updateExamHeader();
}

async function handleAnswerSubmit() {
  if (state.isBusy || !state.exam.currentQuestion) return;
  const answer = dom.answerTextarea.value.trim();
  if (!answer) {
    showBanner(dom.examErrorBanner, 'Please write your answer before submitting.', 'warning');
    return;
  }

  showBanner(dom.examErrorBanner, '');
  state.isBusy = true;
  dom.submitAnswerBtn.disabled = true;
  dom.submitAnswerBtn.textContent = 'Evaluating...';

  try {
    const data = await evaluateAnswer({
      notes: state.notes,
      question: state.exam.currentQuestion.question,
      topic: state.exam.currentQuestion.topic,
      answer,
      isFollowUp: false,
      followUpCount: state.exam.followUpCount
    });

    const ev = data.evaluation;
    state.exam.originalAnswer = answer;

    if (ev.needsFollowUp && ev.followUpQuestion && state.exam.followUpCount < 1) {
      state.exam.awaitingFollowUp = true;
      state.exam.followUpQuestion = ev.followUpQuestion;
      state.exam.followUpCount = 1;

      dom.primaryAnswerBox.classList.add('hidden');
      dom.originalAnswerPreview.textContent = answer;
      dom.followupQuestionText.textContent = ev.followUpQuestion;
      dom.followupCard.classList.remove('hidden');
      dom.followupTextarea.focus();
    } else {
      dom.primaryAnswerBox.classList.add('hidden');
      finalizeQuestionEvaluation({
        evaluation: ev,
        originalAnswer: answer,
        followUpQuestion: '',
        followUpAnswer: ''
      });
    }
  } catch (err) {
    showBanner(dom.examErrorBanner, err.message, 'error');
  } finally {
    state.isBusy = false;
    dom.submitAnswerBtn.disabled = false;
    dom.submitAnswerBtn.textContent = 'Submit Answer';
  }
}

async function handleFollowupSubmit() {
  if (state.isBusy || !state.exam.currentQuestion) return;
  const followUpAnswer = dom.followupTextarea.value.trim();
  if (!followUpAnswer) {
    showBanner(dom.examErrorBanner, 'Please write your follow-up response before submitting.', 'warning');
    return;
  }

  showBanner(dom.examErrorBanner, '');
  state.isBusy = true;
  dom.submitFollowupBtn.disabled = true;
  dom.submitFollowupBtn.textContent = 'Evaluating...';

  try {
    const data = await evaluateAnswer({
      notes: state.notes,
      question: state.exam.currentQuestion.question,
      topic: state.exam.currentQuestion.topic,
      answer: followUpAnswer,
      isFollowUp: true,
      originalAnswer: state.exam.originalAnswer,
      followUpQuestion: state.exam.followUpQuestion,
      followUpCount: state.exam.followUpCount
    });

    dom.followupCard.classList.add('hidden');
    finalizeQuestionEvaluation({
      evaluation: data.evaluation,
      originalAnswer: state.exam.originalAnswer,
      followUpQuestion: state.exam.followUpQuestion,
      followUpAnswer
    });
  } catch (err) {
    showBanner(dom.examErrorBanner, err.message, 'error');
  } finally {
    state.isBusy = false;
    dom.submitFollowupBtn.disabled = false;
    dom.submitFollowupBtn.textContent = 'Submit Follow-Up';
  }
}

function finalizeQuestionEvaluation({ evaluation, originalAnswer, followUpQuestion, followUpAnswer }) {
  const record = {
    questionNumber: state.exam.currentQuestionNumber,
    topic: state.exam.currentQuestion.topic,
    questionType: state.exam.currentQuestion.questionType,
    question: state.exam.currentQuestion.question,
    originalAnswer,
    followUpQuestion,
    followUpAnswer,
    score: evaluation.score,
    whatWasCorrect: evaluation.whatWasCorrect,
    missingConcepts: evaluation.missingConcepts,
    feedback: evaluation.feedback,
    correctExplanation: evaluation.correctExplanation
  };

  state.exam.evaluations.push(record);
  renderEvaluationFeedback(evaluation);
}

function renderInsightList(ulElement, items, fallbackText) {
  ulElement.innerHTML = '';
  const list = Array.isArray(items) && items.length > 0 ? items : [fallbackText];
  list.forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    ulElement.appendChild(li);
  });
}

async function finishAndShowReport() {
  if (state.isBusy) return;
  state.isBusy = true;

  showView('report');
  dom.reportLoading.classList.remove('hidden');
  dom.reportContent.classList.add('hidden');
  showBanner(dom.reportErrorBanner, '');

  try {
    const data = await generateReport({ evaluations: state.exam.evaluations });
    const report = data.report;

    dom.reportClassification.textContent = report.classification;
    dom.reportSummary.textContent = report.overallSummary;
    dom.reportTotalScore.textContent = `${report.totalScore} / ${report.maxScore}`;
    dom.reportPercentage.textContent = `${report.percentage}%`;

    renderInsightList(dom.reportStrengths, report.strengths, 'Consistent effort across questions.');
    renderInsightList(dom.reportWeaknesses, report.weaknesses, 'No major weaknesses identified.');
    renderInsightList(dom.reportRevisions, report.revisionPriorities, 'Continue periodic review of your notes.');

    dom.reportQuestionsList.innerHTML = '';
    state.exam.evaluations.forEach((ev) => {
      const card = document.createElement('div');
      card.className = 'report-q-item';

      const head = document.createElement('div');
      head.className = 'report-q-head';

      const topicSpan = document.createElement('span');
      topicSpan.className = 'topic-badge';
      topicSpan.textContent = `Q${ev.questionNumber}: ${ev.topic}`;

      const scoreSpan = document.createElement('span');
      scoreSpan.className = 'score-pill';
      scoreSpan.textContent = `${ev.score} / 5`;

      head.appendChild(topicSpan);
      head.appendChild(scoreSpan);

      const qTitle = document.createElement('div');
      qTitle.className = 'report-q-title';
      qTitle.textContent = ev.question;

      const ansEl = document.createElement('p');
      ansEl.className = 'report-q-detail';
      ansEl.innerHTML = '<strong>Your Answer:</strong> ';
      ansEl.appendChild(document.createTextNode(ev.originalAnswer));

      card.appendChild(head);
      card.appendChild(qTitle);
      card.appendChild(ansEl);

      if (ev.followUpQuestion && ev.followUpAnswer) {
        const fuEl = document.createElement('p');
        fuEl.className = 'report-q-detail';
        fuEl.innerHTML = '<strong>Follow-Up Response:</strong> ';
        fuEl.appendChild(document.createTextNode(`${ev.followUpQuestion} — ${ev.followUpAnswer}`));
        card.appendChild(fuEl);
      }

      const expEl = document.createElement('p');
      expEl.className = 'report-q-detail';
      expEl.innerHTML = '<strong>Correct Explanation:</strong> ';
      expEl.appendChild(document.createTextNode(ev.correctExplanation));
      card.appendChild(expEl);

      dom.reportQuestionsList.appendChild(card);
    });

    saveVivaHistoryItem({
      sourceName: state.sourceName,
      totalScore: report.totalScore,
      maxScore: report.maxScore,
      percentage: report.percentage,
      classification: report.classification,
      date: new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    });
    renderHistory();

    dom.reportLoading.classList.add('hidden');
    dom.reportContent.classList.remove('hidden');
  } catch (err) {
    dom.reportLoading.classList.add('hidden');
    showBanner(dom.reportErrorBanner, err.message, 'error');
  } finally {
    state.isBusy = false;
  }
}

async function startVivaSession() {
  showBanner(dom.setupErrorBanner, '');
  const notes = dom.notesTextarea.value.trim();

  if (notes.length < MIN_NOTES_CHARS) {
    showBanner(
      dom.setupErrorBanner,
      `Please provide at least ${MIN_NOTES_CHARS} characters of study notes before starting the viva.`,
      'warning'
    );
    return;
  }

  if (notes.length > MAX_EXTRACTED_CHARS) {
    showBanner(
      dom.setupErrorBanner,
      `Study notes exceed ${MAX_EXTRACTED_CHARS.toLocaleString()} characters. Please trim the text.`,
      'warning'
    );
    return;
  }

  if (!state.backendConnected || !state.geminiConfigured) {
    await testBackendConnection();
    if (!state.backendConnected || !state.geminiConfigured) {
      showBanner(
        dom.setupErrorBanner,
        'Cannot start viva: the Gemini backend is offline or missing the server Gemini API key.',
        'error'
      );
      return;
    }
  }

  state.notes = notes;
  state.exam = {
    currentQuestionNumber: 0,
    currentQuestion: null,
    originalAnswer: '',
    followUpQuestion: '',
    followUpCount: 0,
    awaitingFollowUp: false,
    evaluations: []
  };

  showView('exam');
  await loadNextQuestion();
}

function bindEvents() {
  // Backend URL save & connect
  dom.saveConnectBtn.addEventListener('click', async () => {
    const check = validateBackendUrl(dom.backendUrlInput.value);
    if (!check.valid) {
      setConnectionStatus({ connected: false, message: check.error });
      return;
    }
    setBackendBaseUrl(check.url);
    await testBackendConnection();
  });

  // File upload interactions
  dom.browseFilesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dom.fileInput.click();
  });

  dom.dropZone.addEventListener('click', () => {
    dom.fileInput.click();
  });

  dom.dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      dom.fileInput.click();
    }
  });

  dom.fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelection(file);
    }
    dom.fileInput.value = '';
  });

  dom.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dom.dropZone.classList.add('drag-over');
  });

  dom.dropZone.addEventListener('dragleave', () => {
    dom.dropZone.classList.remove('drag-over');
  });

  dom.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.dropZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      handleFileSelection(file);
    }
  });

  dom.notesTextarea.addEventListener('input', () => {
    if (!dom.notesTextarea.value.trim()) {
      state.sourceName = 'Manual input';
    }
    updateNotesMetrics();
  });

  dom.clearNotesBtn.addEventListener('click', () => {
    dom.notesTextarea.value = '';
    state.sourceName = 'Manual input';
    showBanner(dom.extractionStatus, '');
    showBanner(dom.setupErrorBanner, '');
    updateNotesMetrics();
  });

  dom.clearHistoryBtn.addEventListener('click', () => {
    clearVivaHistory();
    renderHistory();
  });

  dom.startVivaBtn.addEventListener('click', startVivaSession);

  // Exam controls
  dom.submitAnswerBtn.addEventListener('click', handleAnswerSubmit);
  dom.submitFollowupBtn.addEventListener('click', handleFollowupSubmit);

  dom.nextQuestionBtn.addEventListener('click', () => {
    if (state.exam.currentQuestionNumber >= TOTAL_QUESTIONS) {
      finishAndShowReport();
    } else {
      loadNextQuestion();
    }
  });

  dom.exitVivaBtn.addEventListener('click', () => {
    const confirmed = window.confirm('Exit the current viva? Your in-progress answers will not be saved.');
    if (confirmed) {
      showView('setup');
    }
  });

  dom.restartVivaBtn.addEventListener('click', () => {
    showView('setup');
  });
}

function init() {
  dom.backendUrlInput.value = getBackendBaseUrl();
  updateNotesMetrics();
  renderHistory();
  bindEvents();
  testBackendConnection();
}

init();
