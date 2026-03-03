import * as mysql from 'mysql2/promise';
import { ConnectionConfig } from './types';

export class DbConnectionManager {
  private connections = new Map<string, mysql.Connection>();

  async connectDirect(cfg: ConnectionConfig, password: string): Promise<void> {
    const opts: mysql.ConnectionOptions = {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password,
      multipleStatements: false,
    };
    if (cfg.database) {opts.database = cfg.database;}
    const conn = await mysql.createConnection(opts);
    this.connections.set(cfg.id, conn);
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
  }

  async disconnectAll(): Promise<void> {
    for (const id of this.connections.keys()) {
      await this.disconnect(id);
    }
  }
}
