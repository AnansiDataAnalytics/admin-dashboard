import Link from 'next/link';
import { Icon } from '@/components/Icon';

// Shared "planned service" placeholder so the full shape of the dashboard is
// visible from day one. Each planned nav entry routes here.
export default function StubPage({ icon = 'box', title, blurb }) {
  const CI = Icon[icon] || Icon.box;
  return (
    <main className="apage">
      <div className="stub">
        <div className="stub-inner">
          <div className="stub-ico"><CI size={26} /></div>
          <h1>{title}</h1>
          <p>{blurb}</p>
          <div className="stub-links">
            <Link className="btn btn-primary" href="/pipelines">Go to Pipelines</Link>
            <Link className="btn btn-ghost" href="/">Back home</Link>
          </div>
        </div>
      </div>
    </main>
  );
}
