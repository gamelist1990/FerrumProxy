import React, { useState } from 'react';
import { Plus, Network } from 'lucide-react';
import { Input } from '../ui/Input';
import { createListenerRoute, listenerPortsConflict, type RoutePreset } from './listenerRoutes';
import { ListenerItem } from './ListenerItem';
import { Button } from '../ui/Button';
import type { ListenerConfig } from '../../api';
import { t } from '../../lang';

const syncListenerTargets = (listener: ListenerConfig): ListenerConfig => {
  const targets = listener.targets !== undefined
    ? listener.targets
    : listener.target
      ? [listener.target]
      : [];

  return {
    ...listener,
    target: targets[0],
    targets,
  };
};

interface ListenerListProps {
  instanceId: string;
  listeners: ListenerConfig[];
  onChange: (listeners: ListenerConfig[]) => void;
}

export const ListenerList: React.FC<ListenerListProps> = ({ instanceId, listeners, onChange }) => {
  const [sharedHost, setSharedHost] = useState(listeners[0]?.targets?.[0]?.host ?? listeners[0]?.target?.host ?? '100.83.127.8');
  const handleListenerChange = <K extends keyof ListenerConfig>(index: number, field: K, value: ListenerConfig[K]) => {
    const newListeners = [...listeners];
    newListeners[index] = syncListenerTargets({ ...newListeners[index], [field]: value });
    if (field === 'bedrockTransport' && value !== 'nethernet') {
      newListeners[index].nethernetAdvertiseHost = undefined;
      newListeners[index].nethernetAdvertisePort = undefined;
    } else if (field === 'nethernetAdvertiseHost' && !value) {
      newListeners[index].nethernetAdvertisePort = undefined;
    }
    onChange(newListeners);
  };

  const handleTargetsChange = (index: number, targets: NonNullable<ListenerConfig['targets']>) => {
    const newListeners = [...listeners];
    newListeners[index] = syncListenerTargets({
      ...newListeners[index],
      targets,
      target: targets[0],
    });
    onChange(newListeners);
  };

  const handleHttpMappingsChange = (index: number, httpMappings: NonNullable<ListenerConfig['httpMappings']>) => {
    const newListeners = [...listeners];
    newListeners[index] = syncListenerTargets({
      ...newListeners[index],
      httpMappings,
    });
    onChange(newListeners);
  };

  const addListener = (preset: RoutePreset) => {
    onChange([...listeners, createListenerRoute(preset, sharedHost.trim() || 'localhost')]);
  };

  const removeListener = (index: number) => {
    const newListeners = [...listeners];
    newListeners.splice(index, 1);
    onChange(newListeners);
  };

  return (
    <div className="listener-list">
      <div className="route-builder">
        <div className="route-builder-heading"><Network size={20} /><h4>{t('routeTitle')}</h4><span className="route-count">{listeners.length}</span></div>
        <p className="ui-help-text">{t('routeIntro')}</p>
        <Input label={t('newRouteHost')} value={sharedHost} onChange={e => setSharedHost(e.target.value)} placeholder="100.83.127.8" />
        <div className="route-preset-actions">
          <Button variant="primary" onClick={() => addListener('custom')}><Plus size={16} />{t('addCustomRoute')}</Button>
          <Button variant="secondary" onClick={() => addListener('java')}>Java · TCP 25565</Button>
          <Button variant="secondary" onClick={() => addListener('nethernet')}>NetherNet · TCP/UDP 19132</Button>
        </div>
        <p className="ui-help-text">{t('routePresetHint')}</p>
      </div>
      {listeners.some((listener, index) => listeners.slice(index + 1).some(other => listenerPortsConflict(listener, other))) && (
        <p className="route-warning" role="alert">{t('routePortConflict')}</p>
      )}
      {listeners.length === 0 ? <p className="ui-help-text">{t('noListenersConfigured')}</p> : (
        listeners.map((listener, index) => (
          <ListenerItem
            key={index}
            instanceId={instanceId}
            index={index}
            listener={syncListenerTargets(listener)}
            onChange={(field, value) => handleListenerChange(index, field, value)}
            onTargetsChange={(targets) => handleTargetsChange(index, targets)}
            onHttpMappingsChange={(mappings) => handleHttpMappingsChange(index, mappings)}
            onRemove={listeners.length > 1 ? () => removeListener(index) : undefined}
          />
        ))
      )}
    </div>
  );
};
