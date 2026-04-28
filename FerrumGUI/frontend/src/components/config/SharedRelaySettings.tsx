import React from 'react';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { Button } from '../ui/Button';
import { t } from '../../lang';
import type { FerrumProxyConfig, SharedServiceLimits, SharedServiceToken } from '../../api';

interface SharedRelaySettingsProps {
  config: FerrumProxyConfig;
  onChange: (sharedService: FerrumProxyConfig['sharedService']) => void;
}

const defaultLimits: SharedServiceLimits = {
  maxTcpConnections: 32,
  maxUdpPeers: 64,
  maxBytesPerSecond: 10 * 1024 * 1024,
  idleTimeoutSeconds: 120,
  udpSessionTimeoutSeconds: 60,
};

const generateToken = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `fp_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

const toPositiveInt = (value: string, fallback: number) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const SharedRelaySettings: React.FC<SharedRelaySettingsProps> = ({ config, onChange }) => {
  const sharedService = config.sharedService || {};
  const defaults = { ...defaultLimits, ...(sharedService.defaults || {}) };
  const queue = { enabled: true, maxSize: 128, ...(sharedService.queue || {}) };
  const tokens: SharedServiceToken[] =
    sharedService.tokens ||
    (sharedService.authTokens || []).map((token, index) => ({
      name: `legacy-${index + 1}`,
      token,
      enabled: true,
      priority: 10,
      limits: defaults,
    }));

  const updateShared = (updates: FerrumProxyConfig['sharedService']) => {
    onChange({
      enabled: false,
      ...sharedService,
      ...updates,
      publicBind: '0.0.0.0',
    });
  };

  const updateLimit = (field: keyof SharedServiceLimits, value: number) => {
    updateShared({
      defaults: {
        ...defaults,
        [field]: value,
      },
    });
  };

  const updateToken = (index: number, updates: Partial<SharedServiceToken>) => {
    updateShared({
      tokens: tokens.map((token, tokenIndex) =>
        tokenIndex === index ? { ...token, ...updates } : token
      ),
    });
  };

  const updateTokenLimit = (index: number, field: keyof SharedServiceLimits, value: number) => {
    const token = tokens[index];
    updateToken(index, {
      limits: {
        ...defaults,
        ...(token.limits || {}),
        [field]: value,
      },
    });
  };

  const addToken = () => {
    updateShared({
      tokens: [
        ...tokens,
        {
          name: `token-${tokens.length + 1}`,
          token: generateToken(),
          enabled: true,
          priority: 10,
          limits: defaults,
        },
      ],
    });
  };

  const removeToken = (index: number) => {
    updateShared({
      tokens: tokens.filter((_, tokenIndex) => tokenIndex !== index),
    });
  };

  return (
    <Card
      title={t('sharedServiceRelay')}
      actions={
        <Button type="button" variant="secondary" onClick={addToken}>
          {t('issueToken')}
        </Button>
      }
    >
      <div className="ui-grid">
        <div className="flex flex-col gap-4 pt-2">
          <Switch
            label={t('enableSharedServiceRelay')}
            checked={sharedService.enabled || false}
            onChange={(checked) => updateShared({ enabled: checked })}
          />
          <Switch
            label={t('allowAnonymousAccess')}
            checked={sharedService.allowAnonymous ?? true}
            onChange={(checked) => updateShared({ allowAnonymous: checked })}
          />
        </div>

        <Input
          label={t('maxTcpConnections')}
          type="number"
          value={defaults.maxTcpConnections}
          onChange={(event) => updateLimit('maxTcpConnections', toPositiveInt(event.target.value, defaults.maxTcpConnections))}
          min="1"
        />

        <Input
          label={t('maxUdpPeers')}
          type="number"
          value={defaults.maxUdpPeers}
          onChange={(event) => updateLimit('maxUdpPeers', toPositiveInt(event.target.value, defaults.maxUdpPeers))}
          min="1"
        />

        <Input
          label={t('bandwidthBytesPerSecond')}
          type="number"
          value={defaults.maxBytesPerSecond}
          onChange={(event) => updateLimit('maxBytesPerSecond', toPositiveInt(event.target.value, defaults.maxBytesPerSecond))}
          min="1024"
        />

        <Input
          label={t('tcpIdleTimeoutSeconds')}
          type="number"
          value={defaults.idleTimeoutSeconds}
          onChange={(event) => updateLimit('idleTimeoutSeconds', toPositiveInt(event.target.value, defaults.idleTimeoutSeconds))}
          min="1"
        />

        <Input
          label={t('udpSessionTimeoutSeconds')}
          type="number"
          value={defaults.udpSessionTimeoutSeconds}
          onChange={(event) => updateLimit('udpSessionTimeoutSeconds', toPositiveInt(event.target.value, defaults.udpSessionTimeoutSeconds))}
          min="1"
        />

        <div className="flex flex-col gap-4 pt-2">
          <Switch
            label={t('enableWaitingQueue')}
            checked={queue.enabled ?? true}
            className="ui-switch--stacked"
            onChange={(checked) => updateShared({ queue: { ...queue, enabled: checked } })}
          />
        </div>

        <Input
          label={t('maxQueueSize')}
          type="number"
          value={queue.maxSize}
          onChange={(event) => updateShared({ queue: { ...queue, maxSize: toPositiveInt(event.target.value, queue.maxSize || 128) } })}
          min="1"
        />
      </div>

      <p className="ui-help-text">{t('anonymousUsersQueued')}</p>

      {tokens.length > 0 && (
        <div className="token-list">
          {tokens.map((token, index) => {
            const limits = { ...defaults, ...(token.limits || {}) };
            return (
              <div className="token-row" key={`${token.token}-${index}`}>
                <div className="token-row-head">
                  <Switch
                    label={t('tokenEnabled')}
                    checked={token.enabled ?? true}
                    onChange={(checked) => updateToken(index, { enabled: checked })}
                  />
                  <Button type="button" variant="danger" onClick={() => removeToken(index)}>
                    {t('removeToken')}
                  </Button>
                </div>

                <div className="ui-grid">
                  <Input
                    label={t('tokenName')}
                    value={token.name || ''}
                    onChange={(event) => updateToken(index, { name: event.target.value })}
                  />
                  <Input
                    label={t('tokenValue')}
                    value={token.token}
                    onChange={(event) => updateToken(index, { token: event.target.value })}
                  />
                  <Input
                    label={t('tokenPriority')}
                    type="number"
                    value={token.priority ?? 10}
                    onChange={(event) => updateToken(index, { priority: Math.max(0, Number.parseInt(event.target.value, 10) || 0) })}
                    min="0"
                  />
                  <Input
                    label={t('tokenBandwidth')}
                    type="number"
                    value={limits.maxBytesPerSecond}
                    onChange={(event) => updateTokenLimit(index, 'maxBytesPerSecond', toPositiveInt(event.target.value, limits.maxBytesPerSecond))}
                    min="1024"
                  />
                  <Input
                    label={t('tokenMaxTcp')}
                    type="number"
                    value={limits.maxTcpConnections}
                    onChange={(event) => updateTokenLimit(index, 'maxTcpConnections', toPositiveInt(event.target.value, limits.maxTcpConnections))}
                    min="1"
                  />
                  <Input
                    label={t('tokenMaxUdp')}
                    type="number"
                    value={limits.maxUdpPeers}
                    onChange={(event) => updateTokenLimit(index, 'maxUdpPeers', toPositiveInt(event.target.value, limits.maxUdpPeers))}
                    min="1"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
};
