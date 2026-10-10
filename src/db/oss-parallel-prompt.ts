import { getPool } from './index';
import { OSS_PARALLEL_DISCOVERY_PROMPT, ossParallelPromptNeedsRefresh } from '../services/parallel-prompts';

/**
 * Compare-and-set the active OSS Parallel discovery prompt. Inactive rows
 * and prompts an operator already rewrote (21-day window, no old funder
 * queries) stay as they are.
 */
export async function refreshOssParallelDiscoveryPrompt(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; prompt_text: string }>(
    `SELECT id, prompt_text
     FROM scan_prompts
     WHERE is_active = true AND tool_type = 'parallel' AND wire = 'oss'`,
  );
  for (const row of rows) {
    if (!ossParallelPromptNeedsRefresh(row.prompt_text)) continue;
    await pool.query(
      `UPDATE scan_prompts
       SET prompt_text = $2
       WHERE id = $1
         AND is_active = true
         AND tool_type = 'parallel'
         AND wire = 'oss'
         AND prompt_text = $3`,
      [row.id, OSS_PARALLEL_DISCOVERY_PROMPT, row.prompt_text],
    );
  }
}
