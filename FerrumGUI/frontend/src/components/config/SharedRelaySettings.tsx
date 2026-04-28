import React from 'react';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import type { FerrumProxyConfig, SharedServiceLimits } from '../../api';

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

export const SharedRelaySettings: React.FC<SharedRelaySettingsProps> = ({ config, onChange }) => {
  const sharedService = config.sharedService || {};
  const defaults = { ...defaultLimits, ...(sharedService.defaults || {}) };

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

  return (
    <Card title="Shared Service Relay">
      <div className="ui-grid">
        <div className="flex flex-col gap-4 pt-2">
          <Switch
            label="Enable shared service relay"
            checked={sharedService.enabled || false}
            onChange={(checked) => updateShared({ enabled: checked })}
          />
        </div>

        <Input
          label="Max TCP connections"
          type="number"
          value={defaults.maxTcpConnections}
          onChange={(event) => updateLimit('maxTcpConnections', parseInt(event.target.value))}
          min="1"
        />

        <Input
          label="Max UDP peers"
          type="number"
          value={defaults.maxUdpPeers}
          onChange={(event) => updateLimit('maxUdpPeers', parseInt(event.target.value))}
          min="1"
        />

        <Input
          label="Bandwidth bytes/sec"
          type="number"
          value={defaults.maxBytesPerSecond}
          onChange={(event) => updateLimit('maxBytesPerSecond', parseInt(event.target.value))}
          min="1024"
        />

        <Input
          label="TCP idle timeout seconds"
          type="number"
          value={defaults.idleTimeoutSeconds}
          onChange={(event) => updateLimit('idleTimeoutSeconds', parseInt(event.target.value))}
          min="1"
        />

        <Input
          label="UDP session timeout seconds"
          type="number"
          value={defaults.udpSessionTimeoutSeconds}
          onChange={(event) => updateLimit('udpSessionTimeoutSeconds', parseInt(event.target.value))}
          min="1"
        />
      </div>
    </Card>
  );
};
