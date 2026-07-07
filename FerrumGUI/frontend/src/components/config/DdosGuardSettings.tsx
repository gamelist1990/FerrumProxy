import React from 'react';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { Button } from '../ui/Button';
import type { DdosGuardConfig } from '../../api';
import { t } from '../../lang';

interface DdosGuardSettingsProps {
  config: DdosGuardConfig | undefined;
  onChange: (config: DdosGuardConfig) => void;
}

/**
 * FerrumProxy 側の `DdosGuardSettings::default()` と一致させたバランス設定。
 * ブラウザからの並列接続を許容しつつ、UDP は Bedrock のパケットレートを賄える値。
 */
const PRESET_BALANCED: DdosGuardConfig = {
  enabled: true,
  tcpMaxActivePerIp: 256,
  tcpNewConnectionsPerSecond: 100,
  tcpNewConnectionBurst: 500,
  udpPacketsPerSecond: 240,
  udpPacketBurst: 480,
  udpBytesPerSecond: 2 * 1024 * 1024,
  udpByteBurst: 4 * 1024 * 1024,
  udpMaxDatagramBytes: 8 * 1024,
};

/** 単一 Bedrock サーバ 1 台向け。同一 IP からの大量接続を強めに絞る。 */
const PRESET_STRICT: DdosGuardConfig = {
  enabled: true,
  tcpMaxActivePerIp: 32,
  tcpNewConnectionsPerSecond: 12,
  tcpNewConnectionBurst: 40,
  udpPacketsPerSecond: 120,
  udpPacketBurst: 240,
  udpBytesPerSecond: 512 * 1024,
  udpByteBurst: 1024 * 1024,
  udpMaxDatagramBytes: 2 * 1024,
};

/** 前段の LB / CDN が保護してくれる環境向け。ガード自体は無効化。 */
const PRESET_OFF: DdosGuardConfig = {
  ...PRESET_BALANCED,
  enabled: false,
};

export const DdosGuardSettingsPanel: React.FC<DdosGuardSettingsProps> = ({ config, onChange }) => {
  const cfg: DdosGuardConfig = { ...PRESET_BALANCED, ...(config ?? {}) };
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  const patch = <K extends keyof DdosGuardConfig>(field: K, value: DdosGuardConfig[K]) => {
    onChange({ ...cfg, [field]: value });
  };

  const parseNumber = (value: string): number | undefined => {
    if (value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const applyPreset = (preset: DdosGuardConfig) => onChange({ ...preset });

  return (
    <Card title={t('ddosGuardSettings') || 'DDoS Guard'}>
      <div className="flex flex-col gap-4">
        <Switch
          label={t('ddosEnabled') || 'Enable DDoS guard'}
          checked={cfg.enabled !== false}
          onChange={(checked) => patch('enabled', checked)}
        />

        <p className="text-sm text-muted" style={{ marginTop: '-4px' }}>
          {t('ddosGuardHint') ||
            'Per-IP TCP/UDP rate limiting. Pick a preset, then tweak the details if needed.'}
        </p>

        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => applyPreset(PRESET_BALANCED)}>
            {t('ddosPresetBalanced') || 'Balanced (default)'}
          </Button>
          <Button variant="secondary" onClick={() => applyPreset(PRESET_STRICT)}>
            {t('ddosPresetStrict') || 'Strict (Bedrock)'}
          </Button>
          <Button variant="ghost" onClick={() => applyPreset(PRESET_OFF)}>
            {t('ddosPresetOff') || 'Off (trusted upstream)'}
          </Button>
        </div>

        <Button variant="ghost" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced
            ? t('ddosHideAdvanced') || 'Hide advanced thresholds'
            : t('ddosShowAdvanced') || 'Show advanced thresholds'}
        </Button>

        {showAdvanced && (
          <div className="ui-grid">
            <Input
              label={t('tcpMaxActivePerIp') || 'TCP max active per IP'}
              type="number"
              min={1}
              value={cfg.tcpMaxActivePerIp ?? ''}
              onChange={(e) => patch('tcpMaxActivePerIp', parseNumber(e.target.value))}
            />
            <Input
              label={t('tcpNewConnectionsPerSecond') || 'TCP new conn/sec'}
              type="number"
              min={0}
              step={1}
              value={cfg.tcpNewConnectionsPerSecond ?? ''}
              onChange={(e) => patch('tcpNewConnectionsPerSecond', parseNumber(e.target.value))}
            />
            <Input
              label={t('tcpNewConnectionBurst') || 'TCP new conn burst'}
              type="number"
              min={0}
              step={1}
              value={cfg.tcpNewConnectionBurst ?? ''}
              onChange={(e) => patch('tcpNewConnectionBurst', parseNumber(e.target.value))}
            />
            <Input
              label={t('udpPacketsPerSecond') || 'UDP packets/sec'}
              type="number"
              min={0}
              step={1}
              value={cfg.udpPacketsPerSecond ?? ''}
              onChange={(e) => patch('udpPacketsPerSecond', parseNumber(e.target.value))}
            />
            <Input
              label={t('udpPacketBurst') || 'UDP packet burst'}
              type="number"
              min={0}
              step={1}
              value={cfg.udpPacketBurst ?? ''}
              onChange={(e) => patch('udpPacketBurst', parseNumber(e.target.value))}
            />
            <Input
              label={t('udpBytesPerSecond') || 'UDP bytes/sec'}
              type="number"
              min={0}
              step={1024}
              value={cfg.udpBytesPerSecond ?? ''}
              onChange={(e) => patch('udpBytesPerSecond', parseNumber(e.target.value))}
            />
            <Input
              label={t('udpByteBurst') || 'UDP byte burst'}
              type="number"
              min={0}
              step={1024}
              value={cfg.udpByteBurst ?? ''}
              onChange={(e) => patch('udpByteBurst', parseNumber(e.target.value))}
            />
            <Input
              label={t('udpMaxDatagramBytes') || 'UDP max datagram bytes'}
              type="number"
              min={1}
              step={64}
              value={cfg.udpMaxDatagramBytes ?? ''}
              onChange={(e) => patch('udpMaxDatagramBytes', parseNumber(e.target.value))}
            />
          </div>
        )}
      </div>
    </Card>
  );
};
