"""
Ingestion script — Policy Assistant RAG Demo
Run once to populate the Pinecone index with policy document chunks.

Usage:
    OPENAI_API_KEY=sk-... PINECONE_API_KEY=pcsk_... python3 scripts/ingest.py

Or set keys in .env.local and export them before running.
"""

import os
import sys
from pinecone import Pinecone
from openai import OpenAI

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
PINECONE_API_KEY = os.environ.get("PINECONE_API_KEY")
PINECONE_INDEX = os.environ.get("PINECONE_INDEX_NAME", "policy-docs")

if not OPENAI_API_KEY or not PINECONE_API_KEY:
    print("Error: OPENAI_API_KEY and PINECONE_API_KEY must be set as environment variables.")
    sys.exit(1)

openai_client = OpenAI(api_key=OPENAI_API_KEY)
pc = Pinecone(api_key=PINECONE_API_KEY)
index = pc.Index(PINECONE_INDEX)

POLICY_DOCUMENTS = [
    {
        "id": "vacation-policy",
        "title": "Vacation Policy",
        "content": """
        VACATION AND PAID TIME OFF POLICY

        Section 1: Annual Leave Entitlement
        Full-time employees receive 15 days of paid time off (PTO) per year during their first 3 years of employment. After 3 years, this increases to 20 days. After 7 years, employees receive 25 days annually.

        Section 2: Carryover
        Employees may carry over up to 5 unused PTO days to the following year. Any days beyond 5 will be forfeited on December 31st. Unused carryover days must be used by March 31st of the following year.

        Section 3: Request Process
        PTO requests must be submitted at least 2 weeks in advance for requests of 3 or more consecutive days. Requests for 1-2 days require 48 hours notice. All requests are subject to manager approval based on business needs.

        Section 4: Blackout Periods
        The company may designate blackout periods during critical business times when PTO requests may be limited. These periods will be communicated at least 30 days in advance.
        """,
    },
    {
        "id": "expense-policy",
        "title": "Expense Reimbursement Policy",
        "content": """
        EXPENSE REIMBURSEMENT POLICY

        Section 1: Eligible Expenses
        The company reimburses reasonable business expenses including: travel (airfare, hotels, ground transportation), meals during business travel, client entertainment, office supplies, and professional development.

        Section 2: Approval Limits
        Expenses under $50 require no pre-approval. Expenses between $50-$500 require manager approval. Expenses over $500 require director approval. Travel bookings over $1000 require VP approval.

        Section 3: Submission Requirements
        All expense reports must be submitted within 30 days of incurring the expense. Receipts are required for all expenses over $25. Reports submitted after 60 days may not be reimbursed.

        Section 4: Per Diem Rates
        For domestic travel: meals up to $75/day, hotels up to $200/night. For international travel: meals up to $100/day, hotels based on location guidelines. Alcohol is not reimbursable except for client entertainment with prior approval.

        Section 5: Mileage
        Personal vehicle use for business purposes is reimbursed at the current IRS rate of $0.67 per mile. Commuting to the regular office is not reimbursable.
        """,
    },
    {
        "id": "remote-work-policy",
        "title": "Remote Work Policy",
        "content": """
        REMOTE WORK POLICY

        Section 1: Eligibility
        Employees in good standing who have completed their 90-day probation period may request remote work arrangements. Some positions require on-site presence and are not eligible for remote work.

        Section 2: Hybrid Schedule
        The standard hybrid schedule is 3 days in office, 2 days remote. Teams may adjust this based on business needs with director approval. Fully remote arrangements require VP approval.

        Section 3: Home Office Requirements
        Remote workers must maintain a dedicated workspace with reliable internet (minimum 50 Mbps). The company provides a laptop and one monitor. Additional equipment requests require manager approval.

        Section 4: Availability
        Remote workers must be available during core hours (9 AM - 3 PM local time) and responsive on Slack within 30 minutes. Employees must notify their manager if they will be unavailable during core hours.

        Section 5: Security
        All work must be performed on company-provided devices. Public WiFi use requires VPN connection. Confidential calls should not be taken in public spaces.
        """,
    },
    {
        "id": "performance-review-policy",
        "title": "Performance Review Policy",
        "content": """
        PERFORMANCE REVIEW POLICY

        Section 1: Review Cycle
        Formal performance reviews are conducted twice per year: mid-year (June) and year-end (December). Mid-year reviews focus on progress and development. Year-end reviews determine compensation adjustments.

        Section 2: Rating Scale
        Employees are rated on a 5-point scale: 1 (Does Not Meet Expectations), 2 (Partially Meets), 3 (Meets Expectations), 4 (Exceeds Expectations), 5 (Exceptional). Ratings of 1 or 2 trigger a performance improvement plan.

        Section 3: Self-Assessment
        Employees must complete a self-assessment at least one week before their scheduled review. Self-assessments should include accomplishments, challenges, and development goals.

        Section 4: Compensation
        Merit increases are awarded in January based on year-end performance ratings. Typical increases: Rating 3 = 2-3%, Rating 4 = 4-6%, Rating 5 = 7-10%. Ratings 1-2 are not eligible for increases.

        Section 5: Promotions
        Promotions require at least 12 months in current role, a rating of 4 or higher, and demonstrated readiness for next-level responsibilities. Promotion decisions are made during the year-end cycle.
        """,
    },
]


def chunk_document(doc, chunk_size=500, overlap=50):
    content = doc["content"].strip()
    chunks = []
    start = 0
    chunk_num = 0

    while start < len(content):
        end = start + chunk_size
        if end < len(content):
            for sep in [". ", ".\n", "? ", "!\n", "\n\n"]:
                last_sep = content[start:end].rfind(sep)
                if last_sep != -1:
                    end = start + last_sep + len(sep)
                    break
        chunk_text = content[start:end].strip()
        if chunk_text:
            chunks.append(
                {
                    "id": f"{doc['id']}-chunk-{chunk_num}",
                    "text": chunk_text,
                    "metadata": {
                        "doc_id": doc["id"],
                        "title": doc["title"],
                        "chunk_num": chunk_num,
                    },
                }
            )
            chunk_num += 1
        start = end - overlap

    return chunks


def get_embedding(text):
    response = openai_client.embeddings.create(
        model="text-embedding-3-small", input=text
    )
    return response.data[0].embedding


def ingest():
    print(f"Indexing {len(POLICY_DOCUMENTS)} policy documents into '{PINECONE_INDEX}'...")

    all_chunks = []
    for doc in POLICY_DOCUMENTS:
        chunks = chunk_document(doc)
        all_chunks.extend(chunks)
        print(f"  {doc['title']}: {len(chunks)} chunks")

    print(f"\nTotal chunks: {len(all_chunks)}")
    print("Embedding and uploading...")

    vectors = []
    for i, chunk in enumerate(all_chunks):
        embedding = get_embedding(chunk["text"])
        vectors.append(
            {
                "id": chunk["id"],
                "values": embedding,
                "metadata": {**chunk["metadata"], "text": chunk["text"]},
            }
        )
        if (i + 1) % 5 == 0:
            print(f"  {i + 1}/{len(all_chunks)} chunks embedded")

    batch_size = 100
    for i in range(0, len(vectors), batch_size):
        index.upsert(vectors=vectors[i : i + batch_size])

    print(f"\n✓ Indexed {len(vectors)} chunks to Pinecone index '{PINECONE_INDEX}'")


if __name__ == "__main__":
    ingest()
