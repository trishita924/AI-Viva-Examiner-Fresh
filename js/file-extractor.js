/**
 * Browser-side document text extraction for PDF, DOCX, and TXT files.
 * Uses PDF.js for PDFs, Mammoth.js for DOCX, and native File API for TXT.
 */

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_EXTRACTED_CHARS = 40000;
export const MIN_NOTES_CHARS = 50;

const PDF_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

function getFileExtension(filename) {
  const parts = (filename || '').toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

function normalizeExtractedText(text) {
  return (text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractTxt(file) {
  const text = await file.text();
  return normalizeExtractedText(text);
}

async function extractPdf(file) {
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) {
    throw new Error('PDF extraction library failed to load. Check your internet connection or paste your notes manually.');
  }

  pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;

  const arrayBuffer = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  } catch {
    throw new Error('Could not read this PDF file. It may be corrupted, password-protected, or not a valid PDF.');
  }

  if (!pdf || pdf.numPages === 0) {
    throw new Error('This PDF contains no readable pages.');
  }

  const pageTexts = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const strings = content.items
      .map((item) => (typeof item.str === 'string' ? item.str : ''))
      .filter(Boolean);
    if (strings.length > 0) {
      pageTexts.push(strings.join(' '));
    }
  }

  return normalizeExtractedText(pageTexts.join('\n\n'));
}

async function extractDocx(file) {
  const mammoth = window.mammoth;
  if (!mammoth) {
    throw new Error('DOCX extraction library failed to load. Check your internet connection or paste your notes manually.');
  }

  const arrayBuffer = await file.arrayBuffer();
  let result;
  try {
    result = await mammoth.extractRawText({ arrayBuffer });
  } catch {
    throw new Error('Could not read this DOCX file. It may be corrupted or not a valid Word (.docx) document.');
  }

  return normalizeExtractedText(result?.value || '');
}

/**
 * Extracts text from a supported File object and enforces size and content checks.
 */
export async function extractTextFromFile(file) {
  if (!file) {
    throw new Error('No file selected.');
  }

  if (file.size === 0) {
    throw new Error(`"${file.name}" is empty (0 bytes). Please upload a file with study content.`);
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    throw new Error(`"${file.name}" is ${sizeMb} MB, which exceeds the 10 MB upload limit.`);
  }

  const ext = getFileExtension(file.name);
  let extractedText = '';

  if (ext === 'txt') {
    extractedText = await extractTxt(file);
  } else if (ext === 'pdf') {
    extractedText = await extractPdf(file);
  } else if (ext === 'docx') {
    extractedText = await extractDocx(file);
  } else {
    throw new Error(`Unsupported file type ".${ext || 'unknown'}". Please upload a PDF, DOCX, or TXT file.`);
  }

  if (!extractedText) {
    throw new Error(
      `No readable text could be extracted from "${file.name}". If this is a scanned image PDF, please paste your notes manually.`
    );
  }

  let truncated = false;
  if (extractedText.length > MAX_EXTRACTED_CHARS) {
    extractedText = extractedText.slice(0, MAX_EXTRACTED_CHARS).trim();
    truncated = true;
  }

  return {
    filename: file.name,
    text: extractedText,
    wordCount: countWords(extractedText),
    charCount: extractedText.length,
    truncated
  };
}

export function countWords(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
