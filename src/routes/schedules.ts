/**
 * Schedule & Digest Routes
 *
 * GET    /schedules          — list all schedules
 * POST   /schedules          — create a new schedule
 * PUT    /schedules/:id      — update a schedule
 * DELETE /schedules/:id      — delete a schedule
 * GET    /schedule           — get single schedule (legacy)
 * POST   /schedule           — update schedule (legacy POST compat)
 * POST   /digest/send-now    — send daily digest email on demand
 * POST   /test-alert         — send test alert email
 * GET    /scheduler-status   — get scheduler debug status
 */

import { Router, Request, Response } from 'express';
import { SCHEDULE_TYPES } from '../types/intake';
import { getPool } from '../db';
import { isValidUuid } from '../utils/validation';
import { getSchedule, getSchedules, setSchedule, addSchedule, removeSchedule, formatScheduleDescription, getNextRunTime, sendTestAlert, getSchedulerStatus, ScheduleConfig } from '../services/scheduler';

const router = Router();

/** Validate schedule numeric parameters. Returns error string or null. */
function validateScheduleParams(body: Record<string, any>): string | null {
  const { dayOfWeek, hour, minute, lookbackDays, scheduleType, frequencyHours, notifyEmails } = body;
  if (scheduleType && !(SCHEDULE_TYPES as readonly string[]).includes(scheduleType)) {
    return `scheduleType must be one of: ${SCHEDULE_TYPES.join(', ')}`;
  }
  if (typeof dayOfWeek === 'number' && (dayOfWeek < 0 || dayOfWeek > 7)) {
    return 'dayOfWeek must be between 0 (Sunday) and 6 (Saturday), or 7 for daily';
  }
  if (typeof hour === 'number' && (hour < 0 || hour > 23)) {
    return 'hour must be between 0 and 23';
  }
  if (typeof minute === 'number' && (minute < 0 || minute > 59)) {
    return 'minute must be between 0 and 59';
  }
  if (typeof lookbackDays === 'number' && (lookbackDays < 1 || lookbackDays > 365)) {
    return 'lookbackDays must be between 1 and 365';
  }
  if (typeof frequencyHours === 'number' && (frequencyHours < 1 || frequencyHours > 23)) {
    return 'frequencyHours must be between 1 and 23';
  }
  if (notifyEmails !== undefined && typeof notifyEmails !== 'string') {
    return 'notifyEmails must be a comma-separated string of email addresses';
  }
  return null;
}

// GET /schedules — list all schedules
router.get('/schedules', (req: Request, res: Response) => {
  const schedules = getSchedules().map(schedule => ({
    ...schedule,
    description: formatScheduleDescription(schedule),
    nextRun: getNextRunTime(schedule.id)?.toISOString() || null,
  }));

  res.json({ schedules });
});

// POST /schedules — create new schedule
router.post('/schedules', async (req: Request, res: Response) => {
  const validationError = validateScheduleParams(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const { name, enabled, dayOfWeek, hour, minute, lookbackDays, grokModel, anthropicModel, timezone, wire, scheduleType, frequencyHours, notifyEmails } = req.body;

  const scheduleData: Partial<Omit<ScheduleConfig, 'id'>> = {};

  if (name) scheduleData.name = name;
  if (scheduleType) scheduleData.scheduleType = scheduleType;
  if (typeof enabled === 'boolean') scheduleData.enabled = enabled;
  if (typeof dayOfWeek === 'number') scheduleData.dayOfWeek = dayOfWeek;
  if (typeof hour === 'number') scheduleData.hour = hour;
  if (typeof minute === 'number') scheduleData.minute = minute;
  if (typeof lookbackDays === 'number') scheduleData.lookbackDays = lookbackDays;
  if (grokModel) scheduleData.grokModel = grokModel;
  if (anthropicModel) scheduleData.anthropicModel = anthropicModel;
  if (timezone) scheduleData.timezone = timezone;
  if (wire !== undefined) scheduleData.wire = wire || undefined;
  if (typeof frequencyHours === 'number') scheduleData.frequencyHours = frequencyHours;
  if (notifyEmails !== undefined) scheduleData.notifyEmails = notifyEmails || undefined;

  try {
    const newSchedule = await addSchedule(scheduleData);
    const nextRun = getNextRunTime(newSchedule.id);
    const description = formatScheduleDescription(newSchedule);

    res.json({
      ...newSchedule,
      description,
      nextRun: nextRun?.toISOString() || null,
    });
  } catch (error) {
    console.error('Failed to create schedule:', error);
    res.status(500).json({ error: 'Failed to create schedule' });
  }
});

// PUT /schedules/:id — update schedule
router.put('/schedules/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid schedule ID' });
    return;
  }

  const validationError = validateScheduleParams(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const { name, enabled, dayOfWeek, hour, minute, lookbackDays, grokModel, anthropicModel, timezone, wire, scheduleType, frequencyHours, notifyEmails } = req.body;

  const updates: Partial<Omit<ScheduleConfig, 'id'>> = {};

  if (name !== undefined) updates.name = name;
  if (scheduleType !== undefined) updates.scheduleType = scheduleType;
  if (typeof enabled === 'boolean') updates.enabled = enabled;
  if (typeof dayOfWeek === 'number') updates.dayOfWeek = dayOfWeek;
  if (typeof hour === 'number') updates.hour = hour;
  if (typeof minute === 'number') updates.minute = minute;
  if (typeof lookbackDays === 'number') updates.lookbackDays = lookbackDays;
  if (grokModel !== undefined) updates.grokModel = grokModel || undefined;
  if (anthropicModel !== undefined) updates.anthropicModel = anthropicModel || undefined;
  if (timezone) updates.timezone = timezone;
  if (wire !== undefined) updates.wire = wire || undefined;
  if (frequencyHours !== undefined) updates.frequencyHours = typeof frequencyHours === 'number' ? frequencyHours : undefined;
  if (notifyEmails !== undefined) updates.notifyEmails = notifyEmails || undefined;

  try {
    const updatedSchedule = await setSchedule(id, updates);
    if (!updatedSchedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }

    const nextRun = getNextRunTime(updatedSchedule.id);
    const description = formatScheduleDescription(updatedSchedule);

    res.json({
      ...updatedSchedule,
      description,
      nextRun: nextRun?.toISOString() || null,
    });
  } catch (error) {
    console.error('Failed to update schedule:', error);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

// DELETE /schedules/:id — delete schedule
router.delete('/schedules/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid schedule ID' });
    return;
  }

  try {
    const deleted = await removeSchedule(id);
    if (!deleted) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete schedule:', error);
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
});

// POST /digest/send-now — send actual daily digest now (on-demand)
router.post('/digest/send-now', async (req: Request, res: Response) => {
  try {
    const pool = getPool();
    const { assembleAndSendDailyDigest } = await import('../jobs/daily-digest');

    // Get configured recipients from the daily-digest schedule
    const allSchedules = getSchedules();
    const digestSchedule = allSchedules.find(s => s.scheduleType === 'daily-digest');
    const recipients = digestSchedule?.notifyEmails
      ? digestSchedule.notifyEmails.split(',').map(e => e.trim()).filter(Boolean)
      : undefined;

    const summary = await assembleAndSendDailyDigest(pool, { recipients });
    res.json({
      success: true,
      message: `Digest sent to ${recipients?.join(', ') || 'default recipients'}`,
      stats: { date: summary.date, fresh: summary.freshCount, totalNew: summary.totalNew, issues: summary.issueCount },
    });
  } catch (error) {
    console.error('[DigestNow] Failed:', error);
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to send digest' });
  }
});

// POST /test-alert — send test alert to verify email configuration
router.post('/test-alert', async (req: Request, res: Response) => {

  try {
    const result = await sendTestAlert();
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(500).json({ success: false, error: result.message });
    }
  } catch (error) {
    console.error('Failed to send test alert:', error);
    res.status(500).json({ success: false, error: 'Failed to send test alert' });
  }
});

// GET /scheduler-status — scheduler debug status
router.get('/scheduler-status', (req: Request, res: Response) => {
  const status = getSchedulerStatus();
  res.json(status);
});

export { router as scheduleRouter };
