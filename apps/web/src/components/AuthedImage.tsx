import { useEffect, useState } from 'react';
import { getToken } from '../api';

/**
 * An image from an authenticated route, shown in an `<img>`.
 *
 * `<img>` cannot send an Authorization header, so the bytes are fetched once
 * with the session token and shown from a blob URL. The public page's banner
 * is unauthenticated and uses its URL directly; this is for the staff
 * preview, whose banner lives behind `GET /api/forms/:id/header/image`.
 */
export function AuthedImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setFailed(false);
    setObjectUrl(null);

    const token = getToken();
    void fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [src]);

  if (failed) return null;
  if (!objectUrl) return <div className={className} aria-hidden="true" />;
  return <img src={objectUrl} alt={alt} className={className} />;
}
