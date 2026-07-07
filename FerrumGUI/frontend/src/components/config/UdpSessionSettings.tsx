import React from 'react';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import type { HighLatencyConfig } from '../../api';
import { t as tRaw, en_US } from '../../lang';

// 動的キー (preset の labelKey) を渡すために型アサートしたラッパー。
// キーは en_US に存在することを保証している。
const t = (key: string): string => tRaw(key as keyof typeof en_US);

interface UdpSessionSettingsProps {
  /**
   * 実データは `highLatency` の中に相乗りする。UI 上は独立カードだが、
   * バックエンドは `HighLatencyConfig.udpSessionIdleTimeoutMs` を単独で
   * 参照できないので、非既定値のときは `enabled: true` を裏で立てる。
   */
  config: HighLatencyConfig | undefined;
  onChange: (next: HighLatencyConfig) => void;
}

const DEFAULT_MS = 10_000;

type UdpPresetId = 'fast' | 'default' | 'balanced' | 'persistent' | 'extreme' | 'custom';

interface UdpPreset {
  id: UdpPresetId;
  ms: number;
  labelKey: string;
  fallbackLabel: string;
}

/** ✂ 即切り (bot 対策など): 3 秒 */
const PRESET_FAST: UdpPreset = { id: 'fast', ms: 3_000, labelKey: 'udpIdlePresetFast', fallbackLabel: 'Fast (3s)' };
/** 既定 (10 秒) — Bedrock は接続中なら 1 秒に何度も飛ぶので 10s で十分検知できる */
const PRESET_DEFAULT: UdpPreset = { id: 'default', ms: DEFAULT_MS, labelKey: 'udpIdlePresetDefault', fallbackLabel: 'Default (10s)' };
/** 少しゆるめ (30 秒) */
const PRESET_BALANCED: UdpPreset = { id: 'balanced', ms: 30_000, labelKey: 'udpIdlePresetBalanced', fallbackLabel: 'Balanced (30s)' };
/** 瞬断許容 (5 分) — モバイル/テザリング */
const PRESET_PERSISTENT: UdpPreset = { id: 'persistent', ms: 300_000, labelKey: 'udpIdlePresetPersistent', fallbackLabel: 'Persistent (5min)' };
/** 極端 (30 分) — 衛星/長時間セッション保持 */
const PRESET_EXTREME: UdpPreset = { id: 'extreme', ms: 1_800_000, labelKey: 'udpIdlePresetExtreme', fallbackLabel: 'Extreme (30min)' };

const PRESETS: UdpPreset[] = [PRESET_FAST, PRESET_DEFAULT, PRESET_BALANCED, PRESET_PERSISTENT, PRESET_EXTREME];

export const UdpSessionSettingsPanel: React.FC<UdpSessionSettingsProps> = ({ config, onChange }) => {
  // enabled が false のときは、実行時に config.rs の default (10s) が使われる。
  // UI としては「Default (10s)」を選んでいる扱いにする。
  const enabled = config?.enabled === true;
  const currentMs = enabled
    ? config?.udpSessionIdleTimeoutMs ?? DEFAULT_MS
    : DEFAULT_MS;

  const matchedPreset = PRESETS.find((p) => p.ms === currentMs && (p.id === 'default' ? !enabled : enabled));
  const activeId: UdpPresetId = matchedPreset?.id ?? (currentMs === DEFAULT_MS && !enabled ? 'default' : 'custom');

  const applyPreset = (preset: UdpPreset) => {
    if (preset.id === 'default') {
      // Rust 側デフォルトに任せる → enabled=false
      onChange({
        ...(config ?? {}),
        enabled: false,
        udpSessionIdleTimeoutMs: DEFAULT_MS,
      });
    } else {
      onChange({
        ...(config ?? {}),
        enabled: true,
        udpSessionIdleTimeoutMs: preset.ms,
      });
    }
  };

  const applyCustom = (ms: number | undefined) => {
    if (ms === undefined || !Number.isFinite(ms) || ms < 0) return;
    onChange({
      ...(config ?? {}),
      enabled: true,
      udpSessionIdleTimeoutMs: ms,
    });
  };

  const presetVariant = (id: UdpPresetId): 'primary' | 'ghost' =>
    activeId === id ? 'primary' : 'ghost';
  const mark = (id: UdpPresetId) => (activeId === id ? '✓ ' : '');

  const activeLabelForId = (id: UdpPresetId): string => {
    if (id === 'custom') return t('presetCustom') || 'Custom';
    const p = PRESETS.find((x) => x.id === id);
    return p ? t(p.labelKey) || p.fallbackLabel : String(id);
  };

  return (
    <Card title={t('udpSessionSettings') || 'UDP セッション設定'}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted" style={{ marginTop: '-4px' }}>
          {t('udpSessionHint') ||
            'UDP セッションが無通信のまま何秒でゾンビ判定するかを決めます。Bedrock は接続中なら 1 秒に何度もパケットが飛ぶので、10 秒で十分ですが、モバイル瞬断を許容したい場合は長めに設定してください。'}
        </p>

        <p className="text-sm" style={{ marginTop: '-4px' }}>
          <strong>{t('activePreset') || 'Active'}:</strong> {activeLabelForId(activeId)}
        </p>

        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.id}
              variant={presetVariant(p.id)}
              onClick={() => applyPreset(p)}
            >
              {mark(p.id)}{t(p.labelKey) || p.fallbackLabel}
            </Button>
          ))}
        </div>

        <div className="ui-grid">
          <Input
            label={t('udpSessionIdleTimeoutMs') || 'UDP session idle timeout (ms)'}
            type="number"
            min={0}
            step={1000}
            value={currentMs}
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (raw === '') return;
              const n = Number(raw);
              if (Number.isFinite(n)) applyCustom(n);
            }}
          />
        </div>
      </div>
    </Card>
  );
};
