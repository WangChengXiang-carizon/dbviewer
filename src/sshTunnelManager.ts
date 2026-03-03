import * as mysql from 'mysql2/promise';
import * as fs from 'fs';
import { ConnectionConfig } from './types';

const SSHClient: any = require('ssh2').Client;

export class SshTunnelManager {
  private sshClients = new Map<string, any>();
  private connections = new Map<string, mysql.Connection>();

  async connectViaSsh(cfg: ConnectionConfig, password: string): Promise<void> {
    const sshKey = `${cfg.sshHost}|${cfg.sshPort ?? 22}|${cfg.sshUser}|${cfg.sshPrivateKey ?? ''}`;
    let holder = this.sshClients.get(sshKey);
    if (!holder) {
      const ssh = new SSHClient();
      holder = {
        client: ssh,
        refs: new Set<string>(),
        streams: new Map<string, any>(),
        ready: false,
        queue: []
      };
      this.sshClients.set(sshKey, holder);
      ssh.on('ready', () => {
        holder.ready = true;
        // 处理队列
        while (holder.queue.length > 0) {
          const { cfg, password, resolve, reject } = holder.queue.shift();
          this._forwardOut(holder, cfg, password, resolve, reject);
        }
      }).on('error', (err: any) => {
        while (holder.queue.length > 0) {
          const { reject } = holder.queue.shift();
          reject(err);
        }
      });
      ssh.connect({
        host: cfg.sshHost,
        port: cfg.sshPort ?? 22,
        username: cfg.sshUser,
        password: cfg.sshPassword,
        privateKey: cfg.sshPrivateKey ? fs.readFileSync(cfg.sshPrivateKey) : undefined,
        passphrase: cfg.sshPassphrase,
        keepaliveInterval: 20000,
        readyTimeout: 20000
      });
    }
    await new Promise<void>((resolve, reject) => {
      if (holder.ready) {
        this._forwardOut(holder, cfg, password, resolve, reject);
      } else {
        holder.queue.push({ cfg, password, resolve, reject });
      }
    });
  }

  private async _forwardOut(holder: any, cfg: ConnectionConfig, password: string, resolve: Function, reject: Function) {
    holder.client.forwardOut('127.0.0.1', 0, cfg.host, cfg.port, async (err: Error | null, stream: any) => {
      if (err) { return reject(err); }
      try {
        const opts: any = { user: cfg.user, password, stream, multipleStatements: false };
        if (cfg.database) { opts.database = cfg.database; }
        const conn = await mysql.createConnection(opts);
        this.connections.set(cfg.id, conn);
        holder.refs.add(cfg.id);
        holder.streams.set(cfg.id, stream);
        resolve();
      } catch (e) {
        stream.destroy();
        reject(e);
      }
    });
  }

  getConnection(id: string): mysql.Connection | undefined {
    return this.connections.get(id);
  }

  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (conn) {
      await conn.end();
      this.connections.delete(id);
    }
    // 省略ssh client清理逻辑
  }
}
