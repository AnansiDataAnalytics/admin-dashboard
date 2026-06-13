'use client';
import { ClipLoader } from 'react-spinners';

// Single in-progress spinner for the whole app (replaces the hand-rolled CSS
// pulse). ClipLoader is a clean rotating arc; size/color tunable per use.
export default function Spinner({ size = 16, color = 'var(--blue)' }) {
  return (
    <span style={{ display: 'inline-flex', lineHeight: 0 }}>
      <ClipLoader size={size} color={color} cssOverride={{ borderWidth: 2 }} />
    </span>
  );
}
