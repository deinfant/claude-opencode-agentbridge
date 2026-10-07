import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export class Queue {
  constructor(file, now = Date.now) {
    this.file = file;
    this.now = now;
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, paused: false, messages: [] };
    this.peers = {};
  }
  save() {
    writeFileSync(this.file + '.tmp', JSON.stringify(this.state, null, 2));
    renameSync(this.file + '.tmp', this.file);
  }
  active(role) { return this.peers[role] && this.now() - this.peers[role].seen < 15000; }
  heartbeat({ role, consumer, ready = false, session, pending = [] }) {
    const existing = this.peers[role];
    if (this.active(role) && existing.consumer !== consumer) return { active: false, reason: `${role} already has an active receiver` };
    this.peers[role] = { consumer, ready, session, seen: this.now() };
    let changed = false;
    for (const message of this.state.messages) {
      if (message.to === role && message.lease?.consumer === consumer && pending.includes(message.id)) {
        message.lease.until = this.now() + 45000;
        changed = true;
      }
    }
    if (changed) this.save();
    return { active: true };
  }
  send({ from, text, kind = 'request', thread_id, reply_to, dedupe_key }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('text must contain 1–16000 characters');
    if (!['request', 'handoff', 'reply', 'info', 'ack'].includes(kind)) throw new Error('Invalid message kind');
    if (reply_to) {
      const parent = this.state.messages.find(m => m.id === reply_to && m.to === from);
      if (!parent) throw new Error('reply_to must identify a message addressed to this agent');
      thread_id = parent.thread_id;
      parent.delivered_at ??= this.now();
      delete parent.lease;
    }
    if (dedupe_key) {
      const old = this.state.messages.find(m => m.from === from && m.dedupe_key === dedupe_key);
      if (old) return old;
    }
    thread_id ||= randomUUID();
    const wakes = this.state.messages.filter(m => m.thread_id === thread_id && m.wake).length;
    const wake = !['info', 'ack'].includes(kind) && wakes < 12;
    const message = {
      id: randomUUID(), from, to: from === 'claude' ? 'opencode' : 'claude', text, kind,
      thread_id, reply_to, dedupe_key, wake, created_at: this.now(),
      ...(wakes >= 12 && !['info', 'ack'].includes(kind) ? { held_reason: 'Thread reached 12 automatic wakes; read manually or start a new task thread.' } : {}),
    };
    this.state.messages.push(message);
    this.save();
    return message;
  }
  claim({ role, consumer, limit = 5 }) {
    const peer = this.peers[role];
    if (this.state.paused || !this.active(role) || peer.consumer !== consumer || !peer.ready) return [];
    const available = this.state.messages.filter(m => m.to === role && m.wake && !m.delivered_at && (!m.lease || m.lease.until < this.now()));
    const result = available.slice(0, Math.min(5, Math.max(1, Number(limit) || 1)));
    for (const message of result) message.lease = { consumer, until: this.now() + 45000 };
    if (result.length) this.save();
    return result;
  }
  ack({ role, consumer, ids, manual = false }) {
    let count = 0;
    for (const message of this.state.messages) {
      if (message.to === role && ids.includes(message.id) && (manual || message.lease?.consumer === consumer)) {
        message.delivered_at ??= this.now();
        delete message.lease;
        count++;
      }
    }
    if (count) this.save();
    return { acknowledged: count };
  }
  release({ role, consumer, ids }) {
    for (const message of this.state.messages) {
      if (message.to === role && ids.includes(message.id) && message.lease?.consumer === consumer) delete message.lease;
    }
    this.save();
    return { released: true };
  }
  inbox({ role, include_delivered = false }) {
    return this.state.messages.filter(m => m.to === role && (include_delivered || !m.delivered_at)).slice(-100);
  }
  status() {
    return {
      paused: this.state.paused,
      peers: Object.fromEntries(['opencode', 'claude'].map(role => [role, {
        connected: Boolean(this.active(role)), ready: Boolean(this.active(role) && this.peers[role].ready),
        session: this.peers[role]?.session,
        waiting: this.state.messages.filter(m => m.to === role && !m.delivered_at).length,
      }])),
    };
  }
  pause({ paused }) { this.state.paused = Boolean(paused); this.save(); return this.status(); }
}
