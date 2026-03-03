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

    // 处理来自页面的加载请求（查询表结构/数据/外键）
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command !== 'load') { return; }
      try {
        const limit = Number(msg.limit) || 10;
        const offset = Number(msg.offset) || 0;
        const sortField = msg.sortField || null;
        const sortDir = (msg.sortDir === 'DESC') ? 'DESC' : 'ASC';

        // 列信息：使用 information_schema.COLUMNS 获取更完整的信息
          // 返回与前端 renderStructure() 期望的字段名一致的列信息
          const colsSql = `SELECT
            COLUMN_NAME AS Field,
            COLUMN_TYPE AS Type,
            IS_NULLABLE AS \`Null\`,
            COLUMN_KEY AS \`Key\`,
            COLUMN_DEFAULT AS \`Default\`,
            EXTRA AS Extra,
            COLUMN_COMMENT AS Comment
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`;
        const [colsRows] = await conn.query<any[]>(colsSql, [dbName, tableName]);

        // 外键：引用其他表（outgoing）
        const outgoingSql = `SELECT * FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`;
        const [outgoingRows] = await conn.query<any[]>(outgoingSql, [dbName, tableName]);

        // incoming refs: 其他表引用当前表
        const incomingSql = `SELECT * FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?`;
        const [incomingRows] = await conn.query<any[]>(incomingSql, [dbName, tableName]);

        // 总行数
        const countSql = `SELECT COUNT(*) as cnt FROM \`${dbName}\`.\`${tableName}\``;
        const [countRows] = await conn.query<any[]>(countSql);
        const total = Array.isArray(countRows) && countRows[0] ? Number(countRows[0].cnt || 0) : 0;

        // 数据行（分页）
        let dataSql = `SELECT * FROM \`${dbName}\`.\`${tableName}\``;
        if (sortField) { dataSql += ` ORDER BY \`${String(sortField)}\` ${sortDir}`; }
        dataSql += ` LIMIT ? OFFSET ?`;
        const [dataRows] = await conn.query<any[]>(dataSql, [limit, offset]);

        panel.webview.postMessage({ type: 'data', cols: colsRows, rows: dataRows, total, outgoingRefs: outgoingRows, incomingRefs: incomingRows });
      } catch (err) {
        panel.webview.postMessage({ type: 'error', message: typeof err === 'object' && err && 'message' in err ? (err as any).message : String(err) });
      }
    });
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
    // 根据是否传入 tableName 生成合理的默认 SQL
    const defaultSql = tableName
      ? `SELECT * FROM \`${dbName}\`.\`${tableName}\` LIMIT 100;`
      : `SHOW TABLES;`;

    html = html.replace(/\{\{TITLE\}\}/g, title)
               .replace(/\{\{DB\}\}/g, dbName)
               .replace(/\{\{TBL\}\}/g, tableName || '')
               .replace(/\{\{CONNID\}\}/g, connId)
               .replace(/\{\{DEFAULT_SQL\}\}/g, defaultSql);
    panel.webview.html = html;
    // 处理来自页面的执行请求
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || msg.command !== 'execute') { return; }
      const sql = String(msg.sql || '').trim();
      if (!sql) {
        panel.webview.postMessage({ type: 'error', message: '空的 SQL 语句' });
        return;
      }
      try {
        // 使用 .query 执行任意 SELECT/非 SELECT 语句
        const res = await conn.query(sql);
        // mysql2 返回 [rows, fields]
        const rows = Array.isArray(res) ? res[0] : res;
        const fields = Array.isArray(res) && res.length > 1 ? res[1] : undefined;

        // 如果 rows 不是数组，表示非结果集（OK packet）
        if (!Array.isArray(rows)) {
          const ok = rows as any;
          const msgText = `执行完成，受影响行数: ${ok.affectedRows ?? 0}`;
          panel.webview.postMessage({ type: 'result', mode: 'ok', message: msgText });
          return;
        }

        // 生成列名（优先使用 fields 中的字段顺序）
        let columns: string[] = [];
        if (Array.isArray(fields)) {
          try { columns = (fields as any[]).map(f => f.name || f.orgName || f.columnName).filter(Boolean); } catch { columns = []; }
        }
        if (!columns.length && rows.length > 0) {
          columns = Object.keys(rows[0]);
        }

        panel.webview.postMessage({ type: 'result', columns, rows });
      } catch (err) {
        panel.webview.postMessage({ type: 'error', message: typeof err === 'object' && err && 'message' in err ? (err as any).message : String(err) });
      }
    });
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
           .replace(/\{\{CONNID\}\}/g, cfg?.id || '')
           .replace(/\{\{DELETE_BTN\}\}/g, cfg ? '<button class="btn-danger" onclick="del()">删除</button>' : '');
    panel.webview.html = html;

    // 页面 ready 后发送配置和密码，并处理 save/test/delete 命令
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'ready') {
        let pwd = '';
        if (cfg?.id) {
          try {
            const { loadPwd } = await import('./configStorage.js');
            pwd = await loadPwd(context, cfg.id);
          } catch {}
        }
        panel.webview.postMessage({ type: 'init', cfg, pwd });
        return;
      }

      // 保存并连接
      if (msg.command === 'save') {
        try {
          const { saveConfigs, savePwd, loadConfigs } = await import('./configStorage.js');
          let configs = provider ? loadConfigs(context) : [];
          if (msg.id) {
            configs = configs.filter((c: any) => c.id !== msg.id);
          }
          const newId = msg.id || Math.random().toString(36).slice(2, 10);
          const newCfg = { ...msg, id: newId };
          configs.push(newCfg);
          await saveConfigs(context, configs);
          await savePwd(context, newId, msg.password || '');
          await provider.connect(newCfg, msg.password || '');
          panel.webview.postMessage({ type: 'ok', message: `保存并连接成功：${newCfg.user}@${newCfg.host}:${newCfg.port} (id=${newId})` });
          provider.refreshConnectionNode(newId);
        } catch (err) {
          panel.webview.postMessage({ type: 'error', message: '保存或连接失败: ' + (typeof err === 'object' && err && 'message' in err ? (err as any).message : String(err)) });
        }
        return;
      }

      // 测试连接（临时连接并立即断开，不保存到配置）
      if (msg.command === 'test') {
        try {
          const tempId = msg.id || `tmp-${Math.random().toString(36).slice(2,8)}`;
          const cfg = { ...msg, id: tempId };
          await provider.connect(cfg, msg.password || '');
          // 立即断开，避免在 provider 中留下持久连接
          try { await provider.disconnect(tempId); } catch {}
          panel.webview.postMessage({ type: 'ok', message: `连接成功：${cfg.user}@${cfg.host}:${cfg.port} (id=${cfg.id})` });
        } catch (err) {
          panel.webview.postMessage({ type: 'error', message: '连接失败: ' + (typeof err === 'object' && err && 'message' in err ? (err as any).message : String(err)) });
        }
        return;
      }

      // 删除连接
      if (msg.command === 'delete') {
        try {
          const { saveConfigs, deletePwd, loadConfigs } = await import('./configStorage.js');
          let configs = provider ? loadConfigs(context) : [];
          configs = configs.filter((c: any) => c.id !== msg.id);
          await saveConfigs(context, configs);
          await deletePwd(context, msg.id);
          await provider.disconnect(msg.id);
          provider.refresh();
          // 再次延迟刷新以避免删除首项时的显示问题
          try { setTimeout(() => { provider.refresh(); }, 120); } catch {}
          panel.webview.postMessage({ type: 'ok', message: `连接已删除：id=${msg.id}` });
          // 关闭编辑面板
          try { panel.dispose(); } catch {}
        } catch (err) {
          panel.webview.postMessage({ type: 'error', message: '删除失败: ' + (typeof err === 'object' && err && 'message' in err ? (err as any).message : String(err)) });
        }
        return;
      }
    });
  }
}
