'use client';

import { useMemo, useState } from 'react';
import { JevyrClient } from '@jevyr/sdk';
import { GenomeLab } from '@/components/genome-lab';
import styles from '../airlock/surface.module.css';
import { defaultDaemonOrigin } from '@/lib/daemon-origin';

export default function GenomeLabPage() {
  const [address, setAddress] = useState(defaultDaemonOrigin);
  const [token, setToken] = useState('');
  const client = useMemo(() => new JevyrClient({ baseUrl: address, headers: token ? { authorization: `Bearer ${token}` } : {} }), [address, token]);
  return <main className={styles.airlock}>
    <header className={styles.header}><a href="/">← Chamber</a><span>JEVYR / GENOME LAB</span><a href="/airlock">Airlock</a></header>
    <details className={styles.connection}><summary>Daemon connection</summary><div className={styles.row}>
      <label>Address<input value={address} onChange={event => setAddress(event.target.value)} /></label>
      <label>Team access token<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} /><small>Held in this page’s memory only.</small></label>
    </div></details>
    <GenomeLab client={client} />
  </main>;
}
