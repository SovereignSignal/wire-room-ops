/**
 * Scan-prompt review. Uses the Ollama summary chain (primary, then fallback).
 */

import { getBrand } from '../config/brand';
import type { RawScanResult, ToolType } from '../types/intake';
import { ollamaComplete, summaryModelChain } from './ollama';

export interface PromptReviewResult {
  model: string;
  summary: string;
  overallScore: number;
  strengths: string[];
  risks: string[];
  suggestions: string[];
  revisedPromptText: string;
  revisedResponseFormat: string | null;
  expectedImprovements: string[];
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
}

function normalizeReviewResult(raw: Record<string, unknown>, model: string): PromptReviewResult {
  return {
    model,
    summary: typeof raw.summary === 'string' && raw.summary.trim()
      ? raw.summary.trim()
      : 'The model did not provide a summary.',
    overallScore: Math.max(0, Math.min(100, Number(raw.overallScore) || 0)),
    strengths: normalizeStringList(raw.strengths),
    risks: normalizeStringList(raw.risks),
    suggestions: normalizeStringList(raw.suggestions),
    revisedPromptText: typeof raw.revisedPromptText === 'string' ? raw.revisedPromptText.trim() : '',
    revisedResponseFormat: typeof raw.revisedResponseFormat === 'string'
      ? (raw.revisedResponseFormat.trim() || null)
      : null,
    expectedImprovements: normalizeStringList(raw.expectedImprovements),
  };
}

function buildPromptReviewRequest(params: {
  wire?: string;
  label?: string;
  toolType: ToolType;
  promptText: string;
  responseFormat?: string | null;
  testOutput?: string | null;
  parsedResults?: RawScanResult[];
}): string {
  const parsedPreview = (params.parsedResults || [])
    .slice(0, 8)
    .map((result, index) => ({
      index: index + 1,
      name: result.name,
      amount: result.amount,
      deadline: result.deadline,
      sourceUrl: result.sourceUrl,
      description: result.description,
    }));

  const brand = getBrand();
  return `You are reviewing a ${brand.name} scan prompt used to discover high-signal ${brand.contentType}.

Your job:
1. Evaluate whether the prompt is likely to return findings in the six wire areas, excluding the OUT list.
2. Evaluate whether the output is easy to parse into structured entries with fields like name, description, amount, deadline, and source URL.
3. If test output is provided, judge the actual yield, not just the prompt wording.
4. Recommend a sharper version of the prompt and response format.

Evaluation criteria:
- High signal over noise
- Actionable opportunities over general news
- Strong inclusion and exclusion guidance
- Good fit for the selected tool
- Parseable, structured output
- Avoid duplicate-prone vague searches
- Avoid under-specified prompts that miss deadlines, amounts, or application details

Selected feed: ${params.wire || 'unknown'}
Prompt label: ${params.label || 'Untitled'}
Tool type: ${params.toolType}

Current prompt text:
${params.promptText}

Current response format:
${params.responseFormat || '(none)'}

Latest test output:
${params.testOutput || '(no test output supplied)'}

Parsed results preview:
${parsedPreview.length ? JSON.stringify(parsedPreview, null, 2) : '[]'}

Return strict JSON with exactly these keys:
{
  "summary": "one short paragraph",
  "overallScore": 0,
  "strengths": ["..."],
  "risks": ["..."],
  "suggestions": ["..."],
  "revisedPromptText": "full improved prompt text",
  "revisedResponseFormat": "full improved response format or empty string if not needed",
  "expectedImprovements": ["..."]
}

Rules:
- Keep overallScore between 0 and 100.
- revisedPromptText must be production-ready, not commentary.
- Suggestions must be concrete and specific to this prompt.
- If the current response format is good, you may keep it with minor edits.
- Do not wrap the JSON in markdown fences.`;
}

export async function reviewScanPrompt(params: {
  wire?: string;
  label?: string;
  toolType: ToolType;
  promptText: string;
  responseFormat?: string | null;
  testOutput?: string | null;
  parsedResults?: RawScanResult[];
  model?: string;
}): Promise<PromptReviewResult> {
  const request = buildPromptReviewRequest(params);
  const models = params.model?.trim() ? [params.model.trim()] : summaryModelChain();
  if (models.length === 0) throw new Error('Ollama summary model is not configured');

  let lastError: Error | null = null;
  for (const model of models) {
    try {
      const { text } = await ollamaComplete({
        prompt: request,
        purpose: 'prompt-review',
        model,
        numPredict: 8192,
      });
      const parsed = extractJsonObject(text);
      if (!parsed) throw new Error('Prompt review returned an invalid response');
      return normalizeReviewResult(parsed, model);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error('Prompt review failed');
}
