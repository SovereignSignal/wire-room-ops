import fs from 'fs';
import path from 'path';
import { URL } from 'url';

const CONFIG_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(CONFIG_DIR, 'db-config.json');

interface DbConfigFile {
  databaseUrl: string;
  updatedAt: string;
}

export function getDbConfigUrl(): string | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const data: DbConfigFile = JSON.parse(raw);
    return data.databaseUrl || null;
  } catch {
    return null;
  }
}

export function saveDbConfig(databaseUrl: string): { success: boolean; source: string } {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const data: DbConfigFile = { databaseUrl, updatedAt: new Date().toISOString() };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8');
  return { success: true, source: 'config_file' };
}

export function getEffectiveDbUrl(): string | null {
  return getDbConfigUrl() || process.env.DATABASE_URL || null;
}

/** Production must not let the dashboard retarget the live database. */
export function isDatabaseUrlChangeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production';
}

export interface DbConfigMeta {
  configured: boolean;
  host: string | null;
  database: string | null;
  source: string;
  urlChangeAllowed: boolean;
}

export function getDbConfigMeta(): DbConfigMeta {
  const configFileUrl = getDbConfigUrl();
  const envUrl = process.env.DATABASE_URL || null;
  const effectiveUrl = configFileUrl || envUrl;
  const urlChangeAllowed = isDatabaseUrlChangeAllowed();

  if (!effectiveUrl) {
    return { configured: false, host: null, database: null, source: 'none', urlChangeAllowed };
  }

  try {
    const parsed = new URL(effectiveUrl);
    return {
      configured: true,
      host: parsed.hostname,
      database: parsed.pathname.replace(/^\//, '') || null,
      source: configFileUrl ? 'config_file' : 'env_var',
      urlChangeAllowed,
    };
  } catch {
    return {
      configured: true,
      host: null,
      database: null,
      source: configFileUrl ? 'config_file' : 'env_var',
      urlChangeAllowed,
    };
  }
}
