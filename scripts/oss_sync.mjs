#!/usr/bin/env node
// 将 site/ 同步到阿里云 OSS（OSS4-HMAC-SHA256 Header 签名，零依赖）。
// 用法：OSS_AK=... OSS_SK=... [OSS_BUCKET=bahe-prd] [OSS_PREFIX=smart-import-workbench-web] [OSS_REGION=cn-shanghai] [OSS_SYNC_DELETE=true] node scripts/oss_sync.mjs
import { createHmac, createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const AK = process.env.OSS_AK
const SK = process.env.OSS_SK
if (!AK || !SK) { console.error('缺少 OSS_AK / OSS_SK'); process.exit(1) }

const BUCKET = process.env.OSS_BUCKET || 'bahe-prd'
const REGION = process.env.OSS_REGION || 'cn-shanghai'
const PREFIX = (process.env.OSS_PREFIX || 'smart-import-workbench-web').replace(/^\/+|\/+$/g, '')
const DELETE_ORPHANS = String(process.env.OSS_SYNC_DELETE || 'false') === 'true'
const HOST = `${BUCKET}.oss-${REGION}.aliyuncs.com`
const ROOT = fileURLToPath(new URL('../site', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
}
const mimeOf = file => MIME[extname(file).toLowerCase()] || 'application/octet-stream'

const files = []
const walk = dir => { for (const name of readdirSync(dir)) { const p = join(dir, name); statSync(p).isDirectory() ? walk(p) : files.push(p) } }
walk(ROOT)
console.log(`待上传 ${files.length} 个文件 → oss://${BUCKET}/${PREFIX}/`)

const sha256 = data => createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()
const urlPath = key => key.split('/').map(encodeURIComponent).join('/')

function sign(method, key, contentType, query = '') {
  const date = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const shortDate = date.slice(0, 8)
  const canonicalHeaders = `content-type:${contentType}\nhost:${HOST}\nx-oss-content-sha256:UNSIGNED-PAYLOAD\nx-oss-date:${date}\n`
  const canonicalRequest = `${method}\n/${BUCKET}/${key}\n${query}\n${canonicalHeaders}\nhost\nUNSIGNED-PAYLOAD`
  const scope = `${shortDate}/${REGION}/oss/aliyun_v4_request`
  const stringToSign = `OSS4-HMAC-SHA256\n${date}\n${scope}\n${sha256(canonicalRequest)}`
  const signingKey = hmac(hmac(hmac(hmac(`aliyun_v4${SK}`, shortDate), REGION), 'oss'), 'aliyun_v4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return {
    date,
    authorization: `OSS4-HMAC-SHA256 Credential=${AK}/${scope},AdditionalHeaders=host,Signature=${signature}`,
  }
}

async function request(method, key, contentType = 'application/octet-stream', body, query = '') {
  const { date, authorization } = sign(method, key, contentType, query)
  const headers = { host: HOST, 'x-oss-date': date, 'x-oss-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': contentType, authorization }
  const response = await fetch(`https://${HOST}/${urlPath(key)}${query ? '?' + query : ''}`, { method, headers, body })
  if (!response.ok) throw new Error(`${method} ${key} → ${response.status}: ${(await response.text()).slice(0, 200)}`)
  return response
}

let uploaded = 0
for (const file of files) {
  const key = `${PREFIX}/${relative(ROOT, file).split('\\').join('/')}`
  await request('PUT', key, mimeOf(file), readFileSync(file))
  uploaded += 1
}
console.log(`已上传 ${uploaded} 个文件`)

if (DELETE_ORPHANS) {
  const wanted = new Set(files.map(file => `${PREFIX}/${relative(ROOT, file).split('\\').join('/')}`))
  const existing = []
  let token = ''
  for (;;) {
    const query = `list-type=2&max-keys=1000&prefix=${encodeURIComponent(PREFIX + '/')}${token ? '&continuation-token=' + encodeURIComponent(token) : ''}`
    const response = await request('GET', '', 'application/octet-stream', undefined, query)
    const xml = await response.text()
    existing.push(...[...xml.matchAll(/<Key>(.*?)<\/Key>/g)].map(match => match[1]))
    const next = /<NextContinuationToken>(.*?)<\/NextContinuationToken>/.exec(xml)?.[1]
    if (!next || !/<IsTruncated>true<\/IsTruncated>/.test(xml)) break
    token = next
  }
  const orphans = existing.filter(key => !wanted.has(key))
  for (const key of orphans) await request('DELETE', key, 'application/octet-stream')
  console.log(`远端共 ${existing.length} 个对象，删除多余 ${orphans.length} 个`)
}
console.log('同步完成')
