// frontend/src/pages/Discover.jsx
//
// Issue #690 — adds what Home.jsx doesn't already cover:
//   - a trending carousel backed by the weighted trending score
//     (GET /campaigns/trending), not just "most contributions in 48h"
//   - a "For You" personalised tab (GET /campaigns/recommended, already
//     powered by services/campaignRecommendationService.js)
//   - an embed-code generator so creators can grab a <script> snippet for
//     the embeddable discovery widget
//
// Wire up a route for this in App.jsx, e.g.:
//   <Route path="/discover" element={<Discover />} />

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import CampaignCard from '../components/CampaignCard';

const styles = {
  page: { maxWidth: 1100, margin: '0 auto', padding: '2rem 1rem' },
  sectionTitle: { fontSize: '1.25rem', fontWeight: 700, marginBottom: '1rem' },
  carousel: {
    display: 'flex',
    gap: '1rem',
    overflowX: 'auto',
    paddingBottom: '0.75rem',
    scrollSnapType: 'x mandatory',
  },
  carouselItem: { flex: '0 0 280px', scrollSnapAlign: 'start' },
  tabs: { display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' },
  tab: (active) => ({
    padding: '0.5rem 1rem',
    borderRadius: 999,
    border: '1px solid #e5e7eb',
    background: active ? '#4f46e5' : '#fff',
    color: active ? '#fff' : '#374151',
    fontWeight: 600,
    fontSize: '0.875rem',
    cursor: 'pointer',
  }),
  grid: {
    display: 'grid',
    gap: '1rem',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))',
  },
  empty: { color: '#6b7280', fontSize: '0.9rem', padding: '1rem 0' },
  embedBox: {
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: 10,
    padding: '1rem',
    marginTop: '2.5rem',
  },
  code: {
    display: 'block',
    background: '#111827',
    color: '#e5e7eb',
    padding: '0.75rem',
    borderRadius: 8,
    fontSize: '0.75rem',
    overflowX: 'auto',
    marginTop: '0.5rem',
  },
};

function TrendingSection() {
  const [trending, setTrending] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .getTrendingCampaigns({ limit: 10 })
      .then((data) => {
        if (!cancelled) setTrending(data?.campaigns || []);
      })
      .catch(() => {
        if (!cancelled) setTrending([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div style={styles.empty}>Loading trending campaigns…</div>;
  if (!trending.length) return null;

  return (
    <section style={{ marginBottom: '2.5rem' }}>
      <h2 style={styles.sectionTitle}>🔥 Trending now</h2>
      <div style={styles.carousel}>
        {trending.map((c) => (
          <div key={c.id} style={styles.carouselItem}>
            <CampaignCard campaign={c} />
          </div>
        ))}
      </div>
    </section>
  );
}

function PersonalisedFeed() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .getRecommendedCampaigns({ limit: 12 })
      .then((data) => {
        if (!cancelled) setCampaigns(Array.isArray(data) ? data : data?.campaigns || []);
      })
      .catch(() => {
        if (!cancelled) setCampaigns([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div style={styles.empty}>Finding campaigns for you…</div>;
  if (!campaigns.length) {
    return <div style={styles.empty}>Fund a few campaigns and we&apos;ll start tailoring this feed to you.</div>;
  }

  return (
    <div>
      <p style={{ fontSize: '0.8rem', color: '#9ca3af', marginBottom: '0.75rem' }}>
        Based on your contribution history
      </p>
      <div style={styles.grid}>
        {campaigns.map((c) => (
          <CampaignCard key={c.id} campaign={c} />
        ))}
      </div>
    </div>
  );
}

function DiscoveryGrid() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .getCampaigns({ limit: 24, sort: 'newest' })
      .then((data) => {
        if (!cancelled) setCampaigns(data?.campaigns || []);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div style={styles.empty}>Loading campaigns…</div>;

  return (
    <div style={styles.grid}>
      {campaigns.map((c) => (
        <CampaignCard key={c.id} campaign={c} />
      ))}
    </div>
  );
}

function EmbedSnippet() {
  const [copied, setCopied] = useState(false);
  const snippet = `<script src="https://cdn.crowdpay.com/discover.js"
  data-token="YOUR_EMBED_TOKEN"
  data-topic="education"
  data-asset="USDC"
  data-limit="3"></script>`;

  function copy() {
    navigator.clipboard?.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div style={styles.embedBox}>
      <strong>Embed CrowdPay campaigns on your site</strong>
      <p style={{ fontSize: '0.85rem', color: '#6b7280', margin: '0.5rem 0 0' }}>
        Generate an embed token from your{' '}
        <Link to="/developer">developer settings</Link>, then drop this snippet into any page:
      </p>
      <code style={styles.code}>{snippet}</code>
      <button
        type="button"
        onClick={copy}
        style={{ marginTop: '0.5rem', fontSize: '0.8rem', cursor: 'pointer' }}
      >
        {copied ? 'Copied!' : 'Copy snippet'}
      </button>
    </div>
  );
}

export default function Discover() {
  const { user } = useAuth();
  const [tab, setTab] = useState('all');

  return (
    <div style={styles.page}>
      <TrendingSection />

      <div style={styles.tabs}>
        <button type="button" style={styles.tab(tab === 'all')} onClick={() => setTab('all')}>
          All campaigns
        </button>
        {user && (
          <button type="button" style={styles.tab(tab === 'forYou')} onClick={() => setTab('forYou')}>
            For You
          </button>
        )}
      </div>

      <section>
        {tab === 'forYou' ? <PersonalisedFeed /> : <DiscoveryGrid />}
      </section>

      <EmbedSnippet />
    </div>
  );
}