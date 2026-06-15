'use client'

import { useState } from 'react'

interface Source {
  title: string
  text: string
  relevance: number
}

interface QueryResult {
  question: string
  answer: string
  sources: Source[]
  time: string
}

const SAMPLE_QUESTIONS = [
  'How many vacation days do I get?',
  'What is the expense approval limit?',
  'Can I work from home?',
  'What happens to unused PTO?',
  'How do I get a promotion?',
  'When are performance reviews?',
]

const LOADING_STEPS = [
  'Converting question to vector…',
  'Searching Pinecone index…',
  'Retrieving relevant chunks…',
  'Generating answer with GPT-4o-mini…',
]

const PIPELINE = [
  { icon: '❓', label: 'Question', desc: 'User input' },
  { icon: '🔢', label: 'Embed', desc: 'OpenAI vector' },
  { icon: '🔍', label: 'Search', desc: 'Pinecone query' },
  { icon: '📄', label: 'Retrieve', desc: 'Top-3 chunks' },
  { icon: '🤖', label: 'Generate', desc: 'GPT-4o-mini' },
  { icon: '✅', label: 'Answer', desc: 'Cited response' },
]

export default function PolicyAssistant() {
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingStepIdx, setLoadingStepIdx] = useState(0)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const runQuery = async (q: string) => {
    if (!q.trim() || loading) return

    setLoading(true)
    setError(null)
    setResult(null)
    setLoadingStepIdx(0)

    let idx = 0
    const stepTimer = setInterval(() => {
      idx = Math.min(idx + 1, LOADING_STEPS.length - 1)
      setLoadingStepIdx(idx)
    }, 900)

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Request failed')
        return
      }
      setResult({
        question: q,
        answer: data.answer,
        sources: data.sources ?? [],
        time: new Date().toLocaleTimeString(),
      })
    } catch {
      setError('Network error — please try again')
    } finally {
      clearInterval(stepTimer)
      setLoading(false)
    }
  }

  const handleSubmit = () => runQuery(question)
  const handleChip = (q: string) => {
    setQuestion(q)
    runQuery(q)
  }

  // Build pipeline elements without Fragment key issues
  const pipelineElements = PIPELINE.flatMap((step, i) => {
    const stepEl = (
      <div key={step.label} className="pipeline-step">
        <div className="step-icon">{step.icon}</div>
        <div className="step-label">{step.label}</div>
        <div className="step-desc">{step.desc}</div>
      </div>
    )
    if (i < PIPELINE.length - 1) {
      return [stepEl, <div key={`arr-${i}`} className="pipeline-arrow">→</div>]
    }
    return [stepEl]
  })

  return (
    <div className="container">
      <header>
        <div className="logo">
          <span className="logo-icon">📋</span>
          <div>
            <h1>Policy Assistant</h1>
            <p className="subtitle">RAG-Powered Document Q&amp;A</p>
          </div>
        </div>
        <span className="status-badge">● Live</span>
      </header>

      <div className="tech-banner">
        <div style={{ flex: 1 }}>
          <strong>Retrieval-Augmented Generation</strong>
          <p style={{ color: '#94a3b8', fontSize: '13px', marginTop: '4px' }}>
            Semantic search over policy documents — answers grounded in source text, citations included
          </p>
        </div>
        <div className="tech-stat">
          <div className="tech-number">Pinecone</div>
          <div className="tech-label">Vector DB</div>
        </div>
        <div className="tech-stat">
          <div className="tech-number">OpenAI</div>
          <div className="tech-label">Embeddings</div>
        </div>
        <div className="tech-stat">
          <div className="tech-number">GPT-4o-mini</div>
          <div className="tech-label">Generation</div>
        </div>
        <div className="tech-stat">
          <div className="tech-number">4</div>
          <div className="tech-label">Policy Docs</div>
        </div>
      </div>

      <div className="search-box">
        <label className="search-label">Ask a question about company policies</label>
        <div className="search-input-wrapper">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="e.g., How many vacation days do I get?"
            disabled={loading}
          />
          <button
            className="btn-primary"
            onClick={handleSubmit}
            disabled={loading || !question.trim()}
          >
            {loading ? '…' : 'Ask'}
          </button>
        </div>
        <div className="sample-questions">
          {SAMPLE_QUESTIONS.map((q) => (
            <button
              key={q}
              className="sample-q"
              onClick={() => handleChip(q)}
              disabled={loading}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      <div className="grid">
        {/* Left panel: Answer */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">💬 Answer</span>
          </div>

          {loading && (
            <div className="loading-box">
              <div className="spinner" />
              <div className="loading-text">Processing your question…</div>
              <div className="loading-step">{LOADING_STEPS[loadingStepIdx]}</div>
            </div>
          )}

          {error && !loading && (
            <div className="error-box">
              <strong>Error:</strong> {error}
            </div>
          )}

          {result && !loading && (
            <div className="answer-content">
              <div className="query-bubble">
                <span className="query-label">Q:</span>
                {result.question}
              </div>
              <div className="answer-text">{result.answer}</div>
              <div className="answer-meta">
                {result.time} &nbsp;·&nbsp; {result.sources.length} source
                {result.sources.length !== 1 ? 's' : ''} retrieved
              </div>
            </div>
          )}

          {!loading && !result && !error && (
            <div className="empty-state">
              <div className="empty-state-icon">🔍</div>
              <p>Ask a question to get a grounded answer with citations from policy documents.</p>
            </div>
          )}
        </div>

        {/* Right panel: Sources */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">
              📚 Retrieved Sources
              {result && (
                <span className="count-badge">{result.sources.length}</span>
              )}
            </span>
          </div>

          {loading && (
            <div className="loading-box">
              <div className="spinner" />
              <div className="loading-text">Searching vector index…</div>
            </div>
          )}

          {result && !loading && (
            <div className="sources-list">
              {result.sources.map((s, i) => (
                <div key={i} className="source-item">
                  <div className="source-header">
                    <span className="source-name">{s.title}</span>
                    <span className="source-relevance">
                      {Math.round(s.relevance * 100)}% match
                    </span>
                  </div>
                  <div className="source-text">
                    {s.text}
                    {s.text.length >= 500 ? '…' : ''}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && !result && (
            <div className="empty-state">
              <div className="empty-state-icon">📄</div>
              <p>The 3 most relevant policy chunks will appear here after a query.</p>
            </div>
          )}
        </div>
      </div>

      {/* Pipeline visualization */}
      <div className="pipeline-section">
        <div className="pipeline-header">How RAG Works</div>
        <div className="pipeline-steps">{pipelineElements}</div>
      </div>
    </div>
  )
}
