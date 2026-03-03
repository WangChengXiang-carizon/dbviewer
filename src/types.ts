// 类型定义和接口
export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database: string;
  sshEnabled?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshPassword?: string;
  sshPrivateKey?: string;
  sshPassphrase?: string;
}

export type NodeType = 'connection' | 'database' | 'table';

export interface DbNode {
  type: NodeType;
  label: string;
  connId: string;
  database?: string;
}
