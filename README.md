# Policy Assistant — RAG Demo

Live demo of AI-powered document Q&A using Retrieval-Augmented Generation.

**Pattern:** Question → OpenAI embedding → Pinecone vector search → top-3 chunk retrieval → GPT-4o-mini generation → cited answer

**Stack:** Next.js 14 (App Router) · TypeScript · OpenAI · Pinecone · Vercel

## Running locally

```bash
npm install
```

Create a `.env.local` file:

```
OPENAI_API_KEY=your-openai-key
PINECONE_API_KEY=your-pinecone-key
PINECONE_INDEX_NAME=policy-docs
```

Then:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deploy to Vercel

```bash
npx vercel --prod
```

Or import the repo at vercel.com/new. Set these environment variables in the Vercel dashboard:

- `OPENAI_API_KEY`
- `PINECONE_API_KEY`
- `PINECONE_INDEX_NAME` (default: `policy-docs`)

## Pinecone index

The `policy-docs` index must already be populated. Run the ingestion script from the source files if needed:

```bash
cd "../Rag Demo"
python3 rag_demo.py index
```

## API

- `POST /api/ask` — accepts `{ question }`, returns `{ answer, sources: [{ title, text, relevance }] }`. Rate-limited to 30 req/IP/10 min.

---

Built by [Orienteer AI](https://orienteer.ai) · [See all demos](https://orienteer.ai/demos)
