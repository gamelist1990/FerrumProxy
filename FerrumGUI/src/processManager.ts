import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import chalk from 'chalk';

export interface ProcessOptions {
  workingDirectory: string;
  binaryPath: string;
  args?: string[];
  env?: Record<string, string>;
  useSudo?: boolean;
}

export interface LogEntry {
  timestamp: string;
  type: 'stdout' | 'stderr' | 'system';
  message: string;
}

export class ProcessManager extends EventEmitter {
  private processes: Map<string, ChildProcess> = new Map();
  private logs: Map<string, LogEntry[]> = new Map();
  private maxLogEntries = 1000;

  constructor() {
    super();
  }

  start(instanceId: string, options: ProcessOptions): number {
    if (this.processes.has(instanceId)) {
      throw new Error(`Process for instance ${instanceId} is already running`);
    }

    console.log(chalk.blue(`Starting FerrumProxy instance: ${instanceId}`));
    console.log(chalk.gray(`  Binary: ${options.binaryPath}`));
    console.log(chalk.gray(`  Working Directory: ${options.workingDirectory}`));

    const shouldUseSudo = !!options.useSudo && process.platform !== 'win32';
    const command = shouldUseSudo ? 'sudo' : options.binaryPath;
    const commandArgs = shouldUseSudo
      ? ['-n', options.binaryPath, ...(options.args || [])]
      : (options.args || []);

    if (shouldUseSudo) {
      console.log(chalk.yellow('  Running with sudo (Unix platform policy)'));
    }

    const child = spawn(command, commandArgs, {
      cwd: options.workingDirectory,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.processes.set(instanceId, child);
    this.logs.set(instanceId, []);

    
    this.addLog(instanceId, 'system', `Process started (PID: ${child.pid})`);

    
    child.stdout?.on('data', (data: Buffer) => {
      const message = data.toString();
      this.addLog(instanceId, 'stdout', message);
      this.emit('log', instanceId, 'stdout', message);
    });

    
    child.stderr?.on('data', (data: Buffer) => {
      const message = data.toString();
      this.addLog(instanceId, 'stderr', message);
      this.emit('log', instanceId, 'stderr', message);
    });

    
    child.on('exit', (code, signal) => {
      const message = `Process exited with code ${code}, signal ${signal}`;
      console.log(chalk.yellow(`${instanceId}: ${message}`));
      this.addLog(instanceId, 'system', message);
      this.emit('exit', instanceId, code, signal);
      this.processes.delete(instanceId);
    });

    
    child.on('error', (error) => {
      const message = `Process error: ${error.message}`;
      console.error(chalk.red(`${instanceId}: ${message}`));
      this.addLog(instanceId, 'system', message);
      this.emit('error', instanceId, error);
    });

    console.log(chalk.green(`✓ Process started with PID: ${child.pid}`));

    if (!child.pid) {
      throw new Error('Failed to get process PID');
    }

    return child.pid;
  }

  stop(instanceId: string, force: boolean = false): void {
    const child = this.processes.get(instanceId);
    
    if (!child) {
      throw new Error(`No running process found for instance ${instanceId}`);
    }

    console.log(chalk.blue(`Stopping FerrumProxy instance: ${instanceId}`));
    this.addLog(instanceId, 'system', `Stopping process (force: ${force})`);

    if (force) {
      child.kill('SIGKILL');
    } else {
      child.kill('SIGTERM');
    }
  }

  async restart(instanceId: string, options: ProcessOptions): Promise<number> {
    console.log(chalk.blue(`Restarting FerrumProxy instance: ${instanceId}`));
    
    if (this.isRunning(instanceId)) {
      this.stop(instanceId);
      
      
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (!this.isRunning(instanceId)) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
        
        
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, 10000);
      });
    }
    
    return this.start(instanceId, options);
  }

  isRunning(instanceId: string): boolean {
    return this.processes.has(instanceId);
  }

  getPid(instanceId: string): number | undefined {
    return this.processes.get(instanceId)?.pid;
  }

  getLogs(instanceId: string, limit?: number): LogEntry[] {
    const logs = this.logs.get(instanceId) || [];
    return limit ? logs.slice(-limit) : logs;
  }

  clearLogs(instanceId: string): void {
    this.logs.set(instanceId, []);
  }

  private addLog(instanceId: string, type: LogEntry['type'], message: string): void {
    const logs = this.logs.get(instanceId) || [];
    
    logs.push({
      timestamp: new Date().toISOString(),
      type,
      message: message.trim(),
    });

    
    if (logs.length > this.maxLogEntries) {
      logs.splice(0, logs.length - this.maxLogEntries);
    }

    this.logs.set(instanceId, logs);
  }

  stopAll(): void {
    console.log(chalk.blue('Stopping all processes...'));
    
    for (const [instanceId] of this.processes) {
      try {
        this.stop(instanceId);
      } catch (error: any) {
        console.error(chalk.red(`Error stopping ${instanceId}: ${error.message}`));
      }
    }
  }
}
