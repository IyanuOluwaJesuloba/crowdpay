(function() {
  'use strict';
  const SELECTOR = '.campaign-milestone-widget';
  const DEFAULT_API = '/api/embed/milestones';
  const DEFAULT_COLOR = '#007bff';
  const REFRESH_MS = 60000;

  function refresh() {
    document.querySelectorAll(SELECTOR).forEach(el => {
      const campaignId = el.getAttribute('data-campaign-id');
      const token = el.getAttribute('data-embed-token');
      if (!campaignId || !token) return;
      const api = el.getAttribute('data-api-url') || DEFAULT_API;
      fetch(`${api}?campaignId=${encodeURIComponent(campaignId)}&embedToken=${encodeURIComponent(token)}`)
        .then(r => r.json())
        .then(data => {
          const total = data.total || 0;
          const completed = data.completed || 0;
          const pct = total ? Math.round(completed / total * 100) : 0;
          const primary = el.getAttribute('data-color-primary') || (data.branding && data.branding.primaryColor) || DEFAULT_COLOR;
          const track = el.getAttribute('data-color-track') || (data.branding && data.branding.trackColor) || '#eee';
          const showPct = el.getAttribute('data-show-percentage') !== 'false';
          const label = el.getAttribute('data-label');
          let html = '';
          if (label) html += `<div style="font-family:sans-serif;font-size:14px">${label}</div>`;
          html += `<div style="background:#{track};border-radius:10px;height:20px;overflow:hidden">`;
          html += `<div style="width:${pct}%;background:${primary};height:100%;border-radius:10px;transition:width 0.5s"></div>`;
          html += `</div>`;
          if (showPct) html += `<div style="font-family:sans-serif;font-size:12px">$completed} / ${total} (${pct}%)</div>`;
          el.innerHTML = html;
        })
        .catch(() => { el.innerHTML = 'Milestone data unavailable'; });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh);
  } else {
    refresh();
  }
  setInterval(refresh, REFRESH_MS);

  window.CampaignMilestones = { refresh };
})();