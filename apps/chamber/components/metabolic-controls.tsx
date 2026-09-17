'use client';
import { useEffect, useState } from 'react';
import { JevyrClient, JevyrHttpError } from '@jevyr/sdk';

type Offers = Awaited<ReturnType<JevyrClient['metabolismOffers']>>;
export function MetabolicControls({ client, caseId }: { client: JevyrClient; caseId: string }) {
  const [offers, setOffers] = useState<Offers>();
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [closed, setClosed] = useState(false);
  const [pending, setPending] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    setOffers(undefined); setQuantities({}); setError(''); setClosed(false); setPending(undefined);
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await client.metabolismOffers(caseId, controller.signal);
        if (controller.signal.aborted) return;
        setOffers(next); setClosed(next.admission === 'closed');
        if (next.admission === 'open') timer = setTimeout(() => { void read(); }, 4000);
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof JevyrHttpError && failure.status === 409) setClosed(true);
        else setError(failure instanceof Error ? failure.message : 'Additions could not be verified');
      }
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, caseId]);
  async function redeem(ballId: string) {
    setPending(ballId); setError('');
    try {
      await client.redeemMetabolism(caseId, ballId, quantities[ballId] ?? 1);
      setOffers(await client.metabolismOffers(caseId));
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'This addition is no longer available'); }
    finally { setPending(undefined); }
  }
  return <section aria-label="Juggler additions" style={{ borderTop: '1px solid var(--line)', marginTop: 24, paddingTop: 8 }}>
    <h3>Juggler</h3><p>Fund additional investigation. The original workload and judgment rules stay fixed.</p>
    {closed ? <p>Admission has closed.</p> : !offers ? <p aria-busy="true">Checking calibrated additions…</p> : offers.offers.length === 0 ? <p>No calibrated additions are available for this run.</p> : offers.offers.map((offer) => <article key={offer.ballId} style={{ borderTop: '1px solid var(--line)', padding: '16px 0' }}>
      <h4 style={{ margin: '0 0 8px' }}>{offer.kind}</h4><p>{offer.promisedEffect}</p>
      <p style={{ fontSize: 14, color: 'var(--muted)' }}>Per unit: ≤{offer.unitCostCeiling.maxMindInvocations} calls · ≤{offer.unitCostCeiling.maxOutputTokens.toLocaleString()} output tokens · ≤{Math.ceil(offer.unitCostCeiling.maxWallMillis / 1000)} seconds</p>
      <details><summary>Calibration · {offer.calibration.pairedSeeds} paired seeds</summary>
        <p>{offer.calibration.scope}</p>
        <p>Recall difference, 95% interval: {(offer.calibration.recallDifference.lower * 100).toFixed(1)} to {(offer.calibration.recallDifference.upper * 100).toFixed(1)} percentage points.</p>
        <p>Reproducibility difference, 95% interval: {(offer.calibration.reproducibilityDifference.lower * 100).toFixed(1)} to {(offer.calibration.reproducibilityDifference.upper * 100).toFixed(1)} percentage points.</p>
        <p>Doses measured: {offer.calibration.doses.join(', ')}. The identical-evidence judgment check passed.</p>
      </details>
      <label>Quantity<input aria-label={`${offer.kind} quantity`} type="number" min={1} max={offer.maxQuantity} step={1} value={quantities[offer.ballId] ?? 1} onChange={(event) => setQuantities((previous) => ({ ...previous, [offer.ballId]: Number(event.target.value) }))} /></label>
      <button disabled={Boolean(pending) || !Number.isInteger(quantities[offer.ballId] ?? 1) || (quantities[offer.ballId] ?? 1) < 1 || (quantities[offer.ballId] ?? 1) > offer.maxQuantity} onClick={() => void redeem(offer.ballId)}>{pending === offer.ballId ? 'Committing addition…' : `Add ${offer.kind}`}</button>
    </article>)}
    {offers && offers.receipts.length > 0 && <details><summary>{offers.receipts.length} signed additions</summary><ol>{offers.receipts.map(({ receipt }) => <li key={receipt.digest}>{receipt.sequence}. {receipt.kind} × {receipt.quantity} · {receipt.issuedAt}</li>)}</ol></details>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
