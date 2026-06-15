import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

// Rate limiter: 6 uploads / IP / 10 min (uploads burn embedding credits)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const LIMIT = 6
const WINDOW_MS = 10 * 60 * 1000

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    return true
  }
  if (entry.count >= LIMIT) return false
  entry.count++
  return true
}

function getIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}

const MAX_CHARS = 60_000 // ~120 chunks — bounds embedding cost per upload
const MAX_CHUNKS = 80

function chunkText(content: string, chunkSize = 500, overlap = 50) {
  const text = content.trim()
  const chunks: string[] = []
  let start = 0
  while (start < text.length && chunks.length < MAX_CHUNKS) {
    let end = start + chunkSize
    if (end < text.length) {
      const seps = ['. ', '.\n', '? ', '!\n', '\n\n']
      for (const sep of seps) {
        const lastSep = text.slice(start, end).lastIndexOf(sep)
        if (lastSep !== -1) {
          end = start + lastSep + sep.length
          break
        }
      }
    }
    const piece = text.slice(start, end).trim()
    if (piece) chunks.push(piece)
    start = end - overlap
  }
  return chunks
}

let cachedIndexHost: string | null = null

async function getPineconeHost(apiKey: string, indexName: string): Promise<string> {
  if (cachedIndexHost) return cachedIndexHost
  const res = await fetch(`https://api.pinecone.io/indexes/${indexName}`, {
    headers: { 'Api-Key': apiKey },
  })
  if (!res.ok) throw new Error(`Pinecone index lookup failed (${res.status})`)
  const data = (await res.json()) as { host?: string }
  if (!data.host) throw new Error('Pinecone index host not found in response')
  cachedIndexHost = data.host
  return data.host
}

function makeNamespace(): string {
  return (
    'upload-' +
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 8)
  )
}

export async function POST(req: NextRequest) {
  const ip = getIp(req)
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: 'Upload limit reached — try again in 10 minutes' },
      { status: 429 }
    )
  }

  let body: { text?: string; title?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const rawText = (body.text ?? '').trim()
  const title = (body.title ?? 'Your Document').slice(0, 80)

  if (!rawText) {
    return NextResponse.json({ error: 'No text found in document' }, { status: 400 })
  }
  const text = rawText.slice(0, MAX_CHARS)

  const openaiKey = process.env.OPENAI_API_KEY
  const pineconeKey = process.env.PINECONE_API_KEY
  const indexName = process.env.PINECONE_INDEX_NAME ?? 'policy-docs'
  if (!openaiKey || !pineconeKey) {
    return NextResponse.json(
      { error: 'Server not configured — API keys missing' },
      { status: 500 }
    )
  }

  try {
    const openai = new OpenAI({ apiKey: openaiKey })
    const chunks = chunkText(text)
    if (chunks.length === 0) {
      return NextResponse.json({ error: 'Document produced no usable text' }, { status: 400 })
    }

    // Embed all chunks in one batch call
    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: chunks,
    })

    const namespace = makeNamespace()
    const vectors = embRes.data.map((e, i) => ({
      id: `${namespace}-chunk-${i}`,
      values: e.embedding,
      metadata: { title, text: chunks[i], chunk_num: i },
    }))

    const host = await getPineconeHost(pineconeKey, indexName)
    const upsertRes = await fetch(`https://${host}/vectors/upsert`, {
      method: 'POST',
      headers: { 'Api-Key': pineconeKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ vectors, namespace }),
    })
    if (!upsertRes.ok) throw new Error(`Pinecone upsert failed (${upsertRes.status})`)

    return NextResponse.json({ namespace, title, chunks: chunks.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
