import { sharedHead, sharedBaseStyles, sharedCenteredPageStyles, config } from './shared';

export function renderLoginPage(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  ${sharedHead('Sign In')}
  <script>(function(){var t=localStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t)})()</script>
  <style>
    ${sharedBaseStyles()}
    ${sharedCenteredPageStyles()}
    :root[data-theme="light"] body { color-scheme: light; }
    .container { max-width: 400px; text-align: center; }
    .logo {
      margin: 0 0 6px;
      font-size: 26px;
      font-weight: 700;
      font-family: var(--font-display);
      letter-spacing: 0.1em;
    }
    .logo-wire { color: var(--text); }
    .logo-ops {
      color: var(--accent);
      text-shadow: 0 0 12px hsl(185, 100%, 50% / 0.7), 0 0 30px hsl(185, 100%, 50% / 0.3);
    }
    .subtitle {
      color: var(--text-muted);
      margin-bottom: 32px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-family: var(--font-mono);
    }
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
  <canvas id="starfield" style="position:fixed;inset:0;pointer-events:none;z-index:0;opacity:0.5;"></canvas>
  <div id="privy-root" style="position:relative;z-index:1;"></div>
  <script>
    (function() {
      var canvas = document.getElementById('starfield');
      var ctx = canvas.getContext('2d');
      var stars = [];
      function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        var n = Math.floor(canvas.width * canvas.height / 8000);
        stars = Array.from({ length: n }, function() {
          return { x: Math.random()*canvas.width, y: Math.random()*canvas.height,
            size: Math.random()*1.2+0.3, opacity: Math.random()*0.5+0.2,
            speed: Math.random()*0.015+0.004, tw: Math.random()*0.02+0.01,
            tp: Math.random()*Math.PI*2 };
        });
      }
      function frame(t) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        stars.forEach(function(s) {
          var op = s.opacity * (Math.sin(t*0.001*s.tw*30+s.tp)*0.3+0.7);
          var g = ctx.createRadialGradient(s.x,s.y,0,s.x,s.y,s.size*3);
          g.addColorStop(0,'rgba(120,220,255,'+op+')');
          g.addColorStop(0.5,'rgba(120,220,255,'+(op*0.3)+')');
          g.addColorStop(1,'rgba(120,220,255,0)');
          ctx.beginPath(); ctx.arc(s.x,s.y,s.size*3,0,Math.PI*2);
          ctx.fillStyle=g; ctx.fill();
          ctx.beginPath(); ctx.arc(s.x,s.y,s.size,0,Math.PI*2);
          ctx.fillStyle='rgba(200,240,255,'+op+')'; ctx.fill();
          s.y+=s.speed;
          if(s.y>canvas.height+10){s.y=-10;s.x=Math.random()*canvas.width;}
        });
        requestAnimationFrame(frame);
      }
      resize(); window.addEventListener('resize', resize); requestAnimationFrame(frame);
    })();
  </script>
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
          String.fromCodePoint(0x1F4E1), '\u00a0',
          React.createElement('span', { className: 'logo-wire' }, 'WIRE'),
          React.createElement('span', { className: 'logo-ops' }, 'OPS')
        ),
        React.createElement('p', { className: 'subtitle' }, 'Array Control Station'),
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
    var savedTheme = localStorage.getItem('theme');
    var privyTheme = savedTheme === 'light' ? 'light' : 'dark';
    root.render(
      React.createElement(PrivyProvider, {
        appId: ${JSON.stringify(config.privy.appId)},
        config: {
          loginMethods: ['email', 'wallet', 'google'],
          appearance: {
            theme: privyTheme,
            accentColor: savedTheme === 'light' ? '#0ea5a5' : '#00eaff',
          },
        },
      }, React.createElement(LoginApp))
    );
  </script>
</body>
</html>
  `.trim();
}
