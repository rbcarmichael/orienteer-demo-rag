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

// Below this similarity, nothing relevant was retrieved at all — skip the grounded attempt.
const RETRIEVAL_FLOOR = 0.15

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

  let body: { question?: string; namespace?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const question = body.question?.trim()
  const namespace = body.namespace?.trim() || ''
  if (!question) {
    return NextResponse.json({ error: 'Missing question' }, { status: 400 })
  }
  if (question.length > 500) {
    return NextResponse.json({ error: 'Question too long' }, { status: 400 })
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

    // --- Ungoverned answer: a normal assistant, no documents, runs in parallel ---
    const ungovernedPromise = openai.chat.completions
      .create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful corporate assistant. Answer the employee question directly and confidently in 2-4 sentences, as a typical AI chatbot would.',
          },
          { role: 'user', content: question },
        ],
        temperature: 0.6,
      })
      .then((c) => c.choices[0]?.message?.content?.trim() ?? 'No answer.')

    // --- Retrieval ---
    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: question,
    })
    const vector = embRes.data[0].embedding

    const host = await getPineconeHost(pineconeKey, indexName)
    const queryBody: Record<string, unknown> = {
      topK: 3,
      vector,
      includeMetadata: true,
    }
    if (namespace) queryBody.namespace = namespace

    const queryRes = await fetch(`https://${host}/query`, {
      method: 'POST',
      headers: { 'Api-Key': pineconeKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(queryBody),
    })
    if (!queryRes.ok) throw new Error(`Pinecone query failed (${queryRes.status})`)

    const queryData = (await queryRes.json()) as { matches?: PineconeMatch[] }
    const matches = queryData.matches ?? []

    const sources = matches.map((m) => ({
      title: (m.metadata?.title as string) ?? 'Document',
      text: ((m.metadata?.text as string) ?? '').slice(0, 500),
      relevance: m.score ?? 0,
    }))

    const topScore = sources.length ? sources[0].relevance : 0
    const corpus = namespace ? 'uploaded' : 'demo'

    // --- No relevant documents at all ---
    if (topScore < RETRIEVAL_FLOOR) {
      const ungoverned = await ungovernedPromise
      return NextResponse.json({
        question,
        ungoverned: { answer: ungoverned },
        governed: {
          decision: 'no_match',
          grounded: false,
          retrievalConfidence: topScore,
          answer: '',
          citation: '',
          sources,
          corpus,
        },
      })
    }

    // --- Grounded attempt: model must certify the answer is supported by the context ---
    const contextText = sources.map((s) => `[${s.title}]\n${s.text}`).join('\n\n')

    const groundedRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a careful policy assistant. You are given context passages from internal documents. ' +
            'Decide whether the context EXPLICITLY answers the question. ' +
            'Return strict JSON: {"grounded": boolean, "answer": string, "citation": string}. ' +
            'Set "grounded" true ONLY if the answer is directly stated in the context — not merely related or plausible. ' +
            'If grounded, "answer" is the answer drawn solely from the context and "citation" names the source document (and section if visible). ' +
            'If the context does not actually contain the answer, set "grounded" false, "answer" to an empty string, and "citation" to an empty string. Do not use outside knowledge.',
        },
        {
          role: 'user',
          content: `Context:\n${contextText}\n\nQuestion: ${question}`,
        },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    })

    let grounded = false
    let answer = ''
    let citation = ''
    try {
      const parsed = JSON.parse(groundedRes.choices[0]?.message?.content ?? '{}')
      grounded = parsed.grounded === true
      answer = typeof parsed.answer === 'string' ? parsed.answer : ''
      citation = typeof parsed.citation === 'string' ? parsed.citation : ''
    } catch {
      grounded = false
    }

    const ungoverned = await ungovernedPromise

    if (grounded && answer) {
      return NextResponse.json({
        question,
        ungoverned: { answer: ungoverned },
        governed: {
          decision: 'answered',
          grounded: true,
          retrievalConfidence: topScore,
          answer,
          citation,
          sources,
          corpus,
        },
      })
    }

    // Retrieved related text, but the answer isn't actually there.
    return NextResponse.json({
      question,
      ungoverned: { answer: ungoverned },
      governed: {
        decision: 'not_grounded',
        grounded: false,
        retrievalConfidence: topScore,
        answer: '',
        citation: '',
        sources,
        corpus,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
