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
  sharedService?: {
    enabled?: boolean;
    controlBind?: string;
    publicBind?: string;
    publicHost?: string;
    portRange?: {
      start?: number;
      end?: number;
    };
    authTokens?: string[];
    allowAnonymous?: boolean;
    queue?: {
      enabled?: boolean;
      maxSize?: number;
    };
    tokens?: Array<{
      name?: string;
      token?: string;
      enabled?: boolean;
      priority?: number;
      limits?: {
        maxTcpConnections?: number;
        maxUdpPeers?: number;
        maxBytesPerSecond?: number;
        idleTimeoutSeconds?: number;
        udpSessionTimeoutSeconds?: number;
      };
    }>;
    defaults?: {
      maxTcpConnections?: number;
      maxUdpPeers?: number;
      maxBytesPerSecond?: number;
      idleTimeoutSeconds?: number;
      udpSessionTimeoutSeconds?: number;
    };
    maximums?: {
      maxTcpConnections?: number;
      maxUdpPeers?: number;
      maxBytesPerSecond?: number;
      idleTimeoutSeconds?: number;
      udpSessionTimeoutSeconds?: number;
    };
  };
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
    httpMappings?: Array<{
      path: string;
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
    const sanitized: FerrumProxyConfig = { ...config };

    // Sanitize sharedService
    if (sanitized.sharedService) {
      const shared = { ...sanitized.sharedService };
      if (shared.controlBind) shared.controlBind = shared.controlBind.trim();
      if (shared.publicBind) shared.publicBind = shared.publicBind.trim();
      if (shared.publicHost) shared.publicHost = shared.publicHost.trim();

      // Clean up tokens: remove tokens with empty token strings
      if (shared.tokens) {
        shared.tokens = shared.tokens
          .filter((t) => t.token && t.token.trim().length > 0)
          .map((t) => ({
            ...t,
            token: t.token!.trim(),
            name: t.name?.trim() || undefined,
          }));
      }

      // Clean up authTokens: remove empty strings
      if (shared.authTokens) {
        shared.authTokens = shared.authTokens.filter((t) => t.trim().length > 0);
      }

      // Ensure port range values are integers
      if (shared.portRange) {
        if (shared.portRange.start !== undefined) {
          shared.portRange.start = Math.floor(shared.portRange.start);
        }
        if (shared.portRange.end !== undefined) {
          shared.portRange.end = Math.floor(shared.portRange.end);
        }
      }

      sanitized.sharedService = shared;
    }

    // Sanitize listeners
    sanitized.listeners = config.listeners?.map((listener) => {
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
    });

    return sanitized;
  }

  async validate(config: FerrumProxyConfig, isSharedRelayMode: boolean = false): Promise<{ valid: boolean; errors: string[] }> {
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

    const validatePositiveLimit = (value: unknown, path: string) => {
      if (value !== undefined && (!Number.isInteger(value) || Number(value) < 1)) {
        errors.push(`${path} must be a positive integer`);
      }
    };

    const validatePort = (value: unknown, path: string) => {
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
          errors.push(`${path} must be a valid port number (1-65535)`);
        }
      }
    };

    if (config.sharedService) {
      const shared = config.sharedService;

      // Validate controlBind when shared service is enabled
      if (shared.enabled && shared.controlBind) {
        const bindParts = shared.controlBind.split(':');
        if (bindParts.length !== 2 || isNaN(Number(bindParts[1]))) {
          errors.push('sharedService.controlBind must be in format host:port');
        }
      }

      if (shared.portRange) {
        validatePort(shared.portRange.start, 'sharedService.portRange.start');
        validatePort(shared.portRange.end, 'sharedService.portRange.end');
        if (
          typeof shared.portRange.start === 'number' &&
          typeof shared.portRange.end === 'number' &&
          shared.portRange.start > shared.portRange.end
        ) {
          errors.push('sharedService.portRange.start must be less than or equal to end');
        }
      }

      for (const groupName of ['defaults', 'maximums'] as const) {
        const group = shared[groupName];
        if (!group) continue;
        validatePositiveLimit(group.maxTcpConnections, `sharedService.${groupName}.maxTcpConnections`);
        validatePositiveLimit(group.maxUdpPeers, `sharedService.${groupName}.maxUdpPeers`);
        validatePositiveLimit(group.maxBytesPerSecond, `sharedService.${groupName}.maxBytesPerSecond`);
        validatePositiveLimit(group.idleTimeoutSeconds, `sharedService.${groupName}.idleTimeoutSeconds`);
        validatePositiveLimit(group.udpSessionTimeoutSeconds, `sharedService.${groupName}.udpSessionTimeoutSeconds`);
      }

      if (shared.queue) {
        validatePositiveLimit(shared.queue.maxSize, 'sharedService.queue.maxSize');
      }

      if (shared.tokens !== undefined) {
        if (!Array.isArray(shared.tokens)) {
          errors.push('sharedService.tokens must be an array');
        } else {
          shared.tokens.forEach((token, index) => {
            if (!token.token || typeof token.token !== 'string') {
              errors.push(`sharedService.tokens[${index}].token must be a non-empty string`);
            }
            if (
              token.priority !== undefined &&
              (!Number.isInteger(token.priority) || Number(token.priority) < 0)
            ) {
              errors.push(`sharedService.tokens[${index}].priority must be a non-negative integer`);
            }
            if (token.limits) {
              validatePositiveLimit(token.limits.maxTcpConnections, `sharedService.tokens[${index}].limits.maxTcpConnections`);
              validatePositiveLimit(token.limits.maxUdpPeers, `sharedService.tokens[${index}].limits.maxUdpPeers`);
              validatePositiveLimit(token.limits.maxBytesPerSecond, `sharedService.tokens[${index}].limits.maxBytesPerSecond`);
              validatePositiveLimit(token.limits.idleTimeoutSeconds, `sharedService.tokens[${index}].limits.idleTimeoutSeconds`);
              validatePositiveLimit(token.limits.udpSessionTimeoutSeconds, `sharedService.tokens[${index}].limits.udpSessionTimeoutSeconds`);
            }
          });
        }
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
