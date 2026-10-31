import * as dns from "node:dns";
import * as net from "node:net";
import { z } from "zod";
import type { ToolContract } from "../core/contracts.js";

const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 15 * 60_000;
const MAX_CACHE_ENTRIES = 32;
const urlContentCache = new Map<string, { ts: number; contentType: string; text: string }>();

export function clearWebFetchCache(): void {
  urlContentCache.clear();
}

export function normalizeMappedIpv4(rawHost: string): string {
  const clean = rawHost.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  const dotted = clean.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dotted) return dotted[1]!;
  const hex = clean.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return clean;
}

export function isBlockedIpAddress(rawIp: string, allowLoopback = false): boolean {
  const ip = normalizeMappedIpv4(rawIp);
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    if (a === 127) return !allowLoopback;
    if (a === 0 || a === 10 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return !allowLoopback;
    if (ip === "::" || ip === "0:0:0:0:0:0:0:0") return true;
    if (/^(?:fc|fd)[0-9a-f]{2}:/i.test(ip) || /^fe[89ab][0-9a-f]:/i.test(ip) || /^ff[0-9a-f]{2}:/i.test(ip)) return true;
  }
  return false;
}

export function isBlockedFetchUrl(
  rawUrl: string,
  allowExplicitLoopback = false,
): { blocked: boolean; reason?: string; isExplicitLoopback?: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { blocked: true, reason: `无效的 URL 格式: ${rawUrl}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { blocked: true, reason: `禁止访问非 HTTP(S) 协议 (${parsed.protocol}): ${rawUrl}` };
  }
  const rawHost = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const normHost = normalizeMappedIpv4(rawHost);
  if (!normHost) return { blocked: true, reason: `URL 缺少有效主机名: ${rawUrl}` };
  if (
    normHost === "metadata.google.internal" ||
    normHost === "metadata.tencentyun.com" ||
    normHost === "metadata" ||
    normHost.endsWith(".internal") ||
    normHost.endsWith(".local")
  ) {
    return { blocked: true, reason: `禁止访问云元数据或内网私有域名 (${normHost})` };
  }
  if (normHost === "localhost" || normHost === "127.0.0.1" || normHost === "::1") {
    return allowExplicitLoopback
      ? { blocked: false, isExplicitLoopback: true }
      : { blocked: true, reason: `禁止访问本机回环地址 (${normHost})` };
  }
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(normHost) || (normHost.split(".").every((p) => /^(?:0x[0-9a-f]+|0\d+|\d+)$/i.test(p)) && !net.isIPv4(normHost))) {
    return { blocked: true, reason: `禁止使用非标准编码 IP 地址 (${normHost})` };
  }
  if (isBlockedIpAddress(normHost, allowExplicitLoopback)) {
    return { blocked: true, reason: `禁止访问私有内网、保留网段或云元数据地址 (${rawHost})` };
  }
  return { blocked: false, isExplicitLoopback: false };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

export function htmlToCleanMarkdown(rawHtml: string): string {
  const withoutNoise = rawHtml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|svg|noscript|iframe|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => `\n\`\`\`\n${decodeHtmlEntities(inner.replace(/<[^>]+>/g, "")).trim()}\n\`\`\`\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, inner: string) => `\n${"#".repeat(Number(lvl))} ${inner.replace(/<[^>]+>/g, "").trim()}\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${inner.replace(/<[^>]+>/g, "").trim()}`)
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const cleanLabel = label.replace(/<[^>]+>/g, "").trim();
      return cleanLabel && !href.startsWith("javascript:") ? `[${cleanLabel}](${href})` : cleanLabel;
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${inner.replace(/<[^>]+>/g, "").trim()}\``)
    .replace(/<\/(?:p|div|section|article|header|footer|main|tr|blockquote|ul|ol)>/gi, "\n")
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(?:td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(withoutNoise)
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string }>>;
const defaultDnsLookup: DnsLookupFn = (hostname) => dns.promises.lookup(hostname, { all: true });

async function readResponseWithCap(res: Response, maxBytes = MAX_FETCH_BYTES): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes))));
        break;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export const FetchUrlArgsSchema = z.object({
  url: z.string().min(1).describe("要读取的完整 http/https URL 地址"),
  offset: z.number().int().min(0).optional().describe("字符起始偏移量（用于长文档分页续读，默认 0）"),
  maxChars: z.number().int().min(500).max(60_000).optional().describe("单次最大返回字符数（默认 20000）"),
});

export async function executeWebFetch(
  args: z.infer<typeof FetchUrlArgsSchema>,
  options: { signal?: AbortSignal; dnsLookup?: DnsLookupFn; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const startOffset = args.offset ?? 0, maxChars = args.maxChars ?? 20_000;
  const lookup = options.dnsLookup ?? defaultDnsLookup, doFetch = options.fetchImpl ?? fetch;
  let currentUrl = args.url.trim();
  const cached = urlContentCache.get(currentUrl);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    const slice = cached.text.slice(startOffset, startOffset + maxChars);
    const more = startOffset + maxChars < cached.text.length ? `\n... [内容未完 (共 ${cached.text.length} 字符)，可传 offset: ${startOffset + maxChars} 继续读取]` : "";
    return `${slice}${more}`;
  }
  for (let hop = 0; hop <= 3; hop++) {
    const check = isBlockedFetchUrl(currentUrl, false);
    if (check.blocked) throw new Error(`[沙箱安全拦截] ${check.reason}`);
    const host = normalizeMappedIpv4(new URL(currentUrl).hostname);
    if (!check.isExplicitLoopback && !net.isIP(host)) {
      const addrs = await lookup(host);
      for (const a of addrs) {
        if (isBlockedIpAddress(a.address, false)) {
          throw new Error(`[沙箱安全拦截] 域名 ${host} 解析到受限内网或回环地址 (${a.address})，已阻断请求`);
        }
      }
    }
    const res = await doFetch(currentUrl, { redirect: "manual", signal: options.signal, headers: { "User-Agent": "Duo-Harness/1.0 (ReadOnly-Fetch)" } });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`HTTP ${res.status} 重定向缺少 Location 响应头`);
      if (hop === 3) throw new Error("重定向次数超过上限 (最多 3 次)");
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const rawBody = await readResponseWithCap(res);
    const isHtml = contentType.includes("text/html") || /^\s*<(?:!doctype\s+html|html)\b/i.test(rawBody);
    const cleaned = isHtml ? htmlToCleanMarkdown(rawBody) : rawBody.trim();
    if (urlContentCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = urlContentCache.keys().next().value;
      if (oldestKey) urlContentCache.delete(oldestKey);
    }
    urlContentCache.set(args.url.trim(), { ts: Date.now(), contentType, text: cleaned });
    const slice = cleaned.slice(startOffset, startOffset + maxChars);
    const more = startOffset + maxChars < cleaned.length ? `\n... [内容未完 (共 ${cleaned.length} 字符)，可传 offset: ${startOffset + maxChars} 继续读取]` : "";
    return `${slice}${more}`;
  }
  throw new Error("重定向次数超过上限");
}

export function createWebFetchTool(signal?: AbortSignal): ToolContract<z.infer<typeof FetchUrlArgsSchema>> {
  return {
    name: "fetch_url",
    description: "只读抓取指定 HTTP/HTTPS URL 的网页或文档内容（自动剥离 HTML 脚本/样式噪音转为干净 Markdown，支持 offset 分页续读）",
    parameters: FetchUrlArgsSchema,
    readonly: true,
    execute: (args) => executeWebFetch(args, { signal }),
  };
}
