import fs from 'fs/promises';
import { watch, FSWatcher } from 'fs';
import YAML from 'yaml';
import { EventEmitter } from 'events';
import chalk from 'chalk';

export interface FerrumProxyConfig {
  endpoint?: number;
  useRestApi?: boolean;
  savePlayerIP?: boolean;
  debug?: boolean;
  listeners?: Array<{
    bind?: string;
    tcp?: number;
    udp?: number;
    haproxy?: boolean;
    https?: {
      enabled?: boolean;
      autoDetect?: boolean;
      letsEncryptDomain?: string;
      certPath?: string;
      keyPath?: string;
    };
    webhook?: string;
    rewriteBedrockPongPorts?: boolean;
    target?: {
      host?: string;
      tcp?: number;
      udp?: number;
    };
    targets?: Array<{
      host?: string;
      tcp?: number;
      udp?: number;
    }>;
  }>;
}

export class ConfigManager extends EventEmitter {
  private watchers: Map<string, FSWatcher> = new Map();

  constructor() {
    super();
  }

  async read(configPath: string): Promise<FerrumProxyConfig> {
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      return YAML.parse(content);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.log(chalk.yellow(`Config file not found: ${configPath}`));
        return {};
      }
      throw error;
    }
  }

  async write(configPath: string, config: FerrumProxyConfig): Promise<void> {
    const content = YAML.stringify(this.sanitize(config));
    await fs.writeFile(configPath, content, 'utf-8');
    console.log(chalk.green(`✓ Config saved: ${configPath}`));
  }

  private sanitize(config: FerrumProxyConfig): FerrumProxyConfig {
    return {
      ...config,
      listeners: config.listeners?.map((listener) => {
        const https = listener.https
          ? {
              ...listener.https,
              letsEncryptDomain: listener.https.letsEncryptDomain?.trim() || undefined,
              certPath: listener.https.certPath?.trim() || undefined,
              keyPath: listener.https.keyPath?.trim() || undefined,
            }
          : undefined;

        return {
          ...listener,
          webhook: listener.webhook?.trim() || undefined,
          https,
        };
      }),
    };
  }

  async validate(config: FerrumProxyConfig): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    const validateTargetPorts = (
      target: { tcp?: number; udp?: number } | undefined,
      path: string
    ) => {
      if (!target) {
        return;
      }
      if (target.tcp !== undefined) {
        if (typeof target.tcp !== 'number' || target.tcp < 1 || target.tcp > 65535) {
          errors.push(`${path}.tcp must be a valid port number`);
        }
      }
      if (target.udp !== undefined) {
        if (typeof target.udp !== 'number' || target.udp < 1 || target.udp > 65535) {
          errors.push(`${path}.udp must be a valid port number`);
        }
      }
    };

    if (config.endpoint !== undefined) {
      if (typeof config.endpoint !== 'number' || config.endpoint < 1 || config.endpoint > 65535) {
        errors.push('endpoint must be a valid port number (1-65535)');
      }
    }

    if (config.listeners) {
      if (!Array.isArray(config.listeners)) {
        errors.push('listeners must be an array');
      } else {
        config.listeners.forEach((listener, index) => {
          if (listener.tcp !== undefined) {
            if (typeof listener.tcp !== 'number' || listener.tcp < 1 || listener.tcp > 65535) {
              errors.push(`listeners[${index}].tcp must be a valid port number`);
            }
          }
          if (listener.udp !== undefined) {
            if (typeof listener.udp !== 'number' || listener.udp < 1 || listener.udp > 65535) {
              errors.push(`listeners[${index}].udp must be a valid port number`);
            }
          }
          if (listener.https !== undefined) {
            if (typeof listener.https !== 'object' || listener.https === null) {
              errors.push(`listeners[${index}].https must be an object`);
            } else {
              if (listener.https.letsEncryptDomain !== undefined && typeof listener.https.letsEncryptDomain !== 'string') {
                errors.push(`listeners[${index}].https.letsEncryptDomain must be a string`);
              }
              if (listener.https.certPath !== undefined && typeof listener.https.certPath !== 'string') {
                errors.push(`listeners[${index}].https.certPath must be a string`);
              }
              if (listener.https.keyPath !== undefined && typeof listener.https.keyPath !== 'string') {
                errors.push(`listeners[${index}].https.keyPath must be a string`);
              }
            }
          }
          if (listener.target) {
            validateTargetPorts(listener.target, `listeners[${index}].target`);
          }
          if (listener.targets !== undefined) {
            if (!Array.isArray(listener.targets)) {
              errors.push(`listeners[${index}].targets must be an array`);
            } else {
              listener.targets.forEach((target, targetIndex) => {
                validateTargetPorts(target, `listeners[${index}].targets[${targetIndex}]`);
              });
            }
          }
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  watch(instanceId: string, configPath: string): void {
    if (this.watchers.has(instanceId)) {
      console.log(chalk.yellow(`Already watching config for ${instanceId}`));
      return;
    }

    console.log(chalk.blue(`Watching config: ${configPath}`));

    const watcher = watch(configPath, async (eventType) => {
      if (eventType === 'change') {
        try {
          const config = await this.read(configPath);
          this.emit('change', instanceId, config);
        } catch (error: any) {
          console.error(chalk.red(`Error reading config: ${error.message}`));
          this.emit('error', instanceId, error);
        }
      }
    });

    this.watchers.set(instanceId, watcher);
  }

  unwatch(instanceId: string): void {
    const watcher = this.watchers.get(instanceId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(instanceId);
      console.log(chalk.blue(`Stopped watching config for ${instanceId}`));
    }
  }

  unwatchAll(): void {
    for (const [instanceId] of this.watchers) {
      this.unwatch(instanceId);
    }
  }
}
