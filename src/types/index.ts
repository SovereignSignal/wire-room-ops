export interface DatabaseEntry {
  id: string;
  url: string;
  quick_summary: string;
  category: string;
  timestamp: Date;
  source: string;
  wire?: string;
  title?: string;
  orgs?: string[];
}

export interface ProcessedEntry {
  id: string;
  url: string;
  originalSummary: string;
  category: string;
  timestamp: Date;
  source: string;
  wire?: string;
  enrichedSummary: string;
  processingMethod: 'grok' | 'ollama';
  processingError?: string;
}

export interface ProcessingStats {
  totalEntries: number;
  xcomEntries: number;
  otherEntries: number;
  successfulProcessing: number;
  failedProcessing: number;
  categories: string[];
  entriesByWire?: Record<string, number>;
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
