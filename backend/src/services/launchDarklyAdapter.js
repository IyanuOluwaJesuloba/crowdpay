const { init } = require('launchdarkly-node-server-sdk');

class LaunchDarklyAdapter {
  constructor(config = {}) {
    this.client = null;
    if (config.sdkKey) {
      try {
        this.client = init(config.sdkKey);
      } catch {
        this.client = null;
      }
    }
  }

  async isEnabled(flagKey, context = {}) {
    if (!this.client) return false;
    try {
      return await this.client.variation(flagKey, {
        key: context.userId || 'anonymous',
        anonymous: !context.userId,
        custom: context.custom,
      }, false);
    } catch {
      return false;
    }
  }

  async getVariant(flagKey, context = {}) {
    if (!this.client) return { name: 'disabled', enabled: false };
    try {
      const detail = await this.client.variationDetail(flagKey, {
        key: context.userId || 'anonymous',
        anonymous: !context.userId,
        custom: context.custom,
      }, null);
      return {
        name: String(detail.variationIndex),
        enabled: !! detail.value,
        payload: detail.value,
      };
    } catch {
      return { name: 'disabled', enabled: false };
    }
  }
}

module.exports = LaunchDarklyAdapter;
