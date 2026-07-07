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
  maxBytesPerSecond: 10 * 1024 * 1024,
};

const BANDWIDTH_UNITS: Record<string, number> = {
  bps: 1,
  kbps: 1024,
  mbps: 1024 * 1024,
  gbps: 1024 * 1024 * 1024,
  tbps: 1024 * 1024 * 1024 * 1024,
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

const toOptionalPort = (value: string) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : undefined;
};

const parseBandwidthToBytesPerSecond = (value: string): number | null => {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (/^\d+$/.test(normalized)) {
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(k|m|g|t)?bps$/i);
  if (!match) {
    return null;
  }

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const unit = `${(match[2] || '').toLowerCase()}bps`;
  const multiplier = BANDWIDTH_UNITS[unit];
  if (!multiplier) {
    return null;
  }

  const bitsPerSecond = amount * multiplier;
  const bytesPerSecond = Math.round(bitsPerSecond / 8);
  return bytesPerSecond > 0 ? bytesPerSecond : null;
};

const formatBandwidthFromBytesPerSecond = (bytesPerSecond: number): string => {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return '';
  }

  const bitsPerSecond = bytesPerSecond * 8;
  const units = [
    { label: 'Tbps', value: BANDWIDTH_UNITS.tbps },
    { label: 'Gbps', value: BANDWIDTH_UNITS.gbps },
    { label: 'Mbps', value: BANDWIDTH_UNITS.mbps },
    { label: 'Kbps', value: BANDWIDTH_UNITS.kbps },
    { label: 'bps', value: BANDWIDTH_UNITS.bps },
  ];

  const chosen = units.find((unit) => bitsPerSecond >= unit.value) || units[units.length - 1];
  const amount = bitsPerSecond / chosen.value;
  const rounded = amount >= 100 ? amount.toFixed(0) : amount >= 10 ? amount.toFixed(1) : amount.toFixed(2);
  return `${Number.parseFloat(rounded)}${chosen.label}`;
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
  const [defaultBandwidthInput, setDefaultBandwidthInput] = React.useState(() =>
    formatBandwidthFromBytesPerSecond(defaults.maxBytesPerSecond)
  );
  const [tokenBandwidthInputs, setTokenBandwidthInputs] = React.useState<Record<number, string>>({});

  React.useEffect(() => {
    setDefaultBandwidthInput(formatBandwidthFromBytesPerSecond(defaults.maxBytesPerSecond));
  }, [defaults.maxBytesPerSecond]);

  React.useEffect(() => {
    setTokenBandwidthInputs(
      Object.fromEntries(
        tokens.map((token, index) => [
          index,
          formatBandwidthFromBytesPerSecond((token.limits || {}).maxBytesPerSecond ?? defaults.maxBytesPerSecond),
        ])
      )
    );
  }, [tokens, defaults.maxBytesPerSecond]);

  const updateShared = (updates: FerrumProxyConfig['sharedService']) => {
    onChange({
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

  const commitDefaultBandwidthInput = (raw: string) => {
    const parsed = parseBandwidthToBytesPerSecond(raw);
    if (!parsed) {
      setDefaultBandwidthInput(formatBandwidthFromBytesPerSecond(defaults.maxBytesPerSecond));
      return;
    }
    updateLimit('maxBytesPerSecond', parsed);
    setDefaultBandwidthInput(formatBandwidthFromBytesPerSecond(parsed));
  };

  const commitTokenBandwidthInput = (index: number, raw: string, fallback: number) => {
    const parsed = parseBandwidthToBytesPerSecond(raw);
    if (!parsed) {
      setTokenBandwidthInputs((prev) => ({ ...prev, [index]: formatBandwidthFromBytesPerSecond(fallback) }));
      return;
    }
    updateTokenLimit(index, 'maxBytesPerSecond', parsed);
    setTokenBandwidthInputs((prev) => ({ ...prev, [index]: formatBandwidthFromBytesPerSecond(parsed) }));
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
          label={t('controlBind')}
          type="text"
          value={sharedService.controlBind || '0.0.0.0:7000'}
          onChange={(event) => updateShared({ controlBind: event.target.value })}
          placeholder="0.0.0.0:7000"
        />

        <Input
          label={t('publicHost')}
          type="text"
          value={sharedService.publicHost || ''}
          onChange={(event) => updateShared({ publicHost: event.target.value })}
          placeholder="xxx.xxx.xxx.xxx"
        />

        <Input
          label={t('bandwidthBytesPerSecond')}
          type="text"
          value={defaultBandwidthInput}
          onChange={(event) => setDefaultBandwidthInput(event.target.value)}
          onBlur={() => commitDefaultBandwidthInput(defaultBandwidthInput)}
          placeholder="10Mbps or 10485760"
        />

        <Input
          label={t('maxQueueSize')}
          type="number"
          value={queue.maxSize}
          onChange={(event) => updateShared({ queue: { ...queue, enabled: true, maxSize: toPositiveInt(event.target.value, queue.maxSize || 128) } })}
          min="0"
        />
      </div>

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
                    label={t('tokenFixedPort')}
                    type="number"
                    value={token.fixedPort || ''}
                    onChange={(event) => updateToken(index, { fixedPort: toOptionalPort(event.target.value) })}
                    min="1"
                    max="65535"
                    placeholder="optional"
                  />
                  <Input
                    label={t('tokenBandwidth')}
                    type="text"
                    value={tokenBandwidthInputs[index] ?? formatBandwidthFromBytesPerSecond(limits.maxBytesPerSecond)}
                    onChange={(event) =>
                      setTokenBandwidthInputs((prev) => ({ ...prev, [index]: event.target.value }))
                    }
                    onBlur={() =>
                      commitTokenBandwidthInput(
                        index,
                        tokenBandwidthInputs[index] ?? '',
                        limits.maxBytesPerSecond
                      )
                    }
                    placeholder="1Kbps / 10Mbps / 10485760"
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
