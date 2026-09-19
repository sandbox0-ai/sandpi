import type { EnvironmentAgentId } from "@/lib/types";
import { nativeAgentSessionSchema } from "@/lib/native-agent-sessions";
import { z } from "zod";
import { agentAdapter } from "./registry";

export const nativeSessionDiscoverySchema = z.object({
  sessions: z.array(nativeAgentSessionSchema).max(200),
  partial: z.boolean(),
});

/** Runs inside the guest. Bound traversal and reads, and never follow symlinks. */
export const NATIVE_SESSION_DISCOVERY_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[1];
const agent = process.argv[2];
const deadline = Date.now() + 4000;
const files = [];
let visited = 0, partial = false;
function walk(dir, depth = 0) {
  if (depth > 5 || Date.now() > deadline || visited > 10000) { partial = true; return; }
  let entries;
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return;
    entries = [];
    const directory = fs.opendirSync(dir);
    try {
      let entry;
      while ((entry = directory.readSync())) {
        if (entries.length + visited >= 10000 || Date.now() > deadline) {partial = true; break;}
        entries.push(entry);
      }
    } finally {directory.closeSync();}
    entries.sort((a,b)=>b.name.localeCompare(a.name));
  }
  catch (e) { if (e.code !== 'ENOENT') throw e; return; }
  for (const entry of entries) {
    if (++visited > 10000 || Date.now() > deadline) { partial = true; return; }
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { if (entry.name !== 'subagents') walk(p, depth + 1); }
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const stat = fs.lstatSync(p);
      files.push({path:p, time:stat.mtimeMs, size:stat.size});
    } else if (entry.name.endsWith('.zst')) partial = true;
  }
}
function records(file, limit = 262144) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return [];
    const head = Buffer.alloc(Math.min(stat.size, limit));
    const n = fs.readSync(fd, head, 0, head.length, 0);
    let lines = head.subarray(0,n).toString('utf8').split('\n');
    if (stat.size > n) lines.pop();
    if (stat.size > limit) {
      const tail = Buffer.alloc(Math.min(65536,stat.size));
      const count = fs.readSync(fd, tail, 0, tail.length, stat.size-tail.length);
      lines.push(...tail.subarray(0,count).toString('utf8').split('\n').slice(1));
    }
    return lines.flatMap(line => {try {return [JSON.parse(line)];} catch {return [];}});
  } finally { fs.closeSync(fd); }
}
const names = new Map();
if (agent === 'codex') {
  // Index entries are title metadata; rollout files prove resumability.
  const index = path.join(root, 'session_index.jsonl');
  if (fs.existsSync(index) && !fs.lstatSync(index).isSymbolicLink()) {
    for (const r of records(index)) if (r.id && r.thread_name) names.set(r.id,r.thread_name);
  }
}
walk(path.join(root, agent === 'claude-code' ? 'projects' : 'sessions'));
files.sort((a,b) => b.time-a.time);
if (files.length > 200) partial = true;
const sessions = new Map();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function text(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(x => x && (x.type === 'text' || x.type === 'input_text')).map(x => x.text || '').join(' ') : '';
}
for (const file of files.slice(0,200)) {
  if (Date.now() > deadline) {partial = true; break;}
  let rows;
  try {rows = records(file.path);} catch {partial = true; continue;}
  let id, title = '', firstUser = '';
  for (const r of rows) {
    if (agent === 'codex' && r.type === 'session_meta') id = r.payload?.id;
    if (agent === 'pi' && r.type === 'session') id = r.id;
    if (agent === 'claude-code' && r.sessionId && !r.isSidechain) id = r.sessionId;
    if (r.type === 'custom-title') title = r.customTitle || title;
    if (r.type === 'session_info') title = r.name || title;
    const msg = agent === 'codex' ? r.payload : r.message;
    if (!firstUser && msg?.role === 'user' && !r.isMeta) {
      const value = text(msg.content).trim();
      if (value && !value.startsWith('<') && !value.startsWith('# AGENTS.md')) firstUser = value;
    }
  }
  if (!uuid.test(id || '')) continue;
  const value = String(names.get(id) || title || firstUser || 'Untitled session').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,160);
  if (!sessions.has(id)) sessions.set(id,{id,title:value,updatedAt:file.time,resumePath:file.path});
}
process.stdout.write(JSON.stringify({sessions:[...sessions.values()],partial}));
`;

export function nativeSessionRoot(agent: EnvironmentAgentId) {
  return agent === "pi"
    ? "/workspace/.pi/agent"
    : `/workspace/.sandpi/harnesses/${agent}`;
}

export function nativeSessionCommand(
  agent: EnvironmentAgentId,
  id?: string,
  resumePath?: string,
) {
  const command = [...agentAdapter(agent).command];
  if (!id) return command;
  z.string().uuid().parse(id);
  if (agent === "codex") return [...command, "resume", id];
  if (agent === "claude-code") return [...command, "--resume", id];
  const root = `${nativeSessionRoot(agent)}/sessions/`;
  if (
    !resumePath?.startsWith(root) ||
    resumePath.split("/").includes("..") ||
    !resumePath.endsWith(".jsonl")
  ) {
    throw new Error("Invalid native session path");
  }
  return [...command, "--session", resumePath];
}
