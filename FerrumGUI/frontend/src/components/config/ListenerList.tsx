import React from 'react';
import { ListenerItem } from './ListenerItem';
import { Button } from '../ui/Button';
import type { ListenerConfig } from '../../api';
import { t } from '../../lang';

const createDefaultTarget = () => ({
  host: 'localhost',
  tcp: 19132,
  udp: 19132,
});

const syncListenerTargets = (listener: ListenerConfig): ListenerConfig => {
  const targets = listener.targets && listener.targets.length > 0
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
  const handleListenerChange = (index: number, field: string, value: any) => {
    const newListeners = [...listeners];
    newListeners[index] = syncListenerTargets({ ...newListeners[index], [field]: value });
    onChange(newListeners);
  };

  const handleTargetsChange = (index: number, targets: NonNullable<ListenerConfig['targets']>) => {
    const newListeners = [...listeners];
    newListeners[index] = syncListenerTargets({
      ...newListeners[index],
      targets,
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

  const addListener = () => {
    const newListeners = [...listeners];
    newListeners.push({
      bind: '0.0.0.0',
      tcp: 25565,
      udp: 25565,
      haproxy: false,
      https: {
        enabled: false,
        autoDetect: true,
        letsEncryptDomain: '',
        certPath: '',
        keyPath: '',
      },
      webhook: '',
      rewriteBedrockPongPorts: true,
      target: createDefaultTarget(),
      targets: [createDefaultTarget()],
      httpMappings: [],
    });
    onChange(newListeners);
  };

  const removeListener = (index: number) => {
    const newListeners = [...listeners];
    newListeners.splice(index, 1);
    onChange(newListeners);
  };

  return (
    <div className="listener-list">
      <div className="flex justify-between items-center mb-4">
        <h4 className="text-lg font-bold text-primary">{t('listeners') || 'Listeners'}</h4>
        {listeners.length === 0 && (
          <span className="text-sm text-secondary">{t('singleListenerOnly') || 'Single listener only'}</span>
        )}
      </div>

      {listeners.length === 0 ? (
        <div className="text-center py-8 text-secondary">
          <p>{t('noListenersConfigured') || 'No listeners configured'}</p>
          <Button variant="primary" onClick={addListener} className="mt-4">
            + {t('addListener') || 'Add Listener'}
          </Button>
        </div>
      ) : (
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
