import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Policy Assistant — RAG Demo',
  description: 'AI-Powered Document Q&A with Pinecone + OpenAI',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
