export interface JobProgress {
  current: number;
  total: number;
  step: string;
}

export interface JobStatus {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: JobProgress;
  result?: any;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
}

type JobStatusListener = (status: JobStatus) => void;

class JobQueue {
  private jobs: Map<string, JobStatus> = new Map();
  private listeners: Map<string, Set<JobStatusListener>> = new Map();
  private jobCounter = 0;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startPeriodicCleanup();
  }

  private startPeriodicCleanup(intervalMs: number = 15 * 60 * 1000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), intervalMs);
    this.cleanupTimer.unref();
  }

  stopPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  createJob(): string {
    const id = `job_${Date.now()}_${++this.jobCounter}`;
    const status: JobStatus = {
      id,
      status: 'pending',
      progress: { current: 0, total: 0, step: 'Initializing...' },
      startedAt: new Date(),
    };
    this.jobs.set(id, status);
    return id;
  }

  getJob(id: string): JobStatus | undefined {
    return this.jobs.get(id);
  }

  updateJob(id: string, updates: Partial<JobStatus>): void {
    const job = this.jobs.get(id);
    if (!job) return;

    Object.assign(job, updates);
    this.notifyListeners(id, job);
  }

  updateProgress(id: string, progress: JobProgress): void {
    const job = this.jobs.get(id);
    if (!job) return;

    job.progress = progress;
    this.notifyListeners(id, job);
  }

  completeJob(id: string, result: any): void {
    this.updateJob(id, {
      status: 'completed',
      result,
      completedAt: new Date(),
    });
  }

  failJob(id: string, error: string): void {
    this.updateJob(id, {
      status: 'failed',
      error,
      completedAt: new Date(),
    });
  }

  subscribe(id: string, listener: JobStatusListener): () => void {
    if (!this.listeners.has(id)) {
      this.listeners.set(id, new Set());
    }
    this.listeners.get(id)!.add(listener);

    // Immediately send current status
    const job = this.jobs.get(id);
    if (job) {
      listener(job);
    }

    // Return unsubscribe function
    return () => {
      this.listeners.get(id)?.delete(listener);
    };
  }

  private notifyListeners(id: string, status: JobStatus): void {
    const jobListeners = this.listeners.get(id);
    if (jobListeners) {
      jobListeners.forEach(listener => listener(status));
    }
  }

  // Clean up old jobs by age and cap
  cleanup(): void {
    const now = Date.now();
    const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
    const MAX_JOBS = 10;

    // Remove terminal jobs older than MAX_AGE
    for (const [id, job] of this.jobs.entries()) {
      const isTerminal = job.status === 'completed' || job.status === 'failed';
      const age = now - job.startedAt.getTime();
      if (isTerminal && age > MAX_AGE_MS) {
        this.jobs.delete(id);
        this.listeners.delete(id);
      }
    }

    // Enforce hard cap on remaining jobs
    if (this.jobs.size > MAX_JOBS) {
      const toRemove = Array.from(this.jobs.entries())
        .filter(([, job]) => job.status === 'completed' || job.status === 'failed')
        .sort(([, a], [, b]) => a.startedAt.getTime() - b.startedAt.getTime())
        .slice(0, this.jobs.size - MAX_JOBS);

      for (const [id] of toRemove) {
        this.jobs.delete(id);
        this.listeners.delete(id);
      }
    }

    // Clean up empty listener sets
    for (const [id, listeners] of this.listeners.entries()) {
      if (listeners.size === 0) {
        this.listeners.delete(id);
      }
    }
  }
}

export const jobQueue = new JobQueue();
