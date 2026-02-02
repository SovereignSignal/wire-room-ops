import cron, { ScheduledTask } from 'node-cron';
import { runWeeklySummaryJob } from '../jobs/weekly-summary';
import { config } from '../config';
import { sendNotificationEmail, sendTestAlertEmail, sendScheduledJobFailureEmail } from './email';
import { createMagicLink } from './auth';
import { ensureScheduleTable, getScheduleConfig, saveScheduleConfig, StoredScheduleConfig } from '../db';

export interface ScheduleConfig {
  enabled: boolean;
  dayOfWeek: number; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  hour: number; // 0-23
  minute: number; // 0-59
  lookbackDays: number; // How many days back to look
  grokModel?: string;
  anthropicModel?: string;
  timezone: string;
}

// Default schedule: Wednesday at 9:00 AM, look back 7 days
const DEFAULT_SCHEDULE: ScheduleConfig = {
  enabled: false,
  dayOfWeek: 3, // Wednesday
  hour: 9,
  minute: 0,
  lookbackDays: 7,
  timezone: 'America/Los_Angeles',
};

// In-memory cache of schedule config (loaded from DB on init)
let currentSchedule: ScheduleConfig = { ...DEFAULT_SCHEDULE };
let scheduledTask: ScheduledTask | null = null;
let isInitialized = false;

// Job execution tracking
let lastJobRun: Date | null = null;
let lastJobStatus: 'success' | 'failed' | null = null;
let lastJobError: string | null = null;
let schedulerStartTime: Date | null = null;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function getSchedule(): ScheduleConfig {
  return { ...currentSchedule };
}

export async function setSchedule(newSchedule: Partial<ScheduleConfig>): Promise<ScheduleConfig> {
  currentSchedule = { ...currentSchedule, ...newSchedule };

  // Persist to database
  await saveScheduleConfig(currentSchedule as StoredScheduleConfig);

  // Restart the scheduler with new config
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }

  if (currentSchedule.enabled) {
    startScheduler();
  }

  console.log(`[Scheduler] Schedule updated and persisted:`, formatScheduleDescription(currentSchedule));
  return { ...currentSchedule };
}

export function formatScheduleDescription(schedule: ScheduleConfig): string {
  if (!schedule.enabled) {
    return 'Disabled';
  }

  const day = DAY_NAMES[schedule.dayOfWeek];
  const hour = schedule.hour.toString().padStart(2, '0');
  const minute = schedule.minute.toString().padStart(2, '0');
  const ampm = schedule.hour >= 12 ? 'PM' : 'AM';
  const hour12 = schedule.hour % 12 || 12;

  return `Every ${day} at ${hour12}:${minute} ${ampm} (${schedule.timezone}), looking back ${schedule.lookbackDays} days`;
}

function buildCronExpression(schedule: ScheduleConfig): string {
  // Cron format: minute hour dayOfMonth month dayOfWeek
  return `${schedule.minute} ${schedule.hour} * * ${schedule.dayOfWeek}`;
}

async function executeScheduledJob(): Promise<void> {
  const jobStartTime = new Date();
  console.log(`[Scheduler] Starting scheduled job at ${jobStartTime.toISOString()}`);
  lastJobRun = jobStartTime;

  try {
    // Calculate date range based on lookback days
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - currentSchedule.lookbackDays);

    // Set to start/end of day
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);

    console.log(`[Scheduler] Date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);

    const result = await runWeeklySummaryJob({
      sendEmail: false,
      dateRange: { start: startDate, end: endDate },
      models: {
        grokModel: currentSchedule.grokModel,
        anthropicModel: currentSchedule.anthropicModel,
      },
    });

    // Send notification email with download link
    const downloadUrl = createMagicLink(config.email.notificationEmail, result.file.id);
    await sendNotificationEmail(downloadUrl, result.stats, result.dateRange);

    lastJobStatus = 'success';
    lastJobError = null;
    console.log(`[Scheduler] Job completed successfully. Email sent.`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    lastJobStatus = 'failed';
    lastJobError = errorMsg;
    console.error(`[Scheduler] Job failed:`, error);

    // Send failure notification email
    try {
      await sendScheduledJobFailureEmail(errorMsg, jobStartTime);
      console.log(`[Scheduler] Failure notification email sent.`);
    } catch (emailError) {
      console.error(`[Scheduler] Failed to send failure notification:`, emailError);
    }
  }
}

export function startScheduler(): void {
  if (!currentSchedule.enabled) {
    console.log('[Scheduler] Scheduler is disabled');
    return;
  }

  const cronExpression = buildCronExpression(currentSchedule);

  console.log(`[Scheduler] Starting scheduler with cron: ${cronExpression}`);
  console.log(`[Scheduler] ${formatScheduleDescription(currentSchedule)}`);

  scheduledTask = cron.schedule(cronExpression, executeScheduledJob, {
    timezone: currentSchedule.timezone,
  });

  scheduledTask.start();
  schedulerStartTime = new Date();
}

export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    schedulerStartTime = null;
    console.log('[Scheduler] Scheduler stopped');
  }
}

export function getNextRunTime(): Date | null {
  if (!currentSchedule.enabled) {
    return null;
  }

  const now = new Date();
  const next = new Date(now);

  // Find the next occurrence of the scheduled day/time
  const currentDay = now.getDay();
  const targetDay = currentSchedule.dayOfWeek;

  let daysUntilTarget = targetDay - currentDay;
  if (daysUntilTarget < 0) {
    daysUntilTarget += 7;
  }

  next.setDate(now.getDate() + daysUntilTarget);
  next.setHours(currentSchedule.hour, currentSchedule.minute, 0, 0);

  // If the time has already passed today and it's the target day, add 7 days
  if (next <= now) {
    next.setDate(next.getDate() + 7);
  }

  return next;
}

export function isSchedulerRunning(): boolean {
  return scheduledTask !== null;
}

export interface SchedulerStatus {
  isRunning: boolean;
  schedulerStartedAt: string | null;
  lastJobRun: string | null;
  lastJobStatus: 'success' | 'failed' | null;
  lastJobError: string | null;
  nextRun: string | null;
  cronExpression: string | null;
  config: ScheduleConfig;
}

export function getSchedulerStatus(): SchedulerStatus {
  return {
    isRunning: scheduledTask !== null,
    schedulerStartedAt: schedulerStartTime?.toISOString() || null,
    lastJobRun: lastJobRun?.toISOString() || null,
    lastJobStatus,
    lastJobError,
    nextRun: getNextRunTime()?.toISOString() || null,
    cronExpression: currentSchedule.enabled ? buildCronExpression(currentSchedule) : null,
    config: { ...currentSchedule },
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
    // Ensure the schedule table exists
    await ensureScheduleTable();
    console.log('[Scheduler] Schedule table ready');

    // Load saved config from database
    const savedConfig = await getScheduleConfig();

    if (savedConfig) {
      currentSchedule = savedConfig;
      console.log(`[Scheduler] Loaded schedule from database: ${formatScheduleDescription(currentSchedule)}`);
    } else {
      // No saved config - save the defaults
      await saveScheduleConfig(DEFAULT_SCHEDULE);
      console.log('[Scheduler] No saved schedule found, using defaults');
    }

    // Start the scheduler if enabled
    if (currentSchedule.enabled) {
      startScheduler();
      console.log(`[Scheduler] Scheduler started. Next run: ${getNextRunTime()?.toISOString() || 'N/A'}`);
    } else {
      console.log('[Scheduler] Scheduler is disabled');
    }

    isInitialized = true;
  } catch (error) {
    console.error('[Scheduler] Failed to initialize scheduler:', error);
    // Continue with defaults if database fails
    isInitialized = true;
  }
}
