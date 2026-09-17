'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from './horizon.module.css';

// Exact sampling and equations from the sealed 543-byte prototype.
const frames = Array.from({ length: 121 }, (_, i) => {
  const t = i / 10;
  const left = Math.sin(t);
  const right = Math.sin(Math.sqrt(2) * t);
  return { t, left, right, gap: Math.abs(left - right) };
});

export default function HorizonPreview() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackStart, setPlaybackStart] = useState(0);
  useEffect(() => {
    if (!playing) return;
    let frameId: number;
    let start: number | undefined;
    const initial = playbackStart;
    const tick = (now: number) => {
      start ??= now;
      const next = Math.min(120, initial + Math.floor((now - start) / 100));
      setIndex(next);
      if (next < 120) frameId = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [playing, playbackStart]);
  const frame = frames[index]!;
  const position = (value: number) => 50 - value * 28;
  return (
    <main className={styles.preview}>
      <header className={styles.header}>
        <div>
          <p className={styles.label}>JEVYR / PROTOTYPE RENDER</p>
          <h1>A horizon briefly held in common</h1>
        </div>
        <Link href="/?case=case_f001da0279e93482">Back to the case ↗</Link>
      </header>
      <figure className={styles.field} aria-label={`Two horizontal lines at sample ${index + 1} of 121. Separation ${frame.gap.toFixed(4)} in normalized units.`}>
        <div className={styles.first} style={{ top: `${position(frame.left)}%` }} />
        <div className={styles.second} style={{ top: `${position(frame.right)}%` }} />
        <div className={styles.legend}><span>— First line</span><span>┄ Second line</span></div>
      </figure>
      <footer className={styles.footer}>
        <div className={styles.controls}>
          <button type="button" onClick={() => { const initial = index === 120 ? 0 : index; setIndex(initial); setPlaybackStart(initial); setPlaying(!playing); }}>
            {playing ? 'Pause' : index === 120 ? 'Replay' : 'Play'}
          </button>
          <label className={styles.timeline}>
            <span>Sample {index + 1} / 121</span>
            <input aria-label="Prototype sample" type="range" min="0" max="120" value={index} onChange={(event) => { setPlaying(false); setIndex(Number(event.target.value)); }} />
          </label>
          <output className={styles.readout}>t = {frame.t.toFixed(1)}<br />gap {frame.gap.toFixed(4)}</output>
        </div>
        <p className={styles.disclosure}>New visual preview of the saved calculation. Not the proposed glass installation; not a beauty measurement.</p>
        <details>
          <summary>What is being rendered</summary>
          <p>Two line heights: sin(t) and sin(√2 × t), sampled from t = 0 to 12 in steps of 0.1. Playback shows ten samples per second. The parameter t has no declared physical unit.</p>
          <p>The original prototype prints these 121 samples as JSON. This page adds only the display and playback controls. It does not modify or rerun the sealed case.</p>
          <code>Source SHA-256: aa83587c3f42ac0f99314b6f2106537a7c73be324bf114a7ea117d078c648d16</code>
        </details>
      </footer>
    </main>
  );
}
