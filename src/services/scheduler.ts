import cron, { ScheduledTask } from 'node-cron';
import { runScanExecution } from '../jobs/scan-execution';
import { runForumScan } from '../jobs/forum-scan';
import { config } from '../config';
import { sendTestAlertEmail, sendScheduledJobFailureEmail, sendDailyDigestEmail } from './email';
import { ExperimentEngine } from './experiment-engine';
import { runCsvExport } from '../jobs/csv-export';
import { createMagicLink } from './auth';
import { runDailyDigest, getTopPendingFinds } from '../jobs/daily-digest';
import { ensureScheduleTable, getAllSchedules, getScheduleById, createSchedule, updateSchedule, deleteSchedule as dbDeleteSchedule, StoredScheduleConfig, ensureFeedsTable, ensureScanTables, ensureScanPromptsTable, ensureDistributionTables, getPool } from '../db';
import { getActiveWires } from './intake-core';

export interface ScheduleConfig {
  id: string;
  name: string;
  enabled: boolean;
  dayOfWeek: number; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  hour: number; // 0-23
  minute: number; // 0-59
  lookbackDays: number; // How many days back to look
  grokModel?: string;
  anthropicModel?: string;
  timezone: string;
  wire?: string; // Optional wire/feed filter
  scheduleType?: 'scan-execution' | 'forum-scan' | 'daily-digest';
  frequencyHours?: number; // Sub-daily interval (1-23) for scan-execution
  notifyEmails?: string; // Comma-separated email recipients
}

// Default schedule template for new schedules
const DEFAULT_SCHEDULE_TEMPLATE: Omit<ScheduleConfig, 'id'> = {
  name: 'New Schedule',
  enabled: false,
  dayOfWeek: 7, // Every day (0-6 = specific day, 7 = daily)
  hour: 9,
  minute: 0,
  lookbackDays: 7,
  timezone: 'America/Los_Angeles',
  scheduleType: 'scan-execution',
};

// In-memory cache of all schedules
let schedules: Map<string, ScheduleConfig> = new Map();
let scheduledTasks: Map<string, ScheduledTask> = new Map();
let isInitialized = false;

// Job execution tracking per schedule
interface JobStatus {
  lastRun: Date | null;
  status: 'success' | 'failed' | null;
  error: string | null;
  retried?: boolean;
}
let jobStatuses: Map<string, JobStatus> = new Map();
let executingJobs: Set<string> = new Set(); // Prevents overlapping cron runs
let pendingRetryTimers: Map<string, NodeJS.Timeout> = new Map(); // Track retry timers for cleanup
let schedulerStartTime: Date | null = null;

function isQuotaExhaustedError(message: string): boolean {
  return /resource has been exhausted|used all available credits|monthly spending limit/i.test(message);
}

export function getSchedules(): ScheduleConfig[] {
  return Array.from(schedules.values());
}

export function getSchedule(id?: string): ScheduleConfig | null {
  if (id) {
    return schedules.get(id) || null;
  }
  // Legacy: return first schedule
  const all = getSchedules();
  return all.length > 0 ? all[0] : null;
}

export async function addSchedule(newSchedule?: Partial<Omit<ScheduleConfig, 'id'>>): Promise<ScheduleConfig> {
  const scheduleData = { ...DEFAULT_SCHEDULE_TEMPLATE, ...newSchedule };
  const created = await createSchedule(scheduleData);
  
  schedules.set(created.id, created);
  
  if (created.enabled) {
    startScheduleTask(created);
  }
  
  console.log(`[Scheduler] Created new schedule: ${created.name} (${created.id})`);

  // If this is a new daily-digest schedule, auto-derive scan schedules from it
  if (created.scheduleType === 'daily-digest') {
    await syncScanSchedulesFromDigest(created);
  }

  return created;
}

export async function setSchedule(id: string, updates: Partial<Omit<ScheduleConfig, 'id'>>): Promise<ScheduleConfig | null> {
  const updated = await updateSchedule(id, updates);
  if (!updated) return null;

  schedules.set(id, updated);

  // Restart the task if it exists
  stopScheduleTask(id);
  if (updated.enabled) {
    startScheduleTask(updated);
  }

  // If this is a daily-digest schedule, auto-sync scan schedules to run before it
  if (updated.scheduleType === 'daily-digest') {
    await syncScanSchedulesFromDigest(updated);
  }

  console.log(`[Scheduler] Updated schedule: ${updated.name} (${id})`);
  return updated;
}

/**
 * Digest-Driven Scan Scheduling
 *
 * When a user sets a digest delivery time, we automatically backsolve scan times
 * so all three wires complete well before the digest fires.
 *
 * Lead times before digest:
 *   crypto → 4.5h before (most scans, most prompts)
 *   ai     → 3.5h before
 *   oss    → 2.5h before
 *
 * Second pass (afternoon):
 *   crypto → 4.5h after digest
 *   ai     → 5.5h after digest
 *   oss    → 6.5h after digest
 *
 * Users set ONE time (when they want results). Everything else is derived.
 */
export async function syncScanSchedulesFromDigest(digestSchedule: ScheduleConfig): Promise<void> {
  const pool = getPool();
  const digestHour = digestSchedule.hour;
  const digestMinute = digestSchedule.minute;
  const timezone = digestSchedule.timezone;
  const digestEnabled = digestSchedule.enabled;

  // Load active wires dynamically from DB/env
  const activeWireKeys = await getActiveWires();

  // Spread lead times evenly: first wire = 270 min before, last = 150 min before
  // Formula for N wires: leadMinutes[i] = 270 - i * (120 / max(N-1, 1))
  const maxLead = 270;
  const minLead = 150;
  const step = activeWireKeys.length > 1 ? (maxLead - minLead) / (activeWireKeys.length - 1) : 0;
  const wires = activeWireKeys.map((wire, i) => ({
    wire,
    leadMinutes: Math.round(maxLead - i * step),
  }));

  // Helper: subtract minutes from an hour:minute, wrapping around midnight
  function subtractMinutes(h: number, m: number, lead: number) {
    const totalMins = h * 60 + m - lead;
    const wrapped = ((totalMins % 1440) + 1440) % 1440; // always positive
    return { hour: Math.floor(wrapped / 60), minute: wrapped % 60 };
  }

  function addMinutes(h: number, m: number, offset: number) {
    const totalMins = h * 60 + m + offset;
    const wrapped = totalMins % 1440;
    return { hour: Math.floor(wrapped / 60), minute: wrapped % 60 };
  }

  // Afternoon second-pass offsets after digest: stagger by 90 min each starting at 270 min
  const afternoonOffsets = wires.map((_, i) => 270 + i * 90);

  console.log(`[Scheduler] Syncing scan schedules from digest at ${digestHour}:${String(digestMinute).padStart(2,'0')} ${timezone}`);

  for (let i = 0; i < wires.length; i++) {
    const { wire, leadMinutes } = wires[i];
    const firstRun = subtractMinutes(digestHour, digestMinute, leadMinutes);
    const secondRun = addMinutes(digestHour, digestMinute, afternoonOffsets[i]);

    // Find existing scan-execution schedules for this wire
    const existing = await pool.query(
      `SELECT id, hour, minute FROM schedules WHERE schedule_type = 'scan-execution' AND wire = $1 ORDER BY hour`,
      [wire]
    );

    if (existing.rows.length === 0) {
      // Create new scan schedules for this wire
      for (const [idx, run] of [firstRun, secondRun].entries()) {
        await pool.query(
          `INSERT INTO schedules (id, name, enabled, hour, minute, timezone, wire, schedule_type, lookback_days, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'scan-execution', 7, NOW(), NOW())`,
          [
            `${wire} scan (${idx === 0 ? 'AM' : 'PM'}) — auto`,
            digestEnabled,
            run.hour,
            run.minute,
            timezone,
            wire,
          ]
        );
      }
      console.log(`[Scheduler] Created scan schedules for ${wire}: AM at ${firstRun.hour}:${String(firstRun.minute).padStart(2,'0')}, PM at ${secondRun.hour}:${String(secondRun.minute).padStart(2,'0')}`);
    } else {
      // Update existing schedules: first row = first run, second row = second run
      const sortedRows = existing.rows.sort((a: { hour: number }, b: { hour: number }) => a.hour - b.hour);
      const updates = [firstRun, secondRun];
      for (let j = 0; j < Math.min(sortedRows.length, updates.length); j++) {
        await pool.query(
          `UPDATE schedules SET hour = $1, minute = $2, timezone = $3, enabled = $4, updated_at = NOW() WHERE id = $5`,
          [updates[j].hour, updates[j].minute, timezone, digestEnabled, sortedRows[j].id]
        );
      }
      console.log(`[Scheduler] Updated scan schedules for ${wire}: AM at ${firstRun.hour}:${String(firstRun.minute).padStart(2,'0')}, PM at ${secondRun.hour}:${String(secondRun.minute).padStart(2,'0')}`);
    }
  }

  // Reload all schedules so the in-memory state reflects the new scan times
  const allSchedules = await getAllSchedules();
  schedules.clear();
  scheduledTasks.forEach((_, id) => stopScheduleTask(id));
  for (const s of allSchedules) {
    schedules.set(s.id, s);
    if (s.enabled) startScheduleTask(s);
  }
  console.log(`[Scheduler] Scan schedules synced. ${allSchedules.length} active schedules loaded.`);
}

export async function removeSchedule(id: string): Promise<boolean> {
  stopScheduleTask(id);
  const deleted = await dbDeleteSchedule(id);
  if (deleted) {
    schedules.delete(id);
    jobStatuses.delete(id);
    console.log(`[Scheduler] Deleted schedule: ${id}`);
  }
  return deleted;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatScheduleDescription(schedule: ScheduleConfig): string {
  if (!schedule.enabled) {
    return 'Disabled';
  }

  const minute = schedule.minute.toString().padStart(2, '0');
  const ampm = schedule.hour >= 12 ? 'PM' : 'AM';
  const hour12 = schedule.hour % 12 || 12;
  const isWeekly = schedule.dayOfWeek >= 0 && schedule.dayOfWeek <= 6;
  const cadence = isWeekly ? `${DAY_NAMES[schedule.dayOfWeek]}s` : 'Daily';

  const typeLabel =
    schedule.scheduleType === 'forum-scan' ? 'Forum Scan' :
    schedule.scheduleType === 'daily-digest' ? 'Daily Digest' :
    'Scan Execution';

  if (schedule.frequencyHours && schedule.frequencyHours < 24) {
    return `Every ${schedule.frequencyHours}h at :${minute} (${schedule.timezone}) \u2014 ${typeLabel}`;
  }
  return `${cadence} at ${hour12}:${minute} ${ampm} (${schedule.timezone}) \u2014 ${typeLabel}`;
}

function buildCronExpression(schedule: ScheduleConfig): string {
  // Cron format: minute hour dayOfMonth month dayOfWeek
  // dayOfWeek: 0-6 for specific day, 7 means "every day" (wildcard)
  const dow = schedule.dayOfWeek >= 0 && schedule.dayOfWeek <= 6 ? schedule.dayOfWeek : '*';

  if (schedule.frequencyHours && schedule.frequencyHours < 24) {
    // Sub-daily: run every N hours at the configured minute
    return `${schedule.minute} */${schedule.frequencyHours} * * ${dow}`;
  }
  // Daily or weekly schedule
  return `${schedule.minute} ${schedule.hour} * * ${dow}`;
}

function createJobExecutor(schedule: ScheduleConfig) {
  const executor = async function executeScheduledJob(): Promise<void> {
    // Prevent overlapping execution
    if (executingJobs.has(schedule.id)) {
      console.log(`[Scheduler] Job "${schedule.name}" is already running, skipping overlapping execution`);
      return;
    }

    const jobStartTime = new Date();
    console.log(`[Scheduler] Starting job for "${schedule.name}" at ${jobStartTime.toISOString()}`);

    // Get fresh schedule data in case it was updated
    const currentScheduleData = schedules.get(schedule.id);
    if (!currentScheduleData) {
      console.log(`[Scheduler] Schedule ${schedule.id} no longer exists, skipping`);
      return;
    }

    executingJobs.add(schedule.id);
    const status: JobStatus = { lastRun: jobStartTime, status: null, error: null };
    jobStatuses.set(schedule.id, status);

    try {
      if (currentScheduleData.scheduleType === 'scan-execution') {
        // ---- Scan Execution Job ----
        const pool = getPool();
        const wireLabel = currentScheduleData.wire || 'all wires';
        console.log(`[Scheduler] Running scan execution for: ${wireLabel}`);

        const scanResult = await runScanExecution(pool, {
          wire: currentScheduleData.wire || undefined,
          config: {
            dedupeWindow: currentScheduleData.lookbackDays || 14,
          },
        });

        status.status = 'success';
        status.error = null;
        console.log(`[Scheduler] Scan "${currentScheduleData.name}" completed: ${scanResult.promptsExecuted} prompts, ${scanResult.totalResults} results, ${scanResult.intakeSummary.newUnique} unique`);

        // Per-scan email notifications are disabled.
        // A single daily digest is sent by the 'daily-digest' schedule type instead.

      } else if (currentScheduleData.scheduleType === 'forum-scan') {
        // ---- Forum Scan Job ----
        const pool = getPool();
        const wireLabel = currentScheduleData.wire || 'all wires';
        console.log(`[Scheduler] Running forum scan for: ${wireLabel}`);

        if (!config.forum.enabled) {
          console.warn(`[Scheduler] Forum scan skipped: FORUM_SCAN_ENABLED is not true`);
          status.status = 'success';
          status.error = null;
          return;
        }

        const forumResult = await runForumScan(pool, {
          wire: currentScheduleData.wire || undefined,
          lookbackDays: currentScheduleData.lookbackDays || 2,
        });

        status.status = 'success';
        status.error = null;
        console.log(`[Scheduler] Forum scan "${currentScheduleData.name}" completed: ${forumResult.totalResults} results (${forumResult.discussionsResults} discussions + ${forumResult.searchResults} search), ${forumResult.intakeSummary.newUnique} unique`);

      } else if (currentScheduleData.scheduleType === 'daily-digest') {
        // ---- Daily Digest Job ----
        const pool = getPool();
        console.log(`[Scheduler] Running daily digest...`);

        const digest = await runDailyDigest(pool);
        const topFinds = digest.totalPendingReview > 0 ? await getTopPendingFinds(pool, 5) : [];
        console.log(`[Scheduler] Daily digest: hasActivity=${digest.hasActivity}, newUnique=${digest.totalNewUnique}, pending=${digest.totalPendingReview}`);

        if (digest.hasActivity) {
          const dashboardUrl = config.app.url;
          const recipients = currentScheduleData.notifyEmails
            ? currentScheduleData.notifyEmails.split(',').map(e => e.trim()).filter(Boolean)
            : undefined;

          // Run CSV export first
          let csvResult: import('../jobs/csv-export').CsvExportResult | undefined;
          let downloadUrls: { csv: string | null; md: string | null } | undefined;
          try {
            csvResult = await runCsvExport(pool, 24);
            if (csvResult.entryCount > 0) {
              const email = config.email.notificationEmail;
              downloadUrls = {
                csv: csvResult.csvFileId ? createMagicLink(email, csvResult.csvFileId) : null,
                md: csvResult.mdFileId ? createMagicLink(email, csvResult.mdFileId) : null,
              };
              console.log(`[Scheduler] CSV export ready (${csvResult.entryCount} entries)`);
            } else {
              console.log(`[Scheduler] CSV export: no approved entries in last 24h`);
            }
          } catch (csvErr) {
            console.error(`[Scheduler] Failed to run CSV export:`, csvErr);
          }

          // Pull active experiment status
          let experimentStatus: { name: string; entriesScored: number; approvalRate: number; status: string } | null = null;
          try {
            const engine = new ExperimentEngine(pool);
            const activeExp = await engine.getActiveExperiment();
            if (activeExp) {
              const total = activeExp.approved_count + activeExp.declined_count;
              const approvalRate = total > 0 ? (activeExp.approved_count / total) * 100 : 0;
              experimentStatus = {
                name: activeExp.name,
                entriesScored: total,
                approvalRate,
                status: activeExp.status,
              };
            }
          } catch (expErr) {
            console.error(`[Scheduler] Failed to fetch experiment status:`, expErr);
          }

          // Send single consolidated email
          try {
            await sendDailyDigestEmail(digest, dashboardUrl, recipients, topFinds, csvResult, downloadUrls, experimentStatus);
            console.log(`[Scheduler] Daily digest email sent (${digest.totalNewUnique} new, ${csvResult?.entryCount ?? 0} approved)`);
          } catch (emailErr) {
            console.error(`[Scheduler] Failed to send daily digest email:`, emailErr);
          }
        } else {
          console.log(`[Scheduler] Daily digest: no activity today, skipping email`);
        }

        status.status = 'success';
        status.error = null;
        console.log(`[Scheduler] Daily digest completed`);

      } else {
        console.warn(`[Scheduler] Unsupported schedule type "${currentScheduleData.scheduleType}" — skipping`);
      }

      status.status = 'success';
      status.error = null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const isNoEntries = errorMsg.includes('No entries found');
      const isQuotaError = isQuotaExhaustedError(errorMsg);

      if (isNoEntries) {
        // "No entries found" is not a real failure — mark success, skip email and retry
        status.status = 'success';
        status.error = errorMsg;
        console.warn(`[Scheduler] Job "${schedule.name}" found nothing: ${errorMsg}`);
      } else {
        status.status = 'failed';
        status.error = errorMsg;
        console.error(`[Scheduler] Job "${schedule.name}" failed:`, error);

        // Send failure notification email (include schedule name for context)
        try {
          const recipients = currentScheduleData.notifyEmails
            ? currentScheduleData.notifyEmails.split(',').map(e => e.trim()).filter(Boolean)
            : undefined;
          await sendScheduledJobFailureEmail(`[${currentScheduleData.name}] ${errorMsg}`, jobStartTime, recipients);
          console.log(`[Scheduler] Failure notification email sent.`);
        } catch (emailError) {
          console.error(`[Scheduler] Failed to send failure notification:`, emailError);
        }

        // Retry once after 5 minutes for transient failures (skip on quota exhaustion)
        if (!status.retried && !isQuotaError) {
          status.retried = true;
          const scheduleId = schedule.id;
          console.log(`[Scheduler] Will retry "${schedule.name}" in 5 minutes...`);
          const retryTimer = setTimeout(() => {
            pendingRetryTimers.delete(scheduleId);
            // Skip if schedule was reconfigured (stopScheduleTask clears the task)
            if (!scheduledTasks.has(scheduleId)) {
              console.log(`[Scheduler] Skipping retry for "${schedule.name}" — schedule was reconfigured`);
              return;
            }
            console.log(`[Scheduler] Retrying "${schedule.name}"...`);
            executor();
          }, 5 * 60 * 1000);
          retryTimer.unref();
          pendingRetryTimers.set(scheduleId, retryTimer);
        } else if (isQuotaError) {
          console.warn(`[Scheduler] Skipping retry for "${schedule.name}" due to quota exhaustion`);
        }
      }
    } finally {
      executingJobs.delete(schedule.id);
    }
  };
  return executor;
}

function startScheduleTask(schedule: ScheduleConfig): void {
  if (!schedule.enabled) {
    return;
  }

  const cronExpression = buildCronExpression(schedule);

  console.log(`[Scheduler] Starting task for "${schedule.name}" with cron: ${cronExpression}`);

  const task = cron.schedule(cronExpression, createJobExecutor(schedule), {
    timezone: schedule.timezone,
  });

  task.start();
  scheduledTasks.set(schedule.id, task);
}

function stopScheduleTask(id: string): void {
  const task = scheduledTasks.get(id);
  if (task) {
    task.stop();
    scheduledTasks.delete(id);
    console.log(`[Scheduler] Stopped task for schedule ${id}`);
  }
  // Cancel any pending retry timer
  const retryTimer = pendingRetryTimers.get(id);
  if (retryTimer) {
    clearTimeout(retryTimer);
    pendingRetryTimers.delete(id);
    console.log(`[Scheduler] Cancelled pending retry for schedule ${id}`);
  }
}

export function startScheduler(): void {
  // Start all enabled schedules
  for (const schedule of schedules.values()) {
    if (schedule.enabled) {
      startScheduleTask(schedule);
    }
  }
  schedulerStartTime = new Date();
}

export function stopScheduler(): void {
  for (const [id, task] of scheduledTasks.entries()) {
    task.stop();
    console.log(`[Scheduler] Stopped task ${id}`);
  }
  scheduledTasks.clear();
  schedulerStartTime = null;
  console.log('[Scheduler] All schedulers stopped');
}

// Get the timezone offset in ms between UTC and a given IANA timezone
function getTimezoneOffsetMs(timezone: string, date: Date = new Date()): number {
  // Format the date in the target timezone to extract components
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
  const tzDate = new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')));
  return tzDate.getTime() - date.getTime();
}

export function getNextRunTime(scheduleId?: string): Date | null {
  const schedule = scheduleId ? schedules.get(scheduleId) : getSchedules().find(s => s.enabled);
  if (!schedule || !schedule.enabled) {
    return null;
  }

  const now = new Date();
  const tzOffset = getTimezoneOffsetMs(schedule.timezone, now);

  // Current time in the schedule's timezone (as UTC-based Date for arithmetic)
  const tzNow = new Date(now.getTime() + tzOffset);
  const next = new Date(tzNow);

  // Schedules in this codebase run daily or sub-daily.
  if (schedule.frequencyHours && schedule.frequencyHours < 24) {
    // Sub-daily: find next hour that matches */N pattern
    const freq = schedule.frequencyHours;
    const currentHour = tzNow.getUTCHours();
    const currentMin = tzNow.getUTCMinutes();

    // Find next matching hour (hours that are divisible by freq)
    let nextHour = currentHour;
    if (currentMin >= schedule.minute) {
      nextHour++;
    }
    // Round up to next multiple of freq
    nextHour = Math.ceil(nextHour / freq) * freq;
    if (nextHour >= 24) {
      next.setUTCDate(next.getUTCDate() + 1);
      nextHour = 0;
    }
    next.setUTCHours(nextHour, schedule.minute, 0, 0);
  } else {
    // Daily schedule -- next run is today or tomorrow at the scheduled time
    next.setUTCHours(schedule.hour, schedule.minute, 0, 0);
    if (next <= tzNow) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
  }

  // Convert back from timezone-local to real UTC time
  return new Date(next.getTime() - tzOffset);
}

export function isSchedulerRunning(): boolean {
  return scheduledTasks.size > 0;
}

export interface ScheduleStatus {
  id: string;
  name: string;
  isRunning: boolean;
  lastJobRun: string | null;
  lastJobStatus: 'success' | 'failed' | null;
  lastJobError: string | null;
  nextRun: string | null;
  cronExpression: string | null;
  description: string;
  config: ScheduleConfig;
}

export interface SchedulerStatus {
  isRunning: boolean;
  schedulerStartedAt: string | null;
  activeSchedules: number;
  totalSchedules: number;
  schedules: ScheduleStatus[];
}

export function getSchedulerStatus(): SchedulerStatus {
  const scheduleStatuses: ScheduleStatus[] = [];
  
  for (const schedule of schedules.values()) {
    const jobStatus = jobStatuses.get(schedule.id);
    scheduleStatuses.push({
      id: schedule.id,
      name: schedule.name,
      isRunning: scheduledTasks.has(schedule.id),
      lastJobRun: jobStatus?.lastRun?.toISOString() || null,
      lastJobStatus: jobStatus?.status || null,
      lastJobError: jobStatus?.error || null,
      nextRun: getNextRunTime(schedule.id)?.toISOString() || null,
      cronExpression: buildCronExpression(schedule),
      description: formatScheduleDescription(schedule),
      config: schedule,
    });
  }

  return {
    isRunning: scheduledTasks.size > 0,
    schedulerStartedAt: schedulerStartTime?.toISOString() || null,
    activeSchedules: scheduledTasks.size,
    totalSchedules: schedules.size,
    schedules: scheduleStatuses,
  };
}

// Send a test alert email to verify email configuration works
export async function sendTestAlert(): Promise<{ success: boolean; message: string }> {
  console.log(`[Scheduler] Sending test alert email...`);

  try {
    await sendTestAlertEmail();
    console.log(`[Scheduler] Test alert sent successfully`);
    return { success: true, message: 'Test alert email sent successfully! Check your inbox.' };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Scheduler] Test alert failed:`, errorMsg);
    return { success: false, message: `Failed to send test alert: ${errorMsg}` };
  }
}

// Initialize scheduler - loads config from database
export async function initScheduler(): Promise<void> {
  if (isInitialized) {
    console.log('[Scheduler] Already initialized, skipping');
    return;
  }

  try {
    // Ensure tables exist
    await ensureScheduleTable();
    console.log('[Scheduler] Schedule table ready');
    await ensureFeedsTable();
    console.log('[Scheduler] Feeds table ready');
    await ensureScanTables();
    console.log('[Scheduler] Scan pipeline tables ready');
    await ensureScanPromptsTable();
    console.log('[Scheduler] Scan prompts table ready');
    await ensureDistributionTables();
    console.log('[Scheduler] Distribution tables ready');
    // Load all schedules from database
    const savedSchedules = await getAllSchedules();

    if (savedSchedules.length > 0) {
      for (const schedule of savedSchedules) {
        schedules.set(schedule.id, schedule);
      }
      console.log(`[Scheduler] Loaded ${savedSchedules.length} schedule(s) from database`);
    } else {
      // No saved schedules - create a default one
      const defaultSchedule = await createSchedule(DEFAULT_SCHEDULE_TEMPLATE);
      schedules.set(defaultSchedule.id, defaultSchedule);
      console.log('[Scheduler] No saved schedules found, created default');
    }

    // Log all loaded schedules for observability
    console.log(`[Scheduler] Loaded ${schedules.size} schedules:`);
    for (const schedule of schedules.values()) {
      console.log(`  - ${schedule.name} [${schedule.scheduleType}] wire=${schedule.wire} enabled=${schedule.enabled} cron=${buildCronExpression(schedule)}`);
    }

    // Start all enabled schedules
    let enabledCount = 0;
    for (const schedule of schedules.values()) {
      if (schedule.enabled) {
        startScheduleTask(schedule);
        enabledCount++;
      }
    }

    schedulerStartTime = new Date();
    console.log(`[Scheduler] Started ${enabledCount} enabled schedule(s)`);

    isInitialized = true;
  } catch (error) {
    console.error('[Scheduler] Failed to initialize scheduler:', error);
    throw error;
  }
}
