import React from 'react';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import type { FerrumProxyConfig } from '../../api';
import { t } from '../../lang';

interface GeneralSettingsProps {
  config: FerrumProxyConfig;
  onChange: (field: keyof FerrumProxyConfig, value: any) => void;
}

export const GeneralSettings: React.FC<GeneralSettingsProps> = ({ config, onChange }) => {
  return (
    <Card title={t('generalSettings') || 'General Settings'}>
      <div className="ui-grid">
        <Input
          label={t('endpointPort') || 'Endpoint Port'}
          type="number"
          value={config.endpoint || 6000}
          onChange={(e) => onChange('endpoint', parseInt(e.target.value))}
          min="1"
          max="65535"
        />
        
        <div className="flex flex-col gap-4 pt-2">
          <Switch
            label={t('enableRestApi') || 'Enable REST API'}
            checked={config.useRestApi || false}
            onChange={(checked) => onChange('useRestApi', checked)}
          />
          
          <Switch
            label={t('savePlayerIp') || 'Save Player IP'}
            checked={config.savePlayerIP || false}
            onChange={(checked) => onChange('savePlayerIP', checked)}
          />

          <Switch
            label={t('debugLogs') || 'Debug logs'}
            checked={config.debug || false}
            onChange={(checked) => onChange('debug', checked)}
          />
        </div>
      </div>
    </Card>
  );
};
