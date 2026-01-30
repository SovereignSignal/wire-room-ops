import { JobResult } from '../jobs/weekly-summary';

export interface JobProgress {
  current: number;
  total: number;
  step: string;
}

export interface JobStatus {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: JobProgress;
  result?: JobResult;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
}

type JobStatusListener = (status: JobStatus) => void;

class JobQueue {
  private jobs: Map<string, JobStatus> = new Map();
  private listeners: Map<string, Set<JobStatusListener>> = new Map();
  private jobCounter = 0;

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

  completeJob(id: string, result: JobResult): void {
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

  // Clean up old jobs (keep last 10)
  cleanup(): void {
    const jobs = Array.from(this.jobs.entries());
    if (jobs.length > 10) {
      const toRemove = jobs
        .filter(([, job]) => job.status === 'completed' || job.status === 'failed')
        .slice(0, jobs.length - 10);

      toRemove.forEach(([id]) => {
        this.jobs.delete(id);
        this.listeners.delete(id);
      });
    }
  }
}

export const jobQueue = new JobQueue();
