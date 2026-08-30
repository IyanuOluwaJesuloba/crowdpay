/**
 * ReputationGauge
 *
 * Displays a contributor's reputation score (0–1000) as an SVG radial gauge
 * with a tier label.  No external charting library required.
 *
 * Tiers (per spec):
 *   Newcomer    0–99
 *   Contributor 100–299
 *   Trusted     300–599
 *   Veteran     600–849
 *   Champion    850–1000
 */

const TIERS = [
  { label: 'Newcomer',    min: 0,   max: 99,   color: 'var(--color-text-hint)' },
  { label: 'Contributor', min: 100, max: 299,  color: 'var(--color-accent)' },
  { label: 'Trusted',     min: 300, max: 599,  color: 'var(--color-accent-light)' },
  { label: 'Veteran',     min: 600, max: 849,  color: '#7c3aed' },
  { label: 'Champion',    min: 850, max: 1000, color: 'var(--color-teal)' },
];

function getTier(score) {
  return TIERS.find((t) => score >= t.min && score <= t.max) || TIERS[0];
}

/** Convert polar coords to SVG cartesian. cx/cy = centre, r = radius. */
function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** Build an SVG arc path for a gauge that sweeps from startDeg to endDeg. */
function arcPath(cx, cy, r, startDeg, endDeg) {
  const start = polarToCartesian(cx, cy, r, endDeg);
  const end = polarToCartesian(cx, cy, r, startDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 0 ${end.x} ${end.y}`;
}

export default function ReputationGauge({ score = 0, size = 160 }) {
  const clamped = Math.max(0, Math.min(1000, score));
  const tier = getTier(clamped);

  // Gauge sweeps 240° (from -120° to +120° relative to bottom, i.e. 120°–360°)
  const START_DEG = 120;
  const END_DEG   = 420; // = 360 + 60, drawn as 420 for SVG arc maths
  const TOTAL_DEG = END_DEG - START_DEG; // 300°

  const cx = size / 2;
  const cy = size / 2;
  const r  = size * 0.38;
  const strokeWidth = size * 0.09;

  const filledDeg = START_DEG + (clamped / 1000) * TOTAL_DEG;

  const trackPath = arcPath(cx, cy, r, START_DEG, END_DEG);
  const fillPath  = clamped > 0 ? arcPath(cx, cy, r, START_DEG, filledDeg) : null;

  return (
    <div
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.25rem',
      }}
      aria-label={`Reputation score: ${clamped} — ${tier.label}`}
      role="img"
    >
      <svg width={size} height={size * 0.75} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {/* Track */}
        <path
          d={trackPath}
          fill="none"
          stroke="var(--color-border, #e2e8f0)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        {/* Filled arc */}
        {fillPath && (
          <path
            d={fillPath}
            fill="none"
            stroke={tier.color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.6s ease' }}
          />
        )}
        {/* Score text */}
        <text
          x={cx}
          y={cy + size * 0.06}
          textAnchor="middle"
          fontSize={size * 0.2}
          fontWeight="700"
          fill="var(--color-text, #1a202c)"
        >
          {clamped}
        </text>
        <text
          x={cx}
          y={cy + size * 0.2}
          textAnchor="middle"
          fontSize={size * 0.1}
          fill="var(--color-text-secondary, #718096)"
        >
          / 1000
        </text>
      </svg>

      {/* Tier label */}
      <span
        style={{
          fontSize: '0.85rem',
          fontWeight: 600,
          color: tier.color,
          letterSpacing: '0.03em',
          textTransform: 'uppercase',
        }}
      >
        {tier.label}
      </span>
    </div>
  );
}
