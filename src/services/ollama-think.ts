/**
 * Native Ollama /api/chat thinking control.
 *
 * Lives apart from ollama.ts so the provider connection test can use the same
 * rules without an import cycle (ollama.ts reads the provider cache).
 */

export const SUMMARY_TOKEN_BUDGET = 4096;

export interface OllamaChatMessage {
  role: string;
  content: string;
  thinking?: string;
}

export type ThinkControl = { think: false | 'low' } | Record<string, never>;

/**
 * gpt-oss only accepts levels (`low` | `medium` | `high`). `true`/`false` are
 * not in its capability list, so they are ignored and the model default
 * (medium) applies. `low` is the shortest trace it allows.
 * https://docs.ollama.com/capabilities/thinking
 *
 * DeepSeek (including deepseek-v4.1-flash) and GLM (including glm-5.3-flash)
 * accept a boolean on the native /api/chat endpoint. `false` requests no
 * reasoning trace. Omitting `think` leaves thinking on, which spends
 * num_predict before the answer. The OpenAI-compatible /v1 `reasoning_effort`
 * mapping is not reliable for glm-5.3-flash (ollama/ollama#18121); callers
 * stay on /api/chat.
 *
 * Other models get no field. A boolean on a model with no thinking support
 * has been rejected by the API.
 */
export function thinkControl(model: string): ThinkControl {
  const name = model.trim().toLowerCase();
  if (name.startsWith('gpt-oss')) return { think: 'low' };
  if (name.startsWith('deepseek') || name.startsWith('glm')) return { think: false };
  return {};
}

function stripThinkMarkup(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const close = out.search(/<\/think>/i);
  if (close !== -1) out = out.slice(close).replace(/<\/think>/i, '');
  return out.replace(/<\/?think>/gi, '').trim();
}

/**
 * The model's final answer only. `message.thinking` is reasoning and must never
 * be used as output, even when `content` is empty. A length stop means the
 * answer was cut off. An unpaired `</think>` in content (glm chat template,
 * ollama/ollama#18082) is markup: everything before it is the trace.
 */
export function finalAnswerText(data: {
  message?: OllamaChatMessage;
  done_reason?: string;
}): string {
  if (data.done_reason === 'length') return '';
  return stripThinkMarkup(data.message?.content || '');
}
