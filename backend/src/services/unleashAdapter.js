const { initialize } = require('unleash-client');

class UnleashAdapter {
  constructor(config = {}) {
    this.client = null;
    const { url, apiToken, appName, environment } = config;
    if (url && apiToken && appName) {
      try {
        this.client = initialize({
          url,
          appName,
          environment: environment || process.env.NODE_ENV || 'development',
          customHeaders: { Authorization: apiToken },
        });
      } catch {
        this.client = null;
      }
    }
  }

  isEnabled(flagKey, context = {}) {
    if (!this.client) return false;
    try {
      return this.client.isEnabled(flagKey, {
        userId: context.userId,
        sessionId: context.sessionId,
        remoteAddress: context.ip,
        properties: context.custom,
      }, false);
    } catch {
      return false;
    }
  }

  getVariant(flagKey, context = {}) {
    if (!this.client) return { name: 'disabled', enabled: false };
    try {
      const variant = this.client.getVariant(flagKey, {
        userId: context.userId,
        properties: context.custom,
      });
      return {
        name: variant.name || 'disabled',
        enabled: !!variant.enabled,
        payload: variant.payload,
      };
    } catch {
      return { name: 'disabled', enabled: false };
    }
  }
}

module.exports = UnleashAdapter;
