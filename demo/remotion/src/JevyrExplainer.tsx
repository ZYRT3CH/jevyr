import React from 'react';
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export type JevyrExplainerProps = {
  title: string;
  subtitle: string;
};

const colors = {
  black: '#07090b',
  panel: '#101419',
  panelBright: '#171e24',
  line: '#33414a',
  bone: '#f3f0e8',
  muted: '#8f9ca5',
  blue: '#a8d6e8',
  orange: '#ff765b',
  red: '#cf4d4d',
  green: '#a9dbc1',
};

const stages = [
  ['01', 'SEAL'],
  ['02', 'INTERPRET'],
  ['03', 'CREATE'],
  ['04', 'EXECUTE'],
  ['05', 'JUDGE'],
  ['06', 'CLOSE'],
] as const;

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const reveal = (frame: number, start: number, duration = 36) =>
  interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

const pulse = (frame: number, speed = 0.08) => 0.5 + Math.sin(frame * speed) * 0.5;

const FramePanel: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({
  children,
  style,
}) => (
  <div
    style={{
      border: '1px solid ' + colors.line,
      background: colors.panel,
      ...style,
    }}
  >
    {children}
  </div>
);

const MarkLogo: React.FC<{ size?: number; opacity?: number; glow?: boolean }> = ({
  size = 64,
  opacity = 1,
  glow = false,
}) => (
  <Img
    src={staticFile('jevyr-mark.svg')}
    style={{
      width: size,
      height: size,
      opacity,
      filter: glow ? 'drop-shadow(0 0 22px rgba(255,118,91,.38))' : undefined,
    }}
  />
);

const Brand: React.FC<{ small?: boolean }> = ({ small = false }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: small ? 14 : 20 }}>
    <MarkLogo size={small ? 38 : 68} />
    <div
      style={{
        color: colors.bone,
        fontFamily: 'Arial, sans-serif',
        fontSize: small ? 24 : 44,
        fontWeight: 700,
        letterSpacing: small ? 5 : 9,
      }}
    >
      JEVYR<span style={{ color: colors.orange }}> /</span>
    </div>
  </div>
);

const Grain: React.FC = () => (
  <AbsoluteFill
    style={{
      pointerEvents: 'none',
      opacity: 0.18,
      backgroundImage:
        'radial-gradient(circle at 20% 30%, rgba(168,214,232,.18) 0 1px, transparent 1px), radial-gradient(circle at 70% 70%, rgba(255,118,91,.14) 0 1px, transparent 1px)',
      backgroundSize: '37px 41px, 53px 47px',
      mixBlendMode: 'screen',
    }}
  />
);

const Rail: React.FC<{ label: string; right?: string }> = ({
  label,
  right = 'LOCAL-FIRST / EXPERIMENT',
}) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      color: colors.muted,
      fontFamily: 'monospace',
      fontSize: 16,
      letterSpacing: 2,
    }}
  >
    <span>{label}</span>
    <span style={{ color: colors.blue }}>{right}</span>
  </div>
);

const StageRail: React.FC<{ active: number }> = ({ active }) => (
  <div style={{ display: 'flex', gap: 8, width: '100%' }}>
    {stages.map(([number, label], index) => (
      <div
        key={number}
        style={{
          flex: 1,
          padding: '14px 14px 12px',
          borderTop: '2px solid ' + (index <= active ? colors.orange : colors.line),
          color: index <= active ? colors.bone : colors.muted,
          fontFamily: 'monospace',
          fontSize: 14,
          letterSpacing: 1,
        }}
      >
        <span style={{ color: colors.orange }}>{number}</span> {label}
      </div>
    ))}
  </div>
);

const OrbitWorld: React.FC<{
  frame: number;
  width?: number;
  height?: number;
  failed?: boolean;
  dense?: boolean;
}> = ({ frame, width = 620, height = 520, failed = false, dense = true }) => {
  const points = Array.from({ length: dense ? 24 : 15 }, (_, index) => {
    const count = dense ? 24 : 15;
    const angle = (index / count) * Math.PI * 2;
    const radius = 164 + Math.sin(index * 2.31) * 32;
    const drift = frame * (0.006 + (index % 3) * 0.001);
    return {
      x: 310 + Math.cos(angle + drift) * radius,
      y: 252 + Math.sin(angle + drift) * radius * 0.64,
      r: index % 5 === 0 ? 8 : index % 2 === 0 ? 4 : 3,
    };
  });
  const energy = 0.72 + pulse(frame, 0.045) * 0.28;
  return (
    <div style={{ position: 'relative', width, height }}>
      <svg width={width} height={height} viewBox="0 0 620 520">
        <g transform={'rotate(' + frame * 0.18 + ' 310 252)'} fill="none">
          <circle cx="310" cy="252" r="208" stroke={failed ? colors.red : colors.bone} strokeWidth="2.4" strokeOpacity=".8" />
          <path
            d="M148 253c22-111 115-177 220-160 102 16 157 93 132 175-27 87-137 130-234 121-82-8-134-61-118-136Z"
            stroke={colors.blue}
            strokeWidth="1.7"
            strokeOpacity=".62"
          />
          <circle cx="310" cy="252" r="80" stroke={colors.bone} strokeWidth="2" strokeOpacity=".78" />
          <path d="M94 252h432M310 44v416" stroke={colors.line} strokeWidth="1" strokeOpacity=".58" />
          {points.map((point, index) => (
            <g key={index} opacity={clamp((frame / 420) * 1.6 - index / points.length)}>
              {index % 4 === 0 ? (
                <path d={'M310 252L' + point.x + ' ' + point.y} stroke={colors.line} strokeWidth="1" />
              ) : null}
              <circle
                cx={point.x}
                cy={point.y}
                r={point.r}
                fill={failed ? colors.red : colors.orange}
                fillOpacity={0.55 + (index % 3) * 0.14}
              />
            </g>
          ))}
        </g>
        <circle cx="310" cy="252" r={42 + energy * 18} fill="none" stroke={failed ? colors.red : colors.orange} strokeOpacity=".65" strokeWidth="2" />
        <circle cx="310" cy="252" r="13" fill={failed ? colors.red : colors.orange} />
      </svg>
      <div
        style={{
          position: 'absolute',
          left: 28,
          bottom: 20,
          color: colors.muted,
          fontFamily: 'monospace',
          fontSize: 14,
          letterSpacing: 2,
        }}
      >
        {failed ? 'CANDIDATE RETAINED AS FAILURE' : 'DISPOSABLE EXPERIMENTAL WORLD'}
      </div>
    </div>
  );
};

const HashLine: React.FC<{ frame: number; index: number; text: string; tone?: string }> = ({
  frame,
  index,
  text,
  tone = colors.blue,
}) => {
  const shown = reveal(frame, 80 + index * 38, 24);
  const digest = 'sha256:' + ['7a9d', 'e1b4', 'c38f', '0d72', '9f21'][index % 5] + '…' + ['c41e', '7f09', 'a6d2', '104b', '8e70'][index % 5];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '70px 1fr 230px',
        gap: 18,
        alignItems: 'center',
        borderTop: '1px solid ' + colors.line,
        padding: '18px 0',
        opacity: shown,
        transform: 'translateX(' + (1 - shown) * 24 + 'px)',
      }}
    >
      <span style={{ color: colors.orange, fontFamily: 'monospace' }}>{String(index + 1).padStart(2, '0')}</span>
      <span style={{ color: colors.bone }}>{text}</span>
      <span style={{ color: tone, fontFamily: 'monospace', fontSize: 13, textAlign: 'right' }}>{digest}</span>
    </div>
  );
};

const ColdOpen: React.FC<JevyrExplainerProps> = ({ title, subtitle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const beat = pulse(frame, 0.055);
  return (
    <AbsoluteFill style={{ background: colors.black, color: colors.bone, padding: 86 }}>
      <Grain />
      <Brand />
      <div
        style={{
          position: 'absolute',
          top: 300,
          left: 86,
          width: 1020,
          opacity: enter,
          transform: 'translateY(' + (1 - enter) * 50 + 'px)',
        }}
      >
        <div style={{ color: colors.orange, fontFamily: 'monospace', fontSize: 20, letterSpacing: 3 }}>
          THE PROBLEM WITH “LOOKS RIGHT”
        </div>
        <div style={{ fontFamily: 'Arial, sans-serif', fontSize: 86, lineHeight: 1.02, marginTop: 22, letterSpacing: -3 }}>
          Your model can be brilliant.
          <br />
          It can still be wrong.
        </div>
        <div style={{ color: colors.blue, fontFamily: 'Arial, sans-serif', fontSize: 30, marginTop: 38, maxWidth: 760, lineHeight: 1.35 }}>
          {subtitle}
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          right: 150,
          top: 295,
          width: 270,
          height: 270,
          border: '1px solid ' + colors.line,
          borderRadius: '50%',
          opacity: 0.35 + beat * 0.3,
          transform: 'scale(' + (0.92 + beat * 0.08) + ')',
        }}
      />
      <div style={{ position: 'absolute', right: 212, top: 360, opacity: 0.95 }}>
        <MarkLogo size={146} glow />
      </div>
      <FramePanel
        style={{
          position: 'absolute',
          right: 86,
          bottom: 110,
          width: 470,
          padding: 24,
          background: 'rgba(16,20,25,.84)',
          transform: 'rotate(-3deg)',
        }}
      >
        <div style={{ color: colors.muted, fontFamily: 'monospace', fontSize: 14 }}>MODEL OUTPUT / 00:01</div>
        <div style={{ color: colors.bone, fontSize: 25, marginTop: 10 }}>“This should work.”</div>
        <div style={{ color: colors.red, fontFamily: 'monospace', fontSize: 15, marginTop: 18 }}>CONFIDENCE IS NOT EVIDENCE</div>
      </FramePanel>
      <div style={{ position: 'absolute', bottom: 52, left: 86, color: colors.muted, fontFamily: 'monospace', fontSize: 17, letterSpacing: 2 }}>
        WHAT IF THE MODEL WAS NOT THE JUDGE?
      </div>
      <div style={{ position: 'absolute', right: 86, bottom: 52, color: colors.muted, fontFamily: 'monospace', fontSize: 15 }}>
        {title.toUpperCase()} / OPEN-SOURCE EXPERIMENT
      </div>
    </AbsoluteFill>
  );
};

const ModelIsNotJudge: React.FC = () => {
  const frame = useCurrentFrame();
  const left = reveal(frame, 20);
  const right = reveal(frame, 115);
  const stamp = reveal(frame, 270, 45);
  return (
    <AbsoluteFill style={{ background: colors.black, color: colors.bone, padding: 74 }}>
      <Grain />
      <Rail label="01 / THE SEPARATION" right="GENERATION ≠ JUDGMENT" />
      <div style={{ marginTop: 120, display: 'flex', gap: 28, alignItems: 'stretch' }}>
        <FramePanel style={{ flex: 1, padding: 44, opacity: left, transform: 'translateX(' + (1 - left) * -50 + 'px)' }}>
          <div style={{ color: colors.orange, fontFamily: 'monospace', fontSize: 18 }}>THE MODEL</div>
          <div style={{ fontSize: 54, marginTop: 30, lineHeight: 1.05 }}>Makes claims.</div>
          <div style={{ color: colors.muted, fontSize: 24, marginTop: 28, lineHeight: 1.45 }}>
            It can imagine, explain, draft, predict, and propose.
          </div>
          <div style={{ marginTop: 80, color: colors.blue, fontFamily: 'monospace', fontSize: 17 }}>GOOD AT POSSIBILITY</div>
        </FramePanel>
        <div style={{ alignSelf: 'center', color: colors.orange, fontFamily: 'monospace', fontSize: 28 }}>≠</div>
        <FramePanel style={{ flex: 1, padding: 44, opacity: right, transform: 'translateX(' + (1 - right) * 50 + 'px)', background: colors.panelBright }}>
          <div style={{ color: colors.blue, fontFamily: 'monospace', fontSize: 18 }}>THE JUDGE</div>
          <div style={{ fontSize: 54, marginTop: 30, lineHeight: 1.05 }}>Checks claims.</div>
          <div style={{ color: colors.muted, fontSize: 24, marginTop: 28, lineHeight: 1.45 }}>
            It asks what was sealed, what was tested, and what the evidence can actually support.
          </div>
          <div style={{ marginTop: 52, color: colors.orange, fontFamily: 'monospace', fontSize: 17 }}>GOOD AT BOUNDARIES</div>
        </FramePanel>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 330,
          right: 330,
          bottom: 126,
          padding: '24px 34px',
          border: '1px solid ' + colors.orange,
          color: colors.bone,
          fontFamily: 'monospace',
          fontSize: 24,
          textAlign: 'center',
          opacity: stamp,
          transform: 'scale(' + (0.96 + stamp * 0.04) + ')',
        }}
      >
        MODELS MAY MAKE CLAIMS. EVIDENCE MUST DECIDE.
      </div>
    </AbsoluteFill>
  );
};

const Airlock: React.FC = () => {
  const frame = useCurrentFrame();
  const entered = reveal(frame, 30);
  const seal = reveal(frame, 410, 50);
  const spin = frame * 0.7;
  return (
    <AbsoluteFill style={{ background: colors.black, color: colors.bone, padding: 74 }}>
      <Grain />
      <Rail label="02 / THE AIRLOCK" right="ONE INPUT / NO QUIET STEERING" />
      <div style={{ display: 'flex', gap: 64, marginTop: 88, alignItems: 'center' }}>
        <div style={{ width: 790, opacity: entered, transform: 'translateY(' + (1 - entered) * 35 + 'px)' }}>
          <div style={{ color: colors.muted, fontFamily: 'monospace', fontSize: 18, letterSpacing: 2 }}>THE REQUEST</div>
          <div style={{ fontSize: 58, lineHeight: 1.08, marginTop: 30 }}>
            Design a self-validating
            <br />
            machine that refuses
            <br />
            inherited answers.
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 52 }}>
            {['TASK', 'SUBJECTS', 'PRIVACY', 'EVIDENCE RULES'].map((label, index) => (
              <div key={label} style={{ border: '1px solid ' + colors.line, padding: '11px 14px', color: index === 3 ? colors.orange : colors.blue, fontFamily: 'monospace', fontSize: 13 }}>
                {label}
              </div>
            ))}
          </div>
          <div style={{ color: colors.muted, fontSize: 21, marginTop: 52, lineHeight: 1.45 }}>
            Before any Mind speaks, the question becomes a Case. After Seal, the Case cannot be nudged from the outside.
          </div>
        </div>
        <div style={{ position: 'relative', width: 430, height: 430, opacity: seal }}>
          <div style={{ position: 'absolute', inset: 0, border: '1px solid ' + colors.line, borderRadius: '50%', transform: 'rotate(' + spin + 'deg)' }} />
          <div style={{ position: 'absolute', inset: 38, border: '1px solid ' + colors.blue, borderRadius: '50%', opacity: 0.7, transform: 'rotate(' + (-spin * 1.4) + 'deg)' }} />
          <div style={{ position: 'absolute', inset: 112, border: '2px solid ' + colors.bone, borderRadius: '50%', opacity: 0.8 }} />
          <div style={{ position: 'absolute', left: 187, top: 187, width: 56, height: 56, border: '2px solid ' + colors.orange, borderRadius: '50%', background: colors.black, boxShadow: '0 0 40px rgba(255,118,91,.35)' }} />
          <div style={{ position: 'absolute', left: 209, top: 209, width: 14, height: 14, borderRadius: '50%', background: colors.orange }} />
          <div style={{ position: 'absolute', left: 145, bottom: -4, color: colors.orange, fontFamily: 'monospace', fontSize: 17, letterSpacing: 3 }}>SEALED CASE</div>
        </div>
      </div>
      <div style={{ position: 'absolute', left: 74, right: 74, bottom: 64, borderTop: '1px solid ' + colors.line, paddingTop: 19, display: 'flex', justifyContent: 'space-between', color: colors.muted, fontFamily: 'monospace', fontSize: 15 }}>
        <span>INGRESS: OPEN → CLOSED</span>
        <span style={{ color: colors.orange }}>WATCHING DOES NOT STEER IT</span>
      </div>
    </AbsoluteFill>
  );
};

const CandidateCard: React.FC<{
  title: string;
  status: string;
  tone: string;
  x: number;
  y: number;
  opacity: number;
  rotate?: number;
}> = ({ title, status, tone, x, y, opacity, rotate = 0 }) => (
  <FramePanel
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: 355,
      padding: 24,
      opacity,
      transform: 'rotate(' + rotate + 'deg)',
      borderTop: '3px solid ' + tone,
      boxShadow: '0 20px 50px rgba(0,0,0,.24)',
    }}
  >
    <div style={{ color: tone, fontFamily: 'monospace', fontSize: 15 }}>{status}</div>
    <div style={{ color: colors.bone, fontSize: 26, lineHeight: 1.2, marginTop: 14 }}>{title}</div>
    <div style={{ color: colors.muted, fontFamily: 'monospace', fontSize: 13, marginTop: 25 }}>PROPOSAL / NOT YET PROOF</div>
  </FramePanel>
);

const Divergence: React.FC = () => {
  const frame = useCurrentFrame();
  const base = reveal(frame, 20);
  const first = reveal(frame, 70);
  const second = reveal(frame, 145);
  const third = reveal(frame, 220);
  const failure = reveal(frame, 610);
  return (
    <AbsoluteFill style={{ background: colors.black, color: colors.bone, padding: 70 }}>
      <Grain />
      <Rail label="03 / CANDIDATES" right="PROPOSE ≠ PROVE" />
      <div style={{ marginTop: 68, position: 'relative', height: 700, opacity: base }}>
        <div style={{ width: 590, paddingTop: 65 }}>
          <div style={{ color: colors.orange, fontFamily: 'monospace', fontSize: 20, letterSpacing: 2 }}>DIVERGENCE</div>
          <div style={{ fontSize: 66, marginTop: 24, lineHeight: 1.04 }}>Keep the alternatives alive.</div>
          <div style={{ color: colors.muted, fontSize: 23, marginTop: 34, lineHeight: 1.45 }}>
            Jevyr grows competing mechanisms instead of allowing the first plausible answer to become the answer.
          </div>
          <div style={{ marginTop: 64, color: colors.blue, fontFamily: 'monospace', fontSize: 16 }}>FAILURES STAY VISIBLE</div>
        </div>
        <div style={{ position: 'absolute', left: 590, top: 34, width: 650, height: 620 }}>
          <svg width="650" height="620" viewBox="0 0 650 620">
            <path d="M36 310C170 310 216 140 330 140S478 310 614 310" stroke={colors.line} strokeWidth="2" fill="none" />
            <path d="M36 310C170 310 216 480 330 480S478 310 614 310" stroke={colors.line} strokeWidth="2" fill="none" />
            <circle cx="36" cy="310" r="13" fill={colors.orange} />
            <circle cx="330" cy="140" r="9" fill={colors.blue} />
            <circle cx="330" cy="480" r="9" fill={colors.blue} />
            <circle cx="614" cy="310" r="16" fill={colors.orange} />
            <circle cx={170 + Math.sin(frame * 0.03) * 35} cy="310" r="6" fill={colors.bone} />
            <circle cx={465 + Math.sin(frame * 0.04) * 34} cy="310" r="6" fill={colors.bone} />
          </svg>
          <CandidateCard title="A validator that can rewrite its own test boundary." status="CANDIDATE 01" tone={colors.blue} x={84} y={22} opacity={first} rotate={-2} />
          <CandidateCard title="A consensus mirror failed: agreement could impersonate truth." status="CANDIDATE 02 / FAILED" tone={colors.red} x={190} y={408} opacity={second} rotate={2} />
          <CandidateCard title="A child inherited the boundary, not the answer." status="CANDIDATE 03" tone={colors.orange} x={360} y={174} opacity={third} rotate={-1} />
          <div style={{ position: 'absolute', right: 8, bottom: 12, color: colors.red, fontFamily: 'monospace', fontSize: 15, opacity: failure }}>✕ FAILURE PRESERVED IN THE LEDGER</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Forge: React.FC = () => {
  const frame = useCurrentFrame();
  const enter = reveal(frame, 20);
  const world = reveal(frame, 220);
  const meter = clamp((frame - 240) / 620);
  return (
    <AbsoluteFill style={{ background: colors.black, color: colors.bone, padding: 70 }}>
      <Grain />
      <Rail label="04 / THE FORGE" right="BOUNDED EXECUTION / NETWORK 0 BYTES" />
      <div style={{ display: 'flex', marginTop: 76, gap: 44, alignItems: 'center' }}>
        <div style={{ width: 760, opacity: enter }}>
          <div style={{ color: colors.orange, fontFamily: 'monospace', fontSize: 20, letterSpacing: 2 }}>NOW TEST THE CLAIM</div>
          <div style={{ fontSize: 68, lineHeight: 1.04, marginTop: 22 }}>Put the candidate in a world it cannot quietly rewrite.</div>
          <div style={{ color: colors.muted, fontSize: 23, marginTop: 32, lineHeight: 1.45, maxWidth: 650 }}>
            The Forge runs admitted work in disposable environments with sealed inputs, fixed limits, and observable output.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 54, width: 600 }}>
            {[
              ['NETWORK', '0 bytes', colors.blue],
              ['SOURCE', 'read-only', colors.blue],
              ['WORKSPACE', 'disposable', colors.orange],
              ['OUTPUT', 'captured', colors.green],
            ].map(([label, value, tone]) => (
              <div key={label} style={{ borderTop: '1px solid ' + colors.line, padding: '16px 0' }}>
                <div style={{ color: colors.muted, fontFamily: 'monospace', fontSize: 13 }}>{label}</div>
                <div style={{ color: tone, fontSize: 20, marginTop: 6 }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ opacity: world }}>
          <OrbitWorld frame={frame} width={610} height={520} dense />
        </div>
      </div>
      <div style={{ position: 'absolute', left: 70, right: 70, bottom: 46 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: colors.muted, fontFamily: 'monospace', fontSize: 14, marginBottom: 12 }}>
          <span>ASSAY FRONTIER / NODE</span>
          <span>{Math.round(meter * 100)}% OF BOUNDED RUN</span>
        </div>
        <div style={{ height: 4, background: colors.line }}>
          <div style={{ width: meter * 100 + '%', height: '100%', background: meter > 0.84 ? colors.green : colors.orange }} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Evidence: React.FC = () => {
  const frame = useCurrentFrame();
  const ledger = [
    'sealed input recorded',
    'candidate proposed',
    'candidate failed assay',
    'stdout captured exactly',
    'final judgment compiled',
  ];
  return (
    <AbsoluteFill style={{ background: colors.black, color: colors.bone, padding: 70 }}>
      <Grain />
      <Rail label="05 / EVIDENCE" right="BLOOD / APPEND-ONLY PUBLIC LEDGER" />
      <div style={{ display: 'flex', gap: 70, marginTop: 86 }}>
        <div style={{ width: 630 }}>
          <div style={{ color: colors.orange, fontFamily: 'monospace', fontSize: 20, letterSpacing: 2 }}>THE RECEIPT</div>
          <div style={{ fontSize: 67, lineHeight: 1.04, marginTop: 22 }}>If it happened, keep the trace.</div>
          <div style={{ color: colors.muted, fontSize: 23, lineHeight: 1.45, marginTop: 34 }}>
            Jevyr links events, artifacts, and findings so mutation, reordering, and invented progress become visible.
          </div>
          <FramePanel style={{ marginTop: 56, padding: 26, background: colors.panelBright }}>
            <div style={{ color: colors.blue, fontFamily: 'monospace', fontSize: 15 }}>MEASURED WORK</div>
            <div style={{ display: 'flex', gap: 36, marginTop: 22 }}>
              <div><div style={{ color: colors.bone, fontSize: 31 }}>17</div><div style={{ color: colors.muted, fontFamily: 'monospace', fontSize: 12 }}>MODEL CALLS</div></div>
              <div><div style={{ color: colors.bone, fontSize: 31 }}>0</div><div style={{ color: colors.muted, fontFamily: 'monospace', fontSize: 12 }}>NETWORK BYTES</div></div>
              <div><div style={{ color: colors.orange, fontSize: 31 }}>—</div><div style={{ color: colors.muted, fontFamily: 'monospace', fontSize: 12 }}>TOKEN COUNT</div></div>
            </div>
            <div style={{ color: colors.muted, fontFamily: 'monospace', fontSize: 13, marginTop: 24 }}>NOT REPORTED IS BETTER THAN MADE UP.</div>
          </FramePanel>
        </div>
        <FramePanel style={{ flex: 1, padding: '22px 28px', background: '#0d1115' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: colors.muted, fontFamily: 'monospace', fontSize: 14, paddingBottom: 18 }}>
            <span>LIVE LEDGER</span>
            <span style={{ color: colors.green }}>CONTINUITY VERIFIED</span>
          </div>
          {ledger.map((text, index) => (
            <HashLine key={text} frame={frame} index={index} text={text} tone={index === 2 ? colors.red : index === 4 ? colors.green : colors.blue} />
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', color: colors.muted, fontFamily: 'monospace', fontSize: 13, paddingTop: 22 }}>
            <span>HEAD / sha256:9f21…8e70</span>
            <span>NO SILENT EDITS</span>
          </div>
        </FramePanel>
      </div>
    </AbsoluteFill>
  );
};

const Chamber: React.FC = () => {
  const frame = useCurrentFrame();
  const idea = Math.floor(frame / 120) % 3;
  const ideas = [
    'A validator that can rewrite its own test boundary.',
    'A consensus mirror failed: agreement could impersonate truth.',
    'A child inherited the boundary, not the answer.',
  ];
  const active = Math.min(5, Math.floor(frame / 220));
  const ideaIn = reveal(frame % 120, 6, 18);
  return (
    <AbsoluteFill style={{ background: colors.black, color: colors.bone, padding: 58 }}>
      <Grain />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Brand small />
        <div style={{ display: 'flex', gap: 12, color: colors.muted, fontFamily: 'monospace', fontSize: 14 }}>
          <span style={{ color: colors.orange }}>COUCH</span><span>/</span><span>INSPECT</span><span>/</span><span>CASE_001</span>
        </div>
      </div>
      <div style={{ marginTop: 54 }}>
        <StageRail active={active} />
      </div>
      <div style={{ display: 'flex', gap: 1, marginTop: 36, minHeight: 620 }}>
        <FramePanel style={{ flex: 1, padding: 38, background: '#090b0d' }}>
          <div style={{ color: colors.muted, fontFamily: 'monospace', fontSize: 14, letterSpacing: 2 }}>THE REQUEST</div>
          <div style={{ fontSize: 42, lineHeight: 1.12, marginTop: 28 }}>Design a self-validating machine that refuses inherited answers.</div>
          <div style={{ height: 310, marginTop: 30, display: 'flex', justifyContent: 'center' }}>
            <OrbitWorld frame={frame} width={420} height={330} dense={false} />
          </div>
          <div style={{ color: colors.orange, fontFamily: 'monospace', fontSize: 14 }}>RIGHT NOW</div>
          <div style={{ fontSize: 29, marginTop: 8 }}>{active < 3 ? 'Connecting the ideas' : active < 5 ? 'Watching the evidence' : 'Compiling the Record'}</div>
          <div style={{ color: colors.muted, fontSize: 16, marginTop: 8 }}>From here, this screen only observes.</div>
        </FramePanel>
        <FramePanel style={{ flex: 1, padding: 38, background: '#151a1f' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: colors.blue, fontFamily: 'monospace', fontSize: 14 }}>
            <span>IDEA {idea + 1} / 3</span><span>FOLLOWING NEW IDEAS</span>
          </div>
          <div style={{ marginTop: 170, opacity: ideaIn, transform: 'translateY(' + (1 - ideaIn) * 24 + 'px)' }}>
            <div style={{ color: idea === 1 ? colors.red : colors.orange, fontFamily: 'monospace', fontSize: 15 }}>{idea === 1 ? 'FAILED · KEPT VISIBLE' : 'PROPOSED · NOT TESTED'}</div>
            <div style={{ fontSize: 39, lineHeight: 1.12, marginTop: 18 }}>{ideas[idea]}</div>
          </div>
          <div style={{ position: 'absolute', left: '50%', right: 58, bottom: 65, borderTop: '1px solid ' + colors.line, paddingTop: 18, display: 'flex', justifyContent: 'space-between', color: colors.muted, fontFamily: 'monospace', fontSize: 14 }}>
            <span>← PREVIOUS</span><span>NEXT →</span>
          </div>
        </FramePanel>
      </div>
      <div style={{ position: 'absolute', left: 58, right: 58, bottom: 36, display: 'flex', justifyContent: 'space-between', color: colors.muted, fontFamily: 'monospace', fontSize: 14 }}>
        <span>3 IDEAS PROPOSED</span><span>2 CANDIDATES EXECUTED</span><span style={{ color: colors.orange }}>FINAL JUDGMENT IN PROGRESS</span>
      </div>
    </AbsoluteFill>
  );
};

const Outcomes: React.FC = () => {
  const frame = useCurrentFrame();
  const entrance = reveal(frame, 30);
  const cards = [
    ['ACCEPT', 'The defined requirement was supported.', colors.green],
    ['REJECT', 'The requirement was contradicted or failed.', colors.red],
    ['UNPROVEN', 'The evidence could not establish the requirement.', colors.orange],
    ['INVALID', 'The investigation itself was not trustworthy.', colors.blue],
  ] as const;
  return (
    <AbsoluteFill style={{ background: colors.black, color: colors.bone, padding: 74 }}>
      <Grain />
      <Rail label="06 / THE JUDGMENT" right="BONE / DETERMINISTIC COMPILATION" />
      <div style={{ marginTop: 116, opacity: entrance }}>
        <div style={{ color: colors.orange, fontFamily: 'monospace', fontSize: 19, letterSpacing: 2 }}>THE MOST IMPORTANT OUTPUT</div>
        <div style={{ fontSize: 67, lineHeight: 1.04, marginTop: 24 }}>Sometimes the honest answer is:</div>
        <div style={{ color: colors.orange, fontSize: 78, lineHeight: 1, marginTop: 10 }}>not enough evidence.</div>
        <div style={{ display: 'flex', gap: 14, marginTop: 62 }}>
          {cards.map(([label, description, tone], index) => {
            const shown = reveal(frame, 130 + index * 42, 25);
            return (
              <FramePanel key={label} style={{ flex: 1, padding: 26, borderTop: '4px solid ' + tone, opacity: shown, transform: 'translateY(' + (1 - shown) * 30 + 'px)' }}>
                <div style={{ color: tone, fontFamily: 'monospace', fontSize: 21 }}>{label}</div>
                <div style={{ color: colors.muted, fontSize: 19, lineHeight: 1.4, marginTop: 22 }}>{description}</div>
              </FramePanel>
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 58, color: colors.muted, fontFamily: 'monospace', fontSize: 15 }}>
          <span>NO MODEL GETS TO CERTIFY ITS OWN CLAIM</span>
          <span style={{ color: colors.blue }}>UNPROVEN IS A VALID RESULT</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Closing: React.FC = () => {
  const frame = useCurrentFrame();
  const shown = reveal(frame, 22);
  const mark = clamp(reveal(frame, 45, 70) + pulse(frame, 0.035) * 0.08);
  return (
    <AbsoluteFill style={{ background: colors.black, color: colors.bone, padding: 86 }}>
      <Grain />
      <Brand />
      <div style={{ position: 'absolute', left: 86, top: 330, opacity: shown, transform: 'translateY(' + (1 - shown) * 34 + 'px)' }}>
        <div style={{ fontSize: 76, lineHeight: 1.05 }}>Make the claim.</div>
        <div style={{ fontSize: 76, lineHeight: 1.05 }}>Test the claim.</div>
        <div style={{ color: colors.orange, fontSize: 76, lineHeight: 1.05 }}>Keep the evidence.</div>
        <div style={{ color: colors.blue, fontSize: 27, marginTop: 40 }}>An open-source experiment in AI judgment.</div>
      </div>
      <div style={{ position: 'absolute', right: 190, top: 330, opacity: mark }}>
        <MarkLogo size={260} glow />
      </div>
      <div style={{ position: 'absolute', left: 86, right: 86, bottom: 62, display: 'flex', justifyContent: 'space-between', color: colors.muted, fontFamily: 'monospace', fontSize: 16 }}>
        <span>github.com/ZYRT3CH/jevyr</span>
        <span>TRY A QUESTION THAT MATTERS / SEE WHAT SURVIVES</span>
      </div>
    </AbsoluteFill>
  );
};

type LaunchSceneRendererV2 = (frame: number) => React.ReactNode;

const CinematicCamera: React.FC<{ frame: number; scene: number; children: React.ReactNode }> = ({ frame, scene, children }) => {
  const travel = clamp(frame / 360);
  const moves = [
    [-18, 12, 18, -9, -0.5],
    [16, -10, -18, 12, 0.44],
    [-16, -11, 18, 12, -0.48],
    [18, 11, -16, -10, 0.4],
    [17, -10, -17, 11, -0.43],
    [-15, 10, 16, -10, 0.46],
    [0, 0, 0, 0, 0],
  ] as const;
  const [fromX, fromY, toX, toY, rotation] = moves[scene % moves.length];
  const x = fromX + (toX - fromX) * travel + Math.sin(frame * 0.028 + scene) * 9;
  const y = fromY + (toY - fromY) * travel + Math.cos(frame * 0.023 + scene) * 8;
  const scale = 1.03 + travel * 0.052 + pulse(frame, 0.022) * 0.008;
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        transformOrigin: 'center center',
        transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(' + scale + ') rotate(' + Math.sin(travel * Math.PI) * rotation + 'deg)',
        willChange: 'transform',
      }}
    >
      {children}
    </div>
  );
};

const CinematicOverlay: React.FC<{ frame: number; accent?: string; intensity?: number }> = ({ frame, accent = colors.orange, intensity = 1 }) => {
  const beat = frame % 132;
  const glitch = beat < 8 ? 1 - beat / 8 : beat > 119 ? (beat - 119) / 13 : 0;
  const sweep = interpolate(frame % 240, [0, 240], [-360, 1320]);
  const lensX = ((frame * 5.2) % 2520) - 300;
  const lensY = 250 + Math.sin(frame * 0.023) * 150;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', overflow: 'hidden', mixBlendMode: 'screen', opacity: intensity }}>
      <div style={{ position: 'absolute', inset: -220, background: 'conic-gradient(from ' + frame * 0.35 + 'deg at 74% 48%, transparent 0deg, ' + accent + '12 28deg, transparent 64deg, rgba(168,214,232,.08) 118deg, transparent 166deg)', transform: 'rotate(' + Math.sin(frame * 0.012) * 5 + 'deg) scale(' + (1 + pulse(frame, 0.02) * 0.04) + ')' }} />
      <svg width="1920" height="1080" viewBox="0 0 1920 1080" style={{ position: 'absolute', inset: 0, opacity: 0.54 + glitch * 0.3 }}>
        <path d={'M-80 ' + (720 + Math.sin(frame * 0.018) * 90) + ' C420 ' + (520 + Math.cos(frame * 0.021) * 120) + ' 1080 ' + (860 + Math.sin(frame * 0.016) * 100) + ' 2040 ' + (420 + Math.cos(frame * 0.014) * 80)} stroke={accent} strokeWidth={glitch ? 6 : 2} fill="none" opacity=".45" />
        <path d={'M-100 ' + (240 + Math.cos(frame * 0.014) * 70) + ' C520 ' + (420 + Math.sin(frame * 0.019) * 80) + ' 1120 ' + (120 + Math.cos(frame * 0.017) * 100) + ' 2020 ' + (680 + Math.sin(frame * 0.015) * 90)} stroke={colors.blue} strokeWidth="1.5" fill="none" opacity=".34" />
        <circle cx={1430 + Math.sin(frame * 0.018) * 100} cy={510 + Math.cos(frame * 0.021) * 100} r={290 + pulse(frame, 0.03) * 90} stroke={accent} strokeWidth="2" fill="none" opacity=".22" />
      </svg>
      <div style={{ position: 'absolute', left: sweep, top: 0, width: glitch ? 150 : 4, height: '100%', background: accent, opacity: 0.08 + glitch * 0.2, boxShadow: '0 0 80px ' + accent, transform: 'skewX(-12deg)' }} />
      <div style={{ position: 'absolute', left: lensX, top: lensY, width: 520, height: 520, border: '2px solid ' + accent, borderRadius: '50%', opacity: 0.18, transform: 'rotate(' + frame * 0.42 + 'deg) scale(' + (0.84 + pulse(frame, 0.027) * 0.12) + ')', boxShadow: '0 0 90px ' + accent }}>
        <div style={{ position: 'absolute', inset: 62, border: '1px solid ' + colors.blue, borderRadius: '50%' }} />
        <div style={{ position: 'absolute', inset: 166, border: '2px solid ' + colors.bone, borderRadius: '50%', borderLeftColor: 'transparent' }} />
        <div style={{ position: 'absolute', left: 238, top: 238, width: 42, height: 42, borderRadius: '50%', background: accent, boxShadow: '0 0 42px ' + accent }} />
      </div>
      {Array.from({ length: 8 }, (_, index) => <div key={index} style={{ position: 'absolute', left: Math.sin(frame * 0.08 + index * 1.8) * (glitch ? 72 : 12), top: 104 + index * 126 + Math.sin(frame * 0.03 + index) * 8, width: 420 + (index % 3) * 260, height: glitch && index % 3 === 0 ? 5 : 1, background: index % 2 ? colors.blue : accent, opacity: 0.09 + glitch * (index % 3 === 0 ? 0.22 : 0.05), transform: 'rotate(' + (-7 + Math.sin(frame * 0.012 + index) * 2) + 'deg)' }} />)}
      <div style={{ position: 'absolute', inset: 0, backgroundImage: 'repeating-linear-gradient(0deg, rgba(243,240,232,.06) 0 1px, transparent 1px 5px)', opacity: 0.14 + glitch * 0.2 }} />
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, transparent 48%, rgba(0,0,0,.52) 100%)', mixBlendMode: 'multiply' }} />
    </AbsoluteFill>
  );
};

const MotionSceneV2: React.FC<{ from: number; duration: number; render: LaunchSceneRendererV2 }> = ({ from, duration, render }) => {
  const frame = useCurrentFrame();
  const local = frame - from;
  if (local < 0 || local > duration) return null;
  const opacity = interpolate(local, [0, 16, duration - 24, duration], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const scene = Math.floor(from / 300);
  return <AbsoluteFill style={{ opacity }}><CinematicCamera frame={local} scene={scene}>{render(local)}</CinematicCamera><CinematicOverlay frame={local} accent={scene % 3 === 0 ? colors.orange : scene % 3 === 1 ? colors.blue : colors.green} intensity={0.82} /></AbsoluteFill>;
};

const LaunchParticlesV2: React.FC<{ frame: number; tone?: string; count?: number; spread?: number }> = ({
  frame,
  tone = colors.blue,
  count = 56,
  spread = 1,
}) => (
  <svg width="1920" height="1080" viewBox="0 0 1920 1080" style={{ position: 'absolute', inset: 0, opacity: 0.72 }}>
    {Array.from({ length: count }, (_, index) => {
      const baseX = (index * 347 + 83) % 1920;
      const baseY = (index * 193 + 119) % 1080;
      const drift = Math.sin(frame * 0.018 + index * 1.7) * 28 * spread;
      const y = ((baseY + frame * (0.72 + (index % 4) * 0.2) + index * 97) % 1340) - 130;
      const radius = index % 13 === 0 ? 4 : index % 3 === 0 ? 2.2 : 1.2;
      return <circle key={index} cx={baseX + drift} cy={y} r={radius} fill={tone} opacity={0.18 + (index % 5) * 0.08} />;
    })}
  </svg>
);

const LaunchBackdropV2: React.FC<{ frame: number; accent?: string; quiet?: boolean }> = ({
  frame,
  accent = colors.blue,
  quiet = false,
}) => (
  <AbsoluteFill style={{ background: colors.black, color: colors.bone, overflow: 'hidden' }}>
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background:
          'radial-gradient(circle at 74% 43%, ' + accent + '22, transparent 30%), linear-gradient(125deg, #07090b 0%, #0b1014 48%, #07090b 100%)',
        opacity: quiet ? 0.72 : 1,
      }}
    />
    <div style={{ position: 'absolute', inset: -180, transform: 'rotate(' + (frame * 0.014 - 5) + 'deg)', opacity: 0.25 }}>
      <div style={{ width: '140%', height: 2, marginTop: 428, background: accent, boxShadow: '0 0 32px ' + accent }} />
      <div style={{ width: '140%', height: 1, marginTop: 360, background: colors.line }} />
    </div>
    <LaunchParticlesV2 frame={frame} tone={accent} spread={quiet ? 0.55 : 1} />
    <Grain />
  </AbsoluteFill>
);

const LaunchHeaderV2: React.FC<{ frame: number; phase: string; right: string }> = ({ frame, phase, right }) => (
  <>
    <div style={{ position: 'absolute', left: 84, top: 56, transform: 'translateX(' + Math.sin(frame * 0.02) * 3 + 'px)' }}><Brand small /></div>
    <div style={{ position: 'absolute', left: 84, right: 84, top: 128, height: 1, background: colors.line, opacity: 0.8 }} />
    <div style={{ position: 'absolute', left: 86, top: 150, color: colors.muted, fontFamily: 'monospace', fontSize: 14, letterSpacing: 3 }}>{phase}</div>
    <div style={{ position: 'absolute', right: 86, top: 150, color: colors.blue, fontFamily: 'monospace', fontSize: 13, letterSpacing: 2 }}>{right}</div>
  </>
);

const LaunchOrbitV2: React.FC<{ frame: number; x?: number; y?: number; scale?: number; failed?: boolean }> = ({
  frame,
  x = 1350,
  y = 500,
  scale = 1,
  failed = false,
}) => {
  const tone = failed ? colors.red : colors.orange;
  const enter = reveal(frame, 6, 40);
  const zoom = 0.7 + enter * 0.3 + Math.sin(frame * 0.035) * 0.02;
  const points = Array.from({ length: 24 }, (_, index) => {
    const angle = index / 24 * Math.PI * 2 + frame * 0.004;
    const radius = 194 + Math.sin(index * 2.4) * 28;
    return { x: 320 + Math.cos(angle) * radius, y: 300 + Math.sin(angle) * radius * 0.62, r: index % 5 === 0 ? 9 : index % 2 ? 3 : 5 };
  });
  return (
    <div style={{ position: 'absolute', left: x - 320 * scale, top: y - 300 * scale, width: 640, height: 600, transform: 'scale(' + scale * zoom + ') rotate(' + (Math.sin(frame * 0.02) * 2 - 2) + 'deg)', transformOrigin: 'center', opacity: enter }}>
      <svg width="640" height="600" viewBox="0 0 640 600">
        <g transform={'rotate(' + frame * 0.12 + ' 320 300)'} fill="none">
          <circle cx="320" cy="300" r="246" stroke={failed ? colors.red : colors.bone} strokeWidth="2" strokeOpacity=".78" />
          <path d="M128 302c25-130 134-207 269-184 126 22 194 109 162 204-35 105-168 153-291 137-101-14-165-78-140-157Z" stroke={colors.blue} strokeWidth="1.8" strokeOpacity=".66" />
          <circle cx="320" cy="300" r="102" stroke={colors.bone} strokeWidth="2" strokeOpacity=".75" />
          <path d="M74 300h492M320 44v512" stroke={colors.line} strokeWidth="1" />
          {points.map((point, index) => (
            <g key={index} opacity={clamp((frame - index * 2) / 44)}>
              {index % 4 === 0 ? <path d={'M320 300L' + point.x + ' ' + point.y} stroke={colors.line} strokeWidth="1" /> : null}
              <circle cx={point.x} cy={point.y} r={point.r} fill={tone} fillOpacity={0.58 + (index % 3) * 0.12} />
            </g>
          ))}
        </g>
        <circle cx="320" cy="300" r={40 + pulse(frame, 0.06) * 18} fill="none" stroke={tone} strokeWidth="2" strokeOpacity=".72" />
        <circle cx="320" cy="300" r="15" fill={tone} />
      </svg>
    </div>
  );
};

const KineticHeadlineV2: React.FC<{
  frame: number;
  lines: string[];
  tones?: string[];
  size?: number;
  lineHeight?: number;
  exitAt?: number;
}> = ({ frame, lines, tones = [], size = 92, lineHeight = 0.92, exitAt = 9999 }) => {
  const exit = reveal(frame, exitAt, 26);
  return (
    <div style={{ fontSize: size, lineHeight, letterSpacing: -5 }}>
      {lines.map((line, index) => {
        const enter = reveal(frame, 18 + index * 13, 23);
        const direction = index % 2 === 0 ? -1 : 1;
        const x = (1 - enter) * direction * 110 - exit * direction * 80;
        const y = (1 - enter) * 26 - exit * 12;
        const scale = 0.92 + enter * 0.08 - exit * 0.04;
        return (
          <div
            key={line + index}
            style={{
              color: tones[index] || colors.bone,
              opacity: enter * (1 - exit),
              transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(' + scale + ')',
              filter: 'blur(' + (1 - enter) * 7 + 'px)',
              transformOrigin: direction < 0 ? 'left center' : 'right center',
              whiteSpace: 'nowrap',
            }}
          >
            {line}
          </div>
        );
      })}
    </div>
  );
};

const KineticEyebrowV2: React.FC<{ frame: number; children: React.ReactNode; tone?: string }> = ({ frame, children, tone = colors.orange }) => {
  const enter = reveal(frame, 6, 18);
  return (
    <div style={{ color: tone, fontFamily: 'monospace', fontSize: 18, letterSpacing: 4, opacity: enter, transform: 'translateX(' + (1 - enter) * -70 + 'px)', filter: 'blur(' + (1 - enter) * 4 + 'px)' }}>
      {children}
    </div>
  );
};

const LaunchOpenV2: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 12, 24);
  const slash = reveal(frame, 98, 18);
  const camera = interpolate(frame, [0, 240], [0.72, 1.18], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <>
      <LaunchBackdropV2 frame={frame} accent={colors.orange} />
      <LaunchHeaderV2 frame={frame} phase="00 / THE QUESTION" right="JUDGMENT IS NOT GENERATION" />
      <div style={{ position: 'absolute', left: 84, top: 300, width: 780, zIndex: 2, color: colors.bone, transform: 'translateY(' + (1 - show) * 40 + 'px)', opacity: show }}>
        <KineticEyebrowV2 frame={frame}>THE ANSWER CAN SOUND CERTAIN</KineticEyebrowV2>
        <div style={{ marginTop: 22 }}><KineticHeadlineV2 frame={frame} lines={['That doesn’t make', 'it true.']} tones={[colors.bone, colors.orange]} size={96} exitAt={205} /></div>
      </div>
      <div style={{ position: 'absolute', right: 96, bottom: 142, width: 340, color: colors.muted, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2, opacity: show }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>MODEL OUTPUT</span><span style={{ color: colors.blue }}>01</span></div>
        <div style={{ marginTop: 16, height: 1, background: colors.line }} />
        <div style={{ marginTop: 18, color: colors.bone }}>“The answer is ready.”</div>
        <div style={{ marginTop: 14, color: colors.red, opacity: slash }}>× ASSERTION ONLY</div>
      </div>
      <LaunchOrbitV2 frame={frame} x={1390} y={490} scale={camera} failed />
      <div style={{ position: 'absolute', left: 84, bottom: 68, color: colors.muted, fontFamily: 'monospace', fontSize: 14, letterSpacing: 2 }}>WHAT IF THE SYSTEM HAD TO EARN THE WORD “TRUE”?</div>
      <div style={{ position: 'absolute', left: -80 + frame * 12, top: 848, width: 500, height: 2, background: colors.red, boxShadow: '0 0 26px rgba(207,77,77,.7)', transform: 'rotate(-7deg)', opacity: slash }} />
    </>
  );
};

const LaunchSealV2: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 10, 26);
  const ring = reveal(frame, 28, 34);
  const lock = reveal(frame, 112, 22);
  const sweep = interpolate(frame, [0, 300], [-300, 2200], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <>
      <LaunchBackdropV2 frame={frame} accent={colors.blue} quiet />
      <LaunchHeaderV2 frame={frame} phase="01 / SEAL" right="ONE IMPULSE / ONE BOUNDARY" />
      <div style={{ position: 'absolute', left: 86, top: 286, width: 790, color: colors.bone, opacity: show, transform: 'translateX(' + (1 - show) * -60 + 'px)' }}>
        <KineticEyebrowV2 frame={frame} tone={colors.blue}>START WITH ONE SEALED IMPULSE</KineticEyebrowV2>
        <div style={{ marginTop: 22 }}><KineticHeadlineV2 frame={frame} lines={['The question goes in.', 'The boundary stays.']} tones={[colors.bone, colors.orange]} size={88} exitAt={270} /></div>
        <div style={{ color: colors.muted, fontSize: 23, lineHeight: 1.45, marginTop: 34, maxWidth: 630 }}>No quiet edits. No steering from the sidelines. The Case starts closed.</div>
      </div>
      <div style={{ position: 'absolute', left: 1110, top: 178, width: 570, height: 570, opacity: ring, transform: 'scale(' + (0.74 + ring * 0.26) + ') rotate(' + frame * 0.16 + 'deg)' }}>
        {[0, 1, 2].map((index) => <div key={index} style={{ position: 'absolute', inset: index * 70, border: (index === 2 ? 2 : 1) + 'px solid ' + (index === 2 ? colors.orange : index === 1 ? colors.blue : colors.line), borderRadius: '50%', opacity: 0.86 - index * 0.12 }} />)}
        <div style={{ position: 'absolute', left: 256, top: 256, width: 58, height: 58, borderRadius: '50%', background: colors.orange, boxShadow: '0 0 54px rgba(255,118,91,.65)', transform: 'scale(' + (0.86 + pulse(frame, 0.12) * 0.14) + ')' }} />
        <div style={{ position: 'absolute', left: 116, top: 277, color: colors.muted, fontFamily: 'monospace', fontSize: 13, letterSpacing: 2, transform: 'rotate(' + -frame * 0.16 + 'deg)' }}>CASE / SEALED</div>
      </div>
      <div style={{ position: 'absolute', left: 0, top: sweep, width: '100%', height: 2, background: colors.orange, opacity: 0.42 }} />
      <div style={{ position: 'absolute', right: 86, bottom: 72, color: colors.orange, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2, opacity: lock }}>● INGRESS CLOSED / WATCHING CANNOT STEER</div>
    </>
  );
};

const LaunchDivergenceV2: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 8, 24);
  const lines = [colors.blue, colors.orange, colors.green];
  const labels = ['A / PLAUSIBLE', 'B / DIFFERENT', 'C / STRANGE'];
  return (
    <>
      <LaunchBackdropV2 frame={frame} accent={colors.orange} />
      <LaunchHeaderV2 frame={frame} phase="02 / CREATE" right="DIVERSITY BEFORE AGREEMENT" />
      <div style={{ position: 'absolute', left: 84, top: 278, color: colors.bone, opacity: show, transform: 'translateY(' + (1 - show) * 35 + 'px)' }}>
        <KineticEyebrowV2 frame={frame}>DON’T KEEP THE FIRST IDEA</KineticEyebrowV2>
        <div style={{ marginTop: 22 }}><KineticHeadlineV2 frame={frame} lines={['Make the', 'possibilities', 'disagree.']} tones={[colors.bone, colors.blue, colors.bone]} size={94} lineHeight={0.9} exitAt={300} /></div>
      </div>
      <svg width="1920" height="1080" viewBox="0 0 1920 1080" style={{ position: 'absolute', inset: 0 }}>
        <g transform="translate(970 545)">
          <circle r="74" fill="none" stroke={colors.line} strokeWidth="1" />
          <circle r={42 + pulse(frame, 0.08) * 10} fill={colors.orange} opacity=".9" />
          <circle r="14" fill={colors.bone} />
          {lines.map((tone, index) => {
            const y = (index - 1) * 172;
            const travel = reveal(frame, 28 + index * 22, 44);
            return (
              <g key={tone} opacity={travel}>
                <path d={'M80 0 C240 ' + y + ' 360 ' + y + ' 760 ' + y} fill="none" stroke={tone} strokeWidth="3" strokeDasharray="14 18" strokeDashoffset={-frame * 4 - index * 50} opacity=".74" />
                <circle cx="760" cy={y} r={12 + pulse(frame + index * 30, 0.09) * 5} fill={tone} />
                <rect x="820" y={y - 42} width="360" height="84" rx="2" fill={colors.panel} stroke={tone} strokeWidth="1.5" />
                <text x="850" y={y - 6} fill={tone} fontFamily="monospace" fontSize="19" letterSpacing="3">{labels[index]}</text>
                <text x="850" y={y + 24} fill={colors.muted} fontFamily="monospace" fontSize="13" letterSpacing="2">INDEPENDENT LINEAGE / ADMITTED</text>
              </g>
            );
          })}
        </g>
      </svg>
      <div style={{ position: 'absolute', left: 84, bottom: 72, color: colors.muted, fontFamily: 'monospace', fontSize: 14, letterSpacing: 2 }}>ONE QUESTION → MANY WAYS TO BE WRONG</div>
    </>
  );
};

const LaunchWorldV2: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 8, 24);
  const world = reveal(frame, 26, 42);
  const scan = interpolate(frame, [0, 360], [-180, 1080], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <>
      <LaunchBackdropV2 frame={frame} accent={colors.green} quiet />
      <LaunchHeaderV2 frame={frame} phase="03 / EXECUTE" right="DISPOSABLE WORLD / BOUNDED BUDGET" />
      <div style={{ position: 'absolute', left: 84, top: 278, width: 700, zIndex: 2, color: colors.bone, opacity: show }}>
        <KineticEyebrowV2 frame={frame} tone={colors.green}>IDEAS ARE CHEAP</KineticEyebrowV2>
        <div style={{ marginTop: 24 }}><KineticHeadlineV2 frame={frame} lines={['Make them', 'touch reality.']} tones={[colors.bone, colors.blue]} size={92} exitAt={325} /></div>
        <div style={{ color: colors.muted, fontSize: 23, lineHeight: 1.45, marginTop: 34, maxWidth: 600 }}>A clean world. A finite budget. A test that can say no.</div>
      </div>
      <div style={{ position: 'absolute', left: 820, top: 210, width: 970, height: 700, opacity: world, transform: 'scale(' + (0.82 + world * 0.18) + ') rotateY(' + Math.sin(frame * 0.018) * 3 + 'deg)' }}>
        <div style={{ position: 'absolute', inset: 0, perspective: 780 }}>
          <div style={{ position: 'absolute', left: 90, right: 90, bottom: 40, height: 330, transform: 'rotateX(60deg) rotateZ(' + Math.sin(frame * 0.015) * 2 + 'deg)', backgroundImage: 'linear-gradient(rgba(168,214,232,.17) 1px, transparent 1px), linear-gradient(90deg, rgba(168,214,232,.17) 1px, transparent 1px)', backgroundSize: '48px 48px', border: '1px solid ' + colors.line, boxShadow: '0 0 70px rgba(168,214,232,.12)' }} />
        </div>
        <OrbitWorld frame={frame} width={760} height={650} />
        <div style={{ position: 'absolute', left: 126, top: 38, color: colors.green, fontFamily: 'monospace', fontSize: 14, letterSpacing: 2 }}>FORGE / RUN 01 / SANDBOXED</div>
        <div style={{ position: 'absolute', right: 40, bottom: 72, color: colors.orange, fontFamily: 'monospace', fontSize: 14, letterSpacing: 2 }}>CPU ▰▰▰▰▱ / BOUNDARY LOCKED</div>
        <div style={{ position: 'absolute', left: 0, top: scan, width: 880, height: 2, background: colors.green, boxShadow: '0 0 24px rgba(169,219,193,.75)', opacity: 0.7 }} />
      </div>
      <div style={{ position: 'absolute', left: 84, bottom: 70, display: 'flex', gap: 42, color: colors.muted, fontFamily: 'monospace', fontSize: 14, letterSpacing: 2, opacity: world }}>
        <span style={{ color: colors.green }}>✓ CLEAN ROOT</span><span style={{ color: colors.blue }}>✓ BOUNDED</span><span style={{ color: colors.orange }}>→ MEASURE</span>
      </div>
    </>
  );
};

const LaunchEvidenceV2: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 10, 26);
  const rows = ['candidate/A · run/01', 'candidate/B · run/01', 'assay/result · 8c1a…42e9', 'record · pending judgment', 'provider usage · measured'];
  return (
    <>
      <LaunchBackdropV2 frame={frame} accent={colors.blue} />
      <LaunchHeaderV2 frame={frame} phase="04 / EVIDENCE" right="EVERY STEP / A DIGEST-LINKED TRACE" />
      <div style={{ position: 'absolute', left: 84, top: 274, width: 700, zIndex: 2, color: colors.bone, opacity: show, transform: 'translateX(' + (1 - show) * -40 + 'px)' }}>
        <KineticEyebrowV2 frame={frame} tone={colors.blue}>EVERY STEP LEAVES A TRACE</KineticEyebrowV2>
        <div style={{ marginTop: 24 }}><KineticHeadlineV2 frame={frame} lines={['Nothing gets', 'invented.']} tones={[colors.bone, colors.orange]} size={91} exitAt={325} /></div>
        <div style={{ color: colors.muted, fontSize: 23, lineHeight: 1.45, marginTop: 34, maxWidth: 600 }}>If it was not measured, Jevyr does not quietly turn it into a fact.</div>
      </div>
      <div style={{ position: 'absolute', left: 900, top: 200, width: 900, height: 700, transform: 'perspective(1200px) rotateY(-8deg) rotateX(5deg) translateY(' + Math.sin(frame * 0.04) * 10 + 'px)', opacity: show }}>
        <div style={{ position: 'absolute', inset: 0, border: '1px solid ' + colors.line, background: 'linear-gradient(135deg, rgba(16,20,25,.95), rgba(7,9,11,.72))', boxShadow: '0 20px 90px rgba(0,0,0,.45)' }} />
        {Array.from({ length: 13 }, (_, index) => {
          const y = 58 + ((index * 57 + frame * 3.4) % 760) - 90;
          const tone = index % 5 === 3 ? colors.orange : index % 3 === 0 ? colors.green : colors.blue;
          const width = 340 + (index % 4) * 86;
          return <div key={index} style={{ position: 'absolute', left: 42 + (index % 3) * 20, top: y, width, height: 37, display: 'flex', alignItems: 'center', gap: 16, borderTop: '1px solid ' + colors.line, color: colors.muted, fontFamily: 'monospace', fontSize: 13, letterSpacing: 1, opacity: 0.52 + (index % 4) * 0.1 }}>
            <span style={{ color: tone }}>●</span><span>{rows[index % rows.length]}</span><span style={{ marginLeft: 'auto', color: tone }}>{index % 5 === 3 ? 'PENDING' : 'DIGEST LINKED'}</span>
          </div>;
        })}
        <div style={{ position: 'absolute', left: 42, right: 42, bottom: 46, border: '1px solid ' + colors.orange, padding: 20, color: colors.orange, fontFamily: 'monospace', fontSize: 18, letterSpacing: 3, transform: 'translateX(' + Math.sin(frame * 0.07) * 4 + 'px)' }}>NOT REPORTED &gt; MADE UP</div>
      </div>
      <div style={{ position: 'absolute', left: 84, bottom: 70, color: colors.muted, fontFamily: 'monospace', fontSize: 14, letterSpacing: 2 }}>PROVENANCE IS PART OF THE ANSWER</div>
    </>
  );
};

const LaunchJudgeV2: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 8, 22);
  const aperture = reveal(frame, 42, 42);
  const result = reveal(frame, 130, 30);
  return (
    <>
      <LaunchBackdropV2 frame={frame} accent={colors.orange} />
      <LaunchHeaderV2 frame={frame} phase="05 / JUDGE" right="THE KERNEL DECIDES / NOT THE MODEL" />
      <div style={{ position: 'absolute', left: 84, top: 298, zIndex: 3, color: colors.bone, opacity: show }}>
        <KineticEyebrowV2 frame={frame}>CLAIM → TEST → RECORD</KineticEyebrowV2>
        <div style={{ marginTop: 24 }}><KineticHeadlineV2 frame={frame} lines={['The model', 'can propose.', 'Only evidence', 'can close.']} tones={[colors.bone, colors.bone, colors.orange, colors.orange]} size={88} lineHeight={0.92} exitAt={205} /></div>
      </div>
      <div style={{ position: 'absolute', left: 1220, top: 190, width: 510, height: 510, border: '1px solid ' + colors.line, borderRadius: '50%', transform: 'scale(' + (0.7 + aperture * 0.3) + ') rotate(' + frame * 0.22 + 'deg)', opacity: aperture }}>
        <div style={{ position: 'absolute', inset: 44, border: '2px solid ' + colors.orange, borderRadius: '50%', borderLeftColor: 'transparent', borderBottomColor: 'transparent' }} />
        <div style={{ position: 'absolute', inset: 105, border: '1px solid ' + colors.blue, borderRadius: '50%', borderRightColor: 'transparent' }} />
        <div style={{ position: 'absolute', left: 205, top: 205, width: 98, height: 98, borderRadius: '50%', background: colors.orange, boxShadow: '0 0 75px rgba(255,118,91,.8)', transform: 'scale(' + (0.88 + pulse(frame, 0.11) * 0.12) + ')' }} />
        <div style={{ position: 'absolute', left: 178, top: 170, color: colors.black, fontFamily: 'monospace', fontSize: 15, letterSpacing: 3, transform: 'rotate(' + -frame * 0.22 + 'deg)' }}>JUDGMENT</div>
      </div>
      <div style={{ position: 'absolute', right: 86, bottom: 116, color: colors.blue, fontFamily: 'monospace', fontSize: 16, letterSpacing: 2, opacity: result }}>RESULT / EVIDENCE-BOUND / SIGNED</div>
      <div style={{ position: 'absolute', left: 84, bottom: 70, color: colors.muted, fontFamily: 'monospace', fontSize: 14, letterSpacing: 2 }}>THE ANSWER IS A RECORD OF WHAT SURVIVED</div>
    </>
  );
};

const LaunchCloseV2: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 4, 24);
  const mark = spring({ frame: Math.max(0, frame - 28), fps: 30, config: { damping: 18, stiffness: 110, mass: 0.7 } });
  return (
    <>
      <LaunchBackdropV2 frame={frame} accent={colors.orange} quiet />
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 74% 49%, rgba(255,118,91,.2), transparent 25%)' }} />
      <div style={{ position: 'absolute', left: 84, top: 56 }}><Brand small /></div>
      <div style={{ position: 'absolute', left: 84, top: 278, color: colors.bone, opacity: show, transform: 'translateY(' + (1 - show) * 30 + 'px)' }}>
        <KineticEyebrowV2 frame={frame} tone={colors.blue}>06 / CLOSE</KineticEyebrowV2>
        <div style={{ marginTop: 28 }}><KineticHeadlineV2 frame={frame} lines={['Make the claim.', 'Test the claim.', 'Keep the evidence.']} tones={[colors.bone, colors.bone, colors.orange]} size={84} lineHeight={0.94} /></div>
        <div style={{ color: colors.muted, fontSize: 23, marginTop: 38 }}>Jevyr · an open-source experiment in AI judgment</div>
      </div>
      <div style={{ position: 'absolute', right: 178, top: 324, opacity: mark, transform: 'scale(' + (0.58 + mark * 0.42) + ') rotate(' + (1 - mark) * -12 + 'deg)' }}><MarkLogo size={370} glow /></div>
      <div style={{ position: 'absolute', left: 84, right: 84, bottom: 68, display: 'flex', justifyContent: 'space-between', color: colors.muted, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2 }}><span>github.com/ZYRT3CH/jevyr</span><span>TRY A QUESTION THAT MATTERS</span></div>
    </>
  );
};

/*
 * A second short cut for people who do not live in this vocabulary every day.
 * The question stays on screen throughout the film, while the graphics keep
 * moving underneath it. It is intentionally warmer and more direct than the
 * technical launch cut above.
 */
const WhatIfBackdrop: React.FC<{ frame: number; accent?: string }> = ({ frame, accent = colors.orange }) => (
  <AbsoluteFill style={{ background: colors.black, color: colors.bone, overflow: 'hidden' }}>
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background:
          'radial-gradient(circle at 78% 42%, ' + accent + '2c, transparent 28%), linear-gradient(120deg, #07090b 0%, #11171b 55%, #07090b 100%)',
      }}
    />
    <div
      style={{
        position: 'absolute',
        left: -160 + Math.sin(frame * 0.018) * 48,
        top: 330 + Math.cos(frame * 0.014) * 20,
        width: 2300,
        height: 2,
        background: accent,
        opacity: 0.34,
        boxShadow: '0 0 34px ' + accent,
        transform: 'rotate(' + (-7 + Math.sin(frame * 0.01) * 3) + 'deg)',
      }}
    />
    <div
      style={{
        position: 'absolute',
        right: -220,
        top: -250,
        width: 820,
        height: 820,
        border: '1px solid ' + accent,
        borderRadius: '50%',
        opacity: 0.2,
        transform: 'rotate(' + frame * 0.18 + 'deg) scale(' + (1 + pulse(frame, 0.018) * 0.035) + ')',
      }}
    />
    <LaunchParticlesV2 frame={frame} tone={accent} count={44} spread={0.8} />
    <Grain />
  </AbsoluteFill>
);

const WhatIfHeader: React.FC<{ frame: number; accent?: string }> = ({ frame, accent = colors.orange }) => (
  <>
    <div style={{ position: 'absolute', left: 84, top: 52, transform: 'translateX(' + Math.sin(frame * 0.02) * 4 + 'px)' }}><Brand small /></div>
    <div style={{ position: 'absolute', right: 84, top: 65, color: accent, fontFamily: 'monospace', fontSize: 15, letterSpacing: 3 }}>WHAT IF? / AN EXPERIMENT</div>
    <div style={{ position: 'absolute', left: 84, right: 84, top: 126, height: 1, background: colors.line }} />
  </>
);

const WhatIfHeadline: React.FC<{
  frame: number;
  lines: string[];
  tones?: string[];
  size?: number;
  start?: number;
  lineHeight?: number;
}> = ({ frame, lines, tones = [], size = 94, start = 12, lineHeight = 0.94 }) => (
  <div style={{ fontSize: size, lineHeight, letterSpacing: -4 }}>
    {lines.map((line, lineIndex) => (
      <div key={line + lineIndex} style={{ whiteSpace: 'nowrap' }}>
        {line.split(' ').map((word, wordIndex) => {
          const enter = reveal(frame, start + lineIndex * 13 + wordIndex * 5, 18);
          const direction = (wordIndex + lineIndex) % 2 === 0 ? -1 : 1;
          return (
            <span
              key={word + wordIndex}
              style={{
                display: 'inline-block',
                marginRight: wordIndex === line.split(' ').length - 1 ? 0 : 18,
                color: tones[lineIndex] || colors.bone,
                opacity: enter,
                transform: 'translate3d(' + (1 - enter) * direction * 52 + 'px,' + (1 - enter) * 28 + 'px,0) scale(' + (0.88 + enter * 0.12) + ')',
                filter: 'blur(' + (1 - enter) * 6 + 'px)',
              }}
            >
              {word}
            </span>
          );
        })}
      </div>
    ))}
  </div>
);

const WhatIfCaption: React.FC<{ frame: number; children: React.ReactNode; tone?: string }> = ({ frame, children, tone = colors.muted }) => {
  const show = reveal(frame, 32, 22);
  return <div style={{ color: tone, fontSize: 24, lineHeight: 1.42, opacity: show, transform: 'translateY(' + (1 - show) * 18 + 'px)', filter: 'blur(' + (1 - show) * 3 + 'px)' }}>{children}</div>;
};

const WhatIfQuestion: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 8, 22);
  const card = reveal(frame, 30, 34);
  const strike = reveal(frame, 95, 16);
  return (
    <>
      <WhatIfBackdrop frame={frame} accent={colors.orange} />
      <WhatIfHeader frame={frame} />
      <div style={{ position: 'absolute', left: 84, top: 264, zIndex: 2, opacity: show }}>
        <div style={{ color: colors.orange, fontFamily: 'monospace', fontSize: 19, letterSpacing: 4 }}>START HERE</div>
        <div style={{ marginTop: 26 }}><WhatIfHeadline frame={frame} lines={['What if', 'a confident answer', 'was still wrong?']} tones={[colors.bone, colors.bone, colors.orange]} size={82} lineHeight={0.96} /></div>
      </div>
      <div style={{ position: 'absolute', left: 1150, top: 260, width: 600, height: 470, opacity: card, transform: 'perspective(1000px) rotateY(' + (-10 + Math.sin(frame * 0.028) * 2) + 'deg) translateY(' + Math.sin(frame * 0.05) * 8 + 'px)' }}>
        <FramePanel style={{ height: '100%', padding: 32, background: 'rgba(16,20,25,.88)', borderColor: colors.line, boxShadow: '0 30px 100px rgba(0,0,0,.45)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: colors.muted, fontFamily: 'monospace', fontSize: 14, letterSpacing: 2 }}><span>ANSWER</span><span style={{ color: colors.orange }}>CERTAIN</span></div>
          <div style={{ marginTop: 86, color: colors.bone, fontSize: 41, lineHeight: 1.15 }}>“This should work.”</div>
          <div style={{ marginTop: 40, height: 5, background: colors.orange, width: 420 * (0.68 + pulse(frame, 0.08) * 0.25), boxShadow: '0 0 28px rgba(255,118,91,.55)' }} />
          <div style={{ marginTop: 44, color: colors.red, fontFamily: 'monospace', fontSize: 18, letterSpacing: 2, opacity: strike }}>✕  THAT IS NOT PROOF</div>
        </FramePanel>
      </div>
      <div style={{ position: 'absolute', left: 84, bottom: 66, color: colors.muted, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2 }}>AN OPEN-SOURCE EXPERIMENT IN BETTER QUESTIONS</div>
    </>
  );
};

const WhatIfAsk: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 8, 20);
  const ring = reveal(frame, 24, 40);
  const cursor = interpolate(frame, [0, 270], [0, 490], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <>
      <WhatIfBackdrop frame={frame} accent={colors.blue} />
      <WhatIfHeader frame={frame} accent={colors.blue} />
      <div style={{ position: 'absolute', left: 84, top: 296, width: 840, opacity: show }}>
        <div style={{ color: colors.blue, fontFamily: 'monospace', fontSize: 19, letterSpacing: 4 }}>ASK ONE MORE QUESTION</div>
        <div style={{ marginTop: 26 }}><WhatIfHeadline frame={frame} lines={['What if we asked', '“How do we know?”']} tones={[colors.bone, colors.blue]} size={88} /></div>
        <WhatIfCaption frame={frame}>Jevyr is an experiment built around that pause.</WhatIfCaption>
      </div>
      <div style={{ position: 'absolute', right: 150, top: 210, width: 560, height: 560, opacity: ring, transform: 'scale(' + (0.72 + ring * 0.28) + ') rotate(' + frame * 0.22 + 'deg)' }}>
        <div style={{ position: 'absolute', inset: 0, border: '1px solid ' + colors.blue, borderRadius: '50%', boxShadow: '0 0 80px rgba(168,214,232,.12)' }} />
        <div style={{ position: 'absolute', inset: 78, border: '2px solid ' + colors.orange, borderRadius: '50%', borderRightColor: 'transparent' }} />
        <div style={{ position: 'absolute', inset: 172, border: '1px solid ' + colors.bone, borderRadius: '50%', opacity: 0.7 }} />
        <div style={{ position: 'absolute', left: 253, top: 253, width: 54, height: 54, borderRadius: '50%', background: colors.orange, boxShadow: '0 0 44px rgba(255,118,91,.65)', transform: 'scale(' + (0.82 + pulse(frame, 0.11) * 0.25) + ')' }} />
        <div style={{ position: 'absolute', left: 267, top: cursor, width: 26, height: 2, background: colors.blue, transform: 'rotate(90deg)' }} />
      </div>
      <div style={{ position: 'absolute', left: 84, bottom: 66, color: colors.muted, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2 }}>THE QUESTION BECOMES THE BOUNDARY</div>
    </>
  );
};

const WhatIfTry: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 8, 20);
  const progress = reveal(frame, 26, 42);
  const drift = Math.sin(frame * 0.055) * 13;
  const candidates = [
    ['TRY 01', colors.blue, 'the easy answer'],
    ['TRY 02', colors.orange, 'a different path'],
    ['TRY 03', colors.green, 'the strange idea'],
  ];
  return (
    <>
      <WhatIfBackdrop frame={frame} accent={colors.orange} />
      <WhatIfHeader frame={frame} />
      <div style={{ position: 'absolute', left: 84, top: 286, width: 700, zIndex: 3, opacity: show }}>
        <div style={{ color: colors.orange, fontFamily: 'monospace', fontSize: 19, letterSpacing: 4 }}>DO NOT STOP AT THE FIRST IDEA</div>
        <div style={{ marginTop: 26 }}><WhatIfHeadline frame={frame} lines={['What if one question', 'could get more than', 'one honest try?']} tones={[colors.bone, colors.bone, colors.orange]} size={78} lineHeight={0.96} /></div>
        <WhatIfCaption frame={frame}>Jevyr keeps several answers alive long enough to test them.</WhatIfCaption>
      </div>
      <div style={{ position: 'absolute', left: 940, top: 240, width: 850, height: 620, transform: 'translateY(' + drift + 'px)', opacity: progress }}>
        <svg width="850" height="620" viewBox="0 0 850 620" style={{ position: 'absolute', inset: 0 }}>
          <path d="M44 310C220 310 250 130 410 130S625 240 804 310" stroke={colors.line} strokeWidth="2" fill="none" />
          <path d="M44 310C220 310 260 310 410 310S610 310 804 310" stroke={colors.line} strokeWidth="2" fill="none" />
          <path d="M44 310C220 310 250 490 410 490S625 380 804 310" stroke={colors.line} strokeWidth="2" fill="none" />
          <circle cx="44" cy="310" r="16" fill={colors.orange} />
          {([[410, 130, colors.blue], [410, 310, colors.orange], [410, 490, colors.green]] as const).map(([x, y, tone], index) => <g key={index}><circle cx={x} cy={y} r={18 + pulse(frame, 0.06 + index * 0.01) * 6} fill="none" stroke={tone} strokeWidth="2" opacity=".75" /><circle cx={x} cy={y} r="7" fill={tone} /></g>)}
          <circle cx={804} cy="310" r="17" fill={colors.bone} />
          <circle cx={150 + (frame * 6) % 560} cy="310" r="7" fill={colors.orange} />
        </svg>
        {candidates.map(([label, tone, text], index) => <FramePanel key={label} style={{ position: 'absolute', left: 255, top: 18 + index * 190, width: 360, padding: 20, borderColor: tone, borderTopWidth: 3, background: 'rgba(16,20,25,.9)', transform: 'translateX(' + (1 - reveal(frame, 38 + index * 30, 22)) * 80 + 'px)' }}><div style={{ color: tone, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2 }}>{label}</div><div style={{ marginTop: 12, fontSize: 22 }}>{text}</div></FramePanel>)}
      </div>
      <div style={{ position: 'absolute', left: 84, bottom: 66, color: colors.muted, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2 }}>BAD IDEAS ARE ALLOWED TO BE SEEN</div>
    </>
  );
};

const WhatIfWorld: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 8, 22);
  const world = reveal(frame, 26, 44);
  return (
    <>
      <WhatIfBackdrop frame={frame} accent={colors.green} />
      <WhatIfHeader frame={frame} accent={colors.green} />
      <div style={{ position: 'absolute', left: 84, top: 292, width: 720, zIndex: 2, opacity: show }}>
        <div style={{ color: colors.green, fontFamily: 'monospace', fontSize: 19, letterSpacing: 4 }}>LET IT TOUCH REALITY</div>
        <div style={{ marginTop: 26 }}><WhatIfHeadline frame={frame} lines={['What if an idea', 'had to work', 'in a small world?']} tones={[colors.bone, colors.bone, colors.green]} size={82} lineHeight={0.94} /></div>
        <WhatIfCaption frame={frame}>Each try gets a clean space, a small budget, and a test that can say no.</WhatIfCaption>
      </div>
      <div style={{ position: 'absolute', right: 24, top: 162, width: 820, height: 730, opacity: world, transform: 'scale(' + (0.82 + world * 0.18) + ') rotateY(' + Math.sin(frame * 0.016) * 4 + 'deg)' }}>
        <div style={{ position: 'absolute', left: 50, right: 10, bottom: 70, height: 350, transform: 'perspective(700px) rotateX(60deg) rotateZ(' + Math.sin(frame * 0.014) * 2 + 'deg)', backgroundImage: 'linear-gradient(rgba(169,219,193,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(169,219,193,.18) 1px, transparent 1px)', backgroundSize: '48px 48px', border: '1px solid ' + colors.line }} />
        <OrbitWorld frame={frame} width={760} height={650} />
        <div style={{ position: 'absolute', left: 130, top: 28, color: colors.green, fontFamily: 'monospace', fontSize: 14, letterSpacing: 2 }}>CLEAN WORLD / TEST RUN</div>
        <div style={{ position: 'absolute', left: 120, top: 128 + ((frame * 5) % 460), width: 660, height: 2, background: colors.green, boxShadow: '0 0 22px ' + colors.green, opacity: 0.65 }} />
      </div>
      <div style={{ position: 'absolute', left: 84, bottom: 66, color: colors.muted, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2 }}>A TEST CAN SAY NO</div>
    </>
  );
};

const WhatIfTrace: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 8, 22);
  const rows = ['question received', 'three tries recorded', 'one try failed', 'test output saved', 'answer still open'];
  return (
    <>
      <WhatIfBackdrop frame={frame} accent={colors.blue} />
      <WhatIfHeader frame={frame} accent={colors.blue} />
      <div style={{ position: 'absolute', left: 84, top: 294, width: 710, zIndex: 2, opacity: show }}>
        <div style={{ color: colors.blue, fontFamily: 'monospace', fontSize: 19, letterSpacing: 4 }}>KEEP THE TRACE</div>
        <div style={{ marginTop: 26 }}><WhatIfHeadline frame={frame} lines={['What if every step', 'left a clear trace?']} tones={[colors.bone, colors.blue]} size={86} /></div>
        <WhatIfCaption frame={frame}>When a number is missing, Jevyr says “not reported.” It does not make one up.</WhatIfCaption>
      </div>
      <div style={{ position: 'absolute', left: 960, top: 230, width: 820, height: 620, padding: 28, background: 'rgba(9,12,15,.92)', border: '1px solid ' + colors.line, transform: 'perspective(900px) rotateY(-8deg) translateY(' + Math.sin(frame * 0.04) * 8 + 'px)', opacity: show, boxShadow: '0 30px 100px rgba(0,0,0,.48)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: colors.muted, fontFamily: 'monospace', fontSize: 14, letterSpacing: 2, paddingBottom: 20, borderBottom: '1px solid ' + colors.line }}><span>WHAT HAPPENED</span><span style={{ color: colors.green }}>TRACE KEPT</span></div>
        <div style={{ overflow: 'hidden', height: 430, paddingTop: 22 }}>
          {Array.from({ length: 10 }, (_, index) => {
            const row = rows[index % rows.length];
            const y = ((index * 66 + frame * 3.8) % 720) - 150;
            const tone = index % 5 === 2 ? colors.red : index % 5 === 4 ? colors.orange : colors.blue;
            return <div key={index} style={{ position: 'absolute', left: 28, right: 28, top: 100 + y, display: 'flex', gap: 18, alignItems: 'center', borderBottom: '1px solid ' + colors.line, padding: '16px 0', color: colors.muted, fontFamily: 'monospace', fontSize: 16 }}><span style={{ color: tone }}>●</span><span>{row}</span><span style={{ marginLeft: 'auto', color: tone }}>{index % 5 === 2 ? 'FAILED' : index % 5 === 4 ? 'OPEN' : 'RECORDED'}</span></div>;
          })}
        </div>
        <div style={{ position: 'absolute', left: 28, right: 28, bottom: 28, padding: 18, border: '1px solid ' + colors.orange, color: colors.orange, fontFamily: 'monospace', fontSize: 17, letterSpacing: 2 }}>NOT REPORTED &gt; MADE UP</div>
      </div>
      <div style={{ position: 'absolute', left: 84, bottom: 66, color: colors.muted, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2 }}>IF IT WAS NOT MEASURED, IT STAYS UNKNOWN</div>
    </>
  );
};

const WhatIfAnswer: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 8, 22);
  const aperture = reveal(frame, 25, 44);
  const answer = reveal(frame, 112, 28);
  return (
    <>
      <WhatIfBackdrop frame={frame} accent={colors.orange} />
      <WhatIfHeader frame={frame} />
      <div style={{ position: 'absolute', left: 84, top: 290, width: 850, zIndex: 3, opacity: show }}>
        <div style={{ color: colors.orange, fontFamily: 'monospace', fontSize: 19, letterSpacing: 4 }}>THE HONEST PART</div>
        <div style={{ marginTop: 26 }}><WhatIfHeadline frame={frame} lines={['What if the answer', 'was sometimes:', '“not enough proof”?']} tones={[colors.bone, colors.bone, colors.orange]} size={77} lineHeight={0.96} /></div>
        <WhatIfCaption frame={frame}>That is not a failure. It is a result you can understand.</WhatIfCaption>
      </div>
      <div style={{ position: 'absolute', right: 180, top: 208, width: 610, height: 610, opacity: aperture, transform: 'scale(' + (0.66 + aperture * 0.34) + ') rotate(' + frame * 0.25 + 'deg)' }}>
        <div style={{ position: 'absolute', inset: 0, border: '1px solid ' + colors.line, borderRadius: '50%' }} />
        <div style={{ position: 'absolute', inset: 58, border: '2px solid ' + colors.orange, borderRadius: '50%', borderLeftColor: 'transparent', borderBottomColor: 'transparent' }} />
        <div style={{ position: 'absolute', inset: 150, border: '1px solid ' + colors.blue, borderRadius: '50%', borderRightColor: 'transparent' }} />
        <div style={{ position: 'absolute', left: 250, top: 250, width: 110, height: 110, borderRadius: '50%', background: colors.orange, boxShadow: '0 0 90px rgba(255,118,91,.9)', transform: 'scale(' + (0.9 + pulse(frame, 0.12) * 0.14) + ')' }} />
        <div style={{ position: 'absolute', left: 188, top: 180, color: colors.black, fontFamily: 'monospace', fontSize: 16, letterSpacing: 3, transform: 'rotate(' + -frame * 0.25 + 'deg)' }}>RESULT</div>
      </div>
      <div style={{ position: 'absolute', right: 100, bottom: 118, color: colors.blue, fontFamily: 'monospace', fontSize: 16, letterSpacing: 2, opacity: answer }}>HONEST / USEFUL / OPEN TO ANOTHER TRY</div>
      <div style={{ position: 'absolute', left: 84, bottom: 66, color: colors.muted, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2 }}>THE RESULT IS A RECORD OF WHAT SURVIVED</div>
    </>
  );
};

const WhatIfClose: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 4, 22);
  const mark = spring({ frame: Math.max(0, frame - 22), fps: 30, config: { damping: 17, stiffness: 115, mass: 0.72 } });
  return (
    <>
      <WhatIfBackdrop frame={frame} accent={colors.orange} />
      <div style={{ position: 'absolute', left: 84, top: 52 }}><Brand small /></div>
      <div style={{ position: 'absolute', left: 84, top: 250, width: 920, opacity: show }}>
        <div style={{ color: colors.orange, fontFamily: 'monospace', fontSize: 19, letterSpacing: 4 }}>ONE LAST WHAT IF?</div>
        <div style={{ marginTop: 26 }}><WhatIfHeadline frame={frame} lines={['What if you could', 'test an idea before', 'you trusted it?']} tones={[colors.bone, colors.bone, colors.orange]} size={79} lineHeight={0.96} /></div>
        <div style={{ color: colors.muted, fontSize: 25, marginTop: 38, opacity: reveal(frame, 76, 24) }}>Jevyr · an open-source experiment</div>
      </div>
      <div style={{ position: 'absolute', right: 220, top: 300, opacity: mark, transform: 'scale(' + (0.55 + mark * 0.45) + ') rotate(' + (1 - mark) * -15 + 'deg)' }}><MarkLogo size={400} glow /></div>
      <div style={{ position: 'absolute', left: 84, right: 84, bottom: 68, display: 'flex', justifyContent: 'space-between', color: colors.muted, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2 }}><span>github.com/ZYRT3CH/jevyr</span><span>WHAT IF?</span></div>
    </>
  );
};

const FilmField: React.FC<{ frame: number; accent?: string; second?: string }> = ({ frame, accent = colors.orange, second = colors.blue }) => {
  const rotation = frame * 0.12;
  const pulseSize = 1 + pulse(frame, 0.027) * 0.035;
  return (
    <AbsoluteFill style={{ background: '#050709', color: colors.bone, overflow: 'hidden', filter: 'saturate(1.18) contrast(1.06)' }}>
      <div style={{ position: 'absolute', inset: -260, background: 'radial-gradient(circle at ' + (50 + Math.sin(frame * 0.013) * 26) + '% ' + (48 + Math.cos(frame * 0.011) * 22) + '%, ' + accent + '30, transparent 22%), radial-gradient(circle at ' + (22 + Math.cos(frame * 0.017) * 18) + '% 70%, ' + second + '20, transparent 28%), conic-gradient(from ' + rotation + 'deg at 50% 50%, #050709, ' + accent + '0d, #050709 24%, ' + second + '0d, #050709 51%, ' + accent + '14, #050709 78%)', transform: 'scale(' + pulseSize + ')' }} />
      <div style={{ position: 'absolute', inset: -200, transform: 'rotate(' + (-10 + Math.sin(frame * 0.009) * 4) + 'deg)' }}>
        <div style={{ position: 'absolute', left: -400, top: 300 + Math.sin(frame * 0.021) * 60, width: 2700, height: 2, background: accent, opacity: 0.38, boxShadow: '0 0 42px ' + accent }} />
        <div style={{ position: 'absolute', left: -400, top: 710 + Math.cos(frame * 0.018) * 80, width: 2700, height: 1, background: second, opacity: 0.3, boxShadow: '0 0 32px ' + second }} />
      </div>
      <svg width="1920" height="1080" viewBox="0 0 1920 1080" style={{ position: 'absolute', inset: 0, opacity: 0.66 }}>
        {Array.from({ length: 72 }, (_, index) => {
          const x = (index * 337 + 91) % 1920 + Math.sin(frame * 0.012 + index) * 42;
          const y = ((index * 197 + frame * (0.7 + (index % 4) * 0.25)) % 1280) - 100;
          const radius = index % 17 === 0 ? 4.5 : index % 4 === 0 ? 2 : 1;
          return <circle key={index} cx={x} cy={y} r={radius} fill={index % 3 === 0 ? accent : second} opacity={0.16 + (index % 5) * 0.06} />;
        })}
        <g transform={'translate(960 540) rotate(' + rotation + ') scale(' + pulseSize + ')'} fill="none">
          <circle r="460" stroke={accent} strokeWidth="1.5" opacity=".16" />
          <circle r="318" stroke={second} strokeWidth="1.2" opacity=".2" />
          <circle r="126" stroke={colors.bone} strokeWidth="1.5" opacity=".19" />
          <path d="M-620 0H620M0-620V620" stroke={colors.line} strokeWidth="1" opacity=".5" />
        </g>
      </svg>
      <div style={{ position: 'absolute', inset: 0, backgroundImage: 'repeating-linear-gradient(0deg, rgba(243,240,232,.08) 0 1px, transparent 1px 5px)', opacity: 0.17 }} />
      <Grain />
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, transparent 42%, rgba(0,0,0,.7) 100%)' }} />
    </AbsoluteFill>
  );
};

const FilmType: React.FC<{ frame: number; lines: string[]; size?: number; tone?: string; start?: number; align?: 'left' | 'center' }> = ({ frame, lines, size = 110, tone = colors.bone, start = 10, align = 'center' }) => (
  <div style={{ fontSize: size, lineHeight: 0.9, letterSpacing: -6, textAlign: align, color: tone }}>
    {lines.map((line, lineIndex) => <div key={line + lineIndex} style={{ whiteSpace: 'nowrap' }}>{line.split(' ').map((word, wordIndex) => { const show = reveal(frame, start + lineIndex * 9 + wordIndex * 4, 16); const angle = Math.sin(frame * 0.028 + wordIndex) * 1.4; return <span key={word + wordIndex} style={{ display: 'inline-block', marginRight: 19, opacity: show, transform: 'translate3d(' + (1 - show) * (wordIndex % 2 ? 68 : -68) + 'px,' + (1 - show) * 42 + 'px,0) rotate(' + ((1 - show) * (wordIndex % 2 ? 8 : -8) + angle) + 'deg) scale(' + (0.8 + show * 0.2) + ')', filter: 'blur(' + (1 - show) * 7 + 'px)', textShadow: show > 0.88 ? '0 0 28px ' + tone + '33' : undefined }}>{word}</span>; })}</div>)}
  </div>
);

const FilmMark: React.FC<{ frame: number; x: number; y: number; size?: number; accent?: string }> = ({ frame, x, y, size = 620, accent = colors.orange }) => {
  const enter = reveal(frame, 8, 34);
  return <div style={{ position: 'absolute', left: x - size / 2, top: y - size / 2, width: size, height: size, opacity: enter, transform: 'scale(' + (0.55 + enter * 0.45 + pulse(frame, 0.04) * 0.025) + ') rotate(' + frame * 0.25 + 'deg)', filter: 'drop-shadow(0 0 38px ' + accent + '55)' }}><svg width={size} height={size} viewBox="0 0 640 640"><g transform="translate(320 320)" fill="none"><circle r="278" stroke={colors.bone} strokeWidth="2" opacity=".9" /><circle r="185" stroke={colors.blue} strokeWidth="2" opacity=".75" /><circle r="78" stroke={accent} strokeWidth="3" opacity=".9" /><path d="M-278 0H278M0-278V278" stroke={colors.line} /><path d="M-110-245C40-190 226-82 218 67C210 191 33 250-128 197C-250 156-284-16-205-141C-166-203-42-238 80-208Z" stroke={colors.blue} strokeWidth="2" opacity=".7" />{Array.from({ length: 18 }, (_, index) => { const a = index / 18 * Math.PI * 2; const r = 220 + Math.sin(index * 2.1) * 30; return <circle key={index} cx={Math.cos(a + frame * 0.01) * r} cy={Math.sin(a + frame * 0.01) * r * 0.64} r={index % 5 === 0 ? 8 : 3} fill={index % 3 === 0 ? accent : colors.blue} stroke="none" opacity=".8" />; })}<circle r="18" fill={accent} stroke="none" /></g></svg></div>;
};

const FilmGlitch: React.FC<{ frame: number; accent?: string }> = ({ frame, accent = colors.orange }) => {
  const beat = frame % 108;
  const hit = beat < 7 ? 1 - beat / 7 : beat > 102 ? (beat - 102) / 6 : 0;
  return <AbsoluteFill style={{ pointerEvents: 'none', mixBlendMode: 'screen', opacity: 0.75 }}>
    {Array.from({ length: 11 }, (_, index) => <div key={index} style={{ position: 'absolute', left: Math.sin(frame * 0.11 + index) * (8 + hit * 70), top: 82 + index * 91 + Math.sin(frame * 0.023 + index) * 12, width: 330 + (index % 4) * 280, height: hit > 0.35 && index % 2 === 0 ? 4 : 1, background: index % 3 === 0 ? accent : colors.blue, opacity: 0.07 + hit * (index % 2 ? 0.06 : 0.26), transform: 'skewX(-18deg)' }} />)}
    <div style={{ position: 'absolute', left: -40 + ((frame * 10) % 2100), top: 0, width: hit ? 190 : 5, height: '100%', background: accent, opacity: 0.08 + hit * 0.2, filter: 'blur(' + (hit ? 0 : 2) + 'px)' }} />
  </AbsoluteFill>;
};

const FilmScene: React.FC<{ from: number; duration: number; scene: number; accent: string; render: (frame: number) => React.ReactNode; holdEnd?: boolean }> = ({ from, duration, scene, accent, render, holdEnd = false }) => {
  const frame = useCurrentFrame();
  const local = frame - from;
  if (local < 0 || local > duration) return null;
  const cut = interpolate(local, [0, 3], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const out = holdEnd ? 1 : interpolate(local, [duration - 3, duration], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const travel = interpolate(local, [0, duration], [scene % 2 ? 32 : -32, scene % 2 ? -36 : 38], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const x = travel + Math.sin(local * 0.027 + scene * 1.7) * 24;
  const y = Math.cos(local * 0.021 + scene) * 18 + Math.sin(local * 0.009) * 8;
  const zoom = 1.015 + interpolate(local, [0, duration], [0, 0.055], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) + pulse(local, 0.034) * 0.012;
  const tilt = Math.sin(local * 0.016 + scene) * 0.65 + interpolate(local, [0, duration], [scene % 2 ? 0.45 : -0.45, scene % 2 ? -0.45 : 0.45], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const flash = local < 10 ? interpolate(local, [0, 10], [0.2, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 0;
  return <AbsoluteFill style={{ opacity: cut * out }}><FilmField frame={local} accent={accent} second={scene % 2 ? colors.orange : colors.blue} /><div style={{ position: 'absolute', inset: 0, transformOrigin: '50% 50%', transform: 'perspective(1200px) translate3d(' + x + 'px,' + y + 'px,0) scale(' + zoom + ') rotate(' + tilt + 'deg)', filter: 'contrast(1.08) saturate(1.12)' }}>{render(local)}</div><FilmGlitch frame={local} accent={accent} /><div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 50% 50%, transparent 42%, rgba(0,0,0,.5) 100%)', pointerEvents: 'none' }} /><div style={{ position: 'absolute', inset: 0, background: accent, opacity: flash * 0.18, mixBlendMode: 'screen', pointerEvents: 'none' }} /></AbsoluteFill>;
};

const FilmHook: React.FC<{ frame: number }> = ({ frame }) => {
  const mark = reveal(frame, 100, 38);
  const move = interpolate(frame, [0, 240], [0, 420], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <><FilmMark frame={frame} x={1420 - move * 0.48} y={510 + Math.sin(frame * 0.026) * 35} size={680} /><div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: 'translateX(' + Math.sin(frame * 0.017) * 20 + 'px)' }}><FilmType frame={frame} lines={['What if?']} size={198} tone={colors.bone} /></div><div style={{ position: 'absolute', left: 84, bottom: 92, color: colors.orange, fontFamily: 'monospace', fontSize: 20, letterSpacing: 5, opacity: mark }}>AN ANSWER CAN SOUND RIGHT / AND STILL BE WRONG</div><div style={{ position: 'absolute', right: 84, top: 64, color: colors.muted, fontFamily: 'monospace', fontSize: 15, letterSpacing: 3 }}>JEVYR / AN EXPERIMENT</div></>;
};

const FilmPause: React.FC<{ frame: number }> = ({ frame }) => {
  const sweep = interpolate(frame, [0, 270], [-500, 2150], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <><FilmMark frame={frame} x={960 + Math.sin(frame * 0.03) * 130} y={550} size={880} accent={colors.blue} /><div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: 'translateY(' + Math.sin(frame * 0.023) * 18 + 'px)' }}><FilmType frame={frame} lines={['How do we', 'know?']} size={142} tone={colors.blue} start={16} /></div><div style={{ position: 'absolute', left: sweep, top: 0, width: 3, height: '100%', background: colors.bone, boxShadow: '0 0 32px ' + colors.bone, opacity: 0.6 }} /><div style={{ position: 'absolute', left: 84, bottom: 92, color: colors.muted, fontFamily: 'monospace', fontSize: 19, letterSpacing: 4 }}>THE QUESTION BECOMES THE BOUNDARY</div></>;
};

const FilmSplit: React.FC<{ frame: number }> = ({ frame }) => {
  const progress = reveal(frame, 10, 36);
  const dot = (frame * 8) % 860;
  return <><svg width="1920" height="1080" viewBox="0 0 1920 1080" style={{ position: 'absolute', inset: 0, opacity: progress }}><g fill="none" strokeLinecap="round"><path d="M240 540C620 540 610 200 980 200S1320 540 1790 540" stroke={colors.blue} strokeWidth="5" opacity=".7" /><path d="M240 540C620 540 760 540 980 540S1380 540 1790 540" stroke={colors.orange} strokeWidth="5" opacity=".75" /><path d="M240 540C620 540 610 880 980 880S1320 540 1790 540" stroke={colors.green} strokeWidth="5" opacity=".7" /><circle cx="240" cy="540" r="24" fill={colors.orange} stroke="none" /><circle cx="1790" cy="540" r="24" fill={colors.bone} stroke="none" />{([[980, 200, colors.blue], [980, 540, colors.orange], [980, 880, colors.green]] as const).map(([x, y, tone], index) => <g key={index}><circle cx={x} cy={y} r={34 + pulse(frame, 0.08 + index * 0.01) * 12} stroke={tone} strokeWidth="3" opacity=".8" /><circle cx={x} cy={y} r="10" fill={tone} stroke="none" /></g>)}<circle cx={240 + dot} cy={540} r="10" fill={colors.bone} stroke="none" /></g></svg><div style={{ position: 'absolute', left: 120, top: 356, transform: 'rotate(' + Math.sin(frame * 0.02) * 2 + 'deg)' }}><FilmType frame={frame} lines={['One question.', 'Many tries.']} size={132} align="left" /></div><div style={{ position: 'absolute', left: 124, bottom: 94, color: colors.orange, fontFamily: 'monospace', fontSize: 20, letterSpacing: 4 }}>DO NOT STOP AT THE FIRST IDEA</div></>;
};

const FilmWorld: React.FC<{ frame: number }> = ({ frame }) => {
  const zoom = interpolate(frame, [0, 360], [0.7, 1.14], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <><div style={{ position: 'absolute', inset: 0, perspective: 650 }}><div style={{ position: 'absolute', left: -220, top: 570, width: 2400, height: 800, transform: 'rotateX(67deg) rotateZ(' + Math.sin(frame * 0.015) * 2 + 'deg)', backgroundImage: 'linear-gradient(rgba(169,219,193,.22) 1px, transparent 1px), linear-gradient(90deg, rgba(169,219,193,.22) 1px, transparent 1px)', backgroundSize: '65px 65px', boxShadow: '0 0 100px rgba(169,219,193,.18)' }} /></div><div style={{ position: 'absolute', inset: 0, transform: 'scale(' + zoom + ')' }}><FilmMark frame={frame} x={960} y={540} size={850} accent={colors.green} /></div><div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: 'translateY(' + Math.sin(frame * 0.023) * 20 + 'px)' }}><FilmType frame={frame} lines={['Let it run.', 'See what', 'survives.']} size={118} align="left" tone={colors.bone} /></div><div style={{ position: 'absolute', left: 96, bottom: 92, color: colors.green, fontFamily: 'monospace', fontSize: 20, letterSpacing: 4 }}>A CLEAN WORLD / A TEST THAT CAN SAY NO</div></>;
};

const FilmTrace: React.FC<{ frame: number }> = ({ frame }) => {
  const trail = (frame * 5) % 2300;
  return <><svg width="1920" height="1080" viewBox="0 0 1920 1080" style={{ position: 'absolute', inset: 0, opacity: 0.9 }}>{Array.from({ length: 24 }, (_, index) => { const x = ((index * 191 - trail) % 2400) - 240; const y = 120 + index * 39 + Math.sin(frame * 0.02 + index) * 20; const length = 180 + (index % 5) * 130; const tone = index % 5 === 0 ? colors.orange : index % 3 === 0 ? colors.green : colors.blue; return <g key={index} transform={'translate(' + x + ' ' + y + ')'}><path d={'M0 0H' + length} stroke={tone} strokeWidth={index % 4 === 0 ? 4 : 1.5} opacity=".75" /><circle cx={length} cy="0" r={index % 4 === 0 ? 7 : 3} fill={tone} /></g>; })}</svg><div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: 'translateX(' + Math.sin(frame * 0.02) * 18 + 'px)' }}><FilmType frame={frame} lines={['If we did not', 'measure it,', 'we do not call', 'it true.']} size={102} tone={colors.bone} /></div><div style={{ position: 'absolute', left: 88, bottom: 92, color: colors.blue, fontFamily: 'monospace', fontSize: 20, letterSpacing: 4 }}>EVERY STEP LEAVES A TRACE</div></>;
};

const FilmVerdict: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 12, 28);
  const result = reveal(frame, 125, 24);
  return <><div style={{ position: 'absolute', inset: 0, transform: 'scale(' + (0.7 + show * 0.3) + ') rotate(' + frame * 0.2 + 'deg)' }}><FilmMark frame={frame} x={960} y={540} size={1040} accent={colors.orange} /></div><div style={{ position: 'absolute', left: 102, top: 344, opacity: show }}><FilmType frame={frame} lines={['Sometimes,', 'the honest', 'answer is:', 'not enough', 'proof.']} size={102} align="left" tone={colors.bone} /></div><div style={{ position: 'absolute', right: 110, bottom: 112, color: colors.orange, fontFamily: 'monospace', fontSize: 21, letterSpacing: 4, opacity: result }}>NOT A FAILURE / A RESULT YOU CAN UNDERSTAND</div></>;
};

const FilmClose: React.FC<{ frame: number }> = ({ frame }) => {
  const show = reveal(frame, 8, 24);
  const mark = spring({ frame: Math.max(0, frame - 26), fps: 30, config: { damping: 16, stiffness: 120, mass: 0.7 } });
  return <><FilmMark frame={frame} x={1370} y={540} size={760} accent={colors.orange} /><div style={{ position: 'absolute', left: 120, top: 330, opacity: show, transform: 'translateY(' + (1 - show) * 32 + 'px)' }}><FilmType frame={frame} lines={['Test an idea', 'before you', 'trust it.']} size={132} align="left" tone={colors.bone} /></div><div style={{ position: 'absolute', left: 124, bottom: 110, color: colors.orange, fontFamily: 'monospace', fontSize: 24, letterSpacing: 5, opacity: reveal(frame, 90, 25) }}>JEVYR / AN OPEN-SOURCE EXPERIMENT</div><div style={{ position: 'absolute', right: 245, top: 830, opacity: mark, color: colors.muted, fontFamily: 'monospace', fontSize: 16, letterSpacing: 3 }}>WHAT IF?</div></>;
};

const WhatIfScene: React.FC<{ from: number; duration: number; render: (frame: number) => React.ReactNode; fadeOut?: boolean; accent?: string }> = ({ from, duration, render, fadeOut = true, accent = colors.orange }) => {
  const frame = useCurrentFrame();
  const local = frame - from;
  if (local < 0 || local > duration) return null;
  const opacity = fadeOut ? interpolate(local, [0, 14, duration - 22, duration], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : interpolate(local, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const scene = Math.floor(from / 300);
  return <AbsoluteFill style={{ opacity }}><CinematicCamera frame={local} scene={scene}>{render(local)}</CinematicCamera><CinematicOverlay frame={local} accent={accent} intensity={1.05} /></AbsoluteFill>;
};

export const JevyrWhatIfShort: React.FC<JevyrExplainerProps> = () => (
  <AbsoluteFill style={{ backgroundColor: colors.black }}>
    <FilmScene from={0} duration={270} scene={0} accent={colors.orange} render={(frame) => <FilmHook frame={frame} />} />
    <FilmScene from={250} duration={290} scene={1} accent={colors.blue} render={(frame) => <FilmPause frame={frame} />} />
    <FilmScene from={520} duration={330} scene={2} accent={colors.orange} render={(frame) => <FilmSplit frame={frame} />} />
    <FilmScene from={830} duration={360} scene={3} accent={colors.green} render={(frame) => <FilmWorld frame={frame} />} />
    <FilmScene from={1170} duration={330} scene={4} accent={colors.blue} render={(frame) => <FilmTrace frame={frame} />} />
    <FilmScene from={1480} duration={240} scene={5} accent={colors.orange} render={(frame) => <FilmVerdict frame={frame} />} />
    <FilmScene from={1700} duration={100} scene={6} accent={colors.orange} render={(frame) => <FilmClose frame={frame} />} holdEnd />
  </AbsoluteFill>
);

const ShortPulseLine: React.FC<{ top: number; left?: number; width: number; delay?: number; color?: string }> = ({
  top,
  left = 0,
  width,
  delay = 0,
  color = colors.line,
}) => {
  const frame = useCurrentFrame();
  const progress = reveal(frame, delay, 22);
  return (
    <div
      style={{
        position: 'absolute',
        top,
        left,
        width: width * progress,
        height: 2,
        background: color,
        boxShadow: color === colors.orange ? '0 0 18px rgba(255,118,91,.45)' : undefined,
      }}
    />
  );
};

const ShortSignal: React.FC = () => {
  const frame = useCurrentFrame();
  const mark = spring({ frame, fps: 30, config: { damping: 16, stiffness: 120, mass: 0.7 } });
  const strike = reveal(frame, 88, 18);
  const copy = reveal(frame, 22, 24);
  return (
    <AbsoluteFill style={{ background: colors.black, color: colors.bone, overflow: 'hidden' }}>
      <Grain />
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 50% 43%, rgba(168,214,232,.08), transparent 32%)' }} />
      <ShortPulseLine top={108} left={0} width={1920} delay={8} color={colors.line} />
      <ShortPulseLine top={974} left={0} width={1920} delay={24} color={colors.line} />
      <div style={{ position: 'absolute', left: 84, top: 62, opacity: copy }}><Brand small /></div>
      <div
        style={{
          position: 'absolute',
          left: 690,
          top: 170,
          width: 540,
          height: 540,
          transform: `scale(${0.56 + mark * 0.44}) rotate(${interpolate(frame, [0, 240], [-8, 8])}deg)`,
          opacity: mark,
        }}
      >
        <MarkLogo size={540} glow />
      </div>
      <div style={{ position: 'absolute', left: 84, bottom: 128, opacity: copy, transform: `translateY(${(1 - copy) * 30}px)` }}>
        <div style={{ color: colors.orange, fontFamily: 'monospace', fontSize: 20, letterSpacing: 4 }}>THE ANSWER CAN SOUND CERTAIN</div>
        <div style={{ fontSize: 76, lineHeight: 0.98, marginTop: 18 }}>That doesn’t make</div>
        <div style={{ color: colors.orange, fontSize: 92, lineHeight: 0.98, marginTop: 4 }}>it true.</div>
      </div>
      <div style={{ position: 'absolute', right: 86, bottom: 132, color: colors.muted, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2, opacity: copy }}>
        <div>MODEL OUTPUT</div>
        <div style={{ color: colors.red, marginTop: 12, opacity: strike }}>×  NOT EVIDENCE</div>
      </div>
    </AbsoluteFill>
  );
};

const ShortSeal: React.FC = () => {
  const frame = useCurrentFrame();
  const question = reveal(frame, 18, 30);
  const lock = reveal(frame, 100, 28);
  const sweep = interpolate(frame, [0, 300], [-500, 2100], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: colors.panel, color: colors.bone, overflow: 'hidden' }}>
      <Grain />
      <Brand small />
      <div style={{ position: 'absolute', left: 86, top: 270, width: 790, opacity: question, transform: `translateX(${(1 - question) * -50}px)` }}>
        <div style={{ color: colors.blue, fontFamily: 'monospace', fontSize: 19, letterSpacing: 4 }}>01 / SEAL</div>
        <div style={{ fontSize: 76, lineHeight: 1.02, marginTop: 28 }}>Start with one<br /><span style={{ color: colors.orange }}>sealed question.</span></div>
        <div style={{ color: colors.muted, fontSize: 25, lineHeight: 1.4, marginTop: 34, maxWidth: 630 }}>No quiet edits. No steering from the sidelines. The question becomes the boundary.</div>
      </div>
      <div style={{ position: 'absolute', right: 130, top: 230, width: 600, height: 600, border: `1px solid ${colors.line}`, borderRadius: '50%', opacity: lock * 0.9 }}>
        <div style={{ position: 'absolute', inset: 64, border: `1px solid ${colors.blue}`, borderRadius: '50%', transform: `rotate(${frame * 0.45}deg)` }} />
        <div style={{ position: 'absolute', inset: 160, border: `2px solid ${colors.orange}`, borderRadius: '50%', opacity: 0.8 }} />
        <div style={{ position: 'absolute', left: 270, top: 270, width: 58, height: 58, borderRadius: '50%', background: colors.orange, boxShadow: '0 0 40px rgba(255,118,91,.55)' }} />
      </div>
      <div style={{ position: 'absolute', left: 0, top: sweep, width: '100%', height: 2, background: colors.orange, opacity: 0.35 }} />
      <div style={{ position: 'absolute', right: 86, bottom: 72, color: colors.muted, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2 }}>INGRESS CLOSED / WATCHING CANNOT STEER</div>
    </AbsoluteFill>
  );
};

const ShortSplit: React.FC = () => {
  const frame = useCurrentFrame();
  const show = reveal(frame, 12, 20);
  const second = reveal(frame, 90, 24);
  const third = reveal(frame, 180, 24);
  const drift = Math.sin(frame * 0.08) * 10;
  return (
    <AbsoluteFill style={{ background: colors.black, color: colors.bone, overflow: 'hidden' }}>
      <Grain />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(115deg, rgba(168,214,232,.07), transparent 42%, rgba(255,118,91,.08))' }} />
      <div style={{ position: 'absolute', left: 86, top: 62 }}><Brand small /></div>
      <div style={{ position: 'absolute', left: 86, top: 230, color: colors.muted, fontFamily: 'monospace', fontSize: 18, letterSpacing: 4, opacity: show }}>03 / CREATE</div>
      <div style={{ position: 'absolute', left: 86, top: 292, fontSize: 74, lineHeight: 1, opacity: show }}>Don’t keep<br />the first idea.</div>
      <div style={{ position: 'absolute', left: 86, bottom: 108, color: colors.blue, fontSize: 25, opacity: second }}>Make the possibilities disagree.</div>
      <div style={{ position: 'absolute', left: 960, top: 220, width: 760, height: 600, transform: `translateY(${drift}px)` }}>
        {[
          ['A', colors.blue, 'plausible'],
          ['B', colors.orange, 'different'],
          ['C', colors.green, 'strange'],
        ].map(([label, tone, word], index) => {
          const shown = reveal(frame, 36 + index * 62, 26);
          const x = index * 88;
          const y = index * 110;
          return (
            <FramePanel key={label} style={{ position: 'absolute', left: x, top: y, width: 550, height: 142, padding: 24, borderColor: tone, opacity: shown, transform: `translateX(${(1 - shown) * 100}px) rotate(${index === 1 ? -2 : index === 2 ? 2 : 0}deg)` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span style={{ color: tone, fontFamily: 'monospace', fontSize: 18 }}>CANDIDATE {label}</span><span style={{ color: colors.muted, fontFamily: 'monospace', fontSize: 14 }}>{word}</span></div>
              <div style={{ marginTop: 22, height: 2, width: 340 - index * 50, background: tone, opacity: 0.7 }} />
              <div style={{ marginTop: 18, color: colors.muted, fontFamily: 'monospace', fontSize: 14 }}>INDEPENDENT LINEAGE / ADMITTED</div>
            </FramePanel>
          );
        })}
      </div>
      <div style={{ position: 'absolute', right: 88, bottom: 92, color: colors.orange, fontFamily: 'monospace', fontSize: 15, letterSpacing: 3, opacity: third }}>ONE QUESTION → MANY WAYS TO BE WRONG</div>
    </AbsoluteFill>
  );
};

const ShortForge: React.FC = () => {
  const frame = useCurrentFrame();
  const show = reveal(frame, 12, 20);
  const execute = reveal(frame, 90, 20);
  return (
    <AbsoluteFill style={{ background: colors.panel, color: colors.bone, overflow: 'hidden' }}>
      <Grain />
      <div style={{ position: 'absolute', left: 86, top: 62 }}><Brand small /></div>
      <div style={{ position: 'absolute', left: 86, top: 238, opacity: show }}>
        <div style={{ color: colors.orange, fontFamily: 'monospace', fontSize: 18, letterSpacing: 4 }}>04 / EXECUTE</div>
        <div style={{ fontSize: 72, lineHeight: 1.02, marginTop: 28 }}>Ideas are cheap.</div>
        <div style={{ color: colors.blue, fontSize: 72, lineHeight: 1.02 }}>Make them touch reality.</div>
        <div style={{ color: colors.muted, fontSize: 24, marginTop: 34, maxWidth: 580, lineHeight: 1.45 }}>Jevyr gives each admitted candidate a disposable world, a bounded budget, and a test that can say no.</div>
      </div>
      <div style={{ position: 'absolute', right: 56, top: 154, opacity: execute, transform: `scale(${0.9 + execute * 0.1})` }}><OrbitWorld frame={frame} width={760} height={650} /></div>
      <div style={{ position: 'absolute', left: 86, bottom: 86, display: 'flex', gap: 42, color: colors.muted, fontFamily: 'monospace', fontSize: 14, letterSpacing: 2, opacity: execute }}>
        <span style={{ color: colors.green }}>✓ SANDBOX</span><span style={{ color: colors.blue }}>✓ BOUNDED</span><span style={{ color: colors.orange }}>→ MEASURE</span>
      </div>
    </AbsoluteFill>
  );
};

const ShortEvidence: React.FC = () => {
  const frame = useCurrentFrame();
  const show = reveal(frame, 18, 22);
  const warning = reveal(frame, 126, 24);
  const rows = ['candidate/A · run/01', 'candidate/B · run/01', 'assay/result · 8c1a…42e9', 'record · awaiting judgment'];
  return (
    <AbsoluteFill style={{ background: colors.black, color: colors.bone, overflow: 'hidden' }}>
      <Grain />
      <div style={{ position: 'absolute', left: 86, top: 62 }}><Brand small /></div>
      <div style={{ position: 'absolute', left: 86, top: 250, opacity: show }}>
        <div style={{ color: colors.blue, fontFamily: 'monospace', fontSize: 18, letterSpacing: 4 }}>05 / JUDGE</div>
        <div style={{ fontSize: 68, marginTop: 28 }}>Every step leaves a trace.</div>
        <div style={{ color: colors.orange, fontSize: 96, lineHeight: 1, marginTop: 16 }}>Nothing gets invented.</div>
      </div>
      <div style={{ position: 'absolute', right: 110, top: 260, width: 680, opacity: show }}>
        {rows.map((row, index) => {
          const shown = reveal(frame, 45 + index * 34, 20);
          return <div key={row} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '19px 0', borderBottom: `1px solid ${colors.line}`, opacity: shown, transform: `translateX(${(1 - shown) * 42}px)`, fontFamily: 'monospace', fontSize: 16 }}><span style={{ color: index === 3 ? colors.orange : colors.muted }}>{row}</span><span style={{ color: colors.blue }}>{index === 3 ? 'PENDING' : 'DIGEST LINKED'}</span></div>;
        })}
        <div style={{ marginTop: 36, padding: 22, border: `1px solid ${colors.orange}`, color: colors.orange, fontFamily: 'monospace', fontSize: 19, letterSpacing: 2, opacity: warning }}>NOT REPORTED &gt; MADE UP</div>
      </div>
      <div style={{ position: 'absolute', left: 86, bottom: 82, color: colors.muted, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2 }}>PROVENANCE IS PART OF THE ANSWER</div>
    </AbsoluteFill>
  );
};

const ShortPayoff: React.FC = ({}) => {
  const frame = useCurrentFrame();
  const show = reveal(frame, 18, 28);
  const mark = reveal(frame, 100, 55);
  return (
    <AbsoluteFill style={{ background: colors.black, color: colors.bone, overflow: 'hidden' }}>
      <Grain />
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 72% 48%, rgba(255,118,91,.18), transparent 24%)' }} />
      <div style={{ position: 'absolute', left: 86, top: 62 }}><Brand small /></div>
      <div style={{ position: 'absolute', left: 86, top: 272, opacity: show, transform: `translateY(${(1 - show) * 40}px)` }}>
        <div style={{ color: colors.blue, fontFamily: 'monospace', fontSize: 18, letterSpacing: 4 }}>06 / CLOSE</div>
        <div style={{ fontSize: 82, lineHeight: 1.02, marginTop: 30 }}>Make the claim.</div>
        <div style={{ fontSize: 82, lineHeight: 1.02 }}>Test the claim.</div>
        <div style={{ color: colors.orange, fontSize: 82, lineHeight: 1.02 }}>Keep the evidence.</div>
        <div style={{ color: colors.muted, fontSize: 25, marginTop: 40 }}>Jevyr · an open-source experiment in AI judgment</div>
      </div>
      <div style={{ position: 'absolute', right: 180, top: 330, opacity: mark, transform: `scale(${0.78 + mark * 0.22}) rotate(${(1 - mark) * -10}deg)` }}><MarkLogo size={340} glow /></div>
      <div style={{ position: 'absolute', left: 86, right: 86, bottom: 68, display: 'flex', justifyContent: 'space-between', color: colors.muted, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2 }}><span>github.com/ZYRT3CH/jevyr</span><span>TRY A QUESTION THAT MATTERS</span></div>
    </AbsoluteFill>
  );
};

export const JevyrLaunchShort: React.FC<JevyrExplainerProps> = () => (
  <AbsoluteFill style={{ backgroundColor: colors.black }}>
    <MotionSceneV2 from={0} duration={240} render={(frame) => <LaunchOpenV2 frame={frame} />} />
    <MotionSceneV2 from={210} duration={300} render={(frame) => <LaunchSealV2 frame={frame} />} />
    <MotionSceneV2 from={480} duration={330} render={(frame) => <LaunchDivergenceV2 frame={frame} />} />
    <MotionSceneV2 from={780} duration={360} render={(frame) => <LaunchWorldV2 frame={frame} />} />
    <MotionSceneV2 from={1110} duration={360} render={(frame) => <LaunchEvidenceV2 frame={frame} />} />
    <MotionSceneV2 from={1470} duration={240} render={(frame) => <LaunchJudgeV2 frame={frame} />} />
    <MotionSceneV2 from={1680} duration={120} render={(frame) => <LaunchCloseV2 frame={frame} />} />
  </AbsoluteFill>
);

export const JevyrExplainer: React.FC<JevyrExplainerProps> = (props) => (
  <AbsoluteFill style={{ backgroundColor: colors.black }}>
    <Sequence from={0} durationInFrames={600}>
      <ColdOpen {...props} />
    </Sequence>
    <Sequence from={600} durationInFrames={750}>
      <ModelIsNotJudge />
    </Sequence>
    <Sequence from={1350} durationInFrames={900}>
      <Airlock />
    </Sequence>
    <Sequence from={2250} durationInFrames={1200}>
      <Divergence />
    </Sequence>
    <Sequence from={3450} durationInFrames={1350}>
      <Forge />
    </Sequence>
    <Sequence from={4800} durationInFrames={1350}>
      <Evidence />
    </Sequence>
    <Sequence from={6150} durationInFrames={1200}>
      <Chamber />
    </Sequence>
    <Sequence from={7350} durationInFrames={1050}>
      <Outcomes />
    </Sequence>
    <Sequence from={8400} durationInFrames={600}>
      <Closing />
    </Sequence>
  </AbsoluteFill>
);
