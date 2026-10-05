import { useState } from 'react';
import { CheckCircle2, Code2, GitBranch, Globe, LoaderCircle, Save, Settings2, Shield, Timer } from 'lucide-react';
import type { FerrumProxyConfig } from '../api';
import { t } from '../lang';
import { GeneralSettings } from './config/GeneralSettings';
import { SharedRelaySettings } from './config/SharedRelaySettings';
import { ListenerList } from './config/ListenerList';
import { DdosGuardSettingsPanel } from './config/DdosGuardSettings';
import { HighLatencySettingsPanel } from './config/HighLatencySettings';
import { UdpSessionSettingsPanel } from './config/UdpSessionSettings';
import { WorkspaceTabs } from './WorkspaceTabs';
import './ConfigEditor.css';

type Section = 'routes' | 'general' | 'protection' | 'connection' | 'relay' | 'json';
interface ConfigEditorProps {
  instanceId: string; config: FerrumProxyConfig; onChange: (config: FerrumProxyConfig) => void;
  onSave: () => void; dirty?: boolean; saving?: boolean; sharedMode?: boolean;
}

export function ConfigEditor({ instanceId, config, onChange, onSave, dirty = false, saving = false, sharedMode = false }: ConfigEditorProps) {
  const [section, setSection] = useState<Section>(sharedMode ? 'relay' : 'routes');
  const [json, setJson] = useState(() => JSON.stringify(config, null, 2));
  const [jsonError, setJsonError] = useState(false);
  const handleChange = <K extends keyof FerrumProxyConfig>(field: K, value: FerrumProxyConfig[K]) => {
    onChange({ ...config, [field]: value });
  };
  return (
    <div className="config-editor">
      <WorkspaceTabs<Section> prefix="config" className="config-tabs" label={t('configuration')} active={section}
        onChange={(next) => {
          if (next === section) return;
          if (jsonError && next !== 'json') return;
          if (next === 'json') setJson(JSON.stringify(config, null, 2));
          setSection(next);
        }} tabs={[
          ...(!sharedMode ? [{ id: 'routes' as const, label: t('configRoutes'), icon: GitBranch }] : []),
          { id: 'general', label: t('configGeneral'), icon: Settings2 },
          { id: 'protection', label: t('configProtection'), icon: Shield },
          { id: 'connection', label: t('configConnection'), icon: Timer },
          { id: 'relay', label: t('configRelay'), icon: Globe },
          { id: 'json', label: t('configJson'), icon: Code2 },
        ]} />
      <div id={`config-panel-${section}`} role="tabpanel" aria-labelledby={`config-tab-${section}`} tabIndex={0} className="config-section">
        <fieldset disabled={saving} className="config-fields">
          {section === 'routes' && <ListenerList instanceId={instanceId} listeners={config.listeners || []} onChange={(listeners) => handleChange('listeners', listeners)} />}
          {section === 'general' && <GeneralSettings config={config} onChange={handleChange} />}
          {section === 'protection' && <DdosGuardSettingsPanel config={config.ddosGuard} onChange={(ddosGuard) => handleChange('ddosGuard', ddosGuard)} />}
          {section === 'connection' && <>
            <UdpSessionSettingsPanel config={config.highLatency} onChange={(highLatency) => handleChange('highLatency', highLatency)} />
            <HighLatencySettingsPanel config={config.highLatency} onChange={(highLatency) => handleChange('highLatency', highLatency)} />
          </>}
          {section === 'relay' && <SharedRelaySettings config={config} onChange={(sharedService) => handleChange('sharedService', sharedService)} />}
          {section === 'json' && <div className="json-editor">
            <label htmlFor="config-json" className="ui-label">{t('configJson')}</label>
            <textarea id="config-json" value={json} spellCheck={false} aria-invalid={jsonError} aria-describedby={jsonError ? 'json-error' : undefined}
              onChange={(event) => {
                setJson(event.target.value);
                try {
                  const parsed = JSON.parse(event.target.value);
                  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object');
                  onChange(parsed);
                  setJsonError(false);
                } catch { setJsonError(true); }
              }} rows={22} className="font-mono" />
            {jsonError && <p id="json-error" className="form-error" role="alert">{t('invalidJson')}</p>}
          </div>}
        </fieldset>
      </div>
      <div className="config-savebar">
        <div className="savebar-copy" aria-live="polite">
          <span className={`save-state ${dirty || jsonError ? 'dirty' : ''}`}>
            {dirty || jsonError ? <span className="unsaved-dot" /> : <CheckCircle2 size={16} aria-hidden="true" />}
            {dirty || jsonError ? t('unsavedChanges') : t('savedChanges')}
          </span>
          <small>{t('configRestartHint')}</small>
        </div>
        <button type="button" className="btn primary" onClick={onSave} disabled={saving || jsonError || !dirty}>
          {saving ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : <Save size={17} aria-hidden="true" />}
          {saving ? t('savingChanges') : t('saveConfig')}
        </button>
      </div>
    </div>
  );
}
