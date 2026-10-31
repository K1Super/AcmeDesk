'use strict';

const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');

const ssh = require('../infra/ssh');
const {
  buildRemotePidFile,
  buildWrappedJobCommand,
  buildTerminationScript,
  buildTerminationCommand
} = require('../domain/commands');

/**
 * 单通道任务执行器。
 *
 * 证书签发与续期共享 ACME 账户与目录，并行执行会产生锁竞争和覆盖风险，
 * 因此同一时刻只允许一个任务，多余请求直接拒绝而不是排队拖延。
 *
 * 取消与超时不能只结束本地 ssh：远端仍可能继续执行并留下半完成状态。
 * 任务命令由独立会话或独立进程组承载并写入 PID/PGID 文件，终止时再发起
 * 一次受控的远端进程组回收，把“已请求终止”与“远端已停止”如实区分开。
 */

const MAX_LOG_LINES = 2000;
const MAX_LOG_TEXT = 4096;
const MAX_LINE_CHARS = 64 * 1024;
const MAX_JOBS = 20;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINATION_TIMEOUT_MS = 4000;
const REMOTE_TERMINATION_LABELS = {
  none: '远端任务已结束',
  stopped: '远端进程已停止',
  requested: '远端终止信号已发送',
  unconfirmed: '远端终止结果未确认'
};
const OUTCOME_LABELS = {
  success: '任务完成',
  failed: '任务失败',
  cancelled: '任务已取消',
  interrupted: '任务已中断'
};
const TERMINATION_MESSAGES = {
  cancel: '正在取消任务',
  timeout: '任务执行超时，正在终止',
  shutdown: '服务退出，正在终止任务'
};

class JobConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JobConflictError';
  }
}

class JobService {
  constructor({ history, sshImpl = ssh, timeoutMs = DEFAULT_TIMEOUT_MS, terminationTimeoutMs = TERMINATION_TIMEOUT_MS }) {
    this.history = history;
    this.sshImpl = sshImpl;
    this.timeoutMs = timeoutMs;
    this.terminationTimeoutMs = terminationTimeoutMs;
    this.jobs = new Map();
    this.activeId = null;
  }

  isBusy() {
    return Boolean(this.activeId);
  }

  start({ type, label, target, settings, command }) {
    if (this.activeId) {
      throw new JobConflictError('已有任务正在执行，请等待当前任务结束');
    }

    const id = randomUUID();
    const pidFile = buildRemotePidFile(id);
    const wrappedCommand = buildWrappedJobCommand(command, pidFile);
    const child = this.sshImpl.stream(settings, wrappedCommand);
    if (!child || !child.stdout || !child.stderr) {
      if (child && typeof child.kill === 'function') {
        try {
          child.kill();
        } catch (error) {
          // 句柄不完整时终止可能失败，不能掩盖启动错误。
        }
      }
      throw new Error('无法获取远端进程输出通道');
    }

    const job = {
      id,
      type,
      label,
      target,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      remoteTermination: null,
      log: [{ stream: 'meta', text: `[${type}] ${label}` }],
      emitter: new EventEmitter(),
      settings,
      pidFile,
      child,
      timer: null,
      closed: false,
      childClosed: false,
      closeCode: null,
      terminating: false,
      terminationPromise: null
    };

    this.jobs.set(job.id, job);
    this.activeId = job.id;
    this._prune();

    const startedAt = Date.now();
    const buffers = { stdout: '', stderr: '' };
    job.buffers = buffers;

    const consume = (stream, chunk) => {
      buffers[stream] += chunk.toString('utf8');
      const parts = buffers[stream].split('\n');
      buffers[stream] = parts.pop();
      for (const line of parts) {
        this._append(job, stream, line);
      }
      if (buffers[stream].length > MAX_LINE_CHARS) {
        this._append(job, stream, `${buffers[stream].slice(0, MAX_LINE_CHARS)} …[单行过长已截断]`);
        buffers[stream] = '';
      }
    };

    try {
      child.stdout.on('data', (chunk) => consume('stdout', chunk));
      child.stderr.on('data', (chunk) => consume('stderr', chunk));

      child.on('error', (error) => {
        job.childClosed = true;
        if (job.terminating) {
          this._append(job, 'meta', `本地 SSH 进程异常: ${error.message}`);
          return;
        }
        this._append(job, 'meta', `无法启动远端进程: ${error.message}`);
        this._finish(job, 'failed', null);
      });

      child.on('close', (code) => {
        job.childClosed = true;
        job.closeCode = code;
        if (job.terminating) {
          return;
        }
        this._finish(job, code === 0 ? 'success' : 'failed', code);
      });

      job.timer = setTimeout(() => {
        this._terminate(job, 'timeout').catch((error) => {
          this._append(job, 'meta', `终止流程失败: ${error.message}`);
          this._finish(job, 'failed', null, {
            detail: '任务执行超时',
            remoteTermination: 'unconfirmed'
          });
        });
      }, this.timeoutMs);
    } catch (error) {
      if (job.timer) {
        clearTimeout(job.timer);
      }
      this.jobs.delete(job.id);
      this.activeId = null;
      try {
        child.kill();
      } catch (killError) {
        // 进程可能尚未进入可终止状态，保留原始错误向上返回。
      }
      throw error;
    }

    return this.get(job.id);
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') {
      return false;
    }
    return this._terminate(job, 'cancel');
  }

  async shutdown() {
    const job = this.activeId ? this.jobs.get(this.activeId) : null;
    if (!job || job.closed) {
      return;
    }
    await this._terminate(job, 'shutdown');
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) {
      return null;
    }
    return {
      id: job.id,
      type: job.type,
      label: job.label,
      target: job.target,
      status: job.status,
      startedAt: new Date(job.startedAt).toISOString(),
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      exitCode: job.exitCode,
      remoteTermination: job.remoteTermination,
      log: job.log.slice()
    };
  }

  subscribe(id, handlers) {
    const job = this.jobs.get(id);
    if (!job) {
      return null;
    }
    job.emitter.on('line', handlers.line);
    job.emitter.on('done', handlers.done);
    return () => {
      job.emitter.off('line', handlers.line);
      job.emitter.off('done', handlers.done);
    };
  }

  _terminate(job, reason) {
    if (job.terminationPromise) {
      return job.terminationPromise;
    }
    if (job.closed) {
      return Promise.resolve(false);
    }
    job.terminationPromise = this._runTermination(job, reason);
    return job.terminationPromise;
  }

  async _runTermination(job, reason) {
    if (job.closed || job.terminating) {
      return false;
    }
    job.terminating = true;
    job.status = 'cancelling';
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }

    const closedBefore = job.childClosed;
    this._append(job, 'meta', `${TERMINATION_MESSAGES[reason] || '正在终止任务'}，先断开本地 SSH，再回收远端进程组`);
    try {
      job.child.kill();
    } catch (error) {
      this._append(job, 'meta', `本地 SSH 进程终止失败: ${error.message}`);
    }

    job.remoteTermination = await this._terminateRemote(job);

    let status;
    let detail;
    if (job.childClosed && job.closeCode === 0) {
      status = 'success';
      detail = '在终止请求前已完成';
    } else if (job.childClosed && job.closeCode !== null && job.remoteTermination === 'none') {
      status = 'failed';
      detail = '在终止请求前已结束';
    } else if (closedBefore) {
      status = 'failed';
      detail = '在终止请求前已失败';
    } else if (reason === 'cancel') {
      status = 'cancelled';
    } else if (reason === 'timeout') {
      status = 'failed';
      detail = '执行超时';
    } else {
      status = 'interrupted';
      detail = '服务退出';
    }

    this._finish(job, status, job.closeCode, {
      detail,
      remoteTermination: job.remoteTermination
    });
    return true;
  }

  async _terminateRemote(job) {
    if (typeof this.sshImpl.runScript !== 'function') {
      return 'unconfirmed';
    }
    try {
      const result = await this.sshImpl.runScript(job.settings, buildTerminationScript(), {
        command: buildTerminationCommand(job.pidFile),
        timeout: this.terminationTimeoutMs
      });
      if (!result || result.code !== 0) {
        return 'unconfirmed';
      }
      const output = String(result.stdout || '').trim().split('\n').pop();
      if (output === 'none' || output === 'stopped' || output === 'requested') {
        return output;
      }
      return 'unconfirmed';
    } catch (error) {
      this._append(job, 'meta', `远端终止失败: ${error.message}`);
      return 'unconfirmed';
    }
  }

  _finish(job, status, exitCode, { detail = '', remoteTermination = null } = {}) {
    if (job.closed) {
      return;
    }
    job.closed = true;
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    for (const stream of ['stdout', 'stderr']) {
      if (job.buffers && job.buffers[stream]) {
        this._append(job, stream, job.buffers[stream]);
        job.buffers[stream] = '';
      }
    }

    job.status = status;
    job.exitCode = exitCode;
    job.remoteTermination = remoteTermination;
    job.finishedAt = Date.now();
    const durationMs = job.finishedAt - job.startedAt;
    const outcome = OUTCOME_LABELS[status] || '任务失败';
    const detailText = detail ? `（${detail}）` : '';
    const remoteText = remoteTermination
      ? `，${REMOTE_TERMINATION_LABELS[remoteTermination] || REMOTE_TERMINATION_LABELS.unconfirmed}`
      : '';
    this._append(job, 'meta', `${outcome}${detailText}${remoteText}，耗时 ${(durationMs / 1000).toFixed(1)} 秒`);

    try {
      this.history.append({
        type: job.type,
        target: job.target,
        status,
        durationMs,
        exitCode,
        remoteTermination
      });
    } catch (error) {
      console.error('操作历史写入失败:', error.message);
    }

    this.activeId = null;
    job.emitter.emit('done', this.get(job.id));
  }

  _append(job, stream, text) {
    const raw = String(text ?? '');
    const clipped = raw.length > MAX_LOG_TEXT
      ? `${raw.slice(0, MAX_LOG_TEXT)} …[单行过长已截断]`
      : raw;
    const entry = { stream, text: clipped };
    job.log.push(entry);
    if (job.log.length > MAX_LOG_LINES) {
      job.log.splice(0, 200);
      job.log.unshift({ stream: 'meta', text: '日志过长，已截断早期内容' });
    }
    job.emitter.emit('line', entry);
  }

  _prune() {
    if (this.jobs.size <= MAX_JOBS) {
      return;
    }
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running') {
        this.jobs.delete(id);
      }
      if (this.jobs.size <= MAX_JOBS) {
        return;
      }
    }
  }
}

module.exports = {
  JobService,
  JobConflictError
};
