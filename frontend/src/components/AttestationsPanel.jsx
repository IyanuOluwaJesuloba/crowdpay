/**
 * AttestationsPanel
 *
 * Lists the contributor's KYC attestations and surfaces "Get Verified" CTAs
 * for missing tiers.  No personal data is displayed — only attestation type,
 * issuer label, dates, and revocation status.
 */

import { useTranslation } from 'react-i18next';

const ALL_TYPES = [
  {
    type: 'kyc_basic',
    label: 'KYC Basic',
    description: 'Government ID check',
  },
  {
    type: 'kyc_standard',
    label: 'KYC Standard',
    description: 'Government ID + address verification',
  },
  {
    type: 'kyc_enhanced',
    label: 'KYC Enhanced',
    description: 'Government ID + address + liveness check',
  },
];

function formatDate(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function StatusBadge({ attestation }) {
  if (!attestation) {
    return (
      <span
        style={{
          background: 'var(--color-surface-alt, #f7fafc)',
          color: 'var(--color-text-hint, #a0aec0)',
          border: '1px solid var(--color-border, #e2e8f0)',
          borderRadius: '9999px',
          padding: '0.15rem 0.6rem',
          fontSize: '0.75rem',
          fontWeight: 600,
        }}
      >
        Not verified
      </span>
    );
  }
  if (attestation.revoked) {
    return (
      <span
        style={{
          background: '#fff5f5',
          color: '#e53e3e',
          border: '1px solid #fed7d7',
          borderRadius: '9999px',
          padding: '0.15rem 0.6rem',
          fontSize: '0.75rem',
          fontWeight: 600,
        }}
      >
        Revoked
      </span>
    );
  }
  if (attestation.expiresAt && new Date(attestation.expiresAt) < new Date()) {
    return (
      <span
        style={{
          background: '#fffbeb',
          color: '#d97706',
          border: '1px solid #fde68a',
          borderRadius: '9999px',
          padding: '0.15rem 0.6rem',
          fontSize: '0.75rem',
          fontWeight: 600,
        }}
      >
        Expired
      </span>
    );
  }
  return (
    <span
      style={{
        background: '#f0fff4',
        color: '#276749',
        border: '1px solid #9ae6b4',
        borderRadius: '9999px',
        padding: '0.15rem 0.6rem',
        fontSize: '0.75rem',
        fontWeight: 600,
      }}
    >
      Verified
    </span>
  );
}

export default function AttestationsPanel({ attestations = [], onStartKyc }) {
  const { t } = useTranslation();

  // Build a lookup of type → active (non-revoked, non-expired) attestation
  const byType = {};
  for (const att of attestations) {
    const existing = byType[att.type];
    const isActive = !att.revoked && (!att.expiresAt || new Date(att.expiresAt) > new Date());
    // Prefer the most-recent active one; fall back to any
    if (!existing || (isActive && !byType[att.type]._isActive)) {
      byType[att.type] = { ...att, _isActive: isActive };
    }
  }

  return (
    <div>
      <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 600 }}>
        Identity Attestations
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {ALL_TYPES.map(({ type, label, description }) => {
          const att = byType[type] || null;
          const isActive = att?._isActive ?? false;

          return (
            <div
              key={type}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.75rem 1rem',
                borderRadius: '0.5rem',
                background: 'var(--color-surface, #fff)',
                border: '1px solid var(--color-border, #e2e8f0)',
              }}
            >
              {/* Icon */}
              <span style={{ fontSize: '1.4rem', flexShrink: 0 }}>
                {isActive ? '✅' : '🔲'}
              </span>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{label}</div>
                <div
                  style={{
                    fontSize: '0.78rem',
                    color: 'var(--color-text-secondary, #718096)',
                  }}
                >
                  {description}
                </div>
                {att && (
                  <div
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--color-text-hint, #a0aec0)',
                      marginTop: '0.2rem',
                    }}
                  >
                    Issued {formatDate(att.issuedAt)}
                    {att.expiresAt ? ` · Expires ${formatDate(att.expiresAt)}` : ''}
                    {att.issuer ? ` · Issuer: ${att.issuer}` : ''}
                  </div>
                )}
              </div>

              {/* Status + CTA */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-end',
                  gap: '0.4rem',
                  flexShrink: 0,
                }}
              >
                <StatusBadge attestation={att} />
                {!isActive && onStartKyc && (
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ fontSize: '0.75rem', padding: '0.2rem 0.65rem' }}
                    onClick={() => onStartKyc(type)}
                  >
                    Get Verified
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
