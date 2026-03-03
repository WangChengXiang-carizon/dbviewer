import * as vscode from 'vscode';
import * as mysql from 'mysql2/promise';
import * as fs from 'fs';
import * as path from 'path';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────
interface ConnectionConfig {
	id: string;
	name: string;
	host: string;
	port: number;
	user: string;
	database: string;
}

type NodeType = 'connection' | 'database' | 'table';

interface DbNode {
	type: NodeType;
	label: string;
	connId: string;
	database?: string;
}

// ────────────────────────────────────────────────────────────────
// Storage helpers
// ────────────────────────────────────────────────────────────────
const CONNS_KEY = 'dbviewer.connections';

function loadConfigs(context: vscode.ExtensionContext): ConnectionConfig[] {
	return context.globalState.get<ConnectionConfig[]>(CONNS_KEY, []);
}

async function saveConfigs(context: vscode.ExtensionContext, configs: ConnectionConfig[]): Promise<void> {
	await context.globalState.update(CONNS_KEY, configs);
}

function pwdKey(id: string) { return `dbviewer.pwd.${id}`; }

async function loadPwd(context: vscode.ExtensionContext, id: string): Promise<string> {
	return (await context.secrets.get(pwdKey(id))) ?? '';
}

async function savePwd(context: vscode.ExtensionContext, id: string, pwd: string): Promise<void> {
	await context.secrets.store(pwdKey(id), pwd);
}

async function deletePwd(context: vscode.ExtensionContext, id: string): Promise<void> {
	await context.secrets.delete(pwdKey(id));
}

// ────────────────────────────────────────────────────────────────
// TreeItem
// ────────────────────────────────────────────────────────────────
class DatabaseTreeItem extends vscode.TreeItem {
	constructor(
		public readonly node: DbNode,
		label: string,
		collapsible: vscode.TreeItemCollapsibleState,
		description?: string
	) {
		super(label, collapsible);
		this.tooltip = label;
		this.description = description;
		switch (node.type) {
			case 'connection':
				this.iconPath = new vscode.ThemeIcon(
					description === '已连接' ? 'circle-filled' : 'circle-outline'
				);
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

// ────────────────────────────────────────────────────────────────
// TreeDataProvider – 多连接
// ────────────────────────────────────────────────────────────────
class DatabaseTreeDataProvider implements vscode.TreeDataProvider<DatabaseTreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<DatabaseTreeItem | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	/** connId → active mysql connection */
	private connections = new Map<string, mysql.Connection>();

	constructor(private readonly context: vscode.ExtensionContext) {}

	refresh(): void { this._onDidChangeTreeData.fire(); }

	// ── connection management ────────────────────────────────────

	async connect(cfg: ConnectionConfig, password: string): Promise<void> {
		await this.disconnect(cfg.id);
		const opts: mysql.ConnectionOptions = {
			host: cfg.host, port: cfg.port,
			user: cfg.user, password,
			multipleStatements: false
		};
		if (cfg.database) { opts.database = cfg.database; }
		const conn = await mysql.createConnection(opts);
		this.connections.set(cfg.id, conn);
		this.refresh();
	}

	async disconnect(id: string): Promise<void> {
		const conn = this.connections.get(id);
		if (conn) {
			try { await conn.end(); } catch { /* ignore */ }
			this.connections.delete(id);
		}
	}

	async disconnectAll(): Promise<void> {
		for (const id of this.connections.keys()) { await this.disconnect(id); }
	}

	isConnected(id: string): boolean { return this.connections.has(id); }

	getConnection(id: string): mysql.Connection | undefined { return this.connections.get(id); }

	// ── TreeDataProvider impl ────────────────────────────────────

	getTreeItem(e: DatabaseTreeItem): vscode.TreeItem { return e; }

	async getChildren(element?: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
		// 根：列出所有已保存的连接
		if (!element) {
			const configs = loadConfigs(this.context);
			return configs.map(cfg => {
				const connected = this.isConnected(cfg.id);
				return new DatabaseTreeItem(
					{ type: 'connection', label: cfg.name, connId: cfg.id },
					cfg.name,
					connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
					connected ? '已连接' : '未连接'
				);
			});
		}

		// 连接节点 → 列出数据库
		if (element.node.type === 'connection') {
			const conn = this.connections.get(element.node.connId);
			if (!conn) { return []; }
			try {
				const [rows] = await conn.execute<mysql.RowDataPacket[]>('SHOW DATABASES');
				return rows.map(row => new DatabaseTreeItem(
					{ type: 'database', label: row['Database'] as string, connId: element.node.connId },
					row['Database'] as string,
					vscode.TreeItemCollapsibleState.Collapsed
				));
			} catch (err) {
				vscode.window.showErrorMessage(`获取数据库列表失败: ${(err as Error).message}`);
				return [];
			}
		}

		// 数据库节点 → 列出数据表
		if (element.node.type === 'database') {
			const conn = this.connections.get(element.node.connId);
			if (!conn) { return []; }
			const dbName = element.node.label;
			try {
				const [rows] = await conn.execute<mysql.RowDataPacket[]>(
					`SHOW TABLES FROM \`${dbName}\``
				);
				const key = `Tables_in_${dbName}`;
				return rows.map(row => {
					const item = new DatabaseTreeItem(
						{ type: 'table', label: row[key] as string, connId: element.node.connId, database: dbName },
						row[key] as string,
						vscode.TreeItemCollapsibleState.None,
						'table'
					);
					item.command = {
						command: 'dbviewer.openTable',
						title: 'Open Table',
						arguments: [item]
					};
					return item;
				});
			} catch (err) {
				vscode.window.showErrorMessage(`获取表列表失败: ${(err as Error).message}`);
				return [];
			}
		}

		return [];
	}
}

// ────────────────────────────────────────────────────────────────
// WebView 表结构/数据面板
// ────────────────────────────────────────────────────────────────
class TableViewPanel {
	private static panels = new Map<string, TableViewPanel>();
	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	static show(
		extensionPath: string,
		conn: mysql.Connection,
		dbName: string,
		tableName: string
	): void {
		const key = `${dbName}.${tableName}`;
		const existing = TableViewPanel.panels.get(key);
		if (existing) { existing.panel.reveal(vscode.ViewColumn.One); return; }

		const panel = vscode.window.createWebviewPanel(
			'dbviewerTable',
			`${tableName}`,
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		TableViewPanel.panels.set(key, new TableViewPanel(panel, key, extensionPath, conn, dbName, tableName));
	}

	private constructor(
		panel: vscode.WebviewPanel,
		private readonly key: string,
		private readonly extensionPath: string,
		private readonly conn: mysql.Connection,
		private readonly dbName: string,
		private readonly tableName: string
	) {
		this.panel = panel;
		this.panel.webview.html = this.buildHtml();

		this.panel.webview.onDidReceiveMessage(async (msg) => {
			if (msg.command === 'load') {
				try {
					const [cols] = await this.conn.execute<mysql.RowDataPacket[]>(
						`SHOW FULL COLUMNS FROM \`${this.dbName}\`.\`${this.tableName}\``
					);
					const [outgoingRefs] = await this.conn.execute<mysql.RowDataPacket[]>(
						`SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
						 FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
						 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
						[this.dbName, this.tableName]
					);
					const [incomingRefs] = await this.conn.execute<mysql.RowDataPacket[]>(
						`SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_COLUMN_NAME
						 FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
						 WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?`,
						[this.dbName, this.tableName]
					);
					const limit = msg.limit ?? 500;
					const offset = msg.offset ?? 0;
					const [dataRows] = await this.conn.execute<mysql.RowDataPacket[]>(
						`SELECT * FROM \`${this.dbName}\`.\`${this.tableName}\` LIMIT ${limit} OFFSET ${offset}`
					);
					const [countRows] = await this.conn.execute<mysql.RowDataPacket[]>(
						`SELECT COUNT(*) AS cnt FROM \`${this.dbName}\`.\`${this.tableName}\``
					);
					const total = countRows[0]['cnt'] as number;
					this.panel.webview.postMessage({
						type: 'data',
						cols: cols as object[],
						rows: dataRows as object[],
						outgoingRefs: outgoingRefs as object[],
						incomingRefs: incomingRefs as object[],
						total, limit, offset
					});
				} catch (err) {
					this.panel.webview.postMessage({ type: 'error', message: (err as Error).message });
				}
			}
		}, undefined, this.disposables);

		this.panel.onDidDispose(() => {
			TableViewPanel.panels.delete(this.key);
			this.disposables.forEach(d => d.dispose());
		}, null, this.disposables);
	}

	private buildHtml(): string {
		const htmlPath = path.join(this.extensionPath, 'media', 'tableView.html');
		return fs.readFileSync(htmlPath, 'utf8')
			.replace(/\{\{DB\}\}/g, this.dbName)
			.replace(/\{\{TBL\}\}/g, this.tableName);
	}
}

// ────────────────────────────────────────────────────────────────
// WebView SQL 查询面板
// ────────────────────────────────────────────────────────────────
class SqlQueryPanel {
	private static panels = new Map<string, SqlQueryPanel>();
	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	static show(
		extensionPath: string,
		conn: mysql.Connection,
		connId: string,
		dbName: string,
		tableName?: string
	): void {
		const key = `${connId}:${dbName}:${tableName ?? '__db__'}`;
		const existing = SqlQueryPanel.panels.get(key);
		if (existing) { existing.panel.reveal(vscode.ViewColumn.One); return; }

		const title = tableName ? `查询 ${dbName}.${tableName}` : `查询 ${dbName}`;
		const panel = vscode.window.createWebviewPanel(
			'dbviewerQuery',
			title,
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		SqlQueryPanel.panels.set(key, new SqlQueryPanel(panel, key, extensionPath, conn, dbName, tableName));
	}

	private constructor(
		panel: vscode.WebviewPanel,
		private readonly key: string,
		private readonly extensionPath: string,
		private readonly conn: mysql.Connection,
		private readonly dbName: string,
		private readonly tableName?: string
	) {
		this.panel = panel;
		this.panel.webview.html = this.buildHtml();

		this.panel.webview.onDidReceiveMessage(async (msg) => {
			if (msg.command !== 'execute') { return; }
			const sql = String(msg.sql ?? '').trim();
			if (!sql) {
				this.panel.webview.postMessage({ type: 'error', message: '请输入 SQL 语句' });
				return;
			}

			try {
				await this.conn.query(`USE \`${this.dbName}\``);
				const [rows, fields] = await this.conn.query(sql);

				if (Array.isArray(rows)) {
					let columns: string[] = [];
					if (rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null && !Array.isArray(rows[0])) {
						columns = Object.keys(rows[0] as object);
					} else if (Array.isArray(fields)) {
						columns = fields.map((f: any) => String(f?.name ?? ''));
					}
					this.panel.webview.postMessage({
						type: 'result',
						mode: 'table',
						columns,
						rows: rows as object[]
					});
					return;
				}

				const ok = rows as mysql.ResultSetHeader;
				this.panel.webview.postMessage({
					type: 'result',
					mode: 'ok',
					message: `执行成功，影响行数 ${ok.affectedRows ?? 0}`
				});
			} catch (err) {
				this.panel.webview.postMessage({ type: 'error', message: (err as Error).message });
			}
		}, undefined, this.disposables);

		this.panel.onDidDispose(() => {
			SqlQueryPanel.panels.delete(this.key);
			this.disposables.forEach(d => d.dispose());
		}, null, this.disposables);
	}

	private buildHtml(): string {
		const htmlPath = path.join(this.extensionPath, 'media', 'sqlQuery.html');
		const defaultSql = this.tableName
			? `SELECT * FROM \`${this.dbName}\`.\`${this.tableName}\` LIMIT 100;`
			: `-- 请输入 SQL\n-- 当前数据库: ${this.dbName}\nSELECT * FROM information_schema.tables LIMIT 50;`;
		return fs.readFileSync(htmlPath, 'utf8')
			.replace(/\{\{TITLE\}\}/g, this.tableName ? `${this.dbName}.${this.tableName}` : this.dbName)
			.replace(/\{\{DB\}\}/g, this.dbName)
			.replace(/\{\{DEFAULT_SQL\}\}/g, defaultSql.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
	}
}

// ────────────────────────────────────────────────────────────────
// WebView 配置面板（单一表单）
// ────────────────────────────────────────────────────────────────
class ConnectionConfigPanel {
	/** 每个 connId（或 'new'）对应一个独立面板 */
	private static panels = new Map<string, ConnectionConfigPanel>();
	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	static async show(
		context: vscode.ExtensionContext,
		provider: DatabaseTreeDataProvider,
		editCfg?: ConnectionConfig
	): Promise<void> {
		const key = editCfg?.id ?? 'new';
		const existing = ConnectionConfigPanel.panels.get(key);
		if (existing) { existing.panel.reveal(vscode.ViewColumn.One); return; }

		const title = editCfg ? `编辑连接 — ${editCfg.name}` : '新建连接';
		const panel = vscode.window.createWebviewPanel(
			'dbviewerConfig', title,
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		ConnectionConfigPanel.panels.set(key, new ConnectionConfigPanel(panel, context, provider, key, editCfg));
	}

	private constructor(
		panel: vscode.WebviewPanel,
		private readonly context: vscode.ExtensionContext,
		private readonly provider: DatabaseTreeDataProvider,
		private readonly key: string,
		private readonly editCfg?: ConnectionConfig
	) {
		this.panel = panel;
		this.panel.webview.html = this.buildHtml();

		this.panel.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.command) {
				case 'ready': {
					const cfg = this.editCfg;
					const pwd = cfg ? await loadPwd(this.context, cfg.id) : '';
					this.panel.webview.postMessage({ type: 'init', cfg: cfg ?? null, pwd });
					break;
				}
				case 'test':
					await this.handleTestOrSave(msg, false);
					break;
				case 'save':
					await this.handleTestOrSave(msg, true);
					break;
				case 'delete': {
					const cfgs = loadConfigs(this.context).filter(c => c.id !== msg.id);
					await saveConfigs(this.context, cfgs);
					await deletePwd(this.context, msg.id);
					await this.provider.disconnect(msg.id);
					this.provider.refresh();
					this.panel.dispose();
					break;
				}
			}
		}, undefined, this.disposables);

		this.panel.onDidDispose(() => {
			ConnectionConfigPanel.panels.delete(this.key);
			this.disposables.forEach(d => d.dispose());
		}, null, this.disposables);
	}

	private async handleTestOrSave(
		msg: { id?: string; name: string; host: string; port: string; user: string; database: string; password: string },
		doSave: boolean
	) {
		const portNum = parseInt(msg.port, 10) || 3306;
		const dbLabel = msg.database ? `/${msg.database}` : '';
		this.postStatus('connecting', `正在连接 ${msg.user}@${msg.host}:${portNum}${dbLabel} ...`);

		try {
			const opts: mysql.ConnectionOptions = { host: msg.host, port: portNum, user: msg.user, password: msg.password };
			if (msg.database) { opts.database = msg.database; }
			const conn = await mysql.createConnection(opts);
			await conn.end();
			this.postStatus('ok', `连接成功！${msg.user}@${msg.host}:${portNum}${dbLabel}`);
		} catch (err) {
			this.postStatus('error', `连接失败：${(err as Error).message}`);
			return;
		}

		if (doSave) {
			const configs = loadConfigs(this.context);
			const id = msg.id || `conn_${Date.now()}`;
			const cfg: ConnectionConfig = {
				id, name: msg.name || `${msg.user}@${msg.host}`,
				host: msg.host, port: portNum,
				user: msg.user, database: msg.database
			};
			const idx = configs.findIndex(c => c.id === id);
			if (idx >= 0) { configs[idx] = cfg; } else { configs.push(cfg); }
			await saveConfigs(this.context, configs);
			await savePwd(this.context, id, msg.password);
			await tryConnect(this.provider, cfg, msg.password);
			this.panel.dispose();
		}
	}

	private postStatus(type: 'connecting' | 'ok' | 'error', message: string) {
		this.panel.webview.postMessage({ type, message });
	}

	private buildHtml(): string {
		const isEdit = !!this.editCfg;
		const htmlPath = path.join(this.context.extensionPath, 'media', 'connectionConfig.html');
		const deleteBtn = isEdit
			? '<button class="btn-danger" onclick="del()">删除连接</button>'
			: '';
		return fs.readFileSync(htmlPath, 'utf8')
			.replace(/\{\{TITLE\}\}/g,      isEdit ? '编辑连接' : '新建连接')
			.replace(/\{\{HEADING\}\}/g,    isEdit ? '✏️ 编辑连接' : '➕ 新建连接')
			.replace(/\{\{DELETE_BTN\}\}/g, deleteBtn);
	}
}

// ────────────────────────────────────────────────────────────────
// activate
// ────────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
	console.log('dbviewer extension activated');

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
	const addConnCmd = vscode.commands.registerCommand('dbviewer.addConnection', () => {
		ConnectionConfigPanel.show(context, provider);
	});

	// ── 编辑连接（树节点右键） ─────────────────────────────────
	const editConnCmd = vscode.commands.registerCommand('dbviewer.editConnection', async (item: DatabaseTreeItem) => {
		const cfg = loadConfigs(context).find(c => c.id === item.node.connId);
		if (cfg) { ConnectionConfigPanel.show(context, provider, cfg); }
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
	});

	// ── 刷新 ──────────────────────────────────────────────────
	const refreshCmd = vscode.commands.registerCommand('dbviewer.refreshDatabases', () => {
		provider.refresh();
	});

	context.subscriptions.push(openTableCmd, openQueryCmd, addConnCmd, editConnCmd, deleteConnCmd, refreshCmd);

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
	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `正在连接 MySQL ${cfg.user}@${cfg.host}:${cfg.port} ...`,
				cancellable: false
			},
			async () => { await provider.connect(cfg, password); }
		);
		if (!silent) {
			vscode.window.showInformationMessage(`MySQL 连接成功：${cfg.name}`);
		}
	} catch (err) {
		if (!silent) {
			vscode.window.showErrorMessage(`MySQL 连接失败：${(err as Error).message}`);
		}
		provider.refresh();
	}
}

// This method is called when your extension is deactivated
export async function deactivate() {}

