'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

// Top global nav (ported from the mockup .anav). Live links: Home, Pipelines.
// Planned services render dimmed but still routable to their stub pages.
const LINKS = [
  { href: '/', label: 'Home', exact: true, ready: true },
  { href: '/pipelines', label: 'Pipelines', ready: true },
  { href: '/clients', label: 'Clients', ready: false },
  { href: '/data-review', label: 'Data Review', ready: true },
  { href: '/analytics', label: 'Analytics', ready: false },
];

function MoonIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 14.5A8 8 0 119.5 4 6.3 6.3 0 0020 14.5z" />
    </svg>
  );
}
function SunIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2v2.4M12 19.6V22M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2 12h2.4M19.6 12H22M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" />
    </svg>
  );
}

export default function Nav() {
  const path = usePathname();
  const [theme, setTheme] = useState('dark');

  useEffect(() => {
    setTheme(document.documentElement.getAttribute('data-theme') || 'dark');
  }, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('anansi-admin-theme', next); } catch {}
    setTheme(next);
  }

  const isActive = (l) => (l.exact ? path === l.href : path.startsWith(l.href));

  return (
    <nav className="anav">
      <div className="anav-inner">
        <Link className="anav-brand" href="/">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="anav-logo" src="/logo/logo.svg" alt="Anansi" />
          <span className="anav-word">ANANSI</span>
          <span className="anav-tag">Admin</span>
        </Link>
        <div className="anav-links">
          {LINKS.map((l) =>
            l.ready ? (
              <Link key={l.href} href={l.href} className={isActive(l) ? 'active' : ''}>
                {l.label}
              </Link>
            ) : (
              <Link key={l.href} href={l.href} className={`soon${isActive(l) ? ' active' : ''}`}>
                {l.label}
              </Link>
            ),
          )}
        </div>
        <div className="anav-right">
          <button className="theme-toggle" type="button" onClick={toggleTheme}
                  aria-label="Toggle theme">
            {theme === 'light' ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </div>
    </nav>
  );
}
