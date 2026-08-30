const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const BASE = `${API_BASE_URL}/api`;
let refreshPromise = null;
const retryQueue = [];

// --- CSRF double-submit cookie helpers ---
function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)cp_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

const IDEMPOTENT_METHODS = new Set(['GET']);

function isNetworkError(err) {
  return err instanceof TypeError;
}

export function retryQueuedRequests() {
  const queue = [...retryQueue];
  retryQueue.length = 0;
  for (const item of queue) {
    const { method, path, body, options, resolve, reject } = item;
    request(method, path, body, options)
      .then(resolve)
      .catch((err) => {
        if (isNetworkError(err)) {
          retryQueue.push(item);
        } else {
          reject(err);
        }
      });
  }
}

const TIMEOUTS = {
  GET: 10_000, // 10 s
  POST: 20_000, // 20 s — Stellar submissions can be slow
  PATCH: 15_000,
  DELETE: 10_000,
};

function jsonHeaders() {
  const headers = {
    'Content-Type': 'application/json',
  };
  const csrf = getCsrfToken();
  if (csrf) headers['X-CSRF-Token'] = csrf;
  return headers;
}

async function request(method, path, body, options = {}) {
  const { query, _retry = false } = options || {};
  let url = `${BASE}${path}`;

  // Ensure CSRF cookie exists before state-changing requests
  if (method !== 'GET' && method !== 'HEAD' && !getCsrfToken()) {
    try {
      await fetch(`${BASE}/auth/csrf-token`, { credentials: 'include' });
    } catch { /* best-effort */ }
  }

  if (query && Object.keys(query).length) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    });
    url += `?${params.toString()}`;
  }

  const controller = new AbortController();
  const timeoutMs = TIMEOUTS[method] ?? 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? jsonHeaders() : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out. Check your connection and try again.');
    }
    if (isNetworkError(err)) {
      if (IDEMPOTENT_METHODS.has(method)) {
        return new Promise((resolve, reject) => {
          retryQueue.push({ method, path, body, options, resolve, reject });
        });
      }
      throw new Error('You appear to be offline. Please check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Unexpected server response. Please try again.');
    }
  }

  const publicAuthPaths = [
    '/auth/refresh',
    '/auth/login',
    '/auth/forgot-password',
    '/auth/reset-password',
  ];

  if (res.status === 401 && !_retry && !publicAuthPaths.includes(path)) {
    const promise = refresh();
    if (promise) {
      try {
        await promise;
        return request(method, path, body, { ...options, _retry: true });
      } catch {
        throw new Error('Session expired. Please log in again.');
      }
    }
  }

  if (!res.ok) {
    const errorBody = data.error;
    const message =
      typeof errorBody === 'string'
        ? errorBody
        : errorBody?.message || `Request failed (${res.status})`;

    const err = new Error(message);
    err.status = res.status;

    if (errorBody && typeof errorBody === 'object') {
      err.code = errorBody.code;
      err.fields = errorBody.fields;
    }
    // Some routes return { error: 'message', code: '...' } (flat) instead of
    // { error: { message, code } } (nested) — fall back to the top-level code.
    err.code = err.code || data.code;

    throw err;
  }

  return data;
}

async function uploadFormData(path, formData) {
  const url = `${BASE}${path}`;

  // Ensure CSRF cookie exists before state-changing requests
  if (!getCsrfToken()) {
    try {
      await fetch(`${BASE}/auth/csrf-token`, { credentials: 'include' });
    } catch { /* best-effort */ }
  }

  const csrfHeaders = {};
  const csrf = getCsrfToken();
  if (csrf) csrfHeaders['X-CSRF-Token'] = csrf;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers: csrfHeaders,
    });
  } catch (err) {
    if (isNetworkError(err)) {
      throw new Error('You appear to be offline. Please check your connection and try again.');
    }
    throw err;
  }

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Unexpected server response. Please try again.');
    }
  }

  if (!res.ok) {
    const errorBody = data.error;
    const message =
      typeof errorBody === 'string'
        ? errorBody
        : errorBody?.message || `Request failed (${res.status})`;

    const err = new Error(message);
    err.status = res.status;

    if (errorBody && typeof errorBody === 'object') {
      err.code = errorBody.code;
      err.fields = errorBody.fields;
    }
    // Some routes return { error: 'message', code: '...' } (flat) instead of
    // { error: { message, code } } (nested) — fall back to the top-level code.
    err.code = err.code || data.code;

    throw err;
  }

  return data;
}

async function refresh() {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const refreshHeaders = {};
    const csrf = getCsrfToken();
    if (csrf) refreshHeaders['X-CSRF-Token'] = csrf;

    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: refreshHeaders,
    });

    if (!res.ok) {
      const text = await res.text();
      let error = 'Refresh failed';
      try {
        const data = JSON.parse(text);
        error = data.error || error;
      } catch (_err) {
        // ignore
      }
      refreshPromise = null;
      throw new Error(error);
    }

    const data = await res.json();
    refreshPromise = null;
    return data;
  })();

  return refreshPromise;
}

function parseDownloadFilename(disposition, fallback) {
  if (!disposition) return fallback;

  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].replace(/^"|"$/g, ''));
    } catch {
      return utf8Match[1].replace(/^"|"$/g, '') || fallback;
    }
  }

  const match = disposition.match(/filename="?([^";]+)"?/i);
  return match?.[1] || fallback;
}

async function downloadFile(path, fallbackFilename, options = {}) {
  const { _retry = false } = options || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'GET',
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Download timed out. Check your connection and try again.');
    }
    if (isNetworkError(err)) {
      throw new Error('You appear to be offline. Please check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 && !_retry) {
    try {
      await refresh();
      return downloadFile(path, fallbackFilename, { _retry: true });
    } catch {
      throw new Error('Session expired. Please log in again.');
    }
  }

  if (!res.ok) {
    const text = await res.text();
    let message = `Download failed (${res.status})`;
    try {
      const data = JSON.parse(text);
      const errorBody = data.error;
      message = typeof errorBody === 'string' ? errorBody : errorBody?.message || message;
    } catch {
      if (text) message = text;
    }

    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  return {
    blob: await res.blob(),
    filename: parseDownloadFilename(res.headers.get('content-disposition'), fallbackFilename),
  };
}

async function logout() {
  const logoutHeaders = {};
  const csrf = getCsrfToken();
  if (csrf) logoutHeaders['X-CSRF-Token'] = csrf;

  const res = await fetch(`${BASE}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
    headers: logoutHeaders,
  });

  if (!res.ok) {
    const text = await res.text();
    let error = 'Logout failed';
    try {
      const data = JSON.parse(text);
      error = data.error || error;
    } catch (_err) {
      /* ignore */
    }
    throw new Error(error);
  }

  return { message: 'Logged out' };
}

export const api = {
  getPlatformConfig: () => request('GET', '/config'),
  getActiveAnnouncements: () => request('GET', '/announcements/active'),

  register: (body) => request('POST', '/auth/register', body),
  login: (body) => request('POST', '/auth/login', body),
  login2FA: (body) => request('POST', '/auth/2fa/challenge', body),
  setup2FA: () => request('POST', '/auth/2fa/setup'),
  verify2FA: (body) => request('POST', '/auth/2fa/verify', body),
  forgotPassword: (body) => request('POST', '/auth/forgot-password', body),
  resetPassword: (body) => request('POST', '/auth/reset-password', body),
  logout: () => logout(),
  refresh,

  getMe: () => request('GET', '/users/me'),
  getMyBalance: () => request('GET', '/users/me/balance'),
  getMyStats: () => request('GET', '/users/me/stats'),
  getMyContributions: () => request('GET', '/contributions/mine'),
  startKyc: () => request('POST', '/auth/kyc/start'),
  getKycStatus: () => request('GET', '/auth/kyc/status'),

  saveCampaignDraft: (body) => request('POST', '/campaigns/drafts', body),
  getMyCampaignDraft: () => request('GET', '/campaigns/drafts/my'),
  deleteCampaignDraft: (id) => request('DELETE', `/campaigns/drafts/${id}`),

  getMyCampaigns: (options = {}) => request('GET', '/campaigns/mine', null, { query: options }),
  getFeaturedCampaigns: () => request('GET', '/campaigns/featured'),
  getRecommendedCampaigns: (options = {}) =>
    request('GET', '/campaigns/recommended', null, { query: options }),
  getCampaignCategories: () => request('GET', '/campaigns/categories'),
  getCampaignFacets: () => request('GET', '/campaigns/facets'),
  getTrendingCampaigns: (options = {}) =>
  request('GET', '/campaigns/trending', null, { query: options }),
  getCampaigns: (options = {}) => request('GET', '/campaigns', null, { query: options }),
  getCampaign: (id, options = {}) => request('GET', `/campaigns/${id}`, null, { query: options }),
  getCampaignAnalytics: (id) => request('GET', `/campaigns/${id}/analytics`),
  getCampaignAnalyticsContributors: (id) =>
    request('GET', `/campaigns/${id}/analytics/contributors`),
  getCampaignTiers: (id) => request('GET', `/campaigns/${id}/tiers`),
  getMyNftRewards: () => request('GET', '/nft-rewards/me'),
  getCampaignNftRewards: (campaignId) => request('GET', `/nft-rewards/campaign/${encodeURIComponent(campaignId)}`),
  getContributionNftRewards: (contributionId) => request('GET', `/nft-rewards/contributions/${encodeURIComponent(contributionId)}`),
  getCampaignAnalyticsBackers: (id) => request('GET', `/campaigns/${id}/analytics/backers`),
  exportCampaignContributions: (id) =>
    downloadFile(
      `/campaigns/${encodeURIComponent(id)}/contributions/export`,
      `campaign-${id}-contributors.csv`
    ),
  getUserDashboardAnalytics: () => request('GET', '/users/me/dashboard/analytics'),
  getCampaignEmbed: (id) => request('GET', `/campaigns/${id}/embed`),
  getCampaignBackers: (id) => request('GET', `/campaigns/${id}/backers`),
  getCampaignBalance: (id) => request('GET', `/campaigns/${id}/balance`),
  getCloneData: (id) => request('GET', `/campaigns/${id}/clone-data`),
  cloneCampaign: (id) => request('POST', `/campaigns/${id}/clone`, {}),
  publishCampaign: (id) => request('POST', `/campaigns/${id}/publish`, {}),
  scheduleCampaignPublish: (id, body) => request('POST', `/campaigns/${id}/schedule-publish`, body),
  checkDuplicateCampaign: (body) => request('POST', '/campaigns/check-duplicate', body),
  createCampaign: (body) => request('POST', '/campaigns', body),
  getCampaignTemplates: () => request('GET', '/campaign-templates'),
  updateCampaign: (id, body) => request('PATCH', `/campaigns/${id}`, body),
  deleteCampaign: (id) => request('DELETE', `/campaigns/${id}`),
  uploadCampaignCoverImage: (campaignId, file) => {
    const formData = new FormData();
    formData.append('cover_image', file);
    return uploadFormData(`/campaigns/${encodeURIComponent(campaignId)}/cover-image`, formData);
  },

  getCampaignMembers: (campaignId) => request('GET', `/campaigns/${campaignId}/members`),
  inviteCampaignMember: (campaignId, body) =>
    request('POST', `/campaigns/${campaignId}/members/invite`, body),
  resendCampaignInvite: (campaignId, memberId) =>
    request('POST', `/campaigns/${campaignId}/members/${memberId}/resend`),
  cancelCampaignInvite: (campaignId, memberId) =>
    request('DELETE', `/campaigns/${campaignId}/members/invites/${memberId}`),
  getInvitePreview: (token) => request('GET', `/invites/${token}`),
  acceptInviteByToken: (token) => request('POST', `/invites/${token}/accept`, {}),
  updateCampaignMemberRole: (campaignId, userId, body) =>
    request('PATCH', `/campaigns/${campaignId}/members/${userId}`, body),
  removeCampaignMember: (campaignId, userId) =>
    request('DELETE', `/campaigns/${campaignId}/members/${userId}`),
  acceptCampaignInvitation: (campaignId, body) =>
    request('POST', `/campaigns/${campaignId}/members/accept`, body),
  getAnchorInfo: () => request('GET', '/anchor/info'),
  startAnchorDeposit: (body) => request('POST', '/anchor/deposits/start', body),
  getAnchorDepositStatus: (id) => request('GET', `/anchor/deposits/${id}`),
  getSep24Assets: () => request('GET', '/anchor/sep24/assets'),
  startWalletDeposit: (body) => request('POST', '/anchor/sep24/deposit', body),
  getCampaignUpdates: (campaignId, options = {}) =>
    request('GET', `/campaigns/${campaignId}/updates`, null, {
      query: options,
    }),
  postCampaignUpdate: (campaignId, body) =>
    request('POST', `/campaigns/${campaignId}/updates`, body),
  updateCampaignUpdate: (campaignId, updateId, body) =>
    request('PATCH', `/campaigns/${campaignId}/updates/${updateId}`, body),
  deleteCampaignUpdate: (campaignId, updateId) =>
    request('DELETE', `/campaigns/${campaignId}/updates/${updateId}`),

  getCampaignComments: (campaignId) => request('GET', `/campaigns/${campaignId}/comments`),
  postCampaignComment: (campaignId, body) =>
    request('POST', `/campaigns/${campaignId}/comments`, body),
  upvoteCampaignComment: (campaignId, commentId) =>
    request('POST', `/campaigns/${campaignId}/comments/${commentId}/upvote`),
  updateCampaignComment: (campaignId, commentId, body) =>
    request('PATCH', `/campaigns/${campaignId}/comments/${commentId}`, body),
  deleteCampaignComment: (campaignId, commentId) =>
    request('DELETE', `/campaigns/${campaignId}/comments/${commentId}`),
  flagCampaignComment: (campaignId, commentId, body) =>
    request('POST', `/campaigns/${campaignId}/comments/${commentId}/flag`, body),
  getFlaggedCampaignComments: (campaignId) =>
    request('GET', `/campaigns/${campaignId}/comments/moderation`),
  hideCampaignComment: (campaignId, commentId, body) =>
    request('POST', `/campaigns/${campaignId}/comments/${commentId}/hide`, body),
  unhideCampaignComment: (campaignId, commentId) =>
    request('POST', `/campaigns/${campaignId}/comments/${commentId}/unhide`),

  getContributions: (campaignId, options = {}) =>
    request('GET', `/contributions/campaign/${campaignId}`, null, {
      query: options,
    }),
  toggleCampaignVisibility: (id, is_hidden) =>
    request('PATCH', `/campaigns/${id}/visibility`, { is_hidden }),

  getMilestones: (campaignId) => request('GET', `/campaigns/${campaignId}/milestones`),
  setCampaignMilestones: (campaignId, milestones) =>
    request('POST', `/campaigns/${campaignId}/milestones`, { milestones }),
  submitMilestoneEvidence: (id, body) => request('POST', `/milestones/${id}/submit`, body),
  uploadMilestoneEvidence: (id, file) => {
    const formData = new FormData();
    formData.append('evidence_file', file);
    return uploadFormData(`/milestones/${encodeURIComponent(id)}/upload-evidence`, formData);
  },
  getMilestoneEvents: (id) => request('GET', `/milestones/${id}/events`),
  getMilestoneVotes: (id) => request('GET', `/milestones/${id}/votes`),
  voteMilestone: (id, body) => request('POST', `/milestones/${id}/votes`, body || {}),
  approveMilestone: (id, body) => request('POST', `/milestones/${id}/release`, body || {}),
  rejectMilestone: (id, body) => request('POST', `/milestones/${id}/reject`, body || {}),
  contribute: (body, options = {}) => request('POST', '/contributions', body, options),
  prepareContribution: (body, options = {}) =>
    request('POST', '/contributions/prepare', body, options),
  submitSignedContribution: (body) => request('POST', '/contributions/submit-signed', body),
  buildContributionXdr: (body) => request('POST', '/contributions/build-xdr', body),
  guestContribute: (body) => request('POST', '/contributions/guest', body),
  quoteContribution: ({ send_asset, dest_asset, dest_amount }) =>
    request('GET', '/contributions/quote', null, {
      query: { send_asset, dest_asset, dest_amount },
    }),
  getContributionFinalization: (txHash) => request('GET', `/contributions/finalization/${txHash}`),
  failExpiredCampaigns: () => request('POST', '/campaigns/cron/fail-expired'),
  triggerCampaignRefunds: (campaignId) =>
    request('POST', `/campaigns/${campaignId}/trigger-refunds`),
  initiateRefund: (id) => request('POST', `/campaigns/${id}/refund/initiate`, {}),
  approveRefundCreator: (id, body) =>
    request('POST', `/campaigns/${id}/refund/approve/creator`, body || {}),
  approveRefundPlatform: (id) => request('POST', `/campaigns/${id}/refund/approve/platform`, {}),
  requestContributionRefund: (contributionId) =>
    request('POST', `/contributions/${contributionId}/refund`, {}),

  createSubscription: (campaignId, body) =>
    request('POST', `/campaigns/${campaignId}/subscriptions`, body),
  cancelSubscription: (campaignId, subscriptionId) =>
    request('DELETE', `/campaigns/${campaignId}/subscriptions/${subscriptionId}`),
  getMySubscriptions: () => request('GET', '/subscriptions/mine'),

  getContributorDashboard: () => request('GET', '/contributions/dashboard'),
  exportContributionsCsv: () =>
    downloadFile('/contributions/dashboard/export.csv', 'contributions.csv'),
  getTaxReceipts: () => request('GET', '/contributions/tax-receipts'),
  downloadTaxReceiptsPdf: () =>
    downloadFile('/contributions/tax-receipts/download', 'crowdpay-tax-receipts.pdf'),
  downloadTaxReceiptPdf: (id) =>
    downloadFile(
      `/contributions/tax-receipts/${encodeURIComponent(id)}/download`,
      `crowdpay-tax-receipt-${id}.pdf`
    ),

  getFavorites: () => request('GET', '/users/me/favorites'),
  addFavorite: (campaignId) => request('POST', `/campaigns/${campaignId}/favorite`, {}),
  removeFavorite: (campaignId) => request('DELETE', `/campaigns/${campaignId}/favorite`),

  getCampaignFollow: (campaignId) => request('GET', `/campaigns/${campaignId}/follow`),
  followCampaign: (campaignId, preferences) =>
    request('POST', `/campaigns/${campaignId}/follow`, preferences || {}),
  updateCampaignFollow: (campaignId, preferences) =>
    request('PATCH', `/campaigns/${campaignId}/follow`, preferences),
  unfollowCampaign: (campaignId) => request('DELETE', `/campaigns/${campaignId}/follow`),
  getFollowedCampaigns: () => request('GET', '/users/me/following'),

  getMyBadges: () => request('GET', '/users/me/badges'),
  getLeaderboard: (limit) => request('GET', '/users/leaderboard', null, { query: { limit } }),

  getWithdrawalCapabilities: () => request('GET', '/withdrawals/capabilities'),
  listWithdrawals: (campaignId) => request('GET', `/withdrawals/campaign/${campaignId}`),
  getContributorWithdrawalHistory: (campaignId, options = {}) =>
    request('GET', `/withdrawals/campaign/${campaignId}/contributor-history`, null, { query: options }),
  requestWithdrawal: (body) => request('POST', '/withdrawals/request', body),
  approveWithdrawalCreator: (id, body) =>
    request('POST', `/withdrawals/${id}/approve/creator`, body || {}),
  approveWithdrawalPlatform: (id) => request('POST', `/withdrawals/${id}/approve/platform`, {}),
  cancelWithdrawal: (id, body) => request('POST', `/withdrawals/${id}/cancel`, body || {}),
  rejectWithdrawal: (id, body) => request('POST', `/withdrawals/${id}/reject`, body || {}),
  getWithdrawalEvents: (id) => request('GET', `/withdrawals/${id}/events`),
  getWithdrawal: (id) => request('GET', `/withdrawals/${id}`),

  raiseDispute: (campaignId, body) => request('POST', `/campaigns/${campaignId}/disputes`, body),
  getCampaignDisputes: (campaignId) => request('GET', `/campaigns/${campaignId}/disputes`),
  getCampaignDispute: (campaignId) => request('GET', `/campaigns/${campaignId}/dispute`),
  updateDispute: (id, body) => request('PATCH', `/disputes/${id}`, body),
  getDisputeEvents: (id) => request('GET', `/disputes/${id}/events`),
  submitDisputeEvidence: (id, body) => request('POST', `/disputes/${id}/evidence`, body),
  decideDispute: (id, body) => request('POST', `/admin/disputes/${id}/decide`, body),

  getAdminStats: () => request('GET', '/admin/stats'),
  getAdminHealth: () => request('GET', '/admin/health'),
  getAdminCampaigns: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.include_deleted) qs.append('include_deleted', 'true');
    if (params.flagged_only) qs.append('flagged_only', 'true');
    if (params.status) qs.append('status', params.status);
    const query = qs.toString();
    return request('GET', `/admin/campaigns${query ? `?${query}` : ''}`);
  },
  getAdminWithdrawals: (options = {}) =>
    request('GET', '/admin/withdrawals', null, { query: options }),
  getAdminDisputes: (options = {}) => request('GET', '/admin/disputes', null, { query: options }),
  getAdminDispute: (id) => request('GET', `/admin/disputes/${id}`),
  getAdminKycCampaigns: () => request('GET', '/admin/kyc/campaigns'),
  getAdminCampaignContributions: (campaignId, options = {}) =>
    request('GET', `/admin/campaigns/${campaignId}/contributions`, null, { query: options }),
  adminImpersonateUser: (id) => request('POST', `/admin/impersonate/${id}`, {}),
  adminExitImpersonation: () => request('POST', '/admin/impersonate/exit', {}),
  getAdminWebhookDeliveries: (options = {}) =>
    request('GET', '/admin/webhook-deliveries', null, { query: options }),
  adminRetryWebhookDelivery: (id, body) =>
    request('POST', `/admin/webhook-deliveries/${id}/retry`, body),
  adminUpdateUserKyc: (id, body) => request('PATCH', `/admin/users/${id}/kyc`, body),
  getAdminMilestones: (options = {}) =>
    request('GET', '/admin/milestones', null, { query: options }),
  getAdminUsers: (options = {}) => {
    const query =
      typeof options === 'boolean' ? { include_banned: options ? 'true' : 'false' } : options;
    return request('GET', '/admin/users', null, { query });
  },
  getAdminAuditLog: (options = {}) => request('GET', '/admin/audit-log', null, { query: options }),
  updateCampaignStatus: (id, status) =>
    request('PATCH', `/admin/campaigns/${id}/status`, { status }),
  adminSuspendCampaign: (id, body) => request('PATCH', `/admin/campaigns/${id}/suspend`, body),
  adminRestoreCampaign: (id) => request('PATCH', `/admin/campaigns/${id}/restore`, {}),
  adminFeatureCampaign: (id, body) => request('PATCH', `/admin/campaigns/${id}/feature`, body),
  adminUnfeatureCampaign: (id) => request('PATCH', `/admin/campaigns/${id}/unfeature`, {}),
  adminUnflagCampaign: (id) => request('PATCH', `/admin/campaigns/${id}/unflag`),
  adminUpgradeCampaignContract: (id) => request('POST', `/admin/campaigns/${id}/upgrade-contract`, {}),
  getAdminFraudCampaigns: () => request('GET', '/admin/fraud/flagged'),
  getAdminFraudStats: () => request('GET', '/admin/fraud/stats'),
  adminApproveFraudCampaign: (id) => request('PATCH', `/admin/campaigns/${id}/fraud-approve`),
  adminDeleteCampaign: (id, body) => request('DELETE', `/admin/campaigns/${id}`, body),
  adminBanUser: (id, body) => request('PATCH', `/admin/users/${id}/ban`, body),
  adminUnbanUser: (id) => request('PATCH', `/admin/users/${id}/unban`, {}),
  adminPromoteUser: (id) => request('PATCH', `/admin/users/${id}/promote`, {}),
  adminDemoteUser: (id) => request('PATCH', `/admin/users/${id}/demote`, {}),
  listApiKeys: () => request('GET', '/users/api-keys'),
  createApiKey: (body) => request('POST', '/users/api-keys', body),
  deleteApiKey: (id) => request('DELETE', `/users/api-keys/${id}`),
  listWebhooks: () => request('GET', '/webhooks'),
  createWebhook: (body) => request('POST', '/webhooks', body),
  listWebhookDeliveries: (options = {}) =>
    request('GET', '/webhooks/deliveries', null, { query: options }),
  deleteWebhook: (id) => request('DELETE', `/webhooks/${id}`),

  getNotifications: () => request('GET', '/notifications'),
  markNotificationRead: (id) => request('PATCH', `/notifications/${id}/read`, {}),
  markAllNotificationsRead: () => request('PATCH', '/notifications/read-all', {}),
  getNotificationPreferences: () => request('GET', '/notifications/preferences'),
  updateNotificationPreference: (body) => request('PUT', '/notifications/preferences', body),
  getChannelSettings: () => request('GET', '/notifications/channel-settings'),
  updateChannelSettings: (body) => request('PUT', '/notifications/channel-settings', body),
  getPushSubscriptionStatus: () => request('GET', '/notifications/push-subscriptions'),
  registerPushSubscription: (token) => request('POST', '/notifications/push-subscriptions', { token }),
  removePushSubscription: (token) => request('DELETE', '/notifications/push-subscriptions', { token }),

  getReferralCode: (campaignId) => request('GET', `/campaigns/${campaignId}/referral`),
  getReferralLeaderboard: (campaignId) => request('GET', `/campaigns/${campaignId}/referrals`),

  // ── Referral & affiliate program ─────────────────────────────────────
  enableReferralProgram: (campaignId, body) =>
    request('POST', `/campaigns/${encodeURIComponent(campaignId)}/referrals`, body),
  getReferralProgram: (campaignId) =>
    request('GET', `/campaigns/${encodeURIComponent(campaignId)}/referrals/program`),
  createReferralLink: (campaignId) =>
    request('POST', `/campaigns/${encodeURIComponent(campaignId)}/referrals/links`, {}),
  getCampaignReferralCommissions: (campaignId) =>
    request('GET', `/campaigns/${encodeURIComponent(campaignId)}/referrals/commissions`),
  getMyReferralLinks: () => request('GET', '/referrals/links'),

  // Soroban treasury (#687)
  setTreasuryPolicy: (campaignId, body) =>
    request('POST', `/campaigns/${encodeURIComponent(campaignId)}/treasury/policy`, body),
  getTreasuryStatus: (campaignId) =>
    request('GET', `/campaigns/${encodeURIComponent(campaignId)}/treasury/status`),
  requestTreasuryWithdrawal: (campaignId, body) =>
    request('POST', `/campaigns/${encodeURIComponent(campaignId)}/treasury/withdrawal`, body),
  approveTreasuryWithdrawal: (campaignId, pendingId) =>
    request(
      'POST',
      `/campaigns/${encodeURIComponent(campaignId)}/treasury/withdrawal/${encodeURIComponent(pendingId)}/approve`,
      {}
    ),
  triggerTreasuryRefund: (campaignId) =>
    request('POST', `/campaigns/${encodeURIComponent(campaignId)}/treasury/refund`, {}),

  sendBulkThankYou: (campaignId, message) =>
    request('POST', `/campaigns/${campaignId}/thank-you`, { message }),
  sendContributionThankYou: (contributionId, message) =>
    request('POST', `/contributions/${contributionId}/thank-you`, { message }),
  trackShare: (campaignId, platform) => request('POST', `/campaigns/${campaignId}/share`, { platform }),

  // ── Creator Analytics ────────────────────────────────────────────────
  getCreatorAnalyticsOverview: () => request('GET', '/creator/analytics/overview'),
  getCreatorCampaignAnalytics: (id) => request('GET', `/creator/analytics/campaigns/${encodeURIComponent(id)}`),
  getCreatorBenchmarks: () => request('GET', '/creator/analytics/benchmarks'),
  exportCreatorCampaignData: (campaignId) =>
    downloadFile(
      `/creator/analytics/export?campaignId=${encodeURIComponent(campaignId)}`,
      `campaign-${campaignId}-analytics-export.csv`
    ),

  // ── Contribution Pools (#600) ──────────────────────────────────────
  listCampaignPools: (campaignId) =>
    request('GET', `/contribution-pools/campaign/${campaignId}`),
  listMyPools: () =>
    request('GET', '/contribution-pools/mine'),
  getPool: (poolId) =>
    request('GET', `/contribution-pools/${poolId}`),
  createPool: (body) =>
    request('POST', '/contribution-pools', body),
  joinPool: (poolId, share_amount, display_name) =>
    request('POST', `/contribution-pools/${poolId}/join`, { share_amount, display_name }),
  leavePool: (poolId) =>
    request('POST', `/contribution-pools/${poolId}/leave`),
  updatePool: (poolId, body) =>
    request('PATCH', `/contribution-pools/${poolId}`, body),
  submitPool: (poolId) =>
    request('POST', `/contribution-pools/${poolId}/submit`),
  // ── Campaign Translations (#602) ──────────────────────────────────
  getCampaignTranslations: (campaignId) =>
    request('GET', `/campaigns/${campaignId}/translations`),
  upsertTranslation: (campaignId, language, title, description) =>
    request('POST', `/campaigns/${campaignId}/translations`, { language, title, description }),
  deleteTranslation: (campaignId, language) =>
    request('DELETE', `/campaigns/${campaignId}/translations/${language}`),
  // ── Stretch Goals (#585) ──────────────────────────────────────────
  getStretchGoals: (campaignId) =>
    request('GET', `/campaigns/${campaignId}/stretch-goals`),
  createStretchGoal: (campaignId, body) =>
    request('POST', `/campaigns/${campaignId}/stretch-goals`, body),
  updateStretchGoal: (campaignId, goalId, body) =>
    request('PATCH', `/campaigns/${campaignId}/stretch-goals/${goalId}`, body),
  deleteStretchGoal: (campaignId, goalId) =>
    request('DELETE', `/campaigns/${campaignId}/stretch-goals/${goalId}`),
  // ── Creator Public Profile (#588) ────────────────────────────────
  getCreatorProfile: (userId) =>
    request('GET', `/users/${userId}/public`),
  // ── Recurring Contributions (#584) ───────────────────────────────
  getMyRecurringContributions: () =>
    request('GET', '/users/me/recurring-contributions'),
  createRecurringContribution: (body) =>
    request('POST', '/users/me/recurring-contributions', body),
  updateRecurringContribution: (id, body) =>
    request('PATCH', `/users/me/recurring-contributions/${id}`, body),
  deleteRecurringContribution: (id) =>
    request('DELETE', `/users/me/recurring-contributions/${id}`),

  // ── Contributor Identity & Reputation (#689) ─────────────────────
  registerContributorIdentity: () =>
    request('POST', '/contributor/identity/register', {}),
  getContributorIdentityProfile: (publicKey) =>
    request('GET', `/contributor/identity/${encodeURIComponent(publicKey)}`),
  verifyContributorAttestation: (publicKey, attestation) =>
    request('GET', `/contributor/identity/${encodeURIComponent(publicKey)}/verify`, null, {
      query: { attestation },
    }),
  getCampaignRequirements: (campaignId) =>
    request('GET', `/campaigns/${encodeURIComponent(campaignId)}/requirements`),
  setCampaignRequirements: (campaignId, body) =>
    request('POST', `/campaigns/${encodeURIComponent(campaignId)}/requirements`, body),
};
