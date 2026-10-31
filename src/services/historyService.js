'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 本地操作历史。
 *
 * 只记录谁在何时对哪个域名做了什么、结果与耗时；
 * 不记录命令全文，避免邮箱等联系信息进入历史文件。
 */
class HistoryService {
  constructor(filePath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  append(entry) {
    const record = {
      at: new Date().toISOString(),
      type: entry.type,
      target: entry.target,
      status: entry.status,
      durationMs: entry.durationMs,
      exitCode: entry.exitCode,
      remoteTermination: entry.remoteTermination || null
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    this._trimIfNeeded();
    return record;
  }

  read(limit = 50) {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }
    const lines = fs.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean);
    const records = [];
    for (const line of lines.slice(-limit)) {
      try {
        records.push(JSON.parse(line));
      } catch (error) {
        console.warn('历史记录存在无法解析的行，已跳过');
      }
    }
    return records.reverse();
  }

  _trimIfNeeded() {
    let size;
    try {
      size = fs.statSync(this.filePath).size;
    } catch (error) {
      return;
    }
    if (size <= this.maxBytes) {
      return;
    }

    const lines = fs.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean);
    const kept = [];
    let bytes = 0;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const lineBytes = Buffer.byteLength(lines[index], 'utf8') + 1;
      if (bytes + lineBytes > this.maxBytes) {
        break;
      }
      kept.push(lines[index]);
      bytes += lineBytes;
    }
    fs.writeFileSync(this.filePath, kept.length ? `${kept.reverse().join('\n')}\n` : '', 'utf8');
    console.warn(`历史记录超过 ${this.maxBytes} 字节，已保留最近 ${kept.length} 条`);
  }
}

module.exports = { HistoryService };
