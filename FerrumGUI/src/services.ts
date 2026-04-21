import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type FerrumProxyPlatform = 'linux' | 'linux-arm64' | 'macos-arm64' | 'windows';

export interface FerrumProxyInstance {
  id: string;
  name: string;
  version: string;
  platform: FerrumProxyPlatform;
  binaryPath: string;
  dataDir: string;
  configPath: string;
  pid?: number;
  lastStarted?: string;
  autoStart: boolean;
  autoRestart: boolean;
  downloadSource: {
    url: string;
  };
}

export interface ServicesData {
  instances: FerrumProxyInstance[];
  lastUpdated: string;
  auth?: {
    username: string;
    password: string;
  };
}

export class ServiceManager {
  private servicesPath: string;
  private data: ServicesData;

  constructor(servicesPath?: string) {
    this.servicesPath = servicesPath || path.join(process.cwd(), 'services.json');
    this.data = { instances: [], lastUpdated: new Date().toISOString() };
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.servicesPath, 'utf-8');
      this.data = JSON.parse(content);
      this.data.instances = (this.data.instances || []).map((instance) => ({
        ...instance,
        autoStart: instance.autoStart ?? false,
        autoRestart: instance.autoRestart ?? false,
      }));
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        
        await this.save();
      } else {
        throw error;
      }
    }
  }

  async save(): Promise<void> {
    this.data.lastUpdated = new Date().toISOString();
    await fs.writeFile(this.servicesPath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  getAll(): FerrumProxyInstance[] {
    return this.data.instances;
  }

  getById(id: string): FerrumProxyInstance | undefined {
    return this.data.instances.find(instance => instance.id === id);
  }

  async add(instance: FerrumProxyInstance): Promise<void> {
    
    if (this.getById(instance.id)) {
      throw new Error(`Instance with ID ${instance.id} already exists`);
    }
    this.data.instances.push(instance);
    await this.save();
  }

  async update(id: string, updates: Partial<FerrumProxyInstance>): Promise<void> {
    const index = this.data.instances.findIndex(instance => instance.id === id);
    if (index === -1) {
      throw new Error(`Instance with ID ${id} not found`);
    }
    this.data.instances[index] = { ...this.data.instances[index], ...updates };
    await this.save();
  }

  async remove(id: string): Promise<void> {
    const index = this.data.instances.findIndex(instance => instance.id === id);
    if (index === -1) {
      throw new Error(`Instance with ID ${id} not found`);
    }
    this.data.instances.splice(index, 1);
    await this.save();
  }

  async setPid(id: string, pid: number | undefined): Promise<void> {
    await this.update(id, { pid, lastStarted: pid ? new Date().toISOString() : undefined });
  }

  getAuth(): { username: string; password: string } | undefined {
    return this.data.auth;
  }

  async setAuth(username: string, password: string): Promise<void> {
    this.data.auth = { username, password };
    await this.save();
  }

  async verifyAuth(username: string, password: string): Promise<boolean> {
    if (!this.data.auth) {
      return true; 
    }
    return this.data.auth.username === username && this.data.auth.password === password;
  }

  hasAuth(): boolean {
    return !!this.data.auth;
  }
}
