import DataReviewFrame from '@/components/DataReviewFrame';

export const metadata = { title: 'Data Review · Anansi Admin' };

// The review app (Python serve.py) embedded via the same-origin /data-review-app/
// proxy (next.config.js). The iframe + offline fallback live in the client
// component; this stays a server component so it can export metadata.
export default function DataReviewPage() {
  return <DataReviewFrame />;
}
