import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { getToken } from '../api';
import { IconAlert } from '../components/icons';

/**
 * Swagger UI embedded in the app.
 *
 * Loaded from a CDN rather than bundled: swagger-ui-dist is ~1.4 MB and is
 * only needed by administrators, so it stays out of the main bundle. The
 * OpenAPI document itself is fetched from the API at runtime.
 */

declare global {
  interface Window {
    SwaggerUIBundle?: (config: Record<string, unknown>) => unknown;
  }
}

const SWAGGER_CSS = 'https://unpkg.com/swagger-ui-dist@5/swagger-ui.css';
const SWAGGER_JS = 'https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js';

function loadCss(href: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`link[href="${href}"]`)) return resolve();
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Failed to load ${href}`));
    document.head.appendChild(link);
  });
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.SwaggerUIBundle) return resolve();
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(script);
  });
}

export function ApiDocsPage() {
  const { user } = useAuth();
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await Promise.all([loadCss(SWAGGER_CSS), loadScript(SWAGGER_JS)]);

        if (cancelled || !mountRef.current || !window.SwaggerUIBundle) return;

        // The spec is served by the API; in dev Vite proxies /api, but the
        // spec lives at /openapi.json which is not under /api.
        const res = await fetch('/openapi.json');
        if (!res.ok) throw new Error(`Could not load the API specification (${res.status})`);
        const spec = await res.json();

        mountRef.current.innerHTML = '';

        window.SwaggerUIBundle({
          spec,
          domNode: mountRef.current,
          deepLinking: true,
          docExpansion: 'list',
          defaultModelsExpandDepth: 0,
          displayRequestDuration: true,
          tryItOutEnabled: true,
          persistAuthorization: true,
          filter: true,
          // Pre-fill the bearer token so "Try it out" works without a copy-paste.
          requestInterceptor: (request: { headers: Record<string, string> }) => {
            const token = getToken();
            if (token && !request.headers.Authorization) {
              request.headers.Authorization = `Bearer ${token}`;
            }
            return request;
          },
        });

        if (!cancelled) setStatus('ready');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load the API documentation');
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const isAdmin = user && ['SUPER_ADMIN', 'ADMIN'].includes(user.role);

  return (
    <AppShell currentPath="/api-docs" title="API documentation">
      <div className="page-head">
        <div>
          <h2>API documentation</h2>
          <p>
            Every endpoint the application exposes, generated from the running API.
            Use <strong>Try it out</strong> to call an endpoint directly.
          </p>
        </div>
        <a
          className="btn btn-ghost"
          href="http://localhost:3001/swagger"
          target="_blank"
          rel="noreferrer"
        >
          Open raw Swagger
        </a>
      </div>

      {!isAdmin && (
        <div className="alert alert-error" role="alert">
          <IconAlert width={18} height={18} />
          <span>API documentation is restricted to administrators.</span>
        </div>
      )}

      {status === 'error' && (
        <div className="alert alert-error" role="alert">
          <IconAlert width={18} height={18} />
          <span>{error}</span>
        </div>
      )}

      {status === 'loading' && (
        <div className="panel">
          <div className="panel-body">
            <div style={{ padding: 24 }}>
              <div className="skeleton" style={{ height: 40, marginBottom: 12 }} />
              <div className="skeleton" style={{ height: 120 }} />
            </div>
          </div>
        </div>
      )}

      <div className={`swagger-host${status === 'ready' ? '' : ' swagger-hidden'}`} ref={mountRef} />
    </AppShell>
  );
}
