/* global Event */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Embed Loader Script & Widget', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('creates exactly one iframe regardless of duplicate script tags', async () => {
    const script1 = document.createElement('script');
    script1.setAttribute('data-token', 'token-123');
    script1.setAttribute('data-campaign-id', 'campaign-456');
    script1.src = 'http://localhost:5173/embed.js';
    document.body.appendChild(script1);

    const script2 = document.createElement('script');
    script2.setAttribute('data-token', 'token-123');
    script2.setAttribute('data-campaign-id', 'campaign-456');
    script2.src = 'http://localhost:5173/embed.js';
    document.body.appendChild(script2);

    // Dynamic import to execute script logic
    await import('./loader.js');
    const event = new Event('DOMContentLoaded');
    document.dispatchEvent(event);

    const iframes = document.querySelectorAll('iframe[id^="crowdpay-embed-"]');
    expect(iframes.length).toBe(1);
    expect(iframes[0].id).toBe('crowdpay-embed-campaign-456-token-123');
  });

  it('resizes iframe height on CROWDPAY_RESIZE postMessage', async () => {
    const iframe = document.createElement('iframe');
    iframe.id = 'crowdpay-embed-campaign-xyz-token-abc';
    document.body.appendChild(iframe);

    // Dispatch resize postMessage
    const messageEvent = new MessageEvent('message', {
      data: { type: 'CROWDPAY_RESIZE', height: 450 },
    });
    window.dispatchEvent(messageEvent);

    expect(iframe.style.height).toBe('450px');
  });
});
