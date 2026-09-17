# Live Juggler

A Juggler Case can offer calibrated additions while investigation admission remains open. Each offer binds a finite work kind, opaque ball ID, supported quantity range, measured calibration summary and unit resource ceiling. The baseline is unchanged. The separate presealed additive allowance limits all receipts together; it cannot grant network permission, raise per-call limits, change obligations, select a candidate or choose a verdict. Sovereign Cases refuse the interface. Uncalibrated kinds have no offers.

```text
jevyr juggler CASE_ID
jevyr juggler CASE_ID --redeem Mass --quantity 2
jevyr watch CASE_ID
```

Use `--url URL` and `--json` as needed. Quantity defaults to one and must fit the current offer. The command sends exactly `{"ballId":"ball_...","quantity":2}`. It accepts no message, file, target, resource name or other semantic continuation. The five kinds add general effort (Mass), an unfamiliar permitted test family (Refraction), a counterbelief attempt (Polarity), an isolated lane (Fission), or a scent continuation (Inertia). These promises describe extra investigation work, not guaranteed findings.

```typescript
const offers = await client.metabolismOffers(caseId);
const mass = offers.offers.find(offer => offer.kind === "Mass");
if (mass) {
  const signed = await client.redeemMetabolism(caseId, mass.ballId, 1);
  console.log(signed.receipt.grant, signed.receipt.digest);
}
```

```python
offers = client.metabolism_offers(case_id)
mass = next((o for o in offers["offers"] if o["kind"] == "Mass"), None)
if mass:
    signed = client.redeem_metabolism(case_id, mass["ballId"], 1)
    print(signed["receipt"]["grant"], signed["receipt"]["digest"])
```

Both SDKs authenticate the Seal, rehash the exact policy, bind its separate metabolic allowance, verify every historical receipt's dedicated DSSE Ed25519 signature and predecessor, and independently enforce exact additive resource and measured-dose arithmetic. Each offered calibration summary is itself digest-bound in that allowance. Receipt history prevents a new client from trusting an unsigned cumulative counter. The metabolic signer is bound in policy and does not extend the three terminal public-trust payload types. The returned receipt contains `verdictAuthority: "none"` and `baselineUnchanged: true`.

No SDK automatically retries redemption. A concurrent addition between the read and POST may cause a predecessor verification failure even if the server committed this request: reread the signed history instead of retrying blindly. Admission closure and missing calibration remain explicit refusals. The historical fixed-token `jugglerOffers`/`redeemVoucher` methods remain only for old-server compatibility; current runtimes refuse their uncalibrated HTTP routes with 409 and never silently fall back.
