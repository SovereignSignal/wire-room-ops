export interface DatabaseEntry {
  id: string;
  url: string;
  quick_summary: string;
  category: string;
  timestamp: Date;
  source: string;
}

export interface ProcessedEntry {
  id: string;
  url: string;
  originalSummary: string;
  category: string;
  timestamp: Date;
  source: string;
  enrichedSummary: string;
  processingMethod: 'grok' | 'opus';
  processingError?: string;
}

export interface ProcessingStats {
  totalEntries: number;
  xcomEntries: number;
  otherEntries: number;
  successfulProcessing: number;
  failedProcessing: number;
  categories: string[];
}

export interface WeeklySummaryResult {
  markdown: string;
  stats: ProcessingStats;
  dateRange: {
    start: Date;
    end: Date;
  };
  generatedAt: Date;
}

export interface MagicLinkToken {
  token: string;
  email: string;
  fileId: string;
  expiresAt: Date;
  used: boolean;
}

export interface StoredFile {
  id: string;
  filename: string;
  content: string;
  createdAt: Date;
  dateRange: {
    start: Date;
    end: Date;
  };
}
