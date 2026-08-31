import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../services/api';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';

export default function VelocityWidget({ campaignId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [viewMode, setViewMode] = useState('7d');
  const [thresholdInput, setThresholdInput] = useState('');
  const [savingThreshold, setSavingThreshold] = useState(false);

  const fetchVelocity = useCallback(async () => {
    try {
      const res = await api.getCampaignVelocity(campaignId);
      setData(res);
      if (res?.alerts?.threshold !== undefined) {
        setThresholdInput(res.alerts.threshold);
      }
    } catch (err) {
      setError(err.message || 'Failed to load contribution velocity');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    if (!campaignId) return;
    fetchVelocity();
    const interval = setInterval(fetchVelocity, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [campaignId, fetchVelocity]);

  const handleSaveThreshold = async (e) => {
    e.preventDefault();
    setSavingThreshold(true);
    try {
      const res = await api.updateVelocityThreshold(campaignId, Number(thresholdInput));
      setData(prev => ({
        ...prev,
        alerts: {
          ...prev.alerts,
          threshold: res.threshold,
          is_below_threshold: prev.velocity.amount_per_hour < res.threshold,
        },
      }));
    } catch (err) {
      setError(err.message || 'Failed to update alert threshold');
    } finally {
      setSavingThreshold(false);
    }
  };

  if (loading && !data) return <div className="campaign-card">Loading velocity widget…</div>;
  if (error && !data) return <div className="campaign-card" style={{ color: 'var(--color-danger)' }}>{error}</div>;

  const velocity = data?.velocity || {};
  const projected = data?.projected_completion_date;
  const comparison = data?.category_comparison || {};
  const alerts = data?.alerts || {};
  const trends = data?.trends || {};
  const chartData = viewMode === '7d' ? trends.view_7d || [] : trends.view_30d || [];

  return (
    <div className="campaign-card" style={{ display: 'grid', gap: '1rem', padding: '1.25rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h3 style={{ margin: 0, fontSize: '1.15rem' }}>Contribution Velocity & Funding Pace</h3>
        <span style={{ fontSize: '0.75rem', color: 'var(--color-text-hint)' }}>Refreshes every 5m</span>
      </div>

      {alerts.is_below_threshold && (
        <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid var(--color-danger)', padding: '0.75rem', borderRadius: '6px', color: 'var(--color-danger)', fontSize: '0.85rem' }}>
          ⚠️ <strong>Velocity Alert:</strong> Current hourly velocity ({velocity.amount_per_hour}/hr) has dropped below your configured threshold ({alerts.threshold}/hr).
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.75rem' }}>
        <div style={{ background: 'var(--color-bg-subtle)', padding: '0.75rem', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--color-text-hint)' }}>Velocity (Hourly)</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{velocity.amount_per_hour || 0} /hr</div>
        </div>
        <div style={{ background: 'var(--color-bg-subtle)', padding: '0.75rem', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--color-text-hint)' }}>Velocity (Daily)</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{velocity.amount_per_day || 0} /day</div>
        </div>
        <div style={{ background: 'var(--color-bg-subtle)', padding: '0.75rem', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--color-text-hint)' }}>Projected Completion</div>
          <div style={{ fontSize: '0.95rem', fontWeight: 700 }}>
            {projected ? new Date(projected).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A'}
          </div>
        </div>
        <div style={{ background: 'var(--color-bg-subtle)', padding: '0.75rem', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--color-text-hint)' }}>Category Avg (Weekly)</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{comparison.category_avg_weekly || 0}</div>
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>Velocity Trend</span>
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            <button
              type="button"
              className={viewMode === '7d' ? 'btn-primary' : 'btn-secondary'}
              style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
              onClick={() => setViewMode('7d')}
            >
              7 Days
            </button>
            <button
              type="button"
              className={viewMode === '30d' ? 'btn-primary' : 'btn-secondary'}
              style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
              onClick={() => setViewMode('30d')}
            >
              30 Days
            </button>
          </div>
        </div>
        <div style={{ width: '100%', height: '180px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Line type="monotone" dataKey="amount" stroke="#7c3aed" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <form onSubmit={handleSaveThreshold} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.5rem', borderTop: '1px solid var(--color-border)', paddingTop: '0.75rem' }}>
        <label htmlFor="velocity-threshold" style={{ fontSize: '0.8rem', flex: '1 1 180px' }}>
          Alert when hourly velocity drops below:
        </label>
        <input
          id="velocity-threshold"
          type="number"
          min="0"
          step="any"
          value={thresholdInput}
          onChange={(e) => setThresholdInput(e.target.value)}
          style={{ width: '100px', padding: '0.3rem 0.5rem', fontSize: '0.85rem' }}
        />
        <button type="submit" className="btn-secondary" disabled={savingThreshold} style={{ padding: '0.3rem 0.75rem', fontSize: '0.8rem' }}>
          {savingThreshold ? 'Saving…' : 'Set Alert'}
        </button>
      </form>
    </div>
  );
}