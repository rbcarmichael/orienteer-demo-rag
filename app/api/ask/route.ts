import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

// Rate limiter: 30 req / IP / 10 min
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const LIMIT = 30
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

// Cache the Pinecone index host — resolved once per serverless instance
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

interface PineconeMatch {
  score?: number
  metadata?: Record<string, unknown>
}

export async function POST(req: NextRequest) {
  const ip = getIp(req)
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  let body: { question?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const question = body.question?.trim()
  if (!question) {
    return NextResponse.json({ error: 'Missing question' }, { status: 400 })
  }

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

    // 1. Embed the question
    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: question,
    })
    const vector = embRes.data[0].embedding

    // 2. Query Pinecone
    const host = await getPineconeHost(pineconeKey, indexName)
    const queryRes = await fetch(`https://${host}/query`, {
      method: 'POST',
      headers: {
        'Api-Key': pineconeKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ topK: 3, vector, includeMetadata: true }),
    })
    if (!queryRes.ok) throw new Error(`Pinecone query failed (${queryRes.status})`)

    const queryData = (await queryRes.json()) as { matches?: PineconeMatch[] }
    const matches = queryData.matches ?? []

    const sources = matches.map((m) => ({
      title: (m.metadata?.title as string) ?? 'Policy Document',
      text: ((m.metadata?.text as string) ?? '').slice(0, 500),
      relevance: m.score ?? 0,
    }))

    // 3. Generate answer with retrieved context
    const contextText = sources
      .map((s) => `[${s.title}]\n${s.text}`)
      .join('\n\n')

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful HR assistant. Answer questions based ONLY on the provided policy context. Always cite which policy document your answer comes from. If the answer is not in the context, say "I don\'t have that information in the policy documents." Be concise and clear.',
        },
        {
          role: 'user',
          content: `Context:\n${contextText}\n\nQuestion: ${question}`,
        },
      ],
      temperature: 0.3,
    })

    const answer = completion.choices[0]?.message?.content ?? 'Unable to generate an answer.'

    return NextResponse.json({ answer, sources })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
