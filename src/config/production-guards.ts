/**
 * Boot-time production safety checks. Kept as a pure helper so tests can
 * pin the DEV_MODE / Privy refusals without starting the server.
 */
export function assertProductionAuthSafety(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  if (env.DEV_MODE === 'true') {
    throw new Error('DEV_MODE=true is forbidden in production — it bypasses all dashboard auth.');
  }

  if (!env.PRIVY_APP_ID) {
    throw new Error('PRIVY_APP_ID is not set in production. Refusing to start without auth.');
  }
}
