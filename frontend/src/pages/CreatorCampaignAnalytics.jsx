import React, { useEffect, useState, useCallback } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import VelocityWidget from '../components/campaign/VelocityWidget';

import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, BarChart, Bar,
} from 'recharts';

const DONUT_COLORS = ['#7c3aed', '#22c55e', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899', '#14b8a6'];

function StatCard({ label, value }) {
  return (
    <div className="campaign-card" style={{ minHeight: 'auto', padding: '0.6rem 0.75rem' }}>
      <strong style={{ fontSize: '1rem' }}>{value}</strong>
      <div style={{ fontSize: '0.78rem', color: 'var(--color-text-hint)' }}>{label}</div>
    </div>
  );
}

export default function CreatorCampaignAnalytics() {
  const { campaignId } = useParams();
  const { user, ready } = useAuth();
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);

  const isCreator = user?.role === 'creator' || user?.role === 'admin';

  useEffect(() => {
    if (!user || !isCreator || !campaignId) return;
    setLoading(true);
    api
      .getCreatorCampaignAnalytics(campaignId)
      .then(setData)
      .catch((err) => setError(err.message || 'Failed to load campaign analytics'))
      .finally(() => setLoading(false));
  }, [user, isCreator, campaignId]);

  const handleExport = useCallback(async () => {
    if (!campaignId) return;
    setExporting(true);
    setError('');
    try {
      const { blob, filename } = await api.exportCreatorCampaignData(campaignId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      if (err.status === 429) {
        setError('Daily export limit reached (5/day). Try again tomorrow.');
      } else {
        setError(err.message || 'Export failed');
      }
    } finally {
      setExporting(false);
    }
  }, [campaignId]);

  if (!ready) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (!isCreator) return <Navigate to="/dashboard" replace />;

  const retention = data?.contributor_retention;
  const retentionData = retention
    ? [
        { name: 'New', value: retention.new },
        { name: 'Returning', value: retention.returning },
      ]
    : [];

  const assetMixData = (data?.asset_mix || []).map((a) => ({
    name: a.asset,
    value: Number(a.total),
    count: a.count,
  }));

  const milestonesData = (data?.milestones || []).map((m) => ({
    name: m.title,
    progress: m.progress_pct,
    target: m.percentage,
    status: m.status,
  }));

  return (
    <main className="container" style={{ paddingTop: '2rem', paddingBottom: '3rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1.25rem' }}>
        <h1 style={{ fontSize: '1.6rem', fontWeight: 800 }}>
          {data?.campaign?.title || 'Campaign Analytics'}
        </h1>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <button type="button" className="btn-secondary" onClick={handleExport} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
          <Link to="/dashboard/analytics" style={{ color: 'var(--color-accent)', fontWeight: 600, fontSize: '0.9rem' }}>
            ← Back to Analytics
          </Link>
        </div>
      </div>

      {error && <p className="alert alert--error">{error}</p>}
      {loading && <p style={{ color: 'var(--color-text-hint)' }}>{t('common.loading')}</p>}

      {campaignId && (
        <div style={{ marginBottom: '1.5rem' }}>
          <VelocityWidget campaignId={campaignId} />
        </div>
      )}

      {data && !loading && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
            <StatCard label="Raised" value={`${Number(data.campaign.raised_amount).toLocaleString()} ${data.campaign.asset_type}`} />
            <StatCard label="Target" value={`${Number(data.campaign.target_amount).toLocaleString()} ${data.campaign.asset_type}`} />
            <StatCard label="Goal %" value={`${Number(data.campaign.target_amount) > 0 ? Math.min(100, (Number(data.campaign.raised_amount) / Number(data.campaign.target_amount)) * 100).toFixed(1) : 0}%`} />
            <StatCard label="Contributors" value={retention?.total || 0} />
            <StatCard label="Retention Rate" value={`${retention?.retention_rate || 0}%`} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: '1.25rem' }}>
            <div className="campaign-card">
              <h3 style={{ marginBottom: '1rem', fontSize: '1.1rem' }}>Asset Mix</h3>
              {assetMixData.length > 0 ? (
                <div style={{ width: '100%', height: '220px' }}>
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={assetMixData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                        {assetMixData.map((_, index) => (
                          <Cell key={`cell-${index}`} fill={DONUT_COLORS[index % DONUT_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p style={{ color: 'var(--color-text-hint)' }}>No contribution data</p>
              )}
            </div>

            <div className="campaign-card">
              <h3 style={{ marginBottom: '1rem', fontSize: '1.1rem' }}>Milestone Progress</h3>
              {milestonesData.length > 0 ? (
                <div style={{ width: '100%', height: '220px' }}>
                  <ResponsiveContainer>
                    <BarChart data={milestonesData} layout="vertical" margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" domain={[0, 100]} />
                      <YAxis dataKey="name" type="category" width={80} />
                      <Tooltip />
                      <Bar dataKey="progress" fill="#22c55e" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p style={{ color: 'var(--color-text-hint)' }}>No milestones defined</p>
              )}
            </div>
          </div>
        </>
      )}
    </main>
  );
}