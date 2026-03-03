
import * as vscode from 'vscode';
import { ConnectionConfig } from './types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CONNS_KEY = 'dbviewer.connections';
const CONFIG_PATH = path.join(os.homedir(), '.dbviewer', 'config.json');

export function loadConfigs(context: vscode.ExtensionContext): ConnectionConfig[] {
  // 优先从 globalState 读取
  let configs: ConnectionConfig[] = [];
  try {
    configs = context.globalState.get<ConnectionConfig[]>(CONNS_KEY, []);
    if (configs && configs.length > 0) {return configs;}
  } catch {}
  // 其次尝试从本地文件读取
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {return arr;}
    }
  } catch {}
  return [];
}

export async function saveConfigs(context: vscode.ExtensionContext, configs: ConnectionConfig[]): Promise<void> {
  try {
    await context.globalState.update(CONNS_KEY, configs);
  } catch {}
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true });}
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(configs, null, 2), { encoding: 'utf8' });
  } catch {}
}

export async function loadPwd(context: vscode.ExtensionContext, id: string): Promise<string> {
  try {
    return await context.secrets.get(`dbviewer.pwd.${id}`) || '';
  } catch { return ''; }
}

export async function savePwd(context: vscode.ExtensionContext, id: string, pwd: string): Promise<void> {
  try {
    await context.secrets.store(`dbviewer.pwd.${id}`, pwd);
  } catch {}
}

export async function deletePwd(context: vscode.ExtensionContext, id: string): Promise<void> {
  try {
    await context.secrets.delete(`dbviewer.pwd.${id}`);
  } catch {}
}
