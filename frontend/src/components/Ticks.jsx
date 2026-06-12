// Ticks — the "last N releases" outcome strip used on the Home pipeline tile
// and the Pipelines card. Takes releases (newest-first) and renders oldest→newest,
// the final tick marked as latest.
import { stateOf } from '@/lib/format';

export default function Ticks({ releases, max = 12 }) {
  const recent = (releases || []).slice(0, max).reverse(); // oldest → newest
  const ok = recent.filter((r) => stateOf(r.status) !== 'failed').length;
  const failed = recent.length - ok;
  return (
    <div>
      <div className="ticks" aria-label={`Last ${recent.length} releases`}>
        {recent.map((r, i) => {
          const failedTick = stateOf(r.status) === 'failed';
          const latest = i === recent.length - 1;
          const cls = ['tick'];
          if (failedTick) cls.push('fail');
          else cls.push('ok');
          if (latest) cls.push('latest');
          return <span key={r.release_version || i} className={cls.join(' ')} title={`${r.release_version} · ${r.status}`} />;
        })}
      </div>
      <div className="ticks-label">
        Last {recent.length} releases · {ok} sealed{failed ? `, ${failed} failed` : ''}
      </div>
    </div>
  );
}
