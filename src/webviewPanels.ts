import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as mysql from 'mysql2/promise';

export class TableViewPanel {
  static show(extensionPath: string, conn: mysql.Connection, dbName: string, tableName: string) {
    const panel = vscode.window.createWebviewPanel(
      'dbviewerTable',
      `表：${dbName}.${tableName}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const htmlPath = path.join(extensionPath, 'media', 'tableView.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(/\{\{TBL\}\}/g, tableName)
               .replace(/\{\{DB\}\}/g, dbName)
               .replace(/\{\{TITLE\}\}/g, `表：${dbName}.${tableName}`);
    panel.webview.html = html;
    // 可选：事件通信
    // panel.webview.onDidReceiveMessage(...)
  }
}

export class SqlQueryPanel {
  static show(extensionPath: string, conn: mysql.Connection, connId: string, dbName: string, tableName?: string) {
    const title = tableName ? `查询 ${dbName}.${tableName}` : `查询 ${dbName}`;
    const panel = vscode.window.createWebviewPanel(
      'dbviewerQuery',
      title,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const htmlPath = path.join(extensionPath, 'media', 'sqlQuery.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(/\{\{TITLE\}\}/g, title)
               .replace(/\{\{DB\}\}/g, dbName)
               .replace(/\{\{TBL\}\}/g, tableName || '')
               .replace(/\{\{CONNID\}\}/g, connId);
    panel.webview.html = html;
    // 可选：事件通信
    // panel.webview.onDidReceiveMessage(...)
  }
}

export class ConnectionConfigPanel {
  static async show(context: vscode.ExtensionContext, provider: any, cfg?: any) {
    const panel = vscode.window.createWebviewPanel(
      'dbviewerConnConfig',
      cfg ? `编辑连接：${cfg.name}` : '新建连接',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const extensionPath = context.extensionPath || '';
    const htmlPath = path.join(extensionPath, 'media', 'connectionConfig.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(/\{\{TITLE\}\}/g, cfg ? `编辑连接：${cfg.name}` : '新建连接')
               .replace(/\{\{HEADING\}\}/g, cfg ? `编辑连接：${cfg.name}` : '新建连接')
               .replace(/\{\{CONNID\}\}/g, cfg?.id || '');
    panel.webview.html = html;

    // 页面 ready 后发送配置和密码
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'ready') {
        let pwd = '';
        if (cfg?.id) {
          try {
            // 动态加载密码
            const { loadPwd } = await import('./configStorage.js');
            pwd = await loadPwd(context, cfg.id);
          } catch {}
        }
        panel.webview.postMessage({ type: 'init', cfg, pwd });
      }
      // 这里可继续处理 save/test/delete 等命令
    });
  }
}
