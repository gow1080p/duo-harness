import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type RouteTier = "tier0_replay" | "tier1_mimo_peak" | "tier2_deepseek_offpeak" | "tier3_gemini_cli";
export interface RouteOptions { isReplay?: boolean; forceGeminiCli?: boolean; }
export interface RouteDecision { tier: RouteTier; beijingHour: number; isWorkday: boolean; reason: string; }

export type ModelMode = "auto" | "deepseek" | "mimo" | "agy" | "openai" | (string & {});

export interface ModelEndpointConfig {
  protocol?: "openai" | "agy"; baseUrl: string; model: string; apiKey?: string; apiKeyEnv?: string; label?: string; supportsVision?: boolean;
}
export interface TimeRoutingConfig { peakModel?: string; offPeakModel?: string; visionModel?: string; }
export interface ModelRegistryConfig { defaultModel?: string; timeRouting?: TimeRoutingConfig; models: Record<string, ModelEndpointConfig>; }
export interface ResolvedModelTarget { apiUrl: string; model: string; apiKey: string; shortLabel: string; supportsVision: boolean; protocol: "openai" | "agy"; }

export function resolveRouteTier(utcTimestampMs: number, options: RouteOptions = {}): RouteDecision {
  const beijingDate = new Date(utcTimestampMs + 8 * 3600_000);
  const day = beijingDate.getUTCDay();
  const beijingHour = beijingDate.getUTCHours();
  const isWorkday = day >= 1 && day <= 5;
  if (options.isReplay) return { tier: "tier0_replay", beijingHour, isWorkday, reason: "离线录像回放模式 (¥0)" };
  if (options.forceGeminiCli) return { tier: "tier3_gemini_cli", beijingHour, isWorkday, reason: "显式指定 Gemini CLI 桥接兜底 (¥0)" };
  const isPeakHour = isWorkday && ((beijingHour >= 9 && beijingHour < 12) || (beijingHour >= 14 && beijingHour < 18));
  if (isPeakHour) return { tier: "tier1_mimo_peak", beijingHour, isWorkday, reason: `工作日高峰时段 (${beijingHour}:00 · 自动路由高速主力模型)` };
  return { tier: "tier2_deepseek_offpeak", beijingHour, isWorkday, reason: `低谷优惠时段 (${isWorkday ? "工作日午休/夜间" : "周末"} ${beijingHour}:00 · 自动路由 DeepSeek)` };
}

function readKeyFromFile(filePath: string, envName: string, allowBareFirstLine = true): string {
  if (!fs.existsSync(filePath)) return "";
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  const match = raw.match(new RegExp(`^(?:export\\s+)?${envName}\\s*=\\s*(.+)$`, "m"));
  if (match?.[1]) return match[1].trim().replace(/^['"]|['"]$/g, "");
  if (!allowBareFirstLine) return "";
  const firstLine = raw.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  return firstLine.includes("=") ? "" : firstLine.replace(/^['"]|['"]$/g, "");
}

export function loadApiKey(envName: string, dotFileName?: string): string {
  if (!envName) return "";
  if (process.env[envName]?.trim()) return process.env[envName]!.trim();
  const cwdEnv = readKeyFromFile(path.resolve(process.cwd(), ".env.local"), envName, false);
  if (cwdEnv) return cwdEnv;
  const harnessRootEnv = readKeyFromFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env.local"), envName, false);
  if (harnessRootEnv) return harnessRootEnv;
  if (!dotFileName) return "";
  const duoKey = readKeyFromFile(path.join(os.homedir(), ".duo-harness", dotFileName), envName, true);
  return duoKey || readKeyFromFile(path.join(os.homedir(), ".gemini", "antigravity", dotFileName), envName, true);
}

function readJsonConfigSafe(filePath: string): Partial<ModelRegistryConfig> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function loadModelRegistryConfig(workspaceRoot = process.cwd(), customConfigPath?: string): ModelRegistryConfig {
  const openaiKey = loadApiKey("OPENAI_API_KEY", ".openai_key");
  const mimoKey = loadApiKey("MIMO_API_KEY", ".mimo_key");
  const deepseekKey = loadApiKey("DEEPSEEK_API_KEY", ".deepseek_key");
  const agyKey = loadApiKey("AGY_API_KEY", ".agy_key");
  const isTokenPlan = mimoKey.startsWith("tp-") || mimoKey.startsWith("ttp-");
  const builtinModels: Record<string, ModelEndpointConfig> = {
    deepseek: {
      protocol: "openai",
      baseUrl: "https://api.deepseek.com",
      model: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-reasoner",
      apiKey: deepseekKey,
      apiKeyEnv: "DEEPSEEK_API_KEY",
      label: "DeepSeek",
      supportsVision: false,
    },
    mimo: {
      protocol: "openai",
      baseUrl: process.env.MIMO_BASE_URL?.trim() || (isTokenPlan ? "https://token-plan-cn.xiaomimimo.com/v1" : "https://api.xiaomimimo.com/v1"),
      model: process.env.MIMO_MODEL?.trim() || "mimo-v2.6-pro",
      apiKey: mimoKey,
      apiKeyEnv: "MIMO_API_KEY",
      label: "MiMo-2.6",
      supportsVision: true,
    },
    openai: {
      protocol: "openai",
      baseUrl: (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, ""),
      model: process.env.OPENAI_MODEL?.trim() || "gpt-5-codex",
      apiKey: openaiKey,
      apiKeyEnv: "OPENAI_API_KEY",
      label: "OpenAI",
      supportsVision: true,
    },
    agy: {
      protocol: "openai",
      baseUrl: (process.env.AGY_BASE_URL?.trim() || "https://gemini.gow1080p.cn/v1").replace(/\/$/, ""),
      model: process.env.AGY_MODEL?.trim() || "gemini-4-argon-high",
      apiKey: agyKey,
      apiKeyEnv: "AGY_API_KEY",
      label: "Argon·反重力",
      supportsVision: true,
    },
  };
  const globalFile = process.env.DUO_MODELS_CONFIG?.trim() || path.join(os.homedir(), ".duo-harness", "models.json");
  const wsFile = customConfigPath ? path.resolve(workspaceRoot, customConfigPath) : path.join(path.resolve(workspaceRoot), ".duo", "models.json");
  const globalCfg = Boolean(process.env.VITEST) && !process.env.DUO_MODELS_CONFIG?.trim() ? {} : readJsonConfigSafe(globalFile);
  const wsCfg = readJsonConfigSafe(wsFile);
  const mergedModels: Record<string, ModelEndpointConfig> = { ...builtinModels };
  for (const src of [globalCfg.models, wsCfg.models]) {
    if (!src || typeof src !== "object") continue;
    for (const [k, v] of Object.entries(src)) {
      if (!v || typeof v !== "object" || (k === "agy" && v.baseUrl === "agy://local-language-server")) continue;
      const next = { ...mergedModels[k], ...v };
      if (typeof next.baseUrl === "string" && typeof next.model === "string") mergedModels[k] = next;
    }
  }
  return {
    defaultModel: wsCfg.defaultModel ?? globalCfg.defaultModel ?? "auto",
    timeRouting: {
      peakModel: "mimo",
      offPeakModel: "deepseek",
      visionModel: "mimo",
      ...globalCfg.timeRouting,
      ...wsCfg.timeRouting,
    },
    models: mergedModels,
  };
}

export function listAvailableModelModes(workspaceRoot = process.cwd(), customConfigPath?: string): string[] {
  const cfg = loadModelRegistryConfig(workspaceRoot, customConfigPath);
  return ["auto", ...Object.keys(cfg.models)];
}

export function resolveModelsConfigPath(workspaceRoot = process.cwd(), preferWorkspace = false): string {
  const wsFile = path.join(path.resolve(workspaceRoot), ".duo", "models.json");
  if (preferWorkspace || fs.existsSync(wsFile)) return wsFile;
  return process.env.DUO_MODELS_CONFIG?.trim() || path.join(os.homedir(), ".duo-harness", "models.json");
}

export function ensureDefaultModelsConfigFile(workspaceRoot = process.cwd(), preferWorkspace = false): string {
  const targetFile = resolveModelsConfigPath(workspaceRoot, preferWorkspace);
  if (!fs.existsSync(targetFile)) {
    const cfg = loadModelRegistryConfig(workspaceRoot);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  }
  return targetFile;
}

export function saveModelRegistryConfig(patch: Partial<ModelRegistryConfig>, workspaceRoot = process.cwd(), preferWorkspace = false): string {
  const targetFile = resolveModelsConfigPath(workspaceRoot, preferWorkspace);
  const existing = readJsonConfigSafe(targetFile);
  const nextModels: Record<string, ModelEndpointConfig> = { ...(existing.models ?? {}) };
  if (patch.models && typeof patch.models === "object") {
    for (const [k, v] of Object.entries(patch.models)) {
      if (v && typeof v === "object") nextModels[k] = { ...nextModels[k], ...v };
    }
  }
  const merged: ModelRegistryConfig = {
    defaultModel: patch.defaultModel ?? existing.defaultModel ?? "auto",
    timeRouting: { peakModel: "mimo", offPeakModel: "deepseek", visionModel: "mimo", ...existing.timeRouting, ...patch.timeRouting },
    models: nextModels,
  };
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return targetFile;
}

function buildResolvedTarget(key: string, profile: ModelEndpointConfig, suffix = ""): ResolvedModelTarget {
  const protocol = profile.protocol === "agy" || profile.baseUrl.startsWith("agy://") ? "agy" : "openai";
  const cleanUrl = profile.baseUrl.replace(/\/$/, "");
  const apiUrl = protocol === "agy" || cleanUrl.endsWith("/chat/completions") ? cleanUrl : `${cleanUrl}/chat/completions`;
  const envKey = profile.apiKeyEnv ? loadApiKey(profile.apiKeyEnv) : "";
  const isLocalHttp = /^http:\/\/(?:localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(cleanUrl);
  const apiKey = envKey || profile.apiKey || (isLocalHttp ? "EMPTY" : "");
  const baseTag = profile.label || key;
  const supportsVision = profile.supportsVision ?? !profile.model.toLowerCase().startsWith("deepseek");
  return { apiUrl, model: profile.model, apiKey, shortLabel: suffix ? `${baseTag}${suffix}` : baseTag, supportsVision, protocol };
}

export function resolveActiveModelTarget(
  wireLogFile?: string,
  hasPriorAssistant = false,
  mode: ModelMode = "auto",
  nowUtcMs = Date.now(),
  hasImages = false,
  workspaceRoot = process.cwd(),
  customConfig?: ModelRegistryConfig,
): ResolvedModelTarget {
  const cfg = customConfig ?? loadModelRegistryConfig(workspaceRoot);
  const effectiveMode = mode === "auto" && cfg.defaultModel && cfg.defaultModel !== "auto" ? cfg.defaultModel : mode;
  if (effectiveMode !== "auto") {
    const directKey = cfg.models[effectiveMode] ? effectiveMode : Object.keys(cfg.models).find((k) => cfg.models[k]?.model === effectiveMode);
    if (!directKey) throw new Error(`未找到模型配置 "${effectiveMode}"，请在 .duo/models.json 或 ~/.duo-harness/models.json 中定义`);
    const target = buildResolvedTarget(directKey, cfg.models[directKey]!, effectiveMode === "agy" ? "" : "·锁");
    if (hasImages && !target.supportsVision) {
      throw new Error(`当前会话包含未折叠的图片附件，但模型 [${target.model}] 不支持视觉输入 (image_url)；请切换到支持视觉的模型或执行 /compact 折叠历史图片后再试。`);
    }
    return target;
  }

  let stickyKey: string | null = null;
  if (hasPriorAssistant && wireLogFile && fs.existsSync(wireLogFile)) {
    try {
      const arr = JSON.parse(fs.readFileSync(wireLogFile, "utf-8")), last = arr[arr.length - 1];
      const lastModel = String(last?.requestBody?.model ?? last?.model ?? ""), lastUrl = String(last?.apiUrl ?? "");
      const entries = Object.entries(cfg.models).map(([k, p]) => ({ k, p, r: buildResolvedTarget(k, p) })).filter((x) => Boolean(x.r.apiKey));
      const exact = lastUrl ? entries.find((x) => x.r.apiUrl === lastUrl && x.p.model === lastModel) : undefined;
      const fallback = entries.find((x) => x.p.model === lastModel || (x.k !== "openai" && lastModel.startsWith(x.k)));
      stickyKey = (exact ?? fallback)?.k ?? null;
    } catch {}
  }

  const peakKey = cfg.timeRouting?.peakModel ?? "mimo";
  const offPeakKey = cfg.timeRouting?.offPeakModel ?? "deepseek";
  const visionKey = cfg.timeRouting?.visionModel ?? peakKey;
  const resolvedVisionKey = cfg.models[visionKey] ? visionKey : peakKey;
  const openaiTarget = cfg.models.openai ? buildResolvedTarget("openai", cfg.models.openai) : null;
  const peakTarget = cfg.models[peakKey] ? buildResolvedTarget(peakKey, cfg.models[peakKey]!) : null;
  const offPeakTarget = cfg.models[offPeakKey] ? buildResolvedTarget(offPeakKey, cfg.models[offPeakKey]!) : null;
  const visionTarget = cfg.models[resolvedVisionKey] ? buildResolvedTarget(resolvedVisionKey, cfg.models[resolvedVisionKey]!) : null;

  const useOpenAi = Boolean(openaiTarget?.apiKey && ((!peakTarget?.apiKey && !offPeakTarget?.apiKey) || process.env.LLM_PROVIDER === "openai"));
  if (useOpenAi && openaiTarget) return openaiTarget;
  if (hasImages) {
    if (visionTarget?.apiKey && visionTarget.supportsVision) return buildResolvedTarget(resolvedVisionKey, cfg.models[resolvedVisionKey]!, "·视觉");
    throw new Error("当前会话包含未折叠的图片附件，但 DeepSeek 官方接口不支持视觉输入 (image_url)；请配置 MIMO_API_KEY / 执行 /model mimo 切换到支持视觉的模型，或执行 /compact 折叠历史图片后再试。");
  }
  if (stickyKey && cfg.models[stickyKey]) return buildResolvedTarget(stickyKey, cfg.models[stickyKey]!, "·保缓存");
  const decision = resolveRouteTier(nowUtcMs);
  if (decision.tier === "tier1_mimo_peak" && peakTarget?.apiKey) return peakTarget;
  return offPeakTarget ?? peakTarget ?? buildResolvedTarget("deepseek", cfg.models.deepseek!);
}
