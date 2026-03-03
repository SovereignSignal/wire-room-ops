import { sharedHead, sharedBaseStyles, sharedCenteredPageStyles, config } from './shared';

export function renderLoginPage(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  ${sharedHead('Sign In')}
  <style>
    ${sharedBaseStyles()}
    ${sharedCenteredPageStyles()}
    .container { max-width: 400px; text-align: center; }
    .logo { margin: 0 0 8px; font-size: 28px; font-weight: 700; }
    .logo-grant { color: var(--accent); }
    .logo-wire { color: var(--text); }
    .subtitle { color: var(--text-secondary); margin-bottom: 32px; }
    .button { width: 100%; }
    .error {
      background: rgba(239, 68, 68, 0.15);
      color: var(--error);
      padding: 12px 16px;
      border-radius: var(--radius-lg);
      margin-bottom: 20px;
      font-size: 14px;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
  </style>
</head>
<body>
  <div id="privy-root"></div>
  <script type="importmap">
    {
      "imports": {
        "react": "https://esm.sh/react@18",
        "react-dom": "https://esm.sh/react-dom@18",
        "react-dom/client": "https://esm.sh/react-dom@18/client",
        "react/jsx-runtime": "https://esm.sh/react@18/jsx-runtime"
      }
    }
  </script>
  <script type="module">
    import React, { useState, useEffect } from 'react';
    import { createRoot } from 'https://esm.sh/react-dom@18/client?external=react';
    import { PrivyProvider, usePrivy } from 'https://esm.sh/@privy-io/react-auth@2?external=react,react-dom';

    function LoginApp() {
      const { login, authenticated, getAccessToken } = usePrivy();
      const [error, setError] = useState(null);
      const [authenticating, setAuthenticating] = useState(false);

      useEffect(() => {
        if (authenticated && !authenticating) {
          setAuthenticating(true);
          getAccessToken().then(token => {
            return fetch('/api/auth/callback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token }),
            });
          }).then(r => {
            if (!r.ok) {
              return r.json().catch(() => ({})).then(d => {
                throw new Error(d.error || 'Authentication failed (' + r.status + ')');
              });
            }
            return r.json();
          }).then(data => {
            if (data.ok) {
              const params = new URLSearchParams(window.location.search);
              const returnTo = params.get('returnTo');
              window.location.href = (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')) ? returnTo : '/queue';
            } else {
              setError(data.error || 'Authentication failed');
              setAuthenticating(false);
            }
          }).catch(err => {
            setError(err.message || 'Authentication failed. Please try again.');
            setAuthenticating(false);
          });
        }
      }, [authenticated]);

      return React.createElement('div', { className: 'container' },
        React.createElement('h1', { className: 'logo' },
          String.fromCodePoint(0x1F4E1), ' ',
          React.createElement('span', { className: 'logo-wire' }, 'Wire'),
          ' ',
          React.createElement('span', { className: 'logo-grant' }, 'Ops')
        ),
        React.createElement('p', { className: 'subtitle' }, 'Monitoring the Situation'),
        error ? React.createElement('div', { className: 'error' }, error) : null,
        authenticating
          ? React.createElement('p', { style: { color: 'var(--text-secondary)' } }, 'Signing in\u2026')
          : React.createElement('button', {
              className: 'button',
              onClick: login,
              style: { width: '100%' }
            }, 'Sign In')
      );
    }

    const root = createRoot(document.getElementById('privy-root'));
    root.render(
      React.createElement(PrivyProvider, {
        appId: ${JSON.stringify(config.privy.appId)},
        config: {
          loginMethods: ['email', 'wallet', 'google'],
          appearance: {
            theme: 'dark',
            accentColor: '#d4a017',
          },
        },
      }, React.createElement(LoginApp))
    );
  </script>
</body>
</html>
  `.trim();
}
