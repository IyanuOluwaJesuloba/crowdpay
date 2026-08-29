(function () {
  'use strict';

  function initEmbeds() {
    const scripts = document.querySelectorAll('script[data-token][data-campaign-id]');
    scripts.forEach((script) => {
      const token = script.getAttribute('data-token');
      const campaignId = script.getAttribute('data-campaign-id');
      const theme = script.getAttribute('data-theme') || 'light';
      if (!token || !campaignId) return;

      const iframeId = `crowdpay-embed-${campaignId}-${token}`;

      // Enforce exact single iframe creation regardless of duplicate script tags
      if (document.getElementById(iframeId)) return;

      const iframe = document.createElement('iframe');
      iframe.id = iframeId;
      const baseUrl = script.src ? new URL(script.src).origin : window.location.origin;
      const params = new URLSearchParams({ token, campaignId, theme });
      iframe.src = `${baseUrl}/embed/widget.html?${params.toString()}`;
      iframe.style.width = '100%';
      iframe.style.border = 'none';
      iframe.style.overflow = 'hidden';
      iframe.style.minHeight = '200px';
      iframe.style.borderRadius = '12px';
      iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
      iframe.setAttribute('allow', 'payment');

      script.parentNode.insertBefore(iframe, script.nextSibling);
    });
  }

  window.addEventListener('message', function (event) {
    if (!event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'CROWDPAY_RESIZE' && typeof event.data.height === 'number') {
      const iframes = document.querySelectorAll('iframe[id^="crowdpay-embed-"]');
      iframes.forEach((iframe) => {
        if (event.data.height > 50) {
          iframe.style.height = `${event.data.height}px`;
        }
      });
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEmbeds);
  } else {
    initEmbeds();
  }
})();
