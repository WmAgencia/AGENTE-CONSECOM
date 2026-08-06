/**
 * Build the default tool registry from env configuration.
 *
 * Tools are registered based on:
 *  - AGENT_ENABLE_TOOLS: master switch (default false; tests opt-in).
 *  - AGENT_ALLOWED_TOOLS: comma-separated permit list. If absent -> all.
 *  - AGENT_ALLOWED_PERMS: comma-separated permission categories allowed at
 *    runtime. Example: "READ,WRITE". NETWORK/EXECUTE/WHATSAPP are NOT
 *    enabled by default for safety.
 *  - AGENT_ALLOWED_DIR: filesystem root for READ/WRITE tools. Defaults
 *    to a "workspace" subdir of the current working directory.
 *
 * The registry is FROZEN after this function runs.
 */
import { mkdirSync } from 'node:fs';
import {
  ToolRegistry,
  setDefaultRegistry,
  type ToolPermission,
} from './registry.js';
import { createFileReadTool } from './file.read.js';
import { createFileWriteTool } from './file.write.js';
import { createListDirTool } from './list.dir.js';
import { createMarcarReuniaoTool } from './marcar.reuniao.js';
import { createNotifyAdminGroupTool } from './notify.admin.js';
import { getEnv } from '../config/env.js';

let buildCalled = false;

export function buildDefaultRegistry(): ToolRegistry {
  if (buildCalled) {
    throw new Error('buildDefaultRegistry called twice');
  }
  buildCalled = true;

  const env = getEnv();
  const enabled = env.AGENT_ENABLE_TOOLS === true;

  const allowedPermsList = env.AGENT_ALLOWED_PERMS
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean) as ToolPermission[];

  const allowedToolsList = env.AGENT_ALLOWED_TOOLS
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let allowedDir = env.AGENT_ALLOWED_DIR || `${process.cwd()}/workspace`;
  try {
    mkdirSync(allowedDir, { recursive: true });
  } catch {
    // non-fatal: tools will surface the error on first use
  }

  const registry = new ToolRegistry({
    enabled,
    allowedPerms: allowedPermsList,
  });

  const fileRead = createFileReadTool(allowedDir);
  const fileWrite = createFileWriteTool(allowedDir);
  const listDir = createListDirTool(allowedDir);
  const marcarReuniao = createMarcarReuniaoTool();
  const notifyAdminGroup = createNotifyAdminGroupTool();

  const all = [
    { name: fileRead.definition.name, tool: fileRead },
    { name: fileWrite.definition.name, tool: fileWrite },
    { name: listDir.definition.name, tool: listDir },
    { name: marcarReuniao.definition.name, tool: marcarReuniao },
    { name: notifyAdminGroup.definition.name, tool: notifyAdminGroup },
  ];

  for (const { name, tool } of all) {
    if (allowedToolsList.length > 0 && !allowedToolsList.includes(name)) {
      continue;
    }
    registry.register(tool);
  }

  setDefaultRegistry(registry);
  return registry;
}
