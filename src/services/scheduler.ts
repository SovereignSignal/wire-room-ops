import cron, { ScheduledTask } from 'node-cron';
import { runWeeklySummaryJob } from '../jobs/weekly-summary';
import { config } from '../config';
import { sendNotificationEmail } from './email';
import { createMagicLink } from './auth';

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

// In-memory storage for schedule config
let currentSchedule: ScheduleConfig = { ...DEFAULT_SCHEDULE };
let scheduledTask: ScheduledTask | null = null;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function getSchedule(): ScheduleConfig {
  return { ...currentSchedule };
}

export function setSchedule(newSchedule: Partial<ScheduleConfig>): ScheduleConfig {
  currentSchedule = { ...currentSchedule, ...newSchedule };

  // Restart the scheduler with new config
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }

  if (currentSchedule.enabled) {
    startScheduler();
  }

  console.log(`[Scheduler] Schedule updated:`, formatScheduleDescription(currentSchedule));
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
  console.log(`[Scheduler] Starting scheduled job at ${new Date().toISOString()}`);

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

    console.log(`[Scheduler] Job completed successfully. Email sent.`);
  } catch (error) {
    console.error(`[Scheduler] Job failed:`, error);
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
}

export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
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

// Initialize scheduler on module load if enabled
export function initScheduler(): void {
  if (currentSchedule.enabled) {
    startScheduler();
  }
}
