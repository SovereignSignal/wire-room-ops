/**
 * Credential masking utilities for API responses
 */

export function maskConfig(channel: string, cfg: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg)) {
    // Mask secret-looking keys
    if (['appSecret', 'accessSecret', 'accessToken', 'appKey'].includes(k)) {
      masked[k] = v ? '****' + v.slice(-4) : '';
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

export function maskCredentials(creds: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) {
    if (['bot_token', 'webhook_url', 'api_key'].includes(k) && v) {
      masked[k] = v.length > 8 ? '****' + v.slice(-4) : '****';
    } else {
      masked[k] = v;
    }
  }
  return masked;
}
