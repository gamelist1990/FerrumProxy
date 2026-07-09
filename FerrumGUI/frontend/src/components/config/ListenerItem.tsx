import React, { useState } from 'react';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { Button } from '../ui/Button';
import { uploadListenerTlsAssets, type ListenerConfig } from '../../api';
import { t } from '../../lang';

interface ListenerItemProps {
  instanceId: string;
  index: number;
  listener: ListenerConfig;
  onChange: <K extends keyof ListenerConfig>(field: K, value: ListenerConfig[K]) => void;
  onTargetsChange: (targets: NonNullable<ListenerConfig['targets']>) => void;
  onHttpMappingsChange: (mappings: NonNullable<ListenerConfig['httpMappings']>) => void;
  onRemove?: () => void;
}

const createEmptyTarget = () => ({
  host: '',
  tcp: undefined,
  udp: undefined,
});

const createEmptyHttpMapping = () => ({
  path: '/',
  target: {
    host: '',
    tcp: undefined,
    udp: undefined,
  },
  targets: [{
    host: '',
    tcp: undefined,
    udp: undefined,
  }],
});

const parseOptionalPort = (value: string): number | undefined => {
  if (value.trim() === '') {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const DEFAULT_TARGET_PORT = 19132;

type TargetProtocol = 'both' | 'tcp' | 'udp';

const hasPort = (value: number | undefined | null): value is number =>
  value !== undefined && value !== null;

const getTargetProtocol = (target: { tcp?: number; udp?: number }): TargetProtocol => {
  const tcp = hasPort(target.tcp);
  const udp = hasPort(target.udp);
  if (tcp && !udp) return 'tcp';
  if (udp && !tcp) return 'udp';
  return 'both';
};

export const ListenerItem: React.FC<ListenerItemProps> = ({
  instanceId,
  index,
  listener,
  onChange,
  onTargetsChange,
  onHttpMappingsChange,
  onRemove,
}) => {
  const [certFile, setCertFile] = useState<File | null>(null);
  const [keyFile, setKeyFile] = useState<File | null>(null);

  const targets = listener.targets && listener.targets.length > 0
    ? listener.targets
    : listener.target
      ? [listener.target]
      : [];
  const httpMappings = listener.httpMappings ?? [];
  const hasHttpMappings = httpMappings.length > 0;
  const tcpEnabled = hasPort(listener.tcp);
  const udpEnabled = hasPort(listener.udp);

  const handleTargetChange = (targetIndex: number, field: 'host' | 'tcp' | 'udp', value: string | number | undefined) => {
    const nextTargets = targets.map((target, currentIndex) => (
      currentIndex === targetIndex ? { ...target, [field]: value } : target
    ));
    onTargetsChange(nextTargets);
  };

  const handleTargetProtocolChange = (targetIndex: number, protocol: TargetProtocol) => {
    const nextTargets = targets.map((target, currentIndex) => {
      if (currentIndex !== targetIndex) {
        return target;
      }
      let tcp = target.tcp;
      let udp = target.udp;
      if (protocol === 'tcp') {
        tcp = hasPort(tcp) ? tcp : DEFAULT_TARGET_PORT;
        udp = undefined;
      } else if (protocol === 'udp') {
        udp = hasPort(udp) ? udp : DEFAULT_TARGET_PORT;
        tcp = undefined;
      } else {
        tcp = hasPort(tcp) ? tcp : (hasPort(udp) ? udp : DEFAULT_TARGET_PORT);
        udp = hasPort(udp) ? udp : (hasPort(target.tcp) ? target.tcp : DEFAULT_TARGET_PORT);
      }
      return { ...target, tcp, udp };
    });
    onTargetsChange(nextTargets);
  };

  const addTarget = () => {
    onTargetsChange([...targets, createEmptyTarget()]);
  };

  const removeTarget = (targetIndex: number) => {
    const nextTargets = targets.filter((_, currentIndex) => currentIndex !== targetIndex);
    onTargetsChange(nextTargets);
  };

  const addHttpMapping = () => {
    onHttpMappingsChange([...httpMappings, createEmptyHttpMapping()]);
  };

  const updateHttpMapping = (
    mappingIndex: number,
    field: 'path' | 'host' | 'tcp',
    value: string | number | undefined,
  ) => {
    const nextMappings = httpMappings.map((mapping, currentIndex) => {
      if (currentIndex !== mappingIndex) {
        return mapping;
      }

      const target = mapping.targets?.[0] ?? mapping.target ?? createEmptyTarget();
      if (field === 'path') {
        return { ...mapping, path: String(value ?? '/') };
      }
      const nextTarget = { ...target, [field]: value };
      return { ...mapping, target: nextTarget, targets: [nextTarget] };
    });
    onHttpMappingsChange(nextMappings);
  };

  const removeHttpMapping = (mappingIndex: number) => {
    onHttpMappingsChange(httpMappings.filter((_, currentIndex) => currentIndex !== mappingIndex));
  };

  const handleTlsBundleUpload = async () => {
    if (!certFile || !keyFile) {
      alert(t('selectCertAndKey') || 'Select both certificate and key files.');
      return;
    }

    try {
      const [certPem, keyPem] = await Promise.all([certFile.text(), keyFile.text()]);
      const uploaded = await uploadListenerTlsAssets(instanceId, index, { certPem, keyPem });

      onChange('https', {
        ...listener.https,
        enabled: true,
        certPath: uploaded.certPath,
        keyPath: uploaded.keyPath,
      });

      setCertFile(null);
      setKeyFile(null);
      alert(t('tlsUploadSuccess') || 'TLS files uploaded successfully.');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      alert(`${t('tlsUploadFailed') || 'Failed to upload TLS files:'} ${message}`);
    }
  };

  return (
    <Card
      title={`Listener #${index + 1}`}
      actions={
        onRemove ? (
          <Button variant="danger" onClick={onRemove} style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}>
            {t('delete') || 'Delete'}
          </Button>
        ) : undefined
      }
    >
      <div className="ui-grid">
        <Input
          label={t('bindAddress') || 'Bind Address'}
          value={listener.bind || ''}
          onChange={(e) => onChange('bind', e.target.value)}
          placeholder="0.0.0.0"
        />
        <div>
          <Switch
            label={t('enableTcpListener') || 'Enable TCP'}
            checked={tcpEnabled}
            onChange={(checked) => onChange('tcp', checked ? (listener.tcp ?? 25565) : undefined)}
          />
          {tcpEnabled && (
            <Input
              label="TCP Port"
              type="number"
              value={listener.tcp || ''}
              onChange={(e) => onChange('tcp', parseOptionalPort(e.target.value))}
            />
          )}
        </div>
        <div>
          <Switch
            label={t('enableUdpListener') || 'Enable UDP'}
            checked={udpEnabled}
            onChange={(checked) => onChange('udp', checked ? (listener.udp ?? 25565) : undefined)}
          />
          {udpEnabled && (
            <Input
              label="UDP Port"
              type="number"
              value={listener.udp || ''}
              onChange={(e) => onChange('udp', parseOptionalPort(e.target.value))}
            />
          )}
        </div>
      </div>
      {!tcpEnabled && !udpEnabled && (
        <p className="text-sm text-secondary mb-4" style={{ color: 'var(--color-danger, #e5534b)' }}>
          {t('protocolBothDisabled') || 'Both TCP and UDP are disabled. This listener will not accept any traffic.'}
        </p>
      )}

      <div className="mt-4 mb-4">
        <Switch
          label="HAProxy Protocol"
          checked={listener.haproxy || false}
          onChange={(checked) => onChange('haproxy', checked)}
        />
      </div>

      <div className="mt-4 mb-4">
        <Switch
          label={t('rewriteBedrockPongPorts') || 'Rewrite Bedrock pong ports'}
          checked={listener.rewriteBedrockPongPorts ?? true}
          onChange={(checked) => onChange('rewriteBedrockPongPorts', checked)}
        />
      </div>

      <div className="mt-4 mb-4">
        <Switch
          label={t('enableHttpsListener') || 'Enable HTTPS Listener'}
          checked={listener.https?.enabled || false}
          onChange={(checked) => onChange('https', {
            enabled: checked,
            autoDetect: listener.https?.autoDetect ?? true,
            letsEncryptDomain: listener.https?.letsEncryptDomain || '',
            certPath: listener.https?.certPath || '',
            keyPath: listener.https?.keyPath || '',
          })}
        />
      </div>

      {listener.https?.enabled && (
        <>
          <div className="ui-grid">
            <Switch
              label={t('autoDetectLetsEncrypt') || 'Auto-detect Let\'s Encrypt'}
              checked={listener.https?.autoDetect ?? true}
              onChange={(checked) => onChange('https', {
                ...listener.https,
                enabled: true,
                autoDetect: checked,
              })}
            />
            <Input
              label={t('letsEncryptDomain') || 'Let\'s Encrypt Domain'}
              value={listener.https?.letsEncryptDomain || ''}
              onChange={(e) => onChange('https', {
                ...listener.https,
                enabled: true,
                letsEncryptDomain: e.target.value,
              })}
              placeholder="example.com"
            />
          </div>

          <div className="ui-grid">
            <Input
              label={t('tlsCertPath') || 'TLS Certificate Path'}
              value={listener.https?.certPath || ''}
              onChange={(e) => onChange('https', {
                ...listener.https,
                enabled: true,
                certPath: e.target.value,
              })}
              placeholder="/etc/letsencrypt/live/example.com/fullchain.pem"
            />
            <Input
              label={t('tlsKeyPath') || 'TLS Private Key Path'}
              value={listener.https?.keyPath || ''}
              onChange={(e) => onChange('https', {
                ...listener.https,
                enabled: true,
                keyPath: e.target.value,
              })}
              placeholder="/etc/letsencrypt/live/example.com/privkey.pem"
            />
          </div>

          <div className="ui-divider">
            <span className="ui-divider-label">{t('tlsUploadSection') || 'TLS Upload'}</span>
          </div>

          <div className="ui-grid">
            <Input
              label={t('tlsCertFile') || 'Certificate PEM'}
              type="file"
              accept=".pem,.crt,.cer"
              onChange={(e) => {
                setCertFile(e.target.files?.[0] ?? null);
              }}
            />
            <Input
              label={t('tlsKeyFile') || 'Private Key PEM'}
              type="file"
              accept=".pem,.key"
              onChange={(e) => {
                setKeyFile(e.target.files?.[0] ?? null);
              }}
            />
          </div>

          <Button variant="secondary" onClick={() => { void handleTlsBundleUpload(); }}>
            {t('uploadTlsFiles') || 'Upload TLS Files'}
          </Button>

          <p className="ui-help-text">
            {t('tlsUploadHint') || 'Uploading PEM files stores them inside this instance and fills the cert/key paths automatically.'}
          </p>
        </>
      )}

      <Input
        label="Webhook URL"
        value={listener.webhook || ''}
        onChange={(e) => onChange('webhook', e.target.value)}
        placeholder="https://discord.com/api/webhooks/..."
        fullWidth
      />

      <div className="ui-divider">
        <span className="ui-divider-label">{t('targetServers') || 'Target Servers'}</span>
      </div>

      <p className="text-sm text-secondary mb-4">
        {hasHttpMappings
          ? (t('optionalFallbackTargets') || 'With HTTP mappings, standard targets are optional fallbacks for unmatched or non-HTTP TCP traffic.')
          : (t('fallbackOrder') || 'Targets are tried in order. If the first target fails, the next target is used.')}
      </p>

      <p className="text-sm text-secondary mb-4">
        {t('splitTargetHint') || 'To route TCP and UDP to different hosts, add a "TCP only" target and a "UDP only" target with separate hosts.'}
      </p>

      {targets.length === 0 && (
        <p className="text-sm text-secondary mb-4">
          {t('noFallbackTargets') || 'No fallback target is configured. HTTP/HTTPS traffic will use the path mappings below.'}
        </p>
      )}

      {targets.map((target, targetIndex) => {
        const protocol = getTargetProtocol(target);
        const protocolOptions: Array<{ value: TargetProtocol; label: string }> = [
          { value: 'both', label: t('protoBoth') || 'TCP + UDP' },
          { value: 'tcp', label: t('protoTcpOnly') || 'TCP only' },
          { value: 'udp', label: t('protoUdpOnly') || 'UDP only' },
        ];
        return (
          <div key={targetIndex} className="mb-4">
            <div className="flex justify-between items-center mb-2">
              <strong className="text-primary">
                {(t('targetServer') || 'Target Server')} #{targetIndex + 1}
              </strong>
              {(targets.length > 1 || hasHttpMappings) && (
                <Button
                  variant="danger"
                  onClick={() => removeTarget(targetIndex)}
                  style={{ padding: '0.3rem 0.7rem', fontSize: '0.8rem' }}
                >
                  {t('removeTargetServer') || 'Remove Target'}
                </Button>
              )}
            </div>

            <div className="mb-2">
              <label className="ui-label" style={{ display: 'block', marginBottom: '0.35rem' }}>
                {t('protocolScope') || 'Protocol'}
              </label>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                {protocolOptions.map((option) => (
                  <Button
                    key={option.value}
                    variant={protocol === option.value ? 'primary' : 'ghost'}
                    onClick={() => handleTargetProtocolChange(targetIndex, option.value)}
                    style={{ padding: '0.35rem 0.85rem', fontSize: '0.8rem' }}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>

            <div className="ui-grid">
              <Input
                label={t('targetHost') || 'Target Host'}
                value={target.host || ''}
                onChange={(e) => handleTargetChange(targetIndex, 'host', e.target.value)}
                placeholder="localhost"
              />
              {protocol !== 'udp' && (
                <Input
                  label="Target TCP Port"
                  type="number"
                  value={target.tcp || ''}
                  onChange={(e) => handleTargetChange(targetIndex, 'tcp', parseOptionalPort(e.target.value))}
                />
              )}
              {protocol !== 'tcp' && (
                <Input
                  label="Target UDP Port"
                  type="number"
                  value={target.udp || ''}
                  onChange={(e) => handleTargetChange(targetIndex, 'udp', parseOptionalPort(e.target.value))}
                />
              )}
            </div>
          </div>
        );
      })}

      <Button variant="ghost" onClick={addTarget}>
        + {t('addTargetServer') || 'Add Target Server'}
      </Button>

      {(listener.tcp || listener.https?.enabled) && (
        <>
          <div className="ui-divider">
            <span className="ui-divider-label">{t('httpPathMappings') || 'HTTP Path Mappings'}</span>
          </div>

          <p className="text-sm text-secondary mb-4">
            {t('httpPathMappingsHint') || 'For HTTP/HTTPS traffic, the longest matching path is routed first. Choose paths carefully when they overlap.'}
          </p>

          {httpMappings.map((mapping, mappingIndex) => {
            const target = mapping.targets?.[0] ?? mapping.target ?? createEmptyTarget();
            return (
              <div key={mappingIndex} className="mb-4">
                <div className="flex justify-between items-center mb-2">
                  <strong className="text-primary">
                    {(t('httpPathMapping') || 'HTTP Mapping')} #{mappingIndex + 1}
                  </strong>
                  <Button
                    variant="danger"
                    onClick={() => removeHttpMapping(mappingIndex)}
                    style={{ padding: '0.3rem 0.7rem', fontSize: '0.8rem' }}
                  >
                    {t('remove') || 'Remove'}
                  </Button>
                </div>

                <div className="ui-grid">
                  <Input
                    label={t('externalPath') || 'External Path'}
                    value={mapping.path || '/'}
                    onChange={(e) => updateHttpMapping(mappingIndex, 'path', e.target.value)}
                    placeholder="/"
                  />
                  <Input
                    label={t('targetUrl') || 'Target URL'}
                    value={target.host || ''}
                    onChange={(e) => updateHttpMapping(mappingIndex, 'host', e.target.value)}
                    placeholder="https://example.com/base"
                  />
                  <Input
                    label="Target TCP Port"
                    type="number"
                    value={target.tcp || ''}
                    onChange={(e) => updateHttpMapping(mappingIndex, 'tcp', parseOptionalPort(e.target.value))}
                    placeholder="auto"
                  />
                </div>
              </div>
            );
          })}

          <Button variant="ghost" onClick={addHttpMapping}>
            + {t('addHttpPathMapping') || 'Add HTTP Mapping'}
          </Button>
        </>
      )}
    </Card>
  );
};
