'use client'

import { useState } from 'react'

interface Source {
  title: string
  text: string
  relevance: number
}

type Decision = 'answered' | 'not_grounded' | 'no_match'

interface Governed {
  decision: Decision
  grounded: boolean
  retrievalConfidence: number
  answer: string
  citation: string
  sources: Source[]
  corpus: string
}

interface AskResult {
  question: string
  ungoverned: { answer: string }
  governed: Governed
}

interface AuditRow {
  time: string
  question: string
  decision: Decision | 'escalated'
  confidence: number | null
  detail: string
}

const SAMPLE_QUESTIONS = [
  'How many vacation days do I get?',
  'What is the expense approval limit?',
  'Can I work from home?',
  'What is the parental leave policy?',
  'How do I get a promotion?',
]

const DECISION_META: Record<
  AuditRow['decision'],
  { label: string; cls: string; icon: string; tag: string }
> = {
  answered: { label: 'Grounded in your documents', cls: 'ok', icon: '✓', tag: 'Answered' },
  not_grounded: { label: 'Answer not found in your documents', cls: 'warn', icon: '⚠', tag: 'Not grounded' },
  no_match: { label: 'No relevant documents found', cls: 'bad', icon: '🛑', tag: 'No match' },
  escalated: { label: 'Escalated to a human', cls: 'info', icon: '👤', tag: 'Escalated' },
}

// ── PDF text extraction via runtime-loaded pdf.js (no build dependency) ──
let pdfjsLoading: Promise<unknown> | null = null
function loadPdfJs(): Promise<unknown> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
  const w = window as unknown as { pdfjsLib?: unknown }
  if (w.pdfjsLib) return Promise.resolve(w.pdfjsLib)
  if (pdfjsLoading) return pdfjsLoading
  pdfjsLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
    script.onload = () => {
      const lib = (window as unknown as { pdfjsLib?: { GlobalWorkerOptions: { workerSrc: string } } }).pdfjsLib
      if (lib) {
        lib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
        resolve(lib)
      } else reject(new Error('PDF reader failed to load'))
    }
    script.onerror = () => reject(new Error('PDF reader failed to load'))
    document.head.appendChild(script)
  })
  return pdfjsLoading
}

async function extractPdfText(file: File): Promise<string> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const lib: any = await loadPdfJs()
  const buf = await file.arrayBuffer()
  const pdf = await lib.getDocument({ data: buf }).promise
  let out = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    out += content.items.map((it: any) => it.str).join(' ') + '\n'
  }
  return out
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

export default function PolicyAssistant() {
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<AskResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [escalated, setEscalated] = useState(false)
  const [audit, setAudit] = useState<AuditRow[]>([])

  // corpus / upload
  const [namespace, setNamespace] = useState('')
  const [corpusTitle, setCorpusTitle] = useState<string | null>(null)
  const [corpusChunks, setCorpusChunks] = useState(0)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [fileName, setFileName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const logRow = (row: AuditRow) => setAudit((prev) => [row, ...prev].slice(0, 25))

  const runQuery = async (q: string) => {
    if (!q.trim() || loading) return
    setLoading(true)
    setError(null)
    setResult(null)
    setEscalated(false)

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, namespace }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Request failed')
        return
      }
      setResult(data)
      const g: Governed = data.governed
      logRow({
        time: new Date().toLocaleTimeString(),
        question: q,
        decision: g.decision,
        confidence: g.retrievalConfidence,
        detail:
          g.decision === 'answered'
            ? g.citation || 'Cited source'
            : g.decision === 'not_grounded'
            ? 'Flagged + offered escalation'
            : 'Refused — no relevant docs',
      })
    } catch {
      setError('Network error — please try again')
    } finally {
      setLoading(false)
    }
  }

  const handleEscalate = () => {
    setEscalated(true)
    logRow({
      time: new Date().toLocaleTimeString(),
      question: result?.question ?? '',
      decision: 'escalated',
      confidence: null,
      detail: 'Routed to HR for human review',
    })
  }

  const handleFile = async (file: File | null) => {
    if (!file) return
    setUploadError(null)
    setFileName(file.name)
    try {
      let text = ''
      if (file.name.toLowerCase().endsWith('.pdf')) {
        text = await extractPdfText(file)
      } else {
        text = await file.text()
      }
      setPasteText(text)
    } catch {
      setUploadError('Could not read that file. Try pasting the text instead.')
    }
  }

  const submitUpload = async () => {
    const text = pasteText.trim()
    if (!text || uploading) return
    setUploading(true)
    setUploadError(null)
    try {
      const title = fileName || 'Your Document'
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, title }),
      })
      const data = await res.json()
      if (!res.ok) {
        setUploadError(data.error ?? 'Upload failed')
        return
      }
      setNamespace(data.namespace)
      setCorpusTitle(data.title)
      setCorpusChunks(data.chunks)
      setUploadOpen(false)
      setResult(null)
      setError(null)
      setPasteText('')
      setFileName('')
    } catch {
      setUploadError('Network error during upload')
    } finally {
      setUploading(false)
    }
  }

  const resetCorpus = () => {
    setNamespace('')
    setCorpusTitle(null)
    setCorpusChunks(0)
    setResult(null)
    setError(null)
  }

  const g = result?.governed
  const dec = g ? DECISION_META[g.decision] : null

  return (
    <div className="container">
      <header>
        <div className="logo">
          <span className="logo-icon">📋</span>
          <div>
            <h1>Policy Assistant</h1>
            <p className="subtitle">Governed Knowledge Access — grounded answers, or none at all</p>
          </div>
        </div>
        <span className="status-badge">● Live</span>
      </header>

      <div className="tech-banner">
        <div style={{ flex: 1 }}>
          <strong>Governed RAG</strong>
          <p style={{ color: '#94a3b8', fontSize: '13px', marginTop: '4px' }}>
            The system answers only when the documents actually support it — and tells you, and logs it, when they don&apos;t.
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
      </div>

      {/* Corpus + upload control */}
      <div className="corpus-bar">
        <div className="corpus-info">
          Answering from:
          {corpusTitle ? (
            <>
              <span className="corpus-tag">📄 {corpusTitle}</span>
              <span style={{ marginLeft: 8 }}>{corpusChunks} chunks indexed</span>
            </>
          ) : (
            <span className="corpus-tag">Demo HR policies (4 docs)</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {corpusTitle && (
            <button className="btn-ghost" onClick={resetCorpus} disabled={loading}>
              Reset to demo
            </button>
          )}
          <button
            className="btn-ghost"
            onClick={() => setUploadOpen((v) => !v)}
            disabled={loading}
          >
            {uploadOpen ? 'Cancel' : '⬆ Test your own document'}
          </button>
        </div>
      </div>

      {/* Upload panel */}
      {uploadOpen && (
        <div className="upload-panel">
          <div className="upload-title">Test it on your own document</div>
          <div className="upload-hint">
            Paste any policy text, or upload a .txt / .md / .pdf. It&apos;s indexed into a private,
            session-only namespace — not mixed with anyone else&apos;s. Then ask it questions.
          </div>
          <textarea
            className="upload-textarea"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="Paste your policy, handbook, or any document text here…"
          />
          <div className="upload-actions">
            <label className="file-label">
              📎 Choose file
              <input
                type="file"
                accept=".txt,.md,.pdf"
                style={{ display: 'none' }}
                onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              />
            </label>
            {fileName && <span className="file-name">{fileName}</span>}
            <button
              className="btn-primary"
              style={{ marginLeft: 'auto' }}
              onClick={submitUpload}
              disabled={uploading || !pasteText.trim()}
            >
              {uploading ? 'Indexing…' : 'Index & use this document'}
            </button>
          </div>
          {uploadError && <div className="upload-error">{uploadError}</div>}
        </div>
      )}

      {/* Question box */}
      <div className="search-box">
        <label className="search-label">Ask a question</label>
        <div className="search-input-wrapper">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runQuery(question)}
            placeholder="e.g., How many vacation days do I get?"
            disabled={loading}
          />
          <button
            className="btn-primary"
            onClick={() => runQuery(question)}
            disabled={loading || !question.trim()}
          >
            {loading ? '…' : 'Ask'}
          </button>
        </div>
        {!corpusTitle && (
          <div className="sample-questions">
            {SAMPLE_QUESTIONS.map((q) => (
              <button key={q} className="sample-q" onClick={() => { setQuestion(q); runQuery(q) }} disabled={loading}>
                {q}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <div className="error-box"><strong>Error:</strong> {error}</div>}

      {loading && (
        <div className="answer-col" style={{ textAlign: 'center', padding: '40px' }}>
          <div className="spinner" />
          <div className="loading-text">Retrieving, checking grounding, generating both answers…</div>
        </div>
      )}

      {/* Side-by-side answers */}
      {result && g && dec && !loading && (
        <div className="answers-grid">
          {/* Governed */}
          <div className="answer-col governed">
            <div className="col-head">🛡️ Governed <span style={{ color: '#60a5fa' }}>(Orienteer)</span></div>
            <div className="col-sub">Grounded in your documents. Cites sources. Refuses when it shouldn&apos;t answer.</div>

            <div className={`decision-badge ${dec.cls}`}>
              {dec.icon} {dec.label}
            </div>

            {g.decision === 'answered' ? (
              <>
                <div className="grounded-answer">{g.answer}</div>
                {g.citation && <div className="citation">📎 Source: {g.citation}</div>}
              </>
            ) : (
              <>
                <div className="refusal-explain">
                  {g.decision === 'no_match' ? (
                    <>Nothing relevant was found in {corpusTitle ? 'your document' : 'the policy documents'} (top similarity {Math.round(g.retrievalConfidence * 100)}%). The system will not answer from thin air.</>
                  ) : (
                    <>The closest match was <strong>{g.sources[0]?.title}</strong> ({Math.round(g.retrievalConfidence * 100)}% similar) — but it doesn&apos;t actually contain this answer. A similarity score alone would have missed that.</>
                  )}
                </div>
                {result.ungoverned.answer && (
                  <div className="fallback-block">
                    <div className="fallback-flag">⚠ General knowledge — not from your documents — verify before relying</div>
                    <div className="fallback-text">{result.ungoverned.answer}</div>
                  </div>
                )}
                {escalated ? (
                  <div className="escalate-done">👤 Escalated — routed to a human for review</div>
                ) : (
                  <button className="escalate-btn" onClick={handleEscalate}>👤 Escalate to a human</button>
                )}
              </>
            )}

            {g.sources.length > 0 && (
              <>
                <div className="sources-sub">Retrieved passages</div>
                {g.sources.map((s, i) => (
                  <div key={i} className="src">
                    <div className="src-head">
                      <span className="src-name">{s.title}</span>
                      <span className="src-sim">{Math.round(s.relevance * 100)}% similar</span>
                    </div>
                    <div className="simbar">
                      <div className="simbar-fill" style={{ width: `${Math.min(100, Math.round(s.relevance * 100))}%` }} />
                    </div>
                    <div className="src-text">{s.text.slice(0, 160)}…</div>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Ungoverned */}
          <div className="answer-col ungoverned">
            <div className="col-head">🤖 Ungoverned <span style={{ color: '#94a3b8' }}>(typical chatbot)</span></div>
            <div className="col-sub">No documents. No citations. Answers confidently — even when it shouldn&apos;t.</div>
            <div className="ungoverned-answer">{result.ungoverned.answer}</div>
            <div className="ungoverned-note">
              This is the same model with no grounding. Notice it never says &ldquo;I don&apos;t know&rdquo; — it produces a confident answer regardless of whether it&apos;s actually your policy. That confidence is the liability.
            </div>
          </div>
        </div>
      )}

      {/* Audit log */}
      <div className="audit-section">
        <div className="audit-head">
          <span className="panel-title">🧾 Audit Log <span className="count-badge">{audit.length}</span></span>
          <span style={{ fontSize: 12, color: '#64748b' }}>Every query and decision, this session</span>
        </div>
        {audit.length === 0 ? (
          <div className="audit-empty">No activity yet. Ask a question to populate the log.</div>
        ) : (
          <table className="audit-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Question</th>
                <th>Decision</th>
                <th>Confidence</th>
                <th>Action / Source</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((row, i) => {
                const m = DECISION_META[row.decision]
                return (
                  <tr key={i}>
                    <td className="audit-mono">{row.time}</td>
                    <td className="audit-q">{row.question}</td>
                    <td><span className={`tag ${m.cls}`}>{m.tag}</span></td>
                    <td className="audit-mono">{row.confidence === null ? '—' : `${Math.round(row.confidence * 100)}%`}</td>
                    <td>{row.detail}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
