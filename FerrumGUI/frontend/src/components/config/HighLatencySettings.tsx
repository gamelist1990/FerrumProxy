import React from 'react';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { Button } from '../ui/Button';
import type { HighLatencyConfig } from '../../api';
import { t } from '../../lang';

interface HighLatencySettingsProps {
  config: HighLatencyConfig | undefined;
  onChange: (config: HighLatencyConfig) => void;
}

/**
 * FerrumProxy 側の `HighLatencyConfig` デフォルトと一致。無効化されているときは
 * TCP/UDP タイムアウトは 10s / 10s / 10s の baseline に戻る。
 */
const PRESET_DEFAULT: HighLatencyConfig = {
  enabled: false,
  initialClientDataTimeoutMs: 10_000,
  connectTimeoutMs: 10_000,
  udpSessionIdleTimeoutMs: 10_000,
};

/** 1000ms〜3000ms 帯の重ユーザー向け。 */
const PRESET_HIGH: HighLatencyConfig = {
  enabled: true,
  initialClientDataTimeoutMs: 30_000,
  connectTimeoutMs: 30_000,
  udpSessionIdleTimeoutMs: 600_000,
};

/** 5000ms 超・衛星回線・モバイルテザリング等の極端ケース。 */
const PRESET_EXTREME: HighLatencyConfig = {
  enabled: true,
  initialClientDataTimeoutMs: 60_000,
  connectTimeoutMs: 60_000,
  udpSessionIdleTimeoutMs: 1_800_000,
};

const HL_KEYS = [
  'enabled',
  'initialClientDataTimeoutMs',
  'connectTimeoutMs',
  'udpSessionIdleTimeoutMs',
] as const;

function hlPresetsEqual(a: HighLatencyConfig, b: HighLatencyConfig): boolean {
  return HL_KEYS.every((k) => a[k] === b[k]);
}

type ActiveHlPreset = 'off' | 'high' | 'extreme' | 'custom';

export const HighLatencySettingsPanel: React.FC<HighLatencySettingsProps> = ({ config, onChange }) => {
  const cfg: HighLatencyConfig = { ...PRESET_DEFAULT, ...(config ?? {}) };
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  const patch = <K extends keyof HighLatencyConfig>(field: K, value: HighLatencyConfig[K]) => {
    onChange({ ...cfg, [field]: value });
  };

  const parseNumber = (value: string): number | undefined => {
    if (value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };

  const applyPreset = (preset: HighLatencyConfig) => onChange({ ...preset });

  const activePreset: ActiveHlPreset = hlPresetsEqual(cfg, PRESET_DEFAULT)
    ? 'off'
    : hlPresetsEqual(cfg, PRESET_HIGH)
      ? 'high'
      : hlPresetsEqual(cfg, PRESET_EXTREME)
        ? 'extreme'
        : 'custom';

  const presetVariant = (id: ActiveHlPreset) =>
    activePreset === id ? 'primary' : 'ghost';
  const mark = (id: ActiveHlPreset) => (activePreset === id ? '✓ ' : '');

  const activeLabel =
    activePreset === 'off'
      ? t('highLatencyPresetOff') || 'Off (10s / 10s / 10s)'
      : activePreset === 'high'
        ? t('highLatencyPresetHigh') || 'High ping (30s / 30s / 10min)'
        : activePreset === 'extreme'
          ? t('highLatencyPresetExtreme') || 'Extreme (60s / 60s / 30min)'
          : t('presetCustom') || 'Custom';

  return (
    <Card title={t('highLatencySettings') || 'High-latency mode'}>
      <div className="flex flex-col gap-4">
        <Switch
          label={t('highLatencyEnabled') || 'Allow extremely slow clients'}
          checked={cfg.enabled === true}
          onChange={(checked) => patch('enabled', checked)}
        />

        <p className="text-sm text-muted" style={{ marginTop: '-4px' }}>
          {t('highLatencyHint') ||
            'Stretches the initial handshake, backend connect, and UDP idle timeouts so 1000ms–5000ms clients can stay connected. Turn off if you want the tight defaults.'}
        </p>

        <p className="text-sm" style={{ marginTop: '-4px' }}>
          <strong>{t('activePreset') || 'Active'}:</strong> {activeLabel}
        </p>

        <div className="flex flex-wrap gap-2">
          <Button variant={presetVariant('off')} onClick={() => applyPreset(PRESET_DEFAULT)}>
            {mark('off')}{t('highLatencyPresetOff') || 'Off (10s / 10s / 60s)'}
          </Button>
          <Button variant={presetVariant('high')} onClick={() => applyPreset(PRESET_HIGH)}>
            {mark('high')}{t('highLatencyPresetHigh') || 'High ping (30s / 30s / 10min)'}
          </Button>
          <Button variant={presetVariant('extreme')} onClick={() => applyPreset(PRESET_EXTREME)}>
            {mark('extreme')}{t('highLatencyPresetExtreme') || 'Extreme (60s / 60s / 30min)'}
          </Button>
        </div>

        <Button variant="ghost" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced
            ? t('highLatencyHideAdvanced') || 'Hide advanced timeouts'
            : t('highLatencyShowAdvanced') || 'Show advanced timeouts'}
        </Button>

        {showAdvanced && (
          <div className="ui-grid">
            <Input
              label={t('initialClientDataTimeoutMs') || 'Initial client data timeout (ms)'}
              type="number"
              min={0}
              step={500}
              value={cfg.initialClientDataTimeoutMs ?? ''}
              onChange={(e) => patch('initialClientDataTimeoutMs', parseNumber(e.target.value))}
            />
            <Input
              label={t('connectTimeoutMs') || 'Backend connect timeout (ms)'}
              type="number"
              min={0}
              step={500}
              value={cfg.connectTimeoutMs ?? ''}
              onChange={(e) => patch('connectTimeoutMs', parseNumber(e.target.value))}
            />
            <Input
              label={t('udpSessionIdleTimeoutMs') || 'UDP session idle timeout (ms)'}
              type="number"
              min={0}
              step={1000}
              value={cfg.udpSessionIdleTimeoutMs ?? ''}
              onChange={(e) => patch('udpSessionIdleTimeoutMs', parseNumber(e.target.value))}
            />
          </div>
        )}
      </div>
    </Card>
  );
};
