import * as vscode from 'vscode';
import * as mysql from 'mysql2/promise';
import { DatabaseTreeItem } from './treeItem';
import { ConnectionConfig } from './types';
import { loadConfigs, saveConfigs, loadPwd, savePwd, deletePwd } from './configStorage';
import { DbConnectionManager } from './dbConnectionManager';
import { SshTunnelManager } from './sshTunnelManager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TableViewPanel, ConnectionConfigPanel, SqlQueryPanel } from './webviewPanels';

// 通知辅助函数
function notifyInfo(message: string, transientMs = 3000) {
    try { outputChannel?.appendLine(`[INFO] ${new Date().toLocaleTimeString()} ${message}`); } catch {}
    // ...可选：状态栏通知...
}
function notifyError(message: string) {
    try { outputChannel?.appendLine(`[ERROR] ${new Date().toLocaleTimeString()} ${message}`); } catch {}
    vscode.window.showErrorMessage(message);
}
function initNotifications(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('DB Viewer');
    context.subscriptions.push(outputChannel);
}

// 其他辅助变量声明
let outputChannel: vscode.OutputChannel | undefined;

class DatabaseTreeDataProvider implements vscode.TreeDataProvider<DatabaseTreeItem> {
    private dbManager: DbConnectionManager;
    private sshManager: SshTunnelManager;
    private connections = new Map<string, mysql.Connection>();
    private failedConnections = new Set<string>();
    private sshClients = new Map<string, any>();
    private connToSshKey = new Map<string, string>();
    private intentionallyClosing = new Set<string>();
    private sshKeyLocks = new Map<string, Promise<void>>();
    private _onDidChangeTreeData = new vscode.EventEmitter<DatabaseTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    
    constructor(private readonly context: vscode.ExtensionContext) {
        this.dbManager = new DbConnectionManager();
        this.sshManager = new SshTunnelManager();
        initNotifications(context);
    }

    async connect(cfg: ConnectionConfig, password: string): Promise<void> {
        await this.disconnect(cfg.id);
        if (cfg.sshEnabled) {
            await this.sshManager.connectViaSsh(cfg, password);
            const conn = this.sshManager.getConnection(cfg.id);
            if (conn) { this.connections.set(cfg.id, conn); }
        } else {
            await this.dbManager.connectDirect(cfg, password);
            const conn = this.dbManager.getConnection(cfg.id);
            if (conn) { this.connections.set(cfg.id, conn); }
        }
        // 仅刷新该连接节点，避免影响其它连接的 UI 状态
        this.refreshConnectionNode(cfg.id);
    }

    private sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

    private async runWithSshKeyLock(key: string, fn: () => Promise<void>) {
        const prev = this.sshKeyLocks.get(key) || Promise.resolve();
        const next = prev.then(() => fn()).catch((e) => {
            try { outputChannel?.appendLine(`[DBG] sshKeyLock fn error for ${key}: ${(e as Error)?.message}`); } catch {}
        });
        this.sshKeyLocks.set(key, next);
        try {
            await next;
        } finally {
            if (this.sshKeyLocks.get(key) === next) { this.sshKeyLocks.delete(key); }
        }
    }


    // refresh(): void { this._onDidChangeTreeData.fire(); }

    // ── connection management ────────────────────────────────────

    async disconnect(id: string): Promise<void> {
        try {
            try { outputChannel?.appendLine(`[DBG] disconnect called for ${id}`); } catch {}
            const conn = this.connections.get(id);
            if (conn) {
                try { await conn.end(); } catch { /* ignore */ }
                this.connections.delete(id);
            }
            const sshKey = this.connToSshKey.get(id);
            if (sshKey) {
                const holder = this.sshClients.get(sshKey);
                if (holder) {
                    // 只移除当前连接的stream和ref，不影响其他连接
                    const stream = holder.streams.get(id);
                    if (stream) {
                        this.intentionallyClosing.add(id);
                        try { outputChannel?.appendLine(`[DBG] destroying forward stream for ${id}`); } catch {}
                        try {
                            if (stream && typeof stream.end === 'function') {
                                try { stream.end(); } catch {}
                                setTimeout(() => { try { stream && stream.destroy && stream.destroy(); } catch {} }, 1000);
                            } else {
                                try { stream && stream.destroy && stream.destroy(); } catch {}
                            }
                        } catch {}
                        setTimeout(() => { try { this.intentionallyClosing.delete(id); outputChannel?.appendLine(`[DBG] intentionallyClosing cleared for ${id}`); } catch {} }, 3000);
                    }
                    holder.streams.delete(id);
                    holder.refs.delete(id);
                    try { outputChannel?.appendLine(`[DBG] holder.refs after delete: ${Array.from(holder.refs).join(',')}`); } catch {}
                    // 只有当没有其他ref时才关闭ssh client
                    if (!holder.refs.size) {
                        try { outputChannel?.appendLine(`[DBG] no more refs, ending ssh client for key=${sshKey}`); } catch {}
                        try { holder.client && holder.client.end && holder.client.end(); } catch {}
                        this.sshClients.delete(sshKey);
                    }
                }
                this.connToSshKey.delete(id);
            }
            // 仅刷新该连接节点，避免影响其它连接的 UI 状态
            this.refreshConnectionNode(id);
        } catch (err) {
            outputChannel?.appendLine(`[ERROR] disconnect failed for ${id}: ${(err as Error).message}`);
            throw err;
        }
    }


    markFailed(id: string) { this.failedConnections.add(id); this.refreshConnectionNode(id); }
    clearFailed(id: string) { if (this.failedConnections.has(id)) { this.failedConnections.delete(id); this.refreshConnectionNode(id); } }
    isFailed(id: string) { return this.failedConnections.has(id); }

    async disconnectAll(): Promise<void> {
        await this.dbManager.disconnectAll();
        // 断开所有 ssh 连接
        for (const [id] of this.connections) {
            await this.sshManager.disconnect(id);
        }
        this.connections.clear();
    }

    isConnected(id: string): boolean { return this.connections.has(id); }

    getConnection(id: string): mysql.Connection | undefined { return this.connections.get(id); }

    // ── TreeDataProvider impl ────────────────────────────────────

    getTreeItem(e: DatabaseTreeItem): vscode.TreeItem { return e; }

    async getChildren(element?: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
        try {
            // 根：列出所有已保存的连接
            if (!element) {
                try { outputChannel?.appendLine(`[DBG] getChildren(root) connections=${Array.from(this.connections.keys()).join(',')} failed=${Array.from(this.failedConnections).join(',')} sshClients=${Array.from(this.sshClients.keys()).join(',')}`); } catch {}
                const configs = loadConfigs(this.context);
                return configs.map(cfg => {
                    const connected = this.isConnected(cfg.id);
                    const failed = this.isFailed(cfg.id);
                    const item = new DatabaseTreeItem(
                        { type: 'connection', label: cfg.name, connId: cfg.id },
                        cfg.name,
                        connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
                    );
                    if (connected) {
                        item.iconPath = {
                            light: vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'conn-green.svg')),
                            dark:  vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'conn-green.svg'))
                        };
                    } else if (failed) {
                        item.iconPath = {
                            light: vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'conn-red.svg')),
                            dark:  vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'conn-red.svg'))
                        };
                    } else {
                        item.iconPath = {
                            light: vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'conn-gray.svg')),
                            dark:  vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'conn-gray.svg'))
                        };
                    }
                    return item;
                });
            }

            // 连接节点 → 列出数据库
            if (element.node.type === 'connection') {
                try { outputChannel?.appendLine(`[DBG] getChildren(connection) connections=${Array.from(this.connections.keys()).join(',')} sshClients=${Array.from(this.sshClients.keys()).join(',')}`); } catch {}
                const conn = this.connections.get(element.node.connId);
                if (!conn) { return []; }
                try {
                    const [rows] = await conn.execute<mysql.RowDataPacket[]>('SHOW DATABASES');
                    if (!Array.isArray(rows)) {
                        try { outputChannel?.appendLine(`[WARN] SHOW DATABASES returned non-array for connId=${element.node.connId}: ${JSON.stringify(rows).slice(0,200)}`); } catch {}
                        return [];
                    }
                    return rows.map(row => new DatabaseTreeItem(
                        { type: 'database', label: row['Database'] as string, connId: element.node.connId },
                        row['Database'] as string,
                        vscode.TreeItemCollapsibleState.Collapsed
                    ));
                    
                } catch (err) {
                    outputChannel?.appendLine(`[ERROR] getChildren(connection) failed for ${element.node.connId}: ${(err as Error).message}`);
                    return [];
                }
            }

            // 数据库节点 → 列出数据表
            if (element.node.type === 'database') {
                try { outputChannel?.appendLine(`[DBG] getChildren(database) connections=${Array.from(this.connections.keys()).join(',')} sshClients=${Array.from(this.sshClients.keys()).join(',')} requestedConn=${element.node.connId}`); } catch {}
                const conn = this.connections.get(element.node.connId);
                try { outputChannel?.appendLine(`[DBG] getChildren(database) called for connId=${element.node.connId} db=${element.node.label} connExists=${!!conn}`); } catch {}
                if (!conn) { return []; }
                const dbName = element.node.label;
                try {
                    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
                        `SHOW TABLES FROM \`${dbName}\``
                    );
                    if (!Array.isArray(rows)) {
                        try { outputChannel?.appendLine(`[WARN] SHOW TABLES returned non-array for ${dbName} on connId=${element.node.connId}: ${JSON.stringify(rows).slice(0,200)}`); } catch {}
                        return [];
                    }
                    try { outputChannel?.appendLine(`[DBG] SHOW TABLES returned ${rows.length} rows for ${dbName} on connId=${element.node.connId}`); } catch {}
                    const key = `Tables_in_${dbName}`;
                    return rows.map(row => {
                        const item = new DatabaseTreeItem(
                            { type: 'table', label: row[key] as string, connId: element.node.connId, database: dbName },
                            row[key] as string,
                            vscode.TreeItemCollapsibleState.None
                        );
                        item.command = {
                            command: 'dbviewer.openTable',
                            title: 'Open Table',
                            arguments: [item]
                        };
                        return item;
                    });
                } catch (err) {
                    outputChannel?.appendLine(`[ERROR] getChildren(database) failed for ${element.node.connId} db=${dbName}: ${(err as Error).message}`);
                    return [];
                }
            }

            return [];
        } catch (err) {
            outputChannel?.appendLine(`[ERROR] getChildren failed: ${(err as Error).message}`);
            return [];
        }
    }

    async refreshConnectionNode(id: string): Promise<void> {
        // 只刷新指定连接的状态和子节点
        const configs = loadConfigs(this.context);
        const cfg = configs.find(c => c.id === id);
        if (!cfg) {return;}
        const connected = this.isConnected(id);
        const failed = this.isFailed(id);
        try { outputChannel?.appendLine(`[DBG] refreshConnectionNode: id=${id} connected=${connected} failed=${failed} cfgName=${cfg.name}`); } catch {}
        // 构造新的 TreeItem 并触发刷新
        const item = new DatabaseTreeItem(
            { type: 'connection', label: cfg.name, connId: cfg.id },
            cfg.name,
            connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        );
        if (connected) {
            item.iconPath = {
                light: vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'conn-green.svg')),
                dark:  vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'conn-green.svg'))
            };
        } else if (failed) {
            item.iconPath = {
                light: vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'conn-red.svg')),
                dark:  vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'conn-red.svg'))
            };
        } else {
            item.iconPath = {
                light: vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'conn-gray.svg')),
                dark:  vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'conn-gray.svg'))
            };
        }
        this._onDidChangeTreeData.fire(item);
    }

    

    refresh(node?: DatabaseTreeItem): void {
        this._onDidChangeTreeData.fire(node);
    }
}
// ────────────────────────────────────────────────────────────────
// activate
// ────────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
	console.log('dbviewer extension activated');

	// init reduced-notification helpers
	initNotifications(context);

	const provider = new DatabaseTreeDataProvider(context);
	const treeView = vscode.window.createTreeView('dbviewer.databasesView', {
		treeDataProvider: provider,
		showCollapseAll: true
	});
	context.subscriptions.push(treeView);

	// ── 打开表视图（点击树节点）────────────────────────────────
	const openTableCmd = vscode.commands.registerCommand('dbviewer.openTable', (item: DatabaseTreeItem) => {
		const conn = provider.getConnection(item.node.connId);
		if (!conn) {
			vscode.window.showWarningMessage('请先连接到 MySQL');
			return;
		}
		if (!item.node.database) { return; }
		TableViewPanel.show(context.extensionPath, conn, item.node.database, item.node.label);
	});

	// ── SQL 查询（数据库/数据表）────────────────────────────────
	const openQueryCmd = vscode.commands.registerCommand('dbviewer.openQuery', (item: DatabaseTreeItem) => {
		const conn = provider.getConnection(item.node.connId);
		if (!conn) {
			vscode.window.showWarningMessage('请先连接到 MySQL');
			return;
		}
		if (item.node.type === 'database') {
			SqlQueryPanel.show(context.extensionPath, conn, item.node.connId, item.node.label);
			return;
		}
		if (item.node.type === 'table' && item.node.database) {
			SqlQueryPanel.show(context.extensionPath, conn, item.node.connId, item.node.database, item.node.label);
		}
	});

	// ── 新建连接 ──────────────────────────────────────────────
    const addConnCmd = vscode.commands.registerCommand('dbviewer.addConnection', async () => {
        await ConnectionConfigPanel.show(context, provider);
    });

	// ── 编辑连接（树节点右键） ─────────────────────────────────
    const editConnCmd = vscode.commands.registerCommand('dbviewer.editConnection', async (item?: DatabaseTreeItem) => {
        let cfg: ConnectionConfig | undefined;
        if (!item || !item.node) {
            // invoked without tree item — prompt user to pick a saved connection
            const configs = loadConfigs(context);
            if (!configs || configs.length === 0) { vscode.window.showWarningMessage('没有可编辑的连接配置'); return; }
            const pick = await vscode.window.showQuickPick(configs.map(c => ({ label: c.name, id: c.id } as any)), { placeHolder: '选择要编辑的连接' });
            if (!pick) { return; }
            cfg = configs.find(c => c.id === pick.id);
        } else {
            cfg = loadConfigs(context).find(c => c.id === item.node.connId);
        }
        if (cfg) { await ConnectionConfigPanel.show(context, provider, cfg); }
    });

	// ── 刷新单个连接（树节点右键） ───────────────────────────────
	const refreshConnCmd = vscode.commands.registerCommand('dbviewer.refreshConnection', async (item?: DatabaseTreeItem) => {
		if (!item || !item.node) {
			vscode.window.showWarningMessage('未指定连接节点，无法刷新');
			return;
		}
		const id = item.node.connId;
		const cfg = loadConfigs(context).find(c => c.id === id);
		if (!cfg) { vscode.window.showWarningMessage('未找到连接配置'); return; }
		const pwd = await loadPwd(context, id);
		try {
			try { outputChannel?.appendLine(`[DBG] refreshConnCmd: disconnecting ${id}`); } catch {}
			await provider.disconnect(id);
			try { outputChannel?.appendLine(`[DBG] refreshConnCmd: disconnected ${id}, connections=${Array.from(provider['connections'].keys()).join(',')}`); } catch {}
			try { outputChannel?.appendLine(`[DBG] refreshConnCmd: starting tryConnect for ${id}`); } catch {}
			await tryConnect(provider, cfg, pwd);
			try { outputChannel?.appendLine(`[DBG] refreshConnCmd: tryConnect completed for ${id}`); } catch {}
			await provider.refreshConnectionNode(id);
			notifyInfo(`已刷新连接：${cfg.name}`);
		} catch (err) {
			notifyError(`刷新连接失败：${(err as Error).message}`);
			try { outputChannel?.appendLine(`[DBG] refreshConnCmd: error for ${id}: ${(err as Error).message}`); } catch {}
		}
	});

	// ── 删除连接（树节点右键） ─────────────────────────────────
	const deleteConnCmd = vscode.commands.registerCommand('dbviewer.deleteConnection', async (item: DatabaseTreeItem) => {
		const id = item.node.connId;
		const cfg = loadConfigs(context).find(c => c.id === id);
		if (!cfg) { return; }
		const answer = await vscode.window.showWarningMessage(
			`确认删除连接 "${cfg.name}"？`,
			{ modal: true }, '删除'
		);
		if (answer !== '删除') { return; }
		const configs = loadConfigs(context).filter(c => c.id !== id);
		await saveConfigs(context, configs);
		await deletePwd(context, id);
		await provider.disconnect(id);
        provider.refresh();
        // 防止删除第一个连接时出现 UI 竞态，稍后再触发一次完整刷新
        setTimeout(() => { try { provider.refresh(); outputChannel?.appendLine('[DBG] delayed refresh after deleteConnCmd'); } catch {} }, 120);
	});

	// ── 刷新 ──────────────────────────────────────────────────
    // 顶部刷新命令已移除（避免 UI 互相影响），不再注册 'dbviewer.refreshDatabases'

	// ── 导出/导入连接到 ~/.dbviewer/config.json ───────────────────
	const exportCmd = vscode.commands.registerCommand('dbviewer.exportConnections', async () => {
		const configs = loadConfigs(context);
		try {
			// 包含明文密码：从 Secret storage 读取并加入导出对象
			const exportItems: any[] = [];
			for (const cfg of configs) {
				const pwd = await loadPwd(context, cfg.id);
				exportItems.push({ ...cfg, password: pwd });
			}

			const uri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(os.homedir()),
				filters: { 'JSON': ['json'] },
				saveLabel: '导出'
			});
			if (!uri) { return; }
					   fs.writeFileSync(uri.fsPath, JSON.stringify(exportItems, null, 2), { encoding: 'utf8' });
			vscode.window.showInformationMessage(`已导出 ${exportItems.length} 个连接到 ${uri.fsPath}（包含明文密码）`);
		} catch (err) {
			vscode.window.showErrorMessage(`导出失败：${(err as Error).message}`);
		}
	});

	const importCmd = vscode.commands.registerCommand('dbviewer.importConnections', async () => {
		try {
			const uris = await vscode.window.showOpenDialog({
				defaultUri: vscode.Uri.file(os.homedir()),
				canSelectMany: false,
				filters: { 'JSON': ['json'] },
				openLabel: '导入'
			});
			if (!uris || uris.length === 0) { return; }
			const selected = uris[0].fsPath;
			if (!fs.existsSync(selected)) { vscode.window.showWarningMessage(`${selected} 不存在`); return; }
			const raw = fs.readFileSync(selected, 'utf8');
			const parsed = JSON.parse(raw) as any[];
			if (!Array.isArray(parsed)) { throw new Error('配置文件格式不正确'); }
			// 如果包含 password 字段则保存到 Secret storage，并从 configs 中移除密码
			const configsToSave: ConnectionConfig[] = [];
			for (const item of parsed) {
				const copy: any = { ...item };
				const pwd = copy.password as string | undefined;
				if (pwd) { await savePwd(context, copy.id, pwd); }
				delete copy.password;
				configsToSave.push(copy as ConnectionConfig);
			}
			await saveConfigs(context, configsToSave);
			// try reconnecting where password secret exists
			for (const cfg of configsToSave) {
				const pwd = await loadPwd(context, cfg.id);
				if (pwd) { await tryConnect(provider, cfg, pwd, true); }
			}
			provider.refresh();
			vscode.window.showInformationMessage(`已从 ${selected} 导入 ${configsToSave.length} 个连接（若文件含密码已保存到 Secret）`);
		} catch (err) {
			vscode.window.showErrorMessage(`导入失败：${(err as Error).message}`);
		}
	});

    context.subscriptions.push(openTableCmd, openQueryCmd, addConnCmd, editConnCmd, refreshConnCmd, deleteConnCmd, exportCmd, importCmd);

	// 启动时自动重连所有已保存的连接
	(async () => {
		const configs = loadConfigs(context);
		for (const cfg of configs) {
			const pwd = await loadPwd(context, cfg.id);
			if (pwd) { await tryConnect(provider, cfg, pwd, true); }
		}
	})();
}

// ────────────────────────────────────────────────────────────────
// 辅助：尝试连接（带 loading 提示）
// ────────────────────────────────────────────────────────────────
async function tryConnect(
	provider: DatabaseTreeDataProvider,
	cfg: ConnectionConfig,
	password: string,
	silent = false
): Promise<void> {
	// prevent concurrent connect attempts for the same connection id
	if (!(globalThis as any).__dbviewer_inflight_connects) { (globalThis as any).__dbviewer_inflight_connects = new Set<string>(); }
	const inflight: Set<string> = (globalThis as any).__dbviewer_inflight_connects;
	if (inflight.has(cfg.id)) {
		try { outputChannel?.appendLine(`[DBG] tryConnect skipped for ${cfg.id} because another connect is in-flight`); } catch {}
		return;
	}
	inflight.add(cfg.id);
    try {
        try { outputChannel?.appendLine(`[DBG] tryConnect start for ${cfg.id} ${cfg.user}@${cfg.host}:${cfg.port}`); } catch {}
        if (!silent) {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `正在连接 MySQL ${cfg.user}@${cfg.host}:${cfg.port} ...`,
                    cancellable: false
                },
                async () => { await provider.connect(cfg, password); }
            );
        } else {
            // 静默模式：直接连接，不弹出全局进度通知
            await provider.connect(cfg, password);
        }
        try { outputChannel?.appendLine(`[DBG] tryConnect success for ${cfg.id}`); } catch {}
        if (!silent) {
            notifyInfo(`MySQL 连接成功：${cfg.name}`);
        }
        // clear failed marker on success
        try { provider.clearFailed(cfg.id); } catch { /* ignore */ }
    } catch (err) {
        if (!silent) {
            notifyError(`MySQL 连接失败：${(err as Error).message}`);
        }
        try { outputChannel?.appendLine(`[DBG] tryConnect failed for ${cfg.id}: ${(err as Error).message}`); } catch {}
        // mark as failed so tree shows red icon
        try { provider.markFailed(cfg.id); } catch { /* ignore */ }
        // 仅刷新出错的连接节点
        try { provider.refreshConnectionNode(cfg.id); } catch { /* ignore */ }
    }
    finally {
        try { inflight.delete(cfg.id); } catch {}
    }
}

// This method is called when your extension is deactivated
export async function deactivate() {}

