import cron, { ScheduledTask } from 'node-cron';
import { runScanExecution } from '../jobs/scan-execution';
import { runForumScan } from '../jobs/forum-scan';
import { config } from '../config';
import { sendTestAlertEmail, sendScheduledJobFailureEmail, sendScanDigestEmail } from './email';
import { ensureScheduleTable, getAllSchedules, getScheduleById, createSchedule, updateSchedule, deleteSchedule as dbDeleteSchedule, StoredScheduleConfig, ensureFeedsTable, ensureScanTables, ensureScanPromptsTable, getPool } from '../db';

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
  scheduleType?: 'scan-execution' | 'forum-scan';
  frequencyHours?: number; // Sub-daily interval (1-23) for scan-execution
  notifyEmails?: string; // Comma-separated email recipients
}

// Default schedule template for new schedules
const DEFAULT_SCHEDULE_TEMPLATE: Omit<ScheduleConfig, 'id'> = {
  name: 'New Schedule',
  enabled: false,
  dayOfWeek: 3, // Wednesday
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
let schedulerStartTime: Date | null = null;

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

  console.log(`[Scheduler] Updated schedule: ${updated.name} (${id})`);
  return updated;
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

export function formatScheduleDescription(schedule: ScheduleConfig): string {
  if (!schedule.enabled) {
    return 'Disabled';
  }

  const hour = schedule.hour.toString().padStart(2, '0');
  const minute = schedule.minute.toString().padStart(2, '0');
  const ampm = schedule.hour >= 12 ? 'PM' : 'AM';
  const hour12 = schedule.hour % 12 || 12;

  if (schedule.scheduleType === 'scan-execution' || !schedule.scheduleType) {
    if (schedule.frequencyHours && schedule.frequencyHours < 24) {
      return `Every ${schedule.frequencyHours}h at :${minute} (${schedule.timezone}) \u2014 Scan Execution`;
    }
    return `Daily at ${hour12}:${minute} ${ampm} (${schedule.timezone}) \u2014 Scan Execution`;
  }

  if (schedule.scheduleType === 'forum-scan') {
    if (schedule.frequencyHours && schedule.frequencyHours < 24) {
      return `Every ${schedule.frequencyHours}h at :${minute} (${schedule.timezone}) \u2014 Forum Scan`;
    }
    return `Daily at ${hour12}:${minute} ${ampm} (${schedule.timezone}) \u2014 Forum Scan`;
  }

  return `Daily at ${hour12}:${minute} ${ampm} (${schedule.timezone}) \u2014 Scan Execution`;
}

function buildCronExpression(schedule: ScheduleConfig): string {
  // Cron format: minute hour dayOfMonth month dayOfWeek
  if (schedule.frequencyHours && schedule.frequencyHours < 24) {
    // Sub-daily: run every N hours at the configured minute
    return `${schedule.minute} */${schedule.frequencyHours} * * *`;
  }
  // Daily schedule
  return `${schedule.minute} ${schedule.hour} * * *`;
}

function createJobExecutor(schedule: ScheduleConfig) {
  const executor = async function executeScheduledJob(): Promise<void> {
    const jobStartTime = new Date();
    console.log(`[Scheduler] Starting job for "${schedule.name}" at ${jobStartTime.toISOString()}`);

    // Get fresh schedule data in case it was updated
    const currentScheduleData = schedules.get(schedule.id);
    if (!currentScheduleData) {
      console.log(`[Scheduler] Schedule ${schedule.id} no longer exists, skipping`);
      return;
    }

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
        });

        status.status = 'success';
        status.error = null;
        console.log(`[Scheduler] Scan "${currentScheduleData.name}" completed: ${scanResult.promptsExecuted} prompts, ${scanResult.totalResults} results, ${scanResult.intakeSummary.newUnique} unique`);

        // Send daily digest email
        if (scanResult.totalResults > 0) {
          try {
            const dashboardUrl = config.app.url;
            const recipients = currentScheduleData.notifyEmails
              ? currentScheduleData.notifyEmails.split(',').map(e => e.trim()).filter(Boolean)
              : undefined;
            await sendScanDigestEmail(scanResult, dashboardUrl, recipients);
            console.log(`[Scheduler] Scan digest email sent`);
          } catch (emailErr) {
            console.error(`[Scheduler] Failed to send digest email:`, emailErr);
            // Don't fail the job - email is non-critical
          }
        }

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
        });

        status.status = 'success';
        status.error = null;
        console.log(`[Scheduler] Forum scan "${currentScheduleData.name}" completed: ${forumResult.totalResults} results, ${forumResult.intakeSummary.newUnique} unique`);
      } else {
        console.warn(`[Scheduler] Unsupported schedule type "${currentScheduleData.scheduleType}" — skipping`);
      }

      status.status = 'success';
      status.error = null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const isNoEntries = errorMsg.includes('No entries found');

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

        // Retry once after 5 minutes for transient failures
        if (!status.retried) {
          status.retried = true;
          const scheduleId = schedule.id;
          console.log(`[Scheduler] Will retry "${schedule.name}" in 5 minutes...`);
          const retryTimer = setTimeout(() => {
            // Skip if schedule was reconfigured (stopScheduleTask clears the task)
            if (!scheduledTasks.has(scheduleId)) {
              console.log(`[Scheduler] Skipping retry for "${schedule.name}" — schedule was reconfigured`);
              return;
            }
            console.log(`[Scheduler] Retrying "${schedule.name}"...`);
            executor();
          }, 5 * 60 * 1000);
          retryTimer.unref();
        }
      }
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

export function getNextRunTime(scheduleId?: string): Date | null {
  const schedule = scheduleId ? schedules.get(scheduleId) : getSchedules().find(s => s.enabled);
  if (!schedule || !schedule.enabled) {
    return null;
  }

  const now = new Date();

  // Get current time in the schedule's timezone
  const tzNow = new Date(now.toLocaleString('en-US', { timeZone: schedule.timezone }));
  const tzOffset = tzNow.getTime() - now.getTime();

  // Calculate next run in timezone-local time
  const next = new Date(tzNow);

  if (schedule.frequencyHours && schedule.frequencyHours < 24) {
    // Sub-daily: find next hour that matches */N pattern
    const freq = schedule.frequencyHours;
    const currentHour = tzNow.getHours();
    const currentMin = tzNow.getMinutes();

    // Find next matching hour (hours that are divisible by freq)
    let nextHour = currentHour;
    if (currentMin >= schedule.minute) {
      nextHour++;
    }
    // Round up to next multiple of freq
    nextHour = Math.ceil(nextHour / freq) * freq;
    if (nextHour >= 24) {
      next.setDate(next.getDate() + 1);
      nextHour = 0;
    }
    next.setHours(nextHour, schedule.minute, 0, 0);
  } else {
    // Daily schedule -- next run is today or tomorrow at the scheduled time
    next.setHours(schedule.hour, schedule.minute, 0, 0);
    if (next <= tzNow) {
      next.setDate(next.getDate() + 1);
    }
  }

  // Convert back from timezone-local to real time
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
      cronExpression: schedule.enabled ? buildCronExpression(schedule) : null,
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
