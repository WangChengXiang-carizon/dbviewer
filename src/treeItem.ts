import * as vscode from 'vscode';
import { DbNode } from './types';

export class DatabaseTreeItem extends vscode.TreeItem {
  constructor(
    public readonly node: DbNode,
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsible);
    this.tooltip = label;

    // 设置稳定的 `id`，确保 VS Code 能正确识别并刷新单个节点（用于更新状态颜色）
    if (node.type === 'connection') {
      this.id = node.connId;
    } else if (node.type === 'database') {
      this.id = `${node.connId}::db::${node.label}`;
    } else if (node.type === 'table') {
      this.id = `${node.connId}::tbl::${node.database || ''}::${node.label}`;
    }

    switch (node.type) {
      case 'connection':
        // connection icon is set by the provider to allow colored status icons
        this.contextValue = 'connection';
        break;
      case 'database':
        this.iconPath = new vscode.ThemeIcon('database');
        this.contextValue = 'database';
        break;
      case 'table':
        this.iconPath = new vscode.ThemeIcon('table');
        this.contextValue = 'table';
        break;
    }
  }
}
