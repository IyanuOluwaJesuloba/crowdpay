/**
 * ContributorIdentityPage — /profile/identity
 *
 * Displays the authenticated contributor's:
 *   - DID (with copy button + Stellar Expert link)
 *   - Reputation score radial gauge + tier
 *   - Attestations panel (KYC levels)
 *   - Aggregated contribution history stats
 *
 * No personal data (name, email, documents) is ever shown here.
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { api } from '../services/api';
import ReputationGauge from '../components/ReputationGauge';
import AttestationsPanel from '../components/AttestationsPanel';

const STELLAR_EXPERT_BASE = import.meta.env.VITE_STELLAR_EXPERT_URL ||
  'https://stellar.expert/explorer/testnet';

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy DID"
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        fontSize: '0.85rem',
        color: 'var(--color-accent)',
        padding: '0 0.25rem',
      }}
      aria-label="Copy DID to clipboard"
    >
      {copied ? '✓ Copied' : '⎘ Copy'}
    </button>
  );
}

function StatCard({ label, value }) {
  return (
    <div
      style={{
        flex: '1 1 140px',
        padding: '1rem',
        borderRadius: '0.5rem',
        background: 'var(--color-surface, #fff)',
        border: '1px solid var(--color-border, #e2e8f0)',
        textAlign: 'center',
      }}
    >
      <div
        style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--color-text)' }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: '0.78rem',
          color: 'var(--color-text-secondary)',
          marginTop: '0.25rem',
        }}
      >
        {label}
      </div>
    </div>
  );
}

export default function ContributorIdentityPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { showToast } = useToast();

  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState('');

  const publicKey = user?.wallet_public_key;

  const loadProfile = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    setError('');
    try {
      const data = await api.getContributorIdentityProfile(publicKey);
      setProfile(data);
    } catch (err) {
      setError(err.message || 'Failed to load identity profile');
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  async function handleRegister() {
    setRegistering(true);
    try {
      await api.registerContributorIdentity();
      showToast('Identity registered on-chain.', 'success');
      await loadProfile();
    } catch (err) {
      showToast(err.message || 'Registration failed', 'error');
    } finally {
      setRegistering(false);
    }
  }

  async function handleStartKyc(/* attestationType */) {
    try {
      const session = await api.startKyc();
      if (session.redirect_url) {
        window.location.href = session.redirect_url;
      }
    } catch (err) {
      showToast(err.message || 'Could not start KYC', 'error');
    }
  }

  if (!user) return null;

  return (
    <div className="page-narrow" style={{ padding: '2rem 1rem' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.25rem' }}>
        Contributor Identity
      </h1>
      <p style={{ color: 'var(--color-text-secondary)', marginBottom: '2rem', fontSize: '0.9rem' }}>
        Your on-chain identity anchored to your Stellar public key. No personal data is stored here.
      </p>

      {loading && (
        <p style={{ color: 'var(--color-text-hint)' }}>Loading identity…</p>
      )}

      {error && (
        <div className="alert alert--warning" style={{ marginBottom: '1.5rem' }}>
          {error}
        </div>
      )}

      {!loading && profile && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>

          {/* ── DID section ─────────────────────────────────────────────── */}
          <section
            style={{
              padding: '1.25rem',
              borderRadius: '0.5rem',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
            }}
          >
            <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: '0 0 0.75rem' }}>
              Decentralised Identifier (DID)
            </h2>
            {profile.registered ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                  fontFamily: 'monospace',
                  fontSize: '0.82rem',
                  wordBreak: 'break-all',
                  color: 'var(--color-text)',
                }}
              >
                <span>{profile.did}</span>
                <CopyButton value={profile.did} />
                <a
                  href={`${STELLAR_EXPERT_BASE}/account/${publicKey}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: '0.8rem', color: 'var(--color-accent)' }}
                >
                  View on Stellar Expert ↗
                </a>
              </div>
            ) : (
              <div>
                <p
                  style={{
                    color: 'var(--color-text-secondary)',
                    fontSize: '0.875rem',
                    marginBottom: '0.75rem',
                  }}
                >
                  Your identity is not yet registered on-chain.
                </p>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleRegister}
                  disabled={registering}
                >
                  {registering ? 'Registering…' : 'Register Identity'}
                </button>
              </div>
            )}
          </section>

          {/* ── Reputation gauge ─────────────────────────────────────── */}
          <section
            style={{
              padding: '1.25rem',
              borderRadius: '0.5rem',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: 0, alignSelf: 'flex-start' }}>
              Reputation Score
            </h2>
            <ReputationGauge score={profile.reputationScore} size={180} />
            <p
              style={{
                fontSize: '0.8rem',
                color: 'var(--color-text-hint)',
                textAlign: 'center',
                maxWidth: '280px',
                margin: 0,
              }}
            >
              Score is updated on-chain after each campaign interaction. Ranges from 0 to 1000.
            </p>
          </section>

          {/* ── Attestations ─────────────────────────────────────────── */}
          <section
            style={{
              padding: '1.25rem',
              borderRadius: '0.5rem',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
            }}
          >
            <AttestationsPanel
              attestations={profile.attestations}
              onStartKyc={handleStartKyc}
            />
          </section>

          {/* ── Contribution stats ───────────────────────────────────── */}
          <section
            style={{
              padding: '1.25rem',
              borderRadius: '0.5rem',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
            }}
          >
            <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: '0 0 1rem' }}>
              Contribution History
            </h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
              <StatCard
                label="Campaigns Backed"
                value={profile.contributionStats.totalCampaigns}
              />
              <StatCard
                label="Total Contributed (USD)"
                value={`$${profile.contributionStats.totalAmountUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
              />
              <StatCard
                label="Campaign Success Rate"
                value={`${profile.contributionStats.successRate}%`}
              />
            </div>
          </section>

        </div>
      )}
    </div>
  );
}
