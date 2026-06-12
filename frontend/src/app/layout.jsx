import './globals.css';
import Nav from '@/components/Nav';

export const metadata = {
  title: 'Anansi Admin',
  description: 'Internal operations dashboard',
};

// Set the theme attribute before first paint so there's no light/dark flash.
// Persisted under the same key the mockup used. Dark is the default.
const themeInit = `(function(){try{var t=localStorage.getItem('anansi-admin-theme')||'dark';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
