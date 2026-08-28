/*!
 * CrowdPay Discovery Widget
 * frontend/src/embed/discover-widget.js
 *
 * Third parties embed with:
 *   <script src="https://cdn.crowdpay.com/discover.js"
 *           data-token="<embedToken>"
 *           data-topic="education"
 *           data-asset="USDC"
 *           data-limit="3"></script>
 *
 * Ships as a single <3KB minified file (no framework, no dependencies).
 * Renders an iframe pointing at /embed/discover-widget.html, which does the
 * actual API call + card rendering — this file just wires up the iframe and
 * the postMessage bridge (CROWDPAY_WIDGET_READY / CROWDPAY_CAMPAIGN_CLICKED).
 */
(function () {
  'use strict';

  const CDN_ORIGIN = 'https://cdn.crowdpay.com';

  const thisScript = document.currentScript;
  if (!thisScript) return;

  const token = thisScript.getAttribute('data-token');
  const topic = thisScript.getAttribute('data-topic') || '';
  const asset = thisScript.getAttribute('data-asset') || '';
  const limit = thisScript.getAttribute('data-limit') || '3';

  if (!token) {
    console.error('[CrowdPay widget] data-token is required');
    return;
  }

  const qs = [
    'embedToken=' + encodeURIComponent(token),
    topic && 'topic=' + encodeURIComponent(topic),
    asset && 'asset=' + encodeURIComponent(asset),
    'limit=' + encodeURIComponent(limit),
  ].filter(Boolean).join('&');

  const iframe = document.createElement('iframe');
  iframe.src = CDN_ORIGIN + '/embed/discover-widget.html?' + qs;
  iframe.title = 'CrowdPay campaigns';
  iframe.style.cssText = 'width:100%;border:0;display:block;overflow:hidden;';
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('loading', 'lazy');
  // Placeholder height until the child reports its real size on WIDGET_READY.
  iframe.height = String(120 * Number(limit || 3));

  thisScript.parentNode.insertBefore(iframe, thisScript);

  window.addEventListener('message', function (event) {
    if (event.origin !== CDN_ORIGIN || !event.data || event.source !== iframe.contentWindow) return;

    if (event.data.type === 'CROWDPAY_WIDGET_READY') {
      if (event.data.height) iframe.height = String(event.data.height);
      const readyEvent = new CustomEvent('crowdpay:widget-ready', { detail: event.data });
      thisScript.parentNode.dispatchEvent(readyEvent);
    }

    if (event.data.type === 'CROWDPAY_CAMPAIGN_CLICKED') {
      const clickEvent = new CustomEvent('crowdpay:campaign-clicked', {
        detail: { campaignId: event.data.campaignId },
      });
      thisScript.parentNode.dispatchEvent(clickEvent);
    }
  });
})();
