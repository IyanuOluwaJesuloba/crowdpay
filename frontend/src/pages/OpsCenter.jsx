import React, { useState, useEffect, useCallback } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';

export default function OpsCenter() {
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem('cp_ops_api_key') || sessionStorage.getItem('cp_ops_api_key') || ''
  );
  const [tempKey, setTempKey] = useState('');
  const [rememberKey, setRememberKey] = useState(true);
  const [authError, setAuthError] = useState('');

  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [healthData, setHealthData] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [incidentTab, setIncidentTab] = useState('open'); // 'open' | 'resolved'
  const [resolvedIncidents, setResolvedIncidents] = useState([]);
  const [walletAudit, setWalletAudit] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Runbook execution modal state
  const [activeRunbookModal, setActiveRunbookModal] = useState(false);
  const [selectedIncident, setSelectedIncident] = useState(null);
  const [runbookExecuting, setRunbookExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState(null);

  // Metric history modal state
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [historyMetric, setHistoryMetric] = useState('horizon_testnet_latency_ms');
  const [historyData, setHistoryData] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const fetchWithAuth = useCallback(
    async (url, options = {}) => {
      const headers = {
        'Content-Type': 'application/json',
        'ops_api_key': apiKey,
        ...options.headers,
      };
      const res = await fetch(url, { ...options, headers });
      if (res.status === 401) {
        throw new Error('UNAUTHORIZED_OPS');
      }
      return res;
    },
    [apiKey]
  );

  const loadDashboardData = useCallback(async (isRefresh = false) => {
    if (!apiKey) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setErrorMsg('');

    try {
      // 1. Health data
      const healthRes = await fetchWithAuth(`/api/ops/health${isRefresh ? '?fresh=true' : ''}`);
      if (healthRes.ok) {
        const hJson = await healthRes.json();
        setHealthData(hJson.data);
      }

      // 2. Open Incidents
      const openIncRes = await fetchWithAuth('/api/ops/incidents?status=open');
      if (openIncRes.ok) {
        const incJson = await openIncRes.json();
        setIncidents(incJson.incidents || []);
      }

      // 3. Resolved Incidents
      const resIncRes = await fetchWithAuth('/api/ops/incidents?status=resolved&limit=10');
      if (resIncRes.ok) {
        const resJson = await resIncRes.json();
        setResolvedIncidents(resJson.incidents || []);
      }

      // 4. Wallet audit
      const auditRes = await fetchWithAuth('/api/ops/campaigns/wallet-audit');
      if (auditRes.ok) {
        const aJson = await auditRes.json();
        setWalletAudit(aJson.wallets || []);
      }
    } catch (err) {
      if (err.message === 'UNAUTHORIZED_OPS') {
        setAuthError('Authentication failed: Invalid OPS_API_KEY.');
        setApiKey('');
      } else {
        setErrorMsg(err.message || 'Failed to fetch operations data.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [apiKey, fetchWithAuth]);

  // Initial load and 30s auto-refresh
  useEffect(() => {
    if (apiKey) {
      loadDashboardData();
      const interval = setInterval(() => loadDashboardData(true), 30000);
      return () => clearInterval(interval);
    }
  }, [apiKey, loadDashboardData]);

  const handleKeySubmit = (e) => {
    e.preventDefault();
    if (!tempKey.trim()) return;
    const clean = tempKey.trim();
    if (rememberKey) {
      localStorage.setItem('cp_ops_api_key', clean);
    } else {
      sessionStorage.setItem('cp_ops_api_key', clean);
    }
    setAuthError('');
    setApiKey(clean);
  };

  const handleLogout = () => {
    localStorage.removeItem('cp_ops_api_key');
    sessionStorage.removeItem('cp_ops_api_key');
    setApiKey('');
    setHealthData(null);
  };

  const handleAcknowledge = async (incidentId) => {
    try {
      const res = await fetchWithAuth(`/api/ops/incidents/${incidentId}/acknowledge`, {
        method: 'POST',
      });
      if (res.ok) {
        await loadDashboardData(true);
      }
    } catch (err) {
      window.alert(`Failed to acknowledge incident: ${err.message}`);
    }
  };

  const handleOpenRunbook = (incident) => {
    setSelectedIncident(incident);
    setExecutionResult(null);
    setActiveRunbookModal(true);
  };

  const handleExecuteRunbook = async () => {
    if (!selectedIncident) return;
    setRunbookExecuting(true);
    try {
      const res = await fetchWithAuth(`/api/ops/runbooks/${selectedIncident.id}/execute`, {
        method: 'POST',
      });
      if (res.ok) {
        const json = await res.json();
        setExecutionResult(json.execution);
        await loadDashboardData(true);
      } else {
        const errJson = await res.json();
        window.alert(`Runbook execution failed: ${errJson.error?.message || 'Unknown error'}`);
      }
    } catch (err) {
      window.alert(`Runbook error: ${err.message}`);
    } finally {
      setRunbookExecuting(false);
    }
  };

  const handleApproveWalletFunding = async (campaignId) => {
    try {
      const res = await fetchWithAuth(`/api/ops/campaigns/wallet-audit/${campaignId}/approve-funding`, {
        method: 'POST',
      });
      if (res.ok) {
        const json = await res.json();
        window.alert(json.message);
        await loadDashboardData(true);
      }
    } catch (err) {
      window.alert(`Failed to approve funding: ${err.message}`);
    }
  };

  const handleOpenHistory = async (metricName) => {
    setHistoryMetric(metricName);
    setHistoryModalOpen(true);
    setHistoryLoading(true);
    try {
      const res = await fetchWithAuth(`/api/ops/metrics/history?metric=${metricName}&limit=50`);
      if (res.ok) {
        const json = await res.json();
        const formatted = (json.history || []).map((h) => ({
          time: new Date(h.collected_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          value: parseFloat(h.metric_value),
        }));
        setHistoryData(formatted);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setHistoryLoading(false);
    }
  };

  // Auth Key Screen
  if (!apiKey) {
    return (
      <div style={styles.authContainer}>
        <div style={styles.authCard}>
          <div style={styles.authHeader}>
            <div style={styles.authBadge}>SECURITY GATED</div>
            <h2 style={styles.authTitle}>Operations Centre</h2>
            <p style={styles.authSubtitle}>
              Please enter your <code>OPS_API_KEY</code> to access real-time system health, incident response, and automated runbooks.
            </p>
          </div>

          {authError && <div style={styles.errorAlert}>{authError}</div>}

          <form onSubmit={handleKeySubmit} style={styles.authForm}>
            <div style={styles.formGroup}>
              <label style={styles.label}>Operations API Key</label>
              <input
                type="password"
                value={tempKey}
                onChange={(e) => setTempKey(e.target.value)}
                placeholder="Enter key (e.g. ops_secret_dev_key)"
                required
                style={styles.input}
              />
            </div>

            <div style={styles.checkboxRow}>
              <input
                type="checkbox"
                id="rememberKey"
                checked={rememberKey}
                onChange={(e) => setRememberKey(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <label htmlFor="rememberKey" style={{ fontSize: '0.85rem', color: '#94a3b8', cursor: 'pointer' }}>
                Remember key in this browser session
              </label>
            </div>

            <button type="submit" style={styles.primaryBtn}>
              Unlock Operations Centre
            </button>
          </form>
        </div>
      </div>
    );
  }

  const score = healthData?.system_health_score ?? 100;
  const scoreColor = score >= 85 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';

  return (
    <div style={styles.pageContainer}>
      {/* Header */}
      <div style={styles.headerRow}>
        <div>
          <div style={styles.tagline}>OPERATIONAL TELEMETRY & INCIDENT RESPONSE</div>
          <h1 style={styles.pageTitle}>System Health & Operations Centre</h1>
        </div>

        <div style={styles.headerActions}>
          <button
            onClick={() => loadDashboardData(true)}
            disabled={refreshing}
            style={styles.refreshBtn}
          >
            {refreshing ? 'Refreshing...' : '↻ Refresh Telemetry'}
          </button>
          <button onClick={handleLogout} style={styles.secondaryBtn}>
            Lock / Change Key
          </button>
        </div>
      </div>

      {errorMsg && <div style={styles.errorAlert}>{errorMsg}</div>}

      {/* Main Health Score Gauge & Top Stats */}
      <div style={styles.overviewGrid}>
        <div style={styles.scoreCard}>
          <div style={styles.scoreGaugeContainer}>
            <div style={{ ...styles.scoreGauge, borderColor: scoreColor }}>
              <span style={{ ...styles.scoreValue, color: scoreColor }}>{score}</span>
              <span style={styles.scoreLabel}>/ 100</span>
            </div>
          </div>
          <div style={styles.scoreMeta}>
            <div style={{ ...styles.statusPill, backgroundColor: `${scoreColor}22`, color: scoreColor }}>
              {score >= 85 ? 'SYSTEM OPERATIONAL' : score >= 60 ? 'DEGRADED PERFORMANCE' : 'CRITICAL INCIDENTS'}
            </div>
            <div style={styles.lastCollected}>
              Last collection:{' '}
              {healthData?.collected_at
                ? new Date(healthData.collected_at).toLocaleTimeString()
                : 'Just now'}
            </div>
          </div>
        </div>

        {/* Subsystem Telemetry Cards */}
        <div
          style={styles.telemetryCard}
          onClick={() => handleOpenHistory('horizon_testnet_latency_ms')}
          title="Click to view latency history"
        >
          <div style={styles.cardHeader}>
            <span style={styles.cardTitle}>Horizon Node Health</span>
            <span style={{ ...styles.badge, backgroundColor: healthData?.horizon?.testnet?.ok ? '#10b98122' : '#ef444422', color: healthData?.horizon?.testnet?.ok ? '#10b981' : '#ef4444' }}>
              {healthData?.horizon?.testnet?.ok ? 'ONLINE' : 'DOWN'}
            </span>
          </div>
          <div style={styles.metricVal}>
            {healthData?.horizon?.testnet?.latency_ms ?? 0} <span style={styles.metricUnit}>ms</span>
          </div>
          <div style={styles.cardDetail}>
            Ledger staleness: <strong>{healthData?.horizon?.ledger?.staleness_seconds ?? 0}s</strong>
          </div>
          <div style={styles.sparkHint}>📈 Click to view 24h latency chart</div>
        </div>

        <div style={styles.telemetryCard}>
          <div style={styles.cardHeader}>
            <span style={styles.cardTitle}>SSE Payment Streams</span>
            <span style={styles.badgeNeutral}>
              {healthData?.sse_streams?.active_connections ?? 0} ACTIVE
            </span>
          </div>
          <div style={styles.metricVal}>
            {healthData?.sse_streams?.dropped_count === 0 ? '0' : healthData?.sse_streams?.dropped_count}
            <span style={styles.metricUnit}> dropped</span>
          </div>
          <div style={styles.cardDetail}>
            Monitored campaigns: <strong>{healthData?.sse_streams?.total_monitored ?? 0}</strong>
          </div>
        </div>

        <div style={styles.telemetryCard}>
          <div style={styles.cardHeader}>
            <span style={styles.cardTitle}>Platform Co-Signer</span>
            <span
              style={{
                ...styles.badge,
                backgroundColor: (healthData?.platform_wallet?.balance_xlm ?? 0) >= 10 ? '#10b98122' : '#ef444422',
                color: (healthData?.platform_wallet?.balance_xlm ?? 0) >= 10 ? '#10b981' : '#ef4444',
              }}
            >
              {(healthData?.platform_wallet?.balance_xlm ?? 0) >= 10 ? 'HEALTHY' : 'LOW BALANCE'}
            </span>
          </div>
          <div style={styles.metricVal}>
            {healthData?.platform_wallet?.balance_xlm?.toFixed(2) ?? '0.00'}{' '}
            <span style={styles.metricUnit}>XLM</span>
          </div>
          <div style={styles.cardDetail}>
            Pending txs: <strong>{healthData?.platform_wallet?.pending_transactions_count ?? 0}</strong> (Est. needed: {healthData?.platform_wallet?.estimated_xlm_needed ?? 0} XLM)
          </div>
        </div>
      </div>

      {/* Incidents & Remediation Section */}
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>Incident Management & Runbooks</h2>
        <div style={styles.tabSwitch}>
          <button
            onClick={() => setIncidentTab('open')}
            style={incidentTab === 'open' ? styles.tabActive : styles.tabInactive}
          >
            Active Incidents ({incidents.length})
          </button>
          <button
            onClick={() => setIncidentTab('resolved')}
            style={incidentTab === 'resolved' ? styles.tabActive : styles.tabInactive}
          >
            Resolved (Last 24h: {resolvedIncidents.length})
          </button>
        </div>
      </div>

      {incidentTab === 'open' ? (
        incidents.length === 0 ? (
          <div style={styles.emptyState}>
            <div style={{ fontSize: '2rem', marginBottom: '8px' }}>✨</div>
            <div style={{ fontWeight: '600', color: '#10b981' }}>All Systems Nominal</div>
            <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No open incidents or threshold violations detected.</p>
          </div>
        ) : (
          <div style={styles.incidentList}>
            {incidents.map((inc) => (
              <div key={inc.id} style={styles.incidentCard}>
                <div style={styles.incidentHeader}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span
                      style={{
                        ...styles.severityTag,
                        backgroundColor: inc.severity === 'critical' ? '#ef4444' : '#f59e0b',
                      }}
                    >
                      {inc.severity.toUpperCase()}
                    </span>
                    <span style={styles.incidentType}>{inc.incident_type}</span>
                  </div>
                  <span style={styles.incidentTime}>
                    Detected: {new Date(inc.triggered_at).toLocaleTimeString()}
                  </span>
                </div>

                <div style={styles.incidentBody}>
                  <p style={styles.incidentMsg}>
                    {inc.details?.message || JSON.stringify(inc.triggering_metric_values)}
                  </p>
                </div>

                <div style={styles.incidentActions}>
                  {inc.status === 'open' && (
                    <button
                      onClick={() => handleAcknowledge(inc.id)}
                      style={styles.ackBtn}
                    >
                      ✓ Acknowledge
                    </button>
                  )}
                  <button
                    onClick={() => handleOpenRunbook(inc)}
                    style={styles.runbookBtn}
                  >
                    ⚡ Execute Runbook
                  </button>
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        <div style={styles.resolvedList}>
          {resolvedIncidents.length === 0 ? (
            <div style={styles.emptyState}>No resolved incidents in the past 24 hours.</div>
          ) : (
            resolvedIncidents.map((res) => (
              <div key={res.id} style={styles.resolvedRow}>
                <div>
                  <span style={{ fontWeight: '600', color: '#94a3b8' }}>{res.incident_type}</span>
                  <span style={{ marginLeft: '10px', fontSize: '0.8rem', color: '#64748b' }}>
                    Resolved at {new Date(res.resolved_at).toLocaleTimeString()}
                  </span>
                </div>
                <div style={{ fontSize: '0.85rem', color: '#10b981' }}>
                  Duration: {res.duration_seconds ? `${res.duration_seconds}s` : '< 1m'}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Campaign Wallet Reserve Audit Table */}
      <div style={styles.sectionHeader}>
        <div>
          <h2 style={styles.sectionTitle}>Campaign Wallet Reserve Audit</h2>
          <p style={styles.sectionDesc}>
            Enforces Stellar base reserve formula: <code>2 * base_reserve + trustlines * 0.5 XLM</code>
          </p>
        </div>
      </div>

      <div style={styles.tableCard}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Campaign</th>
              <th style={styles.th}>Wallet Public Key</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Current Balance</th>
              <th style={styles.th}>Min. Required</th>
              <th style={styles.th}>Deficit</th>
              <th style={styles.th}>Health</th>
              <th style={styles.th}>Action</th>
            </tr>
          </thead>
          <tbody>
            {walletAudit.length === 0 ? (
              <tr>
                <td colSpan="8" style={{ ...styles.td, textAlign: 'center', color: '#94a3b8' }}>
                  No active campaign wallets currently found.
                </td>
              </tr>
            ) : (
              walletAudit.map((w) => (
                <tr key={w.campaign_id} style={w.deficit_xlm > 0 ? styles.tableRowWarning : {}}>
                  <td style={styles.td}>
                    <strong>{w.campaign_title || 'Untitled Campaign'}</strong>
                  </td>
                  <td style={styles.td}>
                    <code style={styles.code}>{w.wallet_public_key?.slice(0, 10)}...</code>
                  </td>
                  <td style={styles.td}>{w.campaign_status}</td>
                  <td style={styles.td}>{w.balance_xlm.toFixed(4)} XLM</td>
                  <td style={styles.td}>{w.min_required_xlm.toFixed(4)} XLM</td>
                  <td style={{ ...styles.td, color: w.deficit_xlm > 0 ? '#ef4444' : '#10b981', fontWeight: 'bold' }}>
                    {w.deficit_xlm > 0 ? `-${w.deficit_xlm.toFixed(7)} XLM` : '0.0000000'}
                  </td>
                  <td style={styles.td}>
                    <span
                      style={{
                        ...styles.statusBadge,
                        backgroundColor: w.health === 'ok' ? '#10b98122' : '#ef444422',
                        color: w.health === 'ok' ? '#10b981' : '#ef4444',
                      }}
                    >
                      {w.health.toUpperCase()}
                    </span>
                  </td>
                  <td style={styles.td}>
                    {w.deficit_xlm > 0 ? (
                      <button
                        onClick={() => handleApproveWalletFunding(w.campaign_id)}
                        style={styles.fundingBtn}
                      >
                        Approve Funding
                      </button>
                    ) : (
                      <span style={{ color: '#64748b', fontSize: '0.85rem' }}>Compliant</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Runbook Modal */}
      {activeRunbookModal && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalCard}>
            <div style={styles.modalHeader}>
              <div>
                <h3 style={styles.modalTitle}>Automated Runbook Remediation</h3>
                <p style={styles.modalSubtitle}>Incident: {selectedIncident?.incident_type}</p>
              </div>
              <button onClick={() => setActiveRunbookModal(false)} style={styles.closeBtn}>
                ✕
              </button>
            </div>

            <div style={styles.modalContent}>
              {!executionResult && !runbookExecuting && (
                <div>
                  <p style={{ color: '#cbd5e1', marginBottom: '16px' }}>
                    Triggering this runbook will execute automated diagnostics, safe operational locks, and state recovery.
                  </p>
                  <button onClick={handleExecuteRunbook} style={styles.primaryBtn}>
                    Start Runbook Execution
                  </button>
                </div>
              )}

              {runbookExecuting && (
                <div style={{ textAlign: 'center', padding: '24px 0' }}>
                  <div style={{ color: '#38bdf8', marginBottom: '10px' }}>⚡ Executing runbook steps in real-time...</div>
                  <div style={styles.spinner} />
                </div>
              )}

              {executionResult && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <span style={{ fontWeight: '600', color: '#f8fafc' }}>
                      Execution Status:{' '}
                      <span style={{ color: executionResult.status === 'completed' ? '#10b981' : '#f59e0b' }}>
                        {executionResult.status.toUpperCase()}
                      </span>
                    </span>
                    <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                      Finished at {new Date(executionResult.completed_at).toLocaleTimeString()}
                    </span>
                  </div>

                  <div style={styles.stepTimeline}>
                    {executionResult.steps?.map((step, idx) => (
                      <div key={idx} style={styles.stepItem}>
                        <div style={styles.stepHeader}>
                          <span style={styles.stepName}>{step.name}</span>
                          <span
                            style={{
                              ...styles.stepStatusBadge,
                              backgroundColor: step.status === 'completed' ? '#10b98122' : '#f59e0b22',
                              color: step.status === 'completed' ? '#10b981' : '#f59e0b',
                            }}
                          >
                            {step.status}
                          </span>
                        </div>
                        <div style={styles.stepLog}>{step.log}</div>
                      </div>
                    ))}
                  </div>

                  {executionResult.status === 'requires_manual_action' && (
                    <div style={styles.manualActionBox}>
                      <strong>Action Required:</strong>
                      <p style={{ margin: '6px 0 0 0' }}>
                        {executionResult.result?.action_required || 'Manual operator confirmation required.'}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div style={styles.modalFooter}>
              <button onClick={() => setActiveRunbookModal(false)} style={styles.secondaryBtn}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* History Modal */}
      {historyModalOpen && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalCard}>
            <div style={styles.modalHeader}>
              <div>
                <h3 style={styles.modalTitle}>Metric Telemetry History</h3>
                <p style={styles.modalSubtitle}>{historyMetric}</p>
              </div>
              <button onClick={() => setHistoryModalOpen(false)} style={styles.closeBtn}>
                ✕
              </button>
            </div>

            <div style={{ padding: '16px', height: '300px' }}>
              {historyLoading ? (
                <div style={{ textAlign: 'center', paddingTop: '100px', color: '#94a3b8' }}>Loading time-series...</div>
              ) : historyData.length === 0 ? (
                <div style={{ textAlign: 'center', paddingTop: '100px', color: '#94a3b8' }}>
                  No historical data recorded yet for this metric.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={historyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="time" stroke="#94a3b8" />
                    <YAxis stroke="#94a3b8" />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1e293b', borderColor: '#475569', color: '#f8fafc' }}
                    />
                    <Line type="monotone" dataKey="value" stroke="#38bdf8" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            <div style={styles.modalFooter}>
              <button onClick={() => setHistoryModalOpen(false)} style={styles.secondaryBtn}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  pageContainer: {
    padding: '32px',
    maxWidth: '1300px',
    margin: '0 auto',
    color: '#f8fafc',
  },
  headerRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '28px',
  },
  tagline: {
    fontSize: '0.75rem',
    fontWeight: '700',
    letterSpacing: '1px',
    color: '#38bdf8',
    marginBottom: '4px',
  },
  pageTitle: {
    fontSize: '1.75rem',
    fontWeight: '800',
    margin: 0,
    color: '#f8fafc',
  },
  headerActions: {
    display: 'flex',
    gap: '12px',
  },
  refreshBtn: {
    backgroundColor: '#0284c7',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    padding: '8px 16px',
    fontSize: '0.85rem',
    fontWeight: '600',
    cursor: 'pointer',
  },
  secondaryBtn: {
    backgroundColor: '#334155',
    color: '#e2e8f0',
    border: 'none',
    borderRadius: '8px',
    padding: '8px 16px',
    fontSize: '0.85rem',
    cursor: 'pointer',
  },
  primaryBtn: {
    backgroundColor: '#0284c7',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    padding: '10px 18px',
    fontSize: '0.9rem',
    fontWeight: '600',
    cursor: 'pointer',
    width: '100%',
  },
  overviewGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: '16px',
    marginBottom: '32px',
  },
  scoreCard: {
    backgroundColor: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '12px',
    padding: '20px',
    display: 'flex',
    alignItems: 'center',
    gap: '18px',
  },
  scoreGaugeContainer: {
    flexShrink: 0,
  },
  scoreGauge: {
    width: '80px',
    height: '80px',
    borderRadius: '50%',
    borderWidth: '5px',
    borderStyle: 'solid',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0f172a',
  },
  scoreValue: {
    fontSize: '1.6rem',
    fontWeight: '800',
    lineHeight: 1,
  },
  scoreLabel: {
    fontSize: '0.65rem',
    color: '#94a3b8',
  },
  scoreMeta: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  statusPill: {
    padding: '3px 8px',
    borderRadius: '6px',
    fontSize: '0.7rem',
    fontWeight: '700',
    display: 'inline-block',
  },
  lastCollected: {
    fontSize: '0.75rem',
    color: '#94a3b8',
  },
  telemetryCard: {
    backgroundColor: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '12px',
    padding: '18px',
    cursor: 'pointer',
    transition: 'transform 0.15s ease',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
  },
  cardTitle: {
    fontSize: '0.85rem',
    color: '#94a3b8',
    fontWeight: '600',
  },
  metricVal: {
    fontSize: '1.5rem',
    fontWeight: '800',
    color: '#f8fafc',
    marginBottom: '6px',
  },
  metricUnit: {
    fontSize: '0.85rem',
    fontWeight: '400',
    color: '#94a3b8',
  },
  cardDetail: {
    fontSize: '0.75rem',
    color: '#64748b',
  },
  sparkHint: {
    marginTop: '6px',
    fontSize: '0.7rem',
    color: '#38bdf8',
  },
  badge: {
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '0.7rem',
    fontWeight: '700',
  },
  badgeNeutral: {
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '0.7rem',
    fontWeight: '700',
    backgroundColor: '#334155',
    color: '#cbd5e1',
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
  },
  sectionTitle: {
    fontSize: '1.2rem',
    fontWeight: '700',
    margin: 0,
    color: '#f8fafc',
  },
  sectionDesc: {
    fontSize: '0.8rem',
    color: '#94a3b8',
    margin: '2px 0 0 0',
  },
  tabSwitch: {
    display: 'flex',
    backgroundColor: '#1e293b',
    borderRadius: '8px',
    padding: '3px',
    border: '1px solid #334155',
  },
  tabActive: {
    backgroundColor: '#0284c7',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    padding: '6px 12px',
    fontSize: '0.8rem',
    fontWeight: '600',
    cursor: 'pointer',
  },
  tabInactive: {
    backgroundColor: 'transparent',
    color: '#94a3b8',
    border: 'none',
    borderRadius: '6px',
    padding: '6px 12px',
    fontSize: '0.8rem',
    cursor: 'pointer',
  },
  emptyState: {
    backgroundColor: '#1e293b',
    border: '1px dashed #334155',
    borderRadius: '12px',
    padding: '32px',
    textAlign: 'center',
    marginBottom: '32px',
  },
  incidentList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    marginBottom: '32px',
  },
  incidentCard: {
    backgroundColor: '#1e293b',
    border: '1px solid #334155',
    borderLeft: '4px solid #ef4444',
    borderRadius: '8px',
    padding: '16px',
  },
  incidentHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '8px',
  },
  severityTag: {
    color: '#fff',
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '0.65rem',
    fontWeight: '800',
  },
  incidentType: {
    fontWeight: '700',
    fontSize: '0.95rem',
    color: '#f8fafc',
  },
  incidentTime: {
    fontSize: '0.75rem',
    color: '#94a3b8',
  },
  incidentBody: {
    marginBottom: '12px',
  },
  incidentMsg: {
    fontSize: '0.85rem',
    color: '#cbd5e1',
    margin: 0,
  },
  incidentActions: {
    display: 'flex',
    gap: '10px',
  },
  ackBtn: {
    backgroundColor: '#334155',
    color: '#f8fafc',
    border: 'none',
    borderRadius: '6px',
    padding: '6px 12px',
    fontSize: '0.8rem',
    cursor: 'pointer',
  },
  runbookBtn: {
    backgroundColor: '#f59e0b',
    color: '#000',
    border: 'none',
    borderRadius: '6px',
    padding: '6px 12px',
    fontSize: '0.8rem',
    fontWeight: '700',
    cursor: 'pointer',
  },
  resolvedList: {
    backgroundColor: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '8px',
    padding: '12px 16px',
    marginBottom: '32px',
  },
  resolvedRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 0',
    borderBottom: '1px solid #334155',
  },
  tableCard: {
    backgroundColor: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '12px',
    overflow: 'hidden',
    marginBottom: '32px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    textAlign: 'left',
    fontSize: '0.85rem',
  },
  th: {
    backgroundColor: '#0f172a',
    padding: '12px 16px',
    color: '#94a3b8',
    fontWeight: '600',
    borderBottom: '1px solid #334155',
  },
  td: {
    padding: '12px 16px',
    borderBottom: '1px solid #334155',
    color: '#cbd5e1',
  },
  tableRowWarning: {
    backgroundColor: '#450a0a22',
  },
  code: {
    backgroundColor: '#0f172a',
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '0.75rem',
    color: '#38bdf8',
  },
  statusBadge: {
    padding: '3px 6px',
    borderRadius: '4px',
    fontSize: '0.7rem',
    fontWeight: '700',
  },
  fundingBtn: {
    backgroundColor: '#10b981',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    padding: '4px 10px',
    fontSize: '0.75rem',
    fontWeight: '600',
    cursor: 'pointer',
  },
  authContainer: {
    minHeight: '80vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '20px',
  },
  authCard: {
    backgroundColor: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '16px',
    padding: '36px',
    maxWidth: '440px',
    width: '100%',
  },
  authHeader: {
    textAlign: 'center',
    marginBottom: '24px',
  },
  authBadge: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '0.65rem',
    fontWeight: '800',
    backgroundColor: '#f59e0b22',
    color: '#f59e0b',
    marginBottom: '8px',
  },
  authTitle: {
    fontSize: '1.4rem',
    fontWeight: '800',
    margin: '0 0 6px 0',
  },
  authSubtitle: {
    fontSize: '0.85rem',
    color: '#94a3b8',
    lineHeight: 1.4,
    margin: 0,
  },
  authForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  label: {
    fontSize: '0.8rem',
    fontWeight: '600',
    color: '#cbd5e1',
  },
  input: {
    backgroundColor: '#0f172a',
    border: '1px solid #334155',
    borderRadius: '8px',
    padding: '10px 14px',
    color: '#f8fafc',
    fontSize: '0.9rem',
    outline: 'none',
  },
  checkboxRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  errorAlert: {
    backgroundColor: '#ef444422',
    border: '1px solid #ef4444',
    color: '#fca5a5',
    padding: '10px 14px',
    borderRadius: '8px',
    fontSize: '0.85rem',
    marginBottom: '16px',
  },
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '20px',
    zIndex: 9999,
  },
  modalCard: {
    backgroundColor: '#1e293b',
    border: '1px solid #475569',
    borderRadius: '16px',
    maxWidth: '600px',
    width: '100%',
    overflow: 'hidden',
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: '20px',
    borderBottom: '1px solid #334155',
  },
  modalTitle: {
    fontSize: '1.1rem',
    fontWeight: '700',
    margin: 0,
  },
  modalSubtitle: {
    fontSize: '0.8rem',
    color: '#94a3b8',
    margin: '2px 0 0 0',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#94a3b8',
    fontSize: '1.1rem',
    cursor: 'pointer',
  },
  modalContent: {
    padding: '20px',
    maxHeight: '400px',
    overflowY: 'auto',
  },
  modalFooter: {
    padding: '14px 20px',
    borderTop: '1px solid #334155',
    display: 'flex',
    justifyContent: 'flex-end',
  },
  stepTimeline: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    marginBottom: '16px',
  },
  stepItem: {
    backgroundColor: '#0f172a',
    borderRadius: '8px',
    padding: '10px 14px',
    border: '1px solid #334155',
  },
  stepHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '4px',
  },
  stepName: {
    fontSize: '0.85rem',
    fontWeight: '700',
    color: '#f8fafc',
  },
  stepStatusBadge: {
    padding: '1px 6px',
    borderRadius: '4px',
    fontSize: '0.65rem',
    fontWeight: '700',
  },
  stepLog: {
    fontSize: '0.75rem',
    color: '#94a3b8',
    fontFamily: 'monospace',
  },
  manualActionBox: {
    backgroundColor: '#78350f33',
    border: '1px solid #f59e0b',
    borderRadius: '8px',
    padding: '12px',
    fontSize: '0.85rem',
    color: '#fef3c7',
  },
  spinner: {
    width: '24px',
    height: '24px',
    border: '3px solid #334155',
    borderTopColor: '#38bdf8',
    borderRadius: '50%',
    margin: '0 auto',
    animation: 'spin 1s linear infinite',
  },
};
