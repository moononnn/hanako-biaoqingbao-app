// 页面启动数据（App 版）
//
// 老版是把这些数据在服务端拼进 HTML 的（见插件 routes/ui.js 的 renderPage）。
// App 版页面是静态的，所以改成一个接口，页面启动时自己来取。
//
// 注意：密钥字段一律只给占位符，真实密钥留在配置文件里，不下发到页面。

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  DATA_DIR,
  readVisionConfig,
  readTextConfig,
  readEmbeddingConfig,
  getAvailableVisionModels,
  getAvailableTextModels,
  getAvailableEmbeddingModels,
} from '../lib/shared.js';
import { readSafeJevConfig } from '../lib/jev.js';
import { readContextFeedback } from '../lib/context-feedback.js';
import { listAgentFitNotes } from '../lib/agent-fit-notes.js';
import { EXPORT_CONFIG_FILE_NAME, readLastExportDir, readAgentCatalog } from '../lib/sticker-transfer.js';
import { readChahuahuiUsage, summarizeChahuahuiUsage } from '../lib/chahuahui-usage.js';

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf-8'));
  } catch {
    return fallback;
  }
}

export function buildBootData() {
  const visionConfig = readVisionConfig();
  const textConfig = readTextConfig();
  const embeddingConfig = readEmbeddingConfig();

  const exportConfigPath = path.join(DATA_DIR, EXPORT_CONFIG_FILE_NAME);

  const agentNames = {};
  for (const item of readAgentCatalog()) {
    if (item?.id) agentNames[item.id] = item.name || item.id;
  }

  return {
    // 密钥只给占位符，跟老页面一致
    __VISION_CONFIG__: { ...visionConfig, customApiKey: visionConfig.customApiKey ? '********' : '' },
    __VISION_MODELS__: getAvailableVisionModels(),
    __TEXT_CONFIG__: { ...textConfig, customApiKey: textConfig.customApiKey ? '********' : '' },
    __TEXT_MODELS__: getAvailableTextModels(),
    __EMBEDDING_CONFIG__: { ...embeddingConfig, customApiKey: embeddingConfig.customApiKey ? '********' : '' },
    __EMBEDDING_MODELS__: getAvailableEmbeddingModels(),
    __JEV_CONFIG__: readSafeJevConfig(),
    __PREFERENCES__: readJson('preferences.json', { version: 1, users: {} }),
    __DISPLAY_CONFIG__: readJson('display-config.json', {
      smallImageFit: true,
      smallImageThreshold: 200,
      showFeedbackButtons: true,
      sizeMode: 'auto',
      agentSelfNote: true,
    }),
    __DECISION_LOG__: readJson('decision-log.json', { version: 1, entries: [] }),
    __CONTEXT_FEEDBACK__: readContextFeedback({ dataDir: DATA_DIR }),
    __AGENT_FIT_NOTES__: listAgentFitNotes({ dataDir: DATA_DIR, limit: 200 }),
    __AGENT_NAMES__: agentNames,
    __CHAHUAHUI_USAGE__: summarizeChahuahuiUsage(readChahuahuiUsage()),
    __EXPORT_CONFIG__: { dir: readLastExportDir(exportConfigPath, path.join(homedir(), 'Downloads')) },
  };
}
